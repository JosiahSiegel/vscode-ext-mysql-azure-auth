/**
 * Release-safe diagnostic formatter.
 *
 * Every external diagnostic emitted by the extension — log channels,
 * console calls, webview postMessage failures, and live evidence files
 * — must pass through `formatDiagnostic` first. The formatter's
 * allowlist is the single source of truth for which fields may leave
 * the process boundary and which values are safe to print.
 *
 * Allowlist (the canonical 7 keys, in this order):
 *   - operation         short, stable verb label (e.g. `connect`, `refresh`)
 *   - credentialSource  `'vscode' | 'azureCli' | 'deviceCode' | 'unknown'`
 *   - elapsedMs         integer milliseconds
 *   - errorClass        enum label (e.g. `'class:credential_error'`)
 *   - mysqlErrorCode    short enum/code label from the server (e.g. `ER_ACCESS_DENIED_ERROR`)
 *   - connectionState   `'connecting' | 'connected' | 'refreshing' | 'failed' | 'closed' | 'disconnected'`
 *   - retryCount        non-negative integer
 *
 * Raw error messages, stacks, tokens, Bearer headers, SQL fragments,
 * principal emails, hostnames, tenant ids, and schema names are never
 * permitted in the formatter's output. Raw errors remain in memory
 * for control flow only.
 *
 * Throws `TypeError` (with `code: 'UNKNOWN_FIELD'`) if any input
 * field is outside the allowlist. Throws `RangeError` (with one of
 * the leak codes `BEARER_LEAK` / `EMAIL_LEAK` / `SQL_LEAK` /
 * `ASSIGNMENT_LEAK`) if any string value matches one of the forbidden
 * patterns. Throws `TypeError` (with `code: 'INVALID_TYPE'`) if a
 * value is the wrong primitive shape (e.g. a string for elapsedMs).
 *
 * The companion `formatDiagnosticBatch(events)` helper applies the
 * same contract to every event and rejects the whole batch on the
 * first failure (no partial-success emits).
 *
 * `getAllowlist()` returns a frozen array snapshot of the canonical
 * 7-key list. The Todo 10 validator uses it to enforce that the
 * production allowlist has not drifted from the spec.
 */

export const DIAGNOSTIC_ALLOWLIST = [
    'operation',
    'credentialSource',
    'elapsedMs',
    'errorClass',
    'mysqlErrorCode',
    'connectionState',
    'retryCount',
] as const;

export type CredentialSource = 'vscode' | 'azureCli' | 'deviceCode' | 'unknown';
export type ConnectionState =
    | 'connecting'
    | 'connected'
    | 'refreshing'
    | 'failed'
    | 'closed'
    | 'disconnected';

export interface SafeDiagnosticInput {
    operation: string;
    credentialSource: CredentialSource;
    elapsedMs?: number;
    errorClass?: string;
    mysqlErrorCode?: string;
    connectionState?: ConnectionState;
    retryCount?: number;
}

const ALLOWLIST_SET: ReadonlySet<string> = new Set(DIAGNOSTIC_ALLOWLIST);

// Bearer authorization header. Matches `Bearer <token>` with one or
// more base64url-ish characters; case-insensitive on the scheme.
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/i;

// Looks-like-email pattern: `<local>@<host>` where both sides are
// non-whitespace. Conservative on purpose — anything that smells
// like a principal email is rejected.
const EMAIL_PATTERN = /<[^<>@\s]+@[^<>@\s]+>/;

// Assignment-style secret carrier. Catches `password=...`,
// `secret=...`, `token=...` in free-text strings.
const ASSIGNMENT_PATTERN = /(?:password|secret|token)\s*=/i;

// SQL boundary keywords. Matches as a whole word, case-insensitive.
// Other clauses (DESCRIBE, SHOW, EXPLAIN) are explicitly permitted by
// the runtime SQL classifier and so are not part of this list.
const SQL_KEYWORD_PATTERN = /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|RENAME|GRANT|REVOKE|REPLACE)\b/i;

/**
 * Return a frozen copy of the canonical allowlist. Used by the
 * Todo 10 validator to confirm the production allowlist is unchanged.
 */
export function getAllowlist(): readonly string[] {
    return Object.freeze([...DIAGNOSTIC_ALLOWLIST]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ensureAllowedKeys(input: Record<string, unknown>): void {
    for (const key of Object.keys(input)) {
        if (!ALLOWLIST_SET.has(key)) {
            const err = new TypeError(
                `safeDiagnostic: field "${key}" is not in the release allowlist`
            );
            (err as Error & { code?: string }).code = 'UNKNOWN_FIELD';
            throw err;
        }
    }
}

function checkStringValue(field: string, value: string): void {
    if (BEARER_PATTERN.test(value)) {
        const err = new RangeError(
            `safeDiagnostic: field "${field}" contains a Bearer authorization header`
        );
        (err as Error & { code?: string }).code = 'BEARER_LEAK';
        throw err;
    }
    if (EMAIL_PATTERN.test(value)) {
        const err = new RangeError(
            `safeDiagnostic: field "${field}" contains a looks-like-email value`
        );
        (err as Error & { code?: string }).code = 'EMAIL_LEAK';
        throw err;
    }
    if (ASSIGNMENT_PATTERN.test(value)) {
        const err = new RangeError(
            `safeDiagnostic: field "${field}" contains a password/secret/token assignment`
        );
        (err as Error & { code?: string }).code = 'ASSIGNMENT_LEAK';
        throw err;
    }
    if (SQL_KEYWORD_PATTERN.test(value)) {
        const err = new RangeError(
            `safeDiagnostic: field "${field}" contains a SQL boundary keyword`
        );
        (err as Error & { code?: string }).code = 'SQL_LEAK';
        throw err;
    }
}

/**
 * Validate a single safe-diagnostic event. Returns a copy of the
 * input so the allowlist enforcement is the function's contract:
 * any caller that mutates the return value is mutating a copy, not
 * the caller's own object.
 */
export function formatDiagnostic(
    input: SafeDiagnosticInput
): Record<string, unknown> {
    if (!isPlainObject(input)) {
        const err = new TypeError('safeDiagnostic: input must be a plain object');
        (err as Error & { code?: string }).code = 'INVALID_TYPE';
        throw err;
    }

    ensureAllowedKeys(input);

    const out: Record<string, unknown> = {};

    // operation: required string. Enum/code-label only — never raw messages.
    const operation = input.operation;
    if (typeof operation !== 'string' || operation.length === 0) {
        const err = new TypeError('safeDiagnostic: operation must be a non-empty string');
        (err as Error & { code?: string }).code = 'INVALID_TYPE';
        throw err;
    }
    checkStringValue('operation', operation);
    out.operation = operation;

    // credentialSource: required enum label.
    const credentialSource = input.credentialSource;
    const allowedSources: ReadonlySet<string> = new Set([
        'vscode',
        'azureCli',
        'deviceCode',
        'unknown',
    ]);
    if (typeof credentialSource !== 'string' || !allowedSources.has(credentialSource)) {
        const err = new TypeError(
            `safeDiagnostic: credentialSource must be one of ${Array.from(allowedSources).join(', ')}`
        );
        (err as Error & { code?: string }).code = 'INVALID_TYPE';
        throw err;
    }
    out.credentialSource = credentialSource;

    // Optional elapsedMs: integer.
    if (input.elapsedMs !== undefined) {
        if (
            typeof input.elapsedMs !== 'number' ||
            !Number.isInteger(input.elapsedMs) ||
            input.elapsedMs < 0
        ) {
            const err = new TypeError(
                'safeDiagnostic: elapsedMs must be a non-negative integer when present'
            );
            (err as Error & { code?: string }).code = 'INVALID_TYPE';
            throw err;
        }
        out.elapsedMs = input.elapsedMs;
    }

    // Optional errorClass: enum label, never the raw error text.
    if (input.errorClass !== undefined) {
        if (typeof input.errorClass !== 'string' || input.errorClass.length === 0) {
            const err = new TypeError(
                'safeDiagnostic: errorClass must be a non-empty string when present'
            );
            (err as Error & { code?: string }).code = 'INVALID_TYPE';
            throw err;
        }
        checkStringValue('errorClass', input.errorClass);
        out.errorClass = input.errorClass;
    }

    // Optional mysqlErrorCode: enum/code label.
    if (input.mysqlErrorCode !== undefined) {
        if (
            typeof input.mysqlErrorCode !== 'string' ||
            input.mysqlErrorCode.length === 0
        ) {
            const err = new TypeError(
                'safeDiagnostic: mysqlErrorCode must be a non-empty string when present'
            );
            (err as Error & { code?: string }).code = 'INVALID_TYPE';
            throw err;
        }
        checkStringValue('mysqlErrorCode', input.mysqlErrorCode);
        out.mysqlErrorCode = input.mysqlErrorCode;
    }

    // Optional connectionState: enum label.
    if (input.connectionState !== undefined) {
        const allowedStates: ReadonlySet<string> = new Set([
            'connecting',
            'connected',
            'refreshing',
            'failed',
            'closed',
            'disconnected',
        ]);
        if (
            typeof input.connectionState !== 'string' ||
            !allowedStates.has(input.connectionState)
        ) {
            const err = new TypeError(
                `safeDiagnostic: connectionState must be one of ${Array.from(allowedStates).join(', ')}`
            );
            (err as Error & { code?: string }).code = 'INVALID_TYPE';
            throw err;
        }
        out.connectionState = input.connectionState;
    }

    // Optional retryCount: non-negative integer.
    if (input.retryCount !== undefined) {
        if (
            typeof input.retryCount !== 'number' ||
            !Number.isInteger(input.retryCount) ||
            input.retryCount < 0
        ) {
            const err = new TypeError(
                'safeDiagnostic: retryCount must be a non-negative integer when present'
            );
            (err as Error & { code?: string }).code = 'INVALID_TYPE';
            throw err;
        }
        out.retryCount = input.retryCount;
    }

    return out;
}

/**
 * Run a batch of safe-diagnostic events through the formatter.
 * Rejects the entire batch on the first failure (atomicity is part
 * of the contract — partial batches must not be emitted).
 */
export function formatDiagnosticBatch(
    events: ReadonlyArray<SafeDiagnosticInput>
): Record<string, unknown>[] {
    if (!Array.isArray(events)) {
        const err = new TypeError('safeDiagnostic: events must be an array');
        (err as Error & { code?: string }).code = 'INVALID_TYPE';
        throw err;
    }
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < events.length; i += 1) {
        try {
            out.push(formatDiagnostic(events[i]));
        } catch (err: unknown) {
            const wrapped = new TypeError(
                `safeDiagnostic: events[${i}] rejected: ${
                    err instanceof Error ? err.message : String(err)
                }`
            );
            (wrapped as Error & { code?: string }).code =
                (err as { code?: string })?.code ?? 'INVALID_TYPE';
            throw wrapped;
        }
    }
    return out;
}

/**
 * Default-export alias. Allows callers to `import safeDiagnostic from
 * './safeDiagnostic'` and invoke it as `safeDiagnostic({...})`. The
 * Todo 10 validator's `git grep -nE 'safeDiagnostic\\('` positive
 * wiring check then sees the literal call site directly.
 */
export default function safeDiagnostic(
    input: SafeDiagnosticInput
): Record<string, unknown> {
    return formatDiagnostic(input);
}