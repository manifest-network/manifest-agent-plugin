# Set-domain tx fee estimate (deploy-app Step 6a-bis detail)

This file is loaded by `skills/deploy-app/SKILL.md` Step 6 when
`SPEC.customDomain` is set. Skip the entire flow if it isn't.

## Variables in scope

The orchestrator must have these in scope before loading this file:

- `SPEC.customDomain` — the FQDN the user wants to claim (set if you reached this section)
- `SPEC.serviceName` — for stacks, the service the domain attaches to (omitted for single-service)
- `<address>` — the signer address, captured at Step 0 from `update-config.cjs --status`

The flow produces:

- `SET_DOMAIN_ESTIMATE` — either the response object from `cosmos_estimate_fee` (with `gasEstimate` and `fee.amount`) OR the literal string `"skipped"` (approach-3 fallback when no representative lease is available)

## Why the second estimate is non-trivial

When `SPEC.customDomain` is set, `deploy_app` broadcasts TWO billing txes
(the runtime policy heredoc spells this out): `create-lease` first, then
`set-item-custom-domain`. The runtime policy requires a fee estimate
before each broadcast, but the lease being created doesn't exist yet,
and the chain's keeper validates ownership against the simulated msg
sender. The workaround: estimate against a representative existing
lease the signer already owns.

## Flow

1. Query `mcp__manifest-lease__leases_by_tenant({ tenant: <address> })`.

2. From the response, pick the FIRST lease whose `state` decodes to
   `LEASE_STATE_ACTIVE`. Use `decode-lease-state.cjs` if needed:

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state <int>
   ```

   Capture as `REP_UUID`.

3. **If a representative lease exists**: build the args[] array via
   `build-set-domain-args.cjs` (do NOT hand-construct the array — the
   script pins the shape):

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/build-set-domain-args.cjs" \
     --lease-uuid "$REP_UUID" \
     --fqdn "$SPEC_CUSTOM_DOMAIN" \
     <stacks-only: --service-name "$SPEC_SERVICE_NAME">
   ```

   Then estimate against the representative lease:

   ```
   mcp__manifest-chain__cosmos_estimate_fee({
     module: "billing",
     subcommand: "set-item-custom-domain",
     args: <stdout of build-set-domain-args.cjs>
   })
   ```

   Capture as `SET_DOMAIN_ESTIMATE`. The fee is essentially fixed for
   this msg type, so it transfers cleanly to the about-to-be-created
   lease.

4. **If no ACTIVE lease exists** (fresh wallet, all prior leases
   closed): set `SET_DOMAIN_ESTIMATE = "skipped"`. Step 6b will pass
   `--set-domain-tx-fee skipped` to `render-deployment-plan.cjs`, which
   emits its canonical "not estimated" marker line in the DeploymentPlan
   block (the script owns the wording — do not quote it here, it'll
   drift). **Do NOT add prose around this in the intent recap** — the
   DeploymentPlan line itself is the single source of truth, and
   stitching a "Heads-up: …" sentence into the recap creates awkward
   paraphrases. PreToolUse + textual confirm still fire normally on the
   printed plan.

If the estimate itself errors out (chain unreachable, malformed
response), surface the error and confirm via `AskUserQuestion` (Yes /
No): "proceed without a set-domain estimate?". Do NOT silently skip. On
Yes, set `SET_DOMAIN_ESTIMATE = "skipped"` and continue.
