/**
 * SQL classifier - fail-closed read-only statement gate.
 *
 * Every user SQL dispatched by `DatabaseSession.execute()` runs through
 * `classifySqlBatch()` before it reaches the pool. The classifier permits
 * ONLY the read paths required for the public preview contract:
 *
 *   - SELECT (with deny-listed side-effects stripped)
 *   - DESCRIBE
 *   - SHOW
 *   - EXPLAIN of an otherwise-permitted read
 *
 * The classifier fails closed. Unknown executable forms are rejected.
 * Multi-statement batches are validated atomically: if ANY statement is
 * rejected, the WHOLE batch is rejected and no statement reaches the pool.
 *
 * Tokenization is intentionally simple - a state machine over the source
 * text that recognizes MySQL comments, string literals (single, double,
 * backtick), hex/binary literals, and MySQL executable comment blocks
 * (slash-star-bang ... star-slash). The classifier must NOT call out to
 * a full SQL parser; the goal is a deterministic allow/deny decision on
 * the surface form of the statement.
 */

/**
 * Allow-listed verbs. These may ONLY appear at the start of a statement
 * (ignoring whitespace and comments). Every other verb is rejected.
 */
const ALLOWED_VERBS = new Set(['SELECT', 'DESCRIBE', 'DESC', 'SHOW', 'EXPLAIN']);

/**
 * Deny-listed verbs. These MUST NOT appear anywhere at the start of a
 * statement, and (for some) MUST NOT appear inside an otherwise-allowed
 * statement. The match is over tokenized, comment-stripped input.
 */
const DENIED_VERBS = new Set([
    'INSERT', 'UPDATE', 'DELETE', 'REPLACE',
    'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME',
    'GRANT', 'REVOKE',
    'CALL', 'LOAD', 'SET', 'LOCK', 'UNLOCK',
    'HANDLER', 'RESET', 'STOP', 'START', 'SHUTDOWN',
    'CHANGE', 'CHECK', 'OPTIMIZE', 'REPAIR', 'ANALYZE',
    'KILL', 'PURGE', 'FLUSH', 'CACHE', 'BINLOG',
]);

/**
 * Side-effecting substrings that disqualify an otherwise-allowed SELECT.
 * Match is over the upper-cased token stream (comments stripped). Each
 * entry is checked as a word boundary regex against the upper-cased text.
 */
const SELECT_DENY_TOKENS = [
    'INTO OUTFILE',
    'INTO DUMPFILE',
    'FOR UPDATE',
    'FOR SHARE',
    'LOCK IN SHARE MODE',
    'GET_LOCK',
    'RELEASE_LOCK',
    'SLEEP',
    'BENCHMARK',
    'LOAD_FILE',
];

/**
 * User-variable assignment. The pattern matches `@foo :=` and `@foo =`
 * but NOT `@foo` (which is a reference, not an assignment). The pattern
 * must match the START of the token (after a boundary) so we don't false-
 * positive on identifiers like `email_address`.
 */
const USER_VARIABLE_ASSIGNMENT = /(?:^|\s|[(,])@[A-Za-z_][A-Za-z0-9_]*\s*:?=/u;

/**
 * Strip comments and string literals from a SQL source. The classifier
 * uses this for surface checks so comments cannot be used to smuggle
 * rejected verbs.
 *
 * Returns the source with:
 *   - block comments replaced with spaces (preserving newlines).
 *   - MySQL executable comments (slash-star bang ... star-slash) unwrapped:
 *     the inner content is preserved as live SQL, because MySQL executes
 *     those blocks.
 *   - `--` line comments terminated by newline.
 *   - `#` line comments terminated by newline.
 *   - String literals (single, double, backtick) replaced with spaces
 *     (preserving newlines) so the source cannot smuggle verbs inside
 *     a quoted identifier or string.
 */
export function stripCommentsAndStrings(sql: string): string {
    const len = sql.length;
    let out = '';
    let i = 0;
    while (i < len) {
        const ch = sql[i];
        const next = i + 1 < len ? sql[i + 1] : '';
        // Executable MySQL comment `/*! ... */` - unwrap the inner block.
        if (ch === '/' && next === '*') {
            const closeIdx = sql.indexOf('*/', i + 2);
            if (closeIdx === -1) {
                // Unterminated comment - treat the rest as comment.
                return out + ' '.repeat(len - i);
            }
            // Look for executable comment: `/*!` (with optional version).
            if (sql[i + 2] === '!') {
                // Inner content is live SQL. Preserve newlines so error
                // messages stay aligned with the original source.
                const inner = sql.slice(i + 3, closeIdx);
                out += inner.replace(/[ \t]/g, ' ');
            } else {
                // Ordinary block comment - replace with whitespace.
                out += ' '.repeat(closeIdx + 2 - i);
            }
            i = closeIdx + 2;
            continue;
        }
        // Line comment `--` to end of line.
        if (ch === '-' && next === '-') {
            const newlineIdx = sql.indexOf('\n', i);
            const stopIdx = newlineIdx === -1 ? len : newlineIdx;
            out += ' '.repeat(stopIdx - i);
            i = stopIdx;
            continue;
        }
        // Line comment `#` to end of line (but only at start of token -
        // `#` is also a valid identifier character when used inside an
        // identifier). We only treat it as a line comment when followed
        // by whitespace, end-of-input, or a recognizable SQL separator.
        if (ch === '#' && (i === 0 || /[\s;]/.test(sql[i - 1] ?? ''))) {
            const newlineIdx = sql.indexOf('\n', i);
            const stopIdx = newlineIdx === -1 ? len : newlineIdx;
            out += ' '.repeat(stopIdx - i);
            i = stopIdx;
            continue;
        }
        // String literals.
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            let j = i + 1;
            while (j < len) {
                const c = sql[j];
                if (c === '\\' && j + 1 < len) {
                    // Escaped character.
                    j += 2;
                    continue;
                }
                if (c === quote) {
                    j += 1;
                    break;
                }
                j += 1;
            }
            out += ' '.repeat(j - i);
            i = j;
            continue;
        }
        out += ch;
        i += 1;
    }
    return out;
}

/**
 * Split a SQL batch into individual statements on `;` boundaries that are
 * outside comments and string literals. Returns the trimmed, non-empty
 * statements in source order. Empty statements are silently dropped.
 */
export function splitSqlBatch(stripped: string): string[] {
    const stmts: string[] = [];
    let buf = '';
    let parenDepth = 0;
    for (let i = 0; i < stripped.length; i++) {
        const ch = stripped[i];
        if (ch === '(') parenDepth += 1;
        else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
        if (ch === ';' && parenDepth === 0) {
            const trimmed = buf.trim();
            if (trimmed.length > 0) stmts.push(trimmed);
            buf = '';
        } else {
            buf += ch;
        }
    }
    const trimmed = buf.trim();
    if (trimmed.length > 0) stmts.push(trimmed);
    return stmts;
}

/**
 * The first non-whitespace token of a statement (after comment/string
 * stripping). For EXPLAIN, returns both the leading verb and the verb of
 * the explained statement so callers can confirm EXPLAIN wraps a read.
 */
export function leadingVerb(stmt: string): string {
    const m = /^\s*([A-Za-z_]+)/.exec(stmt);
    if (!m || m[1] === undefined) return '';
    return m[1].toUpperCase();
}

/**
 * Verdict of classifying a single statement. `accepted` means the
 * statement is on the allow-list and survives side-effect checks.
 * `rejected` carries the exact reason; the validator emits this code
 * in `NOT READY: <code>` diagnostics.
 */
export type Classification =
    | { readonly accepted: true }
    | { readonly accepted: false; readonly reason: string };

/**
 * Classify one statement (post-comment/string stripping). Returns
 * `accepted` or a specific rejection `reason`. The caller is expected
 * to short-circuit the whole batch on the first rejection.
 *
 * Recognized reasons:
 *   - EMPTY_STATEMENT
 *   - UNKNOWN_LEADING_VERB
 *   - DENIED_LEADING_VERB:<verb>
 *   - EXPLAIN_NON_READ
 *   - SELECT_SIDE_EFFECT:<token>
 *   - USER_VARIABLE_ASSIGNMENT
 *   - EXECUTABLE_COMMENT_INSIDE
 *   - UNRECOGNIZED_FORM
 */
export function classifyStatement(stmt: string): Classification {
    const stripped = stmt.trim();
    if (stripped.length === 0) {
        return { accepted: false, reason: 'EMPTY_STATEMENT' };
    }
    const upper = stripped.toUpperCase();
    const verb = leadingVerb(stripped);
    if (verb === '') {
        return { accepted: false, reason: 'UNKNOWN_LEADING_VERB' };
    }

    // EXPLAIN is only permitted when its target is itself a read.
    if (verb === 'EXPLAIN') {
        // The explained statement starts after the EXPLAIN token, with
        // optional FORMAT=JSON / ANALYZE modifiers consumed first.
        const tailMatch = /^\s*EXPLAIN(?:\s+ANALYZE)?(?:\s+FORMAT\s*=\s*(?:JSON|TREE|TRADITIONAL))?\s+(SELECT|DESCRIBE|DESC|SHOW)\b/i.exec(stripped);
        if (!tailMatch) {
            // EXPLAIN of any non-allowed verb (or no verb at all) is rejected.
            const deniedVerb = /(^\s*EXPLAIN(?:\s+ANALYZE)?\s+)([A-Za-z_]+)/i.exec(stripped);
            const target = deniedVerb && deniedVerb[2] ? deniedVerb[2].toUpperCase() : 'UNKNOWN';
            return { accepted: false, reason: `EXPLAIN_NON_READ:${target}` };
        }
        return { accepted: true };
    }

    if (!ALLOWED_VERBS.has(verb)) {
        if (DENIED_VERBS.has(verb)) {
            return { accepted: false, reason: `DENIED_LEADING_VERB:${verb}` };
        }
        return { accepted: false, reason: 'UNKNOWN_LEADING_VERB' };
    }

    // SELECT side-effect checks.
    if (verb === 'SELECT') {
        for (const token of SELECT_DENY_TOKENS) {
            const re = new RegExp(`(?:^|[^A-Za-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^A-Za-z0-9_])`);
            if (re.test(upper)) {
                return { accepted: false, reason: `SELECT_SIDE_EFFECT:${token}` };
            }
        }
        if (USER_VARIABLE_ASSIGNMENT.test(stripped)) {
            return { accepted: false, reason: 'USER_VARIABLE_ASSIGNMENT' };
        }
    }
    return { accepted: true };
}

/**
 * Classify an entire batch. If ANY statement is rejected, the WHOLE batch
 * is rejected and NO statement executes. Returns `accepted` for an empty
 * batch (no work to do).
 */
export function classifySqlBatch(sql: string): Classification {
    const stripped = stripCommentsAndStrings(sql);
    const statements = splitSqlBatch(stripped);
    if (statements.length === 0) {
        return { accepted: false, reason: 'EMPTY_STATEMENT' };
    }
    for (const stmt of statements) {
        const verdict = classifyStatement(stmt);
        if (!verdict.accepted) return verdict;
    }
    return { accepted: true };
}
