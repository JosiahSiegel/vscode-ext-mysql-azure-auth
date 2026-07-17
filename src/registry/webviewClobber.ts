/**
 * webviewClobber — dispose every open QueryWorkbench panel.
 *
 * On an upgrade / downgrade / malformedVersion activation the
 * previously open webviews are running the prior extension's HTML
 * and JavaScript, so they will look stale no matter how the manifest
 * is updated. The only safe move is to dispose them so the next
 * `QueryWorkbench.createOrShow` call for the same `connectionId`
 * rebuilds the panel from the current build.
 *
 * Why snapshot-first then clear-before-iterating:
 *
 *   1. `dispose()` removes its own entry from `currentPanels`
 *      (`src/views/queryWorkbench.ts:402`). Iterating the live map
 *      while those removes are happening throws
 *      `Map iterator undefined` on the next `.next()` step.
 *   2. The `dispose()` body also fires `panel.onDidDispose`
 *      listeners which — depending on user code — could call
 *      `createOrShow` for the same `connectionId`. We clear the map
 *      BEFORE iterating the snapshot so a re-entrant `createOrShow`
 *      lands in a fresh map slot and does not race with the
 *      iteration or get clobbered by it.
 *   3. Each `panel.dispose()` call is wrapped in a try/catch so one
 *      panel's failure (e.g. a VS Code host that has already torn
 *      the panel down) does not strand the others. The `disposed`
 *      short-circuit inside `QueryWorkbench.dispose`
 *      (`src/views/queryWorkbench.ts:400`) means re-entry is also
 *      safe; this is belt-and-suspenders.
 *
 * Sentinel:
 *
 * `__test__.wasCalled()` flips to `true` after the first call to
 * `disposeAllWorkbenchPanels()` so the activation wiring (T5) can
 * observe whether the clobber actually ran in the upgrade branch
 * without reading a private flag. `__test__.reset()` clears the
 * sentinel back to `false`. Production callers MUST NOT use the
 * `__test__` export — the namespace is a test-only seam.
 */

import { QueryWorkbench } from '../views/queryWorkbench';

let wasDisposed = false;

/**
 * Dispose every entry in `QueryWorkbench.currentPanels`.
 *
 * The implementation:
 *
 *   1. Snapshots the current values to a local array.
 *   2. Clears the static map BEFORE iterating.
 *   3. Calls `dispose()` on each snapshot entry, catching any
 *      individual failure so the rest are still attempted.
 *
 * Returns void; never throws.
 */
export function disposeAllWorkbenchPanels(): void {
    wasDisposed = true;
    const snapshot = Array.from(QueryWorkbench.currentPanels.values());
    QueryWorkbench.currentPanels.clear();
    for (const panel of snapshot) {
        try {
            panel.dispose();
        } catch {
            // The `disposed` short-circuit inside `QueryWorkbench.dispose`
            // already makes re-entry safe; this catch is here so a host
            // that has torn the panel down before we reached it does
            // not strand the other panels in the snapshot.
        }
    }
}

/**
 * Dispose a single entry by `connectionId`, if present.
 *
 * Used by the per-id dispose seam that the test suite exercises
 * directly; the production wiring goes through `disposeAllWorkbenchPanels`.
 * Silently no-ops when the id is absent — the caller's intent is
 * "ensure this panel is gone", not "assert it was there".
 */
export function disposeWorkbenchPanel(id: string): void {
    const panel = QueryWorkbench.currentPanels.get(id);
    if (!panel) return;
    QueryWorkbench.currentPanels.delete(id);
    try {
        panel.dispose();
    } catch {
        // same defense-in-depth as disposeAllWorkbenchPanels
    }
}

/**
 * Test-only seam. Production callers MUST NOT import this namespace.
 */
export const __test__ = {
    wasCalled(): boolean {
        return wasDisposed;
    },
    reset(): void {
        wasDisposed = false;
    },
};
