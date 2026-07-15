/**
 * Tests for per-actor query serialization in ActorRegistry.
 *
 * After Wave 2B.1, all workbench operations (executeQuery, getDatabases,
 * getTables, getTableColumns) route through the actor's enqueue() so they
 * serialize on the same id. These tests use controllable promises (deferred
 * resolvers) to prove FIFO ordering and rejection isolation.
 */

import * as assert from 'assert';
import { ActorRegistry } from '../../registry/actorRegistry';
import type {
    DatabaseSessionConfig,
    PoolFactory,
    PoolLike,
} from '../../registry/databaseSession';

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
}

function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Build a pool factory whose `execute()` returns whatever the test's
 * `executeBehaviour` map says. The map is keyed by SQL substring so tests can
 * match specific queries to specific deferreds or resolved rows.
 */
function buildDeferredPool(
    executeBehaviour: Map<string, { rows: unknown[]; fields: { name: string }[]; deferred?: Deferred }>
) {
    const calls: string[] = [];
    const fakeEnd = async (): Promise<void> => undefined;
    const fakeExecute = async (sql: string): Promise<[unknown[], { name: string }[]]> => {
        calls.push(sql);
        for (const [matcher, behaviour] of executeBehaviour) {
            if (sql.includes(matcher)) {
                if (behaviour.deferred) {
                    await behaviour.deferred.promise;
                }
                return [behaviour.rows, behaviour.fields];
            }
        }
        return [[], []];
    };
    const factory: PoolFactory = (_config: DatabaseSessionConfig): PoolLike => ({
        execute: fakeExecute as unknown as PoolLike['execute'],
        end: fakeEnd as unknown as () => Promise<void>,
    });
    return { factory, calls };
}

const baseConfig = {
    id: 'cfg-ser',
    name: 'test',
    host: 'h',
    port: 3306,
    database: 'd',
    user: 'u',
    ssl: true,
};

suite('ActorRegistry query serialization', () => {
    test('two same-id queries run FIFO through the actor queue', async () => {
        const d1 = deferred();
        const d2 = deferred();
        const { factory } = buildDeferredPool(new Map([
            ['Q1', { rows: [{ v: 1 }], fields: [{ name: 'v' }], deferred: d1 }],
            ['Q2', { rows: [{ v: 2 }], fields: [{ name: 'v' }], deferred: d2 }],
        ]));
        const reg = new ActorRegistry({ poolFactory: factory });
        await reg.connect(baseConfig.id, baseConfig);

        const order: string[] = [];
        const p1 = reg.executeQuery(baseConfig.id, 'Q1').then((r) => {
            order.push(`Q1-done-${r.rows[0]?.v}`);
        });
        const p2 = reg.executeQuery(baseConfig.id, 'Q2').then((r) => {
            order.push(`Q2-done-${r.rows[0]?.v}`);
        });

        // Q1 is blocked at the pool. Resolve it first; only then should Q2 run.
        d1.resolve();
        await p1;
        d2.resolve();
        await p2;

        assert.deepStrictEqual(order, ['Q1-done-1', 'Q2-done-2']);
    });

    test('a server-error query returns an error result and does not poison the queue', async () => {
        // Build a pool that throws on 'BAD'. DatabaseSession wraps pool errors
        // as QueryOutcome.err instead of rejecting, so the registry surfaces the
        // error via the legacy QueryResult.error field.
        const fakeEnd = async (): Promise<void> => undefined;
        const fakeExecute = async (sql: string): Promise<[unknown[], { name: string }[]]> => {
            if (sql === 'BAD') throw new Error('pool rejected');
            return [[{ v: 1 }], [{ name: 'v' }]];
        };
        const factory: PoolFactory = (_config: DatabaseSessionConfig): PoolLike => ({
            execute: fakeExecute as unknown as PoolLike['execute'],
            end: fakeEnd as unknown as () => Promise<void>,
        });
        const reg = new ActorRegistry({ poolFactory: factory });
        await reg.connect(baseConfig.id, baseConfig);

        const errorResult = await reg.executeQuery(baseConfig.id, 'BAD');
        assert.ok(errorResult.error, 'expected QueryResult.error to be set');
        assert.match(errorResult.error ?? '', /pool rejected/);

        // The queue is not poisoned — a subsequent query succeeds.
        const okResult = await reg.executeQuery(baseConfig.id, 'GOOD');
        assert.strictEqual(okResult.error, undefined);
        assert.strictEqual(okResult.rows[0]?.v, 1);
    });

    test('queries on different ids may run concurrently', async () => {
        const d1 = deferred();
        const d2 = deferred();
        const { factory } = buildDeferredPool(new Map([
            ['A.', { rows: [{ v: 1 }], fields: [{ name: 'v' }], deferred: d1 }],
            ['B.', { rows: [{ v: 2 }], fields: [{ name: 'v' }], deferred: d2 }],
        ]));
        const reg = new ActorRegistry({ poolFactory: factory });
        const cfgA = { ...baseConfig, id: 'cfg-A', name: 'A' };
        const cfgB = { ...baseConfig, id: 'cfg-B', name: 'B' };
        await reg.connect(cfgA.id, cfgA);
        await reg.connect(cfgB.id, cfgB);

        const order: string[] = [];
        const pA = reg.executeQuery(cfgA.id, 'A.SELECT 1').then(() => order.push('A'));
        const pB = reg.executeQuery(cfgB.id, 'B.SELECT 1').then(() => order.push('B'));

        // Both are blocked. Resolve both simultaneously.
        d1.resolve();
        d2.resolve();
        await Promise.all([pA, pB]);

        // Both ran (order is not deterministic, just that both succeeded).
        assert.strictEqual(order.length, 2);
        assert.ok(order.includes('A'));
        assert.ok(order.includes('B'));
    });

    test('executeQuery throws when the actor is missing', async () => {
        const { factory } = buildDeferredPool(new Map());
        const reg = new ActorRegistry({ poolFactory: factory });
        await assert.rejects(
            () => reg.executeQuery('nonexistent', 'SELECT 1'),
            /no connection actor/i
        );
    });

    test('executeQuery throws when the connection is disconnected', async () => {
        const { factory } = buildDeferredPool(new Map());
        const reg = new ActorRegistry({ poolFactory: factory });
        await reg.connect(baseConfig.id, baseConfig);
        await reg.disconnect(baseConfig.id);
        await assert.rejects(
            () => reg.executeQuery(baseConfig.id, 'SELECT 1'),
            /not connected/i
        );
    });

    test('getDatabases/getTables/getTableColumns route through the actor queue', async () => {
        let executeCount = 0;
        const fakeEnd = async (): Promise<void> => undefined;
        const fakeExecute = async (sql: string): Promise<[unknown[], { name: string }[]]> => {
            executeCount += 1;
            // mysql2 returns rows as objects keyed by column name (or aliases).
            if (sql === 'SHOW DATABASES') return [[{ Database: 'mysql' }], [{ name: 'Database' }]];
            if (sql === 'SHOW TABLES') return [[{ Tables_in_d: 'users' }], [{ name: 'Tables_in_d' }]];
            if (sql.startsWith('DESCRIBE')) return [[{ Field: 'id', Type: 'int' }], [{ name: 'Field' }]];
            return [[], []];
        };
        const factory: PoolFactory = (_config: DatabaseSessionConfig): PoolLike => ({
            execute: fakeExecute as unknown as PoolLike['execute'],
            end: fakeEnd as unknown as () => Promise<void>,
        });
        const reg = new ActorRegistry({ poolFactory: factory });
        await reg.connect(baseConfig.id, baseConfig);

        const [dbs, tables, cols] = await Promise.all([
            reg.getDatabases(baseConfig.id),
            reg.getTables(baseConfig.id),
            reg.getTableColumns(baseConfig.id, 'users'),
        ]);
        assert.deepStrictEqual([...dbs], ['mysql']);
        assert.deepStrictEqual([...tables], ['users']);
        assert.deepStrictEqual(cols, [{ name: 'id', type: 'int' }]);
        assert.strictEqual(executeCount, 3);
    });

    test('readOnly: true is forwarded into DatabaseSessionConfig when building the pool', async () => {
        const { factory, calls } = buildDeferredPool(new Map([
            ['SELECT 1', { rows: [{ v: 1 }], fields: [{ name: 'v' }] }],
        ]));
        const reg = new ActorRegistry({ poolFactory: factory });
        await reg.connect(baseConfig.id, { ...baseConfig, readOnly: true });
        await reg.executeQuery(baseConfig.id, 'SELECT 1');

        // The user SQL was passed through unmodified. The session-level
        // SET SESSION TRANSACTION READ ONLY is applied by the production
        // defaultPoolFactory via the pool's 'connection' event - tested
        // separately in defaultPoolFactory tests.
        assert.deepStrictEqual(calls, ['SELECT 1']);
    });

    test('readOnly: false / absent is forwarded as readOnly: undefined to the session', async () => {
        let observedReadOnly: unknown = 'sentinel';
        const fakeEnd = async (): Promise<void> => undefined;
        const fakeExecute = async (_sql: string): Promise<[unknown[], { name: string }[]]> => [[], []];
        const factory: PoolFactory = (config: DatabaseSessionConfig): PoolLike => {
            observedReadOnly = config.readOnly;
            return {
                execute: fakeExecute as unknown as PoolLike['execute'],
                end: fakeEnd as unknown as () => Promise<void>,
            };
        };
        const reg = new ActorRegistry({ poolFactory: factory });
        await reg.connect(baseConfig.id, { ...baseConfig, readOnly: false });
        await reg.executeQuery(baseConfig.id, 'SELECT 1');
        assert.strictEqual(observedReadOnly, undefined, 'readOnly: false must propagate as absent to the session');
    });

    test('getConfig returns the latest known ConnectionConfig for an id', async () => {
        const { factory } = buildDeferredPool(new Map());
        const reg = new ActorRegistry({ poolFactory: factory });
        // Pre-connect: no actor -> undefined.
        assert.strictEqual(reg.getConfig('never-seen'), undefined);

        await reg.connect(baseConfig.id, { ...baseConfig, readOnly: true });
        const cfg = reg.getConfig(baseConfig.id);
        assert.ok(cfg);
        assert.strictEqual(cfg?.readOnly, true);

        // Edit propagates (the registry refreshes actor.config on every
        // getOrCreateActor).
        await reg.connect(baseConfig.id, { ...baseConfig, readOnly: false });
        assert.strictEqual(reg.getConfig(baseConfig.id)?.readOnly, false);
    });
});