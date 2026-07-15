/**
 * Locks the public surface of the extension. Any change to package.json that
 * alters the command IDs, the storage key, the contributes shape, or the
 * activation event strings MUST update this test intentionally. This catches
 * accidental drift in CI.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require(path.resolve(__dirname, '..', '..', '..', 'package.json')) as {
    name: string;
    publisher: string;
    displayName: string;
    main: string;
    icon: string;
    activationEvents: string[];
    contributes: {
        commands: { command: string; title: string; category: string; icon?: string }[];
        viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
        views: Record<string, { id: string; name: string }[]>;
        configuration: { title: string; properties: Record<string, { type: string; default: unknown }> };
        menus: Record<string, unknown[]>;
    };
};

suite('Public surface lock', () => {
    test('extension identity is preserved', () => {
        assert.strictEqual(pkg.name, 'mysql-azure-auth');
        assert.strictEqual(pkg.displayName, 'MySQL Azure Auth');
        assert.strictEqual(pkg.main, './out/main.js');
    });

    test('all 9 command IDs and their categories are preserved', () => {
        const expectedIds = [
            'mysqlAzureAuth.registerServer',
            'mysqlAzureAuth.forgetServer',
            'mysqlAzureAuth.editServer',
            'mysqlAzureAuth.connectServer',
            'mysqlAzureAuth.disconnectServer',
            'mysqlAzureAuth.openWorkbench',
            'mysqlAzureAuth.refreshAll',
            'mysqlAzureAuth.previewRows',
            'mysqlAzureAuth.viewMoreRows',
        ];
        const actualIds = pkg.contributes.commands.map((c) => c.command);
        assert.deepStrictEqual(actualIds, expectedIds);

        // Every command sits in the "MySQL Azure Auth" category.
        for (const cmd of pkg.contributes.commands) {
            assert.strictEqual(
                cmd.category,
                'MySQL Azure Auth',
                `category for ${cmd.command}`
            );
        }
    });

    test('activation events include the 9 commands and the tree view', () => {
        const events = pkg.activationEvents;
        assert.ok(events.includes('onView:mysqlAzureAuth.serversView'));
        for (const cmd of [
            'mysqlAzureAuth.registerServer',
            'mysqlAzureAuth.connectServer',
            'mysqlAzureAuth.disconnectServer',
            'mysqlAzureAuth.openWorkbench',
            'mysqlAzureAuth.previewRows',
            'mysqlAzureAuth.viewMoreRows',
            'mysqlAzureAuth.forgetServer',
            'mysqlAzureAuth.editServer',
            'mysqlAzureAuth.refreshAll',
        ]) {
            assert.ok(events.includes(`onCommand:${cmd}`), `activation for ${cmd}`);
        }
        // Locked contract: `onLanguage:sql`, `onLanguage:mysql`, and
        // `workspaceContains:**/.vscode/mysql.json` were removed by Todo 2
        // and locked in by Todo 7's MANIFEST READY branch. This test must
        // stay in sync with the validator; if any of these linger, the
        // manifest validator still fails.
        for (const forbidden of [
            'onLanguage:sql',
            'onLanguage:mysql',
            'workspaceContains:**/.vscode/mysql.json',
        ]) {
            assert.ok(
                !events.includes(forbidden),
                `activation ${forbidden} must not be present; the validator contract forbids it`
            );
        }
    });

    test('views container and views are preserved', () => {
        assert.strictEqual(
            pkg.contributes.viewsContainers.activitybar[0]?.id,
            'mysql-azure-auth'
        );
        assert.strictEqual(
            pkg.contributes.viewsContainers.activitybar[0]?.title,
            'MySQL Azure Auth'
        );
        const serversView = pkg.contributes.views['mysql-azure-auth']?.[0];
        assert.ok(serversView, 'expected servers view');
        assert.strictEqual(serversView.id, 'mysqlAzureAuth.serversView');
        assert.strictEqual(serversView.name, 'Servers');
    });

    test('settings keys match the locked contract (regression: storage reads these exact keys)', () => {
        // Locked contract: the Todo 2 cleanup removed `mysqlAzureAuth.servers`
        // and `mysqlAzureAuth.connectionColors` (they were unused / unread).
        // The remaining settings are only the three that production code actually
        // consumes today. This test must stay in sync with the validator
        // MANIFEST READY contract from Todo 7.
        const properties = pkg.contributes.configuration.properties;
        const expectedKeys = [
            'mysqlAzureAuth.historyLimit',
            'mysqlAzureAuth.showRowCounts',
            'mysqlAzureAuth.enableStatusBar',
        ];
        for (const key of expectedKeys) {
            assert.ok(properties[key], `expected ${key} setting`);
        }
        for (const forbidden of [
            'mysqlAzureAuth.servers',
            'mysqlAzureAuth.connectionColors',
        ]) {
            assert.ok(
                !properties[forbidden],
                `setting ${forbidden} must not be present; the validator contract forbids it`
            );
        }
    });

    test('integration test hand-built context and the integration suite rely on the same contract', () => {
        const commandIds = pkg.contributes.commands.map((c) => c.command);
        const integrationExpected = [
            'mysqlAzureAuth.registerServer',
            'mysqlAzureAuth.forgetServer',
            'mysqlAzureAuth.editServer',
            'mysqlAzureAuth.connectServer',
            'mysqlAzureAuth.disconnectServer',
            'mysqlAzureAuth.openWorkbench',
            'mysqlAzureAuth.refreshAll',
            'mysqlAzureAuth.previewRows',
            'mysqlAzureAuth.viewMoreRows',
        ];
        for (const id of integrationExpected) {
            assert.ok(
                commandIds.includes(id),
                `integration expects command ${id} to be registered`
            );
        }
    });

    test('package.json parses as valid JSON (catches editing mistakes)', () => {
        const text = fs.readFileSync(
            path.resolve(__dirname, '..', '..', '..', 'package.json'),
            'utf8'
        );
        const parsed = JSON.parse(text);
        assert.strictEqual(typeof parsed, 'object');
    });

    test('no command title matches the original titles verbatim', () => {
        // The original used "Add Connection", "Connect", "New Query", etc.
        // as user-visible titles. Verify none of those survive.
        const forbiddenTitles = [
            'Add Connection',
            'Remove Connection',
            'Edit Connection',
            'Connect',
            'Disconnect',
            'New Query',
            'Refresh Connections',
            'Preview Table Data',
            'Edit Table Data',
            'Create Table',
        ];
        const titles = pkg.contributes.commands.map((c) => c.title);
        for (const bad of forbiddenTitles) {
            assert.ok(
                !titles.includes(bad),
                `title "${bad}" matches the original; rewrite the UX copy`
            );
        }
    });

    test('extension icon and activity-bar icon are fresh (not the original)', () => {
        // The original shipped a MySQL dolphin cylinder SVG. The rewrite
        // uses a server-stack-with-key glyph. Both the PNG (for the
        // Marketplace gallery) and the SVG (for the activity bar) must
        // be present and the activity-bar SVG must NOT be the original
        // dolphin design.
        const fs = require('fs');
        const path = require('path');
        const root = path.resolve(__dirname, '..', '..', '..');
        const iconPng = path.join(root, 'resources', 'icons', 'icon.png');
        const activityBarSvg = path.join(
            root,
            'resources',
            'icons',
            'server-key.svg'
        );
        assert.ok(
            fs.existsSync(iconPng),
            `${iconPng} must exist for the Marketplace gallery`
        );
        assert.ok(
            fs.existsSync(activityBarSvg),
            `${activityBarSvg} must exist for the activity bar`
        );
        const activityBarContents = fs.readFileSync(activityBarSvg, 'utf8');
        // The original SVG was a cylinder with three ellipse + two paths
        // (the dolphin logo). The rewrite adds a key glyph (circle +
        // shaft + teeth) so we assert by feature: presence of the key ring.
        assert.ok(
            /circle\s+[^>]*r="3"/.test(activityBarContents),
            'activity-bar SVG must contain a key ring'
        );
        assert.ok(
            pkg.icon === 'resources/icons/icon.png',
            'package.json icon must point at the PNG resource'
        );
        const activityBarIcon =
            pkg.contributes.viewsContainers.activitybar[0]?.icon;
        assert.ok(
            activityBarIcon === 'resources/icons/server-key.svg',
            `activity bar icon must be the new server-key glyph; got: ${activityBarIcon}`
        );
    });
});