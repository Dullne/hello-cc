import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { shellQuoteArg } from '../lib/format.mjs';
import { CliError } from '../lib/shared/errors.mjs';
import { conditionalTmuxKill, conditionalTmuxRename } from '../lib/core/peers/tmux-safety.mjs';
import { runTmux } from '../lib/terminal/tmux.mjs';
import { prepareTmuxCwdHandoff, trustedCwdHandoffBinary } from '../lib/process/tmux-cwd-handoff.mjs';
import { monitorPinnedTmuxLaunch, runPinnedTmuxNewSession } from '../lib/web/tmux-sessions.mjs';

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-tmux-pin-'));
  const selected = path.join(sandbox, 'selected');
  const replacement = path.join(sandbox, 'replacement');
  fs.mkdirSync(selected);
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(selected, 'marker'), 'OLD');
  fs.writeFileSync(path.join(replacement, 'marker'), 'NEW');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  return { sandbox, selected, replacement };
}

function input(selected) {
  return {
    cwd: selected,
    shell: '/bin/sh',
    command: 'cat marker',
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    sessionName: 'hcc-tmux-pin-test',
    tmuxEnv: { HCC_ROOT: selected }
  };
}

function mockHandoff() {
  const state = { authorized: [], released: 0, bound: false, failed: false, waitError: null };
  return {
    state,
    prepare() {
      return {
        cwd: '/', command: '/trusted/hcc-cwd-handoff', args: ['client'], env: { PATH: '/usr/bin:/bin' },
        authorize(pid) { state.authorized.push(pid); },
        waitBoundSync() {
          if (state.waitError) throw state.waitError;
          state.bound = true;
        },
        acknowledged() { return state.bound; },
        failed() { return state.failed; },
        release() { state.released++; }
      };
    }
  };
}

test('tmux gets only the trusted cwd and authorizes the atomically reported pane PID', (t) => {
  const { selected } = fixture(t);
  const handoff = mockHandoff();
  let args;
  const monitor = runPinnedTmuxNewSession(input(selected), {
    prepare: handoff.prepare,
    run(value) { args = value; return '%42|12345|$7|1700000000\n'; },
    paneInfo: () => ({ dead: false })
  });
  assert.deepEqual(args.slice(0, 6), [
    'new-session', '-d', '-P', '-F', '#{pane_id}|#{pane_pid}|#{session_id}|#{session_created}', '-s'
  ]);
  assert.equal(args[args.indexOf('-c') + 1], '/');
  assert.deepEqual(handoff.state.authorized, [12345]);
  assert.equal(handoff.state.bound, true);
  assert.equal(monitor.pending(), false);
  assert.equal(handoff.state.released, 1);
});

test('a created pane is reported for rollback before bind failure, never admitted', (t) => {
  const { selected } = fixture(t);
  const handoff = mockHandoff();
  handoff.state.waitError = new CliError('PINNED_CWD_UNAVAILABLE', 'client never bound');
  const created = [];
  assert.throws(() => runPinnedTmuxNewSession(input(selected), {
    prepare: handoff.prepare,
    run: () => '%42|12345|$7|1700000000\n',
    onCreated(fields) { created.push(fields); }
  }), { code: 'PINNED_CWD_UNAVAILABLE' });
  assert.deepEqual(created, [['%42', '12345', '$7', '1700000000']]);
  assert.deepEqual(handoff.state.authorized, [12345]);
  assert.equal(handoff.state.bound, false);
  assert.equal(handoff.state.released, 1);
});

test('missing or malformed tmux receipt never authorizes the directory FD', (t) => {
  const { selected } = fixture(t);
  for (const receipt of ['', '%1|0|$1|1700000000', '%1|abc|$1|1700000000',
    '%1|123|invalid|1700000000', '%1|123|$1|bad',
    '%1|999999999999999999|$1|1700000000', '%1|123|$1|1700000000\n%2|456|$2|1700000001']) {
    const handoff = mockHandoff();
    assert.throws(() => runPinnedTmuxNewSession(input(selected), {
      prepare: handoff.prepare,
      run: () => receipt
    }), { code: 'TMUX_ERROR' });
    assert.deepEqual(handoff.state.authorized, []);
    assert.equal(handoff.state.released, 1);
  }
});

test('per-launch hold rejects the pane before broker or tmux startup', (t) => {
  const { selected } = fixture(t);
  const held = input(selected);
  held.env.HCC_PINNED_LAUNCH_MODE = 'hold';
  assert.throws(() => runPinnedTmuxNewSession(held, {
    run() { throw new Error('tmux must not start'); }
  }), { code: 'PINNED_LAUNCH_PAUSED' });
});

test('native helper starts without pre-bind loader hooks or stale PWD', (t) => {
  try { trustedCwdHandoffBinary(); }
  catch { return t.skip('prebuilt trusted handoff helper unavailable'); }
  const { selected } = fixture(t);
  const binding = prepareTmuxCwdHandoff({
    ...input(selected),
    env: { PATH: '/usr/bin:/bin', PWD: selected,
      LD_PRELOAD: '/untrusted/preload.so', DYLD_INSERT_LIBRARIES: '/untrusted/preload.dylib' }
  });
  try {
    assert.equal(binding.env.PWD, undefined);
    assert.equal(binding.env.LD_PRELOAD, undefined);
    assert.equal(binding.env.DYLD_INSERT_LIBRARIES, undefined);
  } finally { binding.release(); }
});

test('a helper spawn failure is handled without a later unhandled child error', async (t) => {
  const { selected } = fixture(t);
  assert.throws(() => prepareTmuxCwdHandoff(input(selected), {
    binary: '/hcc-deliberately-missing-cwd-helper',
    spawnBroker: (_binary, args, options) =>
      spawn('/hcc-deliberately-missing-cwd-helper', args, options)
  }), { code: 'PINNED_CWD_UNAVAILABLE' });
  await new Promise(resolve => setImmediate(resolve));
});

test('ambiguous tmux timeout revokes the broker without authorizing an orphan pane', (t) => {
  const { selected } = fixture(t);
  const handoff = mockHandoff();
  const timeout = new CliError('TMUX_ERROR', 'tmux timed out after creating a pane');
  assert.throws(() => runPinnedTmuxNewSession(input(selected), {
    prepare: handoff.prepare,
    run() { throw timeout; }
  }), (error) => error === timeout);
  assert.deepEqual(handoff.state.authorized, []);
  assert.equal(handoff.state.released, 1);
});

test('monitor releases a failed handoff even if the pane remains alive', () => {
  const handoff = mockHandoff();
  const monitor = monitorPinnedTmuxLaunch(handoff.prepare(), '%1', {
    paneInfo: () => ({ dead: false })
  });
  assert.equal(monitor.pending(), true);
  handoff.state.failed = true;
  assert.equal(monitor.check(), true);
  assert.equal(handoff.state.released, 1);
});

test('runTmux distinguishes a proven pre-spawn failure from timeout', () => {
  assert.throws(() => runTmux(['-V'], {
    spawn: (_command, args, options) => spawnSync('hcc-deliberately-absent-tmux', args, options)
  }), (error) => error.code === 'TMUX_ERROR' && error.extra?.preSpawnCode === 'ENOENT');
  assert.throws(() => runTmux(['new-session'], {
    spawn: () => ({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), pid: 0, killed: true })
  }), (error) => error.code === 'TMUX_ERROR' && error.extra?.preSpawnCode === undefined);
});

test('actual isolated tmux pane inherits the original FD after same-path replacement', async (t) => {
  if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) return t.skip('tmux unavailable');
  try { trustedCwdHandoffBinary(); }
  catch { return t.skip('prebuilt trusted handoff helper unavailable'); }
  const { sandbox, selected, replacement } = fixture(t);
  const socketName = `hcc-fd-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const startupCanary = path.join(sandbox, 'shell-started-before-handoff');
  const startupHook = path.join(sandbox, 'shell-startup-hook');
  fs.writeFileSync(startupHook, `printf BAD > ${shellQuoteArg(startupCanary)}\n`);
  const replacementShellCanary = path.join(sandbox, 'replacement-shell-executed');
  fs.writeFileSync(path.join(selected, 'local-shell'), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(replacement, 'local-shell'),
    `#!/bin/sh\nprintf BAD > ${shellQuoteArg(replacementShellCanary)}\nexec /bin/sh "$@"\n`, { mode: 0o755 });
  const tmux = (args) => spawnSync('tmux', ['-L', socketName, '-f', '/dev/null', ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, BASH_ENV: startupHook, ENV: startupHook }
  });
  t.after(() => tmux(['kill-server']));
  const output = path.join(sandbox, 'result');
  const request = input(selected);
  request.shell = path.join(selected, 'local-shell');
  request.command = `cat marker > ${shellQuoteArg(output)}; sleep 2`;
  let replaced = false;
  const monitor = runPinnedTmuxNewSession(request, {
    run(args) {
      fs.renameSync(selected, path.join(sandbox, 'original'));
      fs.symlinkSync(replacement, selected);
      replaced = true;
      const result = tmux(args);
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return result.stdout;
    },
    paneInfo(target) {
      const result = tmux(['list-panes', '-t', target, '-F', '#{pane_dead}']);
      if (result.status !== 0) throw new Error(result.stderr || "can't find pane");
      return { dead: result.stdout.trim() === '1' };
    }
  });
  assert.equal(replaced, true);
  const deadline = Date.now() + 5000;
  let content = '';
  while (Date.now() < deadline) {
    try { content = fs.readFileSync(output, 'utf8'); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (content) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(content, 'OLD', 'replacement B must not be executed');
  assert.equal(fs.readFileSync(path.join(replacement, 'marker'), 'utf8'), 'NEW');
  assert.equal(fs.existsSync(startupCanary), false, 'tmux launched a shell before the FD handoff');
  assert.equal(fs.existsSync(replacementShellCanary), false, 'absolute shell path escaped the pinned cwd');
  const boundDeadline = Date.now() + 2000;
  while (monitor.pending() && Date.now() < boundDeadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(monitor.pending(), false, 'trusted handoff did not complete');
});

test('a reused managed name is not killed or quarantined with an old creation receipt', (t) => {
  if (spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status !== 0) return t.skip('tmux unavailable');
  const socketName = `hcc-reuse-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const tmux = args => spawnSync('tmux', ['-L', socketName, '-f', '/dev/null', ...args], {
    encoding: 'utf8', timeout: 5000
  });
  const run = args => {
    const result = tmux(args);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  t.after(() => tmux(['kill-server']));
  const name = 'hcc-managed-reused';
  run(['new-session', '-d', '-s', 'hcc-reuse-sentinel', 'sleep 10']);
  const first = run(['new-session', '-d', '-P', '-F',
    '#{pane_id}|#{pane_pid}|#{session_id}|#{session_created}', '-s', name, 'sleep 10']).trim().split('|');
  assert.equal(first.length, 4);
  const candidate = {
    session: name, pane: first[0], session_id: first[2], session_created: first[3],
    process_identity: { pid: Number(first[1]) }
  };
  run(['kill-session', '-t', candidate.session_id]);
  const second = run(['new-session', '-d', '-P', '-F', '#{session_id}', '-s', name, 'sleep 10']).trim();
  assert.notEqual(second, candidate.session_id);
  assert.throws(() => conditionalTmuxKill(run, candidate, { allowClients: true }),
    { code: 'TMUX_CONDITIONAL_KILL_MISMATCH' });
  assert.throws(() => conditionalTmuxRename(run, candidate, 'hcc-quarantine', { allowClients: true }),
    { code: 'TMUX_CONDITIONAL_RENAME_MISMATCH' });
  assert.equal(run(['display-message', '-p', '-t', name, '#{session_id}']).trim(), second);
});
