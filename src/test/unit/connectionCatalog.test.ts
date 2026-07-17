/**
 * Tests for `parseStoredConnections` and the catalog's round-trip
 * persistence layer.
 *
 * drop-default-database T1: the optional `database` field is gone from the
 * parsed shape and the v1 migration step rewrites legacy persisted records
 * to drop the field. `loadOrMigrate()` is the catalog's canonical
 * coercion+rewrite step (and the same code path the v1 step invokes);
 * it persists the rewritten records back to `globalState` whenever the
 * in-memory shape differs from the on-disk shape. The first test below
 * exercises that end-to-end: a legacy record carrying `database` is
 * written directly into `globalState`, `loadOrMigrate()` is called,
 * and the resulting `JSON.stringify(...)` of the persisted record MUST
 * NOT contain the substring `"database"`.
 */

import * as assert from 'assert';
import type { ExtensionContext } from 'vscode';
import {
    GlobalStateConnectionCatalog,
    parseStoredConnections,
} from '../../registry/connectionCatalog';
import { __test__, extensionContext } from '../mocks/vscode';

/** Build a record as it might land in `globalState` from a pre-T1 release. */
function legacyV0Record(): Record<string, unknown> {
    return {
        id: 'cfg-1',
        name: 'legacy',
        host: 'x.mysql.database.azure.com',
        port: 3306,
        user: 'u@example.com',
        database: 'appdb',
        readOnly: true,
        ssl: true,
    };
}

suite('parseStoredConnections — drops the legacy `database` field on parse', () => {
    test('parses a payload that includes `database` but does not surface the field in-memory', () => {
        // zod's `.object()` strips unknown keys by default; the legacy
        // `database` field is dropped at parse time without raising a
        // problem (the v1 migration step is what guarantees removal
        // from `globalState` itself).
        const result = parseStoredConnections([legacyV0Record()]);
        assert.strictEqual(result.problems.length, 0);
        assert.strictEqual(result.connections.length, 1);
        const [first] = result.connections;
        assert.ok(first);
        assert.ok(
            !('database' in first),
            `expected in-memory connection to omit 'database'; got keys: ${Object.keys(first).join(', ')}`
        );
    });
});

suite('GlobalStateConnectionCatalog.loadOrMigrate — v1 step strips legacy `database`', () => {
    setup(() => {
        __test__.reset();
    });

    teardown(() => {
        __test__.reset();
    });

    test('round-trip rewrites a legacy v0 record to drop `database` from globalState', () => {
        const ctx = extensionContext as unknown as Pick<ExtensionContext, 'globalState'>;
        // Seed globalState with the exact legacy shape a pre-T1 user
        // would have had. Done directly via `globalState.update` so
        // we don't depend on `add()`, which the catalog layer will
        // strip as part of its coercion path (we want to exercise the
        // v1 step's read-and-rewrite path, not the catalog's write
        // path).
        void ctx.globalState.update('connections', [legacyV0Record()]);

        const catalog = new GlobalStateConnectionCatalog(ctx);
        // `loadOrMigrate()` is the same code path the v1 migration
        // step in `src/main.ts` invokes — it coerces
        // `readOnly`/`database` to the canonical in-memory shape AND
        // persists a stripped disk shape (no `readOnly`, no
        // `database`) back to globalState whenever the in-memory
        // shape differs from disk.
        catalog.loadOrMigrate();

        const persisted = ctx.globalState.get<unknown>('connections');
        assert.ok(Array.isArray(persisted), 'persisted payload should be an array');
        assert.strictEqual(persisted.length, 1);
        // The persisted record MUST NOT carry a `database` key — that's
        // the whole point of the v1 step.
        const persistedJson = JSON.stringify(persisted);
        assert.ok(
            !persistedJson.includes('"database"'),
            `expected persisted record to omit 'database'; got: ${persistedJson}`
        );
    });

    test('persisted record after migration round-trips through `catalog.list()` with no `database` field', () => {
        const ctx = extensionContext as unknown as Pick<ExtensionContext, 'globalState'>;
        void ctx.globalState.update('connections', [legacyV0Record()]);

        const catalog = new GlobalStateConnectionCatalog(ctx);
        catalog.loadOrMigrate();

        const { connections } = catalog.list();
        assert.strictEqual(connections.length, 1);
        const [first] = connections;
        assert.ok(first);
        // The catalog does not surface a `database` key on its in-memory
        // shape either. (zod strips the field; the migration step strips
        // it from `globalState`.)
        assert.ok(
            !('database' in first),
            `expected in-memory record to omit 'database'; got keys: ${Object.keys(first).join(', ')}`
        );
    });
});
