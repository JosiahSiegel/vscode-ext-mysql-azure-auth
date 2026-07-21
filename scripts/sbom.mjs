#!/usr/bin/env node
// scripts/sbom.mjs
//
// Todo 13 — CycloneDX SBOM generator for runtime + dev dependencies.
//
// Drives the lockfile-pinned @cyclonedx/cyclonedx-npm CLI by:
//   1. Reading node_modules/@cyclonedx/cyclonedx-npm/package.json to
//      verify the on-disk version equals the plan-body pin (6.0.0).
//      A version drift fails closed with SBOM NOT READY: VERSION_PIN.
//   2. Resolving the npm CLI (npm-cli.js) on the system so that
//      cyclonedx 6.0.0's NpmRunner can invoke it via execFileSync.
//      cyclonedx 6.0.0 requires Node >= 20.18.0 and uses an explicit
//      npm_execpath hint rather than relying on PATH; we set
//      `npm_execpath` to the discovered npm-cli.js so the auto-detect
//      fallback never has to spawn `npm run` through cmd.exe.
//   3. Executing the bin script directly via the current Node.js process
//      so we never depend on PATH-resolved cmd.exe shims; the Node CLI
//      entry is `node_modules/@cyclonedx/cyclonedx-npm/bin/cyclonedx-npm-cli.js`.
//   4. Writing the JSON SBOM to .omo/evidence/sbom.cdx.json (created on
//      demand, idempotent across reruns).
//   5. Propagating the CLI exit code unchanged so npm scripts and the
//      .github/workflows/security.yml job can chain the failure.

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const EVIDENCE_DIR = resolve(ROOT, ".omo", "evidence");
const OUTPUT_PATH = resolve(EVIDENCE_DIR, "sbom.cdx.json");
const CLI_PATH = resolve(
  ROOT,
  "node_modules",
  "@cyclonedx",
  "cyclonedx-npm",
  "bin",
  "cyclonedx-npm-cli.js",
);
const REQUIRED_VERSION = "6.0.0";

if (!existsSync(CLI_PATH)) {
  console.error("SBOM NOT READY: CLI_MISSING");
  console.error("@cyclonedx/cyclonedx-npm CLI not found. Run `npm ci` first.");
  process.exit(1);
}

let resolvedVersion = null;
try {
  const pkgJson = JSON.parse(
    readFileSync(
      resolve(ROOT, "node_modules", "@cyclonedx", "cyclonedx-npm", "package.json"),
      "utf8",
    ),
  );
  resolvedVersion = pkgJson.version;
} catch { /* ignore */ }

if (resolvedVersion !== REQUIRED_VERSION) {
  console.error(`SBOM NOT READY: VERSION_PIN (resolved ${resolvedVersion || "unknown"}, required ${REQUIRED_VERSION})`);
  process.exit(1);
}

// Resolve the npm CLI script. cyclonedx 6.0.0 invokes npm via
// `execFileSync(node, ['--', npmJsPath, ...args])`; it requires the
// path to end in `npm-cli.js`. We probe the standard install locations
// in order: process.execPath's sibling bin/, then PATH via `where` /
// `which`. Setting npm_execpath in the child env prevents cyclonedx
// from spawning `npm run --silent npm_execpath` itself.
function resolveNpmCli() {
  const candidates = [];
  // npm is shipped as a Node module that lives next to (or near) the
  // Node binary. We probe the standard install locations in order:
  //   1. Sibling to node: <node-bin>/node_modules/npm/bin/npm-cli.js
  //      (nvm-style user installs.)
  //   2. Standard system install: <node-bin>/../lib/node_modules/npm/bin/npm-cli.js
  //      (official Node tarball, most distro packages, the OpenClaw
  //      sandbox.)
  //   3. One more level out: <node-bin>/../../lib/node_modules/npm/bin/npm-cli.js
  //      (some Linux distros nest deeper.)
  //   4. Repo-local npm via node_modules (in case of a future npm-shim
  //      install inside the project.)
  const execDir = dirname(process.execPath);
  candidates.push(join(execDir, "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(join(execDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(join(execDir, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  candidates.push(resolve(ROOT, "node_modules", "npm", "bin", "npm-cli.js"));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error("SBOM NOT READY: NPM_CLI_MISSING (could not locate npm-cli.js)");
}

let npmCliPath;
try {
  npmCliPath = resolveNpmCli();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

mkdirSync(EVIDENCE_DIR, { recursive: true });

const cliArgs = [
  CLI_PATH,
  "--output-format", "JSON",
  "--output-file", OUTPUT_PATH,
  "--spec-version", "1.5",
];

const child = spawnSync(process.execPath, cliArgs, {
  cwd: ROOT,
  stdio: "inherit",
  encoding: "utf8",
  env: {
    ...process.env,
    npm_execpath: npmCliPath,
  },
});

if (typeof child.status === "number") {
  process.exitCode = child.status;
} else {
  process.exitCode = 1;
}
