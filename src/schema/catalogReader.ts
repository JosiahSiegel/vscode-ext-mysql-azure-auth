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

    async listTables(): Promise<string[]> {
        const session = this.getSession();
        if (!session) throw new Error('Not connected');
        return session.listTables();
    }

    async listColumns(tableName: string): Promise<ColumnInfo[]> {
        const session = this.getSession();
        if (!session) throw new Error('Not connected');
        return session.listColumns(tableName);
    }
}