# 0.5.1 release preparation

Patch release of the four reliability fixes merged after v0.5.0. Node
22.19.0 or later is required; the MCP runtime remains pinned to 0.22.0.

## Release notes

- Registry refresh validates chain IDs, endpoints and gas-token metadata
  before replacing cached files. Failed refreshes preserve usable cached
  metadata and report partial results accurately. ([ENG-1008](https://linear.app/liftedinit/issue/ENG-1008))
- Wallet replacement preserves custom gas settings atomically. Onboarding
  and key import verify the saved configuration and report incomplete
  verification as a partial result. ([ENG-1009](https://linear.app/liftedinit/issue/ENG-1009))
- Config-update diagnostics give actionable recovery steps, and gas-token
  selection uses the refreshed registry data consistently.
  ([ENG-1011](https://linear.app/liftedinit/issue/ENG-1011))
- Secret-file recipes explain Bash setup and separate private data entry
  from shell commands. Env recovery uses the recorded service path, preserves
  supplied files and offers cleanup only for eligible temporary inputs.
  ([ENG-1010](https://linear.app/liftedinit/issue/ENG-1010))

## Release checklist

- [x] Three version manifests and lockfile root agree at 0.5.1.
- [ ] Automated tests, installed contracts and documentation examples pass.
- [ ] Fresh Claude and Codex terminal evidence reviewed; cleanup verified.
- [ ] Upgrade, reinstall, saved-state preservation and runtime repair verified.
- [ ] Both hosts' live-testnet lifecycle passes; temporary resources removed.
- [ ] Current-source release evidence passes the strict gate; Codex archive eligible.
- [ ] Preparation changes merged and CI green on the commit to tag.
- [ ] v0.5.1 published; archive contents and distribution source verified.

Published v0.5.0 evidence remains historical. Fresh acceptance must reference
the 0.5.1 candidate's source and version. Linux CLI evidence does not establish
GUI behavior or native macOS/Windows credential-store compatibility.

The renderer token contract ([ENG-1029](https://linear.app/liftedinit/issue/ENG-1029)),
scripted env-input ledger ([ENG-1045](https://linear.app/liftedinit/issue/ENG-1045))
and normalized-fragment collision guard remain separate follow-ups.
