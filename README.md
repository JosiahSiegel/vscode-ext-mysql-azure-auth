# MySQL Azure Auth

A VS Code workbench for **Azure Database for MySQL Flexible Server** that uses **Microsoft Entra ID** for authentication. Browse servers in the sidebar, open a session, run SQL, and walk the schema without leaving the editor.

The extension keeps long-running sessions alive by rotating the Entra access token in the background. In normal use a single session lasts as long as you have VS Code open.

---

## Features

- **Entra ID sign-in** — uses VS Code's Microsoft account provider, with the Azure CLI as a transparent fallback.
- **Self-healing sessions** — Entra tokens for the MySQL Flexible Server audience are valid 5–60 minutes. The extension rotates them automatically every 45 minutes so the socket never drops.
- **Drain-and-replace rotation** — token refresh builds a brand-new connection pool bound to the new token, then drains the old pool after its in-flight queries finish. No `COM_CHANGE_USER` (which is broken for `mysql_clear_password`), no hard reconnects, no query loss.
- **Multiple servers** — register as many endpoints as you like; each has its own session and credentials.
- **Server sidebar** — Servers view in the Activity Bar shows every registered endpoint with its live/idle state. Click to expand and walk tables.
- **Query workbench** — opens a webview per server. Run SQL, see results in a table, export to CSV or JSON.
- **Preview table rows** — right-click a table to preview 100 rows or view up to 1,000 rows with `SELECT * FROM ... LIMIT N`; this is read-only browsing, not row editing.
- **Schema-aware new-table wizard** — `mysqlAzureAuth.createTable` prompts for a name and asks for confirmation before issuing DDL.
- **Strict input validation** — ports are bounds-checked at the wizard boundary; dismissed TLS picker is never silent.
- **Typed everywhere** — the public surface is pinned by `src/test/unit/publicSurface.test.ts`. Any drift to the manifest fails CI.

---

## Prerequisites

1. **VS Code ≥ 1.85.0** (built-in Microsoft authentication provider is required)
2. A Microsoft account that has access to your MySQL Flexible Server. Sign in via the Microsoft sign-in flow that VS Code shows when you first connect (no separate extension required).
3. *(Optional)* **Azure CLI** (`az`) — only needed if the VS Code Microsoft auth provider isn't available. The extension will fall back to it transparently.
   - Windows: <https://learn.microsoft.com/cli/azure/install-azure-cli-windows>
   - macOS: `brew install azure-cli`
   - Linux: <https://learn.microsoft.com/cli/azure/install-azure-cli-linux>
4. **Azure Database for MySQL Flexible Server** with Entra ID authentication enabled.
5. An Entra principal (user or group) with at least the `Read` data-plane role on the Flexible Server's `Azure OSSRDBMS Database` resource.

> The extension does **not** depend on the Azure Account extension (deprecated January 2025). Sign-in goes through VS Code's built-in Microsoft provider.

### Azure-side setup

1. In the Azure Portal, open your **Flexible Server** → **Security** → **Authentication**.
2. Set the authentication mode to **Microsoft Entra ID only** or **MySQL and Microsoft Entra ID**.
3. Click **Set Admin** and pick the principal you want to use.
4. Connect with your admin credentials and create the MySQL-side user that matches the Entra principal:
   ```sql
   CREATE USER 'you@your-tenant.com'@'%' IDENTIFIED BY 'token-placeholder';
   GRANT ALL PRIVILEGES ON your_database.* TO 'you@your-tenant.com'@'%';
   FLUSH PRIVILEGES;
   ```
   The `'token-placeholder'` value is required by MySQL syntax but is ignored at authentication time — Entra tokens are validated by the server's AAD plugin.

---

## Usage

1. Open the **MySQL Azure Auth** view in the Activity Bar.
2. Click **+ Register Server** (or run **MySQL Azure Auth: Register Server**).
3. Fill in:
   - **Display label** — a friendly name (e.g. `production-analytics`)
   - **Flexible Server hostname** — your `*.mysql.database.azure.com` FQDN
   - **TCP port** — defaults to 3306; must be 1–65535
   - **Default schema** — the database to bind to
   - **Entra principal** — your Entra group name (e.g. `DBA Team`) or your personal email
   - **Transport encryption** — `Encrypt (recommended)` (default) or `Plaintext` (warns on selection)
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
│    2. Hit cache miss -> ChainedIdentityProvider.getToken()         │
│       a. VSCodeIdentitySource (VS Code Microsoft sign-in)          │
│       b. AzureCliCredential (@azure/identity, transparent az CLI)  │
│    3. Cache the new token; remember expiresOnTimestamp              │
│                                                                     │
│  DatabaseSession.connect()                                         │
│    1. Build mysql.Pool bound to the token (authPlugins closure)    │
│    2. Start a 45-minute setInterval (unref'd) that calls swapToken()│
│                                                                     │
│  Every 45 minutes:                                                  │
│    ActorRegistry refreshes each session via DatabaseSession         │
│      .swapToken():                                                  │
│        1. Build NEW pool bound to the fresh token                   │
│        2. Atomically route new work to the new pool                 │
│        3. Wait for the old pool's in-flight queries to drain        │
│        4. Close the old pool                                       │
│                                                                     │
│  Cancellation / sign-out:                                          │
│    - VS Code "AuthenticationCancelledNotification" ->              │
│      AuthenticationRequiredError -> chain advances to AzureCli       │
│    - isSignedIn() reports false if neither source has a session     │
│    - Disconnect clears the refresh interval exactly once            │
└────────────────────────────────────────────────────────────────────┘
```

### Why drain-and-replace, not `connection.changeUser()`

`mysql2`'s `Connection.changeUser()` is broken for Azure MySQL Entra token auth (see `sidorares/node-mysql2` issue #3350: `ER_ACCESS_DENIED_ERROR (using password: NO)`). It sends `COM_CHANGE_USER` which strips the cleartext plugin semantics that Azure MySQL requires. Pool-based rotation sidesteps that entirely — we build a new pool for each token, route new queries to it, and close the old pool only after its in-flight work completes.

### Token lifetime

Microsoft issues Entra access tokens with a randomised 5–60 minute lifetime (averaging 75 min) for the `ossrdbms-aad` audience. Token lifetime policy can extend this up to 24 hours per tenant, but is rarely applied. We refresh every 45 minutes to stay safely under the ceiling. To change the interval, edit `src/registry/connectionLifecycle.ts`.

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
  registry/
    actorRegistry.ts               per-ID actors + state machine
    databaseSession.ts             mysql.Pool wrapper with drain-and-replace
    connectionLifecycle.ts         ConnectionHandle facade (legacy compat)
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
    unit/*.test.ts                 97 unit tests (Mocha TDD)
```

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
npm install
npm run compile           # build main.js + integration test entries
npm run build:test        # bundle unit tests with the vscode mock
npm test                  # lint + typecheck + unit + integration
npm run package           # produce .vsix
```

See `BUILD.md` for troubleshooting tips and pre-publish checks.

---

## Customization points

- **Refresh interval** — `src/registry/connectionLifecycle.ts` exposes `refreshIntervalMs` on `MySqlClientOptions`. Default: 45 min.
- **Identity chain order** — pass a custom `fallback` (or a full `primary` + `fallback` pair) into `new EntraTokenProvider({...})` in `src/main.ts` to add or replace identity sources. The well-supported `@azure/identity` primitives compose naturally.
- **Form copy** — all user-facing strings live in `src/forms/connectionForm.ts` and `src/main.ts`. Adjust wording without touching schema or registry code.

---

## License

MIT.