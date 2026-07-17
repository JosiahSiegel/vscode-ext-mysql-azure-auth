# Changelog

All notable changes to the `mysql-azure-auth` VS Code extension are
documented here. The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/) with a
Preview suffix for pre-stable releases.

> **Preview status.** `0.1.1-Preview` is the current Preview line; `0.1.0-Preview`
> remains supported. The surface, behaviour, and supported targets documented
> here may still change in subsequent Preview revisions.

## 0.1.1-Preview

The second Preview line. Workflow + distribution automation only — no
extension-code, schema, or behaviour changes. The Marketplace listing
moves from `0.1.0` to `0.1.1`.

### Added

- The GitHub Actions workflow that publishes to GitHub Releases now
  also publishes to the VS Code Marketplace under the `JosiahSiegel`
  publisher namespace. The Marketplace Personal Access Token is read
  from the `VSCE_PAT` repository secret and passed to
  `npx @vscode/vsce publish --pat …`. The workflow fails fast with a
  clear `::error::` annotation if the secret is unset, so a missing
  PAT never silently produces a GitHub-only release. No manual
  `vsce publish` step is required after pushing a tag.
- The release workflow now regenerates `resources/icons/icon.png`
  from `resources/icons/server-key.svg` before packaging, so the
  shipped VSIX always carries the freshest icon at 128×128. The SVG
  is the source of truth; the regeneration step is idempotent and
  exits 0 when the PNG already matches. The icon itself was
  reworked for `0.1.1`: the database stack now uses MySQL brand
  dolphin blue (`#00758F`) and the skeleton key uses MySQL brand
  warm orange (`#F29111`), replacing the previous monochrome
  rendering.
- A new "Marketplace version" step reads `package.json#version` and
  exposes it as a step output, so the maintainer can sanity-check
  the tag-vs-Marketplace-version alignment in the Actions job log
  before the publish step runs.

### Changed

- `.github/workflows/release.yml` was renamed to
  `.github/workflows/release-dry-run.yml`. The file's `name:` field
  was updated from `Release Preview` to `Release Dry-Run` so the
  Actions UI matches the filename. Internal cross-references and the
  workflow header were updated to point at
  `release-dry-run.yml` instead of the old name. **No behaviour
  change** — the workflow still only runs on
  `workflow_dispatch`, still exercises Todo 14 + Todo 15 + the
  supported-platforms renderer, and never publishes anything.
- `.github/workflows/release-github.yml` now displays as
  `Release: GitHub + Marketplace` in the Actions UI, with a job
  name of `Build, publish to Marketplace, attach to GitHub Release`.
  The header comment was rewritten to enumerate the five things the
  workflow does on every tag push (icon regen → package →
  Marketplace publish → SHA-256 + artifact upload → GitHub Release).
- `README.md`, `BUILD.md`, `SECURITY.md`, and `SUPPORT.md` were
  updated to reflect the new distribution shape. README's
  Distribution section now treats the Marketplace as a first-class
  channel alongside GitHub Releases. The "Cut a new release"
  recipe is now a single `git tag && git push` — no follow-up
  command. SECURITY.md and SUPPORT.md added `0.1.1-Preview` to the
  supported-versions tables alongside the still-supported
  `0.1.0-Preview` line.
- The CHANGELOG's "Honest disclosures" section was rewritten to
  reflect the new state: the `verify:t19` Marketplace gate still
  defers (live + pilot attestations remain pending), the Marketplace
  listing is live, and the gate is an audit trail of external
  attestations rather than a release blocker.

### Fixed

- The release VSIX could previously ship a stale `icon.png` if the
  SVG was edited without running `npm run icons:regen` locally.
  The workflow now regenerates the icon as part of the release
  pipeline, so the shipped artifact matches the committed SVG by
  construction.
- `.vscodeignore` now explicitly excludes `.env` and `.env.*`.
  `.gitignore` already kept these out of git history, but `vsce
  package` was failing the release build with `.env files should not
  be packaged`. The local `.env` file that triggered this finding has
  been removed from the working tree; a binary scan of the produced
  `mysql-azure-auth-0.1.1.vsix` confirms neither the `.env` filename
  nor the prior PAT value appears in the archive. Maintainers who
  store PATs in `.env` for one-shot `vsce publish` invocations
  should rotate the affected token at minimum, and consider
  switching to `npx @vscode/vsce publish --pat "${VSCE_PAT}"` with
  the token passed inline rather than written to disk.

### Removed

- Nothing. No code, schema, command, or dependency changes.

### Known observations

- `vsce package` reports `out/main.js is large (1.49 MB)`. The
  bundle is below the Marketplace ceiling (50 MB) but is dominated
  by `mysql2` and `@azure/identity`. Tracked for future split into
  an optional `mysql2-lite` dependency; not blocking `0.1.1`.

### Honest disclosures

- `verify:t19` continues to emit `DEFER MARKETPLACE PUBLICATION`
  because the upstream live Azure test (Todo 17) and pilot
  attestations (Todo 18) have not yet been supplied under
  `.omo/inputs/`. The Marketplace publish in this workflow is
  unconditional; the gate remains an audit trail. Pilot evidence
  MUST NEVER be fabricated — `scripts/verify-task.mjs` enforces
  this structurally.
- `FRESH PUBLIC ROOT REQUIRED` is still the machine result produced
  by the Todo 3 history scan. This Preview line does not retire
  that honest disclosure.

## 0.1.0-Preview

The first Preview line. It does not yet satisfy
`GOVERNANCE DISTRIBUTABLE`: the
`.omo/inputs/project-direction-open-source.json` owner identity contract is
absent, so the Maintainer's governed routes resolve to placeholder text and
are not yet ready for public distribution.

### Added

- Pinned Node.js runtime and npm package manager (commit `3b1cc50`): the
  repository declares `.node-version` and `packageManager` so a fresh
  install lands on the exact maintainer-tested versions. Baseline gate
  scripts (`scripts/check-runtime.mjs`, the synthetic `package:verify`
  path) were added so claim-conformance and runtime pinning can be checked
  without producing a distributable VSIX.
- Specialist product contract, public-surface disposition table, and
  accompanying `release-contract.json` + `release-contract.test.mjs`
  fixtures (commit `d8765f5`): every command, activation event, view, and
  setting is classified as KEEP, RENAME, REMOVE, or INTERNAL, and the
  locked product sentence is mirrored at the top of `README.md`.
- Minimum open-source governance files: `SECURITY.md`, `CONTRIBUTING.md`,
  `SUPPORT.md`, `CHANGELOG.md`, plus GitHub issue and PR templates
  (commit `T4`, this release). A new `verify:t4` gate validates the owner
  identity contract, the privacy/security/support copy, and the
  CHANGELOG/templating deterministically.
- Issue templates under `.github/ISSUE_TEMPLATE/` and a pull request
  checklist at `.github/PULL_REQUEST_TEMPLATE.md` for bug reports and
  feature requests (commit `T4`, this release).
- Lightweight DCO (Developer Certificate of Origin) policy in
  `CONTRIBUTING.md` (commit `T4`, this release).

### Changed

- `package.json` declares the locked product sentence and the maintainer
  gates (`check:runtime`, `package:verify`, `verify:t[1-4]`) so a fresh
  clone is forced through the maintainer's quality bars before a release
  candidate is prepared (commit `3b1cc50`).
- `README.md` was aligned to the specialist product contract during the
  public-surface freeze (commit `d8765f5`): stale marketing copy was
  removed and the locked product sentence now appears at the top.
- The history-scan wiring now treats unreadable blob IDs as
  `HISTORY SCAN INCOMPLETE` rather than claiming success on partial data
  (commit `5aa73f6`).

### Fixed

- A hard-coded personal email that had been embedded in the tracked
  `scripts/quick.js` and across every historical commit since the initial
  import was scrubbed and parameterized (commit `5aa73f6`). The history
  scan now reports a `FRESH PUBLIC ROOT REQUIRED` condition because the
  same blob IDs are still reachable from `git reflog`.
- Local-only release contaminants (root-level VSIX, build logs,
  browser/playwright artifacts, source maps) were removed from the
  working tree and `.gitignore` was tightened to keep them out (commit
  `5aa73f6`).

### Removed

- No commands, settings, activation events, or code paths were removed in
  commit `3b1cc50`. Public-surface REMOVE dispositions are reserved for
  the manifests/cleanup tasks later in the plan (Todos 6–8).
- No rows were removed from git history during the contamination removal
  pass (commit `5aa73f6`). History rewriting is intentionally deferred to
  the owner-executed fresh-root procedure in Todo 3 of the open-source
  plan — see `.omo/plans/project-direction-open-source.md` for the exact
  steps.

### Honest disclosures

- ~~`GOVERNANCE NOT DISTRIBUTABLE: MISSING OWNER IDENTITY` is the machine
  result produced by `npm run verify:t4` in this Preview until the owner
  populates `.omo/inputs/project-direction-open-source.json`. Until that
  lands, `SECURITY.md` deliberately points readers back at
  `.omo/inputs/project-direction-open-source.json#owner.securityContact`
  rather than carrying a fabricated private route.~~
  **Superseded on 2026-07-16**: `.omo/inputs/project-direction-open-source.json`
  is now populated (`copyrightHolder`, `publisherId`, `securityContact`,
  `supportCommitment`, and the cross-bound `marketplaceControl` block).
  `verify:t4` against `governance-valid.json` is expected to print
  `GOVERNANCE READY`.
- `FRESH PUBLIC ROOT REQUIRED` is still the machine result produced by
  the Todo 3 history scan because removed personal-email content remains
  reachable through `git reflog`. This Preview cannot be marked
  `PUBLIC SOURCE READY` until the owner cuts a fresh root off commit
  `5aa73f6` and re-runs `node scripts/scan-history.mjs` against it.

### Distribution

- The VS Code Marketplace listing for `JosiahSiegel.mysql-azure-auth`
  went live at version `0.1.0` (publisher namespace `JosiahSiegel`,
  same as the GitHub Releases publisher). The Marketplace publish is
  now driven by `.github/workflows/release-github.yml` on every tag
  push: the workflow builds the VSIX, reads `secrets.VSCE_PAT`, runs
  `npx @vscode/vsce publish --pat …` against the produced VSIX, and
  then attaches the same artifact to a GitHub Release. The PAT must
  be issued against the `JosiahSiegel` publisher namespace on the
  Marketplace publisher management page; the workflow fails fast if
  the secret is unset. The publisher PAT verification artifact
  (`.omo/inputs/marketplace-control.json` +
  `.omo/inputs/marketplace-verification.txt`) remains dated
  `2026-07-16T20:47:10Z` and is unaffected by this automation.

  The `verify:t19` gate aggregates three upstream checks — Todo 16
  (public-source readiness), Todo 17 (live Azure test), and Todo 18
  (pilot attestations) — and continues to emit
  `DEFER MARKETPLACE PUBLICATION` because the live and pilot
  attestations have not yet been supplied under `.omo/inputs/`. The
  workflow publishes to the Marketplace regardless of gate state; the
  gate is an audit trail of external attestations, and those
  attestations must come from real Azure runs and real pilot users.
  Pilot evidence MUST NEVER be fabricated — `scripts/verify-task.mjs`
  enforces this structurally.
