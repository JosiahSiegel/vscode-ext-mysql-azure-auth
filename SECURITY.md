# Security Policy

## Supported Versions

| Version       | Supported |
| ------------- | --------- |
| 0.1.1-Preview | Yes       |
| 0.1.0-Preview | Yes       |

Both `0.1.1-Preview` and `0.1.0-Preview` are currently supported. Pre-release
and post-release builds are not covered.

## Reporting a Vulnerability

Please report security issues privately. **Do not** open a public GitHub issue
or pull request for a suspected vulnerability.

Report security issues to: mailto:josiah0601@gmail.com

## Acknowledgement and Remediation Targets

Targets below are the maintainer's commitment for the supported
`0.1.x-Preview` lines. They are best-effort and may shift if the project
gains more contributors or the owner updates
`.omo/inputs/project-direction-open-source.json`.

| Severity     | Acknowledgement target | Critical fix target |
| ------------ | ---------------------- | ------------------- |
| High/Critical | 7 days                 | 30 days             |

Sources of the targets:

- The acknowledgement target derives from the owner-provided
  `supportCommitment.securityAckDays` (fallback: 7 days).
- The critical fix target derives from the owner-provided
  `supportCommitment.criticalFixTargetDays` (fallback: 30 days).

If the owner input file is absent or invalid, the defaults above apply.

## Security-Only Rollback

A security regression can be reverted in isolation without touching feature
work.

### Automated rollback

Use the official `vsce` tool against the previous Marketplace version when the
extension has been published:

```bash
vsce <previousVersion> --revert
```

`<previousVersion>` must be a published prior version (`0.1.0-Preview` or
`0.1.1-Preview` candidate tags are eligible). This command prompts the
maintainer to confirm the downgrade and re-publishes the earlier VSIX.

### Public manual procedure

When `vsce` is unavailable or the extension has not yet been published to the Marketplace:

1. Identify the offending commit (the new commit on top of a known-clean tag).
2. Revert that commit locally:
   ```bash
   git revert <commit>
   ```
   or, if a true revert is unsafe due to conflict resolution, restore the prior
   state with:
   ```bash
   git checkout <known-clean-tag> -- src/ SECURITY.md CONTRIBUTING.md SUPPORT.md \
       CHANGELOG.md .github/ISSUE_TEMPLATE/ .github/PULL_REQUEST_TEMPLATE.md \
       package.json
   ```
3. Rebuild and re-run `npm test` and `npm run package:verify`.
4. Re-publish the rebuilt VSIX, or in preview-only mode, push the revert to
   the public branch with a note in the release section of `CHANGELOG.md`.
5. Open an issue referencing the security advisory so downstream users can
   pin to the last known-good commit if they cannot upgrade.

The maintainer's commit history must remain auditable — no force-pushes for a
security rollback unless the owner explicitly authorizes rewriting after the
fresh-root procedure documented in `.omo/plans/project-direction-open-source.md`
Todo 3 has been executed.

## Deprecation and Archive Policy

This is a community preview, scoped to Azure Database for MySQL Flexible Server
with Microsoft Entra authentication. The maintainer reserves the right to
archive the repository when one of the following is true, in order:

1. A more capable official extension from Microsoft or the Azure MySQL team
   fills the same need.
2. The Azure MySQL data-plane or `ossrdbms-aad` auth flow changes in a way that
   this preview cannot track without breaking core guarantees.
3. No commits, issue triage, or community feedback has occurred for a stretch
   exceeding 12 months and there is no active owner willing to keep the
   extension alive.

Archive means: the repository is marked read-only, the Marketplace listing
(publisher `JosiahSiegel`) is withdrawn, and `SECURITY.md` is updated to point
readers at the recommended successor. Critical security fixes during the deprecation window
remain best-effort on a case-by-case basis. The MIT license on historical
commits is unaffected by archival.

---

Plain Markdown — no extra formatting directives.
