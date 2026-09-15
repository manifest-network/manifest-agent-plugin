'use strict';

// Deterministic loopback model responses. Never generates shell commands or
// approval answers; the terminal driver supplies the human UI inputs.
function outputs(body, host) {
  return host === 'claude'
    ? (body.messages || []).flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((c) => c.type === 'tool_result')
    : (body.input || []).filter((c) => ['custom_tool_call_output', 'function_call_output'].includes(c.type));
}

function replyText(body, host) {
  const result = JSON.stringify(outputs(body, host));
  // These labels reflect received output, never the case's expected result.
  const outcome = result.includes('OPERATION_CANCELLED') ? 'OPERATION_CANCELLED'
    : /\\"status\\":\\"partial\\"/.test(result) ? 'partial'
      : result.includes('LEASE_STATE_ACTIVE') ? 'complete LEASE_STATE_ACTIVE'
        : result.includes('read_only') ? 'read_only' : 'host denied or interrupted tool';
  const lease = result.match(/11111111-1111-4111-8111-111111111111/)?.[0];
  return `Fixture result: ${outcome}${lease ? `; lease ${lease}` : ''}. Terminal fixture finished.`;
}

function claudeEvents(body, { server, tool, args = {} }) {
  const complete = outputs(body, 'claude').length > 0;
  // Claude also asks for background metadata before the user sends a prompt.
  const requested = (body.tools || []).some((t) => t.name === `mcp__plugin_manifest-agent_manifest-${server}__${tool}`);
  const textOnly = complete || !requested;
  const block = textOnly ? { type: 'text', text: '' } : {
    type: 'tool_use', id: 'toolu_fixture', name: `mcp__plugin_manifest-agent_manifest-${server}__${tool}`, input: {},
  };
  const delta = textOnly ? { type: 'text_delta', text: complete ? replyText(body, 'claude') : 'Manifest fixture' }
    : { type: 'input_json_delta', partial_json: JSON.stringify(args) };
  return [
    ['message_start', { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: block }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: textOnly ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function codexEvents(body, { server, tool, args = {} }) {
  const metadata = Boolean(body.text?.format);
  const complete = metadata || outputs(body, 'codex').length > 0;
  const item = complete ? { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [
    { type: 'output_text', text: metadata ? JSON.stringify({ title: 'Manifest fixture' }) : replyText(body, 'codex'), annotations: [] },
  ] } : { id: 'fc_fixture', type: 'custom_tool_call', call_id: 'call_fixture', namespace: 'functions', name: 'exec',
    input: `// @exec: {"yield_time_ms":120000}\ntext(await tools.mcp__manifest_${server}__${tool}(${JSON.stringify(args)}));`, status: 'completed' };
  const base = { id: 'resp_fixture', object: 'response', created_at: 1, model: body.model, output: [], status: 'in_progress' };
  let sequence = 0;
  const event = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`;
  let data = event('response.created', { response: base });
  data += event('response.output_item.added', { output_index: 0, item: complete
    ? { ...item, content: [], status: 'in_progress' } : { ...item, input: '', status: 'in_progress' } });
  if (complete) {
    data += event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    data += event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
    data += event('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text });
    data += event('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
  } else {
    data += event('response.custom_tool_call_input.delta', { item_id: item.id, output_index: 0, delta: item.input });
    data += event('response.custom_tool_call_input.done', { item_id: item.id, output_index: 0, input: item.input });
  }
  data += event('response.output_item.done', { output_index: 0, item });
  return data + event('response.completed', { response: { ...base, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
}

module.exports = { outputs, replyText, claudeEvents, codexEvents };
