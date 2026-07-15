/**
 * Tests for src/errors.ts. Verifies the ExtensionProblem hierarchy: each
 * subclass carries a stable code, retryable flag, and user-safe message.
 */

import * as assert from 'assert';
import {
    AuthProblem,
    CancelledProblem,
    ConnectionProblem,
    ExtensionProblem,
    QueryProblemError,
    isExtensionProblem,
} from '../../problems';

suite('ExtensionProblem hierarchy', () => {
    test('AuthProblem carries AUTH_FAILED and is retryable', () => {
        const err = new AuthProblem('raw', 'Please sign in to Azure.');
        assert.ok(err instanceof ExtensionProblem);
        assert.strictEqual(err.code, 'AUTH_FAILED');
        assert.strictEqual(err.retryable, true);
        assert.strictEqual(err.userMessage, 'Please sign in to Azure.');
        assert.strictEqual(err.message, 'raw');
    });

    test('ConnectionProblem carries CONNECTION_FAILED and is retryable', () => {
        const err = new ConnectionProblem('socket closed', 'Lost connection to MySQL.');
        assert.strictEqual(err.code, 'CONNECTION_FAILED');
        assert.strictEqual(err.retryable, true);
    });

    test('QueryProblemError carries QUERY_FAILED and is not retryable', () => {
        const err = new QueryProblemError(
            'ER_PARSE_ERROR',
            'Query failed.',
            undefined,
            'ER_PARSE_ERROR'
        );
        assert.strictEqual(err.code, 'QUERY_FAILED');
        assert.strictEqual(err.retryable, false);
        assert.strictEqual(err.serverCode, 'ER_PARSE_ERROR');
    });

    test('CancelledProblem carries AUTH_CANCELLED by default and is not retryable', () => {
        const err = new CancelledProblem();
        assert.strictEqual(err.code, 'AUTH_CANCELLED');
        assert.strictEqual(err.retryable, false);
    });

    test('cause propagates from constructor to property', () => {
        const underlying = new Error('boom');
        const err = new ConnectionProblem('wrapped', 'Try again.', underlying);
        assert.strictEqual(err.cause, underlying);
    });

    test('cause is undefined when not provided', () => {
        const err = new AuthProblem('raw', 'msg');
        assert.strictEqual(err.cause, undefined);
    });

    test('name equals the constructor name (helps with logs)', () => {
        assert.strictEqual(new AuthProblem('x', 'y').name, 'AuthProblem');
        assert.strictEqual(new ConnectionProblem('x', 'y').name, 'ConnectionProblem');
        assert.strictEqual(new QueryProblemError('x', 'y').name, 'QueryProblemError');
        assert.strictEqual(new CancelledProblem().name, 'CancelledProblem');
    });

    test('isExtensionProblem narrows unknown to the hierarchy', () => {
        assert.strictEqual(isExtensionProblem(new AuthProblem('a', 'b')), true);
        assert.strictEqual(isExtensionProblem(new Error('plain')), false);
        assert.strictEqual(isExtensionProblem('a string'), false);
        assert.strictEqual(isExtensionProblem(null), false);
        assert.strictEqual(isExtensionProblem(undefined), false);
    });

    test('userMessage never carries the raw message by default', () => {
        const raw = 'token=eyJhbGc.something-secret';
        const err = new AuthProblem(raw, 'Please sign in.');
        assert.ok(!err.userMessage.includes('token='), 'userMessage must not leak secrets');
    });
});