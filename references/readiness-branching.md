# Readiness branching (post-`evaluate-readiness.cjs`)

This file is loaded by `skills/author-manifest/SKILL.md` Step 4 and
`skills/deploy-app/SKILL.md` Step 5 after the readiness evaluator runs.
Single source of truth for the `status` branch handling — both skills
need the same logic and a free-form cross-skill cite ("the same way
author-manifest does it") was brittle to rewordings. Lives at the
plugin root (`references/`) rather than under any single skill so
neither consumer "owns" it; both load it as a shared dependency.

## Variables in scope

The orchestrator must have these in scope before loading this file:

- `<activeChain>` — `"testnet"` or `"mainnet"`, derived from
  `update-config.cjs --status` earlier in the skill. Used in the
  `--chain-data-file` path passed to `humanize-fee.cjs`.
- `<amount>` — user-supplied fund amount string (e.g. `"10000000umfx"`).
  Collected via `AskUserQuestion` when the `fund_credit` action is
  picked; passed unchanged to both `cosmos_estimate_fee` and
  `fund_credit`.
- `READINESS` — the JSON `{ status, reasons, suggested_actions }`
  printed by `evaluate-readiness.cjs` immediately before this file
  loads. Branching below keys off `READINESS.status`.

## Per-skill recovery overrides

The `pick_different_sku` action's "return to the SKU pick step" recovery
differs by consumer:

- **`/manifest-agent:author-manifest`**: return to Step 2 (the SKU pick
  step in the authoring flow).
- **`/manifest-agent:deploy-app`**: SKU rejection is terminal — the SKU
  is supplied as input (CLI argument or spec field), not via a pick
  step. Surface the rejection and stop.

## Branches

`evaluate-readiness.cjs` prints `{ status, reasons, suggested_actions }`.
Branch on `status`:

- **`block`** — print the `reasons` to the user and stop. If
  `suggested_actions` includes `pick_different_sku`, return to the SKU
  pick step (the user may pick a different SKU and retry); otherwise
  stop entirely.

- **`warn`** — present `reasons` to the user. Use `AskUserQuestion` to
  ask what to do, with options derived from `suggested_actions`:

    - `fund_credit` → "Fund credits and continue". When the user picks
      this, ask them how much to fund (e.g. `"10000000umfx"`). Then —
      per the runtime policy — estimate the tx fee BEFORE broadcasting:

      ```
      mcp__manifest-chain__cosmos_estimate_fee({
        module: "billing",
        subcommand: "fund-credit",
        args: ["<amount>"]   // same string you'll pass to fund_credit
      })
      ```

      Compute the human-readable fee string with `humanize-fee.cjs`
      (do NOT inline the math):

      ```bash
      node "$MANIFEST_PLUGIN_ROOT/scripts/humanize-fee.cjs" \
        --chain-data-file "$MANIFEST_PLUGIN_DATA/chains/<activeChain>.json" \
        --fee-json '<ESTIMATE.fee.amount as JSON>'
      ```

      Capture stdout as `FEE_HUMAN`, then confirm via `AskUserQuestion`
      (Yes / No):
      > Fund credits with `<amount>`? Estimated tx fee: `<FEE_HUMAN>`
      > (gas `<gasEstimate>`).

      On Yes, call `mcp__manifest-lease__fund_credit({ amount: <amount> })`
      (gated by PreToolUse hook), then re-run the readiness check. If
      the estimate itself fails, surface the error and ask via
      `AskUserQuestion` whether to proceed without one (Yes / No) — do
      not silently skip.

    - `request_faucet` → "Request testnet faucet funds" → call
      `mcp__manifest-chain__request_faucet`, then re-run the readiness
      check. (No fee estimate — the faucet is a free testnet operation.)

    - `topup_wallet` → "I'll top up the wallet myself" → stop; ask the
      user to top up and re-run the skill.

    - Always include "Proceed anyway" and "Abort" options.

- **`ok`** — silent pass.
