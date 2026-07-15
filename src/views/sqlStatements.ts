/**
 * Pure SQL statement scanner.
 *
 * Replaces the broken regex `/;(?=\s*(?:\r?\n|$))/` which split on semicolons
 * inside string literals, comments, and same-line statements.
 *
 * The scanner is a single-pass state machine. It is the SOLE source of truth
 * for SQL splitting and focused-statement selection in the extension host.
 * The browser-side webview sends the full editor text and caret position.
 *
 * NOT in scope:
 *   - Full SQL grammar parsing (no statement classification).
 *   - MySQL DELIMITER directive support.
 *   - Stored-program body parsing (BEGIN...END with internal ;).
 *   - Tokenization or AST construction.
 *
 * States:
 *   - normal: outside any quoted/comment region
 *   - singleQuote: inside '...'
 *   - doubleQuote: inside "..."
 *   - backtick: inside backtick identifier
 *   - dashComment: inside dash-dash comment to EOL
 *   - hashComment: inside hash comment to EOL
 *   - blockComment: inside slash-star block comment
 *
 * Returns a discriminated ScanResult:
 *   - { tag: 'ok', statements } for well-formed input
 *   - { tag: 'unsupported', message } for unterminated strings/comments or
 *     MySQL DELIMITER directives that would change the split semantics.
 */

export type ScanResult =
    | { readonly tag: 'ok'; readonly statements: readonly string[] }
    | { readonly tag: 'unsupported'; readonly message: string };

const UNSUPPORTED_DELIMITER = 'MySQL DELIMITER directives are not supported by the workbench scanner.';
const UNSUPPORTED_UNTERMINATED_STRING = 'Unterminated string literal. Close the quote before running.';
const UNSUPPORTED_UNTERMINATED_COMMENT = 'Unterminated block comment. Close */ before running.';

export function escapeSqlIdentifier(value: string): string {
    return value.replace(/`/g, '``');
}

type State =
    | 'normal'
    | 'singleQuote'
    | 'doubleQuote'
    | 'backtick'
    | 'dashComment'
    | 'hashComment'
    | 'blockComment';

/**
 * Split a SQL script into individual statements. Empty/whitespace-only input
 * yields an empty array. Statements are returned in source order, with outer
 * whitespace trimmed and internal whitespace preserved.
 */
export function splitSqlStatements(input: string): ScanResult {
    const trimmed = input ?? '';
    if (trimmed.length === 0) {
        return { tag: 'ok', statements: [] };
    }

    const statements: string[] = [];
    let state: State = 'normal';
    let buffer = '';
    let i = 0;
    const n = trimmed.length;

    while (i < n) {
        const ch = trimmed[i]!;
        const next = i + 1 < n ? trimmed[i + 1] : '';

        switch (state) {
            case 'normal': {
                if (ch === "'") {
                    state = 'singleQuote';
                    buffer += ch;
                    i += 1;
                } else if (ch === '"') {
                    state = 'doubleQuote';
                    buffer += ch;
                    i += 1;
                } else if (ch === '`') {
                    state = 'backtick';
                    buffer += ch;
                    i += 1;
                } else if (ch === '-' && next === '-') {
                    state = 'dashComment';
                    buffer += ch;
                    i += 1;
                } else if (ch === '#') {
                    state = 'hashComment';
                    buffer += ch;
                    i += 1;
                } else if (ch === '/' && next === '*') {
                    state = 'blockComment';
                    buffer += ch;
                    i += 1;
                } else if (ch === ';') {
                    flushStatement(buffer, statements);
                    buffer = '';
                    i += 1;
                } else {
                    buffer += ch;
                    i += 1;
                }
                break;
            }

            case 'singleQuote': {
                if (ch === '\\' && next !== '') {
                    // Backslash escape: consume the next character literally.
                    buffer += ch + next;
                    i += 2;
                } else if (ch === "'" && next === "'") {
                    // Doubled single-quote escape (SQL standard): ''
                    buffer += "''";
                    i += 2;
                } else if (ch === "'") {
                    buffer += ch;
                    state = 'normal';
                    i += 1;
                } else {
                    buffer += ch;
                    i += 1;
                }
                break;
            }

            case 'doubleQuote': {
                if (ch === '\\' && next !== '') {
                    buffer += ch + next;
                    i += 2;
                } else if (ch === '"') {
                    buffer += ch;
                    state = 'normal';
                    i += 1;
                } else {
                    buffer += ch;
                    i += 1;
                }
                break;
            }

            case 'backtick': {
                if (ch === '`') {
                    buffer += ch;
                    state = 'normal';
                    i += 1;
                } else {
                    buffer += ch;
                    i += 1;
                }
                break;
            }

            case 'dashComment': {
                buffer += ch;
                if (ch === '\n' || i === n - 1) {
                    state = 'normal';
                }
                i += 1;
                break;
            }

            case 'hashComment': {
                buffer += ch;
                if (ch === '\n' || i === n - 1) {
                    state = 'normal';
                }
                i += 1;
                break;
            }

            case 'blockComment': {
                if (ch === '*' && next === '/') {
                    buffer += '*/';
                    state = 'normal';
                    i += 2;
                } else {
                    buffer += ch;
                    i += 1;
                }
                break;
            }
        }
    }

    // End-of-input handling.
    if (state === 'blockComment') {
        return { tag: 'unsupported', message: UNSUPPORTED_UNTERMINATED_COMMENT };
    }
    if (state === 'singleQuote' || state === 'doubleQuote' || state === 'backtick') {
        return { tag: 'unsupported', message: UNSUPPORTED_UNTERMINATED_STRING };
    }

    // Check for MySQL DELIMITER directive at the start of any non-empty,
    // trimmed statement. We do this AFTER the split so DELIMITER followed by
    // valid SQL still surfaces a clear message.
    for (const stmt of statements) {
        if (/^\s*DELIMITER\b/i.test(stmt)) {
            return { tag: 'unsupported', message: UNSUPPORTED_DELIMITER };
        }
    }
    // Also check the final trailing buffer (statement not terminated by ;).
    if (/^\s*DELIMITER\b/i.test(buffer)) {
        return { tag: 'unsupported', message: UNSUPPORTED_DELIMITER };
    }

    flushStatement(buffer, statements);
    return { tag: 'ok', statements };
}

function flushStatement(raw: string, out: string[]): void {
    const trimmed = stripTrailingComments(raw.trim());
    if (trimmed.length === 0) return;
    out.push(trimmed);
}

/**
 * Remove trailing line/block comments from a statement. Only strips comments
 * that appear AFTER the last non-comment content.
 */
function stripTrailingComments(stmt: string): string {
    let state: State = 'normal';
    let i = 0;
    const n = stmt.length;
    // Track the offset just AFTER the last non-comment content. Start at 0
    // (nothing seen yet) so a comment-only string returns ''.
    let lastNonCommentEnd = 0;

    while (i < n) {
        const ch = stmt[i]!;
        const next = i + 1 < n ? stmt[i + 1] : '';

        switch (state) {
            case 'normal':
                if (ch === "'") state = 'singleQuote';
                else if (ch === '"') state = 'doubleQuote';
                else if (ch === '`') state = 'backtick';
                else if (ch === '-' && next === '-') state = 'dashComment';
                else if (ch === '#') state = 'hashComment';
                else if (ch === '/' && next === '*') state = 'blockComment';
                else lastNonCommentEnd = i + 1;
                i += 1;
                break;
            case 'singleQuote':
                if (ch === '\\' && next !== '') i += 2;
                else if (ch === "'" && next === "'") { lastNonCommentEnd = i + 2; i += 2; }
                else if (ch === "'") { state = 'normal'; lastNonCommentEnd = i + 1; i += 1; }
                else i += 1;
                break;
            case 'doubleQuote':
                if (ch === '\\' && next !== '') i += 2;
                else if (ch === '"') { state = 'normal'; lastNonCommentEnd = i + 1; i += 1; }
                else i += 1;
                break;
            case 'backtick':
                if (ch === '`') { state = 'normal'; lastNonCommentEnd = i + 1; i += 1; }
                else i += 1;
                break;
            case 'dashComment':
            case 'hashComment':
                if (ch === '\n') { state = 'normal'; lastNonCommentEnd = i + 1; }
                i += 1;
                break;
            case 'blockComment':
                if (ch === '*' && next === '/') { state = 'normal'; i += 2; }
                else i += 1;
                break;
        }
    }

    return stmt.slice(0, lastNonCommentEnd).trimEnd();
}

/**
 * Pick the statement containing the given caret offset in the editor source.
 *
 * Used by the webview to implement "execute the focused statement" without
 * matching SQL text. Returns the full editor text when:
 *   - There is no statement boundary before the caret.
 *   - The caret sits in inter-statement whitespace.
 *
 * Returns the trimmed focused statement otherwise.
 */
export function selectFocusedStatement(source: string, caret: number): string {
    const text = source ?? '';
    const safeCaret = Math.max(0, Math.min(caret, text.length));

    // Walk through the original text by locating each `;` outside quotes/comments
    // so we can map caret positions to statement slices.
    const boundaries = findStatementBoundaries(text);

    if (boundaries.length === 0) {
        return text.trim();
    }

    // If the caret sits BEFORE the first statement boundary, return the first
    // statement (cursor is in leading whitespace).
    const first = boundaries[0]!;
    if (safeCaret <= first.endOffset) {
        return text.slice(first.startOffset, first.endOffset).trim();
    }

    // If the caret is strictly BETWEEN two boundaries (in inter-statement
    // whitespace), return the full text so the user can run-all by pressing
    // Run while the cursor is in the gap.
    for (let i = 1; i < boundaries.length; i += 1) {
        const prev = boundaries[i - 1]!;
        const cur = boundaries[i]!;
        if (safeCaret > prev.endOffset && safeCaret < cur.startOffset) {
            return text.trim();
        }
        if (safeCaret >= cur.startOffset && safeCaret <= cur.endOffset) {
            return text.slice(cur.startOffset, cur.endOffset).trim();
        }
    }

    // Caret is past the last boundary — return the trailing statement.
    const last = boundaries[boundaries.length - 1]!;
    return text.slice(last.startOffset).trim();
}

interface Boundary {
    readonly startOffset: number;
    readonly endOffset: number;
}

function findStatementBoundaries(source: string): readonly Boundary[] {
    const boundaries: Boundary[] = [];
    let state: State = 'normal';
    let i = 0;
    const n = source.length;
    let lastStart = 0;

    while (i < n) {
        const ch = source[i]!;
        const next = i + 1 < n ? source[i + 1] : '';

        switch (state) {
            case 'normal':
                if (ch === "'") { state = 'singleQuote'; i += 1; }
                else if (ch === '"') { state = 'doubleQuote'; i += 1; }
                else if (ch === '`') { state = 'backtick'; i += 1; }
                else if (ch === '-' && next === '-') { state = 'dashComment'; i += 2; }
                else if (ch === '#') { state = 'hashComment'; i += 1; }
                else if (ch === '/' && next === '*') { state = 'blockComment'; i += 2; }
                else if (ch === ';') {
                    const end = i; // exclusive of the semicolon
                    boundaries.push({ startOffset: lastStart, endOffset: end });
                    // Skip leading whitespace after the semicolon so the next
                    // boundary starts at the first non-whitespace character.
                    let next = i + 1;
                    while (next < n && (source[next] === ' ' || source[next] === '\t' || source[next] === '\n' || source[next] === '\r')) {
                        next += 1;
                    }
                    lastStart = next;
                    i = next;
                } else {
                    i += 1;
                }
                break;
            case 'singleQuote':
                if (ch === '\\' && next !== '') i += 2;
                else if (ch === "'" && next === "'") i += 2;
                else if (ch === "'") { state = 'normal'; i += 1; }
                else i += 1;
                break;
            case 'doubleQuote':
                if (ch === '\\' && next !== '') i += 2;
                else if (ch === '"') { state = 'normal'; i += 1; }
                else i += 1;
                break;
            case 'backtick':
                if (ch === '`') { state = 'normal'; i += 1; }
                else i += 1;
                break;
            case 'dashComment':
            case 'hashComment':
                if (ch === '\n') state = 'normal';
                i += 1;
                break;
            case 'blockComment':
                if (ch === '*' && next === '/') { state = 'normal'; i += 2; }
                else i += 1;
                break;
        }
    }

    if (lastStart < n) {
        boundaries.push({ startOffset: lastStart, endOffset: n });
    }

    return boundaries;
}