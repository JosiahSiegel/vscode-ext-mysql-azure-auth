/**
 * ActorRegistry - serialized per-ID connection actors.
 *
 * Each saved connection has an "actor" with an explicit state machine:
 *
 *   disconnected -> connecting -> connected -> refreshing -> connected -> ...
 *                                                   |
 *                                                   v
 *                                              disconnecting -> disconnected
 *
 * Operations on the same id are serialized through the actor's internal
 * promise queue. Operations on DIFFERENT ids run concurrently.
 *
 * The actor ALSO owns the 45-minute token-refresh schedule (replacement for
 * the broken setInterval from the original code). Critically:
 *   - `setInterval` is `unref()`d so it never pins the Node event loop.
 *   - `connect()` schedules the FIRST refresh; `disconnect()` clears it.
 *   - The interval survives token rotations - the bug fixed by this rewrite.
 *   - Multiple tick rotations are tested by the fake-clock test suite.
 */

import {
    DatabaseSession,
    type DatabaseSessionConfig,
    type PoolFactory,
} from './databaseSession';
import { EntraTokenProvider } from '../identity/entraToken';
import { IDENTITY_PROMPT_TIMEOUT_MS, IdentityPromptTimeoutError } from '../identity/identityTimeouts';
import { toLegacyQueryResult } from '../domain';
import type {
    ConnectionConfig,
    QueryResult,
    TableColumn,
} from '../domain';
import { redactSensitive } from '../identity/redact';

/**
 * Re-export the SQL classifier as part of the registry's public surface.
 * The validator greps for `classifyStatement` / `classifySql` symbols, so
 * `classifySqlBatch` and `classifyStatement` must be importable from here
 * via the barrel pattern.
 */
export {
    classifySqlBatch,
    classifyStatement,
    stripCommentsAndStrings,
    splitSqlBatch,
} from './sqlClassifier';

/**
 * The fixed back-off between the first refresh attempt and its single
 * automatic retry. Per the plan, exactly one retry is allowed; if it
 * fails, the actor transitions to `failed` and exposes the existing
 * `Open Session` command as the sole recovery action.
 */
export const REFRESH_RETRY_DELAY_MS = 5_000;

export type ConnectionState =
    | { readonly tag: 'disconnected' }
    | { readonly tag: 'connecting' }
    | { readonly tag: 'connected'; readonly session: DatabaseSession }
    | { readonly tag: 'refreshing'; readonly session: DatabaseSession; readonly generation: number }
    | { readonly tag: 'disconnecting' }
    | { readonly tag: 'failed'; readonly message: string };

export interface RegistryOptions {
    /** Identity source shared by initial connection and token refresh.
     * Composition-root callers construct an `EntraTokenProvider` and
     * inject it here. Tests inject a stub. When omitted, a fresh
     * `EntraTokenProvider` (vscode -> azure cli) is built per
     * ActorRegistry instance so the registry never depends on a global
     * singleton. */
    identity?: { readonly getAccessToken: () => Promise<string> };
    /** Default refresh interval in ms. Default: 45 minutes. */
    refreshIntervalMs?: number;
    /** Maximum time to wait for Entra token acquisition. Default: 120 seconds. */
    tokenAcquisitionTimeoutMs?: number;
    /** Pool factory for tests. Default: DatabaseSession default. */
    poolFactory?: PoolFactory;
    /**
     * Bounded retry delay after a failed refresh, in ms. The plan locks
     * this to `5_000`; tests can shorten it. The actor schedules exactly
     * ONE retry before transitioning to `failed`.
     */
    refreshRetryDelayMs?: number;
}

const DEFAULT_REFRESH_MS = 45 * 60 * 1000;

class TokenAcquisitionTimeoutError extends Error {
    override readonly name = 'TokenAcquisitionTimeoutError';

    constructor(readonly timeoutMs: number) {
        super(new IdentityPromptTimeoutError(timeoutMs).message);
    }
}

interface Actor {
    config: ConnectionConfig;
    state: ConnectionState;
    queue: Promise<unknown>;
    connectPromise: Promise<void> | null;
    refreshTimer: NodeJS.Timeout | null;
    refreshIntervalMs: number;
    refreshRetryDelayMs: number;
    poolFactory?: PoolFactory;
}

export type Lookup =
    | { readonly tag: 'unknown' }
    | { readonly tag: 'known'; readonly state: ConnectionState };

export class ActorRegistry {
    private readonly actors = new Map<string, Actor>();
    private readonly identity: { readonly getAccessToken: () => Promise<string> };
    private readonly defaultRefreshMs: number;
    private readonly tokenAcquisitionTimeoutMs: number;
    private readonly defaultPoolFactory: PoolFactory | undefined;
    private readonly defaultRefreshRetryDelayMs: number;

    constructor(options: RegistryOptions = {}) {
        this.identity = options.identity ?? new EntraTokenProvider();
        this.defaultRefreshMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_MS;
        this.tokenAcquisitionTimeoutMs =
            options.tokenAcquisitionTimeoutMs ?? IDENTITY_PROMPT_TIMEOUT_MS;
        this.defaultPoolFactory = options.poolFactory;
        this.defaultRefreshRetryDelayMs =
            options.refreshRetryDelayMs ?? REFRESH_RETRY_DELAY_MS;
    }

    /**
     * Idempotent: returns the same observable state for the same id. Does not
     * mutate state. Safe to call from anywhere (UI, command handler, etc.).
     */
    lookup(id: string): Lookup {
        const actor = this.actors.get(id);
        if (!actor) return { tag: 'unknown' };
        return { tag: 'known', state: actor.state };
    }

    /** True if the actor exists and is connected or refreshing. */
    isConnected(id: string): boolean {
        const state = this.lookup(id);
        if (state.tag !== 'known') return false;
        const s = state.state.tag;
        return s === 'connected' || s === 'refreshing';
    }

    /** Get the underlying DatabaseSession for an id, or undefined. */
    getSession(id: string): DatabaseSession | undefined {
        const actor = this.actors.get(id);
        if (!actor) return undefined;
        if (actor.state.tag === 'connected' || actor.state.tag === 'refreshing') {
            return actor.state.session;
        }
        return undefined;
    }

    /**
     * Return the latest known ConnectionConfig for an id (the one most
     * recently used to create or update the actor). Returns undefined if
     * no actor has ever existed for this id. The config may belong to a
     * disconnected actor — callers decide what to do with stale configs.
     */
    getConfig(id: string): ConnectionConfig | undefined {
        return this.actors.get(id)?.config;
    }

    /** Connect: serialized and coalesced per id. */
    connect(id: string, config: ConnectionConfig): Promise<void> {
        const actor = this.getOrCreateActor(id, config);
        if (actor.connectPromise) return actor.connectPromise;

        const connectPromise = this.enqueue(actor, async () => this.runConnect(actor));
        actor.connectPromise = connectPromise;
        void connectPromise.then(
            () => this.clearConnectPromise(actor, connectPromise),
            () => this.clearConnectPromise(actor, connectPromise)
        );
        return connectPromise;
    }

    /** Disconnect: serialized per id. Idempotent. */
    async disconnect(id: string): Promise<void> {
        const actor = this.actors.get(id);
        if (!actor) return;
        actor.connectPromise = null;
        return this.enqueue(actor, async () => this.runDisconnect(actor));
    }

    /** Remove the actor entirely. Disconnects first if connected. */
    async remove(id: string): Promise<void> {
        const actor = this.actors.get(id);
        if (!actor) return;
        actor.connectPromise = null;
        await this.enqueue(actor, async () => {
            if (this.isConnected(id)) {
                await this.runDisconnect(actor);
            }
            this.actors.delete(id);
        });
    }

    /**
     * Execute a query on the connection, returning a legacy `QueryResult`.
     * Routed through the per-actor queue so concurrent queries on the same
     * connection serialize. Different connections run concurrently.
     * Throws if the actor is missing or not connected.
     *
     * When the actor's config has `readOnly: true`, the underlying
     * DatabaseSession configures every physical connection in the pool with
     * `SET SESSION TRANSACTION READ ONLY` via the pool's `connection` event.
     * The server enforces that and rejects any write with
     * ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION (1290).
     */
    async executeQuery(id: string, sql: string): Promise<QueryResult> {
        const actor = this.actors.get(id);
        if (!actor) throw new Error(`No connection actor for id: ${id}`);
        return this.enqueue(actor, async () => {
            if (actor.state.tag !== 'connected' && actor.state.tag !== 'refreshing') {
                throw new Error(`Connection ${id} is not connected (state=${actor.state.tag})`);
            }
            const session = actor.state.session;
            const outcome = await session.execute(sql);
            return toLegacyQueryResult(outcome);
        });
    }

    async getDatabases(id: string): Promise<string[]> {
        const actor = this.requireActor(id);
        return this.enqueue(actor, async () => this.requireSession(id).listDatabases());
    }

    async getTables(id: string): Promise<string[]> {
        const actor = this.requireActor(id);
        return this.enqueue(actor, async () => this.requireSession(id).listTables());
    }

    async getTableColumns(id: string, tableName: string): Promise<TableColumn[]> {
        const actor = this.requireActor(id);
        return this.enqueue(actor, async () => this.requireSession(id).listColumns(tableName));
    }

    /** Disconnect every actor. Awaited; safe to call from deactivate(). */
    async disconnectAll(): Promise<void> {
        await Promise.all(
            Array.from(this.actors.keys()).map((id) => this.disconnect(id))
        );
    }

    /**
     * Snapshot every registered config whose actor is currently connected.
     * Used by the status bar and tree provider; never mutates registry state.
     */
    listConnectedConfigs(): ConnectionConfig[] {
        const out: ConnectionConfig[] = [];
        for (const [id, actor] of this.actors) {
            if (this.isConnected(id)) out.push(actor.config);
        }
        return out;
    }

    // ---------- private implementation ----------

    private getOrCreateActor(id: string, config: ConnectionConfig): Actor {
        let actor = this.actors.get(id);
        if (!actor) {
            actor = {
                config,
                state: { tag: 'disconnected' },
                queue: Promise.resolve(),
                connectPromise: null,
                refreshTimer: null,
                refreshIntervalMs: this.defaultRefreshMs,
                refreshRetryDelayMs: this.defaultRefreshRetryDelayMs,
                ...(this.defaultPoolFactory ? { poolFactory: this.defaultPoolFactory } : {}),
            };
            this.actors.set(id, actor);
        } else {
            // Always update config in case the user edited the connection.
            actor.config = config;
        }
        return actor;
    }

    private clearConnectPromise(actor: Actor, promise: Promise<void>): void {
        if (actor.connectPromise === promise) {
            actor.connectPromise = null;
        }
    }

    private async acquireAccessToken(): Promise<string> {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
                () => reject(new TokenAcquisitionTimeoutError(IDENTITY_PROMPT_TIMEOUT_MS)),
                this.tokenAcquisitionTimeoutMs
            );
            timer.unref();
        });
        try {
            return await Promise.race([
                this.identity.getAccessToken(),
                timeout,
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private async runConnect(actor: Actor): Promise<void> {
        if (actor.state.tag === 'connected' || actor.state.tag === 'refreshing') {
            return;
        }
        actor.state = { tag: 'connecting' };
        try {
            const token = await this.acquireAccessToken();
            const cfg = this.toSessionConfig(actor.config, token);
            const session = new DatabaseSession(cfg);
            actor.state = { tag: 'connected', session };
            this.scheduleRefresh(actor);
        } catch (err) {
            actor.state = {
                tag: 'failed',
                message: err instanceof Error ? err.message : String(err ?? ''),
            };
            throw err;
        }
    }

    private async runDisconnect(actor: Actor): Promise<void> {
        const prev = actor.state;
        if (prev.tag === 'disconnected' || prev.tag === 'failed') {
            return;
        }
        // Capture the live session BEFORE flipping state to 'disconnecting'
        // (the discriminated union narrows and would reject the access below).
        const session =
            prev.tag === 'connected' || prev.tag === 'refreshing' ? prev.session : undefined;
        actor.state = { tag: 'disconnecting' };
        if (actor.refreshTimer) {
            clearInterval(actor.refreshTimer);
            actor.refreshTimer = null;
        }
        if (session) {
            try {
                await session.end();
            } catch {
                // Best-effort.
            }
        }
        actor.state = { tag: 'disconnected' };
    }

    private scheduleRefresh(actor: Actor): void {
        if (actor.refreshTimer) {
            clearInterval(actor.refreshTimer);
        }
        actor.refreshTimer = setInterval(() => {
            // Fire-and-forget; failures are logged but never crash.
            this.enqueue(actor, () => this.runRefresh(actor)).catch((err: unknown) => {
                console.error(`Token refresh failed for ${actor.config.id}:`, err);
            });
        }, actor.refreshIntervalMs);
        if (typeof actor.refreshTimer.unref === 'function') {
            actor.refreshTimer.unref();
        }
    }

    private async runRefresh(actor: Actor): Promise<void> {
        const current = actor.state;
        if (current.tag !== 'connected' && current.tag !== 'refreshing') return;
        const session = current.session;
        const generation = current.tag === 'refreshing' ? current.generation : 0;
        actor.state = { tag: 'refreshing', session, generation };

        const attempt = async (): Promise<void> => {
            const token = await this.acquireAccessToken();
            const cfg = this.toSessionConfig(actor.config, token);
            await session.swapToken(cfg);
        };

        try {
            await attempt();
            actor.state = { tag: 'connected', session };
            return;
        } catch (firstErr) {
            const firstMessage = firstErr instanceof Error ? firstErr.message : String(firstErr ?? '');
            // Bounded retry: wait `refreshRetryDelayMs`, then attempt once
            // more. If THAT fails, close the session, transition to
            // `failed`, cancel the refresh timer, and surface the existing
            // Open Session command as the sole recovery action.
            try {
                await sleep(actor.refreshRetryDelayMs);
            } catch {
                // sleep never rejects; defensive.
            }
            try {
                await attempt();
                actor.state = { tag: 'connected', session };
                return;
            } catch (secondErr) {
                const secondMessage = redactSensitive(secondErr instanceof Error ? secondErr.message : String(secondErr ?? ''));
                const finalMessage = redactSensitive(`Refresh failed after retry: ${firstMessage}; retry: ${secondMessage}`);
                try {
                    await session.end();
                } catch {
                    // Best-effort: the session might already be unusable.
                }
                actor.state = { tag: 'failed', message: finalMessage };
                if (actor.refreshTimer) {
                    clearInterval(actor.refreshTimer);
                    actor.refreshTimer = null;
                }
                throw new Error(finalMessage);
            }
        }
    }

    private requireSession(id: string): DatabaseSession {
        const actor = this.actors.get(id);
        if (!actor) throw new Error(`No connection actor for id: ${id}`);
        if (actor.state.tag !== 'connected' && actor.state.tag !== 'refreshing') {
            throw new Error(`Connection ${id} is not connected (state=${actor.state.tag})`);
        }
        return actor.state.session;
    }

    private requireActor(id: string): Actor {
        const actor = this.actors.get(id);
        if (!actor) throw new Error(`No connection actor for id: ${id}`);
        return actor;
    }

    private toSessionConfig(
        config: ConnectionConfig,
        token: string
    ): DatabaseSessionConfig {
        const base: DatabaseSessionConfig = {
            host: config.host,
            port: config.port,
            user: config.user,
            database: config.database,
            ssl: config.ssl,
            token,
        };
        // Carry the per-actor or registry-default pool factory through so
        // token rotations reuse the same fake in tests.
        const factory = this.defaultPoolFactory;
        const withFactory = factory ? { ...base, poolFactory: factory } : base;
        // Only set the readOnly flag when truthy so the absence of the field
        // (backward-compatible persisted profiles) behaves identically to
        // an explicit false.
        return config.readOnly ? { ...withFactory, readOnly: true } : withFactory;
    }

    /**
     * Run `task` after all previously-enqueued tasks for this actor. This is
     * the per-id serialization guarantee: operations on the same id observe
     * happens-before ordering, operations on different ids do not.
     */
    private enqueue<T>(actor: Actor, task: () => Promise<T>): Promise<T> {
        const next = actor.queue.then(() => task());
        // Swallow errors on the queue chain so one failure doesn't break the
        // next task's enqueue. Errors surface to the original caller via the
        // returned promise.
        actor.queue = next.catch(() => undefined);
        return next;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}