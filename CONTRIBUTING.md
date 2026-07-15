# Contributing

Thank you for your interest in this community preview of the Azure Database
for MySQL Flexible Server + Microsoft Entra authentication VS Code extension.

The maintainer's locked product sentence is intentionally narrow:

> "A community-maintained VS Code preview for browsing and querying Azure
> Database for MySQL Flexible Server with Microsoft Entra authentication."

It is mirrored at the top of `README.md`. Out-of-scope contributions
(generic SQL tooling, additional database engines, row/schema editors,
telemetry, sponsorship) will be declined even if technically sound.

## Local validation

A clean install and the maintainer's verification scripts should pass before
you open a pull request.

```bash
npm ci                   # reproducible install against the lockfile
npm test                 # lint + typecheck + unit + integration
npm run package:verify   # synthetic package allowlist/denylist gate
```

`npm test` runs the lint, typecheck, and test gates in that order. Use
`npm run lint`, `npm run typecheck`, `npm run test:unit`, and
`npm run test:integration` individually if you want to bisect a failure.

The Todo gates under `.omo/plans/project-direction-open-source.md` are
invoked from this preview's verification script (`node scripts/verify-task.mjs
<N>`). Pull requests that touch the public surface, manifest, privacy, or
release files are expected to leave the matching `verify:t[1-9]` scripts
green:

```bash
node scripts/verify-task.mjs 1 --fixture test/fixtures/release/baseline-pass.json
node scripts/verify-task.mjs 2 --fixture test/fixtures/release/surface-valid.json
node scripts/verify-task.mjs 3 --fixture test/fixtures/release/history-clean.json
node scripts/verify-task.mjs 4 --fixture test/fixtures/release/governance-missing-owner.json
```

Fixtures live under `test/fixtures/release/`. The Todo 4 governance gate
emits exactly one of `GOVERNANCE DISTRIBUTABLE`,
`GOVERNANCE NOT DISTRIBUTABLE: <code>`, or `GOVERNANCE NOT READY: <code>`
on stdout, matched in `.github/PULL_REQUEST_TEMPLATE.md`.

## Commit signing and DCO

This project follows a lightweight Developer Certificate of Origin (DCO):

- Every commit message **must** contain a `Signed-off-by:` line:
  `Signed-off-by: Your Name <your.email@example.com>`.
- You can produce one automatically with `git commit -s`.
- The line certifies the standard DCO 1.1 statement that you have the right
  to contribute the change under the project's MIT license.

Cryptographic commit signing is encouraged but **not** strictly enforced.
GitHub's "Require signed commits" branch protection is the source of truth:
if you can push a pull request, signing is met. Local-only development without
signing keys is acceptable as long as the `Signed-off-by:` trailer is
present.

## Reporting problems

- Bugs and feature requests → GitHub Issues (see
  `.github/ISSUE_TEMPLATE/bug-report.md` and
  `.github/ISSUE_TEMPLATE/feature-request.md`).
- Security-sensitive observations → follow `SECURITY.md` instead of opening
  a public issue.
- General usage questions → see `SUPPORT.md` for community channels.

## Pull request checklist

The template at `.github/PULL_REQUEST_TEMPLATE.md` walks you through the
expected checks. Items include: keeping `npm ci`, `npm test`, and
`npm run package:verify` green, not extending the product sentence, and
updating `CHANGELOG.md` if the change is user-visible.

## Read next

- `README.md` for the locked product scope and usage walkthrough.
- `BUILD.md` for environment preparation and packaging details.
- `SECURITY.md` for the supported versions and acknowledgement windows.
- `SUPPORT.md` for community-only support expectations.
- `CHANGELOG.md` for user-visible changes per release.
