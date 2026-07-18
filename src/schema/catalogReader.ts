/**
 * CatalogReader - read-only schema browsing. Pulls databases, tables, and
 * column metadata from a connected session.
 *
 * The explorer returns raw `DbRow[]` so the caller can shape them for
 * display. The tree renderer (UI layer) is responsible for mapping rows to
 * `vscode.TreeItem` instances; this layer is pure data I/O.
 */

import { DatabaseSession } from '../registry/databaseSession';

export interface ColumnInfo {
    readonly name: string;
    readonly type: string;
}

export class CatalogReader {
    constructor(private readonly getSession: () => DatabaseSession | undefined) {}

    async listDatabases(): Promise<string[]> {
        const session = this.getSession();
        if (!session) throw new Error('Not connected');
        return session.listDatabases();
    }

    /**
     * List table names visible to the current session.
     *
     * When `database` is omitted, the connection's default DB applies and
     * the underlying call emits a bare `SHOW TABLES`. When `database` is
     * provided, the call is scoped to that DB via `SHOW TABLES FROM \`db\``
     * — this is the path used when expanding a database node in the tree
     * for a connection profile whose default DB is empty (the
     * friendly-defaults configuration).
     */
    async listTables(database?: string): Promise<string[]> {
        const session = this.getSession();
        if (!session) throw new Error('Not connected');
        return session.listTables(database);
    }

    async listColumns(database: string | undefined, tableName: string): Promise<ColumnInfo[]> {
        const session = this.getSession();
        if (!session) throw new Error('Not connected');
        return session.listColumns(database, tableName);
    }
}