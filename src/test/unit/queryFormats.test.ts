/**
 * Tests for the export formatters (CSV / Markdown).
 *
 * The previous in-file implementations lived at the bottom of
 * src/views/queryWorkbench.ts and were not exported. We extract them here so
 * the contract is locked by unit tests rather than visual inspection.
 */

import * as assert from 'assert';
import type { QueryResult } from '../../domain';
import { toCsv, toMarkdown } from '../../views/queryFormats';

function result(columns: string[], rows: Record<string, unknown>[]): QueryResult {
    return { columns, rows, rowCount: rows.length, executionTime: 0 };
}

suite('toCsv', () => {
    test('emits header in column order', () => {
        const out = toCsv(result(['id', 'name'], [{ id: 1, name: 'a' }]));
        const lines = out.split('\n');
        assert.strictEqual(lines[0], 'id,name');
    });

    test('emits rows in column order', () => {
        const out = toCsv(result(['id', 'name'], [{ id: 1, name: 'a' }, { id: 2, name: 'b' }]));
        const lines = out.split('\n');
        assert.strictEqual(lines[1], '1,a');
        assert.strictEqual(lines[2], '2,b');
    });

    test('quotes fields containing commas', () => {
        const out = toCsv(result(['x'], [{ x: 'has,comma' }]));
        assert.ok(out.includes('"has,comma"'));
    });

    test('quotes fields containing double quotes and doubles internal quotes', () => {
        const out = toCsv(result(['x'], [{ x: 'say "hi"' }]));
        assert.ok(out.includes('"say ""hi"""'));
    });

    test('quotes fields containing CR or LF', () => {
        const out = toCsv(result(['x'], [{ x: 'a\r\nb' }]));
        assert.ok(out.includes('"a\r\nb"'));
    });

    test('null and undefined become empty fields', () => {
        const out = toCsv(result(['a', 'b'], [{ a: null, b: undefined }]));
        const lines = out.split('\n');
        assert.strictEqual(lines[1], ',');
    });

    test('object values are JSON-stringified', () => {
        const out = toCsv(result(['j'], [{ j: { k: 'v' } }]));
        // JSON output contains quotes/colons, so it's CSV-quoted with internal
        // quotes doubled per RFC-4180.
        assert.ok(out.includes('"{""k"":""v""}"'));
    });

    test('empty rows still produces header when columns exist', () => {
        const out = toCsv(result(['a', 'b'], []));
        assert.strictEqual(out, 'a,b');
    });

    test('unicode remains UTF-8 text', () => {
        const out = toCsv(result(['x'], [{ x: '日本語' }]));
        assert.ok(out.includes('日本語'));
    });

    test('no unexpected trailing newline', () => {
        const out = toCsv(result(['x'], [{ x: 1 }]));
        assert.strictEqual(out.endsWith('\n'), false);
    });
});

suite('toMarkdown', () => {
    test('emits header row', () => {
        const out = toMarkdown(result(['id', 'name'], [{ id: 1, name: 'a' }]));
        const lines = out.split('\n');
        assert.strictEqual(lines[0], '| id | name |');
    });

    test('emits separator row', () => {
        const out = toMarkdown(result(['a', 'b'], [{ a: 1, b: 2 }]));
        const lines = out.split('\n');
        assert.strictEqual(lines[1], '| --- | --- |');
    });

    test('emits body rows in column order', () => {
        const out = toMarkdown(result(['a', 'b'], [{ a: 1, b: 2 }]));
        const lines = out.split('\n');
        assert.strictEqual(lines[2], '| 1 | 2 |');
    });

    test('escapes pipe characters in cell content', () => {
        const out = toMarkdown(result(['x'], [{ x: 'a|b' }]));
        assert.ok(out.includes('a\\|b'));
    });

    test('renders CRLF/LF as <br>', () => {
        const out = toMarkdown(result(['x'], [{ x: 'a\nb' }]));
        assert.ok(out.includes('a<br>b'));
    });

    test('null and undefined produce empty cells', () => {
        const out = toMarkdown(result(['a', 'b'], [{ a: null, b: undefined }]));
        const lines = out.split('\n');
        assert.strictEqual(lines[2], '|  |  |');
    });

    test('object values are JSON-stringified', () => {
        const out = toMarkdown(result(['j'], [{ j: { k: 'v' } }]));
        const lines = out.split('\n');
        assert.strictEqual(lines[2], '| {"k":"v"} |');
    });

    test('empty rows still produce header and separator', () => {
        const out = toMarkdown(result(['a', 'b'], []));
        const lines = out.split('\n');
        assert.strictEqual(lines[0], '| a | b |');
        assert.strictEqual(lines[1], '| --- | --- |');
        assert.strictEqual(lines.length, 2);
    });

    test('unicode remains unchanged', () => {
        const out = toMarkdown(result(['x'], [{ x: '日本語' }]));
        assert.ok(out.includes('日本語'));
    });
});