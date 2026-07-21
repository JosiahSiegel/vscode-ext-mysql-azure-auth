/**
 * Fake mysql2 Pool for the integration test. Returns canned results
 * for the queries the extension exercises and a configurable JWT
 * validation policy so the test can assert the auth path.
 *
 * This is the right abstraction level for the integration test: we
 * want to validate the extension's auth code (Entra token
 * acquisition, pool creation, query dispatch) without exercising
 * the MySQL wire protocol itself (mysql2's job). A real `mysqld` is
 * a different test and would catch different bugs.
 *
 * Supported queries (case-insensitive, normalized):
 *   "SELECT 1"               -> [[{1: 1}], [{name: '1'}]]
 *   "SELECT 1+1 AS sum"      -> [[{sum: 2}], [{name: 'sum'}]]
 *   "SELECT DATABASE()"      -> [[{d: 'mysql'}], [{name: 'd'}]]
 *   "SELECT @@version_comment" -> [['stub-mysql'], ['v']]
 *   "SHOW DATABASES"         -> [[{Database: 'mysql'}], [{name: 'Database'}]]
 *   "SET SESSION TRANSACTION READ ONLY" -> [[{affectedRows: 0}], []]
 *   anything starting with DROP / DELETE / UPDATE / INSERT (not in allowlist) -> rejects
 *
 * The token is validated on every query so negative tests (expired
 * JWT, wrong audience) fail at the FakePool, mirroring how a real
 * Azure MySQL Flexible Server's AAD plugin would reject them.
 */

export interface FakePoolOptions {
    validateToken: (token: string) => { ok: true } | { ok: false; reason: string };
    allowedHosts?: string[]; // optional host whitelist
}

export class FakePool {
    private token: string;
    private opts: FakePoolOptions;
    private closed = false;

    constructor(initialToken: string, opts: FakePoolOptions) {
        this.token = initialToken;
        this.opts = opts;
    }

    /** mysql2 Pool.execute(sql) -> [rows, fields]. */
    async execute(sql: string): Promise<[unknown[], unknown[]]> {
        if (this.closed) {
            throw new Error('pool is closed');
        }
        const verdict = this.opts.validateToken(this.token);
        if (!verdict.ok) {
            const err = new Error(`access denied: ${verdict.reason}`);
            (err as any).code = 'ER_ACCESS_DENIED';
            throw err;
        }
        const normalized = sql.replace(/\s+/g, ' ').trim().toUpperCase();
        if (normalized === 'SELECT 1') {
            return [[{ '1': 1 }], [{ name: '1' }]] as any;
        }
        if (normalized === 'SELECT 1+1 AS SUM' || normalized === 'SELECT 1 + 1 AS SUM') {
            return [[{ sum: 2 }], [{ name: 'sum' }]] as any;
        }
        if (normalized === 'SELECT DATABASE()') {
            return [[{ d: 'mysql' }], [{ name: 'd' }]] as any;
        }
        if (normalized === 'SELECT @@VERSION_COMMENT') {
            return [['stub-mysql'], [{ name: '@@version_comment' }]] as any;
        }
        if (normalized === 'SHOW DATABASES') {
            return [[{ Database: 'information_schema' }, { Database: 'mysql' }], [{ name: 'Database' }]] as any;
        }
        if (normalized === 'SET SESSION TRANSACTION READ ONLY') {
            return [[{ affectedRows: 0 }], []] as any;
        }
        const err = new Error(`FakePool: unsupported query: ${sql}`);
        (err as any).code = 'ER_NOT_SUPPORTED_YET';
        throw err;
    }

    async query(sql: string, params?: unknown[]): Promise<[unknown[], unknown[]]> {
        return this.execute(sql);
    }

    /** mysql2 Pool.getConnection(cb). */
    getConnection(cb: (err: Error | null, conn: FakeConnection | null) => void): void {
        const verdict = this.opts.validateToken(this.token);
        if (!verdict.ok) {
            cb(new Error(`access denied: ${verdict.reason}`), null);
            return;
        }
        cb(null, new FakeConnection(this.token, this.opts));
    }

    async end(): Promise<void> {
        this.closed = true;
    }

    on(_event: string, _handler: (...args: unknown[]) => void): void {
        // No-op for the test.
    }

    removeAllListeners(): void {
        // No-op.
    }
}

export class FakeConnection {
    private token: string;
    private opts: FakePoolOptions;

    constructor(token: string, opts: FakePoolOptions) {
        this.token = token;
        this.opts = opts;
    }

    async query(sql: string): Promise<[unknown[], unknown[]]> {
        const verdict = this.opts.validateToken(this.token);
        if (!verdict.ok) {
            const err = new Error(`access denied: ${verdict.reason}`);
            (err as any).code = 'ER_ACCESS_DENIED';
            throw err;
        }
        if (sql === 'SET SESSION TRANSACTION READ ONLY') {
            return [[{ affectedRows: 0 }], []] as any;
        }
        const err = new Error(`FakeConnection: unsupported query: ${sql}`);
        (err as any).code = 'ER_NOT_SUPPORTED_YET';
        throw err;
    }

    async execute(sql: string): Promise<[unknown[], unknown[]]> {
        return this.query(sql);
    }

    destroy(): void {
        // No-op.
    }

    release(): void {
        // No-op.
    }
}
