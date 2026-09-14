'use strict';

// Host-specific inputs terminate here. Runtime helpers only consume the
// MANIFEST_* contract. In particular a Codex child must not inherit a Claude
// session's selected wallet/data directory.
const { isAbsolute, join, resolve } = require('node:path');
const { homedir } = require('node:os');

function absolute(value, name) {
  if (typeof value !== 'string' || !value || !isAbsolute(value) || value.includes('\0')) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return resolve(value);
}

function resolveHost(host, { env = process.env, pluginRoot = resolve(__dirname, '..'), home = homedir() } = {}) {
  const root = absolute(pluginRoot, 'Plugin root');
  let data;
  let session;
  if (host === 'claude') {
    data = env.CLAUDE_PLUGIN_DATA || env.MANIFEST_PLUGIN_DATA;
    if (!data) throw new Error('Claude plugin data is missing. Restart Claude Code so SessionStart runs.');
    session = env.MANIFEST_SESSION_ID || '';
  } else if (host === 'codex') {
    const xdg = env.XDG_DATA_HOME;
    const base = typeof xdg === 'string' && isAbsolute(xdg) && !xdg.includes('\0')
      ? xdg : join(home, '.local', 'share');
    data = env.MANIFEST_CODEX_DATA || join(base, 'manifest-agent', 'codex');
    session = env.CODEX_THREAD_ID || '';
  } else throw new Error('Host must be claude or codex.');
  const dataDir = absolute(data, `${host} data directory`);
  return {
    host, pluginRoot: root, dataDir,
    env: {
      MANIFEST_PLUGIN_HOST: host,
      MANIFEST_PLUGIN_ROOT: root,
      MANIFEST_PLUGIN_DATA: dataDir,
      NODE_PATH: join(dataDir, 'node_modules'),
      ...(host === 'codex' || session ? { MANIFEST_SESSION_ID: session } : {}),
    },
  };
}

function shellExports(environment) {
  return Object.entries(environment).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error('Invalid environment assignment.');
    }
    return `export ${key}='${value.replaceAll("'", "'\\''")}'`;
  }).join('\n') + '\n';
}

module.exports = { resolveHost, shellExports };
