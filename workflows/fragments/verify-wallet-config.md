`write-config.cjs` has already preserved any configured gas multiplier in the
same atomic write as the wallet. No separate gas update is needed.

Read the saved settings before reporting completion:

```bash
node "$MANIFEST_PLUGIN_ROOT/scripts/update-config.cjs" --status
```

On success, store the parsed safe output as `FINAL_SETTINGS` and set
`RUN_OUTCOME` to `"success"`. Report the returned gas price and multiplier;
a null multiplier means the effective default is `1.5`. Keep the returned
value's type, including a numeric string from a hand-edited config.

If status fails, set `RUN_OUTCOME` to `"partial"`. Set `FINAL_SETTINGS.address`
and `FINAL_SETTINGS.activeChain` from the successful `WRITTEN_CONFIG` output,
and set only `gasPrice` and `gasMultiplier` to `"unknown"`. Record one
`config_status_failed` error with the sanitized diagnostic in `message`.
Explain that the wallet was written but the final gas settings could not be
read; do not claim the multiplier reverted to the default or was lost.

Resolve the read failure and retry only `--status`. **Do not generate or import
another wallet** to verify settings. If verification cannot finish in this run,
report and journal the partial result and needed recovery action, then stop.
Use empty errors and recovery actions when no failure occurred; otherwise
retain the diagnostic and describe whether the status retry succeeded.
