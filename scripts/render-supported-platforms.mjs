#!/usr/bin/env node
/**
 * scripts/render-supported-platforms.mjs
 *
 * Todo 15 — controlled preview release support-matrix renderer.
 *
 * Reads the optional owner-supplied CI fixture at
 *   .omo/inputs/platform-ci.json
 * validates its schema (schemaVersion 1, sourceCommit 40-hex, runs[] of
 * { os, conclusion, completedAt, logPath, logSha256 }), verifies each log
 * file's bytes against its declared SHA-256, enforces per-OS `process.arch`
 * expectations on the log content, and emits a deterministic markdown
 * summary of the resulting support matrix.
 *
 * Support matrix (locked by the plan body):
 *   - windows-x64     process.arch === "x64"
 *   - ubuntu-x64      process.arch === "x64"
 *   - macos-arm64     process.arch === "arm64"
 *
 * Behaviour matrix:
 *
 *   File absent                              -> stderr "PLATFORM SUPPORT NOT READY"  exit 2
 *   File malformed                           -> stderr "PLATFORM SUPPORT NOT READY"  exit 2
 *   Zero successful arch-passing runs        -> stderr "PLATFORM SUPPORT NOT READY"  exit 2
 *   At least one successful arch-passing run -> stdout markdown summary             exit 0
 *
 * Output is byte-stable: runs are sorted by `os`, no timestamps or random
 * values appear in the emitted document.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const INPUT_PATH = ".omo/inputs/platform-ci.json";
const SUPPORTED_OS = new Set(["windows-x64", "ubuntu-x64", "macos-arm64"]);

/**
 * Per-OS arch expectations. The log must contain the literal phrase
 * `process.arch === "<arch>"` (including the surrounding quotes and
 * operator). The validator tolerates either single or double quotes.
 *
 * @type {Record<string, string>}
 */
const ARCH_EXPECTATION = {
  "windows-x64": "x64",
  "ubuntu-x64": "x64",
  "macos-arm64": "arm64",
};

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const SOURCE_COMMIT_HEX_RE = /^[0-9a-f]{40}$/;
const ISO_8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function bailNotReady(reason) {
  const message = reason ? `PLATFORM SUPPORT NOT READY: ${reason}` : "PLATFORM SUPPORT NOT READY";
  console.error(message);
  process.exit(2);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * Verify that the supplied log content carries the expected `process.arch`
 * phrase for the given OS. Returns true when the phrase appears.
 *
 * @param {string} logBody raw log bytes
 * @param {string} os one of the supported os identifiers
 */
function logMentionsExpectedArch(logBody, os) {
  const expected = ARCH_EXPECTATION[os];
  if (!expected) return false;
  const pattern = new RegExp(
    `process\\.arch\\s*===\\s*(['"])${expected.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\1`,
  );
  return pattern.test(logBody);
}

/**
 * Validate the platform-ci.json document. Returns either
 *   { ok: true, payload } on success
 *   { ok: false, code }   on any structural failure.
 *
 * @param {string} [overridePath] when provided, read this path instead
 *   of the canonical INPUT_PATH. Used by Todo 15's clean-fixture branch
 *   to point the renderer at a synthetic temp file.
 */
async function loadAndValidateFixture(overridePath) {
  const targetPath = typeof overridePath === "string" && overridePath.length > 0
    ? overridePath
    : INPUT_PATH;
  let raw;
  try {
    raw = await readFile(resolve(process.cwd(), targetPath), "utf8");
  } catch {
    return { ok: false, code: "INPUT_MISSING" };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "FIXTURE_INVALID" };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (parsed.schemaVersion !== 1) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!isString(parsed.sourceCommit) || !SOURCE_COMMIT_HEX_RE.test(parsed.sourceCommit)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!Array.isArray(parsed.runs)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }

  const validRuns = [];
  for (const run of parsed.runs) {
    if (!isPlainObject(run)) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (!isString(run.os) || !SUPPORTED_OS.has(run.os)) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (run.conclusion !== "success") {
      // Only successful runs count toward the support matrix. Failures
      // are silently dropped, but malformed entries (e.g. conclusion not
      // a string) still fail validation.
      if (typeof run.conclusion !== "string") {
        return { ok: false, code: "FIXTURE_INVALID" };
      }
      continue;
    }
    if (!isString(run.completedAt) || !ISO_8601_RE.test(run.completedAt)) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (!isString(run.logPath) || run.logPath.length === 0) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (!isString(run.logSha256) || !SHA256_HEX_RE.test(run.logSha256)) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }

    let logBytes;
    try {
      logBytes = await readFile(resolve(process.cwd(), run.logPath));
    } catch {
      return { ok: false, code: "LOG_UNREADABLE" };
    }

    const computed = createHash("sha256").update(logBytes).digest("hex").toLowerCase();
    if (computed !== run.logSha256.toLowerCase()) {
      return { ok: false, code: "LOG_HASH_MISMATCH" };
    }

    const logBody = logBytes.toString("utf8");
    if (!logMentionsExpectedArch(logBody, run.os)) {
      // Drop the run from the supported set; the OS is not yet verified.
      continue;
    }

    validRuns.push({
      os: run.os,
      completedAt: run.completedAt,
      logPath: run.logPath,
    });
  }

  return { ok: true, payload: parsed, validRuns };
}

/**
 * Emit a deterministic markdown summary of the support matrix.
 *
 * @param {string} sourceCommit 40-hex source commit
 * @param {Array<{os: string, completedAt: string, logPath: string}>} validRuns
 */
function renderMarkdown(sourceCommit, validRuns) {
  const byOs = new Map();
  for (const os of SUPPORTED_OS) {
    byOs.set(os, []);
  }
  for (const run of validRuns) {
    byOs.get(run.os).push(run);
  }

  const lines = [];
  lines.push("# Supported platforms");
  lines.push("");
  lines.push(`sourceCommit: ${sourceCommit}`);
  lines.push("");
  lines.push("| OS | Smoke result | Log |");
  lines.push("| --- | --- | --- |");

  for (const os of [...SUPPORTED_OS].sort()) {
    const runs = byOs.get(os);
    if (runs.length === 0) {
      lines.push(`| ${os} | unsupported |  |`);
    } else {
      // Stable sort by completedAt then logPath to keep output deterministic.
      runs.sort((a, b) => {
        if (a.completedAt !== b.completedAt) return a.completedAt < b.completedAt ? -1 : 1;
        return a.logPath < b.logPath ? -1 : a.logPath > b.logPath ? 1 : 0;
      });
      for (const run of runs) {
        lines.push(`| ${os} | PASS | ${run.logPath} |`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

/* ---------------------------------------------------------------------------
 * CLI entry
 * -------------------------------------------------------------------------*/

const invokedDirectly = import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`;
if (invokedDirectly) {
  const result = await loadAndValidateFixture();
  if (!result.ok) {
    bailNotReady(result.code);
  }
  if (result.validRuns.length === 0) {
    bailNotReady("NO_SUCCESSFUL_RUNS");
  }
  const markdown = renderMarkdown(result.payload.sourceCommit, result.validRuns);
  process.stdout.write(markdown);
}

export {
  loadAndValidateFixture,
  renderMarkdown,
  logMentionsExpectedArch,
  ARCH_EXPECTATION,
  SUPPORTED_OS,
  INPUT_PATH,
};