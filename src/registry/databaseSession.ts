/**
 * DatabaseSession - the typed port over mysql2.
 *
 * The port exposes ONLY what the rest of the extension needs:
 *   - execute(sql) -> QueryOutcome  (discriminated union, no stringly-typed errors)
 *   - listDatabases() / listTables() / listColumns(table)
 *   - end() -> Promise<void>
 *
 * Internally each session owns an `mysql.Pool` and an `authPlugins` closure
 * bound to the CURRENT token. The pool is replaced wholesale when the token
 * rotates; the old pool drains in-flight work before being closed.
 *
 * We do NOT use `connection.changeUser()`. It is broken for
 * `mysql_clear_password` token auth (mysql2 issue #3350); see README §
 * "How authentication works" for the full rationale.
 */

import * as mysql from 'mysql2/promise';
import {
    QueryOutcome,
    QuerySuccess,
    StatementOutput,
    QueryProblem,
    DbRow,
} from '../domain';
import { ConnectionProblem, QueryProblemError } from '../problems';
import { escapeSqlIdentifier } from '../views/sqlStatements';

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
     * The setting is applied via the pool's `connection` event so it covers
     * fresh pools AND every connection acquired later from the pool. Token
     * rotations build a fresh pool, which re-fires the listener, so the
     * guarantee survives rotation.
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
 * `onConnection` is optional — the production `mysql2` pool implements it
 * (inherited from EventEmitter). Test fakes can omit it because they don't
 * simulate real network session state.
 */
export interface PoolLike {
    execute(sql: string): Promise<[unknown[], mysql.FieldPacket[] | undefined]>;
    end(): Promise<void>;
    onConnection?: (listener: (connection: { query: (sql: string) => unknown }) => void) => void;
}

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

    constructor(config: DatabaseSessionConfig) {
        this.factory = config.poolFactory ?? defaultPoolFactory;
        this.current = {
            pool: this.factory(config),
            generation: 0,
        };
    }

    /**
     * Execute a SQL statement. Returns the discriminated `QueryOutcome`; never
     * throws for query errors (server problems become `{tag:'err', problem}`).
     * Throws `ConnectionProblem` only when no pool is available.
     */
    async execute(sql: string): Promise<QueryOutcome> {
        if (this.closed) {
            return errOutcome({ tag: 'notConnected' });
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

    async listTables(): Promise<string[]> {
        const outcome = await this.execute('SHOW TABLES');
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

    async listColumns(tableName: string): Promise<{ name: string; type: string }[]> {
        const outcome = await this.execute(`DESCRIBE \`${escapeSqlIdentifier(tableName)}\``);
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
        poolOptions.ssl = { rejectUnauthorized: true };
    }
    const pool = mysql.createPool(poolOptions);
    if (config.readOnly) {
        // The pool fires 'connection' for every physical connection it
        // acquires (initial + subsequent). Setting SESSION TRANSACTION READ
        // ONLY here guarantees read-only mode for every query that touches
        // this pool, including catalog reads (SHOW DATABASES etc.) and every
        // statement across a multi-statement user script.
        //
        // mysql2's promise pool wraps the underlying connection; the
        // 'connection' event surfaces the raw connection which exposes
        // .query(). We issue the SET and ignore any error — if the server
        // doesn't support it, the next query will surface a clearer error
        // anyway.
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