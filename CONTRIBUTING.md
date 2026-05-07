# Contributing

Thanks for considering a contribution. This doc covers branch naming, commit conventions, PR expectations, and the most common pitfalls. For architecture and patterns, read [`CLAUDE.md`](CLAUDE.md) first; for testing, [`docs/testing.md`](docs/testing.md).

## Before opening a PR

Run locally what CI will run on your branch:

```bash
# Syntax check
for f in scripts/*.cjs; do node --check "$f"; done
for f in scripts/*.sh;  do bash -n "$f"; done

# Tests
npm test

# Version consistency (CI fails if these drift)
node -p "require('./package.json').version"
node -p "require('./.claude-plugin/plugin.json').version"
```

If you touched the broadcast-tool surface (added a new MCP tool that spends funds or mutates remote state), update three places in the same commit — `hooks/hooks.json`, the expected list in `.github/workflows/ci.yml`, and the "Tools gated by the PreToolUse hook" list in `CLAUDE.md`.

## Branch names

- `feat/<short-slug>` for features
- `fix/<short-slug>` for bug fixes
- `docs/<short-slug>` for doc-only changes
- `chore/<short-slug>` for dependency bumps, version bumps, refactors

No strict enforcement, but Conventional Commits-style prefixes line up with the commit-message convention below.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <imperative summary>

<optional body explaining the why>
```

Available types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`.

Recent examples (`git log --pretty=format:'%s'` for more):

- `feat: add /deploy-app end-to-end deployment workflow (ENG-86) (#3)`
- `chore: bump manifest-mcp-node to 0.6.2`
- `fix: correct README security claims and clean up write-config output`
- `docs: document transaction confirmation enforcement and bypass-mode caveat`

Issue references go in the subject (`(ENG-NN)`) when the change traces back to a tracked ticket. PR numbers are appended by the squash-merge.

## PR checklist

- [ ] Branch builds in CI (syntax + tests + version check).
- [ ] If you added a script, you also added a test file (see [`docs/testing.md`](docs/testing.md) for the branch-coverage checklist).
- [ ] If you changed any user-visible flow, the corresponding `skills/<name>/SKILL.md` is updated.
- [ ] If you added or renamed a script, the **Scripts inventory** section in `CLAUDE.md` is updated.
- [ ] If you changed the broadcast-tool surface, `hooks/hooks.json`, the CI matcher list, and `CLAUDE.md` all match.
- [ ] If you bumped `@manifest-network/manifest-mcp-node`, the env-var mapping in `CLAUDE.md` is still accurate (re-read `start-server.cjs`).
- [ ] Plugin version is unchanged (a separate `chore: bump plugin version to X.Y.Z` commit handles releases — see [`docs/release.md`](docs/release.md)).
- [ ] No secrets in the diff: keypairs, mnemonics, real chain RPC credentials.

## Code conventions

The architectural patterns are in [`CLAUDE.md`](CLAUDE.md). The recurring ones to internalize:

- **CJS only** (`.cjs` extension, `require()`) — `NODE_PATH` doesn't work with ESM. Don't introduce ESM modules in `scripts/`.
- **Underscore prefix for sibling-only helpers.** `_io.cjs`, `_uuid.cjs`, etc. are required via `./_X.cjs` and never invoked by skills via `node`.
- **Atomic write + 0600 mode** for any file under `$MANIFEST_PLUGIN_DATA`. Use `_io.cjs`'s `atomicWrite` instead of writing files directly.
- **Secrets via stdin**, never via argv. Mnemonics, passwords, env-file paths flow through pipes; argv is visible in `/proc/*/cmdline`.
- **Fail loudly** on misuse. CLI scripts exit `1` on bad input with a one-line stderr diagnostic. Don't paper over errors with defaults.
- **Scripts pin contracts; prose handles ambiguity.** Deterministic logic (UUID validation, threshold comparisons, JSON shape extraction) belongs in a `.cjs` script with a test. Asking the user a question or interpreting a fuzzy diagnostic belongs in `SKILL.md` prose.

## When to add a script vs. inline bash

A script is justified when at least one of the following is true:

- The logic has a non-obvious correctness condition (UUID format, FQDN syntax, atomic write).
- The output is consumed by multiple skills and must stay byte-identical (e.g. `render-deployment-plan.cjs`).
- The logic has branches that need test coverage (any classifier).
- Inlining would force prose to paraphrase a value and risk LLM-rendering drift.

Inline bash is fine for a one-line read or a trivial pipe inside a single skill, especially when the input/output are user-visible immediately.

When in doubt: write the script. The codebase already errs on the side of more scripts; that's a deliberate stance documented in `CLAUDE.md` ("Scripts vs prose").

## Documentation expectations

Every code change comes with the doc change in the same commit. Specifically:

- New script → entry in the **Scripts inventory** in `CLAUDE.md`, plus a test file in `tests/`.
- New skill → row in the README "Skills" table, plus a `SKILL.md` whose first 30 lines tell a reader what the skill does and what files it touches.
- Behavior change in an existing skill → update both `SKILL.md` and any reference file the skill loads.
- Architectural shift (data flow, file layout, hook contract) → update `CLAUDE.md`. README only mentions architecture in the "How It Works" diagram; that diagram is intentionally high-level and rarely changes.

Reference files (`references/*.md` and `skills/*/references/*.md`) MUST declare their consumers and their "Variables in scope" — see `CLAUDE.md` "references/ files and cross-skill loading" for the pattern.

## Asking for help

- File an issue before a large change. Architectural shifts are easier to align on at the design stage.
- For security-sensitive changes (anything touching keys, mnemonics, broadcast tools, or hook output), request review from a maintainer explicitly.
