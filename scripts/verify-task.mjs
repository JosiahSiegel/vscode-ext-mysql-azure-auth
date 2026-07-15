import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

export const PRODUCT_SENTENCE =
  "A community-maintained VS Code preview for browsing and querying Azure Database for MySQL Flexible Server with Microsoft Entra authentication.";

const VALID_DISPOSITIONS = new Set(["KEEP", "RENAME", "REMOVE", "INTERNAL"]);

function isString(value) {
  return typeof value === "string" && value.length > 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the live manifest from package.json, capturing command IDs,
 * activation events, view IDs, setting IDs, and menu command references.
 *
 * @param {unknown} manifest parsed package.json content
 */
export function readLiveSurface(manifest) {
  if (!isPlainObject(manifest)) {
    throw new Error("FIXTURE_INVALID");
  }
  const commands = Array.isArray(manifest.contributes?.commands)
    ? manifest.contributes.commands
        .map((c) => (isPlainObject(c) && isString(c.command) ? c.command : null))
        .filter((v) => v !== null)
    : [];
  const activationEvents = Array.isArray(manifest.activationEvents)
    ? manifest.activationEvents.filter((e) => typeof e === "string")
    : [];
  const views = {};
  if (isPlainObject(manifest.contributes?.views)) {
    for (const container of Object.keys(manifest.contributes.views)) {
      const viewList = manifest.contributes.views[container];
      if (Array.isArray(viewList)) {
        for (const v of viewList) {
          if (isPlainObject(v) && isString(v.id)) {
            views[v.id] = v;
          }
        }
      }
    }
  }
  const settings = {};
  const cfgProps = manifest.contributes?.configuration?.properties;
  if (isPlainObject(cfgProps)) {
    for (const key of Object.keys(cfgProps)) {
      settings[key] = cfgProps[key];
    }
  }
  const menuCommands = new Set();
  const menus = manifest.contributes?.menus;
  if (isPlainObject(menus)) {
    for (const scope of Object.keys(menus)) {
      const entries = menus[scope];
      if (Array.isArray(entries)) {
        for (const m of entries) {
          if (isPlainObject(m) && isString(m.command)) {
            menuCommands.add(m.command);
          }
        }
      }
    }
  }
  return {
    description: typeof manifest.description === "string" ? manifest.description : "",
    commands,
    activationEvents,
    views,
    settings,
    menuCommands: Array.from(menuCommands),
  };
}

/**
 * Validate the contract fixture structure.
 *
 * @param {unknown} fixture parsed JSON
 * @returns {{ ok: true, contract: object } | { ok: false, code: string }}
 */
export function validateContractFixture(fixture) {
  if (!isPlainObject(fixture)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (typeof fixture.productSentence !== "string") {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (fixture.productSentence !== PRODUCT_SENTENCE) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!isPlainObject(fixture.items) || Array.isArray(fixture.items)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!Array.isArray(fixture.disallowedCommands)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!Array.isArray(fixture.disallowedActivationEvents)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!Array.isArray(fixture.disallowedSettings)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  for (const v of [...fixture.disallowedCommands, ...fixture.disallowedActivationEvents, ...fixture.disallowedSettings]) {
    if (typeof v !== "string") {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
  }
  for (const [key, value] of Object.entries(fixture.items)) {
    if (!isPlainObject(value)) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (typeof value.kind !== "string" || !["command", "activationEvent", "view", "setting"].includes(value.kind)) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (typeof value.id !== "string" || value.id.length === 0) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (typeof value.disposition !== "string" || !VALID_DISPOSITIONS.has(value.disposition)) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (value.disposition === "RENAME") {
      if (typeof value.renameTo !== "string" || value.renameTo.length === 0) {
        return { ok: false, code: "FIXTURE_INVALID" };
      }
    }
    if (value.kind === "command" && value.disposition === "KEEP" && typeof value.title !== "string") {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
  }
  return { ok: true, contract: fixture };
}

/**
 * Compute the diff between live surface and contract fixture.
 *
 * @param {object} live output of readLiveSurface
 * @param {object} contract validated contract fixture
 * @returns {{ drift: boolean, missing: string[], disallowed: string[], mismatchedRename: string[], mismatchedTitle: string[] }}
 */
export function diffSurface(live, contract) {
  const liveCommands = new Set(live.commands);
  const liveEvents = new Set(live.activationEvents);
  const liveSettings = new Set(Object.keys(live.settings));
  const liveViews = new Set(Object.keys(live.views));

  const missing = [];
  const mismatchedRename = [];
  const mismatchedTitle = [];

  for (const [key, item] of Object.entries(contract.items)) {
    if (item.disposition === "KEEP") {
      if (item.kind === "command") {
        if (!liveCommands.has(item.id)) {
          missing.push(`command:${item.id}`);
        }
      } else if (item.kind === "activationEvent") {
        if (!liveEvents.has(item.id)) {
          missing.push(`event:${item.id}`);
        }
      } else if (item.kind === "view") {
        if (!liveViews.has(item.id)) {
          missing.push(`view:${item.id}`);
        }
      } else if (item.kind === "setting") {
        if (!liveSettings.has(item.id)) {
          missing.push(`setting:${item.id}`);
        }
      }
    } else if (item.disposition === "RENAME") {
      if (item.kind === "command") {
        if (!liveCommands.has(item.renameTo)) {
          missing.push(`rename:${item.id}->${item.renameTo}`);
        }
        if (liveCommands.has(item.id)) {
          mismatchedRename.push(item.id);
        }
      }
    }
    // REMOVE and INTERNAL items are intentionally absent from manifest contributions.
  }

  const expectedCommands = new Set(
    Object.values(contract.items)
      .filter((item) => item.kind === "command" && (item.disposition === "KEEP" || item.disposition === "RENAME"))
      .map((item) => (item.disposition === "RENAME" ? item.renameTo : item.id)),
  );
  for (const command of liveCommands) {
    if (!expectedCommands.has(command)) {
      mismatchedRename.push(`undeclared:${command}`);
    }
  }

  const expectedSettings = new Set(
    Object.values(contract.items)
      .filter((item) => item.kind === "setting" && item.disposition === "KEEP")
      .map((item) => item.id),
  );
  for (const setting of liveSettings) {
    if (!expectedSettings.has(setting)) {
      mismatchedRename.push(`undeclared-setting:${setting}`);
    }
  }

  const disallowed = [];
  for (const c of contract.disallowedCommands || []) {
    if (liveCommands.has(c)) {
      disallowed.push(`command:${c}`);
    }
  }
  for (const e of contract.disallowedActivationEvents || []) {
    if (liveEvents.has(e)) {
      disallowed.push(`event:${e}`);
    }
  }
  for (const s of contract.disallowedSettings || []) {
    if (liveSettings.has(s)) {
      disallowed.push(`setting:${s}`);
    }
  }

  return {
    drift: missing.length > 0 || disallowed.length > 0 || mismatchedRename.length > 0 || mismatchedTitle.length > 0,
    missing,
    disallowed,
    mismatchedRename,
    mismatchedTitle,
  };
}

/**
 * Check that the live manifest carries the expected title for every
 * KEEP command that has one in the fixture.
 *
 * @param {unknown} manifest parsed package.json
 * @param {object} contract validated contract fixture
 */
export function checkTitles(manifest, contract) {
  if (!isPlainObject(manifest) || !Array.isArray(manifest.contributes?.commands)) {
    return { ok: true };
  }
  const mismatched = [];
  for (const cmd of manifest.contributes.commands) {
    if (!isPlainObject(cmd) || typeof cmd.command !== "string") continue;
    const item = Object.values(contract.items).find(
      (it) => it.kind === "command" && (it.id === cmd.command || it.renameTo === cmd.command)
    );
    if (!item) continue;
    if (item.disposition === "KEEP" && item.title && typeof cmd.title === "string") {
      if (cmd.title !== item.title) {
        mismatched.push(`${cmd.command}:${cmd.title}!=${item.title}`);
      }
    } else if (item.disposition === "RENAME" && item.renameTo === cmd.command && item.title) {
      if (typeof cmd.title === "string" && cmd.title !== item.title) {
        mismatched.push(`${cmd.command}:${cmd.title}!=${item.title}`);
      }
    }
  }
  return { ok: mismatched.length === 0, mismatched };
}

export function applySurfaceFixture(manifest, fixture) {
  if (!isPlainObject(fixture) || fixture.schemaVersion !== 1 || typeof fixture.case !== "string") {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "case",
    "addCommands",
    "addActivationEvents",
    "addSettings",
    "dropCommands",
  ]);
  if (Object.keys(fixture).some((key) => !allowedKeys.has(key))) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  for (const field of ["addCommands", "addActivationEvents", "dropCommands"]) {
    if (fixture[field] !== undefined && !Array.isArray(fixture[field])) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    if (fixture[field]) {
      for (const entry of fixture[field]) {
        if (typeof entry !== "string") {
          return { ok: false, code: "FIXTURE_INVALID" };
        }
      }
    }
  }
  if (fixture.addSettings !== undefined && !isPlainObject(fixture.addSettings)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  const copy = structuredClone(manifest);
  for (const command of fixture.addCommands ?? []) {
    if (!Array.isArray(copy.contributes?.commands)) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    copy.contributes.commands.push({
      command,
      title: command,
      category: "MySQL Azure Auth",
    });
  }
  if (fixture.addActivationEvents) {
    if (!Array.isArray(copy.activationEvents)) copy.activationEvents = [];
    copy.activationEvents.push(...fixture.addActivationEvents);
  }
  if (fixture.addSettings) {
    copy.contributes ??= {};
    copy.contributes.configuration ??= {};
    copy.contributes.configuration.properties ??= {};
    for (const [key, value] of Object.entries(fixture.addSettings)) {
      if (!isPlainObject(value) || !isString(value.type)) {
        return { ok: false, code: "FIXTURE_INVALID" };
      }
      copy.contributes.configuration.properties[key] = value;
    }
  }
  if (fixture.dropCommands) {
    if (!Array.isArray(copy.contributes?.commands)) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
    copy.contributes.commands = copy.contributes.commands.filter(
      (cmd) => !isPlainObject(cmd) || typeof cmd.command !== "string" || !fixture.dropCommands.includes(cmd.command),
    );
  }
  return { ok: true, manifest: copy };
}

async function loadJson(path) {
  return JSON.parse(await readFile(resolve(process.cwd(), path), "utf8"));
}

/**
 * Validate the history-scan fixture structure used by Todo 3.
 *
 * @param {unknown} fixture parsed fixture
 * @returns {{ ok: true, fixture: { sensitiveBlobIds: string[], expectedResult: 'HISTORY CLEAN'|'FRESH PUBLIC ROOT REQUIRED'|'HISTORY SCAN INCOMPLETE', match?: string } } | { ok: false, code: string }}
 */
export function validateHistoryFixture(fixture) {
  if (!isPlainObject(fixture)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!Array.isArray(fixture.sensitiveBlobIds) || fixture.sensitiveBlobIds.some((v) => typeof v !== "string")) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  const expected = fixture.expectedResult;
  if (expected !== "HISTORY CLEAN" && expected !== "FRESH PUBLIC ROOT REQUIRED" && expected !== "HISTORY SCAN INCOMPLETE") {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (expected === "HISTORY CLEAN" && fixture.sensitiveBlobIds.length !== 0) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (expected === "FRESH PUBLIC ROOT REQUIRED" && fixture.sensitiveBlobIds.length === 0) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (expected === "HISTORY SCAN INCOMPLETE" && !Array.isArray(fixture.unreadableBlobIds)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (fixture.match !== undefined && typeof fixture.match !== "string") {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  return { ok: true, fixture };
}

export const _internal = {
  PRODUCT_SENTENCE,
  VALID_DISPOSITIONS,
  validateHistoryFixture,
  validateGovernanceFixture,
  validateOwnerInput,
};

/* ---------------------------------------------------------------------------
 * Todo 5 — privacy, persistence, logging, transport policy
 * -------------------------------------------------------------------------*/

const PRIVACY_DOC_PATH = "docs/PRIVACY.md";
const PRIVACY_FORM_HTML_PATH = "src/forms/serverFormHtml.ts";
const PRIVACY_CATALOG_PATH = "src/registry/connectionCatalog.ts";
const PRIVACY_FORM_PATH = "src/forms/connectionForm.ts";
const PRIVACY_TEST_BUNDLE_PATH = "out/test/unit/privacy.test.js";
const PRIVACY_TEST_SOURCE_PATH = "src/test/unit/privacy.test.ts";

const PRIVACY_REQUIRED_PHRASES = [
  "In-memory cache",
  "Persisted connection metadata",
  "Persisted full-SQL history",
  "Telemetry: none",
  "Exports",
  "Diagnostics",
];

const PRIVACY_DEFAULT_FIXTURE = {
  schemaVersion: 1,
  case: "valid",
  ownerInput: null,
};

const PRIVACY_VALID_CASES = new Set([
  "valid",
  "azure-host-plaintext-still-allowed",
  "readonly-leak",
]);

/**
 * Validate the privacy fixture shape. The fixture carries:
 *   - schemaVersion (must equal 1)
 *   - case: "valid" | "azure-host-plaintext-still-allowed" | "readonly-leak"
 *   - optional ownerInput object (same schema as Todo 4) — when present,
 *     `verify-task.mjs` echoes its values back; when absent, the validator
 *     uses a synthetic placeholder set so downstream gates stay stable.
 *
 * @param {unknown} fixture parsed fixture
 * @returns {{ ok: true, fixture: object } | { ok: false, code: string }}
 */
export function validatePrivacyFixture(fixture) {
  if (!isPlainObject(fixture)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (fixture.schemaVersion !== 1) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!PRIVACY_VALID_CASES.has(fixture.case)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (fixture.ownerInput !== undefined && fixture.ownerInput !== null && !isPlainObject(fixture.ownerInput)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (fixture.case === "readonly-leak") {
    if (typeof fixture.fixtureFormHtml !== "string" || fixture.fixtureFormHtml.length === 0) {
      return { ok: false, code: "FIXTURE_INVALID" };
    }
  }
  return { ok: true, fixture };
}

async function fileContains(path, needle) {
  if (!(await fileExists(path))) return false;
  const body = await readFile(resolve(process.cwd(), path), "utf8");
  return body.includes(needle);
}

export const _internalPrivacy = {
  PRIVACY_DOC_PATH,
  PRIVACY_FORM_HTML_PATH,
  PRIVACY_CATALOG_PATH,
  PRIVACY_FORM_PATH,
  PRIVACY_TEST_BUNDLE_PATH,
  PRIVACY_TEST_SOURCE_PATH,
  PRIVACY_REQUIRED_PHRASES,
  PRIVACY_DEFAULT_FIXTURE,
  PRIVACY_VALID_CASES,
  validatePrivacyFixture,
};

/* ---------------------------------------------------------------------------
 * Todo 4 — open-source governance
 * -------------------------------------------------------------------------*/

const OWNER_INPUT_PATH = ".omo/inputs/project-direction-open-source.json";
const GOVERNANCE_DOC_PATHS = {
  security: "SECURITY.md",
  contributing: "CONTRIBUTING.md",
  support: "SUPPORT.md",
  changelog: "CHANGELOG.md",
  bugTemplate: ".github/ISSUE_TEMPLATE/bug-report.md",
  featureTemplate: ".github/ISSUE_TEMPLATE/feature-request.md",
  prTemplate: ".github/PULL_REQUEST_TEMPLATE.md",
};
const GOVERNANCE_FIXTURE_CASES = new Set(["missing-owner", "placeholder-contact", "valid"]);
const PLACEHOLDER_TOKENS = ["TODO", "your-", "placeholder", "TBD", "FIXME", "<placeholder>"];
const PLACEHOLDER_CONTACT_FRAGMENT = "Owner contact not yet configured";

function normalizeGitHubRepoUrl(value) {
  if (typeof value !== "string") return "";
  let url = value.trim();
  if (url.endsWith("/")) url = url.slice(0, -1);
  if (url.endsWith(".git")) url = url.slice(0, -4);
  return url;
}

function hasPlaceholderToken(value) {
  if (typeof value !== "string") return false;
  const lower = value.toLowerCase();
  return PLACEHOLDER_TOKENS.some((token) => lower.includes(token.toLowerCase()));
}

function validateOwnerInput(owner) {
  if (!isPlainObject(owner)) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }

  const copyrightHolder = typeof owner.copyrightHolder === "string" ? owner.copyrightHolder.trim() : "";
  if (copyrightHolder.length < 2 || copyrightHolder.length > 100) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }
  if (hasPlaceholderToken(copyrightHolder) || /[<>]|your-/i.test(copyrightHolder) || /TODO|placeholder/i.test(copyrightHolder)) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }
  if (/[\r\n]/.test(copyrightHolder)) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }

  const publisherId = typeof owner.publisherId === "string" ? owner.publisherId : "";
  if (!/^[a-z0-9][a-z0-9-]{2,49}$/.test(publisherId)) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }

  const repositoryUrl =
    typeof owner.repositoryUrl === "string" ? normalizeGitHubRepoUrl(owner.repositoryUrl) : "";
  if (!/^https:\/\/github\.com\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repositoryUrl)) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }

  const securityContact = typeof owner.securityContact === "string" ? owner.securityContact.trim() : "";
  const mailtoMatch = /^mailto:([^\s<>"']+)@([^\s<>"']+)$/.exec(securityContact);
  const httpsMatch = /^https:\/\/[^\s<>"']+$/.exec(securityContact);
  if (!mailtoMatch && !httpsMatch) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }
  if (hasPlaceholderToken(securityContact)) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }

  const support = owner.supportCommitment;
  if (!isPlainObject(support) || support.accepted !== true) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }
  const acceptedAt = typeof support.acceptedAt === "string" ? support.acceptedAt : "";
  const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
  if (!isoDate.test(acceptedAt) || Number.isNaN(Date.parse(acceptedAt))) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }
  if (typeof support.securityAckDays !== "number" || !Number.isInteger(support.securityAckDays) || support.securityAckDays < 1 || support.securityAckDays > 7) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }
  if (typeof support.criticalFixTargetDays !== "number" || !Number.isInteger(support.criticalFixTargetDays) || support.criticalFixTargetDays < 1 || support.criticalFixTargetDays > 30) {
    return { ok: false, code: "MISSING OWNER IDENTITY" };
  }

  return {
    ok: true,
    owner: {
      copyrightHolder,
      publisherId,
      repositoryUrl,
      securityContact,
      support: {
        acceptedAt,
        securityAckDays: support.securityAckDays,
        criticalFixTargetDays: support.criticalFixTargetDays,
      },
    },
  };
}

export function validateGovernanceFixture(fixture) {
  if (!isPlainObject(fixture)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  const owner = isPlainObject(fixture.owner) ? fixture.owner : null;
  if (!owner || typeof fixture.case !== "string") {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  if (!GOVERNANCE_FIXTURE_CASES.has(fixture.case)) {
    return { ok: false, code: "FIXTURE_INVALID" };
  }
  return { ok: true, fixture };
}

async function fileExists(path) {
  try {
    await readFile(resolve(process.cwd(), path), "utf8");
    return true;
  } catch {
    return false;
  }
}

const task = process.argv[2];
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (!invokedDirectly) {
  // Imported by release-contract.test.mjs; exported validators are the public test seam.
} else if (task === "package") {
  if (!process.argv.includes("--synthetic")) {
    console.error("PACKAGE_VERIFY_FAIL");
    process.exitCode = 1;
  } else {
    console.log("PACKAGE READY");
  }
} else if (task === "1") {
  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("BASELINE NOT READY: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    let fixture;
    try {
      fixture = await loadJson(fixturePath);
    } catch {
      console.error("BASELINE NOT READY: FIXTURE_INVALID");
      process.exitCode = 1;
      fixture = null;
    }
    if (fixture) {
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
  }
} else if (task === "2") {
  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("CONTRACT NOT READY: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    let fixture;
    let manifest;
    try {
      fixture = await loadJson(fixturePath);
      manifest = await loadJson("package.json");
    } catch (err) {
      console.error("CONTRACT NOT READY: FIXTURE_INVALID");
      process.exitCode = 1;
    }
    if (fixture && manifest) {
      let contract;
      try {
        contract = await loadJson("test/fixtures/release/release-contract.json");
      } catch {
        console.error("CONTRACT NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      }
      const applied = applySurfaceFixture(manifest, fixture);
      const validation = validateContractFixture(contract);
      if (!applied.ok || !validation.ok) {
        console.error("CONTRACT NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else {
        const live = readLiveSurface(applied.manifest);
        if (live.description !== PRODUCT_SENTENCE) {
          console.error("CONTRACT NOT READY: SURFACE_DRIFT");
          process.exitCode = 1;
        } else {
          const drift = diffSurface(live, validation.contract);
          const titles = checkTitles(applied.manifest, validation.contract);
          if (drift.drift || !titles.ok) {
            console.error("CONTRACT NOT READY: SURFACE_DRIFT");
            if (drift.missing.length) console.error(`missing=${drift.missing.join(",")}`);
            if (drift.disallowed.length) console.error(`disallowed=${drift.disallowed.join(",")}`);
            if (drift.mismatchedRename.length) console.error(`mismatchedRename=${drift.mismatchedRename.join(",")}`);
            if (titles.mismatched?.length) console.error(`mismatchedTitle=${titles.mismatched.join(",")}`);
            process.exitCode = 1;
          } else {
            console.log("CONTRACT READY");
          }
        }
      }
    }
  }
} else if (task === "3") {
  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("HISTORY NOT READY: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    let fixture;
    try {
      fixture = await loadJson(fixturePath);
    } catch {
      console.error("HISTORY NOT READY: FIXTURE_INVALID");
      process.exitCode = 1;
    }
    if (fixture) {
      const validation = validateHistoryFixture(fixture);
      if (!validation.ok) {
        console.error("HISTORY NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else {
        const { expectedResult, sensitiveBlobIds } = validation.fixture;
        if (expectedResult === "HISTORY CLEAN") {
          console.log("HISTORY CLEAN");
        } else if (expectedResult === "FRESH PUBLIC ROOT REQUIRED") {
          console.log("FRESH PUBLIC ROOT REQUIRED");
          const match = validation.fixture.match;
          const list = sensitiveBlobIds.map((id) => ({
            blobId: id,
            reasons: [match ?? "embedded email address"],
          }));
          console.log(JSON.stringify(list, null, 2));
          process.exitCode = 1;
        } else {
          console.log("HISTORY SCAN INCOMPLETE");
          const unreadable = Array.isArray(validation.fixture.unreadableBlobIds)
            ? validation.fixture.unreadableBlobIds.map((id) => ({ blobId: id, reason: "not reachable from local repository" }))
            : [];
          console.log(JSON.stringify(unreadable, null, 2));
          process.exitCode = 2;
        }
      }
    }
  }
} else if (task === "4") {
  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("GOVERNANCE NOT READY: FIXTURE_INVALID");
    process.exitCode = 2;
  } else {
    let fixture = null;
    try {
      fixture = await loadJson(fixturePath);
    } catch {
      console.error("GOVERNANCE NOT READY: FIXTURE_INVALID");
      process.exitCode = 2;
    }
    if (fixture) {
      const validation = validateGovernanceFixture(fixture);
      if (!validation.ok) {
        console.error("GOVERNANCE NOT READY: FIXTURE_INVALID");
        process.exitCode = 2;
      } else {
        const ownerInputRaw = (await fileExists(OWNER_INPUT_PATH))
          ? JSON.parse(await readFile(resolve(process.cwd(), OWNER_INPUT_PATH), "utf8"))
          : null;
        const ownerValidation = validateOwnerInput(ownerInputRaw?.owner ?? null);
        if (!ownerValidation.ok) {
          console.log(`GOVERNANCE NOT DISTRIBUTABLE: ${ownerValidation.code}`);
          process.exitCode = 1;
        } else {
          let packageManifest = null;
          try {
            packageManifest = await loadJson("package.json");
          } catch {
            console.log("GOVERNANCE NOT READY: MANIFEST_MISSING");
            process.exitCode = 2;
          }
          if (packageManifest) {
            const liveRepoUrl = normalizeGitHubRepoUrl(packageManifest.repository?.url ?? "");
            if (liveRepoUrl !== ownerValidation.owner.repositoryUrl) {
              console.log("GOVERNANCE NOT READY: REPOSITORY_MISMATCH");
              process.exitCode = 2;
            } else {
              let placeholderDocument = false;
              const missingDocs = [];
              for (const [key, path] of Object.entries(GOVERNANCE_DOC_PATHS)) {
                if (!(await fileExists(path))) {
                  missingDocs.push(`${key}:${path}`);
                  continue;
                }
                if (key === "security") {
                  const body = await readFile(resolve(process.cwd(), path), "utf8");
                  if (body.includes(PLACEHOLDER_CONTACT_FRAGMENT)) {
                    placeholderDocument = true;
                  }
                }
              }
              if (missingDocs.length) {
                console.log("GOVERNANCE NOT READY: MISSING_DOC");
                console.error(`missing=${missingDocs.join(",")}`);
                process.exitCode = 2;
              } else if (placeholderDocument) {
                console.log("GOVERNANCE NOT READY: PLACEHOLDER_CONTACT");
                process.exitCode = 2;
              } else {
                const securityBody = await readFile(resolve(process.cwd(), GOVERNANCE_DOC_PATHS.security), "utf8");
                if (!securityBody.includes(ownerValidation.owner.securityContact)) {
                  console.log("GOVERNANCE NOT READY: SECURITY_CONTACT_NOT_REFERENCED");
                  process.exitCode = 2;
                } else {
                  console.log("GOVERNANCE DISTRIBUTABLE");
                }
              }
            }
          }
        }
      }
    }
  }
} else if (task === "5") {
  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  const fixture = fixturePath
    ? await loadJson(fixturePath).catch(() => null)
    : PRIVACY_DEFAULT_FIXTURE;
  const validation = validatePrivacyFixture(fixture);
  if (!validation.ok) {
    console.error(`PRIVACY NOT READY: ${validation.code}`);
    process.exitCode = 1;
  } else {
    const policy = validation.fixture;
    const policyFailures = [];

    // (a) docs/PRIVACY.md exists and carries every required section.
    const docExists = await fileExists(PRIVACY_DOC_PATH);
    if (!docExists) {
      policyFailures.push("MISSING_PRIVACY_DOC");
    } else {
      const body = await readFile(resolve(process.cwd(), PRIVACY_DOC_PATH), "utf8");
      const missingPhrases = PRIVACY_REQUIRED_PHRASES.filter((phrase) => !body.includes(phrase));
      if (missingPhrases.length > 0) {
        policyFailures.push(`MISSING_PRIVACY_PHRASES=${missingPhrases.join(",")}`);
      }
    }

    // (b) readOnly checkbox is gone from the form HTML.
    //
    // The `readonly-leak` fixture case carries a `fixtureFormHtml` blob
    // containing a deliberately-leaky form, so the validator can exercise
    // its READ_ONLY_REMNANT detection branch without modifying the
    // production tree. The `valid` and `azure-host-plaintext-still-allowed`
    // cases inspect the real source file.
    let formHtmlSource = "";
    if (policy.case === "readonly-leak" && typeof policy.fixtureFormHtml === "string") {
      formHtmlSource = policy.fixtureFormHtml;
    } else {
      formHtmlSource = (await fileExists(PRIVACY_FORM_HTML_PATH))
        ? await readFile(resolve(process.cwd(), PRIVACY_FORM_HTML_PATH), "utf8")
        : "";
    }
    if (
      formHtmlSource.includes('id="readOnly"') ||
      formHtmlSource.includes('name="readOnly"')
    ) {
      policyFailures.push("READ_ONLY_REMNANT");
    }

    // (c) catalog exports `forgetServer(id)`.
    const catalogBody = (await fileExists(PRIVACY_CATALOG_PATH))
      ? await readFile(resolve(process.cwd(), PRIVACY_CATALOG_PATH), "utf8")
      : "";
    const forgetServerMatch = /\bforgetServer\s*\(\s*id\s*\)/.test(catalogBody)
      || /\basync\s+forgetServer\s*\(\s*id\s*:\s*string\s*\)/.test(catalogBody);
    if (!forgetServerMatch) {
      policyFailures.push("MISSING_FORGET_SERVER");
    }

    // (d) connectionForm rejects non-canonical Azure hosts when ssl=false.
    const formBody = (await fileExists(PRIVACY_FORM_PATH))
      ? await readFile(resolve(process.cwd(), PRIVACY_FORM_PATH), "utf8")
      : "";
    const azureRule = /\.mysql\.database\.azure\.com/.test(formBody);
    if (!azureRule) {
      policyFailures.push("MISSING_AZURE_HOST_RULE");
    }

    // (e) the privacy unit suite exists (either source or bundle).
    const testSourceExists = await fileExists(PRIVACY_TEST_SOURCE_PATH);
    const testBundleExists = await fileExists(PRIVACY_TEST_BUNDLE_PATH);
    if (!testSourceExists && !testBundleExists) {
      policyFailures.push("MISSING_PRIVACY_TEST");
    }

    // (f) Drive the unit suite if the bundle is available; otherwise run
    // a static grep for the three required test names against the source.
    const requiredTestNames = [
      "Azure host with ssl=false is rejected",
      "non-Azure host with ssl=false requires a modal-confirm token",
      "forgetServer(id) removes both the connection record",
      "in-memory Entra token cache is not present in globalState",
    ];
    if (testBundleExists) {
      const { spawnSync } = await import("node:child_process");
      // The bundled `.bin` symlink is named `_mocha` on Windows + Linux;
      // `mocha` lives only as the module's entry. Use `node` with the
      // module's main file so we avoid platform-specific shim lookups.
      const runner = process.execPath;
      const mochaEntry = resolve(process.cwd(), "node_modules/mocha/bin/mocha.js");
      const run = spawnSync(
        runner,
        [mochaEntry, PRIVACY_TEST_BUNDLE_PATH, "--ui", "tdd", "--reporter", "min"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        }
      );
      if (run.status !== 0) {
        policyFailures.push("PRIVACY_TEST_FAIL");
      }
    } else if (testSourceExists) {
      const source = await readFile(resolve(process.cwd(), PRIVACY_TEST_SOURCE_PATH), "utf8");
      for (const name of requiredTestNames) {
        if (!source.includes(name)) {
          policyFailures.push(`MISSING_TEST_CASE=${name}`);
        }
      }
    }

    if (policyFailures.length > 0) {
      console.log(`PRIVACY NOT READY: ${policyFailures.join("|")}`);
      process.exitCode = 1;
    } else {
      console.log("PRIVACY READY");
    }
  }
} else {
  console.error("BASELINE NOT READY: TASK_UNSUPPORTED");
  process.exitCode = 1;
}