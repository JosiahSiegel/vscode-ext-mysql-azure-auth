import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_NODE_VERSION = "20.16.0";
const EXPECTED_PACKAGE_MANAGER = "npm@10.8.1";

const fixtureIndex = process.argv.indexOf("--fixture");
const fixturePath = fixtureIndex === -1 ? undefined : process.argv[fixtureIndex + 1];
const root = process.cwd();

const runtime = fixturePath
  ? JSON.parse(await readFile(resolve(root, fixturePath), "utf8"))
  : {
      nodeVersion: (await readFile(resolve(root, ".node-version"), "utf8")).trimEnd(),
      packageManager: JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).packageManager,
    };

const mismatches = [];
if (runtime.nodeVersion !== EXPECTED_NODE_VERSION) {
  mismatches.push(
    `NODE_VERSION_MISMATCH: expected ${EXPECTED_NODE_VERSION}, got ${String(runtime.nodeVersion)}`,
  );
}
if (runtime.packageManager !== EXPECTED_PACKAGE_MANAGER) {
  mismatches.push(
    `PACKAGE_MANAGER_MISMATCH: expected ${EXPECTED_PACKAGE_MANAGER}, got ${String(runtime.packageManager)}`,
  );
}

if (mismatches.length > 0) {
  console.error(mismatches.join("\n"));
  process.exitCode = 1;
}
