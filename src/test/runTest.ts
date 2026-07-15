/**
 * Entry point for the integration test runner.
 *
 * Boots a real VS Code instance (downloaded by @vscode/test-electron on first
 * run), installs the compiled extension, and runs the Mocha suite defined in
 * suite/index.ts.
 *
 * Usage:  node out/test/runIntegrationTests.js
 */

import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    try {
        const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
        const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');

        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            // Stable, broadly available build for headless CI.
            version: '1.85.0',
            launchArgs: [
                '--disable-gpu',
                '--no-sandbox',
                // Headless / CI-friendly flags
                '--disable-dev-shm-usage',
            ],
        });
    } catch (err) {
        console.error('Failed to run integration tests:', err);
        process.exit(1);
    }
}

main();