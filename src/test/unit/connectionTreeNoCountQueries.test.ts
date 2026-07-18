/**
 * Regression test for the row-count purge in `src/views/connectionExplorer.ts`.
 *
 * After the row-count code path was deleted from `ServerTree.getTables()`,
 * `TableNode` is constructed with no row-count description. This test
 * locks in the new contract: **expanding a database issues zero
 * `SELECT COUNT(*)` queries** against the `ActorRegistry`.
 *
 * If anyone ever reintroduces a `SELECT COUNT(*) FROM \`db\`.\`tbl\``
 * round-trip into the tree's database-expand path, this test must fail.
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
 */
function buildTablePool(rowsByTable: ReadonlyArray<Record<string, string>>) {
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
    let executeQueryStub: sinon.SinonStub;
    let registry: ActorRegistry;
    let catalog: GlobalStateConnectionCatalog;
    let provider: ServerTree;

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
        registry = new ActorRegistry({
            identity: fakeIdentity(),
            poolFactory: tablePool.factory,
        });
        provider = new ServerTree({ catalog, registry });

        // Replace `executeQuery` at the prototype level so we can record every
        // SQL string the tree sends into the registry. The real implementation
        // is bypassed; we only need to know whether COUNT(*) is among them.
        executeQueryStub = sinon.stub(ActorRegistry.prototype, 'executeQuery').callsFake(
            async (_id: string, _sql: string) => {
                return [[], []] as unknown as never;
            }
        );
    });

    teardown(() => {
        executeQueryStub.restore();
        __test__.reset();
        __test__.resetAuth();
    });

    test('expanding a database issues zero SELECT COUNT(*) queries', async function (): Promise<void> {
        this.timeout(5_000);

        const cfg = makeConnectionConfig({ id: 'cfg-no-count' });
        await catalog.add(cfg);
        await registry.connect('cfg-no-count', cfg);

        const recordedSql: string[] = [];
        executeQueryStub.callsFake(async (_id: string, sql: string) => {
            recordedSql.push(sql);
            return [[], []] as unknown as never;
        });

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

        // 2. No recorded SQL may match the COUNT(*) pattern.
        const countPattern = /SELECT\s+COUNT\s*\(\s*\*/i;
        const offenders = recordedSql.filter((sql) => countPattern.test(sql));
        assert.strictEqual(
            offenders.length,
            0,
            `expected zero SELECT COUNT(*) queries on database expand; got ${offenders.length}: ${JSON.stringify(offenders)}`
        );
    });
});
