import { createHash } from 'crypto';

const JWT_PATTERN = /[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gi;
// Assignment-style secret leakage in free-text error output (NOT covered
// by the JWT pattern). `token` is intentionally omitted because the JWT
// pattern already handles `token=<jwt>` carriers, and including it here
// would conflict with the existing JWT redaction test.
const ASSIGNMENT_PATTERN = /(password|secret|apikey|api_key)\s*=\s*[^\s;,)]+/gi;

export function redactSensitive(value: string): string {
    return value
        .replace(JWT_PATTERN, '[REDACTED JWT]')
        .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
        .replace(ASSIGNMENT_PATTERN, '$1=[REDACTED]');
}

export function summarizeSensitive(value: string): string {
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
    return `length=${value.length} sha256=${hash}`;
}

/**
 * Categorize a redacted error into a short, actionable, safe label.
 * Used by the registry's `failed` state and by diagnostics so error
 * output never contains raw server messages (which can carry SQL
 * fragments, principals, or schema names).
 */
export function redactErrorCategory(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err ?? '');
    const redacted = redactSensitive(raw).toLowerCase();
    if (redacted.includes('timed out') || redacted.includes('timeout')) {
        return 'timeout';
    }
    if (redacted.includes('refused') || redacted.includes('econnreset') || redacted.includes('econnrefused')) {
        return 'connection-refused';
    }
    if (redacted.includes('classifier')) {
        return 'classifier-rejected';
    }
    if (redacted.includes('refresh')) {
        return 'refresh-failed';
    }
    return 'unknown';
}
