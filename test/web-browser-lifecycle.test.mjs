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
function shippedSyncFunction(name) {
  const start = source.indexOf('    function ' + name + '(');
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
      api: async () => ({ projects: [{ root: '/project' }], current: { root: '/project' }, project_identity: 'identity-A' }),
      projectRequests: { rootIdentity: () => 'identity-A', setRoot: (value, identity) => scopes.push([value, identity]) },
      renderProjects: () => rendered.push(context.currentProject),
      updateLocationProject: () => locations.push(context.currentProject)
    });
    vm.runInContext(shippedFunction('loadProjects'), context);
    await vm.runInContext('loadProjects()', context);
    assert.equal(context.currentProject, '/project');
    assert.deepEqual(scopes, [['/project', 'identity-A']]);
    assert.deepEqual(rendered, ['/project']);
    assert.deepEqual(locations, ['/project']);
    let accepted = 0, recoveries = 0;
    const receiver = createSessionSync({ root: context.currentProject, sessionId: 'native-one', onState: () => accepted++, requestSnapshot: () => recoveries++ });
    receiver.receive({ type: 'state_sync', protocol: 1, root: '/project', sessionId: 'native-one', executorId: 'executor',
      generation: 'generation', revision: 0, channel: 'native', mode: 'snapshot', state: { executorId: 'executor' } });
    assert.equal(accepted, 1); assert.equal(recoveries, 0);
  }
});

test('untrusted project and root deep links require a user submit before selecting their directory', async () => {
  for (const key of ['project', 'root']) for (const suppliedIdentity of ['', 'unsigned-inode-record']) {
    const calls = [], opened = [], selected = [], nodes = new Map();
    const node = id => {
      if (!nodes.has(id)) nodes.set(id, { disabled: false, hidden: true, value: '', textContent: '',
        addEventListener(type, callback) { this[type] = callback; } });
      return nodes.get(id);
    };
    const requested = '/other server directory';
    const context = vm.createContext({
      initialParams: new URLSearchParams([[key, requested], ...(suppliedIdentity ? [['root_identity', suppliedIdentity]] : [])]), paneMode: false,
      headers: {}, sharedProjectBroker: () => ({}),
      sessionStorage: { getItem: () => null },
      createProjectRequests: ({ root, rootIdentity }) => {
        assert.equal(root, ''); assert.equal(rootIdentity, '');
        return { rootIdentity: () => '', setRoot: () => {} };
      },
      document: { getElementById: node }, projectDialog: node('projectDialog'),
      api: async (url, options) => {
        calls.push([url, options?.method || 'GET']);
        if (url === '/api/projects/select') return { projects: [{ root: '/safe' }], current: { root: '/safe' }, project_identity: 'safe-identity' };
        return { project: { root: requested }, project_identity: 'other-identity' };
      },
      renderProjects: () => {}, updateLocationProject: () => {},
      openDialog: (dialog, input) => { dialog.hidden = false; opened.push(input.value); },
      closeDialog: dialog => { dialog.hidden = true; }, switchProject: async root => selected.push(root),
      tr: (_key, fallback) => fallback
    });
    vm.runInContext(shippedListener('    const requestedInitialProject =', '\n    let projectSelectionVisit'), context);
    assert.equal(vm.runInContext('currentProject', context), '');
    vm.runInContext(shippedFunction('loadProjects'), context);
    vm.runInContext(shippedSyncFunction('offerInitialProject'), context);
    vm.runInContext(shippedListener("    document.getElementById('projectForm').addEventListener", '\n    function clearSessionFilters'), context);
    await vm.runInContext('loadProjects()', context);
    assert.deepEqual(calls, [['/api/projects/select', 'POST']], 'navigation must not select the URL-supplied directory');
    assert.equal(vm.runInContext('currentProject', context), '/safe');
    vm.runInContext('offerInitialProject()', context);
    assert.deepEqual(opened, [requested]);
    assert.equal(node('projectPath').value, requested);
    assert.deepEqual(calls, [['/api/projects/select', 'POST']], 'offering the directory is read-only');
    vm.runInContext('offerInitialProject()', context);
    assert.deepEqual(opened, [requested], 'polls and rerenders must not reopen the dialog');
    await node('projectForm').submit({ preventDefault() {} });
    assert.deepEqual(calls, [['/api/projects/select', 'POST'],
      ['/api/projects?root=%2Fother%20server%20directory', 'POST']]);
    assert.deepEqual(selected, [requested]);
  }
});

test('same-tab selection restores without a new POST and embedded panes use their parent identity', async () => {
  const root = '/previously selected', identity = 'identity-B';
  for (const paneMode of [false, true]) {
    const calls = [], scopes = [];
    const parent = { location: { origin: 'http://hcc.local' }, hccWorkspaceHost: {
      project: () => root, projectIdentity: () => identity } };
    const context = vm.createContext({
      initialParams: new URLSearchParams({ project: root, root_identity: identity }), paneMode,
      window: { parent }, location: { origin: 'http://hcc.local' },
      sessionStorage: { getItem: () => JSON.stringify({ root, identity }) },
      headers: {}, sharedProjectBroker: () => ({}),
      createProjectRequests: ({ root: selectedRoot, rootIdentity }) => {
        scopes.push([selectedRoot, rootIdentity]);
        return { rootIdentity: () => identity, setRoot: () => {} };
      },
      api: async (url) => { calls.push(url); return { projects: [{ root }], current: { root }, project_identity: identity }; },
      renderProjects: () => {}, updateLocationProject: () => {}
    });
    vm.runInContext(shippedListener('    const requestedInitialProject =', '\n    let projectSelectionVisit'), context);
    vm.runInContext(shippedFunction('loadProjects'), context);
    await vm.runInContext('loadProjects()', context);
    assert.deepEqual(scopes, [[root, identity]]);
    assert.deepEqual(calls, ['/api/projects']);
    assert.equal(vm.runInContext('pendingInitialProject', context), '');
  }
});

test('a stale same-tab marker cannot authorize another top-level directory', async () => {
  const selected = [];
  const context = vm.createContext({
    initialParams: new URLSearchParams({ project: '/target', root_identity: 'target-inode' }), paneMode: false,
    sessionStorage: { getItem: () => JSON.stringify({ root: '/safe', identity: 'safe-inode' }) },
    headers: {}, sharedProjectBroker: () => ({}),
    createProjectRequests: options => { selected.push([options.root, options.rootIdentity]);
      return { rootIdentity: () => '', setRoot: () => {} }; }
  });
  vm.runInContext(shippedListener('    const requestedInitialProject =', '\n    let projectSelectionVisit'), context);
  assert.deepEqual(selected, [['', '']]);
  assert.equal(vm.runInContext('pendingInitialProject', context), '/target');
});

test('top-level /pane is not an authenticated project frame', async () => {
  const removed = [], calls = [], selected = [];
  const window = { hccDraftScope: 'auxiliary', hccUi: {} };
  window.parent = window;
  const context = vm.createContext({
    window, location: { origin: 'http://hcc.local' },
    document: { documentElement: { classList: { remove: value => removed.push(value) } } },
    installHandoff: () => {}, installWorkbench: () => {},
    initialParams: new URLSearchParams({ project: '/target', root_identity: 'target-inode' }),
    sessionStorage: { getItem: () => null }, headers: {}, sharedProjectBroker: () => ({}),
    createProjectRequests: options => { selected.push([options.root, options.rootIdentity]);
      return { rootIdentity: () => '', setRoot: () => {} }; },
    api: async (url, options) => { calls.push([url, options?.method]);
      return { projects: [{ root: '/safe' }], current: { root: '/safe' }, project_identity: 'safe-inode' }; },
    renderProjects: () => {}, updateLocationProject: () => {}
  });
  vm.runInContext(shippedListener('    const auxiliaryPage =', '\n    const handoffStore'), context);
  assert.equal(vm.runInContext('paneMode', context), false);
  assert.equal(window.hccDraftScope, '');
  assert.deepEqual(removed, ['session-pane']);
  vm.runInContext(shippedListener('    const requestedInitialProject =', '\n    let projectSelectionVisit'), context);
  assert.deepEqual(selected, [['', '']]);
  vm.runInContext(shippedFunction('loadProjects'), context);
  await vm.runInContext('loadProjects()', context);
  assert.deepEqual(calls, [['/api/projects/select', 'POST']]);
  assert.equal(vm.runInContext('pendingInitialProject', context), '/target');
});

test('selected project identity is remembered in the tab only after the page binds it', () => {
  const saved = [];
  const context = vm.createContext({
    token: '', currentProject: '/bound', paneMode: false, sessionKindFilter: 'all',
    projectRequests: { rootIdentity: () => 'bound-identity' },
    location: { search: '?project=%2Funtrusted', pathname: '/' },
    history: { replaceState: (_state, _title, value) => saved.push(['url', value]) },
    sessionStorage: { setItem: (key, value) => saved.push([key, JSON.parse(value)]) },
    URLSearchParams
  });
  vm.runInContext(shippedSyncFunction('updateLocationProject'), context);
  vm.runInContext('updateLocationProject()', context);
  assert.deepEqual(saved, [['url', '/?project=%2Fbound&root_identity=bound-identity'],
    ['hcc.selectedProject', { root: '/bound', identity: 'bound-identity' }]]);
});

test('a deep link spelling with only a trailing separator does not interrupt the default project', () => {
  const input = { value: '' };
  let opened = 0;
  const context = vm.createContext({
    pendingInitialProject: '/safe/', currentProject: '/safe', paneMode: false,
    document: { getElementById: () => input }, openDialog: () => opened++
  });
  vm.runInContext(shippedSyncFunction('offerInitialProject'), context);
  vm.runInContext('offerInitialProject()', context);
  assert.equal(opened, 0);
  assert.equal(vm.runInContext('pendingInitialProject', context), '');
});

test('a stale browser project list read never silently reselects a replacement directory', async () => {
  const calls = [], selections = [];
  const context = vm.createContext({ currentProject: '/selected', projects: [{ root: '/selected' }],
    api: async (url) => { calls.push(url); throw Object.assign(new Error('project changed'), { code: 'PROJECT_PATH_CHANGED' }); },
    projectRequests: { rootIdentity: () => 'identity-A', setRoot: (...args) => selections.push(args) },
    renderProjects: () => {}, updateLocationProject: () => {} });
  vm.runInContext(shippedFunction('loadProjects'), context);
  await assert.rejects(vm.runInContext('loadProjects()', context), { code: 'PROJECT_PATH_CHANGED' });
  assert.deepEqual(calls, ['/api/projects']);
  assert.deepEqual(selections, []);
  assert.equal(context.currentProject, '/selected');
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
    api: async (url, options) => { requests.push({ url, body: JSON.parse(options.body), explicitSelection: options.explicitSelection });
      return { project: { root: '/canonical-project' }, project_identity: 'identity-B' }; },
    loadProjects: async () => {}, switchProject: async root => selections.push(root),
    closeDialog: dialog => { dialog.hidden = true; }, tr: (_key, fallback) => fallback
  });
  vm.runInContext(shippedListener("    document.getElementById('projectForm').addEventListener", '\n    function clearSessionFilters'), context);
  await node('projectForm').submit({ preventDefault() {} });
  assert.deepEqual(requests, [{ url: '/api/projects?root=%2Fproject-alias%2F',
    body: { root: '/project-alias/' }, explicitSelection: true }]);
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
    projectRequests: { rootIdentity: () => 'fixture-project-identity' },
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
