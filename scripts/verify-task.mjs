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

export const _internal = {
  PRODUCT_SENTENCE,
  VALID_DISPOSITIONS,
};

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
} else {
  console.error("BASELINE NOT READY: TASK_UNSUPPORTED");
  process.exitCode = 1;
}