/**
 * Pool factory used by the integration test. Mirrors the production
 * `defaultPoolFactory` exactly (with the same custom
 * `authPlugins.mysql_clear_password` closure) so the test exercises
 * the actual production wire flow: the auth-switch dance.
 */

import * as mysql from 'mysql2/promise';
import type { PoolLike, DatabaseSessionConfig } from '../../src/registry/databaseSession';
import type { Pool } from 'mysql2/promise';

export function stubMysqlPoolFactory(config: DatabaseSessionConfig): PoolLike {
    const pool = mysql.createPool({
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
        connectionLimit: 4,
        queueLimit: 0,
    });
    return pool as unknown as PoolLike;
}

void ({} as Pool);
