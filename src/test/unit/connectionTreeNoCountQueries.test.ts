/**
 * Regression test for the row-count purge in `src/views/connectionExplorer.ts`.
 *
 * After the row-count code path was deleted from `ServerTree.getTables()`,
 * `TableNode` is constructed with no row-count description. This test
 * locks in the new contract: **expanding a database issues zero
 * `SELECT COUNT(*)` queries** against the underlying mysql2 pool.
 *
 * The production path that gets exercised when a `DatabaseNode` is
 * expanded is:
 *
 *     ServerTree.getTables
 *       -> CatalogReader.listTables
 *       -> DatabaseSession.listTables(database)
 *       -> DatabaseSession.execute('SHOW TABLES FROM `db`')
 *       -> pool.execute(sql)            // <-- the mysql2 pool surface
 *
 * We capture SQL at the pool surface (the same surface production uses)
 * via the `fakeExecute` sinon stub returned by `buildTablePool`. If anyone
 * ever reintroduces a `SELECT COUNT(*) FROM \`db\`.\`tbl\`` round-trip into
 * the tree's database-expand path, this test must fail.
 *
 * Replaces the broader `connectionTreeDatabaseExpand.test.ts` (which
 * also covered the deleted cache-poisoning bug class). The earlier
 * file's "sequential happy-path expand" and "read-only expand"
 * scenarios remain valuable but are not the regression we are
 * shipping; this is.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { __test__, extensionContext } from '../mocks/vscode';

import {
    ServerTree,
    DatabaseNode,
    TableNode,
} from '../../views/connectionExplorer';
import { ActorRegistry } from '../../registry/actorRegistry';
import { GlobalStateConnectionCatalog } from '../../registry/connectionCatalog';
import type { DatabaseSessionConfig, PoolFactory, PoolLike } from '../../registry/databaseSession';
import { makeConnectionConfig } from '../factories/connectionConfig';

/**
 * Stub identity. The tree renderer only inspects registry state, never
 * the credential chain, so a constant-token stub keeps the tests
 * network-free.
 */
function fakeIdentity(): { readonly getAccessToken: () => Promise<string> } {
    return {
        async getAccessToken(): Promise<string> {
            return 'fake-token';
        },
    };
}

/**
 * Build a fake pool whose `execute` returns whatever 2-tuple the
 * caller stages. Returns the sinon stub so tests can assert on the
 * SQL strings the registry's session ultimately reaches.
 *
 * NOTE: `fakeExecute` is the **mysql2 pool surface** that production
 * code calls. Capturing SQL here means we observe exactly the strings
 * `DatabaseSession.execute()` forwards to `pool.execute()` — the same
 * surface `ServerTree.getTables()` ultimately drives via
 * `CatalogReader.listTables()` -> `DatabaseSession.listTables()`.
 */
function buildTablePool(rowsByTable: ReadonlyArray<Record<string, string>>): {
    factory: PoolFactory;
    fakeExecute: sinon.SinonStub;
} {
    const fakeExecute = sinon.stub().callsFake(async (sql: string) => {
        if (/^\s*SHOW\s+TABLES/i.test(sql)) {
            return [rowsByTable as unknown as never[], []] as unknown as never;
        }
        return [[], []] as unknown as never;
    });
    const factory: PoolFactory = (_config: DatabaseSessionConfig): PoolLike => ({
        execute: fakeExecute as unknown as PoolLike['execute'],
        end: sinon.stub().resolves() as unknown as () => Promise<void>,
    });
    return { factory, fakeExecute };
}

suite('ServerTree database expand (no COUNT(*) regression)', () => {
    let registry: ActorRegistry;
    let catalog: GlobalStateConnectionCatalog;
    let provider: ServerTree;
    let fakeExecute: sinon.SinonStub;

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

        // Stage the fake pool to return table rows when `SHOW TABLES FROM
        // \`appdb\`` is issued. The pool's `execute` is what CatalogReader
        // ultimately calls; this stub is what the registry's session
        // reaches via the poolFactory we wire in.
        const tablePool = buildTablePool([
            { Tables_in_appdb: 'users' },
            { Tables_in_appdb: 'orders' },
        ]);
        fakeExecute = tablePool.fakeExecute;
        registry = new ActorRegistry({
            identity: fakeIdentity(),
            poolFactory: tablePool.factory,
        });
        provider = new ServerTree({ catalog, registry });
    });

    teardown(() => {
        __test__.reset();
        __test__.resetAuth();
    });

    test('expanding a database issues zero SELECT COUNT(*) queries', async function (): Promise<void> {
        this.timeout(5_000);

        const cfg = makeConnectionConfig({ id: 'cfg-no-count' });
        await catalog.add(cfg);
        await registry.connect('cfg-no-count', cfg);

        const databaseNode = new DatabaseNode('appdb', 'cfg-no-count');

        const children = await provider.getChildren(databaseNode);

        // 1. Every child must be a TableNode, with no row-count description.
        assert.ok(
            children.length > 0,
            'expected at least one TableNode child for an expand of a fake-catalog database'
        );
        for (const child of children) {
            assert.ok(child instanceof TableNode, `expected TableNode, got ${child.constructor.name}`);
            assert.ok(
                child.description === undefined || child.description === '',
                `TableNode for ${(child as TableNode).tableName} should have no description; got ${JSON.stringify(child.description)}`
            );
        }

        // 2. No recorded SQL on the pool surface may match the COUNT(*) pattern.
        //    `fakeExecute.getCalls()` reads the SQL strings that flowed through
        //    `DatabaseSession.execute()` -> `pool.execute()` — the same surface
        //    the production `getTables` path drives.
        const allSql = fakeExecute.getCalls().map((c) => c.args[0] as string);
        const offenders = allSql.filter((sql) => /SELECT\s+COUNT\s*\(\s*\*/i.test(sql));
        assert.strictEqual(
            offenders.length,
            0,
            `expected zero SELECT COUNT(*) queries on database expand; got ${offenders.length}: ${JSON.stringify(offenders)}`
        );
    });
});
