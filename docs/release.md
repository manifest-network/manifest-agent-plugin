# Releasing

The release process is tag-driven. Pushing any `v*.*.*` tag triggers `.github/workflows/release.yml`; the workflow refuses tags whose commit isn't reachable from `origin/main`, verifies version consistency, and then creates a GitHub Release with auto-generated notes.

## Versioning

The plugin uses [Semantic Versioning](https://semver.org/):

- **Patch** (`0.4.0` → `0.4.1`) — bug fixes, doc-only changes, dependency bumps that don't change behavior.
- **Minor** (`0.4.0` → `0.5.0`) — new skills, new flags, new MCP tool gating, behavior additions that don't break existing flows.
- **Major** (`0.4.0` → `1.0.0`) — anything that breaks an existing skill argument, removes a script, changes a wrapper-file `schema_version`'s read contract, or otherwise requires existing users to take action.

The version string lives in two manifests that MUST match:

- `package.json` (`version` field)
- `.claude-plugin/plugin.json` (`version` field)

CI fails fast if they drift (`Verify version consistency across manifests` step in `.github/workflows/ci.yml`).

## Cutting a release

```bash
# 1. Update both manifests in a chore commit. Pick the new version once.
NEW_VERSION="0.5.0"
node -e "
  const fs = require('fs');
  for (const p of ['package.json', '.claude-plugin/plugin.json']) {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.version = '$NEW_VERSION';
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  }
"
# Refresh root package metadata in the tracked lock, preserving resolutions.
npm install --package-lock-only --ignore-scripts
git add package.json package-lock.json .claude-plugin/plugin.json
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
2. Verifies the tag string (minus the `v` prefix) matches both manifest versions.
3. Creates a GitHub Release with `generate_release_notes: true` (auto-generates notes from PR titles and labels since the previous tag).

## When to release

There's no fixed cadence. Cut a release when:

- A user-visible feature has shipped to `main` and you want it discoverable in Claude Code's marketplace UI.
- A bug fix needs to roll out to existing installs (marketplace installs pull the latest tagged release, not `main`).
- A `manifest-mcp-node` bump shipped — these change the MCP tool surface and should be tagged so users know to reconnect.

## Pre-release checklist

- [ ] Both version manifests and the lockfile root version updated in one commit.
- [ ] CI is green on `main` at the commit you're about to tag.
- [ ] `manifest-mcp-node` version in `package.json` is the one you intend to ship (CLAUDE.md "Custom domains" mentions a minimum version — confirm it's still accurate after the bump).
- [ ] No undocumented breaking changes — check `git log` since the previous tag for any commit that renamed a script, removed a flag, or changed a skill argument shape.
- [ ] The installed MCP inventory check (`ci/mcp-tool-policy.cjs`) and policy-completeness check pass for the pinned package; record the host-validation status separately (see [`approval-validation.md`](approval-validation.md)).

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

## Next release: runtime compatibility (ENG-893)

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
- Existing ENG-158 still owns the plugin helper's numeric terminal-state mapping;
  current orchestrated flows decode states upstream. ENG-260 still owns full
  SKU/provider UUID selection and persistence; authoring saves required size and
  stops on ambiguous names. MCP 0.22.0's saved wrapper still lacks UUID selectors.

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
SIGKILL can leave an empty private MCP working directory for the OS temp cleaner;
normal exits remove it.
