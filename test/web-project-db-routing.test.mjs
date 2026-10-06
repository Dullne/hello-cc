import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { contextForProject, projectDbPath, projectRegistryPath, runtimePath } from '../lib/runtime/paths.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { createAutoAttach } from '../lib/web/auto-attach.mjs';
import { createProjectContexts } from '../lib/web/project-contexts.mjs';
import { createSessionSerialize } from '../lib/web/session-serialize.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';
import { privateProjectStateDir } from '../lib/runtime/private-state.mjs';
import { tmuxManagedSessionName } from '../lib/terminal/tmux.mjs';

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-project-db-'));
  const home = path.join(sandbox, 'home');
  const root = path.join(sandbox, 'initial');
  const otherRoot = path.join(sandbox, 'selected');
  const alias = path.join(sandbox, 'selected-alias');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root);
  fs.mkdirSync(otherRoot);
  fs.chmodSync(otherRoot, 0o777); // Browser may select a root requiring private state.
  fs.symlinkSync(otherRoot, alias, 'dir');
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
  const ctx = contextForProject(root);
  const sessions = new Map();
  const serializer = createSessionSerialize({ sessions, ctx,
    sameResolvedPath: (left, right) => fs.realpathSync(left) === fs.realpathSync(right) });
  const connections = [];
  const projects = createProjectContexts({
    ctx,
    sessions,
    sessionKey: serializer.sessionKey,
    sessionsForProject: serializer.sessionsForProject,
    connect: project => { connections.push(project); return { close() {} }; },
    sameResolvedPath: (left, right) => fs.realpathSync(left) === fs.realpathSync(right)
  });
  t.after(() => projects.releaseProjectContexts?.());
  return { sandbox, root, otherRoot, alias, ctx, projects, sessions, serializer, connections };
}

function requestProject(projects, target, headers = {}, options = {}) {
  return projects.projectFromRequest({ headers }, new URL(target, 'http://localhost:8787'), options);
}

async function getProjectRoute(routes, target, headers = {}, method = 'GET') {
  const req = Readable.from([]);
  req.method = method;
  req.url = target;
  req.headers = { host: 'localhost:8787', 'x-hcc-api-version': '2', 'x-hcc-browser': '1', ...headers };
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  const res = { status: null, body: '', writeHead(status) { this.status = status; },
    end(value = '') { this.body = String(value); } };
  await routes.handleWebRequest(req, res);
  return { status: res.status, body: JSON.parse(res.body) };
}

async function postProject(routes, body, { headers = {}, beforeBody = null } = {}) {
  const req = Readable.from(beforeBody
    ? (async function* () { beforeBody(); yield JSON.stringify(body); })()
    : [JSON.stringify(body)]);
  req.method = 'POST';
  req.url = '/api/projects';
  req.headers = { host: 'localhost:8787', 'x-hcc-api-version': '2', ...headers };
  req.socket = { remoteAddress: '127.0.0.1', encrypted: false };
  const res = {
    status: null,
    body: '',
    writeHead(status) { this.status = status; },
    end(value = '') { this.body = String(value); }
  };
  await routes.handleWebRequest(req, res);
  return { status: res.status, body: JSON.parse(res.body) };
}

test('Web root selection uses the project DB resolver for defaults and legacy aliases', {
  skip: process.platform === 'win32'
}, (t) => {
  const f = fixture(t);
  const expected = projectDbPath(f.otherRoot);
  const legacy = path.join(f.otherRoot, '.hello-cc', 'mesh.db');
  assert.notEqual(expected, legacy);

  assert.equal(requestProject(f.projects, '/api/runtime').dbPath, projectDbPath(f.root));
  for (const target of [
    `/api/runtime?root=${encodeURIComponent(f.otherRoot)}`,
    `/api/runtime?project=${encodeURIComponent(f.alias)}`
  ]) {
    const selected = requestProject(f.projects, target);
    assert.equal(selected.root, fs.realpathSync(f.otherRoot));
    assert.equal(selected.dbPath, expected);
  }
  assert.equal(requestProject(f.projects, '/api/runtime', {
    'x-hcc-root': f.otherRoot
  }).dbPath, expected);

  assert.equal(requestProject(f.projects,
    `/api/runtime?root=${encodeURIComponent(f.otherRoot)}&db=${encodeURIComponent(legacy)}`
  ).dbPath, expected);
  assert.equal(requestProject(f.projects, '/api/runtime', {
    'x-hcc-root': f.alias,
    'x-hcc-db': path.join(f.alias, '.hello-cc', 'mesh.db')
  }).dbPath, expected);

  const outside = path.join(f.sandbox, 'outside.db');
  for (const [target, headers] of [
    [`/api/runtime?root=${encodeURIComponent(f.otherRoot)}&db=${encodeURIComponent(outside)}`, {}],
    ['/api/runtime', { 'x-hcc-root': f.otherRoot, 'x-hcc-db': outside }]
  ]) {
    assert.throws(() => requestProject(f.projects, target, headers), {
      code: 'PROJECT_PATH_FORBIDDEN'
    });
  }
  assert.equal(fs.existsSync(outside), false);
});

test('POST /api/projects defaults to the selected root DB and validates explicit DBs', {
  skip: process.platform === 'win32'
}, async (t) => {
  const f = fixture(t);
  const routes = createHttpRoutes({
    ctx: f.ctx,
    ...f.projects,
    token: 'local-token',
    host: '127.0.0.1',
    port: 8787,
    useTls: false,
    trustProxy: false,
    webAuthMode: () => 'token',
    cookieSessionOk: () => false,
    connectWebProject: () => ({ close() {} }),
    getProcessIdentity: () => null,
    getActualPort: () => 8787,
    now: () => 1,
    PRODUCT_NAME: 'hello-cc',
    VERSION: 'test',
    webErrorStatus: (error) => error?.code === 'PROJECT_PATH_FORBIDDEN' ? 403 : 500
  });
  const expected = projectDbPath(f.otherRoot);
  const selected = await postProject(routes, { root: f.otherRoot });
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  assert.equal(selected.body.project.root, fs.realpathSync(f.otherRoot));
  assert.equal(selected.body.project.db, expected);
  assert.equal(JSON.parse(fs.readFileSync(runtimePath({ root: f.otherRoot }), 'utf8')).db, expected);

  const legacy = await postProject(routes, {
    root: f.alias,
    db: path.join(f.alias, '.hello-cc', 'mesh.db')
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.project.db, expected);

  const outside = path.join(f.sandbox, 'outside.db');
  const rejected = await postProject(routes, { root: f.otherRoot, db: outside });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, 'PROJECT_PATH_FORBIDDEN');
  assert.equal(fs.existsSync(outside), false);

  const freshRoot = path.join(f.sandbox, 'outside-before-create');
  fs.mkdirSync(freshRoot);
  const freshRejected = await postProject(routes, { root: freshRoot, db: outside });
  assert.equal(freshRejected.status, 403);
  assert.equal(freshRejected.body.error.code, 'PROJECT_PATH_FORBIDDEN');
  assert.equal(fs.existsSync(path.join(freshRoot, '.hello-cc')), false);
  assert.equal(fs.existsSync(privateProjectStateDir(freshRoot)), false);
});

test('invalid B database cannot publish a generation fence before rejection', {
  skip: process.platform === 'win32'
}, async t => {
  const f = fixture(t);
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'token', cookieSessionOk: () => false,
    connectWebProject: () => ({ close() {} }), getProcessIdentity: () => null,
    getActualPort: () => 8787, now: () => 1,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'PROJECT_PATH_FORBIDDEN' ? 403 : 500
  });
  const first = await postProject(routes, { root: f.otherRoot });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const oldStore = privateProjectStateDir(f.otherRoot);
  fs.renameSync(f.otherRoot, `${f.otherRoot}-old`);
  fs.mkdirSync(f.otherRoot, { mode: 0o777 });
  fs.chmodSync(f.otherRoot, 0o777);
  const outside = path.join(f.sandbox, 'outside-B.db');
  const rejected = await postProject(routes, { root: f.otherRoot, db: outside });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, 'PROJECT_PATH_FORBIDDEN');
  assert.equal(fs.existsSync(`${oldStore}.generations`), false);
  assert.equal(JSON.parse(fs.readFileSync(`${oldStore}.authority.json`, 'utf8')).fence, undefined);
  assert.equal(fs.existsSync(outside), false);
  const oldStoreDb = await postProject(routes, {
    root: f.otherRoot, db: path.join(oldStore, 'mesh.db')
  });
  assert.equal(oldStoreDb.status, 403);
  assert.equal(fs.existsSync(`${oldStore}.generations`), false);
});

test('a selected Web project cannot reconnect or expose its old managed session after A is rebound to B', {
  skip: process.platform === 'win32'
}, (t) => {
  const f = fixture(t);
  const selected = requestProject(f.projects, `/api/runtime?root=${encodeURIComponent(f.otherRoot)}`);
  const sent = [];
  const closed = [];
  const client = { readyState: 1, OPEN: 1, send: value => sent.push(value),
    close: (...args) => closed.push(args) };
  const session = { id: 'codex-a', peerId: 'codex-a', root: selected.root, ctx: selected,
    status: 'running', type: 'app-server', clients: new Set([client]) };
  f.sessions.set(f.serializer.sessionKey(selected, session.id), session);
  assert.equal(f.projects.getSession(selected, session.id), session);

  const moved = `${f.otherRoot}-moved`;
  const replacement = path.join(f.sandbox, 'replacement');
  fs.mkdirSync(replacement);
  fs.renameSync(f.otherRoot, moved);
  fs.symlinkSync(replacement, f.otherRoot, 'dir');

  assert.throws(() => f.projects.connectWebProject(selected), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(f.connections.length, 0, 'the old context must not open B’s database');
  f.serializer.broadcast(session, { type: 'data', data: 'private output' });
  assert.deepEqual(sent, [], 'the rebound root cannot receive the old session stream');
  assert.deepEqual(closed, [[1008, 'project changed']]);
  selected.rootIdentity.dropDescriptor();
  assert.throws(() => f.projects.retainProjectContextDescriptor(selected), {
    code: 'PROJECT_PATH_CHANGED'
  }, 'a restored tmux context must not acquire B’s directory descriptor');

  const fresh = requestProject(f.projects, `/api/runtime?root=${encodeURIComponent(f.otherRoot)}`);
  assert.equal(fresh.root, fs.realpathSync(replacement), 'new B remains selectable');
  assert.equal(f.serializer.sessionsForProject(fresh).includes(session), false);
  assert.equal(f.projects.getSession(fresh, session.id), null);
});

test('a CLI-carried root identity cannot select replacement B through the Web API', {
  skip: process.platform === 'win32'
}, (t) => {
  const f = fixture(t);
  const original = captureSelectedCwdSnapshot(f.otherRoot);
  const carried = Buffer.from(JSON.stringify({ canonical: original.canonical,
    identity: original.identity })).toString('base64url');
  fs.renameSync(f.otherRoot, `${f.otherRoot}-original`);
  fs.mkdirSync(f.otherRoot);
  assert.throws(() => requestProject(f.projects, '/api/runtime', {
    'x-hcc-root': f.otherRoot,
    'x-hcc-root-identity': carried
  }), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(f.connections.length, 0);
  const freshlySelected = requestProject(f.projects, '/api/runtime', { 'x-hcc-root': f.otherRoot });
  assert.equal(freshlySelected.root, fs.realpathSync(f.otherRoot));
});

test('automatic Web startup-root selection never adopts B after A is replaced', {
  skip: process.platform === 'win32'
}, (t) => {
  const f = fixture(t);
  f.ctx.initialRootIdentity = captureSelectedCwdSnapshot(f.root);
  const moved = path.join(f.sandbox, 'original-startup-root');
  fs.renameSync(f.root, moved);
  fs.mkdirSync(f.root);
  const defaultRequest = { headers: {}, method: 'POST' };
  for (const target of ['/api/projects/select', '/api/projects/select?root=',
    '/api/projects/select?project=', '/api/projects/select?root=&project=']) {
    assert.throws(() => f.projects.projectFromRequest(defaultRequest,
      new URL(target, 'http://localhost:8787'), { requireIdentity: true }), {
      code: 'PROJECT_PATH_CHANGED'
    }, target);
  }
  assert.throws(() => f.projects.projectFromRequest({ headers: { 'x-hcc-root': '' }, method: 'POST' },
    new URL('/api/projects/select', 'http://localhost:8787'), { requireIdentity: true }), {
    code: 'PROJECT_PATH_CHANGED'
  });
  assert.equal(fs.existsSync(path.join(f.root, '.hello-cc')), false);

  // An actual selection that names the new directory remains available.
  const selected = f.projects.projectFromRequest(defaultRequest,
    new URL(`/api/projects/select?root=${encodeURIComponent(f.root)}`, 'http://localhost:8787'),
    { requireIdentity: true });
  assert.equal(selected.root, fs.realpathSync(f.root));
  assert.equal(selected.rootIdentity.identity.ino, fs.statSync(f.root, { bigint: true }).ino.toString());
});

test('browser selection issues an identity, stale HTTP and WS fail closed, and explicit re-selection accepts B', {
  skip: process.platform === 'win32'
}, async t => {
  const f = fixture(t);
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'token', cookieSessionOk: () => false,
    sessionsForProject: f.serializer.sessionsForProject, getProcessIdentity: () => null,
    getActualPort: () => 8787, now: () => 1,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'PROJECT_PATH_CHANGED' ? 409 : 500
  });
  const root = encodeURIComponent(f.otherRoot);
  const selected = await getProjectRoute(routes, `/api/projects/select?root=${root}`, {}, 'POST');
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const canonicalRoot = fs.realpathSync(f.otherRoot);
  assert.equal(selected.body.current.root, canonicalRoot);
  const originalIdentity = selected.body.project_identity;
  assert.equal(typeof originalIdentity, 'string');
  assert.deepEqual(JSON.parse(Buffer.from(originalIdentity, 'base64url').toString()), {
    canonical: canonicalRoot, identity: captureSelectedCwdSnapshot(f.otherRoot).identity
  });
  const browserHeaders = { 'x-hcc-root-identity': originalIdentity };
  assert.equal((await getProjectRoute(routes, `/api/runtime?root=${root}`, browserHeaders)).status, 200);
  const missing = await getProjectRoute(routes, `/api/runtime?root=${root}`);
  assert.equal(missing.status, 409, JSON.stringify(missing.body));
  assert.equal(missing.body.error.code, 'PROJECT_PATH_CHANGED');

  fs.renameSync(f.otherRoot, `${f.otherRoot}-original`);
  const replacement = path.join(f.sandbox, 'replacement');
  fs.mkdirSync(replacement);
  fs.symlinkSync(replacement, f.otherRoot, 'dir');
  for (const target of [`/api/runtime?root=${root}`, `/api/projects?root=${root}`]) {
    const stale = await getProjectRoute(routes, target, browserHeaders);
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(stale.body.error.code, 'PROJECT_PATH_CHANGED');
  }
  const wsUrl = `/ws/terminal/unused?root=${root}&browser=1&root_identity=${originalIdentity}`;
  assert.throws(() => requestProject(f.projects, wsUrl), { code: 'PROJECT_PATH_CHANGED' });
  assert.throws(() => requestProject(f.projects, `/ws/terminal/unused?root=${root}&browser=1`), {
    code: 'PROJECT_PATH_CHANGED'
  });

  const reselected = await getProjectRoute(routes, `/api/projects/select?root=${root}`, {}, 'POST');
  assert.equal(reselected.status, 200, JSON.stringify(reselected.body));
  assert.notEqual(reselected.body.project_identity, originalIdentity);
  assert.equal((await getProjectRoute(routes, `/api/runtime?root=${root}`,
    { 'x-hcc-root-identity': reselected.body.project_identity })).status, 200);
  assert.equal(requestProject(f.projects,
    `/ws/terminal/unused?root=${root}&browser=1&root_identity=${reselected.body.project_identity}`).root,
    fs.realpathSync(f.otherRoot));
  assert.equal(f.connections.length, 0, 'identity checks must not open a project DB');
});

test('explicit browser selection retains same-origin CSRF protection for cookie sessions', {
  skip: process.platform === 'win32'
}, async t => {
  const f = fixture(t);
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'cookie', cookieSessionOk: () => true,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'PROJECT_PATH_CHANGED' ? 409 : 500
  });
  const target = `/api/projects/select?root=${encodeURIComponent(f.otherRoot)}`;
  const crossSite = await getProjectRoute(routes, target, { origin: 'https://elsewhere.example' }, 'POST');
  assert.equal(crossSite.status, 403);
  assert.equal(crossSite.body.error.code, 'CSRF_ORIGIN');
  const noOrigin = await getProjectRoute(routes, target, {}, 'POST');
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.body.error.code, 'CSRF_ORIGIN');
  const sameOrigin = await getProjectRoute(routes, target, { origin: 'http://localhost:8787' }, 'POST');
  assert.equal(sameOrigin.status, 200, JSON.stringify(sameOrigin.body));
  assert.ok(sameOrigin.body.project_identity);
});

test('an unknown top-level cookie navigation cannot create another project state', {
  skip: process.platform === 'win32'
}, async t => {
  const f = fixture(t);
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'cookie', cookieSessionOk: () => true,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'PROJECT_PATH_CHANGED' ? 409 : 500
  });
  const identity = Buffer.from(JSON.stringify(captureSelectedCwdSnapshot(f.otherRoot))).toString('base64url');
  const stateDir = path.dirname(projectDbPath(f.otherRoot));
  assert.equal(fs.existsSync(stateDir), false);
  const response = await getProjectRoute(routes,
    `/notfound?root=${encodeURIComponent(f.otherRoot)}&root_identity=${identity}`,
    { 'x-hcc-api-version': undefined, 'x-hcc-browser': undefined });
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'NOT_FOUND');
  assert.equal(fs.existsSync(stateDir), false);
});

test('an unknown versioned API route cannot create project state or registry activity', {
  skip: process.platform === 'win32'
}, async t => {
  const f = fixture(t);
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'cookie', cookieSessionOk: () => true,
    sessionsForProject: f.serializer.sessionsForProject, getProcessIdentity: () => null,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'BAD_REQUEST' ? 400 :
      error?.code === 'PROJECT_PATH_CHANGED' ? 409 : 500
  });
  const identity = Buffer.from(JSON.stringify(captureSelectedCwdSnapshot(f.otherRoot))).toString('base64url');
  const stateDir = path.dirname(projectDbPath(f.otherRoot));
  const registry = projectRegistryPath();
  const registryBefore = fs.existsSync(registry) ? fs.readFileSync(registry) : null;
  assert.equal(fs.existsSync(stateDir), false);
  for (const [pathname, method] of [
    ['/api/notfound', 'GET'], ['/api/runtime/stop', 'GET'],
    ['/api/sessions/peer/unknown', 'GET'], ['/api/agent-defaults/extra', 'GET'],
    ['/api/sessions/peer/native/unknown', 'GET'],
    ['/api/sessions/peer/native/%75nknown', 'GET'],
    ['/api/sessions/%ZZ/native/state', 'GET'],
    ['/api/sessions/peer/codex/unknown', 'GET'],
    ['/api/sessions/peer/codex/%ZZ', 'GET'],
    ['/api/sessions/%ZZ/results', 'GET'],
    ['/api/sessions/peer/results', 'DELETE'],
    ['/api/peers/peer/actions/unknown', 'GET'],
    ['/api/peers/peer/actions/unknown', 'POST'],
    ['/api/peers/%ZZ/actions/status', 'GET'],
    ['/api/native/history/peer', 'POST'],
    ['/api/native/history/peer/resume', 'GET'],
    ['/api/native/history/%ZZ', 'GET'],
    ['/api/codex/threads/thread/fork', 'GET'],
    ['/api/codex/threads/thread', 'POST'],
    ['/api/codex/threads/%ZZ', 'GET']
  ]) {
    const response = await getProjectRoute(routes,
      `${pathname}?root=${encodeURIComponent(f.otherRoot)}&root_identity=${identity}`,
      { 'x-hcc-browser': undefined, ...(method !== 'GET' ? { origin: 'http://localhost:8787' } : {}) }, method);
    assert.equal(response.status, 404, `${method} ${pathname}`);
    assert.equal(response.body.error.code, 'NOT_FOUND');
    assert.equal(fs.existsSync(stateDir), false, pathname);
    assert.deepEqual(fs.existsSync(registry) ? fs.readFileSync(registry) : null, registryBefore, pathname);
  }
  for (const [pathname, method] of [
    ['/api/peers/peer/actions/status', 'POST'],
    ['/api/peers/peer/actions/task_next', 'GET']
  ]) {
    const response = await getProjectRoute(routes,
      `${pathname}?root=${encodeURIComponent(f.otherRoot)}&root_identity=${identity}`,
      { 'x-hcc-browser': undefined, ...(method === 'POST' ? { origin: 'http://localhost:8787' } : {}) }, method);
    assert.equal(response.status, 405, `${method} ${pathname}`);
    assert.equal(response.body.error.code, 'METHOD_NOT_ALLOWED');
    assert.equal(fs.existsSync(stateDir), false, pathname);
    assert.deepEqual(fs.existsSync(registry) ? fs.readFileSync(registry) : null, registryBefore, pathname);
  }
  for (const [pathname, method] of [
    ...['account', 'login', 'logout', 'refreshToken', '%61ccount'].map(action =>
      [`/api/sessions/peer/codex/${action}`, 'POST']),
    ['/api/agent-defaults', 'POST']
  ]) {
    const response = await getProjectRoute(routes,
      `${pathname}?root=${encodeURIComponent(f.otherRoot)}&root_identity=${identity}`,
      { 'x-hcc-browser': undefined, ...(method === 'GET' ? {} : { origin: 'http://localhost:8787' }) }, method);
    assert.equal(response.status, 400, `${method} ${pathname}`);
    assert.equal(response.body.error.code, 'BAD_REQUEST');
    assert.equal(fs.existsSync(stateDir), false, pathname);
    assert.deepEqual(fs.existsSync(registry) ? fs.readFileSync(registry) : null, registryBefore, pathname);
  }
  const supported = await getProjectRoute(routes,
    `/api/runtime?root=${encodeURIComponent(f.otherRoot)}&root_identity=${identity}`,
    { 'x-hcc-browser': undefined });
  assert.equal(supported.status, 200, JSON.stringify(supported.body));
  assert.equal(supported.body.root, fs.realpathSync(f.otherRoot));
});

test('cookie API and WebSocket requests require project identity without a browser self-marker', {
  skip: process.platform === 'win32'
}, async t => {
  const f = fixture(t);
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'cookie', cookieSessionOk: () => true,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'PROJECT_PATH_CHANGED' ? 409 : 500
  });
  const root = encodeURIComponent(f.otherRoot);
  const unmarked = { 'x-hcc-browser': undefined };
  const selectHeaders = { ...unmarked, origin: 'http://localhost:8787' };
  const selected = await getProjectRoute(routes, `/api/projects/select?root=${root}`, selectHeaders, 'POST');
  assert.equal(selected.status, 200, JSON.stringify(selected.body));
  const originalIdentity = selected.body.project_identity;
  assert.equal((await getProjectRoute(routes, `/api/projects?root=${root}`, unmarked)).status, 409);
  assert.equal((await getProjectRoute(routes, `/api/projects?root=${root}`,
    { ...unmarked, 'x-hcc-root-identity': originalIdentity })).status, 200);

  fs.renameSync(f.otherRoot, `${f.otherRoot}-original`);
  const replacement = path.join(f.sandbox, 'replacement');
  fs.mkdirSync(replacement);
  fs.symlinkSync(replacement, f.otherRoot, 'dir');
  const stale = await getProjectRoute(routes, `/api/projects?root=${root}`, unmarked);
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error.code, 'PROJECT_PATH_CHANGED');
  assert.equal((await getProjectRoute(routes, `/api/projects?root=${root}`,
    { ...unmarked, 'x-hcc-root-identity': originalIdentity })).status, 409);
  assert.throws(() => requestProject(f.projects, `/ws/terminal/unused?root=${root}`,
    {}, { requireIdentity: true }), { code: 'PROJECT_PATH_CHANGED' });

  const reselected = await getProjectRoute(routes, `/api/projects/select?root=${root}`, selectHeaders, 'POST');
  assert.equal(reselected.status, 200, JSON.stringify(reselected.body));
  assert.notEqual(reselected.body.project_identity, originalIdentity);
  assert.equal((await getProjectRoute(routes, `/api/projects?root=${root}`,
    { ...unmarked, 'x-hcc-root-identity': reselected.body.project_identity })).status, 200);
  assert.equal(requestProject(f.projects, `/ws/terminal/unused?root=${root}`,
    { 'x-hcc-root-identity': reselected.body.project_identity }, { requireIdentity: true }).root,
    fs.realpathSync(f.otherRoot));
  assert.equal(f.connections.length, 0, 'rejected requests must not open a project DB');
});

test('explicit browser reselection provisions private B without exposing private A state', {
  skip: process.platform === 'win32'
}, async t => {
  const f = fixture(t);
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'cookie', cookieSessionOk: () => true,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'PROJECT_PATH_CHANGED' ? 409
      : error?.code === 'PROJECT_PATH_FORBIDDEN' ? 403 : 500
  });
  const root = encodeURIComponent(f.otherRoot);
  const headers = { origin: 'http://localhost:8787', 'x-hcc-browser': undefined };
  const original = await getProjectRoute(routes, `/api/projects/select?root=${root}`, headers, 'POST');
  assert.equal(original.status, 200, JSON.stringify(original.body));
  const oldContext = requestProject(f.projects, `/api/runtime?root=${root}`,
    { 'x-hcc-root-identity': original.body.project_identity });
  const oldSession = { id: 'shared-peer', peerId: 'shared-peer', root: oldContext.root,
    ctx: oldContext, status: 'running', type: 'tmux' };
  f.sessions.set(f.serializer.sessionKey(oldContext, oldSession.id), oldSession);
  const oldStore = privateProjectStateDir(f.otherRoot);
  fs.writeFileSync(path.join(oldStore, 'A-only'), 'private history', { mode: 0o600 });
  fs.renameSync(f.otherRoot, `${f.otherRoot}-old`);
  fs.mkdirSync(f.otherRoot, { mode: 0o777 });
  fs.chmodSync(f.otherRoot, 0o777);
  const stale = await getProjectRoute(routes, `/api/projects?root=${root}`,
    { 'x-hcc-root-identity': original.body.project_identity, 'x-hcc-browser': undefined });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'PROJECT_PATH_CHANGED');
  const fresh = await getProjectRoute(routes, `/api/projects/select?root=${root}`, headers, 'POST');
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.notEqual(fresh.body.project_identity, original.body.project_identity);
  const newStore = privateProjectStateDir(f.otherRoot);
  assert.notEqual(newStore, oldStore);
  assert.equal(fresh.body.current.db, path.join(newStore, 'mesh.db'));
  const freshContext = requestProject(f.projects, `/api/runtime?root=${root}`,
    { 'x-hcc-root-identity': fresh.body.project_identity });
  assert.notEqual(f.serializer.sessionKey(oldContext, oldSession.id),
    f.serializer.sessionKey(freshContext, oldSession.id));
  assert.notEqual(tmuxManagedSessionName(oldContext, oldSession.id),
    tmuxManagedSessionName(freshContext, oldSession.id));
  assert.equal(f.projects.getSession(freshContext, oldSession.id), null);
  assert.equal(f.sessions.get(f.serializer.sessionKey(oldContext, oldSession.id)), oldSession);
  assert.equal(fs.readFileSync(path.join(oldStore, 'A-only'), 'utf8'), 'private history');
  assert.equal(fs.existsSync(path.join(newStore, 'A-only')), false);
  const current = await getProjectRoute(routes, `/api/projects?root=${root}`,
    { 'x-hcc-root-identity': fresh.body.project_identity, 'x-hcc-browser': undefined });
  assert.equal(current.status, 200, JSON.stringify(current.body));
});

test('POST /api/projects body can explicitly reselect B after the startup root A is replaced', {
  skip: process.platform === 'win32'
}, async t => {
  const f = fixture(t);
  fs.chmodSync(f.root, 0o777);
  f.ctx.initialRootIdentity = captureSelectedCwdSnapshot(f.root);
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'token', cookieSessionOk: () => false,
    connectWebProject: () => ({ close() {} }), getProcessIdentity: () => null,
    getActualPort: () => 8787, now: () => 1,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'PROJECT_PATH_CHANGED' ? 409
      : error?.code === 'PROJECT_PATH_FORBIDDEN' ? 403 : 500
  });
  const first = await postProject(routes, { root: f.root });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const oldStore = privateProjectStateDir(f.root);
  fs.writeFileSync(path.join(oldStore, 'A-only'), 'preserved', { mode: 0o600 });
  fs.renameSync(f.root, `${f.root}-old`);
  fs.mkdirSync(f.root, { mode: 0o777 });
  fs.chmodSync(f.root, 0o777);
  const stale = await postProject(routes, { root: f.root }, {
    headers: { 'x-hcc-root-identity': first.body.project_identity }
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'PROJECT_PATH_CHANGED');
  assert.equal(fs.existsSync(`${oldStore}.generations`), false);
  const next = await postProject(routes, { root: f.root });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const newStore = privateProjectStateDir(f.root);
  assert.notEqual(newStore, oldStore);
  assert.equal(next.body.project.db, path.join(newStore, 'mesh.db'));
  assert.equal(fs.readFileSync(path.join(oldStore, 'A-only'), 'utf8'), 'preserved');
  assert.equal(fs.existsSync(path.join(newStore, 'A-only')), false);
});

test('token-authenticated CLI project requests remain compatible without browser identity', {
  skip: process.platform === 'win32'
}, async t => {
  const f = fixture(t);
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'token', cookieSessionOk: () => false,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'PROJECT_PATH_CHANGED' ? 409 : 500
  });
  const root = encodeURIComponent(f.otherRoot);
  const response = await getProjectRoute(routes, `/api/projects?root=${root}`,
    { 'x-hcc-browser': undefined });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.current.root, fs.realpathSync(f.otherRoot));
  assert.equal(requestProject(f.projects, `/ws/terminal/unused?root=${root}`).root,
    fs.realpathSync(f.otherRoot));
});

test('CLI project registration rejects a root replaced while its request body arrives', {
  skip: process.platform === 'win32'
}, async (t) => {
  const f = fixture(t);
  fs.chmodSync(f.otherRoot, 0o700); // Exercise the project-local state route, without a private authority marker.
  const original = captureSelectedCwdSnapshot(f.otherRoot);
  const carried = Buffer.from(JSON.stringify({ canonical: original.canonical,
    identity: original.identity })).toString('base64url');
  const routes = createHttpRoutes({
    ctx: f.ctx, ...f.projects, token: 'local-token', host: '127.0.0.1', port: 8787,
    useTls: false, trustProxy: false, webAuthMode: () => 'token', cookieSessionOk: () => false,
    connectWebProject: () => ({ close() {} }), now: () => 1,
    PRODUCT_NAME: 'hello-cc', VERSION: 'test',
    webErrorStatus: error => error?.code === 'PROJECT_PATH_CHANGED' ? 409 : 500
  });
  const response = await postProject(routes, { root: f.otherRoot }, {
    headers: { 'x-hcc-root': f.otherRoot, 'x-hcc-root-identity': carried },
    beforeBody() {
      fs.renameSync(f.otherRoot, `${f.otherRoot}-original`);
      fs.mkdirSync(f.otherRoot);
    }
  });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error.code, 'PROJECT_PATH_CHANGED');
});

test('idle Web projects downgrade their held directory descriptor and reacquire it on selection', {
  skip: process.platform === 'win32'
}, (t) => {
  const f = fixture(t);
  const selected = requestProject(f.projects, `/api/runtime?root=${encodeURIComponent(f.otherRoot)}`);
  assert.equal(selected.rootIdentity.mode, 'descriptor');
  f.projects.dropIdleProjectContextDescriptors(null, 0);
  assert.equal(selected.rootIdentity.mode, 'stat-only');
  const restored = f.projects.retainProjectContextDescriptor(selected);
  assert.equal(restored.mode, 'descriptor', 'tmux restoration upgrades a valid idle project');
  assert.equal(selected.rootIdentity, restored);

  f.projects.dropIdleProjectContextDescriptors(null, 0);
  assert.equal(selected.rootIdentity.mode, 'stat-only');

  const selectedAgain = requestProject(f.projects, `/api/runtime?root=${encodeURIComponent(f.otherRoot)}`);
  assert.equal(selectedAgain.rootIdentity.mode, 'descriptor');
  const session = { id: 'live-a', ctx: selectedAgain, root: selectedAgain.root, status: 'running' };
  f.sessions.set(f.serializer.sessionKey(selectedAgain, session.id), session);
  f.projects.dropIdleProjectContextDescriptors(null, 0);
  assert.equal(selectedAgain.rootIdentity.mode, 'descriptor');

  session.status = 'exited';
  f.projects.dropIdleProjectContextDescriptors(null, 0);
  assert.equal(selectedAgain.rootIdentity.mode, 'stat-only');
});

test('managed sessions from one project database are not reused under another DB at the same root', {
  skip: process.platform === 'win32'
}, (t) => {
  const f = fixture(t);
  const first = requestProject(f.projects, `/api/runtime?root=${encodeURIComponent(f.otherRoot)}`);
  const session = { id: 'first-db-session', peerId: 'first-db-session', root: first.root,
    ctx: first, status: 'running' };
  f.sessions.set(f.serializer.sessionKey(first, session.id), session);
  const secondDb = path.join(path.dirname(first.dbPath), 'second.db');
  const second = requestProject(f.projects,
    `/api/runtime?root=${encodeURIComponent(f.otherRoot)}&db=${encodeURIComponent(secondDb)}`);
  assert.equal(second.root, first.root);
  assert.equal(second.dbPath, secondDb);
  assert.equal(f.serializer.sessionsForProject(second).includes(session), false);
  assert.equal(f.projects.getSession(second, session.id), null);
  assert.equal(f.projects.getSession(first, session.id), session);
});

test('browser HTTP and WebSocket requests carry the selected directory identity', (t) => {
  const f = fixture(t);
  const target = `/api/projects/select?root=${encodeURIComponent(f.otherRoot)}`;
  const selected = f.projects.projectFromRequest({ method: 'POST', headers: {} },
    new URL(target, 'http://localhost:8787'), { requireIdentity: true });
  const identity = f.projects.selectedProjectIdentity(selected);
  const api = new URL(`/api/runtime?root=${encodeURIComponent(f.otherRoot)}`, 'http://localhost:8787');
  assert.throws(() => f.projects.projectFromRequest({ headers: {} }, api,
    { requireIdentity: true }), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(f.projects.projectFromRequest({ headers: { 'x-hcc-root-identity': identity } },
    api, { requireIdentity: true }).root, selected.root);
  const ws = new URL(`/ws/terminal/peer?root=${encodeURIComponent(f.otherRoot)}&browser=1&root_identity=${identity}`,
    'http://localhost:8787');
  assert.equal(f.projects.projectFromRequest({ headers: {} }, ws).root, selected.root);
  assert.throws(() => f.projects.projectFromRequest({ headers: { 'x-hcc-root-identity': 'different' } }, ws),
    { code: 'PROJECT_PATH_CHANGED' });
  fs.renameSync(f.otherRoot, `${f.otherRoot}-moved`);
  fs.mkdirSync(f.otherRoot);
  assert.throws(() => f.projects.projectFromRequest({ headers: { 'x-hcc-root-identity': identity } },
    api, { requireIdentity: true }), { code: 'PROJECT_PATH_CHANGED' });
  assert.throws(() => f.projects.projectFromRequest({ headers: {} }, ws), { code: 'PROJECT_PATH_CHANGED' });
  assert.equal(f.connections.length, 0, 'identity checks must not open a project database');
});

test('background adoption retains its startup context after idle descriptor eviction and reselection', {
  skip: process.platform === 'win32'
}, (t) => {
  const f = fixture(t);
  const startup = requestProject(f.projects, `/api/runtime?root=${encodeURIComponent(f.root)}`);
  let adoptions = 0;
  const background = createAutoAttach({
    ctx: startup, sessions: f.sessions,
    connectWebProject(project) {
      const db = f.projects.connectWebProject(project);
      return { ...db, prepare: () => ({ all: () => [] }) };
    },
    reAdoptOrphanManagedTmuxSessions(project) {
      assert.equal(project, startup);
      project.rootIdentity.assertUnchanged();
      adoptions += 1;
      return new Set();
    },
    reapDeadPeersForProject() {}, now: () => 1, ACTIVE_PEER_TTL: 60,
    redactedLogText: String
  });
  t.after(() => clearInterval(background.autoAttachPoller));
  assert.equal(adoptions, 1);

  // Production caches 32 idle descriptors. Visiting other projects evicts
  // the startup binding while the background scanner still owns its context.
  for (let i = 0; i < 33; i++) {
    const root = path.join(f.sandbox, `visited-${i}`);
    fs.mkdirSync(root);
    requestProject(f.projects, `/api/runtime?root=${encodeURIComponent(root)}`);
  }
  assert.equal(startup.rootIdentity.mode, 'stat-only');
  const selectedAgain = requestProject(f.projects, `/api/runtime?root=${encodeURIComponent(f.root)}`);
  assert.equal(selectedAgain.rootIdentity.mode, 'descriptor');
  background.scanAndAttachDetectedPeers();
  assert.equal(adoptions, 2, 'background adoption still reaches the original project after reselection');
  assert.equal(f.connections.at(-1).dbPath, startup.dbPath);
});
