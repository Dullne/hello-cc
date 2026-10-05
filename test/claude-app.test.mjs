import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { claudeAppCapability, createClaudeAppBridge, writeClaudeAppPlugin } from '../lib/integrations/claude-app.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-app-test-'));
  const callbacks = [];
  const bridge = await createClaudeAppBridge({ root, sessionId: 'real-session-1', pollMs: 100,
    onConnected: value => callbacks.push(['connected', value]),
    onDisconnected: value => callbacks.push(['disconnected', value]), ...options });
  const plugin = writeClaudeAppPlugin({ bridge });
  t.after(async () => { await bridge.close(); plugin.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root: fs.realpathSync(root), originalRoot: root, bridge, plugin, callbacks };
}

async function rpc(f, route, data, { secret = f.bridge.pluginConfig.secret, headers = {} } = {}) {
  const response = await fetch(f.bridge.address + route, { method: 'POST', headers: {
    Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify({ sessionId: 'real-session-1', cwd: f.root, ...data }) });
  return { status: response.status, data: await response.json() };
}

async function connect(f, extra = {}) {
  const response = await rpc(f, '/connect', { version: '2.1.287', surfaces: ['desktop'], instanceId: 'fixture', ...extra });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data.connectionId;
}

async function harness(f, { version = '2.1.287', loseAcceptedResponse = false, submitError = false, dropPrompt = false } = {}) {
  const handlers = new Map(), timers = [], submitted = [], nextCalls = [];
  const current = { id: 'real-session-1', cwd: f.root, version, surfaces: ['desktop'] };
  let fault = loseAcceptedResponse;
  const $ = {
    session: { id: async () => current.id, cwd: async () => current.cwd,
      version: async () => ({ version: current.version }), surfaces: async () => current.surfaces },
    clock: { now: async () => Date.now(), every: (_ms, fn) => {
      const timer = { fn, active: true, cancel() { this.active = false; } }; timers.push(timer); return timer;
    } },
    http: { fetch: async (url, init) => {
      const response = await fetch(url, init), text = await response.text();
      if (fault && url.endsWith('/event') && JSON.parse(init.body).type === 'accepted') {
        fault = false; throw new Error('simulated lost receipt response');
      }
      return { ok: response.ok, status: response.status, text };
    } },
    prompt: { submit: ({ text }) => {
      if (submitError) throw new Error('host synchronously refused this call');
      return (async () => {
        const accepted = await fire('prompt.submit', { text, origin: { kind: 'plugin', name: 'hcc-claude-app' }, wait: false });
        if (accepted.drop) return accepted;
        if (dropPrompt) return { drop: 'another hook refused the prompt' };
        return new Promise(resolve => submitted.push({ text, resolve }));
      })();
    } }
  };
  async function fire(name, event) {
    const next = async value => { nextCalls.push({ name, value }); return name === 'prompt.submit' ? { text: value.text, origin: value.origin } : { untouched: name }; };
    return handlers.get(name)($, event, next);
  }
  const module = await import(pathToFileURL(path.join(f.plugin.directory, 'hooks/register.mjs')).href);
  module.register((name, fn) => handlers.set(name, fn));
  await fire('session.start', { cwd: f.root, surface: 'desktop', isInteractive: true });
  async function pumpUntil(predicate) {
    for (let i = 0; i < 200; i++) {
      for (const timer of timers) if (timer.active) timer.fn();
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.fail('Mod did not reach the expected state');
  }
  return { current, submitted, handlers, timers, nextCalls, fire, pumpUntil,
    async start(turnId = 'turn-1', text = submitted[0]?.text) {
      await fire('turn.start', { turnId, text });
      submitted[0]?.resolve({ text });
    },
    async complete(extra = {}) { return fire('turn.complete', { turnId: 'turn-1', answer: 'reply from existing session', reason: 'answer', isAborted: false, ...extra }); }
  };
}

test('capability requires a stable >= 2.1.287 engine, including current device versions', () => {
  for (const version of ['2.1.204', '2.1.217', '2.1.286', '2.1.287-dev.x', '', null, 'not-a-version']) {
    assert.equal(claudeAppCapability(version).supported, false);
  }
  for (const version of ['2.1.287', '2.1.289', '2.2.0', '3.0.0']) assert.equal(claudeAppCapability(version).supported, true);
});

test('bridge admits only its capability, exact identity, supported engine and Desktop surface', async t => {
  const f = await fixture(t);
  assert.throws(() => f.bridge.send({ sessionId: 'real-session-1', requestId: 'q1', text: 'hello' }), { code: 'CLAUDE_APP_NOT_CONNECTED' });
  const base = { version: '2.1.287', surfaces: ['desktop'], instanceId: 'fixture' };
  assert.equal((await rpc(f, '/connect', base, { secret: 'wrong' })).status, 401);
  assert.equal((await rpc(f, '/connect', base, { headers: { Origin: 'https://example.com' } })).status, 403);
  for (const [extra, code] of [
    [{ sessionId: 'someone-else' }, 'CLAUDE_APP_IDENTITY_MISMATCH'],
    [{ cwd: path.dirname(f.root) }, 'CLAUDE_APP_IDENTITY_MISMATCH'],
    [{ peer: 'native-owner' }, 'BAD_ARGS'],
    [{ version: '2.1.217' }, 'CLAUDE_APP_ENGINE_UNSUPPORTED'],
    [{ surfaces: ['terminal'] }, 'CLAUDE_APP_DESKTOP_REQUIRED']
  ]) assert.equal((await rpc(f, '/connect', { ...base, ...extra })).data.error.code, code);
  const connectionId = await connect(f);
  assert.equal(f.bridge.list()[0].ready, true);
  assert.equal(f.callbacks.filter(([name]) => name === 'connected').length, 1);
  assert.equal(JSON.stringify(f.callbacks).includes(f.bridge.pluginConfig.secret), false);
  assert.equal((await rpc(f, '/poll', { connectionId: 'other' })).data.error.code, 'CLAUDE_APP_CONNECTION_STALE');
  assert.equal((await rpc(f, '/connect', { ...base, instanceId: 'second-mod' })).data.error.code, 'CLAUDE_APP_ALREADY_CONNECTED');
  assert.equal((await rpc(f, '/poll', { connectionId })).data.request, null);
});

test('generated opt-in plugin is private and one-session scoped without changing user settings', async t => {
  const f = await fixture(t);
  assert.equal(fs.statSync(f.plugin.marketplaceDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(f.plugin.directory).mode & 0o777, 0o700);
  const sourcePath = path.join(f.plugin.directory, 'hooks/register.mjs');
  assert.equal(fs.statSync(sourcePath).mode & 0o777, 0o600);
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.ok(source.includes(f.bridge.pluginConfig.secret));
  assert.ok(source.includes('$.session.id()')); assert.ok(source.includes('$.session.cwd()'));
  assert.equal(source.includes('asUser: true'), false);
  assert.equal(source.includes('$.session.authorize('), false);
  assert.deepEqual(fs.readdirSync(f.root), []);
  assert.throws(() => writeClaudeAppPlugin({ directory: f.plugin.directory, bridge: f.bridge }), { code: 'EEXIST' });
});

test('generated marketplace identifies its contained plugin and cannot reuse another bridge run cache', async t => {
  const f = await fixture(t), other = writeClaudeAppPlugin({ bridge: f.bridge });
  t.after(() => other.dispose());
  assert.notEqual(f.plugin.marketplace, other.marketplace);
  assert.notEqual(f.plugin.version, other.version);
  for (const plugin of [f.plugin, other]) {
    const manifestPath = path.join(plugin.marketplaceDirectory, '.claude-plugin/marketplace.json');
    const marketplace = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin.directory, '.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(fs.statSync(manifestPath).mode & 0o777, 0o600);
    assert.equal(marketplace.name, plugin.marketplace);
    assert.equal(marketplace.plugins[0].name, plugin.name);
    assert.equal(manifest.name, plugin.name);
    assert.equal(manifest.version, plugin.version);
    assert.equal(path.resolve(plugin.marketplaceDirectory, marketplace.plugins[0].source), plugin.directory);
    assert.equal(JSON.stringify(marketplace).includes(f.bridge.pluginConfig.secret), false);
  }
});

test('plugin cleanup refuses a replaced directory and remains idempotent after its own removal', async t => {
  const f = await fixture(t), plugin = writeClaudeAppPlugin({ bridge: f.bridge });
  const original = `${plugin.marketplaceDirectory}-original`;
  fs.renameSync(plugin.marketplaceDirectory, original);
  fs.mkdirSync(plugin.marketplaceDirectory);
  const sentinel = path.join(plugin.marketplaceDirectory, 'preserve-me');
  fs.writeFileSync(sentinel, 'replacement belongs to someone else');
  t.after(() => {
    fs.rmSync(plugin.marketplaceDirectory, { recursive: true, force: true });
    fs.rmSync(original, { recursive: true, force: true });
  });
  assert.throws(() => plugin.dispose(), { code: 'CLAUDE_APP_PLUGIN_PATH_CHANGED' });
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'replacement belongs to someone else');
  assert.ok(fs.existsSync(path.join(original, 'plugin/hooks/register.mjs')));
  f.plugin.dispose();
  assert.doesNotThrow(() => f.plugin.dispose());
});

test('real HTTP plus mocked official Mod events complete only the exact bound main turn', async t => {
  const f = await fixture(t), h = await harness(f);
  await h.pumpUntil(() => f.bridge.list()[0].ready);
  const queued = f.bridge.send({ sessionId: 'real-session-1', requestId: 'request-1', text: 'read-only task' });
  assert.equal(queued.status, 'queued'); assert.equal(queued.answer, null);
  await h.pumpUntil(() => h.submitted.length === 1);
  assert.equal(f.bridge.getRequest('request-1').status, 'claimed');
  await h.fire('turn.start', { turnId: 'human-turn', text: 'a person asked something else' });
  await h.complete({ turnId: 'human-turn', answer: 'unrelated reply' });
  await h.pumpUntil(() => f.bridge.getRequest('request-1').accepted);
  assert.equal(f.bridge.getRequest('request-1').answer, null);
  await h.start();
  await h.pumpUntil(() => f.bridge.getRequest('request-1').status === 'started');
  await h.complete({ agentId: 'subagent-1', answer: 'not the parent reply' });
  assert.equal(f.bridge.getRequest('request-1').status, 'started');
  assert.deepEqual(await h.complete(), { untouched: 'turn.complete' });
  await h.pumpUntil(() => f.bridge.getRequest('request-1').status === 'completed');
  const complete = f.bridge.getRequest('request-1');
  assert.equal(complete.turnId, 'turn-1'); assert.equal(complete.answer, 'reply from existing session');
  assert.equal(f.bridge.send({ sessionId: 'real-session-1', requestId: 'request-1', text: 'read-only task' }).status, 'completed');
  assert.equal(h.submitted.length, 1);
  assert.throws(() => f.bridge.send({ sessionId: 'real-session-1', requestId: 'request-1', text: 'different task' }), { code: 'CLAUDE_APP_REQUEST_CONFLICT' });
  assert.throws(() => f.bridge.send({ sessionId: 'other', requestId: 'request-2', text: 'task' }), { code: 'CLAUDE_APP_IDENTITY_MISMATCH' });
  await h.fire('session.end', { reason: 'logout' });
});

test('lost receipt response retries the receipt but submits the model prompt once', async t => {
  const f = await fixture(t), h = await harness(f, { loseAcceptedResponse: true });
  await h.pumpUntil(() => f.bridge.list()[0].ready);
  f.bridge.send({ sessionId: 'real-session-1', requestId: 'lost-receipt', text: 'do it once' });
  await h.pumpUntil(() => h.submitted.length === 1);
  await h.start(); await h.complete();
  await h.pumpUntil(() => f.bridge.getRequest('lost-receipt').status === 'completed');
  assert.equal(h.submitted.length, 1);
  await h.fire('session.end', { reason: 'other' });
});

test('synchronous host rejection and another hook dropping a prompt settle without replay or ACK', async t => {
  for (const [option, status] of [['submitError', 'uncertain'], ['dropPrompt', 'rejected']]) {
    const f = await fixture(t), h = await harness(f, { [option]: true });
    await h.pumpUntil(() => f.bridge.list()[0].ready);
    f.bridge.send({ sessionId: 'real-session-1', requestId: option, text: 'respect the host policy' });
    await h.pumpUntil(() => f.bridge.getRequest(option).status === status);
    assert.equal(h.submitted.length, 0);
    assert.equal(f.bridge.getRequest(option).answer, null);
    await h.fire('session.end', { reason: 'other' });
  }
});

test('queued requests stay serialized and background agent events cannot hold the main session busy', async t => {
  const f = await fixture(t), h = await harness(f);
  await h.pumpUntil(() => f.bridge.list()[0].ready);
  await h.fire('turn.start', { agentId: 'background-agent', turnId: 'agent-turn', text: 'unrelated background work' });
  f.bridge.send({ sessionId: 'real-session-1', requestId: 'first', text: 'first task' });
  f.bridge.send({ sessionId: 'real-session-1', requestId: 'second', text: 'second task' });
  await h.pumpUntil(() => h.submitted.length === 1);
  await h.start('turn-first');
  await h.pumpUntil(() => f.bridge.getRequest('first').status === 'started');
  assert.equal(h.submitted.length, 1);
  await h.complete({ turnId: 'turn-first' });
  await h.pumpUntil(() => h.submitted.length === 2);
  assert.equal(f.bridge.getRequest('first').status, 'completed');
  assert.equal(f.bridge.getRequest('second').status, 'claimed');
  await h.fire('session.end', { reason: 'other' });
});

test('abort and session changes remain incomplete, never pass a queued prompt to a different session', async t => {
  const f = await fixture(t), h = await harness(f);
  await h.pumpUntil(() => f.bridge.list()[0].ready);
  f.bridge.send({ sessionId: 'real-session-1', requestId: 'abort', text: 'task' });
  await h.pumpUntil(() => h.submitted.length === 1);
  await h.start(); await h.complete({ isAborted: true, reason: 'aborted', answer: 'partial' });
  await h.pumpUntil(() => f.bridge.getRequest('abort').status === 'aborted');
  const queued = f.bridge.send({ sessionId: 'real-session-1', requestId: 'old-session', text: 'never inject elsewhere' });
  h.current.id = 'replacement-session';
  const dropped = await h.fire('prompt.submit', { text: queued.prompt, origin: { kind: 'plugin', name: 'hcc-claude-app' } });
  assert.ok(dropped.drop);
  await h.pumpUntil(() => !f.bridge.list()[0].ready);
  assert.equal(f.bridge.getRequest('old-session').status, 'uncertain');
  assert.equal(h.submitted.length, 1);
  assert.equal(h.timers[0].active, false);
});

test('approval/busy turns preserve heartbeat and defer submission until idle', async t => {
  const f = await fixture(t), h = await harness(f);
  await h.pumpUntil(() => f.bridge.list()[0].ready);
  await h.fire('turn.start', { turnId: 'busy-human', text: 'existing approval-gated work' });
  f.bridge.send({ sessionId: 'real-session-1', requestId: 'wait', text: 'wait until idle' });
  await h.pumpUntil(() => f.bridge.getRequest('wait').status === 'claimed');
  assert.equal(h.submitted.length, 0);
  await h.complete({ turnId: 'busy-human' });
  await h.pumpUntil(() => h.submitted.length === 1);
  await h.fire('session.end', { reason: 'clear' });
  assert.equal(f.bridge.getRequest('wait').status, 'uncertain');
});

test('completion cannot skip observed start or name another turn; stale connections cannot report results', async t => {
  const f = await fixture(t), connectionId = await connect(f);
  f.bridge.send({ sessionId: 'real-session-1', requestId: 'sequence', text: 'task' });
  await rpc(f, '/poll', { connectionId });
  const accepted = { connectionId, eventId: 'event-1', requestId: 'sequence', type: 'accepted' };
  assert.equal((await rpc(f, '/event', accepted)).status, 200);
  assert.equal((await rpc(f, '/event', accepted)).status, 200);
  assert.equal((await rpc(f, '/event', { ...accepted, type: 'started', turnId: 'turn-a' })).data.error.code, 'CLAUDE_APP_EVENT_CONFLICT');
  assert.equal((await rpc(f, '/event', { ...accepted, eventId: 'event-2', type: 'completed', turnId: 'turn-a', answer: 'forged' })).data.error.code, 'CLAUDE_APP_TURN_MISMATCH');
  await rpc(f, '/event', { ...accepted, eventId: 'event-3', type: 'started', turnId: 'turn-a' });
  assert.equal((await rpc(f, '/event', { ...accepted, eventId: 'event-4', type: 'completed', turnId: 'turn-b', answer: 'wrong' })).data.error.code, 'CLAUDE_APP_TURN_MISMATCH');
  await rpc(f, '/disconnect', { connectionId, reason: 'reload' });
  assert.equal((await rpc(f, '/event', { ...accepted, eventId: 'event-5', type: 'completed', turnId: 'turn-a', answer: 'late' })).data.error.code, 'CLAUDE_APP_CONNECTION_STALE');
  assert.equal(f.bridge.getRequest('sequence').status, 'uncertain');
});

test('terminal release restores capacity and repeated completion receipts survive release', async t => {
  const f = await fixture(t, { maxRequests: 1 }), connectionId = await connect(f);
  let firstCompletion;
  for (let i = 1; i <= 2; i++) {
    const requestId = `sequential-${i}`, turnId = `turn-${i}`;
    f.bridge.send({ sessionId: 'real-session-1', requestId, text: `task ${i}` });
    assert.throws(() => f.bridge.releaseRequest(requestId), { code: 'CLAUDE_APP_REQUEST_PENDING' });
    assert.throws(() => f.bridge.send({ sessionId: 'real-session-1', requestId: `overflow-${i}`, text: 'queue full' }), { code: 'CLAUDE_APP_QUEUE_FULL' });
    assert.equal((await rpc(f, '/poll', { connectionId })).data.request.requestId, requestId);
    for (const type of ['accepted', 'started']) {
      const response = await rpc(f, '/event', { connectionId, requestId, eventId: `${requestId}-${type}`, type,
        ...(type === 'started' ? { turnId } : {}) });
      assert.equal(response.status, 200);
    }
    const completion = { connectionId, requestId, eventId: `${requestId}-completed`, type: 'completed', turnId, answer: `answer ${i}` };
    assert.equal((await rpc(f, '/event', completion)).status, 200);
    assert.equal(f.bridge.getRequest(requestId).status, 'completed');
    assert.equal(f.bridge.releaseRequest(requestId), true);
    assert.equal(f.bridge.getRequest(requestId), null);
    assert.equal(f.bridge.releaseRequest(requestId), false);
    assert.equal((await rpc(f, '/event', completion)).status, 200);
    assert.equal((await rpc(f, '/event', { ...completion, answer: 'changed receipt' })).data.error.code, 'CLAUDE_APP_EVENT_CONFLICT');
    firstCompletion ||= completion;
  }
  assert.equal((await rpc(f, '/event', firstCompletion)).status, 200);
});

test('root replacement revokes readiness instead of moving delivery to a pathname replacement', async t => {
  const f = await fixture(t);
  await connect(f);
  const moved = f.originalRoot + '-original';
  fs.renameSync(f.originalRoot, moved); fs.mkdirSync(f.originalRoot);
  t.after(() => fs.rmSync(moved, { recursive: true, force: true }));
  assert.throws(() => f.bridge.send({ sessionId: 'real-session-1', requestId: 'rebound', text: 'must not send' }), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(f.callbacks.at(-1)[0], 'disconnected');
});

test('bridge rejects a root replaced after the caller captured its startup identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-app-startup-test-'));
  const moved = `${root}-original`;
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(moved, { recursive: true, force: true });
  });
  const initialRootIdentity = captureSelectedCwdSnapshot(root);
  fs.renameSync(root, moved);
  fs.mkdirSync(root);
  await assert.rejects(createClaudeAppBridge({ root, initialRootIdentity, sessionId: 'existing-session' }),
    { code: 'PROJECT_PATH_CHANGED' });
  assert.deepEqual(fs.readdirSync(root), []);
});
