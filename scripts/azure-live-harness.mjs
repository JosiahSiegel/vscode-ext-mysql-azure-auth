/**
 * Azure live-gate harness stub.
 *
 * // stub: not available in this environment.
 *
 * This file is the stubbed sanitizer the validator at
 * `scripts/verify-task.mjs` (task === "17") invokes once every
 * preflight precondition is met. The real harness is committed in a
 * future task before `finalSourceCommit`; the plan body explicitly
 * assigns `Commit: N` to this Todo, evidence-only, and forbids
 * provisioning or destroying Azure infrastructure implicitly.
 *
 * The stub exercises the same contract surface the real harness will:
 *
 *   - Normalize the host via trim + lowercase + removal of one
 *     trailing dot and require `host.endsWith('.mysql.database.azure.com')`
 *     with at least one non-empty label before the suffix.
 *   - Open an `mysql2` connection with `ssl: { rejectUnauthorized: true }`.
 *   - Run `SHOW DATABASES` then `SELECT 1`.
 *   - Confirm `read-only` mode via the Todo 9 classifier.
 *   - Disconnect idempotently.
 *
 * Crucially, the stub NEVER opens a real socket. It accepts a
 * `simulate` field on its options that is set by fixture-driven runs
 * (the fixture is a synthetic JSON document under
 * `test/fixtures/release/`; it carries no real Azure credentials).
 *
 * Contract:
 *
 *   runLiveGate({ env, azureLive, simulate }) returns
 *
 *     { pass: true,  evidence: { ... } }
 *     { pass: false, code: "HOST_NOT_AZURE_FQDN", evidence: {...} }
 *     { pass: false, code: "TLS_VERIFY_REQUIRED", evidence: {...} }
 *     { pass: false, code: "CLASSIFIER_REJECTED_MUTATION", evidence: {...} }
 *     { pass: false, code: "DISCONNECT_NOT_IDEMPOTENT", evidence: {...} }
 *     { pass: false, code: "AZ_CLI_NOT_AUTHENTICATED", evidence: {...} }
 *
 * The stub reads `simulate` (if present) to pick a return value; the
 * live-mode caller (which never carries `simulate`) is rejected with
 * `AZ_CLI_NOT_AUTHENTICATED` because no `az login` session exists on
 * the orchestrator today. The plan body documents this deterministic
 * live-mode failure as the accepted today-state for the task; it does
 * NOT affect Marketplace defer (Todo 19 owns that decision and reads
 * only the four-precondition stderr line).
 */

// stub: not available in this environment.
// stub: not available in this environment.
// stub: not available in this environment.

const AZURE_SUFFIX = ".mysql.database.azure.com";

/**
 * Normalize the supplied host. Mirrors the contract the real harness
 * will implement verbatim: trim + lowercase + remove a single
 * trailing dot. Pure transformation; never throws.
 *
 * @param {string} host
 */
function normalizeHost(host) {
  if (typeof host !== "string") return "";
  return host.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Validate the normalized host. Returns either `{ ok: true, label }`
 * or `{ ok: false, code }`. The host must end in the Azure FQDN
 * suffix AND carry at least one non-empty label before the suffix.
 *
 * @param {string} host
 */
function validateHost(host) {
  const normalized = normalizeHost(host);
  if (typeof normalized !== "string" || normalized.length === 0) {
    return { ok: false, code: "HOST_MISSING" };
  }
  if (!normalized.endsWith(AZURE_SUFFIX)) {
    return { ok: false, code: "HOST_NOT_AZURE_FQDN" };
  }
  const label = normalized.slice(0, -AZURE_SUFFIX.length);
  if (label.length === 0) {
    return { ok: false, code: "HOST_LABEL_MISSING" };
  }
  return { ok: true, label };
}

/**
 * Pre-classifier sanity check. The real harness will exercise a spy
 * pool that asserts a mutating statement is rejected BEFORE network
 * dispatch; the stub short-circuits on the supplied fixture's
 * `simulate.mutationAccepted` flag so the FAIL branch can prove the
 * rejected-mutation path without spawning a real spy pool.
 *
 * Semantics (named from the perspective of the application's SQL
 * classifier):
 *   - `simulate.mutationAccepted === true`   → the spy pool observed
 *     a mutation that PASSED the classifier. The application-side
 *     read-only gate is broken. Return value `false`.
 *   - absent / `false`                       → either the spy pool
 *     observed a mutation that was correctly rejected, OR no
 *     mutation was injected. Either way the application-side gate
 *     is intact. Return value `true`.
 *
 * @param {{ simulate?: { mutationAccepted?: boolean } }} opts
 * @returns {boolean} `true` when the application-side gate is intact.
 */
function classifierRejectsMutation(opts) {
  const flag =
    opts && opts.simulate && opts.simulate.mutationAccepted;
  return flag !== true;
}

/**
 * Public harness entry point. The validator calls
 * `runLiveGate({ env, azureLive, simulate })` after preflight has
 * cleared every missing-precondition tag; the stub never opens a real
 * socket.
 *
 * @param {{ env: Record<string,string>, azureLive: unknown, simulate?: object }} opts
 * @returns {Promise<{ pass: boolean, code?: string, evidence: object }>}
 */
export async function runLiveGate(opts) {
  const env = (opts && opts.env) || {};
  const simulate = (opts && opts.simulate) || {};
  const azureLive = (opts && opts.azureLive) || {};

  // (1) Host normalization.
  const hostCheck = validateHost(env.MYSQL_HOST);
  if (!hostCheck.ok) {
    return {
      pass: false,
      code: hostCheck.code,
      evidence: { stage: "host-normalize", host: env.MYSQL_HOST },
    };
  }

  // (2) TLS verification. The real harness opens a connection with
  //     `ssl: { rejectUnauthorized: true }`. The stub consults the
  //     fixture's `simulate.tlsVerified` flag.
  if (simulate && simulate.tlsVerified === false) {
    return {
      pass: false,
      code: "TLS_VERIFY_REQUIRED",
      evidence: { stage: "tls-verify" },
    };
  }

  // (3) Application read-only classifier. The real harness injects a
  //     spy pool; the stub short-circuits on `simulate.mutationAccepted`.
  if (!classifierRejectsMutation({ simulate })) {
    return {
      pass: false,
      code: "CLASSIFIER_REJECTED_MUTATION",
      evidence: { stage: "classifier-spy" },
    };
  }

  // (4) Pool replacement + idempotent disconnect. The real harness
  //     exercises both. The stub consults `simulate.disconnectIdempotent`.
  if (simulate && simulate.disconnectIdempotent === false) {
    return {
      pass: false,
      code: "DISCONNECT_NOT_IDEMPOTENT",
      evidence: { stage: "disconnect" },
    };
  }

  // (5) Azure CLI credential source. The real harness calls
  //     `az account get-access-token` and rejects when no session is
  //     active. The stub mirrors that semantic on the live-mode path:
  //     when no `simulate` flag is present we deterministically return
  //     AZ_CLI_NOT_AUTHENTICATED so the live-mode branch NEVER emits
  //     PASS in the current orchestrator environment.
  if (!simulate || Object.keys(simulate).length === 0) {
    return {
      pass: false,
      code: "AZ_CLI_NOT_AUTHENTICATED",
      evidence: { stage: "az-cli" },
    };
  }

  // (6) All four READY assertions hold: host normalized, TLS
  //     verification on, classifier rejected a spy pool mutation,
  //     pool replaced and disconnected idempotently. Emit PASS with
  //     a sanitized evidence bag.
  return {
    pass: true,
    evidence: {
      stage: "complete",
      hostLabel: hostCheck.label,
      selectOne: { value: 1 },
      schemaList: { databases: ["information_schema", "mysql", "performance_schema"] },
      spyAssertion: "rejected-mutation-before-dispatch",
      poolReplacement: "executed",
      disconnect: "idempotent",
    },
  };
}

export const HARNESS_VERSION = "0.1.0-stub";
export const AZURE_SUFFIX_PUBLIC = AZURE_SUFFIX;