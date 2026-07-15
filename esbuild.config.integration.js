// Bundles integration test entry points (runTest.ts, suite/index.ts, and
// extension.test.ts) so they end up under out/test/. These are what
// @vscode/test-electron loads at run time.
//
// IMPORTANT: unlike the unit-test build, `vscode` is externalized here so
// the test file imports the REAL vscode API provided by the Extension Host.
// The unit-test bundle (esbuild.config.test.js) injects an in-memory mock
// for the `vscode` module via esbuild alias; those unit bundles must NOT be
// loaded inside the real VS Code host because their mock would shadow the
// real API. The suite loader only discovers extension.test.js from this
// output dir.

const esbuild = require('esbuild');
const path = require('path');

const outDir = path.join(__dirname, 'out', 'test');

esbuild
    .build({
        entryPoints: [
            path.join(__dirname, 'src', 'test', 'runTest.ts'),
            path.join(__dirname, 'src', 'test', 'suite', 'index.ts'),
            path.join(__dirname, 'src', 'test', 'extension.integration.test.ts'),
        ],
        outdir: outDir,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        sourcemap: true,
        external: ['vscode', 'mocha', 'glob', '@vscode/test-electron'],
        logLevel: 'info',
    })
    .then(
        () => console.log(`Built integration test entries into ${outDir}`),
        (err) => {
            console.error('Integration test build failed:', err);
            process.exit(1);
        }
    );