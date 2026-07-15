# Pull Request

Thanks for contributing to the `mysql-azure-auth` Preview. Please complete the
checklist below; reviewers will close PRs that leave an item unchecked unless
you add a note explaining why.

## Summary

- What changed and why:
- Link to the relevant plan todo or issue:

## Public surface

The project's public surface is contractually pinned. Tick what your PR touches:

- [ ] Commands (added, renamed, removed)
- [ ] Settings (added, renamed, removed)
- [ ] Activation events (added, removed)
- [ ] Views (added, removed)
- [ ] Product sentence in `README.md` (must not change without explicit owner approval)
- [ ] Governance docs (`SECURITY.md` / `CONTRIBUTING.md` / `SUPPORT.md` / `CHANGELOG.md`)

If you ticked any of the first four, attach a release-contract fixture diff
under `test/fixtures/release/` and update
`test/fixtures/release/release-contract.json`.

## Verification

Run the maintainer's gate stack locally and paste results (or attach logs):

- [ ] `npm ci`
- [ ] `npm test` (lint + typecheck + unit + integration)
- [ ] `npm run package:verify`

Then run the relevant Todo gate(s) from this preview's verification script
(`node scripts/verify-task.mjs <N> --fixture …`):

- [ ] `verify:t1` — baseline / runtime / claim consistency
- [ ] `verify:t2` — public-surface contract
- [ ] `verify:t3` — history scan
- [ ] `verify:t4` — governance / owner identity
- [ ] `verify:t5..t9` — privacy, manifest, identity, refresh, logging (later in plan)

Fixtures for the matched gates live under `test/fixtures/release/`. Every
gate must emit its documented success string (`BASELINE READY`,
`CONTRACT READY`, `HISTORY CLEAN`, `GOVERNANCE DISTRIBUTABLE`, etc.).

## DCO

- [ ] Every commit message carries a `Signed-off-by:` line (use `git commit -s`)
- [ ] Cryptographic signing encouraged but not strictly enforced

## Risk and rollback

- Risk:
- Reversal procedure:

## Documentation

- [ ] Updated `README.md` (if user-visible)
- [ ] Updated `CHANGELOG.md` (if user-visible)
- [ ] Updated `SUPPORT.md` or `SECURITY.md` (if governance impact)

## Read first

- `CONTRIBUTING.md` for the DCO requirement and local validation rules
- `SECURITY.md` for supported versions and the acknowledgement windows
- `.omo/plans/project-direction-open-source.md` for which Todo owns a given
  area of the code base
