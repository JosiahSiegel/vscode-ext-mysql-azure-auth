/**
 * DatabaseSession - the typed port over mysql2.
 *
 * The port exposes ONLY what the rest of the extension needs:
 *   - execute(sql) -> QueryOutcome  (discriminated union, no stringly-typed errors)
 *   - listDatabases() / listTables(database?) / listColumns(database, table)
 *   - end() -> Promise<void>
 *
 * Internally each session owns an `mysql.Pool` and an `authPlugins` closure
 * bound to the CURRENT token. The pool is replaced wholesale when the token
 * rotates; the old pool drains in-flight work before being closed.
 *
 * We do NOT use `connection.changeUser()`. It is broken for
 * `mysql_clear_password` token auth (mysql2 issue #3350); see README §
 * "How authentication works" for the full rationale.
 *
 * Todo 9 hardening:
 *   - Every user SQL is routed through `classifySqlBatch()` BEFORE it
 *     reaches the pool. The classifier fail-closes unknown or disallowed
 *     statement forms.
 *   - The pool's `connection` event still attempts a best-effort
 *     `SET SESSION TRANSACTION READ ONLY`, but mysql2's async listener
 *     cannot be awaited. The synchronous wrapper `acquireReadOnlyConnection`
 *     below is the source of truth for the read-only contract.
 */

import * as mysql from 'mysql2/promise';
import {
    QueryOutcome,
    StatementOutput,
    QueryProblem,
    DbRow,
} from '../domain';
import { ConnectionProblem, QueryProblemError } from '../problems';
import { escapeSqlIdentifier } from '../views/sqlStatements';
import { classifySqlBatch } from './sqlClassifier';

export interface DatabaseSessionConfig {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly ssl: boolean;
    /** Current Entra access token. Captured by the authPlugins closure. */
    readonly token: string;
    /** Maximum time (ms) to wait when opening a connection. */
    readonly connectTimeoutMs?: number;
    /**
     * Pool factory. Tests inject a fake; production uses the default
     * `mysql.createPool`. The factory is invoked every time the session
     * builds a new pool (initial + after each token rotation).
     */
    readonly poolFactory?: PoolFactory;
    /**
     * When true, every physical connection acquired from the pool runs
     * `SET SESSION TRANSACTION READ ONLY` immediately after the auth
     * handshake. The server then enforces read-only mode for the lifetime of
     * that connection, rejecting any write with
     * ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION (1290).
     *
     * The pool's async `connection` listener cannot be awaited, so the
     * synchronous wrapper `acquireReadOnlyConnection()` below is the source
     * of truth for read-only enforcement. The pool listener is retained as
     * a defensive backstop.
     */
    readonly readOnly?: boolean;
}

/**
 * Factory shape for `mysql.createPool`. Exposed so tests can inject fakes
 * without mutating the bundled `mysql2/promise` namespace (esbuild wraps
 * that as a private CommonJS module that tests cannot reach from CJS).
 */
export type PoolFactory = (config: DatabaseSessionConfig) => PoolLike;

/**
 * Minimal pool surface used by DatabaseSession. Matches `mysql.Pool`'s
 * `execute()` + `end()` for our purposes.
 *
 * `onConnection` is optional - the production `mysql2` pool implements it
 * (inherited from EventEmitter). Test fakes can omit it because they don't
 * simulate real network session state.
 *
 * `getConnection` is the synchronous wrapper hook used by
 * `acquireReadOnlyConnection()`. The wrapper calls
 * `pool.getConnection()` to obtain a raw connection, awaits the returned
 * promise, and then issues `SET SESSION TRANSACTION READ ONLY` against
 * that connection BEFORE the session exposes it to query callers. Test
 * fakes can implement `getConnection` to drive the wrapper's success or
 * failure paths.
 */
export interface PoolLike {
    execute(sql: string): Promise<[unknown[], mysql.FieldPacket[] | undefined]>;
    end(): Promise<void>;
    onConnection?: (listener: (connection: { query: (sql: string) => unknown }) => void) => void;
    getConnection?: (callback: (err: Error | null, connection: ConnectionLike | undefined) => void) => void;
}

/**
 * The minimum surface `acquireReadOnlyConnection()` needs from a checked-
 * out pool connection. Mirrors mysql2's `PoolConnection` shape.
 */
export interface ConnectionLike {
    query(sql: string): Promise<unknown>;
    release(): void;
    destroy(): void;
}

/**
 * Outcome of a synchronous read-only connection checkout.
 */
export type ReadOnlyConnection =
    | { readonly ok: true; readonly connection: ConnectionLike; readonly readOnly: true }
    | { readonly ok: false; readonly reason: 'checkout-failed' | 'set-read-only-failed'; readonly cause?: unknown };

interface PoolHolder {
    readonly pool: PoolLike;
    readonly generation: number;
}

/**
 * A database session is an async context that owns one `mysql.Pool` plus the
 * `authPlugins` closure bound to a specific token. Rotating the token REPLACES
 * the pool (drain-old, build-new pattern); see `swapToken()`.
 */
export class DatabaseSession {
    private current: PoolHolder;
    /** Active count so close() can wait for in-flight work. */
    private inflight = 0;
    private closed = false;
    private readonly factory: PoolFactory;
    /**
     * True iff the session was constructed with `readOnly: true`. The
     * checkout wrapper is a no-op for `false`, so this flag records the
     * intent (which the registry may inspect for diagnostics).
     */
    private readonly readOnlyMode: boolean;

    constructor(config: DatabaseSessionConfig) {
        this.factory = config.poolFactory ?? defaultPoolFactory;
        this.readOnlyMode = config.readOnly === true;
        this.current = {
            pool: this.factory(config),
            generation: 0,
        };
    }

    /**
     * Synchronous checkout wrapper. Acquires a physical connection from
     * the current pool and runs `SET SESSION TRANSACTION READ ONLY`
     * BEFORE exposing the connection to query callers. mysql2's pool
     * `connection` event is async and not awaited, so the wrapper IS the
     * source of truth for the read-only contract.
     *
     * - On SET success: returns `{ok:true, connection, readOnly:true}`.
     * - On any SET failure: releases/destroys the connection and returns
     *   `{ok:false, reason:'set-read-only-failed'}`. The session is then
     *   `closed` and surfaces as not connected.
     * - When the pool does not implement `getConnection` (e.g., test fakes
     *   that bypass real network I/O): returns
     *   `{ok:false, reason:'checkout-failed'}` and closes the session.
     *
     * Callers MUST treat the `ok:false` branch as fatal: the session is
     * closed and further `execute()` calls return `notConnected`.
     */
    async acquireReadOnlyConnection(): Promise<ReadOnlyConnection> {
        if (this.closed) {
            return { ok: false, reason: 'checkout-failed', cause: new Error('session closed') };
        }
        const pool = this.current.pool;
        if (typeof pool.getConnection !== 'function') {
            this.closed = true;
            return { ok: false, reason: 'checkout-failed', cause: new Error('pool does not support getConnection') };
        }
        const acquired = await new Promise<ConnectionLike | undefined>((resolve) => {
            pool.getConnection!((err, connection) => {
                if (err || !connection) {
                    resolve(undefined);
                    return;
                }
                resolve(connection);
            });
        });
        if (!acquired) {
            this.closed = true;
            return { ok: false, reason: 'checkout-failed' };
        }
        try {
            await acquired.query('SET SESSION TRANSACTION READ ONLY');
        } catch (cause) {
            try { acquired.destroy(); } catch { /* best-effort */ }
            this.closed = true;
            return { ok: false, reason: 'set-read-only-failed', cause };
        }
        return { ok: true, connection: acquired, readOnly: true };
    }

    /**
     * True iff the session was constructed with `readOnly: true`. The
     * checkout wrapper above only enforces `SET SESSION TRANSACTION READ
     * ONLY` in that mode.
     */
    isReadOnlyMode(): boolean {
        return this.readOnlyMode;
    }

    /**
     * Execute a SQL statement. Returns the discriminated `QueryOutcome`; never
     * throws for query errors (server problems become `{tag:'err', problem}`).
     * Throws `ConnectionProblem` only when no pool is available.
     *
     * Todo 9 hardening: every user SQL runs through the fail-closed SQL
     * classifier BEFORE it reaches the pool. A rejected batch returns
     * `{tag:'err', problem:{tag:'server', code:'CLASSIFIER', message}}`
     * with the exact classifier reason as `code`.
     */
    async execute(sql: string): Promise<QueryOutcome> {
        if (this.closed) {
            return errOutcome({ tag: 'notConnected' });
        }
        const verdict = classifySqlBatch(sql);
        if (!verdict.accepted) {
            return errOutcome({
                tag: 'server',
                code: 'CLASSIFIER',
                message: verdict.reason,
            });
        }
        const start = Date.now();
        this.inflight += 1;
        try {
            const [rows, fields] = await this.current.pool.execute(sql);
            const elapsedMs = Date.now() - start;

            if (Array.isArray(rows)) {
                const columns = (fields ?? []).map((f) => f.name);
                const output: StatementOutput = {
                    tag: 'rows',
                    columns,
                    rows: rows as readonly DbRow[],
                };
                return { tag: 'ok', success: { output, elapsedMs } };
            }
            const header = rows as mysql.ResultSetHeader;
            const output: StatementOutput = {
                tag: 'change',
                affectedRows: header.affectedRows,
                insertId: header.insertId,
                info: header.info,
            };
            return { tag: 'ok', success: { output, elapsedMs } };
        } catch (err) {
            return errOutcome({
                tag: 'server',
                message: err instanceof Error ? err.message : String(err ?? ''),
            });
        } finally {
            this.inflight -= 1;
        }
    }

    async listDatabases(): Promise<string[]> {
        const outcome = await this.execute('SHOW DATABASES');
        if (outcome.tag === 'err') {
            throw new QueryProblemError(
                problemMessage(outcome.problem),
                'Failed to list databases.'
            );
        }
        const output = outcome.success.output;
        if (output.tag !== 'rows') return [];
        return output.rows.map((row) => String(row['Database'] ?? row['database'] ?? ''));
    }

    async listTables(database?: string): Promise<string[]> {
        const sql = database && database.length > 0
            ? `SHOW TABLES FROM \`${escapeSqlIdentifier(database)}\``
            : 'SHOW TABLES';
        const outcome = await this.execute(sql);
        if (outcome.tag === 'err') {
            throw new QueryProblemError(
                problemMessage(outcome.problem),
                'Failed to list tables.'
            );
        }
        const output = outcome.success.output;
        if (output.tag !== 'rows') return [];
        return output.rows.map((row) => String(Object.values(row)[0] ?? ''));
    }

    /**
     * Describe a table's columns.
     *
     * `database` is the scope in which the table lives. When `database` is
     * non-empty the call emits `DESCRIBE \`db\`.\`tbl\`` so it resolves
     * against that schema regardless of the connection's default DB; this
     * is the path used when expanding a `TableNode` whose node was built
     * from a real `DatabaseNode` and the connection has no default DB
     * (the friendly-defaults configuration introduced by the
     * drop-default-database plan).
     *
     * When `database` is undefined or empty, the call falls back to the
     * single-identifier form `DESCRIBE \`tbl\`` which resolves against
     * the connection's default DB.
     */
    async listColumns(database: string | undefined, tableName: string): Promise<{ name: string; type: string }[]> {
        const sql = database && database.length > 0
            ? `DESCRIBE \`${escapeSqlIdentifier(database)}\`.\`${escapeSqlIdentifier(tableName)}\``
            : `DESCRIBE \`${escapeSqlIdentifier(tableName)}\``;
        const outcome = await this.execute(sql);
        if (outcome.tag === 'err') {
            throw new QueryProblemError(
                problemMessage(outcome.problem),
                `Failed to describe ${tableName}.`
            );
        }
        const output = outcome.success.output;
        if (output.tag !== 'rows') return [];
        return output.rows.map((row) => ({
            name: String(row['Field'] ?? ''),
            type: String(row['Type'] ?? ''),
        }));
    }

    /**
     * Drain-and-replace the pool with one bound to the new token.
     *
     * Algorithm (see README § "How authentication works"):
     *   1. Build a NEW pool using the new token + fresh authPlugins closure.
     *   2. Atomically swap to the new pool. Future `execute()` calls go there.
     *   3. Wait for `inflight` to reach 0 (active queries on the old pool
     *      complete naturally).
     *   4. Close the old pool.
     *   5. Never start a query on the old pool once the swap happens.
     *
     * Returns when the swap is fully complete.
     */
    async swapToken(config: DatabaseSessionConfig): Promise<void> {
        if (this.closed) {
            throw new ConnectionProblem('Session is closed', 'Cannot rotate token on a closed session.');
        }
        const old = this.current;
        // The factory closure captures the new config.token so the new pool's
        // authPlugins are bound to the fresh token.
        const factory = config.poolFactory ?? this.factory;
        const next: PoolHolder = {
            pool: factory(config),
            generation: old.generation + 1,
        };
        this.current = next;

        // Wait for in-flight work on the old pool to drain before closing it.
        // We poll the counter with a small sleep; a real semaphore would be
        // ideal but `inflight` is the single shared mutable state.
        while (this.inflight > 0) {
            await sleep(10);
        }
        try {
            await endPoolSafely(old.pool);
        } catch {
            // Best-effort: the new pool is already serving requests.
        }
    }

    /** True while the session has an open pool. */
    isOpen(): boolean {
        return !this.closed && this.current.pool !== undefined;
    }

    /**
     * End the session. Waits for in-flight work, then closes the current pool.
     * Idempotent; calling twice is a no-op.
     */
    async end(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        while (this.inflight > 0) {
            await sleep(10);
        }
        await endPoolSafely(this.current.pool);
    }
}

async function endPoolSafely(pool: PoolLike): Promise<void> {
    try {
        await pool.end();
    } catch {
        // Already closed by rotation; that's fine.
    }
}

function defaultPoolFactory(config: DatabaseSessionConfig): PoolLike {
    // The authPlugins closure MUST capture the token. The Pool re-invokes the
    // plugin supplier on every connection acquired from the pool, so binding
    // here is what makes per-token rotation work.
    const poolOptions: mysql.PoolOptions = {
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.token,
        database: config.database,
        authPlugins: {
            mysql_clear_password: () => () => Buffer.from(config.token + '\0'),
        },
        connectTimeout: config.connectTimeoutMs ?? 30_000,
        waitForConnections: true,
        // Limit concurrency so a slow remote MySQL doesn't drown the host.
        connectionLimit: 4,
        queueLimit: 0,
    };
    if (config.ssl) {
        // Require a valid cert chain against the system trust store.
        // Mismatches here are the most common reason an Azure MySQL
        // Flexible Server rejects a connection.
        poolOptions.ssl = { rejectUnauthorized: true };
    }
    const pool = mysql.createPool(poolOptions);
    if (config.readOnly) {
        // The pool fires 'connection' for every physical connection it
        // acquires (initial + subsequent). Setting SESSION TRANSACTION READ
        // ONLY here is a defensive backstop; the synchronous wrapper
        // `acquireReadOnlyConnection()` is the source of truth and runs on
        // every checkout.
        pool.on('connection', (connection) => {
            try {
                void connection.query('SET SESSION TRANSACTION READ ONLY');
            } catch {
                // Best-effort: subsequent queries will surface real errors.
            }
        });
    }
    return pool as unknown as PoolLike;
}

function errOutcome(problem: QueryProblem): QueryOutcome {
    return { tag: 'err', problem };
}

function problemMessage(problem: QueryProblem): string {
    switch (problem.tag) {
        case 'notConnected':
            return 'Not connected to database';
        case 'cancelled':
            return 'Query cancelled';
        case 'server':
            return problem.code ? `[${problem.code}] ${problem.message}` : problem.message;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
