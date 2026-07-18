/**
 * Tests for the Todo 5 privacy policy.
 *
 * - Azure hosts reject plaintext at the form/connection boundary.
 * - Non-Azure hosts require a modal-confirm token (`plaintextConfirmed`)
 *   before accepting plaintext; the absence of the sink default to TLS.
 * - `GlobalStateConnectionCatalog.forgetServer(id)` removes both the
 *   connection record and the per-server query-history key from
 *   globalState.
 * - The in-memory Entra access token cache is not persisted to
 *   globalState, even across `deactivate()`.
 *
 * The test reuses the in-memory `vscode` mock and the stubbed mysql2
 * factory from `_setup.ts` so it runs without a real VS Code host.
 */

import * as assert from 'assert';
import {
    coerceReadOnly,
    GlobalStateConnectionCatalog,
    loadOrMigrateTestShim,
    queryHistoryKey,
    stripPersistedFields,
} from '../../registry/connectionCatalog';
import {
    collectNewServer,
    isAzureMysqlHost,
} from '../../forms/connectionForm';
import type { ConnectionConfig } from '../../domain';
import type { ExtensionContext } from 'vscode';
import { EntraTokenProvider } from '../../identity/entraToken';
import { CachedIdentityProvider } from '../../identity/entraToken';
import { ensureMysqlStubbed, restoreMysqlStub } from './_setup';
import { __test__, extensionContext } from '../mocks/vscode';
import type { TokenCredential, AccessToken } from '@azure/core-auth';

const AZURE_HOST = 'example.mysql.database.azure.com';
const NON_AZURE_HOST = 'mysql.internal.example.com';

function makeBaseConfig(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
    return {
        id: overrides.id ?? 'cfg-test',
        name: overrides.name ?? 'Test',
        host: overrides.host ?? AZURE_HOST,
        port: overrides.port ?? 3306,
        user: overrides.user ?? 'me@example.com',
        ssl: overrides.ssl ?? true,
        readOnly: overrides.readOnly,
    };
}

interface CapturedSinks {
    inputs: string[];
    picks: (string | undefined)[];
    warnings: string[];
    plaintextConfirmed?: boolean;
    confirmPlaintext?: (host: string) => Promise<boolean>;
}

function makeSinks(opts: CapturedSinks = { inputs: [], picks: [], warnings: [] }) {
    let inputIdx = 0;
    let pickIdx = 0;
    const sink = {
        showInputBox: async () => {
            const v = opts.inputs[inputIdx++];
            return v === undefined ? undefined : v;
        },
        showQuickPick: async () => {
            const v = opts.picks[pickIdx++];
            return v;
        },
        reportWarning: (message: string) => {
            opts.warnings.push(message);
        },
        ...(opts.confirmPlaintext
            ? { confirmPlaintext: opts.confirmPlaintext }
            : {}),
    };
    return {
        sinks: sink,
        opts,
        pickCount: () => pickIdx,
    };
}

suite('privacy', () => {
    test('isAzureMysqlHost matches canonical FQDN case-insensitively and rejects lookalikes', () => {
        assert.strictEqual(isAzureMysqlHost('example.mysql.database.azure.com'), true);
        assert.strictEqual(isAzureMysqlHost('EXAMPLE.MYSQL.DATABASE.AZURE.COM'), true);
        // Trailing dot is accepted (FQDN form).
        assert.strictEqual(isAzureMysqlHost('example.mysql.database.azure.com.'), true);
        // Lookalikes that only contain the suffix are NOT treated as Azure.
        assert.strictEqual(
            isAzureMysqlHost('example.mysql.database.azure.com.attacker.example'),
            false
        );
        assert.strictEqual(isAzureMysqlHost(NON_AZURE_HOST), false);
    });

    test('Azure host with ssl=false is rejected by the new-server form before reaching the catalog', async () => {
        ensureMysqlStubbed();
        try {
            const captured: CapturedSinks = { inputs: [], picks: [], warnings: [] };
            captured.inputs.push('analytics-prod', AZURE_HOST, '3306', 'me@example.com');
            captured.picks.push('Plaintext'); // explicit plaintext attempt
            const { sinks, opts, pickCount } = makeSinks(captured);
            const outcome = await collectNewServer(
                sinks,
                () => 'id-test'
            );
            // The form bounces Azure + plaintext to the TLS-only retry picker,
            // and a dismissal returns `cancelled` without producing a config.
            assert.strictEqual(outcome.tag, 'cancelled');
            // The TLS-only retry prompt is the second showQuickPick call.
            assert.strictEqual(pickCount(), 2);
            assert.ok(
                opts.warnings.some((w) => w.includes('mandatory') && w.includes(AZURE_HOST)),
                `expected mandatory TLS warning; got: ${opts.warnings.join(' | ')}`
            );
        } finally {
            restoreMysqlStub();
        }
    });

    test('non-Azure host with ssl=false requires a modal-confirm token before accepting plaintext', async () => {
        ensureMysqlStubbed();
        try {
            const captured: CapturedSinks = { inputs: [], picks: [], warnings: [] };
            captured.inputs.push('analytics-prod', NON_AZURE_HOST, '3306', 'me@example.com');
            captured.picks.push('Plaintext');
            // Without confirmPlaintext: form must default back to TLS.
            const noConfirm = makeSinks(captured).sinks;
            const outcomeNoConfirm = await collectNewServer(noConfirm, () => 'id-no-confirm');
            assert.strictEqual(outcomeNoConfirm.tag, 'ok');
            if (outcomeNoConfirm.tag === 'ok') {
                assert.strictEqual(outcomeNoConfirm.config.ssl, true);
            }

            // With confirmPlaintext = false: same result.
            const declined: CapturedSinks = {
                inputs: ['analytics-prod', NON_AZURE_HOST, '3306', 'me@example.com'],
                picks: ['Plaintext'],
                warnings: [],
                plaintextConfirmed: false,
                confirmPlaintext: async () => false,
            };
            const declinedSinks = makeSinks(declined).sinks;
            const outcomeDeclined = await collectNewServer(declinedSinks, () => 'id-declined');
            assert.strictEqual(outcomeDeclined.tag, 'ok');
            if (outcomeDeclined.tag === 'ok') {
                assert.strictEqual(outcomeDeclined.config.ssl, true);
            }

            // With confirmPlaintext = true: plaintext is allowed.
            const accepted: CapturedSinks = {
                inputs: ['analytics-prod', NON_AZURE_HOST, '3306', 'me@example.com'],
                picks: ['Plaintext'],
                warnings: [],
                plaintextConfirmed: true,
                confirmPlaintext: async () => true,
            };
            const acceptedSinks = makeSinks(accepted).sinks;
            const outcomeAccepted = await collectNewServer(acceptedSinks, () => 'id-accepted');
            assert.strictEqual(outcomeAccepted.tag, 'ok');
            if (outcomeAccepted.tag === 'ok') {
                assert.strictEqual(outcomeAccepted.config.ssl, false);
            }
        } finally {
            restoreMysqlStub();
        }
    });

    test('forgetServer(id) removes both the connection record and the per-server history key', async () => {
        __test__.reset();
        const ctx = extensionContext as unknown as Pick<ExtensionContext, 'globalState'>;

        const catalog = new GlobalStateConnectionCatalog(ctx);

        await catalog.add(makeBaseConfig({ id: 'cfg-A' }));
        await catalog.add(makeBaseConfig({ id: 'cfg-B' }));
        // Seed history for both ids.
        await ctx.globalState.update(queryHistoryKey('cfg-A'), [
            { sql: 'SELECT 1', executedAt: 1000 },
        ]);
        await ctx.globalState.update(queryHistoryKey('cfg-B'), [
            { sql: 'SELECT 2', executedAt: 1000 },
        ]);

        await catalog.forgetServer('cfg-A');

        const remaining = catalog.list().connections.map((c) => c.id);
        assert.deepStrictEqual(remaining, ['cfg-B']);
        assert.strictEqual(ctx.globalState.get(queryHistoryKey('cfg-A')), undefined);
        assert.ok(ctx.globalState.get(queryHistoryKey('cfg-B')));

        __test__.reset();
    });

    test('coerceReadOnly honours the user value: true preserved, false / missing collapse to false', () => {
        // Todo 6 flipped the contract from collapse-to-true to honour-user.
        // The catalog now keeps `readOnly: true` only when the user opted in;
        // any other persisted state collapses to `false` so the new opt-in
        // default takes effect.
        assert.strictEqual(coerceReadOnly(makeBaseConfig({ readOnly: true })).readOnly, true);
        assert.strictEqual(coerceReadOnly(makeBaseConfig({ readOnly: false })).readOnly, false);
        assert.strictEqual(coerceReadOnly(makeBaseConfig()).readOnly, false);
    });

    test('a checked readOnly preference survives GlobalStateConnectionCatalog save/reload', async () => {
        // Regression: the user explicitly checked "Open session in
        // read-only mode" on the connection form. That preference must
        // survive a save → fresh-catalog → list() round-trip through
        // globalState. Today it does NOT — `stripPersistedFields`
        // drops `readOnly` from the persisted shape, and `catalog.list()`
        // returns a record whose `readOnly` is missing (i.e. not
        // `true`). This test pins the desired behaviour so the fix
        // can be locked by a green.
        __test__.reset();
        try {
            const ctx =
                extensionContext as unknown as Pick<ExtensionContext, 'globalState'>;

            const catalog = new GlobalStateConnectionCatalog(ctx);
            await catalog.add(
                makeBaseConfig({ id: 'cfg-readonly-roundtrip', readOnly: true })
            );

            // Simulate a fresh extension activation: a new catalog
            // instance reading from the same globalState.
            const reloaded = new GlobalStateConnectionCatalog(ctx);
            const { connections, problems } = reloaded.list();
            assert.strictEqual(
                problems.length,
                0,
                `reloaded catalog reported parse problems: ${problems.join(' | ')}`
            );
            assert.strictEqual(connections.length, 1);
            const reloadedConfig = connections[0];
            assert.ok(reloadedConfig, 'reloaded connections should have one entry');
            assert.strictEqual(
                reloadedConfig.id,
                'cfg-readonly-roundtrip'
            );
            // The checked readOnly preference MUST survive the round-trip.
            assert.strictEqual(
                reloadedConfig.readOnly,
                true,
                `readOnly preference was lost across catalog save/reload; ` +
                    `got ${JSON.stringify(reloadedConfig)}`
            );

            // And the persisted shape on disk must also carry the
            // user-set flag — otherwise a downgrade / external read
            // could regress the user's choice.
            const persisted = ctx.globalState.get('connections') as
                | Array<Record<string, unknown>>
                | undefined;
            assert.ok(
                Array.isArray(persisted) && persisted.length === 1,
                `expected one persisted record; got: ${JSON.stringify(persisted)}`
            );
            const persistedRecord = persisted[0];
            assert.ok(persistedRecord, 'persisted record should exist');
            assert.strictEqual(
                persistedRecord.readOnly,
                true,
                `persisted record dropped readOnly; got: ${JSON.stringify(persistedRecord)}`
            );
        } finally {
            __test__.reset();
        }
    });

    test('stripPersistedFields preserves readOnly and drops only the legacy database field', () => {
        // Todo 6 flipped the policy: `readOnly` is now legitimate
        // persisted data — the user's opt-in preference must
        // round-trip through `globalState` so a fresh-catalog
        // rehydration does not silently downgrade their choice. The
        // legacy `database` field is the only field stripped today.
        const withReadOnly = makeBaseConfig({ readOnly: true });
        const stripped = stripPersistedFields(withReadOnly);
        assert.strictEqual('readOnly' in stripped, true);
        assert.strictEqual(stripped.readOnly, true);
        // The legacy `database` field is stripped (records persisted
        // by older releases may carry it; new records never do).
        const withLegacyDatabase = {
            ...makeBaseConfig({ readOnly: true }),
            database: 'appdb',
        } as ConnectionConfig & { readonly database?: string };
        const strippedLegacy = stripPersistedFields(withLegacyDatabase);
        assert.strictEqual('database' in strippedLegacy, false);
    });

    test('loadOrMigrateTestShim coerces stored readOnly and preserves it on disk', async () => {
        __test__.reset();
        const ctx = extensionContext as unknown as Pick<ExtensionContext, 'globalState'>;
        // Legacy payload with `readOnly: true` (pre-Todo 6 user opt-in).
        await ctx.globalState.update('connections', [
            { ...makeBaseConfig({ id: 'cfg-legacy' }), readOnly: true },
        ]);
        const catalog = new GlobalStateConnectionCatalog(ctx);
        const coerced = loadOrMigrateTestShim(catalog);
        assert.strictEqual(coerced.length, 1);
        assert.ok(coerced[0]);
        // Todo 6: the user's opt-in preference is honoured end-to-end.
        assert.strictEqual(coerced[0].readOnly, true);
        const persisted = ctx.globalState.get('connections') as Array<Record<string, unknown>>;
        assert.ok(persisted);
        assert.strictEqual(persisted.length, 1);
        const first = persisted[0];
        assert.ok(first);
        // `readOnly` IS persisted — the field must round-trip through
        // `globalState` so a fresh-catalog rehydration does not lose
        // the user's choice.
        assert.strictEqual('readOnly' in first, true);
        assert.strictEqual(first.readOnly, true);
        // The legacy `database` field, if present, must be stripped.
        assert.strictEqual('database' in first, false);

        __test__.reset();
    });

    test('in-memory Entra token cache is not present in globalState after deactivate()', async () => {
        __test__.reset();

        const sentinel = 'SENTINEL-ENTRA-TOKEN-DO-NOT-PERSIST';
        const fakeCredential: TokenCredential = {
            async getToken(): Promise<AccessToken> {
                return {
                    token: sentinel,
                    expiresOnTimestamp: Date.now() + 60_000,
                };
            },
        };
        const provider = new EntraTokenProvider({ primary: fakeCredential });
        await provider.getAccessToken();
        assert.strictEqual(await provider.isSignedIn(), true);

        // No key under globalState or secrets should ever carry the token.
        const stateKeys = extensionContext.globalState.keys();
        const flattened = stateKeys
            .map((key) => `${key}=${JSON.stringify(extensionContext.globalState.get(key))}`)
            .join('\n');
        assert.ok(
            !flattened.includes(sentinel),
            `globalState contained the sentinel token: ${flattened}`
        );
        assert.strictEqual(extensionContext.secrets.get('mysqlAzureAuth.token'), undefined);

        // Deactivate: clear the cache. globalState must still not hold it.
        provider.clearCache();
        assert.strictEqual(await provider.isSignedIn(), false);
        const afterDeactivate = extensionContext.globalState
            .keys()
            .map((key) => `${key}=${JSON.stringify(extensionContext.globalState.get(key))}`)
            .join('\n');
        assert.ok(
            !afterDeactivate.includes(sentinel),
            `globalState persisted the sentinel token across deactivate(): ${afterDeactivate}`
        );

        // The cached provider also exposes the helper used by the public API.
        const cached = new CachedIdentityProvider(fakeCredential);
        await cached.getToken(['https://example/.default']);
        assert.strictEqual(cached.hasCachedToken(), true);
        cached.clearCache();
        assert.strictEqual(cached.hasCachedToken(), false);

        __test__.reset();
    });
});