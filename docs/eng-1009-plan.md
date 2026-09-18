# ENG-1009: preserve gas settings during wallet replacement

[ENG-1009](https://linear.app/liftedinit/issue/ENG-1009) fixes the loss of a
custom gas multiplier when either `init-agent` wallet path replaces config,
and makes incomplete final-status verification visible in reports and journals.

Status: PR review corrections implemented and verified on Linux with Node 24.15.0. The
writer preserves the multiplier atomically with the wallet; both hosts share
the final-status verification instructions.

## Plan

1. Carry the previous non-null multiplier forward inside `write-config.cjs`'s
   config lock and atomic write. Preserve its value and type, including numeric
   strings in hand-edited config; absent/null keeps the runtime default `1.5`.
2. Share a final-status read between `init-agent` and `import-key`, removing the
   separate restoration command and reliance on model memory. An interrupted
   run or later invocation must find the preserved multiplier on disk.
3. Report the settings actually observed. Failed verification produces a
   `partial` outcome and one structured `config_status_failed` error, retaining
   the writer-confirmed address/chain and marking only gas settings unknown.
   Recovery retries only status. Cancellation uses the previous identity or
   null when no status was observed.
4. Execute the generated commands for both hosts with disposable wallet
   fixtures, real config writers and journals. Cover successful preservation,
   defaults, interruption, failed writes, status recovery and cancellation.
5. Regenerate the Claude skills and native Codex package, update user and
   developer guidance, and run the focused regressions plus required Linux
   package, unit, policy, syntax and offline documentation/evidence checks.

## PR review corrections

The [review on PR #22](https://github.com/manifest-network/manifest-agent-plugin/pull/22#issuecomment-5721018953)
identified a real interruption gap in the separate restoration design. The
writer already reads the previous config under its lock, so preservation now
occurs in that same atomic write instead of a second workflow mutation.

| Finding | Resolution |
| --- | --- |
| 1–2: preservation in prose and loss on interruption/rerun | Preserve in the writer; test the saved bytes immediately after writing and a new invocation without prior-run memory. Failure at atomic rename retains the previous wallet and multiplier together. |
| 3: unknown chain/address after failed status | Keep the successful writer's identity, mark only gas fields unknown, and check the journal's chain/signer contract. |
| 4: contributor-only fragment header in prompts | Replace the restoration fragment with a smaller verification fragment without a developer header. |
| Duplicate classification, repeated restoration rules, funding advice and numeric-string mismatches | Remove the restoration protocol. Preserve numeric-string types and report the safe status value without comparing it against a coerced value. Funding guidance stays in init-agent only. |
| Cancellation signer and brittle command tests | Set the previous signer/chain or null before journaling cancellation. Execute no follow-up mutation and require final status to follow both wallet pipelines. |

## Release boundary

The plugin and dependency versions remain unchanged. Published v0.5.0 reports
and source hashes stay intact; all four host release rows are already pending.
Fresh source-bound host and live-testnet acceptance is required before the next
release under [the release policy](host-acceptance.md#release-evidence).
Offline Linux command tests do not establish model behavior in an interactive
host or native macOS/Windows compatibility.

## Validation results

- Before the writer change, regressions for `2`, `2.25`, `"2"`, legacy
  migration and successful retry after an injected write failure reproduced
  the lost multiplier. Those cases now pass without a restoration command.
- The revised focused config/workflow/package suite passed all 100 tests,
  including 54 generated-command scenarios across six host/wallet combinations.
- The full Linux suite passed 961 tests with 0 failures; 3 PowerShell syntax
  checks were skipped because PowerShell is unavailable locally.
- Claude skill generation, Codex package generation, all 14 generated-skill
  checks, changed Codex skills' frontmatter validation, policy completeness,
  CJS/Bash syntax and `git diff --check` passed.
- Executable documentation checks passed: 3 ran, 2 network examples skipped,
  0 failures and 0 lint failures, using an isolated locked runtime.
- Historical evidence/source checks passed, including all eight archived
  terminal reports. Release eligibility remains `false` with all four host
  rows pending; no archived reports, source hashes or package versions changed.

The command driver supplies the workflow choices and journal values. These
tests verify executable commands and the record contract, not model decisions
or final prose. Native macOS/Windows behavior and fresh interactive/live-testnet
acceptance remain outside this offline Linux validation.
