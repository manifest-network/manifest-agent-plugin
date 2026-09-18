# ENG-1011: actionable config-update recovery

[ENG-1011](https://linear.app/liftedinit/issue/ENG-1011) fixes recovery advice
for a missing active chain and missing registry files during gas-token selection.

Status: implemented and verified on Linux with Node 24.15.0.

## Plan

1. Require explicit `--chain testnet` or `--chain mainnet` when a chain-dependent
   update has no valid active chain. Explain when to include `--refresh-chains`.
2. Retain the gas-token disk-file requirement. Resolve symbols and minimum
   prices from `chains/<network>.json`, with no fallback to potentially older
   `config.chains` data. Missing-file recovery runs `fetch-chain-registry.cjs`,
   verifies the selected network was saved, then retries the original update
   with explicit chain selection and `--refresh-chains`. Refresh only merges
   existing files; it never downloads them.
3. Stage and validate changes under the config lock before credential migration.
   Refused updates must preserve config bytes, including legacy credentials,
   and release the lock. Successful updates retain migration and atomic writes.
4. Reproduce both reported cases in subprocess fixtures. Execute the advised
   remedies using the real fetcher with only its network boundary stubbed,
   covering both networks, partial fetches and retained gas/wallet settings.
5. Update the script guide and affected shared workflows, regenerate Claude
   skills, build the Codex package, and run focused regressions plus required
   Linux package, unit, policy, syntax and available offline evidence/doc checks.

## Release boundary

Plugin and dependency versions stay unchanged. Published v0.5.0 reports and
source hashes remain intact; all four host release rows are already pending.
Fresh source-bound host and live-testnet acceptance is required before the next
release under [the release policy](host-acceptance.md#release-evidence).
Linux fixtures do not establish interactive model behavior or native
macOS/Windows compatibility.

## Validation results

- Before the fix, nine new regression cases failed on the ineffective recovery
  messages or the premature legacy migration. The focused config suite now
  passes all 47 tests, including executed remedies and partial-fetch refusal.
- The full Linux suite passed 971 tests with zero failures; three PowerShell
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
