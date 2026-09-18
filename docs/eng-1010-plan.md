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
   Explain Ctrl+D explicitly and offer cleanup for confirmed recipe-created
   temporary files after all their merges succeed. Preserve skipped inputs,
   supplied pre-existing files and files of unknown or conflicting origin,
   including when the recipe is repeated for several services.
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
| 4: literal `^D` breaks env parsing | Separate shell commands, private data entry and path display in the workflow and README. The initial comment-only correction was superseded by the third review's paste/history fix below. |
| 5: cleanup wording names only the terminal | All three workflows now explicitly name the same `bash` session at cleanup. |
| 6: broad builder rewrite can corrupt shell prose | Track the builder and related read-tool wording separately in [ENG-1029](https://linear.app/liftedinit/issue/ENG-1029). Document the current literal-shell/token convention in `CLAUDE.md`. |

The [follow-up review of 50f65d0](https://github.com/manifest-network/manifest-agent-plugin/pull/24#issuecomment-5733250449)
identified additional cleanup and regression boundaries.

| Finding | Resolution |
| --- | --- |
| 1: per-path cleanup can include a user's project env file | Record which inputs the user confirms were created with the recipe. Suggest deletion only for those temporary files; preserve pre-existing inputs and inputs of unknown origin. |
| 2: cleanup shell wording is outside the intro check | Reject `exec_command` used as a session, shell or terminal name throughout every generated workflow. |
| 3: the negated-tool guard only matches one exact sentence | Check negations of read/shell tool tokens in source and rendered tool verbs without anchoring to an object noun. The third review further distinguishes tool names from lowercase shell names and covers intervening verbs. |
| 4: mnemonic recipe comments can become invalid input | End the first command block at `cat`, put Enter/Ctrl+D guidance in prose, and print the path in a separate block after the shell returns. Mnemonic parsing remains phrase-only. |
| Merge recovery and documentation nits | Explain that listed input errors leave the spec unchanged and earlier service merges remain; retry the failed service. Remove the stale builder-test count and move the naming convention to the shared workflow guidance. The third review corrects the distinction between token-expanded workflow fragments and raw host fragments. |
| Placeholder and ordering nits | Use `TEMP_ENV_INPUT_FILE` for the user cleanup placeholder and require the Bash-start instruction to precede the recipe commands. |

The [third review of cdfc626](https://github.com/manifest-network/manifest-agent-plugin/pull/24#issuecomment-5734090896)
found an env-paste hazard and remaining instruction/test gaps.

| Finding | Resolution |
| --- | --- |
| Medium: pasting the combined env block puts values in shell history or invalid input in the file | End capture at `cat`, enter KEY=VALUE data separately, and print the path only after Ctrl+D returns the prompt. Apply the same structure to the README. Stop authoring on `keys_merged: []`, retain the input and draft, and retry after private correction. |
| 1: negation guard rejects lowercase shell advice and misses "NOT use" | Keep tool names case-sensitive while accepting common negation casing, intervening verbs and hard line wraps. |
| 2: ordering guard rejects valid wording but accepts unrelated "first" | Require "before" the commands or recipe, allowing "these commands" and parenthetical examples. |
| 3: cleanup provenance lacks a concrete question and record | Ask whether the file came from the recipe, store `(service-name, env-file-path, recipe-created)` through merging, and preserve unknown or conflicting origins. Report retained input paths. |
| 4: mnemonic tests allow the sole data-entry paragraph to disappear | Require words-only input, no-prompt waiting, Enter/Ctrl+D, and returning-prompt instructions between the two command blocks on both hosts. |
| 5: contributor token advice incorrectly includes raw host fragments | Document token expansion for workflow sources/fragments and literal host tool names for raw `hosts/` fragments. |
| Nits | Clarify that labels are collected as non-sensitive chat pairs; describe waiting `cat` in both mnemonic recipes; document the limited shell-noun guard and the mnemonic-only privacy guard. The general renderer correction remains in ENG-1029. |

The [fourth review of fe284b2](https://github.com/manifest-network/manifest-agent-plugin/pull/24#issuecomment-5734768653)
confirmed the paste/history fix and identified recovery and coverage gaps.

| Finding | Resolution |
| --- | --- |
| 1: an empty env retry can target the last collected file or loop indefinitely | Supply a `cat` re-entry command with the affected service's recorded path as a shell-escaped literal, retaining its input record and origin flag. Offer continuation without file values or cancellation; retain and list skipped files, including shared paths. Base the final values recap on nonempty merges, not on the input mode originally selected. |
| 2: the origin question and cleanup rules can disappear without a test failure | Check both renders for the host question tool, all three origin choices, conservative flag defaults, the record carried into merging, the confirmed-only cleanup filter, completion of all associated merges, conflicting origins and retained-file reporting. |
| 3: contributor entry points omit the shell/tool naming rule | Link the convention from the workflow-editing paragraph and add a PR checklist item in `CONTRIBUTING.md`. |
| Origin and empty-input nits | Trigger the origin question after offering the recipe, without assuming how a supplied path was created. Exercise empty merges with and without an existing env map, documenting the helper's rewrite and `env: {}` insertion. |
| Other checked nits | Keep the Bash-order check in one sentence while accepting abbreviation examples; require "press Enter" before Ctrl+D; describe the renderer's full workflow scope; align README cleanup with completion of every service using the file. |

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
  input/instruction blocks. All 101 package, env and wallet workflow tests pass.
- Isolated source mutations confirmed that the recipe guidance test fails when
  its adjacent advice is removed or a capitalized shell name becomes
  `exec_command` in the Codex render.
  Seven further mutations were rejected: capitalized cleanup shell names in
  each workflow, three negated-tool wording variants, and inverted Bash timing.
- Third-review mutation checks reject combined env blocks, missing data-entry
  instructions, missing empty-input recovery, negations with intervening verbs,
  and after-the-commands timing with an unrelated "first". Positive controls
  accept lowercase shell negation, "before these commands", and an `e.g.`
  parenthetical example.
- Fourth-review fixtures execute recorded-path retries for two services on
  both hosts, preserving the other input and merging each service's own keys.
  Empty and comment-only inputs cover existing and absent env maps; the helper
  preserves existing values but rewrites the draft and adds `env: {}` if absent.
  Render guards cover the origin question, record handling, cleanup eligibility,
  retained inputs and retry/skip/cancel choices.
  Eighteen isolated regressions were rejected, including retrying through the
  last-file variable, omitted origin/cleanup rules, cross-sentence ordering
  and reversed Enter/Ctrl+D instructions. Both valid ordering controls passed.
- Both hosts' generated env commands create mode `0600` files, merge sample
  input through stdin, preserve private spec permissions, and emit no values.
  Cleanup fixtures remove both recipe-created paths despite a reassigned input
  variable, including paths with spaces, apostrophes and shell syntax. They
  merge supplied pre-existing and unknown-origin files and preserve their bytes
  through cleanup, executing no path-supplied commands. The fixture supplies
  file origins; it does not establish a model's provenance decisions.
- Both hosts' mnemonic fixtures execute the separated capture/path-display
  commands, preserving exactly the supplied words in mode `0600` files without
  instructional text or mnemonic output. Tests also require the data-entry
  paragraph between blocks; the env and README recipes use the same checks.
- Disposable Linux Bash 5.3.15 pseudoterminals reproduced the old env recipe's
  history leak with bracketed paste enabled, and swallowed `printf` input with
  it disabled. All 14 corrected cases (README and six generated recipes, each
  with bracketed paste enabled/disabled) preserved exact input at mode `0600`,
  printed the path, and left fixture values out of shell history. These were
  review-time checks, not native macOS or Windows acceptance.
- Removing only the broad `Bash` rewrite changes none of the current 14 Codex
  renders, confirming the independent builder follow-up's reproduction.
- The full Linux suite passed 1,001 tests with zero failures using
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
