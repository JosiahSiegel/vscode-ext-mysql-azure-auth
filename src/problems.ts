/**
 * Extension error hierarchy.
 *
 * Domain code throws one of these instead of bare `Error`. The hierarchy
 * carries a machine-readable `code`, an optional underlying `cause`, a
 * `retryable` flag, and a sanitized `userMessage` safe for display.
 *
 * The webview and command surface catch these at the boundary and project
 * them to a user-visible notification; deeper code lets them propagate.
 *
 * Hierarchy:
 *
 *   ExtensionProblem (abstract)
 *   ├── AuthProblem
 *   ├── ConnectionProblem
 *   ├── QueryProblemError
 *   └── CancelledProblem
 */

export type ExtensionProblemCode =
    | 'AUTH_FAILED'
    | 'AUTH_CANCELLED'
    | 'CONNECTION_FAILED'
    | 'CONNECTION_LOST'
    | 'QUERY_FAILED'
    | 'QUERY_CANCELLED'
    | 'NOT_CONNECTED'
    | 'STORAGE_CORRUPT';

export abstract class ExtensionProblem extends Error {
    abstract readonly code: ExtensionProblemCode;
    abstract readonly retryable: boolean;
    override readonly cause?: unknown;

    protected constructor(message: string, cause?: unknown) {
        super(message);
        this.name = this.constructor.name;
        if (cause !== undefined) {
            this.cause = cause;
        }
    }

    /**
     * Sanitized user-visible message. Implementations should NEVER include
     * tokens, passwords, or server stack traces here. The `cause` field on the
     * error holds the raw information for logging.
     */
    abstract readonly userMessage: string;
}

export class AuthProblem extends ExtensionProblem {
    readonly code = 'AUTH_FAILED' as const;
    readonly retryable = true;

    constructor(message: string, public readonly userMessage: string, cause?: unknown) {
        super(message, cause);
    }
}

export class CancelledProblem extends ExtensionProblem {
    readonly code: ExtensionProblemCode = 'AUTH_CANCELLED';
    readonly retryable = false;

    constructor(message = 'Operation cancelled by user', public readonly userMessage = message) {
        super(message);
    }
}

export class ConnectionProblem extends ExtensionProblem {
    readonly code = 'CONNECTION_FAILED' as const;
    readonly retryable = true;

    constructor(message: string, public readonly userMessage: string, cause?: unknown) {
        super(message, cause);
    }
}

export class QueryProblemError extends ExtensionProblem {
    readonly code = 'QUERY_FAILED' as const;
    readonly retryable = false;

    constructor(
        message: string,
        public readonly userMessage: string,
        cause?: unknown,
        public readonly serverCode?: string
    ) {
        super(message, cause);
    }
}

/**
 * Convenience predicate: was this thrown from the extension's own domain
 * code (vs. an unrelated library error)?
 */
export function isExtensionProblem(err: unknown): err is ExtensionProblem {
    return err instanceof ExtensionProblem;
}