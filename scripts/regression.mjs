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

function writeFakeTools() {
  fs.mkdirSync(fakeBin, { recursive: true });
  for (const name of ['claude', 'codex']) {
    const file = path.join(fakeBin, name);
    fs.writeFileSync(file, `#!/usr/bin/env bash\necho fake-${name} "$@"\nif [ "\${HCC_FAKE_STAY_ALIVE:-}" = "1" ]; then exec bash --noprofile --norc; fi\n`, { mode: 0o755 });
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
  log('[1/11] web bootstrap/hooks/shims');
  writeFakeTools();
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
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
  log('[3/11] db workflow');
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

async function tmuxBackedStartWorkflow() {
  if (!tmuxAvailable()) {
    log('[4/11] tmux-backed start skipped (tmux not installed)');
    return;
  }

  log('[4/11] tmux-backed start + websocket + restore');
  const file = path.join(outDir, 'pty-ok');
  const started = hcc(['peer', 'start', 'shell-a', '--kind', 'shell', '--', 'bash']);
  const pane = parsePane(started);
  const list = hcc(['peer', 'list']);
  if (!list.includes('shell-a') || !list.includes('tmux')) fail(`tmux-backed peer missing from list:\n${list}`);
  hcc(['inject', 'shell-a', `echo PTY_OK > ${file}`]);
  await waitForFile(file, 'PTY_OK', 'pty injection');
  await expectWebSocketMarker('shell-a', 'WS_PTY_OK');

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
    log('[5/11] shim tmux-backed launch skipped (tmux not installed)');
    return;
  }

  log('[5/11] shim tmux-backed launch');
  const shim = path.join(home, '.hcc-shims', 'claude');
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
  const file = path.join(outDir, 'shim-ok');
  hcc(['inject', peer, `echo SHIM_OK > ${file}`]);
  await waitForFile(file, 'SHIM_OK', 'shim tmux injection');
  await expectWebSocketMarker(peer, 'WS_SHIM_OK');

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
  hcc(['peer', 'stop', peer]);
}

async function tmuxWorkflow() {
  const tmuxVersion = runMaybe('tmux', ['-V']);
  if (tmuxVersion.status !== 0) {
    log('[6/11] tmux skipped (tmux not installed)');
    return;
  }

  log('[6/11] tmux attach + websocket + force');
  run('tmux', ['new-session', '-d', '-s', tmuxSession, '-c', os.tmpdir(), 'bash --noprofile --norc']);
  tmuxStarted = true;
  const pane = run('tmux', ['display-message', '-p', '-t', `${tmuxSession}:0.0`, '#{pane_id}']).trim();
  const file = path.join(outDir, 'tmux-ok');
  hcc(['peer', 'attach', 'tmux-a', '--kind', 'shell', '--pane', pane]);
  hcc(['inject', 'tmux-a', `echo TMUX_OK > ${file}`]);
  await waitForFile(file, 'TMUX_OK', 'tmux injection');
  await expectWebSocketMarker('tmux-a', 'WS_TMUX_OK');
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
    log('[7/11] ask/broadcast injection skipped (tmux not installed)');
    return;
  }

  log('[7/11] ask/broadcast injection');
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
  log('[8/11] down/gc/pack');
  hccMaybe(['peer', 'stop', 'shell-a']);
  hccMaybe(['peer', 'stop', 'shell-b']);
  await stopRuntime();
  await waitFor(() => !fs.existsSync(path.join(root, '.hello-cc', 'runtime.json')), 'runtime cleanup', 5000);
  hcc(['gc', '--older-than', '0', '--yes']);
  run('npm', ['pack', '--dry-run']);
}

function oldNameScan() {
  log('[9/11] old-name scan');
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
  log('[10/11] syntax/help');
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
  log('[11/11] maintenance cleanup');
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
  log('[2/11] runtime');
  startRuntime();
  await waitRuntime();
  hcc(['peer', 'list']);
  await dbWorkflow();
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
