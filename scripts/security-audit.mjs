#!/usr/bin/env node
// scripts/security-audit.mjs
//
// Todo 13 — runtime npm audit gate.
//
// Invokes the exact command the plan body documents:
//   npm audit --omit=dev --audit-level=high
//
// Rationale:
//   * `--omit=dev` keeps dev-only advisories out of the production-blocking
//     gate. Dev-only advisory handling is documented in the policy but does
//     not block release readiness on its own.
//   * `--audit-level=high` blocks on high AND critical runtime advisories.
//     Low / moderate runtime advisories are not blocking here; they flow
//     through the per-id exception matching performed by the Todo 13
//     validator.
//   * The exit code mirrors what `npm audit` returns so the same exit code
//     propagates to the validator and the upstream `npm run security:audit`
//     wrapper. Non-zero means "production-blocking runtime finding present".
//
// The script is single-purpose: it MUST be safe to run in CI on every push
// and pull_request. Failures bubble up via `process.exitCode` so callers can
// chain it from npm scripts and CI shells without translation.
//
// Implementation note: on Windows the `npm` binary is the `npm.cmd` shim;
// child_process.spawnSync cannot run a `.cmd` script without shell:true and
// would ENOENT otherwise. We enable shell:true only on Windows.

import { spawnSync } from "node:child_process";

const NPM_AUDIT_ARGS = ["audit", "--omit=dev", "--audit-level=high"];

const child = spawnSync("npm", NPM_AUDIT_ARGS, {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32",
  encoding: "utf8",
});

if (typeof child.status === "number") {
  process.exitCode = child.status;
} else {
  // npm could not be spawned (for example missing binary). Treat as fail.
  process.exitCode = 1;
}
