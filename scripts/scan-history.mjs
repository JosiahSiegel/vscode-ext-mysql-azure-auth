#!/usr/bin/env node
// scripts/scan-history.mjs
//
// Scans every reachable Git object in the local repository for content that
// would be considered a release-blocker in a public source root:
//   * PII / secrets — tight PII regex and JWT/sensitive-pattern detection.
//   * The same gitleaks-style patterns used by the package-allowlist gate.
//
// The scan runs against bytes materialised through `git cat-file --batch`,
// never against the working tree, so it inspects history without checking
// content out. reflog-only objects that have already expired are reported
// as a limitation in the machine result line.
//
// Machine results:
//   exit 0  HISTORY CLEAN
//           " (with N reflog blobs unreachable)" appended if any reflog blob
//           could not be inspected from the local repo
//   exit 1  FRESH PUBLIC ROOT REQUIRED  + JSON list of sensitive blob IDs
//   exit 2  HISTORY SCAN INCOMPLETE    + JSON list of unreadable/missing IDs

import { spawnFile, spawnLine } from "./lib/git-run.mjs";

const PII_RULES = [
  {
    id: "pii-email-XXXXXXXX",
    pattern: /REDACT7@XXXXXXXX\.com/iu,
    label: "literal personal email leaked into history",
  },
  {
    id: "pii-email-generic",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u,
    label: "embedded email address",
  },
];

const SENSITIVE_RULES = [
  {
    id: "jwt-bearer",
    // Conservative JWT shape: header.payload.signature, three base64url segments.
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u,
    label: "JWT-shaped token",
  },
  {
    id: "aws-access-key",
    pattern: /AKIA[0-9A-Z]{16}/u,
    label: "AWS access key id",
  },
  {
    id: "github-token",
    pattern: /gh[pousr]_[A-Za-z0-9]{36,}/u,
    label: "GitHub token",
  },
  {
    id: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u,
    label: "PEM private key",
  },
];

const ALL_RULES = [...SENSITIVE_RULES, ...PII_RULES];

function summariseLabels(findings) {
  const labels = new Set();
  for (const f of findings) labels.add(f.ruleLabel);
  return Array.from(labels).sort();
}

function blobFindings(bytes) {
  const text = bytes.toString("binary");
  const findings = [];
  for (const rule of ALL_RULES) {
    if (rule.pattern.test(text)) {
      findings.push({ ruleId: rule.id, ruleLabel: rule.label });
    }
  }
  return findings;
}

async function readReflogBlobs() {
  // reflog only records commits; expanding those to the objects they reference
  // gives every blob that ever appeared on any reflog-reachable commit.
  const shas = new Set();
  for await (const line of spawnLine("git", ["reflog", "show", "--all", "--format=%H"])) {
    if (/^[0-9a-f]{40}$/u.test(line)) shas.add(line);
  }
  if (shas.size === 0) return [];
  const ids = new Set();
  for (const sha of shas) {
    const args = ["rev-list", "--objects", sha];
    for await (const line of spawnLine("git", args)) {
      const sha2 = line.slice(0, 40);
      if (/^[0-9a-f]{40}$/u.test(sha2)) ids.add(sha2);
    }
  }
  return Array.from(ids);
}

async function readCommitBlobs() {
  const ids = new Set();
  for await (const line of spawnLine("git", ["rev-list", "--objects", "--all"])) {
    const sha = line.slice(0, 40);
    if (/^[0-9a-f]{40}$/u.test(sha)) ids.add(sha);
  }
  return Array.from(ids);
}

async function checkExists(id) {
  const proc = await spawnFile("git", ["cat-file", "-e", id], { allowExitCodes: new Set([0, 1, 128]) });
  return proc.exitCode === 0;
}

async function readBlobBytes(id) {
  const proc = await spawnFile("git", ["cat-file", "blob", id], { allowExitCodes: new Set([0, 1, 128]) });
  if (proc.exitCode !== 0) return null;
  return Buffer.from(proc.stdout, "binary");
}

function emitClean(extra) {
  const suffix = extra ? ` (with ${extra} reflog blobs unreachable)` : "";
  process.stdout.write(`HISTORY CLEAN${suffix}\n`);
  process.exit(0);
}

function emitFreshRequired(findings) {
  const list = findings.map((f) => ({ blobId: f.blobId, reasons: f.reasons }));
  process.stdout.write("FRESH PUBLIC ROOT REQUIRED\n");
  process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
  process.exit(1);
}

function emitIncomplete(unreadable) {
  process.stdout.write("HISTORY SCAN INCOMPLETE\n");
  process.stdout.write(`${JSON.stringify(unreadable, null, 2)}\n`);
  process.exit(2);
}

async function main() {
  const allIds = new Set();
  const commitBlobs = await readCommitBlobs();
  for (const id of commitBlobs) allIds.add(id);
  const reflogBlobs = await readReflogBlobs();
  let reflogOnlyCount = 0;
  for (const id of reflogBlobs) {
    if (!allIds.has(id)) reflogOnlyCount++;
    allIds.add(id);
  }

  const sensitive = [];
  const unreadable = [];

  for (const id of allIds) {
    const exists = await checkExists(id);
    if (!exists) {
      unreadable.push({ blobId: id, reason: "cat-file -e failed; object not reachable from this repository" });
      continue;
    }
    const bytes = await readBlobBytes(id);
    if (bytes === null) {
      unreadable.push({ blobId: id, reason: "cat-file blob failed; object unreadable" });
      continue;
    }
    if (bytes.length === 0) continue;
    if (bytes.includes(0)) continue; // skip binary blobs (commits, trees, packed binary)
    const findings = blobFindings(bytes);
    if (findings.length > 0) {
      sensitive.push({ blobId: id, reasons: summariseLabels(findings) });
    }
  }

  if (sensitive.length > 0) {
    return emitFreshRequired(sensitive);
  }
  if (unreadable.length > 0) {
    return emitIncomplete(unreadable);
  }
  emitClean(reflogOnlyCount > 0 ? reflogOnlyCount : null);
}

await main();
