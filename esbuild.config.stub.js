// Bundles the stub-MySQL integration test (test/integration/runAgainstStub.test.ts)
// into out/test/integration/ with the same vscode-mock aliasing strategy
// used by the unit-test build (esbuild.config.test.js).
//
// The stub test does not import `vscode` directly, but it pulls in
// src/identity/entraToken.ts which in turn imports src/identity/vscodeAuth.ts.
// That chain resolves `import * as vscode from 'vscode'` which we redirect
// to src/test/mocks/vscode.ts so the test loads in plain Node without a
// VS Code host.

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const outDir = path.join(__dirname, 'out', 'test', 'integration');
const mockPath = path.join(__dirname, 'src', 'test', 'mocks', 'vscode.ts');
const entry = path.join(__dirname, 'test', 'integration', 'runAgainstStub.test.ts');
const runnerEntry = path.join(__dirname, 'src', 'test', 'runStubTests.ts');

fs.mkdirSync(outDir, { recursive: true });

esbuild
    .build({
        entryPoints: [entry, runnerEntry],
        outdir: outDir,
        bundle: true,
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        sourcemap: true,
        alias: {
            vscode: mockPath,
        },
        external: ['mocha'],
        logLevel: 'info',
    })
    .then(
        () => console.log(`Built stub integration test into ${outDir}`),
        (err) => {
            console.error('esbuild failed:', err);
            process.exit(1);
        }
    );
