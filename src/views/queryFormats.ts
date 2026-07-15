/**
 * Pure export formatters for query results.
 *
 * These functions are the sole source of truth for CSV and Markdown export
 * formatting. Both the host controller and any future webview-driven export
 * path consume them. They were extracted from src/views/queryWorkbench.ts
 * where they were previously private functions.
 *
 * Contract:
 *   - Stable column order from QueryResult.columns.
 *   - No mutation of input rows or cells.
 *   - Empty result with non-empty columns still emits the header.
 *   - Output ends without a trailing newline.
 */

import type { QueryResult } from '../domain';

/** Render a QueryResult as RFC-4180 CSV. */
export function toCsv(result: QueryResult): string {
    const quote = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [
        result.columns.map(quote).join(','),
        ...result.rows.map((row) => result.columns.map((column) => quote(row[column])).join(',')),
    ].join('\n');
}

/** Render a QueryResult as a GitHub-flavored Markdown table. */
export function toMarkdown(result: QueryResult): string {
    const cell = (value: unknown): string => {
        if (value === null || value === undefined) return '';
        const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
        return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
    };
    return [
        `| ${result.columns.map(cell).join(' | ')} |`,
        `| ${result.columns.map(() => '---').join(' | ')} |`,
        ...result.rows.map((row) => `| ${result.columns.map((column) => cell(row[column])).join(' | ')} |`),
    ].join('\n');
}