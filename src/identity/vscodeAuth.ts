/**
 * Token credentials - adapters between VS Code's authentication API and
 * the `@azure/identity` `TokenCredential` interface.
 *
 * `VSCodeIdentitySource` uses the user's existing VS Code Microsoft
 * sign-in (provided by Microsoft Azure extensions). It returns the cached
 * session if present and does NOT trigger a new sign-in prompt reliably
 * for arbitrary Entra resource scopes, because VS Code's bundled client
 * ID is not pre-authorized for scopes outside the Azure management
 * surface. The Azure CLI primitive (`@azure/identity`'s
 * `AzureCliCredential`) provides the transparent fallback when VS Code
 * auth cannot satisfy the requested scope.
 *
 * Cancellation: VS Code emits an Error with code
 * `AuthenticationCancelledNotification` when the user cancels the
 * sign-in dialog. We surface that as `AuthenticationRequiredError` (a
 * framework-recognised signal) so the chain can decide whether to
 * advance or fail.
 *
 * No-provider / unauthorized-scope: when the Microsoft auth provider
 * isn't registered or the requested scope isn't authorized for VS
 * Code's bundled client, we throw `CredentialUnavailableError` so the
 * chain advances to the next source.
 *
 * Caching and concurrency control live on top of the chain, not
 * reimplemented.
 */

import type { TokenCredential, GetTokenOptions, AccessToken } from '@azure/core-auth';
import {
    AuthenticationRequiredError,
    CredentialUnavailableError,
} from '@azure/identity';
import * as vscode from 'vscode';
import { redactSensitive } from './redact';

const VSCODE_CANCELLED_CODE = 'AuthenticationCancelledNotification';
const VSCODE_NO_PROVIDER_PATTERNS = [
    /no provider/i,
    /not registered/i,
    /unknown provider/i,
    /not found/i,
] as const;

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

function describeError(err: unknown, fallback = ''): string {
    if (err instanceof Error) return err.message || fallback;
    if (typeof err === 'string') return err || fallback;
    return fallback;
}