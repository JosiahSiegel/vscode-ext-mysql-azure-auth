/**
 * Standalone unit-test runner.
 *
 * Loads every bundled *.test.js in out/test/unit and runs them through Mocha.
 * Avoids the @vscode/test-electron dependency for unit tests, so this runs
 * in plain Node and is fast enough to be a pre-commit / pre-PR gate.
 */

import * as path from 'path';
import * as fs from 'fs';
import Mocha from 'mocha';

const testDir = path.join(__dirname, 'unit');

if (!fs.existsSync(testDir)) {
    console.error(
        `Test output directory not found: ${testDir}\n` +
            `Run \`npm run build:test\` first.`
    );
    process.exit(1);
}

const testFiles = fs
    .readdirSync(testDir)
    .filter((f: string) => f.endsWith('.test.js'))
    .sort();

if (testFiles.length === 0) {
    console.error(`No bundled test files found in ${testDir}`);
    process.exit(1);
}

// TDD UI exposes `suite`/`test`/`setup`/`teardown`/`suiteTeardown` globals,
// which matches the style used in the VS Code extension sample tests.
const mocha = new Mocha({
    reporter: 'spec',
    timeout: 10_000,
    color: true,
    ui: 'tdd',
});

for (const file of testFiles) {
    mocha.addFile(path.join(testDir, file));
}

mocha.run((failures: number) => {
    process.exitCode = failures > 0 ? 1 : 0;
});