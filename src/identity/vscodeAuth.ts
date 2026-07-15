/**
 * Token credentials - adapters between VS Code's authentication API and
 * the `@azure/identity` `TokenCredential` interface.
 *
 * Two sources are provided:
 *
 * 1. `VSCodeIdentitySource` - uses the user's existing VS Code Microsoft
 *    sign-in (provided by Microsoft Azure extensions). Returns the cached
 *    session if present. Does NOT trigger a new sign-in prompt reliably
 *    for arbitrary Entra resource scopes, because VS Code's bundled client
 *    ID is not pre-authorized for scopes outside the Azure management
 *    surface. Used for the second cache hit after a successful chain run.
 *
 * 2. `DeviceCodeIdentitySource` - drives the device-code flow directly
 *    against Microsoft Entra using the Azure CLI public client ID. This
 *    client IS pre-authorized for the `ossrdbms-aad` resource and other
 *    public-cloud resources. The `userPromptCallback` displays the device
 *    code + verification URL in a VS Code notification that the user can
 *    click through. This is the entry point that ensures the user always
 *    sees an authentication prompt when one is needed.
 *
 * Caching and concurrency control live on top of the chain, not reimplemented.
 */

import type { TokenCredential, GetTokenOptions, AccessToken } from '@azure/core-auth';
import {
    DeviceCodeCredential,
    AuthenticationRequiredError,
    CredentialUnavailableError,
} from '@azure/identity';
import type {
    DeviceCodeInfo,
    DeviceCodeCredentialOptions,
} from '@azure/identity';
import * as vscode from 'vscode';
import { redactSensitive, summarizeSensitive } from './redact';

const VSCODE_CANCELLED_CODE = 'AuthenticationCancelledNotification';
const VSCODE_NO_PROVIDER_PATTERNS = [
    /no provider/i,
    /not registered/i,
    /unknown provider/i,
    /not found/i,
] as const;

// Microsoft's public client ID reserved by the Azure CLI for end-user
// sign-in. It is pre-authorized for the ossrdbms-aad resource. We use it
// because VS Code's own Microsoft provider is not configured for that
// scope and never reliably shows a prompt for it.
const DEVICE_CODE_CLIENT_ID = '04b07795-8ddb-461a-bbee-02f9e1e7f63e';

export type DeviceCodePrompt = (
    info: DeviceCodeInfo,
    cancel: () => void
) => Thenable<undefined> | undefined;

/**
 * VSCodeIdentitySource - acquires an Entra token via the user's existing
 * VS Code Microsoft sign-in.
 *
 * Cancellation: VS Code emits an Error with code
 * `AuthenticationCancelledNotification` when the user cancels the sign-in
 * dialog. We surface that as `AuthenticationRequiredError` (a framework-
 * recognised signal) so the chain can decide whether to advance or fail.
 *
 * No-provider / unauthorized-scope: when the Microsoft auth provider
 * isn't registered or the requested scope isn't authorized for VS Code's
 * bundled client, we throw `CredentialUnavailableError` so the chain
 * advances to the next source.
 */
export class VSCodeIdentitySource implements TokenCredential {
    constructor(private readonly providerId: string = 'microsoft') {}

    async getToken(
        scopes: string | string[],
        _options?: GetTokenOptions
    ): Promise<AccessToken> {
        const scopeList = Array.isArray(scopes) ? scopes : [scopes];

        let session: vscode.AuthenticationSession | undefined;
        try {
            session = await vscode.authentication.getSession(
                this.providerId,
                scopeList,
                { createIfNone: true }
            );
        } catch (err: unknown) {
            if (isCancelledError(err)) {
                throw new AuthenticationRequiredError({
                    message: 'User cancelled the VS Code sign-in dialog.',
                    scopes: scopeList,
                });
            }
            if (isMissingProviderError(err) || isUnauthorizedScopeError(err)) {
                throw new CredentialUnavailableError(
                    describeError(
                        err,
                        `Microsoft provider cannot satisfy scope(s) ${scopeList.join(' ')}.`
                    )
                );
            }
            const message = redactSensitive(describeError(err));
            // eslint-disable-next-line no-console
            console.error(
                `[mysql-azure-auth identity] vscode getSession failed: ${message}`
            );
            // Real failure (network, server error). Surface as
            // AuthenticationRequiredError so the chain advances to the next
            // source rather than terminating the entire chain.
            throw new AuthenticationRequiredError({
                message: `Microsoft auth failed: ${message}`,
                scopes: scopeList,
                cause: err instanceof Error ? err : new Error(message),
            });
        }

        if (!session) {
            // createIfNone was true; if VS Code returned no session anyway,
            // signal "advance" so the chain can try the next source.
            throw new CredentialUnavailableError(
                `VS Code returned no Microsoft session for scope(s) ${scopeList.join(' ')}.`
            );
        }
        // Synthesized 50-minute expiry; VS Code does not expose exact
        // expiry for the access token.
        return {
            token: session.accessToken,
            expiresOnTimestamp: Date.now() + 50 * 60 * 1000,
        };
    }
}

/**
 * DeviceCodeIdentitySource - drives the Entra device-code flow against the
 * Azure CLI public client ID and surfaces the prompt through a caller-
 * provided UI (`prompt`).
 *
 *  - Uses Microsoft's pre-authorized Azure CLI client so we are not at the
 *    mercy of VS Code's bundled provider scope list.
 *  - When interactive sign-in is required the host calls `prompt` with the
 *    device code, the verification URL, and a cancel callback. The typical
 *    host opens a VS Code `showInformationMessage` that links to the URL.
 *  - Always either returns a valid `AccessToken` or throws an actionable
 *    `CredentialUnavailableError` / `AuthenticationRequiredError`.
 */
export class DeviceCodeIdentitySource implements TokenCredential {
    private readonly credential: DeviceCodeCredential;

    constructor(
        private readonly prompt: DeviceCodePrompt,
        clientId: string = DEVICE_CODE_CLIENT_ID,
        authorityHost?: string
    ) {
        const options: DeviceCodeCredentialOptions = {
            clientId,
            userPromptCallback: (info: DeviceCodeInfo) => {
                // Bridge DeviceCodePromptCallback (sync) to DeviceCodePrompt
                // (Thenable-returning). The Azure SDK ignores the return.
                void this.prompt(info, () => undefined);
            },
        };
        if (authorityHost !== undefined) {
            options.authorityHost = authorityHost;
        }
        this.credential = new DeviceCodeCredential(options);
    }

    async getToken(
        scopes: string | string[],
        options?: GetTokenOptions
    ): Promise<AccessToken> {
        const list = Array.isArray(scopes) ? scopes : [scopes];
        try {
            const token = await this.credential.getToken(list, options);
            if (token === null) {
                throw new CredentialUnavailableError(
                    'Device-code credential did not return a token.'
                );
            }
            return token;
        } catch (err: unknown) {
            // The chained credential advances only on
            // CredentialUnavailableError / AuthenticationRequiredError. Any
            // concrete failure from MSAL (HTTP failure, network failure,
            // configuration error, etc.) must therefore be re-classified
            // into one of those two so the chain still tries VS Code auth
            // and the Azure CLI fallback.
            if (isCredentialUnavailable(err)) {
                throw err;
            }
            const summary = redactSensitive(describeError(err));
            const detail = describeCredentialError(err);
            // eslint-disable-next-line no-console
            console.error(
                `[mysql-azure-auth identity] deviceCode failed: ${summary} detail=${detail}`
            );
            // Re-throw as AuthenticationRequiredError with the underlying
            // error preserved as `cause` so the chain advances to the next
            // source while still carrying the diagnostic message.
            throw new AuthenticationRequiredError({
                message: `Device code flow failed: ${summary}. ${detail}`,
                scopes: list,
                cause: err instanceof Error ? err : new Error(summary),
            });
        }
    }
}

function isCancelledError(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: unknown }).code === VSCODE_CANCELLED_CODE
    );
}

function isMissingProviderError(err: unknown): boolean {
    const message = describeError(err);
    return VSCODE_NO_PROVIDER_PATTERNS.some((pattern) => pattern.test(message));
}

function isUnauthorizedScopeError(err: unknown): boolean {
    const message = describeError(err);
    return (
        /doesn't have access/i.test(message) ||
        /does not have access/i.test(message) ||
        /invalid[_\s-]?scope/i.test(message) ||
        /application is not configured/i.test(message)
    );
}

function isCredentialUnavailable(err: unknown): boolean {
    return (
        err !== null &&
        typeof err === 'object' &&
        (err as { name?: unknown }).name === 'CredentialUnavailableError'
    );
}

function describeError(err: unknown, fallback = ''): string {
    if (err instanceof Error) return err.message || fallback;
    if (typeof err === 'string') return err || fallback;
    return fallback;
}

/**
 * Walk a thrown credential error and surface every field MSAL or VS Code
 * might have attached. Falls back to `err.message` so the function always
 * returns a non-empty string.
 */
function describeCredentialError(err: unknown): string {
    if (err === null || typeof err !== 'object') return describeError(err);
    const parts: string[] = [];
    const name = (err as { name?: unknown }).name;
    const message = describeError(err);
    const code = (err as { code?: unknown }).code;
    const errorCode = (err as { errorCode?: unknown }).errorCode;
    const statusCode = (err as { statusCode?: unknown }).statusCode;
    const errorBody = (err as { errorBody?: unknown }).errorBody;
    const errorResponse = (err as { errorResponse?: unknown }).errorResponse;
    const correlationId = (err as { correlationId?: unknown }).correlationId;
    const body = (err as { body?: unknown }).body;
    const stderr = (err as { stderr?: unknown }).stderr;

    if (typeof name === 'string' && name) parts.push(`name=${name}`);
    if (typeof errorCode === 'string' && errorCode) parts.push(`errorCode=${errorCode}`);
    if (typeof code === 'string' && code) parts.push(`code=${code}`);
    if (typeof statusCode === 'number') parts.push(`statusCode=${statusCode}`);
    if (typeof message === 'string' && message)
        parts.push(`message=${redactSensitive(message)}`);
    if (typeof stderr === 'string' && stderr)
        parts.push(`stderr=${redactSensitive(stderr)}`);
    if (typeof correlationId === 'string' && correlationId)
        parts.push(`correlationId=${correlationId}`);
    if (errorResponse && typeof errorResponse === 'object') {
        const er = errorResponse as { error?: unknown; error_description?: unknown };
        if (typeof er.error === 'string')
            parts.push(`response.error=${redactSensitive(er.error)}`);
        if (typeof er.error_description === 'string')
            parts.push(`response.error_description=${redactSensitive(er.error_description)}`);
    }
    if (errorBody !== undefined) {
        let serialized: string;
        try {
            serialized = typeof errorBody === 'string' ? errorBody : JSON.stringify(errorBody);
        } catch {
            serialized = '[unserializable]';
        }
        parts.push(`errorBody(${summarizeSensitive(serialized)})`);
    }
    if (typeof body === 'string' && body)
        parts.push(`body(${summarizeSensitive(body)})`);

    if (parts.length === 0) return message || String(err);
    return parts.join(' ');
}
