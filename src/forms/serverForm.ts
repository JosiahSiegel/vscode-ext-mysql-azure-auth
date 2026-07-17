/**
 * Server registration/edit form — a single webview panel with all fields
 * visible at once. Replaces the previous five-call showInputBox sequence
 * which forced the user to remember context across modal dialogs.
 *
 * Outcomes are projected through `collectNewServer` / `collectEditedServer`
 * so the public surface (FormPrompts, FormOutcome, isValidTcpPort) stays
 * unchanged. The wizard test in `wizard.test.ts` continues to pass against
 * the pure validation helpers.
 *
 * The webview posts:
 *   { command: 'submit', values: { name, host, port, database, user, ssl } }
 *   { command: 'cancel' }
 * The form posts back:
 *   { type: 'ready' }
 *   { type: 'validate', field, message }   (inline error feedback)
 */

import * as vscode from 'vscode';
import { z } from 'zod';
import type { ConnectionConfig } from '../domain';
import { isValidTcpPort } from './connectionForm';
import { buildServerFormHtml, createServerFormNonce } from './serverFormHtml';

/** Wire-format shape coming back from the webview. */
const submitSchema = z.object({
    name: z.string(),
    host: z.string(),
    port: z.string(),
    database: z.string(),
    user: z.string(),
    ssl: z.boolean(),
    readOnly: z.boolean().optional(),
});
type SubmitValues = z.infer<typeof submitSchema>;

export interface ServerFormOptions {
    readonly mode: 'new' | 'edit';
    readonly existing?: ConnectionConfig;
    readonly envVarHint?: string;
}

interface FormPromise {
    readonly promise: Promise<FormResult>;
    readonly panel: vscode.WebviewPanel;
    readonly disposables: vscode.Disposable[];
}

const liveForms = new Map<string, FormPromise>();

export type FormResult =
    | { readonly tag: 'ok'; readonly config: ConnectionConfig }
    | { readonly tag: 'cancelled' };

/**
 * Show the server form panel. Idempotent per `mode+existing.id`: calling
 * while a panel is open reveals the existing one.
 */
export async function showServerForm(options: ServerFormOptions): Promise<FormResult> {
    const key = options.mode === 'edit' && options.existing
        ? `edit:${options.existing.id}`
        : 'new';

    const live = liveForms.get(key);
    if (live) {
        live.panel.reveal(vscode.ViewColumn.Active);
        return live.promise;
    }

    const panel = vscode.window.createWebviewPanel(
        'mysqlAzureAuth.serverForm',
        options.mode === 'edit' ? 'Edit Server' : 'Register Server',
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
        }
    );

    const disposables: vscode.Disposable[] = [];
    const promise = new Promise<FormResult>((resolve) => {
        let settled = false;
        const settle = (result: FormResult): void => {
            if (settled) return;
            settled = true;
            liveForms.delete(key);
            resolve(result);
            panel.dispose();
        };

        panel.webview.html = buildServerFormHtml({
            nonce: createServerFormNonce(),
            mode: options.mode,
            ...(options.existing ? { existing: options.existing } : {}),
        });
        panel.webview.onDidReceiveMessage(
            (message: unknown) => {
                if (!message || typeof message !== 'object') return;
                const cmd = (message as { command?: unknown }).command;
                if (cmd === 'cancel') {
                    settle({ tag: 'cancelled' });
                    return;
                }
                if (cmd === 'submit') {
                    const parsed = submitSchema.safeParse((message as { values?: unknown }).values);
                    if (!parsed.success) {
                        void panel.webview.postMessage({
                            type: 'error',
                            message: 'Invalid form payload',
                        });
                        return;
                    }
                    const result = validateAndBuild(options, parsed.data);
                    if (result.tag === 'invalid') {
                        void panel.webview.postMessage({
                            type: 'error',
                            message: result.message,
                        });
                        return;
                    }
                    settle(result);
                }
            },
            undefined,
            disposables
        );
        panel.onDidDispose(() => settle({ tag: 'cancelled' }), undefined, disposables);
    });

    const entry: FormPromise = { promise, panel, disposables };
    liveForms.set(key, entry);
    promise.finally(() => {
        while (disposables.length > 0) disposables.pop()?.dispose();
    });
    return promise;
}

type ValidationResult =
    | { readonly tag: 'ok'; readonly config: ConnectionConfig }
    | { readonly tag: 'invalid'; readonly message: string };

function validateAndBuild(options: ServerFormOptions, raw: SubmitValues): ValidationResult {
    const name = raw.name.trim();
    const host = raw.host.trim();
    const database = raw.database.trim();
    const user = raw.user.trim();

    if (!name) return { tag: 'invalid', message: 'Display label is required.' };
    if (!host) return { tag: 'invalid', message: 'Hostname is required.' };
    // database is now optional; the workbench + driver accept schema-qualified queries against any database the principal has access to.
    if (!user) return { tag: 'invalid', message: 'Entra principal is required.' };

    const portStr = raw.port.trim();
    if (!portStr) return { tag: 'invalid', message: 'Port is required.' };
    if (!/^\d+$/.test(portStr)) {
        return { tag: 'invalid', message: 'Port must be an integer between 1 and 65535.' };
    }
    const port = Number.parseInt(portStr, 10);
    if (!isValidTcpPort(port)) {
        return { tag: 'invalid', message: 'Port must be an integer between 1 and 65535.' };
    }

    const base: ConnectionConfig = options.existing
        ? options.existing
        : {
            id: '',
            name,
            host,
            port,
            database,
            user,
            ssl: raw.ssl,
        };

    const config: ConnectionConfig = {
        ...base,
        name,
        host,
        port,
        database,
        user,
        ssl: raw.ssl,
        ...(raw.readOnly ? { readOnly: true } : {}),
    };

    // Generate an id for the new path; pass through for edit.
    if (!config.id) {
        const id = globalThis.crypto.randomUUID();
        return { tag: 'ok', config: { ...config, id } };
    }
    return { tag: 'ok', config };
}
