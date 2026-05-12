# Partial-success recovery (after `classify-deploy-error.cjs` returned `partially_succeeded`)

This file is loaded by `skills/deploy-app/SKILL.md` Step 11 when the
`deploy_app` MCP error envelope was classified as
`outcome: "partially_succeeded"` — the `create-lease` tx confirmed (a lease
exists at the UUID returned by the script) but a downstream step in
`deploy_app` fell over.

## Variables in scope

The orchestrator must have these in scope before loading this file:

- `LEASE_UUID` — the lease that survived create-lease, extracted from the
  error envelope by `classify-deploy-error.cjs`
- `MANIFEST_JSON` — the canonical Fred-rendered manifest bytes captured at
  Step 3 validation; needed for the salvage-without-domain `update_app`
  call
- `REQUESTED_FQDN` — only when the deploy was attempting a custom domain
  (`SPEC.customDomain` was set); echoed in the recovery prompt and used
  in the retry path

Per the upstream pipeline order
(`create-lease` → `set-item-custom-domain` → manifest upload to provider
→ readiness poll), this can happen at any step after the lease landed
on-chain.

**The most common case with a custom domain set is that set-domain failed,
which means the manifest was NEVER uploaded to the provider** — the
lease is on-chain, draining credits, but the provider has no app to run.
State will likely be `LEASE_STATE_PENDING` with `payload_received: false`.

## Step 11.a — diagnose state first

Call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })` to read
the on-chain lease state and the provider's `payload_received` /
`provisioning_started` flags. Decode the state via
`decode-lease-state.cjs --state <int>`. Capture as `DECODED_STATE`. This
determines which cleanup primitive applies AND whether a salvage path is
available.

## Step 11.b — show the user the situation and offer recovery

Render the prompt body + option list deterministically (do NOT hand-build
the conditional template — the script handles the with-domain / no-domain
branches and the option-1 omission):

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/render-partial-success-prompt.cjs" \
  --lease-uuid "$LEASE_UUID" \
  --decoded-state "$DECODED_STATE" \
  --reason "<reason from classify-deploy-error.cjs output>" \
  <when-domain-was-requested: --requested-custom-domain "$REQUESTED_FQDN">
```

Parse the script's stdout JSON ({ `prompt`, `options` }). Pass `prompt`
as the AskUserQuestion body and `options` as the option list verbatim.

The three recovery paths and what they do:
  1. **Retry set-domain + upload** — re-attach the domain (same or
     different FQDN), then trigger a manifest upload via `update_app`.
     (Only present when a domain was requested.)
  2. **Salvage without domain** — skip the domain entirely; just upload
     the manifest now via `update_app` so the lease starts serving the
     app on the provider FQDN.
  3. **Cancel or close the lease** — release credits and abandon.

## On Retry set-domain + upload

1. Ask via `AskUserQuestion` whether to retry with the same FQDN or a
   different one. On "different", validate the new FQDN via
   `validate-domain.cjs`.
2. Drive the manage-domain skill's reusable post-broadcast block inline
   (Step 6 of `/manifest-agent:manage-domain` — the estimate → confirm →
   broadcast → verify spine; Steps 4 and 5 of that skill are
   pre-broadcast input collection that doesn't apply here since we
   already have `LEASE_UUID` and the FQDN). Concretely: call
   `cosmos_estimate_fee` against `billing set-item-custom-domain`
   (using `LEASE_UUID` directly — the lease exists, so no
   representative-lease query is needed) → textual confirm via
   `AskUserQuestion` with action + humanized fee →
   `mcp__manifest-lease__set_item_custom_domain`. The retry MUST re-run
   `cosmos_estimate_fee` per runtime policy.

   After the broadcast returns, verify on-chain via the shared
   verify-recover driver (`scripts/verify-recover.cjs`; see
   `references/verify-recover.md`). `Read` that reference if you
   haven't yet. Re-query
   `mcp__manifest-lease__leases_by_tenant({ tenant: <signer address> })`
   to get the post-broadcast tenant payload, then run:

   ```bash
   echo '{
     "spec": {
       "verifier": { "script": "verify-domain-state.cjs",
                     "args": ["--lease-uuid", "{{lease_uuid}}",
                              <stacks-only: "--service-name", "{{service_name}}",>
                              "--expected", "{{expected_fqdn}}"],
                     "stdin_source": "leases_by_tenant_response" },
       "success": { "field": "outcome", "values": ["match"] },
       "branches": {
         "mismatch": { "branch_id": "domain-mismatch",
                       "journal_action_tag": "domain-verification-mismatch",
                       "user_message": "Tx accepted but chain shows `{{actual}}` instead of the expected value. Chain may need ~30s to settle." },
         "not_found": { "branch_id": "domain-not-found",
                        "journal_action_tag": "domain-verification-not-found",
                        "user_message": "Lease + service combination wasn't visible to the tenant query: `{{reason}}`." }
       }
     },
     "payloads": { "leases_by_tenant_response": <leases_by_tenant response> },
     "context": { "lease_uuid": "<LEASE_UUID>", "service_name": "<SERVICE_NAME or empty>", "expected_fqdn": "<retry FQDN>" }
   }' | node "$MANIFEST_PLUGIN_ROOT/scripts/verify-recover.cjs"
   ```

   Capture stdout as `RETRY_VERIFY_RESULT`. On
   `RETRY_VERIFY_RESULT.result === "success"`, fall through to the
   upload step. On `failure`, print
   `RETRY_VERIFY_RESULT.user_message` verbatim and treat this as the
   second failure. **Single retry only** — on second failure, surface
   BOTH failures and re-offer options 2 and 3.
3. After set-domain succeeds, fall through to the upload step below.

## On Salvage without domain (or after a successful retry)

1. Call `mcp__manifest-fred__update_app({ lease_uuid: LEASE_UUID,
   manifest: MANIFEST_JSON })` to upload the manifest the deploy was
   supposed to send. PreToolUse will prompt — `update_app` is a provider
   HTTPS call, no chain tx, no `cosmos_estimate_fee` needed per the
   runtime policy bucket for provider tools.
2. Wait for the lease to come up:
   `mcp__manifest-fred__wait_for_app_ready({ lease_uuid: LEASE_UUID,
   timeout_seconds: 300 })`. On thrown error: surface and stop;
   troubleshoot-deployment can take it from here.
3. Call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })` to
   get the connection details (the provider FQDN, etc.). Synthesize the
   `DEPLOY_RESPONSE`-shaped object that downstream classifiers consume,
   via `synthesize-deploy-response.cjs` (do NOT hand-build it — the shape
   is load-bearing for `format-success.cjs` and `save-manifest.cjs`):

   ```bash
   echo '<app_status JSON>' \
     | node "$MANIFEST_PLUGIN_ROOT/scripts/synthesize-deploy-response.cjs" \
         --lease-uuid "$LEASE_UUID" \
         <FQDN-only-if-retry-succeeded: --custom-domain "<FQDN>">
   ```

   The script's stdout IS the `DEPLOY_RESPONSE`. Capture as `DEPLOY_RESPONSE`.
4. Persist via `save-manifest.cjs` (with `--custom-domain` only when the
   retry succeeded) and print `format-success.cjs` output.

## On Cancel / Close

1. **PENDING leases must be cancelled**, NOT closed (different chain
   primitives — `MsgCancelLease` vs `MsgCloseLease`). Branch on the
   `DECODED_STATE` from Step 11.a:
   - `LEASE_STATE_PENDING` → use `mcp__manifest-chain__cosmos_tx` against
     `billing cancel-lease <LEASE_UUID>` (no MCP wrapper exists for
     cancel-lease today; `cosmos_tx` is the route).
   - `LEASE_STATE_ACTIVE` → use `mcp__manifest-lease__close_lease`.
   - Other states (closed, insufficient funds): nothing to do; the lease
     is already terminal.
2. Per runtime policy, call `cosmos_estimate_fee` first against the
   relevant subcommand (`billing cancel-lease` or `billing close-lease`)
   and surface the fee in a textual confirmation before broadcasting.
3. After the broadcast confirms, verify on-chain via the shared
   verify-recover driver. Same close-lease verify spec used by
   `references/billing-tx-confirm.md` Step 5a — keeping the two sites
   on a single driver invocation is the dedup point. `Read`
   `references/verify-recover.md` if you haven't yet. Re-query
   `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`,
   capture `chainState.state` as `STATE_INT`, then run:

   ```bash
   echo '{
     "spec": {
       "verifier": { "script": "decode-lease-state.cjs",
                     "args": ["--state", "{{state_int}}", "--json"],
                     "stdin_source": null },
       "success": { "field": "terminal", "values": [true] },
       "branches": {
         "other": { "branch_id": "close-not-yet-terminal",
                    "journal_action_tag": "close-lease-verify-pending",
                    "user_message": "Cancel/close tx accepted but lease state is still `{{name}}`; chain may need a moment to settle. Re-run `/manifest-agent:troubleshoot-deployment {{lease_uuid}}` in ~30s to recheck." }
       }
     },
     "payloads": {},
     "context": { "state_int": "<STATE_INT>", "lease_uuid": "<LEASE_UUID>" }
   }' | node "$MANIFEST_PLUGIN_ROOT/scripts/verify-recover.cjs"
   ```

   Capture stdout as `CLEANUP_VERIFY_RESULT`. On
   `CLEANUP_VERIFY_RESULT.result === "success"` (terminal: true), run
   `remove-manifest.cjs --lease-uuid "$LEASE_UUID"` to clean up any
   saved wrapper. On `failure` (branch_id `close-not-yet-terminal`),
   print `CLEANUP_VERIFY_RESULT.user_message` verbatim; do NOT remove
   the local manifest record.
