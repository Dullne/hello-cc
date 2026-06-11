#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';

const repoRoot = path.resolve(import.meta.dirname, '..');
const hccBin = path.join(repoRoot, 'bin', 'hcc.mjs');
const testId = `${process.pid}-${Date.now()}`;
const root = path.join(os.tmpdir(), `hcc-reg-root-${testId}`);
const home = path.join(os.tmpdir(), `hcc-reg-home-${testId}`);
const fakeBin = path.join(os.tmpdir(), `hcc-reg-bin-${testId}`);
const outDir = path.join(os.tmpdir(), `hcc-reg-out-${testId}`);
const tmuxSession = `hcc-reg-${process.pid}`;
const port = 22000 + (process.pid % 10000);

let tmuxStarted = false;
let runtimePid = null;
const managedTmuxSessions = new Set();

const env = {
  ...process.env,
  HOME: home,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`
};
for (const key of Object.keys(env)) {
  if (key.startsWith('HCC_')) delete env[key];
}

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  throw new Error(message);
}

function commandText(command, args) {
  return [command, ...args].join(' ');
}

function sh(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || env,
    input: options.input,
    encoding: 'utf8',
    stdio: options.stdio || [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    fail(`${commandText(command, args)} failed${output ? `\n${output}` : ''}`);
  }
  return result.stdout || '';
}

function runMaybe(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    env: options.env || env,
    input: options.input,
    encoding: 'utf8',
    stdio: options.stdio || [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
  });
}

function hcc(args, options = {}) {
  return run(process.execPath, [hccBin, '--root', root, ...args], options);
}

function hccJson(args, options = {}) {
  const output = hcc(['--json', ...args], options);
  const parsed = JSON.parse(output);
  if (!parsed.ok) fail(`hcc json command failed: ${output}`);
  return parsed.data;
}

function hccMaybe(args, options = {}) {
  return runMaybe(process.execPath, [hccBin, '--root', root, ...args], options);
}

function hccFrom(args, cwd, options = {}) {
  return run(process.execPath, [hccBin, ...args], { ...options, cwd });
}

function hccFromMaybe(args, cwd, options = {}) {
  return runMaybe(process.execPath, [hccBin, ...args], { ...options, cwd });
}

function tmuxAvailable() {
  return runMaybe('tmux', ['-V']).status === 0;
}

function trackTmuxPane(pane) {
  if (!pane) return;
  const result = runMaybe('tmux', ['display-message', '-p', '-t', pane, '#S']);
  if (result.status === 0) managedTmuxSessions.add(result.stdout.trim());
}

function parsePane(output) {
  const match = String(output).match(/\bpane=(%\d+)/);
  if (!match) fail(`cannot parse tmux pane from:\n${output}`);
  trackTmuxPane(match[1]);
  return match[1];
}

function envWithoutPeer(extra = {}) {
  const next = { ...env, ...extra };
  delete next.HCC_PEER;
  delete next.HCC_ROOT;
  delete next.HCC_DB;
  return next;
}

function envWithoutProvider(extra = {}) {
  const next = envWithoutPeer();
  for (const key of Object.keys(next)) {
    if (key.startsWith('ANTHROPIC_') || key.startsWith('CLAUDE_CODE_')) delete next[key];
  }
  return { ...next, ...extra };
}

function envAsCodex(extra = {}) {
  const next = envWithoutPeer({
    CODEX_MANAGED_BY_NPM: '1',
    CODEX_THREAD_ID: `codex-thread-${testId}`,
    ...extra
  });
  delete next.CLAUDE_CODE_SESSION_ID;
  delete next.CLAUDECODE;
  return next;
}

function parseSentPeer(output) {
  const match = String(output).match(/^sent message #\d+ (.+) -> /m);
  if (!match) fail(`cannot parse sender from: ${output}`);
  return match[1];
}

function hasTask(rows, taskId) {
  return rows.some((row) => String(row.id) === String(taskId));
}

function hasInstalledHook(config, event) {
  const entries = config?.hooks?.[event];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) =>
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((hook) => /\bhcc\.mjs\b.*\bhook\b/.test(String(hook?.command || '')))
  );
}

function hookContext(output, expectedEvent) {
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    fail(`hook output is not JSON:\n${output}`);
  }
  const specific = parsed?.hookSpecificOutput;
  if (specific?.hookEventName !== expectedEvent) {
    fail(`hookEventName mismatch for ${expectedEvent}:\n${output}`);
  }
  return String(specific.additionalContext || '');
}

function ensureFile(file, expected = null) {
  if (!fs.existsSync(file)) fail(`missing file: ${file}`);
  if (expected !== null) {
    const actual = fs.readFileSync(file, 'utf8').trim();
    if (actual !== expected) fail(`unexpected content in ${file}: ${actual}`);
  }
}

async function waitFor(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  fail(`timed out waiting for ${label}`);
}

async function waitForFile(file, expected, label = file) {
  await waitFor(() => fs.existsSync(file), label);
  ensureFile(file, expected);
}

async function waitForFileContent(file, expected, label = file) {
  await waitFor(() => {
    if (!fs.existsSync(file)) return false;
    return fs.readFileSync(file, 'utf8').trim() === expected;
  }, label);
  ensureFile(file, expected);
}

async function waitForFileLineCount(file, expected, label = file) {
  await waitFor(() => {
    if (!fs.existsSync(file)) return false;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.length === expected;
  }, label);
}

async function waitRuntime() {
  const runtimeFile = path.join(root, '.hello-cc', 'runtime.json');
  await waitFor(async () => {
    if (!fs.existsSync(runtimeFile)) return false;
    try {
      const runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
      const response = await fetch(`${runtime.base_url}/api/runtime`);
      return response.ok;
    } catch {
      return false;
    }
  }, 'runtime');
}

async function expectWebSocketMarker(peer, marker) {
  await new Promise((resolve, reject) => {
    let sawSnapshot = false;
    let sawMarker = false;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal/${encodeURIComponent(peer)}`);
    const timer = setTimeout(() => reject(new Error(`${peer} websocket timeout`)), 5000);
    ws.on('open', () => {
      const result = hccMaybe(['inject', peer, `echo ${marker}`]);
      if (result.status !== 0) reject(new Error(result.stderr || result.stdout || 'inject failed'));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'snapshot') sawSnapshot = true;
      if (['snapshot', 'data', 'replace'].includes(msg.type) && String(msg.data || '').includes(marker)) {
        sawMarker = true;
      }
      if (sawSnapshot && sawMarker) {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });
    ws.on('error', reject);
  });
}

function tmuxStreamNodes() {
  const dir = path.join(root, '.hello-cc', 'bufs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.startsWith('tmux-') && name.endsWith('.pipe'))
    .map((name) => path.join(dir, name));
}

async function expectBoundedTmuxStream(label) {
  let nodes = [];
  await waitFor(() => {
    nodes = tmuxStreamNodes();
    return nodes.some((file) => {
      try { return fs.lstatSync(file).isFIFO(); } catch { return false; }
    });
  }, label);
  const bad = nodes.filter((file) => {
    try {
      const stat = fs.lstatSync(file);
      return !stat.isFIFO() || stat.size !== 0;
    } catch {
      return true;
    }
  });
  if (bad.length) fail(`tmux stream used growable regular files:\n${bad.join('\n')}`);
}

function writeFakeTools() {
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const name of ['claude', 'codex']) {
    const file = path.join(fakeBin, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\necho fake-${name} "$@"\nif [ -n "\${HCC_FAKE_LOG:-}" ]; then echo fake-${name} "$@" >> "$HCC_FAKE_LOG"; fi\nif [ "\${HCC_FAKE_STAY_ALIVE:-}" = "1" ]; then exec bash --noprofile --norc; fi\n`, { mode: 0o755 });
  }
}

function startRuntime(options = {}) {
  const runtimeEnv = options.env || env;
  const upOutput = hcc(['up', '--no-discover', '--no-guidance'], { env: runtimeEnv });
  if (!upOutput.includes('local coordination ready')) fail(`hcc up did not report local coordination:\n${upOutput}`);
  if (fs.existsSync(path.join(root, '.hello-cc', 'runtime.json'))) fail('hcc up should not start web runtime');

  const output = hcc(['web', '--local', '--port', String(port), '--no-discover', '--no-guidance'], { env: runtimeEnv });
  const match = output.match(/^pid:\s*(\d+)/m);
  if (!match) fail(`hcc web did not print background pid:\n${output}`);
  runtimePid = Number.parseInt(match[1], 10);
  if (!output.includes('web started in background')) fail(`hcc web did not report background start:\n${output}`);
}

async function stopRuntime() {
  if (!runtimePid) return;
  hccMaybe(['down']);
  await waitFor(() => {
    try {
      process.kill(runtimePid, 0);
      return false;
    } catch {
      return true;
    }
  }, 'runtime process exit', 5000).catch(() => {
    try { process.kill(runtimePid, 'SIGTERM'); } catch {}
  });
  runtimePid = null;
}

function cleanup() {
  try { hccMaybe(['down']); } catch {}
  if (runtimePid) {
    try { process.kill(runtimePid, 'SIGTERM'); } catch {}
  }
  if (tmuxStarted) {
    runMaybe('tmux', ['kill-session', '-t', tmuxSession]);
  }
  for (const session of managedTmuxSessions) {
    runMaybe('tmux', ['kill-session', '-t', session]);
  }
  for (const dir of [root, home, fakeBin, outDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

async function setupRegression() {
  log('[1/12] web bootstrap/hooks/shims');
  writeFakeTools();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(home, '.profile'), 'if [ "$BASH" ]; then . "$HOME/.bashrc"; fi\n');
  fs.writeFileSync(path.join(home, '.bashrc'), '# regression rc\n[ -z "$PS1" ] && return\nexport PATH="/late:$PATH"\n');
  const output = hcc(['web', '--local', '--port', String(port), '--no-discover', '--no-guidance']);
  const match = output.match(/^pid:\s*(\d+)/m);
  if (!match) fail(`hcc web did not print background pid during bootstrap:\n${output}`);
  runtimePid = Number.parseInt(match[1], 10);
  await waitRuntime();
  ensureFile(path.join(root, '.hello-cc', 'mesh.db'));
  if (fs.existsSync(path.join(root, '.hello-cc', 'HCC.md'))) fail('web --no-guidance should not write HCC.md');
  if (fs.existsSync(path.join(root, 'CLAUDE.md'))) fail('web --no-guidance should not write CLAUDE.md');
  if (fs.existsSync(path.join(root, 'AGENTS.md'))) fail('web --no-guidance should not write AGENTS.md');
  ensureFile(path.join(home, '.claude', 'settings.json'));
  ensureFile(path.join(home, '.codex', 'hooks.json'));
  const claudeHooks = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PostToolUse', 'PreToolUse']) {
    if (!hasInstalledHook(claudeHooks, event)) fail(`Claude hook missing ${event}`);
  }
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreToolUse']) {
    if (!hasInstalledHook(codexHooks, event)) fail(`Codex hook missing ${event}`);
  }
  ensureFile(path.join(home, '.hcc-shims', 'claude'));
  ensureFile(path.join(home, '.hcc-shims', 'codex'));
  const bashrc = fs.readFileSync(path.join(home, '.bashrc'), 'utf8');
  const shimIndex = bashrc.indexOf('.hcc-shims');
  const guardIndex = bashrc.indexOf('[ -z "$PS1" ] && return');
  if (shimIndex < 0 || guardIndex < 0 || shimIndex > guardIndex) {
    fail(`shim PATH was not installed before bash early return:\n${bashrc}`);
  }
  const latePathIndex = bashrc.indexOf('export PATH="/late:$PATH"');
  const lastShimIndex = bashrc.lastIndexOf('.hcc-shims');
  if (latePathIndex < 0 || lastShimIndex < latePathIndex) {
    fail(`shim PATH was not reasserted after late PATH edits:\n${bashrc}`);
  }
  const nonInteractiveCodex = run('bash', ['-lc', 'command -v codex'], { env }).trim();
  if (nonInteractiveCodex !== path.join(home, '.hcc-shims', 'codex')) {
    fail(`non-interactive bash did not resolve codex shim: ${nonInteractiveCodex}`);
  }
  const interactiveCodex = run('bash', ['-ic', 'command -v codex'], { env }).trim();
  if (interactiveCodex !== path.join(home, '.hcc-shims', 'codex')) {
    fail(`interactive bash did not keep codex shim first: ${interactiveCodex}`);
  }
  if (!hcc(['install-hooks', '--status']).includes('claude=yes codex=yes')) fail('hooks not installed');
  if (!hcc(['shim', 'status']).includes('shims installed')) fail('shims not installed');
  const staleShim = path.join(home, '.hcc-shims', 'claude');
  fs.writeFileSync(staleShim, '#!/usr/bin/env bash\necho stale --web-managed\n', { mode: 0o755 });
  const ensured = hccMaybe(['shim', 'ensure', 'claude', staleShim]);
  if (ensured.status !== 75) {
    fail(`shim ensure did not request re-exec for stale shim:\n${ensured.stdout}\n${ensured.stderr}`);
  }
  const refreshedShim = fs.readFileSync(staleShim, 'utf8');
  if (!refreshedShim.includes('shim ensure "claude"') || refreshedShim.includes('stale --web-managed')) {
    fail(`shim ensure did not refresh stale shim:\n${refreshedShim}`);
  }
  await stopRuntime();

  const noTokenOutput = hcc(['web', '--host', '0.0.0.0', '--port', String(port), '--no-discover', '--no-guidance']);
  const noTokenMatch = noTokenOutput.match(/^pid:\s*(\d+)/m);
  if (!noTokenMatch) fail(`no-token web did not print background pid:\n${noTokenOutput}`);
  runtimePid = Number.parseInt(noTokenMatch[1], 10);
  if (noTokenOutput.includes('token=') || noTokenOutput.includes('token was generated')) {
    fail(`default web output unexpectedly required token:\n${noTokenOutput}`);
  }
  await waitRuntime();
  const noTokenRuntime = JSON.parse(fs.readFileSync(path.join(root, '.hello-cc', 'runtime.json'), 'utf8'));
  if (noTokenRuntime.token || Object.hasOwn(noTokenRuntime, 'token_generated')) {
    fail(`default web runtime unexpectedly stored token data:\n${JSON.stringify(noTokenRuntime, null, 2)}`);
  }
  const noTokenResponse = await fetch(`${noTokenRuntime.base_url}/api/runtime`);
  if (!noTokenResponse.ok) fail(`default web API required token: ${noTokenResponse.status}`);
  await stopRuntime();

  const childDir = path.join(root, 'packages', 'child');
  fs.mkdirSync(childDir, { recursive: true });
  const childFindRoot = hccFrom(['find-root'], childDir).trim();
  if (childFindRoot !== childDir) fail(`child find-root mismatch: ${childFindRoot} !== ${childDir}`);
  const childStatus = hccFrom(['status'], childDir);
  if (!childStatus.includes(`root: ${childDir}`) || !childStatus.includes(`db: ${path.join(childDir, '.hello-cc', 'mesh.db')}`)) {
    fail(`child command did not stay on current path:\n${childStatus}`);
  }
  ensureFile(path.join(childDir, '.hello-cc', 'mesh.db'));
  const explicitChildRoot = hccFrom(['--root', root, 'find-root'], childDir).trim();
  if (explicitChildRoot !== root) fail(`explicit child find-root mismatch: ${explicitChildRoot} !== ${root}`);
  const explicitChildStatus = hccFrom(['--root', root, 'status'], childDir);
  if (!explicitChildStatus.includes(`root: ${root}`) || !explicitChildStatus.includes(`db: ${path.join(root, '.hello-cc', 'mesh.db')}`)) {
    fail(`explicit child command did not use requested root:\n${explicitChildStatus}`);
  }
  const childHookPayload = JSON.stringify({ session_id: 'child-hook-session', cwd: childDir, hook_event_name: 'UserPromptSubmit', prompt: 'status?' });
  hccFrom(['hook', 'userpromptsubmit'], childDir, { input: childHookPayload, env: envWithoutPeer({ CODEX_THREAD_ID: 'child-hook-thread' }) });
  const registryFile = path.join(home, '.hello-cc', 'projects.json');
  ensureFile(registryFile);
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf8'));
  if (!(registry.projects || []).some((p) => p.root === childDir)) {
    fail(`hook project was not auto-registered:\n${JSON.stringify(registry, null, 2)}`);
  }

  const joinOut = hcc(['join', '--peer', 'join-a', '--kind', 'codex']);
  if (!joinOut.includes('export HCC_PEER=join-a')) fail(`bad join output: ${joinOut}`);
  const envOut = hcc(['env', '--peer', 'env-a']);
  if (!envOut.includes('export HCC_PEER=env-a')) fail(`bad env output: ${envOut}`);
  run('bash', ['-lc', [
    `eval "$(${sh(process.execPath)} ${sh(hccBin)} --root ${sh(root)} join --peer eval-a --kind codex)"`,
    'test "$HCC_PEER" = eval-a',
    `${sh(process.execPath)} ${sh(hccBin)} --root ${sh(root)} msg send --from "$HCC_PEER" --to "$HCC_PEER" --body eval-ok >/dev/null`,
    `${sh(process.execPath)} ${sh(hccBin)} --root ${sh(root)} msg inbox --peer "$HCC_PEER" --all | grep -q eval-ok`
  ].join('; ')]);
}

async function dbWorkflow() {
  log('[3/12] db workflow');
  hcc(['register', '--peer', 'human', '--kind', 'human', '--role', 'operator']);
  const created = hcc(['task', 'create', '--from', 'human', '--to', 'codex-a', '--title', 'full regression task', '--body', 'exercise hcc bus']);
  const taskMatch = created.match(/created task #(\d+):/);
  if (!taskMatch) fail(`cannot parse task id: ${created}`);
  const taskId = taskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-a', '--id', taskId]);
  hcc(['task', 'update', '--peer', 'codex-a', '--id', taskId, '--status', 'running', '--summary', 'started']);
  const runningTasksForOtherPeer = hccJson(['task', 'list'], { env: { ...env, HCC_PEER: 'claude-a' } });
  if (!hasTask(runningTasksForOtherPeer, taskId)) {
    fail(`running task hidden from default list for another peer: #${taskId}`);
  }
  hcc(['lock', 'acquire', '--peer', 'codex-a', '--task', taskId, '--resource', 'src/router', '--ttl', '60', '--reason', 'regression']);
  hcc(['lock', 'renew', '--peer', 'codex-a', '--resource', 'src/router', '--ttl', '60']);
  hcc(['msg', 'send', '--from', 'codex-a', '--to', 'claude-a', '--task', taskId, '--body', 'please review']);
  const inbox = hcc(['msg', 'inbox', '--peer', 'claude-a', '--wait', '0']);
  if (!inbox.includes('please review')) fail('inbox did not include message');
  const msgMatch = inbox.match(/^#(\d+)/m);
  if (!msgMatch) fail(`cannot parse message id: ${inbox}`);
  hcc(['msg', 'ack', '--peer', 'claude-a', '--id', msgMatch[1]]);
  hcc(['handoff', 'create', '--from', 'codex-a', '--to', 'claude-a', '--task', taskId, '--summary', 'handoff summary', '--tests', 'full script', '--risks', 'none']);
  if (!hcc(['handoff', 'list', '--task', taskId]).includes('handoff summary')) fail('handoff missing');
  if (!hcc(['status', '--peer', 'codex-a']).includes('codex-a')) fail('status missing peer');
  hcc(['lock', 'release', '--peer', 'codex-a', '--resource', 'src/router']);
  hcc(['task', 'done', '--peer', 'codex-a', '--id', taskId, '--summary', 'done']);
  const doneDefaultTasks = hccJson(['task', 'list'], { env: { ...env, HCC_PEER: 'claude-a' } });
  if (hasTask(doneDefaultTasks, taskId)) fail(`done task still shown in default list: #${taskId}`);
  if (!hasTask(hccJson(['task', 'list', '--all']), taskId)) fail(`done task missing from --all list: #${taskId}`);
  if (!hasTask(hccJson(['task', 'list', '--status', 'done']), taskId)) fail(`done task missing from --status done list: #${taskId}`);

  const abandoned = hcc(['task', 'create', '--from', 'human', '--title', 'abandoned regression task']);
  const abandonedMatch = abandoned.match(/created task #(\d+):/);
  if (!abandonedMatch) fail(`cannot parse abandoned task id: ${abandoned}`);
  const abandonedTaskId = abandonedMatch[1];
  hcc(['task', 'update', '--peer', 'human', '--id', abandonedTaskId, '--status', 'abandoned', '--summary', 'not needed']);
  if (hasTask(hccJson(['task', 'list']), abandonedTaskId)) {
    fail(`abandoned task still shown in default list: #${abandonedTaskId}`);
  }
  if (!hasTask(hccJson(['task', 'list', '--status', 'abandoned']), abandonedTaskId)) {
    fail(`abandoned task missing from --status abandoned list: #${abandonedTaskId}`);
  }

  const hookTask = hcc(['task', 'create', '--from', 'human', '--to', 'codex-hook', '--title', 'hook visible task']);
  const hookTaskMatch = hookTask.match(/created task #(\d+):/);
  if (!hookTaskMatch) fail(`cannot parse hook task id: ${hookTask}`);
  const hookTaskId = hookTaskMatch[1];
  hcc(['task', 'claim', '--peer', 'codex-hook', '--id', hookTaskId]);
  hcc(['task', 'update', '--peer', 'codex-hook', '--id', hookTaskId, '--status', 'running', '--summary', 'hook visible']);
  hcc(['msg', 'send', '--from', 'human', '--to', 'claude-hook', '--task', hookTaskId, '--body', 'hook-only-message']);
  const hookPayload = JSON.stringify({ session_id: 'claude-hook-session', cwd: root, hook_event_name: 'UserPromptSubmit', prompt: 'status?' });
  const hookEnv = { ...env, HCC_PEER: 'claude-hook' };
  const firstHook = hookContext(hcc(['hook', 'userpromptsubmit'], { env: hookEnv, input: hookPayload }), 'UserPromptSubmit');
  if (!firstHook.includes('[hello-cc coordination]') || !firstHook.includes('[hello-cc open tasks]') || !firstHook.includes(`#${hookTaskId} running`)) {
    fail(`UserPromptSubmit hook did not include open task snapshot:\n${firstHook}`);
  }
  if (!firstHook.includes('[hello-cc known peers]') || !firstHook.includes('do not say sessions are isolated')) {
    fail(`UserPromptSubmit hook missing strong cross-session instruction:\n${firstHook}`);
  }
  if (!firstHook.includes('hcc task list') || !firstHook.includes('hook-only-message')) {
    fail(`UserPromptSubmit hook missing instructions or unread message:\n${firstHook}`);
  }
  const secondHook = hookContext(hcc(['hook', 'userpromptsubmit'], { env: hookEnv, input: hookPayload }), 'UserPromptSubmit');
  if (!secondHook.includes(`#${hookTaskId} running`)) {
    fail(`UserPromptSubmit hook stopped showing open task after first read:\n${secondHook}`);
  }
  if (secondHook.includes('hook-only-message')) {
    fail(`UserPromptSubmit hook repeated acked unread message:\n${secondHook}`);
  }
  const sessionHookPayload = JSON.stringify({ session_id: 'claude-hook-session', cwd: root, hook_event_name: 'SessionStart', source: 'resume' });
  const sessionHook = hookContext(hcc(['hook', 'sessionstart'], { env: hookEnv, input: sessionHookPayload }), 'SessionStart');
  if (!sessionHook.includes(`#${hookTaskId} running`) || sessionHook.includes('hook-only-message')) {
    fail(`SessionStart hook context wrong:\n${sessionHook}`);
  }
  hcc(['task', 'done', '--peer', 'codex-hook', '--id', hookTaskId, '--summary', 'hook regression done']);
  hcc(['event', 'tail', '--limit', '5']);

  const autoEnv = envWithoutPeer();
  const autoSent = hcc(['msg', 'send', '--to', 'all', '--body', 'auto-join-ok'], { env: autoEnv });
  const autoPeer = parseSentPeer(autoSent);
  const autoPeers = hcc(['peers']);
  if (!autoPeers.includes(autoPeer)) fail(`auto peer missing from peers: ${autoPeer}\n${autoPeers}`);
  const autoInbox = hcc(['msg', 'inbox', '--all'], { env: autoEnv });
  if (!autoInbox.includes('auto-join-ok')) fail(`auto inbox missing message:\n${autoInbox}`);
  const autoTask = hcc(['task', 'create', '--title', 'auto join task', '--body', 'auto workflow'], { env: autoEnv });
  const autoTaskMatch = autoTask.match(/created task #(\d+):/);
  if (!autoTaskMatch) fail(`cannot parse auto task id: ${autoTask}`);
  const autoTaskId = autoTaskMatch[1];
  hcc(['task', 'claim', '--id', autoTaskId], { env: autoEnv });
  hcc(['task', 'update', '--id', autoTaskId, '--status', 'running', '--summary', 'auto running'], { env: autoEnv });
  hcc(['lock', 'acquire', '--resource', 'auto/resource', '--task', autoTaskId, '--ttl', '60'], { env: autoEnv });
  hcc(['lock', 'renew', '--resource', 'auto/resource', '--ttl', '60'], { env: autoEnv });
  hcc(['handoff', 'create', '--summary', 'auto handoff', '--tests', 'auto test', '--risks', 'none'], { env: autoEnv });
  hcc(['lock', 'release', '--resource', 'auto/resource'], { env: autoEnv });
  hcc(['task', 'done', '--id', autoTaskId, '--summary', 'auto done'], { env: autoEnv });
  const autoEvents = hcc(['event', 'tail', '--limit', '50']);
  if (!autoEvents.includes('peer.auto_joined') || !autoEvents.includes(autoPeer)) {
    fail(`auto join event missing for ${autoPeer}:\n${autoEvents}`);
  }

  const codexEnv = envAsCodex();
  const codexPeer = parseSentPeer(hcc(['msg', 'send', '--to', 'all', '--body', 'auto-codex-ok'], { env: codexEnv }));
  if (!codexPeer.startsWith('codex-')) fail(`CODEX_THREAD_ID did not produce codex peer: ${codexPeer}`);
  if (!hcc(['msg', 'inbox', '--all'], { env: codexEnv }).includes('auto-codex-ok')) {
    fail('codex auto peer inbox did not include message');
  }
}

async function multiProjectWebWorkflow() {
  log('[4/12] multi-project web');
  const otherRoot = path.join(root, 'second-project');
  fs.mkdirSync(otherRoot, { recursive: true });
  const output = hccFrom(['web', '--local', '--port', String(port), '--no-discover', '--no-guidance'], otherRoot);
  if (!output.includes('web already running in background')) fail(`second project did not reuse global web:\n${output}`);
  if (!output.includes(`project: ${otherRoot}`)) fail(`second project output did not show its root:\n${output}`);
  if (!output.includes(encodeURIComponent(otherRoot))) fail(`second project URL did not include project query:\n${output}`);

  const otherRuntimeFile = path.join(otherRoot, '.hello-cc', 'runtime.json');
  ensureFile(otherRuntimeFile);
  const otherRuntime = JSON.parse(fs.readFileSync(otherRuntimeFile, 'utf8'));
  if (otherRuntime.pid !== runtimePid || otherRuntime.port !== port) {
    fail(`second project runtime did not point at global runtime:\n${JSON.stringify(otherRuntime, null, 2)}`);
  }

  const projectsResponse = await fetch(`http://127.0.0.1:${port}/api/projects?root=${encodeURIComponent(otherRoot)}`);
  const projects = await projectsResponse.json();
  if (!projectsResponse.ok) fail(`projects API failed: ${JSON.stringify(projects)}`);
  const roots = new Set((projects.projects || []).map((p) => p.root));
  if (!roots.has(root) || !roots.has(otherRoot)) {
    fail(`projects API did not include both roots:\n${JSON.stringify(projects, null, 2)}`);
  }

  const htmlResponse = await fetch(`http://127.0.0.1:${port}/`);
  const html = await htmlResponse.text();
  for (const forbidden of ['Alias optional', 'Role tag', 'Command<input', 'Working directory', 'commandbar', 'lineInput', 'Send text to active terminal']) {
    if (html.includes(forbidden)) fail(`web form still exposes ${forbidden}`);
  }
  if (!html.includes('Register Project') || !html.includes('New session') || !html.includes('<strong>Sessions</strong>') || !html.includes('<label>View<select')) {
    fail('web form missing simplified project/session controls');
  }

  if (!tmuxAvailable()) return;
  const started = hccFrom(['peer', 'start', 'other-shell', '--kind', 'shell', '--', 'bash', '--noprofile', '--norc'], otherRoot);
  parsePane(started);
  const rootList = hcc(['peer', 'list']);
  const otherList = hccFrom(['peer', 'list'], otherRoot);
  if (rootList.includes('other-shell')) fail(`root project saw second project session:\n${rootList}`);
  if (!otherList.includes('other-shell')) fail(`second project did not see its session:\n${otherList}`);

  const rootSessions = await (await fetch(`http://127.0.0.1:${port}/api/sessions?root=${encodeURIComponent(root)}`)).json();
  const otherSessions = await (await fetch(`http://127.0.0.1:${port}/api/sessions?root=${encodeURIComponent(otherRoot)}`)).json();
  if ((rootSessions.sessions || []).some((s) => s.id === 'other-shell')) {
    fail(`root API saw second project session:\n${JSON.stringify(rootSessions)}`);
  }
  if (!(otherSessions.sessions || []).some((s) => s.id === 'other-shell')) {
    fail(`second project API did not see its session:\n${JSON.stringify(otherSessions)}`);
  }

  const startAuto = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/sessions?root=${encodeURIComponent(otherRoot)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'shell', command: 'bash --noprofile --norc' })
    });
    const json = await response.json();
    if (!response.ok) fail(`auto web session start failed: ${JSON.stringify(json)}`);
    return json.session;
  };
  const autoOne = await startAuto();
  const autoTwo = await startAuto();
  if (!autoOne.id.startsWith('shell-') || !autoTwo.id.startsWith('shell-') || autoOne.id === autoTwo.id) {
    fail(`auto web session ids were not unique: ${autoOne.id}, ${autoTwo.id}`);
  }
  await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(autoOne.id)}/stop?root=${encodeURIComponent(otherRoot)}`, { method: 'POST' });
  await fetch(`http://127.0.0.1:${port}/api/sessions/${encodeURIComponent(autoTwo.id)}/stop?root=${encodeURIComponent(otherRoot)}`, { method: 'POST' });
  hccFromMaybe(['peer', 'stop', 'other-shell'], otherRoot);
}

async function tmuxBackedStartWorkflow() {
  if (!tmuxAvailable()) {
    log('[5/12] tmux-backed start skipped (tmux not installed)');
    return;
  }

  log('[5/12] tmux-backed start + websocket + restore');
  const file = path.join(outDir, 'pty-ok');
  const started = hcc(['peer', 'start', 'shell-a', '--kind', 'shell', '--', 'bash']);
  const pane = parsePane(started);
  const list = hcc(['peer', 'list']);
  if (!list.includes('shell-a') || !list.includes('tmux')) fail(`tmux-backed peer missing from list:\n${list}`);
  hcc(['inject', 'shell-a', `echo PTY_OK > ${file}`]);
  await waitForFile(file, 'PTY_OK', 'pty injection');
  await expectWebSocketMarker('shell-a', 'WS_PTY_OK');
  await expectBoundedTmuxStream('tmux-backed FIFO stream');

  await stopRuntime();
  run('tmux', ['display-message', '-p', '-t', pane, '#{pane_id}']);
  startRuntime();
  await waitRuntime();
  await waitFor(() => hcc(['peer', 'list']).includes('shell-a'), 'tmux-backed peer restore');
  const restoredFile = path.join(outDir, 'pty-restored-ok');
  hcc(['inject', 'shell-a', `echo PTY_RESTORED_OK > ${restoredFile}`]);
  await waitForFile(restoredFile, 'PTY_RESTORED_OK', 'tmux restore injection');

  await stopRuntime();
  startRuntime({ env: envWithoutProvider({ HCC_REG_VALUE: 'runtime-old', ANTHROPIC_BASE_URL: 'runtime-old-url' }) });
  await waitRuntime();
  const envFile = path.join(outDir, 'caller-env-ok');
  parsePane(hcc(['peer', 'start', 'env-a', '--kind', 'shell', '--', 'bash', '--noprofile', '--norc'], {
    env: envWithoutProvider({ HCC_REG_VALUE: 'caller-new' })
  }));
  hcc(['inject', 'env-a', `printf '%s|%s\\n' "$HCC_REG_VALUE" "\${ANTHROPIC_BASE_URL:-}" > ${envFile}`]);
  await waitForFile(envFile, 'caller-new|', 'caller env propagation');
  hcc(['peer', 'stop', 'env-a']);
}

async function shimTmuxWorkflow() {
  if (!tmuxAvailable()) {
    log('[6/12] shim tmux-backed launch skipped (tmux not installed)');
    return;
  }

  log('[6/12] shim tmux-backed launch');
  const shim = path.join(home, '.hcc-shims', 'claude');
  const codexShim = path.join(home, '.hcc-shims', 'codex');
  const claudeVersion = run(shim, ['--version'], { cwd: root, env });
  if (!claudeVersion.includes('fake-claude --version') || claudeVersion.includes('started ')) {
    fail(`claude shim did not pass through --version:\n${claudeVersion}`);
  }
  const claudePrint = run(shim, ['--print', 'hello'], { cwd: root, env });
  if (!claudePrint.includes('fake-claude --print hello') || claudePrint.includes('started ')) {
    fail(`claude shim did not pass through --print:\n${claudePrint}`);
  }
  const codexVersion = run(codexShim, ['--version'], { cwd: root, env });
  if (!codexVersion.includes('fake-codex --version') || codexVersion.includes('started ')) {
    fail(`codex shim did not pass through --version:\n${codexVersion}`);
  }
  const codexExec = run(codexShim, ['exec', 'hello'], { cwd: root, env });
  if (!codexExec.includes('fake-codex exec hello') || codexExec.includes('started ')) {
    fail(`codex shim did not pass through exec:\n${codexExec}`);
  }

  const shimEnv = {
    ...env,
    HCC_SHIM_NO_ATTACH: '1',
    HCC_FAKE_STAY_ALIVE: '1',
    HCC_NO_AUTO_INSTALL_TMUX: '1',
    HCC_REG_VALUE: 'shim-first'
  };
  const output = run(shim, ['--resume', 'shim-regression-session'], { cwd: root, env: shimEnv });
  const peerMatch = output.match(/started\s+(\S+)\s+\(/);
  if (!peerMatch) fail(`shim did not start a peer:\n${output}`);
  const peer = peerMatch[1];
  const pane = parsePane(output);
  const list = hcc(['peer', 'list']);
  if (!list.includes(peer) || !list.includes('tmux') || !list.includes(pane)) {
    fail(`shim peer missing from list:\n${list}`);
  }
  const hookPreservePayload = JSON.stringify({
    session_id: 'hook-preserve-session',
    cwd: root,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'keep tmux binding'
  });
  hcc(['hook', 'userpromptsubmit'], {
    env: { ...env, HCC_PEER: peer, CLAUDE_CODE_SESSION_ID: 'hook-preserve-session' },
    input: hookPreservePayload
  });
  const afterHookRows = hccJson(['peer', 'list']);
  const afterHookPeer = afterHookRows.find((row) => row.id === peer);
  if (!afterHookPeer?.binding || afterHookPeer.binding.transport !== 'tmux' || afterHookPeer.binding.runtime_target !== pane) {
    fail(`Claude hook overwrote tmux binding:\n${JSON.stringify(afterHookPeer, null, 2)}`);
  }
  const file = path.join(outDir, 'shim-ok');
  hcc(['inject', peer, `echo SHIM_OK > ${file}`]);
  await waitForFile(file, 'SHIM_OK', 'shim tmux injection');
  await expectWebSocketMarker(peer, 'WS_SHIM_OK');
  await expectBoundedTmuxStream('shim tmux FIFO stream');

  const firstEnvFile = path.join(outDir, 'shim-env-first');
  hcc(['inject', peer, `printf '%s\\n' "$HCC_REG_VALUE" > ${firstEnvFile}`]);
  await waitForFile(firstEnvFile, 'shim-first', 'shim first env');

  const restarted = run(shim, ['--resume', 'shim-regression-session'], {
    cwd: root,
    env: { ...shimEnv, HCC_REG_VALUE: 'shim-second' }
  });
  parsePane(restarted);
  const secondEnvFile = path.join(outDir, 'shim-env-second');
  hcc(['inject', peer, `printf '%s\\n' "$HCC_REG_VALUE" > ${secondEnvFile}`]);
  await waitForFile(secondEnvFile, 'shim-second', 'shim env restart');
  const reentryFile = path.join(outDir, 'shim-reentry');
  hcc(['inject', peer, `HCC_FAKE_STAY_ALIVE=0 HCC_REG_VALUE=shim-third ${sh(shim)} --resume shim-regression-session > ${sh(reentryFile)} 2>&1`]);
  await waitForFileContent(reentryFile, 'fake-claude --resume shim-regression-session', 'shim tmux pane re-entry');
  hcc(['peer', 'stop', peer]);

  const exitedResume = 'shim-exited-session';
  const exitedLog = path.join(outDir, 'shim-exited-log');
  const exitedEnv = {
    ...shimEnv,
    HCC_FAKE_STAY_ALIVE: '0',
    HCC_FAKE_LOG: exitedLog
  };
  const exitedFirst = run(shim, ['--resume', exitedResume], { cwd: root, env: exitedEnv });
  const exitedPeerMatch = exitedFirst.match(/started\s+(\S+)\s+\(/);
  if (!exitedPeerMatch) fail(`exited shim did not start a peer:\n${exitedFirst}`);
  const exitedPeer = exitedPeerMatch[1];
  parsePane(exitedFirst);
  await waitForFileLineCount(exitedLog, 1, 'shim exited first provider launch');
  const fallbackFile = path.join(outDir, 'shim-exited-fallback');
  hcc(['inject', exitedPeer, `printf '%s\\n' fallback > ${sh(fallbackFile)}`]);
  await waitForFile(fallbackFile, 'fallback', 'shim exited fallback shell');
  const exitedSecond = run(shim, ['--resume', exitedResume], { cwd: root, env: exitedEnv });
  parsePane(exitedSecond);
  await waitForFileLineCount(exitedLog, 2, 'shim exited resume relaunch');
  hcc(['peer', 'stop', exitedPeer]);
}

async function tmuxWorkflow() {
  const tmuxVersion = runMaybe('tmux', ['-V']);
  if (tmuxVersion.status !== 0) {
    log('[7/12] tmux skipped (tmux not installed)');
    return;
  }

  log('[7/12] tmux attach + websocket + force');
  run('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', os.tmpdir(), 'bash --noprofile --norc']);
  tmuxStarted = true;
  const pane = run('tmux', ['display-message', '-p', '-t', `${tmuxSession}:0.0`, '#{pane_id}']).trim();
  const file = path.join(outDir, 'tmux-ok');
  hcc(['peer', 'attach', 'tmux-a', '--kind', 'shell', '--pane', pane]);
  hcc(['inject', 'tmux-a', `echo TMUX_OK > ${file}`]);
  await waitForFile(file, 'TMUX_OK', 'tmux injection');
  await expectWebSocketMarker('tmux-a', 'WS_TMUX_OK');
  await expectBoundedTmuxStream('attached tmux FIFO stream');
  const conflict = hccMaybe(['peer', 'attach', 'tmux-b', '--kind', 'shell', '--pane', pane]);
  if (conflict.status === 0 || !String(conflict.stderr || conflict.stdout).includes('already attached to tmux-a')) {
    fail('tmux duplicate attach did not fail as expected');
  }
  hcc(['peer', 'attach', 'tmux-b', '--kind', 'shell', '--pane', pane, '--force']);
  if (!hcc(['peer', 'list']).includes('tmux-b')) fail('tmux force attach missing');
  hcc(['peer', 'stop', 'tmux-b']);
  run('tmux', ['display-message', '-p', '-t', pane, '#{pane_id}']);
}

async function askBroadcastWorkflow() {
  if (!tmuxAvailable()) {
    log('[8/12] ask/broadcast injection skipped (tmux not installed)');
    return;
  }

  log('[8/12] ask/broadcast injection');
  const askFile = path.join(outDir, 'ask-ok');
  parsePane(hcc(['peer', 'start', 'shell-b', '--kind', 'shell', '--', 'bash']));
  hcc(['ask', 'shell-b', `echo ASK_OK > ${askFile}`, '--from', 'human', '--inject']);
  await waitForFile(askFile, 'ASK_OK', 'ask injection');
  if (!hcc(['msg', 'inbox', '--peer', 'shell-b', '--all']).includes('ASK_OK')) fail('ask durable message missing');
  const broadcastFile = path.join(outDir, 'broadcast-ok');
  hcc(['broadcast', `echo BROADCAST_OK > ${broadcastFile}`, '--from', 'human', '--inject']);
  await waitForFile(broadcastFile, 'BROADCAST_OK', 'broadcast injection');
}

async function downGcPackWorkflow() {
  log('[9/12] down/gc/pack');
  hccMaybe(['peer', 'stop', 'shell-a']);
  hccMaybe(['peer', 'stop', 'shell-b']);
  await stopRuntime();
  await waitFor(() => !fs.existsSync(path.join(root, '.hello-cc', 'runtime.json')), 'runtime cleanup', 5000);
  hcc(['gc', '--older-than', '0', '--yes']);
  run('npm', ['pack', '--dry-run']);
}

function oldNameScan() {
  log('[10/12] old-name scan');
  const oldNamePattern = [
    'agent' + 'mesh',
    'Agent' + 'mesh',
    'AGENT' + 'MESH',
    '\\.' + 'agent' + 'mesh',
    'bin/' + 'agent' + 'mesh',
    'HCC_' + 'AGENT',
    'ACTIVE_' + 'AGENT_' + 'TTL',
    '--' + 'agent\\b'
  ].join('|');
  const rg = runMaybe('rg', [
    '-n',
    '--glob', '!node_modules/**',
    '--glob', '!*.tgz',
    '--',
    oldNamePattern,
    '.'
  ]);
  if (rg.status === 0) fail(`old names found:\n${rg.stdout}`);
  if (rg.status !== 1) fail(`rg failed:\n${rg.stderr || rg.stdout}`);
}

function syntaxAndHelp() {
  log('[11/12] syntax/help');
  run(process.execPath, ['--check', path.join(repoRoot, 'bin', 'hcc.mjs')]);
  run(process.execPath, ['--check', path.join(repoRoot, 'lib', 'setup.mjs')]);
  run(process.execPath, ['--check', path.join(repoRoot, 'lib', 'discover.mjs')]);
  const mainHelp = run(process.execPath, [hccBin, '--help']);
  if (mainHelp.includes('setup') || mainHelp.includes('uninstall') || mainHelp.includes('--web-managed')) {
    fail(`public help exposes maintenance or removed commands:\n${mainHelp}`);
  }
  const runHelp = run(process.execPath, [hccBin, 'run', '--help']);
  if (runHelp.includes('--web-managed')) fail(`run help exposes removed --web-managed:\n${runHelp}`);
  if (!run(process.execPath, [hccBin, 'peer', '--help']).includes('peer attach')) fail('peer attach missing from help');
  const removed = runMaybe(process.execPath, [hccBin, '--root', root, 'run', '--peer', 'bad', '--kind', 'shell', '--web-managed', '--', 'bash']);
  if (removed.status === 0 || !String(removed.stderr || removed.stdout).includes('unknown option --web-managed')) {
    fail(`run --web-managed was not rejected:\n${removed.stdout}\n${removed.stderr}`);
  }
  run('npm', ['run', 'smoke']);
}

function uninstallWorkflow() {
  log('[12/12] maintenance cleanup');
  const uninstallRoot = path.join(os.tmpdir(), `hcc-reg-uninstall-root-${testId}`);
  const uninstallHome = path.join(os.tmpdir(), `hcc-reg-uninstall-home-${testId}`);
  fs.mkdirSync(uninstallRoot, { recursive: true });
  fs.mkdirSync(uninstallHome, { recursive: true });
  const uninstallEnv = {
    ...env,
    HOME: uninstallHome,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`
  };

  run(process.execPath, [hccBin, '--root', uninstallRoot, 'setup', '--quiet'], { env: uninstallEnv });
  ensureFile(path.join(uninstallRoot, '.hello-cc', 'mesh.db'));
  ensureFile(path.join(uninstallRoot, 'CLAUDE.md'));
  ensureFile(path.join(uninstallRoot, 'AGENTS.md'));
  ensureFile(path.join(uninstallHome, '.claude', 'settings.json'));
  ensureFile(path.join(uninstallHome, '.codex', 'hooks.json'));
  ensureFile(path.join(uninstallHome, '.hcc-shims', 'claude'));

  const kept = run(process.execPath, [hccBin, '--root', uninstallRoot, 'uninstall'], { env: uninstallEnv });
  if (!kept.includes('project data kept')) fail(`uninstall did not keep project data by default:\n${kept}`);
  if (!fs.existsSync(path.join(uninstallRoot, '.hello-cc', 'mesh.db'))) fail('default uninstall removed project db');
  if (fs.existsSync(path.join(uninstallHome, '.hcc-shims', 'claude'))) fail('default uninstall did not remove shim');
  if (!run(process.execPath, [hccBin, '--root', uninstallRoot, 'install-hooks', '--status'], { env: uninstallEnv }).includes('claude=no codex=no')) {
    fail('default uninstall did not remove hooks');
  }

  run(process.execPath, [hccBin, '--root', uninstallRoot, 'setup', '--quiet'], { env: uninstallEnv });
  const refused = runMaybe(process.execPath, [hccBin, '--root', uninstallRoot, 'uninstall', '--purge'], { env: uninstallEnv });
  if (refused.status === 0 || !String(refused.stderr || refused.stdout).includes('without --yes')) {
    fail(`purge without --yes was not refused:\n${refused.stdout}\n${refused.stderr}`);
  }
  const purged = run(process.execPath, [hccBin, '--root', uninstallRoot, 'uninstall', '--purge', '--yes'], { env: uninstallEnv });
  if (!purged.includes('project data removed')) fail(`purge output wrong:\n${purged}`);
  if (fs.existsSync(path.join(uninstallRoot, '.hello-cc'))) fail('purge did not remove .hello-cc');
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const p = path.join(uninstallRoot, file);
    const text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (text.includes('hello-cc:start')) fail(`${file} still has hello-cc block after purge`);
  }

  try { fs.rmSync(uninstallRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(uninstallHome, { recursive: true, force: true }); } catch {}
}

async function main() {
  process.once('SIGINT', () => { cleanup(); process.exit(130); });
  process.once('SIGTERM', () => { cleanup(); process.exit(143); });

  await setupRegression();
  log('[2/12] runtime');
  startRuntime();
  await waitRuntime();
  hcc(['peer', 'list']);
  await dbWorkflow();
  await multiProjectWebWorkflow();
  await tmuxBackedStartWorkflow();
  await shimTmuxWorkflow();
  await tmuxWorkflow();
  await askBroadcastWorkflow();
  await downGcPackWorkflow();
  oldNameScan();
  syntaxAndHelp();
  uninstallWorkflow();
  log('FULL_REGRESSION_OK');
}

main().catch((err) => {
  cleanup();
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exit(1);
}).finally(() => {
  cleanup();
});
