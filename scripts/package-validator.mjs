#!/usr/bin/env node
/**
 * Package preflight validator (sandbox-only).
 *
 * The validator exercises the Todo 14 package-allowlist/denylist rules against
 * a *synthetic* ZIP-like archive constructed in memory from a fixture-driven
 * file table. It does NOT install or read a real VS Code VSIX. The intent is
 * to prove the allow/deny logic before the real `vsce package` runs in
 * Todo 15's dual-worktree procedure.
 *
 * The archive bytes are deterministic: we use `zlib.deflateRawSync` with no
 * timestamps, no dictionary, and no randomness. Re-running the validator
 * against the same fixture yields byte-identical output. The validator
 * additionally records a "rerun hash" by compressing a second time and
 * asserting the SHA-256 of the byte sequence is stable.
 *
 * Forbidden substrings (denylist):
 *   - ".log"           (release-time log files; .vscodeignore covers these too)
 *   - ".map"           (source maps; should never ship)
 *   - ".vsix"          (nested VSIX archives are always wrong)
 *   - ".playwright-mcp/" (browser artifact directory)
 *
 * Required canonical entry (allowlist anchor):
 *   - At least one entry name must equal "extension/package.json" so the
 *     fixture describes a real extension-shaped package. The validator also
 *     accepts the alias "package.json" so a minimal fixture remains
 *     representative.
 *
 * Returns one of:
 *   { ok: true }                              archive is clean and valid
 *   { ok: false, code: "FIXTURE_INVALID" }    fixture shape is broken
 *   { ok: false, code: "ARCHIVE_CONTAMINATED" } a denylist substring matched
 *   { ok: false, code: "MISSING_CANONICAL_ENTRY" } no canonical entry present
 *   { ok: false, code: "ARCHIVE_NON_DETERMINISTIC" } rerun bytes differ
 *   { ok: false, code: "ARCHIVE_INVALID" }     zlib produced non-finite bytes
 *
 * CLI usage:
 *   node scripts/package-validator.mjs <fixture.json>
 *   stdout: "PACKAGE_VALIDATOR: READY" | "PACKAGE_VALIDATOR: <CODE>"
 *   exit  : 0 on READY, 1 on every other code
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const FORBIDDEN_SUBSTRINGS = [".log", ".map", ".vsix", ".playwright-mcp/"];
const CANONICAL_ENTRY_PRIMARY = "extension/package.json";
const CANONICAL_ENTRY_ALIAS = "package.json";

/**
 * Build a deterministic in-memory "ZIP-like" byte sequence from a file table.
 * The bytes are NOT a real ZIP (no central directory, no file headers); they
 * are a fixed-layout concatenation of:
 *   1. A 4-byte little-endian magic tag `PK14`
 *   2. For each entry (lexicographic order):
 *      - 2-byte BE entry name length
 *      - UTF-8 entry name bytes
 *      - 4-byte BE deflateRaw-compressed payload length
 *      - compressed payload bytes
 *   3. A 4-byte BE terminator `0x00 0x00 0x00 0x00`
 *
 * Layout is deterministic (lexicographic entry order, no timestamps, no
 * randomness) and the SHA-256 of the resulting bytes must be stable across
 * reruns of the same input.
 *
 * @param {Array<{name: string, content: string}>} entries
 * @returns {Buffer}
 */
export function buildSyntheticArchive(entries) {
  if (!Array.isArray(entries)) {
    throw new Error("FIXTURE_INVALID: entries must be an array");
  }
  // Defensive copy + sort: lexicographic order so the byte layout is
  // deterministic regardless of the caller's ordering.
  const sorted = entries
    .filter((e) => e && typeof e.name === "string" && typeof e.content === "string")
    .map((e) => ({ name: e.name, content: e.content }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const parts = [];
  parts.push(Buffer.from([0x50, 0x4b, 0x31, 0x34])); // 'PK14'
  for (const entry of sorted) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    if (nameBytes.length > 0xffff) {
      throw new Error("FIXTURE_INVALID: entry name exceeds 65535 bytes");
    }
    const payload = deflateRawSync(Buffer.from(entry.content, "utf8"));
    if (!Buffer.isBuffer(payload) || !Number.isFinite(payload.length)) {
      throw new Error("ARCHIVE_INVALID: deflateRawSync returned non-finite bytes");
    }
    const nameLen = Buffer.alloc(2);
    nameLen.writeUInt16BE(nameBytes.length, 0);
    const payloadLen = Buffer.alloc(4);
    payloadLen.writeUInt32BE(payload.length, 0);
    parts.push(nameLen, nameBytes, payloadLen, payload);
  }
  parts.push(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  return Buffer.concat(parts);
}

/**
 * Validate a package-validator fixture.
 *
 * @param {unknown} fixture parsed JSON
 * @returns {{ ok: true, fixture: object } | { ok: false, code: string }}
 */
export function validatePackageValidatorFixture(fixture) {
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (fixture.schemaVersion !== 1) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (typeof fixture.case !== "string") {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!Array.isArray(fixture.entries)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  for (const entry of fixture.entries) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (typeof entry.name !== "string" || entry.name.length === 0) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (typeof entry.content !== "string") {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
  }
  return { ok: true, fixture };
}

/**
 * Run the synthetic-archive scan against a validated fixture.
 *
 * @param {object} fixture validated by validatePackageValidatorFixture
 * @returns {{ ok: true, archiveSha256: string, byteLength: number, entryCount: number } | { ok: false, code: string, message?: string }}
 */
export function scanSyntheticArchive(fixture) {
  const validation = validatePackageValidatorFixture(fixture);
  if (!validation.ok) {
    return { ok: false, code: validation.code };
  }
  const entries = validation.fixture.entries;

  // (a) Entry-name denylist: no forbidden substrings in any entry name.
  for (const entry of entries) {
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      if (entry.name.includes(forbidden)) {
        return {
          ok: false,
          code: "ARCHIVE_CONTAMINATED",
          message: `entry "${entry.name}" contains forbidden substring "${forbidden}"`,
        };
      }
    }
  }

  // (b) Canonical entry present (allowlist anchor).
  const names = new Set(entries.map((e) => e.name));
  if (!names.has(CANONICAL_ENTRY_PRIMARY) && !names.has(CANONICAL_ENTRY_ALIAS)) {
    return {
      ok: false,
      code: "MISSING_CANONICAL_ENTRY",
      message: `fixture must include "${CANONICAL_ENTRY_PRIMARY}" or "${CANONICAL_ENTRY_ALIAS}"`,
    };
  }

  // (c) Determinism: build the archive twice and assert byte equality +
  //     a stable SHA-256.
  let archive1;
  let archive2;
  try {
    archive1 = buildSyntheticArchive(entries);
    archive2 = buildSyntheticArchive(entries);
  } catch (err) {
    return {
      ok: false,
      code: "ARCHIVE_INVALID",
      message: err && err.message ? err.message : String(err),
    };
  }
  if (!Buffer.isBuffer(archive1) || !Number.isFinite(archive1.length)) {
    return { ok: false, code: "ARCHIVE_INVALID" };
  }
  if (archive1.length !== archive2.length || archive1.equals(archive2) === false) {
    return { ok: false, code: "ARCHIVE_NON_DETERMINISTIC" };
  }
  const sha256 = createHash("sha256").update(archive1).digest("hex");
  return {
    ok: true,
    archiveSha256: sha256,
    byteLength: archive1.length,
    entryCount: entries.length,
  };
}

// ---------------------------------------------------------------------------
// CLI: invoked directly as `node scripts/package-validator.mjs <fixture>`
// ---------------------------------------------------------------------------
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  const fixturePath = process.argv[2];
  if (!fixturePath) {
    console.log("PACKAGE_VALIDATOR: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    let fixture = null;
    try {
      const body = await readFile(resolve(process.cwd(), fixturePath), "utf8");
      fixture = JSON.parse(body);
    } catch {
      console.log("PACKAGE_VALIDATOR: FIXTURE_INVALID");
      process.exitCode = 1;
    }
    if (fixture) {
      const verdict = scanSyntheticArchive(fixture);
      if (verdict.ok) {
        console.log("PACKAGE_VALIDATOR: READY");
      } else {
        console.log(`PACKAGE_VALIDATOR: ${verdict.code}`);
        if (verdict.message) console.error(verdict.message);
        process.exitCode = 1;
      }
    }
  }
}
