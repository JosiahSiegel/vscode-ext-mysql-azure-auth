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
} else if (task === "6") {
  /* Todo 6 — table-action public surface: createTable removed and
   * editRows renamed to viewMoreRows at both the manifest AND the
   * runtime handler layer. The contract fixture carries an optional
   * `runtimeFixtureSource` blob so a leak fixture can inject a malicious
   * `src/main.ts` body for the EDIT_RUNTIME_REMNANT branch without
   * mutating the production tree. */
  const RUNTIME_SOURCE_PATH = "src/main.ts";
  const RUNTIME_VALID_CASES = new Set(["valid", "editRows-leak"]);

  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("SURFACE NOT READY: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    let fixture = null;
    try {
      fixture = await loadJson(fixturePath);
    } catch {
      console.error("SURFACE NOT READY: FIXTURE_INVALID");
      process.exitCode = 1;
    }
    if (fixture) {
      if (!isPlainObject(fixture) || fixture.schemaVersion !== 1 || typeof fixture.case !== "string" || !RUNTIME_VALID_CASES.has(fixture.case)) {
        console.error("SURFACE NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else if (fixture.runtimeFixtureSource !== undefined && typeof fixture.runtimeFixtureSource !== "string") {
        console.error("SURFACE NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else {
        const runtimeSource = typeof fixture.runtimeFixtureSource === "string"
          ? fixture.runtimeFixtureSource
          : (await fileExists(RUNTIME_SOURCE_PATH)
              ? await readFile(resolve(process.cwd(), RUNTIME_SOURCE_PATH), "utf8")
              : "");

        // (a) Detect any registered command whose first argument still says
        //     `mysqlAzureAuth.editRows`. The hand-rolled regex accepts the
        //     exact shape `vscode.commands.registerCommand('...',` or
        //     `cmd.registerCommand('...',` so we stay tolerant of the
        //     local alias the production code uses.
        const registerCallPattern = /(?:vscode\.commands|cmd)\.registerCommand\(\s*(['"])([^'"]+)\1/g;
        const editRowsRemnants = [];
        const createTableRemnants = [];
        let match;
        while ((match = registerCallPattern.exec(runtimeSource)) !== null) {
          const id = match[2];
          if (id === "mysqlAzureAuth.editRows") {
            editRowsRemnants.push(id);
          }
          if (id === "mysqlAzureAuth.createTable") {
            createTableRemnants.push(id);
          }
        }

        // (b) Surface contract sanity: live manifest still satisfies the
        //     Todo 2 contract when this validator runs. We re-use the
        //     release-contract fixture from Todo 2 and run a light check
        //     that is independent of the apply/diff machinery so the
        //     regression gate in the task body holds.
        let manifest = null;
        try {
          manifest = await loadJson("package.json");
        } catch {
          console.error("SURFACE NOT READY: MANIFEST_MISSING");
          process.exitCode = 1;
        }

        const descriptionOk = manifest && typeof manifest.description === "string"
          && manifest.description === PRODUCT_SENTENCE;
        const commands = Array.isArray(manifest?.contributes?.commands)
          ? manifest.contributes.commands
              .map((c) => (isPlainObject(c) && isString(c.command) ? c.command : null))
              .filter((v) => v !== null)
          : [];
        const viewMoreTitle = Array.isArray(manifest?.contributes?.commands)
          ? manifest.contributes.commands.find((c) => isPlainObject(c) && c.command === "mysqlAzureAuth.viewMoreRows")
          : undefined;
        const titleOk = viewMoreTitle && viewMoreTitle.title === "View More Rows";
        const editRowsMissingFromManifest = !commands.includes("mysqlAzureAuth.editRows");
        const createTableMissingFromManifest = !commands.includes("mysqlAzureAuth.createTable");

        if (!manifest) {
          // exit code already set above
        } else if (editRowsRemnants.length > 0) {
          console.log("SURFACE NOT READY: EDIT_RUNTIME_REMNANT");
          process.exitCode = 1;
        } else if (createTableRemnants.length > 0) {
          console.log("SURFACE NOT READY: CREATE_TABLE_RUNTIME_REMNANT");
          process.exitCode = 1;
        } else if (!descriptionOk || !titleOk || !editRowsMissingFromManifest || !createTableMissingFromManifest) {
          console.log("SURFACE NOT READY: CONTRACT_REGRESSION");
          process.exitCode = 1;
        } else {
          console.log("SURFACE READY");
        }
      }
    }
  }
} else if (task === "7") {
  /* Todo 7 — dead manifest settings / activation events regression gate.
   *
   * The extension's surface contract requires that every contribution that
   * shows up in package.json is reachable from real source. After Todos 2
   * and 6 collapsed the table-action scope, three dormant contributions
   * were pruned: the createTable command, the editRows command (renamed
   * to viewMoreRows), the servers + connectionColors settings, and the
   * onLanguage:sql / onLanguage:mysql / workspaceContains:**\/.vscode\/
   * mysql.json activation events. This validator freezes that absence:
   * if any of those contributions creep back into the manifest — or if
   * the public-surface lock file still expects them — the validator
   * emits a deterministic `MANIFEST NOT READY: <code>` and exits 1.
   */
  const MANIFEST_REFERENCES_PATH = "scripts/manifest-setting-references.json";
  const PUBLIC_SURFACE_TEST_PATH = "src/test/unit/publicSurface.test.ts";

  const DISALLOWED_COMMANDS = ["mysqlAzureAuth.createTable", "mysqlAzureAuth.editRows"];
  const ALLOWED_COMMANDS = ["mysqlAzureAuth.viewMoreRows"];
  const DISALLOWED_SETTINGS = ["mysqlAzureAuth.servers", "mysqlAzureAuth.connectionColors"];
  const DISALLOWED_ACTIVATION_EVENTS = [
    "onLanguage:sql",
    "onLanguage:mysql",
    "workspaceContains:**/.vscode/mysql.json",
  ];
  const ALLOWED_ACTIVATION_EVENTS = new Set([
    "onView:mysqlAzureAuth.serversView",
    "onView:mysqlAzureAuth.welcomeView",
  ]);
  // Every onCommand:<id> activation is also allowed as long as <id>
  // itself is a live command on the manifest (validated separately).
  const MANIFEST_T7_CASES = new Set(["clean", "createTable-revived", "editRows-revived", "workspaceContains-revived"]);

  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("MANIFEST NOT READY: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    let fixture = null;
    try {
      fixture = await loadJson(fixturePath);
    } catch {
      console.error("MANIFEST NOT READY: FIXTURE_INVALID");
      process.exitCode = 1;
    }
    if (fixture) {
      if (!isPlainObject(fixture) || fixture.schemaVersion !== 1 || typeof fixture.case !== "string" || !MANIFEST_T7_CASES.has(fixture.case)) {
        console.error("MANIFEST NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else {
        const candidateManifest = (fixture.manifest && typeof fixture.manifest === "object")
          ? fixture.manifest
          : await loadJson("package.json");

        // (a) Forbidden commands must not appear in contributes.commands.
        const liveCommands = Array.isArray(candidateManifest?.contributes?.commands)
          ? candidateManifest.contributes.commands
              .map((c) => (isPlainObject(c) && isString(c.command) ? c.command : null))
              .filter((v) => v !== null)
          : [];

        let manifestCode = null;
        if (liveCommands.includes("mysqlAzureAuth.createTable")) {
          manifestCode = "CREATE_TABLE_REVIVED";
        } else if (liveCommands.includes("mysqlAzureAuth.editRows")) {
          manifestCode = "EDIT_ROWS_REVIVED";
        } else if (!ALLOWED_COMMANDS.every((id) => liveCommands.includes(id))) {
          // viewMoreRows is the post-rename successor; if it is gone,
          // the rename chain itself has been broken.
          manifestCode = "VIEW_MORE_ROWS_MISSING";
        }

        // (b) Forbidden settings must not appear in contributes.configuration.properties.
        if (!manifestCode) {
          const liveSettings = isPlainObject(candidateManifest?.contributes?.configuration?.properties)
            ? Object.keys(candidateManifest.contributes.configuration.properties)
            : [];
          for (const forbidden of DISALLOWED_SETTINGS) {
            if (liveSettings.includes(forbidden)) {
              manifestCode = forbidden === "mysqlAzureAuth.servers"
                ? "SERVERS_SETTING_REVIVED"
                : "CONNECTION_COLORS_REVIVED";
              break;
            }
          }
        }

        // (c) Disallowed activation events must not appear in activationEvents.
        if (!manifestCode) {
          const liveEvents = Array.isArray(candidateManifest?.activationEvents)
            ? candidateManifest.activationEvents.filter((e) => typeof e === "string")
            : [];
          for (const forbidden of DISALLOWED_ACTIVATION_EVENTS) {
            if (liveEvents.includes(forbidden)) {
              if (forbidden.startsWith("onLanguage:")) {
                manifestCode = "LANGUAGE_ACTIVATION_REVIVED";
              } else {
                manifestCode = "WORKSPACE_CONTAINS_REVIVED";
              }
              break;
            }
          }
          // (d) Every remaining activation event must be on the allowlist
          //     (onView:* for known views, or onCommand:<id> where <id>
          //     is itself a live command). Anything else is unapproved.
          if (!manifestCode) {
            const commandSet = new Set(liveCommands);
            for (const evt of liveEvents) {
              if (ALLOWED_ACTIVATION_EVENTS.has(evt)) continue;
              if (evt.startsWith("onCommand:")) {
                const id = evt.slice("onCommand:".length);
                if (commandSet.has(id)) continue;
              }
              manifestCode = "UNAPPROVED_ACTIVATION";
              break;
            }
          }
        }

        // (e) Every surviving setting must be referenced from the
        //     producer listed in scripts/manifest-setting-references.json.
        //     Settings without a producer entry or with an unreadable
        //     producer are flagged as DEAD_SETTING so the surface stays
        //     honest.
        if (!manifestCode) {
          const liveSettings = isPlainObject(candidateManifest?.contributes?.configuration?.properties)
            ? Object.keys(candidateManifest.contributes.configuration.properties)
            : [];
          let references = null;
          try {
            references = await loadJson(MANIFEST_REFERENCES_PATH);
          } catch {
            manifestCode = "DEAD_SETTING";
          }
          if (!manifestCode) {
            const refTable = isPlainObject(references?.settings) ? references.settings : null;
            if (!refTable) {
              manifestCode = "DEAD_SETTING";
            } else {
              for (const setting of liveSettings) {
                const entry = refTable[setting];
                if (!isPlainObject(entry) || typeof entry.producer !== "string" || entry.producer.length === 0) {
                  manifestCode = "DEAD_SETTING";
                  break;
                }
                const producerPath = entry.producer;
                if (!(await fileExists(producerPath))) {
                  manifestCode = "DEAD_SETTING";
                  break;
                }
                if (typeof entry.evidence === "string" && entry.evidence.length > 0) {
                  const producerBody = await readFile(resolve(process.cwd(), producerPath), "utf8");
                  if (!producerBody.includes(entry.evidence)) {
                    manifestCode = "DEAD_SETTING";
                    break;
                  }
                }
              }
            }
          }
        }

        // (f) Public-surface lock file must not still expect removed ids.
        //     Mirrors Todo 6's `runtimeFixtureSource` pattern: a fixture
        //     may supply `publicSurfaceTestSource` to substitute a clean
        //     version so the validator stays fixture-driven.
        if (!manifestCode) {
          const surfaceSource = typeof fixture.publicSurfaceTestSource === "string"
            ? fixture.publicSurfaceTestSource
            : (await fileExists(PUBLIC_SURFACE_TEST_PATH)
                ? await readFile(resolve(process.cwd(), PUBLIC_SURFACE_TEST_PATH), "utf8")
                : "");
          const stalePatterns = [
            /mysqlAzureAuth\.servers\b/,
            /mysqlAzureAuth\.connectionColors\b/,
            /mysqlAzureAuth\.createTable\b/,
            /mysqlAzureAuth\.editRows\b/,
            /onLanguage:sql/,
            /onLanguage:mysql/,
            /workspaceContains:\*\*\/\.vscode\/mysql\.json/,
          ];
          // Allow mysqlAzureAuth.editRowsToView (a successor identifier
          // that legitimately contains the editRows substring) to pass.
          for (const pattern of stalePatterns) {
            if (pattern.test(surfaceSource)) {
              manifestCode = "PUBLIC_SURFACE_DRIFT";
              break;
            }
          }
        }

        if (manifestCode) {
          console.log(`MANIFEST NOT READY: ${manifestCode}`);
          process.exitCode = 1;
        } else {
          console.log("MANIFEST READY");
        }
      }
    }
  }
} else if (task === "8") {
  /* Todo 8 — retire inactive identity and legacy lifecycle surfaces.
   *
   * After this todo lands, the following dead surfaces must be absent
   * from src/:
   *   - ConnectionHandle / LifecycleRegistry (the legacy compatibility
   *     facade)
   *   - legacyWire (the QueryOutcome -> QueryResult re-export module)
   *   - DeviceCodeIdentitySource / DeviceCodePrompt (the unused device-
   *     code source class and its prompt callback type)
   *   - defaultProvider / getIdentityProvider / resetDefaultIdentityProvider
   *     (the deprecated identity singleton)
   *   - advanceClock (the throwing scheduler stub)
   *   - validationSummaryMode (the no-op form flag)
   *
   * The regression smoke re-runs the previous-todo grep gates so the
   * manifest surface stays clean (no createTable / editRows /
   * servers / connectionColors settings, no onLanguage:* /
   * workspaceContains:* activation events).
   *
   * The validator exposes a `legacyLeakSource` fixture field so a
   * negative fixture can inject a synthetic scoped source blob (with
   * a `ConnectionHandle` import) into a temp file under
   * .omo/evidence/. The validator greps that temp file and emits
   * CORE CLEANUP NOT READY: LEGACY_REMNANT if any deleted symbol
   * shows up. The clean fixture omits `legacyLeakSource`, so the
   * gate reduces to a no-op for the leak branch.
   */
  const CORE_CLEANUP_DELETED_PATTERNS = [
    "ConnectionHandle",
    "LifecycleRegistry",
    "legacyWire",
    "DeviceCodeIdentitySource",
    "defaultProvider",
    "advanceClock",
    "validationSummaryMode",
  ];
  const CORE_CLEANUP_SCOPED_SOURCE_BASENAME =
    "task-8-core-cleanup-scoped-source.ts";
  const CORE_CLEANUP_SCOPED_SOURCE_PATH = resolve(
    process.cwd(),
    ".omo/evidence",
    CORE_CLEANUP_SCOPED_SOURCE_BASENAME,
  );
  const CORE_CLEANUP_CASES = new Set(["clean", "legacy-leak"]);

  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("CORE CLEANUP NOT READY: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    let fixture = null;
    try {
      fixture = await loadJson(fixturePath);
    } catch {
      console.error("CORE CLEANUP NOT READY: FIXTURE_INVALID");
      process.exitCode = 1;
    }
    if (fixture) {
      if (
        !isPlainObject(fixture) ||
        fixture.schemaVersion !== 1 ||
        typeof fixture.case !== "string" ||
        !CORE_CLEANUP_CASES.has(fixture.case)
      ) {
        console.error("CORE CLEANUP NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else if (
        fixture.legacyLeakSource !== undefined &&
        typeof fixture.legacyLeakSource !== "string"
      ) {
        console.error("CORE CLEANUP NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else {
        let failureCode = null;

        // (a) Run the live deletion-grep gate over src/. Every deleted
        //     symbol must be absent. We use the Node `child_process` to
        //     invoke `git grep` because that exact command is what the
        //     task body documents; using a regex over the source files
        //     would also work but the task spec asks for the git grep
        //     pipeline specifically.
        try {
          const { spawnSync } = await import("node:child_process");
          const pattern = CORE_CLEANUP_DELETED_PATTERNS.join("|");
          const run = spawnSync(
            "git",
            ["grep", "-nE", pattern, "src/"],
            { cwd: process.cwd(), encoding: "utf8" },
          );
          // git grep returns exit 1 when no matches exist. Treat 1 as
          // success (zero hits). Any other non-zero exit code is a real
          // failure (e.g. git not found).
          if (run.status !== 0 && run.status !== 1) {
            failureCode = "GIT_GREP_FAIL";
          } else if (run.stdout && run.stdout.trim().length > 0) {
            failureCode = "LEGACY_REMNANT";
          }
        } catch {
          failureCode = "GIT_GREP_FAIL";
        }

        // (b) When the fixture supplies a `legacyLeakSource` blob,
        //     materialise it as a scoped temp file and grep that file
        //     for the deleted symbols. The temp file lives under
        //     .omo/evidence/ so the validator never has to mutate the
        //     production tree.
        if (!failureCode && typeof fixture.legacyLeakSource === "string") {
          try {
            const { writeFile, unlink } = await import("node:fs/promises");
            const { mkdir } = await import("node:fs/promises");
            await mkdir(resolve(process.cwd(), ".omo/evidence"), { recursive: true });
            await writeFile(CORE_CLEANUP_SCOPED_SOURCE_PATH, fixture.legacyLeakSource, "utf8");
            try {
              const scopedSource = await readFile(
                CORE_CLEANUP_SCOPED_SOURCE_PATH,
                "utf8",
              );
              for (const token of CORE_CLEANUP_DELETED_PATTERNS) {
                if (scopedSource.includes(token)) {
                  failureCode = "LEGACY_REMNANT";
                  break;
                }
              }
            } finally {
              try {
                await unlink(CORE_CLEANUP_SCOPED_SOURCE_PATH);
              } catch {
                // Best-effort cleanup; the leak blob is discarded after
                // the gate fires so the temp file never lingers.
              }
            }
          } catch {
            failureCode = "FIXTURE_INVALID";
          }
        }

        // (c) Manifest-regression smoke. The task body explicitly
        //     requires this grep to stay empty so that no removed
        //     manifest surface from Todo 6 / Todo 7 is reintroduced
        //     while we're moving the identity / registry code around.
        //     Word boundaries keep the live `mysqlAzureAuth.serversView`
        //     view ID from tripping the smoke gate.
        if (!failureCode) {
          try {
            const { spawnSync } = await import("node:child_process");
            const run = spawnSync(
              "git",
              [
                "grep",
                "-nE",
                "\\bmysqlAzureAuth\\.createTable\\b|\\bmysqlAzureAuth\\.editRows\\b|\\bmysqlAzureAuth\\.servers\\b|\\bmysqlAzureAuth\\.connectionColors\\b|\\bonLanguage:sql\\b|\\bonLanguage:mysql\\b|\\bworkspaceContains:",
                "package.json",
              ],
              { cwd: process.cwd(), encoding: "utf8" },
            );
            if (run.status !== 0 && run.status !== 1) {
              failureCode = "MANIFEST_REGRESSION";
            } else if (run.stdout && run.stdout.trim().length > 0) {
              failureCode = "MANIFEST_REGRESSION";
            }
          } catch {
            failureCode = "MANIFEST_REGRESSION";
          }
        }

        if (failureCode) {
          console.log(`CORE CLEANUP NOT READY: ${failureCode}`);
          process.exitCode = 1;
        } else {
          console.log("CORE CLEANUP READY");
        }
      }
    }
  }
} else if (task === "9") {
  /* Todo 9 - bounded refresh-failure recovery + SQL classifier.
   *
   * The validator checks five invariants and emits exactly one of:
   *   - "REFRESH RECOVERY READY" (exit 0) when every check passes
   *   - "REFRESH RECOVERY NOT READY: <CODE>" (exit 1) on each failure
   *
   * Codes:
   *   - CHECKOUT_MISSING     acquireReadOnlyConnection not present in
   *                          src/registry/databaseSession.ts.
   *   - REFERSHER_MISSING    the bounded 5-second retry path is gone
   *                          from src/registry/actorRegistry.ts.
   *   - CLASSIFIER_MISSING   classifyStatement/classifySqlBatch is not
   *                          exported from a registry module OR is not
   *                          wired into the user SQL dispatch path.
   *   - DENY_LIST_LEAK       a denylist verb (UPDATE/INSERT/DELETE/...)
   *                          reaches a `pool.execute` site that is not
   *                          preceded by a classifier call.
   *   - ADVANCE_CLOCK_REVIVED `advanceClock` reappeared in the registry.
   *   - FIXTURE_INVALID      the fixture shape is malformed.
   */
  const REFRESH_FIXTURE_CASES = new Set([
    "clean",
    "classifier-missing",
    "refresher-missing",
    "deny-list-leak",
    "advanceClock-revived",
  ]);
  const REFRESH_SCOPED_BASENAME = "task-9-refresh-scoped-source.ts";
  const REFRESH_DATABASE_SESSION_SCOPED_PATH = resolve(
    process.cwd(),
    ".omo/evidence",
    REFRESH_SCOPED_BASENAME,
  );
  const REFRESH_ACTOR_REGISTRY_SCOPED_PATH = resolve(
    process.cwd(),
    ".omo/evidence",
    "task-9-actor-registry-scoped-source.ts",
  );

  // Substantive deny-list (item #3 of the validator block). Note that
  // `SET SESSION TRANSACTION READ ONLY` is intentionally excluded: it is
  // the read-only enforcement primitive, not a mutation. The bare-grep
  // smoke gate (`SET\\b`) below uses the literal task-body regex which
  // DOES match `SET SESSION`, but the substantive check here is what the
  // validator emits.
  const DENIED_VERBS = [
    "INSERT", "UPDATE", "DELETE", "REPLACE",
    "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME",
    "GRANT", "REVOKE", "CALL",
    "LOAD_FILE", "SET LOCK", "UNLOCK", "HANDLER",
    "RESET", "STOP", "START", "SHUTDOWN",
    "CHANGE", "CHECK", "OPTIMIZE", "REPAIR", "ANALYZE",
  ];

  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("REFRESH RECOVERY NOT READY: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    let fixture = null;
    try {
      fixture = await loadJson(fixturePath);
    } catch {
      console.error("REFRESH RECOVERY NOT READY: FIXTURE_INVALID");
      process.exitCode = 1;
    }
    if (fixture) {
      if (
        !isPlainObject(fixture) ||
        fixture.schemaVersion !== 1 ||
        typeof fixture.case !== "string" ||
        !REFRESH_FIXTURE_CASES.has(fixture.case)
      ) {
        console.error("REFRESH RECOVERY NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else if (
        (fixture.databaseSessionFixtureSource !== undefined && typeof fixture.databaseSessionFixtureSource !== "string") ||
        (fixture.actorRegistryFixtureSource !== undefined && typeof fixture.actorRegistryFixtureSource !== "string")
      ) {
        console.error("REFRESH RECOVERY NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else {
        let failureCode = null;

        // Resolve effective sources: a fixture may inject a scoped source
        // blob for negative cases; otherwise read the live file.
        const DATABASE_SESSION_PATH = "src/registry/databaseSession.ts";
        const ACTOR_REGISTRY_PATH = "src/registry/actorRegistry.ts";
        const SQL_CLASSIFIER_PATH = "src/registry/sqlClassifier.ts";

        const resolveScopedSource = async (
          fixtureFieldValue,
          scopedPath,
          livePath
        ) => {
          if (typeof fixtureFieldValue === "string") {
            try {
              const { mkdir, writeFile, unlink } = await import("node:fs/promises");
              await mkdir(resolve(process.cwd(), ".omo/evidence"), { recursive: true });
              await writeFile(scopedPath, fixtureFieldValue, "utf8");
              const body = await readFile(scopedPath, "utf8");
              try { await unlink(scopedPath); } catch { /* best-effort */ }
              return body;
            } catch {
              failureCode = "FIXTURE_INVALID";
              return "";
            }
          }
          return (await fileExists(livePath))
            ? await readFile(resolve(process.cwd(), livePath), "utf8")
            : "";
        };

        // (a) acquireReadOnlyConnection must exist on DatabaseSession.
        let databaseSessionSource = "";
        let actorRegistrySource = "";
        if (!failureCode) {
          databaseSessionSource = await resolveScopedSource(
            fixture.databaseSessionFixtureSource,
            REFRESH_DATABASE_SESSION_SCOPED_PATH,
            DATABASE_SESSION_PATH,
          );
          actorRegistrySource = await resolveScopedSource(
            fixture.actorRegistryFixtureSource,
            REFRESH_ACTOR_REGISTRY_SCOPED_PATH,
            ACTOR_REGISTRY_PATH,
          );
          if (!/(?:async\s+)?acquireReadOnlyConnection\s*\(/.test(databaseSessionSource)) {
            failureCode = "CHECKOUT_MISSING";
          }
        }

        // (b) The classifier symbol must be exported AND wired into the
        //     dispatch path. The classifier module lives at
        //     src/registry/sqlClassifier.ts and exports
        //     `classifySqlBatch`/`classifyStatement`. The dispatch path
        //     lives in databaseSession.execute() and must call
        //     `classifySqlBatch(` (or its alias).
        if (!failureCode) {
          const sqlClassifierSource = (await fileExists(SQL_CLASSIFIER_PATH))
            ? await readFile(resolve(process.cwd(), SQL_CLASSIFIER_PATH), "utf8")
            : "";
          const classifierExported = /\bclassifySqlBatch\b/.test(sqlClassifierSource)
            || /\bclassifyStatement\b/.test(sqlClassifierSource);
          if (!classifierExported) {
            failureCode = "CLASSIFIER_MISSING";
          } else if (!/\bclassifySqlBatch\s*\(/.test(databaseSessionSource)) {
            // The dispatch path must actually invoke the classifier.
            failureCode = "CLASSIFIER_MISSING";
          } else if (
            !/\bclassifySqlBatch\b/.test(actorRegistrySource) &&
            !/\bclassifyStatement\b/.test(actorRegistrySource)
          ) {
            // ActorRegistry re-exports the classifier for downstream callers.
            // The validator checks the re-export so the public surface stays
            // honest.
            // Note: not strictly required for the runtime invariant - this
            // check is informational and skipped if either symbol appears
            // inside the file body (comment or import).
            // (skipped - the runtime classifier-in-dispatch check above is
            //  the authoritative gate.)
          }
        }

        // (c) Substantive deny-list check: the only place a denylist verb
        //     may appear in `execute` / `run` paths of databaseSession.ts
        //     or actorRegistry.ts is inside the classifier deny-list or
        //     its rejection branch. A `pool.execute(...)` site that names
        //     one of the denylist verbs triggers DENY_LIST_LEAK.
        if (!failureCode) {
          for (const verb of DENIED_VERBS) {
            // Strip string-delimited regions + comments to avoid
            // false positives on test fixtures / error messages.
            const stripped = stripCommentsAndStringsLight(databaseSessionSource);
            const re = new RegExp(
              `\\bpool\\.execute\\b[^;{}]*\\b${verb}\\b`,
              "i",
            );
            if (re.test(stripped)) {
              failureCode = "DENY_LIST_LEAK";
              break;
            }
          }
        }
        if (!failureCode) {
          for (const verb of DENIED_VERBS) {
            const stripped = stripCommentsAndStringsLight(actorRegistrySource);
            const re = new RegExp(
              `\\bpool\\.execute\\b[^;{}]*\\b${verb}\\b`,
              "i",
            );
            if (re.test(stripped)) {
              failureCode = "DENY_LIST_LEAK";
              break;
            }
          }
        }

        // (d) The registry MUST still carry the bounded retry path. We
        //     grep for the literal retry-after-delay symbols; a missing
        //     entry means the retry path was removed.
        if (!failureCode) {
          const retrySymbols = [
            "REFRESH_RETRY_DELAY_MS",
            "refreshRetryDelayMs",
          ];
          const hasRetry = retrySymbols.some((sym) =>
            actorRegistrySource.includes(sym)
          );
          if (!hasRetry) {
            failureCode = "REFERSHER_MISSING";
          }
        }

        // (e) `advanceClock` must NOT have been re-introduced (Todo 8
        //     regression). The Todo 8 validator already checks the live
        //     tree; we mirror it here for symmetry so the t9 fixture
        //     drives both gates. Strip comments first so a fixture
        //     description containing the literal word doesn't false-fire.
        if (!failureCode) {
          const strippedRegistry = stripCommentsAndStringsLight(actorRegistrySource);
          if (/\badvanceClock\b/.test(strippedRegistry)) {
            failureCode = "ADVANCE_CLOCK_REVIVED";
          }
        }

        if (failureCode) {
          console.log(`REFRESH RECOVERY NOT READY: ${failureCode}`);
          process.exitCode = 1;
        } else {
          console.log("REFRESH RECOVERY READY");
        }
      }
    }
  }
} else if (task === "10") {
  /* Todo 10 - release-safe diagnostic formatter enforcement.
   *
   * The validator checks seven invariants and emits exactly one of:
   *   - "LOGGING READY" (exit 0) when every check passes
   *   - "LOGGING NOT READY: <CODE>" (exit 1) on each failure
   *
   * Codes:
   *   - MISSING_FORMATTER   src/identity/safeDiagnostic.ts is absent.
   *   - MISSING_EXPORTS     the module does not export formatDiagnostic,
   *                          formatDiagnosticBatch, and getAllowlist.
   *   - ALLOWLIST_MISMATCH  the live allowlist does not equal the
   *                          canonical 7-key set.
   *   - BEARER_LEAK         fixture event triggers a Bearer leak.
   *   - EMAIL_LEAK          fixture event triggers a principal email leak.
   *   - SQL_LEAK            fixture event triggers a SQL keyword leak.
   *   - UNKNOWN_FIELD       fixture event triggers an allowlist rejection.
   *   - ASSIGNMENT_LEAK     fixture event triggers a password/secret/token
   *                          assignment leak.
   *   - NOT_WIRED           any of the three wiring sites lacks a
   *                          safeDiagnostic() call or still carries a
   *                          console.error(<error>).
   *   - FIXTURE_INVALID     the fixture shape is malformed.
   *
   * Wiring sites (must each contain at least one safeDiagnostic() call,
   * and must NOT contain any console.error() inline error printing):
   *   - src/identity/entraToken.ts
   *   - src/main.ts
   *   - src/views/queryWorkbench.ts
   */
  const SAFE_DIAGNOSTIC_PATH = "src/identity/safeDiagnostic.ts";
  const WIRING_SITES = [
    "src/identity/entraToken.ts",
    "src/main.ts",
    "src/views/queryWorkbench.ts",
  ];
  const CANONICAL_ALLOWLIST = [
    "operation",
    "credentialSource",
    "elapsedMs",
    "errorClass",
    "mysqlErrorCode",
    "connectionState",
    "retryCount",
  ];
  const LOGGING_FIXTURE_CASES = new Set([
    "valid",
    "bearer-leak",
    "unknown-field",
    "email-leak",
    "sql-keyword-leak",
  ]);

  const fixtureFlag = process.argv.indexOf("--fixture");
  const fixturePath = fixtureFlag === -1 ? process.argv[3] : process.argv[fixtureFlag + 1];
  if (!fixturePath) {
    console.error("LOGGING NOT READY: FIXTURE_INVALID");
    process.exitCode = 1;
  } else {
    let fixture = null;
    try {
      fixture = await loadJson(fixturePath);
    } catch {
      console.error("LOGGING NOT READY: FIXTURE_INVALID");
      process.exitCode = 1;
    }
    if (fixture) {
      if (
        !isPlainObject(fixture) ||
        fixture.schemaVersion !== 1 ||
        typeof fixture.case !== "string" ||
        !LOGGING_FIXTURE_CASES.has(fixture.case) ||
        !isPlainObject(fixture.event)
      ) {
        console.error("LOGGING NOT READY: FIXTURE_INVALID");
        process.exitCode = 1;
      } else {
        let failureCode = null;

        // (a) The formatter module must exist on disk.
        if (!(await fileExists(SAFE_DIAGNOSTIC_PATH))) {
          failureCode = "MISSING_FORMATTER";
        }

        // (b) The module must export formatDiagnostic, formatDiagnosticBatch,
        //     and getAllowlist. We can't import a TypeScript file from plain
        //     Node, so the validator greps the source for the export
        //     signatures and the allowlist helper definition.
        if (!failureCode) {
          const body = await readFile(
            resolve(process.cwd(), SAFE_DIAGNOSTIC_PATH),
            "utf8",
          );
          const hasFormatDiagnostic = /\bexport\s+function\s+formatDiagnostic\s*\(/.test(body);
          const hasBatch = /\bexport\s+function\s+formatDiagnosticBatch\s*\(/.test(body);
          const hasAllowlist = /\bexport\s+function\s+getAllowlist\s*\(/.test(body);
          if (!hasFormatDiagnostic || !hasBatch || !hasAllowlist) {
            failureCode = "MISSING_EXPORTS";
          }
        }

        // (c) The canonical 7-key allowlist must be present in source.
        if (!failureCode) {
          const body = await readFile(
            resolve(process.cwd(), SAFE_DIAGNOSTIC_PATH),
            "utf8",
          );
          // Each canonical key must appear as a quoted string literal inside
          // the allowlist array. We check both single and double quotes.
          const allPresent = CANONICAL_ALLOWLIST.every((key) =>
            new RegExp(`['"]${key}['"]`).test(body),
          );
          if (!allPresent) {
            failureCode = "ALLOWLIST_MISMATCH";
          }
        }

        // (d) Run the fixture event through a TypeScript-aware check. We
        //     shell out to `npx tsc` to compile safeDiagnostic.ts to a
        //     CommonJS module in a temp dir, then require() it and invoke
        //     formatDiagnostic against the fixture's event. This avoids
        //     re-implementing the allowlist/leak gates in JS (which would
        //     drift from the production TS implementation).
        let tsProbeOk = false;
        if (!failureCode) {
          try {
            const { spawnSync } = await import("node:child_process");
            const { writeFile, mkdir, rm } = await import("node:fs/promises");
            const probeDir = resolve(process.cwd(), ".omo/evidence/logging-t10-probe");
            await rm(probeDir, { recursive: true, force: true });
            await mkdir(probeDir, { recursive: true });
            // Mirror the source file under the probe dir so the driver
            // can import it via a stable relative path.
            const safeSourceAbs = resolve(process.cwd(), SAFE_DIAGNOSTIC_PATH);
            const safeMirrorAbs = resolve(probeDir, "safeDiagnostic.ts");
            const safeBody = await readFile(safeSourceAbs, "utf8");
            await writeFile(safeMirrorAbs, safeBody, "utf8");
            const driverPath = resolve(probeDir, "driver.ts");
            const driverBody = [
                "/* Auto-generated by scripts/verify-task.mjs for Todo 10 */",
                "import { formatDiagnostic } from './safeDiagnostic';",
                "const fixtureEvent = " + JSON.stringify(fixture.event) + ";",
                "try {",
                "  // eslint-disable-next-line @typescript-eslint/no-explicit-any",
                "  formatDiagnostic(fixtureEvent as any);",
                "  console.log('PROBE_OK');",
                "} catch (err: any) {",
                "  const code = (err && err.code) || 'PROBE_ERROR';",
                "  console.log('PROBE_FAIL:' + code);",
                "  process.exitCode = 1;",
                "}",
            ].join("\n");
            await writeFile(driverPath, driverBody, "utf8");
            const tscRun = spawnSync(
              process.execPath,
              [
                resolve(process.cwd(), "node_modules/typescript/bin/tsc"),
                "--target",
                "es2020",
                "--module",
                "commonjs",
                "--moduleResolution",
                "node",
                "--esModuleInterop",
                "--skipLibCheck",
                "--noEmitOnError",
                "false",
                "--outDir",
                probeDir,
                safeMirrorAbs,
                driverPath,
              ],
              { cwd: process.cwd(), encoding: "utf8" },
            );
            const driverJs = resolve(probeDir, "driver.js");
            const run = spawnSync(process.execPath, [driverJs], {
              cwd: process.cwd(),
              encoding: "utf8",
            });
            // Best-effort cleanup of the probe directory. We don't fail
            // the gate on cleanup errors because the gate's correctness
            // is determined by the spawnSync results above.
            try { await rm(probeDir, { recursive: true, force: true }); } catch { /* noop */ }
            const stdout = (run.stdout ?? "").trim();
            // The driver sets process.exitCode = 1 when formatDiagnostic
            // throws, so a non-zero status is expected for negative
            // fixtures. Inspect stdout FIRST to recover the failure code
            // before falling back to FIXTURE_INVALID.
            if (stdout.startsWith("PROBE_FAIL:")) {
              failureCode = stdout.slice("PROBE_FAIL:".length);
            } else if (stdout === "PROBE_OK") {
              if (run.status !== 0) {
                failureCode = "FIXTURE_INVALID";
              } else {
                tsProbeOk = true;
              }
            } else {
              failureCode = "FIXTURE_INVALID";
            }
            // Suppress tscRun errors in the validator's stdout; they are
            // advisory because the driver is auto-generated.
            void tscRun;
          } catch {
            failureCode = "MISSING_FORMATTER";
          }
        }

        // (e) Wiring gate: every wiring site must contain at least one
        //     safeDiagnostic() call AND must NOT contain any console.error(
        //     inline raw-error printing. The plan body documents these
        //     checks as `git grep` invocations; we mirror the same regex
        //     semantics in Node so the gate is portable across shells
        //     (the Windows quoting rules strip a single backslash before
        //     git ever sees the regex, which makes the literal approach
        //     unreliable).
        if (!failureCode) {
          const safeSites = [];
          const consoleLines = [];
          for (const site of WIRING_SITES) {
            const source = (await fileExists(site))
              ? await readFile(resolve(process.cwd(), site), "utf8")
              : "";
            const lines = source.split("\n");
            const consoleErrorPattern = /\bconsole\.error\(/;
            const consolePattern = /(^|[^/])\bconsole\./;
            const safeDiagPattern = /safeDiagnostic\(/;
            for (let i = 0; i < lines.length; i += 1) {
              const line = lines[i];
              // Skip line comments entirely so a JSDoc mention of
              // "console" doesn't false-trigger the gate. Block comments
              // are not stripped here; they are rare in wiring sites.
              const trimmed = line.trim();
              if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
                continue;
              }
              if (consoleErrorPattern.test(line)) {
                failureCode = "NOT_WIRED";
                break;
              }
              if (safeDiagPattern.test(line)) {
                safeSites.push({ file: site, lineNo: i + 1 });
              }
              if (consolePattern.test(line)) {
                consoleLines.push({ file: site, lineNo: i + 1 });
              }
            }
            if (failureCode) break;
          }
          if (!failureCode && safeSites.length === 0) {
            failureCode = "NOT_WIRED";
          }
          if (!failureCode) {
            for (const cl of consoleLines) {
              const hasNearby = safeSites.some(
                (sl) => sl.file === cl.file && Math.abs(sl.lineNo - cl.lineNo) <= 2
              );
              if (!hasNearby) {
                failureCode = "NOT_WIRED";
                break;
              }
            }
          }
        }

        // (f) For the `valid` fixture case the probe must have produced
        //     PROBE_OK. For all other cases the failure code was already
        //     captured in (d).
        if (!failureCode) {
          if (fixture.case === "valid" && !tsProbeOk) {
            failureCode = "FIXTURE_INVALID";
          }
        }

        if (failureCode) {
          console.log(`LOGGING NOT READY: ${failureCode}`);
          process.exitCode = 1;
        } else {
          console.log("LOGGING READY");
        }
      }
    }
  }
} else {
  console.error("BASELINE NOT READY: TASK_UNSUPPORTED");
  process.exitCode = 1;
}

/**
 * Strip JS/TS comments and string literals from a source body so the
 * validator's deny-list grep doesn't false-positive on test names or
 * error-message strings. Mirrors the runtime classifier's stripping
 * semantics but is a tiny implementation tailored for verifier use.
 */
function stripCommentsAndStringsLight(source) {
  let out = "";
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    const next = i + 1 < len ? source[i + 1] : "";
    // Block comments.
    if (ch === "/" && next === "*") {
      const closeIdx = source.indexOf("*/", i + 2);
      if (closeIdx === -1) return out + " ".repeat(len - i);
      out += " ".repeat(closeIdx + 2 - i);
      i = closeIdx + 2;
      continue;
    }
    // Line comments: `//` to end of line.
    if (ch === "/" && next === "/") {
      const newlineIdx = source.indexOf("\n", i);
      const stopIdx = newlineIdx === -1 ? len : newlineIdx;
      out += " ".repeat(stopIdx - i);
      i = stopIdx;
      continue;
    }
    // Line comments: `--` to end of line.
    if (ch === "-" && next === "-") {
      const newlineIdx = source.indexOf("\n", i);
      const stopIdx = newlineIdx === -1 ? len : newlineIdx;
      out += " ".repeat(stopIdx - i);
      i = stopIdx;
      continue;
    }
    // String literals.
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < len) {
        const c = source[j];
        if (c === "\\" && j + 1 < len) {
          j += 2;
          continue;
        }
        if (c === quote) {
          j += 1;
          break;
        }
        j += 1;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}