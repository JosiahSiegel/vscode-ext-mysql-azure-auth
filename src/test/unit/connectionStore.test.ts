/**
 * Tests for GlobalStateConnectionCatalog + parseStoredConnections.
 * Uses zod for parse-don't-validate: invalid payloads yield an empty list
 * plus a logged problem rather than corrupting app state.
 */

import * as assert from 'assert';
import { parseStoredConnections } from '../../registry/connectionCatalog';
import type { ConnectionConfig } from '../../domain';

function makeValidConfig(): ConnectionConfig {
    return {
        id: 'cfg-1',
        name: 'Test',
        host: 'example.mysql.database.azure.com',
        port: 3306,
        database: 'appdb',
        user: 'me@example.com',
        ssl: true,
    };
}

suite('parseStoredConnections', () => {
    test('returns empty for null/undefined', () => {
        for (const v of [undefined, null]) {
            const r = parseStoredConnections(v);
            assert.deepStrictEqual(r.connections, []);
            assert.deepStrictEqual(r.problems, []);
        }
    });

    test('round-trips a valid legacy payload', () => {
        const payload: ConnectionConfig[] = [makeValidConfig()];
        const r = parseStoredConnections(payload);
        assert.strictEqual(r.problems.length, 0);
        assert.deepStrictEqual(r.connections, payload);
    });

    test('rejects non-array payloads', () => {
        for (const bad of [{ id: 'a' }, 'string', 42, true]) {
            const r = parseStoredConnections(bad);
            assert.strictEqual(r.connections.length, 0);
            assert.ok(r.problems.length > 0, `expected problems for ${JSON.stringify(bad)}`);
        }
    });

    test('rejects entries with out-of-range ports and surfaces a path-tagged problem', () => {
        const bad = {
            ...makeValidConfig(),
            port: 70000,
        };
        const r = parseStoredConnections([bad]);
        assert.strictEqual(r.connections.length, 0);
        assert.ok(
            r.problems.some((p) => p.includes('port')),
            `expected port problem; got: ${r.problems.join(', ')}`
        );
    });

    test('rejects entries with non-string ids / hosts', () => {
        const bad = { ...makeValidConfig(), host: '' };
        const r = parseStoredConnections([bad]);
        assert.strictEqual(r.connections.length, 0);
        assert.ok(r.problems.some((p) => p.includes('host')));
    });

    test('partially valid payloads are still rejected wholesale', () => {
        const good = makeValidConfig();
        const bad = { ...makeValidConfig(), port: 0 };
        const r = parseStoredConnections([good, bad]);
        // zod fails the whole array because one element is invalid.
        assert.strictEqual(r.connections.length, 0);
        assert.ok(r.problems.length > 0);
    });

    test('survives legacy payloads that are missing newer optional fields', () => {
        // The legacy shape has no optional fields, so this is mostly a
        // round-trip check; but a payload with EXTRA unknown fields should
        // still parse (zod's default is to strip them).
        const payload = [
            { ...makeValidConfig(), extraField: 'ignored' },
        ];
        const r = parseStoredConnections(payload);
        assert.strictEqual(r.problems.length, 0);
        assert.strictEqual(r.connections.length, 1);
    });
});