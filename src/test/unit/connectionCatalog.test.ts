/**
 * Backward-compatibility tests for `parseStoredConnections`.
 *
 * F2 [H4]: the schema was changed from `database: z.string().min(1)` to
 * `database: z.string().optional()`, with `parseStoredConnections`
 * normalising `undefined` -> `''` at the read seam. Records persisted
 * BEFORE that change can legitimately:
 *   1. omit `database` entirely (no such key in the JSON object), or
 *   2. carry `database: ''` (the empty string).
 *
 * Both shapes must round-trip through `parseStoredConnections` with
 * `database: ''` in the in-memory `ConnectionConfig`, no problems, and
 * no data loss on the other fields.
 *
 * These tests construct a real persisted value (a plain object as it
 * would land in `globalState`) and call `parseStoredConnections`
 * directly — the same shape the catalog's `list()` uses at runtime.
 */

import * as assert from 'assert';
import { parseStoredConnections } from '../../registry/connectionCatalog';

/** Minimal valid persisted record with no `database` field. */
function makeAbsentDatabaseRecord(): Record<string, unknown> {
    return {
        id: 'legacy-absent',
        name: 'legacy (no database field)',
        host: 'legacy.example.com',
        port: 3306,
        user: 'legacy-user@example.com',
        ssl: true,
    };
}

/** Minimal valid persisted record with an explicit empty `database`. */
function makeEmptyDatabaseRecord(): Record<string, unknown> {
    return {
        id: 'legacy-empty',
        name: 'legacy (database = "")',
        host: 'legacy.example.com',
        port: 3306,
        database: '',
        user: 'legacy-user@example.com',
        ssl: true,
    };
}

suite('parseStoredConnections — backward-compat for optional database', () => {
    test('accepts a record persisted without the database field', () => {
        const result = parseStoredConnections([makeAbsentDatabaseRecord()]);
        assert.strictEqual(result.problems.length, 0, 'no parse problems expected');
        assert.strictEqual(result.connections.length, 1);
        const [first] = result.connections;
        assert.ok(first);
        assert.strictEqual(first.database, '');
    });

    test('accepts a record persisted with database = ""', () => {
        const result = parseStoredConnections([makeEmptyDatabaseRecord()]);
        assert.strictEqual(result.problems.length, 0, 'no parse problems expected');
        assert.strictEqual(result.connections.length, 1);
        const [first] = result.connections;
        assert.ok(first);
        assert.strictEqual(first.database, '');
    });

    test('still parses a modern record with a non-empty database unchanged', () => {
        const record: Record<string, unknown> = {
            id: 'modern',
            name: 'modern (database = "mydb")',
            host: 'modern.example.com',
            port: 3306,
            database: 'mydb',
            user: 'modern-user@example.com',
            ssl: true,
        };
        const result = parseStoredConnections([record]);
        assert.strictEqual(result.problems.length, 0);
        assert.strictEqual(result.connections.length, 1);
        const [first] = result.connections;
        assert.ok(first);
        assert.strictEqual(first.database, 'mydb');
    });
});
