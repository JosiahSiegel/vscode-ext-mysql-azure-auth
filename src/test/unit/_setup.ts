/**
 * Shared setup that stubs mysql2/promise's createConnection with a no-op
 * factory. Tests that exercise mysql queries override the per-call fake.
 */

import * as sinon from 'sinon';

let mysqlStubHandle: ReturnType<typeof stubMysql2> | null = null;

function stubMysql2() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mysqlModule = require('mysql2/promise');
    const orig = mysqlModule.createConnection;
    return {
        restore: () => {
            mysqlModule.createConnection = orig;
        },
        stubCreate: (impl: typeof orig) => {
            mysqlModule.createConnection = impl;
        },
    };
}

export function ensureMysqlStubbed() {
    if (mysqlStubHandle) return mysqlStubHandle;
    mysqlStubHandle = stubMysql2();
    mysqlStubHandle.stubCreate(async () => ({
        execute: async () => [[], []],
        end: async () => undefined,
    }));
    return mysqlStubHandle;
}

export function restoreMysqlStub() {
    if (mysqlStubHandle) {
        mysqlStubHandle.restore();
        mysqlStubHandle = null;
    }
}

// Silence "unused import" warning for sinon (it's re-exported for convenience).
export type { sinon };