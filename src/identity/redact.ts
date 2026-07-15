import { createHash } from 'crypto';

const JWT_PATTERN = /[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}\.[A-Za-z0-9._-]{20,}/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gi;

export function redactSensitive(value: string): string {
    return value
        .replace(JWT_PATTERN, '[REDACTED JWT]')
        .replace(BEARER_PATTERN, 'Bearer [REDACTED]');
}

export function summarizeSensitive(value: string): string {
    const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
    return `length=${value.length} sha256=${hash}`;
}
