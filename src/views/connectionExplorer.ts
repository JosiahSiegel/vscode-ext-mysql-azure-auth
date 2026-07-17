/**
 * Server explorer: server -> database -> table -> column.
 *
 * Context values are part of package.json's menu contract. Keep
 * server-live, server-idle, and table-live stable.
 *
 * allow: SIZE_OK — VS Code tree nodes and their provider must remain in this
 * single public module because the task explicitly forbids changing other files.
 */

import * as vscode from 'vscode';
import { ActorRegistry } from '../registry/actorRegistry';
import { CatalogReader, type ColumnInfo } from '../schema/catalogReader';
import { GlobalStateConnectionCatalog } from '../registry/connectionCatalog';
import type { ConnectionConfig, QueryResult } from '../domain';

const CACHE_TTL_MS = 60_000;
/** Maximum time (ms) to wait for a single SELECT COUNT(*) before giving up. */
const COUNT_QUERY_TIMEOUT_MS = 5_000;
const REFRESH_INTERVAL_MS = 2_000;
const DEFAULT_ROW_COUNT_LIMIT = 50;
const README_URL = 'https://github.com/your-org/mysql-azure-auth#readme';

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref();
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

type WelcomeAction = 'register' | 'readme';
type DisposableLike = { readonly dispose: () => void };

type SchemaCache = {
    loadedAt: number;
    databases: string[];
    tables: Map<string, string[]>;
    columns: Map<string, ColumnInfo[]>;
};

export interface ServerTreeDeps {
    readonly catalog: GlobalStateConnectionCatalog;
    readonly registry: ActorRegistry;
}

export class ServerTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this.changeEmitter.event;

    private readonly catalog: GlobalStateConnectionCatalog;
    private readonly registry: ActorRegistry;
    private readonly readerFor: (id: string) => CatalogReader;
    private readonly schemaCache = new Map<string, SchemaCache>();
    private readonly rowCounts = new Map<string, number | undefined>();
    private readonly lastKnownState = new Map<string, boolean>();
    private readonly disposables: DisposableLike[] = [];

    constructor(deps: ServerTreeDeps) {
        this.catalog = deps.catalog;
        this.registry = deps.registry;
        this.readerFor = (id: string) => new CatalogReader(() => this.registry.getSession(id));

        const pollingTimer = setInterval(() => this.refresh(), REFRESH_INTERVAL_MS);
        pollingTimer.unref();
        this.disposables.push({ dispose: () => clearInterval(pollingTimer) });
    }

    static makeStatusBarItem(registry: ActorRegistry): vscode.StatusBarItem {
        const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        const config = firstConnectedConfig(registry);
        const roTag = config?.readOnly ? ' · RO' : '';
        item.text = config ? `🟢 ${config.name}${roTag}` : '○ No connection';
        item.tooltip = config
            ? `${config.user}@${config.host}:${config.port}${config.readOnly ? ' (read-only)' : ''}`
            : 'No MySQL server is connected';
        item.show();
        return item;
    }

    refresh(): void {
        this.reconcileConnectionStates();
        this.changeEmitter.fire(undefined);
    }

    dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
        this.changeEmitter.dispose();
    }

    getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        try {
            if (element === undefined) return this.getServers();
            if (element instanceof ServerNode) return await this.getDatabases(element);
            if (element instanceof DatabaseNode) return await this.getTables(element);
            if (element instanceof TableNode) return await this.getColumns(element);
            return [];
        } catch (error) {
            return [new TreeErrorNode(`Schema unavailable: ${shortError(error)}`)];
        }
    }

    private getServers(): vscode.TreeItem[] {
        const { connections } = this.catalog.list();
        if (connections.length === 0) return [new WelcomeNode('register')];

        return connections.map((config) => {
            const isLive = this.registry.isConnected(config.id);
            const lookup = this.registry.lookup(config.id);
            const hasError = lookup.tag === 'known' && lookup.state.tag === 'failed';
            const previous = this.lastKnownState.get(config.id);
            if (previous === true && !isLive) this.invalidate(config.id);
            this.lastKnownState.set(config.id, isLive);
            return new ServerNode(config, isLive, hasError);
        });
    }

    private async getDatabases(server: ServerNode): Promise<vscode.TreeItem[]> {
        if (!server.isLive) return [];

        const cache = this.cacheFor(server.config.id);
        if (cache.databases.length === 0) {
            const databases = await this.readerFor(server.config.id).listDatabases();
            cache.databases = databases.filter((database) => database.length > 0);
            cache.loadedAt = Date.now();

            // After the friendly-defaults change, an empty `cache.databases`
            // means "no databases visible to this principal at this server",
            // not "render tables as fake databases". The old compat fallback
            // (which synthesised TableNodes from a bare `SHOW TABLES` call)
            // is removed: callers now navigate via real DatabaseNodes whose
            // tables are scoped by name at expansion time.
            if (databases.length > 0 && cache.databases.length === 0) {
                return [];
            }
        }

        return cache.databases.map(
            (database) => new DatabaseNode(database, server.config.id)
        );
    }

    private async getTables(database: DatabaseNode): Promise<vscode.TreeItem[]> {
        const cache = this.cacheFor(database.connectionId);
        let tables = cache.tables.get(database.databaseName);
        if (tables === undefined) {
            tables = await this.readerFor(database.connectionId).listTables(database.databaseName);
            cache.tables.set(database.databaseName, tables);
        }

        const rowCountsEnabled = vscode.workspace
            .getConfiguration('mysqlAzureAuth')
            .get<boolean>('showRowCounts', true) !== false;
        const counts = rowCountsEnabled
            ? await this.loadRowCounts(database.connectionId, database.databaseName, tables)
            : new Map<string, number | undefined>();
        return tables.map((table) =>
            new TableNode(
                table,
                database.connectionId,
                database.databaseName,
                counts.get(table),
                rowCountsEnabled
            )
        );
    }

    private async getColumns(table: TableNode): Promise<vscode.TreeItem[]> {
        const cache = this.cacheFor(table.connectionId);
        const key = schemaKey(table.databaseName, table.tableName);
        let columns = cache.columns.get(key);
        if (columns === undefined) {
            columns = await this.readerFor(table.connectionId).listColumns(table.tableName);
            cache.columns.set(key, columns);
        }
        return columns.map((column) => new ColumnNode(column));
    }

    private cacheFor(connectionId: string): SchemaCache {
        const cached = this.schemaCache.get(connectionId);
        if (cached !== undefined && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
            return cached;
        }

        this.invalidate(connectionId);
        const created: SchemaCache = {
            loadedAt: Date.now(),
            databases: [],
            tables: new Map<string, string[]>(),
            columns: new Map<string, ColumnInfo[]>(),
        };
        this.schemaCache.set(connectionId, created);
        return created;
    }

    private async loadRowCounts(
        connectionId: string,
        database: string,
        tables: readonly string[]
    ): Promise<Map<string, number | undefined>> {
        const selected = tables.slice(0, DEFAULT_ROW_COUNT_LIMIT);
        await Promise.all(selected.map(async (table) => {
            const key = rowCountKey(connectionId, database, table);
            if (this.rowCounts.has(key)) return;
            const sql = `SELECT COUNT(*) FROM \`${escapeIdentifier(database)}\`.\`${escapeIdentifier(table)}\``;
            try {
                const result = await withTimeout(
                    this.registry.executeQuery(connectionId, sql),
                    COUNT_QUERY_TIMEOUT_MS,
                    `count(${escapeIdentifier(database)}.${escapeIdentifier(table)})`
                );
                this.rowCounts.set(key, readCount(result));
            } catch {
                /* swallow — do not cache, let next expand retry */
            }
        }));

        return new Map(selected.map((table) => [
            table,
            this.rowCounts.get(rowCountKey(connectionId, database, table)),
        ]));
    }

    private reconcileConnectionStates(): void {
        const knownIds = new Set<string>();
        for (const config of this.catalog.list().connections) {
            knownIds.add(config.id);
            const current = this.registry.isConnected(config.id);
            const previous = this.lastKnownState.get(config.id);
            if (previous === true && !current) this.invalidate(config.id);
            this.lastKnownState.set(config.id, current);
        }
        for (const id of this.lastKnownState.keys()) {
            if (!knownIds.has(id)) {
                this.lastKnownState.delete(id);
                this.invalidate(id);
            }
        }
    }

    private invalidate(connectionId: string): void {
        this.schemaCache.delete(connectionId);
        const prefix = `${connectionId}\u0000`;
        for (const key of this.rowCounts.keys()) {
            if (key.startsWith(prefix)) this.rowCounts.delete(key);
        }
    }
}

export class WelcomeNode extends vscode.TreeItem {
    readonly action: WelcomeAction;

    constructor(action: WelcomeAction = 'register') {
        super(
            action === 'register' ? 'Register your first server' : 'Open README',
            vscode.TreeItemCollapsibleState.None
        );
        this.action = action;
        this.description = action === 'register' ? 'Get connected' : 'Setup and usage guide';
        this.tooltip = action === 'register'
            ? 'Register your first server. You can also open the README for setup help.'
            : README_URL;
        this.contextValue = 'welcome-node';
        this.iconPath = new vscode.ThemeIcon(action === 'register' ? 'add' : 'book');
        this.command = {
            command: 'mysqlAzureAuth.welcomeAction',
            title: 'Run welcome action',
            arguments: [action],
        };
    }

    static async run(action: WelcomeAction): Promise<void> {
        if (action === 'register') {
            await vscode.commands.executeCommand('mysqlAzureAuth.registerServer');
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(README_URL));
    }
}

export class ServerNode extends vscode.TreeItem {
    public readonly config: ConnectionConfig;
    public readonly isLive: boolean;

    constructor(config: ConnectionConfig, isLive: boolean, hasError = false) {
        super(
            config.name,
            isLive ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None
        );
        this.config = config;
        this.isLive = isLive;
        // Append an RO badge so the read-only state is visible at a glance
        // next to the host description.
        const roSuffix = config.readOnly ? ' · RO' : '';
        this.description = `${config.host}${roSuffix}`;
        this.tooltip = `${config.user}@${config.host}:${config.port}${config.readOnly ? ' (read-only)' : ''}`;
        this.contextValue = isLive ? 'server-live' : 'server-idle';
        this.iconPath = hasError
            ? new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'))
            : new vscode.ThemeIcon(
                isLive ? 'database' : 'circle-outline',
                isLive ? new vscode.ThemeColor(config.readOnly ? 'charts.blue' : 'testing.iconPassed') : undefined
            );
    }
}

export class DatabaseNode extends vscode.TreeItem {
    constructor(
        public readonly databaseName: string,
        public readonly connectionId: string
    ) {
        super(databaseName, vscode.TreeItemCollapsibleState.Collapsed);
        this.contextValue = 'database-live';
        this.iconPath = new vscode.ThemeIcon('database');
    }
}

export class TableNode extends vscode.TreeItem {
    public readonly tableName: string;
    public readonly connectionId: string;
    public readonly databaseName: string;

    constructor(
        tableName: string,
        connectionId: string,
        databaseName = '',
        rowCount?: number,
        showRowCount = true
    ) {
        super(tableName, vscode.TreeItemCollapsibleState.Collapsed);
        this.tableName = tableName;
        this.connectionId = connectionId;
        this.databaseName = databaseName;
        if (showRowCount) {
            this.description = rowCount === undefined ? '? rows' : `${formatCount(rowCount)} rows`;
        }
        this.iconPath = new vscode.ThemeIcon('table');
        this.contextValue = 'table-live';
        this.command = {
            command: 'mysqlAzureAuth.previewRows',
            title: 'Peek Rows',
            arguments: [this],
        };
    }
}

export class ColumnNode extends vscode.TreeItem {
    constructor(public readonly column: ColumnInfo) {
        super(column.name, vscode.TreeItemCollapsibleState.None);
        const badges = columnBadges(column);
        this.description = `${column.type}${badges.length > 0 ? ` ${badges.join(' ')}` : ''}`;
        this.tooltip = `${column.name} ${column.type}${badges.length > 0 ? ` ${badges.join(' ')}` : ''}`;
        this.contextValue = 'column-info';
        this.iconPath = new vscode.ThemeIcon(badges.includes('[PK]') ? 'key' : 'symbol-field');
    }
}

export class TreeErrorNode extends vscode.TreeItem {
    constructor(message: string) {
        super(message, vscode.TreeItemCollapsibleState.None);
        this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    }
}

function columnBadges(column: ColumnInfo): string[] {
    const key = stringMetadata(column, 'key').toUpperCase();
    const extra = stringMetadata(column, 'extra').toUpperCase();
    const badges: string[] = [];
    if (key === 'PRI' || booleanMetadata(column, 'primaryKey')) badges.push('[PK]');
    if (key === 'MUL' || booleanMetadata(column, 'foreignKey')) badges.push('[FK]');
    if (key === 'UNI' || booleanMetadata(column, 'indexed') || extra.includes('INDEX')) {
        badges.push('[IDX]');
    }
    return badges;
}

function stringMetadata(value: object, key: string): string {
    const metadata = Reflect.get(value, key);
    return typeof metadata === 'string' ? metadata : '';
}

function booleanMetadata(value: object, key: string): boolean {
    return Reflect.get(value, key) === true;
}

function readCount(result: QueryResult): number | undefined {
    if (result.error !== undefined) return undefined;
    const row = result.rows[0];
    if (row === undefined) return undefined;
    const value = Object.values(row)[0];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function formatCount(count: number): string {
    if (count < 1_000) return count.toLocaleString();
    if (count < 1_000_000) return `${stripTrailingZero((count / 1_000).toFixed(1))}k`;
    if (count < 1_000_000_000) return `${stripTrailingZero((count / 1_000_000).toFixed(1))}m`;
    return `${stripTrailingZero((count / 1_000_000_000).toFixed(1))}b`;
}

function stripTrailingZero(value: string): string {
    return value.endsWith('.0') ? value.slice(0, -2) : value;
}

function shortError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    const singleLine = message.replace(/\s+/g, ' ').trim();
    return singleLine.length > 100 ? `${singleLine.slice(0, 97)}...` : singleLine;
}

function escapeIdentifier(identifier: string): string {
    return identifier.replace(/`/g, '``');
}

function schemaKey(database: string, table: string): string {
    return `${database}\u0000${table}`;
}

function rowCountKey(connectionId: string, database: string, table: string): string {
    return `${connectionId}\u0000${database}\u0000${table}`;
}

function firstConnectedConfig(registry: ActorRegistry): ConnectionConfig | undefined {
    const connected = registry.listConnectedConfigs();
    return connected.length > 0 ? connected[0] : undefined;
}
