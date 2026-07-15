---
name: Bug Report
about: Report a defect in the Azure MySQL + Microsoft Entra VS Code preview
title: "[Bug] "
labels: ["bug", "needs-triage"]
assignees: []
---

**Please do not post secrets, tokens, hosts, schema names, or query contents here.** Use
`SECURITY.md` for security-sensitive observations and the `safeDiagnostic`
output wherever possible.

## Describe the bug

A clear and concise description of what the bug is.

## Reproduction steps

1. Open the project in VS Code with `<extension version>`
2. Register a server with `<flexible-server FQDN>`
3. Run `<command>` against `<table>`
4. Observe `<unexpected output>`

## Expected behaviour

What you expected to happen.

## Actual behaviour

What actually happened, including any error / status messages.

## Environment

- VS Code version:
- Extension version (`0.1.0-Preview`):
- OS:
- Entra sign-in source (VS Code Microsoft provider / Azure CLI fallback):

## Safe diagnostic output

Paste the maintainer-safe diagnostic output here (omit anything that looks
like a token, email, host, or query):

```text
operation = <…>
credentialSource = <…>
elapsedMs = <…>
errorClass = <…>
mysqlErrorCode = <…>
connectionState = <…>
retryCount = <…>
```

## Local validation

Confirm the maintainer's gate stack reproduces or rules out the bug:

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run package:verify -- --synthetic`
- [ ] `node scripts/verify-task.mjs 1 --fixture test/fixtures/release/baseline-pass.json`
- [ ] `node scripts/verify-task.mjs 4 --fixture test/fixtures/release/governance-missing-owner.json`

## Additional context

Anything else that might help.
