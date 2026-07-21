/**
 * End-to-end integration test for the Entra MySQL auth path.
 *
 * The test stands up a real MySQL wire-protocol stub on a random
 * localhost port. The stub is a minimal server that:
 *   - advertises `mysql_clear_password` as the default auth plugin
 *   - parses the JWT the client sends in the auth slot
 *   - verifies the JWT against a test-owned public key
 *   - accepts a small set of well-known queries
 *
 * The test composes the real `EntraTokenProvider` facade with a stub
 * primary/fallback credential. The facade hands the resulting JWT to
 * the real `DatabaseSession` (which uses `mysql2` under the hood with
 * the production `authPlugins.mysql_clear_password` callback).
 *
 * The test therefore exercises the FULL auth path end-to-end:
 *   EntraTokenProvider -> @azure/identity chain -> JWT -> mysql2
 *     -> mysql_clear_password plugin -> stub MySQL -> JWT verify
 *
 * The test uses a custom `poolFactory` that sets
 * `enableCleartextPlugin: true` so mysql2 will send the JWT directly
 * instead of going through the auth-switch dance. The production
 * `defaultPoolFactory` does NOT set this flag; the test exercises
 * the same JWT-on-the-wire path, just without the auth-switch
 * indirection. (mysql2 v3 ships a security guard against cleartext
 * passwords that has to be explicitly opted into for this flow.)
 */

import * as assert from 'assert';
import type { TokenCredential, AccessToken } from '@azure/core-auth';
import {
    EntraTokenProvider,
} from '../../src/identity/entraToken';
import { DatabaseSession, DatabaseSessionConfig } from '../../src/registry/databaseSession';
import { generateStubKeyPair, signStubJwt } from './stub/jwt';
import { startStubMysql, StubMysqlHandle } from './stub/mysqlStub';
import { stubMysqlPoolFactory } from './stub/poolFactory';

const STUB_TENANT_ID = '11111111-2222-3333-4444-555555555555';
const STUB_OID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const STUB_UPN = 'test-user@stub-tenant.example.com';
const STUB_USER = 'test-user@stub-tenant.example.com';

interface StubCredOptions {
    jwt: string;
    expiresAt: number;
}

/**
 * A TokenCredential that returns a pre-baked JWT and refuses to refresh.
 * Mirrors the shape of the real VSCodeIdentitySource (token + expiry).
 */
function makeStubTokenCredential(opts: StubCredOptions): TokenCredential {
    return {
        async getToken(): Promise<AccessToken> {
            return {
                token: opts.jwt,
                expiresOnTimestamp: opts.expiresAt,
            };
        },
    };
}

function makeSessionConfig(
    stub: StubMysqlHandle,
    token: string
): DatabaseSessionConfig {
    return {
        host: stub.host,
        port: stub.port,
        database: 'test_db',
        user: STUB_USER,
        ssl: false,
        token,
        poolFactory: stubMysqlPoolFactory
    };
}

suite('Entra MySQL auth integration', () => {
    let stub: StubMysqlHandle | undefined;
    let keyPair: ReturnType<typeof generateStubKeyPair>;
    let currentJwt: { value: string; expiresAt: number };
    setup(async () => {
        keyPair = generateStubKeyPair();
        const signed = signStubJwt(keyPair, {
            tenantId: STUB_TENANT_ID,
            oid: STUB_OID,
            upn: STUB_UPN,
        });
        currentJwt = { value: signed.jwt, expiresAt: signed.expiresAt * 1000 };        stub = await startStubMysql({
            keyPair,
            tenantId: STUB_TENANT_ID,
            database: 'test_db',
            authTimeoutMs: 5000
        });
    });

    teardown(async () => {
        if (stub) {
            await stub.close();
            stub = undefined;
        }    });

    test('connects with a valid Entra JWT and runs SELECT 1', async () => {
        assert.ok(stub, 'stub should be running');
        const cred = makeStubTokenCredential({
            jwt: currentJwt.value,
            expiresAt: currentJwt.expiresAt,
        });
        const provider = new EntraTokenProvider({
            primary: cred,
            fallback: cred,
            log: () => { /* silent */ },
        });
        const session = new DatabaseSession(
            makeSessionConfig(stub, await provider.getAccessToken())
        );
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
        assert.strictEqual(stub.authAttempts(), 1, 'expected exactly 1 auth attempt');
        assert.strictEqual(stub.authSuccesses(), 1, 'expected auth to succeed');
        assert.strictEqual(stub.lastUsername(), STUB_USER);
    });

    test('rejects an expired JWT with access denied', async () => {
        assert.ok(stub, 'stub should be running');
        const expired = signStubJwt(keyPair, {
            tenantId: STUB_TENANT_ID,
            oid: STUB_OID,
            upn: STUB_UPN,
            now: Math.floor(Date.now() / 1000) - 7200,
            expiresInSec: 60, // expired 2 hours ago
        });
        const cred = makeStubTokenCredential({
            jwt: expired.jwt,
            expiresAt: Date.now() + 3600_000, // cache says valid; server is the source of truth
        });
        const provider = new EntraTokenProvider({
            primary: cred,
            fallback: cred,
            log: () => { /* silent */ },
        });
        const session = new DatabaseSession(
            makeSessionConfig(stub, await provider.getAccessToken())
        );
        try {
            const outcome = await session.execute('SELECT 1');
            assert.strictEqual(outcome.tag, 'err', 'expected error from expired JWT');
            if (outcome.tag === 'err') {
                assert.strictEqual(outcome.problem.tag, 'server');
            }
        } finally {
            try { await session.end(); } catch { /* ignore */ }
        }
        assert.strictEqual(stub.authSuccesses(), 0, 'no handshake should have succeeded');
        assert.match(stub.lastRejectReason() ?? '', /expired/);
    });

    test('rejects a JWT with the wrong audience', async () => {
        assert.ok(stub, 'stub should be running');
        const wrongAud = signStubJwt(keyPair, {
            tenantId: STUB_TENANT_ID,
            oid: STUB_OID,
            upn: STUB_UPN,
            audience: 'https://management.azure.com/.default',
        });
        const cred = makeStubTokenCredential({
            jwt: wrongAud.jwt,
            expiresAt: wrongAud.expiresAt * 1000,
        });
        const provider = new EntraTokenProvider({
            primary: cred,
            fallback: cred,
            log: () => { /* silent */ },
        });
        const session = new DatabaseSession(
            makeSessionConfig(stub, await provider.getAccessToken())
        );
        try {
            const outcome = await session.execute('SELECT 1');
            assert.strictEqual(outcome.tag, 'err');
        } finally {
            try { await session.end(); } catch { /* ignore */ }
        }
        assert.match(stub.lastRejectReason() ?? '', /audience/);
    });

    test('listDatabases returns the stub rowset after auth', async () => {
        assert.ok(stub, 'stub should be running');
        const cred = makeStubTokenCredential({
            jwt: currentJwt.value,
            expiresAt: currentJwt.expiresAt,
        });
        const provider = new EntraTokenProvider({
            primary: cred,
            fallback: cred,
            log: () => { /* silent */ },
        });
        const session = new DatabaseSession(
            makeSessionConfig(stub, await provider.getAccessToken())
        );
        try {
            const dbs = await session.listDatabases();
            assert.deepStrictEqual(dbs, ['information_schema', 'mysql', 'test_db']);
        } finally {
            await session.end();
        }
    });

    test('swapToken rotates the auth closure and runs another query', async () => {
        assert.ok(stub, 'stub should be running');
        const cred = makeStubTokenCredential({
            jwt: currentJwt.value,
            expiresAt: currentJwt.expiresAt,
        });
        const provider = new EntraTokenProvider({
            primary: cred,
            fallback: cred,
            log: () => { /* silent */ },
        });
        const initialToken = await provider.getAccessToken();
        const session = new DatabaseSession(
            makeSessionConfig(stub, initialToken)
        );
        try {
            const first = await session.execute('SELECT 1');
            assert.strictEqual(first.tag, 'ok');

            // Sign a new token (e.g. after a 50-min mark) and rotate.
            const rotated = signStubJwt(keyPair, {
                tenantId: STUB_TENANT_ID,
                oid: STUB_OID,
                upn: STUB_UPN,
                now: Math.floor(Date.now() / 1000) + 3000, // 50 minutes in the future
            });
            currentJwt.value = rotated.jwt;
            currentJwt.expiresAt = rotated.expiresAt * 1000;
            const newToken = await provider.getAccessToken();
            assert.notStrictEqual(newToken, initialToken, 'token should have rotated');

            await session.swapToken(makeSessionConfig(stub, newToken));

            const second = await session.execute('SELECT 1');
            assert.strictEqual(second.tag, 'ok');
        } finally {
            await session.end();
        }
        // Two successful handshakes: initial connection + rotation.
        assert.ok(stub.authSuccesses() >= 2, `expected at least 2 successful handshakes, got ${stub.authSuccesses()}`);
    });

    test('classifier rejects disallowed SQL before the wire', async () => {
        assert.ok(stub, 'stub should be running');
        const cred = makeStubTokenCredential({
            jwt: currentJwt.value,
            expiresAt: currentJwt.expiresAt,
        });
        const provider = new EntraTokenProvider({
            primary: cred,
            fallback: cred,
            log: () => { /* silent */ },
        });
        const session = new DatabaseSession(
            makeSessionConfig(stub, await provider.getAccessToken())
        );
        try {
            const before = stub.authSuccesses();
            const outcome = await session.execute('DROP TABLE foo');
            assert.strictEqual(outcome.tag, 'err');
            if (outcome.tag === 'err') {
                assert.strictEqual(outcome.problem.tag, 'server');
                if (outcome.problem.tag === 'server') {
                    assert.strictEqual(outcome.problem.code, 'CLASSIFIER');
                }
            }
            const after = stub.authSuccesses();
            // No new handshake should have happened for the rejected statement.
            assert.strictEqual(after, before, 'classifier rejection must not touch the wire');
        } finally {
            await session.end();
        }
    });

    test('stub MySQL handles concurrent connections independently', async () => {
        assert.ok(stub, 'stub should be running');
        const cred = makeStubTokenCredential({
            jwt: currentJwt.value,
            expiresAt: currentJwt.expiresAt,
        });
        const provider = new EntraTokenProvider({
            primary: cred,
            fallback: cred,
            log: () => { /* silent */ },
        });
        const token = await provider.getAccessToken();
        const sessions = [
            new DatabaseSession(makeSessionConfig(stub!, token)),
            new DatabaseSession(makeSessionConfig(stub!, token)),
            new DatabaseSession(makeSessionConfig(stub!, token)),
        ];
        try {
            const results = await Promise.all(
                sessions.map((s) => s.execute('SELECT 1'))
            );
            for (const r of results) {
                assert.strictEqual(r.tag, 'ok');
            }
            assert.ok(stub.authSuccesses() >= 3, `expected 3 successful handshakes, got ${stub.authSuccesses()}`);
        } finally {
            await Promise.all(sessions.map((s) => s.end()));
        }
    });
});
