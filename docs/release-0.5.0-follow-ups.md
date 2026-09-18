# 0.5.0 review follow-ups

The [second PR review](https://github.com/manifest-network/manifest-agent-plugin/pull/20#issuecomment-5718411512)
separates its release-documentation blocker from the source changes below.
These items were open after the documentation corrections and additional
builder guard tests; status notes below identify subsequent fixes. They were checked against reviewed source
`4bbd5af14c504ac280fc6dc8c14383c6fff6c832`; none is claimed fixed by the
current [release preparation](release-0.5.0.md).

Changing these runtime, workflow or builder files invalidates the current
release rows. Their implementation must include regression tests, generated
skill updates where applicable, and fresh acceptance evidence as described
in [host acceptance](host-acceptance.md#release-evidence).

## Include shell guidance in shipped secret-input recipes

Status: implemented in [ENG-1010](eng-1010-plan.md). Release acceptance for the
changed source is still pending; published v0.5.0 evidence stays unchanged.

The v0.5.0 generated skills presented POSIX assignments without the Bash
guidance in the README and contributor-only `CLAUDE.md`. The user-typed
secret-file recipes in `workflows/init-agent.md`, `workflows/import-key.md`
and `workflows/author-manifest.md` now tell fish users to run `bash` in their
separate terminal before the recipe and remain in that shell through
temporary-file cleanup. Both hosts' generated skills carry the advice beside
the commands. Review corrections clarify mnemonic privacy and Ctrl+D input,
and clean up every confirmed recipe-created env file after repeated recipes,
preserving pre-existing inputs and files of unknown origin. Both mnemonic
and env entry end the shell block at `cat`, keep private data entry and
Ctrl+D instructions in prose, and print the path after the shell prompt
returns. Authoring records explicit file-origin confirmation and pauses on an
empty env merge to offer retry at the recorded path, continuation without
file values, or cancellation. Skipped inputs are retained and listed. Rendering
and command regressions cover both hosts. The builder's broad tool-name
rewrite is tracked separately in [ENG-1029](https://linear.app/liftedinit/issue/ENG-1029).

## Preserve reinitialization settings and clarify import recovery

Status: implemented in [ENG-1009](eng-1009-plan.md), including the PR review's
atomic-preservation and journal corrections. Release acceptance for the changed
source is still pending; published v0.5.0 evidence stays unchanged.

The v0.5.0 [init-agent](../workflows/init-agent.md) workflow replaced config
through [write-config.cjs](../scripts/write-config.cjs) without restoring a
custom `gasMultiplier`, so reinitialization reverted to the runtime default
`1.5`. The writer now preserves the previous non-null multiplier under its lock
in the same atomic config write. Both wallet paths use the same final-status
instructions as [import-key](../workflows/import-key.md).

Both journal sketches distinguish successful and partial outcomes with
structured `class`/`message` errors. A failed status read retains the confirmed
address and chain and marks only the gas fields unknown. Recovery retries only
status and never creates or imports a second wallet. Generated-command and
writer regressions cover integers, fractions, numeric strings, absent/null
values, interruptions, write failure, verification recovery and cancellation.
They do not establish interactive model behavior.

## Reject unusable registry chain metadata before saving it

Status: implemented in [ENG-1008](eng-1008-plan.md), including the PR review's
consumer-policy, REST, chain-ID and fee-token corrections. Release acceptance
for the changed source is still pending.

The v0.5.0 [fetch-chain-registry.cjs](../scripts/fetch-chain-registry.cjs)
accepted a successful JSON response containing `{}`. An offline fixture
reproduced exit 0, both networks in stdout, overwritten good cache files
without `chainId` or `rpcUrl`, and an advanced fetch timestamp.

The fetcher now validates startup-relevant metadata before atomic writes,
retains failed networks' cached bytes, and preserves the partial/zero-save
contract. Endpoint schemes are normalized for the pinned transport. Offline
tests cover validation and persistence; an installed-runtime parity check
guards drift from the pinned consumer. See the plan for current checks and
the remaining host acceptance requirements.

## Make config-update recovery diagnostics actionable

Two offline fixtures reproduce the current behavior of
[update-config.cjs](../scripts/update-config.cjs):

- With no `activeChain`, `--refresh-chains` refuses the update but recommends
  another refresh, which cannot select a chain. The diagnostic should request
  `--chain testnet` or `--chain mainnet` with the appropriate refresh.
- With metadata only in `config.chains`, `--chain testnet` succeeds, while
  adding `--gas-token MFX` fails because symbol resolution reads the selected
  network's file under `chains/`. A refresh only merges existing files; it
  does not download a missing file.

The [script guide](scripts.md) now distinguishes these data sources. The
follow-up should correct the recovery messages and make an explicit decision
about retaining or changing the gas-token disk-file requirement. Tests must
verify refused updates preserve config bytes and release the config lock,
and that following the suggested remedy succeeds.

## Reject collisions between normalized fragment names

The [builder](../ci/build-packages.cjs) maps both `journal-write.md` and
`journal_write.md` to `journal_write`. A scratch fixture reproduced silent
replacement by the underscore-named fragment for both hosts before the
existing built-in-token guard runs.

Detect duplicate normalized fragment names before building the fragment
object. Report the token and both filenames, reject duplicates even when a
workflow does not use the token, and keep the built-in vocabulary collision
guard. Test both hosts, reversed file naming/order where relevant, and a
noncolliding control.

The existing built-in collision and unresolved-fragment guards now have
dedicated regression tests in [build-packages.test.cjs](../tests/build-packages.test.cjs).
The builder regression tests pass. Removing either existing guard from a scratch copy
makes its new regression fail. Those tests do not claim to fix the separate
fragment-name collision above.
