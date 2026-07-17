/**
 * Tests for src/identity/identityTimeouts.ts.
 *
 * Locks the shared user-facing identity-prompt timeout budget
 * (IDENTITY_PROMPT_TIMEOUT_MS) and the IdentityPromptTimeoutError shape.
 * These tests must run BEFORE Todo 2 wires the constant into
 * src/commands/openSession.ts and src/registry/actorRegistry.ts.
 */

import * as assert from 'assert';
import {
    IDENTITY_PROMPT_TIMEOUT_MS,
    IdentityPromptTimeoutError,
} from '../../identity/identityTimeouts';

suite('identityTimeouts', () => {
    test('IDENTITY_PROMPT_TIMEOUT_MS equals 120_000 (two minutes)', () => {
        assert.strictEqual(IDENTITY_PROMPT_TIMEOUT_MS, 120_000);
    });

    test('IdentityPromptTimeoutError.name is the literal class name', () => {
        const err = new IdentityPromptTimeoutError(IDENTITY_PROMPT_TIMEOUT_MS);
        assert.strictEqual(err.name, 'IdentityPromptTimeoutError');
    });

    test('IdentityPromptTimeoutError.message is the literal user-facing string', () => {
        const err = new IdentityPromptTimeoutError(IDENTITY_PROMPT_TIMEOUT_MS);
        assert.strictEqual(err.message, 'Identity prompt timed out after 120 seconds.');
    });

    test('IdentityPromptTimeoutError preserves the timeoutMs it was constructed with', () => {
        const err = new IdentityPromptTimeoutError(IDENTITY_PROMPT_TIMEOUT_MS);
        assert.strictEqual(err.timeoutMs, IDENTITY_PROMPT_TIMEOUT_MS);
    });

    test('IdentityPromptTimeoutError is an instance of Error for try/catch interop', () => {
        const err = new IdentityPromptTimeoutError(IDENTITY_PROMPT_TIMEOUT_MS);
        assert.ok(err instanceof Error);
        assert.ok(err instanceof IdentityPromptTimeoutError);
    });
});