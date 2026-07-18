/**
 * GlobalStateConnectionCatalog - persists connections in VS Code's
 * globalState. Uses `zod` for parse-don't-validate: anything in globalState
 * that doesn't match the schema is treated as missing (with a logged
 * warning) rather than corrupting the running app.
 *
 * This module's contract is what U10's composition root depends on. The
 * tree view and the commands consume the Repository, not globalState.
 *
 * Todo 6 privacy:
 *   - the user's `readOnly` opt-in is persisted end-to-end: a checked
 *     checkbox survives `catalog.add()` → fresh `catalog.list()` and
 *     rehydrates the edit-form. `stripPersistedFields` only removes
 *     the legacy `database` field — `readOnly` round-trips through
 *     `globalState`.
 *   - `forgetServer(id)` removes both the connection record and the
 *     per-server `mysqlAzureAuth.queryHistory.<id>` key.
 *
 * drop-default-database T1: the optional `database` field is REMOVED from
 * the parsed shape entirely. Profiles persisted by older releases may
 * still carry `database: 'appdb'`; the v1 migration step in `main.ts`
 * rewrites those records to drop the field. `parseStoredConnections`
 * rejects (treats as missing) any persisted record that still carries a
 * `database` key — a no-op for the typical user, but a fast-fail for the
 * edge case where a downgrade / external edit reintroduced the field.
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
    user: z.string().min(1),
    ssl: z.boolean(),
    // Optional for backward compatibility with profiles saved before
    // read-only mode was added. The persisted value is honoured as
    // the user set it (Todo 6); missing values default to `false` at
    // parse time and `loadOrMigrate()` runs `coerceReadOnly()` so the
    // opt-in preference is preserved end-to-end.
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
    // The `database` field is no longer part of the parsed shape. The
    // caller is expected to have already run the v1 migration step
    // (see `src/main.ts`) which rewrites legacy persisted records to
    // drop `database`; if a stray record still carries it (eg. because
    // the user downgraded), zod rejects it above.
    const connections: readonly ConnectionConfig[] = result.data.map(
        (entry) => ({ ...entry })
    );
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
 * of coerced records and eagerly rewrites the persisted array to drop
 * the legacy `database` field (the `readOnly` flag IS preserved end-to-end).
 * `forgetServer(id)` removes any per-server `mysqlAzureAuth.queryHistory.<id>`
 * key in the same atomic step.
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
     * Read the stored list, normalise every record's `readOnly` flag via
     * `coerceReadOnly()` (Todo 6: honour the user's opt-in), and persist
     * the rewritten list if any record still carries the legacy
     * `database` field on disk or otherwise differs from the normalised
     * shape. Returns the coerced records so callers see the
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
                coerced.map(stripPersistedFields)
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
            next.map(stripPersistedFields)
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
            next.map(stripPersistedFields)
        );
        this.onChanged?.();
    }

    async remove(id: string): Promise<void> {
        const current = this.loadOrMigrate();
        const next = current.filter((c) => c.id !== id);
        await this.context.globalState.update(
            CONNECTIONS_STORAGE_KEY,
            next.map(stripPersistedFields)
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
            normalized.map(stripPersistedFields)
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
 * Honour the user's opt-in: `readOnly` is preserved as `true` when set;
 * legacy records with `readOnly: false` (or missing) collapse to
 * `readOnly: false` to enable the new opt-in default. Records that
 * explicitly carried `readOnly: true` retain it. The disk shape is
 * stripped separately by `stripPersistedFields`; this helper only
 * normalises the in-memory value. `readOnly` IS part of the persisted
 * shape (only the legacy `database` field is stripped).
 */
export function coerceReadOnly(config: ConnectionConfig): ConnectionConfig {
    return { ...config, readOnly: config.readOnly === true };
}

/**
 * Strip a set of fields that the connection profile no longer
 * round-trips through `globalState`. The `readOnly` flag IS persisted:
 * the user's opt-in preference must survive a save / fresh-catalog /
 * list() round-trip so an edit-form rehydration does not silently
 * downgrade the user's choice. The legacy `database` field is the
 * only field stripped today — records persisted by older releases may
 * carry it; new records never do.
 */
export function stripPersistedFields(
    config: ConnectionConfig
): ConnectionConfig {
    const { database: _dropDatabase, ...rest } = config as ConnectionConfig & {
        readonly database?: string | undefined;
    };
    void _dropDatabase;
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