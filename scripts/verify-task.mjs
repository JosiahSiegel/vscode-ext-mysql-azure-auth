import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const EXPECTED_NODE_VERSION = "20.16.0";
const EXPECTED_PACKAGE_MANAGER = "npm@10.8.1";
const mutableTestCount = /\b\d[\d,]*\s+(?:unit\s+|integration\s+)?tests?\b/iu;
const gateCodes = {
  npmCi: "INSTALL_FAIL",
  lint: "LINT_FAIL",
  typecheck: "TYPECHECK_FAIL",
  compile: "COMPILE_FAIL",
  unit: "TEST_FAIL",
  integration: "TEST_FAIL",
  packageVerify: "PACKAGE_VERIFY_FAIL",
};

const task = process.argv[2];
if (task === "package") {
  if (!process.argv.includes("--synthetic")) {
    console.error("PACKAGE_VERIFY_FAIL");
    process.exitCode = 1;
  }
} else if (task === "1") {
  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("BASELINE NOT READY: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    const fixture = JSON.parse(await readFile(resolve(process.cwd(), fixturePath), "utf8"));
    let failureCode;
    if (fixture.nodeVersion !== EXPECTED_NODE_VERSION) {
      failureCode = "RUNTIME_NOT_READY:NODE_VERSION_MISMATCH";
    } else if (fixture.packageManager !== EXPECTED_PACKAGE_MANAGER) {
      failureCode = "RUNTIME_NOT_READY:PACKAGE_MANAGER_MISMATCH";
    } else if (!Array.isArray(fixture.documents) || fixture.documents.some((text) => mutableTestCount.test(text))) {
      failureCode = "STALE_COUNT_CLAIM";
    } else {
      for (const [gate, code] of Object.entries(gateCodes)) {
        if (fixture.gateExitCodes?.[gate] !== 0) {
          failureCode = code;
          break;
        }
      }
    }

    if (failureCode) {
      console.log(`BASELINE NOT READY: ${failureCode}`);
      process.exitCode = 1;
    } else {
      console.log("BASELINE READY");
    }
  }
} else {
  console.error("BASELINE NOT READY: TASK_UNSUPPORTED");
  process.exitCode = 1;
}
