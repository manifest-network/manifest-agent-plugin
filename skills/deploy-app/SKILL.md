---
name: deploy-app
description: >
  Deploy a containerized app on Manifest end-to-end. Optional argument:
  either a path to a JSON deployment spec (e.g. /path/to/spec.json), OR an
  image reference (e.g. nginx:1.27 or ghcr.io/me/app@sha256:...) for a
  single-service fast-path. Omit the argument for interactive authoring of
  a single-service or multi-service stack. Runs a pre-flight readiness
  check, shows the deployment plan, waits for textual confirmation,
  broadcasts, persists the post-deploy record, and prints the live URL.
  On failure, runs the troubleshoot flow inline and offers to reclaim the
  lease.
allowed-tools: Bash(*), Read, Write
---

# Deploy App (orchestrator)

You are running the full deployment workflow. The flow is the same whether
the user supplied a spec file path or not — only the input-handling step
differs.

**For all user choices, use the `AskUserQuestion` tool.**

**Do not narrate the skill's internal structure in your chat output.**
Labels like "Step 2", "Branch A2", "Step 11b" are scaffolding for skill
authors only. To the user, just describe what you're doing in plain
language — e.g. "I'll use that as the image and ask you for the SKU and
port", not "I'm following Branch A2". Skip phrases like "Now in Step N"
or "Switching to the failure branch"; describe the action itself.

## Step 0 — Verify environment

Run:
```bash
echo "$MANIFEST_PLUGIN_ROOT"
```

If empty, tell the user to restart Claude Code and stop.

Run:
```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

If it fails, tell the user to run `/manifest-agent:init-agent` first and
stop. Otherwise parse the JSON; you need `activeChain`, `address`, and
`chains.<activeChain>.chainId`.

**Never** read `~/.manifest-agent/config.json` directly.

## Step 1 — Mainnet confirmation

If `activeChain == "mainnet"`, ask via `AskUserQuestion`:

> You are about to deploy on mainnet. The lease and any retries will spend
> real funds. Continue?

Options: **Yes** (proceed) / **No** (stop). If No, stop immediately.

If the spec being deployed (or the inline collection in Step 2) sets a
`customDomain` AND chain is mainnet, append a second sentence to the
warning:
> This transaction also permanently associates the FQDN with this lease
> on-chain until you `--clear` it or close the lease. FQDN squatting is
> irreversible.

## Step 2 — Get the manifest spec

Three input modes based on `$ARGUMENTS`. Choose deterministically using
the checks below — do not guess if the input is ambiguous; ask the user.

**Input detection:**

Tokenize `$ARGUMENTS` first: split on whitespace, drop empty strings,
drop bare `+` tokens (so `wordpress:6 + mysql:9` and `wordpress:6 mysql:9`
both yield `["wordpress:6", "mysql:9"]`). Then:

- If the original `$ARGUMENTS` is empty → **Interactive authoring** (below).
- Else if `test -f "$ARGUMENTS"` succeeds → **Spec file path** (below).
- Else if **two or more** tokens each match an image reference shape
  (contains a `:` for tag form or `@sha256:` for digest form) →
  **Multi-image stack fast-path** (below).
- Else if exactly **one** token matches an image reference shape →
  **Image fast-path** (single-service, below).
- Else → tell the user the argument was neither a readable file nor a
  recognizable image reference, show what they passed, and stop. (E.g.
  they typed a relative path that doesn't exist; better to fail loudly
  than guess.)

### When `$ARGUMENTS` is a spec file path

Treat `$ARGUMENTS` as a path to a JSON spec file. Validate it exists, is
readable, and parses as JSON **without echoing its contents to chat** — spec
files can contain user-supplied env values that may be sensitive:

```bash
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log("ok")' "$ARGUMENTS"
```

If the command does not print `ok` (file missing, unreadable, or invalid
JSON), surface the error verbatim to the user and stop.

Then load the spec into your context using the `Read` tool — NOT `cat`.
`cat` would echo the entire spec to chat as a bash result; `Read` returns
the file content as a structured tool result instead. The parsed spec
object is your `SPEC`.

**If the loaded spec has a top-level `customDomain`** (and optionally
`serviceName` for stacks), surface it for confirmation via
`AskUserQuestion` rather than re-asking blindly:
> The spec sets a custom domain: `<fqdn>` → service `<name>` (or
> "single-service lease" when serviceName omitted). What do you want
> to do?
> Options: **Keep** (deploy with this domain) / **Change** (provide a
> different FQDN now) / **Clear** (deploy without a custom domain).
On Change: ask for the new FQDN, validate via
`scripts/validate-domain.cjs`, replace `SPEC.customDomain`. On Clear:
delete both `customDomain` and `serviceName` from `SPEC`.

**If the loaded spec has NO `customDomain`**, ask once via
`AskUserQuestion` "Attach a custom domain to this deploy? (Yes / Skip)";
on Yes, follow the FQDN-collection + (for stacks) service-picker flow
described under the image fast-path below.

### When `$ARGUMENTS` is multiple image references (multi-service stack fast-path)

The user typed something like `/manifest-agent:deploy-app wordpress:6 mysql:9`
or `/manifest-agent:deploy-app wordpress:6 + mysql:9`. The `+` is a
visual separator only — drop it. Each remaining token is a service.

**Derive a service name** from each image reference:
1. Strip any `@sha256:...` suffix.
2. Strip any `:tag` suffix.
3. Take the basename (everything after the last `/`).
4. Lowercase. RFC 1123 DNS label: alphanumeric + hyphens only, no
   leading/trailing hyphens, max 63 chars. If the derived name doesn't
   conform, ask the user for a service name.

Examples:
- `docker.io/lifted/wordpress:6` → `wordpress`
- `docker.io/library/mysql:9` → `mysql`
- `ghcr.io/me/web-api@sha256:abc` → `web-api`
- `nginx:1.27` → `nginx`

**Confirm the parse before doing anything else** so the user can catch
mistakes. Use `AskUserQuestion`:

> Parsed your input as a stack of N services:
>   - `wordpress` (`docker.io/lifted/wordpress:6`)
>   - `mysql` (`docker.io/library/mysql:9`)
> Proceed with these names? Options: yes / customize names / abort.

On "customize names" let the user rename each service. On "abort" stop.

**Service name collisions**: if two tokens derive to the same name (e.g.
`redis:7 redis:8` both → `redis`), the parse confirmation must show the
collision and ask the user to disambiguate (suggest `redis-7` / `redis-8`
or let them type names). Do not silently auto-suffix.

**SKU size**: after the parse is confirmed, ask for the SKU size once
for the whole stack via `AskUserQuestion`, populated from
`mcp__manifest-fred__browse_catalog`. Store as `SIZE`. (The SKU applies
to the whole lease, not per-service; per-service compute sizing isn't
exposed at the deploy_app surface.)

**Per-service authoring** — for each service in order:
1. Set `IMAGE = <token>` and call:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/inspect-image.cjs" --image "$IMAGE"
   ```
   Capture as `SVC_INFO`. Same fail-soft semantics as the single-service
   fast-path.
2. **Ports**: from `SVC_INFO.ports`.
   - 1 detected: use it.
   - >1 detected: ask which (multi-select).
   - 0 / inspection failed: ask the user to type each port-protocol pair.
3. **Ingress per port**: in stacks the typical pattern is one
   public-facing service (web tier) and the rest internal (DBs,
   workers). **Always ask explicitly per port — do not default.** No
   port number heuristic in this branch (the agent doesn't know which
   service is the public tier).
4. **tmpfs**: use `SVC_INFO.suggestedTmpfs` as the default with
   `["Yes (Recommended)", "No", "Customize"]`.
5. **env** — `AskUserQuestion` for the input mode:
   - **From a file (recommended for secrets)** — user provides an absolute
     path to a dotenv file. Tell them to create it in a separate terminal
     (`cat > /tmp/<svc>.env` … Ctrl+D, then `chmod 600`), not via `echo`
     (shell history). Wait for the path. Store the path with the service
     name; values are merged BEFORE Step 3 — they do not enter chat now.
   - **Type in chat (KEY=VALUE pairs)** — for non-sensitive only (log
     levels, feature flags, etc.). Loop key/value/done.
   - **Skip** — no env for this service.
   You may combine the chat and file modes per service (the file overlays
   the chat values; same-key entries take the file's value).
6. **labels**, **health_check** (only if image has none), **storage**
   (top-level, asked once after all services), **init** — ask normally.
7. **Skip asking about** `command` / `args` / `user` / `workingDir` —
   image defaults apply.

**Inter-service env wiring is NOT auto-populated.** The user must add
env vars like `WORDPRESS_DB_HOST=mysql`, `WORDPRESS_DB_PASSWORD=...`,
`MYSQL_ROOT_PASSWORD=...` themselves via the per-service env prompts —
either typed in chat (for non-sensitive values like the `_HOST=mysql`
pointer) or via a per-service env file (recommended for passwords). The
Intent recap below will heads-up on common gaps.

After all services collected, ask top-level **`storage`** and
**`depends_on`** (e.g. `wordpress depends_on mysql` is a typical pattern
— offer it but let the user say no).

**Custom domain (optional)** — after all services collected and before
the final SPEC is assembled, ask via `AskUserQuestion`:
> Attach a custom domain (FQDN) to this stack? Pick which service it
> routes to. (Yes / Skip)

On Yes:
1. Ask for the FQDN. Validate client-side via
   `node "$MANIFEST_PLUGIN_ROOT/scripts/validate-domain.cjs" --domain "<fqdn>"`.
   Re-ask on `valid: false`.
2. Pick the service via `AskUserQuestion` populated from the confirmed
   service names from the parse step (no chain query — you already have
   them in memory).
3. Add to the spec: top-level `customDomain: <fqdn>` + `serviceName: <picked>`.

**Final SPEC** — services-map shape, one entry per token in the same
order the user typed:

```js
{
  services: {
    "wordpress": { image: "...", ports: { "80/tcp": { ingress: true } }, env: {...}, tmpfs: [...] },
    "mysql":     { image: "...", ports: { "3306/tcp": { ingress: false } }, env: {...}, tmpfs: [...] }
  },
  customDomain?,                    // top-level FQDN (optional)
  serviceName?,                     // top-level — service the domain attaches to (optional, required when customDomain is set on a stack)
  storage?,
  depends_on?
}
```

This branch then continues to Step 3 validation, the Intent recap, the
readiness check, etc., the same as the other input modes.

### When `$ARGUMENTS` is an image reference (single-service fast-path)

Treat `$ARGUMENTS` as the image. Set `IMAGE = $ARGUMENTS`. **Inspect the
image first** to verify it's reachable and to auto-detect ports / cmd /
tmpfs hints:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/inspect-image.cjs" --image "$IMAGE"
```

Capture the JSON result as `IMAGE_INFO`. If empty `{}` (inspection
failed), surface the stderr reason and ask the user to either retry with
a different image or proceed without auto-detection.

Then collect only what's still needed:

1. `AskUserQuestion` for SKU size, populated from
   `mcp__manifest-fred__browse_catalog`.
2. **Ports** — driven by `IMAGE_INFO.ports`:
   - 1 detected: use it (don't ask).
   - >1 detected: multi-select.
   - 0 / no inspection: ask user to type each port-protocol pair.
3. **Ingress per port** — for each chosen port:
   - Single port AND number in `{80, 443, 8080, 8443}`: confirm with
     options `["Yes (Recommended)", "No (internal only)"]`.
   - Otherwise: ask explicitly per port, no default.
4. **Skip asking about** `command` / `args` / `user` / `workingDir` — Fred
   uses image defaults (visible in `IMAGE_INFO.cmd` etc.) unless overridden.
5. **`tmpfs`** — if `IMAGE_INFO.suggestedTmpfs` is non-empty, offer it as
   the default (`["Yes (Recommended)", "No", "Customize"]`); else ask
   "Need any tmpfs mounts? (yes / skip)".
6. **`env`** — three-option flow (file / chat / skip), same as the
   multi-image fast-path env step above. Sensitive values via file is the
   recommended path for secrets. The single-service shape uses the
   service name `app` — pass `--service-name app` to `merge-env.cjs`.
7. **`labels`**, **`health_check`** (only if image has none),
   **`storage`**, **`init`** — ask normally.

**Custom domain (optional)** — after collection above and before the
final SPEC is built, ask via `AskUserQuestion`:
> Attach a custom domain (FQDN) to this lease? (Yes / Skip)

On Yes:
1. Ask for the FQDN. Validate via
   `node "$MANIFEST_PLUGIN_ROOT/scripts/validate-domain.cjs" --domain "<fqdn>"`.
   Re-ask on `valid: false`.
2. No service picker — the single-service shape uses one service named
   `app`, which is the implicit target.
3. Add to the spec: top-level `customDomain: <fqdn>`. (Do NOT set
   `serviceName`; the chain treats single-item leases as not needing it.)

Build the `SPEC` object using the **services-map shape** so per-port
ingress is encoded explicitly:

```js
{
  services: {
    "app": {                                           // default service name
      image: IMAGE,
      ports: { "80/tcp": { ingress: true }, ... },
      env?, labels?, health_check?, tmpfs?, init?
    }
  },
  customDomain?,                                       // top-level FQDN (optional)
  storage?
}
```

This branch is single-service only. If the user supplied an image but
actually wants a multi-service stack, tell them: "image-arg fast-path is
single-service only; re-run as `/manifest-agent:deploy-app` (no argument)
for interactive multi-service authoring, or as
`/manifest-agent:deploy-app /path/to/spec.json` if you have a stack spec
file." Then stop.

### When `$ARGUMENTS` is empty (interactive authoring)

Drive a thin authoring sequence inline (do NOT `Read` the
`author-manifest/SKILL.md` file — the prose below is sufficient). The
standalone `/manifest-agent:author-manifest` is the right entry point if the
user wants a reusable saved spec; here we just author + deploy in one shot.

1. Use `AskUserQuestion` for shape: **Single-service** or **Multi-service stack**.
2. Use `AskUserQuestion` for SKU size, populated from
   `mcp__manifest-fred__browse_catalog`.
3. Ask for the image reference. Then immediately inspect it to verify
   reachability and to auto-detect ports / cmd / suggested tmpfs:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/inspect-image.cjs" --image "<image>"
   ```
   Same fail-soft handling as the image fast-path above.
4. Collect remaining fields per the same rules as `author-manifest`
   Step 6a (single-service) or 6b (stack):
   - Ports + ingress per port (with web-port default for single-service).
   - Skip cmd / args / user (image defaults).
   - tmpfs from `suggestedTmpfs`.
   - **env** — three-option flow (file / chat / skip), same as the
     multi-image fast-path env step above. Sensitive values via file is
     the recommended path for secrets.
   - labels, health_check (only if image has none), storage, init —
     ask normally.
5. **Custom domain (optional)** — after all collection and before the
   final SPEC is built: `AskUserQuestion` "Attach a custom domain (FQDN)
   to this lease? (Yes / Skip)". On Yes: ask FQDN → validate via
   `validate-domain.cjs` → for stacks pick service via `AskUserQuestion`
   over `Object.keys(SPEC.services)`; for single, no picker. Add
   `customDomain` (and `serviceName` for stacks) at the top level of the
   spec.
6. Build the `SPEC` object using the **services-map shape** with explicit
   `ports: { "<p>/<proto>": { ingress: <bool> } }` entries.

Do NOT call `save-manifest-draft.cjs` in the image fast-path or interactive
modes — the spec lives only in memory; the post-deploy wrapper at
`~/.manifest-agent/manifests/<lease_uuid>.json` (Step 10) is the durable
record. (When the user provided an existing spec file path, the spec already
lives on disk by definition.)

### Merge any file-sourced env (interactive paths only)

Skip this section if the user provided a spec file path (the file already
holds whatever env it has) OR if no service was given an env-file path.

Otherwise, materialize the in-memory SPEC, merge each env file via the
script (no values in chat), then re-load the merged spec:

1. Use the `Write` tool to materialize SPEC at
   `/tmp/.spec-env-${process_pid}.json`. The Write tool input shows the
   spec content (image, ports, chat-typed env if any, etc.); file-sourced
   values are NOT in this Write yet.
2. For each `(service-name, env-file-path)` pair the user provided in
   Step 2, run:
   ```bash
   cat "<env-file-path>" | node "$MANIFEST_PLUGIN_ROOT/scripts/merge-env.cjs" \
     --spec-file "/tmp/.spec-env-${process_pid}.json" \
     --service-name "<service-name>"
   ```
   Report the script's `keys_merged` to the user (keys only — no values
   appear). On any error: surface verbatim, `rm -f` the tempfile, stop.
3. Use the `Read` tool to load `/tmp/.spec-env-${process_pid}.json` back
   into your context as the new SPEC. The Read result will contain the
   merged env values — they enter your context here, but they have not
   transited the chat input or any agent prose.
4. `rm -f /tmp/.spec-env-${process_pid}.json` once the spec is loaded.
5. Suggest the user delete each env file after a successful deploy
   (e.g. `rm /tmp/wordpress.env`); they have served their purpose.

(Architectural note: env values still appear in the `build_manifest_preview`
and `deploy_app` MCP tool call args at Steps 3 and 7. Eliminating that
exposure entirely needs upstream MCP support for "load spec from this
path" and is out of scope here. What this flow does eliminate is the user
typing secrets into the chat input.)

## Step 3 — Validate the spec

Always validate, even when loading from a path (the user may have edited the
file). Call:

```
mcp__manifest-fred__build_manifest_preview(<SPEC fields splatted>)
```

If `validation.valid === false`, surface every entry in `validation.errors[]`
verbatim and stop. Recovery instructions to give the user depend on how
they got here: if they passed a spec file path, they should edit the file
and re-run `/manifest-agent:deploy-app <path>`; if they used the image
fast-paths or interactive authoring, they can re-run `/manifest-agent:deploy-app`
with their corrected inputs.

Capture from the response:
- `META_HASH` ← `meta_hash_hex`
- `MANIFEST_JSON` ← `manifest_json` (the canonical Fred-rendered string;
  Step 10 needs it for the durable post-deploy record)
- The `format` (`single` or `stack`) — surfaces in the DeploymentPlan
  summary.

For `IMAGE`: the SKU pre-flight in Step 4 wants a single image. Note that
specs always use the services-map shape (every authoring path emits it),
so derive the image from the first entry of `SPEC.services`:
`IMAGE = Object.values(SPEC.services)[0].image`. For multi-service stacks
this picks the first service's image as the representative — the provider
validates all of them at deploy time. Legacy specs that still use the flat
`SPEC.image` shape work as a fallback: `IMAGE = SPEC.image ||
Object.values(SPEC.services || {})[0]?.image`.

For `SIZE`: spec files don't carry the SKU choice — when the user
provided a spec file path, use `AskUserQuestion` populated from
`browse_catalog` to ask. When the user came in via any of the
interactive flows (image fast-path, multi-image stack fast-path, or
no-arg interactive authoring), `SIZE` was already collected in Step 2;
reuse it.

## Confirm intent (between spec validation and readiness)

Before you make any chain round-trips (readiness, fee estimate), write a
plain-English **Intent recap** in 4–6 short paragraphs and ask the user to
confirm. This is distinct from the structural `DeploymentPlan` rendered
later: that one captures technical truth (gas, balances); this one
captures *what you understood the user is trying to do*, so misinterpretations
get caught before any chain calls.

Cover, in order:

1. **What's being deployed** — service count, names, images. State both
   what the user typed/passed and what you derived (e.g. "I parsed your
   input as 2 services: `wordpress` (`docker.io/lifted/wordpress:6`) and
   `mysql` (`docker.io/lifted/mysql:9`)").
2. **Connectivity** — which ports are publicly reachable via the
   provider's HTTPS subdomain (`ingress: true`) and which are internal
   only. Use plain English ("publicly reachable" / "internal only"), not
   the literal `ingress` boolean.
3. **What you provided vs what was auto-detected** — distinguish
   user-supplied env keys, labels, command overrides, etc. from defaults
   you pulled from the image (cmd / entrypoint / user / workingDir /
   tmpfs hints). The user should know what the agent inferred.
4. **Sensitive values always redacted** — env vars: show **keys only**,
   never values. Labels: show **keys only**, never values. The Fred
   manifest schema doesn't constrain label values beyond `type: string`,
   so they can in principle carry secrets — redact unconditionally, do
   not try to guess which ones "look sensitive."
5. **Heads-up: obvious gaps** — apply your knowledge of common app
   patterns to flag things the user probably forgot. For example: a
   wordpress service without `WORDPRESS_DB_HOST` / `WORDPRESS_DB_PASSWORD`
   set won't connect to its DB; a postgres without `POSTGRES_PASSWORD`
   won't start; a mysql without `MYSQL_ROOT_PASSWORD` won't start. Be
   conservative — only flag cases you're confident about. If you're
   unsure, say so or skip the heads-up.
6. **Custom domain** (only when `SPEC.customDomain` is set) — show the
   line `Custom domain: <fqdn> -> service <name>` (or
   `-> single-service lease` when `SPEC.serviceName` is omitted). Then
   add a **dual-tx clarification**:
   > Note: when a custom domain is set, `deploy_app` broadcasts TWO
   > billing transactions atomically: `create-lease` AND
   > `set-item-custom-domain`. The single permission prompt that fires
   > later covers BOTH; this textual recap is your per-tx review.

Then ask via `AskUserQuestion`:

> Does this match what you want?
>   - **Yes, proceed** → continue to readiness check + DeploymentPlan
>   - **Amend** → return to spec authoring; the recovery path depends on
>     how the spec got here (edit the spec file when one was passed,
>     otherwise re-collect interactively)
>   - **Abort** → stop without broadcasting

On Amend: re-enter spec authoring. On Abort: stop. Only on Yes do you
proceed to readiness.

## Step 4 — Pre-flight readiness

Always re-fetch — balances at broadcast time are what matter, not whatever
the spec was authored against. Call:

```
mcp__manifest-fred__check_deployment_readiness({ size: SIZE, image: IMAGE })
```

Pipe to the evaluator. Pass `--gas-price` from the config you read in Step 0
(the `gasPrice` field, e.g. `"1umfx"` or `"0.37upwr"`) so the script knows
which wallet denom to check for gas:

```bash
echo '<readiness JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/evaluate-readiness.cjs" --gas-price '<gasPrice from config>'
```

Branch on `status` exactly as `author-manifest` Step 5 does:
- **`block`** → print `reasons`, stop.
- **`warn`** → ask the user to proceed / fund_credit / request_faucet /
  topup_wallet / abort. On fund_credit/request_faucet, re-run Step 4.
- **`ok`** → silent.

Save the readiness JSON as `READINESS`.

## Step 5 — Estimate the deploy_app tx fee, then render the DeploymentPlan

### 5a — Estimate the chain tx fee

The runtime policy mandates calling `cosmos_estimate_fee` before any
billing-module broadcast. `deploy_app` wraps `cosmosTx("billing",
"create-lease", [...])` under the hood, so call:

```
mcp__manifest-chain__cosmos_estimate_fee({
  module: "billing",
  subcommand: "create-lease",
  args: [
    "--meta-hash", META_HASH,
    "<skuUuid>:1",                     // single-service
    // OR for stacks: "<skuUuid>:1:<svcName1>", "<skuUuid>:1:<svcName2>", ...
    // OR with storage: append "<storageSkuUuid>:1"
  ]
})
```

Where `skuUuid` is `READINESS.sku.uuid` (already in your context from the
readiness check) and `META_HASH` is from Step 3.

**Storage SKU lookup**: if `SPEC.storage` is set, you need the storage
SKU's UUID. Call `mcp__manifest-lease__get_skus` (no args), find the
entry whose `name` matches `SPEC.storage`, take its `uuid`, and append
`<storageSkuUuid>:1` to the `args` array.

Capture the response as `ESTIMATE` — it has `gasEstimate` (string,
e.g. `"142000"`) and `fee.amount` (an array of `{denom, amount}`).

If `cosmos_estimate_fee` itself errors out, surface the error to the
user and ask: "estimate failed; proceed without an estimate? (yes / no)".
Do NOT silently skip. If the user says yes, set `ESTIMATE = null` and
continue.

### 5a-bis — Estimate the set-domain tx fee (custom domain only)

Skip this if `SPEC.customDomain` is unset.

When set, `deploy_app` will broadcast TWO billing txes (the runtime
policy heredoc spells this out). Estimate the second one too. The
challenge: the lease being created doesn't exist yet, but the chain's
keeper validates ownership against the simulated msg sender. Use a
representative existing lease the signer already owns.

1. Query `mcp__manifest-lease__leases_by_tenant({ tenant: <address from
   Step 0> })`.
2. From the response, pick the FIRST lease whose `state` decodes to
   `LEASE_STATE_ACTIVE`. Use `decode-lease-state.cjs` if needed:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state <int>
   ```
   Capture as `REP_UUID`.
3. **If a representative lease exists**: call
   ```
   mcp__manifest-chain__cosmos_estimate_fee({
     module: "billing",
     subcommand: "set-item-custom-domain",
     args: ["<REP_UUID>", "<SPEC.customDomain>"
            // for stacks add: , "--service-name", "<SPEC.serviceName>"
           ]
   })
   ```
   Capture as `SET_DOMAIN_ESTIMATE`. The fee is essentially fixed for
   this msg type, so it transfers cleanly to the about-to-be-created
   lease.
4. **If no ACTIVE lease exists** (fresh wallet, all prior leases closed):
   set `SET_DOMAIN_ESTIMATE = "skipped"`. Step 5b will pass
   `--set-domain-tx-fee skipped` to `render-deployment-plan.cjs`,
   which emits the canonical
   `Tx fee (set-domain): (not estimated — no representative lease available …)`
   line in the DeploymentPlan block. **Do NOT add prose around this in
   the intent recap** — the DeploymentPlan line itself is the single
   source of truth, and stitching a "Heads-up: …" sentence into the
   recap creates awkward paraphrases (the same applies to any other
   `(not estimated)` rendering). PreToolUse + textual confirm still
   fire normally on the printed plan.

If the second estimate itself errors out, surface the error and ask
"proceed without a set-domain estimate? (yes / no)" — do NOT silently
skip. On yes, set `SET_DOMAIN_ESTIMATE = "skipped"` and continue.

### 5b — Render the DeploymentPlan

Compute a structural summary of the spec. Pass the spec via stdin from a
file (NOT inline `echo` — the spec can carry user-supplied env values that
would be re-rendered into chat as a literal bash command):

1. Use the `Write` tool to materialize the SPEC JSON at
   `/tmp/.spec-${process_pid}.json`.
2. Run:

   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/manifest-summary.cjs" < /tmp/.spec-XXX.json
   rm -f /tmp/.spec-XXX.json
   ```

The summary output (`{ format, service_count, port_count, env_count, env_keys, images }`)
contains only env *keys*, never values — safe to keep inline for the next
step.

Convert `ESTIMATE.fee.amount` to a single human-readable string for the
`--tx-fee` flag (e.g. for `[{"denom":"umfx","amount":"2300"}]` →
`"0.0023 MFX"` — divide by 1e6 for `umfx` and label with the friendly
denom name from the chain registry; for any denom you can't friendlify,
fall back to `"<amount> <denom>"` like `"2300 umfx"`). For `--tx-gas`,
pass `ESTIMATE.gasEstimate` verbatim. If `ESTIMATE` is null (the user
proceeded without an estimate), omit both flags — the script will print
a "(not estimated)" marker so the omission is visible.

Then render the canonical block. The summary + readiness JSON together
contain no env values, so inline echo is acceptable here:

```bash
echo '{"summary": <summary JSON from above>, "readiness": <READINESS JSON>}' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/render-deployment-plan.cjs" \
      --meta-hash "$META_HASH" \
      --image "$IMAGE" \
      --size "$SIZE" \
      --tx-gas "<ESTIMATE.gasEstimate>" \
      --tx-fee "<human-readable fee string>"
```

**When `SPEC.customDomain` is set**, also pass:
- `--custom-domain "<SPEC.customDomain>"`
- `--custom-domain-service "<SPEC.serviceName>"` (for stacks; omit for
  single-service)
- `--set-domain-tx-gas "<SET_DOMAIN_ESTIMATE.gasEstimate>"` (when the
  second estimate succeeded)
- `--set-domain-tx-fee "<human-readable set-domain fee>"` OR
  `--set-domain-tx-fee skipped` (when approach-3 fallback fired)

The script's stdout IS the plan. Print it to the user verbatim. Do not
restate, reformat, or splice in additional fields — the script owns the
canonical format. With a custom domain set, the plan automatically
shows two `Tx fee:` lines plus a `Total fee:` line.

## Step 6 — Wait for textual confirmation

Ask the user via `AskUserQuestion`:

> Confirm to broadcast `deploy_app` with the plan above? (yes / no)

This textual confirmation is the primary gate (per runtime policy). The
PreToolUse permission prompt that fires next is a safety net, not a
substitute. Do not call `deploy_app` without an explicit affirmative.

If the user says no, ask whether to amend the spec (return to Step 2) or
abort entirely.

## Step 7 — Broadcast

Call `mcp__manifest-fred__deploy_app` with the spec fields splatted as
arguments. **When `SPEC.customDomain` is set**, splat
`custom_domain: SPEC.customDomain` and (for stacks)
`service_name: SPEC.serviceName` alongside the other fields. (deploy_app
uses snake_case in its MCP input schema; the SPEC stores camelCase to
mirror the underlying TypeScript signature — translate on the call.)

The PreToolUse hook will prompt for permission — that is expected. Note
that ONE permission prompt covers BOTH txes when `custom_domain` is set
(the second tx fires server-side via `setItemCustomDomain`, never via
the MCP tool surface).

Stream `notifications/progress` events to the user as they arrive.

**On a thrown error**: capture the error envelope as
`{ message, details, code? }` and route through the error classifier:

```bash
echo '<error envelope JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/classify-deploy-error.cjs"
# When SPEC.customDomain is set, also pass:
#   --expected-custom-domain "<SPEC.customDomain>"
```

Branch on the script's `outcome`:
- **`partially_succeeded`**: `create-lease` confirmed but the downstream
  step (set-domain or upload/poll) fell over. The lease exists at
  `details.lease_uuid` (or extracted from the message by the script).
  Jump to **Step 11 partial-success sub-branch** with that UUID.
- **`failed`**: no lease was created. Surface `reason` verbatim and
  stop. No cleanup needed.

If `deploy_app` returns a response (no throw), capture it as
`DEPLOY_RESPONSE` and proceed to Step 8.

## Step 8 — Classify the response

```bash
echo '<DEPLOY_RESPONSE JSON>' | node "$MANIFEST_PLUGIN_ROOT/scripts/classify-deploy-response.cjs"
```

The script prints `{ outcome, lease_uuid?, provider_uuid?, urls, state_name?, error_summary? }`.

Capture `LEASE_UUID` from the script's output (always present except on
`failed`-with-no-lease).

Branch on `outcome`:

- **`active`** → skip Step 9, go directly to Step 10.
- **`needs_wait`** → call
  `mcp__manifest-fred__wait_for_app_ready({ lease_uuid: LEASE_UUID, timeout_seconds: 300 })`.
  On thrown error → Step 11. On success, call
  `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })` and merge its
  `connection` into the response. Re-run `classify-deploy-response.cjs` on
  the merged response. Then continue to Step 10.
- **`failed`** → Step 11.

## Step 9 — (reserved)

(Kept blank to preserve numbering used by Step 8 references.)

## Step 10 — Persist + success output

**Persist**:

Write the canonical `MANIFEST_JSON` (captured in Step 3) to a temporary
file using the `Write` tool — NOT a bash heredoc. The heredoc form would
require re-rendering `MANIFEST_JSON` (which can contain sensitive env
values) into chat as a literal bash code block; the `Write` tool writes
the file as a structured tool call instead. The value was already
visible in chat from `build_manifest_preview`'s response, so we don't add
a third on-screen rendering of the secret-bearing payload.

1. Pick the temp path: `/tmp/.manifest-${LEASE_UUID}.json` (the lease UUID
   is unique per broadcast — no collision with concurrent sessions).
2. Use `Write` with `file_path` set to that path and `content` set to
   `MANIFEST_JSON`.
3. Run the persistence + cleanup:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/save-manifest.cjs" \
  --lease-uuid "$LEASE_UUID" \
  --image "$IMAGE" \
  --size "$SIZE" \
  --meta-hash "$META_HASH" \
  --chain-id "$CHAIN_ID" \
  --manifest-file "/tmp/.manifest-${LEASE_UUID}.json"
# When the deploy_app response carried a custom_domain (set-domain tx
# confirmed), pass it through to the wrapper so troubleshoot-deployment
# can surface it later. Add --custom-domain-service-name only for stacks.
#   --custom-domain "<DEPLOY_RESPONSE.custom_domain>" \
#   --custom-domain-service-name "<DEPLOY_RESPONSE.service_name>"   # stacks only
rm -f "/tmp/.manifest-${LEASE_UUID}.json"
```

(`CHAIN_ID` comes from `chains.<activeChain>.chainId` in the config status
from Step 0.)

`save-manifest.cjs` re-computes SHA-256 of the manifest bytes and compares
against `$META_HASH`. If they don't match the script exits non-zero with a
diagnostic — surface that error verbatim to the user. The most common
cause is writing the structured spec to the tmpfile instead of the
canonical `MANIFEST_JSON` string captured in Step 3; double-check the
Write tool was passed `MANIFEST_JSON` (the long Fred-rendered string),
not `SPEC` (the structured input).

The script prints the saved file path on stdout. Show it briefly:
"Saved manifest record: `<path>`".

**Success output**: call `browse_catalog` once more to resolve provider name
(the deploy may have happened many minutes ago for the `needs_wait` branch),
then:

```bash
echo '{"deploy_response": <DEPLOY_RESPONSE>, "catalog": <browse_catalog response>}' \
  | node "$MANIFEST_PLUGIN_ROOT/scripts/format-success.cjs" --lease-uuid "$LEASE_UUID"
```

**Print the script's stdout VERBATIM.** Do NOT add explanatory prose
around it, do NOT paraphrase its labels, do NOT invent fields the
deploy_app response doesn't have (e.g. there is no `connection.urls[]` —
don't reference it). The script's output is the success message — the
labels (Provider / Lease UUID / Lease Status / Ingress / troubleshoot
pointer) and their order are intentional and complete. If the user wants
more detail about logs or diagnostics, they can run
`/manifest-agent:troubleshoot-deployment <uuid>` as the script's last
line suggests.

If the script reports `Ingress: (none — service is internal or no FQDN
reported)`, just print that as-is. The user knows what an internal-only
service is; do not narrate around it.

## Step 11 — Failure

Three sub-cases.

### When `classify-deploy-error.cjs` returned `partially_succeeded`

The `create-lease` tx confirmed (lease exists at the UUID returned by
the script) but a downstream step in `deploy_app` fell over. Per the
upstream pipeline order (`create-lease` → `set-item-custom-domain` →
manifest upload to provider → readiness poll), this can happen at any
step after the lease landed on-chain. **The most common case with a
custom domain set is that set-domain failed, which means the manifest
was NEVER uploaded to the provider** — the lease is on-chain, draining
credits, but the provider has no app to run. State will likely be
`LEASE_STATE_PENDING` with `payload_received: false`.

**Step 11.a — diagnose state first.**

Call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })` to
read the on-chain lease state and the provider's `payload_received` /
`provisioning_started` flags. Decode the state via
`decode-lease-state.cjs --state <int>`. This determines which cleanup
primitive applies AND whether a salvage path is available.

**Step 11.b — show the user the situation and offer recovery.**

Via `AskUserQuestion`:
> Deploy partially succeeded:
>   - Lease `<lease_uuid>` was created on-chain (state: `<decoded-state>`).
>   - <If a custom domain was requested:> set-domain step did NOT
>     complete: `<reason>`. The manifest was therefore NEVER uploaded
>     to the provider — no app is running on this lease.
>   - <If no custom domain:> the manifest upload or readiness poll
>     failed: `<reason>`. The provider may or may not have started the
>     app.
>
> What do you want to do?
>
>   1. **Retry set-domain + upload** — re-attach the domain (same or
>      different FQDN), then trigger a manifest upload via `update_app`.
>   2. **Salvage without domain** — skip the domain entirely; just
>      upload the manifest now via `update_app` so the lease starts
>      serving the app on the provider FQDN.
>   3. **Cancel / Close the lease** — release credits and abandon.

(Omit option 1 when no custom domain was set in the first place.)

**On Retry set-domain + upload**:
1. Ask via `AskUserQuestion` whether to retry with the same FQDN or a
   different one. On "different", validate the new FQDN via
   `validate-domain.cjs`.
2. Drive the manage-domain skill's reusable post-broadcast block inline
   (Steps 4–6 of `/manifest-agent:manage-domain`):
   `cosmos_estimate_fee` against `billing set-item-custom-domain`
   (using `LEASE_UUID` directly — the lease exists, so no
   representative-lease query is needed) → textual confirm with action
   + fee → `mcp__manifest-lease__set_item_custom_domain` → verify
   on-chain via `leases_by_tenant`. The retry MUST re-run
   `cosmos_estimate_fee` per runtime policy. **Single retry only** — on
   second failure, surface BOTH failures and re-offer options 2 and 3.
3. After set-domain succeeds, fall through to the upload step below.

**On Salvage without domain** (or after a successful retry):
1. Call `mcp__manifest-fred__update_app({ lease_uuid: LEASE_UUID,
   manifest: MANIFEST_JSON })` to upload the manifest the deploy was
   supposed to send. PreToolUse will prompt — `update_app` is a
   provider HTTPS call, no chain tx, no `cosmos_estimate_fee` needed
   per the runtime policy bucket for provider tools.
2. Wait for the lease to come up:
   `mcp__manifest-fred__wait_for_app_ready({ lease_uuid: LEASE_UUID,
   timeout_seconds: 300 })`. On thrown error: surface and stop;
   troubleshoot-deployment can take it from here.
3. Call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })` to
   get the connection details (the provider FQDN, etc.). Synthesize a
   `DEPLOY_RESPONSE`-shaped object: `{ lease_uuid: LEASE_UUID,
   provider_uuid: <from app_status.chainState.providerUuid>,
   state: <from app_status.chainState.state>, connection: <from
   app_status.connection>, custom_domain?: <FQDN if retry succeeded> }`.
4. Persist via `save-manifest.cjs` (with `--custom-domain` only when
   the retry succeeded) and print `format-success.cjs` output.

**On Cancel / Close**:
1. **PENDING leases must be cancelled**, NOT closed (different chain
   primitives — `MsgCancelLease` vs `MsgCloseLease`). Branch on the
   decoded state from Step 11.a:
   - `LEASE_STATE_PENDING` → use `mcp__manifest-chain__cosmos_tx`
     against `billing cancel-lease <LEASE_UUID>` (no MCP wrapper exists
     for cancel-lease today; cosmos_tx is the route).
   - `LEASE_STATE_ACTIVE` → use `mcp__manifest-lease__close_lease`.
   - Other states (closed, insufficient funds): nothing to do; the
     lease is already terminal.
2. Per runtime policy, call `cosmos_estimate_fee` first against the
   relevant subcommand (`billing cancel-lease` or `billing close-lease`)
   and surface the fee in a textual confirmation before broadcasting.
3. After the broadcast confirms, verify on-chain via
   `mcp__manifest-fred__app_status` (state should be
   `LEASE_STATE_CLOSED` or similar terminal). If verified, run
   `remove-manifest.cjs --lease-uuid "$LEASE_UUID"` to clean up any
   saved wrapper.

### When the broadcast created a lease (`LEASE_UUID` present)

Inline a thin troubleshoot sequence (do NOT `Read` the
`troubleshoot-deployment/SKILL.md` file). Run in parallel:

- `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__app_diagnostics({ lease_uuid: LEASE_UUID })`
- `mcp__manifest-fred__get_logs({ lease_uuid: LEASE_UUID, tail: 100 })`

Render a brief Markdown report to the user with three sections (Status /
Diagnostics / Recent logs). Decode the lease state:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state <state-int>
```

Before offering cleanup, estimate the close-lease tx fee per the runtime
policy:

```
mcp__manifest-chain__cosmos_estimate_fee({
  module: "billing",
  subcommand: "close-lease",
  args: ["<LEASE_UUID>"]
})
```

If the estimate fails, surface the error and ask the user whether to
proceed without one — do not silently skip.

Then offer cleanup via `AskUserQuestion`. Include the image AND the
estimated fee in the prompt so the user knows what they're paying:

> Close the lease for image `<IMAGE>` (uuid `<LEASE_UUID>`)?
> Estimated tx fee: `<human-readable fee>` (gas `<gasEstimate>`).
> Closing frees the credits this lease was reserving. (yes / no)

If yes, call `mcp__manifest-lease__close_lease({ lease_uuid: LEASE_UUID })`
(PreToolUse hook will prompt).

**Verify on-chain state after the tx returns** — a successful broadcast
does not guarantee the lease actually transitioned to `LEASE_STATE_CLOSED`.
The tx might have been accepted into the mempool but reverted on
execution, or the lease state might lag a block. Confirm explicitly:

1. Call `mcp__manifest-fred__app_status({ lease_uuid: LEASE_UUID })`.
2. Decode `chainState.state` (integer) via:
   ```bash
   node "$MANIFEST_PLUGIN_ROOT/scripts/decode-lease-state.cjs" --state <state-int>
   ```
3. Branch on the decoded name:
   - **`LEASE_STATE_CLOSED`** → confirmed. Run cleanup:
     ```bash
     node "$MANIFEST_PLUGIN_ROOT/scripts/remove-manifest.cjs" --lease-uuid "$LEASE_UUID"
     ```
     (no-op if the saved manifest record does not exist). Tell the user
     "Lease confirmed CLOSED on-chain. Removed local saved manifest record."
   - **Any other state** (typically still `LEASE_STATE_ACTIVE` or
     `LEASE_STATE_PENDING`) → tell the user: "close_lease tx accepted but
     lease state is still `<decoded-name>`; chain may need a moment to
     settle. Re-run `/manifest-agent:troubleshoot-deployment <LEASE_UUID>`
     in ~30s to recheck. Local saved manifest record NOT removed yet."
   - If `app_status` itself errors out: surface the error and tell the
     user the tx was sent but verification failed. Do NOT remove the
     local manifest record.

If the user wants a deeper investigation, suggest
`/manifest-agent:troubleshoot-deployment`.

### When no lease was created (`LEASE_UUID` absent)

The broadcast failed before any lease was created (most commonly: registry
rejected at upload time, insufficient gas, network error). Surface the
`error_summary` from the classify-deploy-response output verbatim and stop.
No cleanup needed.
