/**
 * Tests for the stateful SQL statement scanner.
 *
 * The scanner replaces the broken regex `/;(?=\s*(?:\r?\n|$))/` which fails on
 * semicolons inside string literals, comments, and same-line statements.
 *
 * All tests verify behavior the host AND the webview depend on.
 */

import * as assert from 'assert';
import {
    splitSqlStatements,
    selectFocusedStatement,
    escapeSqlIdentifier,
    type ScanResult,
} from '../../views/sqlStatements';

function unwrap(result: ScanResult): readonly string[] {
    assert.strictEqual(
        result.tag,
        'ok',
        `expected ok, got ${result.tag}: ${'message' in result ? result.message : ''}`
    );
    return result.statements;
}

suite('escapeSqlIdentifier', () => {
    test('doubles embedded backticks', () => {
        assert.strictEqual(escapeSqlIdentifier('weird`name'), 'weird``name');
    });

    test('preserves identifiers without backticks', () => {
        assert.strictEqual(escapeSqlIdentifier('normal_name'), 'normal_name');
    });
});

suite('splitSqlStatements', () => {
    test('splits two statements on separate lines', () => {
        const result = unwrap(splitSqlStatements('SELECT 1;\nSELECT 2;'));
        assert.deepStrictEqual([...result], ['SELECT 1', 'SELECT 2']);
    });

    test('splits same-line statements', () => {
        const result = unwrap(splitSqlStatements('SELECT 1; SELECT 2;'));
        assert.deepStrictEqual([...result], ['SELECT 1', 'SELECT 2']);
    });

    test('preserves semicolons inside single-quoted strings', () => {
        const result = unwrap(splitSqlStatements("SELECT 'a;b'; SELECT 1;"));
        assert.deepStrictEqual([...result], ["SELECT 'a;b'", 'SELECT 1']);
    });

    test('preserves semicolons inside double-quoted strings', () => {
        const result = unwrap(splitSqlStatements('SELECT "a;b"; SELECT 1;'));
        assert.deepStrictEqual([...result], ['SELECT "a;b"', 'SELECT 1']);
    });

    test('preserves semicolons inside backtick identifiers', () => {
        const result = unwrap(splitSqlStatements('SELECT `weird;name` FROM t; SELECT 1;'));
        assert.deepStrictEqual([...result], ['SELECT `weird;name` FROM t', 'SELECT 1']);
    });

    test('preserves semicolons inside line comments (-- )', () => {
        // The comment attaches to the following statement; the semicolon in the
        // comment must not split.
        const result = unwrap(splitSqlStatements('-- note;still a comment\nSELECT 1;\nSELECT 2;'));
        assert.deepStrictEqual([...result], ['-- note;still a comment\nSELECT 1', 'SELECT 2']);
    });

    test('preserves semicolons inside hash comments', () => {
        const result = unwrap(splitSqlStatements('# note;still a comment\nSELECT 1;'));
        assert.deepStrictEqual([...result], ['# note;still a comment\nSELECT 1']);
    });

    test('preserves semicolons inside block comments', () => {
        const result = unwrap(
            splitSqlStatements('/* this; that; other */ SELECT 1; SELECT 2;')
        );
        assert.deepStrictEqual([...result], ['/* this; that; other */ SELECT 1', 'SELECT 2']);
    });

    test('preserves doubled SQL quotes', () => {
        const result = unwrap(splitSqlStatements("SELECT 'it''s;fine'; SELECT 2;"));
        assert.deepStrictEqual([...result], ["SELECT 'it''s;fine'", 'SELECT 2']);
    });

    test('preserves backslash-escaped quotes inside single-quoted strings', () => {
        const result = unwrap(splitSqlStatements("SELECT 'a\\';b'; SELECT 1;"));
        assert.deepStrictEqual([...result], ["SELECT 'a\\';b'", 'SELECT 1']);
    });

    test('handles CRLF line endings', () => {
        const result = unwrap(splitSqlStatements('SELECT 1;\r\nSELECT 2;\r\n'));
        assert.deepStrictEqual([...result], ['SELECT 1', 'SELECT 2']);
    });

    test('preserves statement preceded by block comment', () => {
        const result = unwrap(splitSqlStatements('/* doc */ SELECT 1; SELECT 2;'));
        assert.deepStrictEqual([...result], ['/* doc */ SELECT 1', 'SELECT 2']);
    });

    test('returns unsupported for unterminated single quote', () => {
        const result = splitSqlStatements("SELECT 'unterminated");
        assert.strictEqual(result.tag, 'unsupported');
        if (result.tag === 'unsupported') {
            assert.ok(result.message.toLowerCase().includes('string'));
        }
    });

    test('returns unsupported for unterminated block comment', () => {
        const result = splitSqlStatements('SELECT 1; /* unterminated');
        assert.strictEqual(result.tag, 'unsupported');
        if (result.tag === 'unsupported') {
            assert.ok(result.message.toLowerCase().includes('comment'));
        }
    });

    test('returns unsupported for DELIMITER directive', () => {
        const result = splitSqlStatements('DELIMITER $$\nSELECT 1$$');
        assert.strictEqual(result.tag, 'unsupported');
        if (result.tag === 'unsupported') {
            assert.ok(result.message.toLowerCase().includes('delimiter'));
        }
    });

    test('trims outer whitespace only', () => {
        const result = unwrap(splitSqlStatements('   SELECT   1   ;\n  SELECT 2;  '));
        assert.deepStrictEqual([...result], ['SELECT   1', 'SELECT 2']);
    });

    test('excludes empty statements between consecutive semicolons', () => {
        const result = unwrap(splitSqlStatements('SELECT 1;;;\nSELECT 2;'));
        assert.deepStrictEqual([...result], ['SELECT 1', 'SELECT 2']);
    });

    test('preserves order', () => {
        const result = unwrap(splitSqlStatements('A;\nB;\nC;\n'));
        assert.deepStrictEqual([...result], ['A', 'B', 'C']);
    });

    test('does not normalize internal whitespace or comments', () => {
        const result = unwrap(splitSqlStatements('SELECT /* x */ 1 /* y */ FROM t; SELECT 2;'));
        assert.deepStrictEqual([...result], ['SELECT /* x */ 1 /* y */ FROM t', 'SELECT 2']);
    });

    test('handles empty input', () => {
        const result = unwrap(splitSqlStatements(''));
        assert.deepStrictEqual([...result], []);
    });

    test('handles whitespace-only input', () => {
        const result = unwrap(splitSqlStatements('   \n  \t\n'));
        assert.deepStrictEqual([...result], []);
    });

    test('handles trailing comment-only content', () => {
        // Trailing comment after final semicolon is dropped (including the
        // trailing semicolon since the comment claims everything after the
        // last non-comment content).
        const result = unwrap(splitSqlStatements('SELECT 1; -- trailing comment'));
        assert.deepStrictEqual([...result], ['SELECT 1']);
    });

    test('does not split on semicolon inside backslash-escaped quote', () => {
        const result = unwrap(splitSqlStatements("SELECT 'a\\'b;c'; SELECT 1;"));
        assert.deepStrictEqual([...result], ["SELECT 'a\\'b;c'", 'SELECT 1']);
    });
});

suite('selectFocusedStatement', () => {
    test('returns full text when cursor is at end with no trailing delimiter', () => {
        const sql = 'SELECT 1';
        const result = selectFocusedStatement(sql, sql.length);
        assert.strictEqual(result, 'SELECT 1');
    });

    test('returns the focused statement when cursor sits inside a multi-statement editor', () => {
        const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';
        // Cursor at end of "SELECT 2" (position of the semicolon after 2)
        const secondEnd = sql.indexOf(';', sql.indexOf('SELECT 2'));
        const result = selectFocusedStatement(sql, secondEnd);
        assert.strictEqual(result, 'SELECT 2');
    });

    test('returns full text when cursor sits in inter-statement whitespace', () => {
        // Cursor at position 9 (the first \n in \n\n) — clearly whitespace
        // between the two statements.
        const sql = 'SELECT 1;\n\nSELECT 2;';
        const cursor = sql.indexOf('\n'); // position 9 (the first \n)
        const result = selectFocusedStatement(sql, cursor);
        assert.strictEqual(result, sql.trim());
    });

    test('handles cursor at the very start', () => {
        const sql = 'SELECT 1;\nSELECT 2;';
        const result = selectFocusedStatement(sql, 0);
        assert.strictEqual(result, 'SELECT 1');
    });

    test('handles single statement with no semicolons', () => {
        const sql = 'SELECT * FROM t';
        const result = selectFocusedStatement(sql, 5);
        assert.strictEqual(result, 'SELECT * FROM t');
    });
});