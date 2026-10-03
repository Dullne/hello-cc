import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { shellQuoteArg } from '../lib/format.mjs';
import { monitorPinnedTmuxLaunch, runPinnedTmuxNewSession } from '../lib/web/tmux-sessions.mjs';

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-tmux-pin-'));
  const trusted = path.join(sandbox, 'trusted');
  const selected = path.join(sandbox, 'selected');
  const replacement = path.join(sandbox, 'replacement');
  fs.mkdirSync(trusted, { mode: 0o700 });
  fs.mkdirSync(selected);
  fs.mkdirSync(replacement);
  fs.writeFileSync(path.join(selected, 'marker'), 'OLD');
  fs.writeFileSync(path.join(replacement, 'marker'), 'NEW');
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  return { sandbox, trusted, selected, replacement };
}

function input(selected) {
  return {
    cwd: selected,
    shell: '/bin/sh',
    command: 'pwd; cat marker',
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
    sessionName: 'hcc-tmux-pin-test',
    tmuxEnv: { HCC_ROOT: selected }
  };
}

function runTmuxCommand(args) {
  const cwd = args[args.indexOf('-c') + 1];
  const launch = args.slice(args.indexOf('--') + 1);
  assert.ok(launch.length > 1, 'tmux must receive direct command argv');
  return spawnSync(launch[0], launch.slice(1), {
    cwd,
    env: process.env,
    encoding: 'utf8',
    timeout: 10000
  });
}

test('new tmux pane starts bootstrap from trusted cwd and runs logical shell in selected inode', (t) => {
  const { trusted, selected } = fixture(t);
  let seenArgs;
  let result;
  const monitor = runPinnedTmuxNewSession(input(selected), {
    bootstrapCwd: trusted,
    run(args) { seenArgs = args; result = runTmuxCommand(args); },
    paneInfo: () => ({ dead: false })
  });
  assert.equal(seenArgs[seenArgs.indexOf('-c') + 1], fs.realpathSync(trusted));
  assert.equal(seenArgs[seenArgs.indexOf('--') + 1], '/usr/bin/env');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `${fs.realpathSync(selected)}\nOLD`);
  assert.equal(monitor.pending(), false);
  assert.deepEqual(fs.readdirSync(trusted), []);
});

test('new tmux pane refuses a selected directory swapped before bootstrap', (t) => {
  const { sandbox, trusted, selected, replacement } = fixture(t);
  let result;
  const monitor = runPinnedTmuxNewSession(input(selected), {
    bootstrapCwd: trusted,
    run(args) {
      fs.renameSync(selected, path.join(sandbox, 'original'));
      fs.symlinkSync(replacement, selected);
      result = runTmuxCommand(args);
    },
    paneInfo: () => ({ dead: true })
  });
  assert.equal(result.status, 41, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /HCC_PINNED_CWD_CHANGED/);
  assert.equal(monitor.pending(), false);
  assert.deepEqual(fs.readdirSync(trusted), []);
});

test('tmux monitor keeps the directory descriptor until ACK or definitive pane exit', () => {
  let acknowledged = false;
  let released = 0;
  let paneState = 'live';
  const binding = { acknowledged: () => acknowledged, release: () => { released += 1; } };
  const monitor = monitorPinnedTmuxLaunch(binding, 'test:0.0', {
    paneInfo: () => {
      if (paneState === 'unknown') throw new Error('tmux temporarily busy');
      if (paneState === 'gone') throw new Error("can't find pane: test:0.0");
      return { dead: false };
    }
  });
  assert.equal(monitor.pending(), true);
  assert.equal(released, 0);
  paneState = 'unknown';
  assert.equal(monitor.check(), false);
  assert.equal(released, 0);
  acknowledged = true;
  assert.equal(monitor.check(), true);
  assert.equal(released, 1);
  assert.equal(monitor.check(), true);
  assert.equal(released, 1);

  acknowledged = false;
  const gone = monitorPinnedTmuxLaunch(binding, 'test:0.0', {
    paneInfo: () => { throw new Error("can't find pane: test:0.0"); }
  });
  assert.equal(gone.pending(), true);
  assert.equal(released, 1);
  acknowledged = true;
  assert.equal(gone.check(), true);
  assert.equal(gone.pending(), false);
  assert.equal(released, 2);
});

test('actual isolated tmux server starts the pane in the selected directory', async (t) => {
  const available = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (available.error || available.status !== 0) return t.skip('tmux is not installed');
  const { sandbox, trusted, selected } = fixture(t);
  const socket = `hcc-pin-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const canary = path.join(sandbox, 'shell-hook-canary');
  const hook = path.join(sandbox, 'shell-hook');
  const zshDir = path.join(sandbox, 'zsh-home');
  fs.mkdirSync(zshDir);
  fs.writeFileSync(hook, `printf HOOK > ${shellQuoteArg(canary)}\n`);
  fs.writeFileSync(path.join(zshDir, '.zshenv'), `printf HOOK > ${shellQuoteArg(canary)}\n`);
  const tmux = (args) => spawnSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, BASH_ENV: hook, ENV: hook, ZDOTDIR: zshDir }
  });
  t.after(() => tmux(['kill-server']));
  const output = path.join(sandbox, 'pane-output');
  const request = input(selected);
  request.command = `pwd > ${shellQuoteArg(output)}; cat marker >> ${shellQuoteArg(output)}; sleep 3`;
  const monitor = runPinnedTmuxNewSession(request, {
    bootstrapCwd: trusted,
    run(args) {
      const result = tmux(args);
      assert.equal(result.status, 0, result.stderr || result.error?.message);
    },
    paneInfo(target) {
      const result = tmux(['list-panes', '-t', target, '-F', '#{pane_dead}']);
      if (result.status !== 0) throw new Error(result.stderr || "can't find pane");
      return { dead: result.stdout.trim() === '1' };
    }
  });
  const deadline = Date.now() + 2500;
  while (monitor.pending() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(monitor.pending(), false, 'bootstrap did not acknowledge checked chdir');
  assert.equal(fs.readFileSync(output, 'utf8'), `${fs.realpathSync(selected)}\nOLD`);
  assert.equal(fs.existsSync(canary), false, 'a shell startup hook ran before the pinned bootstrap');
  assert.deepEqual(fs.readdirSync(trusted), []);
});
