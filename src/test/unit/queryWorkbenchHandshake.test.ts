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
// Imported here (top of file) so all tests share a single resolve path even
// though the implementation file uses zod + vscode-only side effects. The
// `QueryWorkbench` factory below also imports the same module, but importing
// `parseWebviewRequest` directly avoids needing a panel for pure schema checks.
import { parseWebviewRequest } from '../../views/queryWorkbench';

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
    const factory: PoolFactory = (_config: DatabaseSessionConfig): PoolLike => ({
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
            const registry = new ActorRegistry({
        identity: {
            async getAccessToken(): Promise<string> {
                return 'fake-token';
            },
        },
        poolFactory: factory,
    });
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
            const registry = new ActorRegistry({
        identity: {
            async getAccessToken(): Promise<string> {
                return 'fake-token';
            },
        },
        poolFactory: factory,
    });
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
            const connRegistry = new ActorRegistry({
            identity: {
                async getAccessToken(): Promise<string> {
                    return 'fake-token';
                },
            },
            poolFactory: fake.factory,
        });
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

    test('postMessage after dispose is a no-op', async () => {
        const capture = createCapturingPanel();
        try {
            const { QueryWorkbench } = await import('../../views/queryWorkbench');
            const { extensionContext } = await import('../mocks/vscode');
            const ctx = extensionContext as unknown as import('vscode').ExtensionContext;
            const workbench = QueryWorkbench.createOrShow(
                ctx.extensionUri,
                'cfg-disposed-post',
                'production',
                { registry: new ActorRegistry(), context: ctx }
            );

            await capture.fireReady();
            workbench.setEditorSql('SELECT 1');
            workbench.dispose();
            const receivedBeforePostDispose = capture.received.length;
            workbench.setEditorSql('SELECT 2');

            assert.strictEqual(workbench['disposed'], true);
            assert.strictEqual(capture.received.length, receivedBeforePostDispose);
            assert.strictEqual(capture.received.at(-1)?.sql, 'SELECT 1');
        } finally {
            capture.restore();
        }
    });

    test('drainPendingMessages after dispose is a no-op', async () => {
        const capture = createCapturingPanel();
        try {
            const { QueryWorkbench } = await import('../../views/queryWorkbench');
            const { extensionContext } = await import('../mocks/vscode');
            const ctx = extensionContext as unknown as import('vscode').ExtensionContext;
            const workbench = QueryWorkbench.createOrShow(
                ctx.extensionUri,
                'cfg-disposed-drain',
                'production',
                { registry: new ActorRegistry(), context: ctx }
            );

            workbench.setEditorSql('SELECT 1');
            workbench.dispose();
            await capture.fireReady();

            assert.strictEqual(capture.received.length, 0);
            assert.strictEqual(workbench['pendingMessages'].length, 0);
        } finally {
            capture.restore();
        }
    });

    test('pendingMessages is empty after dispose', async () => {
        const capture = createCapturingPanel();
        try {
            const { QueryWorkbench } = await import('../../views/queryWorkbench');
            const { extensionContext } = await import('../mocks/vscode');
            const ctx = extensionContext as unknown as import('vscode').ExtensionContext;
            const workbench = QueryWorkbench.createOrShow(
                ctx.extensionUri,
                'cfg-disposed-pending',
                'production',
                { registry: new ActorRegistry(), context: ctx }
            );

            workbench.setEditorSql('SELECT 1');
            workbench.setEditorSql('SELECT 2');
            workbench.setEditorSql('SELECT 3');
            workbench.dispose();

            assert.strictEqual(workbench['pendingMessages'].length, 0);
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
            const connRegistry = new ActorRegistry({
            identity: {
                async getAccessToken(): Promise<string> {
                    return 'fake-token';
                },
            },
            poolFactory: fake.factory,
        });
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

    test('webviewRequestSchema accepts a bare openSession command and strips stray fields', () => {
        // (a) acceptance: a payload that matches the new `openSession` literal
        // exactly must parse to { tag: 'ok', request: { command: 'openSession' } }.
        const ok = parseWebviewRequest({ command: 'openSession' });
        assert.strictEqual(ok.tag, 'ok', `expected ok, got ${ok.tag}`);
        if (ok.tag !== 'ok') return;
        assert.strictEqual(ok.request.command, 'openSession');
        assert.deepStrictEqual(
            Object.keys(ok.request as Record<string, unknown>),
            ['command'],
            'openSession must not carry any extra fields'
        );

        // (a) cross-variant rejection: a stray `sql` on an `openSession`
        // payload MUST NOT propagate onto the parsed request. The
        // `webviewRequestSchema` is a `z.discriminatedUnion` with default
        // (strip) object semantics; the matching `openSession` variant
        // shape is `{ command }` only, so any `sql` is dropped before the
        // switch in `onMessage` ever sees it. This is the protection that
        // prevents an `openSession` wire message from ever accidentally
        // dispatching as an `executeQuery`. (Mirror of the
        // `rejects malformed executeQuery payloads (extra fields still
        // accepted)` assertion in queryPanel.test.ts, but on the
        // newly-added literal.)
        const stripped = parseWebviewRequest({ command: 'openSession', sql: 'SELECT 1' });
        assert.strictEqual(stripped.tag, 'ok', 'openSession with stray sql must still parse (zod strips extra keys)');
        if (stripped.tag !== 'ok') return;
        assert.strictEqual(stripped.request.command, 'openSession');
        assert.ok(
            !('sql' in (stripped.request as Record<string, unknown>)),
            'stray sql must be stripped from an openSession request, not propagated into the switch'
        );

        // (a) cross-variant rejection sanity: a bare `openSession` where
        // the discriminator itself is missing must be rejected — proves
        // we haven't accidentally weakened the union by adding the new
        // literal.
        const missing = parseWebviewRequest({ sql: 'SELECT 1' });
        assert.strictEqual(
            missing.tag,
            'parseFailure',
            `a payload without a discriminator must still be rejected, got ${missing.tag}`
        );
    });

    test('postMessage(sessionState) after dispose is dropped by the disposed guard', async () => {
        // (b) regression: T9 wired `drainPendingMessages()` to publish a
        // `{ type: 'sessionState', connected }` message as the last step of
        // the ready handshake. T10 added the matching switch case. If
        // `dispose()` runs between the webview firing `ready` and the host
        // draining the buffer, the postMessage call must be a no-op — both
        // because `dispose()` zeroes `pendingMessages` and because the
        // private `postMessage()` short-circuits on `this.disposed`.
        const capture = createCapturingPanel();
        try {
            const { QueryWorkbench } = await import('../../views/queryWorkbench');
            const { extensionContext } = await import('../mocks/vscode');
            const ctx = extensionContext as unknown as import('vscode').ExtensionContext;
            const workbench = QueryWorkbench.createOrShow(
                ctx.extensionUri,
                'cfg-disposed-sessionState',
                'production',
                { registry: new ActorRegistry(), context: ctx }
            );

            // Stage 1: a user action before `ready` queues a real outbound
            // message in `pendingMessages`. This proves dispose-then-fireReady
            // leaves the queue empty (existing dispose-guard semantics).
            workbench.setEditorSql('SELECT 1');

            // Stage 2: dispose while pendingMessages is non-empty. The
            // existing contract (see dispose() at queryWorkbench.ts:409-423)
            // is that this both flips the disposed flag AND clears the
            // queue.
            workbench.dispose();
            assert.strictEqual(
                (workbench as unknown as { pendingMessages: unknown[] }).pendingMessages.length,
                0,
                'dispose must clear pendingMessages'
            );
            assert.strictEqual(workbench['disposed'], true);

            // Stage 3: simulate the webview reporting ready after dispose.
            // drainPendingMessages() runs and then unconditionally fires
            // `postMessage({ type: 'sessionState', ... })`. The postMessage
            // guard `if (this.disposed) return;` must swallow it.
            await capture.fireReady();

            const sessionStateMessages = capture.received.filter((m) => m.type === 'sessionState');
            assert.strictEqual(
                sessionStateMessages.length,
                0,
                'pending sessionState postMessage must be dropped after dispose; got: ' +
                    JSON.stringify(capture.received.map((m) => m.type))
            );

            // Stage 4: a direct postMessage after dispose is also dropped.
            // This proves the guard works regardless of which path emits.
            (workbench as unknown as { postMessage: (msg: unknown) => void }).postMessage({
                type: 'sessionState',
                connected: true,
            });
            assert.strictEqual(
                capture.received.length,
                0,
                'direct postMessage after dispose must not leak to the webview; got: ' +
                    JSON.stringify(capture.received.map((m) => m.type))
            );
        } finally {
            capture.restore();
        }
    });
});
