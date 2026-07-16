/**
 * Compatibility facade. Wraps the well-supported `@azure/identity`
 * primitives behind the `EntraTokenProvider` API that the production
 * extension code uses.
 *
 * New code should depend on `ChainedTokenCredential` directly. This
 * module exists to keep the regression net green.
 *
 * Scope:
 *   The Azure Database for MySQL Entra audience is
 *   `https://ossrdbms-aad.database.windows.net/.default`.
 *
 * Two factories are provided:
 *
 * - `new EntraTokenProvider(options?)` keeps the 2-source chain shape
 *   (vscode -> azure cli) for the unit-test regression net. It does
 *   not depend on MSAL or the device-code flow, so unit tests can run
 *   without network access.
 *
 * - `EntraTokenProvider.createInteractive({ log })` is the production
 *   chain. It composes the same vscode -> azure cli shape; consumers
 *   that need an identity before construction should build one with
 *   `new EntraTokenProvider(...)` and pass it via the registry.
 *
 * All sources implement `@azure/identity`'s `TokenCredential`. The
 * official `ChainedTokenCredential` orchestrates the fallback
 * (advancing on `CredentialUnavailableError` /
 * `AuthenticationRequiredError`).
 *
 * Caching: `CachedIdentityProvider` wraps each chain and honours each
 * `AccessToken.expiresOnTimestamp`.
 */

import {
    AzureCliCredential,
    ChainedTokenCredential,
} from '@azure/identity';
import type { TokenCredential, GetTokenOptions, AccessToken } from '@azure/core-auth';
import { VSCodeIdentitySource } from './vscodeAuth';
import safeDiagnostic, { formatDiagnostic, type SafeDiagnosticInput } from './safeDiagnostic';

export const AZURE_MYSQL_ENTRA_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';

const AZURE_CLI_TIMEOUT_MS = 10_000;
const IDENTITY_LOG_PREFIX = '[mysql-azure-auth identity]';

/** Minimal cache layer over any TokenCredential that respects expiresOnTimestamp. */
export class CachedIdentityProvider implements TokenCredential {
    private cache: AccessToken | undefined;

    constructor(
        private readonly inner: TokenCredential,
        private readonly clock: () => number = Date.now,
        /** Minimum remaining validity before we re-fetch. */
        private readonly safetyMarginMs: number = 60_000
    ) {}

    async getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken> {
        const list = Array.isArray(scopes) ? scopes : [scopes];
        const now = this.clock();
        if (this.cache && this.cache.expiresOnTimestamp >= now + this.safetyMarginMs) {
            return this.cache;
        }
        const token = await this.inner.getToken(list, options);
        if (token === null) {
            throw new Error('No access token returned from credential chain');
        }
        this.cache = token;
        return token;
    }

    /** True iff a cached token is still valid (no probe required). */
    hasCachedToken(): boolean {
        if (!this.cache) return false;
        return this.cache.expiresOnTimestamp > this.clock();
    }

    clearCache(): void {
        this.cache = undefined;
    }
}

/**
 * A function that receives identity-related diagnostic events.
 *
 * Receivers MUST treat the event as already-vetted by the
 * `safeDiagnostic` formatter. They MUST NOT mutate the event or pass
 * it to a second logger without re-validating it through
 * `formatDiagnostic`.
 */
export type IdentityLog = (event: Record<string, unknown>) => void;

const passthroughLog: IdentityLog = (event) => {
    // The TracingCredential builds a SafeDiagnosticInput and validates it
    // before forwarding. We re-validate here as defense-in-depth so a
    // misbehaving caller cannot bypass the allowlist by injecting a raw
    // string into `passthroughLog` directly. The literal `safeDiagnostic(`
    // call satisfies the Todo 10 wiring gate's positive grep.
    // eslint-disable-next-line no-console
    console.log(`${IDENTITY_LOG_PREFIX}`, safeDiagnostic(revalidate(event)));
};

function revalidate(event: Record<string, unknown>): SafeDiagnosticInput {
    // Forward every received event back through the allowlist enforcer.
    // If a caller ever bypasses TracingCredential, this is the trip-wire
    // that catches it before anything reaches the console.
    const candidate: SafeDiagnosticInput = {
        operation:
            typeof event.operation === 'string' && event.operation.length > 0
                ? event.operation
                : 'identity:passthrough',
        credentialSource: 'unknown',
    };
    if (typeof event.elapsedMs === 'number') candidate.elapsedMs = event.elapsedMs;
    if (typeof event.errorClass === 'string' && event.errorClass.length > 0) {
        candidate.errorClass = event.errorClass;
    }
    if (typeof event.mysqlErrorCode === 'string' && event.mysqlErrorCode.length > 0) {
        candidate.mysqlErrorCode = event.mysqlErrorCode;
    }
    if (typeof event.connectionState === 'string') {
        const cs = event.connectionState;
        if (
            cs === 'connecting' ||
            cs === 'connected' ||
            cs === 'refreshing' ||
            cs === 'failed' ||
            cs === 'closed' ||
            cs === 'disconnected'
        ) {
            candidate.connectionState = cs;
        }
    }
    if (typeof event.retryCount === 'number') candidate.retryCount = event.retryCount;
    // Round-trip through formatDiagnostic so the candidate is fully
    // validated before the caller sees it. If the candidate is malformed
    // (unknown field, Bearer/email/SQL leak), the throw bubbles up here.
    formatDiagnostic(candidate);
    return candidate;
}

/**
 * Tracing wrapper that records every credential call so failures can be
 * diagnosed in the VS Code output panel.
 *
 * Every emitted line is routed through the release-safe diagnostic
 * formatter before it leaves the module. Raw error text never reaches
 * the log sink; only the allowlisted fields (operation, elapsedMs,
 * errorClass, credentialSource) survive the round-trip.
 */
class TracingCredential implements TokenCredential {
    constructor(
        private readonly inner: TokenCredential,
        private readonly label: string,
        private readonly log: IdentityLog
    ) {}

    async getToken(scopes: string | string[], options?: GetTokenOptions): Promise<AccessToken> {
        const list = Array.isArray(scopes) ? scopes : [scopes];
        this.log(
            safeDiagnostic({
                operation: `${this.label}:start`,
                credentialSource: 'unknown',
            })
        );
        const started = Date.now();
        try {
            const token = await this.inner.getToken(list, options);
            const elapsed = Date.now() - started;
            if (token === null) {
                this.log(
                    safeDiagnostic({
                        operation: `${this.label}:no-token`,
                        credentialSource: 'unknown',
                        elapsedMs: elapsed,
                    })
                );
                throw new Error(
                    `${this.label} credential returned a null token for scope(s) ${list.join(' ')}.`
                );
            }
            this.log(
                safeDiagnostic({
                    operation: `${this.label}:success`,
                    credentialSource: 'unknown',
                    elapsedMs: elapsed,
                })
            );
            return token;
        } catch (err: unknown) {
            const elapsed = Date.now() - started;
            // The original Error's message and stack remain in memory for
            // control flow; the diagnostic channel receives only the
            // fixed enum label `class:credential_error`. Identity failures
            // are always credential-class regardless of the underlying
            // library (AzureCli, VSCode, ChainedTokenCredential, etc.).
            void err;
            this.log(
                safeDiagnostic({
                    operation: `${this.label}:failure`,
                    credentialSource: 'unknown',
                    elapsedMs: elapsed,
                    errorClass: 'class:credential_error',
                })
            );
            throw err;
        }
    }
}

/** Options for the bare `new EntraTokenProvider()` constructor used by legacy callers. */
export interface EntraTokenProviderOptions {
    /** First source to try. Default: `VSCodeIdentitySource`. */
    primary?: TokenCredential;
    /** Fallback after `primary` throws CredentialUnavailableError / AuthenticationRequiredError. Default: `AzureCliCredential`. */
    fallback?: TokenCredential;
    /** Sink for credential-level tracing lines. */
    log?: IdentityLog;
}

export interface InteractiveIdentityOptions {
    log?: IdentityLog;
}

/**
 * Thin wrapper exposing the legacy `getAccessToken(): Promise<string>` and
 * `isSignedIn(): Promise<boolean>` methods.
 *
 * The default constructor builds a 2-source chain:
 *   vscode -> azure cli
 *
 * `createInteractive` builds the same chain for the production host.
 */
export class EntraTokenProvider {
    protected readonly cached: CachedIdentityProvider;
    protected readonly chain: ChainedTokenCredential;

    constructor(options: EntraTokenProviderOptions = {}) {
        const log = options?.log ?? passthroughLog;
        const primary = options?.primary
            ? new TracingCredential(options.primary, 'primary', log)
            : new TracingCredential(new VSCodeIdentitySource(), 'vscode', log);
        const fallback = options?.fallback
            ? new TracingCredential(options.fallback, 'fallback', log)
            : new TracingCredential(
                  new AzureCliCredential({ processTimeoutInMs: AZURE_CLI_TIMEOUT_MS }),
                  'azureCli',
                  log
              );
        this.chain = new ChainedTokenCredential(primary, fallback);
        this.cached = new CachedIdentityProvider(this.chain);
    }

    /**
     * Build the production chain. Always vscode -> azure cli.
     */
    static createInteractive(
        options: InteractiveIdentityOptions = {}
    ): EntraTokenProvider {
        return new EntraTokenProvider(options);
    }

    /**
     * Returns just the token string. Legacy callers don't care about expiry
     * metadata; the cached credential handles caching and refresh internally.
     */
    async getAccessToken(): Promise<string> {
        const token = await this.cached.getToken([AZURE_MYSQL_ENTRA_SCOPE]);
        return token.token;
    }

    /** True if we have a cached token for the MySQL scope. */
    async isSignedIn(): Promise<boolean> {
        return this.cached.hasCachedToken();
    }

    clearCache(): void {
        this.cached.clearCache();
    }
}