<!-- Consumers: init-agent and import-key, after a successful config write.
Variables in scope: PREVIOUS_GAS_MULTIPLIER from the pre-write safe status
(null for initial setup/default), and address/activeChain from write-config.
Outputs: FINAL_SETTINGS, RUN_OUTCOME, structured errors and recovery actions. -->

`write-config.cjs` replaces config without `gasMultiplier`. Keep
`PREVIOUS_GAS_MULTIPLIER` in workflow memory until recovery is complete; it is
**not preserved in the newly written config**. If it is absent/null, skip the
update below and keep the runtime default of `1.5`.

For a non-null previous value, restore that exact value. Substitute it as a
properly shell-escaped literal:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --gas-multiplier 'PREVIOUS_GAS_MULTIPLIER'
```

Check the exit status and returned `gasMultiplier`. A nonzero exit or a value
that differs from `PREVIOUS_GAS_MULTIPLIER` is a restoration failure. Save a
structured error with `class: "gas_multiplier_restore_failed"` and a `message`
containing the sanitized diagnostic or expected/observed mismatch.

After the restoration attempt, or when no update was needed, read the actual
saved settings:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

On success, store the parsed safe output as `FINAL_SETTINGS`. Use its address,
chain, gas price and multiplier for the report and journal. A null multiplier
means the effective default is `1.5`; do not substitute the requested previous
value for an observed null. Verify the final multiplier against the previous
value (or null when the default was intended) before claiming success. A
mismatch is also a `gas_multiplier_restore_failed` error.

If status fails, record `class: "config_status_failed"` with the sanitized
diagnostic. The final settings are **unknown**, not defaulted or restored:
use `"unknown"` for unverified final-state fields. The successful config-write
result can still identify the wallet that was written, but is not a fresh
status observation.

If restoration or verification fails, the new wallet has already been
configured. Set `RUN_OUTCOME` to `"partial"`; explain the diagnostic and actual
final settings. After resolving a restoration failure, retry **only** the
multiplier update above with the non-null previous value, then read status
again. If only the status read failed, retry that read first; never pass null
to `--gas-multiplier`. **Do not generate or import another wallet** to restore
gas settings. If recovery cannot finish in this run, report and journal the
partial result with its structured errors and needed recovery action, then
stop. Do not proceed to optional funding or claim completion.

Set `RUN_OUTCOME` to `"success"` only when no restoration was needed or it
succeeded, and final status confirms the intended multiplier. Use empty errors
and recovery actions when no failure occurred; otherwise retain the diagnostics
and describe the recovery attempted, including whether it succeeded.
