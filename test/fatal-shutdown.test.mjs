import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFatalShutdownController } from '../lib/runtime/fatal-shutdown.mjs';
import { clearRuntime } from '../lib/runtime/state.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fatalModuleUrl = pathToFileURL(path.join(repoRoot, 'lib', 'runtime', 'fatal-shutdown.mjs')).href;

function childResult(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('first fatal cleans up once and every later fatal forces exit', async () => {
  const events = [];
  let releaseCleanup;
  let cleanupStarted;
  const started = new Promise((resolve) => { cleanupStarted = resolve; });
  const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
  const controller = createFatalShutdownController({
    cleanup: async (reason) => {
      events.push(`cleanup:${reason}`);
      cleanupStarted();
      await cleanupGate;
    },
    exit: (code) => { events.push(`exit:${code}`); },
    forceExit: (code) => { events.push(`force:${code}`); },
    log: (value) => { events.push(`log:${value.code}`); }
  });

  const first = controller.fatal(new Error('first'));
  await started;
  await controller.fatal(new Error('second'));
  releaseCleanup();
  await first;
  await controller.fatal(new Error('third'));

  assert.deepEqual(events, [
    'log:FATAL_RUNTIME_ERROR',
    'cleanup:first',
    'force:1',
    'exit:1',
    'force:1'
  ]);
});

test('cleanup failure is redacted and still exits nonzero', async () => {
  const secret = 'fatal-cleanup-secret-value';
  const logs = [];
  const exits = [];
  const controller = createFatalShutdownController({
    cleanup: async () => { throw new Error(`cleanup failed --token ${secret}`); },
    exit: (code) => { exits.push(code); },
    forceExit: (code) => { exits.push(code); },
    log: (value) => { logs.push(JSON.stringify(value)); }
  });

  await controller.fatal(new Error(`fatal Bearer ${secret}`));

  assert.deepEqual(exits, [1]);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /FATAL_RUNTIME_ERROR/);
  assert.match(logs[1], /FATAL_CLEANUP_ERROR/);
  assert.equal(logs.join('\n').includes(secret), false);
  assert.match(logs.join('\n'), /\[REDACTED\]/);
});

test('a lone fatal force exits when cleanup never settles', async () => {
  const events = [];
  let fireDeadline;
  const controller = createFatalShutdownController({
    cleanup: () => new Promise(() => {}),
    exit: (code) => { events.push(`exit:${code}`); },
    forceExit: (code) => { events.push(`force:${code}`); },
    log: (value) => { events.push(`log:${value.code}`); },
    schedule: (callback, delay) => {
      events.push(`schedule:${delay}`);
      fireDeadline = callback;
      return { unref: () => events.push('unref') };
    },
    timeoutMs: 2_000
  });

  void controller.fatal(new Error('hung cleanup'));
  assert.deepEqual(events, [
    'schedule:2000',
    'unref',
    'log:FATAL_RUNTIME_ERROR'
  ]);

  fireDeadline();
  assert.equal(events.at(-1), 'force:1');
});

test('completed cleanup cancels its deadline after exit returns', async () => {
  const events = [];
  const deadline = { unref: () => events.push('unref') };
  const controller = createFatalShutdownController({
    cleanup: async () => { events.push('cleanup'); },
    exit: (code) => { events.push(`exit:${code}`); },
    forceExit: (code) => { events.push(`force:${code}`); },
    log: (value) => { events.push(`log:${value.code}`); },
    schedule: () => { events.push('schedule'); return deadline; },
    cancel: (value) => { events.push(`cancel:${value === deadline}`); }
  });

  await controller.fatal(new Error('settled cleanup'));

  assert.deepEqual(events, [
    'schedule',
    'unref',
    'log:FATAL_RUNTIME_ERROR',
    'cleanup',
    'exit:1',
    'cancel:true'
  ]);
});

test('real EventEmitter routes an unhandled rejection through controlled cleanup', async () => {
  const emitter = new EventEmitter();
  const events = [];
  let exited;
  const exitObserved = new Promise((resolve) => { exited = resolve; });
  const controller = createFatalShutdownController({
    cleanup: async () => { events.push('cleanup'); },
    exit: (code) => { events.push(`exit:${code}`); exited(); },
    forceExit: (code) => { events.push(`force:${code}`); exited(); },
    log: (value) => { events.push(`log:${value.code}`); }
  });
  emitter.on('unhandledRejection', (reason) => { void controller.fatal(reason); });

  emitter.emit('unhandledRejection', new Error('event fatal'));
  await exitObserved;

  assert.deepEqual(events, ['log:FATAL_RUNTIME_ERROR', 'cleanup', 'exit:1']);
});

test('child fatal closes its real listener and fd before exiting 1', async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-fatal-child-'));
  const markerPath = path.join(fixtureDir, 'cleanup.json');
  const resourcePath = path.join(fixtureDir, 'owned-resource');
  const secret = 'child-fatal-secret-value';
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const source = String.raw`
    import fs from 'node:fs';
    import http from 'node:http';
    import { createFatalShutdownController } from ${JSON.stringify(fatalModuleUrl)};
    const [markerPath, resourcePath, secret] = process.argv.slice(1);
    const server = http.createServer((_req, res) => res.end('open'));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const fd = fs.openSync(resourcePath, 'w');
    const controller = createFatalShutdownController({
      cleanup: async () => {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        fs.closeSync(fd);
        let fdClosed = false;
        try { fs.fstatSync(fd); } catch (error) { fdClosed = error?.code === 'EBADF'; }
        fs.writeFileSync(markerPath, JSON.stringify({ listenerClosed: !server.listening, fdClosed }));
      },
      exit: (code) => process.exit(code),
      forceExit: (code) => process.exit(code),
      log: (value) => console.error(JSON.stringify(value))
    });
    process.on('unhandledRejection', (reason) => { void controller.fatal(reason); });
    Promise.reject(new Error('child fatal Bearer ' + secret + ' --token ' + secret));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, markerPath, resourcePath, secret], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const result = await childResult(child);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), {
    listenerClosed: true,
    fdClosed: true
  });
  assert.equal(result.stderr.includes(secret), false);
  assert.match(result.stderr, /FATAL_RUNTIME_ERROR/);
  assert.match(result.stderr, /\[REDACTED\]/);
});

test('runtime pointer cleanup requires the exact current pid', (t) => {
  const originalHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-fatal-runtime-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-fatal-runtime-root-'));
  const stateDir = path.join(root, '.hello-cc');
  const globalDir = path.join(home, '.hello-cc');
  const projectPointer = path.join(stateDir, 'runtime.json');
  const globalPointer = path.join(globalDir, 'runtime.json');
  process.env.HOME = home;
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(globalDir, { recursive: true });
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  for (const pointer of [projectPointer, globalPointer]) {
    fs.writeFileSync(pointer, JSON.stringify({ base_url: 'http://127.0.0.1:1' }));
  }
  clearRuntime({ root }, process.pid);
  assert.equal(fs.existsSync(projectPointer), true, 'missing-pid project pointer was deleted');
  assert.equal(fs.existsSync(globalPointer), true, 'missing-pid global pointer was deleted');

  for (const pointer of [projectPointer, globalPointer]) {
    fs.writeFileSync(pointer, JSON.stringify({ pid: process.pid + 1, base_url: 'http://127.0.0.1:1' }));
  }
  clearRuntime({ root }, process.pid);
  assert.equal(fs.existsSync(projectPointer), true, 'different-pid project pointer was deleted');
  assert.equal(fs.existsSync(globalPointer), true, 'different-pid global pointer was deleted');

  for (const pointer of [projectPointer, globalPointer]) {
    fs.writeFileSync(pointer, JSON.stringify({ pid: process.pid, base_url: 'http://127.0.0.1:1' }));
  }
  clearRuntime({ root }, process.pid);
  assert.equal(fs.existsSync(projectPointer), false, 'matching project pointer survived');
  assert.equal(fs.existsSync(globalPointer), false, 'matching global pointer survived');
});

test('Web fatal wiring retains one complete session shutdown path', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'runtime-main.mjs'), 'utf8');
  const serializeSource = fs.readFileSync(path.join(repoRoot, 'lib', 'web', 'session-serialize.mjs'), 'utf8');
  assert.ok(serializeSource.includes('function closeSessionClients('), 'closeSessionClients moved to session-serialize.mjs');
  assert.match(source, /createFatalShutdownController/);
  assert.doesNotMatch(source, /kept alive|crashWindowStart|crashCount/);
  assert.match(source, /process\.on\('uncaughtException',[\s\S]*fatalController\.fatal/);
  assert.match(source, /process\.on\('unhandledRejection',[\s\S]*fatalController\.fatal/);
  for (const expected of [
    "UPDATE peers SET status = 'detached'",
    'UPDATE peer_bindings SET runtime_target = NULL',
    'clearInterval(externalScanPoller)',
    'clearInterval(autoAttachPoller)',
    'clearInterval(reaperPoller)',
    'clearInterval(gcPoller)',
    'clearInterval(webSessionPruner)',
    'bufsWatchers.values()',
    'clearInterval(bufsWatcherSyncPoller)',
    'closeSessionClients(session)',
    'stopTmuxStream(session)',
    'session.pty.kill()',
    'wss.close()',
    'server.close('
  ]) {
    assert.ok(source.includes(expected), `Web shutdown lost ${expected}`);
  }
});
