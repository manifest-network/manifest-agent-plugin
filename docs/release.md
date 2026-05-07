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
git add package.json .claude-plugin/plugin.json
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

- [ ] Both version manifests bumped in one commit.
- [ ] CI is green on `main` at the commit you're about to tag.
- [ ] `manifest-mcp-node` version in `package.json` is the one you intend to ship (CLAUDE.md "Custom domains" mentions a minimum version — confirm it's still accurate after the bump).
- [ ] No undocumented breaking changes — check `git log` since the previous tag for any commit that renamed a script, removed a flag, or changed a skill argument shape.
- [ ] The PreToolUse matcher in `hooks/hooks.json` matches the expected tools list in `.github/workflows/ci.yml` (CI catches drift, but easier to verify before tagging).

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
