/**
 * GlobalStateConnectionCatalog - persists connections in VS Code's
 * globalState. Uses `zod` for parse-don't-validate: anything in globalState
 * that doesn't match the schema is treated as missing (with a logged
 * warning) rather than corrupting the running app.
 *
 * This module's contract is what U10's composition root depends on. The
 * tree view and the commands consume the Repository, not globalState.
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
    database: z.string().min(1),
    user: z.string().min(1),
    ssl: z.boolean(),
    // Optional for backward compatibility with profiles saved before
    // read-only mode was added. Missing values default to false.
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
    return { connections: result.data, problems: [] };
}

/** Well-known globalState key for saved connections. */
export const CONNECTIONS_STORAGE_KEY = 'connections';

/**
 * The Repository is a thin wrapper over ExtensionContext.globalState that
 * parses on read and validates on write. It also handles persistence
 * coordination (refresh-after-write) for callers that don't care about the
 * underlying memento.
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

    async add(config: ConnectionConfig): Promise<void> {
        const current = this.list().connections;
        const next = [...current, config];
        await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, next);
        this.onChanged?.();
    }

    async update(config: ConnectionConfig): Promise<void> {
        const current = this.list().connections;
        const index = current.findIndex((c) => c.id === config.id);
        if (index < 0) return; // No-op for unknown id.
        const next = current.slice();
        next[index] = config;
        await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, next);
        this.onChanged?.();
    }

    async remove(id: string): Promise<void> {
        const current = this.list().connections;
        const next = current.filter((c) => c.id !== id);
        await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, next);
        this.onChanged?.();
    }

    async replaceAll(connections: readonly ConnectionConfig[]): Promise<void> {
        const result = storedConnectionsSchema.safeParse(connections);
        if (!result.success) {
            throw new Error(
                `Cannot persist invalid connection list: ${result.error.message}`
            );
        }
        await this.context.globalState.update(CONNECTIONS_STORAGE_KEY, result.data);
        this.onChanged?.();
    }
}