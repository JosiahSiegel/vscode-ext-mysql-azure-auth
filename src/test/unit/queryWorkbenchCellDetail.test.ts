/**
 * Tests for per-statement cell detail ownership in QueryWorkbench.
 *
 * The bug being fixed: showCellDetail previously looked up cells only against
 * `lastResult`, so clicking a cell in statement 0 after statement 1 had
 * completed returned the wrong value. The fix routes lookups through
 * `statementResults[statementIndex]`.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ActorRegistry } from '../../registry/actorRegistry';
import type {
    DatabaseSessionConfig,
    PoolFactory,
    PoolLike,
} from '../../registry/databaseSession';

type PostMessage = (msg: unknown) => Promise<boolean>;
type ReceivedMessage = { type: string; [key: string]: unknown };

function createCapturingPanel() {
    const received: ReceivedMessage[] = [];
    let onDidReceive: ((msg: unknown) => void | Promise<void>) | undefined;
    const dispose = sinon.stub();
    const reveal = sinon.stub();
    const postMessage: PostMessage = async (msg) => {
        received.push(msg as ReceivedMessage);
        return true;
    };
    const onDidDispose = sinon.stub();
    const panel = {
        webview: {
            html: '',
            onDidReceiveMessage: (listener: (msg: unknown) => void | Promise<void>) => {
                onDidReceive = listener;
                return { dispose };
            },
            postMessage,
            asWebviewUri: (uri: unknown) => uri,
        },
        onDidDispose: (listener: () => void) => {
            onDidDispose(listener);
            return { dispose };
        },
        dispose,
        reveal,
    };
    const original = vscode.window.createWebviewPanel;
    (vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel =
        () => panel as unknown as ReturnType<typeof vscode.window.createWebviewPanel>;
    return {
        received,
        fireReady() {
            if (!onDidReceive) throw new Error('onDidReceive not registered');
            return onDidReceive({ command: 'ready' });
        },
        fireShowCellDetail(statementIndex: number, rowIndex: number, column: string) {
            if (!onDidReceive) throw new Error('onDidReceive not registered');
            return onDidReceive({ command: 'showCellDetail', statementIndex, rowIndex, column });
        },
        restore() {
            (vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel =
                original;
        },
    };
}

function buildSequentialPool(
    perExecute: ReadonlyArray<readonly [readonly Record<string, unknown>[], { name: string }[]]>
) {
    let index = 0;
    const fakeEnd = sinon.stub().resolves();
    const fakeExecute = sinon.stub().callsFake(async () => {
        const slot = perExecute[Math.min(index, perExecute.length - 1)]!;
        index += 1;
        return [slot[0], slot[1]] as [readonly Record<string, unknown>[], { name: string }[]];
    });
    const factory: PoolFactory = (_config: DatabaseSessionConfig): PoolLike => ({
        execute: fakeExecute as unknown as PoolLike['execute'],
        end: fakeEnd as unknown as () => Promise<void>,
    });
    return { factory, fakeExecute, fakeEnd };
}

async function importWorkbench() {
    const mod = await import('../../views/queryWorkbench');
    return mod.QueryWorkbench;
}

async function connectAndCreate(
    QueryWorkbench: typeof import('../../views/queryWorkbench').QueryWorkbench,
    factory: PoolFactory,
    ctx: import('vscode').ExtensionContext,
    config: { id: string; name: string }
) {
    const { GlobalStateConnectionCatalog } = await import('../../registry/connectionCatalog');
    const { makeConnectionConfig } = await import('../factories/connectionConfig');
    const connRegistry = new ActorRegistry({ poolFactory: factory });
    const catalog = new GlobalStateConnectionCatalog(ctx);
    await catalog.add(makeConnectionConfig({ id: config.id, name: config.name }));
    await connRegistry.connect(config.id, makeConnectionConfig({ id: config.id, name: config.name }));
    const panel = QueryWorkbench.createOrShow(ctx.extensionUri, config.id, config.name, {
        registry: connRegistry,
        context: ctx,
    });
    return { panel, connRegistry };
}

suite('QueryWorkbench cell detail per-statement ownership', () => {
    test('returns value from the requested statement, not the last result', async () => {
        const capture = createCapturingPanel();
        try {
            const ctx = (await import('../mocks/vscode')).extensionContext as unknown as import('vscode').ExtensionContext;
            const QueryWorkbench = await importWorkbench();
            const factory = buildSequentialPool([
                [[{ id: 100 }, { id: 200 }], [{ name: 'id' }]],
                [[{ id: 999 }], [{ name: 'id' }]],
            ]).factory;
            const { panel } = await connectAndCreate(QueryWorkbench, factory, ctx, {
                id: 'cfg-cell-1',
                name: 'production',
            });

            // Run two statements that have different "id" values per row.
            await capture.fireReady();
            await panel.executeQuery('SELECT 100 AS id;\nSELECT 999 AS id;');

            // Now request a cell from statement 0, row 1 (id=200), column "id".
            await capture.fireShowCellDetail(0, 1, 'id');

            // The most recent cellDetail message should report id=200.
            const details = capture.received.filter((m) => m.type === 'cellDetail');
            const last = details[details.length - 1]!;
            assert.strictEqual(last.statementIndex, 0);
            assert.strictEqual(last.rowIndex, 1);
            assert.strictEqual(last.column, 'id');
            assert.strictEqual(last.value, 200);
        } finally {
            capture.restore();
        }
    });

    test('returns value from statement 1 when statement 1 is requested', async () => {
        const capture = createCapturingPanel();
        try {
            const ctx = (await import('../mocks/vscode')).extensionContext as unknown as import('vscode').ExtensionContext;
            const QueryWorkbench = await importWorkbench();
            const factory = buildSequentialPool([
                [[{ name: 'alpha' }], [{ name: 'name' }]],
                [[{ name: 'beta' }], [{ name: 'name' }]],
            ]).factory;
            const { panel } = await connectAndCreate(QueryWorkbench, factory, ctx, {
                id: 'cfg-cell-2',
                name: 'production',
            });

            await capture.fireReady();
            await panel.executeQuery("SELECT 'alpha' AS name;\nSELECT 'beta' AS name;");

            await capture.fireShowCellDetail(1, 0, 'name');

            const details = capture.received.filter((m) => m.type === 'cellDetail');
            const last = details[details.length - 1]!;
            assert.strictEqual(last.statementIndex, 1);
            assert.strictEqual(last.value, 'beta');
        } finally {
            capture.restore();
        }
    });

    test('returns null value for out-of-range statementIndex without throwing', async () => {
        const capture = createCapturingPanel();
        try {
            const ctx = (await import('../mocks/vscode')).extensionContext as unknown as import('vscode').ExtensionContext;
            const QueryWorkbench = await importWorkbench();
            const factory = buildSequentialPool([
                [[{ id: 1 }], [{ name: 'id' }]],
            ]).factory;
            const { panel } = await connectAndCreate(QueryWorkbench, factory, ctx, {
                id: 'cfg-cell-3',
                name: 'production',
            });

            await capture.fireReady();
            await panel.executeQuery('SELECT 1 AS id;');

            await capture.fireShowCellDetail(99, 0, 'id');

            const details = capture.received.filter((m) => m.type === 'cellDetail');
            const last = details[details.length - 1]!;
            assert.strictEqual(last.statementIndex, 99);
            assert.strictEqual(last.value, null);
        } finally {
            capture.restore();
        }
    });
});