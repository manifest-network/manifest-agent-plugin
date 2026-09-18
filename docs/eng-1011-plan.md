# ENG-1011: actionable config-update recovery

[ENG-1011](https://linear.app/liftedinit/issue/ENG-1011) fixes recovery advice
for a missing active chain and missing registry files during gas-token selection.

Status: PR review corrections implemented and verified on Linux with Node
24.15.0.

## Plan

1. Require explicit user selection through `switch-chain`, including mainnet
   confirmation, when a chain-dependent update has no valid active chain.
   Existing local metadata can be merged with `--refresh-chains` offline.
2. Retain the gas-token disk-file requirement. Resolve symbols and minimum
   prices from `chains/<network>.json`, with no fallback to potentially older
   `config.chains` data. Synchronize config before presenting token choices;
   refuse a token update when disk metadata differs from that config snapshot.
   Missing/malformed files route to `refresh-registry`, with equivalent CLI
   fetch/verify/merge instructions. Review refreshed choices before retrying
   gas options. Refresh only merges existing files; it never downloads them.
3. Stage and validate changes under the config lock before credential migration.
   Refused updates must preserve config bytes, including legacy credentials,
   and release the lock. Successful updates retain migration and atomic writes.
4. Reproduce both reported cases in subprocess fixtures. Execute the advised
   remedies using the real fetcher with only its network boundary stubbed,
   covering both networks, partial fetches and retained gas/wallet settings.
   Execute both hosts' generated gas commands with changed registry prices.
5. Update the script guide and affected shared workflows, regenerate Claude
   skills, build the Codex package, and run focused regressions plus required
   Linux package, unit, policy, syntax and available offline evidence/doc checks.

## PR review corrections

The [review of 72e11ea](https://github.com/manifest-network/manifest-agent-plugin/pull/23#issuecomment-5730800649)
was checked against the scripts and reproduced with disposable fixtures.

| Finding | Resolution |
| --- | --- |
| 1, 5, 9: ineffective or conflicting recovery | Valid local files get an offline merge remedy; missing or malformed files name `refresh-registry` and its CLI equivalent. Fetch success must include the affected network, and repair keeps the previously selected active chain. |
| 2: displayed and written minimum prices differ | The generated token picker first synchronizes metadata. Token updates reject stale config metadata; fixtures verify both hosts' displayed and saved prices and refusal after a later disk change. Merging only at the final write would leave the earlier prompt stale. |
| 3: nonobject chain maps are spread into config | Refuse supplied nonobject maps before migration or writes; an absent map can still be initialized from valid files. |
| 4: chain-selection advice bypasses the user choice | Missing-chain diagnostics route through explicit user selection and the workflow's mainnet confirmation, rather than offering a concrete mainnet retry. |
| 6, 7: incomplete module stub and duplicate registry reads | Mark the network stub loaded; memoize each registry read so a combined gas/refresh update uses one snapshot. |
| 8: repeated migration reads | Keep the migration helper's independent config read and raw-byte fingerprint. Passing caller-owned config would broaden the shared credential API for a small local read optimization; the fingerprint also serves the native-store failure cooldown. |
| 10: repeated network literals | Share the frozen plugin `NETWORKS` list across both config writers and session identity. |
| 11: unused recovery strings | Render recovery text only when the relevant error is raised, after validating the selected network. |

## Release boundary

Plugin and dependency versions stay unchanged. Published v0.5.0 reports and
source hashes remain intact; all four host release rows are already pending.
Fresh source-bound host and live-testnet acceptance is required before the next
release under [the release policy](host-acceptance.md#release-evidence).
Linux fixtures do not establish interactive model behavior or native
macOS/Windows compatibility.

## Validation results

- Review regressions reproduced the ineffective offline remedy, stale gas
  price, malformed-map/file and duplicate-read problems on `72e11ea`.
  The revised config and generated-workflow cases pass, including actual
  remedy execution and refusal of a disk change after token choices are shown.
- The full Linux suite passed 984 tests with zero failures; three PowerShell
  checks were skipped because `pwsh` is unavailable locally.
- Generated skills, Codex packaging, policy completeness, CJS/shell syntax,
  version consistency and diff whitespace checks passed. The skill-creator
  validator accepted both affected generated Codex skills; Claude frontmatter
  is checked by the repository builder.
- An isolated offline install of the locked runtime passed all three local
  executable documentation examples (two network examples skipped), 78 config
  parity cases, the five-server tool policy, both host launcher inventories,
  25 workflow tool references and six callback contract cases.
- Archived evidence and host-acceptance provenance checks passed with Git
  history required. Historical reports and all four pending release rows
  remain unchanged.
