/**
 * Lightweight mock of the `vscode` module used by unit tests.
 *
 * Production code externalizes `vscode` (via esbuild) and relies on the real
 * VS Code host. Unit tests instead bundle this mock into the test output so
 * that `import * as vscode from 'vscode'` resolves to a minimal in-memory
 * implementation that supports the surface area exercised by our tests.
 *
 * Only the APIs touched by `src/` are implemented. Anything we forgot will
 * surface as a TypeError at runtime, which makes test gaps obvious.
 */

type EventListener<T> = (e: T) => any;

// Matches the VS Code `Disposable` shape: { dispose(): any }.
interface DisposableLike {
    dispose(): unknown;
}

// Matches the VS Code `Event<T>` shape: a callable that takes a listener and
// returns a Disposable. The real type is more elaborate, but the function
// signature is what callers actually use.
type VsCodeEvent<T> = (listener: EventListener<T>, thisArgs?: unknown) => DisposableLike;

class EventEmitter<T> {
    private listeners: EventListener<T>[] = [];

    /**
     * Subscribable event. Matches the VS Code `Event<T>` shape:
     * calling it registers a listener and returns a Disposable.
     */
    get event(): VsCodeEvent<T> {
        const subscribe = (listener: EventListener<T>): DisposableLike => {
            this.listeners.push(listener);
            return {
                dispose: () => {
                    this.listeners = this.listeners.filter((l) => l !== listener);
                },
            };
        };
        return subscribe;
    }

    fire(data: T): void {
        for (const listener of this.listeners) {
            listener(data);
        }
    }

    dispose(): void {
        this.listeners = [];
    }
}

// Re-exported by `vscode` namespace.
export { EventEmitter };

export enum TreeItemCollapsibleState {
    None = 0,
    Collapsed = 1,
    Expanded = 2,
}

export enum ProgressLocation {
    Notification = 15,
}

export enum StatusBarAlignment {
    Left = 1,
    Right = 2,
}

export enum ViewColumn {
    One = 1,
    Two = 2,
    Three = 3,
    Beside = -2,
    Active = -1,
}

export class ThemeIcon {
    constructor(
        public readonly id: string,
        public readonly color?: ThemeColor
    ) {}
}

export class ThemeColor {
    constructor(public readonly id: string) {}
}

export class TreeItem {
    label?: string;
    description?: string;
    tooltip?: string;
    contextValue?: string;
    iconPath?: ThemeIcon;
    collapsibleState?: TreeItemCollapsibleState;

    constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
        this.label = label;
        // exactOptionalPropertyTypes: assign undefined only when explicitly
        // provided, otherwise leave the property unset.
        if (collapsibleState !== undefined) {
            this.collapsibleState = collapsibleState;
        }
    }
}

// ---------- In-memory globalState / secrets / context ----------

class MockGlobalState {
    private items = new Map<string, unknown>();

    get<T>(key: string, defaultValue?: T): T {
        return this.items.has(key) ? (this.items.get(key) as T) : (defaultValue as T);
    }

    async update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            this.items.delete(key);
        } else {
            this.items.set(key, value);
        }
    }

    keys(): readonly string[] {
        return Array.from(this.items.keys());
    }

    clear(): void {
        this.items.clear();
    }
}

class MockSecretStorage {
    private items = new Map<string, string>();

    get(key: string): string | undefined {
        return this.items.get(key);
    }

    async store(key: string, value: string): Promise<void> {
        this.items.set(key, value);
    }

    async delete(key: string): Promise<void> {
        this.items.delete(key);
    }
}

const globalState = new MockGlobalState();
const workspaceState = new MockGlobalState();
const secrets = new MockSecretStorage();
const subscriptions: { dispose(): unknown }[] = [];

const extensionUriStub = {
    toString: () => 'vscode-resource://test',
    fsPath: '/tmp/test',
    scheme: 'vscode-resource',
    path: '/test',
    authority: '',
    query: '',
    fragment: '',
};

interface MockExtensionContext {
    subscriptions: { dispose(): unknown }[];
    globalState: MockGlobalState;
    workspaceState: MockGlobalState;
    secrets: MockSecretStorage;
    extensionUri: typeof extensionUriStub;
    extensionPath: string;
    extensionMode: number;
    storageUri: undefined;
    storagePath: undefined;
    logUri: undefined;
    logPath: undefined;
    globalStorageUri: undefined;
    globalStoragePath: string;
    asAbsolutePath: (p: string) => string;
    environmentVariableCollection: undefined;
    languageModelAccessInformation: undefined;
    extension: {
        id: string;
        extensionUri: typeof extensionUriStub;
        extensionPath: string;
        isActive: boolean;
        packageJSON: Record<string, unknown>;
        exports: Record<string, unknown>;
        activate: () => Promise<void>;
    };
}

export const extensionContext: MockExtensionContext = {
    subscriptions,
    globalState,
    workspaceState,
    secrets,
    extensionUri: extensionUriStub,
    extensionPath: '/tmp/test',
    extensionMode: 1, // Production: ExtensionMode.Production
    storageUri: undefined,
    storagePath: undefined,
    logUri: undefined,
    logPath: undefined,
    globalStorageUri: undefined,
    globalStoragePath: '/tmp/global',
    asAbsolutePath: (p: string) => `/tmp/test/${p}`,
    environmentVariableCollection: undefined,
    languageModelAccessInformation: undefined,
    extension: {
        id: 'test.mysql-azure-auth',
        extensionUri: extensionUriStub,
        extensionPath: '/tmp/test',
        isActive: true,
        packageJSON: {},
        exports: {},
        activate: async () => undefined,
    },
};

// ---------- commands ----------

const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
const executedCommands: { command: string; args: unknown[] }[] = [];

export const commands = {
    registerCommand: (
        command: string,
        callback: (...args: unknown[]) => unknown
    ) => {
        commandHandlers.set(command, callback);
        return { dispose: () => commandHandlers.delete(command) };
    },
    executeCommand: async (command: string, ...args: unknown[]) => {
        executedCommands.push({ command, args });
        const handler = commandHandlers.get(command);
        if (!handler) {
            throw new Error(`No handler registered for command: ${command}`);
        }
        return handler(...args);
    },
    getCommands: async () => Array.from(commandHandlers.keys()),
};

// ---------- window ----------

interface InputBoxOptions {
    prompt?: string;
    placeHolder?: string;
    value?: string;
}

interface QuickPickOptions {
    placeHolder?: string;
}

interface QueuedResponse {
    kind: 'input' | 'pick';
    value?: string;
}

interface MockWindow {
    showInformationMessage: (msg: string, ...items: string[]) => Promise<string | undefined>;
    showWarningMessage: (
        msg: string,
        optionsOrItem?: string | { modal?: boolean },
        ...items: string[]
    ) => Promise<string | undefined>;
    showErrorMessage: (msg: string, ...items: string[]) => Promise<string | undefined>;
    showInputBox: (options?: InputBoxOptions) => Promise<string | undefined>;
    showQuickPick: <T extends string>(items: T[], options?: QuickPickOptions) => Promise<T | undefined>;
    createTreeView: (id: string, options?: unknown) => {
        dispose: () => void;
        reveal: () => Promise<void>;
    };
    createWebviewPanel: (
        viewType: string,
        title: string,
        showOptions: unknown,
        options?: unknown
    ) => {
        webview: {
            html: string;
            onDidReceiveMessage: VsCodeEvent<unknown>;
            postMessage: (msg: unknown) => Promise<boolean>;
            asWebviewUri: (uri: unknown) => unknown;
        };
        onDidDispose: VsCodeEvent<void>;
        dispose: () => void;
        reveal: () => void;
    };
    withProgress: <T>(
        options: unknown,
        task: (progress: { report: (v: unknown) => void }) => Promise<T>
    ) => Promise<T>;
    __queue: QueuedResponse[];
    __reset: () => void;
}

export const window: MockWindow = {
    showInformationMessage: async (_msg, ..._items) => undefined,
    showWarningMessage: async (_msg, _optionsOrItem, ..._items) => undefined,
    showErrorMessage: async (_msg, ..._items) => undefined,
    showInputBox: async (_options) => undefined,
    showQuickPick: async (_items, _options) => undefined,
    createTreeView: () => ({ dispose: () => undefined, reveal: async () => undefined }),
    createWebviewPanel: () => ({
        webview: {
            html: '',
            onDidReceiveMessage: new EventEmitter<unknown>().event,
            postMessage: async () => true,
            asWebviewUri: (uri) => uri,
        },
        onDidDispose: new EventEmitter<void>().event,
        dispose: () => undefined,
        reveal: () => undefined,
    }),
    withProgress: async (_options, task) =>
        task({ report: () => undefined }),
    __queue: [],
    __reset: () => undefined,
};

const queueKey = '__queue';
window[queueKey] = [];

const defaultInputBox = window.showInputBox;
window.showInputBox = async (options) => {
    const q = window[queueKey];
    const head = q[0];
    if (head && head.kind === 'input') {
        q.shift();
        return head.value;
    }
    return defaultInputBox(options);
};

const defaultQuickPick = window.showQuickPick;
window.showQuickPick = async <T extends string>(items: T[], options?: QuickPickOptions) => {
    const q = window[queueKey];
    const head = q[0];
    if (head && head.kind === 'pick') {
        q.shift();
        return head.value as T | undefined;
    }
    return defaultQuickPick(items, options);
};

// ---------- authentication ----------

export interface AuthenticationSession {
    readonly id: string;
    readonly accessToken: string;
    readonly account: { id: string; label: string };
    readonly scopes: readonly string[];
}

let nextSession: AuthenticationSession | undefined;
let getSessionError: Error | undefined;
let getSessionCalls: {
    providerId: string;
    scopes: string[];
    options: { createIfNone: boolean };
}[] = [];

export const authentication = {
    getSession: async (
        providerId: string,
        scopes: string[],
        options: { createIfNone: boolean }
    ) => {
        getSessionCalls.push({ providerId, scopes, options });
        if (getSessionError) {
            const err = getSessionError;
            getSessionError = undefined;
            throw err;
        }
        return nextSession;
    },
    onDidChangeSessions: new EventEmitter<unknown>().event,
};

// ---------- workspace / Uri / Range / Position / Selection ----------

export const workspace = {
    getConfiguration: (_section?: string) => ({
        get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
        update: async (_key: string, _value: unknown) => undefined,
    }),
    onDidChangeConfiguration: new EventEmitter<unknown>().event,
};

export class Uri {
    scheme: string;
    authority: string;
    path: string;
    query: string;
    fragment: string;

    static parse(value: string): Uri {
        return new Uri(value);
    }

    static file(path: string): Uri {
        return new Uri(`file://${path}`);
    }

    constructor(value: string) {
        this.scheme = 'vscode-resource';
        this.authority = '';
        this.path = value;
        this.query = '';
        this.fragment = '';
    }

    toString(): string {
        return `${this.scheme}://${this.authority}${this.path}`;
    }

    with(_change: {
        scheme?: string;
        authority?: string;
        path?: string;
        query?: string;
        fragment?: string;
    }): Uri {
        return new Uri(this.path);
    }

    get fsPath(): string {
        return this.path;
    }
}

export interface Extension {
    readonly id: string;
}

export class Range {
    constructor(
        public readonly start: unknown,
        public readonly end: unknown
    ) {}
}

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Selection {
    constructor(public readonly anchor: Position, public readonly active: Position) {}
}

export class CancellationTokenSource {
    token = {
        isCancellationRequested: false,
        onCancellationRequested: new EventEmitter<void>().event,
    };
    cancel(): void {
        this.token.isCancellationRequested = true;
    }
    dispose(): void {}
}

// ---------- test helpers ----------

export const __test__ = {
    commandHandlers,
    executedCommands,

    reset() {
        commandHandlers.clear();
        executedCommands.length = 0;
        globalState.clear();
        subscriptions.length = 0;
        window[queueKey] = [];
    },

    resetAuth() {
        nextSession = undefined;
        getSessionError = undefined;
        getSessionCalls = [];
    },
    setNextSession(s: AuthenticationSession | undefined) {
        nextSession = s;
    },
    setNextSessionError(e: Error) {
        getSessionError = e;
    },
    getSessionCalls() {
        return getSessionCalls;
    },
};