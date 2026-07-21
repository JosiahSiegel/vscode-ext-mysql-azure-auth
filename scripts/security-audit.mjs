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
// would ENOENT otherwise. We invoke the npm Node CLI script directly via
// the current Node.js process and set `npm_execpath` so npm's internal
// dispatch works; this is independent of cmd.exe PATHEXT inheritance.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");

function resolveNpmCli() {
  // npm is shipped as a Node module that lives next to (or near) the
  // Node binary. The two "standard" install locations are:
  //   1. Sibling to node:  <node-bin>/../lib/node_modules/npm/bin/npm-cli.js
  //      (used by the official Node tarball install on Linux/macOS, and
  //      by most distro packages that put node in /usr/bin and npm's
  //      module in /usr/lib.)
  //   2. Adjacent to node: <node-bin>/node_modules/npm/bin/npm-cli.js
  //      (used by some minimal installs, e.g. nvm-style user installs.)
  //   3. The project-local copy (transitively installed as a devDep in
  //      many projects; checked last because it is the most likely to
  //      be missing in CI containers that ran `npm ci --omit=dev`.)
  const execDir = dirname(process.execPath);
  const candidates = [
    join(execDir, "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(execDir, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(ROOT, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const npmCliPath = resolveNpmCli();
if (!npmCliPath) {
  console.error("SECURITY AUDIT NOT READY: NPM_CLI_MISSING");
  process.exit(1);
}

const NPM_AUDIT_ARGS = ["audit", "--omit=dev", "--audit-level=high"];

const child = spawnSync(process.execPath, ["--", npmCliPath, ...NPM_AUDIT_ARGS], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: false,
  windowsHide: true,
  encoding: "utf8",
  env: {
    ...process.env,
    npm_execpath: npmCliPath,
  },
});

if (typeof child.status === "number") {
  process.exitCode = child.status;
} else {
  // npm could not be spawned (for example missing binary). Treat as fail.
  process.exitCode = 1;
}
