// Install and exercise the actual Windows package without real provider accounts.
// Production imports below are resolved only from the disposable installed copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('Usage: node scripts/windows-installed-acceptance.mjs [--output FILE] [--package-output FILE.tgz] [--package-input FILE.tgz]');
  console.log('Packs and installs into a disposable Windows profile; checks public CLI, background Web/native services and persistent ConPTY. Node 24+ and built Windows artifacts required.');
  process.exit(0);
}
const options = new Map();
for (let i = 0; i < args.length; i += 2) {
  if (!['--output', '--package-output', '--package-input', '--installed-root', '--fixture-root'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid acceptance option');
  options.set(args[i], args[i + 1]);
}
assert.equal(process.platform, 'win32', 'Windows installed acceptance requires native Windows');
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Windows installed acceptance requires Node 24+');

async function run(file, argv, { cwd, env = process.env, timeoutMs = 120000, stage }) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); reject(new Error(`${stage}: command deadline exceeded`)); }, timeoutMs);
    const append = key => bytes => {
      if (key === 'out') stdout += bytes; else stderr += bytes;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 4 * 1024 * 1024) {
        failed = true; child.kill(); reject(new Error(`${stage}: excessive command output`));
      }
    };
    child.stdout.on('data', append('out')); child.stderr.on('data', append('err'));
    child.once('error', error => { failed = true; clearTimeout(timer); reject(new Error(`${stage}: ${error.code || 'spawn failed'}`)); });
    child.once('close', code => {
      clearTimeout(timer); if (failed) return;
      if (code !== 0) {
        let diagnostic, acceptanceMessage;
        try {
          const parsed = JSON.parse(stderr.trim() || stdout.trim());
          diagnostic = parsed.error?.code || parsed.code;
          if (parsed.success === false && typeof parsed.message === 'string') acceptanceMessage = parsed.message.slice(0, 500);
        } catch {}
        reject(Object.assign(new Error(`${stage}: command exited ${code}${diagnostic ? ` (${diagnostic})` : ''}${acceptanceMessage ? `: ${acceptanceMessage}` : ''}`), { stage, exitCode: code }));
      } else resolve(stdout);
    });
  });
}

async function installedChecks(installed, root) {
  const fromInstalled = name => import(pathToFileURL(path.join(installed, name)).href);
  const [{ projectDbPath }, { readRuntimeFile }, { ensureTerminalHost }, { inspectProcessIdentity, compareProcessIdentity },
    { readNativePointer }, { nativeRequest }] = await Promise.all([
    fromInstalled('lib/runtime/paths.mjs'), fromInstalled('lib/runtime/state.mjs'), fromInstalled('lib/terminal/client.mjs'),
    fromInstalled('lib/process/identity.mjs'), fromInstalled('lib/runtime/native/store.mjs'), fromInstalled('lib/runtime/native/client.mjs')
  ]);
  const entry = path.join(installed, 'bin', 'hcc.mjs'), WebSocket = createRequire(entry)('ws');
  const cli = (argv, stage) => run(process.execPath, [entry, '--root', root, '--json', ...argv], { cwd: root, stage, timeoutMs: 45000 });
  const jsonCli = async (argv, stage) => JSON.parse(await cli(argv, stage)).data;
  const checks = [], identities = [], ctx = { root, dbPath: projectDbPath(root) };
  let runtime, host, socket, native;
  async function dead(identity) {
    for (let i = 0; i < 400; i++) {
      const observed = inspectProcessIdentity(identity.pid);
      if (observed.state === 'dead' || (observed.state === 'live' && compareProcessIdentity(identity, observed.identity) === 'dead')) return;
      await delay(25);
    }
    throw new Error('Owned fixture process exit could not be confirmed');
  }
  async function request(method, route, value) {
    const response = await fetch(runtime.base_url + route, { method, signal: AbortSignal.timeout(15000),
      headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json', 'x-hcc-api-version': '2' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    const result = await response.json();
    assert.equal(response.status, 200, `HTTP ${route}: ${result.error?.code || response.status}`);
    return result;
  }
  async function startWeb() {
    await cli(['web', '--local', '--port', '0', '--no-discover'], 'public background Web start');
    runtime = readRuntimeFile(ctx);
    assert.ok(runtime?.pid && runtime?.token && runtime?.base_url, 'Background Web must publish its authenticated receipt');
    const observed = inspectProcessIdentity(runtime.pid); assert.equal(observed.state, 'live');
    identities.push(observed.identity);
    assert.equal((await request('GET', '/api/state')).terminal_backend, 'windows-terminal');
  }
  async function stopWeb() {
    if (!runtime) return;
    const observed = inspectProcessIdentity(runtime.pid);
    await cli(['down'], 'public Web stop');
    if (observed.state === 'live') await dead(observed.identity);
    runtime = null;
  }
  async function attach(id) {
    socket = new WebSocket(runtime.base_url.replace('http:', 'ws:') + '/ws/terminal/' + encodeURIComponent(id) + '?api_version=2', {
      headers: { authorization: `Bearer ${runtime.token}`, origin: runtime.base_url }, handshakeTimeout: 10000
    });
    const frames = []; let error;
    socket.on('message', bytes => frames.push(JSON.parse(bytes.toString())));
    socket.on('error', value => { error = value.code || 'socket failed'; });
    for (let i = 0; i < 400; i++) {
      if (error) throw new Error(`Browser terminal attachment: ${error}`);
      const snapshot = frames.find(frame => frame.type === 'snapshot');
      if (snapshot) return { frames, snapshot };
      await delay(25);
    }
    throw new Error('Browser terminal snapshot deadline exceeded');
  }
  async function until(predicate, message) {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await delay(25); }
    throw new Error(message);
  }
  let failure;
  try {
    const environment = await jsonCli(['doctor', '--environment'], 'installed environment doctor');
    assert.equal(environment.ready, true); checks.push('installed environment doctor');
    await cli(['init'], 'installed project initialization');
    assert.ok(fs.existsSync(path.join(root, 'AGENTS.md'))); assert.ok(fs.existsSync(path.join(root, 'CLAUDE.md')));
    await cli(['doctor'], 'installed database doctor'); checks.push('public init and database doctor');
    const task = await jsonCli(['task', 'create', '--title', 'Windows 中文 task %!&'], 'public task creation');
    assert.ok(Number.isSafeInteger(task.id));
    const claimed = await jsonCli(['task', 'claim', '--peer', 'acceptance-worker', '--id', String(task.id)], 'public task claim');
    assert.equal(claimed.owner, 'acceptance-worker');
    const locked = await jsonCli(['lock', 'acquire', '--peer', 'acceptance-worker', '--task', String(task.id),
      '--resource', 'src/中文 file', '--ttl', '60'], 'public resource lock');
    assert.equal(locked.owner, 'acceptance-worker');
    const message = await jsonCli(['msg', 'send', '--from', 'acceptance-worker', '--to', 'acceptance-reviewer',
      '--body', 'literal 中文 %!&', '--task', String(task.id)], 'public local coordination message');
    const inbox = await jsonCli(['msg', 'inbox', '--peer', 'acceptance-reviewer'], 'public local inbox');
    assert.ok(inbox.some(row => row.id === message.id && row.body === 'literal 中文 %!&'));
    const released = await jsonCli(['lock', 'release', '--peer', 'acceptance-worker', '--resource', 'src/中文 file'], 'public resource unlock');
    assert.equal(released.released, true);
    checks.push('public task creation/claim, local message/inbox and resource lock/release');
    await startWeb(); checks.push('public background Web handoff');
    host = await ensureTerminalHost(); identities.push(host.pointer.identity);
    const program = path.join(root, '模拟 provider.cjs');
    fs.writeFileSync(program, 'process.stdin.setRawMode(true);process.stdout.write("INSTALLED中文\\r\\n");process.stdin.on("data",d=>process.stdout.write("INPUT:"+d));setInterval(()=>{},1000)');
    const created = (await request('POST', '/api/sessions', { id: 'installed-shell', kind: 'shell',
      invocation: { file: process.execPath, args: [program] } })).session;
    assert.equal(created.type, 'windows-terminal');
    const processIdentity = inspectProcessIdentity(created.pid); assert.equal(processIdentity.state, 'live');
    identities.push(processIdentity.identity);
    let browser = await attach(created.id);
    assert.equal(browser.snapshot.control.can_control, true);
    socket.send(JSON.stringify({ type: 'input', action_token: browser.snapshot.action_token,
      epoch: browser.snapshot.control.epoch, data: 'literal 中文 %!&', input_id: 'before-restart' }));
    await until(() => browser.frames.some(frame => frame.type === 'input_ack'), 'Input acknowledgement deadline');
    await stopWeb(); socket.terminate(); socket = null;
    assert.equal(inspectProcessIdentity(created.pid).state, 'live');
    await startWeb();
    const restored = (await request('GET', '/api/sessions')).sessions.find(session => session.id === created.id);
    assert.equal(restored?.pid, created.pid); assert.equal(restored.terminal_generation, created.terminal_generation);
    browser = await attach(created.id);
    assert.match(browser.snapshot.data, /INSTALLED中文/); assert.match(browser.snapshot.data, /INPUT:literal 中文 %!&/);
    checks.push('Web stop/restart preserves terminal PID, generation and screen');
    if (!browser.snapshot.control.can_control) {
      socket.send(JSON.stringify({ type: 'control', action: 'claim', force: true, epoch: browser.snapshot.control.epoch,
        action_token: browser.snapshot.action_token }));
      await until(() => browser.frames.some(frame => frame.type === 'control' && frame.control.can_control), 'Control takeover deadline');
    }
    const control = browser.frames.filter(frame => frame.control).at(-1).control;
    await request('POST', `/api/sessions/${encodeURIComponent(created.id)}/stop`, {
      action_token: browser.snapshot.action_token, epoch: control.epoch });
    await dead(processIdentity.identity); checks.push('controlled input and confirmed terminal Job termination');
    socket.terminate(); socket = null; await stopWeb();
    native = await jsonCli(['native', 'up'], 'public native service start');
    assert.ok(native.pid && native.generation);
    const observed = inspectProcessIdentity(native.pid); assert.equal(observed.state, 'live'); identities.push(observed.identity);
    assert.equal((await jsonCli(['native', 'status'], 'public native status')).generation, native.generation);
    await cli(['native', 'down'], 'public native service stop'); await dead(observed.identity); native = null;
    checks.push('public native up/status/down');
  } catch (error) { failure = error; }
  finally {
    socket?.terminate();
    const cleanup = async operation => { try { await operation(); } catch (error) { failure ||= error; } };
    await cleanup(async () => {
      // Read only this isolated profile's authenticated pointers. Never use
      // process enumeration or a PID alone as cleanup authority.
      runtime ||= readRuntimeFile(ctx);
      if (runtime) {
        const observed = inspectProcessIdentity(runtime.pid);
        try { await stopWeb(); }
        catch {
          await request('POST', '/api/runtime/stop', {});
          if (observed.state === 'live') await dead(observed.identity);
          runtime = null;
        }
      }
    });
    await cleanup(async () => {
      const pointer = readNativePointer(ctx);
      if (pointer) { await nativeRequest(ctx, 'POST', '/down', {}, { timeoutMs: 5000 });
        const identity = pointer.ownerIdentity || pointer.processIdentity;
        if (identity) await dead(identity); }
    });
    await cleanup(async () => {
      if (host) {
        for (const session of await host.list()) {
          if (session.status === 'exited') continue;
          const connection = await host.connect(session.id, session.generation);
          try {
            if (!connection.control.can_control) await connection.action({ type: 'claim', epoch: connection.control.epoch, takeover: true });
            await connection.action({ type: 'terminate', epoch: connection.control.epoch });
          } finally { connection.close(); }
        }
        await host.shutdown(); await dead(host.pointer.identity);
      }
    });
    await cleanup(async () => { for (const identity of identities) await dead(identity); });
  }
  if (failure) throw failure;
  return { checks, cleanup: 'all authenticated fixture services and owned provider processes confirmed exited' };
}

if (options.has('--installed-root')) {
  try {
    const result = await installedChecks(path.resolve(options.get('--installed-root')), path.resolve(options.get('--fixture-root')));
    console.log(JSON.stringify({ success: true, ...result }));
  } catch (error) {
    // CLI stdout and service pointers may contain credentials. Emit only the
    // bounded acceptance stage and typed error, never captured raw output.
    console.error(JSON.stringify({ success: false, code: error.code || 'ACCEPTANCE_FAILED', message: error.message }));
    process.exitCode = 1;
  }
} else {
  const repo = fileURLToPath(new URL('..', import.meta.url));
  const base = fs.mkdtempSync(path.join(os.homedir(), 'hcc-installed-windows-'));
  const prefix = path.join(base, '安装 prefix 空间'), profile = path.join(base, '独立 profile'), root = path.join(base, '项目 空间');
  for (const directory of [prefix, profile, root]) fs.mkdirSync(directory);
  const npmEntry = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.ok(fs.existsSync(npmEntry), 'Use a Node 24 installation containing its npm CLI');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const env = { SystemRoot: systemRoot, WINDIR: systemRoot, COMSPEC: path.join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD', PATH: [path.dirname(process.execPath), path.join(systemRoot, 'System32'),
      path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';'),
    TEMP: base, TMP: base, HOME: profile, USERPROFILE: profile, NODE_NO_WARNINGS: '1',
    HCC_SKIP_SHIM_INSTALL: '1', HCC_WEB_TOKEN: randomBytes(32).toString('hex'),
    NPM_CONFIG_CACHE: path.join(base, 'npm-cache'), NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    NPM_CONFIG_USERCONFIG: path.join(profile, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(profile, 'global-npmrc') };
  fs.writeFileSync(env.NPM_CONFIG_USERCONFIG, ''); fs.writeFileSync(env.NPM_CONFIG_GLOBALCONFIG, '');
  fs.writeFileSync(path.join(prefix, 'package.json'), JSON.stringify({ name: 'hcc-windows-acceptance', version: '0.0.0', private: true }));
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    success: false, scope: 'Installed local npm candidate on Windows; simulated provider; no real login, model call or global installation' };
  let failure;
  try {
    const metadata = options.has('--package-input') ? JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
      : JSON.parse(await run(process.execPath, [npmEntry, 'pack', '--ignore-scripts', '--json', '--pack-destination', base],
        { cwd: repo, env, stage: 'npm pack' }))[0];
    const archive = options.has('--package-input') ? path.resolve(options.get('--package-input')) : path.join(base, metadata.filename);
    report.package = { name: metadata.name, version: metadata.version,
      ...(!options.has('--package-input') ? { files: metadata.files.length } : { assembly: 'provided archive' }),
      sha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex') };
    await run(process.execPath, [npmEntry, 'install', '--prefix', prefix, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund',
      '--package-lock=false', '--fetch-retries=1', '--fetch-timeout=60000', archive], { cwd: prefix, env, stage: 'isolated npm install', timeoutMs: 180000 });
    const installed = path.join(prefix, 'node_modules', '@logicseek', 'hello-cc');
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version, metadata.version);
    const result = JSON.parse(await run(process.execPath, [path.join(installed, 'scripts', 'windows-installed-acceptance.mjs'),
      '--installed-root', installed, '--fixture-root', root], { cwd: root, env, stage: 'installed lifecycle', timeoutMs: 180000 }));
    assert.equal(result.success, true); Object.assign(report, result);
    if (options.has('--package-output')) {
      const artifact = path.resolve(options.get('--package-output'));
      fs.mkdirSync(path.dirname(artifact), { recursive: true });
      fs.copyFileSync(archive, artifact);
    }
  } catch (error) { failure = error; report.error = { code: error.code || 'ACCEPTANCE_FAILED', message: error.message }; }
  finally {
    try {
      assert.equal(path.dirname(base), os.homedir()); assert.ok(path.basename(base).startsWith('hcc-installed-windows-'));
      // Failed acceptance can leave authenticated services requiring diagnosis.
      // Keep its installed code and private pointers intact for cleanup.
      if (failure) { report.fixture = base; report.cleanup = 'failed acceptance fixture retained for diagnosis'; }
      else await fs.promises.rm(base, { recursive: true, force: true, maxRetries: 40, retryDelay: 50 });
    } catch { report.success = false; report.cleanup = 'unconfirmed; fixture retained'; report.fixture = base; failure ||= new Error('Fixture cleanup failed'); }
    report.finishedAt = new Date().toISOString();
    const output = path.resolve(options.get('--output') || path.join(repo, '.superpowers', 'windows-installed-acceptance.json'));
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
  }
  if (failure) process.exitCode = 1;
}
