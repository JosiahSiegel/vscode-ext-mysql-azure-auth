import * as assert from 'assert';
import * as vscode from 'vscode';
import * as sinon from 'sinon';
import { ActorRegistry } from '../../registry/actorRegistry';
import { ServerTree } from '../../views/connectionExplorer';
import { activate, deactivate } from '../../main';
import { __test__, extensionContext } from '../mocks/vscode';

interface MutableWindow {
    createOutputChannel: () => vscode.OutputChannel;
    registerTreeDataProvider: () => vscode.Disposable;
}

function activateExtension(): void {
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
    sinon.stub(ServerTree, 'makeStatusBarItem').returns({
        text: '',
        tooltip: undefined,
        dispose: () => undefined,
    } as vscode.StatusBarItem);
    mutableWindow.registerTreeDataProvider = () => ({ dispose: () => undefined });
    __test__.commandHandlers.set('setContext', () => undefined);
    activate(extensionContext as unknown as vscode.ExtensionContext);
}

suite('Main lifecycle', () => {
    setup(async () => {
        await deactivate();
        __test__.reset();
    });

    teardown(async () => {
        await deactivate();
        for (const disposable of extensionContext.subscriptions.splice(0)) {
            if (typeof disposable.dispose === 'function') disposable.dispose();
        }
        sinon.restore();
    });

    test('deactivate before activation is a safe no-op', async () => {
        await deactivate();
    });

    test('sequential deactivate calls disconnect the active registry once', async () => {
        const disconnectAll = sinon.stub(ActorRegistry.prototype, 'disconnectAll').resolves();
        activateExtension();

        await deactivate();
        await deactivate();

        assert.strictEqual(disconnectAll.callCount, 1);
    });

    test('concurrent deactivate calls do not double-disconnect', async () => {
        let finishDisconnect: (() => void) | undefined;
        const disconnectAll = sinon.stub(ActorRegistry.prototype, 'disconnectAll').callsFake(
            () => new Promise<void>((resolve) => {
                finishDisconnect = resolve;
            })
        );
        activateExtension();

        const first = deactivate();
        const second = deactivate();
        assert.strictEqual(disconnectAll.callCount, 1);

        finishDisconnect?.();
        await Promise.all([first, second]);
        assert.strictEqual(disconnectAll.callCount, 1);
    });
});
