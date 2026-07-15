# Building & packaging

Quick reference for building MySQL Azure Auth from source.

## Prerequisites

- Node 20.x (CI runs on Node 20)
- npm 10+

## First-time setup

```bash
git clone <your-repo-url>
cd mysql-azure-auth
npm install
```

This installs all runtime and dev dependencies. The `@azure/identity`, `mysql2`, and `zod` packages are pulled in automatically.

## Build

```bash
npm run compile
```

This produces:
- `out/main.js` — the bundled extension (loaded by VS Code from `main` in `package.json`)
- `out/main.js.map` — source map
- `out/test/runTest.js` and `out/test/suite/index.js` — integration test harness

## Run the unit tests

```bash
npm run test:unit
```

Unit tests run in plain Node — no VS Code download required. They bundle a mock `vscode` module (see `src/test/mocks/vscode.ts`) and stub `mysql2/promise` via dependency injection (`MySqlClientOptions.poolFactory`).

97 unit tests run in under 50 ms.

## Run the integration tests

```bash
npm run test:integration
```

The first run downloads a portable VS Code (≈125 MB) into `.vscode-test/`. Subsequent runs reuse the cache.

The integration test boots a real VS Code instance, loads the bundled extension, calls `activate()` against a hand-built `ExtensionContext` (to bypass `extensionDependencies` for `ms-azuretools.vscode-azureresourcegroups`), and verifies every command is registered with the manifest.

## Run the full pipeline

```bash
npm test
```

Equivalent to: lint → typecheck → unit → integration.

## Package a .vsix

```bash
npm run package
```

Produces `mysql-azure-auth-<version>.vsix`. The output excludes `src/`, `node_modules/`, source maps, esbuild configs, `.github/`, `.vscode-test/`, and any test artifacts (see `.vscodeignore`).

To install locally:

```bash
code --install-extension mysql-azure-auth-0.1.0.vsix
```

To publish to the VS Code Marketplace:

```bash
npx @vscode/vsce publish
```

You'll need a publisher account and a Personal Access Token from <https://dev.azure.com>.

## Pre-publish check

```bash
npm run vscode:prepublish
```

Runs `esbuild --minify` against the production bundle. The VSIX packaging step also runs this implicitly.

## Troubleshooting

- **"Cannot find module 'vscode'" at runtime** — VS Code bundles the `vscode` module; this error means the extension is running outside an Extension Host. Run via `npm run test:integration` or use VS Code's "Run Extension" debug config.
- **`zod` parse errors on stored connections** — `src/registry/connectionCatalog.ts:parseStoredConnections` validates globalState on every read. Bad data is logged and ignored, never crashes the extension. To migrate, fix the saved entries in globalState manually (Settings → Extensions → MySQL Azure Auth → "Edit in settings.json") and reload.
- **Tests hang on shutdown** — every test that calls `connect()` on a `MySqlClient` must also call `disconnect()`. The 45-min refresh interval is `unref()`'d so it doesn't pin the Node event loop, but only after `disconnect()` clears it. Use the `makeClient()` helper from `src/test/unit/mysqlClient.test.ts` to register clients for auto-disconnect.
- **Integration test fails with "Cannot activate... unknown extension"** — expected; the test bypasses `activate()` by importing the bundled module directly. The error is from VS Code's own dependency resolver, not from our code.

## CI

The repository ships a GitHub Actions workflow at `.github/workflows/ci.yml` that runs the full pipeline on every push to `main` / `master` and on every pull request. It uses `xvfb-run` for the headless integration test step on Linux runners.