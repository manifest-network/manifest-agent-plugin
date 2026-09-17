# ENG-1008: validate registry metadata before saving

[ENG-1008](https://linear.app/liftedinit/issue/ENG-1008) addresses successful
HTTP responses that contain unusable chain metadata and overwrite a working
cache. The implementation stays in `scripts/fetch-chain-registry.cjs` and
uses the existing per-network failure handling and atomic writes.

Status: implemented and verified locally on Linux with Node 24.15.0.

## Plan

1. Extend the offline network-boundary fixture to supply arbitrary JSON chain
   responses. Reproduce invalid response shapes, chain IDs and RPC addresses
   with each network failing independently and both failing together. Assert
   stdout, status, network/field diagnostics, cached bytes and fetch timestamp.
2. Validate a non-null JSON object, a nonblank string `chain_id`, and an
   absolute HTTP(S) `apis.rpc[0].address` with a hostname before extraction and
   writing. Preserve valid values and first-RPC selection; do not probe the
   endpoint or select a different entry when the first entry is invalid.
3. Preserve partial-success exit 0, zero-save exit 1, and timestamp advancement
   only after at least one save. Keep optional asset-fetch failure and existing
   transport/write-failure behavior covered, including timestamp-write failure.
4. Document the validation boundary, update the shared refresh workflow,
   regenerate skills and build the Codex package. Mark all four affected
   release-evidence rows pending without changing archived reports or hashes.
5. Run the focused regression suite, full Linux unit suite, package and policy
   checks, syntax checks, and available offline documentation/evidence checks.

## Release boundary

This fix does not bump the plugin or dependency versions. Published v0.5.0
reports remain evidence for their recorded source. Fresh source-bound host
and live-testnet acceptance is required before the next release, as described
in [the release policy](host-acceptance.md#release-evidence). Offline Linux
regressions require no transactions and do not establish native macOS or
Windows compatibility.

## Validation results

- The empty-object regression failed before the fix: both networks were
  written and the process exited 0 instead of 1.
- `node --test tests/fetch-chain-registry.test.cjs`: 140 passed.
- `node --test --test-concurrency=4 tests/*.test.cjs`: 885 passed, 3 skipped,
  0 failed. The skips require unavailable PowerShell. The first full run at
  default concurrency hit seven subprocess timeouts in the existing
  SessionStart tests; all 50 SessionStart tests passed in isolation before
  the complete run passed with four test files at a time.
- `npm run build:skills`, `npm run build:codex`, `npm run test:packages`,
  and `npm run test:policy-completeness`: passed. The generated Codex
  package contains the updated registry script.
- CJS/Bash syntax, manifest versions, tracked JSON and `git diff --check`:
  passed. Plugin version remains 0.5.0 and MCP remains 0.22.0.
- The skill-creator validator passed for the generated Codex skill. Its
  generic schema does not accept Claude's existing `disable-model-invocation`
  field; the repository's own generated-skill check passed for all 14 skills.
- Executable docs with the existing temporary runtime's verified locked
  dependencies: 3 passed, 2 network examples skipped, 0 lint failures.
- Offline evidence checks verified the historical source commits, including
  all eight archived terminal reports. `--codex-release-status` returned
  `eligible=false` because fresh acceptance is pending. Archived reports and
  recorded source hashes are unchanged.
