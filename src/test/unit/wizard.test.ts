/**
 * Tests for the server-registration form. The form validates user input
 * (port range, TLS semantics) BEFORE any state mutation, returning typed
 * outcomes (`ok | cancelled | invalid`). Callers persist on `ok` only.
 */

import * as assert from 'assert';
import {
    isValidTcpPort,
    collectNewServer,
    collectEditedServer,
    type FormPrompts,
} from '../../forms/connectionForm';
import { makeConnectionConfig } from '../factories/connectionConfig';

class FakePrompts implements FormPrompts {
    public readonly warnings: string[] = [];
    public confirmCalls: string[] = [];
    public confirmAnswer: boolean = false;
    private readonly inputs: (string | undefined)[];
    private readonly picks: (string | undefined)[];
    private inputIdx = 0;
    private pickIdx = 0;

    constructor(
        inputs: (string | undefined)[] = [],
        picks: (string | undefined)[] = []
    ) {
        this.inputs = inputs;
        this.picks = picks;
    }

    showInputBox = async (_options: {
        prompt: string;
        placeHolder?: string;
        value?: string;
    }): Promise<string | undefined> => {
        return this.inputs[this.inputIdx++];
    };

    showQuickPick = async <T extends string>(
        _items: readonly T[],
        _options: { placeHolder?: string }
    ): Promise<T | undefined> => {
        return this.picks[this.pickIdx++] as T | undefined;
    };

    reportWarning = (message: string): void => {
        this.warnings.push(message);
    };

    confirmPlaintext = async (host: string): Promise<boolean> => {
        this.confirmCalls.push(host);
        return this.confirmAnswer;
    };
}

suite('isValidTcpPort', () => {
    test('accepts 1 and 65535 as boundary ports', () => {
        assert.strictEqual(isValidTcpPort(1), true);
        assert.strictEqual(isValidTcpPort(65535), true);
    });
    test('rejects 0, negative, NaN, decimals, and > 65535', () => {
        assert.strictEqual(isValidTcpPort(0), false);
        assert.strictEqual(isValidTcpPort(-1), false);
        assert.strictEqual(isValidTcpPort(65536), false);
        assert.strictEqual(isValidTcpPort(3306.5), false);
        assert.strictEqual(isValidTcpPort(NaN), false);
        assert.strictEqual(isValidTcpPort(Number.POSITIVE_INFINITY), false);
    });
});

suite('collectNewServer', () => {
    test('happy path produces a typed config and uses the provided id', async () => {
        const prompts = new FakePrompts(
            [
                'production',
                'prod.example.com',
                '3306',
                'me@example.com',
            ],
            ['Encrypt (recommended)']
        );
        const result = await collectNewServer(prompts, () => 'srv-1');
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.config.id, 'srv-1');
        assert.strictEqual(result.config.name, 'production');
        assert.strictEqual(result.config.host, 'prod.example.com');
        assert.strictEqual(result.config.port, 3306);
        assert.strictEqual(result.config.user, 'me@example.com');
        assert.strictEqual(result.config.ssl, true);
        assert.strictEqual(prompts.warnings.length, 0);
    });

    test('cancellation at the name step yields cancelled', async () => {
        const prompts = new FakePrompts([undefined]);
        const result = await collectNewServer(prompts, () => 'srv-1');
        assert.strictEqual(result.tag, 'cancelled');
    });

    test('invalid port returns invalid with a sanitized message - no persistence', async () => {
        const prompts = new FakePrompts(['x', 'h', 'not-a-port'], []);
        const result = await collectNewServer(prompts, () => 'srv-1');
        assert.strictEqual(result.tag, 'invalid');
        if (result.tag !== 'invalid') throw new Error('unreachable');
        assert.match(result.message, /Port/);
        assert.match(result.message, /1/);
        assert.match(result.message, /65535/);
    });

    test('port 0, negative, decimal, and > 65535 all rejected', async () => {
        for (const bad of ['0', '-1', '3306.5', '65536', '99999']) {
            const prompts = new FakePrompts(['x', 'h', bad], []);
            const result = await collectNewServer(prompts, () => 'id');
            assert.strictEqual(result.tag, 'invalid', `expected ${bad} to be rejected`);
        }
    });

    test('preserves environment-like text literally', async () => {
        const prompts = new FakePrompts(
            ['${env:LABEL}', '${env:MYSQL_HOST}', '3306', '${env:USER}'],
            ['Encrypt (recommended)']
        );

        const result = await collectNewServer(prompts, () => 'id');

        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.config.name, '${env:LABEL}');
        assert.strictEqual(result.config.host, '${env:MYSQL_HOST}');
        assert.strictEqual(result.config.user, '${env:USER}');
    });

    test('Plaintext TLS pick on a non-Azure host returns ssl=false only after modal confirmation', async () => {
        const prompts = new FakePrompts(
            ['n', 'prod.example.com', '3306', 'u'],
            ['Plaintext']
        );
        prompts.confirmAnswer = true;
        const result = await collectNewServer(prompts, () => 'id');
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.config.ssl, false);
        assert.deepStrictEqual(prompts.confirmCalls, ['prod.example.com']);
        assert.strictEqual(prompts.warnings.length, 1);
        assert.match(prompts.warnings[0]!, /TLS/);
    });

    test('Plaintext TLS pick on a non-Azure host without modal confirmation defaults to TLS', async () => {
        const prompts = new FakePrompts(
            ['n', 'prod.example.com', '3306', 'u'],
            ['Plaintext']
        );
        // No modal sink wired and no confirmAnswer set -> form defaults to TLS.
        const result = await collectNewServer(prompts, () => 'id');
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.config.ssl, true);
    });

    test('Plaintext TLS pick on an Azure host is rejected and bounces the user to TLS-only retry', async () => {
        const prompts = new FakePrompts(
            ['n', 'prod.mysql.database.azure.com', '3306', 'u'],
            ['Plaintext', undefined]
        );
        const result = await collectNewServer(prompts, () => 'id');
        // The TLS-only retry quick-pick was dismissed, so the form returns cancelled.
        assert.strictEqual(result.tag, 'cancelled');
        assert.ok(prompts.warnings.some((w) => /mandatory/i.test(w)));
    });

    test('dismissed TLS quick-pick defaults to TLS (never silently plaintext)', async () => {
        const prompts = new FakePrompts(
            ['n', 'prod.example.com', '3306', 'u'],
            [undefined]
        );
        const result = await collectNewServer(prompts, () => 'id');
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.config.ssl, true);
    });
});

suite('collectEditedServer', () => {
    test('preserves existing TLS when quick-pick is dismissed', async () => {
        const existing = makeConnectionConfig({ id: 'srv-1', ssl: true });
        const prompts = new FakePrompts(
            [
                existing.name,
                existing.host,
                String(existing.port),
                existing.user,
            ],
            [undefined]
        );
        const result = await collectEditedServer(prompts, existing);
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.config.ssl, true);
        assert.strictEqual(prompts.warnings.length, 0);
    });

    test('changing TLS to Plaintext on a non-Azure host with confirmation returns ssl=false', async () => {
        const existing = makeConnectionConfig({ id: 'srv-1', ssl: true, host: 'prod.example.com' });
        const prompts = new FakePrompts(
            [
                existing.name,
                existing.host,
                String(existing.port),
                existing.user,
            ],
            ['Plaintext']
        );
        prompts.confirmAnswer = true;
        const result = await collectEditedServer(prompts, existing);
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.config.ssl, false);
        assert.strictEqual(prompts.warnings.length, 1);
    });

    test('changing TLS to Plaintext on an Azure host keeps TLS enabled', async () => {
        const existing = makeConnectionConfig({
            id: 'srv-1',
            ssl: true,
            host: 'prod.mysql.database.azure.com',
        });
        const prompts = new FakePrompts(
            [
                existing.name,
                existing.host,
                String(existing.port),
                existing.user,
            ],
            ['Plaintext']
        );
        const result = await collectEditedServer(prompts, existing);
        assert.strictEqual(result.tag, 'ok');
        if (result.tag !== 'ok') throw new Error('unreachable');
        assert.strictEqual(result.config.ssl, true);
        assert.ok(prompts.warnings.some((w) => /mandatory/i.test(w)));
    });

    test('cancellation at the name step yields cancelled', async () => {
        const existing = makeConnectionConfig();
        const prompts = new FakePrompts([undefined]);
        const result = await collectEditedServer(prompts, existing);
        assert.strictEqual(result.tag, 'cancelled');
    });

    test('invalid port returns invalid', async () => {
        const existing = makeConnectionConfig();
        const prompts = new FakePrompts(
            [existing.name, existing.host, '0', existing.user],
            []
        );
        const result = await collectEditedServer(prompts, existing);
        assert.strictEqual(result.tag, 'invalid');
    });
});