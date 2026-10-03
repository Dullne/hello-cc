// Disposable stdio MCP server for installed-model form acceptance.
// Only synthetic inputs from this harness are recorded; no provider credentials.
import fs from 'node:fs';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
if (!args.includes('--stdio')) {
  console.log('Acceptance fixture only: node scripts/mcp-form-live-fixture.mjs --stdio --log FILE');
  process.exit(0);
}
const logIndex = args.indexOf('--log');
if (logIndex < 0 || !args[logIndex + 1]) throw new Error('--log FILE is required');
const logPath = args[logIndex + 1];
const pending = new Map();
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const record = value => fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + '\n', { mode: 0o600 });
const reply = (id, result) => write({ id, result });
const schema = {
  type: 'object',
  properties: {
    project: { type: 'string', title: 'Project name / 项目名', minLength: 3, maxLength: 64 },
    count: { type: 'integer', title: 'Run count / 次数', minimum: 1, maximum: 4 },
    enabled: { type: 'boolean', title: 'Enable extra operation / 开启额外操作' },
    region: { type: 'string', title: 'Region / 地区', enum: ['eu', 'us'], enumNames: ['Europe', 'USA'] },
    features: { type: 'array', title: 'Features / 功能', minItems: 1, maxItems: 2,
      items: { type: 'string', enum: ['logs', 'tests'] } },
    note: { type: 'string', title: 'Optional note / 可选备注', default: 'suggested-but-not-automatically-submitted' }
  },
  required: ['project', 'count', 'enabled', 'region', 'features']
};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { write({ id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
  const { id, method, params = {} } = message;
  if (!method) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer);
    record({ event: 'form-response', phase: entry.phase, elicitationId: id, response: message.result ?? null,
      ...(message.error ? { error: { code: message.error.code } } : {}) });
    if (message.error) { reply(entry.callId, { content: [{ type: 'text', text: 'Form failed' }], isError: true }); return; }
    reply(entry.callId, { content: [{ type: 'text', text: JSON.stringify({ phase: entry.phase, ...message.result }) }] });
    return;
  }
  if (method === 'initialize') {
    record({ event: 'initialize', protocolVersion: params.protocolVersion, clientName: params.clientInfo?.name,
      elicitationCapabilities: params.capabilities?.elicitation ?? null });
    reply(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} },
      serverInfo: { name: 'hcc-form-live-acceptance', version: '1.0.0' } });
  } else if (method === 'notifications/initialized') {
    record({ event: 'ready' });
  } else if (method === 'ping') {
    reply(id, {});
  } else if (method === 'tools/list') {
    reply(id, { tools: [{ name: 'collect_project_settings',
      description: 'Ask the human for project settings in a typed MCP form. Wait for their response and return the selected values.',
      inputSchema: { type: 'object', properties: { phase: { type: 'string', enum: ['native', 'web-owned'] } },
        required: ['phase'], additionalProperties: false } }] });
  } else if (method === 'tools/call') {
    const phase = params.arguments?.phase;
    if (params.name !== 'collect_project_settings' || !['native', 'web-owned'].includes(phase)) {
      write({ id, error: { code: -32602, message: 'Unknown acceptance tool or phase' } }); return;
    }
    const elicitationId = 'acceptance-form-' + randomUUID();
    const timer = setTimeout(() => {
      if (!pending.delete(elicitationId)) return;
      record({ event: 'form-timeout', phase, elicitationId });
      reply(id, { content: [{ type: 'text', text: 'Acceptance form timed out' }], isError: true });
    }, 240000);
    pending.set(elicitationId, { callId: id, phase, timer });
    record({ event: 'tool-called', phase, elicitationId });
    write({ id: elicitationId, method: 'elicitation/create', params: { mode: 'form',
      message: 'Acceptance only: provide synthetic project settings / 验收表单：填写合成项目参数', requestedSchema: schema } });
    record({ event: 'form-requested', phase, elicitationId });
  } else if (id !== undefined) {
    write({ id, error: { code: -32601, message: 'Method not found' } });
  }
});
lines.on('close', () => { for (const entry of pending.values()) clearTimeout(entry.timer); pending.clear(); });
