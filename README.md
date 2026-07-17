# MySQL Azure Auth

A community-maintained VS Code preview for browsing and querying Azure Database for MySQL Flexible Server with Microsoft Entra authentication.

`0.1.1-Preview` — public preview. Not affiliated with Microsoft, Azure, Oracle, or MySQL.

The extension keeps long-running sessions alive by rotating the Entra access token in the background. In normal use a single session lasts as long as you have VS Code open.

---

## Features

- **Microsoft Entra ID sign-in** — uses VS Code's built-in Microsoft account provider, with the Azure CLI as a transparent fallback.
- **Drain-and-replace token rotation** — when the cached token nears expiry the extension builds a fresh `mysql.Pool` bound to the new token, routes new work to it, and closes the old pool after its in-flight queries finish.
- **Opt-in read-only session enforcement** — every server profile carries a "Read-only mode" checkbox. When checked, the session runs `SET SESSION TRANSACTION READ ONLY` at checkout and classifies user SQL through a deny-list (`classifySqlBatch`) before any `pool.execute`. DDL, write, and administrative statements are rejected fail-closed. When unchecked, writes are allowed if your account has the necessary database grants.
- **Multiple servers** — register as many endpoints as you like; each has its own session and credentials.
- **Server sidebar** — the Servers view in the Activity Bar shows every registered endpoint with its live/idle state. Click to expand and walk tables.
- **Query workbench** — opens a webview per server. Run SQL, see results in a table, export to CSV or JSON.
- **History** — per-server SQL history is exposed through the Query Workbench picker, bounded by `mysqlAzureAuth.historyLimit` (default 100, range 0–10000).

---

## Prerequisites

1. **VS Code ≥ 1.85.0** (built-in Microsoft authentication provider is required).
2. A Microsoft account that has access to your MySQL Flexible Server. Sign in via the Microsoft sign-in flow that VS Code shows when you first connect (no separate extension required).
3. *(Optional)* **Azure CLI** (`az`) — only needed if the VS Code Microsoft auth provider is unavailable. The extension falls back to it transparently.
   - Windows: <https://learn.microsoft.com/cli/azure/install-azure-cli-windows>
   - macOS: `brew install azure-cli`
   - Linux: <https://learn.microsoft.com/cli/azure/install-azure-cli-linux>
4. **Azure Database for MySQL Flexible Server** with Microsoft Entra ID authentication enabled.
5. An Entra principal (user or group) that has both:
   - the data-plane role you want on the server (`Reader` is sufficient for browsing), and
   - a matching MySQL-side user with the read-only database grants you intend (see "Least-privilege setup" below).

> The extension does **not** depend on the Azure Account extension (deprecated January 2025). Sign-in goes through VS Code's built-in Microsoft provider.

### Azure-side setup

1. In the Azure Portal, open your **Flexible Server** → **Security** → **Authentication**.
2. Set the authentication mode to **Microsoft Entra ID only** or **MySQL and Microsoft Entra ID**.
3. Click **Set Admin** and pick the principal you want to use.
4. Connect with your admin credentials and run:

   ```sql
   CREATE USER 'you@your-tenant.com'@'%' IDENTIFIED BY 'token-placeholder';
   GRANT SELECT ON your_database.* TO 'you@your-tenant.com'@'%';
   FLUSH PRIVILEGES;
   ```

   The `'token-placeholder'` value is required by MySQL syntax but is ignored at authentication time — Entra tokens are validated by the server's AAD plugin.

### Least-privilege setup

The extension reads from the database; it does not modify schema or data. To minimise blast radius:

- Grant `SELECT` on the schemas you actually want to browse.
- If you only need metadata, also grant `SHOW VIEW` / `PROCESS` only where required.
- Do **not** grant `ALL PRIVILEGES` to the principal the extension signs in as.
- Azure RBAC on the server and MySQL-side grants are separate. Granting an Azure data-plane role does **not** create the MySQL user or grant database privileges; you must run the `CREATE USER` / `GRANT` statements above.

### Opt-in read-only session

Every server profile carries an opt-in "Open session in read-only mode" checkbox (default: checked for new profiles). When checked, the session runs `SET SESSION TRANSACTION READ ONLY` at checkout, and `classifySqlBatch` rejects mutations, DDL, and administrative statements fail-closed. When unchecked, writes are allowed if your account has the necessary database grants.

If a write statement is submitted while a read-only session is open, the session returns `READ_ONLY_REJECTED` and the connection is closed. The Azure RBAC grants you choose do not change this behaviour; the read-only enforcement is application-side and applies to every session opened with the checkbox checked regardless of the account's database privileges.

---

## Usage

1. Open the **MySQL Azure Auth** view in the Activity Bar.
2. Click **+ Register Server** (or run **MySQL Azure Auth: Register Server**).
3. Fill in:
   - **Display label** — a friendly name (e.g. `production-analytics`).
   - **Flexible Server hostname** — your `*.mysql.database.azure.com` FQDN.
   - **TCP port** — defaults to 3306; must be 1–65535.
   - **Database** — the schema to bind to (free text; selection is intentionally not automated).
   - **Entra principal** — your Entra group name (e.g. `DBA Team`) or your personal email.
   - **Transport encryption** — `Encrypt (recommended)` (default) or `Plaintext` (warns on selection).
   - **Open session in read-only mode** — checked by default for new profiles; uncheck if your account has write grants and you want to run INSERT/UPDATE/DELETE/DDL.
4. Right-click the new server → **Open Session**.
5. Expand the server to see tables. Right-click a table → **Preview Rows** for a quick `SELECT * FROM ... LIMIT 100`.
6. From a connected server, run **Open Workbench** to get a SQL editor.

---

## How authentication works

```
┌────────────────────────────────────────────────────────────────────┐
│  User clicks Open Session                                          │
│                                                                     │
│  IdentityProvider.getToken()                                       │
│    1. Check token cache (60s safety margin)                        │
│    2. Cache miss -> ChainedTokenCredential.getToken()              │
│       a. VSCodeIdentitySource (VS Code Microsoft sign-in)          │
│       b. AzureCliCredential (Azure CLI; transparent fallback)      │
│    3. Cache the new token; remember expiresOnTimestamp              │
│                                                                     │
│  DatabaseSession.connect()                                         │
│    1. Build mysql.Pool bound to the token (authPlugins closure)    │
│    2. Open a connection, run SET SESSION TRANSACTION READ ONLY     │
│    3. Install the refresh interval (45 min, unref'd)                │
│                                                                     │
│  Token rotation (every 45 min, on demand, or on token expiry):      │
│    ActorRegistry swaps the session via DatabaseSession.swapToken() │
│      1. Build a NEW pool bound to the fresh token                   │
│      2. Atomically route new work to the new pool                   │
│      3. Wait for the old pool's in-flight queries to drain          │
│      4. Close the old pool                                         │
│      On the first refresh failure:                                 │
│         - retry once after a 5 s delay                             │
│         - on second failure, mark the actor as failed              │
│         - close the session best-effort and require Open Session   │
│                                                                     │
│  Cancellation / sign-out:                                          │
│    - VS Code "AuthenticationCancelledNotification" ->              │
│      AuthenticationRequiredError -> chain advances to AzureCli       │
│    - isSignedIn() reports false if neither source has a session     │
│    - Disconnect clears the refresh interval exactly once            │
└────────────────────────────────────────────────────────────────────┘
```

> Device-code sign-in was removed during the preview (deprecated upstream in `sidorares/node-mysql2` and `@azure/identity`). It is not wired in this release; do not rely on it.

### Why drain-and-replace, not `connection.changeUser()`

`mysql2`'s `Connection.changeUser()` is broken for Azure MySQL Entra token auth (see `sidorares/node-mysql2` issue #3350: `ER_ACCESS_DENIED_ERROR (using password: NO)`). It sends `COM_CHANGE_USER` which strips the cleartext plugin semantics that Azure MySQL requires. Pool-based rotation sidesteps that entirely — the extension builds a new pool for each token, routes new queries to it, and closes the old pool only after its in-flight work completes.

### Token lifetime and rotation

Microsoft issues Entra access tokens with a randomised lifetime for the `ossrdbms-aad` audience. Token-lifetime policy can extend or shorten this per tenant, but defaults are typically well under an hour. The extension rotates when the cached token's `expiresOnTimestamp` is within 60 seconds, and otherwise on a 45-minute cadence. To change the interval, edit `src/registry/actorRegistry.ts` (`DEFAULT_REFRESH_MS`).

---

## Architecture

```
src/
  main.ts                          composition root, command registration
  domain.ts                        branded primitives, QueryOutcome union
  problems.ts                      ExtensionProblem hierarchy
  identity/
    entraToken.ts                  EntraTokenProvider facade
    vscodeAuth.ts                  VSCodeIdentitySource (TokenCredential)
    safeDiagnostic.ts              allowlist-only diagnostic formatter
  registry/
    actorRegistry.ts               per-ID actors + state machine (rotation, retry)
    databaseSession.ts             mysql.Pool wrapper, read-only checkout, drain-and-replace
    sqlClassifier.ts               classifyStatement / classifySqlBatch (deny-list)
    connectionCatalog.ts           globalState persistence (zod-validated)
    legacyWire.ts                  QueryOutcome -> legacy QueryResult adapter
  schema/
    catalogReader.ts               listDatabases / listTables / listColumns
  forms/
    connectionForm.ts              port + TLS validation, no I/O
  views/
    connectionExplorer.ts          ServerTree (renderer only)
    queryWorkbench.ts              SQL webview with parseWebviewRequest
  test/
    factories/connectionConfig.ts  makeConnectionConfig()
    mocks/vscode.ts                in-memory vscode API for unit tests
    suite/index.ts                 Mocha loader for @vscode/test-electron
    extension.integration.test.ts  real VS Code host smoke test
    unit/*.test.ts                 unit tests (Mocha TDD; count is generated from CI)
```

> The unit-test count is generated from CI output; do not hard-code.

### Where state lives

| State                    | Where                                                  |
|--------------------------|--------------------------------------------------------|
| Registered servers       | VS Code `globalState` key `connections`               |
| Live sessions            | In-memory `ActorRegistry` (one actor per server id)   |
| Token cache              | In-memory `CachedIdentityProvider` (1 entry / scope)  |
| Last query result        | Per-`QueryWorkbench` instance (webview-local)         |

---

## Building & packaging

```bash
npm ci
npm run compile           # build main.js + integration test entries
npm run build:test        # bundle unit tests with the vscode mock
npm test                  # lint + typecheck + unit + integration
npm run package           # produce .vsix
```

See `BUILD.md` for troubleshooting tips and pre-publish checks.

### Distribution

The extension is distributed through **two parallel channels** under the
`JosiahSiegel` publisher namespace:

- **VS Code Marketplace** — [marketplace.visualstudio.com/items?itemName=JosiahSiegel.mysql-azure-auth](https://marketplace.visualstudio.com/items?itemName=JosiahSiegel.mysql-azure-auth).
  The standard install path for most users.
- **GitHub Releases** — [github.com/JosiahSiegel/vscode-ext-mysql-azure-auth/releases](https://github.com/JosiahSiegel/vscode-ext-mysql-azure-auth/releases).
  Used when you want to verify the SHA-256 checksum before installing, or
  when you want a specific tagged build that hasn't reached the Marketplace
  yet.

#### Install from the Marketplace

1. In VS Code: **Extensions** panel (`Ctrl+Shift+X` / `Cmd+Shift+X`).
2. Search for **MySQL Azure Auth** (publisher: JosiahSiegel).
3. Click **Install**.
4. Reload VS Code when prompted.

#### Install from a GitHub Release

1. Open the [Releases page](https://github.com/JosiahSiegel/vscode-ext-mysql-azure-auth/releases).
2. Download the latest `mysql-azure-auth-<tag>.vsix` and its `.sha256` companion.
3. Verify the SHA-256 of the VSIX against the published `.sha256` file.
4. In VS Code: **Extensions** panel → `⋯` menu → **Install from VSIX…** →
   pick the downloaded file.
5. Reload VS Code when prompted.

#### Cut a new release

```bash
git tag 0.1.1-preview             # or 0.2.0, etc.
git push origin 0.1.1-preview     # triggers .github/workflows/release-github.yml
```

The GitHub workflow builds the VSIX, hashes it, publishes it to the
VS Code Marketplace under the `JosiahSiegel` publisher namespace, and
attaches it to a GitHub Release marked as pre-release. The Marketplace
publish reads the version from `package.json#version` (so bump that
field before tagging if you want a new Marketplace version). The PAT
used by the workflow lives at the repository's `VSCE_PAT` secret and
must be issued against the `JosiahSiegel` publisher namespace on the
Marketplace publisher management page.

The Marketplace publish decision is owned by `verify:t19`, which
aggregates three upstream gates:

- **Todo 16** — public-source readiness (owner identity, history scan,
  cleanup markers).
- **Todo 17** — live Azure test against a real
  `*.mysql.database.azure.com` endpoint (env-driven harness).
- **Todo 18** — pilot attestations from real users on real installations.

As of this writing the Marketplace listing at
`marketplace.visualstudio.com/items?itemName=JosiahSiegel.mysql-azure-auth`
(version `0.1.1`) is live, but `verify:t19` continues to emit
`DEFER MARKETPLACE PUBLICATION` because the live and pilot attestations
have not yet been supplied under `.omo/inputs/`. The gate is an audit
trail of external attestations; the workflow publishes to both channels
regardless of gate state so the user-facing distribution never goes
stale. The `FRESH PUBLIC ROOT REQUIRED` honest disclosure (Todo 3
history scan) is independent of distribution.

---

## Customization points

- **Refresh interval** — `src/registry/actorRegistry.ts` exposes `DEFAULT_REFRESH_MS`. Default: 45 min.
- **Identity chain order** — pass a custom `fallback` (or a full `primary` + `fallback` pair) into `new EntraTokenProvider({...})` in `src/main.ts` to add or replace identity sources. The well-supported `@azure/identity` primitives compose naturally.
- **Form copy** — all user-facing strings live in `src/forms/connectionForm.ts` and `src/main.ts`. Adjust wording without touching schema or registry code.

---

## Known failures of this preview

The preview deliberately does not support:

- **Row or schema editing.** There are no `editRows` / `createTable` / `dropTable` commands and no DDL flows.
- **DDL or write SQL.** Mutating statements (INSERT/UPDATE/DELETE/...), administrative statements (GRANT/REVOKE/CALL/...), and DDL (CREATE/ALTER/DROP/...) are rejected by `classifySqlBatch` before any pool dispatch.
- **Telemetry.** No analytics SDK is embedded. The only outbound calls are the VS Code Microsoft auth provider, Azure CLI (fallback), and the MySQL Flexible Server itself.
- **Marketplace publishing requires a PAT.** The release workflow reads `secrets.VSCE_PAT` to publish to the VS Code Marketplace; the secret must be a Personal Access Token issued against the `JosiahSiegel` publisher namespace. The publish runs unconditionally on tag push (the gate is an audit trail, not a pre-publish blocker).
- **Device-code sign-in.** Removed during the preview; use the VS Code Microsoft auth provider or the Azure CLI fallback.
- **Schema-aware wizard pickers.** The "Database" field is free text; the form does not query the server during entry.

Recovery semantics are bounded: a single refresh failure is retried after 5 seconds; a second failure marks the actor as `failed` and requires the user to run **Open Session** again. The extension does not promise that arbitrary network or server outages are transparent. On extension upgrade (or downgrade), open Query Workbench panels are disposed and rebuilt on next open; persistent state is migrated once per version transition; failures are logged to the "MySQL Azure Auth" output channel and do not block activation.

---

## Privacy and data

- **Telemetry:** none. The extension does not embed Application Insights, Sentry, or any other analytics SDK.
- **Persisted full-SQL history:** the Query Workbench stores the literal SQL the user submitted, per server, bounded by `mysqlAzureAuth.historyLimit`. Forget Server wipes the matching history key in one step.
- **Persisted connection metadata:** only the display label, hostname, port, database, principal, and TLS flag are stored in `globalState`. No tokens, passwords, client secrets, or refresh tokens are persisted.
- **In-memory token cache:** the Entra access token lives only in process memory; it is cleared on deactivation.

See `docs/PRIVACY.md` for the authoritative privacy policy.

---

## Governance

This is a community preview, not affiliated with Microsoft, Azure, Oracle, or MySQL. Trademarks belong to their respective owners; references are nominative only.

- Security: see `SECURITY.md`
- Contributing: see `CONTRIBUTING.md`
- Support: see `SUPPORT.md`

---

## License

MIT.