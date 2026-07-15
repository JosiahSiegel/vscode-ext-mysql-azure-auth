/**
 * Tests for the domain contracts in src/types.ts.
 * Covers the brand, the discriminated QueryOutcome, and the wire-format
 * adapter that preserves the existing test/webview contract.
 */

import * as assert from 'assert';
import {
    asConnectionId,
    toLegacyQueryResult,
    type QueryOutcome,
    type StatementOutput,
} from '../../domain';

suite('asConnectionId', () => {
    test('returns a ConnectionId branded from a string', () => {
        const id = asConnectionId('cfg-1');
        assert.strictEqual(typeof id, 'string');
        assert.strictEqual(id, 'cfg-1');
    });
});

suite('toLegacyQueryResult', () => {
    test('projects ok:rows to legacy rows shape', () => {
        const outcome: QueryOutcome = {
            tag: 'ok',
            success: {
                elapsedMs: 12,
                output: {
                    tag: 'rows',
                    columns: ['id', 'name'],
                    rows: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
                },
            },
        };
        const legacy = toLegacyQueryResult(outcome);
        assert.deepStrictEqual(legacy.columns, ['id', 'name']);
        assert.strictEqual(legacy.rowCount, 2);
        assert.strictEqual(legacy.executionTime, 12);
        assert.strictEqual(legacy.error, undefined);
        assert.strictEqual(legacy.rows.length, 2);
    });

    test('projects ok:change to mutation metadata shape', () => {
        const output: StatementOutput = {
            tag: 'change',
            affectedRows: 3,
            insertId: 42,
            info: 'Records: 3  Duplicates: 0  Warnings: 0',
        };
        const outcome: QueryOutcome = {
            tag: 'ok',
            success: { elapsedMs: 5, output },
        };
        const legacy = toLegacyQueryResult(outcome);
        assert.deepStrictEqual(legacy.columns, ['affectedRows', 'insertId', 'info']);
        assert.strictEqual(legacy.rowCount, 1);
        assert.strictEqual((legacy.rows[0] as { affectedRows: number }).affectedRows, 3);
        assert.strictEqual((legacy.rows[0] as { insertId: number }).insertId, 42);
    });

    test('projects err:notConnected to Not connected message', () => {
        const outcome: QueryOutcome = {
            tag: 'err',
            problem: { tag: 'notConnected' },
        };
        const legacy = toLegacyQueryResult(outcome);
        assert.strictEqual(legacy.error, 'Not connected to database');
        assert.strictEqual(legacy.rowCount, 0);
    });

    test('projects err:cancelled to Query cancelled message', () => {
        const outcome: QueryOutcome = {
            tag: 'err',
            problem: { tag: 'cancelled' },
        };
        const legacy = toLegacyQueryResult(outcome);
        assert.strictEqual(legacy.error, 'Query cancelled');
    });

    test('projects err:server to a message that includes the code if present', () => {
        const outcome: QueryOutcome = {
            tag: 'err',
            problem: { tag: 'server', code: 'ER_ACCESS_DENIED', message: 'access denied' },
        };
        const legacy = toLegacyQueryResult(outcome);
        assert.match(legacy.error!, /ER_ACCESS_DENIED/);
        assert.match(legacy.error!, /access denied/);
    });

    test('projects err:server without a code to just the message', () => {
        const outcome: QueryOutcome = {
            tag: 'err',
            problem: { tag: 'server', message: 'syntax error' },
        };
        const legacy = toLegacyQueryResult(outcome);
        assert.strictEqual(legacy.error, 'syntax error');
    });

    test('returns independent row objects (no shared references)', () => {
        const outcome: QueryOutcome = {
            tag: 'ok',
            success: {
                elapsedMs: 0,
                output: { tag: 'rows', columns: ['x'], rows: [{ x: 1 }] },
            },
        };
        const a = toLegacyQueryResult(outcome);
        const b = toLegacyQueryResult(outcome);
        assert.notStrictEqual(a.rows[0], b.rows[0]);
    });
});