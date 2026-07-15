// Release contract test for Todo 2.
// Runs against the live package.json (parsed via JSON.parse(await readFile(...))).
// Invokes the validator exported from scripts/verify-task.mjs without
// requiring the existing Mocha test suite.

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");

const validatorModule = await import(pathToFileURL(resolve(repoRoot, "scripts/verify-task.mjs")).href);
const {
  PRODUCT_SENTENCE,
  readLiveSurface,
  validateContractFixture,
  diffSurface,
  checkTitles,
  applySurfaceFixture,
} = validatorModule;

const packageJsonPath = resolve(repoRoot, "package.json");
const contractPath = resolve(repoRoot, "test/fixtures/release/release-contract.json");

const manifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
const contract = JSON.parse(await readFile(contractPath, "utf8"));

const argv = process.argv.slice(2);
let singleFixturePath;
let singleExpectedCode;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--fixture") {
    singleFixturePath = resolve(repoRoot, argv[i + 1]);
    i += 1;
    continue;
  }
  if (argv[i] === "--expect" && typeof argv[i + 1] === "string") {
    singleExpectedCode = argv[i + 1];
    i += 1;
  }
}

const fixtures = [
  {
    label: "valid (no mutation)",
    path: resolve(repoRoot, "test/fixtures/release/surface-valid.json"),
    expectReady: true,
    expectCode: "CONTRACT READY",
  },
  {
    label: "extra-command (drift: phantom manifest command)",
    path: resolve(repoRoot, "test/fixtures/release/surface-extra-command.json"),
    expectReady: false,
    expectCode: "SURFACE_DRIFT",
  },
  {
    label: "createTable-still-present (drift: removed command still in manifest)",
    path: resolve(repoRoot, "test/fixtures/release/surface-createTable-still-present.json"),
    expectReady: false,
    expectCode: "SURFACE_DRIFT",
  },
];

let failures = 0;
let machineResult = "CONTRACT READY";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures += 1;
  } else {
    console.log(`PASS ${label}`);
  }
}

assertEqual(
  manifest.description,
  PRODUCT_SENTENCE,
  "package.json description matches the locked product sentence",
);

const contractValidation = validateContractFixture(contract);
assertEqual(contractValidation.ok, true, "release-contract.json validates structurally");

const liveSurface = readLiveSurface(manifest);
const liveDrift = diffSurface(liveSurface, contractValidation.contract);
const titles = checkTitles(manifest, contractValidation.contract);
assertEqual(
  liveDrift.drift,
  false,
  `live manifest agrees with release-contract.json (missing=${liveDrift.missing.length}, disallowed=${liveDrift.disallowed.length}, mismatchedRename=${liveDrift.mismatchedRename.length})`,
);
assertEqual(titles.ok, true, "live manifest carries expected titles");

const runList = singleFixturePath
  ? fixtures.filter((f) => f.path === singleFixturePath).length > 0
    ? fixtures.filter((f) => f.path === singleFixturePath)
    : [{
        label: `single-fixture(${singleFixturePath})`,
        path: singleFixturePath,
        expectReady: !singleExpectedCode || singleExpectedCode === "CONTRACT READY",
        expectCode: singleExpectedCode ?? "CONTRACT READY",
      }]
  : fixtures;

for (const fixture of runList) {
  const caseFixture = JSON.parse(await readFile(fixture.path, "utf8"));
  const applied = applySurfaceFixture(manifest, caseFixture);
  assertEqual(applied.ok, true, `${fixture.label}: surface fixture schema is valid`);

  const surface = readLiveSurface(applied.manifest);
  const drift = diffSurface(surface, contractValidation.contract);
  const fixtureTitles = checkTitles(applied.manifest, contractValidation.contract);
  const ready = !drift.drift && fixtureTitles.ok;
  assertEqual(ready, fixture.expectReady, `${fixture.label}: validator returns ready=${fixture.expectReady}`);

  const cli = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "scripts/verify-task.mjs"),
      "2",
      "--fixture",
      fixture.path,
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  const cliStdout = cli.stdout.trim();
  const cliStderr = cli.stderr.trim();
  assertEqual(cli.status, fixture.expectReady ? 0 : 1, `${fixture.label}: CLI exit code`);
  const containsExpected =
    cliStdout.includes(fixture.expectCode) || cliStderr.includes(fixture.expectCode);
  assertEqual(
    containsExpected,
    true,
    `${fixture.label}: CLI prints ${fixture.expectCode} (stdout=${JSON.stringify(cliStdout)}, stderr=${JSON.stringify(cliStderr)})`,
  );
}

if (failures > 0) {
  machineResult = singleFixturePath && singleExpectedCode && singleExpectedCode !== "CONTRACT READY"
    ? singleExpectedCode
    : "CONTRACT NOT READY: SURFACE_DRIFT";
}

console.log(machineResult);
if (machineResult !== "CONTRACT READY") {
  process.exit(1);
}