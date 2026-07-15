import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { activate, deactivate } from '../../main';
import { GlobalStateConnectionCatalog } from '../../registry/connectionCatalog';
import { ServerTree } from '../../views/connectionExplorer';
import { QueryWorkbench } from '../../views/queryWorkbench';
import { makeConnectionConfig } from '../factories/connectionConfig';
import { __test__, extensionContext } from '../mocks/vscode';

interface MutableWindow {
    createOutputChannel: () => vscode.OutputChannel;
    createWebviewPanel: typeof vscode.window.createWebviewPanel;
    registerTreeDataProvider: () => vscode.Disposable;
}

function installActivationStubs(titles: string[]): void {
    const mutableWindow = vscode.window as unknown as MutableWindow;
    mutableWindow.createOutputChannel = () => ({
        append: () => undefined,
        appendLine: () => undefined,
        clear: () => undefined,
        replace: () => undefined,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
        name: 'MySQL Azure Auth',
    });
    mutableWindow.registerTreeDataProvider = () => ({ dispose: () => undefined });
    mutableWindow.createWebviewPanel = (_viewType, title) => {
        titles.push(title);
        return {
            webview: {
                html: '',
                onDidReceiveMessage: () => ({ dispose: () => undefined }),
                postMessage: async () => true,
                asWebviewUri: (uri: unknown) => uri,
            },
            onDidDispose: () => ({ dispose: () => undefined }),
            dispose: () => undefined,
            reveal: () => undefined,
        } as unknown as vscode.WebviewPanel;
    };
    sinon.stub(ServerTree, 'makeStatusBarItem').returns({
        text: '',
        tooltip: undefined,
        dispose: () => undefined,
    } as vscode.StatusBarItem);
    __test__.commandHandlers.set('setContext', () => undefined);
}

suite('Main table commands', () => {
    setup(async () => {
        await deactivate();
        __test__.reset();
        QueryWorkbench.currentPanels.clear();
    });

    teardown(async () => {
        await deactivate();
        QueryWorkbench.currentPanels.clear();
        extensionContext.subscriptions.splice(0);
        sinon.restore();
    });

    test('previewRows keys the panel by connection ID and titles it with the server label', async () => {
        const titles: string[] = [];
        installActivationStubs(titles);
        const context = extensionContext as unknown as vscode.ExtensionContext;
        const catalog = new GlobalStateConnectionCatalog(context);
        await catalog.add(makeConnectionConfig({ id: 'cfg-1', name: 'production' }));
        activate(context);

        await vscode.commands.executeCommand('mysqlAzureAuth.previewRows', {
            connectionId: 'cfg-1',
            tableName: 'users',
        });
        await vscode.commands.executeCommand('mysqlAzureAuth.previewRows', {
            connectionId: 'cfg-1',
            tableName: 'orders',
        });

        assert.deepStrictEqual(titles, ['Query: production']);
        assert.strictEqual(QueryWorkbench.currentPanels.has('cfg-1'), true);
        assert.strictEqual(QueryWorkbench.currentPanels.has('users'), false);
        assert.strictEqual(QueryWorkbench.currentPanels.has('orders'), false);
    });

    test('viewMoreRows titles the panel with the server label', async () => {
        const titles: string[] = [];
        installActivationStubs(titles);
        const context = extensionContext as unknown as vscode.ExtensionContext;
        const catalog = new GlobalStateConnectionCatalog(context);
        await catalog.add(makeConnectionConfig({ id: 'cfg-2', name: 'staging' }));
        activate(context);

        await vscode.commands.executeCommand('mysqlAzureAuth.viewMoreRows', {
            connectionId: 'cfg-2',
            tableName: 'users',
        });

        assert.deepStrictEqual(titles, ['Query: staging']);
    });
});
