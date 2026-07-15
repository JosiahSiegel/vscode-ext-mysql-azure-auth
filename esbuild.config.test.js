// Bundles unit tests + the embedded vscode mock into CommonJS output.
// The mock file is injected as the `vscode` module via esbuild's `alias` option,
// so production code's `import * as vscode from 'vscode'` resolves to the mock.

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const testRoot = path.join(__dirname, 'src', 'test', 'unit');
const unitOutDir = path.join(__dirname, 'out', 'test', 'unit');
const runnerOutDir = path.join(__dirname, 'out', 'test');
const mockPath = path.join(__dirname, 'src', 'test', 'mocks', 'vscode.ts');

fs.mkdirSync(unitOutDir, { recursive: true });
fs.mkdirSync(runnerOutDir, { recursive: true });

const testEntries = fs
    .readdirSync(testRoot)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => path.join(testRoot, f));

if (testEntries.length === 0) {
    console.error(`No test files found in ${testRoot}`);
    process.exit(1);
}

// First build: the unit-test bundles (mock embedded).
const testsBuild = esbuild.build({
    entryPoints: testEntries,
    outdir: unitOutDir,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    alias: {
        // Production code uses `import * as vscode from 'vscode'`. For unit
        // tests we substitute our in-memory mock so the modules can be
        // loaded in plain Node without a VS Code host.
        vscode: mockPath,
    },
    external: [],
    logLevel: 'info',
});

// Second build: the unit-test runner. Lives at out/test/runUnitTests.js.
// Externalize mocha so we load it from node_modules at runtime; do NOT alias
// vscode here because the runner doesn't import it.
const runnerBuild = esbuild.build({
    entryPoints: [path.join(__dirname, 'src', 'test', 'runUnitTests.ts')],
    outdir: runnerOutDir,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: true,
    external: ['mocha'],
    logLevel: 'info',
});

Promise.all([testsBuild, runnerBuild]).then(
    () => {
        console.log(
            `Built ${testEntries.length} test bundle(s) into ${unitOutDir} and runner into ${runnerOutDir}`
        );
    },
    (err) => {
        console.error('esbuild failed:', err);
        process.exit(1);
    }
);