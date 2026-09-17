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
  and balance, with a faucet suggestion for low testnet funds. Startup never
  requests faucet funds automatically. Codex uses the same credential handling;
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

## Evidence and release checklist

- [x] Version manifests and lockfile agree at 0.5.0.
- [x] User and developer documentation audit completed; local examples and links checked.
- [ ] Fresh Claude and Codex terminal reports reviewed with cleanup verified.
- [ ] Current-install preservation, runtime repair and upgrade coverage recorded.
- [ ] Both hosts' live testnet lifecycle completed and resources cleaned up.
- [ ] Release rows reference the final source and pass strict provenance checks.
- [ ] Full local verification and PR CI pass.
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
