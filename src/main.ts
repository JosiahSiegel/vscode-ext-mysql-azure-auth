/**
 * Composition root. The VS Code extension host calls `activate(context)` once
 * per session. Everything else hangs off this function.
 *
 * Responsibilities:
 *   - Build the dependency graph (catalog, registry, identity source).
 *   - Register the 10 commands declared in package.json.
 *   - Hand each command the services it needs; no global state.
 *   - Return a `deactivate()` that resolves AFTER every actor has cleaned up.
 */

import * as vscode from 'vscode';
import {
    GlobalStateConnectionCatalog,
    coerceReadOnly,
    stripReadOnly,
} from './registry/connectionCatalog';
import { ActorRegistry } from './registry/actorRegistry';
import { ServerTree, WelcomeNode } from './views/connectionExplorer';
import { QueryWorkbench } from './views/queryWorkbench';
import { EntraTokenProvider } from './identity/entraToken';
import safeDiagnostic from './identity/safeDiagnostic';
import { showServerForm } from './forms/serverForm';
import { openSession } from './commands/openSession';
import type { ConnectionConfig } from './domain';
import { escapeSqlIdentifier } from './views/sqlStatements';
import { classifyVersionTransition } from './registry/versionTracker';
import { runMigrations, type MigrationStep } from './registry/migrationRunner';
import { disposeAllWorkbenchPanels } from './registry/webviewClobber';

const WELCOME_VISIBLE_KEY = 'mysqlAzureAuth.welcomeVisible' as const;
const STATUS_BAR_REFRESH_MS = 5_000;
const NO_DEFAULT_DATABASE = '(no default database)';
let activeRegistry: ActorRegistry | undefined;

function displayDatabase(database: string): string {
    return database || NO_DEFAULT_DATABASE;
}

/** Loose typing for tree items the manifest menus hand us. */
interface ServerNodeLike {
    readonly config: ConnectionConfig;
}
interface TableNodeLike {
    readonly connectionId: string;
    readonly tableName: string;
    readonly databaseName?: string;
}

interface Composition {
    readonly catalog: GlobalStateConnectionCatalog;
    readonly registry: ActorRegistry;
    readonly explorer: ServerTree;
    readonly identity: EntraTokenProvider;
}

export function activate(context: vscode.ExtensionContext): void {
    // Always create the output channel up front so it always shows up in the
    // Output panel, even if composition fails later.
    const logChannel = vscode.window.createOutputChannel('MySQL Azure Auth');
    context.subscriptions.push(logChannel);
    logChannel.appendLine('[activate] composing MySQL Azure Auth…');

    // Version-transition gate (T5): decide whether this activation is an
    // upgrade / downgrade / malformedVersion before composition runs, so
    // the clobber fires first and the migration IIFE can race the rest
    // of activation in the background. A synchronous failure here is
    // logged via `safeDiagnostic` and swallowed — composition must NOT
    // be blocked by the upgrade path.
    try {
        const observedVersion = (context.extension.packageJSON as {
            version?: string;
        }).version;
        const transition = classifyVersionTransition(
            observedVersion,
            context.globalState.get(
                'mysqlAzureAuth.lastMigratedVersion'
            ) as string | null | undefined
        );
        if (
            context.extensionMode === 1 &&
            (transition === 'upgrade' ||
                transition === 'downgrade' ||
                transition === 'malformedVersion')
        ) {
            disposeAllWorkbenchPanels();
            logChannel.appendLine(
                `[activate] upgrade branch: transition=${transition}; webviews disposed`
            );
        }
        const steps: MigrationStep[] = [
            {
                id: 'v1',
                run: async (ctx) => {
                    const raw = new GlobalStateConnectionCatalog(
                        ctx
                    ).list().connections;
                    if (raw.length === 0) return;
                    const coerced = raw.map(coerceReadOnly);
                    const rewritten = coerced.some(
                        (c, i) => c !== raw[i]
                    );
                    if (rewritten) {
                        await ctx.globalState.update(
                            'connections',
                            coerced.map(stripReadOnly)
                        );
                    }
                },
            },
        ];
        // The migration runner is gated to Production mode for the same
        // reason the clobber is: dev/test runs go through the activation
        // path on every reload, and re-running `loadOrMigrate`-style
        // rewrites during dev/test would mask regressions in the rewrite
        // itself. The runner is also dispatched for `sameVersion` and
        // `firstInstall` transitions because the per-step markers are
        // version-scoped: a same-version activation on a fresh global
        // state must still run the steps exactly once.
        if (context.extensionMode === 1) {
            void (async () => {
                try {
                    await runMigrations(
                        context,
                        logChannel,
                        steps,
                        observedVersion ?? undefined
                    );
                } catch (err: unknown) {
                    const diagnostic = safeDiagnostic({
                        operation: 'activate:migration-runner',
                        credentialSource: 'unknown',
                        errorClass: 'class:migration_failure',
                    });
                    logChannel.appendLine(
                        `[activate] migration runner threw (swallowed); diagnostic=${JSON.stringify(diagnostic)}`
                    );
                    void err;
                }
            })();
        }
    } catch (err: unknown) {
        const diagnostic = safeDiagnostic({
            operation: 'activate:upgrade-gate',
            credentialSource: 'unknown',
            errorClass: 'class:migration_failure',
        });
        logChannel.appendLine(
            `[activate] upgrade-gate threw (swallowed); diagnostic=${JSON.stringify(diagnostic)}`
        );
        void err;
    }

    let composition: Composition;
    try {
        composition = buildComposition(context, logChannel);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err ?? '');
        const stack = err instanceof Error ? err.stack : undefined;
        logChannel.appendLine(`[activate] FATAL: composition failed: ${message}`);
        if (stack) logChannel.appendLine(stack);
        // Routing every external diagnostic through the formatter keeps
        // raw error text, stacks, and any embedded secrets out of the
        // release evidence. The error itself remains in memory for the
        // appended line above and the user-facing toast below.
        // eslint-disable-next-line no-console
        console.log(
            '[mysql-azure-auth] composition failed',
            safeDiagnostic({
                operation: 'activate:composition',
                credentialSource: 'unknown',
                errorClass: 'class:connection_error',
            })
        );
        void err;
        void vscode.window.showErrorMessage(
            `MySQL Azure Auth failed to activate: ${message}. Check the "MySQL Azure Auth" output channel.`
        );
        return;
    }
    logChannel.appendLine('[activate] composition ready; registering commands');

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider(
            'mysqlAzureAuth.serversView',
            composition.explorer
        )
    );
    context.subscriptions.push(composition.explorer);

    // Status bar item shows the active connection. Refreshes on a slow tick
    // so connect/disconnect events surface without a polling-tree coupling.
    const statusBar = installStatusBar(context, composition.registry);
    context.subscriptions.push(statusBar);

    // Toggle the welcome view's `when` clause from the manifest based on
    // whether any servers are registered.
    const refreshWelcomeVisibility = (): void => {
        const hasServers = composition.catalog.list().connections.length > 0;
        void vscode.commands.executeCommand(
            'setContext',
            WELCOME_VISIBLE_KEY,
            !hasServers
        );
    };
    refreshWelcomeVisibility();
    context.subscriptions.push({ dispose: refreshWelcomeVisibility });

    const { catalog, registry, explorer, identity } = composition;
    const cmd = vscode.commands;

    context.subscriptions.push(
        cmd.registerCommand('mysqlAzureAuth.registerServer', () =>
            registerServer(catalog, explorer).then(refreshWelcomeVisibility)
        ),
        cmd.registerCommand(
            'mysqlAzureAuth.forgetServer',
            (node?: ServerNodeLike) => {
                if (!node) return;
                return forgetServer(catalog, registry, node.config.id, explorer)
                    .then(refreshWelcomeVisibility);
            }
        ),
        cmd.registerCommand(
            'mysqlAzureAuth.editServer',
            (node?: ServerNodeLike) => {
                if (!node) return;
                return editServer(catalog, registry, node.config, explorer);
            }
        ),
        cmd.registerCommand(
            'mysqlAzureAuth.connectServer',
            async (node?: ServerNodeLike) => {
                const config = node?.config ?? (await pickIdleServer(catalog));
                if (!config) {
                    void vscode.window.showInformationMessage(
                        'No idle servers. Register a server first.'
                    );
                    return;
                }
                return connectServer(registry, identity, config, explorer, logChannel);
            }
        ),
        cmd.registerCommand(
            'mysqlAzureAuth.disconnectServer',
            async (node?: ServerNodeLike) => {
                const config = node?.config ?? (await pickConnectedServer(catalog, registry));
                if (!config) {
                    void vscode.window.showInformationMessage('No active sessions.');
                    return;
                }
                return disconnectServer(registry, config.id, explorer);
            }
        ),
        cmd.registerCommand(
            'mysqlAzureAuth.openWorkbench',
            async (node?: ServerNodeLike) => {
                const config = node?.config ?? (await pickAnyServer(catalog));
                if (!config) {
                    void vscode.window.showInformationMessage('No servers registered.');
                    return;
                }
                return openWorkbench(context, registry, config);
            }
        ),
        cmd.registerCommand('mysqlAzureAuth.refreshAll', () => explorer.refresh()),
        cmd.registerCommand(
            'mysqlAzureAuth.previewRows',
            (node?: TableNodeLike) => {
                if (!node) return;
                return previewRows(context, catalog, registry, node);
            }
        ),
        cmd.registerCommand(
            'mysqlAzureAuth.viewMoreRows',
            (node?: TableNodeLike) => {
                if (!node) return;
                return viewMoreRows(context, catalog, registry, node);
            }
        ),
        cmd.registerCommand(
            'mysqlAzureAuth.welcomeAction',
            (action: 'register' | 'readme') =>
                WelcomeNode.run(action).then(refreshWelcomeVisibility)
        )
    );
    logChannel.appendLine('[activate] commands registered.');
}

/**
 * Asynchronous deactivation. The extension host gives us a brief grace
 * period before unloading; we use it to clear refresh intervals and close
 * pools. The intervals are also `unref()`'d, so Node can exit even if this
 * function is short-circuited.
 */
export async function deactivate(): Promise<void> {
    let registry = activeRegistry;
    activeRegistry = undefined;
    if (registry) {
        await registry.disconnectAll();
        registry = undefined;
    }
}

function buildComposition(
    context: vscode.ExtensionContext,
    logChannel: vscode.OutputChannel
): Composition {
    const catalog = new GlobalStateConnectionCatalog(context);
    logChannel.appendLine('[activate] catalog constructed');
    const identity = EntraTokenProvider.createInteractive({
        log: (line) => logChannel.appendLine(`[identity] ${line}`),
    });
    logChannel.appendLine('[activate] interactive identity constructed (deviceCode + vscode + azureCli)');
    const registry = new ActorRegistry({ identity });
    const explorer = new ServerTree({ catalog, registry });
    activeRegistry = registry;
    return { catalog, registry, explorer, identity };
}

/**
 * Create a status bar item that mirrors the first connected server. The
 * status bar is opt-out via `mysqlAzureAuth.enableStatusBar`.
 */
function installStatusBar(
    context: vscode.ExtensionContext,
    registry: ActorRegistry
): vscode.Disposable {
    const enabled = vscode.workspace
        .getConfiguration('mysqlAzureAuth')
        .get<boolean>('enableStatusBar', true);
    if (!enabled) {
        return { dispose: () => undefined };
    }
    const item = ServerTree.makeStatusBarItem(registry);
    const timer = setInterval(() => {
        const connected = registry.listConnectedConfigs();
        const first = connected[0];
        item.text = first ? `$(database) ${first.name} · ${displayDatabase(first.database)}` : '$(circle-outline) No connection';
        item.tooltip = first
            ? `${first.user}@${first.host}:${first.port}/${displayDatabase(first.database)}`
            : 'No MySQL server is connected';
    }, STATUS_BAR_REFRESH_MS);
    timer.unref();
    return {
        dispose: () => {
            clearInterval(timer);
            item.dispose();
        },
    };
}

// ---------- Command handlers ----------

/**
 * Palette entry: pick an idle (disconnected) server from the catalog.
 * Returns undefined if the user cancels or no idle servers exist.
 */
async function pickIdleServer(
    catalog: GlobalStateConnectionCatalog
): Promise<ConnectionConfig | undefined> {
    const all = catalog.list().connections;
    // Heuristic: anything not currently connected by the registry.
    // We don't have a registry reference here; treat all as candidates and
    // let the caller handle the connect attempt.
    if (all.length === 0) return undefined;
    if (all.length === 1) return all[0];
    const picks = all.map((c) => ({
        label: c.name,
        description: `${c.host}/${displayDatabase(c.database)}`,
        config: c,
    }));
    const chosen = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Pick a server to connect',
    });
    return chosen?.config;
}

/**
 * Palette entry: pick a connected server (used by disconnect/openWorkbench).
 */
async function pickConnectedServer(
    catalog: GlobalStateConnectionCatalog,
    registry: ActorRegistry
): Promise<ConnectionConfig | undefined> {
    const all = catalog.list().connections.filter((c) => registry.isConnected(c.id));
    if (all.length === 0) return undefined;
    if (all.length === 1) return all[0];
    const picks = all.map((c) => ({
        label: c.name,
        description: `${c.host}/${displayDatabase(c.database)}`,
        config: c,
    }));
    const chosen = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Pick a server',
    });
    return chosen?.config;
}

/**
 * Palette entry: pick any registered server.
 */
async function pickAnyServer(
    catalog: GlobalStateConnectionCatalog
): Promise<ConnectionConfig | undefined> {
    const all = catalog.list().connections;
    if (all.length === 0) return undefined;
    if (all.length === 1) return all[0];
    const picks = all.map((c) => ({
        label: c.name,
        description: `${c.host}/${displayDatabase(c.database)}`,
        config: c,
    }));
    const chosen = await vscode.window.showQuickPick(picks, {
        placeHolder: 'Pick a server',
    });
    return chosen?.config;
}

async function registerServer(
    catalog: GlobalStateConnectionCatalog,
    explorer: ServerTree
): Promise<void> {
    const outcome = await showServerForm({ mode: 'new' });
    if (outcome.tag === 'cancelled') return;
    await catalog.add(outcome.config);
    explorer.refresh();
    void vscode.window.showInformationMessage(`Server "${outcome.config.name}" registered`);
}

async function forgetServer(
    catalog: GlobalStateConnectionCatalog,
    registry: ActorRegistry,
    id: string,
    explorer: ServerTree
): Promise<void> {
    const stored = catalog.list().connections;
    const target = stored.find((c) => c.id === id);
    if (!target) return;
    const confirm = await vscode.window.showWarningMessage(
        `Forget server "${target.name}"? Saved credentials and cached schema are removed.`,
        { modal: true },
        'Forget'
    );
    if (confirm !== 'Forget') return;
    // Disconnect first so the user never sees "ghost" servers still tearing
    // down.
    await registry.remove(id);
    await catalog.remove(id);
    explorer.refresh();
    vscode.window.showInformationMessage(`Server "${target.name}" forgotten`);
}

async function editServer(
    catalog: GlobalStateConnectionCatalog,
    registry: ActorRegistry,
    existing: ConnectionConfig,
    explorer: ServerTree
): Promise<void> {
    const outcome = await showServerForm({ mode: 'edit', existing });
    if (outcome.tag === 'cancelled') return;
    if (registry.isConnected(existing.id)) {
        await registry.disconnect(existing.id);
    }
    await catalog.update(outcome.config);
    explorer.refresh();
    void vscode.window.showInformationMessage(`Server "${outcome.config.name}" updated`);
}

async function connectServer(
    registry: ActorRegistry,
    identity: EntraTokenProvider,
    config: ConnectionConfig,
    explorer: ServerTree,
    logChannel: vscode.OutputChannel
): Promise<void> {
    logChannel.appendLine(
        `[connectServer] invoked for ${config.name} (${config.id})`
    );
    try {
        await openSession(
            {
                registry,
                identity,
                log: (line) => logChannel.appendLine(`[openSession] ${line}`),
            },
            config
        );
        logChannel.appendLine(`[connectServer] openSession returned for ${config.id}`);
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err ?? '');
        const stack = err instanceof Error ? err.stack : undefined;
        logChannel.appendLine(`[connectServer] FAILED for ${config.id}: ${message}`);
        if (stack) logChannel.appendLine(stack);
        // Routing every external diagnostic through the formatter keeps
        // raw error text, stacks, and any embedded secrets out of the
        // release evidence. The error itself remains in memory for the
        // appended line above and the user-facing toast below.
        // eslint-disable-next-line no-console
        console.log(
            '[mysql-azure-auth] connectServer failed',
            safeDiagnostic({
                operation: 'connectServer',
                credentialSource: 'unknown',
                errorClass: 'class:connection_error',
                connectionState: 'failed',
            })
        );
        void err;
        void vscode.window.showErrorMessage(
            `Connect failed: ${message}. See the "MySQL Azure Auth" output channel for the full stack.`
        );
    }
    explorer.refresh();
}

async function disconnectServer(
    registry: ActorRegistry,
    id: string,
    explorer: ServerTree
): Promise<void> {
    await registry.disconnect(id);
    explorer.refresh();
    vscode.window.showInformationMessage(`Disconnected`);
}

async function openWorkbench(
    context: vscode.ExtensionContext,
    registry: ActorRegistry,
    config: ConnectionConfig
): Promise<void> {
    QueryWorkbench.createOrShow(context.extensionUri, config.id, config.name, {
        registry,
        context,
    });
}

async function previewRows(
    context: vscode.ExtensionContext,
    catalog: GlobalStateConnectionCatalog,
    registry: ActorRegistry,
    node: TableNodeLike
): Promise<void> {
    const connectionName = catalog.list().connections.find(
        (connection) => connection.id === node.connectionId
    )?.name ?? node.connectionId;
    const panel = QueryWorkbench.createOrShow(
        context.extensionUri,
        node.connectionId,
        connectionName,
        { registry, context }
    );
    const sql = buildTableSelect(node, 100);
    panel.setEditorSql(sql);
    await panel.executeQuery(sql);
}

async function viewMoreRows(
    context: vscode.ExtensionContext,
    catalog: GlobalStateConnectionCatalog,
    registry: ActorRegistry,
    node: TableNodeLike
): Promise<void> {
    const connectionName = catalog.list().connections.find(
        (connection) => connection.id === node.connectionId
    )?.name ?? node.connectionId;
    const panel = QueryWorkbench.createOrShow(
        context.extensionUri,
        node.connectionId,
        connectionName,
        { registry, context }
    );
    const sql = buildTableSelect(node, 1000);
    panel.setEditorSql(sql);
    await panel.executeQuery(sql);
}

function buildTableSelect(node: TableNodeLike, limit: number): string {
    const table = escapeSqlIdentifier(node.tableName);
    if (node.databaseName && node.databaseName.length > 0) {
        const db = escapeSqlIdentifier(node.databaseName);
        return `SELECT * FROM \`${db}\`.\`${table}\` LIMIT ${limit};`;
    }
    return `SELECT * FROM \`${table}\` LIMIT ${limit};`;
}