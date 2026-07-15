/**
 * Test fixture factories. Centralized so test files share consistent
 * ConnectionConfig literals and so a future change to the config shape
 * (e.g. branded types) can be propagated by editing one place.
 */

import type { ConnectionConfig } from '../../domain';

let counter = 0;

/**
 * Build a ConnectionConfig with sensible defaults. Override fields via the
 * `overrides` argument; fields not specified receive stable defaults.
 */
export function makeConnectionConfig(
    overrides: Partial<ConnectionConfig> = {}
): ConnectionConfig {
    counter += 1;
    const defaults: ConnectionConfig = {
        id: `cfg-${counter}`,
        name: `Test DB ${counter}`,
        host: 'example.mysql.database.azure.com',
        port: 3306,
        database: 'appdb',
        user: 'me@example.com',
        ssl: true,
        // readOnly is opt-in per the design choice: default off, never
        // surprise the user with a write-block.
        readOnly: false,
    };
    return { ...defaults, ...overrides };
}