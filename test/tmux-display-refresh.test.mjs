import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createTmuxStream } from '../lib/web/tmux-stream.mjs';
import { createTmuxSessions } from '../lib/web/tmux-sessions.mjs';
import { tmuxDisplaySnapshot } from '../lib/terminal/tmux.mjs';
import { shellQuoteArg } from '../lib/format.mjs';

async function until(predicate) {
  const deadline = performance.now() + 4000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'fixture observation timed out');
    await delay(10);
  }
}

function fixture(t, { timeoutMs = 3000 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-display-')));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const configFile = path.join(root, 'config.json'), eventsFile = path.join(root, 'events.jsonl');
  const release = path.join(root, 'release'), descendantFile = path.join(root, 'descendant');
  const body = `#!${process.execPath}
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const config = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));
const command = process.argv[2];
const record = event => fs.appendFileSync(${JSON.stringify(eventsFile)}, JSON.stringify({ command, event, pid: process.pid }) + '\\n');
record('start');
if (command === 'capture-pane' && config.descendant) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 'ignore'] });
  fs.writeFileSync(${JSON.stringify(descendantFile)}, String(child.pid)); child.unref(); process.exit(0);
}
const finish = () => {
  record('finish');
  if (config.fail === command) process.exit(1);
  if (command === 'capture-pane') process.stdout.write((config.output || 'image') + '\\n');
  if (command === 'display-message') process.stdout.write('0,0,1,0,24\\n');
};
if (command === 'capture-pane' && config.gate) {
  const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); finish(); } }, 5);
} else setTimeout(finish, command === 'capture-pane' ? config.captureDelay || 0 : config.cursorDelay || 0);
`;
  const executable = path.join(bin, 'tmux'); fs.writeFileSync(executable, body, { mode: 0o700 });
  const previousPath = process.env.PATH;
  process.env.PATH = bin + path.delimiter + (previousPath || '');
  const frames = [], flights = [];
  let stopping = false;
  const stream = createTmuxStream({ ctx: { root }, snapshotTimeoutMs: timeoutMs, now: Date.now,
    isStopping: () => stopping, broadcast(_session, frame) { frames.push(frame); },
    shellQuoteArg, refreshPeerIoHeartbeat() {}, withBufferDirectoryLease(_directory, fn) { return fn(); } });
  const session = { id: 'display', type: 'tmux', pane: '%one', status: 'running', buffer: 'previous' };
  const configure = value => fs.writeFileSync(configFile, JSON.stringify(value));
  configure({});
  const events = () => fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const refresh = options => {
    const result = stream.refreshTmuxSnapshotAsync(session, options); flights.push(result); return result;
  };
  t.after(async () => {
    stream.stopTmuxStream(session, { shutdownDeadline: 0 });
    if (fs.existsSync(descendantFile)) {
      try { process.kill(Number(fs.readFileSync(descendantFile, 'utf8')), 'SIGKILL'); } catch {}
    }
    await Promise.allSettled(flights);
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, stream, session, frames, refresh, configure, events, release: () => fs.writeFileSync(release, ''),
    stopping: () => { stopping = true; } };
}

test('display reads reuse a flight and share one deadline across capture and cursor', async t => {
  const f = fixture(t, { timeoutMs: 1500 });
  f.configure({ captureDelay: 600, cursorDelay: 1000 });
  const first = f.refresh(), second = f.refresh();
  assert.equal(second, first);
  assert.equal(await first, false);
  assert.equal(f.session.buffer, 'previous'); assert.equal(f.frames.length, 0);
  assert.deepEqual(f.events().filter(row => row.event === 'start').map(row => row.command), ['capture-pane', 'display-message']);
  f.configure({ output: 'recovered' });
  assert.equal(await f.refresh(), true);
  assert.match(f.session.buffer, /^recovered/);
});

test('failed cursor reads preserve the complete old image and invalid deadlines reject', async t => {
  const f = fixture(t);
  f.configure({ output: 'partial', fail: 'display-message' });
  assert.equal(await f.refresh(), false);
  assert.equal(f.session.buffer, 'previous'); assert.equal(f.frames.length, 0);
  for (const timeoutMs of [0, -1, Infinity, NaN, 5001]) {
    await assert.rejects(tmuxDisplaySnapshot('%fixture', { timeoutMs }), { code: 'BAD_ARGS' });
  }
});

test('stop cancels and joins the child; restarting this session cannot publish its old generation', async t => {
  const f = fixture(t);
  f.configure({ gate: true, output: 'stale' });
  const old = f.refresh();
  await until(() => f.events().some(row => row.command === 'capture-pane'));
  const pid = f.events()[0].pid;
  f.stream.stopTmuxStream(f.session, { shutdownDeadline: 0 });
  f.configure({ output: 'new generation' });
  f.stream.startTmuxReplacePoller(f.session);
  const newer = f.refresh();
  await Promise.all([old, newer]);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(f.frames.length, 1); assert.match(f.frames[0].data, /^new generation/);
});

test('pane replacement drops the old image and queues only one fresh capture', async t => {
  const f = fixture(t);
  f.configure({ gate: true, output: 'old pane' });
  const first = f.refresh();
  await until(() => f.events().some(row => row.command === 'capture-pane'));
  f.session.pane = '%two'; f.configure({ output: 'new pane' });
  const next = f.refresh(); assert.equal(f.refresh(), next);
  f.release(); await first;
  assert.equal(f.frames.length, 1); assert.match(f.frames[0].data, /^new pane/);
  assert.equal(f.events().filter(row => row.command === 'capture-pane' && row.event === 'start').length, 2);
});

for (const entry of ['input', 'resize']) {
  test(`${entry} invalidates the old image immediately before its debounce timer fires`, async t => {
    const f = fixture(t);
    f.configure({ gate: true, output: 'stale' });
    const first = f.refresh();
    await until(() => f.events().some(row => row.command === 'capture-pane'));
    f.configure({ output: 'fresh' });
    if (entry === 'input') {
      const sessions = createTmuxSessions({ refreshTmuxSnapshotAsync: f.stream.refreshTmuxSnapshotAsync,
        invalidateTmuxSnapshot: f.stream.invalidateTmuxSnapshot });
      sessions.scheduleTmuxInputRefresh(f.session);
    } else f.stream.scheduleTmuxReplace(f.session);
    f.release(); await first;
    await until(() => f.frames.length > 0);
    assert.ok(f.frames.every(frame => !frame.data.startsWith('stale')));
    assert.match(f.frames.at(-1).data, /^fresh/);
  });
}

test('a synchronous initial/on-demand read and runtime shutdown fence an older async image', async t => {
  const f = fixture(t);
  f.configure({ gate: true, output: 'stale' });
  const old = f.refresh();
  await until(() => f.events().some(row => row.command === 'capture-pane'));
  f.configure({ output: 'on demand' });
  assert.match(f.stream.refreshTmuxSnapshot(f.session), /^on demand/);
  f.stopping(); f.release();
  assert.equal(await old, false);
  assert.match(f.session.buffer, /^on demand/); assert.equal(f.frames.length, 0);
});

test('FIFO output arriving during capture cannot be overwritten by an older snapshot', async t => {
  const f = fixture(t);
  f.stream.startTmuxStream(f.session);
  const captures = f.events().filter(row => row.command === 'capture-pane' && row.event === 'start').length;
  f.configure({ gate: true, output: 'stale' });
  const old = f.refresh();
  await until(() => f.events().filter(row => row.command === 'capture-pane' && row.event === 'start').length > captures);
  const writer = fs.openSync(f.session.pipeFile, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  fs.writeSync(writer, 'fresh FIFO bytes'); fs.closeSync(writer);
  await until(() => f.frames.some(frame => frame.type === 'data'));
  f.release(); assert.equal(await old, false);
  assert.ok(f.session.buffer.includes('fresh FIFO bytes'));
  assert.equal(f.frames.filter(frame => frame.type === 'replace').length, 0);
});

test('a descendant retaining stdout cannot hold the display flight past its timeout', async t => {
  const f = fixture(t, { timeoutMs: 300 });
  f.configure({ descendant: true });
  let timer;
  const result = await Promise.race([f.refresh(), new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 2000); })]);
  clearTimeout(timer);
  assert.equal(result, false);
  assert.equal(f.session.buffer, 'previous'); assert.equal(f.frames.length, 0);
});
