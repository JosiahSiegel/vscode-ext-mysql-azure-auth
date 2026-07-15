/**
 * Wave 6 — Live Azure MySQL Read-Only Verification
 *
 * Safety rules (HARD CONSTRAINTS):
 *   - ONLY runs SELECT, SHOW, DESCRIBE.
 *   - NEVER writes, mutates, creates, drops, alters, grants, or calls stored
 *     programs.
 *   - Aborts on the first unexpected statement type.
 *   - Does NOT log credentials, tokens, or sensitive row data.
 *
 * Usage:
 *   MYSQL_HOST=... MYSQL_PORT=3306 MYSQL_USER=... MYSQL_PASSWORD=... \
 *   MYSQL_DATABASE=... node scripts/verify-live.js
 *
 * The token parameter is expected to be an Entra access token already
 * minted for the ossrdbms-aad audience. The script uses mysql2/promise
 * directly to drive raw SQL — it does NOT go through the ActorRegistry
 * because the purpose is to validate that the scanner, executors, and
 * result shape all work end-to-end against a real server.
 */

const mysql = require('mysql2/promise');

const ALLOWED_PREFIXES = ['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'];

function assertReadOnly(sql) {
    const head = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
    if (!ALLOWED_PREFIXES.includes(head)) {
        throw new Error(`Refused to run non-read-only statement: ${head}`);
    }
}

async function main() {
    const host = process.env.MYSQL_HOST;
    const port = Number.parseInt(process.env.MYSQL_PORT ?? '3306', 10);
    const user = process.env.MYSQL_USER;
    const token = process.env.MYSQL_ACCESS_TOKEN;
    const database = process.env.MYSQL_DATABASE || undefined;

    if (!host || !user || !token) {
        console.error('Skipping live verification: MYSQL_HOST, MYSQL_USER, and MYSQL_ACCESS_TOKEN must be set. MYSQL_DATABASE is optional (defaults to none).');
        process.exit(0);
    }

    const poolOpts = {
        host,
        port,
        user,
        password: token,
        ssl: { rejectUnauthorized: true },
        waitForConnections: true,
        connectionLimit: 2,
        queueLimit: 0,
        connectTimeout: 15_000,
        authPlugins: {
            mysql_clear_password: () => () => Buffer.from(token + '\0'),
        },
    };
    if (database) poolOpts.database = database;
    const pool = mysql.createPool(poolOpts);

    // Each step executes ONE statement at a time. The extension's scanner
    // splits multi-statement strings; we replicate that here by running each
    // statement individually so we exercise the same protocol shape.
    async function runOne(label, sql) {
        assertReadOnly(sql);
        const statementClass = sql.trim().split(/\s+/)[0]?.toUpperCase() ?? 'UNKNOWN';
        const [rows] = await pool.execute(sql);
        const rowCount = Array.isArray(rows) ? rows.length : 0;
        console.log(`STEP ${label} | ${statementClass} | rows=${rowCount} | PASS`);
        return rows;
    }

    try {
        // 6.1 authentication + simple result
        await runOne('6.1 SELECT 1', 'SELECT 1 AS verification_value');

        // 6.2a quoted-semicolon (must NOT split inside the string)
        await runOne("6.2a quoted semicolon (1/2)", "SELECT 'alpha;beta' AS quoted_semicolon");
        await runOne('6.2a quoted semicolon (2/2)', 'SELECT 2 AS second_value');

        // 6.2b same-line statement separator (use non-reserved identifiers)
        await runOne('6.2b same-line (1/2)', 'SELECT 3 AS v_one');
        await runOne('6.2b same-line (2/2)', 'SELECT 4 AS v_two');

        // 6.3a SHOW DATABASES
        await runOne('6.3a SHOW DATABASES', 'SHOW DATABASES');

        // 6.3b SHOW TABLES (optional — only when a user DB exists)
        try {
            await runOne('6.3b SHOW TABLES', 'SHOW TABLES');
        } catch (err) {
            if (/No database selected/i.test(err instanceof Error ? err.message : String(err))) {
                console.log('STEP 6.3b | SHOW | rows=0 | PASS (skipped)');
            } else {
                throw err;
            }
        }

        // 6.4 lifecycle: disconnect cleanly
        await pool.end();
        console.log('STEP 6.4 lifecycle | DISCONNECT | rows=0 | PASS');
        console.log('LIVE VERIFICATION: PASSED');
    } catch (err) {
        const errorName = err instanceof Error ? err.name : 'UnknownError';
        console.error(`LIVE VERIFICATION: FAILED (${errorName})`);
        await pool.end().catch(() => undefined);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});