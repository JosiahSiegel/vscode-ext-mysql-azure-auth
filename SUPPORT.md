# Support

This document describes how to ask for help with the
`mysql-azure-auth` VS Code extension. Read it before opening an issue.

## What this project is

A community-maintained VS Code preview for browsing and querying Azure
Database for MySQL Flexible Server with Microsoft Entra authentication.
The project is in Preview and is **not** backed by a vendor service level
agreement.

## Community-only support

This is a community-only project. There is **no SLA**, no on-call rotation,
no paid support tier, and no implied response time. Response cadence is
anecdotal — typically a few days for community questions and as soon as
spare cycles allow for bug confirmations. The maintainer may be on holiday,
between jobs, or simply focused on something else; please plan accordingly
if your work depends on a fix landing inside a specific window.

If you need a guaranteed response time, contract a commercial vendor
qualified to maintain this code or its equivalent for the version of
Azure Database for MySQL Flexible Server and Microsoft Entra you use.

## Where to ask

| Topic                                | Channel                                                   |
| ------------------------------------ | --------------------------------------------------------- |
| Bug reports                          | GitHub Issues → bug-report template                       |
| Feature requests                     | GitHub Issues → feature-request template                   |
| Security vulnerabilities             | Privately per `SECURITY.md` (do not file a public issue)  |
| General usage questions              | GitHub Issues tagged `question`                           |
| Documentation typos / clarifications | Pull request per `CONTRIBUTING.md`                        |

Use `.github/ISSUE_TEMPLATE/bug-report.md` and
`.github/ISSUE_TEMPLATE/feature-request.md` when opening an issue so the
maintainer has the minimum data to reproduce.

## Supported versions

| Version       | Supported          |
| ------------- | ------------------ |
| 0.1.0-Preview | Yes (preview only) |

Only the `0.1.0-Preview` line is currently supported. Pre-release and
post-preview tags are not covered by this support policy.

## Privacy note

Reproductions should **never** include:

- Entra access tokens or `Bearer` headers
- Personal email addresses or hostnames
- Production schema names or query contents
- Console snippets captured from a live MySQL session

The repository ships a `safeDiagnostic` formatter (added by a later release
hardening task) precisely so that any back-and-forth in issues can stay
shareable. Prefer that output over raw errors.

## Acknowledgement targets

Security acknowledgement and remediation targets live in `SECURITY.md` —
they are best-effort commitments of the maintainer for the supported
Preview version, not contractual obligations.

## Read next

- `README.md` for setup, usage, and architecture.
- `SECURITY.md` for the supported versions and acknowledgement windows.
- `CONTRIBUTING.md` for development workflow and the DCO requirement.
- `CHANGELOG.md` for user-visible changes per release.
