/**
 * migrationRunner — fail-soft ordered migration runner.
 *
 * The extension activation path drives a list of idempotent migration
 * steps that bring persisted state from the previous version's shape
 * up to the current build's shape. Each step is gated by a per-id
 * `globalState` marker (`mysqlAzureAuth.migration.<id>`); steps that
 * have already run on a prior activation are skipped.
 *
 * Only after ALL steps succeed does the runner write
 * `mysqlAzureAuth.lastMigratedVersion = observedVersion`. On any
 * failure — a step throw OR the final write rejecting — the marker
 * is left unchanged so the next activation re-runs the same steps.
 *
 * Fail-soft contract: `runMigrations` NEVER rejects. Every code path
 * that can throw (a step's `run`, the `safeDiagnostic` formatter
 * itself, the final `globalState.update`) is wrapped in a try/catch.
 * The activation wiring (`src/main.ts`, T5) `void`-discards the
 * returned Promise inside an async IIFE; an unhandled rejection
 * would crash activation, so the never-rejects rule is load-bearing.
 *
 * The v1 step list is defined in `src/main.ts` (T5). This file is
 * single-purpose: it runs whatever ordered list the caller hands it.
 * No `console.log`, no I/O other than `logChannel.appendLine` for
 * failures and `globalState` for state.
 */

import type { ExtensionContext, OutputChannel } from 'vscode';
import safeDiagnostic from '../identity/safeDiagnostic';

/**
 * One migration step. `id` is stable across versions — it is also the
 * `globalState` marker key (per-id `mysqlAzureAuth.migration.<id>`)
 * and the `operation` field of the diagnostic emitted on failure.
 *
 * `run` may be sync (return void) or async (return a Promise). A
 * synchronous throw is treated identically to a rejection: the step
 * is recorded as failed and the runner continues with the next step.
 */
export type MigrationStep = {
    readonly id: string;
    readonly run: (ctx: ExtensionContext) => Promise<void>;
};

/**
 * Per-call summary. Returned even on partial failure so callers can
 * log a structured report without inspecting globalState. The three
 * arrays are mutually exclusive within a single activation: a step
 * id appears in exactly one of `ran`, `skipped`, `failed`.
 *
 * `'lastMigratedVersion-write-failed'` is a synthetic id that lives
 * only in `failed`; it never appears in `ran` because no step
 * corresponds to it. Its presence means every step succeeded but
 * the final write of `lastMigratedVersion` rejected, so the next
 * activation will re-run every step.
 */
export interface MigrationSummary {
    readonly ran: readonly string[];
    readonly skipped: readonly string[];
    readonly failed: readonly string[];
}

const LAST_MIGRATED_KEY = 'mysqlAzureAuth.lastMigratedVersion';
const STEP_MARKER_PREFIX = 'mysqlAzureAuth.migration.';
const LAST_WRITE_FAILED_SENTINEL = 'lastMigratedVersion-write-failed';

function stepMarkerKey(id: string): string {
    return `${STEP_MARKER_PREFIX}${id}`;
}

/**
 * Run an ordered list of migration steps and update the stored
 * "lastMigratedVersion" marker on full success.
 *
 * Behavior (per the T2 acceptance criteria):
 *   - Each step runs exactly once per version transition. A
 *     previously-completed step (per-id marker is truthy) is added
 *     to `skipped` and `run` is NOT called.
 *   - A throw from `step.run` (sync or async) is logged via
 *     `safeDiagnostic` (allowlist-only formatter; never raw error
 *     text), the step id is added to `failed`, the per-id marker
 *     is NOT set, and the runner continues with the next step.
 *   - After all steps, if `failed.length === 0`, the runner awaits
 *     `globalState.update(LAST_MIGRATED_KEY, observedVersion)`. If
 *     THAT write rejects, the rejection is logged via
 *     `safeDiagnostic`, `LAST_WRITE_FAILED_SENTINEL` is pushed to
 *     `failed`, and the function STILL returns a resolved summary.
 *   - If `failed.length > 0` from any source, `LAST_MIGRATED_KEY`
 *     is left unchanged so the next activation re-runs the steps.
 *   - The function never rejects. Every throwable site is wrapped.
 */
export async function runMigrations(
    context: ExtensionContext,
    logChannel: OutputChannel,
    steps: readonly MigrationStep[],
    observedVersion: string | null | undefined
): Promise<MigrationSummary> {
    const ran: string[] = [];
    const skipped: string[] = [];
    const failed: string[] = [];

    for (const step of steps) {
        const markerKey = stepMarkerKey(step.id);
        let alreadyDone: unknown;
        try {
            alreadyDone = context.globalState.get(markerKey);
        } catch {
            // A throw from the globalState getter is the host's
            // problem; treat the step as not-yet-run and let the
            // step's own `run` surface the real error.
            alreadyDone = undefined;
        }
        if (alreadyDone) {
            skipped.push(step.id);
            continue;
        }

        try {
            await step.run(context);
        } catch (err: unknown) {
            failed.push(step.id);
            logMigrationFailure(logChannel, step.id, observedVersion);
            // Marker is deliberately NOT set on failure — the next
            // activation must re-run this step.
            continue;
        }

        // Step succeeded; persist the per-id marker.
        try {
            await context.globalState.update(markerKey, true);
        } catch {
            // A marker-write failure is logged as a soft failure
            // but does NOT add the step to `failed` — the step
            // itself ran cleanly and its effect is in place; the
            // next activation will simply re-run it (which is the
            // safe idempotent outcome for every existing step).
            logMarkerWriteFailure(logChannel, step.id, observedVersion);
        }
        ran.push(step.id);
    }

    if (failed.length > 0) {
        // Do NOT write lastMigratedVersion when any step failed;
        // the next activation must re-run the same steps.
        return { ran, skipped, failed };
    }

    try {
        await context.globalState.update(LAST_MIGRATED_KEY, observedVersion);
    } catch {
        failed.push(LAST_WRITE_FAILED_SENTINEL);
        logLastMigratedWriteFailure(logChannel, observedVersion);
    }

    return { ran, skipped, failed };
}

/**
 * Emit a single safe-diagnostic line for a step-level failure.
 *
 * The formatter is the `safeDiagnostic` allowlist at
 * `src/identity/safeDiagnostic.ts`: every field is a stable label,
 * never the raw `err.message` (which can carry SQL fragments,
 * emails, or bearer headers). The renderer is `logChannel.appendLine`
 * because VS Code's Output panel is the only surface that survives
 * activation failure — the caller never gets a chance to read the
 * returned Promise's `failed` array in the failure path anyway.
 */
function logMigrationFailure(
    logChannel: OutputChannel,
    stepId: string,
    observedVersion: string | null | undefined
): void {
    try {
        const diagnostic = safeDiagnostic({
            operation: `migration-runner:${stepId}`,
            credentialSource: 'unknown',
            errorClass: 'class:migration_failure',
            connectionState: 'failed',
        });
        // The version field is an out-of-band aid for the operator
        // reading the channel — keep it on the same line so the
        // log entry is self-describing.
        const versionLabel =
            typeof observedVersion === 'string' && observedVersion.length > 0
                ? observedVersion
                : 'unknown';
        logChannel.appendLine(
            `[migration-runner] step '${stepId}' failed; version=${versionLabel} diagnostic=${JSON.stringify(diagnostic)}`
        );
    } catch {
        // safeDiagnostic itself is not allowed to throw on a
        // well-formed input, but the runner's never-rejects rule
        // covers the formatter too.
        logChannel.appendLine(
            `[migration-runner] step '${stepId}' failed (diagnostic formatter threw)`
        );
    }
}

function logMarkerWriteFailure(
    logChannel: OutputChannel,
    stepId: string,
    observedVersion: string | null | undefined
): void {
    try {
        const diagnostic = safeDiagnostic({
            operation: `migration-runner:marker-write:${stepId}`,
            credentialSource: 'unknown',
            errorClass: 'class:migration_state_write_failed',
            connectionState: 'failed',
        });
        const versionLabel =
            typeof observedVersion === 'string' && observedVersion.length > 0
                ? observedVersion
                : 'unknown';
        logChannel.appendLine(
            `[migration-runner] marker write for '${stepId}' rejected; will re-run next activation version=${versionLabel} diagnostic=${JSON.stringify(diagnostic)}`
        );
    } catch {
        logChannel.appendLine(
            `[migration-runner] marker write for '${stepId}' rejected (diagnostic formatter threw)`
        );
    }
}

function logLastMigratedWriteFailure(
    logChannel: OutputChannel,
    observedVersion: string | null | undefined
): void {
    try {
        const diagnostic = safeDiagnostic({
            operation: 'migration-runner:lastMigratedVersion-write',
            credentialSource: 'unknown',
            errorClass: 'class:migration_state_write_failed',
            connectionState: 'failed',
        });
        const versionLabel =
            typeof observedVersion === 'string' && observedVersion.length > 0
                ? observedVersion
                : 'unknown';
        logChannel.appendLine(
            `[migration-runner] lastMigratedVersion write rejected; version=${versionLabel} diagnostic=${JSON.stringify(diagnostic)}`
        );
    } catch {
        logChannel.appendLine(
            '[migration-runner] lastMigratedVersion write rejected (diagnostic formatter threw)'
        );
    }
}