# Releasing

The release process is tag-driven. Pushing any `v*.*.*` tag triggers `.github/workflows/release.yml`; the workflow checks reachability from `origin/main` and version consistency, then creates a GitHub Release with generated notes. A separate job attaches the native Codex archive only when its acceptance evidence is complete. Pending Codex evidence does not block Claude-only releases.

## Versioning

The plugin uses [Semantic Versioning](https://semver.org/):

- **Patch** (`0.4.0` → `0.4.1`) — bug fixes, doc-only changes, dependency bumps that don't change behavior.
- **Minor** (`0.4.0` → `0.5.0`) — new skills, new flags, new MCP tool gating, behavior additions that don't break existing flows.
- **Major** (`0.4.0` → `1.0.0`) — anything that breaks an existing skill argument, removes a script, changes a wrapper-file `schema_version`'s read contract, or otherwise requires existing users to take action.

The version string lives in three manifests that MUST match, together with the lockfile root version:

- `package.json` (`version` field)
- `.claude-plugin/plugin.json` (`version` field)
- `hosts/codex/manifest-agent/.codex-plugin/plugin.json` (`version` field)

CI fails fast if they drift (`Verify version consistency across manifests` step in `.github/workflows/ci.yml`).

## Cutting a release

```bash
# 1. Update all manifests in a chore commit. Pick the new version once.
NEW_VERSION="0.5.0"
node -e "
  const fs = require('fs');
  for (const p of ['package.json', '.claude-plugin/plugin.json', 'hosts/codex/manifest-agent/.codex-plugin/plugin.json']) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.version = '$NEW_VERSION';
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  }
"
# Refresh root package metadata in the tracked lock, preserving resolutions.
npm install --package-lock-only --ignore-scripts
# Codex host fixtures run in CI; the committed historical report stays intact.
# For a Codex archive, also record this version's UI/live evidence (see below).
git add package.json package-lock.json .claude-plugin/plugin.json hosts/codex/manifest-agent/.codex-plugin/plugin.json
git commit -m "chore: bump plugin version to $NEW_VERSION"

# 2. Push the commit and let CI run. Don't tag yet — if CI fails, you'd need
#    to delete and re-push the tag, which gets messy.
git push

# 3. Once CI on main is green, create and push the tag.
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
git push origin "v$NEW_VERSION"
```

The release workflow then:

1. Verifies the tag is reachable from `origin/main` (refuses to release tags pointing off-branch).
2. Verifies the tag string (minus the `v` prefix) matches all manifest versions and the lockfile root.
3. Creates a GitHub Release with `generate_release_notes: true`. Claude continues to install the repository plugin.
4. In a dependent job, runs `ci/host-acceptance.cjs --codex-release-status`. Pending Codex interactive/testnet rows or evidence for another version skip the archive successfully. Complete rows must pass source, coverage and cleanup validation; malformed evidence fails this artifact job without removing the existing release.
5. If eligible, runs Codex fixtures and validates their fresh report, then builds and attaches `manifest-agent-codex-v<VERSION>.tar.gz` with its native marketplace, skills, scripts and locked dependency definition. Dependencies and user data are not included.

## When to release

There's no fixed cadence. Cut a release when:

- A user-visible feature has shipped to `main` and you want it discoverable in Claude Code's marketplace UI.
- A bug fix needs to roll out to existing installs; publish a version bump and update the marketplace source/ref as applicable.
- A `manifest-mcp-node` bump shipped — these change the MCP tool surface and should be tagged so users know to reconnect.

A GitHub Release does not select a marketplace's installed revision. Claude
Git sources use the repository's default branch unless the marketplace pins
a branch, tag, or commit. Check the distributing marketplace's source and
update its pin when publishing a new version. See the
[Claude marketplace source reference](https://code.claude.com/docs/en/plugin-marketplaces#github-repositories).

## Pre-release checklist

- [ ] All three version manifests and the lockfile root version updated in one commit.
- [ ] CI is green on `main` at the commit you're about to tag.
- [ ] `manifest-mcp-node` version in `package.json` is the one you intend to ship (CLAUDE.md "Custom domains" mentions a minimum version — confirm it's still accurate after the bump).
- [ ] No undocumented breaking changes — check `git log` since the previous tag for any commit that renamed a script, removed a flag, or changed a skill argument shape.
- [ ] The installed MCP inventory check (`ci/mcp-tool-policy.cjs`) and policy-completeness check pass for the pinned package; record the host-validation status separately (see [`approval-validation.md`](approval-validation.md)).
- [ ] Native build, `ci/host-contracts.cjs`, and the fresh Codex host report pass in CI. Keep the committed historical report's hashes and source commit intact; source/version changes do not require a local Codex run.
- [ ] For a Codex archive, complete the Codex interactive and testnet rows in [`host-acceptance.md`](host-acceptance.md), record reviewed transcripts, and update `host-acceptance-release.json` for the new version and exact source hashes. `node ci/host-acceptance.cjs --codex-release-status` reports `eligible=true` and all testnet resources are cleaned up. The full both-host matrix remains required before claiming full compatibility.

## Identity hardening release (ENG-85)

ENG-85 explicitly requests a version update, so its changes align the three
manifests and lockfile at 0.5.0. Desktop wallets use native credential storage;
headless installs without a keychain must explicitly select the file fallback.
Legacy config migration verifies storage before removing plaintext. See
[identity setup and recovery](identity.md) and the [implementation plan](eng-85-plan.md).
The existing 0.4.0 host acceptance records remain historical; this bump does
not make them evidence for 0.5.0 or publish a release. Fresh Linux
[terminal and app-server reports](host-acceptance.md#050-preparation-status)
and [native preservation evidence](current-install-acceptance-0.5.0.md) now bind
the final source `c6fcc565`. Both hosts passed automatic 0.4.0 plaintext
migration, native reinstall, offline wallet signing, saved-record checks,
and automatic runtime repair. These runs explicitly selected file credentials.
The first upgraded Claude session required native `/mcp` reconnect after a
30-second connection timeout; the evidence records that limit. Native
remove/install upgrade was tested, not marketplace update-in-place.

Both hosts completed the [live testnet lifecycle](live-testnet-acceptance-0.5.0.md),
including cleanup of temporary deployments, domains, hosts and wallet profiles.
The [0.5.0 checklist](release-0.5.0.md) tracks release-gate validation and the
remaining publication steps; PR CI checks apply to the reviewed commit.
Native macOS Keychain and Windows Credential Manager/ACL acceptance remains
unverified; Linux CLI evidence does not establish those platforms or GUI behavior.

## Native Codex compatibility release (ENG-894)

The original feature kept plugin version 0.4.0 pending a release chore.
Both hosts consume one workflow source and the same locked MCP 0.22.0 runtime.
Codex installs a separate native artifact, performs its own bootstrap, and
uses independent data by default. No Claude wallet, chain selection or local
record is migrated. Configuration/wallet changes in shared data directories
are unsupported; isolated concurrent processes are tested.

Codex's adapter requires form elicitation for reviewed mutations, confirms
direct writes and retains upstream orchestrated confirmation, progress and
recovery. Missing/declined confirmation cannot authorize a direct write.
Cancelled or timed-out operations after broadcast can remain paid partial or
unknown; users must inspect existing state before retrying. Headless hosts
that cannot present native prompts support the read-only workflow subset.

Historical 0.4.0 evidence includes the real Codex 0.153.4 app-server with harmless
fixtures, both pinned launchers and published callback contracts, CLI terminal
observations, the live testnet lifecycle, and
[current-version reinstall and repair](current-install-acceptance.md).
The 0.4.0 evidence explicitly exempts legacy upgrades because the repository
owner confirms there are no existing legacy users; the gate requires reinstall
and runtime-repair coverage in their place. Other records still require
upgrade coverage unless they declare that exemption. GUI behavior and
version-to-version migration were not tested. Interactive and live testnet
evidence remains bound to the recorded source hashes and package version;
a new version needs its own release record.

## Hotfixes

For an urgent fix on top of an existing release:

```bash
git checkout -b fix/<slug> v<previous-version>
# ... make the fix, commit, open PR, merge to main ...
# ... bump version to <previous-version+patch> ...
# ... tag main at the merge commit ...
```

Don't tag the hotfix branch directly. The release workflow refuses to release a tag that's not reachable from `main`.

## Yanking a release

GitHub Releases can be deleted; the underlying tag can be deleted with `git push origin :v<version>`. Marketplace caches may still serve the yanked version until Claude Code refreshes them. Prefer cutting a new patch release with the fix over deleting; the bump path is faster and surfaces the fix in changelogs.

## Historical 0.4.0 changes: runtime compatibility and lease states (ENG-893, ENG-158)

These changes shipped in 0.4.0 and provide upgrade context. The feature
commits predated that release's version/tag preparation.

- Requires Node 22.19.0+; CI covers that floor and Node 24. MCP is pinned to
  0.22.0 with a tracked lockfile. Consumer overrides carry upstream ENG-269/270/748
  dependency fixes (axios 1.19.0, protobufjs 7.6.5, ipaddr.js 2.4.0 and the
  Manifest stargate fork). The feature commit does not bump the plugin version.
- SessionStart, onboarding and repair share `setup-runtime.cjs`. Incomplete or
  removed dependencies trigger a locked reinstall in the data directory. Config,
  keys, drafts, journals and saved deployments survive upgrades and repair.
- Config owns the selected chain/gas/wallet environment, dotenv is isolated from
  workspace files, and stdout stays MCP JSON-RPC. Empty passwords are preserved;
  upstream 0.22.0 rejects encrypted keyfiles with an empty password.
- Skills use required deployment size, current service port constraints, separate
  read-only domain lookup, typed domain results, and OPERATION_CANCELLED/partial
  recovery outcomes. A cancellation can follow a paid lease creation; preserve
  recovery identifiers and query existing state before retrying. Close may cancel
  a pending lease or find an already-terminal one.
- The new `restore_app` mutation is permission-gated. It creates a new paid lease,
  has no fee-estimation interface, and must not be blindly retried.
- Published saved records remain schema 3; v2/v3 summaries stay readable and
  redacted. No local record migration or deletion accompanies this update.
- ENG-158 aligns the plugin helper with the billing proto: 3 is CLOSED, 4 is
  REJECTED, and 5 is EXPIRED; all three are terminal. INSUFFICIENT_FUNDS is
  not in the chain enum; the string remains terminal for compatibility with
  agent-core's public type and terminal set, without a numeric mapping.
  Orchestrated flows continue to decode states upstream.
- ENG-260 added exact SKU/provider UUID selection to authored drafts and
  journals. MCP 0.22.0 honors compute selectors, but its saved wrapper still
  lacks those UUID fields. Storage identity metadata remains a plugin-side
  catalog check rather than an upstream storage selector.

Record final package/launcher checks and any outstanding upstream dependency
advisories in the PR. The prior Claude host evidence is recorded separately in
[approval-validation.md](approval-validation.md); it must not be presented as a
fresh host test of every 0.22.0 tool.

Review follow-up: MCP launchers await concurrent SessionStart setup with bounded
failure diagnostics; supported stable Node majors share the installed JavaScript
runtime; regular `.node` files are rejected until Node-specific runtime support
exists, while directory and symlink names alone do not identify native addons.
Setup and launchers share process-owner checks, so dead owners no longer delay
startup. Linux process identity also distinguishes reused PIDs. Setup retries
yield and stay bounded even for malformed lock paths; launcher diagnostics
identify lock-read failures without misdirecting users to reinstall the plugin.
Setup contention is visible, handled npm failures retain only nonempty logs, and completion errors
identify the invalid metadata. Unsupported prerelease Node builds receive a
distinct diagnostic. Tests exercise the actual timing defaults. Host evidence
checks require substantive case results as well as historical/current source
hashes; historical byte validation requires the recorded Git object locally.
Abrupt launcher termination, including SIGKILL, SIGQUIT or SIGABRT, can skip
exit cleanup and leave an empty private MCP working directory for the OS temp
cleaner. Normal exits remove it; SIGTERM/SIGINT/SIGHUP are forwarded to the
child, with cleanup when the child exits.
