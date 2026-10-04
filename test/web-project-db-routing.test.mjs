import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { contextForProject, projectDbPath, runtimePath } from '../lib/runtime/paths.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { createAutoAttach } from '../lib/web/auto-attach.mjs';
import { createProjectContexts } from '../lib/web/project-contexts.mjs';
import { createSessionSerialize } from '../lib/web/session-serialize.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

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

function requestProject(projects, target, headers = {}) {
  return projects.projectFromRequest({ headers }, new URL(target, 'http://localhost:8787'));
}

async function postProject(routes, body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.url = '/api/projects';
  req.headers = { host: 'localhost:8787', 'x-hcc-api-version': '2' };
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
  const freshRoot = path.join(f.sandbox, 'not-selected');
  fs.mkdirSync(freshRoot);
  const denied = await postProject(routes, { root: freshRoot, db: outside });
  assert.equal(denied.status, 403);
  assert.equal(fs.existsSync(path.join(freshRoot, '.hello-cc')), false,
    'invalid database selection must not create project state');
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
