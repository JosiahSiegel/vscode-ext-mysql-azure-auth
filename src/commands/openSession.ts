/**
 * Open a session against a registered server.
 *
 * Tested directly via unit tests; the composition root in main.ts just
 * delegates to this module.
 *
 * Behavior:
 *   - If no Azure session exists, warn the user that the next step will
 *     prompt for sign-in. The chain (`@azure/identity` ChainedIdentityProvider
 *     with VSCodeIdentitySource + AzureCliCredential) shows VS Code's
 *     built-in Microsoft sign-in UI on demand; we never call
 *     `azure-account.login` (the deprecated Azure Account extension).
 *   - The connect itself runs under a progress notification.
 *   - On failure, surface the error message.
 */

import * as vscode from 'vscode';
import { ActorRegistry } from '../registry/actorRegistry';
import { EntraTokenProvider } from '../identity/entraToken';
import { redactSensitive } from '../identity/redact';
import type { ConnectionConfig } from '../domain';

export interface ConnectCommandDeps {
    registry: ActorRegistry;
    identity: EntraTokenProvider;
    /** Optional sink for diagnostic messages. */
    log?: (line: string) => void;
    /** UI surface; injected so the command can be unit-tested without VS Code. */
    ui?: {
        showWarning: (msg: string) => Thenable<string | undefined>;
        withProgress: <T>(
            options: vscode.ProgressOptions,
            task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>
        ) => Promise<T>;
        showInformation: (msg: string) => Thenable<string | undefined>;
        showError: (msg: string) => Thenable<string | undefined>;
    };
}

/**
 * Default UI surface that delegates to vscode.window.
 *
 * IMPORTANT: the toast-style message calls (showWarning / showInformation /
 * showError) return `Thenable<undefined>` that ONLY resolves when the
 * user dismisses the notification. Awaiting them blocks the surrounding
 * flow until the user clicks the toast away — so we deliberately do NOT
 * await these calls in `openSession`. Calling sites use `void ...` so
 * TypeScript treats them as fire-and-forget.
 */
function defaultUi() {
    return {
        showWarning: (m: string): Thenable<string | undefined> =>
            vscode.window.showWarningMessage(m),
        withProgress: async <T>(
            options: vscode.ProgressOptions,
            task: (progress: vscode.Progress<{ message?: string; increment?: number }>) => Promise<T>
        ): Promise<T> => {
            return vscode.window.withProgress(options, task);
        },
        showInformation: (m: string): Thenable<string | undefined> =>
            vscode.window.showInformationMessage(m),
        showError: (m: string): Thenable<string | undefined> =>
            vscode.window.showErrorMessage(m),
    };
}

const ACCESS_TOKEN_TIMEOUT_MS = 30_000 as const;

class AccessTokenTimeoutError extends Error {
    override readonly name = 'AccessTokenTimeoutError';

    constructor(readonly timeoutMs: number) {
        super(`Access token acquisition timed out after ${timeoutMs / 1_000} seconds.`);
    }
}

const inFlightSessions = new Map<ConnectionConfig['id'], Promise<void>>();

const DEFAULT_TRACE = (line: string): void => {
    // eslint-disable-next-line no-console
    console.log(`[openSession] ${line}`);
};

function trace(deps: ConnectCommandDeps, line: string): void {
    (deps.log ?? DEFAULT_TRACE)(line);
}

export function openSession(
    deps: ConnectCommandDeps,
    config: ConnectionConfig
): Promise<void> {
    const existing = inFlightSessions.get(config.id);
    if (existing !== undefined) {
        trace(deps, `reusing existing in-flight operation for ${config.id}`);
        return existing;
    }

    trace(deps, `opening session for ${config.name} (${config.id})`);
    const ui = deps.ui ?? defaultUi();
    const operation = (async (): Promise<void> => {
        try {
            trace(deps, `step 1: checking isSignedIn`);
            const signedIn = await deps.identity.isSignedIn();
            trace(deps, `step 1 done: signedIn=${signedIn}`);
            if (!signedIn) {
                trace(deps, `step 2: showing no-session warning`);
                // Fire-and-forget: showWarningMessage returns a Thenable
                // that only resolves when the user dismisses the toast.
                void ui.showWarning(
                    'No active Azure session. The next step will prompt you to sign in.'
                );
                trace(deps, `step 2 dispatched: warning shown (fire-and-forget)`);
            }

            trace(deps, `step 3: opening progress notification`);
            await ui.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `Negotiating TLS + Entra token for ${config.name}...`,
                    cancellable: false,
                },
                async () => {
                    trace(deps, `step 4: progress task running - getAccessToken`);
                    let timeout: ReturnType<typeof setTimeout> | undefined;
                    try {
                        const timeoutPromise = new Promise<never>((_, reject) => {
                            timeout = setTimeout(() => {
                                reject(new AccessTokenTimeoutError(ACCESS_TOKEN_TIMEOUT_MS));
                            }, ACCESS_TOKEN_TIMEOUT_MS);
                            timeout.unref?.();
                        });
                        await Promise.race([
                            deps.identity.getAccessToken(),
                            timeoutPromise,
                        ]);
                        trace(deps, `step 4 done: token acquired`);
                    } finally {
                        if (timeout !== undefined) {
                            clearTimeout(timeout);
                        }
                    }
                    trace(deps, `step 5: calling registry.connect`);
                    await deps.registry.connect(config.id, config);
                    trace(deps, `step 5 done: connect succeeded`);
                    void ui.showInformation(`Connected to ${config.name}`);
                    trace(deps, `step 6 dispatched: success notification fired`);
                }
            );
            trace(deps, `step 7: progress task resolved`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            const cause = error instanceof Error ? error.cause : undefined;
            const causeName = cause instanceof Error ? cause.name : '';
            const causeMessage = cause instanceof Error ? cause.message : '';
            const safeMessage = redactSensitive(message);
            const safeCause = causeMessage ? redactSensitive(causeMessage) : '';
            trace(deps, `FAILED: ${safeMessage}`);
            if (safeCause) trace(deps, `cause: ${causeName} ${safeCause}`);
            // eslint-disable-next-line no-console
            console.error(
                '[mysql-azure-auth] openSession failed',
                safeMessage,
                safeCause ? `cause: ${causeName} ${safeCause}` : ''
            );
            const detail = safeCause
                ? `${safeMessage} (${causeName}: ${safeCause})`
                : safeMessage;
            void ui.showError(
                `Connection refused: ${detail}. See "MySQL Azure Auth" output channel for the full error.`
            );
            trace(deps, `error notification fired (fire-and-forget)`);
        }
    })();

    const trackedOperation = operation.finally(() => {
        if (inFlightSessions.get(config.id) === trackedOperation) {
            inFlightSessions.delete(config.id);
        }
        trace(deps, `in-flight map cleaned for ${config.id}`);
    });
    inFlightSessions.set(config.id, trackedOperation);
    return trackedOperation;
}
