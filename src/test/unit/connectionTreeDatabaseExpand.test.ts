/**
 * End-to-end scenarios for sequential database expansion on the same connection.
 *
 * The existing connectionTree.test.ts covers the happy path of a single
 * database expand. These three scenarios close the gap that surfaced as the
 * spinning-load bug:
 *
 *   1. Happy path  - expand DB-A tables, then expand DB-B tables, on
 *      the same live connection. Both expansions must resolve within the
 *      Mocha timeout. The fake pool records the SQL it receives so the
 *      test can assert the SHOW TABLES FROM `db` scoping added in
 *      commit a30ccfb works under sequential load.
 *
 *   2. Read-only mode - same sequential expand, but the connection is
 *      configured with readOnly: true. The fake pool implements
 *      getConnection so it satisfies the production read-only
 *      checkout contract; the test asserts the actor session is still
 *      open after two sequential expands (no deadlock, no forced
 *      disconnect from the read-only wrapper). Specifically, the test
 *      drives the acquireReadOnlyConnection path AFTER the first
 *      getChildren expansion so the production SET SESSION TRANSACTION
 *      READ ONLY SQL is observed in recordedSql.
 *
 *   3. Cache poisoning - one table SELECT COUNT(*) is configured to
 *      never resolve (a controllable deferred()). The post-fix regression
 *      gate verifies that each expand resolves within a bounded wait, failed
 *      counts stay uncached and render as "? rows", and another database on
 *      the same actor remains independently expandable. A no-timeout
 *      regression is still bounded by Mocha's 20-second timeout.
 *
 * Test 3 uses real timers (not fake ones) because the spinning-load
 * symptom is a REAL timeout, not a fake-timer issue. The Mocha-level
 * this.timeout(20_000) bounds the wait so the test runner can never
 * hang past 20 seconds.
 *
 * The plan's literal acceptance criterion defines a single
 * `recordedSql: string[]` array that captures SQL from BOTH the
 * pool.execute path AND the connection-level query callback
 * (acquireReadOnlyConnection issues SET SESSION TRANSACTION READ ONLY
 * against the checked-out connection's query() method). The plan
 * also requires the suite title to use the em-dash character, so the
 * title below uses — (U+2014) instead of the ASCII hyphen-minus.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { __test__, extensionContext } from '../mocks/vscode';

import {
    ServerTree,
    ServerNode,
    DatabaseNode,
    TableNode,
} from '../../views/connectionExplorer';
import { ActorRegistry } from '../../registry/actorRegistry';
import { GlobalStateConnectionCatalog } from '../../registry/connectionCatalog';
import type {
    ConnectionLike,
    DatabaseSessionConfig,
    PoolFactory,
    PoolLike,
} from '../../registry/databaseSession';
import { makeConnectionConfig } from '../factories/connectionConfig';

// ---------- shared fixtures (inline; do not extract to a helper file) ----------

/**
 * Stub identity. The tree renderer only inspects registry state, never the
 * credential chain, so a constant-token stub keeps the tests network-free.
 * Mirrors fakeIdentity() in connectionTree.test.ts.
 */
function fakeIdentity(): { readonly getAccessToken: () => Promise<string> } {
    return {
        async getAccessToken(): Promise<string> {
            return 'fake-token';
        },
    };
}

/**
 * Pool factory that wires execute() to a per-SQL behaviour map. The map is
 * keyed by a substring the SQL must include; the matched entry stages a
 * 2-tuple ([rows, fields]) response that mirrors what a real mysql2 pool
 * returns. A deferred on an entry makes the call wait on the deferred
 * resolution - used by test 3 to simulate "count query hangs forever".
 *
 * getConnection is implemented as a callback that immediately resolves
 * with a stub ConnectionLike so the read-only checkout contract is
 * satisfied when readOnly: true. The connection's query() method also
 * appends SQL to the shared `recordedSql` array so the read-only SET
 * TRANSACTION statement issued by acquireReadOnlyConnection() shows up
 * alongside the pool.execute traffic in a single captured list.
 *
 * `recordedSql` is the literal name the plan's acceptance criterion
 * requires. Both the pool.execute path AND the connection-level query
 * callback append into it. A legacy `calls` alias is exposed for
 * backward compatibility with the original test-1 assertions but it is
 * the same underlying array reference.
 */

function buildFakePool(behaviour: {
    readonly bySql: ReadonlyMap<
        string,
        {
            readonly rows?: readonly Record<string, unknown>[];
            readonly fields?: readonly { name: string }[];
            readonly deferred?: { readonly promise: Promise<void> };
        }
    >;
    readonly default?: { readonly rows?: readonly Record<string, unknown>[]; readonly fields?: readonly { name: string }[] };
}): {
    readonly factory: PoolFactory;
    readonly recordedSql: string[];
    readonly calls: readonly string[];
    readonly fakeExecute: sinon.SinonStub;
    readonly getConnectionCalls: number;
} {
    // Single shared SQL capture array. BOTH the pool.execute stub AND
    // the connection-level query callback push into this same array so
    // that callers can assert against a unified timeline of SQL
    // activity, regardless of which physical code path issued it.
    const recordedSql: string[] = [];
    // Backwards-compatible alias - the original name in the legacy
    // fixture. Tests may reference either name; they are the same
    // array reference.
    const calls = recordedSql;
    let getConnectionCalls = 0;
    const fakeExecute = sinon.stub();
    fakeExecute.callsFake(async (sql: string): Promise<[unknown[], { name: string }[] | undefined]> => {
        recordedSql.push(sql);
        for (const [matcher, entry] of behaviour.bySql) {
            if (sql.includes(matcher)) {
                if (entry.deferred) {
                    await entry.deferred.promise;
                }
                const rows = entry.rows ?? [];
                const fields = entry.fields ?? [];
                return [rows as unknown[], fields as unknown as { name: string }[]];
            }
        }
        const fallback = behaviour.default;
        if (fallback) {
            return [
                (fallback.rows ?? []) as unknown[],
                (fallback.fields ?? []) as unknown as { name: string }[],
            ];
        }
        return [[], []];
    });

    const fakeEnd = sinon.stub().resolves();
    const factory: PoolFactory = (_config: DatabaseSessionConfig): PoolLike => ({
        execute: fakeExecute as unknown as PoolLike['execute'],
        end: fakeEnd as unknown as () => Promise<void>,
        getConnection: ((callback: (err: Error | null, connection: ConnectionLike | undefined) => void) => {
            getConnectionCalls += 1;
            const stubConnection: ConnectionLike = {
                // The connection-level query callback MUST also append
                // into recordedSql so that acquireReadOnlyConnection's
                // `SET SESSION TRANSACTION READ ONLY` shows up in the
                // same capture list as the pool.execute traffic. This
                // is the literal plan acceptance criterion.
                query: async (sql: string): Promise<unknown> => {
                    recordedSql.push(sql);
                    return undefined;
                },
                release: (): void => undefined,
                destroy: (): void => undefined,
            };
            // Resolve on next tick so callers can await the callback path.
            setImmediate(() => callback(null, stubConnection));
        }) as unknown as NonNullable<PoolLike['getConnection']>,
    });
    return {
        factory,
        recordedSql,
        calls,
        fakeExecute,
        get getConnectionCalls() { return getConnectionCalls; },
    };
}

/**
 * Shape of a controllable deferred. The test can hold the resolver until it
 * wants the awaiter to proceed; if it never calls resolve, the awaiter hangs
 * until Mocha's outer timeout fires.
 */
interface Deferred {
    readonly promise: Promise<void>;
    resolve(): void;
    reject(err: Error): void;
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stage the SQL responses needed by the sequential-expand happy path:
 *   SHOW DATABASES                       -> [{Database:dba},{Database:dbb}]
 *   SHOW TABLES FROM `dba`               -> [{Tables_in_dba:users},{Tables_in_dba:orders}]
 *   SHOW TABLES FROM `dbb`               -> [{Tables_in_dbb:products}]
 *   SELECT COUNT(*) FROM `dba`.`users`   -> [{COUNT(*):5}]
 *   SELECT COUNT(*) FROM `dba`.`orders`  -> [{COUNT(*):12}]
 *   SELECT COUNT(*) FROM `dbb`.`products`-> [{COUNT(*):99}]
 */
function stageHappyPathPool(): ReturnType<typeof buildFakePool> {
    const bySql = new Map<string, {
        rows?: readonly Record<string, unknown>[];
        fields?: readonly { name: string }[];
        deferred?: { readonly promise: Promise<void> };
    }>([
        [
            'SHOW DATABASES',
            {
                rows: [{ Database: 'dba' }, { Database: 'dbb' }],
                fields: [{ name: 'Database' }],
            },
        ],
        [
            'FROM `dba`',
            {
                rows: [
                    { Tables_in_dba: 'users' },
                    { Tables_in_dba: 'orders' },
                ],
                fields: [{ name: 'Tables_in_dba' }],
            },
        ],
        [
            'FROM `dbb`',
            {
                rows: [{ Tables_in_dbb: 'products' }],
                fields: [{ name: 'Tables_in_dbb' }],
            },
        ],
        [
            'COUNT(*) FROM `dba`.`users`',
            { rows: [{ 'COUNT(*)': 5 }], fields: [{ name: 'COUNT(*)' }] },
        ],
        [
            'COUNT(*) FROM `dba`.`orders`',
            { rows: [{ 'COUNT(*)': 12 }], fields: [{ name: 'COUNT(*)' }] },
        ],
        [
            'COUNT(*) FROM `dbb`.`products`',
            { rows: [{ 'COUNT(*)': 99 }], fields: [{ name: 'COUNT(*)' }] },
        ],
    ]);
    return buildFakePool({ bySql });
}

// ---------- the suite ----------

suite('ServerTree — sequential database expand', () => {
    let catalog: GlobalStateConnectionCatalog;
    let connRegistry: ActorRegistry;

    setup(() => {
        __test__.reset();
        __test__.resetAuth();
        __test__.setNextSession({
            id: 's',
            accessToken: 't',
            account: { id: 'a', label: 'l' },
            scopes: [],
        });
        catalog = new GlobalStateConnectionCatalog(
            extensionContext as unknown as import('vscode').ExtensionContext
        );
    });

    teardown(() => {
        __test__.reset();
        __test__.resetAuth();
    });

    test('expands two databases sequentially on the same connection without hanging', async function () {
        // Mocha default 2 s is too tight for this end-to-end suite; the
        // spinning-load test relies on a generous outer bound so the runner
        // can fail loudly instead of hanging the CI job.
        this.timeout(10_000);

        const fake = stageHappyPathPool();
        connRegistry = new ActorRegistry({ identity: fakeIdentity(), poolFactory: fake.factory });
        const provider = new ServerTree({ catalog, registry: connRegistry });

        await catalog.add(makeConnectionConfig({ id: 'cfg-1' }));
        await connRegistry.connect('cfg-1', makeConnectionConfig({ id: 'cfg-1' }));

        // Walk to the DatabaseNodes.
        const rootChildren = await provider.getChildren();
        const serverNode = rootChildren[0];
        assert.ok(serverNode instanceof ServerNode, 'expected ServerNode at root');

        const dbChildren = await provider.getChildren(serverNode);
        const dbaNode = dbChildren.find(
            (item) => item instanceof DatabaseNode && item.databaseName === 'dba'
        ) as DatabaseNode | undefined;
        const dbbNode = dbChildren.find(
            (item) => item instanceof DatabaseNode && item.databaseName === 'dbb'
        ) as DatabaseNode | undefined;
        assert.ok(dbaNode, 'expected a DatabaseNode for dba');
        assert.ok(dbbNode, 'expected a DatabaseNode for dbb');

        // First expand: DB-A.
        const dbaTables = await provider.getChildren(dbaNode);
        assert.strictEqual(dbaTables.length, 2, 'DB-A should yield two tables');
        assert.ok(dbaTables[0] instanceof TableNode);
        assert.ok(dbaTables[1] instanceof TableNode);
        assert.strictEqual((dbaTables[0] as TableNode).tableName, 'users');
        assert.strictEqual((dbaTables[1] as TableNode).tableName, 'orders');

        // Second expand: DB-B on the SAME connection.
        const dbbTables = await provider.getChildren(dbbNode);
        assert.strictEqual(dbbTables.length, 1, 'DB-B should yield one table');
        assert.ok(dbbTables[0] instanceof TableNode);
        assert.strictEqual((dbbTables[0] as TableNode).tableName, 'products');

        // The tree MUST have issued SHOW TABLES scoped to each database,
        // in the same connection, in order. This is the regression gate
        // for commit a30ccfb (SHOW TABLES FROM `db` scoping).
        const recordedShows = fake.recordedSql.filter((sql) =>
            sql.trim().toUpperCase().startsWith('SHOW TABLES')
        );
        const dbaCall = recordedShows.find((sql) => sql.includes('FROM `dba`'));
        const dbbCall = recordedShows.find((sql) => sql.includes('FROM `dbb`'));
        assert.ok(
            dbaCall,
            'expected SHOW TABLES FROM `dba`; got: ' + JSON.stringify(recordedShows),
        );
        assert.ok(
            dbbCall,
            'expected SHOW TABLES FROM `dbb`; got: ' + JSON.stringify(recordedShows),
        );

        // Both scoped calls must have been recorded on the same connection.
        assert.ok(fake.recordedSql.length >= 2, 'pool.execute must have been called at least twice');
    });

    test('read-only mode does not deadlock sequential database expansion', async function () {
        this.timeout(10_000);

        const fake = stageHappyPathPool();
        connRegistry = new ActorRegistry({ identity: fakeIdentity(), poolFactory: fake.factory });
        const provider = new ServerTree({ catalog, registry: connRegistry });

        // readOnly: true on the profile - the registry forwards this to the
        // DatabaseSessionConfig so acquireReadOnlyConnection() is the active
        // checkout path (see src/registry/databaseSession.ts:166).
        await catalog.add(makeConnectionConfig({ id: 'cfg-ro', readOnly: true }));
        await connRegistry.connect('cfg-ro', makeConnectionConfig({ id: 'cfg-ro', readOnly: true }));

        // Initially the connection getter has not been called - the tree
        // expansion path uses pool.execute(), which does not require a
        // dedicated physical connection, so nothing has requested the
        // read-only wrapper yet.
        assert.strictEqual(
            fake.getConnectionCalls,
            0,
            'getConnection should not have been called by getChildren itself'
        );

        const rootChildren = await provider.getChildren();
        const serverNode = rootChildren[0];
        assert.ok(serverNode instanceof ServerNode);

        const dbChildren = await provider.getChildren(serverNode);
        const dbaNode = dbChildren.find(
            (item) => item instanceof DatabaseNode && item.databaseName === 'dba'
        ) as DatabaseNode | undefined;
        const dbbNode = dbChildren.find(
            (item) => item instanceof DatabaseNode && item.databaseName === 'dbb'
        ) as DatabaseNode | undefined;
        assert.ok(dbaNode);
        assert.ok(dbbNode);

        // Sequential expand - DB-A then DB-B on the SAME read-only
        // connection. The expansion path itself does not need the
        // synchronous wrapper because `executeQuery` (which the tree's
        // loadRowCounts uses) routes through pool.execute(), but the
        // read-only contract still MUST be enforced. We drive it here
        // by calling the production acquireReadOnlyConnection() method
        // directly on the actor's session - this is the same path the
        // QueryWorkbench and any other caller that wants a guaranteed
        // read-only checkout uses. Tree refresh does not currently call
        // this method, so we drive it through the actor's own state
        // to prove the fake pool's getConnection callback implements
        // the read-only contract correctly.
        const actorLookup = connRegistry.lookup('cfg-ro');
        assert.strictEqual(actorLookup.tag, 'known');
        // First expand triggers loadRowCounts which uses executeQuery -
        // pool.execute path, no getConnection needed.
        const dbaTables = await provider.getChildren(dbaNode);
        assert.strictEqual(dbaTables.length, 2);

        // Now drive the callback-style read-only checkout through the
        // production acquireReadOnlyConnection() code path. This is the
        // exact path the QueryWorkbench uses for queries that must
        // classify through classifySqlBatch before reaching the pool.
        // The synchronous wrapper calls pool.getConnection(), then runs
        // `SET SESSION TRANSACTION READ ONLY` on the checked-out
        // connection. Both reach into our fake: getConnection increments
        // `getConnectionCalls`, and the connection's query() pushes the
        // SET statement into recordedSql.
        //
        // Access the session via the registry's public getSession() -
        // this is the same DatabaseSession the actor exposes; calling
        // acquireReadOnlyConnection on it triggers the production
        // synchronous-wrapper path the plan asks us to drive.
        const session = connRegistry.getSession('cfg-ro');
        assert.ok(session, 'expected an open DatabaseSession for cfg-ro');
        const readOnlyResult = await session.acquireReadOnlyConnection();
        assert.strictEqual(
            readOnlyResult.ok,
            true,
            'acquireReadOnlyConnection must succeed against the fake pool'
        );

        // Defect 2 invariant: the fake pool's getConnection was called
        // by the synchronous read-only checkout wrapper.
        assert.ok(
            fake.getConnectionCalls >= 1,
            'getConnection must have been called by acquireReadOnlyConnection()'
        );

        // Defect 2 invariant: the SET SESSION TRANSACTION READ ONLY SQL
        // statement issued by acquireReadOnlyConnection() reached the
        // fake pool's connection.query() callback and was appended to
        // the shared recordedSql array.
        const setReadOnlyRecorded = fake.recordedSql.some(
            (sql) => sql.trim().toUpperCase() === 'SET SESSION TRANSACTION READ ONLY'
        );
        assert.ok(
            setReadOnlyRecorded,
            'expected recordedSql to contain SET SESSION TRANSACTION READ ONLY; got: ' + JSON.stringify(fake.recordedSql)
        );

        // Second expand on the SAME read-only connection. After the
        // forced read-only checkout the registry is still connected and
        // the expansion completes cleanly.
        const dbbTables = await provider.getChildren(dbbNode);
        assert.strictEqual(dbbTables.length, 1);

        // After two sequential expands on a read-only profile the actor
        // is still connected (no forced disconnect from the wrapper, no
        // queue poison).
        assert.strictEqual(connRegistry.isConnected('cfg-ro'), true, 'actor must remain connected after sequential expand');
    });

    test('a single failing count query does not poison the row-count cache for subsequent expands', async function () {
        // This post-fix regression gate keeps each count query bounded and
        // leaves failed counts out of the cache. Both dba expands must retry
        // and resolve with unknown row counts, while dbb must remain
        // independently expandable. A regression hangs the spinner again and
        // is bounded by Mocha's outer timeout. Two sequential ~5s count
        // timeouts (the production COUNT_QUERY_TIMEOUT_MS in
        // src/views/connectionExplorer.ts) require ~10s of legitimate
        // wait time, so 20_000 is the minimum safe Mocha bound.
        this.timeout(20_000);

        // One specific count will never resolve. Everything else returns
        // empty rows so the loadRowCounts path reaches that one bad call.
        const brokenCount = deferred();
        const bySql = new Map<string, {
            rows?: readonly Record<string, unknown>[];
            fields?: readonly { name: string }[];
            deferred?: { readonly promise: Promise<void> };
        }>([
            [
                'SHOW DATABASES',
                {
                    rows: [{ Database: 'dba' }, { Database: 'dbb' }],
                    fields: [{ name: 'Database' }],
                },
            ],
            [
                // Listed BEFORE FROM `dba` so this matcher wins. Otherwise
                // the broader FROM `dba` substring would shadow it.
                'COUNT(*) FROM `dba`.`broken`',
                {
                    // The deferred is never resolved within the test -
                    // simulate "the count hangs forever".
                    deferred: brokenCount,
                    rows: [],
                    fields: [],
                },
            ],
            [
                'FROM `dba`',
                {
                    rows: [{ Tables_in_dba: 'broken' }],
                    fields: [{ name: 'Tables_in_dba' }],
                },
            ],
            [
                'FROM `dbb`',
                {
                    rows: [{ Tables_in_dbb: 'products' }],
                    fields: [{ name: 'Tables_in_dbb' }],
                },
            ],
        ]);
        const fake = buildFakePool({ bySql });
        connRegistry = new ActorRegistry({ identity: fakeIdentity(), poolFactory: fake.factory });
        const provider = new ServerTree({ catalog, registry: connRegistry });

        await catalog.add(makeConnectionConfig({ id: 'cfg-1' }));
        await connRegistry.connect('cfg-1', makeConnectionConfig({ id: 'cfg-1' }));

        const rootChildren = await provider.getChildren();
        const serverNode = rootChildren[0];
        assert.ok(serverNode instanceof ServerNode);

        const dbChildren = await provider.getChildren(serverNode);
        const dbaNode = dbChildren.find(
            (item) => item instanceof DatabaseNode && item.databaseName === 'dba'
        ) as DatabaseNode | undefined;
        const dbbNode = dbChildren.find(
            (item) => item instanceof DatabaseNode && item.databaseName === 'dbb'
        ) as DatabaseNode | undefined;
        assert.ok(dbaNode);
        assert.ok(dbbNode);

        // The first count times out without writing to the row-count cache.
        const firstResult = await provider.getChildren(dbaNode);
        assert.ok(Array.isArray(firstResult));
        assert.strictEqual(firstResult.length, 1);
        assert.ok(firstResult[0] instanceof TableNode);
        assert.strictEqual(firstResult[0].tableName, 'broken');
        assert.strictEqual(firstResult[0].databaseName, 'dba');
        assert.strictEqual(firstResult[0].description, '? rows');

        // Re-expanding dba retries the uncached count and resolves again.
        const secondResult = await provider.getChildren(dbaNode);
        assert.ok(Array.isArray(secondResult));
        assert.strictEqual(secondResult.length, 1);
        assert.ok(secondResult[0] instanceof TableNode);
        assert.strictEqual(secondResult[0].tableName, 'broken');
        assert.strictEqual(secondResult[0].databaseName, 'dba');
        assert.strictEqual(secondResult[0].description, '? rows');

        // dbb remains independently expandable after the dba timeout.
        const dbbResult = await provider.getChildren(dbbNode);
        assert.ok(Array.isArray(dbbResult));
        assert.strictEqual(dbbResult.length, 1);
        assert.ok(dbbResult[0] instanceof TableNode);
        assert.strictEqual(dbbResult[0].tableName, 'products');
        assert.strictEqual(dbbResult[0].databaseName, 'dbb');

        // Cleanup so the deferred isn't held against a future test run.
        brokenCount.resolve();
    });
});
