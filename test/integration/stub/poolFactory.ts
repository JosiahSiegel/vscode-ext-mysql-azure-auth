/**
 * Pool factory used by the integration test. Returns a `FakePool`
 * instance that validates the JWT on every query and returns canned
 * results for the queries the extension exercises.
 *
 * This is the right abstraction level for the test: we want to
 * validate the extension's auth + dispatch logic (EntraTokenProvider,
 * DatabaseSession, SQL classifier, swapToken rotation) without
 * exercising the MySQL wire protocol itself (which is mysql2's
 * responsibility). A real `mysqld` would catch different bugs
 * (wire format compatibility) and is a different test.
 *
 * The JWT validation function is injected so the test can swap
 * validators (valid / expired / wrong-audience) without rebuilding
 * the pool.
 */

import type { PoolLike, DatabaseSessionConfig } from '../../src/registry/databaseSession';
import { FakePool, FakePoolOptions } from './fakePool';

export function makeStubMysqlPoolFactory(
    opts: FakePoolOptions
): (config: DatabaseSessionConfig) => PoolLike {
    return function stubMysqlPoolFactory(config: DatabaseSessionConfig): PoolLike {
        return new FakePool(config.token, opts) as unknown as PoolLike;
    };
}
