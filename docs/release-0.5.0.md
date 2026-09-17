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

Node 22.19.0 or later is required. The MCP runtime remains pinned to 0.22.0.
Native macOS Keychain and Windows Credential Manager/ACL acceptance is
untested because those platforms are unavailable. Linux CLI evidence does
not establish GUI behavior or native acceptance on other operating systems.

Fresh Linux [terminal and app-server reports](host-acceptance.md) and
[native upgrade/preservation checks](current-install-acceptance-0.5.0.md) bind
source `c6fcc5656349edb8599febae9f20df988d503df8`. Both hosts migrated legacy
0.4.0 plaintext credentials using the explicit file backend, retained the
original encrypted wallets and saved records, and passed native reinstall
and automatic dependency repair. This is a native remove/install version
transition, not marketplace update-in-place or cross-machine migration.

The first upgraded Claude session exceeded the native 30-second MCP
connection timeout. After setup finished, a fresh session still needed
`/mcp` → `manifest-chain` → `Reconnect`; the read-only probe then passed.
The report retains this cold-start limitation and the existing terminal
progress/cancellation limitations. Both hosts also completed all eleven
[live testnet checks](live-testnet-acceptance-0.5.0.md). Temporary leases and
domains were cleaned up, hosts stopped, and isolated wallet/profile data
removed after the archive passed its secret scan. The
[local validation report](host-evidence/release-validation-0.5.0.json) records
734 passing tests and all five passing executable documentation examples.

Known follow-up: `switch-chain` attempts a registry refresh, but a failed or
partial fetch can leave cached target-chain metadata in place and does not
always abort the switch. Inspect the fetch diagnostic and the target chain's
metadata before switching after a fetch failure. The
[refresh-registry workflow](../workflows/refresh-registry.md) describes partial
refresh handling; aligning `switch-chain` with those checks remains follow-up
work. This release acceptance did not exercise a live chain switch.

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
