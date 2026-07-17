/**
 * Shared constants for user-facing identity-prompt timeouts.
 *
 * The user-facing Microsoft sign-in / MFA prompt is allowed up to
 * {@link IDENTITY_PROMPT_TIMEOUT_MS} milliseconds before
 * {@link IdentityPromptTimeoutError} is raised. This is intentionally a
 * separate budget from the in-process Entra cache refresh safety margin
 * (see `safetyMarginMs` in `entraToken.ts`); the cache trigger is
 * independent of how long a human is willing to wait for an interactive
 * sign-in dialog.
 */

/**
 * Maximum wall-clock time (in milliseconds) we will wait for a user-facing
 * identity prompt (sign-in dialog, MFA challenge, etc.) before failing.
 *
 * Value: 120 seconds. Picked to comfortably cover an interactive MFA
 * round-trip on a slow connection without leaving the user staring at a
 * frozen progress notification.
 */
export const IDENTITY_PROMPT_TIMEOUT_MS = 120_000 as const;

/**
 * Raised when a user-facing identity prompt exceeds
 * {@link IDENTITY_PROMPT_TIMEOUT_MS}. Distinct from in-process cache
 * refresh failures so callers can decide whether to surface a
 * "please complete the sign-in" message versus silently retrying.
 */
export class IdentityPromptTimeoutError extends Error {
    override readonly name = 'IdentityPromptTimeoutError';

    constructor(readonly timeoutMs: number) {
        super(`Identity prompt timed out after ${timeoutMs / 1_000} seconds.`);
    }
}