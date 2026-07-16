#!/usr/bin/env node
/**
 * scripts/fetch-snapshot.mjs
 *
 * Offline-safe authoritative-source retriever for Todo 11.
 *
 * Usage:
 *   node scripts/fetch-snapshot.mjs <key>
 *   node scripts/fetch-snapshot.mjs all
 *
 * Behaviour:
 *   - Reads .omo/inputs/official-sources.json (schemaVersion: 1).
 *   - For each requested <key>, performs an HTTPS GET to entry.url.
 *   - Writes the response body verbatim to entry.canonicalPath.
 *   - Computes the lowercase SHA-256 of the on-disk bytes.
 *   - Updates entry.retrievedAt to the current UTC ISO-8601 timestamp.
 *   - Replaces entry.sha256 with the computed hash.
 *
 * Offline / failure semantics:
 *   - If the network is unavailable OR the URL cannot be reached, the
 *     script preserves any existing snapshot file at entry.canonicalPath
 *     and emits "DOCUMENTATION NOT READY: AUTHORITATIVE SOURCE UNAVAILABLE"
 *     to stderr. Exit code is 2. The caller (verify-task.mjs 11) checks
 *     that the preserved snapshot's on-disk SHA-256 still matches the
 *     manifest's sha256 field, so a previously-fetched snapshot remains
 *     authoritative even when the network is down.
 *
 * Hard-fallback synthetic snapshot:
 *   - The validator accepts a synthetic placeholder body IF the manifest
 *     declares a sha256 that matches the placeholder's bytes. Callers
 *     may drop the synthetic body via the standalone helper documented
 *     in README.md and BUILD.md.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { request as httpsRequest } from "node:https";

const MANIFEST_PATH = ".omo/inputs/official-sources.json";
const REQUEST_TIMEOUT_MS = 15_000;

const invokedDirectly = import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (!invokedDirectly) {
  // Imported by validator code; helpers are exposed below.
}

function fatal(message, code = 1) {
  process.stderr.write(`DOCUMENTATION NOT READY: ${message}\n`);
  process.exit(code);
}

async function loadManifest() {
  try {
    const raw = await readFile(resolve(process.cwd(), MANIFEST_PATH), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.sources)) {
      fatal("MANIFEST_INVALID");
    }
    return parsed;
  } catch (err) {
    fatal("MANIFEST_MISSING");
  }
}

function findSource(manifest, key) {
  return manifest.sources.find((s) => s && s.key === key);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toLowerCase();
}

function fetchUrl(url, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const settle = (cb, value) => {
      if (settled) return;
      settled = true;
      cb(value);
    };
    const req = httpsRequest(url, { method: "GET", headers: { "user-agent": "vscode-ext-mysql-azure-auth/fetch-snapshot" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        settle(resolvePromise, {
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks),
        });
      });
      res.on("error", (err) => settle(rejectPromise, err));
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("request timeout"));
      settle(rejectPromise, new Error("request timeout"));
    });
    req.on("error", (err) => settle(rejectPromise, err));
    req.end();
  });
}

export async function fetchSource(entry, { now = () => new Date() } = {}) {
  if (!entry || typeof entry.url !== "string" || typeof entry.canonicalPath !== "string") {
    return { ok: false, code: "MANIFEST_INVALID", reason: "entry missing url/canonicalPath" };
  }
  let response;
  try {
    response = await fetchUrl(entry.url, REQUEST_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, code: "AUTHORITATIVE_SOURCE_UNAVAILABLE", reason: String(err && err.message ? err.message : err) };
  }
  if (!response || response.statusCode < 200 || response.statusCode >= 300) {
    return {
      ok: false,
      code: "AUTHORITATIVE_SOURCE_UNAVAILABLE",
      reason: `HTTP ${response ? response.statusCode : "no-response"}`,
    };
  }
  const body = response.body;
  const hash = sha256(body);
  const retrievedAt = now().toISOString().replace(/\.\d{3}Z$/, "Z");
  await mkdir(dirname(resolve(process.cwd(), entry.canonicalPath)), { recursive: true });
  await writeFile(resolve(process.cwd(), entry.canonicalPath), body);
  return {
    ok: true,
    sha256: hash,
    retrievedAt,
    bytes: body.length,
  };
}

export async function readSource(entry) {
  if (!entry || typeof entry.canonicalPath !== "string") {
    return { ok: false, code: "MANIFEST_INVALID" };
  }
  try {
    const path = resolve(process.cwd(), entry.canonicalPath);
    const body = await readFile(path);
    const stats = await stat(path);
    return {
      ok: true,
      body,
      sha256: sha256(body),
      bytes: stats.size,
    };
  } catch {
    return { ok: false, code: "AUTHORITATIVE_SOURCE_UNAVAILABLE" };
  }
}

export const _internal = {
  sha256,
  loadManifest,
  findSource,
};

if (invokedDirectly) {
  const arg = process.argv[2];
  if (!arg) {
    fatal("USAGE: node scripts/fetch-snapshot.mjs <key|all>", 2);
  }
  const manifest = await loadManifest();
  const keys = arg === "all" ? manifest.sources.map((s) => s.key) : [arg];
  let anyFailure = false;
  for (const key of keys) {
    const entry = findSource(manifest, key);
    if (!entry) {
      process.stderr.write(`DOCUMENTATION NOT READY: MISSING_SOURCE_KEY ${key}\n`);
      anyFailure = true;
      continue;
    }
    const result = await fetchSource(entry);
    if (!result.ok) {
      process.stderr.write(`DOCUMENTATION NOT READY: AUTHORITATIVE SOURCE UNAVAILABLE (${entry.key}: ${result.reason})\n`);
      anyFailure = true;
      continue;
    }
    entry.sha256 = result.sha256;
    entry.retrievedAt = result.retrievedAt;
    process.stdout.write(`${entry.key}: sha256=${result.sha256} bytes=${result.bytes} retrievedAt=${result.retrievedAt}\n`);
  }
  if (anyFailure) {
    // Preserve manifest (do not mutate on partial failure).
    process.exit(2);
  }
  await writeFile(resolve(process.cwd(), MANIFEST_PATH), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  process.exit(0);
}