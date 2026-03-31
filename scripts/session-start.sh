#!/usr/bin/env bash
# Export MANIFEST_PLUGIN_ROOT so skills can reference plugin scripts in bash commands.
if [ -n "$CLAUDE_ENV_FILE" ]; then
  echo "export MANIFEST_PLUGIN_ROOT=\"${CLAUDE_PLUGIN_ROOT}\"" >> "$CLAUDE_ENV_FILE"
fi
