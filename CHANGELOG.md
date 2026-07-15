# Changelog

All notable changes to the `mysql-azure-auth` VS Code extension are
documented here. The format is loosely [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/) with a
Preview suffix for pre-stable releases.

> **Preview status.** `0.1.0-Preview` is the lone supported version line. The
> surface, behaviour, and supported targets documented here may still change
> in subsequent Preview revisions.

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

- `GOVERNANCE NOT DISTRIBUTABLE: MISSING OWNER IDENTITY` is the machine
  result produced by `npm run verify:t4` in this Preview until the owner
  populates `.omo/inputs/project-direction-open-source.json`. Until that
  lands, `SECURITY.md` deliberately points readers back at
  `.omo/inputs/project-direction-open-source.json#owner.securityContact`
  rather than carrying a fabricated private route.
- `FRESH PUBLIC ROOT REQUIRED` is still the machine result produced by
  the Todo 3 history scan because removed personal-email content remains
  reachable through `git reflog`. This Preview cannot be marked
  `PUBLIC SOURCE READY` until the owner cuts a fresh root off commit
  `5aa73f6` and re-runs `node scripts/scan-history.mjs` against it.
