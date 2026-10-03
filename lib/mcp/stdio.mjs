import process from 'node:process';
import { once } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

// Official JSONL stdio transport; batch envelopes are not part of these MCP
// versions. Stdout contains protocol messages only, including parse errors.
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const validId = value => (typeof value === 'string' && value.length <= 256) || Number.isSafeInteger(value);

export async function serveMcpStdio({ tools, input = process.stdin, output = process.stdout,
  serverVersion = '1.0.1', maxLineBytes = 1024 * 1024 }) {
  let initialized = false, ready = false;
  const decoder = new StringDecoder('utf8');
  async function send(value) {
    if (!output.write(JSON.stringify(value) + '\n')) await once(output, 'drain');
  }
  const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  async function handle(line) {
    let request;
    try { request = JSON.parse(line); } catch { return error(null, -32700, 'Parse error'); }
    if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
        (own(request, 'id') && !validId(request.id)) ||
        (request.params !== undefined && !object(request.params))) {
      return error(validId(request?.id) ? request.id : null, -32600, 'Invalid Request');
    }
    const { method, params = {}, id } = request;
    if (!own(request, 'id')) {
      if (method === 'notifications/initialized' && initialized) ready = true;
      return;
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'initialize') {
      if (initialized) return error(id, -32600, 'Already initialized');
      if (typeof params.protocolVersion !== 'string' || !object(params.capabilities) ||
          !object(params.clientInfo) || typeof params.clientInfo.name !== 'string' ||
          typeof params.clientInfo.version !== 'string') return error(id, -32602, 'Invalid initialize parameters');
      initialized = true;
      return send({ jsonrpc: '2.0', id, result: {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'hello-cc-scoped', version: serverVersion },
        instructions: 'Tools are restricted to the project and peer supplied by this executor. Task claiming and handoff do not complete tasks.'
      } });
    }
    if (!ready) return error(id, -32002, 'Send initialize and notifications/initialized first');
    if (method === 'tools/list') {
      if (params.cursor !== undefined) return error(id, -32602, 'This server does not paginate tools');
      return send({ jsonrpc: '2.0', id, result: { tools: tools.list() } });
    }
    if (method === 'tools/call') {
      if (typeof params.name !== 'string' || !tools.has(params.name)) return error(id, -32602, 'Unknown tool');
      if (params.arguments !== undefined && !object(params.arguments)) return error(id, -32602, 'Tool arguments must be an object');
      return send({ jsonrpc: '2.0', id, result: await tools.call(params.name, params.arguments || {}) });
    }
    return error(id, -32601, 'Method not found');
  }
  let pending = '', dropping = false;
  for await (const bytes of input) {
    const text = typeof bytes === 'string' ? bytes : decoder.write(bytes);
    let offset = 0;
    for (;;) {
      const newline = text.indexOf('\n', offset);
      const piece = text.slice(offset, newline < 0 ? undefined : newline);
      if (!dropping) {
        pending += piece;
        if (Buffer.byteLength(pending) > maxLineBytes) {
          pending = ''; dropping = true;
          await error(null, -32600, 'Request line is too large');
        }
      }
      if (newline < 0) break;
      if (!dropping && pending.trim()) await handle(pending);
      pending = ''; dropping = false; offset = newline + 1;
    }
  }
  pending += decoder.end();
  if (!dropping && pending.trim()) await handle(pending);
}
