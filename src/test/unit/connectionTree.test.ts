/**
 * Tests for the connection tree renderer.
 *
 * After the rewrite, the tree provider is a thin renderer only. Persistence
 * is tested via `connectionStore.test.ts`; schema I/O via
 * `schemaExplorer.test.ts`. These tests verify the tree correctly maps
 * catalog state + registry state to `vscode.TreeItem` instances.
 */

import * as assert from 'assert';
import * as sinon from 'sinon';
import { __test__, extensionContext } from '../mocks/vscode';

import {
    ServerTree,
    ServerNode,
    TableNode,
} from '../../views/connectionExplorer';
import { ActorRegistry } from '../../registry/actorRegistry';
import { GlobalStateConnectionCatalog } from '../../registry/connectionCatalog';
import type { DatabaseSessionConfig, PoolFactory, PoolLike } from '../../registry/databaseSession';
import { makeConnectionConfig } from '../factories/connectionConfig';

/**
 * Stub identity. The tree renderer only inspects registry state, never
 * the credential chain, so a constant-token stub keeps the tests
 * network-free.
 */
function fakeIdentity(): { readonly getAccessToken: () => Promise<string> } {
    return {
        async getAccessToken(): Promise<string> {
            return 'fake-token';
        },
    };
}

function buildFakePool(rows: unknown[] = [], fields: { name: string }[] = []) {
    const fakeEnd = sinon.stub().resolves();
    const fakeExecute = sinon.stub().resolves([rows, fields]);
    const factory: PoolFactory = (_config: DatabaseSessionConfig): PoolLike => ({
        execute: fakeExecute as unknown as PoolLike['execute'],
        end: fakeEnd as unknown as () => Promise<void>,
        // _config retained for assertions if a test wants it
    });
    return { factory, fakeExecute, fakeEnd };
}

suite('ServerTree', () => {
    let registry: ActorRegistry;
    let catalog: GlobalStateConnectionCatalog;
    let provider: ServerTree;

    setup(() => {
        __test__.reset();
        __test__.resetAuth();
        __test__.setNextSession({
            id: 's',
            accessToken: 't',
            account: { id: 'a', label: 'l' },
            scopes: [],
        });
        catalog = new GlobalStateConnectionCatalog(
            extensionContext as unknown as import('vscode').ExtensionContext
        );
        registry = new ActorRegistry({ identity: fakeIdentity() });
        provider = new ServerTree({ catalog, registry });
    });

    teardown(() => {
        __test__.reset();
        __test__.resetAuth();
    });

    test('root children reflect the catalog state', async () => {
        await catalog.add(makeConnectionConfig({ id: 'cfg-1' }));
        await catalog.add(makeConnectionConfig({ id: 'cfg-2', name: 'Other' }));

        const children = await provider.getChildren();
        assert.strictEqual(children.length, 2);
        assert.ok(children[0] instanceof ServerNode);
        assert.ok(children[1] instanceof ServerNode);
        assert.strictEqual((children[0] as ServerNode).contextValue, 'server-idle');
    });

    test('a connected server renders with contextValue=server-live', async () => {
        const fake = buildFakePool();
        const connRegistry = new ActorRegistry({ identity: fakeIdentity(), poolFactory: fake.factory });
        const connProvider = new ServerTree({
            catalog,
            registry: connRegistry,
        });
        await catalog.add(makeConnectionConfig({ id: 'cfg-1' }));
        await connRegistry.connect('cfg-1', makeConnectionConfig({ id: 'cfg-1' }));

        const children = await connProvider.getChildren();
        assert.strictEqual(children.length, 1);
        const item = children[0] as ServerNode;
        assert.strictEqual(item.contextValue, 'server-live');
    });

    test('expanding a connected connection renders table items', async () => {
        const fake = buildFakePool(
            [{ Tables_in_db: 'users' }, { Tables_in_db: 'orders' }],
            [{ name: 'Tables_in_db' }]
        );
        const connRegistry = new ActorRegistry({ identity: fakeIdentity(), poolFactory: fake.factory });
        const connProvider = new ServerTree({
            catalog,
            registry: connRegistry,
        });
        await catalog.add(makeConnectionConfig({ id: 'cfg-1' }));
        await connRegistry.connect('cfg-1', makeConnectionConfig({ id: 'cfg-1' }));

        const rootChildren = await connProvider.getChildren();
        const connItem = rootChildren[0];
        assert.ok(connItem instanceof ServerNode);

        const tableChildren = await connProvider.getChildren(connItem);
        assert.strictEqual(tableChildren.length, 2);
        assert.ok(tableChildren[0] instanceof TableNode);
        assert.strictEqual((tableChildren[0] as TableNode).tableName, 'users');
        assert.strictEqual((tableChildren[0] as TableNode).connectionId, 'cfg-1');
    });

    test('getChildren on a disconnected connection returns an empty array (no tables)', async () => {
        await catalog.add(makeConnectionConfig({ id: 'cfg-1' }));

        const rootChildren = await provider.getChildren();
        const connItem = rootChildren[0];
        assert.ok(connItem instanceof ServerNode);

        const tableChildren = await provider.getChildren(connItem);
        // Disconnected -> tree provider returns empty; user must connect first.
        assert.strictEqual(tableChildren.length, 0);
    });

    test('refresh fires onDidChangeTreeData event', () => {
        let count = 0;
        provider.onDidChangeTreeData(() => count++);
        provider.refresh();
        assert.ok(count >= 1);
    });

    test('getTreeItem returns the element unchanged', () => {
        const item = { label: 'X' } as unknown as import('vscode').TreeItem;
        assert.strictEqual(provider.getTreeItem(item), item);
    });
});