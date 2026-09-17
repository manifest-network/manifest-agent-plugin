# ENG-1009: preserve gas settings during wallet replacement

[ENG-1009](https://linear.app/liftedinit/issue/ENG-1009) fixes the loss of a
custom gas multiplier when either `init-agent` wallet path replaces config,
and makes incomplete multiplier restoration visible in reports and journals.

Status: implemented and verified on Linux with Node 24.15.0. Both workflows
render the shared restoration fragment into the Claude and Codex skills; the
existing config-writer contract and credential handling remain unchanged.

## Plan

1. Capture the previous multiplier through the safe status command before
   generating or importing a wallet. Preserve explicit integer and fractional
   values; absent/null values continue to use the runtime default of `1.5`.
2. Share the checked restoration and final-status instructions between
   `init-agent` and `import-key`. Restore only after the config write succeeds.
   Recovery retries only the gas update; it never creates or imports another
   wallet. Keep the requested value in workflow memory until recovery finishes.
3. Report the settings actually saved, including the default after a failed
   restoration. Use `partial` outcomes and structured errors with `class` and
   `message`; a failed status read leaves the final settings unknown.
4. Execute the generated commands for both hosts with disposable wallet
   fixtures, real config writers and journals. Cover successful preservation,
   defaults, failed restoration, and recovery with unchanged wallet identity.
5. Regenerate the Claude skills and native Codex package, update user and
   developer guidance, and run the focused regressions plus required Linux
   package, unit, policy, syntax and offline documentation/evidence checks.

## Release boundary

The plugin and dependency versions remain unchanged. Published v0.5.0 reports
and source hashes stay intact; all four host release rows are already pending.
Fresh source-bound host and live-testnet acceptance is required before the next
release under [the release policy](host-acceptance.md#release-evidence).
Offline Linux command tests do not establish model behavior in an interactive
host or native macOS/Windows compatibility.

## Validation results

- Before the fix, the generated `init-agent` commands lost custom values `2`
  and `2.25`: final status returned null, and no restoration command existed.
- The focused config/workflow/package suite passed all 80 tests. It includes
  40 command scenarios across both hosts and all three wallet paths, covering
  successful/default settings, partial journals, unknown final settings and
  recovery with unchanged wallet calls, keyfiles and credential entries.
- The full Linux suite passed 941 tests with 0 failures; 3 PowerShell syntax
  checks were skipped because PowerShell is unavailable locally.
- Claude skill generation, Codex package generation, all 14 generated-skill
  checks, the changed Codex skills' frontmatter validation, policy completeness,
  CJS/Bash syntax and `git diff --check` passed.
- Executable documentation checks passed: 3 ran, 2 network examples skipped,
  0 failures and 0 lint failures. The locked runtime was installed in a fresh
  `/var/tmp` directory after `/tmp` lacked space; the incomplete install was
  removed without changing an existing runtime.
- Historical evidence/source checks passed, including all eight archived
  terminal reports. Release eligibility remains `false` with all four host
  rows pending; no archived reports, source hashes or package versions changed.

The command driver supplies the workflow choices and journal values. These
tests verify executable commands and the record contract, not model decisions
or final prose. Native macOS/Windows behavior and fresh interactive/live-testnet
acceptance remain outside this offline Linux validation.
