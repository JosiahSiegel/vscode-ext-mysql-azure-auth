# Privacy policy

This document describes the data the extension handles, where each piece
of data lives, and how the user can inspect or remove it. It is the
authoritative reference for `docs/PRIVACY.md` queries from the
Todo 5 validator.

## Scope

The extension connects VS Code to an Azure Database for MySQL Flexible
Server authenticated with Microsoft Entra ID. It is a preview
release, not a managed service. No data is sent to the extension's own
telemetry backend because no such backend exists.

## In-memory cache

The current Entra access token string is held in the process memory of
the extension host only.

- Stored on: in-process fields inside `src/identity/entraToken.ts`
  (`CachedIdentityProvider.cache`, populated by `getToken()`).
- Lifetime: until the cached entry expires (per `expiresOnTimestamp`,
  minus a 60-second safety margin) or the extension is deactivated.
- Never written to:
  - VS Code `globalState`
  - VS Code `secrets` (`SecretStorage`)
  - VS Code `memento` (workspace state)
  - On-disk files under the extension's storage directory
  - Log channels, output channels, or status-bar text
  - The webview, the form HTML, or any prompt

`clearCache()` is called when the extension is deactivated; the cache is
not persisted across extension reloads.

## Persisted connection metadata

A list of `ConnectionConfig` records is persisted under the
`globalState` key `connections` (constant
`CONNECTIONS_STORAGE_KEY` in `src/registry/connectionCatalog.ts`).

Each record carries exactly the following fields:

| Field      | Purpose                                              |
|------------|------------------------------------------------------|
| `id`       | Stable, randomly generated UUID                     |
| `name`     | Display label picked by the user                    |
| `host`     | Server hostname                                      |
| `port`     | TCP port (1..65535)                                  |
| `user`     | Entra principal (UPN / email / group name)           |
| `ssl`      | Whether TLS is required on this connection           |
| `readOnly` | Whether the user opted in to read-only session mode |

Secrets are NOT stored:

- No access tokens, refresh tokens, or session cookies.
- No passwords — Entra token auth uses opaque short-lived tokens that
  are not stored on disk at all.
- No client secrets, API keys, or service-principal credentials.

## Persisted full-SQL history

For every registered server, the extension stores the most recent SQL
that was executed against it under the globalState key
`mysqlAzureAuth.queryHistory.<connectionId>` (one key per server).

- Value shape: `Array<{ sql: string, executedAt: number }>` (zod
  schema in `src/views/queryWorkbench.ts`).
- Default cap: `mysqlAzureAuth.historyLimit` entries
  (default `100`, range `0..10000`).
- The stored SQL is the literal text the user submitted; it may
  include embedded values, identifiers, comments, and any embedded
  secrets the user typed into the editor. The extension never inspects
  or rewrites the text before persisting it.
- `mysqlAzureAuth.queryHistory.<id>` is exposed to the user only via
  the Query Workbench history picker.

### Deletion commands

To remove persisted SQL history:

1. **Per-server** — run the **Forget Server** command on the affected
   server. This removes the connection record and the matching
   `mysqlAzureAuth.queryHistory.<id>` key in one atomic step. The
   Catalog helper `GlobalStateConnectionCatalog.forgetServer(id)`
   performs the deletion.
2. **All data** — run **Forget Server** on every registered server,
   or remove the extension and reload VS Code. Both paths wipe the
   `connections` array and every `mysqlAzureAuth.queryHistory.*` key.

The extension never touches other globalState keys. Workspace state
(`workspaceState`) is not used at all.

## Exports

When the user clicks an export button in the Query Workbench, the
extension writes a CSV / JSON / Markdown file to a path the user picks
through the standard VS Code save dialog.

- The extension writes exactly one file per click.
- The path, filename, and contents are entirely user-controlled.
- The file inherits the permissions of the user-owned directory the
  user selects. The extension does not own or delete export files;
  removing an export is the user's responsibility.
- Exports contain the visible result rows plus, for CSV, the column
  header line. They do not contain tokens, connection metadata, or
  secrets — only what the user just saw in the result grid.

## Diagnostics

Two diagnostics surfaces exist: the status bar item and the
"MySQL Azure Auth" output channel.

- Status bar text: uses `host`, `database`, and `user` only
  (`ServerTree.makeStatusBarItem` and the
  `STATUS_BAR_REFRESH_MS` interval in `src/main.ts`). It never
  embeds the access token, the SQL text, or the query history.
- Output channel: safe-diagnostic labels are the only fields emitted
  (`operation`, `credentialSource`, `elapsedMs`, `errorClass`,
  `mysqlErrorCode`, `connectionState`, `retryCount`). Raw error
  messages, stacks, query strings, principal emails, hostnames,
  schema names, and tokens are stripped before output. The full
  allowlist and the formatter live in `src/identity/safeDiagnostic.ts`
  (introduced by the follow-up Todo 10; the formatter is wired in
  here so this policy is enforceable from this release).

## Telemetry: none

- The extension does not collect telemetry.
- The extension does not embed any third-party analytics SDK
  (Application Insights, Sentry, Mixpanel, Google Analytics,
  Segment, etc.).
- The only outbound network calls the extension makes are:
  - VS Code Microsoft authentication provider
    (`vscode.authentication.getSession`) for the Entra sign-in.
  - Azure CLI (`az`) when the VS Code provider is unavailable.
  - The MySQL Flexible Server itself.
- The extension does not make outbound calls to any other host.
- No crash, error, performance, or feature-usage data is collected.

## What this policy does NOT cover

- The user's own machine, the VS Code host, and any other extensions
  installed alongside this one — those are governed by Microsoft and
  the user's own policies.
- The Azure Database for MySQL Flexible Server itself — that is
  governed by the customer's Azure subscription and Azure policies.
- Microsoft Entra ID — governed by the customer's Microsoft Entra
  tenant policies and Microsoft's terms of service.

## Reporting concerns

If you believe the extension violates this policy, file a confidential
report per `SECURITY.md`. If you have a non-security question about
this document, open a public issue per `SUPPORT.md`.