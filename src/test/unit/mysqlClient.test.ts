/**
 * Tests for ConnectionHandle + LifecycleRegistry.
 *
 * The legacy tests stubbed `mysql2/promise` directly. After the rewrite,
 * that approach no longer works because esbuild wraps `mysql2/promise` in
 * its own private CommonJS module that CJS tests cannot reach. Instead we
 * inject a `poolFactory` via `MySqlClientOptions.poolFactory` and exercise
 * the real `DatabaseSession` code path against a fake pool.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { __test__ } from '../mocks/vscode';

import { ConnectionHandle, LifecycleRegistry } from '../../registry/connectionLifecycle';
import { getIdentityProvider } from '../../identity/entraToken';
import type { ConnectionConfig } from '../../domain';
import type { DatabaseSessionConfig, PoolFactory, PoolLike } from '../../registry/databaseSession';
import { makeConnectionConfig } from '../factories/connectionConfig';

const sampleConfig: ConnectionConfig = makeConnectionConfig({ id: 'cfg-1' });

const clients: ConnectionHandle[] = [];

/**
 * Build a fake pool factory + records every pool it creates. Tests can
 * inspect `.calls` to verify token rotation built a new pool per generation.
 */
function buildFakePool(rows: unknown[] | unknown, fields: { name: string }[] = []) {
    const fakeEnd = sinon.stub().resolves();
    const fakeExecute = sinon.stub().resolves([rows, fields]);
    const fakePool: PoolLike = {
        execute: fakeExecute as unknown as PoolLike['execute'],
        end: fakeEnd as unknown as () => Promise<void>,
    };
    const calls: { token: string; ssl?: boolean }[] = [];
    const factory: PoolFactory = (config: DatabaseSessionConfig): PoolLike => {
        calls.push({ token: config.token, ssl: config.ssl });
        return fakePool;
    };
    return {
        factory,
        fakePool,
        fakeExecute,
        fakeEnd,
        calls,
    };
}

function makeClient(
    config: ConnectionConfig,
    overrides: { rows?: unknown; fields?: { name: string }[]; refreshIntervalMs?: number } = {}
): { client: ConnectionHandle; fake: ReturnType<typeof buildFakePool> } {
    const fake = buildFakePool(overrides.rows ?? [], overrides.fields ?? []);
    const client = new ConnectionHandle(config, {
        poolFactory: fake.factory,
        ...(overrides.refreshIntervalMs !== undefined
            ? { refreshIntervalMs: overrides.refreshIntervalMs }
            : {}),
    });
    clients.push(client);
    return { client, fake };
}

suite('ConnectionHandle', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        __test__.reset();
        __test__.resetAuth();
        __test__.setNextSession({
            id: 's',
            accessToken: 'fake-access-token',
            account: { id: 'a', label: 'l' },
            scopes: [],
        });
    });

    teardown(async () => {
        for (const client of clients) {
            await client.disconnect();
        }
        clients.length = 0;
        sandbox.restore();
        __test__.reset();
        __test__.resetAuth();
    });

    test('connect() builds a pool with the access token as password', async () => {
        const { client, fake } = makeClient(sampleConfig);
        await client.connect();

        assert.strictEqual(fake.calls.length, 1);
        assert.strictEqual(fake.calls[0]?.token, 'fake-access-token');
        assert.strictEqual(fake.calls[0]?.ssl, true);
    });

    test('connect() omits SSL config when ssl=false', async () => {
        const { client, fake } = makeClient({ ...sampleConfig, ssl: false });
        await client.connect();

        assert.strictEqual(fake.calls.length, 1);
        assert.strictEqual(fake.calls[0]?.ssl, false);
    });

    test('executeQuery returns rows and column names for SELECT', async () => {
        const rows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
        const fields = [{ name: 'id' }, { name: 'name' }];
        const { client } = makeClient(sampleConfig, { rows, fields });
        await client.connect();
        const result = await client.executeQuery('SELECT * FROM t');

        assert.strictEqual(result.error, undefined);
        assert.deepStrictEqual(result.columns, ['id', 'name']);
        assert.strictEqual(result.rows.length, 2);
        assert.strictEqual(result.rowCount, 2);
        assert.ok(result.executionTime >= 0);
    });

    test('executeQuery returns affectedRows/insertId for non-SELECT statements', async () => {
        const { client } = makeClient(sampleConfig, {
            rows: {
                affectedRows: 3,
                insertId: 42,
                info: 'Records: 3 Duplicates: 0 Warnings: 0',
            },
        });
        await client.connect();
        const result = await client.executeQuery('UPDATE t SET x=1');

        assert.strictEqual(result.error, undefined);
        assert.deepStrictEqual(result.columns, ['affectedRows', 'insertId', 'info']);
        assert.strictEqual(result.rows.length, 1);
        assert.strictEqual((result.rows[0] as { affectedRows: number }).affectedRows, 3);
        assert.strictEqual(result.rowCount, 1);
    });

    test('executeQuery captures errors and does not throw', async () => {
        const { client, fake } = makeClient(sampleConfig);
        fake.fakeExecute.rejects(new Error('permission denied'));
        await client.connect();
        const result = await client.executeQuery('DROP TABLE t');

        assert.ok(result.error);
        assert.match(result.error!, /permission denied/);
        assert.strictEqual(result.rowCount, 0);
    });

    test('executeQuery throws when not connected', async () => {
        const { client } = makeClient(sampleConfig);
        await assert.rejects(
            () => client.executeQuery('SELECT 1'),
            /Not connected to database/
        );
    });

    test('getDatabases pulls the Database column from SHOW DATABASES', async () => {
        const { client } = makeClient(sampleConfig, {
            rows: [{ Database: 'appdb' }, { Database: 'sys' }, { database: 'mysql' }],
            fields: [{ name: 'Database' }],
        });
        await client.connect();
        const dbs = await client.getDatabases();
        assert.deepStrictEqual(dbs, ['appdb', 'sys', 'mysql']);
    });

    test('getTables reads first column of SHOW TABLES', async () => {
        const { client } = makeClient(sampleConfig, {
            rows: [{ Tables_in_appdb: 'users' }, { Tables_in_appdb: 'orders' }],
            fields: [{ name: 'Tables_in_appdb' }],
        });
        await client.connect();
        const tables = await client.getTables();
        assert.deepStrictEqual(tables, ['users', 'orders']);
    });

    test('getTableColumns escapes embedded backticks in DESCRIBE identifiers', async () => {
        const { client, fake } = makeClient(sampleConfig);
        await client.connect();

        await client.getTableColumns('weird`name');

        assert.strictEqual(fake.fakeExecute.firstCall.args[0], 'DESCRIBE `weird``name`');
    });

    test('getTableColumns maps Field/Type to TableColumn', async () => {
        const { client } = makeClient(sampleConfig, {
            rows: [
                { Field: 'id', Type: 'int(11)' },
                { Field: 'email', Type: 'varchar(255)' },
            ],
            fields: [{ name: 'Field' }, { name: 'Type' }],
        });
        await client.connect();
        const cols = await client.getTableColumns('users');

        assert.deepStrictEqual(cols, [
            { name: 'id', type: 'int(11)' },
            { name: 'email', type: 'varchar(255)' },
        ]);
    });

    test('isConnected reflects connection state', async () => {
        const { client } = makeClient(sampleConfig);
        assert.strictEqual(client.isConnected(), false);
        await client.connect();
        assert.strictEqual(client.isConnected(), true);
        await client.disconnect();
        assert.strictEqual(client.isConnected(), false);
    });

    test('disconnect ends the pool and clears the refresh interval', async () => {
        const { client, fake } = makeClient(sampleConfig);
        await client.connect();
        await client.disconnect();
        assert.strictEqual(fake.fakeEnd.callCount, 1);
        assert.strictEqual(client.isConnected(), false);
    });

    test('getConfig returns the original connection config', () => {
        const { client } = makeClient(sampleConfig);
        assert.strictEqual(client.getConfig(), sampleConfig);
    });

    test('refreshToken() builds a NEW pool bound to the new token (drain-and-replace)', async () => {
        const { client, fake } = makeClient(sampleConfig);
        await client.connect();
        assert.strictEqual(fake.calls.length, 1);
        assert.strictEqual(fake.calls[0]?.token, 'fake-access-token');

        // Force the auth provider to return a different token by clearing the
        // cache, then setting up the VS Code mock for the next call.
        getIdentityProvider().clearCache();
        __test__.setNextSession({
            id: 's2',
            accessToken: 'fresh-access-token',
            account: { id: 'a', label: 'l' },
            scopes: [],
        });
        await client.refreshToken();

        // Should have built a 2nd pool with the new token.
        assert.strictEqual(fake.calls.length, 2);
        assert.strictEqual(fake.calls[1]?.token, 'fresh-access-token');
    });
});

suite('LifecycleRegistry', () => {
    setup(() => {
        __test__.reset();
        __test__.resetAuth();
        __test__.setNextSession({
            id: 's',
            accessToken: 't',
            account: { id: 'a', label: 'l' },
            scopes: [],
        });
    });

    teardown(() => {
        __test__.reset();
        __test__.resetAuth();
    });

    test('setConnection / getConnection round-trip', () => {
        const mgr = new LifecycleRegistry();
        const { client } = makeClient(sampleConfig);
        mgr.setConnection('id-1', client);
        assert.strictEqual(mgr.getConnection('id-1'), client);
        assert.strictEqual(mgr.getConnection('missing'), undefined);
    });

    test('removeConnection disconnects and drops the entry', async () => {
        const mgr = new LifecycleRegistry();
        const { client, fake } = makeClient(sampleConfig);
        await client.connect();
        mgr.setConnection('id-1', client);

        await mgr.removeConnection('id-1');

        assert.strictEqual(mgr.getConnection('id-1'), undefined);
        assert.strictEqual(fake.fakeEnd.callCount, 1);
    });

    test('disconnectAll tears down every connection', async () => {
        const mgr = new LifecycleRegistry();
        const a = makeClient(sampleConfig);
        const b = makeClient({ ...sampleConfig, id: 'cfg-2' });
        await a.client.connect();
        await b.client.connect();
        mgr.setConnection('id-1', a.client);
        mgr.setConnection('id-2', b.client);

        await mgr.disconnectAll();

        assert.strictEqual(a.fake.fakeEnd.callCount, 1);
        assert.strictEqual(b.fake.fakeEnd.callCount, 1);
        assert.strictEqual(mgr.getConnection('id-1'), undefined);
        assert.strictEqual(mgr.getConnection('id-2'), undefined);
    });
});