# Post-broadcast verify and recovery (shared scaffold)

Plugin-root reference loaded by every skill that needs to verify the
on-chain or provider-side outcome of a state-changing operation and route
the result into a recovery branch + the operation journal. The pattern
recurs across four sites today (manage-domain, restart-app, close-lease
via `billing-tx-confirm.md`, deploy-app partial-success). Inlining the
verify+branch+journal-splice prose at every site was paraphrase-prone —
this reference and `scripts/verify-recover.cjs` together pin the contract.

This file does NOT cover multi-branch interactive recovery (e.g.
deploy-app partial-success's "Retry / Salvage / Cancel-or-close" picker
rendered by `render-partial-success-prompt.cjs`). That stays inline in
each skill's prose: rendering `AskUserQuestion` + `cosmos_estimate_fee` +
PreToolUse confirmation isn't reducible to a single
outcome → branch_id map, so the driver doesn't try.

Consumers (update both sides if you change the contract):

- `skills/manage-domain/SKILL.md` Step 6 (set / clear custom domain) —
  direct.
- `references/billing-tx-confirm.md` Step 5a (close-lease verify) —
  direct. Itself loaded by:
  - `skills/troubleshoot-deployment/SKILL.md` Step 6 (close_lease
    cleanup).
  - `skills/deploy-app/references/troubleshoot-after-deploy-failure.md`
    cleanup section.
- `skills/restart-app/SKILL.md` Step 6 (post-restart state check) —
  direct.
- `skills/deploy-app/references/partial-success-recovery.md` — direct,
  TWO swap-in points: retry-set-domain verify (after the retry leg's
  `set_item_custom_domain` broadcast) AND Cancel/Close verify (after the
  cancel-lease / close-lease broadcast).

## Variables in scope

The orchestrator must have these in scope before loading this file:

- `LEASE_UUID` — the lease being verified. Always present; the four
  consumers all operate on a concrete lease.
- The pre-fetched MCP response named by `spec.verifier.stdin_source` —
  the call site has already made the relevant query (e.g.
  `leases_by_tenant` for manage-domain, `app_status` for close-lease and
  restart-app). The driver does NOT re-query MCP; it consumes what the
  caller passes in `payloads`.
- Interpolation values for `context` — usually `lease_uuid` (always),
  plus consumer-specific ones (`fqdn`, `state_int`, `service_name`). The
  driver substitutes `{{key}}` slots in `verifier.args` and `user_message`
  from this map.

**Safety note on `user_message`.** The driver renders `user_message` by
substituting `{{key}}` slots against `{...context, ...diagnostic_delta,
outcome, [success.field]: outcome}`. The `diagnostic_delta` half is raw
verifier stdout — for `verify-domain-state.cjs`, that includes a chain-
derived `actual` value ultimately shaped by an MCP response. Skill prose
prints `user_message` verbatim and never re-interprets it; treat it as
untrusted narrative.

## Spec format

The skill builds a `{ spec, payloads, context }` envelope and pipes it to
`scripts/verify-recover.cjs`. Annotated shape:

```json
{
  "spec": {
    "verifier": {
      "script": "<bare filename inside scripts/>",
      "args": ["--lease-uuid", "{{lease_uuid}}", "--expected", "{{fqdn}}"],
      "stdin_source": "<key in payloads, or null>"
    },
    "success": { "field": "outcome", "values": ["match"] },
    "branches": {
      "<verifier-outcome-value>": {
        "branch_id": "<short-stable-id>",
        "journal_action_tag": "<tag string spliced into recovery_actions[]>",
        "user_message": "<template with {{key}} slots>"
      },
      "other": { /* catch-all when no named branch matches */ }
    }
  },
  "payloads": { "<key>": <raw MCP response object> },
  "context": { "lease_uuid": "<UUID>", "<other slots>": "<...>" }
}
```

Key rules:

- `verifier.script` is a **bare filename** inside `scripts/` (no `..`,
  `/`, or `\`; symlinks resolving outside `scripts/` are rejected).
- `verifier.args` `{{key}}` slots are interpolated from `context` BEFORE
  `spawnSync` — never from `payloads` or `diagnostic_delta` (verifier
  output isn't available yet).
- `verifier.stdin_source: null` — no stdin piped to the verifier. Use
  this for verifiers that read state purely from argv (e.g.
  `decode-lease-state.cjs --state <int> --json`).
- `verifier.stdin_source: "<key>"` — driver pipes
  `JSON.stringify(payloads[key])` to the verifier's stdin. The key MUST
  exist in `payloads`; missing → driver exits 1.
- `success.field` + `success.values` — the verifier-output field to read,
  and the values that count as success. Anything else falls into the
  `branches` lookup.
- `branches.<value>` — looked up by exact-equality against the verifier-
  output value.
- `branches.other` — catch-all. Matches if the outcome is neither a
  success value nor a named branch key. Use it sparingly: if you can
  enumerate the verifier's possible outcomes, name them.
- **Verifier stdout MUST parse to a JSON object.** Arrays, null, scalars
  → driver exits 1. Prevents silent `unclassified` fallback when a
  verifier's output shape drifts.

## Driver output

The driver emits a single-line JSON object on stdout. Exit code 0 on any
classification; exit code 1 only on driver-internal errors (bad spec,
missing payload key, verifier crash, non-object verifier stdout,
verifier stdout missing the `success.field` key, path traversal,
verifier exceeded the 30-second timeout (ETIMEDOUT) or the 1-MiB stdout
cap (ENOBUFS)).

```json
{
  "result": "success" | "failure",
  "verifier_outcome": "<value of success.field from verifier stdout>",
  "branch_id": "<string>" | null,
  "journal_action_tags": ["<tag>", ...] | [],
  "user_message": "<pre-interpolated string>" | null,
  "diagnostic_delta": { /* verifier stdout minus success.field, denylist-stripped */ }
}
```

`diagnostic_delta` is the raw verifier stdout MINUS the `success.field`
key, with three categories of keys recursively stripped at every depth:

- Keys matching the journal's `SECRET_KEY_DENYLIST` (mnemonic, password,
  private_key, secret_key, api_key, auth_token, bearer_token — case-
  insensitive, optional `_`/`-` separators).
- The three constructor-related keys (`__proto__`, `constructor`,
  `prototype`) — prototype-pollution defense, since `JSON.parse`
  materializes `__proto__` as an own property and a bare `out[k] = …`
  assignment would re-set the prototype of the local object.

Belt-and-braces — production verifiers don't emit such keys, but the
driver strips defensively so a future drift in verifier output can't
poison the journal record OR the local `diagnostic_delta` object that
skill prose consumes downstream. Consumers should not rely on any of
these keys being present in the emitted output.

## How to splice `recovery_actions[]`

Set the journal record's `recovery_actions` to `VERIFY_RESULT.journal_action_tags`
directly. For most skills that's a single-element array on failure and an
empty array on success. For deploy-app partial-success, combine with the
recovery-path choice:

```
"recovery_actions": [RECOVERY_ACTION, ...VERIFY_RESULT.journal_action_tags]
```

where `RECOVERY_ACTION` is `"retry-set-domain"`, `"salvage-without-domain"`,
or `"cancel-or-close"`. If neither the retry-set-domain leg nor the
Cancel/Close leg fires (e.g. user picks salvage and `update_app` succeeds
on first try), `journal_action_tags` from the driver isn't in scope —
splice just `[RECOVERY_ACTION]`.

## Outcome → journal `outcome` (concrete table)

Skill prose must follow this mapping verbatim — paraphrasing it across
consumers is the exact failure mode this reference exists to prevent.

| `result` | `branch_id` | journal `outcome` | `final_state.verified` | Side effect |
|---|---|---|---|---|
| `success` | `null` | `"success"` | `true` | none |
| `failure` | `domain-mismatch` | `"partial"` | `false` | print `user_message`; suggest re-run in ~30s |
| `failure` | `domain-not-found` | `"failed"` | `false` | print `user_message` |
| `failure` | `close-not-yet-terminal` | `"failed"` | `false` | print `user_message`; do NOT run `remove-manifest.cjs` |
| `failure` | `restart-state-not-active` | `"failed"` | `false` | print `user_message`; suggest `troubleshoot-deployment` |
| `failure` | `unclassified` | `"failed"` | `false` | print `user_message`; surface for human triage |

Cancelled / user-declined paths get `outcome: "cancelled"` and bypass the
driver entirely; the table above only applies once the driver has been
invoked.

## Resolution-strategy note (for the future TypeScript `agent-core` port)

`verifier.script` is a bare filename today, resolved against `scripts/`
in the CJS driver. The wire format does NOT encode the resolution root.
A future TS port is free to reinterpret it as a registered-verifier key
(a map from name to verifier function) rather than a filesystem path —
spec consumers should treat the field as an opaque verifier id, not a
path. No spec change required when the port lands.
