/**
 * Connection onboarding form. It gathers and validates settings without
 * touching persistence. Submitted values are treated literally; environment
 * variable interpolation is intentionally unsupported.
 *
 * The database remains free-text only. A database quick-pick is intentionally
 * deferred because inserting it would change the established TLS pick contract.
 */

import type { ConnectionConfig } from '../domain';

export interface FormPrompts {
    showInputBox: (options: {
        prompt: string;
        placeHolder?: string;
        value?: string;
    }) => Promise<string | undefined>;
    showQuickPick: (
        items: readonly string[],
        options: { placeHolder?: string }
    ) => Promise<string | undefined>;
    reportWarning: (message: string) => void;
}

export type FormOutcome =
    | { readonly tag: 'ok'; readonly config: ConnectionConfig }
    | { readonly tag: 'cancelled' }
    | { readonly tag: 'invalid'; readonly message: string };

const VALID_TCP_PORT_MIN = 1;
const VALID_TCP_PORT_MAX = 65535;
const TLS_ITEMS = ['Encrypt (recommended)', 'Plaintext'] as const;

/**
 * Enables additive validation summaries for form hosts that opt in. It is
 * disabled by default to preserve the established fail-fast wizard contract.
 */
export const validationSummaryMode = false;

export function isValidTcpPort(value: number): boolean {
    return (
        Number.isInteger(value) &&
        value >= VALID_TCP_PORT_MIN &&
        value <= VALID_TCP_PORT_MAX
    );
}

function parsePortString(raw: string): number | undefined {
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    // Reject decimals and exponential notation explicitly.
    if (!/^\d+$/.test(trimmed)) return undefined;
    const n = Number.parseInt(trimmed, 10);
    if (!isValidTcpPort(n)) return undefined;
    return n;
}

/**
 * Gather a new connection in the stable order label, host, port, database,
 * user, then TLS. Values are persisted literally. Host copy advertises the
 * Azure FQDN shape; label copy suggests `prod`, `stage`, and `dev` suffixes.
 *
 * `FormPrompts` deliberately remains the three-method compatibility contract.
 * A future prompt adapter may accept `suggestions?: readonly string[]`, and
 * `validationSummaryMode` reserves opt-in aggregate validation; both are no-ops
 * here. Database selection remains free-text so TLS stays the first quick-pick.
 */
export async function collectNewServer(
    sinks: FormPrompts,
    generateId: () => string
): Promise<FormOutcome> {
    const nameRaw = await sinks.showInputBox({
        prompt: 'Display label · group with a prod, stage, or dev suffix',
        placeHolder: 'analytics-prod · suggestions: prod, stage, dev',
    });
    if (!nameRaw) return { tag: 'cancelled' };

    const hostRaw = await sinks.showInputBox({
        prompt: 'Flexible Server hostname',
        placeHolder: 'myserver.mysql.database.azure.com',
    });
    if (!hostRaw) return { tag: 'cancelled' };

    const portRaw = await sinks.showInputBox({
        prompt: 'TCP port',
        value: '3306',
    });
    if (portRaw === undefined) return { tag: 'cancelled' };
    const port = parsePortString(portRaw);
    if (port === undefined) {
        return {
            tag: 'invalid',
            message: `Port must be an integer between ${VALID_TCP_PORT_MIN} and ${VALID_TCP_PORT_MAX}.`,
        };
    }

    const databaseRaw = await sinks.showInputBox({
        prompt: 'Default schema',
        placeHolder: 'appdb',
    });
    if (!databaseRaw) return { tag: 'cancelled' };

    const userRaw = await sinks.showInputBox({
        prompt: 'Entra principal',
        placeHolder: 'name@your-tenant.onmicrosoft.com',
    });
    if (!userRaw) return { tag: 'cancelled' };

    const name = nameRaw;
    const host = hostRaw;
    const database = databaseRaw;
    const user = userRaw;

    const tlsPick = await sinks.showQuickPick(TLS_ITEMS, {
        placeHolder: 'Transport encryption',
    });
    if (tlsPick === undefined) {
        sinks.reportWarning(
            'TLS picker was dismissed; defaulting to plaintext. Use this only on trusted networks.'
        );
        return {
            tag: 'ok',
            config: {
                id: generateId(),
                name,
                host,
                port,
                database,
                user,
                ssl: false,
            },
        };
    }
    const ssl = tlsPick === 'Encrypt (recommended)';
    if (!ssl) {
        sinks.reportWarning('TLS disabled for this server. Credentials and rows transit in cleartext.');
    }

    return {
        tag: 'ok',
        config: { id: generateId(), name, host, port, database, user, ssl },
    };
}

/**
 * Edit an existing connection with the same five-input/TLS sequence as create.
 * Submitted strings are kept literal and the port is validated directly.
 * Host and label copy retain the modern endpoint/group hints.
 *
 * The optional `suggestions?: readonly string[]` prompt evolution and aggregate
 * `validationSummaryMode` are forward-compatible no-ops. Database stays
 * free-text, and dismissing TLS preserves the existing encryption choice.
 */
export async function collectEditedServer(
    sinks: FormPrompts,
    existing: ConnectionConfig
): Promise<FormOutcome> {
    const nameRaw = await sinks.showInputBox({
        prompt: 'Display label · group with a prod, stage, or dev suffix',
        placeHolder: 'analytics-prod · suggestions: prod, stage, dev',
        value: existing.name,
    });
    if (nameRaw === undefined) return { tag: 'cancelled' };

    const hostRaw = await sinks.showInputBox({
        prompt: 'Flexible Server hostname',
        placeHolder: 'myserver.mysql.database.azure.com',
        value: existing.host,
    });
    if (hostRaw === undefined) return { tag: 'cancelled' };

    const portRaw = await sinks.showInputBox({
        prompt: 'TCP port',
        value: String(existing.port),
    });
    if (portRaw === undefined) return { tag: 'cancelled' };
    const port = parsePortString(portRaw);
    if (port === undefined) {
        return {
            tag: 'invalid',
            message: `Port must be an integer between ${VALID_TCP_PORT_MIN} and ${VALID_TCP_PORT_MAX}.`,
        };
    }

    const databaseRaw = await sinks.showInputBox({
        prompt: 'Default schema',
        value: existing.database,
    });
    if (databaseRaw === undefined) return { tag: 'cancelled' };

    const userRaw = await sinks.showInputBox({
        prompt: 'Entra principal',
        value: existing.user,
    });
    if (userRaw === undefined) return { tag: 'cancelled' };

    const name = nameRaw;
    const host = hostRaw;
    const database = databaseRaw;
    const user = userRaw;

    const tlsPick = await sinks.showQuickPick(TLS_ITEMS, {
        placeHolder: 'Transport encryption',
    });
    // For edit, an undefined pick means "keep existing".
    const ssl = tlsPick === undefined ? existing.ssl : tlsPick === 'Encrypt (recommended)';
    if (tlsPick !== undefined && !ssl) {
        sinks.reportWarning('TLS disabled for this server. Credentials and rows transit in cleartext.');
    }

    return {
        tag: 'ok',
        config: {
            ...existing,
            name,
            host,
            port,
            database,
            user,
            ssl,
        },
    };
}