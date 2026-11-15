import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const driver = new URL('../scripts/test-platform.mjs', import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');

test('npm unit and regression entry points select the platform before starting fixtures', () => {
  const { scripts } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(scripts['test:unit'], 'node ./scripts/test-platform.mjs unit');
  assert.equal(scripts['test:regression'], 'node ./scripts/test-platform.mjs regression');
  assert.equal(scripts.pretest, 'npm run test:audit && npm run test:unit');
  assert.equal(scripts.test, 'npm run test:regression');
});

test('Linux and macOS retain the complete unit glob and original regression arguments', async () => {
  const { testPlan } = await import(driver);
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(testPlan(platform, 'unit').map(stage => stage.args), [['--test', 'test/*.test.mjs']]);
    assert.deepEqual(testPlan(platform, 'regression').map(stage => stage.args), [['./scripts/regression.mjs']]);
  }
});

test('Windows uses the same bounded core, UI/source and eight shared files as CI', async () => {
  const { testPlan } = await import(driver);
  const logs = path.join(os.tmpdir(), 'hcc-test-plan');
  const stages = testPlan('win32', 'unit', { logDirectory: logs });
  assert.deepEqual(stages.map(stage => stage.name), ['core', 'ui', 'audit', 'shared']);
  assert.ok(stages[0].args.includes('test/windows-*.test.mjs'));
  assert.ok(stages[0].args.includes('test/test-platform.test.mjs'));
  assert.ok(stages[0].args.includes('test/ci-bounded-tests.test.mjs'));
  assert.ok(stages[1].args.includes('test/web-ui-handoff.test.mjs'));
  assert.deepEqual(stages[2].args, ['./scripts/check-free-identifiers.mjs']);
  assert.deepEqual(stages[3].args.slice(-8), [
    'test/native-runtime.test.mjs', 'test/web-native-sessions.test.mjs', 'test/web-structured-routes.test.mjs',
    'test/scoped-mcp.test.mjs', 'test/native-fixture-root.test.mjs', 'test/codex-terminal-history-boundary.test.mjs',
    'test/web-browser-lifecycle.test.mjs', 'test/web-files-platform.test.mjs'
  ]);
  assert.equal(stages[3].args[stages[3].args.indexOf('--concurrency') + 1], '3');
  assert.equal(stages[3].args[stages[3].args.indexOf('--file-timeout-ms') + 1], '2100000');
  for (const group of ['core', 'ui', 'shared']) {
    assert.deepEqual(testPlan('win32', 'windows-group', { group, logDirectory: path.join(logs, group) }),
      stages.filter(stage => stage.name === group || (group === 'ui' && stage.name === 'audit')));
  }
  assert.deepEqual(testPlan('win32', 'regression', { logDirectory: logs })[0].args,
    ['./scripts/windows-installed-acceptance.mjs', '--output', path.join(logs, 'installed-acceptance.json')]);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-test-driver-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function subprocess(stages, root) {
  const script = `import { runTestStages } from ${JSON.stringify(driver.href)};
    process.exitCode = await runTestStages(${JSON.stringify(stages)}, {
      cwd: ${JSON.stringify(repo)}, logDirectory: ${JSON.stringify(path.join(root, 'logs'))}
    });`;
  const env = { ...process.env, HCC_SKIP_SHIM_INSTALL: '1' };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repo, env, encoding: 'utf8', timeout: 15000, windowsHide: true
  });
}

test('a real successful child preserves literal arguments and permits the following group', t => {
  const root = fixture(t), output = path.join(root, 'args.json'), second = path.join(root, 'second');
  const literals = ["space and quote's", 'semi;dollar$(literal)', '中文'];
  const result = subprocess([
    { name: 'first', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify(process.argv.slice(1)))`, ...literals], timeoutMs: 5000 },
    { name: 'second', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(second)},'ran')`], timeoutMs: 5000 }
  ], root);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), literals);
  assert.equal(fs.readFileSync(second, 'utf8'), 'ran');
});

test('a real failing child keeps its exit code and prevents the next group from running', t => {
  const root = fixture(t), forbidden = path.join(root, 'must-not-run');
  const result = subprocess([
    { name: 'failure', args: ['-e', "console.error('expected child failure');process.exit(23)"], timeoutMs: 5000 },
    { name: 'forbidden', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'ran')`], timeoutMs: 5000 }
  ], root);
  assert.equal(result.status, 23, result.stderr + result.stdout);
  assert.equal(fs.existsSync(forbidden), false);
  assert.match(fs.readFileSync(path.join(root, 'logs', 'failure.log'), 'utf8'), /expected child failure/);
});

test('a hung child fails within its deadline and never starts the next group', t => {
  const root = fixture(t), forbidden = path.join(root, 'must-not-run');
  const result = subprocess([
    { name: 'deadline', args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 300 },
    { name: 'forbidden', args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(forbidden)},'ran')`], timeoutMs: 5000 }
  ], root);
  assert.equal(result.status, 1, result.stderr + result.stdout);
  assert.equal(fs.existsSync(forbidden), false);
  assert.match(fs.readFileSync(path.join(root, 'logs', 'deadline.log'), 'utf8'), /deadline exceeded/);
});

test('Windows test profiles isolate both home names and temporary paths without changing parent settings', async t => {
  const { createWindowsTestProfile } = await import(driver);
  const before = { ...process.env }, profile = createWindowsTestProfile({ ...before,
    hcc_root: 'inherited project', Hcc_Native_Owner: 'inherited owner', node_test_context: 'child-v8' });
  t.after(() => fs.rmSync(profile.root, { recursive: true, force: true }));
  assert.equal(path.dirname(profile.root), fs.realpathSync.native(os.homedir()));
  assert.equal(profile.env.HOME, profile.root);
  assert.equal(profile.env.USERPROFILE, profile.root);
  assert.equal(profile.env.TEMP, path.join(profile.root, 'tmp'));
  assert.equal(profile.env.TMP, profile.env.TEMP);
  assert.equal(profile.env.HCC_SKIP_SHIM_INSTALL, '1');
  assert.equal(profile.env.HCC_ROOT, undefined);
  assert.equal(profile.env.hcc_root, undefined);
  assert.equal(profile.env.Hcc_Native_Owner, undefined);
  assert.equal(profile.env.node_test_context, undefined);
  assert.deepEqual({ ...process.env }, before);
});

test('a real Windows test child writes provider state only in the disposable profile', async t => {
  const { createWindowsTestProfile, runTestStages } = await import(driver);
  const root = fixture(t), account = path.join(root, 'original-account');
  fs.mkdirSync(account);
  fs.writeFileSync(path.join(account, 'config.json'), '{"preserve":"account fixture"}');
  const supplied = { ...process.env, codex_home: account, Claude_Config_Dir: account, dsh_home: account,
    XDG_CONFIG_HOME: account, xdg_cache_home: account, CodeX_Internal_Originator_Override: 'desktop',
    codex_thread_id: 'unrelated-session', CLAUDE_CODE_SESSION_ID: 'unrelated-claude' };
  const profile = createWindowsTestProfile(supplied);
  t.after(() => fs.rmSync(profile.root, { recursive: true, force: true }));
  const names = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME'];
  const code = `const fs=require('node:fs'),path=require('node:path');
    for(const name of ${JSON.stringify(names)}) fs.writeFileSync(path.join(process.env[name],'probe'),'isolated');
    const forbidden=Object.keys(process.env).filter(key=>/^(CODEX_INTERNAL_ORIGINATOR_OVERRIDE|CODEX_THREAD_ID|CLAUDE_CODE_SESSION_ID)$/i.test(key));
    if(forbidden.length)process.exit(25);`;
  assert.equal(await runTestStages([{ name: 'provider-profile', args: ['-e', code], timeoutMs: 5000 }],
    { cwd: repo, env: profile.env }), 0);
  for (const name of names) assert.equal(fs.readFileSync(path.join(profile.env[name], 'probe'), 'utf8'), 'isolated');
  assert.deepEqual(fs.readdirSync(account), ['config.json']);
  assert.equal(fs.readFileSync(path.join(account, 'config.json'), 'utf8'), '{"preserve":"account fixture"}');
  assert.equal(supplied.codex_home, account);
});

test('the driver saves failed cleanup evidence and exits even when a real owned controller stays live',
  { skip: process.platform !== 'win32', timeout: 10000 }, async t => {
    const root = fixture(t), preload = path.join(root, 'preload.mjs');
    const logs = path.join(root, 'logs'), receipt = path.join(root, 'child.json');
    const nativeUrl = new URL('../lib/platform/windows-native.mjs', import.meta.url);
    fs.writeFileSync(preload, `import fs from 'node:fs';
      import {loadWindowsNative} from ${JSON.stringify(nativeUrl.href)};
      const native=loadWindowsNative(), start=native.startOwnedProcess;
      native.startOwnedProcess=options=>{
        const controller=start({...options,args:['-e','setInterval(()=>{},40)']});
        fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify(native.inspectProcess(controller.pid)));
        const wrapped=Object.fromEntries(Object.getOwnPropertyNames(controller).map(key=>
          [key,typeof controller[key]==='function'?controller[key].bind(controller):controller[key]]));
        wrapped.terminate=()=>{};
        return wrapped;
      };
      const timer=globalThis.setTimeout;
      globalThis.setTimeout=(callback,delay,...args)=>timer(callback,delay===1200000?100:delay===5000?150:delay,...args);
    `);
    const env = { ...process.env, HCC_SKIP_SHIM_INSTALL: '1' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, fileURLToPath(driver),
      'windows-group', '--group', 'ui', '--log-dir', logs],
    { cwd: repo, env, encoding: 'utf8', timeout: 5000, windowsHide: true });
    const summaryFile = path.join(logs, 'driver-summary.json');
    if (fs.existsSync(summaryFile)) {
      const summary = JSON.parse(fs.readFileSync(summaryFile));
      t.after(() => fs.rmSync(summary.profile, { recursive: true, force: true }));
    }
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(fs.existsSync(summaryFile), true, result.stderr + result.stdout);
    const summary = JSON.parse(fs.readFileSync(summaryFile));
    assert.equal(summary.exitCode, 1);
    assert.equal(summary.cleanupUnconfirmed, true);
    const { loadWindowsNative } = await import(nativeUrl);
    assert.equal(loadWindowsNative().inspectProcess(JSON.parse(fs.readFileSync(receipt)).pid).state, 'dead');
    assert.doesNotMatch(result.stderr, /EBADF/);
  });
