#!/usr/bin/env node
// scripts/sbom.mjs
//
// Todo 13 — CycloneDX SBOM generator for runtime + dev dependencies.
//
// Drives the lockfile-pinned @cyclonedx/cyclonedx-npm CLI by:
//   1. Reading node_modules/@cyclonedx/cyclonedx-npm/package.json to
//      verify the on-disk version equals the plan-body pin (4.0.3).
//      A version drift fails closed with SBOM NOT READY: VERSION_PIN.
//   2. Executing the bin script directly via the current Node.js process
//      so we never depend on PATH-resolved cmd.exe shims; the Node CLI
//      entry is `node_modules/@cyclonedx/cyclonedx-npm/bin/cyclonedx-npm-cli.js`.
//   3. Writing the JSON SBOM to .omo/evidence/sbom.cdx.json (created on
//      demand, idempotent across reruns).
//   4. Propagating the CLI exit code unchanged so npm scripts and the
//      .github/workflows/security.yml job can chain the failure.

import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
const REQUIRED_VERSION = "4.0.3";

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
});

if (typeof child.status === "number") {
  process.exitCode = child.status;
} else {
  process.exitCode = 1;
}
