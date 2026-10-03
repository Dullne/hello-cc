import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseOpts, required } from '../lib/cli-args.mjs';
import { createQueryCommands } from '../lib/cli/commands/query.mjs';
import { shellQuoteArg } from '../lib/format.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');
const hooksUrl = pathToFileURL(path.join(repoRoot, 'lib', 'integrations', 'hooks.mjs')).href;
const claudeEvents = ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse', 'PreToolUse'];
const codexEvents = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];

function fixture(t) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-hook-regression-'));
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  return {
    sandbox, home,
    claudePath: path.join(home, '.claude', 'settings.json'),
    codexPath: path.join(home, '.codex', 'hooks.json')
  };
}

function callHooks(home, calls) {
  const script = `
    import * as api from ${JSON.stringify(hooksUrl)};
    const calls = JSON.parse(process.env.HCC_TEST_HOOK_CALLS);
    const result = calls.map(({ name, args }) => {
      try { return { value: api[name](...args) }; }
      catch (error) { return { error: error.code || error.name }; }
    });
    process.stdout.write(JSON.stringify(result));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: home, HCC_TEST_HOOK_CALLS: JSON.stringify(calls) }
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function hookGroup(command, matcher) {
  return {
    ...(matcher ? { matcher } : {}),
    hooks: [
      { type: 'command', command },
      { type: 'command', command: "echo 'hcc hook is just text'" }
    ]
  };
}

test('reinstall moves stale owned hooks, quotes the active path, and preserves mixed groups', (t) => {
  const f = fixture(t);
  const currentBin = path.join(f.sandbox, "current path's", 'hcc.mjs');
  const oldBin = '/old path/hcc.mjs';
  const oldBareBin = "/old path's/bin/hcc.mjs";
  const config = (events, codex) => ({
    otherSetting: { retained: true },
    hooks: {
      ...Object.fromEntries(events.map(event => [event, [
        hookGroup(`"${oldBin}" hook ${event.toLowerCase()}`,
          codex && event === 'PreToolUse' ? 'Bash' : null),
        { hooks: [{ type: 'command', command: `${oldBareBin} hook ${event.toLowerCase()}` }] }
      ]])),
      Notification: [{ hooks: [{ type: 'command', command: '/usr/bin/notify --keep' }] }]
    }
  });
  fs.writeFileSync(f.claudePath, JSON.stringify(config(claudeEvents, false)));
  fs.writeFileSync(f.codexPath, JSON.stringify(config(codexEvents, true)));

  assert.deepEqual(callHooks(f.home, [
    { name: 'verifyClaudeHooks', args: [currentBin] },
    { name: 'verifyCodexHooks', args: [currentBin] },
    { name: 'installClaudeHooks', args: [currentBin] },
    { name: 'installCodexHooks', args: [currentBin] },
    { name: 'verifyClaudeHooks', args: [currentBin] },
    { name: 'verifyCodexHooks', args: [currentBin] }
  ]).map(result => result.value), [false, false, f.claudePath, f.codexPath, true, true]);

  for (const [file, events] of [[f.claudePath, claudeEvents], [f.codexPath, codexEvents]]) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(saved.otherSetting, { retained: true });
    assert.deepEqual(saved.hooks.Notification, [{ hooks: [{ type: 'command', command: '/usr/bin/notify --keep' }] }]);
    for (const event of events) {
      const entries = saved.hooks[event];
      const commands = entries.flatMap(entry => entry.hooks.map(hook => hook.command));
      assert.deepEqual(commands, ["echo 'hcc hook is just text'", `${shellQuoteArg(currentBin)} hook ${event.toLowerCase()}`]);
      if (file === f.codexPath && event === 'PreToolUse') {
        assert.equal(entries.at(-1).matcher, 'Bash');
      }
    }
  }

  const installed = [fs.readFileSync(f.claudePath, 'utf8'), fs.readFileSync(f.codexPath, 'utf8')];
  callHooks(f.home, [
    { name: 'installClaudeHooks', args: [currentBin] },
    { name: 'installCodexHooks', args: [currentBin] }
  ]);
  assert.deepEqual([fs.readFileSync(f.claudePath, 'utf8'), fs.readFileSync(f.codexPath, 'utf8')], installed);

  assert.deepEqual(callHooks(f.home, [
    { name: 'uninstallClaudeHooks', args: [] },
    { name: 'uninstallCodexHooks', args: [] },
    { name: 'uninstallClaudeHooks', args: [] },
    { name: 'uninstallCodexHooks', args: [] }
  ]).map(result => result.value), [true, true, false, false]);
  for (const [file, events] of [[f.claudePath, claudeEvents], [f.codexPath, codexEvents]]) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const event of events) {
      assert.deepEqual(saved.hooks[event][0].hooks, [
        { type: 'command', command: "echo 'hcc hook is just text'" }
      ]);
    }
    assert.equal(saved.hooks.Notification[0].hooks[0].command, '/usr/bin/notify --keep');
  }
});

test('uninstall removes old unquoted absolute hook paths but retains unrelated commands', (t) => {
  const f = fixture(t);
  const oldBareBin = "/old path's/bin/hcc.mjs";
  const ordinary = '/usr/bin/echo /old path/bin/hcc.mjs hook stop';
  fs.writeFileSync(f.claudePath, JSON.stringify({ hooks: {
    Stop: [
      { hooks: [{ type: 'command', command: `${oldBareBin} hook stop` }] },
      { hooks: [{ type: 'command', command: ordinary }] }
    ]
  } }));
  assert.deepEqual(callHooks(f.home, [{ name: 'uninstallClaudeHooks', args: [] }]), [{ value: true }]);
  const saved = JSON.parse(fs.readFileSync(f.claudePath, 'utf8'));
  assert.deepEqual(saved.hooks.Stop, [{ hooks: [{ type: 'command', command: ordinary }] }]);
});

test('invalid JSON is reported and never replaced by hook install or uninstall', (t) => {
  const f = fixture(t);
  const malformed = '{ invalid config: leave it alone';
  fs.writeFileSync(f.claudePath, malformed);
  fs.writeFileSync(f.codexPath, malformed);
  const results = callHooks(f.home, [
    { name: 'installClaudeHooks', args: ['/new/hcc.mjs'] },
    { name: 'uninstallClaudeHooks', args: [] },
    { name: 'verifyClaudeHooks', args: ['/new/hcc.mjs'] },
    { name: 'installCodexHooks', args: ['/new/hcc.mjs'] },
    { name: 'uninstallCodexHooks', args: [] },
    { name: 'verifyCodexHooks', args: ['/new/hcc.mjs'] }
  ]);
  assert.deepEqual(results.map(result => result.error), Array(6).fill('INVALID_HOOK_CONFIG'));
  assert.equal(fs.readFileSync(f.claudePath, 'utf8'), malformed);
  assert.equal(fs.readFileSync(f.codexPath, 'utf8'), malformed);

  const invalidShape = '{"hooks":{"SessionStart":{"hooks":[]}}}';
  fs.writeFileSync(f.claudePath, invalidShape);
  fs.writeFileSync(f.codexPath, invalidShape);
  const shapeResults = callHooks(f.home, [
    { name: 'installClaudeHooks', args: ['/new/hcc.mjs'] },
    { name: 'uninstallClaudeHooks', args: [] },
    { name: 'installCodexHooks', args: ['/new/hcc.mjs'] },
    { name: 'uninstallCodexHooks', args: [] }
  ]);
  assert.deepEqual(shapeResults.map(result => result.error), Array(4).fill('INVALID_HOOK_CONFIG'));
  assert.equal(fs.readFileSync(f.claudePath, 'utf8'), invalidShape);
  assert.equal(fs.readFileSync(f.codexPath, 'utf8'), invalidShape);
});

test('missing hook files remain installable', (t) => {
  const f = fixture(t);
  const results = callHooks(f.home, [
    { name: 'installClaudeHooks', args: [hccBin] },
    { name: 'installCodexHooks', args: [hccBin] },
    { name: 'verifyClaudeHooks', args: [hccBin] },
    { name: 'verifyCodexHooks', args: [hccBin] }
  ]);
  assert.deepEqual(results.map(result => result.value), [f.claudePath, f.codexPath, true, true]);
  const status = spawnSync(process.execPath, [hccBin, '--json', 'install-hooks', '--status'], {
    cwd: repoRoot, encoding: 'utf8', timeout: 10_000,
    env: { ...process.env, HOME: f.home }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).data, { claude: true, codex: true });
});

test('ordinary hooks honor HCC_DB and an explicit CLI database under HCC_ROOT', (t) => {
  const f = fixture(t);
  const root = path.join(f.sandbox, 'project');
  fs.mkdirSync(root);
  const envDb = path.join(root, '.hello-cc', 'environment.db');
  const cliDb = path.join(root, '.hello-cc', 'explicit.db');
  const payload = JSON.stringify({ cwd: root, session_id: 'custom-db-session' });
  const baseEnv = { ...process.env, HOME: f.home, HCC_ROOT: root, HCC_PEER: 'custom-db-peer', HCC_NATIVE_OWNER: '' };
  const run = (args, env) => spawnSync(process.execPath, [hccBin, ...args, 'hook', 'SessionStart'], {
    cwd: root, encoding: 'utf8', input: payload, timeout: 10_000, env: { ...baseEnv, ...env }
  });
  const fromEnv = run([], { HCC_DB: envDb });
  assert.equal(fromEnv.status, 0, fromEnv.stderr);
  assert.equal(fs.existsSync(envDb), true);
  assert.equal(fs.existsSync(path.join(root, '.hello-cc', 'mesh.db')), false);
  const fromCli = run(['--root', root, '--db', cliDb], { HCC_DB: envDb });
  assert.equal(fromCli.status, 0, fromCli.stderr);
  assert.equal(fs.existsSync(cliDb), true);
  for (const file of [envDb, cliDb]) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT id FROM peers').all().map(row => row.id), ['custom-db-peer']); }
    finally { db.close(); }
  }
  const outsideEnvDb = path.join(f.sandbox, 'outside-environment.db');
  const fromOutsideEnv = run([], { HCC_DB: outsideEnvDb });
  assert.equal(fromOutsideEnv.status, 0, fromOutsideEnv.stderr);
  assert.equal(fs.existsSync(outsideEnvDb), true);
  const outsideCliDb = path.join(f.sandbox, 'outside-cli.db');
  const fromOutsideCli = run(['--root', root, '--db', outsideCliDb], { HCC_DB: envDb });
  assert.equal(fromOutsideCli.status, 0, fromOutsideCli.stderr);
  assert.equal(fs.existsSync(outsideCliDb), true);
  for (const file of [outsideEnvDb, outsideCliDb]) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { assert.deepEqual(db.prepare('SELECT id FROM peers').all().map(row => row.id), ['custom-db-peer']); }
    finally { db.close(); }
  }
});

test('ordinary hooks preserve explicit database precedence through a project symlink alias', (t) => {
  if (process.platform === 'win32') return t.skip('directory symlink permissions vary on Windows');
  const f = fixture(t);
  const root = path.join(f.sandbox, 'project');
  const alias = path.join(f.sandbox, 'project-alias');
  fs.mkdirSync(root);
  fs.symlinkSync(root, alias, 'dir');
  const cliDb = path.join(root, '.hello-cc', 'explicit.db');
  const envDb = path.join(root, '.hello-cc', 'environment.db');
  const run = spawnSync(process.execPath, [hccBin, '--root', alias, '--db', cliDb, 'hook', 'SessionStart'], {
    cwd: alias, encoding: 'utf8', timeout: 10_000,
    input: JSON.stringify({ cwd: root, session_id: 'alias-db-session' }),
    env: { ...process.env, HOME: f.home, HCC_ROOT: alias, HCC_DB: envDb,
      HCC_PEER: 'alias-db-peer', HCC_NATIVE_OWNER: '' }
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(fs.existsSync(cliDb), true, 'canonical and alias roots must share the CLI database selection');
  assert.equal(fs.existsSync(envDb), false, 'HCC_DB must not override an explicit CLI database');
  assert.equal(fs.existsSync(path.join(root, '.hello-cc', 'mesh.db')), false);
  const db = new DatabaseSync(cliDb, { readOnly: true });
  try { assert.deepEqual(db.prepare('SELECT id FROM peers').all().map(row => row.id), ['alias-db-peer']); }
  finally { db.close(); }
});

test('prompt shell commands preserve special characters in every argument', async (t) => {
  const f = fixture(t);
  const marker = path.join(f.sandbox, 'should-not-exist');
  const peer = `peer'$(touch ${marker})`;
  const kind = 'codex dev';
  const role = `peer;touch ${marker}`;
  const root = path.join(f.sandbox, "project's root");
  const dbPath = path.join(root, 'data with spaces.db');
  const command = path.join(f.sandbox, "cli's folder", 'hcc.mjs');
  let prompt;
  const { cmdPrompt } = createQueryCommands({
    parseOpts, required, commandPath: () => command,
    printResult: (_ctx, data) => { prompt = data.prompt; }
  });
  await cmdPrompt({ root, dbPath }, ['--peer', peer, '--kind', kind, '--role', role]);
  const lines = prompt.split('\n').filter(line => line.startsWith('node ')).slice(0, 4);
  assert.equal(lines.length, 4);
  const expectedTail = [
    ['register', '--peer', peer, '--kind', kind, '--role', role],
    ['state', '--peer', peer],
    ['msg', 'inbox', '--peer', peer],
    ['task', 'next', '--peer', peer]
  ];
  for (const [index, line] of lines.entries()) {
    const parsed = spawnSync('/bin/sh', ['-c', `set -- ${line}; printf '%s\\n' "$@"`], { encoding: 'utf8' });
    assert.equal(parsed.status, 0, parsed.stderr);
    assert.deepEqual(parsed.stdout.trimEnd().split('\n'), [
      'node', command, '--root', root, '--db', dbPath, ...expectedTail[index]
    ]);
  }
  assert.equal(fs.existsSync(marker), false);
});
