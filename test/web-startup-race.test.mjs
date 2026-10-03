import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compareProcessIdentity, inspectProcessIdentity, waitForProcessIdentityExit } from '../lib/process/identity.mjs';
import { API_VERSION } from '../lib/web/api-version.mjs';
import { createWebStartup } from '../lib/web/startup.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = path.join(repoRoot, 'bin', 'hcc.mjs');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runCli(args, options) {
  const child = spawn(process.execPath, [cliPath, ...args], options);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return {
    child,
    done: new Promise((resolve) => child.once('close', (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    }))
  };
}

test('concurrent web starts converge on one healthy background runtime', {
  timeout: 90_000,
  skip: process.platform === 'win32'
}, async (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-start-race-'));
  const home = path.join(sandbox, 'home');
  const root = path.join(sandbox, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(root);
  const port = await freePort();
  const env = {
    ...process.env,
    HOME: home,
    HCC_SKIP_SHIM_INSTALL: '1',
    HCC_NO_AUTO_INSTALL_TMUX: '1'
  };
  const options = { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] };
  const args = ['--root', root, '--json', 'web', '--local', '--no-token', '--port', String(port), '--no-guidance', '--no-discover'];
  const first = runCli(args, options);
  const second = runCli(args, options);
  t.after(async () => {
    for (const processHandle of [first.child, second.child]) {
      if (processHandle.exitCode === null && processHandle.signalCode === null) processHandle.kill('SIGTERM');
    }
    const output = spawnSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).stdout || '';
    const ownedPids = output.split('\n').flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      return match?.[2].includes(cliPath) && match[2].includes(`--root ${root} `)
        ? [Number(match[1])]
        : [];
    });
    for (const pid of ownedPids) {
      const observed = inspectProcessIdentity(pid);
      if (observed.state !== 'live') continue;
      try { process.kill(pid, 'SIGTERM'); } catch {}
      const exited = await waitForProcessIdentityExit(observed.identity, { timeoutMs: 2_000 });
      if (exited.state === 'dead') continue;
      const current = inspectProcessIdentity(pid);
      if (current.state === 'live' &&
          compareProcessIdentity(observed.identity, current.identity) === 'live') {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  const results = await Promise.all([first.done, second.done]);
  for (const result of results) {
    assert.equal(result.code, 0, `web start failed: ${JSON.stringify(result)}`);
    assert.equal(result.signal, null);
  }
  const messages = results.map((result) => JSON.parse(result.stdout).data);
  assert.deepEqual(messages.map((message) => message.status).sort(), ['already_running', 'started']);
  assert.equal(messages[0].pid, messages[1].pid);
  const response = await fetch(`http://127.0.0.1:${port}/api/runtime`, {
    headers: { 'X-HCC-API-Version': String(API_VERSION) },
    signal: AbortSignal.timeout(3000)
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pid, messages[0].pid);

  const replacementPort = await freePort();
  const replacementArgs = args.map((arg, index) => args[index - 1] === '--port' ? String(replacementPort) : arg);
  const replacement = await runCli(replacementArgs, options).done;
  assert.equal(replacement.code, 0, `web restart failed: ${JSON.stringify(replacement)}`);
  const restarted = JSON.parse(replacement.stdout).data;
  assert.equal(restarted.status, 'started');
  assert.notEqual(restarted.pid, messages[0].pid);
  const replacementResponse = await fetch(`http://127.0.0.1:${replacementPort}/api/runtime`, {
    headers: { 'X-HCC-API-Version': String(API_VERSION) },
    signal: AbortSignal.timeout(3000)
  });
  assert.equal(replacementResponse.status, 200);
  assert.equal((await replacementResponse.json()).pid, restarted.pid);
});

test('orphan reaper stops only a matching adopted web process', {
  timeout: 10_000,
  skip: process.platform === 'win32'
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-web-orphan-'));
  const dbPath = path.join(root, '.hello-cc', 'mesh.db');
  const childArgs = ['-e', 'setInterval(() => {}, 1000)', cliPath,
    '--root', root, '--db', dbPath, 'web'];
  const wrapper = spawnSync(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, JSON.parse(process.env.HCC_TEST_CHILD_ARGS), {
      detached: true, stdio: 'ignore'
    });
    child.unref();
    console.log(child.pid);
  `], {
    encoding: 'utf8',
    env: { ...process.env, HCC_TEST_CHILD_ARGS: JSON.stringify(childArgs) }
  });
  assert.equal(wrapper.status, 0, wrapper.stderr);
  const pid = Number(wrapper.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  t.after(() => {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  const observed = inspectProcessIdentity(pid);
  assert.equal(observed.state, 'live');

  const startup = createWebStartup({
    splitProcessArgs: (line) => line.split(/\s+/),
    sameResolvedPath: (left, right) => path.resolve(left) === path.resolve(right)
  });
  await startup.stopOrphanWebRuntimes({ root, dbPath });
  const exited = await waitForProcessIdentityExit(observed.identity, { timeoutMs: 2_000 });
  assert.equal(exited.state, 'dead');
});
