/**
 * Domain contracts for the rewrite.
 *
 * The legacy `ConnectionConfig` / `QueryResult` types live alongside the new
 * discriminated-union types. The legacy shapes stay exported because the
 * webview protocol, the persistence layer, and the existing 35-test contract
 * still consume them. New code should prefer the new types; the legacy
 * types are the wire format, not the canonical model.
 *
 * Invariants:
 * - `ConnectionId` is a branded string. Construct via `asConnectionId()`,
 *   never via `as ConnectionId` casts from arbitrary `string` values.
 * - `QueryOutcome` is the canonical internal model for query execution.
 *   `toLegacyQueryResult()` projects it back to the wire `QueryResult`.
 * - `StoredConnections` carries a versioned envelope around the legacy
 *   `ConnectionConfig[]` shape so future migrations are explicit.
 */

// ---------- Branded primitives ----------

declare const __brand: unique symbol;

export type Brand<T, N extends string> = T & { readonly [__brand]: N };

/** Stable identifier for a saved MySQL connection. Construct via `asConnectionId`. */
export type ConnectionId = Brand<string, 'ConnectionId'>;

/** Smart-cast a string to a ConnectionId without runtime checks. */
export function asConnectionId(value: string): ConnectionId {
    return value as ConnectionId;
}

// ---------- Legacy wire types (kept for tests + webview) ----------

export interface ConnectionConfig {
    id: string;
    name: string;
    host: string;
    port: number;
    user: string;
    ssl: boolean;
    /**
     * When true, every user-issued query batch is preceded by
     * `SET SESSION TRANSACTION READ ONLY`. The server then rejects any write
     * attempt (INSERT/UPDATE/DELETE/DDL) with ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION.
     * Default: false. Optional in persisted storage for backward compatibility.
     */
    readOnly?: boolean | undefined;
}

export interface QueryResult {
    columns: string[];
    rows: Record<string, unknown>[];
    rowCount: number;
    executionTime: number;
    error?: string;
}

export interface TableColumn {
    name: string;
    type: string;
}

// ---------- New internal query model ----------

/** Internal row type. Tests use `Record<string, unknown>` for parity. */
export type DbRow = Record<string, unknown>;

/** Discriminated statement output. mysql2 returns either rows or a change header. */
export type StatementOutput = {
    readonly tag: 'rows';
    readonly columns: readonly string[];
    readonly rows: readonly DbRow[];
} | {
    readonly tag: 'change';
    readonly affectedRows: number;
    readonly insertId: number;
    readonly info: string;
};

/** Tagged query problem union. */
export type QueryProblem =
    | { readonly tag: 'notConnected' }
    | { readonly tag: 'cancelled' }
    | { readonly tag: 'server'; readonly code?: string; readonly message: string };

/** Successful query outcome. */
export interface QuerySuccess {
    readonly output: StatementOutput;
    readonly elapsedMs: number;
}

/** Canonical internal result of a query. */
export type QueryOutcome =
    | { readonly tag: 'ok'; readonly success: QuerySuccess }
    | { readonly tag: 'err'; readonly problem: QueryProblem };

// ---------- Wire-format adapter ----------

/** Convert a `QueryOutcome` to the legacy `QueryResult` for the webview/tests. */
export function toLegacyQueryResult(outcome: QueryOutcome): QueryResult {
    if (outcome.tag === 'err') {
        return {
            columns: [],
            rows: [],
            rowCount: 0,
            executionTime: 0,
            error: formatQueryProblem(outcome.problem),
        };
    }
    const { output, elapsedMs } = outcome.success;
    if (output.tag === 'rows') {
        return {
            columns: [...output.columns],
            rows: output.rows.map((r) => ({ ...r })),
            rowCount: output.rows.length,
            executionTime: elapsedMs,
        };
    }
    return {
        columns: ['affectedRows', 'insertId', 'info'],
        rows: [
            {
                affectedRows: output.affectedRows,
                insertId: output.insertId,
                info: output.info,
            },
        ],
        rowCount: 1,
        executionTime: elapsedMs,
    };
}

function formatQueryProblem(problem: QueryProblem): string {
    switch (problem.tag) {
        case 'notConnected':
            return 'Not connected to database';
        case 'cancelled':
            return 'Query cancelled';
        case 'server':
            return problem.code ? `[${problem.code}] ${problem.message}` : problem.message;
    }
}

// ---------- Versioned persisted aggregate ----------

export const STORED_CONNECTIONS_VERSION = 1 as const;

export interface StoredConnections {
    readonly version: typeof STORED_CONNECTIONS_VERSION;
    readonly entries: readonly ConnectionConfig[];
}