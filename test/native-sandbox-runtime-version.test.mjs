import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { inspectProcessIdentity, waitForLiveProcessIdentity, waitForProcessIdentityExit } from '../lib/process/identity.mjs';
import { writeNativePointer, readNativePointer } from '../lib/runtime/native/store.mjs';
import { nativeRequest } from '../lib/runtime/native/client.mjs';
import { captureSelectedCwdSnapshot } from '../lib/process/selected-cwd-identity.mjs';

const hccBin = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));

// An authenticated sandbox-protocol compatibility stand-in carries current
// directory and owner receipts, while deliberately ignoring unknown worker
// fields as the pre-sandbox daemon did. Any unexpected /workers request runs
// a harmless marker executable, never Codex or another real provider.
const legacyRuntimeSource = `
import fs from 'node:fs';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { claimNativeOwner } from ${JSON.stringify(new URL('../lib/runtime/native/store.mjs', import.meta.url).href)};
import { inspectProcessIdentity } from ${JSON.stringify(new URL('../lib/process/identity.mjs', import.meta.url).href)};
const config = JSON.parse(fs.readFileSync(process.env.HCC_LEGACY_FIXTURE_CONFIG, 'utf8'));
const trace = entry => fs.appendFileSync(config.trace, JSON.stringify(entry) + '\\n');
const ownerIdentity = inspectProcessIdentity(process.pid).identity;
const claim = generation => claimNativeOwner({ root: config.root, dbPath: config.dbPath },
  { rootIdentity: config.rootIdentity, identity: ownerIdentity, generation });
let owner = claim(config.generation);
let replacementPort;
const makeServer = instance => http.createServer(async (request, response) => {
  const authorized = request.headers.authorization === 'Bearer ' + instance.token;
  trace({ method: request.method, path: request.url, authorized, instance: instance.name });
  response.setHeader('content-type', 'application/json');
  if (!authorized) { response.writeHead(401); response.end(JSON.stringify({ ok: false, error: { code: 'NATIVE_UNAUTHORIZED' } })); return; }
  if (request.method === 'GET' && request.url === '/status') {
    // Deterministically replace the pointer before the checked GET finishes.
    // The replacement is a second old-protocol listener with another credential.
    if (instance.name === 'checked' && config.replaceOnStatus) {
      // Model a complete owner change, not a pointer detached from its durable
      // owner row. The checked response still reports the previous generation.
      owner.release();
      owner.db.close();
      fs.rmSync(config.pointer);
      owner = claim(config.replacementGeneration);
      const replacementPointer = { root: config.root, meshDb: config.dbPath,
        rootIdentity: config.rootIdentity, ownerVersion: 2, ownerIdentity,
        stateGeneration: owner.stateGeneration,
        generation: config.replacementGeneration, pid: process.pid, port: replacementPort, token: config.replacementToken };
      const temporary = config.pointer + '.fixture-swap';
      fs.writeFileSync(temporary, JSON.stringify(replacementPointer), { mode: 0o600 });
      fs.renameSync(temporary, config.pointer);
    }
    response.end(JSON.stringify({ ok: true, data: { root: config.root, meshDb: config.dbPath,
      ...(config.omitStatusGeneration ? {} : { generation: instance.generation }),
      ...(instance.version === undefined ? {} : { sandboxPolicyVersion: instance.version }),
      pid: process.pid, workers: [] } }));
    return;
  }
  if (request.method === 'POST' && request.url === '/workers') {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    spawnSync(process.execPath, [config.provider], { env: process.env, stdio: 'ignore' });
    response.end(JSON.stringify({ ok: true, data: { peer: input.peer, provider: 'codex',
      sessionId: 'legacy-session', status: 'idle' } }));
    return;
  }
  response.writeHead(404); response.end(JSON.stringify({ ok: false, error: { code: 'UNEXPECTED_ROUTE' } }));
});
const server = makeServer({ name: 'checked', generation: config.generation, token: config.token, version: config.version });
const replacement = config.replaceOnStatus ? makeServer({ name: 'replacement',
  generation: config.replacementGeneration, token: config.replacementToken }) : null;
const stop = () => {
  const servers = [server, replacement].filter(Boolean);
  let pending = servers.length;
  for (const current of servers) { current.close(() => { if (!--pending) { owner.release(); owner.db.close(); process.exit(0); } }); current.closeAllConnections(); }
};
process.on('message', value => { if (value === 'stop') stop(); });
process.on('disconnect', stop);
const listen = () => server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port, pid: process.pid, stateGeneration: owner.stateGeneration }));
if (replacement) replacement.listen(0, '127.0.0.1', () => { replacementPort = replacement.address().port; listen(); });
else listen();
`;

async function fixture(t, options = {}) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-legacy-sandbox-'));
  const root = path.join(fixtureDir, 'project space');
  const home = path.join(fixtureDir, 'home');
  for (const directory of [root, home]) fs.mkdirSync(directory, { mode: 0o700 });
  const canonicalRoot = fs.realpathSync(root);
  const ctx = { root: canonicalRoot, dbPath: path.join(canonicalRoot, '.hello-cc', 'mesh.db') };
  const traceFile = path.join(fixtureDir, 'requests.jsonl');
  const providerTrace = path.join(fixtureDir, 'provider-started');
  const provider = path.join(fixtureDir, 'marker-provider.mjs');
  fs.writeFileSync(provider, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(providerTrace)}, 'started\\n');\n`, { mode: 0o600 });
  const configFile = path.join(fixtureDir, 'fixture.json');
  const rootIdentity = captureSelectedCwdSnapshot(ctx.root);
  const config = { root: ctx.root, dbPath: ctx.dbPath, rootIdentity, token: randomBytes(32).toString('hex'),
    generation: 'legacy-fixture-generation', trace: traceFile, provider,
    pointer: path.join(ctx.root, '.hello-cc', 'native', 'runtime.json'),
    replacementGeneration: 'replacement-fixture-generation', replacementToken: randomBytes(32).toString('hex'),
    ...options };
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home,
    NODE_NO_WARNINGS: '1', NO_COLOR: '1', HCC_RUNTIME_URL: '', HCC_LEGACY_FIXTURE_CONFIG: configFile };
  const child = spawn(process.execPath, ['--input-type=module', '-e', legacyRuntimeSource], {
    cwd: root, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  });
  let stderr = '', ownedIdentity;
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
  t.after(async () => {
    // Prefer the child's own IPC shutdown. Escalation is identity-fenced and
    // never sends a signal to an unverified or reused PID.
    if (child.connected) child.send('stop');
    let observed = await waitForProcessIdentityExit(ownedIdentity || child.pid, { timeoutMs: 2000 });
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (observed.state === 'dead') break;
      const current = inspectProcessIdentity(child.pid);
      if (ownedIdentity && current.state === 'live' &&
          current.identity.startToken === ownedIdentity.startToken &&
          current.identity.commandHash === ownedIdentity.commandHash) process.kill(child.pid, signal);
      observed = await waitForProcessIdentityExit(ownedIdentity || child.pid, { timeoutMs: 2000 });
    }
    assert.equal(observed.state, 'dead', 'owned legacy fixture must terminate before removing its files');
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });
  const started = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Legacy fixture did not listen: ${stderr}`)), 5000);
    child.once('message', value => { clearTimeout(timer); resolve(value); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Legacy fixture exited ${code}: ${stderr}`)); });
  });
  const identity = await waitForLiveProcessIdentity(child.pid, { timeoutMs: 1000 });
  assert.equal(identity.state, 'live', 'fixture process identity must be captured');
  ownedIdentity = identity.identity;
  writeNativePointer(ctx, { root: ctx.root, meshDb: ctx.dbPath, generation: config.generation,
    rootIdentity, ownerVersion: 2, ownerIdentity: ownedIdentity, stateGeneration: started.stateGeneration,
    pid: child.pid, port: started.port, token: config.token });
  const raw = (...args) => spawnSync(process.execPath, [hccBin, '--root', root, '--json', ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 15_000
  });
  const trace = () => fs.existsSync(traceFile)
    ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const fail = (code, ...args) => {
    const result = raw(...args);
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0, result.stdout);
    assert.equal(JSON.parse(result.stderr).error.code, code);
  };
  const unchanged = () => {
    assert.equal(readNativePointer(ctx).pid, child.pid, 'CLI must not restart or replace the old runtime');
    const current = inspectProcessIdentity(child.pid);
    assert.equal(current.state, 'live');
    assert.deepEqual(current.identity, ownedIdentity);
    assert.equal(trace().some(row => row.method !== 'GET' || row.path !== '/status'), false);
    assert.equal(trace().some(row => row.authorized !== true), false);
    assert.equal(fs.existsSync(providerTrace), false, 'no provider executable may start');
  };
  return { raw, fail, trace, unchanged, provider, ctx, generation: config.generation };
}

test('native CLI refuses an old daemon before creating or resuming any Codex worker', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  for (const extra of [['--sandbox', 'read-only'], ['--resume', 'last'], []]) {
    f.fail('NATIVE_SANDBOX_RUNTIME_UNSUPPORTED', 'native', 'start', '--peer', 'readonly-worker',
      '--provider', 'codex', '--binary', f.provider, ...extra);
  }
  assert.equal(f.trace().length, 3, 'each admission should stop after one authenticated capability read');
  f.unchanged();
  const status = f.raw('native', 'status');
  assert.equal(status.status, 0, 'read-only status remains available for an older runtime');
  assert.equal(JSON.parse(status.stdout).data.sandboxPolicyVersion, undefined);
  f.unchanged();
});

test('invalid sandbox inputs do not contact even an existing authenticated legacy daemon', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  for (const extra of [['--sandbox', 'danger-full-access'], ['--sandbox='], ['--sandbox']]) {
    f.fail('BAD_ARGS', 'native', 'start', '--peer', 'invalid-worker', '--provider', 'codex', ...extra);
  }
  assert.deepEqual(f.trace(), []);
  f.unchanged();
});

test('Codex CLI rejects a runtime replaced after capability verification without contacting its successor', { skip: process.platform === 'win32' }, async t => {
  for (const extra of [['--sandbox', 'read-only'], ['--resume', 'last']]) {
    const f = await fixture(t, { version: 1, replaceOnStatus: true });
    f.fail('NATIVE_OWNER_CHANGED', 'native', 'start', '--peer', 'readonly-worker',
      '--provider', 'codex', '--binary', f.provider, ...extra);
    assert.equal(readNativePointer(f.ctx).generation, 'replacement-fixture-generation', 'fixture must actually replace the pointer');
    assert.deepEqual(f.trace(), [{ method: 'GET', path: '/status', authorized: true, instance: 'checked' }],
      'there must be no POST, successor request, automatic status retry or restart');
    f.unchanged();
  }
});

test('Codex CLI refuses capability version one without a reported runtime generation', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t, { version: 1, omitStatusGeneration: true });
  f.fail('NATIVE_RESPONSE_INVALID', 'native', 'start', '--peer', 'readonly-worker',
    '--provider', 'codex', '--binary', f.provider, '--sandbox', 'read-only');
  assert.equal(f.trace().length, 1);
  f.unchanged();
});

test('nativeRequest optional generation fencing rejects mismatches before network I/O and preserves unfenced reads', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  for (const expectedGeneration of ['another-generation', null, '', ' ', false, 1, 'a'.repeat(129)]) {
    await assert.rejects(nativeRequest(f.ctx, 'POST', '/workers', { provider: 'codex' }, { expectedGeneration }),
      { code: 'NATIVE_OWNER_CHANGED', extra: { uncertain: false } });
  }
  assert.deepEqual(f.trace(), []);
  assert.equal((await nativeRequest(f.ctx, 'GET', '/status', null, { expectedGeneration: f.generation })).generation, f.generation);
  assert.equal((await nativeRequest(f.ctx, 'GET', '/status')).generation, f.generation);
  assert.equal(f.trace().length, 2);
  f.unchanged();
});

// Fork admission must not bypass the same runtime capability/generation fence.
test('native CLI refuses forks on an old daemon and never follows a replaced runtime', { skip: process.platform === 'win32' }, async t => {
  const old = await fixture(t);
  old.fail('NATIVE_SANDBOX_RUNTIME_UNSUPPORTED', 'native', 'fork', '--parent', 'readonly-parent', '--peer', 'child');
  old.unchanged();
  const replaced = await fixture(t, { version: 1, replaceOnStatus: true });
  replaced.fail('NATIVE_OWNER_CHANGED', 'native', 'fork', '--parent', 'readonly-parent', '--peer', 'child');
  assert.deepEqual(replaced.trace(), [{ method: 'GET', path: '/status', authorized: true, instance: 'checked' }]);
  replaced.unchanged();
});
