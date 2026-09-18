# ENG-1010: Bash guidance beside secret-input recipes

[ENG-1010](https://linear.app/liftedinit/issue/ENG-1010) carries the README's
Bash guidance into the installed onboarding, key-import and env-file recipes.
Fish users need to start Bash before the POSIX assignments and keep that
session open through temporary-file cleanup.

Status: implemented and verified on Linux with Node 24.15.0.

## Plan

1. Put the Bash instruction immediately before each user-typed secret-file
   recipe in `workflows/init-agent.md`, `workflows/import-key.md` and
   `workflows/author-manifest.md`. Keep the README's adjacent advice consistent.
2. Preserve the commands, private temporary files, stdin pipes, path-only
   collection and cleanup instructions. Do not add fish translations.
3. Regenerate the tracked Claude skills and build the native Codex package.
   Inspect all six generated recipes for adjacent shell guidance and retained
   cleanup; compare the command blocks with the original source. Use literal
   `bash` for the shell name; the Codex renderer translates capitalized `Bash`
   as a host tool name.
4. Run the existing Linux unit suite, package checks, policy completeness,
   syntax and version checks, and validate the affected Codex skills.

## Release boundary

Published v0.5.0 evidence and source hashes remain unchanged. All four host
release rows are already pending. Fresh source-bound host and live-testnet
acceptance is required before the next release under
[the release policy](host-acceptance.md#release-evidence).
Local Linux checks do not establish interactive model behavior or native
macOS/Windows compatibility.

## Validation results

- Reviewed all six generated recipe introductions: each names the `bash`
  shell, directs fish users to start it in their separate terminal, and keeps
  them in that session through cleanup. Each workflow's introduction is
  identical across hosts.
- Compared every fenced command block in the three workflow sources, both
  hosts' generated skills and the README against the original source/render.
  All are unchanged; all six recipes retain their input-file cleanup command.
- Claude generation, Codex packaging, all 14 generated-skill checks, the three
  affected Codex skills' frontmatter validation, policy completeness, CJS/Bash
  syntax, version consistency and diff whitespace checks passed. All 13 package
  tests also passed for the final generated skills.
- The existing Linux suite passed 986 tests with zero failures using
  `--test-concurrency=1`. Three PowerShell checks were skipped because `pwsh`
  is unavailable. The suite required execution outside the workspace sandbox
  after its subprocess checks returned `EPERM`.
