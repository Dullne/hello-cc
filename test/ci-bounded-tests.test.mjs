import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../.github/scripts/run-bounded-tests.mjs', import.meta.url));

test('CI runner preserves bounded parallelism for the shared service suites', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-ci-parallel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = ['one', 'two', 'three'].map(name => {
    const file = path.join(root, name + '.test.mjs');
    fs.writeFileSync(file, "import test from 'node:test';test('slow success',async()=>{await new Promise(r=>setTimeout(r,250))});");
    return file;
  });
  const logs = path.join(root, 'logs');
  const result = spawnSync(process.execPath, [runner, '--log-dir', logs, '--concurrency', '2', '--file-timeout-ms', '3000', ...files],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(fs.readFileSync(path.join(logs, 'summary.json')));
  assert.equal(report.complete, true);
  assert.ok(Date.parse(report.files[1].startedAt) < Date.parse(report.files[0].finishedAt));
  assert.ok(Date.parse(report.files[2].startedAt) >= Math.min(...report.files.slice(0, 2).map(file => Date.parse(file.finishedAt))));
});

function run(t, source, timeout = 3000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-ci-bound-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'fixture.test.mjs'), logs = path.join(root, 'logs');
  fs.writeFileSync(file, source);
  const result = spawnSync(process.execPath, [runner, '--log-dir', logs, '--file-timeout-ms', String(timeout), file],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(result.error, undefined, result.error?.message);
  const report = JSON.parse(fs.readFileSync(path.join(logs, 'summary.json'), 'utf8'));
  const log = fs.readFileSync(path.join(logs, report.files[0].log), 'utf8');
  return { result, report, log };
}

test('CI runner records start, completion, and successful process exit', t => {
  const { result, report, log } = run(t, "import test from 'node:test'; test('healthy fixture', () => {});");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(report.files[0].timedOut, false);
  assert.match(log, /START.*healthy fixture/);
  assert.match(log, /healthy fixture/);
  assert.match(result.stdout, /FILE END.*exit=0/);
});

test('CI runner preserves assertion failures', t => {
  const { result, report, log } = run(t, "import test from 'node:test'; test('broken fixture', () => { throw new Error('intentional failure'); });");
  assert.equal(result.status, 1);
  assert.equal(report.files[0].exitCode, 1);
  assert.equal(report.files[0].timedOut, false);
  assert.match(log, /intentional failure/);
});

test('CI runner fails a passed test file that leaks a live handle', t => {
  const { result, report, log } = run(t, "import test from 'node:test'; test('leaking fixture', () => { setInterval(()=>{},1000); });", 1000);
  assert.equal(result.status, 1);
  assert.equal(report.files[0].timedOut, true);
  assert.match(log, /START.*leaking fixture/);
  assert.match(log, /FILE TIMEOUT/);
});

test('CI runner deadline also stops a test that blocks its event loop', t => {
  const { result, report, log } = run(t, "import test from 'node:test'; test('blocked fixture', () => { while(true) {} });", 1000);
  assert.equal(result.status, 1);
  assert.equal(report.files[0].timedOut, true);
  assert.match(log, /FILE TIMEOUT/);
});

test('Windows CI runner rejects and kills a detached descendant even after its test runner exits',
  { skip: process.platform !== 'win32' }, async t => {
    const { result, report, log } = run(t, `import test from 'node:test'; import {spawn} from 'node:child_process';
      test('orphan fixture',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
      {detached:true,stdio:'ignore',windowsHide:true});console.log('ORPHAN_PID='+child.pid);child.unref();});`, 1000);
    assert.equal(result.status, 1);
    assert.equal(report.files[0].timedOut, true);
    const pid = Number(log.match(/ORPHAN_PID=(\d+)/)?.[1]);
    assert.ok(pid > 0);
    const { loadWindowsNative } = await import('../lib/platform/windows-native.mjs');
    assert.equal(loadWindowsNative().inspectProcess(pid).state, 'dead');
  });
