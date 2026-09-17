# 0.5.0 release preparation

This is the release candidate checklist and draft notes. Version 0.5.0 is
already set in the three manifests and lockfile. Publication happens only
after the preparation PR is merged, CI is green on `main`, and the release
tag is pushed as described in [release.md](release.md).

## Draft release notes

- Wallet passwords move out of `config.json` into a native credential store.
  Legacy migration verifies the stored credential before removing plaintext.
  Headless environments without a keychain must explicitly select the private
  file fallback. See [identity setup and recovery](identity.md) before upgrading.
- New Claude sessions receive the agent address, selected chain, gas denom
  and balance when the chain query succeeds, with a faucet suggestion for low
  testnet funds. Startup never requests faucet funds automatically. Codex uses
  the same credential handling;
  its manual identity-report command is documented in the identity guide.
- Authoring and deployment validate supplied SHA-256 image references and
  preserve them exactly. Mutable tags require an explicit choice during
  authoring. Automatic registry resolution remains blocked on the upstream
  contract tracked by [ENG-954](https://linear.app/liftedinit/issue/ENG-954).
- Documentation has been reviewed against the shipped helpers, shared
  workflows, pinned MCP contracts, CI and release configuration.
- Host Write staging uses new files inside private temporary directories.
  All journal-writing workflows share that sequence, preserving literal JSON
  and the journal writer's failure status through cleanup.
- Registry output reports only successfully saved networks. Setup and chain
  switching require fresh metadata for the chosen network, and config updates
  reject an active chain without metadata. Key import preserves a previously
  configured gas multiplier and reports restoration failures as partial results.

Node 22.19.0 or later is required. The MCP runtime remains pinned to 0.22.0.
Native macOS Keychain and Windows Credential Manager/ACL acceptance is
untested because those platforms are unavailable. Linux CLI evidence does
not establish GUI behavior or native acceptance on other operating systems.

Fresh Linux [terminal and app-server reports](host-acceptance.md) and
[native upgrade/preservation checks](current-install-acceptance-0.5.0.md) bind
reviewed source `4bbd5af14c504ac280fc6dc8c14383c6fff6c832`. Both hosts
migrated legacy 0.4.0 plaintext credentials using the explicit file backend,
retained the original encrypted wallets and saved records, and passed native
reinstall and automatic dependency repair. Version transition used native
remove/install under the same plugin identity, not marketplace update-in-place
or cross-machine migration.

The reviewed preservation run used a warmed npm cache and needed no manual
chain reconnect. The earlier 0.5.0 report retains its cold-start MCP timeout
and native Reconnect observation. Both hosts' terminal progress/cancellation
limitations remain documented. A separate
[native Claude Write check](host-evidence/claude-native-write-0.5.0-reviewed.json)
reproduced the pre-created-file failure and verified the private-directory fix;
it tests actual Write semantics in print mode, not full skill execution.

The fresh [live testnet replay](live-testnet-acceptance-0.5.0.md) passed all
11 checks per host. Both leases closed, domains were cleared, and local keys,
profiles and caches were removed after the private-value scan. The replay
required runtime bootstrap and native Claude reconnect recovery; one read-only
Codex troubleshooting argument typo was corrected in a separate call.

The strict source-matched release gate passed, including archived app-server
provenance, current source equality, both hosts' release rows and Codex archive
eligibility. The separate Codex release-status CLI reported `eligible=true`.
This does not replace merging the PR, green CI on the commit to tag, or release
artifact verification after publication. The
[reviewed validation report](host-evidence/release-validation-0.5.0-reviewed.json)
records 749 local test passes, three PowerShell skips, all five executable
documentation examples, and installed contract checks. PR CI at `4bbd5af`
passed all 752 tests with zero skips on Node 22.19.0 and Node 24.

The reviewed [switch-chain workflow](../workflows/switch-chain.md) stops if the
chosen network is missing from the fresh registry result. Partial registry
success explicitly reports saved and failed networks; zero successful saves
exits nonzero and preserves the previous fetch timestamp. The lower-level
config helper still permits valid cached metadata when invoked directly.
Regression fixtures cover these failure paths; acceptance does not exercise
a live chain switch.

## Evidence and release checklist

- [x] Version manifests and lockfile agree at 0.5.0.
- [x] User and developer documentation audit completed; local examples and links checked.
- [x] Fresh Claude and Codex terminal reports reviewed with cleanup verified.
- [x] Fresh Codex app-server fixture report verified against the final source.
- [x] Current-install preservation, runtime repair and upgrade coverage recorded.
- [x] Both hosts' live testnet lifecycle completed and resources cleaned up.
- [x] Release rows reference the final runtime/workflow source and pass strict provenance checks; Codex archive is eligible.
- [x] Full local verification passed; required PR CI checks run on the reviewed commit.
- [ ] Preparation PR merged and CI green on the commit to tag.
- [ ] Tag published and expected release artifacts verified.

The machine-readable release gate is [host-acceptance-release.json](host-acceptance-release.json).
Historical 0.4.0 reports remain unchanged; only fresh measurements can complete
the 0.5.0 rows.

## Documentation review scope

The audit covers README installation, data storage and recovery, every shared
workflow and its generated skills, the host-specific restart fragments, the
script inventory and architecture guide, contribution and testing commands,
approval boundaries, release instructions, and the scope of historical
implementation and acceptance records. Review includes local link resolution,
executable examples, package generation and policy parity. Historical reports
retain their original source hashes and observed limitations.
