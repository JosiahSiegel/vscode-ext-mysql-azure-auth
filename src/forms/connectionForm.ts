/**
 * Connection onboarding form. It gathers and validates settings without
 * touching persistence. Submitted values are treated literally; environment
 * variable interpolation is intentionally unsupported.
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
    /**
     * Modal confirmation prompt used when a non-Azure host picks plaintext.
     * The form only proceeds when the user explicitly accepts that
     * credentials and rows will transit in cleartext. Defaults to a
     * plain warning if the host does not provide a sink.
     */
    confirmPlaintext?: (host: string) => Promise<boolean>;
}

export type FormOutcome =
    | { readonly tag: 'ok'; readonly config: ConnectionConfig }
    | { readonly tag: 'cancelled' }
    | { readonly tag: 'invalid'; readonly message: string };

const VALID_TCP_PORT_MIN = 1;
const VALID_TCP_PORT_MAX = 65535;
const TLS_ITEMS = ['Encrypt (recommended)', 'Plaintext'] as const;

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
 * True iff `host` matches the canonical Azure Database for MySQL Flexible
 * Server pattern. The check is case-insensitive, ignores an optional
 * trailing dot (FQDN form), and is otherwise exact so a host like
 * `foo.mysql.database.azure.com.attacker.example` is NOT treated as Azure.
 *
 * Export this helper so unit tests can drive it without spinning up the
 * form prompts.
 */
export function isAzureMysqlHost(host: string): boolean {
    const trimmed = host.trim().toLowerCase();
    const noTrailingDot = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
    return noTrailingDot.endsWith('.mysql.database.azure.com');
}

/**
 * Resolve the effective `ssl` flag for the form submission, enforcing
 * the policy:
 *   - Azure hosts must use TLS; a plaintext pick is rejected outright.
 *   - Non-Azure hosts may pick plaintext, but only after an explicit
 *     modal confirmation (or, if no modal sink is wired, a plain
 *     warning). Plaintext defaults to "no" otherwise.
 *   - Default for an ambiguous outcome is always TLS.
 */
export async function resolveSsl(
    host: string,
    tlsPick: string | undefined,
    sinks: FormPrompts
): Promise<{ readonly ssl: boolean; readonly warning?: string }> {
    const azure = isAzureMysqlHost(host);

    if (tlsPick === undefined) {
        // Dismissed: keep TLS. Azure hosts would reject plaintext anyway,
        // and for non-Azure we never silently downgrade.
        return { ssl: true };
    }

    const ssl = tlsPick === 'Encrypt (recommended)';
    if (ssl) {
        return { ssl: true };
    }

    // tlsPick === 'Plaintext'
    if (azure) {
        sinks.reportWarning(
            `TLS is mandatory for ${host}: Azure MySQL Flexible Server refuses plaintext connections.`
        );
        return {
            ssl: false,
            warning: `TLS is mandatory for ${host}; please pick "Encrypt (recommended)" instead.`,
        };
    }

    const confirmed = sinks.confirmPlaintext
        ? await sinks.confirmPlaintext(host)
        : false;
    if (!confirmed) {
        sinks.reportWarning(
            `Plaintext was not confirmed for ${host}; defaulting to TLS.`
        );
        return { ssl: true };
    }

    sinks.reportWarning(
        `TLS disabled for ${host}. Credentials and rows will transit in cleartext.`
    );
    return {
        ssl: false,
        warning: `Plaintext confirmed for ${host}: credentials and rows transit in cleartext.`,
    };
}

/**
 * Gather a new connection in the stable order label, host, port, then
 * user, then TLS. Values are persisted literally. Host copy advertises the
 * Azure FQDN shape; label copy suggests `prod`, `stage`, and `dev` suffixes.
 *
 * `FormPrompts` deliberately remains the three-method compatibility contract.
 * A future prompt adapter may accept `suggestions?: readonly string[]`; this
 * is a forward-compatible no-op. TLS stays the first quick-pick.
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

    const userRaw = await sinks.showInputBox({
        prompt: 'Entra principal',
        placeHolder: 'name@your-tenant.onmicrosoft.com',
    });
    if (!userRaw) return { tag: 'cancelled' };

    const name = nameRaw;
    const host = hostRaw;
    const user = userRaw;

    const tlsPick = await sinks.showQuickPick(TLS_ITEMS, {
        placeHolder: 'Transport encryption',
    });
    const ssl = await resolveSsl(host, tlsPick, sinks);
    if (isAzureMysqlHost(host) && tlsPick === 'Plaintext') {
        // Re-prompt: Azure hosts cannot use plaintext under any circumstance.
        const retryPick = await sinks.showQuickPick(['Encrypt (recommended)'], {
            placeHolder: 'TLS is mandatory for Azure hosts; pick "Encrypt (recommended)"',
        });
        if (retryPick === undefined) {
            return { tag: 'cancelled' };
        }
        return {
            tag: 'ok',
            config: { id: generateId(), name, host, port, user, ssl: true },
        };
    }

    return {
        tag: 'ok',
        config: { id: generateId(), name, host, port, user, ssl: ssl.ssl },
    };
}

/**
 * Edit an existing connection with the same four-input/TLS sequence as create.
 * Submitted strings are kept literal and the port is validated directly.
 * Host and label copy retain the modern endpoint/group hints.
 *
 * The optional `suggestions?: readonly string[]` prompt evolution is a
 * forward-compatible no-op. Dismissing TLS preserves the existing encryption
 * choice.
 *
 * On edit, the Azure plaintext block is absolute: the user is bounced back
 * to TLS without saving. Otherwise the resolved ssl matches the existing
 * record when the picker is dismissed.
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

    const userRaw = await sinks.showInputBox({
        prompt: 'Entra principal',
        value: existing.user,
    });
    if (userRaw === undefined) return { tag: 'cancelled' };

    const name = nameRaw;
    const host = hostRaw;
    const user = userRaw;

    const tlsPick = await sinks.showQuickPick(TLS_ITEMS, {
        placeHolder: 'Transport encryption',
    });
    // For edit, an undefined pick means "keep existing".
    let ssl = tlsPick === undefined ? existing.ssl : tlsPick === 'Encrypt (recommended)';
    if (tlsPick !== undefined && tlsPick === 'Plaintext') {
        if (isAzureMysqlHost(host)) {
            sinks.reportWarning(
                `TLS is mandatory for ${host}; plaintext changes were not applied.`
            );
            ssl = true;
        } else if (sinks.confirmPlaintext) {
            const confirmed = await sinks.confirmPlaintext(host);
            if (!confirmed) {
                sinks.reportWarning(
                    `Plaintext was not confirmed for ${host}; keeping the previous TLS setting.`
                );
                ssl = existing.ssl;
            } else {
                sinks.reportWarning(
                    `TLS disabled for ${host}. Credentials and rows will transit in cleartext.`
                );
            }
        } else {
            sinks.reportWarning(
                `Plaintext was not confirmed for ${host}; keeping the previous TLS setting.`
            );
            ssl = existing.ssl;
        }
    }

    return {
        tag: 'ok',
        config: {
            ...existing,
            name,
            host,
            port,
            user,
            ssl,
        },
    };
}