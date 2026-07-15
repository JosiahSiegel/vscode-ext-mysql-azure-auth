/**
 * Regression tests for the openSession command.
 *
 * The original code attempted to fall back to the now-deprecated Azure
 * Account extension's `azure-account.login` command. That command ID no
 * longer exists in modern VS Code (Azure Account was deprecated in 2025);
 * calling it produced a cryptic error. The rewrite uses the
 * `@azure/identity` chain (VS Code's built-in Microsoft auth provider +
 * `AzureCliCredential`) for sign-in.
 *
 * These tests cover both branches:
 *   - signed in -> straight to the connect (no UI prompt).
 *   - not signed in -> warn that the next step prompts, then attempt.
 *   - source code never references the deprecated `azure-account.login`.
 */

import * as assert from 'assert';
import { __test__ } from '../mocks/vscode';
import { openSession } from '../../commands/openSession';
import { ActorRegistry } from '../../registry/actorRegistry';
import {
    EntraTokenProvider,
} from '../../identity/entraToken';
import type { ConnectionConfig } from '../../domain';
import type { DatabaseSessionConfig, PoolFactory, PoolLike } from '../../registry/databaseSession';
import { makeConnectionConfig } from '../factories/connectionConfig';
import * as fs from 'fs';
import * as path from 'path';
import * as sinon from 'sinon';

function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
} {
    let resolvePromise: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function buildFakePool(): PoolFactory {
    return (_config: DatabaseSessionConfig): PoolLike => ({
        execute: async () => [[], []],
        end: async () => undefined,
    });
}

class RecordingUi {
    public warnings: string[] = [];
    public informations: string[] = [];
    public errors: string[] = [];
    public progressTitle: string | undefined;
    public progressCount = 0;

    /**
     * `showWarning` models the production behaviour: real VS Code
     * `showWarningMessage` returns a `Thenable` that DOES NOT resolve
     * until the user dismisses the popup. Awaiting this promise would
     * freeze `openSession` indefinitely. Tests assert that `openSession`
     * never awaits these calls.
     */
    showWarning = (msg: string): Promise<string | undefined> => {
        this.warnings.push(msg);
        return new Promise(() => undefined);
    };
    showInformation = (msg: string): Promise<string | undefined> => {
        this.informations.push(msg);
        return new Promise(() => undefined);
    };
    showError = (msg: string): Promise<string | undefined> => {
        this.errors.push(msg);
        return new Promise(() => undefined);
    };
    withProgress = async <T>(
        options: import('vscode').ProgressOptions,
        task: (progress: import('vscode').Progress<{ message?: string; increment?: number }>) => Promise<T>
    ): Promise<T> => {
        this.progressCount += 1;
        this.progressTitle = options.title;
        return task({ report: () => undefined });
    };
}

suite('openSession (regression: azure-account.login)', () => {
    let sandbox: sinon.SinonSandbox;

    setup(() => {
        sandbox = sinon.createSandbox();
        __test__.reset();
        __test__.resetAuth();
        __test__.setNextSession({
            id: 's',
            accessToken: 'tok',
            account: { id: 'a', label: 'l' },
            scopes: [],
        });
    });

    teardown(() => {
        sandbox.restore();
        __test__.reset();
        __test__.resetAuth();
    });

    test('connects without prompting when an Azure session already exists', async () => {
        // Prime the cache so isSignedIn() returns true.
        const identity = new EntraTokenProvider();
        await identity.getAccessToken();

        const registry = new ActorRegistry({ identity, poolFactory: buildFakePool() });
        const ui = new RecordingUi();
        const config = makeConnectionConfig({ id: 'cfg-1' });

        await openSession({ registry, identity, ui }, config);

        assert.strictEqual(ui.warnings.length, 0, 'no warning expected when already signed in');
        assert.ok(ui.progressTitle && ui.progressTitle.includes('Negotiating TLS'));
        assert.ok(
            ui.informations.some((m) => m.includes('Connected')),
            'expected success notification'
        );
    });

    test('rapid same-id calls share one progress and connect operation', async () => {
        const identity = new EntraTokenProvider();
        sandbox.stub(identity, 'isSignedIn').resolves(true);
        sandbox.stub(identity, 'getAccessToken').resolves('token');
        const registry = new ActorRegistry({ poolFactory: buildFakePool() });
        const connectStarted = deferred<void>();
        const connectGate = deferred<void>();
        const connect = sandbox.stub(registry, 'connect').callsFake(() => {
            connectStarted.resolve(undefined);
            return connectGate.promise;
        });
        const ui = new RecordingUi();
        const config = makeConnectionConfig({ id: 'cfg-1' });

        const first = openSession({ registry, identity, ui }, config);
        const duplicate = openSession({ registry, identity, ui }, config);

        try {
            await connectStarted.promise;
            assert.strictEqual(ui.progressCount, 1);
            assert.strictEqual(connect.callCount, 1);
        } finally {
            connectGate.resolve(undefined);
            await Promise.all([first, duplicate]);
        }
    });

    test('same-id call retries after the shared operation settles', async () => {
        const identity = new EntraTokenProvider();
        sandbox.stub(identity, 'isSignedIn').resolves(true);
        sandbox.stub(identity, 'getAccessToken').resolves('token');
        const registry = new ActorRegistry({ poolFactory: buildFakePool() });
        const firstConnectStarted = deferred<void>();
        const firstConnect = deferred<void>();
        const connect = sandbox.stub(registry, 'connect');
        connect.onFirstCall().callsFake(() => {
            firstConnectStarted.resolve(undefined);
            return firstConnect.promise;
        });
        connect.onSecondCall().resolves();
        const ui = new RecordingUi();
        const config = makeConnectionConfig({ id: 'cfg-1' });

        const first = openSession({ registry, identity, ui }, config);

        try {
            await firstConnectStarted.promise;
        } finally {
            firstConnect.resolve(undefined);
            await first;
        }
        await openSession({ registry, identity, ui }, config);

        assert.strictEqual(ui.progressCount, 2);
        assert.strictEqual(connect.callCount, 2);
    });

    test('acquires an access token before connecting the registry', async () => {
        // Given an injected identity and registry that record their observable call order.
        const callOrder: string[] = [];
        const identity = new EntraTokenProvider();
        sandbox.stub(identity, 'isSignedIn').resolves(true);
        sandbox.stub(identity, 'getAccessToken').callsFake(async () => {
            callOrder.push('identity.getAccessToken');
            return 'token';
        });
        const registry = new ActorRegistry({ poolFactory: buildFakePool() });
        sandbox.stub(registry, 'connect').callsFake(async () => {
            callOrder.push('registry.connect');
        });
        const ui = new RecordingUi();
        const config = makeConnectionConfig({ id: 'cfg-1' });

        // When opening the session.
        await openSession({ registry, identity, ui }, config);

        // Then the command explicitly acquires identity before registry connection.
        assert.deepStrictEqual(callOrder, [
            'identity.getAccessToken',
            'registry.connect',
        ]);
    });

    test('cold connect reaches VS Code interactive authentication without azure-account.login', async () => {
        // Given an unprimed identity shared by the command and registry.
        const identity = new EntraTokenProvider();
        const registry = new ActorRegistry({ identity, poolFactory: buildFakePool() });
        const ui = new RecordingUi();
        const config = makeConnectionConfig({ id: 'cfg-1' });

        try {
            // When opening the session.
            await openSession({ registry, identity, ui }, config);

            // Then VS Code interactive auth is reached and the connection succeeds.
            const sessionCalls = __test__.getSessionCalls();
            assert.strictEqual(sessionCalls.length, 1);
            assert.strictEqual(sessionCalls[0]?.providerId, 'microsoft');
            assert.strictEqual(sessionCalls[0]?.options.createIfNone, true);
            assert.strictEqual(registry.isConnected(config.id), true);
            assert.strictEqual(ui.warnings.length, 1);
            assert.match(ui.warnings[0] ?? '', /Azure session/);
            assert.ok(ui.informations.some((message) => message.includes('Connected')));
            assert.strictEqual(
                __test__.executedCommands.some(({ command }) => command === 'azure-account.login'),
                false
            );
        } finally {
            await registry.disconnectAll();
            identity.clearCache();
        }
    });

    test('warns the user when no session exists but never calls azure-account.login', async () => {
        // Don't prime the cache - isSignedIn() returns false.
        const identity = new EntraTokenProvider();
        const registry = new ActorRegistry({ identity, poolFactory: buildFakePool() });
        const ui = new RecordingUi();
        const config = makeConnectionConfig({ id: 'cfg-1' });

        // Use a wrapper that records any command we ever try to execute,
        // so we can assert that `azure-account.login` is NEVER invoked.
        const executedCommands: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscodeMock = require('vscode');
        const origExecuteCommand = vscodeMock.commands.executeCommand;
        vscodeMock.commands.executeCommand = async (cmd: string) => {
            executedCommands.push(cmd);
            return undefined;
        };

        try {
            await openSession({ registry, identity, ui }, config);
        } finally {
            vscodeMock.commands.executeCommand = origExecuteCommand;
            await registry.disconnectAll();
            identity.clearCache();
        }

        // The warning fires.
        assert.strictEqual(ui.warnings.length, 1);
        assert.match(ui.warnings[0]!, /Azure session/);

        // The deprecated command is never invoked.
        assert.ok(
            !executedCommands.some((c) => c === 'azure-account.login'),
            `azure-account.login must NOT be called; executed: ${executedCommands.join(', ')}`
        );
    });

    test('surfaces a connection error if the pool factory throws', async () => {
        const identity = new EntraTokenProvider();
        sandbox.stub(identity, 'getAccessToken').resolves('token');
        // The factory itself fails - simulates a DNS resolution error or
        // TLS handshake refusal that happens during pool construction.
        const failingRegistry = new ActorRegistry({
            identity,
            poolFactory: (): PoolLike => {
                throw new Error('TLS handshake refused');
            },
        });
        const ui = new RecordingUi();
        const config = makeConnectionConfig({ id: 'cfg-1' });

        await openSession({ registry: failingRegistry, identity, ui }, config);

        assert.strictEqual(ui.errors.length, 1, 'expected exactly one error notification');
        assert.match(ui.errors[0]!, /TLS handshake refused/);
        assert.strictEqual(ui.informations.length, 0, 'no success notification on error');
    });
});

suite('Source-code sweep: no azure-account.login reference', () => {
    test('no source file references the deprecated azure-account.login command', () => {
        // Walk src/ and assert no production code mentions the deprecated
        // command. This is a literal text sweep - if anyone reintroduces the
        // call, the test fails.
        const offenders: string[] = [];
        function walk(dir: string) {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) {
                    if (ent.name === 'node_modules' || ent.name === 'test') continue;
                    walk(p);
                } else if (p.endsWith('.ts')) {
                    const text = fs.readFileSync(p, 'utf8');
                    if (text.includes('azure-account.login')) {
                        offenders.push(p);
                    }
                }
            }
        }
        walk(path.resolve(__dirname, '..', '..'));
        assert.deepStrictEqual(
            offenders,
            [],
            `azure-account.login must not appear in production code; found in: ${offenders.join(', ')}`
        );
    });
});