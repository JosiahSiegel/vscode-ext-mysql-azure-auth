/**
 * Integration test - runs inside a real VS Code host via @vscode/test-electron.
 * Verifies that activate() registers all the commands declared in package.json.
 *
 * Unit tests in ./unit/*.test.ts run in plain Node with a vscode mock; this
 * file is the safety net that catches mismatches between the bundled
 * main.js and the manifest (command id typos, missing activation
 * handlers, etc.).
 *
 * NOTE: We invoke activate() with a hand-built ExtensionContext so we can
 * run even when `extensionDependencies` references an extension that the
 * test environment does not have installed (e.g. the Azure Resources
 * extension that this extension declares in its manifest). VS Code blocks
 * activation when an extensionDependencies entry is missing, so we bypass
 * that path entirely.
 */

import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

// Load the bundled extension module directly. esbuild produces a single
// CJS file at out/main.js with `vscode` externalized, so `require()`
// resolves to the real VS Code API at runtime inside the test host.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const extensionModule = require(path.resolve(__dirname, '..', 'main.js'));

suite('Extension integration', () => {
    test('activate() registers every command declared in package.json', async () => {
        // Build a minimal ExtensionContext that satisfies the activation code.
        // Only the fields touched by activate() are populated.
        const subscriptions: vscode.Disposable[] = [];
        const fakeContext = {
            subscriptions,
            globalState: {
                get: <T>(_key: string, defaultValue?: T) =>
                    defaultValue as T | undefined,
                update: async (_key: string, _value: unknown) => undefined,
                keys: () => [] as readonly string[],
            },
            extensionUri: vscode.Uri.file(__dirname),
            extensionPath: path.resolve(__dirname, '..', '..'),
            asAbsolutePath: (p: string) =>
                path.resolve(__dirname, '..', '..', p),
        } as unknown as vscode.ExtensionContext;

        // Invoke the real activate() against the fake context.
        await extensionModule.activate(fakeContext);

        // After activate() runs, every registered command must appear in
        // the registry. Pass `true` to include internal commands.
        const registered = await vscode.commands.getCommands(true);

        const expected = [
            'mysqlAzureAuth.registerServer',
            'mysqlAzureAuth.forgetServer',
            'mysqlAzureAuth.editServer',
            'mysqlAzureAuth.connectServer',
            'mysqlAzureAuth.disconnectServer',
            'mysqlAzureAuth.openWorkbench',
            'mysqlAzureAuth.refreshAll',
            'mysqlAzureAuth.previewRows',
            'mysqlAzureAuth.viewMoreRows',
        ];

        const missing = expected.filter((cmd) => !registered.includes(cmd));
        assert.deepStrictEqual(
            missing,
            [],
            `Expected commands missing from the registry: ${missing.join(', ')}`
        );
    });

    test('deactivate() is exported and callable without throwing', () => {
        assert.strictEqual(
            typeof extensionModule.deactivate,
            'function',
            'main.js must export deactivate()'
        );
        assert.doesNotThrow(() => extensionModule.deactivate());
    });
});