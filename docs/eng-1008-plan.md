# ENG-1008: validate registry metadata before saving

[ENG-1008](https://linear.app/liftedinit/issue/ENG-1008) addresses successful
HTTP responses that contain unusable chain metadata and overwrite a working
cache. The fetcher keeps per-network failure handling and atomic writes;
`_chain-registry.cjs` owns extraction and `_chain-config.cjs` mirrors the
pinned consumer's validation predicates.

Status: PR review corrections implemented and verified on Linux with Node
24.15.0.

## Plan

1. Run the full malformed-input matrix in process and keep representative
   subprocess cases for each network failing independently and both failing.
   Assert stdout, status, network/field diagnostics, cached bytes and timestamp.
2. Validate startup-relevant fields against MCP core 0.22.0: chain-ID syntax,
   HTTPS endpoints with HTTP allowed only for localhost, optional REST when
   supplied, and finite nonnegative minimum prices with valid denominations
   for listed fee tokens. Normalize endpoint schemes to lowercase for CosmJS
   HTTP transport; preserve other endpoint bytes and first-entry selection.
3. Preserve partial-success exit 0, zero-save exit 1, and timestamp advancement
   only after at least one save. Keep optional asset-fetch failure and existing
   transport/write-failure behavior covered, including timestamp-write failure.
4. Check consumer-policy drift and persisted metadata against the installed
   MCP core in CI. Reject invalid legacy cached prices in both config writers
   and expand numeric exponents to decimal gas amounts.
5. Document the validation boundary, update the shared refresh workflow,
   regenerate skills and build the Codex package. Mark all four affected
   release-evidence rows pending without changing archived reports or hashes.
6. Run the focused regression suite, full Linux unit suite, package and policy
   checks, syntax checks, and available offline documentation/evidence checks.

## PR review corrections

The [review on PR #21](https://github.com/manifest-network/manifest-agent-plugin/pull/21#issuecomment-5720134186)
was checked against the installed `manifest-mcp-core` 0.22.0 validator and
CosmJS 0.32.4 transport selector. Remote HTTP, invalid REST, padded IDs and
`nullumfx` are rejected by that consumer; uppercase schemes change transport.

| Findings | Resolution |
| --- | --- |
| 1–4, 8: consumer policy and overlapping checks | Shared predicates, stricter registry spelling/shape checks, and installed-runtime parity CI covering endpoint, chain-ID and gas-price rules plus persisted configs. |
| 5: missing/null minimum gas price | Reject unusable listed fees before cache writes; protect both config writers from invalid legacy cached values. Decimal formatting also preserves the raw denom for small/large numeric prices. |
| 6: uppercase schemes | Lowercase only the scheme for RPC and REST; tests preserve the remaining bytes and verify HTTP transport selection. |
| 7: malformed fee-token shapes | Field-specific diagnostics for the fees object, token list, token entries, denominations and prices. |
| 9: stale follow-up documentation | Mark the working follow-up document implemented and link this plan; published v0.5.0 evidence stays unchanged. |
| 10: subprocess matrix cost | Full validation matrix runs in process; CLI cases fall from 140 to 35 while retaining independent mainnet/testnet/both failures and persistence assertions. The original PR passed all three CI jobs; the earlier local timeouts do not establish a CI failure. |

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
- `node --test tests/*.test.cjs` at CI's default concurrency: 896 passed,
  3 PowerShell checks skipped, 0 failures. This includes 100 pure registry
  cases and 35 registry CLI cases, plus predicate/parity and config-writer
  regressions. No test timeout or CI concurrency settings were changed.
- `node ci/chain-config-parity.cjs --data-dir <locked-runtime>`: 78 cases
  passed against installed MCP core 0.22.0, including cache serialization,
  gas composition and startup validation. Drift-injection tests passed.
- Skills generation, Codex build, all 14 generated-skill checks, policy
  completeness, CJS/Bash syntax and the generated Codex skill validator passed.
- Executable docs: 3 passed, 2 network examples skipped, 0 lint failures.
- Historical source/evidence checks passed, including all eight archived
  terminal reports. The release gate correctly remains `eligible=false`;
  no recorded source hashes or archived reports were changed.
- Plugin/dependency versions remain 0.5.0/0.22.0. Native macOS/Windows
  compatibility and fresh interactive/live-testnet acceptance are not
  established by these offline Linux checks.
