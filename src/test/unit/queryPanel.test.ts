/**
 * Tests for the typed webview protocol parser. Verifies the protocol is
 * parsed strictly, unknown commands rejected, and SQL strings must be
 * non-empty.
 */

import * as assert from 'assert';
import { parseWebviewRequest, isReadOnlyError, type WebviewRequest } from '../../views/queryWorkbench';

suite('parseWebviewRequest', () => {
    test('accepts executeQuery with a non-empty sql string', () => {
        const result = parseWebviewRequest({ command: 'executeQuery', sql: 'SELECT 1' });
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        const req = result.request as Extract<WebviewRequest, { command: 'executeQuery' }>;
        assert.strictEqual(req.sql, 'SELECT 1');
    });

    test('accepts runFocusedQuery with full SQL and a caret offset', () => {
        const result = parseWebviewRequest({
            command: 'runFocusedQuery',
            sql: 'SELECT 1; SELECT 2;',
            caret: 15,
        });
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.request.command, 'runFocusedQuery');
        if (result.request.command !== 'runFocusedQuery') throw new Error('unreachable');
        assert.strictEqual(result.request.caret, 15);
    });

    test('accepts exportCsv with no payload', () => {
        const result = parseWebviewRequest({ command: 'exportCsv' });
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.request.command, 'exportCsv');
    });

    test('rejects unknown commands', () => {
        const result = parseWebviewRequest({ command: 'deleteEverything' });
        assert.strictEqual(result.tag, 'parseFailure');
    });

    test('rejects executeQuery with missing sql', () => {
        const result = parseWebviewRequest({ command: 'executeQuery' });
        assert.strictEqual(result.tag, 'parseFailure');
    });

    test('rejects executeQuery with empty sql', () => {
        const result = parseWebviewRequest({ command: 'executeQuery', sql: '' });
        assert.strictEqual(result.tag, 'parseFailure');
    });

    test('rejects executeQuery with non-string sql', () => {
        const result = parseWebviewRequest({ command: 'executeQuery', sql: 123 });
        assert.strictEqual(result.tag, 'parseFailure');
    });

    test('rejects arrays and null', () => {
        assert.strictEqual(parseWebviewRequest([]).tag, 'parseFailure');
        assert.strictEqual(parseWebviewRequest(null).tag, 'parseFailure');
        assert.strictEqual(parseWebviewRequest(undefined).tag, 'parseFailure');
    });

    test('rejects malformed executeQuery payloads (extra fields still accepted)', () => {
        const result = parseWebviewRequest({
            command: 'executeQuery',
            sql: 'SELECT 1',
            extra: 'ignored',
        });
        assert.strictEqual(result.tag, 'ok');
    });
});

suite('isReadOnlyError', () => {
    test('detects the canonical mysql2 error code prefix', () => {
        assert.ok(isReadOnlyError("[ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION] The MySQL server is running with the read-only option"));
    });

    test('detects variant casing of the error code', () => {
        assert.ok(isReadOnlyError("[er_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION] so it cannot execute this statement"));
    });

    test('detects the plain-text "read-only transaction" variant', () => {
        assert.ok(isReadOnlyError('Cannot execute statement in a read-only transaction'));
        assert.ok(isReadOnlyError('Cannot execute statement in a read only transaction'));
    });

    test('returns false for unrelated server errors', () => {
        assert.strictEqual(isReadOnlyError('[ER_PARSE_ERROR] You have an error in your SQL syntax'), false);
        assert.strictEqual(isReadOnlyError('[ER_ACCESS_DENIED_ERROR] Access denied'), false);
        assert.strictEqual(isReadOnlyError('Connection lost'), false);
        assert.strictEqual(isReadOnlyError(''), false);
    });
});