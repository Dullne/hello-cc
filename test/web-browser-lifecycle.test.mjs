import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSessionSync } from '../lib/web/browser/session-sync.mjs';

// Execute the shipped ESM's lifecycle functions with controlled collaborators.
// The complete public module graph is parsed by web-browser-assets.test.mjs;
// browser acceptance exercises the complete bootstrap and real DOM separately.
const source = fs.readFileSync(new URL('../lib/web/browser/core.mjs', import.meta.url), 'utf8');
function shippedFunction(name) {
  const start = ['    async function ', '    function ']
    .map(prefix => source.indexOf(prefix + name + '(')).find(index => index >= 0) ?? -1;
  assert.ok(start >= 0);
  const end = source.indexOf('\n    }', start);
  assert.ok(end > start);
  return source.slice(start, end + 6);
}
function shippedListener(startMarker, endMarker) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test('project loading canonicalizes explicit roots before binding structured session state', async () => {
  for (const requested of ['/project/', '/alias/project', 'relative-project', '']) {
    const scopes = [], rendered = [], locations = [];
    const context = vm.createContext({ currentProject: requested, projects: [],
      api: async () => ({ projects: [{ root: '/project' }], current: { root: '/project' } }),
      projectRequests: { setRoot: value => scopes.push(value) },
      renderProjects: () => rendered.push(context.currentProject),
      updateLocationProject: () => locations.push(context.currentProject)
    });
    vm.runInContext(shippedFunction('loadProjects'), context);
    await vm.runInContext('loadProjects()', context);
    assert.equal(context.currentProject, '/project');
    assert.deepEqual(scopes, ['/project']);
    assert.deepEqual(rendered, ['/project']);
    assert.deepEqual(locations, ['/project']);
    let accepted = 0, recoveries = 0;
    const receiver = createSessionSync({ root: context.currentProject, sessionId: 'native-one', onState: () => accepted++, requestSnapshot: () => recoveries++ });
    receiver.receive({ type: 'state_sync', protocol: 1, root: '/project', sessionId: 'native-one', executorId: 'executor',
      generation: 'generation', revision: 0, channel: 'native', mode: 'snapshot', state: { executorId: 'executor' } });
    assert.equal(accepted, 1); assert.equal(recoveries, 0);
  }
});

test('adding a project selects the server-returned canonical root and never the typed alias', async () => {
  const elements = new Map(), selections = [], requests = [];
  const node = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, hidden: false, value: '', textContent: '',
      addEventListener(type, callback) { this[type] = callback; } });
    return elements.get(id);
  };
  node('projectPath').value = ' /project-alias/ ';
  const context = vm.createContext({ document: { getElementById: node }, currentProject: '/old-project', projectDialog: node('projectDialog'),
    api: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { project: { root: '/canonical-project' } }; },
    loadProjects: async () => {}, switchProject: async root => selections.push(root),
    closeDialog: dialog => { dialog.hidden = true; }, tr: (_key, fallback) => fallback
  });
  vm.runInContext(shippedListener("    document.getElementById('projectForm').addEventListener", '\n    function clearSessionFilters'), context);
  await node('projectForm').submit({ preventDefault() {} });
  assert.deepEqual(requests, [{ url: '/api/projects', body: { root: '/project-alias/' } }]);
  assert.deepEqual(selections, ['/canonical-project']);
  assert.equal(node('projectDialog').hidden, true);
  assert.equal(node('projectDialogError').hidden, true);
  assert.equal(node('addProjectBtn').disabled, false);
});

test('bfcache restoration reloads disposed lifecycles once without replaying input or mutations', () => {
  const handlers = new Map(), calls = [];
  const context = vm.createContext({
    window: { addEventListener: (event, callback) => handlers.set(event, callback) },
    location: { reload: () => calls.push('reload') },
    stopDataPoll: () => calls.push('stop-data'), stopProjectPoll: () => calls.push('stop-projects'),
    projectRequests: { dispose: () => calls.push('dispose-requests') },
    fetch: () => { throw new Error('Restoration must not send a request or input'); }
  });
  vm.runInContext(shippedListener("    window.addEventListener('pagehide', () => { stopDataPoll();", '\n    stopCancelBtn.addEventListener'), context);
  handlers.get('pageshow')({ persisted: false });
  assert.deepEqual(calls, []);
  handlers.get('pagehide')({ persisted: true });
  assert.deepEqual(calls, ['stop-data', 'stop-projects', 'dispose-requests']);
  handlers.get('pageshow')({ persisted: true });
  assert.deepEqual(calls, ['stop-data', 'stop-projects', 'dispose-requests', 'reload']);
});

function reconnectFixture() {
  const sockets = [], timers = new Map(), sent = [], labels = [], requests = [];
  let nextTimer = 0, listed = [{ id: 'a', type: 'native', status: 'running' }];
  class Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 3;
    constructor(url) { this.url = url; this.readyState = Socket.CONNECTING; sockets.push(this); }
    send(text) { sent.push(JSON.parse(text)); }
    close(code = 1001) { this.readyState = Socket.CLOSED; this.onclose?.({ code }); }
  }
  const context = vm.createContext({
    WebSocket: Socket, createSessionSync, structuredClone,
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    location: { protocol: 'http:', host: 'hcc.invalid' }, currentProject: '/project',
    runtimeApiVersion: 1, requestQuery: () => '',
    ws: null, wsReconnectTimer: null, wsReconnectTarget: null, wsReconnectFailures: 0,
    active: 'a', activeType: 'managed', activeDetected: null,
    activeConnectionState: 'offline', activeLocalClients: null, lastSentTerminalSize: null,
    sessions: structuredClone(listed), sessionsLoaded: true,
    sessionActionTokens: new Map(), sessionControls: new Map(),
    handoffStore: { uncertain() {} }, window: { hccNative: { render() {} } },
    navigator: { onLine: true }, loggedOut: false,
    renderHandoff() {}, renderSections() {}, renderActiveSession() {},
    terminalPinned: () => true, writeTerminalSnapshot() {}, resizeTerm() {},
    connText: label => labels.push(label),
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    api: async (url, options) => {
      requests.push({ url, options });
      assert.equal(url, '/api/sessions'); assert.equal(options, undefined);
      return { sessions: structuredClone(listed) };
    }
  });
  vm.runInContext([
    shippedFunction('canControl'), shippedFunction('disconnectWebSocket'), shippedFunction('refreshSessions'),
    shippedListener('    function openWs(', '\n    // ── Connect to detected')
  ].join('\n'), context);
  function tick() {
    const [id, timer] = timers.entries().next().value || [];
    assert.ok(timer, 'Expected one scheduled reconnect');
    timers.delete(id); timer.callback(); return timer.delay;
  }
  function snapshot(socket, canControl = false) {
    socket.readyState = Socket.OPEN; socket.onopen();
    socket.onmessage({ data: JSON.stringify({ type: 'snapshot', action_token: 'fresh-token',
      control: { can_control: canControl, epoch: 2 }, native_state: { connected: true } }) });
  }
  return { context, sockets, timers, sent, labels, requests, Socket, tick, snapshot,
    run: code => vm.runInContext(code, context),
    list: status => { listed = [{ id: 'a', type: 'native', status }]; },
    refresh: () => vm.runInContext('refreshSessions()', context)
  };
}

test('a recovered session resumes bounded WebSocket reconnect after the first timer saw it disconnected', async () => {
  const f = reconnectFixture();
  f.run("openWs('a')"); f.snapshot(f.sockets[0], true);
  assert.equal(f.run('canControl()'), true);
  f.sockets[0].close();
  assert.equal(f.run('canControl()'), false);
  f.list('disconnected'); await f.refresh();
  assert.equal(f.tick(), 750);
  assert.equal(f.sockets.length, 1); assert.equal(f.timers.size, 0);
  f.list('running'); await f.refresh();
  assert.equal(f.timers.size, 1, 'A later running list must resume the pending reconnect');
  await f.refresh();
  assert.equal(f.timers.size, 1, 'Polling must not duplicate or bypass backoff');
  assert.equal(f.tick(), 750); assert.equal(f.sockets.length, 2);
  assert.equal(f.context.sessionActionTokens.size, 0);
  assert.equal(f.run('canControl()'), false);
  await f.refresh();
  assert.equal(f.timers.size, 0, 'A connecting socket must not be duplicated');
  f.snapshot(f.sockets[1]);
  assert.equal(f.run('canControl()'), false, 'A fresh token alone cannot grant control');
  await f.refresh();
  assert.equal(f.sockets.length, 2); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.sent, [], 'Recovery must not replay input, approvals, or control claims');
  f.sockets[1].onmessage({ data: JSON.stringify({ type: 'control', control: { can_control: true, epoch: 3 } }) });
  assert.equal(f.run('canControl()'), true);
});

test('session-list recovery preserves reconnect backoff and the five-attempt limit', async () => {
  const f = reconnectFixture();
  f.run("openWs('a')");
  for (const delay of [750, 1500, 3000, 6000, 12000]) {
    f.sockets.at(-1).close();
    await f.refresh(); await f.refresh();
    assert.equal(f.timers.size, 1);
    assert.equal(f.tick(), delay);
  }
  f.sockets.at(-1).close();
  f.list('disconnected'); await f.refresh();
  f.list('running'); await f.refresh(); await f.refresh();
  assert.equal(f.timers.size, 0); assert.equal(f.sockets.length, 6);
  assert.equal(f.run('canControl()'), false); assert.deepEqual(f.sent, []);
});

test('pending reconnects cannot cross projects, selected sessions, logout, or offline state', async () => {
  for (const change of ["currentProject = '/other'", "active = 'b'", "activeType = 'detected'", 'loggedOut = true', 'navigator.onLine = false']) {
    const f = reconnectFixture();
    f.run("openWs('a')"); f.sockets[0].close();
    f.run(change); f.tick(); await f.refresh();
    assert.equal(f.sockets.length, 1, change); assert.equal(f.timers.size, 0, change);
    assert.equal(f.run('canControl()'), false, change); assert.deepEqual(f.sent, []);
  }
});

test('selection teardown and a manual connection cancel pending reconnects without replacing the new socket', async () => {
  const f = reconnectFixture();
  f.run("openWs('a')"); f.sockets[0].close();
  const staleTimer = [...f.timers.values()][0].callback;
  f.run("disconnectWebSocket(); currentProject = '/other'; active = 'a'; openWs('a')");
  assert.equal(f.timers.size, 0);
  staleTimer(); await f.refresh();
  assert.equal(f.sockets.length, 2); assert.equal(f.timers.size, 0);
  f.snapshot(f.sockets[1]); await f.refresh();
  assert.equal(f.context.ws, f.sockets[1]); assert.equal(f.sockets.length, 2);
  assert.equal(f.run('canControl()'), false); assert.deepEqual(f.sent, []);
});

test('authentication closure and an offline closure are not revived by session-list polling', async () => {
  for (const offline of [false, true]) {
    const f = reconnectFixture();
    f.run("openWs('a')");
    if (offline) f.context.navigator.onLine = false;
    f.sockets[0].close(offline ? 1001 : 4001);
    f.context.navigator.onLine = true;
    await f.refresh();
    assert.equal(f.sockets.length, 1); assert.equal(f.timers.size, 0);
    assert.equal(f.run('canControl()'), false); assert.deepEqual(f.sent, []);
  }
});
