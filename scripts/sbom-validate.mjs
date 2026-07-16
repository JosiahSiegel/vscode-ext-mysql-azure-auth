#!/usr/bin/env node
// scripts/sbom-validate.mjs
//
// Todo 13 — CycloneDX SBOM sanity check.
//
// Reads .omo/evidence/sbom.cdx.json (the artifact produced by
// scripts/sbom.mjs), confirms it is non-empty CycloneDX 1.5 JSON, and
// verifies the root-level metadata. This is a deterministic shape gate —
// it does not enforce license or vulnerability policy (those live in
// scripts/licenses.mjs and scripts/security-audit.mjs respectively).
//
// Exit codes:
//   0  SBOM present, parseable, CycloneDX-format, at least one component.
//   1  SBOM_NOT_READY with a structured code describing the failure:
//        MISSING_FILE     path is absent
//        NOT_JSON         bytes are not valid JSON
//        NOT_CYCLONEDX    no bomFormat === "CycloneDX" field
//        UNEXPECTED_SPEC  specVersion is not 1.5
//        NO_COMPONENTS    no components in the BOM
//        INCOMPLETE       one or more components are missing required fields

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const SBOM_PATH = resolve(ROOT, ".omo", "evidence", "sbom.cdx.json");

const fail = (code, message) => {
  console.error(`SBOM NOT READY: ${code}`);
  if (message) console.error(message);
  process.exit(1);
};

if (!existsSync(SBOM_PATH)) {
  fail("MISSING_FILE", SBOM_PATH);
}

const text = readFileSync(SBOM_PATH, "utf8");
if (text.length === 0) {
  fail("NOT_JSON", `${SBOM_PATH} is empty`);
}

let parsed;
try {
  parsed = JSON.parse(text);
} catch (err) {
  fail("NOT_JSON", err.message || String(err));
}

if (parsed.bomFormat !== "CycloneDX") {
  fail("NOT_CYCLONEDX", `bomFormat=${JSON.stringify(parsed.bomFormat)}`);
}

if (parsed.specVersion !== "1.5") {
  fail("UNEXPECTED_SPEC", `specVersion=${JSON.stringify(parsed.specVersion)}`);
}

const components = Array.isArray(parsed.components) ? parsed.components : [];
if (components.length === 0) {
  fail("NO_COMPONENTS", "components list is empty");
}

for (let i = 0; i < components.length; i += 1) {
  const c = components[i];
  if (typeof c !== "object" || c === null) {
    fail("INCOMPLETE", `component #${i} is not an object`);
  }
  if (typeof c.type !== "string" || c.type.length === 0) {
    fail("INCOMPLETE", `component #${i} missing type`);
  }
  if (typeof c.name !== "string" || c.name.length === 0) {
    fail("INCOMPLETE", `component #${i} missing name`);
  }
  if (typeof c["bom-ref"] !== "string" || c["bom-ref"].length === 0) {
    fail("INCOMPLETE", `component #${i} missing bom-ref`);
  }
  if (typeof c.version !== "string" || c.version.length === 0) {
    fail("INCOMPLETE", `component #${i} missing version`);
  }
}

console.log("SBOM READY");
