import * as assert from 'assert';
import { redactSensitive, summarizeSensitive } from '../../identity/redact';

suite('redactSensitive', () => {
    test('redacts JWT-like values', () => {
        const jwt = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;

        const redacted = redactSensitive(`token=${jwt}`);

        assert.strictEqual(redacted, 'token=[REDACTED JWT]');
    });

    test('redacts Bearer authorization values case-insensitively', () => {
        const redacted = redactSensitive('Authorization: bearer secret_token-123');

        assert.strictEqual(redacted, 'Authorization: Bearer [REDACTED]');
    });

    test('preserves ordinary diagnostic text', () => {
        assert.strictEqual(redactSensitive('connect ECONNREFUSED'), 'connect ECONNREFUSED');
    });
});

suite('summarizeSensitive', () => {
    test('reports only deterministic length and hash metadata', () => {
        const value = '{"access_token":"secret"}';

        const summary = summarizeSensitive(value);

        assert.match(summary, new RegExp(`^length=${value.length} sha256=[a-f0-9]{12}$`));
        assert.strictEqual(summary.includes('secret'), false);
    });
});
