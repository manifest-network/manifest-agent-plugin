'use strict';

const { createInterface } = require('node:readline');

// Shared subprocess harness; tracks responses separately from server requests
// because both peers can use the same request ID space.
function peer(child, { timeoutMs = 20000, jsonrpc = true, onRequest = () => { throw new Error('Unexpected server request'); }, onNotification = () => {} } = {}) {
  let sequence = 0;
  let stderr = '';
  let failure;
  const pending = new Map();
  const messages = [];
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); });
  const send = (message) => child.stdin.write(JSON.stringify(jsonrpc ? { jsonrpc: '2.0', ...message } : message) + '\n');
  const fail = (error) => {
    failure = error;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout });
  lines.on('line', async (line) => {
    try {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.method) {
        if (message.id !== undefined) send({ id: message.id, result: await onRequest(message) });
        else onNotification(message);
      } else if (pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
    } catch (error) { fail(error); }
  });
  child.on('error', fail);
  child.on('close', (code, signal) => fail(new Error(`JSON-RPC process exited ${signal || code}: ${stderr}`)));
  function request(method, params) {
    const id = ++sequence;
    const result = new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timed out: ${method}. ${stderr}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
    });
    result.id = id;
    return result;
  }
  async function close() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const ended = new Promise((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await ended;
    clearTimeout(timer);
    lines.close();
  }
  return { request, send, close, messages, get stderr() { return stderr; } };
}
module.exports = { peer };
