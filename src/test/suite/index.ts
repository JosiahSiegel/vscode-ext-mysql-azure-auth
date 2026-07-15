/**
 * Test loader for @vscode/test-electron. Discovers *.test.js in the compiled
 * out/ tree (both unit and extension tests) and hands them to Mocha.
 *
 * This file is compiled by esbuild as part of `npm run compile` because it
 * sits outside the test/ directory exclusion (it IS the entry point).
 */

import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

export function run(): Promise<void> {
    const mocha = new Mocha({
        reporter: 'spec',
        timeout: 60_000,
        color: true,
        ui: 'tdd',
    });

    // Only load *.integration.test.js (compiled from *-integration.test.ts)
    // plus the top-level extension.test.ts. The unit-test bundles under
    // out/test/unit/ ship with an embedded vscode mock and MUST NOT be
    // loaded inside the real VS Code host - their mock would shadow the
    // real API and the test assertions would test the mock, not the
    // extension. Unit tests run in plain Node via runUnitTests.js.
    const testsRoot = path.resolve(__dirname, '..');

    return new Promise((resolve, reject) => {
        glob('**/*.integration.test.js', { cwd: testsRoot }).then(
            (files: string[]) => {
                files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

                try {
                    mocha.run((failures: number) => {
                        if (failures > 0) {
                            reject(new Error(`${failures} tests failed.`));
                        } else {
                            resolve();
                        }
                    });
                } catch (err) {
                    reject(err);
                }
            },
            (err: unknown) => reject(err)
        );
    });
}