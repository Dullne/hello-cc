import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inspectProcessIdentity } from '../lib/process/identity.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-down-pointer-'));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const root = path.join(sandbox, 'project');
  const home = path.join(sandbox, 'home');
  const state = path.join(root, '.hello-cc');
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return { root, home, pointer: path.join(state, 'runtime.json') };
}

function runDown({ root, home }, env = {}) {
  return spawnSync(process.execPath, [hccBin, '--root', root, 'down'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, HCC_RUNTIME_URL: '', ...env }
  });
}

function writePointer(file, runtime) {
  fs.writeFileSync(file, `${JSON.stringify(runtime)}\n`, { mode: 0o600 });
}

test('down removes a local pointer only when its immutable process identity is confirmed dead', (t) => {
  const state = fixture(t);
  const pid = 2_147_483_647;
  writePointer(state.pointer, {
    product: 'hello-cc',
    pid,
    process_identity: { pid, startToken: 'dead:start', commandHash: 'd'.repeat(64) },
    base_url: 'http://127.0.0.1:1'
  });

  const result = runDown(state);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(state.pointer), false);
  assert.match(result.stdout, /stale runtime pointer removed/i);
  assert.doesNotMatch(result.stdout, /runtime stopped/i);
});

test('down keeps an unreachable pointer whose immutable process identity is still live', (t) => {
  const state = fixture(t);
  const observed = inspectProcessIdentity(process.pid);
  if (observed.state !== 'live') {
    t.skip('complete process identity unavailable');
    return;
  }
  writePointer(state.pointer, {
    product: 'hello-cc',
    pid: process.pid,
    process_identity: observed.identity,
    base_url: 'http://127.0.0.1:1'
  });

  const result = runDown(state);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(state.pointer), true);
  assert.doesNotMatch(result.stdout, /runtime stopped/i);
});

test('down keeps an unreachable pointer when process ownership evidence is incomplete', (t) => {
  const state = fixture(t);
  writePointer(state.pointer, {
    product: 'hello-cc',
    pid: process.pid,
    base_url: 'http://127.0.0.1:1'
  });

  const result = runDown(state);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(state.pointer), true);
  assert.doesNotMatch(result.stdout, /runtime stopped/i);
});

test('down never treats an unreachable environment runtime as a local stale pointer', (t) => {
  const state = fixture(t);
  const result = runDown(state, {
    HCC_RUNTIME_URL: 'http://127.0.0.1:1',
    HCC_RUNTIME_TOKEN: 'test-token'
  });

  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /runtime stopped|stale runtime pointer removed/i);
});

for (const mode of ['normal-response', 'lost-response', 'replacement-pointer']) {
  test(`down confirms only its own stopped HTTP runtime with ${mode}`, async (t) => {
    const state = fixture(t);
    const observed = inspectProcessIdentity(process.pid);
    if (observed.state !== 'live') { t.skip('complete process identity unavailable'); return; }
    const env = {
      HOME: state.home,
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HCC_RUNTIME_LOCAL_ONLY: '1'
    };
    const replacement = {
      product: 'hello-cc', pid: process.pid, process_identity: observed.identity,
      base_url: 'http://127.0.0.1:1'
    };
    const moduleUrl = pathToFileURL(path.join(repoRoot, 'lib/process/identity.mjs')).href;
    const script = `
      import http from 'node:http';
      import fs from 'node:fs';
      import { inspectProcessIdentity } from ${JSON.stringify(moduleUrl)};
      const pointer = ${JSON.stringify(state.pointer)}, mode = ${JSON.stringify(mode)};
      let requests = 0;
      const server = http.createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/api/runtime/stop') { res.writeHead(404); res.end(); return; }
        requests += 1;
        req.resume();
        if (mode === 'replacement-pointer') fs.writeFileSync(pointer, ${JSON.stringify(JSON.stringify(replacement))}, { mode: 0o600 });
        else fs.unlinkSync(pointer);
        if (mode === 'normal-response') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
        else res.destroy();
        setTimeout(() => server.close(() => {
          process.stdout.write(JSON.stringify({ requests }), () => process.exit(0));
        }), 30);
      });
      server.listen(0, '127.0.0.1', () => {
        const identity = inspectProcessIdentity(process.pid).identity;
        fs.writeFileSync(pointer, JSON.stringify({ product: 'hello-cc', pid: process.pid,
          process_identity: identity, base_url: 'http://127.0.0.1:' + server.address().port }), { mode: 0o600 });
        process.send({ ready: true, identity });
      });
    `;
    const server = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: state.root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], timeout: 15_000
    });
    const serverExit = once(server, 'close');
    let serverStdout = '', serverStderr = '';
    server.stdout.on('data', (data) => { serverStdout += data; });
    server.stderr.on('data', (data) => { serverStderr += data; });
    t.after(async () => {
      if (server.exitCode === null && server.signalCode === null) {
        server.kill('SIGTERM');
        await serverExit;
      }
    });
    const [ready] = await once(server, 'message');
    assert.equal(fs.statSync(state.pointer).mode & 0o777, 0o600, 'fixture publishes a private runtime pointer independently of umask');
    const cli = spawn(process.execPath, [hccBin, '--root', state.root, '--json', 'down'], {
      cwd: state.root, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000
    });
    let stdout = '', stderr = '';
    cli.stdout.on('data', (data) => { stdout += data; });
    cli.stderr.on('data', (data) => { stderr += data; });
    const [exitCode, signal] = await once(cli, 'close');
    assert.equal(exitCode, mode === 'replacement-pointer' ? 1 : 0, stderr);
    if (mode === 'replacement-pointer') assert.equal(JSON.parse(stderr).error.code, 'RUNTIME_UNREACHABLE');
    const [serverCode, serverSignal] = await serverExit;
    assert.equal(signal, null);
    assert.equal(serverSignal, null);
    assert.equal(serverCode, 0, serverStderr);
    assert.equal(JSON.parse(serverStdout).requests, 1, 'down must not retry the stop request');
    assert.equal(inspectProcessIdentity(ready.identity.pid).state, 'dead');
    if (mode === 'replacement-pointer') {
      assert.deepEqual(JSON.parse(fs.readFileSync(state.pointer, 'utf8')), replacement);
    } else {
      assert.equal(fs.existsSync(state.pointer), false);
      assert.equal(JSON.parse(stdout).ok, true);
    }
  });
}
