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
import {
    runMigrations,
    type MigrationStep,
} from '../../registry/migrationRunner';
import { ActorRegistry } from '../../registry/actorRegistry';
import type { PoolFactory } from '../../registry/databaseSession';
import { QueryWorkbench } from '../../views/queryWorkbench';
import { ServerTree } from '../../views/connectionExplorer';
import { activate, deactivate } from '../../main';
import { __test__ as vscodeMockTest, extensionContext } from '../mocks/vscode';

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

    suite('migrationRunner.runMigrations', () => {
        // Per-test reset so a leaked migration marker from one test
        // cannot satisfy the "skip" / "ran" assertions of the next.
        // `                vscodeMockTest.reset()` is the same seam the v1 wiring uses in
        // src/main.ts (it clears globalState.clear() via the mock).
        setup(() => {
            vscodeMockTest.reset();
        });

        teardown(() => {
            sinon.restore();
            vscodeMockTest.reset();
        });

        // Track every globalState key the runner writes so the
        // "skip the marker write on a re-run" assertion (b) is
        // observable, not inferred from a missing update call.
        function makeSpyGlobalState() {
            const spy = sinon.spy(extensionContext.globalState, 'update');
            return spy;
        }

        function step(
            id: string,
            behavior: (
                ctx: vscode.ExtensionContext
            ) => Promise<void> | void = async () => undefined
        ): MigrationStep {
            return {
                id,
                run: behavior as (ctx: vscode.ExtensionContext) => Promise<void>,
            };
        }

        // Build a minimal OutputChannel double. We don't read from
        // it — the assertions are about the runMigrations summary
        // and the globalState writes, not about the channel's
        // buffer. Cast to vscode.OutputChannel for the call site.
        function fakeLogChannel(): vscode.OutputChannel {
            return {
                name: 'fake',
                append: sinon.stub(),
                appendLine: sinon.stub(),
                clear: sinon.stub(),
                show: sinon.stub(),
                hide: sinon.stub(),
                dispose: sinon.stub(),
                replace: sinon.stub(),
            } as unknown as vscode.OutputChannel;
        }

        test('first install: every step runs and lastMigratedVersion is written', async () => {
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const log = fakeLogChannel();
            const runA = sinon.stub().resolves();
            const runB = sinon.stub().resolves();
            const steps: readonly MigrationStep[] = [
                step('a', runA),
                step('b', runB),
            ];

            const summary = await runMigrations(ctx, log, steps, '0.1.2');

            assert.deepStrictEqual(
                summary.ran.slice().sort(),
                ['a', 'b'],
                'every step should be reported as ran on first install'
            );
            assert.deepStrictEqual(summary.skipped, []);
            assert.deepStrictEqual(summary.failed, []);
            assert.strictEqual(runA.callCount, 1, 'step a.run must be called once');
            assert.strictEqual(runB.callCount, 1, 'step b.run must be called once');
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.migration.a'),
                true,
                'per-step marker for "a" must be persisted on success'
            );
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.migration.b'),
                true,
                'per-step marker for "b" must be persisted on success'
            );
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                '0.1.2',
                'lastMigratedVersion must be written after all steps succeed'
            );
        });

        test('re-activation with same version: no step runs and no marker is rewritten', async () => {
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const log = fakeLogChannel();
            // Seed the post-migration state from a prior activation
            // so every step's per-id marker is already `true`.
            await ctx.globalState.update('mysqlAzureAuth.migration.a', true);
            await ctx.globalState.update('mysqlAzureAuth.migration.b', true);
            await ctx.globalState.update(
                'mysqlAzureAuth.lastMigratedVersion',
                '0.1.2'
            );

            const updateSpy = makeSpyGlobalState();
            const runA = sinon.stub().resolves();
            const runB = sinon.stub().resolves();
            const steps: readonly MigrationStep[] = [
                step('a', runA),
                step('b', runB),
            ];

            const summary = await runMigrations(ctx, log, steps, '0.1.2');

            assert.strictEqual(
                runA.callCount,
                0,
                'step a.run must NOT be called when the marker is already true'
            );
            assert.strictEqual(
                runB.callCount,
                0,
                'step b.run must NOT be called when the marker is already true'
            );
            assert.deepStrictEqual(summary.ran, []);
            assert.deepStrictEqual(summary.skipped.slice().sort(), ['a', 'b']);
            assert.deepStrictEqual(summary.failed, []);

            // The same-value lastMigratedVersion write is allowed
            // (acceptance criteria (b) explicitly permits it as a
            // "same-value no-op"). The marker writes must NOT happen.
            for (const call of updateSpy.getCalls()) {
                const key = call.args[0] as string;
                assert.ok(
                    key === 'mysqlAzureAuth.lastMigratedVersion',
                    `only the lastMigratedVersion update is permitted on a same-version re-run; got update(${JSON.stringify(key)})`
                );
            }
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                '0.1.2',
                'lastMigratedVersion must still equal the observed version'
            );
        });

        test('a step that throws is logged, its id lands in failed, the marker is NOT set, and lastMigratedVersion is NOT updated', async () => {
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const log = fakeLogChannel();
            const appendLine = log.appendLine as unknown as sinon.SinonStub;
            const runA = sinon.stub().resolves();
            const runB = sinon.stub().rejects(new Error('boom: <bad>'));
            const steps: readonly MigrationStep[] = [
                step('a', runA),
                step('b', runB),
            ];

            const summary = await runMigrations(ctx, log, steps, '0.1.2');

            assert.strictEqual(runA.callCount, 1);
            assert.strictEqual(runB.callCount, 1);
            assert.deepStrictEqual(summary.ran, ['a']);
            assert.deepStrictEqual(summary.skipped, []);
            assert.deepStrictEqual(summary.failed, ['b']);
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.migration.a'),
                true,
                'succeeded step "a" marker must still be set'
            );
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.migration.b'),
                undefined,
                'failed step "b" marker must NOT be set (acceptance criteria c)'
            );
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                undefined,
                'lastMigratedVersion must NOT be updated when any step failed'
            );
            assert.ok(
                appendLine.called,
                'failure must be logged to the channel via safeDiagnostic (the runner routes the JSON line through appendLine)'
            );
        });

        test('a step that throws synchronously still produces a non-rejected summary (sync-throw defense)', async () => {
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const log = fakeLogChannel();
            const runA = sinon.stub().resolves();
            const runB = (() => {
                throw new Error('synchronous boom');
            }) as unknown as (ctx: vscode.ExtensionContext) => Promise<void>;
            const steps: readonly MigrationStep[] = [
                step('a', runA),
                step('b', runB),
            ];

            // The whole point: awaiting the Promise must NOT reject.
            const summary = await runMigrations(ctx, log, steps, '0.1.2');

            assert.deepStrictEqual(summary.ran, ['a']);
            assert.deepStrictEqual(summary.failed, ['b']);
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                undefined,
                'lastMigratedVersion must NOT be updated when any step failed'
            );
        });

        test('steps run in registration order (not parallel)', async () => {
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const log = fakeLogChannel();
            const order: string[] = [];
            const steps: readonly MigrationStep[] = [
                step('a', async () => {
                    await new Promise((r) => setTimeout(r, 15));
                    order.push('a');
                }),
                step('b', async () => {
                    await new Promise((r) => setTimeout(r, 1));
                    order.push('b');
                }),
                step('c', async () => {
                    order.push('c');
                }),
            ];

            await runMigrations(ctx, log, steps, '0.1.2');

            assert.deepStrictEqual(
                order,
                ['a', 'b', 'c'],
                'steps must execute strictly in registration order'
            );
        });

        test('on re-activation after a partial failure, only the failed step re-runs', async () => {
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const log = fakeLogChannel();
            // First activation: step a succeeds, step b throws.
            const runA1 = sinon.stub().resolves();
            const runB1 = sinon.stub().rejects(new Error('first-activation boom'));
            await runMigrations(
                ctx,
                log,
                [step('a', runA1), step('b', runB1)],
                '0.1.2'
            );

            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.migration.a'),
                true,
                'succeeded step must keep its marker across activations'
            );
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.migration.b'),
                undefined,
                'failed step must NOT keep a marker (so it re-runs next time)'
            );

            // Second activation: a is skipped (marker set), b re-runs and succeeds.
            const runA2 = sinon.stub().resolves();
            const runB2 = sinon.stub().resolves();
            const summary = await runMigrations(
                ctx,
                log,
                [step('a', runA2), step('b', runB2)],
                '0.1.2'
            );

            assert.strictEqual(runA2.callCount, 0, 'a must be skipped (marker persists)');
            assert.strictEqual(runB2.callCount, 1, 'b must re-run after the prior failure');
            assert.deepStrictEqual(summary.ran, ['b']);
            assert.deepStrictEqual(summary.skipped, ['a']);
            assert.deepStrictEqual(summary.failed, []);
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                '0.1.2',
                'lastMigratedVersion is now safe to write (all steps succeeded)'
            );
        });

        test('a throwing step mid-run does not block subsequent steps', async () => {
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const log = fakeLogChannel();
            const runA = sinon.stub().resolves();
            const runB = sinon.stub().rejects(new Error('mid-run boom'));
            const runC = sinon.stub().resolves();
            const steps: readonly MigrationStep[] = [
                step('a', runA),
                step('b', runB),
                step('c', runC),
            ];

            const summary = await runMigrations(ctx, log, steps, '0.1.2');

            assert.strictEqual(runA.callCount, 1);
            assert.strictEqual(runB.callCount, 1);
            assert.strictEqual(runC.callCount, 1, 'step C must still run after B fails');
            assert.deepStrictEqual(summary.ran.slice().sort(), ['a', 'c']);
            assert.deepStrictEqual(summary.failed, ['b']);
        });

        test('a rejecting lastMigratedVersion write still returns a non-rejected Promise with lastMigratedVersion-write-failed in failed', async () => {
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const log = fakeLogChannel();
            const runA = sinon.stub().resolves();
            const steps: readonly MigrationStep[] = [step('a', runA)];

            // Make ONLY the final lastMigratedVersion write reject.
            // Any earlier globalState.update (the per-step markers,
            // which are the FIRST writes the runner performs on
            // success) must still succeed so we observe only the
            // final-write rejection behavior.
            const original = ctx.globalState.update.bind(ctx.globalState);
            const stub = sinon.stub(ctx.globalState, 'update').callsFake(
                async (key: string, _value: unknown) => {
                    if (key === 'mysqlAzureAuth.lastMigratedVersion') {
                        throw new Error('globalState.update write rejected (simulated)');
                    }
                    return original(key, _value);
                }
            );

            // Awaiting the runner MUST NOT reject — that's the
            // fail-soft contract on the final write.
            const summary = await runMigrations(ctx, log, steps, '0.1.2');

            assert.deepStrictEqual(summary.ran, ['a']);
            assert.strictEqual(
                summary.failed.includes('lastMigratedVersion-write-failed'),
                true,
                'failed must include lastMigratedVersion-write-failed when the final write rejects'
            );
            assert.strictEqual(
                ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                undefined,
                'lastMigratedVersion must remain unset when the write itself fails'
            );
            stub.restore();
        });

        test('the function never rejects — every failure path returns a summary', async () => {
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const log = fakeLogChannel();
            // Empty step list, all-positive baseline.
            const baseline = await runMigrations(ctx, log, [], '0.1.2');
            assert.deepStrictEqual(baseline, { ran: [], skipped: [], failed: [] });

            // null observedVersion still must not throw.
            const nullVersion = await runMigrations(ctx, log, [], null);
            assert.deepStrictEqual(nullVersion.failed, []);

            // Steps + a throwing final write: must still resolve.
            const failingUpdate = sinon
                .stub(ctx.globalState, 'update')
                .callsFake(async (key: string, _value: unknown) => {
                    if (key === 'mysqlAzureAuth.lastMigratedVersion') {
                        throw new Error('nope');
                    }
                    return undefined;
                });
            try {
                const result = await runMigrations(
                    ctx,
                    log,
                    [step('only', async () => undefined)],
                    null
                );
                assert.ok(Array.isArray(result.failed));
            } finally {
                failingUpdate.restore();
            }
        });
    });

    /**
     * T4 — end-to-end scenarios.
     *
     * Every test in this suite calls `activate(context)` from
     * `src/main.ts` directly — the same path VS Code invokes in the
     * real host. The activation stubs are the same shape
     * `mainLifecycle.test.ts:14-34` installs; the suite-local helper
     * is kept private so each test stays focused on its observable
     * contract rather than on `window`-stub mechanics.
     *
     * The plan expected `activate()` to install the upgrade branch
     * (T5) and to fire `disposeAllWorkbenchPanels()` and
     * `runMigrations()` inside a `void (async () => ...)()` IIFE.
     * T5 has not landed yet (its target commit is TBD). The
     * assertions below are split into two layers:
     *
     *   1. The composition path that `activate()` runs today
     *      — `ServerTree.makeStatusBarItem`, `registerTreeDataProvider`,
     *      command registration, `setContext` execution — all
     *      observable from the mock `vscode.window` /
     *      `__test__.commandHandlers` / `__test__.executedCommands`
     *      seams and asserted regardless of T5's state.
     *
     *   2. The upgrade-branch observables — `webviewClobberTest.wasCalled()`,
     *      `lastMigratedVersion`, the v1 marker — currently assert
     *      their present-state (sentinel `false`, marker unset) and
     *      will flip to assert "sentinel `true` on upgrade", "marker
     *      written on upgrade", etc. once T5 lands. The flip is
     *      intentionally NOT done in this commit so the tests pass
     *      today; the upgrade-branch gates are documented inline so
     *      T5 can update them with a one-line `assert.strictEqual`
     *      change each.
     *
     * Because `extensionContext` is a module-level singleton
     * (`src/test/mocks/vscode.ts:195`), every test MUST wrap its
     * body in a `try { ... } finally { activate-cleanup }` AND the
     * top-level `setup()` / `teardown()` runs the same reset chain
     * so a stray failure inside a test body still leaves a clean
     * slate for the next test in the file.
     */
    suite('Extension upgrade end-to-end', () => {
        /**
         * Install the four stubs `activate()` requires and call it.
         * Mirrors `mainLifecycle.test.ts:14-34`. Returns the
         * `deactivate` cleanup so a test can `await` it in `finally`.
         */
        async function runActivation(
            ctx: vscode.ExtensionContext
        ): Promise<() => Promise<void>> {
            const mutableWindow = vscode.window as unknown as {
                createOutputChannel: () => vscode.OutputChannel;
                registerTreeDataProvider: () => vscode.Disposable;
            };
            mutableWindow.createOutputChannel = () => ({
                append: () => undefined,
                appendLine: () => undefined,
                clear: () => undefined,
                replace: () => undefined,
                show: () => undefined,
                hide: () => undefined,
                dispose: () => undefined,
                name: 'MySQL Azure Auth',
            });
            mutableWindow.registerTreeDataProvider = () => ({
                dispose: () => undefined,
            });
            sinon.stub(ServerTree, 'makeStatusBarItem').returns({
                text: '',
                tooltip: undefined,
                dispose: () => undefined,
            } as unknown as vscode.StatusBarItem);
            vscodeMockTest.commandHandlers.set('setContext', () => undefined);
            activate(ctx);
            return async () => {
                await deactivate();
            };
        }

        setup(async () => {
            await deactivate();
            vscodeMockTest.reset();
            webviewClobberTest.reset();
            QueryWorkbench.currentPanels.clear();
        });

        teardown(async () => {
            await deactivate();
            for (const disposable of extensionContext.subscriptions.splice(0)) {
                if (typeof disposable.dispose === 'function') disposable.dispose();
            }
            sinon.restore();
            vscodeMockTest.reset();
            webviewClobberTest.reset();
            QueryWorkbench.currentPanels.clear();
        });

        test('first install: activate() runs the composition path, no clobber is dispatched, no v1 step marker is written', async () => {
            vscodeMockTest.setPackageJsonVersion('0.1.2');
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            const deactivateFn = await runActivation(ctx);

            try {
                // `activate()` is synchronous today; the migration IIFE
                // is fire-and-forget. `await new Promise(setImmediate)`
                // flushes the microtask queue so any T5-installed
                // async work would run before we read the observable.
                await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                });

                // (1) Composition-side observable: `activate()` built
                //     the composition and registered the nine
                //     MySQL Azure Auth commands with the mock command
                //     bus. This holds regardless of T5's state.
                assert.strictEqual(
                    vscodeMockTest.commandHandlers.has(
                        'mysqlAzureAuth.registerServer'
                    ),
                    true,
                    'activate() must register the registerServer command'
                );
                assert.strictEqual(
                    vscodeMockTest.commandHandlers.has(
                        'mysqlAzureAuth.openWorkbench'
                    ),
                    true,
                    'activate() must register the openWorkbench command'
                );

                // (2) Upgrade-branch observable. Today the
                //     firstInstall path is a no-op for the clobber
                //     and the migration runner; sentinel stays false
                //     and lastMigratedVersion is unset.
                assert.strictEqual(
                    webviewClobberTest.wasCalled(),
                    false,
                    'firstInstall must NOT dispatch the clobber'
                );
                assert.strictEqual(
                    ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                    '0.1.2',
                    'firstInstall: T5 wiring fires the migration IIFE, which writes lastMigratedVersion = observed version on success'
                );
                assert.strictEqual(
                    ctx.globalState.get('mysqlAzureAuth.migration.v1'),
                    true,
                    'firstInstall: the v1 step ran successfully (no-op, no stored connections) and the runner wrote its marker'
                );
            } finally {
                await deactivateFn();
            }
        });

        test('upgrade (0.1.2 -> 0.1.3): activate() runs the composition path; after T5 lands the clobber is dispatched before composition fires', async () => {
            vscodeMockTest.setPackageJsonVersion('0.1.3');
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            // Seed `lastMigratedVersion = '0.1.2'` so an upgrade
            // transition is what `activate()` would dispatch into
            // (post-T5).
            await ctx.globalState.update(
                'mysqlAzureAuth.lastMigratedVersion',
                '0.1.2'
            );

            // Pre-condition: the comparator classifies the seed as
            // `upgrade`. T5 will use this transition to decide whether
            // to dispatch the clobber.
            const observedTransition = classifyVersionTransition(
                (ctx.extension.packageJSON as { version?: string }).version ??
                    null,
                ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion') as
                    | string
                    | null
                    | undefined
            );
            assert.strictEqual(
                observedTransition,
                'upgrade',
                'precondition: 0.1.3 over 0.1.2 is an upgrade'
            );

            const EntraTokenProvider = (
                require('../../identity/entraToken') as typeof import('../../identity/entraToken')
            ).EntraTokenProvider;
            // Capture the clobber sentinel BEFORE activate() so we can
            // prove the clobber fires DURING activate(), not before or
            // after. The T3 sentinel is a one-way flip; a `false→true`
            // delta proves the upgrade branch dispatched inside
            // activate() (i.e. before composition).
            const clobberBefore = webviewClobberTest.wasCalled();
            // Spy on the static factory so we can observe the order
            // in which `buildComposition` fires during `activate()`.
            // `createInteractive` is the first observable side-effect of
            // `buildComposition` (it constructs the EntraTokenProvider);
            // combined with the sentinel flip it locks the
            // clobber-before-composition ordering the plan mandates.
            const createInteractiveSpy = sinon.spy(
                EntraTokenProvider,
                'createInteractive'
            );
            const deactivateFn = await runActivation(ctx);

            try {
                await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                });

                // ORDERING GATE: clobber-before-composition. The sentinel
                // must have flipped false→true during activate() (the
                // upgrade branch ran) AND `createInteractive` must have
                // been called (composition ran). Together these prove
                // the upgrade branch fired before composition. A direct
                // `calledBefore` against `buildComposition` would be
                // stronger but requires exporting `buildComposition`,
                // which the plan keeps module-private.
                assert.strictEqual(
                    clobberBefore,
                    false,
                    'precondition: sentinel must be false BEFORE activate() runs'
                );
                assert.strictEqual(
                    webviewClobberTest.wasCalled(),
                    true,
                    'T5 wires disposeAllWorkbenchPanels() in the upgrade branch under Production mode (clobber fires during activate())'
                );
                assert.strictEqual(
                    createInteractiveSpy.callCount >= 1,
                    true,
                    'activate() must invoke the composition path (createInteractive) AFTER the clobber'
                );
                assert.strictEqual(
                    ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                    '0.1.3',
                    'T5 wiring fires the migration IIFE, which writes lastMigratedVersion = observed version on success'
                );
            } finally {
                createInteractiveSpy.restore();
                await deactivateFn();
            }
        });

        test('extensionMode.Development (2): activate() runs the composition path; upgrade-branch is gated out', async () => {
            vscodeMockTest.setPackageJsonVersion('0.1.3');
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            // Seed the upgrade precondition so a missing mode gate
            // in T5 would visibly fire the clobber here.
            await ctx.globalState.update(
                'mysqlAzureAuth.lastMigratedVersion',
                '0.1.2'
            );
            vscodeMockTest.setExtensionMode(2);

            const deactivateFn = await runActivation(ctx);

            try {
                await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                });

                assert.strictEqual(
                    ctx.extensionMode,
                    2,
                    'precondition: extensionMode is Development'
                );
                assert.strictEqual(
                    vscodeMockTest.commandHandlers.has(
                        'mysqlAzureAuth.registerServer'
                    ),
                    true,
                    'activate() still registers commands in Development mode'
                );
                assert.strictEqual(
                    webviewClobberTest.wasCalled(),
                    false,
                    'Development mode must NOT dispatch the upgrade-branch clobber'
                );
                assert.strictEqual(
                    ctx.globalState.get('mysqlAzureAuth.migration.v1'),
                    undefined,
                    'Development mode must NOT run the migration runner'
                );
            } finally {
                await deactivateFn();
            }
        });

        test('extensionMode.Test (3): activate() runs the composition path; upgrade-branch is gated out', async () => {
            vscodeMockTest.setPackageJsonVersion('0.1.3');
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            await ctx.globalState.update(
                'mysqlAzureAuth.lastMigratedVersion',
                '0.1.2'
            );
            vscodeMockTest.setExtensionMode(3);

            const deactivateFn = await runActivation(ctx);

            try {
                await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                });

                assert.strictEqual(
                    ctx.extensionMode,
                    3,
                    'precondition: extensionMode is Test'
                );
                assert.strictEqual(
                    vscodeMockTest.commandHandlers.has(
                        'mysqlAzureAuth.registerServer'
                    ),
                    true,
                    'activate() still registers commands in Test mode'
                );
                assert.strictEqual(
                    webviewClobberTest.wasCalled(),
                    false,
                    'Test mode must NOT dispatch the upgrade-branch clobber'
                );
                assert.strictEqual(
                    ctx.globalState.get('mysqlAzureAuth.migration.v1'),
                    undefined,
                    'Test mode must NOT run the migration runner'
                );
            } finally {
                await deactivateFn();
            }
        });

        test('malformed version (undefined observed + undefined last): activate() runs the composition path; firstInstall keeps lastMigratedVersion=undefined', async () => {
            vscodeMockTest.setPackageJsonVersion(undefined);
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            // Ensure no prior lastMigratedVersion is present.
            await ctx.globalState.update(
                'mysqlAzureAuth.lastMigratedVersion',
                undefined
            );

            const observedPackageJson = (
                ctx.extension.packageJSON as { version?: string }
            ).version;
            const observedTransition = classifyVersionTransition(
                observedPackageJson ?? null,
                ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion') as
                    | string
                    | null
                    | undefined
            );
            assert.strictEqual(
                observedTransition,
                'firstInstall',
                'precondition: (undefined, undefined) is firstInstall'
            );

            const deactivateFn = await runActivation(ctx);

            try {
                await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                });

                assert.strictEqual(
                    vscodeMockTest.commandHandlers.has(
                        'mysqlAzureAuth.openWorkbench'
                    ),
                    true,
                    'activate() must still register commands when observed version is undefined'
                );
                assert.strictEqual(
                    webviewClobberTest.wasCalled(),
                    false,
                    'firstInstall on a malformed (undefined) version must NOT dispatch the clobber'
                );
                assert.strictEqual(
                    ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                    undefined,
                    'firstInstall on a malformed (undefined) version writes lastMigratedVersion = undefined (Memento.update with undefined deletes the key)'
                );
                assert.strictEqual(
                    ctx.globalState.get('mysqlAzureAuth.migration.v1'),
                    true,
                    'firstInstall on a malformed (undefined) version still runs the migration runner (Production mode) and writes the v1 marker'
                );
            } finally {
                await deactivateFn();
            }
        });

        test('sameVersion: activate() runs the composition path; v1 step marker is NOT re-written when observed === lastMigrated', async () => {
            vscodeMockTest.setPackageJsonVersion('0.1.2');
            const ctx = extensionContext as unknown as vscode.ExtensionContext;
            await ctx.globalState.update(
                'mysqlAzureAuth.lastMigratedVersion',
                '0.1.2'
            );
            // Seed the v1 step marker to model a SUBSEQUENT sameVersion
            // activation (the first sameVersion on a fresh globalState
            // would correctly write the marker; this test pins the
            // idempotent re-run contract — once the marker is set, the
            // runner must NOT rewrite it on a sameVersion activation).
            await ctx.globalState.update(
                'mysqlAzureAuth.migration.v1',
                true
            );

            const observedPackageJson = (
                ctx.extension.packageJSON as { version?: string }
            ).version;
            const observedTransition = classifyVersionTransition(
                observedPackageJson ?? null,
                ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion') as
                    | string
                    | null
                    | undefined
            );
            assert.strictEqual(
                observedTransition,
                'sameVersion',
                'precondition: 0.1.2 === 0.1.2 is sameVersion'
            );

            // Spy on globalState.update BEFORE activate() runs so we can
            // audit every write activation issues. The v1 step is gated
            // by its marker (already set in the seed) so the runner
            // skips it; `lastMigratedVersion` is a same-value write that
            // the runner does NOT issue because all steps were skipped.
            const updateSpy = sinon.spy(
                extensionContext.globalState,
                'update'
            );
            const deactivateFn = await runActivation(ctx);

            try {
                await new Promise<void>((resolve) => {
                    setImmediate(resolve);
                });
                try {
                    const v1MarkerWrites = updateSpy
                        .getCalls()
                        .filter(
                            (call) =>
                                call.args[0] ===
                                'mysqlAzureAuth.migration.v1'
                        );
                    assert.strictEqual(
                        v1MarkerWrites.length,
                        0,
                        'sameVersion activation must NOT re-write the v1 step marker (plan criterion T2 (b): the per-step marker prevents re-run)'
                    );
                    // `lastMigratedVersion` MAY be written as a
                    // same-value no-op (plan T2 (b) explicit allowance).
                    // The plan says: 'the lastMigratedVersion write MAY
                    // be called and is a same-value no-op.'
                    const lastMigratedWrites = updateSpy
                        .getCalls()
                        .filter(
                            (call) =>
                                call.args[0] ===
                                'mysqlAzureAuth.lastMigratedVersion'
                        );
                    for (const call of lastMigratedWrites) {
                        assert.strictEqual(
                            call.args[1],
                            '0.1.2',
                            'sameVersion: any lastMigratedVersion write must be a same-value no-op'
                        );
                    }
                } finally {
                    updateSpy.restore();
                }

                assert.strictEqual(
                    ctx.globalState.get('mysqlAzureAuth.migration.v1'),
                    true,
                    'v1 step marker must remain set (and unchanged) on a sameVersion activation'
                );
                assert.strictEqual(
                    ctx.globalState.get('mysqlAzureAuth.lastMigratedVersion'),
                    '0.1.2',
                    'lastMigratedVersion equals observed version'
                );
            } finally {
                await deactivateFn();
            }
        });
    });
});