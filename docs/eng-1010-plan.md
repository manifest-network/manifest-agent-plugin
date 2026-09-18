# ENG-1010: Bash guidance beside secret-input recipes

[ENG-1010](https://linear.app/liftedinit/issue/ENG-1010) carries the README's
Bash guidance into the installed onboarding, key-import and env-file recipes.
Fish users need to start Bash before the POSIX assignments and keep that
session open through temporary-file cleanup.

Status: review corrections implemented and verified on Linux with Node 24.15.0.

## Plan

1. Put the Bash instruction immediately before each user-typed secret-file
   recipe in `workflows/init-agent.md`, `workflows/import-key.md` and
   `workflows/author-manifest.md`. Keep the README's adjacent advice consistent.
2. Preserve private temporary files, stdin pipes and path-only collection.
   Explain Ctrl+D explicitly and clean up every confirmed recipe-created
   temporary file. Preserve supplied pre-existing files and files of unknown
   origin, including when the recipe is repeated for several services.
3. Regenerate the tracked Claude skills and build the native Codex package.
   Inspect all six generated recipes for adjacent shell guidance and complete
   cleanup. Use literal
   `bash` for the shell name; the Codex renderer translates capitalized `Bash`
   as a host tool name.
4. Cover both hosts' rendered advice, private-file creation, stdin env merge
   and per-file cleanup with regression tests. Run the Linux unit suite,
   package checks, policy completeness, syntax and version checks, and
   validate the affected Codex skills.

## PR review corrections

The [review of 63b2640](https://github.com/manifest-network/manifest-agent-plugin/pull/24#issuecomment-5731929225)
was checked against both hosts' rendered skills and disposable Linux fixtures.

| Finding | Resolution |
| --- | --- |
| 1: Codex mnemonic warning forbids its shell tool | Describe the prohibited display/context exposure without a host tool name, and explicitly allow the stdin import pipeline. Both mnemonic workflows use this instruction. |
| 2: adjacent shell advice lacks regression coverage | Check every generated secret-file recipe for adjacent fish/Bash/session/cleanup guidance and reject tool-name substitution in that paragraph. |
| 3: repeated env recipes leave earlier input files behind | Supply one shell-quoted cleanup command per distinct recipe-created temporary path, independent of the last `ENV_INPUT_PATH` value. |
| 4: literal `^D` breaks env parsing | Use a Ctrl+D comment in the workflow and README. The generated recipe/merge test verifies that even a literally typed comment is harmless. |
| 5: cleanup wording names only the terminal | All three workflows now explicitly name the same `bash` session at cleanup. |
| 6: broad builder rewrite can corrupt shell prose | Track the builder and related read-tool wording separately in [ENG-1029](https://linear.app/liftedinit/issue/ENG-1029). Document the current literal-shell/token convention in `CLAUDE.md`. |

The [follow-up review of 50f65d0](https://github.com/manifest-network/manifest-agent-plugin/pull/24#issuecomment-5733250449)
identified additional cleanup and regression boundaries.

| Finding | Resolution |
| --- | --- |
| 1: per-path cleanup can include a user's project env file | Record which inputs the user confirms were created with the recipe. Suggest deletion only for those temporary files; preserve pre-existing inputs and inputs of unknown origin. |
| 2: cleanup shell wording is outside the intro check | Reject `exec_command` used as a session, shell or terminal name throughout every generated workflow. |
| 3: the negated-tool guard only matches one exact sentence | Check direct negations of read/shell tool tokens in source, case-insensitively, and rendered tool verbs without anchoring to an object noun. |
| 4: mnemonic recipe comments can become invalid input | End the first command block at `cat`, put Enter/Ctrl+D guidance in prose, and print the path in a separate block after the shell returns. Mnemonic parsing remains phrase-only. |
| Merge recovery and documentation nits | Explain that listed input errors leave the spec unchanged and earlier service merges remain; retry the failed service. Remove the stale builder-test count and move the naming convention to the shared workflow guidance, explicitly including host fragments. |
| Placeholder and ordering nits | Use `TEMP_ENV_INPUT_FILE` for the user cleanup placeholder and require the Bash-start instruction to precede the recipe commands. |

## Release boundary

Published v0.5.0 evidence and source hashes remain unchanged. All four host
release rows are already pending. Fresh source-bound host and live-testnet
acceptance is required before the next release under
[the release policy](host-acceptance.md#release-evidence).
Local Linux checks do not establish interactive model behavior or native
macOS/Windows compatibility.

## Validation results

- Before the corrections, regressions detected the contradictory Codex warning,
  missing per-file cleanup command, and both hosts' literal-`^D` parse errors.
  Further guards reproduced the unscoped cleanup advice and combined mnemonic
  input/instruction blocks. All 94 package, env and wallet workflow tests pass.
- Isolated source mutations confirmed that the recipe guidance test fails when
  its adjacent advice is removed or a capitalized shell name becomes
  `exec_command` in the Codex render.
  Seven further mutations were rejected: capitalized cleanup shell names in
  each workflow, three negated-tool wording variants, and inverted Bash timing.
- Both hosts' generated env commands create mode `0600` files, merge sample
  input through stdin, preserve private spec permissions, and emit no values.
  Cleanup fixtures remove both recipe-created paths despite a reassigned input
  variable, including paths with spaces, apostrophes and shell syntax. They
  merge supplied pre-existing and unknown-origin files and preserve their bytes
  through cleanup, executing no path-supplied commands. The fixture supplies
  file origins; it does not establish a model's provenance decisions.
- Both hosts' mnemonic fixtures execute the separated capture/path-display
  commands, preserving exactly the supplied words in mode `0600` files without
  instructional text or mnemonic output.
- Removing only the broad `Bash` rewrite changes none of the current 14 Codex
  renders, confirming the independent builder follow-up's reproduction.
- The full Linux suite passed 994 tests with zero failures using
  `--test-concurrency=1`; three PowerShell checks were skipped because `pwsh`
  is unavailable. Subprocess fixtures ran outside the workspace sandbox.
- Claude generation, Codex packaging, all 14 generated-skill checks, affected
  workflow regressions, policy completeness, CJS/Bash syntax, version
  consistency and diff whitespace checks passed. Published evidence and the
  four pending release rows remain unchanged.
- The standalone skill-creator validator is no longer available at its local
  path for this follow-up. Frontmatter is unchanged; repository generation
  and package validation passed.

The fixtures supply user input and collected paths; they validate rendering
and executable commands, not an interactive model's choices or UI behavior.
