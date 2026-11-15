import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDoctorCommand } from '../lib/cli/commands/doctor.mjs';
import { diagnoseCodex } from '../lib/diagnostics/codex.mjs';
import { initSchema, readSchemaVersion, DB_SCHEMA_VERSION } from '../lib/db/schema.mjs';
import { generateShim } from '../lib/integrations/shims/script.mjs';
import { windowsHookCommand } from '../lib/platform/windows-hook-command.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-doctor-codex-'));
  const home = path.join(root, 'codex-home'); fs.mkdirSync(home);
  // Mocked probes still resolve a deterministic installation on Windows.
  if (process.platform === 'win32') fs.writeFileSync(path.join(root, 'codex.exe'), '');
  const ctx = { root, dbPath: path.join(root, 'mesh.db'), json: true };
  const db = new DatabaseSync(ctx.dbPath); initSchema(db);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, home, ctx, db };
}

function configure(f, command = 'hcc hook', events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
  const hooks = Object.fromEntries(events.map(event => [event, [{ hooks: [{ type: 'command', command }] }]]));
  fs.writeFileSync(path.join(f.home, 'hooks.json'), JSON.stringify({ hooks }));
}

function options(f, overrides = {}) {
  const { env, ...rest } = overrides;
  return { env: { CODEX_HOME: f.home, HCC_SHIM_NO_ATTACH: '0', API_KEY: 'secret-environment-marker',
      PATH: f.root, PATHEXT: '.EXE', ...env },
    homedir: () => { throw new Error('CODEX_HOME should take precedence'); },
    run: (_binary, args) => ({ status: 0, stdout: args[0] === '--version' ? 'codex-cli 0.144.6\n'
      : 'Usage: codex app-server [OPTIONS]\n --listen <URL> supported values: stdio://\n' }),
    ...rest };
}

function capture(operation) {
  const original = console.log, values = [];
  console.log = value => values.push(String(value));
  try { return { result: operation(), values }; } finally { console.log = original; }
}

test('Codex diagnostics recognize generated Windows encoded hooks without executing or exposing them', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const command = windowsHookCommand('C:\\Private installation\\bin\\hcc.mjs', 'sessionstart', { shell: 'powershell' });
  configure(f, command);
  const report = diagnoseCodex(f.ctx, f.db, options(f));
  assert.equal(report.hooks.configuration.status, 'present');
  assert.equal(report.hooks.configuration.matched_events.length, 4);
  assert.equal(report.hooks.trust, 'unknown');
  assert.equal(JSON.stringify(report).includes('EncodedCommand'), false);
  configure(f, command + ' ; Write-Output unrelated');
  assert.equal(diagnoseCodex(f.ctx, f.db, options(f)).hooks.configuration.status, 'missing');
});

test('opt-in probes only version/help with bounds and reports advertised startup rather than protocol success', t => {
  const f = fixture(t); configure(f, 'hcc hook --token secret-command-marker');
  const calls = [];
  const opt = options(f);
  const homes = [];
  const report = diagnoseCodex(f.ctx, f.db, { ...opt, run(binary, args, config) {
    calls.push({ binary, args });
    assert.equal(config.env.HCC_SHIM_NO_ATTACH, '1'); assert.equal(config.cwd, f.root);
    assert.equal(config.env.HCC_SHIM_ENSURED, '1');
    assert.notEqual(config.env.CODEX_HOME, f.home);
    assert.equal(fs.statSync(config.env.HOME).isDirectory(), true);
    assert.equal(fs.statSync(config.env.CODEX_HOME).isDirectory(), true);
    homes.push(config.env.CODEX_HOME);
    assert.equal(config.shell, false); assert.equal(config.timeout, 2000); assert.equal(config.maxBuffer, 65536);
    assert.deepEqual(config.stdio, ['ignore', 'pipe', 'ignore']);
    return opt.run(binary, args, config);
  } });
  const binary = process.platform === 'win32' ? path.join(f.root, 'codex.exe') : 'codex';
  assert.deepEqual(calls, [{ binary, args: ['--version'] }, { binary, args: ['app-server', '--help'] }]);
  assert.equal(report.installed.status, 'present'); assert.equal(report.version.value, '0.144.6');
  assert.equal(report.app_server.status, 'advertised');
  assert.deepEqual(report.app_server.startup_arguments, ['--listen', 'stdio://']);
  assert.equal(report.app_server.protocol_handshake, 'unknown'); assert.equal(report.inference_called, false);
  assert.equal(report.hooks.configuration.status, 'present');
  assert.equal(report.hooks.stdout_delivery_receipt.status, 'unknown');
  assert.equal(report.hooks.provider_acceptance, 'unknown'); assert.equal(report.hooks.trust, 'unknown');
  assert.equal(JSON.stringify(report).includes('secret-'), false);
  for (const home of homes) assert.equal(fs.existsSync(home), false);
});

test('only project Codex hook invocation is observed; pre-output events and generic ACKs never become delivery receipts', t => {
  const f = fixture(t); configure(f);
  f.db.prepare("INSERT INTO peers(id,kind,status,created_at,last_seen_at) VALUES('claude-peer','claude','idle',1,1),('codex-peer','codex','idle',1,1)").run();
  f.db.prepare("INSERT INTO events(type,actor,payload,created_at) VALUES('hook.stop','claude-peer','{}',1),('message.ack','codex-peer','{}',2),('codex.executor.started','codex-peer','{}',3)").run();
  assert.equal(diagnoseCodex(f.ctx, f.db, options(f)).hooks.invocation.status, 'unknown');
  f.db.prepare("INSERT INTO events(type,actor,payload,created_at) VALUES('hook.sessionstart','codex-peer','{}',4)").run();
  const report = diagnoseCodex(f.ctx, f.db, options(f));
  assert.equal(report.hooks.invocation.status, 'present');
  assert.equal(report.hooks.invocation.evidence.type, 'hook.sessionstart');
  assert.equal(report.hooks.invocation.provider_at_event, 'unknown');
  assert.match(report.hooks.invocation.scope, /historical provider identity is not verified/);
  assert.equal(report.hooks.stdout_delivery_receipt.status, 'unknown');
  assert.equal(report.hooks.provider_acceptance, 'unknown');
});

test('missing, failed, timed out and unexpected probe output stay unknown without exposing stdout, stderr or errors', t => {
  const f = fixture(t);
  for (const probe of [
    { status: null, error: { code: 'ENOENT', message: 'secret-error-marker' } },
    { status: null, error: { code: 'ETIMEDOUT', message: 'secret-error-marker' } },
    { status: 1, stdout: 'secret-output-marker', stderr: 'secret-stderr-marker' },
    { status: 0, stdout: 'secret-output-marker', stderr: 'secret-stderr-marker' }
  ]) {
    const report = diagnoseCodex(f.ctx, f.db, options(f, { run: () => probe }));
    assert.equal(report.version.status, 'unknown'); assert.equal(report.version.value, null);
    assert.equal(report.app_server.status, 'unknown'); assert.equal(report.app_server.startup_arguments, null);
    assert.equal(JSON.stringify(report).includes('secret-'), false);
  }
  const thrown = diagnoseCodex(f.ctx, f.db, options(f, { run: () => { throw new Error('secret-error-marker'); } }));
  assert.equal(thrown.version.status, 'unknown'); assert.equal(JSON.stringify(thrown).includes('secret-'), false);
});

test('hooks configuration missing, incomplete, malformed and symlinked files never imply trust or delivery', t => {
  const f = fixture(t);
  assert.equal(diagnoseCodex(f.ctx, f.db, options(f)).hooks.configuration.status, 'missing');
  configure(f, 'hcc hook', ['Stop']);
  assert.equal(diagnoseCodex(f.ctx, f.db, options(f)).hooks.configuration.status, 'missing');
  fs.writeFileSync(path.join(f.home, 'hooks.json'), '{ malformed secret-config-marker');
  const malformed = diagnoseCodex(f.ctx, f.db, options(f));
  assert.equal(malformed.hooks.configuration.status, 'unknown');
  assert.equal(JSON.stringify(malformed).includes('secret-'), false);
  if (process.platform !== 'win32') {
    fs.unlinkSync(path.join(f.home, 'hooks.json'));
    fs.symlinkSync('file-not-read', path.join(f.home, 'hooks.json'));
    assert.equal(diagnoseCodex(f.ctx, f.db, options(f)).hooks.configuration.status, 'unknown');
  }
});

test('doctor keeps default output and database state; optional unknown diagnostics do not change healthy exit status', async t => {
  const f = fixture(t);
  const originalExitCode = process.exitCode;
  t.after(() => { process.exitCode = originalExitCode; });
  process.exitCode = 0;
  const initial = fs.readFileSync(f.ctx.dbPath);
  let invocations = 0;
  const command = createDoctorCommand({ connectReadOnly: ctx => new DatabaseSync(ctx.dbPath, { readOnly: true }),
    readSchemaVersion, DB_SCHEMA_VERSION, CLI_NAME: 'hcc', codexDiagnostics() {
      invocations++; throw new Error('secret-diagnostic-marker');
    } });
  const standard = capture(() => command.cmdDoctor(f.ctx, [])); await standard.result;
  assert.equal(JSON.parse(standard.values[0]).data.codex, undefined); assert.equal(invocations, 0);
  const literal = capture(() => command.cmdDoctor(f.ctx, ['--', '--codex'])); await literal.result;
  assert.equal(JSON.parse(literal.values[0]).data.codex, undefined); assert.equal(invocations, 0);
  const diagnostic = capture(() => command.cmdDoctor(f.ctx, ['--codex'])); await diagnostic.result;
  const report = JSON.parse(diagnostic.values[0]);
  assert.equal(report.ok, true); assert.equal(report.data.codex.version.status, 'unknown');
  assert.equal(invocations, 1); assert.equal(process.exitCode, 0);
  assert.equal(JSON.stringify(report).includes('secret-'), false);
  assert.deepEqual(fs.readFileSync(f.ctx.dbPath), initial);
});

test('Codex diagnostics tolerate legacy databases without initializing missing events or peers', t => {
  const f = fixture(t), legacy = new DatabaseSync(':memory:');
  t.after(() => legacy.close());
  legacy.exec("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); INSERT INTO meta VALUES('schema_version','1')");
  const report = diagnoseCodex(f.ctx, legacy, options(f));
  assert.equal(report.hooks.invocation.status, 'unknown'); assert.equal(report.hooks.invocation.reason, 'events_unavailable');
  assert.deepEqual(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name), ['meta']);
});

test('real generated shim passes probes through without ensuring, updating, registering or attaching', { skip: process.platform === 'win32' }, t => {
  const f = fixture(t), bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  const ensured = path.join(f.root, 'ensure-must-not-run');
  const realBin = path.join(bin, 'real-codex'), hcc = path.join(bin, 'hcc-recorder');
  fs.writeFileSync(hcc, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(ensured)}, 'unexpected HCC invocation');\n`, { mode: 0o755 });
  fs.writeFileSync(realBin, `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.length === 1 && args[0] === '--version') console.log('codex-cli 0.144.6');\nelse if (args.length === 2 && args[0] === 'app-server' && args[1] === '--help') console.log('Usage: codex app-server [OPTIONS]\\n --listen <URL> stdio://');\nelse process.exitCode = 90;\n`, { mode: 0o755 });
  const shim = path.join(bin, 'codex');
  fs.writeFileSync(shim, generateShim(hcc, realBin, { name: 'codex' }), { mode: 0o755 });
  const before = { db: fs.readFileSync(f.ctx.dbPath), shim: fs.readFileSync(shim) };
  const report = diagnoseCodex(f.ctx, f.db, { env: { ...process.env, CODEX_HOME: f.home,
    PATH: bin + path.delimiter + process.env.PATH }, homedir: () => f.root,
    // This test verifies shim passthrough. Concurrent suite processes can delay
    // Node startup beyond the production probe deadline, already tested above.
    run(binary, args, config) { return spawnSync(binary, args, { ...config, timeout: 10_000 }); } });
  assert.equal(report.version.value, '0.144.6');
  assert.deepEqual(report.app_server.startup_arguments, ['--listen', 'stdio://']);
  assert.equal(fs.existsSync(ensured), false);
  assert.deepEqual(fs.readFileSync(shim), before.shim);
  assert.deepEqual(fs.readFileSync(f.ctx.dbPath), before.db);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM peers').get().n, 0);
});

test('probe startup writes stay in temporary homes and are cleaned on success and failure', t => {
  const f = fixture(t); configure(f);
  const originalHome = path.join(f.root, 'original-home'); fs.mkdirSync(originalHome);
  const originalConfig = fs.readFileSync(path.join(f.home, 'hooks.json'));
  for (const shouldThrow of [false, true]) {
    const temporaryPaths = [];
    const report = diagnoseCodex(f.ctx, f.db, options(f, { env: { HOME: originalHome, USERPROFILE: originalHome, CODEX_HOME: f.home },
      run(_binary, args, config) {
        temporaryPaths.push(config.env.HOME, config.env.CODEX_HOME);
        assert.notEqual(config.env.HOME, originalHome); assert.notEqual(config.env.CODEX_HOME, f.home);
        fs.writeFileSync(path.join(config.env.HOME, 'startup-cache'), 'isolated');
        fs.mkdirSync(path.join(config.env.CODEX_HOME, 'tmp'), { recursive: true });
        fs.writeFileSync(path.join(config.env.CODEX_HOME, 'tmp', 'arg0'), 'isolated');
        if (shouldThrow) throw new Error('secret-probe-error');
        return { status: 0, stdout: args[0] === '--version' ? 'codex-cli 0.144.6'
          : 'Usage: codex app-server [OPTIONS]\n --stdio' };
      } }));
    assert.equal(report.version.status, shouldThrow ? 'unknown' : 'known');
    assert.equal(report.hooks.configuration.status, 'present');
    for (const directory of temporaryPaths) assert.equal(fs.existsSync(directory), false);
    assert.deepEqual(fs.readdirSync(originalHome), []);
    assert.deepEqual(fs.readdirSync(f.home), ['hooks.json']);
    assert.deepEqual(fs.readFileSync(path.join(f.home, 'hooks.json')), originalConfig);
  }
});

test('Windows Codex diagnostics probe the selected npm installation before a later executable and skip HCC wrappers', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); configure(f);
  fs.unlinkSync(path.join(f.root, 'codex.exe'));
  const originalHome = path.join(f.root, 'original-home'); fs.mkdirSync(originalHome);
  const shimBin = path.join(originalHome, '.hcc-shims'); fs.mkdirSync(shimBin);
  fs.writeFileSync(path.join(shimBin, 'codex.cmd'), '@rem hello-cc shim\r\n');
  const npmBin = path.join(f.root, 'npm installation'); fs.mkdirSync(npmBin);
  const entry = path.join(npmBin, 'node_modules', '@example', 'codex', 'bin', 'codex.cjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  const receipt = path.join(f.root, 'probe-receipts.jsonl');
  fs.writeFileSync(entry, `const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args, home: process.env.HOME, profile: process.env.USERPROFILE, codexHome: process.env.CODEX_HOME }) + '\\n');
fs.writeFileSync(path.join(process.env.HOME, 'startup-cache'), 'isolated');
fs.writeFileSync(path.join(process.env.CODEX_HOME, 'startup-cache'), 'isolated');
if (JSON.stringify(args) === '["--version"]') console.log('codex-cli 0.167.0');
else if (JSON.stringify(args) === '["app-server","--help"]') console.log('Usage: codex app-server [OPTIONS]\\n --listen <URL> stdio://');
else process.exitCode = 90;
`);
  fs.writeFileSync(path.join(npmBin, 'codex.cmd'), '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n' +
    'IF EXIST "%dp0%\\node.exe" (\r\nSET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\nSET "_prog=node"\r\nSET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n' +
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@example\\codex\\bin\\codex.cjs" %*\r\n');
  const laterBin = path.join(f.root, 'later executable'); fs.mkdirSync(laterBin);
  // A real executable which bare spawn('codex') can select after ignoring .cmd.
  fs.copyFileSync(process.execPath, path.join(laterBin, 'codex.exe'));
  const before = { hooks: fs.readFileSync(path.join(f.home, 'hooks.json')), db: fs.readFileSync(f.ctx.dbPath) };
  const calls = [];
  const report = diagnoseCodex(f.ctx, f.db, { env: { ...process.env, HOME: originalHome, USERPROFILE: originalHome,
    CODEX_HOME: f.home, PATH: [shimBin, npmBin, laterBin].join(path.delimiter), PATHEXT: '.EXE;.CMD' },
    run(binary, args, config) {
      calls.push({ binary, args });
      assert.equal(config.shell, false);
      assert.equal(config.env.HCC_SHIM_NO_ATTACH, '1');
      assert.equal(config.env.HCC_SHIM_ENSURED, '1');
      return spawnSync(binary, args, { ...config, timeout: 10_000 });
    } });
  assert.equal(report.version.value, '0.167.0');
  assert.deepEqual(report.app_server.startup_arguments, ['--listen', 'stdio://']);
  assert.deepEqual(calls, [
    { binary: process.execPath, args: [entry, '--version'] },
    { binary: process.execPath, args: [entry, 'app-server', '--help'] }
  ]);
  const receipts = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(receipts.map(value => value.args), [['--version'], ['app-server', '--help']]);
  for (const value of receipts) {
    assert.notEqual(value.home, originalHome); assert.notEqual(value.codexHome, f.home);
    assert.equal(value.profile, value.home);
    assert.equal(fs.existsSync(value.home), false); assert.equal(fs.existsSync(value.codexHome), false);
  }
  assert.deepEqual(fs.readdirSync(originalHome), ['.hcc-shims']);
  assert.deepEqual(fs.readdirSync(f.home), ['hooks.json']);
  assert.deepEqual(fs.readFileSync(path.join(f.home, 'hooks.json')), before.hooks);
  assert.deepEqual(fs.readFileSync(f.ctx.dbPath), before.db);
  assert.equal(report.inference_called, false);
});

test('Windows Codex diagnostic resolution failures stay bounded and never execute unsupported wrappers', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  const bin = path.join(f.root, 'probe-bin'); fs.mkdirSync(bin);
  let calls = 0;
  const opt = options(f, { env: { PATH: bin, PATHEXT: '.CMD;.EXE' },
    run() { calls++; throw new Error('must not execute'); } });
  const missing = diagnoseCodex(f.ctx, f.db, opt);
  assert.equal(missing.installed.status, 'missing');
  assert.equal(missing.version.reason, 'not_found');
  fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo secret-wrapper-marker\r\n');
  fs.writeFileSync(path.join(bin, 'codex.exe'), '');
  const unsupported = diagnoseCodex(f.ctx, f.db, opt);
  assert.equal(unsupported.installed.status, 'unknown');
  assert.equal(unsupported.version.reason, 'probe_failed');
  assert.equal(unsupported.app_server.reason, 'probe_failed');
  assert.equal(JSON.stringify(unsupported).includes('secret-'), false);
  assert.equal(calls, 0);
});
