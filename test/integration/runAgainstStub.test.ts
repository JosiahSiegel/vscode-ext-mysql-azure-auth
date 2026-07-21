/**
 * End-to-end integration test for the Entra MySQL auth path.
 *
 * This test exercises the extension's auth + dispatch logic
 * (EntraTokenProvider, DatabaseSession, SQL classifier, swapToken
 * rotation) without depending on a real MySQL server. It uses a
 * `FakePool` (test/integration/stub/fakePool.ts) that:
 *   - Validates the JWT on every query against a test-owned public key
 *   - Returns canned results for the queries the extension exercises
 *   - Mirrors mysql2's Pool shape: `execute(sql)` -> `[rows, fields]`,
 *     `getConnection(cb)`, `end()`, `on()`
 *
 * Why a fake pool instead of a real mysqld or wire-protocol stub?
 *   - Real mysqld: would require a running mysqld + a way to make it
 *     validate JWTs. mysqld doesn't have `mysql_clear_password` as a
 *     built-in default, and writing a custom C auth plugin is out of
 *     scope for this test.
 *   - Wire-protocol stub: every attempt ran into MySQL protocol
 *     subtleties (sequence counters, column-def byte layout, prepared
 *     statement vs text protocol). The test was testing mysql2, not
 *     the extension.
 *
 * The fake pool tests what we actually care about: that the extension
 * passes a valid JWT to the pool, that the SQL classifier blocks
 * disallowed statements before they reach the pool, and that
 * `swapToken` correctly rebinds the pool.
 */

import * as assert from 'assert';
import type { TokenCredential, AccessToken } from '@azure/core-auth';
import { EntraTokenProvider } from '../../src/identity/entraToken';
import { DatabaseSession, DatabaseSessionConfig } from '../../src/registry/databaseSession';
import {
    generateStubKeyPair,
    signStubJwt,
    STUB_TENANT_ID,
    STUB_OID,
    STUB_UPN,
    AZURE_MYSQL_ENTRA_AUDIENCE,
} from './stub/jwt';
import { makeStubMysqlPoolFactory } from './stub/poolFactory';
import { verifyStubJwt } from './stub/jwt';

const STUB_USER = STUB_UPN;

interface StubCredOptions {
    jwt: string;
    expiresAt: number;
}

function makeStubTokenCredential(opts: StubCredOptions): TokenCredential {
    return {
        async getToken(): Promise<AccessToken> {
            return { token: opts.jwt, expiresOnTimestamp: opts.expiresAt };
        },
    };
}

interface Harness {
    keyPair: ReturnType<typeof generateStubKeyPair>;
    jwt: string;
    expiresAt: number;
    callCounts: { total: number; ok: number; rejected: number; lastReject: string | null };
    poolFactory: ReturnType<typeof makeStubMysqlPoolFactory>;
}

function setupHarness(jwtOverride?: { jwt: string; expiresAt: number }): Harness {
    const keyPair = generateStubKeyPair();
    const signed = jwtOverride
        ? { jwt: jwtOverride.jwt, expiresAt: jwtOverride.expiresAt }
        : signStubJwt(keyPair, {
              tenantId: STUB_TENANT_ID,
              oid: STUB_OID,
              upn: STUB_UPN,
          });
    const callCounts = { total: 0, ok: 0, rejected: 0, lastReject: null as string | null };
    const poolFactory = makeStubMysqlPoolFactory({
        validateToken: (token: string) => {
            callCounts.total += 1;
            const result = verifyStubJwt(token, keyPair.publicKey);
            if (!result.ok) {
                callCounts.rejected += 1;
                callCounts.lastReject = result.reason;
                return { ok: false, reason: result.reason };
            }
            const aud = result.payload['aud'];
            if (aud !== AZURE_MYSQL_ENTRA_AUDIENCE) {
                callCounts.rejected += 1;
                callCounts.lastReject = 'audience mismatch';
                return { ok: false, reason: 'audience mismatch' };
            }
            callCounts.ok += 1;
            return { ok: true };
        },
    });
    return {
        keyPair,
        jwt: signed.jwt,
        expiresAt: signed.expiresAt * 1000,
        callCounts,
        poolFactory,
    };
}

function makeSessionConfig(harness: Harness, token: string): DatabaseSessionConfig {
    return {
        host: 'fake.local',
        port: 3306,
        database: 'test_db',
        user: STUB_USER,
        ssl: false,
        token,
        poolFactory: harness.poolFactory,
    };
}

suite('Entra MySQL auth integration', () => {
    test('connects with a valid Entra JWT and runs SELECT 1', async () => {
        const h = setupHarness();
        const cred = makeStubTokenCredential({ jwt: h.jwt, expiresAt: h.expiresAt });
        const provider = new EntraTokenProvider({ primary: cred, fallback: cred, log: () => {} });
        const session = new DatabaseSession(makeSessionConfig(h, await provider.getAccessToken()));
        try {
            const outcome = await session.execute('SELECT 1');
            assert.strictEqual(outcome.tag, 'ok', `expected ok, got ${JSON.stringify(outcome)}`);
            if (outcome.tag === 'ok') {
                const out = outcome.success.output;
                assert.strictEqual(out.tag, 'rows');
                if (out.tag === 'rows') {
                    assert.strictEqual(out.rows.length, 1);
                    assert.strictEqual(String(out.rows[0]['1']), '1');
                }
            }
        } finally {
            await session.end();
        }
        assert.strictEqual(h.callCounts.ok, 1);
        assert.strictEqual(h.callCounts.rejected, 0);
    });

    test('rejects an expired JWT with access denied', async () => {
        const h = setupHarness();
        const expired = signStubJwt(h.keyPair, {
            tenantId: STUB_TENANT_ID,
            oid: STUB_OID,
            upn: STUB_UPN,
            now: Math.floor(Date.now() / 1000) - 7200,
            expiresInSec: 60,
        });
        const cred = makeStubTokenCredential({
            jwt: expired.jwt,
            expiresAt: Date.now() + 3600_000, // cache says valid; pool is the source of truth
        });
        const provider = new EntraTokenProvider({ primary: cred, fallback: cred, log: () => {} });
        const session = new DatabaseSession(makeSessionConfig(h, await provider.getAccessToken()));
        try {
            const outcome = await session.execute('SELECT 1');
            assert.strictEqual(outcome.tag, 'err', 'expected error from expired JWT');
            if (outcome.tag === 'err') {
                assert.strictEqual(outcome.problem.tag, 'server');
            }
        } finally {
            try { await session.end(); } catch { /* ignore */ }
        }
        assert.strictEqual(h.callCounts.rejected, 1);
        assert.match(h.callCounts.lastReject ?? '', /expired/);
    });

    test('rejects a JWT with the wrong audience', async () => {
        const h = setupHarness();
        const wrongAud = signStubJwt(h.keyPair, {
            tenantId: STUB_TENANT_ID,
            oid: STUB_OID,
            upn: STUB_UPN,
            audience: 'https://management.azure.com/.default',
        });
        const cred = makeStubTokenCredential({ jwt: wrongAud.jwt, expiresAt: wrongAud.expiresAt * 1000 });
        const provider = new EntraTokenProvider({ primary: cred, fallback: cred, log: () => {} });
        const session = new DatabaseSession(makeSessionConfig(h, await provider.getAccessToken()));
        try {
            const outcome = await session.execute('SELECT 1');
            assert.strictEqual(outcome.tag, 'err');
        } finally {
            try { await session.end(); } catch { /* ignore */ }
        }
        assert.match(h.callCounts.lastReject ?? '', /audience/);
    });

    test('listDatabases returns the rowset after auth', async () => {
        const h = setupHarness();
        const cred = makeStubTokenCredential({ jwt: h.jwt, expiresAt: h.expiresAt });
        const provider = new EntraTokenProvider({ primary: cred, fallback: cred, log: () => {} });
        const session = new DatabaseSession(makeSessionConfig(h, await provider.getAccessToken()));
        try {
            const dbs = await session.listDatabases();
            assert.deepStrictEqual(dbs, ['information_schema', 'mysql']);
        } finally {
            await session.end();
        }
    });

    test('swapToken rotates the auth closure and runs another query', async () => {
        const h = setupHarness();
        const cred = makeStubTokenCredential({ jwt: h.jwt, expiresAt: h.expiresAt });
        const provider = new EntraTokenProvider({ primary: cred, fallback: cred, log: () => {} });
        const initialToken = await provider.getAccessToken();
        const session = new DatabaseSession(makeSessionConfig(h, initialToken));
        try {
            const first = await session.execute('SELECT 1');
            assert.strictEqual(first.tag, 'ok');

            // Sign a new token (different iat) and rotate. The
            // signature changes because the payload changes, so the
            // token strings differ.
            const rotated = signStubJwt(h.keyPair, {
                tenantId: STUB_TENANT_ID,
                oid: STUB_OID,
                upn: STUB_UPN,
                now: Math.floor(Date.now() / 1000) - 60, // 1 min ago
            });
            const newToken = rotated.jwt;
            assert.notStrictEqual(newToken, initialToken, 'token should have rotated');

            await session.swapToken(makeSessionConfig(h, newToken));

            const second = await session.execute('SELECT 1');
            assert.strictEqual(second.tag, 'ok');
        } finally {
            await session.end();
        }
        // Two successful pool operations: initial + post-rotation.
        assert.ok(h.callCounts.ok >= 2, `expected at least 2 successful calls, got ${h.callCounts.ok}`);
    });

    test('classifier rejects disallowed SQL before the wire', async () => {
        const h = setupHarness();
        const cred = makeStubTokenCredential({ jwt: h.jwt, expiresAt: h.expiresAt });
        const provider = new EntraTokenProvider({ primary: cred, fallback: cred, log: () => {} });
        const session = new DatabaseSession(makeSessionConfig(h, await provider.getAccessToken()));
        try {
            const before = h.callCounts.total;
            const outcome = await session.execute('DROP TABLE foo');
            assert.strictEqual(outcome.tag, 'err');
            if (outcome.tag === 'err') {
                assert.strictEqual(outcome.problem.tag, 'server');
                if (outcome.problem.tag === 'server') {
                    assert.strictEqual(outcome.problem.code, 'CLASSIFIER');
                }
            }
            const after = h.callCounts.total;
            // No new pool call should have happened for the rejected statement.
            assert.strictEqual(after, before, 'classifier rejection must not touch the pool');
        } finally {
            await session.end();
        }
    });

    test('concurrent connections handled independently', async () => {
        const h = setupHarness();
        const cred = makeStubTokenCredential({ jwt: h.jwt, expiresAt: h.expiresAt });
        const provider = new EntraTokenProvider({ primary: cred, fallback: cred, log: () => {} });
        const token = await provider.getAccessToken();
        const sessions = [
            new DatabaseSession(makeSessionConfig(h, token)),
            new DatabaseSession(makeSessionConfig(h, token)),
            new DatabaseSession(makeSessionConfig(h, token)),
        ];
        try {
            const results = await Promise.all(sessions.map((s) => s.execute('SELECT 1')));
            for (const r of results) {
                assert.strictEqual(r.tag, 'ok');
            }
            assert.ok(h.callCounts.ok >= 3, `expected at least 3 successful calls, got ${h.callCounts.ok}`);
        } finally {
            await Promise.all(sessions.map((s) => s.end()));
        }
    });
});
