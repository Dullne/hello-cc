import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { contextForProject, projectDbPath, runtimePath } from '../lib/runtime/paths.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';
import { createProjectContexts } from '../lib/web/project-contexts.mjs';

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
  const projects = createProjectContexts({
    ctx,
    sessions: new Map(),
    sameResolvedPath: (left, right) => fs.realpathSync(left) === fs.realpathSync(right)
  });
  return { sandbox, root, otherRoot, alias, ctx, projects };
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
});
