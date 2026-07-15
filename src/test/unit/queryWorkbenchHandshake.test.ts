/**
 * Tests for the QueryWorkbench buffer-drain handshake.
 *
 * The webview fires `vscode.postMessage({command:'ready'})` once its script
 * has registered its `window.addEventListener('message', ...)` handler. Until
 * the host sees `ready`, it queues outbound messages in `pendingMessages` so
 * that host-initiated flows like `previewRows` (which immediately calls
 * `setEditorSql` + `executeQuery`) don't race the webview's listener
 * registration.
 *
 * This test asserts:
 *   1. Calls made before `ready` are buffered (NOT delivered to the
 *      placeholder postMessage stub) and delivered in order when `ready`
 *      arrives.
 *   2. Calls made after `ready` go directly through.
 *
 * Without the handshake, the first `setSql` postMessage is dropped because
 * VS Code only retains messages while a listener exists.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import { ActorRegistry } from '../../registry/actorRegistry';
import type { DatabaseSessionConfig, PoolFactory, PoolLike } from '../../registry/databaseSession';
import * as sinon from 'sinon';

type PostMessage = (msg: unknown) => Promise<boolean>;
type ReceivedMessage = Record<string, unknown>;

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

    // Override the global factory for this test only.
    const original = vscode.window.createWebviewPanel;
    (vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel =
        () => panel as unknown as ReturnType<typeof vscode.window.createWebviewPanel>;

    return {
        received,
        fireReady() {
            if (!onDidReceive) throw new Error('onDidReceive not registered');
            return onDidReceive({ command: 'ready' });
        },
        fireLoadHistory() {
            if (!onDidReceive) throw new Error('onDidReceive not registered');
            return onDidReceive({ command: 'loadHistory', offset: 0 });
        },
        fireMessage(message: unknown) {
            if (!onDidReceive) throw new Error('onDidReceive not registered');
            return onDidReceive(message);
        },
        restore() {
            (vscode.window as unknown as { createWebviewPanel: typeof vscode.window.createWebviewPanel }).createWebviewPanel =
                original;
        },
    };
}

function buildFakePool(rows: unknown[] = [], fields: { name: string }[] = []) {
    const fakeEnd = sinon.stub().resolves();
    const fakeExecute = sinon.stub().resolves([rows, fields]);
    const factory: PoolFactory = (config: DatabaseSessionConfig): PoolLike => ({
        execute: fakeExecute as unknown as PoolLike['execute'],
        end: fakeEnd as unknown as () => Promise<void>,
    });
    return { factory, fakeExecute, fakeEnd };
}

suite('QueryWorkbench handshake', () => {
    test('executeQuery splits full editor SQL in the host before registry execution', async () => {
        const capture = createCapturingPanel();
        const executedSql: string[] = [];
        try {
            const { QueryWorkbench } = await import('../../views/queryWorkbench');
            const { extensionContext } = await import('../mocks/vscode');
            const { makeConnectionConfig } = await import('../factories/connectionConfig');
            const fakeEnd = sinon.stub().resolves();
            const factory: PoolFactory = (): PoolLike => ({
                execute: async (sql: string) => {
                    executedSql.push(sql);
                    return [[], []];
                },
                end: fakeEnd as unknown as () => Promise<void>,
            });
            const registry = new ActorRegistry({ poolFactory: factory });
            const ctx = extensionContext as unknown as import('vscode').ExtensionContext;
            await registry.connect('cfg-split', makeConnectionConfig({ id: 'cfg-split' }));
            const panel = QueryWorkbench.createOrShow(
                ctx.extensionUri,
                'cfg-split',
                'production',
                { registry, context: ctx }
            );

            await capture.fireReady();
            await panel.executeQuery("SELECT 'alpha;beta'; SELECT 2;");

            assert.deepStrictEqual(executedSql, ["SELECT 'alpha;beta'", 'SELECT 2']);
        } finally {
            capture.restore();
        }
    });

    test('runFocusedQuery selects the statement in the host and runs all from inter-statement whitespace', async () => {
        const capture = createCapturingPanel();
        const executedSql: string[] = [];
        try {
            const { QueryWorkbench } = await import('../../views/queryWorkbench');
            const { extensionContext } = await import('../mocks/vscode');
            const { makeConnectionConfig } = await import('../factories/connectionConfig');
            const factory: PoolFactory = (): PoolLike => ({
                execute: async (sql: string) => {
                    executedSql.push(sql);
                    return [[], []];
                },
                end: async () => undefined,
            });
            const registry = new ActorRegistry({ poolFactory: factory });
            const ctx = extensionContext as unknown as import('vscode').ExtensionContext;
            await registry.connect('cfg-focused', makeConnectionConfig({ id: 'cfg-focused' }));
            QueryWorkbench.createOrShow(
                ctx.extensionUri,
                'cfg-focused',
                'production',
                { registry, context: ctx }
            );
            await capture.fireReady();
            const sql = 'SELECT 1;\n\nSELECT 2;';

            await capture.fireMessage({
                command: 'runFocusedQuery',
                sql,
                caret: sql.indexOf('SELECT 2') + 3,
            });
            await capture.fireMessage({
                command: 'runFocusedQuery',
                sql,
                caret: sql.indexOf('\n'),
            });

            assert.deepStrictEqual(executedSql, ['SELECT 2', 'SELECT 1', 'SELECT 2']);
        } finally {
            capture.restore();
        }
    });

    test('previewRows buffers setSql + loading until webview reports ready, then drains in order', async () => {
        const capture = createCapturingPanel();
        try {
            // Use reflection-y access: the symbol is exported via a separate
            // test, but for simplicity we just import the class directly.
            const { QueryWorkbench } = await import('../../views/queryWorkbench');
            const { GlobalStateConnectionCatalog } = await import('../../registry/connectionCatalog');
            const { extensionContext } = await import('../mocks/vscode');

            const fake = buildFakePool(
                [{ id: 1 }, { id: 2 }],
                [{ name: 'id' }]
            );
            const connRegistry = new ActorRegistry({ poolFactory: fake.factory });
            const ctx = extensionContext as unknown as import('vscode').ExtensionContext;
            const catalog = new GlobalStateConnectionCatalog(ctx);
            const { makeConnectionConfig } = await import('../factories/connectionConfig');
            await catalog.add(makeConnectionConfig({ id: 'cfg-1', name: 'production' }));
            await connRegistry.connect('cfg-1', makeConnectionConfig({ id: 'cfg-1', name: 'production' }));

            // Open the workbench for a table (mimics previewRows).
            const panel = QueryWorkbench.createOrShow(
                ctx.extensionUri,
                'cfg-1',
                'users',
                { registry: connRegistry, context: ctx }
            );

            const sql = 'SELECT * FROM `mydb`.`users` LIMIT 100;';
            panel.setEditorSql(sql);
            const executePromise = panel.executeQuery(sql);

            // No message should be received yet: webview hasn't reported ready.
            assert.strictEqual(
                capture.received.length,
                0,
                'expected no messages to be delivered before ready, got: ' + JSON.stringify(capture.received)
            );

            // Fire the webview's ready handshake.
            await capture.fireReady();

            // Now at minimum the setSql should be delivered. Loading may or may
            // not have arrived depending on the timing of the SQL result;
            // but setSql MUST be first because it was buffered first.
            assert.ok(capture.received.length >= 1, 'expected at least one message after ready');
            const first = capture.received[0]!;
            assert.strictEqual(first.type, 'setSql', 'first drained message should be setSql, got: ' + first.type);
            assert.strictEqual(first.sql, sql, 'setSql payload should match previewRows SQL');

            // Let the query result finish.
            await executePromise;

            // The drained buffer + post-ready traffic must include the result
            // card so the user sees data without clicking Run.
            const hasResultCard = capture.received.some(
                (m) => m.type === 'statementResult' && (m.data as { columns?: unknown[] }).columns
            );
            assert.ok(
                hasResultCard,
                'expected an auto-rendered statementResult card in captured messages, got: ' +
                    JSON.stringify(capture.received.map((m) => m.type))
            );
        } finally {
            capture.restore();
        }
    });

    test('fresh workbench auto-seeds a default SELECT * LIMIT 10 query', () => {
        // The default query lives in the webview HTML markup, not in a host-side timer.
        // No panel needs to be created for this assertion.
        const { buildQueryWorkbenchHtml } = require('../../views/queryWorkbenchHtml');
        const html = buildQueryWorkbenchHtml({ nonce: 'test-nonce', serverName: 'production' });
        assert.ok(
            html.includes('SELECT * FROM information_schema.tables LIMIT 10'),
            'webview HTML must pre-populate the editor with a safe default query'
        );
    });

    test('external setEditorSql still wins over the markup default for previewRows', async () => {
        const capture = createCapturingPanel();
        try {
            const { QueryWorkbench } = await import('../../views/queryWorkbench');
            const { GlobalStateConnectionCatalog } = await import('../../registry/connectionCatalog');
            const { extensionContext } = await import('../mocks/vscode');

            const fake = buildFakePool(
                [{ id: 1 }, { id: 2 }],
                [{ name: 'id' }]
            );
            const connRegistry = new ActorRegistry({ poolFactory: fake.factory });
            const ctx = extensionContext as unknown as import('vscode').ExtensionContext;
            const catalog = new GlobalStateConnectionCatalog(ctx);
            const { makeConnectionConfig } = await import('../factories/connectionConfig');
            await catalog.add(makeConnectionConfig({ id: 'cfg-suppress', name: 'production' }));
            await connRegistry.connect('cfg-suppress', makeConnectionConfig({ id: 'cfg-suppress', name: 'production' }));

            const panel = QueryWorkbench.createOrShow(
                ctx.extensionUri,
                'cfg-suppress',
                'users',
                { registry: connRegistry, context: ctx }
            );

            // External caller (previewRows) populates the editor with its own SQL.
            const previewSql = 'SELECT * FROM `db`.`users` LIMIT 100;';
            panel.setEditorSql(previewSql);

            await capture.fireReady();
            await capture.fireMessage({ command: 'loadHistory', offset: 0 });

            const setSqlMessages = capture.received.filter((m) => m.type === 'setSql');
            assert.ok(
                setSqlMessages.length >= 1,
                'expected at least one setSql (the external one)'
            );
            assert.strictEqual(
                setSqlMessages[setSqlMessages.length - 1]!.sql,
                previewSql,
                'last setSql must be the external previewRows SQL'
            );
        } finally {
            capture.restore();
        }
    });
});
