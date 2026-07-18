/**
 * Regression test for the column-expansion fix shipped at `d01dd5e`
 * (`fix(registry): scope DESCRIBE to the table's database so column
 * expansion works without a default DB`).
 *
 * Background:
 *   `DatabaseSession.listColumns(database, tableName)` previously emitted
 *   only the schema-less form `DESCRIBE \`tbl\`` regardless of the
 *   `database` argument. For connection profiles whose default DB is
 *   empty (the friendly-defaults configuration), the server rejected
 *   that call with "No database selected" and the table's expand path
 *   rendered `Schema unavailable: No database selected`.
 *
 *   The fix widens `listColumns` so it emits the qualified form
 *   `DESCRIBE \`db\`.\`tbl\`` when `database` is non-empty, and threads
 *   `table.databaseName` from `ServerTree.getColumns` (built up the tree
 *   from a known `DatabaseNode`) into the SQL.
 *
 * Contract this test locks down:
 *   When a `TableNode` carries a `databaseName` (because the tree
 *   builder rendered it from a real `DatabaseNode`), expanding that
 *   `TableNode` MUST issue `DESCRIBE \`appdb\`.\`users\`` on the pool —
 *   NOT the schema-less fallback form `DESCRIBE \`users\``.
 *
 * Surface used for SQL capture:
 *   We capture SQL on the **mysql2 pool surface** (the `fakeExecute`
 *   sinon stub returned by `buildTablePool`). Production code calls
 *   `pool.execute(sql)` via `DatabaseSession.execute()` ->
 *   `CatalogReader.listColumns()` -> `ServerTree.getColumns()`. That is
 *   the same surface the no-count test uses; capturing here means we
 *   observe exactly the strings the registry's session forwards to
 *   `pool.execute()`. Stubs on `ActorRegistry.executeQuery` would be
 *   the wrong surface and would mask regressions — the no-count test
 *   already proved this.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { __test__, extensionContext } from '../mocks/vscode';

import {
    ServerTree,
    ServerNode,
    DatabaseNode,
    TableNode,
    ColumnNode,
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
 * `fakeExecute` is the **mysql2 pool surface** that production code
 * calls. Capturing SQL here means we observe exactly the strings
 * `DatabaseSession.execute()` forwards to `pool.execute()` — the same
 * surface `ServerTree.getColumns()` ultimately drives via
 * `CatalogReader.listColumns()` -> `DatabaseSession.listColumns()`.
 *
 * Staging:
 *   - `DESCRIBE \`appdb\`.\`users\`` (case-insensitive) -> the staged
 *     fake column rows. This is the **regression-lock contract**: when
 *     a `TableNode` carries a `databaseName`, expansion MUST issue
 *     exactly this SQL.
 *   - `SHOW TABLES` / `SHOW TABLES FROM ...` -> one fake table row so
 *     the database-expand path produces a non-empty `DatabaseNode`
 *     child list and a `TableNode` whose `databaseName` is populated.
 *   - `SHOW DATABASES` -> one fake database row so the server-expand
 *     path produces a `DatabaseNode` for `appdb`.
 *   - Anything else -> `[[], []]` so we can clearly distinguish the
 *     schema-less `DESCRIBE \`users\`` fallback form from the
 *     qualified form.
 */
function buildTablePool(): {
    factory: PoolFactory;
    fakeExecute: sinon.SinonStub;
} {
    const fakeExecute = sinon.stub().callsFake(async (sql: string) => {
        if (/^\s*SHOW\s+DATABASES/i.test(sql)) {
            return [[{ Database: 'appdb' }], []] as unknown as never;
        }
        if (/^\s*SHOW\s+TABLES/i.test(sql)) {
            return [[{ Tables_in_appdb: 'users' }], []] as unknown as never;
        }
        if (/^\s*DESCRIBE\s+`appdb`\.`users`/i.test(sql)) {
            return [
                [
                    { Field: 'id', Type: 'int(11)' },
                    { Field: 'name', Type: 'varchar(255)' },
                ],
                [],
            ] as unknown as never;
        }
        return [[], []] as unknown as never;
    });
    const factory: PoolFactory = (_config: DatabaseSessionConfig): PoolLike => ({
        execute: fakeExecute as unknown as PoolLike['execute'],
        end: sinon.stub().resolves() as unknown as () => Promise<void>,
    });
    return { factory, fakeExecute };
}

suite('ServerTree column expand (DESCRIBE db.tbl regression)', () => {
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

        // Stage the fake pool. The pool's `execute` is what CatalogReader
        // ultimately calls; this stub is what the registry's session
        // reaches via the poolFactory we wire in.
        const tablePool = buildTablePool();
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

    test("expanding a table issues DESCRIBE `db`.`tbl` when default DB is empty", async function (): Promise<void> {
        this.timeout(5_000);

        // Regression condition: the connection profile has NO default DB.
        // After `ca5f0a6` (`feat(catalog): drop the database field`) the
        // `database` field is absent from `ConnectionConfig`, and
        // `ActorRegistry.openSession` hard-codes the `DatabaseSessionConfig`
        // slot to `''`. Prior to `d01dd5e` the bare `DESCRIBE \`users\``
        // form failed server-side with "No database selected" in this
        // state; the production fix threads `table.databaseName` into
        // the SQL so it issues `DESCRIBE \`appdb\`.\`users\`` instead.
        const cfg = makeConnectionConfig({ id: 'cfg-cols-empty-db' });
        await catalog.add(cfg);
        await registry.connect('cfg-cols-empty-db', cfg);

        // 1. Expand the server -> DatabaseNodes including `appdb`.
        const rootChildren = await provider.getChildren();
        assert.strictEqual(rootChildren.length, 1, 'expected exactly one ServerNode root child');
        const serverNode = rootChildren[0];
        assert.ok(
            serverNode !== undefined && serverNode instanceof ServerNode,
            `expected ServerNode, got ${serverNode?.constructor.name ?? 'undefined'}`
        );

        // 2. Expand the server -> DatabaseNodes including `appdb`.
        const dbChildren = await provider.getChildren(serverNode);
        const databaseNode = dbChildren.find(
            (item) => item instanceof DatabaseNode && (item as DatabaseNode).databaseName === 'appdb'
        ) as DatabaseNode | undefined;
        assert.ok(databaseNode, `expected a DatabaseNode for 'appdb' in: ${JSON.stringify(dbChildren.map((c) => c.constructor.name))}`);

        // 3. Expand the database -> TableNodes including `users` whose
        //    `databaseName` is populated by the tree builder (line 145 of
        //    `connectionExplorer.ts`). This is the field the production
        //    fix threads into `listColumns(database, tableName)`.
        const tableChildren = await provider.getChildren(databaseNode);
        const tableNode = tableChildren.find(
            (item) => item instanceof TableNode && (item as TableNode).tableName === 'users'
        ) as TableNode | undefined;
        assert.ok(tableNode, `expected a TableNode for 'users' in: ${JSON.stringify(tableChildren.map((c) => c.constructor.name))}`);
        assert.strictEqual(
            tableNode.databaseName,
            'appdb',
            `TableNode for 'users' must carry databaseName='appdb' so getColumns can scope DESCRIBE; got ${JSON.stringify(tableNode.databaseName)}`
        );

        // 4. Expand the table -> ColumnNodes. This is the path that was
        //    failing with "Schema unavailable: No database selected"
        //    before `d01dd5e`.
        const columnChildren = await provider.getChildren(tableNode);

        // 5. Regression-lock contracts (the heart of this test).
        //
        //    (a) At least one call to `fakeExecute` MUST have been the
        //        qualified form `DESCRIBE \`appdb\`.\`users\``. The
        //        production fix threads `table.databaseName` into the
        //        SQL; if that contract is ever broken (e.g., someone
        //        removes the `databaseName` plumbing from getColumns),
        //        this assertion fails.
        //
        //    (b) NO call to `fakeExecute` may be the schema-less
        //        fallback form `DESCRIBE \`users\``. This is the
        //        symptom we are locking down: when the table node is
        //        built from a known DatabaseNode, the unqualified form
        //        would only succeed if the connection happens to have
        //        a matching default DB; in our regression condition
        //        (`database: ''`) it would fail server-side.
        const allSql = fakeExecute.getCalls().map((c) => c.args[0] as string);

        const qualifiedDescribe = allSql.filter((sql) =>
            /^\s*DESCRIBE\s+`appdb`\.`users`/i.test(sql)
        );
        assert.ok(
            qualifiedDescribe.length >= 1,
            `expected at least one DESCRIBE \`appdb\`.\`users\` call on table expand; recorded SQL was: ${JSON.stringify(allSql)}`
        );

        const unqualifiedDescribe = allSql.filter((sql) =>
            /^\s*DESCRIBE\s+`users`\s*$/i.test(sql)
        );
        assert.strictEqual(
            unqualifiedDescribe.length,
            0,
            `expected zero schema-less DESCRIBE \`users\` calls when the table was built from a DatabaseNode; got ${unqualifiedDescribe.length}: ${JSON.stringify(unqualifiedDescribe)}`
        );

        // 6. The rendered children must be ColumnNodes whose `column.name`
        //    matches the staged fake rows.
        assert.ok(
            columnChildren.length >= 2,
            `expected at least two ColumnNode children for the staged fake rows; got ${columnChildren.length}`
        );
        for (const child of columnChildren) {
            assert.ok(
                child instanceof ColumnNode,
                `expected ColumnNode, got ${child.constructor.name}`
            );
        }
        const names = columnChildren.map((c) => (c as ColumnNode).column.name);
        assert.ok(names.includes('id'), `expected a ColumnNode for column 'id'; got names: ${JSON.stringify(names)}`);
        assert.ok(names.includes('name'), `expected a ColumnNode for column 'name'; got names: ${JSON.stringify(names)}`);
    });
});
