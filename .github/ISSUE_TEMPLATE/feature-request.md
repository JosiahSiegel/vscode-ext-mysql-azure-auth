---
name: Feature Request
about: Suggest a change to the Azure MySQL + Microsoft Entra VS Code preview
title: "[Feature] "
labels: ["enhancement", "needs-triage"]
assignees: []
---

**Scope note:** the maintainer's locked product sentence is "A
community-maintained VS Code preview for browsing and querying Azure Database
for MySQL Flexible Server with Microsoft Entra authentication." Requests that
extend that scope (different databases, row editing, generic SQL tooling,
telemetry, sponsorships) will be declined regardless of technical merit.

## Problem statement

What user problem does this feature solve? Link to any relevant Microsoft
Azure MySQL or Microsoft Entra public documentation.

## Proposed behaviour

How would the extension behave once the feature ships?

## Alternatives considered

What other approaches did you weigh, and why is this one preferred?

## Public-surface impact

Tick what applies:

- [ ] Adds a new command
- [ ] Adds a new setting
- [ ] Adds a new activation event
- [ ] Touches the credential / token lifecycle
- [ ] Touches the read-only enforcement
- [ ] Touches the safe diagnostic allowlist

## Verification plan

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run package:verify`
- [ ] `node scripts/verify-task.mjs 2 --fixture test/fixtures/release/surface-valid.json`

## DCO

- [ ] I will add a `Signed-off-by:` trailer to every commit (`git commit -s`)
