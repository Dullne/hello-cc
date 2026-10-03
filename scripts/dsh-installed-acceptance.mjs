import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { JsonRpcProcess } from '../lib/integrations/native/jsonrpc.mjs';
import { createDshEnvironment } from '../lib/integrations/dsh.mjs';
import { checkDshRuntime } from '../lib/integrations/dsh-cordis.mjs';
import { redactSecrets } from '../lib/shared/redact.mjs';

// Uses actual npm/pnpm installations and the installed public CLI. Every
// profile, project and process belongs to this run. Real inference is opt-in.
const args = process.argv.slice(2);
const install = args[0];
const opt = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (!install || install === '--help') {
  console.log('Usage: node scripts/dsh-installed-acceptance.mjs /isolated/dsh/install [--run-live] [--tarball PATH] [--output-dir DIR] [--npm-cache DIR] [--pnpm-store DIR]');
  process.exit(0);
}
const live = args.includes('--run-live');
if (live && !process.env.DEEPSEEK_API_KEY) throw new Error('Live acceptance requires the existing DEEPSEEK_API_KEY');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolveOfficial = createRequire(path.join(path.resolve(install), 'package.json'));
const binary = resolveOfficial.resolve('@deepseek-ai/dsh/lib/bin.js');
checkDshRuntime(binary);
const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-dsh-installed-')));
fs.chmodSync(directory, 0o700);
const home = path.join(directory, 'home'), root = path.join(directory, 'project'), cordisRoot = path.join(directory, 'cordis-project');
for (const dir of [home, root, cordisRoot]) fs.mkdirSync(dir, { mode: 0o700 });
const prefix = path.join(directory, 'npm-install');
const env = createDshEnvironment(process.env);
Object.assign(env, { HOME: home, DSH_HOME: path.join(home, 'dsh'), DSH_TELEMETRY_DISABLED: '1',
  PATH: [path.dirname(process.execPath), path.join(path.resolve(install), 'node_modules/.bin'), path.join(prefix, 'node_modules/.bin'), env.PATH || ''].join(path.delimiter) });
const noModelEnv = { ...env, DEEPSEEK_API_KEY: 'isolated-no-model-placeholder' };
const output = path.resolve(opt('--output-dir', directory));
fs.mkdirSync(output, { recursive: true });
const receiptPath = path.join(output, 'dsh-installed-receipt.json');
const receipt = { startedAt: new Date().toISOString(), node: process.version, baseline: '0.2.0-rc.2', directory,
  validation: live ? 'installed public CLI, original authenticated DeepSeek model' : 'installed public CLI and official profile lifecycle; no model call',
  checks: [], artifacts: {}, cleanup: {}, limitations: ['No npm publication, global installation, employee device or genuine business task acceptance.'] };
function check(name, data = {}) { receipt.checks.push({ name, passed: true, ...data }); flush(); console.log(JSON.stringify({ check: name, ...data })); }
function flush() { fs.writeFileSync(receiptPath, JSON.stringify(redactSecrets(receipt), null, 2) + '\n', { mode: 0o600 }); }
async function run(label, executable, argv, { cwd = directory, childEnv = env, timeout = 120000, omitOutput = false, allowFailure = false } = {}) {
  const ownsProcessGroup = process.platform !== 'win32';
  const child = spawn(executable, argv, { cwd, env: childEnv, detached: ownsProcessGroup, stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = signal => {
    try { if (ownsProcessGroup) process.kill(-child.pid, signal); else child.kill(signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let stdout = '', stderr = '', timeoutReached = false;
  const timer = setTimeout(() => { timeoutReached = true; stop('SIGTERM'); }, timeout);
  const forced = setTimeout(() => { if (timeoutReached) stop('SIGKILL'); }, timeout + 5000);
  const progress = setInterval(() => console.log(JSON.stringify({ running: label })), 20000);
  child.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-2000000); });
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-2000000); });
  try {
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    fs.writeFileSync(path.join(directory, label + '.log'), omitOutput ? `exit=${status.code}; output omitted\n` : redactSecrets(stdout + stderr), { mode: 0o600 });
    if (!allowFailure) assert.equal(status.code, 0, `${label} failed (${status.signal || status.code}): ${redactSecrets(stderr).slice(-2000)}`);
    return { ...status, stdout, stderr };
  } finally { clearTimeout(timer); clearTimeout(forced); clearInterval(progress); }
}
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function read(project, sql, ...params) {
  const db = new DatabaseSync(path.join(project, '.hello-cc/mesh.db'), { readOnly: true });
  try { return db.prepare(sql).all(...params).map(row => ({ ...row })); } finally { db.close(); }
}
let cli, api, rpc, nativeUp = false;
const peer = 'installed-dsh', marker = 'INSTALLED_' + randomUUID().replaceAll('-', '').slice(0, 16);
const denyTarget = path.join(root, 'permission-denied.txt');
async function hcc(argv, project = root) {
  const result = await run('hcc-' + argv.slice(0, 2).join('-'), process.execPath, [cli, '--root', project, '--json', ...argv], { cwd: project, timeout: 30000 });
  const parsed = JSON.parse(result.stdout); return parsed.data ?? parsed;
}
async function until(fn, label, timeout = 120000) {
  const deadline = Date.now() + timeout; let notice = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value;
    if (Date.now() > notice) { console.log(JSON.stringify({ waiting: label })); notice += 20000; } await delay(250); }
  throw new Error('Timed out: ' + label);
}
async function send(body, task) { return hcc(['native', 'send', '--peer', peer, '--from', 'acceptance-coordinator', '--body', body, ...(task ? ['--task', String(task)] : [])]); }
async function finish(message, { decline = false, label = 'native turn' } = {}) {
  return until(async () => {
    const pending = await hcc(['native', 'requests', '--peer', peer]);
    for (const request of pending.filter(item => item.status === 'pending')) {
      const serialized = JSON.stringify(request.params || request);
      if (decline) assert.ok(serialized.includes(denyTarget), 'The refused ACP request must name the test-owned target file');
      else assert.ok(serialized.includes(root) || /hcc_|hello_cc_scoped/.test(serialized), 'Only acceptance-owned file or collaboration operations may be approved');
      const decision = decline ? 'decline' : 'accept';
      await hcc(['native', 'respond', '--peer', peer, '--request', String(request.requestId), '--decision', decision]);
      receipt.approvals ||= []; receipt.approvals.push({ method: request.method, decision, requestId: request.requestId, turnId: request.turnId, ...(decline ? { target: denyTarget } : {}) });
    }
    const deliveries = await hcc(['native', 'deliveries', '--peer', peer]);
    const row = (Array.isArray(deliveries) ? deliveries : deliveries.deliveries).find(item => item.message_id === message.message_id);
    if (!row || !['completed', 'failed', 'unknown'].includes(row.state)) return false;
    assert.equal(row.state, 'completed', JSON.stringify(row));
    const replies = read(root, 'SELECT body FROM messages WHERE reply_to=?', message.message_id);
    assert.equal(replies.length, 1); assert.equal(read(root, 'SELECT * FROM message_reads WHERE peer=? AND message_id=?', peer, message.message_id).length, 1);
    return { row, reply: replies[0].body };
  }, label, 180000);
}
try {
  let tarball = opt('--tarball');
  if (!tarball) {
    const packed = await run('npm-pack', 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: repo });
    const meta = JSON.parse(packed.stdout)[0]; tarball = path.join(directory, meta.filename);
    receipt.package = { filename: meta.filename, fileCount: meta.files.length, shasum: meta.shasum };
  }
  tarball = fs.realpathSync(tarball);
  receipt.package = { ...receipt.package, filename: path.basename(tarball), sha256: hash(tarball) };
  const candidate = path.join(output, path.basename(tarball));
  if (candidate !== tarball) fs.copyFileSync(tarball, candidate);
  receipt.artifacts.tarball = candidate;
  receipt.platform = { os: process.platform, architecture: process.arch };
  receipt.officialLauncher = binary;
  receipt.packageInstallPrefix = prefix;
  await run('npm-install', 'npm', ['install', '--prefix', prefix, '--cache', path.resolve(opt('--npm-cache', path.join(directory, 'npm-cache'))), '--no-audit', '--no-fund', tarball], { childEnv: noModelEnv, timeout: 240000 });
  const pkgDir = path.join(prefix, 'node_modules/@logicseek/hello-cc');
  cli = path.join(pkgDir, 'bin/hcc.mjs');
  const requireInstalled = createRequire(path.join(pkgDir, 'package.json'));
  const pty = requireInstalled('node-pty');
  const terminal = pty.spawn('/bin/sh', ['-c', 'printf INSTALLED_PTY_READY'], { cwd: root, env: noModelEnv, name: 'xterm', cols: 80, rows: 24 });
  let ptyText = ''; terminal.onData(text => { ptyText += text; });
  await new Promise(resolve => terminal.onExit(resolve)); assert.match(ptyText, /INSTALLED_PTY_READY/);
  check('fresh npm package installation and installed Node 24 PTY dependency load');
  const sourceFiles = ['bin/hcc.mjs','lib/cli/commands/dsh.mjs','lib/cli/commands/native.mjs','lib/integrations/dsh.mjs','lib/integrations/dsh-cordis.mjs','lib/integrations/dsh-collaboration.mjs','lib/integrations/dsh.bundle.yml','lib/integrations/native/dsh-acp.mjs','lib/integrations/native/jsonrpc.mjs','lib/runtime/native/service.mjs','lib/runtime/native/client.mjs','lib/mcp/tools.mjs'];
  receipt.installedSourceHashes = Object.fromEntries(sourceFiles.map(file => [file, hash(path.join(pkgDir, file))]));
  for (const file of sourceFiles) assert.equal(hash(path.join(repo, file)), receipt.installedSourceHashes[file], 'Installed runtime must match current source: ' + file);
  check('installed Cordis, ACP, MCP and native service match current source hashes');
  await run('installed-cli-help', process.execPath, [cli, 'dsh', '--help'], { childEnv: noModelEnv });
  await hcc(['dsh', 'setup', '--mode', 'cordis']);
  const firstConfig = hash(path.join(root, '.hello-cc/dsh/cordis.patch.yml'));
  await hcc(['dsh', 'setup']); assert.equal(hash(path.join(root, '.hello-cc/dsh/cordis.patch.yml')), firstConfig);
  const dshStatus = await hcc(['dsh', 'status']); assert.equal(dshStatus.mode, 'cordis');
  check('installed CLI setup is idempotent; default PATH resolves the pinned official dsh launcher');

  const profile = 'hcc-cordis-acceptance';
  await run('profile-init', process.execPath, [binary, '--profile', profile, '--from-default-profile', 'acp', '--dump-config'], { childEnv: noModelEnv, omitOutput: true });
  const profileDir = path.join(env.DSH_HOME, 'profiles', profile);
  const overlay = path.join(profileDir, 'cordis.patch.yml');
  if (!fs.existsSync(overlay)) fs.writeFileSync(overlay, '[]\n');
  fs.appendFileSync(overlay, '\n# acceptance-owned override must survive package management\n');
  const overlayHash = hash(overlay);
  const manifest = () => JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json')));
  // Pin the only native build required by this candidate in the private profile.
  fs.appendFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), '\nallowBuilds:\n  node-pty@1.2.0-beta.15: true\n');
  receipt.approvedBuilds = ['node-pty@1.2.0-beta.15'];
  const pnpmStore = path.resolve(opt('--pnpm-store', path.join(directory, 'pnpm-store')));
  for (let i = 0; i < 2; i++) await run('plugin-add-' + i, process.execPath, [binary, 'plugin', '--profile', profile, 'add', tarball, '--store-dir', pnpmStore], { childEnv: noModelEnv, timeout: 900000 });
  assert.equal(manifest().dsh.profile.bundles.filter(name => name === '@logicseek/hello-cc').length, 1);
  assert.equal(hash(overlay), overlayHash);
  const config = await run('installed-profile-config', process.execPath, [binary, '--profile', profile, '--dump-config'], { childEnv: noModelEnv, omitOutput: true });
  assert.match(config.stdout, /dsh-cordis\.mjs/);
  check('official plugin add and repeated add install one Cordis bundle and preserve profile overrides');
  rpc = new JsonRpcProcess({ binary, args: ['--profile', profile], cwd: cordisRoot, env: live ? env : noModelEnv, timeoutMs: 30000 });
  await rpc.start();
  await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'hcc-installed-acceptance', version: '1.0.1' } });
  const session = await rpc.request('session/new', { cwd: cordisRoot, mcpServers: [] });
  const binding = read(cordisRoot, 'SELECT * FROM peer_bindings WHERE provider_session_id=?', session.sessionId)[0];
  assert.equal(binding.transport, 'cordis');
  if (live) {
    await rpc.request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: `Use hcc_state, then hcc_message_send once to acceptance-coordinator with exact body ${marker}. Reply only ${marker}. Do not use other tools or files.` }] }, { timeoutMs: 180000 });
    assert.equal(read(cordisRoot, 'SELECT sender FROM messages WHERE body=?', marker)[0].sender, binding.peer);
    check('officially installed Cordis bundle performs a real model collaboration tool round trip');
  }
  await rpc.request('session/close', { sessionId: session.sessionId });
  await rpc.close(); rpc = null;
  check('officially installed bundle creates and disposes a real Agent without duplicate ownership');
  const beforeRemovalHash = hash(overlay);
  receipt.profileOverlayHashes = { beforeAdd: overlayHash, beforeRemove: beforeRemovalHash };
  await run('plugin-remove', process.execPath, [binary, 'plugin', '--profile', profile, 'remove', '@logicseek/hello-cc', '--store-dir', pnpmStore], { childEnv: noModelEnv, timeout: 900000 });
  assert.ok(!manifest().dsh.profile.bundles.includes('@logicseek/hello-cc'));
  assert.equal(hash(overlay), beforeRemovalHash);
  receipt.profileOverlayHashes.afterRemove = hash(overlay);
  await run('profile-after-remove', process.execPath, [binary, '--profile', profile, '--dump-config'], { childEnv: noModelEnv, omitOutput: true });
  check('official plugin remove removes bundle metadata and preserves other profile configuration');

  const acpProfile = path.join(env.DSH_HOME, 'profiles/acp');
  await run('native-profile-init', process.execPath, [binary, '--profile', 'acp', '--dump-config'], { childEnv: noModelEnv, omitOutput: true });
  const policy = path.join(directory, 'approval-policy.mjs');
  fs.writeFileSync(policy, `export const inject=['tools'];\nexport function apply(ctx){ctx.on('tools/pre-execute',async(exec,next)=>{const args=exec.arguments||{};if((['write','str_replace_editor'].includes(exec.name)&&[args.file_path,args.path].includes(${JSON.stringify(denyTarget)}))||(exec.name==='bash'&&String(args.command||'').includes(${JSON.stringify(denyTarget)})))return {kind:'ask',reason:'acceptance requires explicit approval for this test-owned write'};return next();});}\n`);
  fs.writeFileSync(path.join(acpProfile, 'cordis.patch.yml'), `- insert:\n    - id: installed-approval-policy\n      name: ${JSON.stringify(policy)}\n`);
  // The project overlay is not loaded by native ACP. Only the approval policy
  // enters its private profile; Cordis/hooks never duplicate the native owner.
  const nativeClient = await import(pathToFileURL(path.join(pkgDir, 'lib/runtime/native/client.mjs')));
  const ctx = { root, dbPath: path.join(root, '.hello-cc/mesh.db') };
  api = (method, route, body) => nativeClient.nativeRequest(ctx, method, route, body);
  await hcc(['native', 'up']); nativeUp = true;
  const started = await hcc(['native', 'start', '--peer', peer, '--provider', 'dsh']);
  assert.equal(started.provider, 'dsh'); assert.ok(started.sessionId); assert.ok(started.capabilities.approvals);
  receipt.nativeSessionId = started.sessionId;
  check('installed public native CLI starts the default dsh ACP adapter and scoped MCP without factory injection');
  if (live) {
    const permission = await send(`Use the write tool once with file_path ${denyTarget} and content PROOF. This is a permission refusal test. If refused, do not retry or bypass the refusal; reply only DENIED. Do not read or modify anything else.`);
    await finish(permission, { decline: true, label: 'installed real native approval refusal' });
    assert.ok(receipt.approvals?.some(item => item.decision === 'decline' && item.method === 'session/request_permission'));
    assert.equal(fs.existsSync(denyTarget), false);
    check('installed native CLI receives a real ACP file approval, declines it, and the file remains absent');
    fs.writeFileSync(path.join(root, 'orders.json'), JSON.stringify([{ sku:'A',quantity:3,unit_price:12.5 },{ sku:'B',quantity:2,unit_price:8 },{ sku:'A',quantity:1,unit_price:12.5 }]));
    const task = await hcc(['task','create','--from','acceptance-coordinator','--title','Summarize isolated order fixture']);
    const reportFile = path.join(root, 'order-summary.json');
    const work = await send(`This is an isolated order-report task #${task.id}. Use the hello_cc_scoped MCP hcc_task_next to claim it and hcc_lock_acquire for order-summary.json with task_id ${task.id}. Read only orders.json. Compute total quantity and revenue from the input records, aggregate quantity and revenue per SKU, and write ${reportFile} as a JSON object with keys total_quantity,total_revenue,by_sku (by_sku maps SKU to {quantity,revenue}). Use native read/write tools. Send the exact body ${marker} to acceptance-coordinator using MCP hcc_message_send with task_id ${task.id}. Record a local hcc_result_record with task_id ${task.id}, title "Order fixture report", status passed, evidence ["${reportFile}"]; record hcc_handoff to acceptance-coordinator with the same evidence in changed_files. Release your order-summary.json lock. Do not use any other files, external requests or delegation. Reply only ${marker}.`, task.id);
    const finished = await finish(work, { label:'installed native scoped MCP task and file workflow' });
    assert.match(finished.reply, new RegExp(marker));
    const actual = JSON.parse(fs.readFileSync(reportFile));
    assert.deepEqual(actual, {total_quantity:6,total_revenue:66,by_sku:{A:{quantity:4,revenue:50},B:{quantity:2,revenue:16}}});
    const taskRow = read(root, 'SELECT * FROM tasks WHERE id=?', task.id)[0]; assert.equal(taskRow.owner, peer);
    assert.equal(read(root,'SELECT * FROM messages WHERE sender=? AND recipient=? AND body=? AND reply_to IS NULL',peer,'acceptance-coordinator',marker).length,1);
    assert.ok(read(root,'SELECT * FROM handoffs WHERE task_id=? AND from_peer=?',task.id,peer).length);
    assert.ok(read(root,"SELECT * FROM events WHERE type='task.result.recorded' AND task_id=? AND actor=?",task.id,peer).length);
    assert.equal(read(root,'SELECT * FROM locks WHERE owner=? AND task_id=?',peer,task.id).length,0);
    const completion = await send(`The coordinator independently verified order-summary.json: quantity 6, revenue 66 and correct per-SKU totals. Finish your owned task #${task.id} using your session-specific hcc CLI command: task done --peer ${peer} --id ${task.id} --summary ${marker}. Use only that hcc task command; no other tools or file changes. Reply only ${marker}.`);
    await finish(completion, { label:'installed task completion after independent artifact verification' });
    assert.equal(read(root,'SELECT status FROM tasks WHERE id=?',task.id)[0].status,'done');
    const reportCopy = path.join(output, 'order-summary.json');
    if (reportCopy !== reportFile) fs.copyFileSync(reportFile, reportCopy);
    receipt.artifacts.orderReport = reportCopy; receipt.taskId=task.id;
    receipt.workflow = { expected: actual, owner: peer, status: 'done', proactiveMessageCount: 1, resultRecorded: true, handoffRecorded: true, locksReleased: true, scope: 'isolated representative fixture; not business signoff' };
    check('real installed worker claims a task, writes correct report, records evidence and handoff, releases lock and completes task');
  } else receipt.limitations.push('Real model approval and task workflow require --run-live and were not executed.');
  await hcc(['native','close','--peer',peer]);
  assert.equal(read(root,'SELECT status FROM peers WHERE id=?',peer)[0].status,'exited');
  check('installed public close retires only its own native worker');
  receipt.passed = true;
} catch (error) { receipt.passed = false; receipt.failure={code:error.code||'ACCEPTANCE_FAILED',message:redactSecrets(error.message),stack:redactSecrets(error.stack)}; process.exitCode=1; }
finally {
  try { await rpc?.close(); receipt.cleanup.cordisRuntimeStopped=true; } catch { receipt.cleanup.cordisRuntimeStopped=false; }
  if (nativeUp) {
    await hcc(['native','close','--peer',peer]).catch(()=>{});
    try { await hcc(['native','down']); receipt.cleanup.nativeRuntimeStopped=!fs.existsSync(path.join(root,'.hello-cc/native/runtime.json')); }
    catch { receipt.cleanup.nativeRuntimeStopped=false; }
  }
  fs.rmSync(env.DSH_HOME,{recursive:true,force:true}); receipt.cleanup.privateProviderStateRemoved=true;
  if (receipt.installedSourceHashes) receipt.currentRuntimeSourcesStillMatch=Object.entries(receipt.installedSourceHashes).every(([file,sha])=>hash(path.join(repo,file))===sha);
  if (output !== directory) {
    const evidence = path.join(output, 'evidence', path.basename(directory)); fs.mkdirSync(evidence, { recursive: true });
    for (const file of fs.readdirSync(directory).filter(file => file.endsWith('.log'))) fs.copyFileSync(path.join(directory, file), path.join(evidence, file));
    receipt.artifacts.commandLogs = evidence;
  }
  receipt.completedAt=new Date().toISOString(); flush();
  console.log(JSON.stringify({receipt:receiptPath,passed:receipt.passed,checks:receipt.checks.length,cleanup:receipt.cleanup}));
}
