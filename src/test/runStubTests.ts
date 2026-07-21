/**
 * Minimal mocha-like runner for the stub integration test.
 *
 * The esbuild bundle for `runAgainstStub.test.ts` exports a top-level
 * `suite`/`test` structure (mocha-style). This script loads mocha,
 * registers the test file, and runs it. We do not depend on a VS Code
 * host; everything runs in plain Node.
 *
 * Exit code 0 on success, 1 on failure (matches the convention used by
 * `npm run test:unit`).
 */

import * as path from 'path';
import Mocha from 'mocha';

async function main(): Promise<void> {
    const mocha = new Mocha({
        reporter: 'spec',
        timeout: 30_000,
        color: true,
        ui: 'tdd',
    });
    const testFile = path.resolve(__dirname, '..', '..', 'test', 'integration', 'runAgainstStub.test.js');
    mocha.addFile(testFile);
    if (process.env['STUB_MYSQL_MYSQL2_DEBUG']) {
        process.env['MYSQL2_DEBUG'] = '1';
    }
    await new Promise<void>((resolve) => {
        mocha.run((failures) => {
            process.exitCode = failures === 0 ? 0 : 1;
            resolve();
        });
    });
}

void main();
