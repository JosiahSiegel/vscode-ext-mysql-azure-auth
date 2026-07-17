/**
 * versionTracker — numeric-three-part semver comparator + state machine.
 *
 * The extension activation path needs to classify the current load
 * (`observed`, read from `vscode.Extension#packageJSON.version`)
 * against the version that was last persisted after a successful
 * migration run (`lastMigrated`, stored at
 * `mysqlAzureAuth.lastMigratedVersion` in `globalState`). The result
 * drives the migration runner: `firstInstall` and `upgrade` run the
 * step list; `sameVersion` skips it; `downgrade` runs it
 * defensively (downgrades can still need data-shape migrations);
 * `malformedVersion` always re-runs every step because we cannot
 * trust the stored marker.
 *
 * Supported subset: numeric three-part, no pre-release suffixes.
 * Publishing `0.1.2-rc.1` will be classified as `malformedVersion`
 * and will trigger the rebuild path; the project's release policy
 * forbids pre-release suffixes until the comparator grows.
 *
 * The comparator handles `>` and `==` only; `1.0` and `1.0.0.0` are
 * rejected as malformed. No external `semver` dependency — the regex
 * `^\d+\.\d+\.\d+$` defines the supported subset, which is enough
 * for the project's release policy (semver major / minor / patch).
 *
 * The function is pure: no logging, no side effects, no `console`.
 * `classifyVersionTransition` MUST normalize `null` → `undefined`
 * at the entry of the function before any string method is called,
 * so callers that pass a JSON-parsed `null` do not throw.
 */

export type VersionTransition =
    | 'firstInstall'
    | 'sameVersion'
    | 'upgrade'
    | 'downgrade'
    | 'malformedVersion';

/**
 * Strict numeric three-part semver matcher. Anchored on both ends so
 * `'0.1.2 '` (trailing space) and `' 0.1.2'` (leading space) are
 * rejected, matching the spec's "no pre-release suffixes" intent.
 */
const NUMERIC_THREE_PART = /^\d+\.\d+\.\d+$/;

/**
 * Returns `true` when `version` is a numeric three-part semver
 * string (e.g. `'0.1.2'`). Returns `false` for the empty string,
 * two-part versions (`'1.0'`), four-part versions (`'1.0.0.0'`),
 * pre-release suffixes (`'0.1.2-rc.1'`), and any non-numeric input.
 */
export function isNumericThreePart(version: string): boolean {
    return NUMERIC_THREE_PART.test(version);
}

/**
 * Compare two non-negative integers numerically (not lexicographically).
 * Returns -1 / 0 / +1.
 */
function comparePart(a: number, b: number): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Compare two numeric-three-part semver strings. Returns negative /
 * zero / positive in the same convention as `Array#sort`. Inputs
 * that do not match `^\d+\.\d+\.\d+$` are treated as `NaN`-ranked
 * (callers should gate with `isNumericThreePart` first; the public
 * `classifyVersionTransition` does this on the caller's behalf).
 */
function compareVersions(a: string, b: string): number {
    const [aMajor, aMinor, aPatch] = a.split('.').map(Number) as [
        number,
        number,
        number
    ];
    const [bMajor, bMinor, bPatch] = b.split('.').map(Number) as [
        number,
        number,
        number
    ];
    const major = comparePart(aMajor, bMajor);
    if (major !== 0) return major;
    const minor = comparePart(aMinor, bMinor);
    if (minor !== 0) return minor;
    return comparePart(aPatch, bPatch);
}

/**
 * Classify the activation as one of `firstInstall | sameVersion |
 * upgrade | downgrade | malformedVersion`.
 *
 * The decision rules are gated on `observed` first because the
 * stored marker is a recovery aid, not a source of truth: if we
 * can't read the observed version, we can't decide anything.
 *
 * - `(undefined, undefined)` → `firstInstall` — nothing to
 *   compare; the runner records the version on success.
 * - `(undefined, _)` (with a stored marker) → `malformedVersion`
 *   — we cannot compare what we cannot read; the runner falls
 *   through to the rebuild path.
 * - `('malformed', _)` → `malformedVersion` — same: the regex
 *   rejected the value we are about to publish against.
 * - `('valid', undefined | null)` → `firstInstall` — no stored
 *   marker at all, so the install path runs.
 * - `('valid', 'malformed')` → `upgrade` — there is a stored
 *   marker but it is not trustworthy. We treat the marker as a
 *   prior state (any non-zero observed version upgrades past it)
 *   rather than as an absent marker (`firstInstall`), so the
 *   upgrade branch of the runner — which is the rebuild path —
 *   fires. The runner will overwrite the bad marker with the
 *   observed version on success.
 * - `('valid', 'valid')` → `sameVersion` / `upgrade` / `downgrade`.
 *
 * `null` is normalized to `undefined` at the entry of the function
 * so callers that pass a JSON-parsed `null` do not trigger a
 * `TypeError` on the first string method.
 */
export function classifyVersionTransition(
    observed: string | null | undefined,
    lastMigrated: string | null | undefined
): VersionTransition {
    const obs = observed ?? undefined;
    const last = lastMigrated ?? undefined;

    if (obs === undefined && last === undefined) return 'firstInstall';
    if (obs === undefined) return 'malformedVersion';
    if (!isNumericThreePart(obs)) return 'malformedVersion';
    if (last === undefined) return 'firstInstall';
    if (!isNumericThreePart(last)) return 'upgrade';

    const cmp = compareVersions(obs, last);
    if (cmp === 0) return 'sameVersion';
    if (cmp > 0) return 'upgrade';
    return 'downgrade';
}