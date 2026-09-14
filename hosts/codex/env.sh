# Consumers: generated Codex skills. Source this file in each Bash shell call.
# Inputs: MANIFEST_CODEX_DATA, XDG_DATA_HOME, CODEX_THREAD_ID (all optional).
# Outputs: MANIFEST_PLUGIN_HOST/ROOT/DATA, MANIFEST_SESSION_ID, NODE_PATH.
# The installed helper path is relative to this file, independent of the cwd
# and any inherited MANIFEST_PLUGIN_ROOT. No config or wallet contents are read.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  echo 'Source env.sh in the shell that will run the skill command.' >&2
  exit 1
fi
_manifest_skill_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || return 1
_manifest_skill_exports="$(node "$_manifest_skill_dir/../../scripts/host-env.cjs" codex --shell)" || {
  unset _manifest_skill_dir _manifest_skill_exports
  return 1
}
eval "$_manifest_skill_exports" || {
  unset _manifest_skill_dir _manifest_skill_exports
  return 1
}
unset _manifest_skill_dir _manifest_skill_exports
