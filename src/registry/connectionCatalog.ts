/**
 * GlobalStateConnectionCatalog - persists connections in VS Code's
 * globalState. Uses `zod` for parse-don't-validate: anything in globalState
 * that doesn't match the schema is treated as missing (with a logged
 * warning) rather than corrupting the running app.
 *
 * This module's contract is what U10's composition root depends on. The
 * tree view and the commands consume the Repository, not globalState.
 *
 * Todo 5 privacy:
 *   - On every `list()`, legacy `readOnly` flags (true / false / missing)
 *     are coerced to `true` and the writable `readOnly` field is dropped
 *     from disk, so the catalog never re-persists a user-toggleable value.
 *   - `forgetServer(id)` removes both the connection record and the
 *     per-server `mysqlAzureAuth.queryHistory.<id>` key.
 */

import type { ExtensionContext } from 'vscode';
import { z } from 'zod';
import type { ConnectionConfig } from '../domain';

/** The legacy shape on disk: an array of plain objects. */
const connectionSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    // `database` is optional: a saved connection may omit it when the user
    // wants to query any database the principal has access to. The zod
    // schema accepts both `undefined` (field absent) and any string
    // (including `''`). `parseStoredConnections` then normalises
    // `undefined` to `''` so the in-memory `ConnectionConfig` value
    // (which is typed `string`, not `string | undefined`) is uniform
    // across every read site.
    database: z.string().optional(),
    user: z.string().min(1),
    ssl: z.boolean(),
    // Optional for backward compatibility with profiles saved before
    // read-only mode was added. Missing values default to false at parse
    // time, then `loadOrMigrate()` rewrites them to `true` before they
    // reach the runtime.
    readOnly: z.boolean().optional(),
});

const storedConnectionsSchema = z.array(connectionSchema);

export interface ParseResult {
    readonly connections: readonly ConnectionConfig[];
    /** Storage problems found while parsing; safe to log. */
    readonly problems: readonly string[];
}

/**
 * Parse the raw value stored at the connections key. Always returns a
 * ParseResult; never throws. Invalid payload yields an empty array plus
 * problems so the UI can show "saved connections could not be loaded".
 */
export function parseStoredConnections(value: unknown): ParseResult {
    if (value === undefined || value === null) {
        return { connections: [], problems: [] };
    }
    const result = storedConnectionsSchema.safeParse(value);
    if (!result.success) {
        const problems = result.error.issues.map(
            (i) => `${i.path.join('.') || '<root>'}: ${i.message}`
        );
        return { connections: [], problems };
    }
    // Single-point coercion: empty-or-missing `database` is normalised to
    // a single falsy value so downstream consumers (tree view, quickpick,
    // session wrapper) can render `${config.database ? config.database : '(no default database)'}`
    // without splitting on `''` vs `undefined`. The domain type keeps
    // `database: string` (non-optional) per design, so the value here is
    // always a string — `''` for the "no default database" state.
    const connections: readonly ConnectionConfig[] = result.data.map((entry) => ({
        ...entry,
        database: entry.database ?? '',
    }));
    return { connections, problems: [] };
}

/** Well-known globalState key for saved connections. */
export const CONNECTIONS_STORAGE_KEY = 'connections';

/** Per-server SQL history key prefix used by the Query Workbench. */
export const QUERY_HISTORY_KEY_PREFIX = 'mysqlAzureAuth.queryHistory.';

/** Build the per-server query-history key for a connection id. */
export function queryHistoryKey(connectionId: string): string {
    return `${QUERY_HISTORY_KEY_PREFIX}${connectionId}`;
}

/**
 * The Repository is a thin wrapper over ExtensionContext.globalState that
 * parses on read and validates on write. It also handles persistence
 * coordination (refresh-after-write) for callers that don't care about the
 * underlying memento.
 *
 * Todo 5 also adds a `loadOrMigrate()` helper that returns the live list
 * of coerced records, eagerly rewrites the persisted array to drop the
 * `readOnly` field, and removes any per-server `mysqlAzureAuth.queryHistory.<id>`
 * key when called via `forgetServer(id)`.
 */
export class GlobalStateConnectionCatalog {
    constructor(
        private readonly context: Pick<ExtensionContext, 'globalState'>,
        private readonly onChanged?: () => void
    ) {}

    list(): ParseResult {
        const raw = this.context.globalState.get<unknown>(CONNECTIONS_STORAGE_KEY);
        return parseStoredConnections(raw);
    }

    /**
     * Read the stored list, coerce every record's `readOnly` flag to
     * `true`, and persist the rewritten list if any record carried a
     * writable value. Returns the coerced records so callers see the
     * post-migration state.
     */
    loadOrMigrate(): readonly ConnectionConfig[] {
        const { connections } = this.list();
        if (connections.length === 0) return connections;
        const coerced = connections.map((entry) => coerceReadOnly(entry));
        const rewritten = coerced.some(
            (entry, index) => entry !== connections[index]
        );
        if (rewritten) {
            // Fire-and-forget: callers can `await` if they need to, but
            // we deliberately do not require it so the read path stays
            // synchronous.
            void this.context.globalState.update(
                CONNECTIONS_STORAGE_KEY,
                coerced.map(stripReadOnly)
            );
            this.onChanged?.();
        }
        return coerced;
    }

    async add(config: ConnectionConfig): Promise<void> {
        const current = this.loadOrMigrate();
        const next = [...current, coerceReadOnly(config)];
        await this.context.globalState.update(
            CONNECTIONS_STORAGE_KEY,
            next.map(stripReadOnly)
        );
        this.onChanged?.();
    }

    async update(config: ConnectionConfig): Promise<void> {
        const current = this.loadOrMigrate();
        const index = current.findIndex((c) => c.id === config.id);
        if (index < 0) return; // No-op for unknown id.
        const next = current.slice();
        next[index] = coerceReadOnly(config);
        await this.context.globalState.update(
            CONNECTIONS_STORAGE_KEY,
            next.map(stripReadOnly)
        );
        this.onChanged?.();
    }

    async remove(id: string): Promise<void> {
        const current = this.loadOrMigrate();
        const next = current.filter((c) => c.id !== id);
        await this.context.globalState.update(
            CONNECTIONS_STORAGE_KEY,
            next.map(stripReadOnly)
        );
        this.onChanged?.();
    }

    /**
     * Forget a server entirely: drop the connection record and the
     * matching per-server query history key. Idempotent — missing keys
     * are silently ignored.
     */
    async forgetServer(id: string): Promise<void> {
        await this.context.globalState.update(queryHistoryKey(id), undefined);
        await this.remove(id);
    }

    async replaceAll(connections: readonly ConnectionConfig[]): Promise<void> {
        const normalized = connections.map(coerceReadOnly);
        const result = storedConnectionsSchema.safeParse(
            normalized.map(stripReadOnly)
        );
        if (!result.success) {
            throw new Error(
                `Cannot persist invalid connection list: ${result.error.message}`
            );
        }
        await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, result.data);
        this.onChanged?.();
    }
}

/**
 * Coerce any persisted `readOnly` flag to `true`. The catalog no longer
 * honours a writable `readOnly` value — every session is read-only by
 * design (see Todo 9). Both `true` and `false` (and the legacy missing
 * case) collapse to `true` at the runtime boundary.
 */
export function coerceReadOnly(config: ConnectionConfig): ConnectionConfig {
    return { ...config, readOnly: true };
}

/**
 * Strip the `readOnly` field from the persisted shape. The runtime keeps
 * it in memory (because `ConnectionConfig.readOnly` is still part of the
 * domain type) but it is no longer round-tripped through `globalState`.
 */
export function stripReadOnly(config: ConnectionConfig): ConnectionConfig {
    const { readOnly: _drop, ...rest } = config;
    void _drop;
    return rest;
}

/**
 * Test-only convenience: invoke `loadOrMigrate()` on a catalog without
 * needing to await. Returns the coerced record list. The test shim is
 * here (rather than in the test file) so the migration logic stays the
 * single source of truth.
 */
export function loadOrMigrateTestShim(
    catalog: GlobalStateConnectionCatalog
): readonly ConnectionConfig[] {
    return catalog.loadOrMigrate();
}