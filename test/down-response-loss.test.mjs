import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createMiscCommands } from '../lib/cli/commands/misc.mjs';
import { waitForLiveProcessIdentity, waitForProcessIdentityExit } from '../lib/process/identity.mjs';
import { runtimeRequest } from '../lib/runtime/client.mjs';
import { reclaimRuntimePointerFiles } from '../lib/runtime/state.mjs';
import { CliError } from '../lib/shared/errors.mjs';

const original = { pid: 42, startToken: 'boot:100', commandHash: 'a'.repeat(64) };

function fixture(t, { observed = { state: 'dead', identity: null }, replacement = null,
  source = null, identity = original, present = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-down-response-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pointer = path.join(directory, 'runtime.json');
  const runtime = { pid: original.pid, process_identity: identity,
    source: source || pointer, base_url: 'http://127.0.0.1:1' };
  const saved = replacement || (present ? { pid: original.pid, process_identity: original } : null);
  if (saved) fs.writeFileSync(pointer, JSON.stringify(saved));
  const failure = new CliError('RUNTIME_UNREACHABLE', 'Stop response was interrupted');
  let requests = 0, waits = 0, reclaims = 0;
  const output = [];
  const commands = createMiscCommands({ path, process: { env: {} }, CliError,
    printResult: (_ctx, value) => output.push(value),
    readRuntime: () => runtime, runtimePath: () => pointer,
    globalRuntimePath: () => path.join(directory, 'global.json'),
    runtimeRequest: async () => { requests++; throw failure; },
    reclaimRuntimePointerFiles: (files, options) => {
      reclaims++;
      return reclaimRuntimePointerFiles(files, { ...options, inspect: () => observed });
    },
    waitForProcessIdentityExit: async (value, options) => {
      waits++;
      assert.deepEqual(value, original);
      assert.deepEqual(options, { timeoutMs: 5000, intervalMs: 25 });
      return waitForProcessIdentityExit(value, { timeoutMs: 0, inspect: () => observed });
    },
    PRODUCT_NAME: 'hello-cc'
  });
  return { ...commands, pointer, saved, output, failure,
    counts: () => ({ requests, waits, reclaims }) };
}

test('down confirms the original owner exit after a lost response and self-removed pointer', async t => {
  const f = fixture(t);
  await f.cmdDown({}, []);
  assert.equal(f.output.length, 1);
  assert.deepEqual(f.counts(), { requests: 1, waits: 1, reclaims: 1 });
  assert.equal(fs.existsSync(f.pointer), false);
});

for (const state of ['live', 'unknown']) {
  test(`missing pointer does not make a lost stop response successful while owner is ${state}`, async t => {
    const f = fixture(t, { observed: { state, identity: state === 'live' ? original : null } });
    await assert.rejects(f.cmdDown({}, []), error => error === f.failure);
    assert.deepEqual(f.counts(), { requests: 1, waits: 1, reclaims: 0 });
    assert.equal(f.output.length, 0);
  });
}

test('down reclaims only the original dead owner pointer after a lost response', async t => {
  const f = fixture(t, { present: true });
  await f.cmdDown({}, []);
  assert.equal(fs.existsSync(f.pointer), false);
  assert.equal(f.output.length, 1);
});

for (const state of ['live', 'dead']) {
  test(`down preserves a replacement pointer whose owner is ${state}`, async t => {
    const replacementIdentity = { ...original, startToken: 'boot:200' };
    const f = fixture(t, { replacement: { pid: original.pid, process_identity: replacementIdentity },
      observed: { state, identity: state === 'live' ? replacementIdentity : null } });
    await f.cmdDown({}, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.pointer, 'utf8')), f.saved);
    assert.equal(f.output.length, 1);
    assert.equal(f.counts().requests, 1, 'never send another stop to the replacement');
  });
}

for (const options of [{ source: 'env' }, { source: '/unowned/runtime.json' }, { identity: null }]) {
  test(`lost response cannot recover without a captured local owner: ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options);
    await assert.rejects(f.cmdDown({}, []), error => error === f.failure);
    assert.deepEqual(f.counts(), { requests: 1, waits: 0, reclaims: 0 });
    assert.equal(f.output.length, 0);
  });
}

test('real HTTP stop can remove its pointer, lose the response and exit without making down fail',
  { timeout: 15000 }, async t => {
    if (!['darwin', 'linux'].includes(process.platform)) { t.skip('requires native process identity'); return; }
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-down-http-')));
    fs.mkdirSync(path.join(directory, '.hello-cc'), { mode: 0o700 });
    const pointer = path.join(directory, '.hello-cc', 'runtime.json');
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      import http from 'node:http';
      process.once('message', ({ pointer }) => {
        const server = http.createServer((request, response) => {
          if (request.method !== 'POST' || request.url !== '/api/runtime/stop') process.exit(2);
          fs.unlinkSync(pointer);
          response.destroy();
          setTimeout(() => process.exit(0), 25);
        });
        server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
      });
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const exited = once(child, 'exit');
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    const ready = once(child, 'message');
    child.send({ pointer });
    const [{ port }] = await ready;
    const observed = await waitForLiveProcessIdentity(child.pid, { timeoutMs: 1000 });
    assert.equal(observed.state, 'live');
    const runtime = { pid: child.pid, process_identity: observed.identity,
      source: pointer, base_url: 'http://127.0.0.1:' + port };
    fs.writeFileSync(pointer, JSON.stringify(runtime));
    const output = [];
    let transportFailure;
    const commands = createMiscCommands({ path, process: { env: {} }, CliError,
      readRuntime: () => runtime, runtimePath: () => pointer,
      globalRuntimePath: () => path.join(directory, 'global.json'),
      reclaimRuntimePointerFiles, waitForProcessIdentityExit,
      printResult: (_ctx, value) => output.push(value), PRODUCT_NAME: 'hello-cc',
      runtimeRequest: async (...args) => {
        try { return await runtimeRequest(...args); }
        catch (error) { transportFailure = error.code; throw error; }
      }
    });
    let downError;
    try { await commands.cmdDown({ root: directory, dbPath: path.join(directory, 'mesh.db') }, []); }
    catch (error) { downError = error; }
    assert.equal(transportFailure, 'RUNTIME_UNREACHABLE');
    assert.deepEqual(await exited, [0, null]);
    assert.equal(fs.existsSync(pointer), false);
    t.diagnostic('Stop reached the real HTTP server; its pointer disappeared and its process exited 0 without a signal');
    if (downError) throw downError;
    assert.equal(output.length, 1);
  });
