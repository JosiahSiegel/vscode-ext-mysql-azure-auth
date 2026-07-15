import * as vscode from 'vscode';
import { z } from 'zod';
import type { QueryResult } from '../domain';
import { ActorRegistry } from '../registry/actorRegistry';
import {
    GlobalStateConnectionCatalog,
    queryHistoryKey,
} from '../registry/connectionCatalog';
import { CatalogReader } from '../schema/catalogReader';
import { toCsv, toMarkdown } from './queryFormats';
import { buildQueryWorkbenchHtml, createNonce, escapeHtml } from './queryWorkbenchHtml';
import { selectFocusedStatement, splitSqlStatements } from './sqlStatements';

const exportFormatSchema = z.enum(['csv', 'json', 'md']);

/**
 * Detect the server's read-only-transaction rejection message.
 *
 * mysql2 surfaces server errors as `[ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION] ...`,
 * but defensive matching also covers variants where the prefix is missing or
 * the message text varies across MySQL versions.
 *
 * Exported so the workbench's friendly write-block hint can be unit-tested
 * without spinning up a full panel.
 */
export function isReadOnlyError(message: string): boolean {
    return /ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION/i.test(message)
        || /read[- ]only transaction/i.test(message);
}
const webviewRequestSchema = z.discriminatedUnion('command', [
    z.object({ command: z.literal('executeQuery'), sql: z.string().min(1) }),
    z.object({
        command: z.literal('runFocusedQuery'),
        sql: z.string().min(1),
        caret: z.number().int().nonnegative(),
    }),
    z.object({ command: z.literal('exportCsv') }),
    z.object({ command: z.literal('export'), format: exportFormatSchema }),
    z.object({ command: z.literal('loadHistory'), offset: z.number().int().nonnegative() }),
    z.object({ command: z.literal('showCellDetail'), statementIndex: z.number().int().nonnegative(), rowIndex: z.number().int().nonnegative(), column: z.string() }),
    z.object({
        command: z.literal('runExplain'),
        sql: z.string().min(1),
        caret: z.number().int().nonnegative(),
    }),
    z.object({ command: z.literal('loadMore'), statementIndex: z.number().int().nonnegative() }),
    z.object({ command: z.literal('loadCompletions'), sql: z.string(), prefix: z.string() }),
    z.object({ command: z.literal('ready') }),
]);

const historyEntrySchema = z.object({ sql: z.string(), executedAt: z.number() });
const historySchema = z.array(historyEntrySchema);
const MAX_RENDER_ROWS = 10_000;
const CATALOG_CACHE_MS = 60_000;

export type WebviewRequest = z.infer<typeof webviewRequestSchema>;
export type ParseOutcome =
    | { readonly tag: 'ok'; readonly request: WebviewRequest }
    | { readonly tag: 'parseFailure'; readonly message: string };

type ExportFormat = z.infer<typeof exportFormatSchema>;
type CatalogCache = { readonly expiresAt: number; readonly tables: readonly string[] };

export function parseWebviewRequest(value: unknown): ParseOutcome {
    const result = webviewRequestSchema.safeParse(value);
    if (result.success) return { tag: 'ok', request: result.data };
    return {
        tag: 'parseFailure',
        message: result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '),
    };
}

export interface QueryPanelOptions {
    readonly registry: ActorRegistry;
    readonly context?: vscode.ExtensionContext;
    /**
     * Catalog used by the privacy policy: when the workbench disposes via
     * `forgetOnDispose`, the catalog removes both the connection record
     * and the per-server query-history key.
     */
    readonly catalog?: GlobalStateConnectionCatalog;
    /**
     * When true, the workbench's `dispose()` calls `catalog.forgetServer(id)`
     * before tearing down the panel. Defaults to false so unrelated
     * disposes (e.g. user closing the tab) keep history.
     */
    readonly forgetOnDispose?: boolean;
}

export class QueryWorkbench {
    static readonly currentPanels: Map<string, QueryWorkbench> = new Map<string, QueryWorkbench>();

    private readonly disposables: vscode.Disposable[] = [];
    private readonly catalogReader: CatalogReader;
    private readonly statementResults: QueryResult[] = [];
    private readonly pendingMessages: { readonly type: string; readonly [key: string]: unknown }[] = [];
    private lastResult: QueryResult | null = null;
    private catalogCache: CatalogCache | null = null;
    private webviewReady = false;
    private disposed = false;
    private readonly catalog: GlobalStateConnectionCatalog | undefined;
    private readonly forgetOnDispose: boolean;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly connectionId: string,
        private readonly connectionName: string,
        private readonly registry: ActorRegistry,
        private readonly context?: vscode.ExtensionContext,
        catalog?: GlobalStateConnectionCatalog,
        forgetOnDispose: boolean = false
    ) {
        this.catalog = catalog;
        this.forgetOnDispose = forgetOnDispose;
        this.catalogReader = new CatalogReader(() => this.registry.getSession(this.connectionId));
        // The workbench surfaces read-only state in its UI so the user sees
        // the safety posture before issuing any query.
        const readOnly = this.registry.getConfig(this.connectionId)?.readOnly === true;
        this.panel.webview.html = buildQueryWorkbenchHtml({
            nonce: createNonce(),
            serverName: escapeHtml(this.connectionName),
            ...(readOnly ? { readOnly: true } : {}),
        });
        this.panel.webview.onDidReceiveMessage((message: unknown) => this.onMessage(message), undefined, this.disposables);
        this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
        this.context?.subscriptions.push(this.panel);
    }

    static createOrShow(
        extensionUri: vscode.Uri,
        connectionId: string,
        connectionName: string,
        options: QueryPanelOptions
    ): QueryWorkbench {
        void extensionUri;
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        const existing = QueryWorkbench.currentPanels.get(connectionId);
        if (existing) {
            existing.panel.reveal(column);
            return existing;
        }
        const panel = vscode.window.createWebviewPanel('mysqlQuery', `Query: ${connectionName}`, column, {
            enableScripts: true,
            retainContextWhenHidden: true,
        });
        const workbench = new QueryWorkbench(
            panel,
            connectionId,
            connectionName,
            options.registry,
            options.context,
            options.catalog,
            options.forgetOnDispose ?? false
        );
        QueryWorkbench.currentPanels.set(connectionId, workbench);
        return workbench;
    }

    /**
     * Replace the editor contents without executing. Used when the
     * caller (e.g. a "Preview Rows" command) wants the user to see and
     * edit the exact SQL that's about to run.
     */
    setEditorSql(sql: string): void {
        this.postMessage({ type: 'setSql', sql });
    }

    async runFocusedQuery(sql: string, caret: number): Promise<void> {
        await this.executeQuery(selectFocusedStatement(sql, caret));
    }

    async executeQuery(sql: string): Promise<void> {
        if (!this.registry.isConnected(this.connectionId)) {
            this.postMessage({ type: 'error', message: 'Not connected to database' });
            return;
        }
        const scan = splitSqlStatements(sql);
        if (scan.tag === 'unsupported') {
            this.postMessage({ type: 'error', message: scan.message });
            return;
        }
        const statements = scan.statements;
        if (statements.length === 0) return;
        await this.saveHistory(sql);
        this.statementResults.length = 0;
        this.postMessage({ type: 'loading' });
        for (const [statementIndex, statement] of statements.entries()) {
            const result = await this.runStatement(statement);
            if (!result) return;
            this.lastResult = result;
            this.statementResults.push(result);
            this.postMessage({ type: 'result', data: result });
            this.postMessage({
                type: /^\s*EXPLAIN(?:\s+ANALYZE)?\b/i.test(statement) ? 'explainResult' : 'statementResult',
                data: result,
                statement,
                statementIndex,
                statementCount: statements.length,
            });
            if (result.error) return;
        }
    }

    private async runStatement(sql: string): Promise<QueryResult | null> {
        try {
            const result = await this.registry.executeQuery(this.connectionId, sql);
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // Distinguish "not connected" from other failures for the UI.
            if (/not connected/i.test(message) || /is not connected/i.test(message)) {
                this.postMessage({ type: 'error', message: 'Not connected to database' });
                return null;
            }
            // Friendly note when the server rejects a write because the
            // session is in read-only mode. Without this, users see the raw
            // ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION text and assume the
            // extension is broken.
            if (this.isReadOnlyError(message)) {
                this.postMessage({
                    type: 'error',
                    message: `Write blocked: this connection is in read-only mode. ${message} (Edit the server profile and clear "Read-only session" if you need to write.)`,
                });
                return null;
            }
            this.postMessage({ type: 'error', message });
            return null;
        }
    }

    private isReadOnlyError(message: string): boolean {
        return isReadOnlyError(message);
    }

    private async onMessage(message: unknown): Promise<void> {
        const parsed = parseWebviewRequest(message);
        if (parsed.tag === 'parseFailure') {
            this.postMessage({ type: 'error', message: `Bad request: ${parsed.message}` });
            return;
        }
        const request = parsed.request;
        switch (request.command) {
            case 'executeQuery':
                await this.executeQuery(request.sql);
                return;
            case 'runFocusedQuery':
                await this.runFocusedQuery(request.sql, request.caret);
                return;
            case 'runExplain': {
                const focused = selectFocusedStatement(request.sql, request.caret);
                await this.executeQuery(/^\s*EXPLAIN\b/i.test(focused) ? focused : `EXPLAIN ${focused}`);
                return;
            }
            case 'exportCsv':
                await this.exportResult('csv');
                return;
            case 'export':
                await this.exportResult(request.format);
                return;
            case 'loadHistory':
                this.sendHistory(request.offset);
                return;
            case 'showCellDetail':
                this.sendCellDetail(request.statementIndex, request.rowIndex, request.column);
                return;
            case 'loadMore':
                this.sendMoreRows(request.statementIndex);
                return;
            case 'loadCompletions':
                await this.sendCompletions(request.sql, request.prefix);
                return;
            case 'ready':
                this.drainPendingMessages();
                return;
        }
    }

    private async saveHistory(sql: string): Promise<void> {
        if (!this.context) return;
        const key = this.historyKey;
        const current = historySchema.safeParse(this.context.globalState.get<unknown>(key));
        const existing = current.success ? current.data : [];
        const limit = vscode.workspace.getConfiguration('mysqlAzureAuth').get<number>('historyLimit', 100);
        const entries = [{ sql, executedAt: Date.now() }, ...existing.filter((entry) => entry.sql !== sql)].slice(0, Math.max(1, limit));
        await this.context.globalState.update(key, entries);
        this.sendHistory(0);
    }

    private sendHistory(offset: number): void {
        const parsed = historySchema.safeParse(this.context?.globalState.get<unknown>(this.historyKey));
        const entries = parsed.success ? parsed.data : [];
        this.postMessage({ type: 'history', entries: entries.slice(offset, offset + 25), offset, hasMore: offset + 25 < entries.length });
    }

    private sendCellDetail(statementIndex: number, rowIndex: number, column: string): void {
        const result = this.statementResults[statementIndex];
        const value = result?.rows[rowIndex]?.[column];
        this.postMessage({ type: 'cellDetail', statementIndex, rowIndex, column, value: value ?? null });
    }

    private sendMoreRows(statementIndex: number): void {
        const result = this.statementResults[statementIndex];
        if (!result) {
            this.postMessage({ type: 'error', message: 'Result set is no longer available' });
            return;
        }
        this.postMessage({
            type: 'moreRows',
            statementIndex,
            rows: result.rows.slice(0, MAX_RENDER_ROWS),
            capped: result.rows.length > MAX_RENDER_ROWS,
        });
    }

    private async sendCompletions(sql: string, prefix: string): Promise<void> {
        try {
            const tables = await this.getCachedTables();
            const tableMatch = /\b(?:FROM|JOIN)\s+[`"]?([\w$-]+)[`"]?/i.exec(sql);
            const columns = tableMatch?.[1] ? await this.catalogReader.listColumns(tableMatch[1]) : [];
            const candidates = [...tables, ...columns.map((column) => column.name)];
            const normalized = prefix.toLocaleLowerCase();
            this.postMessage({
                type: 'completions',
                items: [...new Set(candidates)].filter((item) => item.toLocaleLowerCase().startsWith(normalized)).slice(0, 50),
            });
        } catch (error) {
            this.postMessage({ type: 'completions', items: [], message: error instanceof Error ? error.message : String(error) });
        }
    }

    private async getCachedTables(): Promise<readonly string[]> {
        if (this.catalogCache && this.catalogCache.expiresAt > Date.now()) return this.catalogCache.tables;
        const tables = await this.catalogReader.listTables();
        this.catalogCache = { tables, expiresAt: Date.now() + CATALOG_CACHE_MS };
        return tables;
    }

    private async exportResult(format: ExportFormat): Promise<void> {
        const result = this.lastResult;
        if (!result || result.rows.length === 0) {
            await vscode.window.showWarningMessage('No data to export');
            return;
        }
        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`query-results.${format}`),
            filters: format === 'csv' ? { 'CSV files': ['csv'] } : format === 'json' ? { 'JSON files': ['json'] } : { 'Markdown files': ['md'] },
        });
        if (!uri) return;
        const content = format === 'csv' ? toCsv(result) : format === 'json' ? JSON.stringify(result.rows, null, 2) : toMarkdown(result);
        const fs = await import('fs');
        const path = await import('path');
        await fs.promises.writeFile(uri.fsPath, content, 'utf8');
        await vscode.window.showInformationMessage(`Exported ${result.rowCount} rows to ${path.basename(uri.fsPath)}`);
    }

    private postMessage(message: { readonly type: string; readonly [key: string]: unknown }): void {
        // Buffer outbound messages until the webview reports ready. Once
        // ready, drain the queue so the initial setSql + executeQuery
        // sequence from commands like previewRows doesn't race the
        // webview's message handler registration.
        if (!this.webviewReady) {
            this.pendingMessages.push(message);
            return;
        }
        void this.panel.webview.postMessage(message).then(undefined, (error: unknown) => {
            // Webview postMessage can reject if the panel was disposed
            // mid-flight or the message was rejected by VS Code's CSP.
            // Swallow so a transient failure doesn't crash the host.
            console.error('[mysqlAzureAuth] postMessage failed', error);
        });
    }

    private drainPendingMessages(): void {
        this.webviewReady = true;
        while (this.pendingMessages.length > 0) {
            const next = this.pendingMessages.shift();
            if (next) void this.panel.webview.postMessage(next);
        }
    }

    private get historyKey(): string {
        return queryHistoryKey(this.connectionId);
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        QueryWorkbench.currentPanels.delete(this.connectionId);
        if (this.forgetOnDispose && this.catalog) {
            // Privacy: when the user actively forgets a server, the
            // workbench must not leave per-server SQL history behind.
            // `forgetServer()` removes both the connection record and
            // the per-server history key in one atomic step.
            void this.catalog.forgetServer(this.connectionId);
        }
        while (this.disposables.length > 0) this.disposables.pop()?.dispose();
        this.panel.dispose();
    }
}

