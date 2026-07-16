#!/usr/bin/env node
// scripts/licenses.mjs
//
// Todo 13 — runtime license policy gate.
//
// Pipeline:
//   1. Verify the lockfile-pinned license-checker-rseidelsohn 4.4.2 binary
//      is on disk; emit LICENSE NOT READY: CLI_MISSING otherwise.
//   2. Generate a JSON license inventory at .omo/evidence/licenses.json
//      using the lockfile-pinned CLI (production-only).
//   3. Apply the policy:
//        Allow: MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD,
//               BlueOak-1.0.0, CC0-1.0
//        Deny (always): GPL*, AGPL*, SSPL*, BSL*, proprietary, unknown,
//                       missing, "SEE LICENSE IN".
//        Anything else: must match exactly one tuple
//          (packageName, packageVersion, normalized SPDX expression)
//        from .github/security-exceptions.json (advisories[] is
//        irrelevant here; we look at licenses[] only).
//   4. Fail closed with one of:
//        LICENSE NOT READY: CLI_MISSING
//        LICENSE NOT READY: VERSION_PIN     pinned CLI not in node_modules
//        LICENSE NOT READY: INVENTORY_EMPTY license-checker wrote nothing
//        LICENSE NOT READY: INVALID_SPDX    parser failure on the inventory
//        LICENSE NOT READY: LICENSE_BLOCKED runtime dep license is denied
//        LICENSE NOT READY: UNAPPROVED_DEP  dep's SPDX does not match an
//                                            exception entry
//
// Driver fixtures (test/fixtures/release/security-*.json) bypass the
// inventory read and pass synthetic data into validateLicenseEntries() so
// the validator can prove each code path without ever running
// license-checker.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeSpdx, spdxEquals } from "./licenses-spdx.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const EVIDENCE_DIR = resolve(ROOT, ".omo", "evidence");
const LICENSES_PATH = resolve(EVIDENCE_DIR, "licenses.json");
const EXCEPTIONS_PATH = resolve(ROOT, ".github", "security-exceptions.json");
const CLI_PATH = resolve(
  ROOT,
  "node_modules",
  "license-checker-rseidelsohn",
  "bin",
  "license-checker-rseidelsohn.js",
);
const PINNED_CLI_VERSION = "4.4.2";

const ALLOW = new Set([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "BlueOak-1.0.0",
  "CC0-1.0",
]);

const DEFAULT_DENY_PREFIXES = [
  "GPL-",
  "GPL ",
  "AGPL-",
  "AGPL ",
  "SSPL-",
  "SSPL ",
  "BSL-",
  "BUSL-",
];

function splitNameAndVersion(key) {
  if (typeof key !== "string") return null;
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function normalizeRawLicense(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .trim()
    .replace(/^\(|\)$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function classifyLicense(rawLicense, parsedExpression) {
  if (!rawLicense || rawLicense.length === 0) {
    return { ok: false, code: "MISSING" };
  }
  if (/SEE LICENSE IN/.test(rawLicense)) {
    return { ok: false, code: "SEE LICENSE IN" };
  }
  // Proprietary / unknown markers from license-checker.
  if (/^(unknown|UNLICENSED|UNLICENCED|proprietary)$/i.test(rawLicense)) {
    return { ok: false, code: rawLicense };
  }
  // Always-denied family prefixes.
  for (const prefix of DEFAULT_DENY_PREFIXES) {
    if (rawLicense.startsWith(prefix)) {
      return { ok: false, code: rawLicense };
    }
  }
  return { ok: true, parsed: parsedExpression ?? rawLicense };
}

function loadExceptions() {
  if (!existsSync(EXCEPTIONS_PATH)) {
    return { advisories: [], licenses: [] };
  }
  try {
    const body = JSON.parse(readFileSync(EXCEPTIONS_PATH, "utf8"));
    return {
      advisories: Array.isArray(body.advisories) ? body.advisories : [],
      licenses: Array.isArray(body.licenses) ? body.licenses : [],
    };
  } catch {
    return { advisories: [], licenses: [] };
  }
}

function matchException(entry, exceptionList) {
  for (const candidate of exceptionList) {
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.packageName !== entry.name) continue;
    if (candidate.packageVersion !== entry.version) continue;
    const expr = candidate.spdxExpression;
    if (typeof expr !== "string") continue;
    if (spdxEquals(expr, entry.normalized)) return true;
  }
  return false;
}

/**
 * Validate a synthetic array of {name, version, licenses} entries. Used by
 * the Todo 13 fixture-driven validator.
 *
 * @param {Array<{name: string, version: string, licenses: string}>} entries
 * @returns {{ ok: boolean, code?: string, offenders?: Array }}
 */
export function validateLicenseEntries(entries) {
  const exceptions = loadExceptions();
  const offenders = [];
  for (const entry of entries) {
    const raw = normalizeRawLicense(entry.licenses);
    let parsed = "";
    let classification = null;
    if (raw.length === 0) {
      classification = { ok: false, code: "MISSING" };
    } else if (/SEE LICENSE IN/.test(raw)) {
      classification = { ok: false, code: "SEE LICENSE IN" };
    } else if (/^(unknown|UNLICENSED|UNLICENCED|proprietary)$/i.test(raw)) {
      classification = { ok: false, code: raw };
    } else if (DEFAULT_DENY_PREFIXES.some((p) => raw.startsWith(p))) {
      classification = { ok: false, code: raw };
    } else if (ALLOW.has(raw)) {
      classification = { ok: true, parsed: raw };
    } else {
      // Compound SPDX expression that is not on the allowlist and not in
      // the deny-by-prefix list. Parse it before applying exceptions so
      // syntactically invalid expressions fail closed.
      try {
        parsed = normalizeSpdx(raw);
        classification = { ok: true, parsed };
      } catch (err) {
        return { ok: false, code: `INVALID SPDX: ${raw}` };
      }
    }
    if (!classification.ok) {
      offenders.push({ name: entry.name, version: entry.version, code: classification.code });
      continue;
    }
    // Allowlist bypass is automatic; off-allowlist entries need a matching
    // exception tuple. The single-id allowlist entries short-circuit this.
    if (ALLOW.has(raw)) continue;
    const normalized = classification.parsed;
    const matched = matchException(
      { name: entry.name, version: entry.version, normalized },
      exceptions.licenses,
    );
    if (!matched) {
      offenders.push({ name: entry.name, version: entry.version, code: "UNAPPROVED" });
    }
  }
  if (offenders.length > 0) {
    return { ok: false, code: "LICENSE_BLOCKED", offenders };
  }
  return { ok: true };
}

function main() {
  if (!existsSync(CLI_PATH)) {
    console.error("LICENSE NOT READY: CLI_MISSING");
    process.exit(1);
  }
  // Verify pinned version on disk.
  try {
    const pkg = JSON.parse(
      readFileSync(
        resolve(ROOT, "node_modules", "license-checker-rseidelsohn", "package.json"),
        "utf8",
      ),
    );
    if (pkg.version !== PINNED_CLI_VERSION) {
      console.error(
        `LICENSE NOT READY: VERSION_PIN (resolved ${pkg.version}, required ${PINNED_CLI_VERSION})`,
      );
      process.exit(1);
    }
  } catch {
    console.error("LICENSE NOT READY: VERSION_PIN");
    process.exit(1);
  }

  mkdirSync(EVIDENCE_DIR, { recursive: true });

  const cliArgs = [
    CLI_PATH,
    "--production",
    "--json",
    "--out", LICENSES_PATH,
  ];
  const child = spawnSync(process.execPath, cliArgs, {
    cwd: ROOT,
    stdio: "inherit",
    encoding: "utf8",
  });
  if (typeof child.status !== "number" || child.status !== 0) {
    console.error("LICENSE NOT READY: CLI_RUN_FAILED");
    process.exit(1);
  }
  if (!existsSync(LICENSES_PATH)) {
    console.error("LICENSE NOT READY: INVENTORY_EMPTY");
    process.exit(1);
  }

  let inventory;
  try {
    inventory = JSON.parse(readFileSync(LICENSES_PATH, "utf8"));
  } catch (err) {
    console.error(`LICENSE NOT READY: INVENTORY_PARSE: ${err.message || err}`);
    process.exit(1);
  }
  const entries = [];
  for (const [key, value] of Object.entries(inventory)) {
    const split = splitNameAndVersion(key);
    if (!split) continue;
    const licenses = value && typeof value.licenses === "string" ? value.licenses : "";
    entries.push({ name: split.name, version: split.version, licenses });
  }
  if (entries.length === 0) {
    console.error("LICENSE NOT READY: INVENTORY_EMPTY");
    process.exit(1);
  }

  const result = validateLicenseEntries(entries);
  if (!result.ok) {
    console.error(`LICENSE NOT READY: ${result.code}`);
    if (result.offenders) {
      for (const offender of result.offenders) {
        console.error(`${offender.name}@${offender.version} -> ${offender.code}`);
      }
    }
    process.exit(1);
  }

  console.log("LICENSE READY");
  // Persist the off-allowlist (but approved) entries alongside the raw
  // inventory so reviewers can see what was allowed through exception.
  try {
    writeFileSync(
      resolve(EVIDENCE_DIR, "licenses.normalized.json"),
      JSON.stringify(
        entries.map((e) => ({
          name: e.name,
          version: e.version,
          raw: e.licenses,
        })),
        null,
        2,
      ),
      "utf8",
    );
  } catch { /* evidence write failure is advisory */ }
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main();
}
