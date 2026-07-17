/**
 * Tests for the displayDatabase helper exported from
 * src/views/connectionExplorer.ts. The helper is shared in spirit with the
 * identical body in src/main.ts (T4 of the friendly-defaults plan); this
 * file pins the contract for both branches: non-empty input passes through,
 * empty/missing input falls back to the human-readable placeholder.
 */

import * as assert from 'assert';
import { displayDatabase } from '../../views/connectionExplorer';

suite('displayDatabase helper', () => {
    const PLACEHOLDER = '(no default database)';

    test('returns the database name unchanged when given a non-empty string', () => {
        assert.strictEqual(displayDatabase('appdb'), 'appdb');
        assert.strictEqual(displayDatabase('a'), 'a');
        assert.strictEqual(displayDatabase('schema with spaces'), 'schema with spaces');
    });

    test('returns the placeholder when given the empty string', () => {
        assert.strictEqual(displayDatabase(''), PLACEHOLDER);
    });

    test('returns the placeholder when given undefined coerced to string', () => {
        // The helper signature is `(database: string)`, but at runtime the
        // connection profile may surface an undefined `database` field; the
        // `||` fallback must cover that case so the tree never renders `undefined`.
        assert.strictEqual(
            displayDatabase(undefined as unknown as string),
            PLACEHOLDER,
        );
    });
});
