/**
 * ConnectionHandle - thin compatibility facade over `DatabaseSession`.
 *
 * The legacy class was a god-class that mixed connect/refresh/query/list-
 * tables plus a 45-minute hard-disconnect that killed in-flight queries. The
 * rewrite moves all of that into `DatabaseSession` (which uses an
 * `mysql.Pool` with drain-and-replace rotation) and `ActorRegistry`
 * (which serialises the per-ID lifecycle).
 *
 * This file remains to keep the 35-test regression net green during the
 * rewrite. It exposes the legacy surface (`connect`, `executeQuery`,
 * `getDatabases`, `getTables`, `getTableColumns`, `isConnected`,
 * `disconnect`, `getConfig`) by delegating to the new modules.
 *
 * The 45-minute refresh interval is implemented via `setInterval` that
 * `unref()`s itself so it never blocks process exit.
 */

import { getIdentityProvider } from '../identity/entraToken';
import { DatabaseSession, type PoolFactory } from '../registry/databaseSession';
import { toLegacyQueryResult } from '../registry/legacyWire';
import type {
    ConnectionConfig,
    QueryResult,
    TableColumn,
} from '../domain';

const DEFAULT_REFRESH_MS = 45 * 60 * 1000;

export interface MySqlClientOptions {
    /** Override the default 45-minute refresh interval (ms). */
    refreshIntervalMs?: number;
    /** Inject a custom pool factory for tests. */
    poolFactory?: PoolFactory;
}

export class ConnectionHandle {
    private session: DatabaseSession | null = null;
    private tokenRefreshTimer: NodeJS.Timeout | null = null;
    private readonly refreshMs: number;
    private readonly poolFactory: PoolFactory | undefined;

    constructor(
        private readonly config: ConnectionConfig,
        options: MySqlClientOptions = {}
    ) {
        this.refreshMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
        this.poolFactory = options.poolFactory;
    }

    /** Open the session and start the token-refresh schedule. */
    async connect(): Promise<void> {
        const auth = getIdentityProvider();
        const token = await auth.getAccessToken();
        this.session = new DatabaseSession({
            host: this.config.host,
            port: this.config.port,
            user: this.config.user,
            database: this.config.database,
            ssl: this.config.ssl,
            token,
            ...(this.poolFactory ? { poolFactory: this.poolFactory } : {}),
        });
        this.startTokenRefresh();
    }

    /** Schedule periodic token rotation. The interval is unref'd so it
     *  never blocks Node exit - a forgotten disconnect() can't keep CI alive. */
    private startTokenRefresh(): void {
        if (this.tokenRefreshTimer) {
            clearInterval(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
        this.tokenRefreshTimer = setInterval(() => {
            // Fire-and-forget; failures are logged but never crash the host.
            this.refreshToken().catch((err: unknown) => {
                console.error('Token refresh failed:', err);
            });
        }, this.refreshMs);
        if (typeof this.tokenRefreshTimer.unref === 'function') {
            this.tokenRefreshTimer.unref();
        }
    }

    /**
     * Acquire a new token and swap it into the live session.
     *
     * Per the design (see README § "How authentication works"):
     *   1. Build a new pool bound to the new token.
     *   2. Atomically swap; new queries go to the new pool.
     *   3. Wait for in-flight queries to drain.
     *   4. Close the old pool.
     *
     * In-flight queries survive because the swap is on the POOL, not on the
     * underlying socket.
     */
    async refreshToken(): Promise<void> {
        if (!this.session) return;
        const auth = getIdentityProvider();
        const token = await auth.getAccessToken();
        await this.session.swapToken({
            host: this.config.host,
            port: this.config.port,
            user: this.config.user,
            database: this.config.database,
            ssl: this.config.ssl,
            token,
            ...(this.poolFactory ? { poolFactory: this.poolFactory } : {}),
        });
    }

    async executeQuery(sql: string): Promise<QueryResult> {
        if (!this.session) {
            throw new Error('Not connected to database');
        }
        const outcome = await this.session.execute(sql);
        return toLegacyQueryResult(outcome);
    }

    async getDatabases(): Promise<string[]> {
        if (!this.session) throw new Error('Not connected to database');
        return this.session.listDatabases();
    }

    async getTables(): Promise<string[]> {
        if (!this.session) throw new Error('Not connected to database');
        return this.session.listTables();
    }

    async getTableColumns(tableName: string): Promise<TableColumn[]> {
        if (!this.session) throw new Error('Not connected to database');
        return this.session.listColumns(tableName);
    }

    async disconnect(): Promise<void> {
        if (this.tokenRefreshTimer) {
            clearInterval(this.tokenRefreshTimer);
            this.tokenRefreshTimer = null;
        }
        if (this.session) {
            await this.session.end();
            this.session = null;
        }
    }

    isConnected(): boolean {
        return this.session?.isOpen() ?? false;
    }

    getConfig(): ConnectionConfig {
        return this.config;
    }
}

// LifecycleRegistry and `connectionManager` singleton live here for the
// legacy tests; the U4 ActorRegistry supersedes this for new code.

export class LifecycleRegistry {
    private readonly connections = new Map<string, ConnectionHandle>();

    getConnection(id: string): ConnectionHandle | undefined {
        return this.connections.get(id);
    }

    setConnection(id: string, client: ConnectionHandle): void {
        this.connections.set(id, client);
    }

    async removeConnection(id: string): Promise<void> {
        const client = this.connections.get(id);
        if (client) {
            // Awaited: fixes the fire-and-forget bug from the original code.
            await client.disconnect();
            this.connections.delete(id);
        }
    }

    getAllConnections(): Map<string, ConnectionHandle> {
        return this.connections;
    }

    async disconnectAll(): Promise<void> {
        const clients = Array.from(this.connections.values());
        await Promise.all(
            clients.map((c) =>
                c.disconnect().catch((err: unknown) => {
                    console.error('Error disconnecting client:', err);
                })
            )
        );
        this.connections.clear();
    }
}

export const connectionManager = new LifecycleRegistry();