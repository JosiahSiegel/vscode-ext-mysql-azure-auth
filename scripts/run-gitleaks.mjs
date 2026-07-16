#!/usr/bin/env node
// scripts/run-gitleaks.mjs
//
// Todo 13 — deterministic gitleaks v8.24.3 secret scanner.
//
// Pipeline:
//   1. Read scripts/tool-checksums.json and select the platform-specific
//      archive (Windows x64 is the only option covered on this host; the
//      table also lists linux-x64, darwin-x64, darwin-arm64, and
//      linux-arm64 so CI runners get the right asset).
//   2. Download the archive from the canonical gitleaks release URL using
//      Node's tls/https stack. No external HTTP client is used.
//   3. Verify SHA-256 against the pinned value from tool-checksums.json.
//      Mismatch -> SECURITY TOOLCHAIN NOT READY: CHECKSUM_MISMATCH exit 1.
//   4. Extract into .tools/gitleaks/8.24.3/ (zip or tar.gz).
//      Extraction failure -> SECURITY TOOLCHAIN NOT READY: EXTRACT_FAIL.
//   5. Write a synthetic .gitleaks.toml that allowlists non-source
//      paths (node_modules, .vscode-test, .omo, .tools, out, *.log, *.txt)
//      so the scan stays focused on shipped source.
//   6. Invoke the binary with:
//        gitleaks detect --source . --no-git --redact --exit-code 1
//                --config <tmp gitleaks.toml>
//      and propagate exit code 1 from a finding, exit code 0 from a clean
//      scan, and emit SECURITY TOOLCHAIN NOT READY: PLATFORM_UNSUPPORTED
//      exit 2 when the host platform/arch lacks a recorded asset.
//
// All errors are fail-closed; the script never claims success without
// independent verification of the downloaded bytes.

import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm, writeFile, chmod, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import https from "node:https";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const CHECKSUMS_PATH = resolve(SCRIPT_DIR, "tool-checksums.json");
const TOOL_VERSION = "8.24.3";
const TOOL_DIR = resolve(ROOT, ".tools", "gitleaks", TOOL_VERSION);
const TMP_CONFIG = resolve(ROOT, ".tools", "gitleaks", ".gitleaks.toml");

const FAIL = (code, message) => {
  console.error(`SECURITY TOOLCHAIN NOT READY: ${code}`);
  if (message) console.error(message);
  process.exit(1);
};

const PLATFORM_TABLE = {
  "win32-x64": "windows-x64",
  "linux-x64": "linux-x64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-arm64": "linux-arm64",
};

async function readJson(path) {
  const body = await readFile(path, "utf8");
  return JSON.parse(body);
}

function downloadTo(url, destination) {
  return new Promise((resolveFn, rejectFn) => {
    const request = https.get(url, { headers: { "user-agent": "mysql-azure-auth-run-gitleaks" } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadTo(response.headers.location, destination).then(resolveFn, rejectFn);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        rejectFn(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      const file = createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(() => resolveFn()));
      file.on("error", (err) => rejectFn(err));
    });
    request.on("error", rejectFn);
    request.setTimeout(60_000, () => request.destroy(new Error("download timeout")));
  });
}

async function extract(archivePath, destDir, archiveType) {
  await mkdir(destDir, { recursive: true });
  if (archiveType === "zip") {
    // Node has no native unzip; rely on `powershell Expand-Archive` on
    // Windows, the `unzip` binary on Linux, and `tar -xf` for tar.gz.
    if (process.platform === "win32") {
      const ps = spawnSync(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'`],
        { encoding: "utf8" },
      );
      if (ps.status !== 0) {
        throw new Error(`Expand-Archive failed: ${ps.stderr || ps.stdout}`);
      }
      return;
    }
    const unzip = spawnSync("unzip", ["-oq", archivePath, "-d", destDir], { encoding: "utf8" });
    if (unzip.status !== 0) {
      throw new Error(`unzip failed: ${unzip.stderr || unzip.stdout}`);
    }
    return;
  }
  if (archiveType === "tar.gz") {
    const tar = spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { encoding: "utf8" });
    if (tar.status !== 0) {
      throw new Error(`tar -xzf failed: ${tar.stderr || tar.stdout}`);
    }
    return;
  }
  throw new Error(`unsupported archive type ${archiveType}`);
}

async function main() {
  const platformKey = `${process.platform}-${process.arch}`;
  const platformKeyNormalized = PLATFORM_TABLE[platformKey];
  if (!platformKeyNormalized) {
    console.error(`SECURITY TOOLCHAIN NOT READY: PLATFORM_UNSUPPORTED (${platformKey})`);
    process.exit(2);
  }

  const checksums = await readJson(CHECKSUMS_PATH);
  const platformSpec = checksums.gitleaks?.platforms?.[platformKeyNormalized];
  if (!platformSpec) {
    console.error(`SECURITY TOOLCHAIN NOT READY: PLATFORM_UNSUPPORTED (${platformKeyNormalized} not in checksums)`);
    process.exit(2);
  }

  const expectedSha = String(platformSpec.sha256 || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    FAIL("CHECKSUM_MISSING", `platform ${platformKeyNormalized} has invalid sha256 record`);
  }

  const releaseUrl = checksums.gitleaks?.releaseUrl;
  if (!releaseUrl) {
    FAIL("CHECKSUM_MISSING", "missing releaseUrl in tool-checksums.json");
  }
  const archiveUrl = `${releaseUrl.replace(/\/$/, "")}/${platformSpec.asset}`;
  const archivePath = resolve(ROOT, ".tools", "gitleaks", platformSpec.asset);
  const binaryPath = resolve(TOOL_DIR, platformSpec.binary);

  await mkdir(resolve(ROOT, ".tools", "gitleaks"), { recursive: true });

  let shouldDownload = true;
  if (existsSync(binaryPath)) {
    // Cache hit: trust the local copy if and only if its SHA-256 matches
    // the pinned value (we verify the binary, not the archive).
    const sha = createHash("sha256").update(await readFile(binaryPath)).digest("hex").toLowerCase();
    if (sha === expectedSha) {
      shouldDownload = false;
    }
  }

  if (shouldDownload) {
    try {
      await downloadTo(archiveUrl, archivePath);
    } catch (err) {
      // Clean partial download and surface a deterministic diagnostic.
      try { await rm(archivePath, { force: true }); } catch { /* ignore */ }
      FAIL("DOWNLOAD_FAIL", `${archiveUrl}: ${err && err.message ? err.message : err}`);
    }

    const archiveBytes = await readFile(archivePath);
    const archiveSha = createHash("sha256").update(archiveBytes).digest("hex").toLowerCase();
    if (archiveSha !== expectedSha) {
      try { await rm(archivePath, { force: true }); } catch { /* ignore */ }
      FAIL("CHECKSUM_MISMATCH", `expected ${expectedSha} got ${archiveSha} for ${platformSpec.asset}`);
    }

    try {
      await extract(archivePath, TOOL_DIR, platformSpec.archive);
    } catch (err) {
      try { await rm(archivePath, { force: true }); } catch { /* ignore */ }
      FAIL("EXTRACT_FAIL", `${err && err.message ? err.message : err}`);
    }
    try { await rm(archivePath, { force: true }); } catch { /* ignore */ }

    if (!existsSync(binaryPath)) {
      FAIL("EXTRACT_FAIL", `binary not found at expected path after extraction`);
    }
    try {
      await chmod(binaryPath, 0o755);
    } catch { /* best effort on Windows */ }
  }

  // Generate a path-allowlisting config so the scan focuses on production
  // source rather than downloaded build artefacts (.vscode-test, .tools).
  // We use allowlist.paths with anchored regexes per the gitleaks docs.
  const gitleaksConfig = `title = "mysql-azure-auth focused scan"

# Generated by scripts/run-gitleaks.mjs (Todo 13). Allowlist non-source
# paths so the secret scan stays focused on shipped code.

[[allowlists]]
description = "ignore generated / non-source artefacts"
target = "Detector"
paths = [
  '''(?:^|/)node_modules/''',
  '''(?:^|/)\\.vscode-test/''',
  '''(?:^|/)\\.tools/''',
  '''(?:^|/)\\.omo/''',
  '''(?:^|/)out/''',
  '''(?:^|/)package-lock\\.json$''',
  '''(?:^|/)\\.git/''',
  '''\\.(?:log|txt|map)$''',
  '''(?:^|/)foofoo\\.txt$''',
]
`;
  await writeFile(TMP_CONFIG, gitleaksConfig, "utf8");

  const args = [
    "detect",
    "--source", ".",
    "--no-git",
    "--redact",
    "--exit-code", "1",
    "--config", TMP_CONFIG,
  ];

  const result = spawnSync(binaryPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    encoding: "utf8",
  });
  // Treat spawn errors (binary missing/unexecutable) as toolchain failure.
  if (result.error) {
    FAIL("EXEC_FAIL", result.error.message);
  }
  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error(`SECURITY TOOLCHAIN NOT READY: ${err && err.code ? err.code : "ERROR"}`);
  if (err && err.message) console.error(err.message);
  process.exit(1);
});
