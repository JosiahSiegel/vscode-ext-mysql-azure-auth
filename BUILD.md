# Building & packaging

Quick reference for building MySQL Azure Auth from source. This document mirrors the actual scripts in `package.json` and the gate chain enforced by `scripts/verify-task.mjs`.

## Prerequisites

- **Node 20.16.0** (pinned in `.node-version` and asserted by `verify:t1`).
- **npm 10.8.1** (pinned as `packageManager` in `package.json` and asserted by `verify:t1`).
- A POSIX shell or Windows PowerShell / Git Bash. The gate commands use `node` directly so they are portable across shells.
- *(Optional)* **Azure CLI** for the runtime fallback identity (`az login`). Not required to build.

`nvm`, `volta`, or `fnm` users can pin to the recorded versions with:

```bash
nvm use                 # reads .node-version
corepack enable         # picks up the npm@10.8.1 packageManager pin
```

## First-time setup

```bash
git clone <repo-url>
cd mysql-azure-auth
npm ci
```

`npm ci` is the supported bootstrap. It performs a clean install from `package-lock.json` and matches the verifier's runtime expectations. Do not substitute `npm install` for `npm ci`.

## Build

```bash
npm run compile
```

Produces:

- `out/main.js` — the bundled extension (loaded by VS Code from `main` in `package.json`).
- `out/main.js.map` — source map.
- `out/test/runTest.js` and `out/test/suite/index.js` — integration test harness.

## Run the unit tests

```bash
npm run test:unit
```

Unit tests run in plain Node — no VS Code download required. They bundle a mock `vscode` module (see `src/test/mocks/vscode.ts`) and stub `mysql2/promise` via dependency injection (`MySqlClientOptions.poolFactory`).

The unit-test count is generated from CI output; do not hard-code.

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

Equivalent to: `lint` → `typecheck` → `unit` → `integration`.

## Gate chain (release readiness)

The repository ships per-Todo verifier scripts that the maintainers run on every change. The chain is:

| Gate | Command | Expected output |
|------|---------|-----------------|
| `verify:t1` | `node scripts/verify-task.mjs 1 --fixture test/fixtures/release/baseline-pass.json` | `BASELINE READY` |
| `verify:t2` | `node test/fixtures/release/release-contract.test.mjs` | `CONTRACT READY (16/16 PASS)` |
| `verify:t3` | `node scripts/verify-task.mjs 3 --fixture test/fixtures/release/history-clean.json` | `HISTORY CLEAN` |
| `verify:t4` | `node scripts/verify-task.mjs 4 --fixture test/fixtures/release/governance-valid.json` | `GOVERNANCE READY` |
| `verify:t5` | `node scripts/verify-task.mjs 5 --fixture test/fixtures/release/privacy-valid.json` | `PRIVACY READY` |
| `verify:t7` | `node scripts/verify-task.mjs 7 --fixture test/fixtures/release/manifest-clean.json` | `MANIFEST READY` |
| `verify:t8` | `node scripts/verify-task.mjs 8 --fixture test/fixtures/release/core-cleanup-clean.json` | `CORE CLEANUP READY` |
| `verify:t9` | `node scripts/verify-task.mjs 9 --fixture test/fixtures/release/refresh-classifier-clean.json` | `REFRESH RECOVERY READY` |
| `verify:t10` | `node scripts/verify-task.mjs 10 --fixture test/fixtures/release/logging-valid.json` | `LOGGING READY` |
| `verify:t11` | `npm run verify:t11 -- --fixture test/fixtures/release/docs-valid.json` | `DOCUMENTATION READY` |
| `verify:t19` | `npm run verify:t19` | `DEFER MARKETPLACE PUBLICATION` (until live + pilot attestations land under `.omo/inputs/`) |

How to interpret each result:

- A `READY` result (exit 0) means the gate's invariants pass against the named fixture.
- A `NOT READY: <code>` result (exit 1) names the failing invariant; the gate's source documents the code's meaning.
- For pre-publish verification, `npm run package:verify -- --synthetic` (the existing `package` branch) prints `PACKAGE READY` — see Todo 14/15 for the upcoming `.vsix`-emitting pre-flight.

`verify:t6` is intentionally run through fixture/manual invocation rather than `npm run` because Todo 6's contract is currently validated per-change, not per-build.

## Package a `.vsix`

```bash
npm run package
```

Produces `mysql-azure-auth-<version>.vsix`. The output excludes `src/`, `node_modules/`, source maps, esbuild configs, `.github/`, `.vscode-test/`, and any test artifacts (see `.vscodeignore`).

The pre-Todo 14/15 path is:

1. Run the full gate chain above.
2. `npm run package`.
3. Smoke-load the `.vsix` in a clean VS Code instance.
4. Push a tag — `.github/workflows/release-github.yml` builds the
   VSIX, publishes it to the VS Code Marketplace under the
   `JosiahSiegel` publisher namespace (reading `secrets.VSCE_PAT`),
   and attaches it to a GitHub Release marked as pre-release. No
   manual `vsce publish` step is required.

   The Marketplace publish decision is owned by `verify:t19`, which
   aggregates three upstream gates:
   - **Todo 16** — public-source readiness (`.omo/evidence/task-16-project-direction-open-source.{json,md,txt}` must yield `PUBLIC SOURCE READY FOR OWNER ACTION`).
   - **Todo 17** — live Azure test (`.omo/inputs/project-direction-open-source.json#azureLive` plus `MYSQL_HOST`/`MYSQL_PORT`/`MYSQL_DATABASE`/`MYSQL_USER` env vars trigger `scripts/azure-live-harness.mjs`).
   - **Todo 18** — pilot attestations (`.omo/inputs/pilot/*.json` and `.omo/inputs/pilot-attestations/<attemptId>.{json,receipt.txt}`).

   `verify:t19` defers with `DEFER MARKETPLACE PUBLICATION` until all
   three are satisfied. The workflow publishes to the Marketplace
   regardless of gate state — the gate is an audit trail, not a
   release blocker. Pilot evidence MUST NEVER be fabricated — the gate's structural cross-checks (SHA-256 of
   attestation receipts, PII regex, SQL DDL/DML regex) are designed
   to reject synthesized records. GitHub Releases do not require the
   Marketplace gate to fire.

To install locally:

```bash
code --install-extension mysql-azure-auth-0.1.1.vsix
```

## Pre-publish check

```bash
npm run vscode:prepublish
```

Runs `esbuild --minify` against the production bundle. The VSIX packaging step also runs this implicitly.

## Public-source checklist

Before tagging a release, confirm the working tree contains **only**:

- Source under `src/`, `scripts/`, `test/`.
- Documentation under `README.md`, `BUILD.md`, `docs/`, `SECURITY.md`, `CONTRIBUTING.md`, `SUPPORT.md`, `CHANGELOG.md`, `LICENSE`.
- Manifest and lockfile (`package.json`, `package-lock.json`).
- `.vscodeignore`, `.gitignore`, `.node-version`.
- `.omo/inputs/official-sources.json` and the pinned snapshot files under `.omo/inputs/snapshots/` (Todo 11).

Confirm the working tree contains **no**:

- `.vsix` files.
- Log files (`*.log`).
- Capture or output files (`*.txt` outside `docs/`).
- Build artefacts (`out/`, `.playwright-mcp/`, `.vscode-test/`).
- Reproduction scripts (`scripts/quick.js` and similar).

## Troubleshooting

- **"Cannot find module 'vscode'" at runtime** — VS Code bundles the `vscode` module; this error means the extension is running outside an Extension Host. Run via `npm run test:integration` or use VS Code's "Run Extension" debug config.
- **`zod` parse errors on stored connections** — `src/registry/connectionCatalog.ts:parseStoredConnections` validates globalState on every read. Bad data is logged via the safe-diagnostic formatter and ignored; it never crashes the extension. To migrate, fix the saved entries in globalState manually (Settings → Extensions → MySQL Azure Auth → "Edit in settings.json") and reload.
- **Tests hang on shutdown** — every test that calls `connect()` on a `MySqlClient` must also call `disconnect()`. The 45-minute refresh interval is `unref()`'d so it does not pin the Node event loop, but only after `disconnect()` clears it. Use the `makeClient()` helper from `src/test/unit/mysqlClient.test.ts` to register clients for auto-disconnect.
- **Integration test fails with "Cannot activate... unknown extension"** — expected; the test bypasses `activate()` by importing the bundled module directly. The error is from VS Code's own dependency resolver, not from our code.

## CI

The repository ships a GitHub Actions workflow at `.github/workflows/ci.yml` that runs the full pipeline on every push to `main` / `master` and on every pull request. It uses `xvfb-run` for the headless integration test step on Linux runners.