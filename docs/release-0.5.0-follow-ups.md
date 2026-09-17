# 0.5.0 review follow-ups

The [second PR review](https://github.com/manifest-network/manifest-agent-plugin/pull/20#issuecomment-5718411512)
separates its release-documentation blocker from the source changes below.
These items remain open after the documentation corrections and additional
builder guard tests. They were checked against reviewed source
`4bbd5af14c504ac280fc6dc8c14383c6fff6c832`; none is claimed fixed by the
current [release preparation](release-0.5.0.md).

Changing these runtime, workflow or builder files invalidates the current
release rows. Their implementation must include regression tests, generated
skill updates where applicable, and fresh acceptance evidence as described
in [host acceptance](host-acceptance.md#release-evidence).

## Include shell guidance in shipped secret-input recipes

Carry the README's Bash-first advice into the user-typed secret-file recipes
in `workflows/init-agent.md`, `workflows/import-key.md`, and
`workflows/author-manifest.md`. The repository's `CLAUDE.md` is contributor
guidance; plugin users need the caveat in the generated skills, which
currently present POSIX assignments without it.

Tell fish users to run `bash` in their separate terminal before the recipe
and remain in that shell through temporary-file cleanup. When updating these
workflows, regenerate both hosts' skills and verify that all three recipes
include the advice alongside the commands the user is asked to type.

## Preserve reinitialization settings and clarify import recovery

[init-agent](../workflows/init-agent.md) replaces configuration through
[write-config.cjs](../scripts/write-config.cjs), which omits `gasMultiplier`.
Reinitializing an existing configuration therefore resets a custom multiplier to
the runtime default of 1.5. The README and developer guide now disclose this;
record the previous value before reinitializing and set it again afterward.

The follow-up should capture the previous multiplier and restore it after a
successful reinitialization, with the same checked partial-result handling
used by [import-key](../workflows/import-key.md). Test custom integer and
fractional values, no explicit value, and restoration failure without a
second wallet import or creation.

The import workflow already checks restoration, but its journal sketch
still shows an unconditional `success` and empty `errors`. Update that
sketch to represent both successful and partial outcomes, using structured
errors with `class` and `message`. Clarify that a failed restoration retains
the old value in memory for recovery, not in the newly written config; the
completion report must describe the actual final settings.

## Reject unusable registry chain metadata before saving it

[fetch-chain-registry.cjs](../scripts/fetch-chain-registry.cjs) currently
accepts a successful JSON response containing `{}`. An offline fixture
reproduced exit 0, both networks in stdout, overwritten good cache files
without `chainId` or `rpcUrl`, and an advanced fetch timestamp.

Validate a nonempty chain ID and usable RPC address before the atomic write.
Malformed metadata should count as a failed network, preserve that network's
cached bytes, and follow the existing partial/zero-save status contract.
Test malformed JSON shapes independently for each network, both networks,
and a valid control; verify stdout, diagnostics, files and timestamp.

Until that validation lands, a successful save is not a complete shape check.
Inspect the saved chain ID and RPC URL when diagnosing a subsequent launcher
failure; refetch corrected registry metadata before trying to start servers.

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
All 13 builder tests pass. Removing either existing guard from a scratch copy
makes its new regression fail. Those tests do not claim to fix the separate
fragment-name collision above.
