import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { createDshCollaboration } from './dsh-collaboration.mjs';
import { scopedMcpToolDefinitions } from '../mcp/tools.mjs';

export const name = 'hello-cc-dsh-collaboration';
export const inject = ['agents', 'tools', 'sessions'];
export const DSH_CORDIS_VERSION = '0.2.0-rc.2';

// A failed retirement is retried only after exact Agent disposal, or by that
// same Agent after its previous plugin context has been disposed.
const retirementRegistryKey = Symbol.for('@logicseek/hello-cc/dsh-cordis/retirements/v1');
if (!Object.hasOwn(globalThis, retirementRegistryKey)) {
  Object.defineProperty(globalThis, retirementRegistryKey, {
    value: Object.freeze({ failedRetirements: new Map(), disposedAgents: new WeakSet() })
  });
}
const retirementRegistry = globalThis[retirementRegistryKey];
if (!(retirementRegistry?.failedRetirements instanceof Map) ||
    !(retirementRegistry?.disposedAgents instanceof WeakSet)) {
  throw new Error('Invalid hello-cc Cordis retirement registry');
}
const { failedRetirements, disposedAgents } = retirementRegistry;

function retire(agent, state, { agentDisposed = false, contextDisposed = false }, forget) {
  let entry = failedRetirements.get(agent);
  if (!entry) {
    entry = { state, agentDisposed, contextDisposed, forget };
    failedRetirements.set(agent, entry);
  } else {
    if (agentDisposed) entry.agentDisposed = true;
    if (contextDisposed) entry.contextDisposed = true;
  }
  entry.state.dispose();
  entry.forget();
  failedRetirements.delete(agent);
}

function retryRetirements(candidate) {
  let root;
  try { root = fs.realpathSync(candidate.session.header.cwd); } catch { return; }
  for (const [agent, entry] of failedRetirements) {
    if (!(entry.agentDisposed || (entry.contextDisposed && agent === candidate)) ||
        entry.state.sessionId !== candidate.session.header.id || entry.state.ctx?.root !== root) continue;
    try { retire(agent, entry.state, {}, entry.forget); } catch {}
  }
}

export function checkDshRuntime(anchor = process.argv[1]) {
  const require = createRequire(path.resolve(anchor));
  for (const pkg of ['dsh-agent', 'dsh-agent-loop', 'dsh-tools', 'dsh-session']) {
    let directory = path.dirname(require.resolve(`@deepseek-ai/${pkg}`));
    let found = false;
    while (path.dirname(directory) !== directory) {
      const file = path.join(directory, 'package.json');
      if (fs.existsSync(file)) {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (manifest.name === `@deepseek-ai/${pkg}`) {
          if (manifest.version !== DSH_CORDIS_VERSION) throw new Error(`hello-cc Cordis requires ${pkg}@${DSH_CORDIS_VERSION}; found ${manifest.version}`);
          found = true;
          break;
        }
      }
      directory = path.dirname(directory);
    }
    if (!found) throw new Error(`Cannot establish the ${pkg} runtime version`);
  }
}

// Tools accepts a deliberately small JSON Schema subset. The shared service
// validates numeric/string bounds even when the presentation cannot encode them.
function toolSchema(value) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems'].includes(key)) continue;
    if (key === 'properties') result[key] = Object.fromEntries(Object.entries(item).map(([k, v]) => [k, toolSchema(v)]));
    else if (key === 'items') result[key] = toolSchema(item);
    else result[key] = item;
  }
  return result;
}
function contextMessage(text) {
  return Object.freeze({ id: randomUUID(), role: 'user',
    source: Object.freeze({ kind: 'hello-cc', form: 'snapshot', sections: [Object.freeze({ name: 'coordination', text })] }),
    content: Object.freeze([Object.freeze({ type: 'text', text })]) });
}

export function createDshCordisPlugin({ checkRuntime = checkDshRuntime, createCollaboration = createDshCollaboration } = {}) {
  return function apply(ctx, config = {}) {
    checkRuntime();
    const bounds = {};
    for (const key of ['maxContextChars', 'maxToolChars']) {
      const value = config[key] ?? 16000;
      if (!Number.isSafeInteger(value) || value < 2048 || value > 64000) throw new TypeError(`${key} must be an integer from 2048 to 64000`);
      bounds[key] = value;
    }
    const states = new Map();
    const pending = new Map();
    let disposed = false;
    function ensure(agent) {
      if (disposed) throw new Error('hello-cc Cordis plugin has been disposed');
      if (!agent?.session?.header) throw new Error('hello-cc tools require an owning Agent');
      if (disposedAgents.has(agent)) throw new Error('hello-cc Cordis Agent has been disposed');
      retryRetirements(agent);
      let state = states.get(agent);
      if (!state) {
        state = createCollaboration({ sessionId: agent.session.header.id, cwd: agent.session.header.cwd, ...bounds });
        states.set(agent, state);
      }
      return state;
    }
    function context(agent) {
      const state = ensure(agent);
      for (const [id, entry] of pending) if (entry.session === agent.session) pending.delete(id);
      const snapshot = state.snapshot();
      const message = contextMessage(snapshot.text);
      if (snapshot.messages.length) pending.set(message.id, { session: agent.session, state, messages: snapshot.messages });
      return { message, snapshot };
    }
    function close(agent) {
      disposedAgents.add(agent);
      const state = states.get(agent) || failedRetirements.get(agent)?.state;
      for (const [id, entry] of pending) if (entry.session === agent.session) pending.delete(id);
      if (state) retire(agent, state, { agentDisposed: true }, () => states.delete(agent));
    }
    // Awaited serial event; no detached setup races with the first model turn.
    ctx.on('agent/created', async ({ agent, signal }) => { signal?.throwIfAborted(); ensure(agent); }, { prepend: true });
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      signal.throwIfAborted();
      ensure(agent);
      const decision = await next();
      if (decision.kind !== 'enter') return decision;
      signal.throwIfAborted();
      const { message } = context(agent);
      return { ...decision, messages: [...decision.messages, message] };
    });
    // ACK only after Harness commits the exact model-visible context. Rejected
    // admission, failed preparation and cancelled turns leave the inbox unread.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return;
      const entry = pending.get(event.data.id);
      if (!entry || entry.session !== session) return;
      pending.delete(event.data.id);
      entry.state.ack(entry.messages);
    });
    ctx.on('agent/status', ({ agent, status }) => { if (states.has(agent)) states.get(agent).status(status); });
    ctx.on('agent/disposed', ({ agent }) => close(agent));
    ctx.on('agent/turn-stopping', ({ agent, signal }) => {
      signal.throwIfAborted();
      const { message, snapshot } = context(agent);
      if (snapshot.complete && snapshot.hasUnread) agent.steer(message);
      else pending.delete(message.id);
    });
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next();
      if (exec.agent && states.has(exec.agent)) states.get(exec.agent).activity('dsh.cordis.tool-observed', exec.name);
      return decision;
    });
    // Registration is owned by this Cordis context, and is removed on disposal.
    // Definitions are shared, but execution authority comes only from exec.agent.
    const probe = scopedMcpToolDefinitions();
    for (const tool of probe) ctx.tools.register({
      name: tool.name, description: tool.description, parameters: toolSchema(tool.inputSchema),
      output: { schema: {}, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => ensure(exec.agent).call(tool.name, args, exec.signal)
    });
    ctx.on('dispose', () => {
      disposed = true;
      pending.clear();
      for (const [agent, state] of states) {
        try { retire(agent, state, { contextDisposed: true }, () => states.delete(agent)); }
        catch (error) { ctx.logger?.warn(String(error)); }
      }
    });
  };
}

export const apply = createDshCordisPlugin();
