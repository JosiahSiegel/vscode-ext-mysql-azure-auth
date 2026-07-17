/**
 * Tests for the extension upgrade state machine (Todos T1 + T3).
 *
 * T1 — version tracker
 *
 * The version tracker compares the version VS Code is loading now
 * (`observed`) against the version that was last persisted after a
 * successful migration run (`lastMigrated`) and classifies the
 * activation as one of:
 *
 *   - firstInstall       — no prior migration (lastMigrated is absent).
 *   - sameVersion        — observed === lastMigrated.
 *   - upgrade            — observed > lastMigrated.
 *   - downgrade          — observed < lastMigrated.
 *   - malformedVersion   — at least one side is not a valid numeric
 *                          three-part semver (the only supported
 *                          subset; pre-release suffixes are not).
 *
 * These tests exercise the comparator through the public exports
 * directly — no vscode mock is needed because the function is pure.
 *
 * T3 — webview clobber
 *
 * The clobber must (a) drain the `currentPanels` map without
 * mutating it during iteration, (b) call `dispose()` exactly once
 * per seeded panel, (c) leave the map empty so the next
 * `createOrShow` for the same `connectionId` produces a NEW workbench
 * instance, and (d) expose a `__test__` sentinel via
 * `wasCalled()` / `reset()` so the activation wiring can observe
 * whether the clobber actually ran in the upgrade branch without
 * reading a private flag.
 *
 * The `suite('Extension upgrade')` wrapper is shared by T4 when it
 * lands; T1 contributes `versionTracker.classifyVersionTransition`
 * and `versionTracker.isNumericThreePart`; T3 contributes
 * `webviewClobber.disposeAllWorkbenchPanels`.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import {
    classifyVersionTransition,
    isNumericThreePart,
} from '../../registry/versionTracker';
import {
    disposeAllWorkbenchPanels,
    disposeWorkbenchPanel,
    __test__ as webviewClobberTest,
} from '../../registry/webviewClobber';
import { ActorRegistry } from '../../registry/actorRegistry';
import type { PoolFactory } from '../../registry/databaseSession';
import { QueryWorkbench } from '../../views/queryWorkbench';
import { extensionContext } from '../mocks/vscode';

suite('Extension upgrade', () => {
    suite('versionTracker.classifyVersionTransition', () => {
        const cases: ReadonlyArray<{
            readonly name: string;
            readonly observed: string | null | undefined;
            readonly lastMigrated: string | null | undefined;
            readonly expected:
                | 'firstInstall'
                | 'sameVersion'
                | 'upgrade'
                | 'downgrade'
                | 'malformedVersion';
        }> = [
            {
                name: '(undefined, undefined) → firstInstall',
                observed: undefined,
                lastMigrated: undefined,
                expected: 'firstInstall',
            },
            {
                name: "('0.1.2', undefined) → firstInstall",
                observed: '0.1.2',
                lastMigrated: undefined,
                expected: 'firstInstall',
            },
            {
                name: "('0.1.2', '0.1.2') → sameVersion",
                observed: '0.1.2',
                lastMigrated: '0.1.2',
                expected: 'sameVersion',
            },
            {
                name: "('0.1.2', '0.1.1') → upgrade",
                observed: '0.1.2',
                lastMigrated: '0.1.1',
                expected: 'upgrade',
            },
            {
                name: "('0.1.1', '0.1.2') → downgrade",
                observed: '0.1.1',
                lastMigrated: '0.1.2',
                expected: 'downgrade',
            },
            {
                name: "('0.1.2', 'malformed') → upgrade",
                observed: '0.1.2',
                lastMigrated: 'malformed',
                expected: 'upgrade',
            },
            {
                name: "(undefined, '0.1.2') → malformedVersion",
                observed: undefined,
                lastMigrated: '0.1.2',
                expected: 'malformedVersion',
            },
            {
                name: "('1.0', '0.9.0') → malformedVersion",
                observed: '1.0',
                lastMigrated: '0.9.0',
                expected: 'malformedVersion',
            },
            {
                name: "('0.1.2-rc.1', '0.1.2') → malformedVersion",
                observed: '0.1.2-rc.1',
                lastMigrated: '0.1.2',
                expected: 'malformedVersion',
            },
            {
                name: '(null, null) → firstInstall',
                observed: null,
                lastMigrated: null,
                expected: 'firstInstall',
            },
            {
                name: "(null, '0.1.2') → malformedVersion",
                observed: null,
                lastMigrated: '0.1.2',
                expected: 'malformedVersion',
            },
            {
                name: "('0.1.2', null) → firstInstall",
                observed: '0.1.2',
                lastMigrated: null,
                expected: 'firstInstall',
            },
            {
                name: "('0.2.0', '0.10.0') → downgrade (numeric, not lexicographic)",
                observed: '0.2.0',
                lastMigrated: '0.10.0',
                expected: 'downgrade',
            },
        ];

        for (const c of cases) {
            test(c.name, () => {
                assert.strictEqual(
                    classifyVersionTransition(c.observed, c.lastMigrated),
                    c.expected
                );
            });
        }

        test('tolerates null inputs without calling string methods', () => {
            // Regression guard: prior to the null→undefined normalization
            // at the top of classifyVersionTransition, passing `null`
            // would throw a TypeError when the comparator called
            // `.split('.')`. Asserting the call returns cleanly is the
            // whole point of the normalization step.
            assert.strictEqual(
                classifyVersionTransition(null, null),
                'firstInstall'
            );
            assert.strictEqual(
                classifyVersionTransition(null, '0.1.2'),
                'malformedVersion'
            );
            assert.strictEqual(
                classifyVersionTransition('0.1.2', null),
                'firstInstall'
            );
        });
    });

    suite('versionTracker.isNumericThreePart', () => {
        test("isNumericThreePart('0.1.2') is true", () => {
            assert.strictEqual(isNumericThreePart('0.1.2'), true);
        });

        test("isNumericThreePart('1.0') is false", () => {
            assert.strictEqual(isNumericThreePart('1.0'), false);
        });

        test("isNumericThreePart('') is false", () => {
            assert.strictEqual(isNumericThreePart(''), false);
        });

        test("isNumericThreePart('0.1.2-rc.1') is false", () => {
            assert.strictEqual(isNumericThreePart('0.1.2-rc.1'), false);
        });
    });

    suite('webviewClobber.disposeAllWorkbenchPanels', () => {
        // Per-test reset of the clobber sentinel + the QueryWorkbench
        // registry so leaks from a prior test cannot satisfy the next
        // test's "empty" assertions or flip its `wasCalled()` check.
        setup(() => {
            webviewClobberTest.reset();
            QueryWorkbench.currentPanels.clear();
        });

        teardown(() => {
            sinon.restore();
            QueryWorkbench.currentPanels.clear();
            webviewClobberTest.reset();
        });

        type CapturedMessage = Record<string, unknown>;
        type CapturingPanel = {
            readonly received: CapturedMessage[];
            readonly dispose: sinon.SinonStub;
            readonly reveal: sinon.SinonStub;
            postMessage: (msg: unknown) => Promise<boolean>;
        };

        function installPanelFactory() {
            const seenPanels: CapturingPanel[] = [];
            const original = vscode.window.createWebviewPanel;
            (vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel =
                (() => {
                    const panel: CapturingPanel = {
                        received: [],
                        dispose: sinon.stub(),
                        reveal: sinon.stub(),
                        postMessage: async (msg: unknown) => {
                            panel.received.push(msg as CapturedMessage);
                            return true;
                        },
                    };
                    // The workbench calls `panel.webview.onDidReceiveMessage` and
                    // `panel.onDidDispose` and never inspects the returned
                    // disposables, so a null-returning stub is sufficient.
                    const stubPanel = {
                        webview: {
                            html: '',
                            onDidReceiveMessage: () => ({ dispose: () => undefined }),
                            postMessage: panel.postMessage,
                            asWebviewUri: (uri: unknown) => uri,
                        },
                        onDidDispose: () => ({ dispose: () => undefined }),
                        dispose: panel.dispose,
                        reveal: panel.reveal,
                    };
                    seenPanels.push(panel);
                    return stubPanel as unknown as ReturnType<typeof vscode.window.createWebviewPanel>;
                }) as unknown as typeof vscode.window.createWebviewPanel;
            const restore = () => {
                (vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel = original;
            };
            return { seenPanels, restore };
        }

        // Flatten the factory handle to a `restore()` method so each
        // test can write `const ctx = await seedPanels(N); try { ... }
        // finally { ctx.restore(); }` without nested property paths.
        async function seedPanels(
            count: number
        ): Promise<ReturnType<typeof installPanelFactory>> {
            const handle = installPanelFactory();
            try {
                const poolStub: PoolFactory = (() => ({
                    execute: async () => [[], []],
                    end: async () => undefined,
                })) as unknown as PoolFactory;
                const registry = new ActorRegistry({
                    identity: {
                        async getAccessToken(): Promise<string> {
                            return 'clobber-test-token';
                        },
                    },
                    poolFactory: poolStub,
                });
                const ctx = extensionContext as unknown as vscode.ExtensionContext;
                const ids = Array.from({ length: count }, (_, i) => `cfg-clobber-${i}`);
                for (const id of ids) {
                    QueryWorkbench.createOrShow(
                        extensionContext.extensionUri as unknown as vscode.Uri,
                        id,
                        `production-${id}`,
                        // The clobber tests don't exercise query
                        // execution; the registry only needs a real
                        // shape so `QueryWorkbench`'s constructor
                        // (`src/views/queryWorkbench.ts:119`) can
                        // call `registry.getConfig`.
                        { registry, context: ctx }
                    );
                }
                return handle;
            } catch (err) {
                handle.restore();
                throw err;
            }
        }

        test('clears currentPanels and calls dispose once per panel when 3 are seeded', async () => {
            const ctx = await seedPanels(3);
            // Spying on the prototype method captures every panel's
            // dispose() invocation. The TS-emitted class puts `dispose`
            // on `QueryWorkbench.prototype` (so it IS an own property
            // of that prototype, not of an instance).
            const disposeSpy = sinon.spy(
                QueryWorkbench.prototype as unknown as { dispose: () => void },
                'dispose'
            );
            try {
                assert.strictEqual(QueryWorkbench.currentPanels.size, 3);

                disposeAllWorkbenchPanels();

                assert.strictEqual(
                    QueryWorkbench.currentPanels.size,
                    0,
                    'currentPanels must be empty after a clobber'
                );
                assert.strictEqual(
                    disposeSpy.callCount,
                    3,
                    'expected QueryWorkbench.prototype.dispose to be invoked exactly 3 times, got ' +
                        disposeSpy.callCount
                );
            } finally {
                disposeSpy.restore();
                ctx.restore();
            }
        });

        test('is idempotent — calling it twice does not throw and the map stays empty', async () => {
            const ctx = await seedPanels(2);
            try {
                disposeAllWorkbenchPanels();
                assert.doesNotThrow(() => disposeAllWorkbenchPanels());
                assert.strictEqual(
                    QueryWorkbench.currentPanels.size,
                    0,
                    'currentPanels must remain empty after a second clobber'
                );
            } finally {
                ctx.restore();
            }
        });

        test('subsequent createOrShow for the same connectionId yields a fresh workbench identity', async () => {
            const ctx = await seedPanels(1);
            try {
                const original = QueryWorkbench.currentPanels.get('cfg-clobber-0');
                assert.ok(original, 'expected the seeded panel to be in the registry');

                disposeAllWorkbenchPanels();

                // The dispose call already removed the entry from the map
                // (see src/views/queryWorkbench.ts:402). The next assertion
                // confirms createOrShow inserts a NEW instance rather than
                // resurrecting the disposed one.
                assert.strictEqual(
                    QueryWorkbench.currentPanels.has('cfg-clobber-0'),
                    false,
                    'disposeAllWorkbenchPanels must remove the entry from the map'
                );

                // A fresh registry handles the second `createOrShow`
                // because the original panel's seeded connectionId
                // was destroyed when the panel was disposed.
                const poolStub: PoolFactory = (() => ({
                    execute: async () => [[], []],
                    end: async () => undefined,
                })) as unknown as PoolFactory;
                const replacementRegistry = new ActorRegistry({
                    identity: { async getAccessToken(): Promise<string> { return 't'; } },
                    poolFactory: poolStub,
                });
                const extCtx = extensionContext as unknown as vscode.ExtensionContext;
                const replacement = QueryWorkbench.createOrShow(
                    extensionContext.extensionUri as unknown as vscode.Uri,
                    'cfg-clobber-0',
                    'production-cfg-clobber-0',
                    { registry: replacementRegistry, context: extCtx }
                );

                assert.notStrictEqual(
                    replacement,
                    original,
                    'createOrShow after a clobber must return a NEW workbench instance'
                );
            } finally {
                ctx.restore();
            }
        });

        test('__test__.wasCalled() flips on disposeAllWorkbenchPanels and __test__.reset() clears it', async () => {
            const ctx = await seedPanels(1);
            try {
                assert.strictEqual(
                    webviewClobberTest.wasCalled(),
                    false,
                    'wasCalled() must start false (the suite-level setup() calls reset())'
                );

                disposeAllWorkbenchPanels();

                assert.strictEqual(
                    webviewClobberTest.wasCalled(),
                    true,
                    'wasCalled() must flip to true after a clobber'
                );

                webviewClobberTest.reset();

                assert.strictEqual(
                    webviewClobberTest.wasCalled(),
                    false,
                    'wasCalled() must return to false after reset()'
                );
            } finally {
                ctx.restore();
            }
        });

        test('disposeWorkbenchPanel clears a single panel without affecting siblings', async () => {
            const ctx = await seedPanels(2);
            try {
                assert.strictEqual(QueryWorkbench.currentPanels.size, 2);
                disposeWorkbenchPanel('cfg-clobber-0');
                assert.strictEqual(
                    QueryWorkbench.currentPanels.size,
                    1,
                    'disposeWorkbenchPanel must remove exactly the targeted entry'
                );
                assert.strictEqual(
                    QueryWorkbench.currentPanels.has('cfg-clobber-1'),
                    true,
                    'sibling entry must survive a single-entry dispose'
                );
                assert.strictEqual(
                    QueryWorkbench.currentPanels.has('cfg-clobber-0'),
                    false,
                    'target entry must be gone after a single-entry dispose'
                );
            } finally {
                ctx.restore();
            }
        });
    });
});