/**
 * Adapter that projects the canonical `QueryOutcome` (discriminated union)
 * back to the legacy `QueryResult` shape consumed by the webview and the
 * existing test contract.
 *
 * New code should consume `QueryOutcome` directly; this module is the
 * boundary that keeps the wire format unchanged.
 */

export {
    toLegacyQueryResult,
    type QueryOutcome,
    type QuerySuccess,
    type StatementOutput,
    type QueryProblem,
    type DbRow,
} from '../domain';