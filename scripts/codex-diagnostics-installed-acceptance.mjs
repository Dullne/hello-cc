// Read-only installed CLI diagnostics in a disposable project/home. No model,
// account configuration, existing session, or user project is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { initSchema } from '../lib/db/schema.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-installed-diagnostics-'));
const root = path.join(directory, 'project');
const home = path.join(directory, 'home');
const codexHome = path.join(directory, 'codex-home');
const state = path.join(root, '.hello-cc');
for (const entry of [state, home, codexHome]) fs.mkdirSync(entry, { recursive: true });
const db = new DatabaseSync(path.join(state, 'mesh.db'));
try { initSchema(db); } finally { db.close(); }
fs.writeFileSync(path.join(codexHome, 'hooks.json'), '{}\n');
const cli = fileURLToPath(new URL('../bin/hcc.mjs', import.meta.url));
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome,
  HCC_SHIM_NO_ATTACH: '1', HCC_SHIM_ENSURED: '1' };

function files(parent = directory) {
  return fs.readdirSync(parent, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(parent, entry.name);
    return entry.isDirectory() ? files(file) : [[path.relative(directory, file),
      createHash('sha256').update(fs.readFileSync(file)).digest('hex')]];
  }).sort(([left], [right]) => left.localeCompare(right));
}

function doctor(args = []) {
  const result = spawnSync(process.execPath, [cli, '--root', root, '--json', 'doctor', ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // Do not expose arbitrary executable/configuration output on failure.
  assert.equal(result.error, undefined, 'Isolated doctor process failed');
  assert.equal(result.status, 0, 'Isolated doctor rejected the healthy database');
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true, 'Isolated doctor did not return a successful report');
  return response.data;
}

let evidence;
try {
  const before = files();
  const plain = doctor();
  assert.equal(Object.hasOwn(plain, 'codex'), false, 'Default doctor unexpectedly probes Codex');
  const report = doctor(['--codex']);
  assert.equal(report.codex.installed.status, 'present');
  assert.equal(report.codex.version.status, 'known');
  assert.equal(report.codex.app_server.status, 'advertised');
  assert.ok(report.codex.app_server.startup_arguments?.length);
  assert.equal(report.codex.app_server.protocol_handshake, 'unknown');
  assert.equal(report.codex.hooks.configuration.status, 'missing');
  assert.equal(report.codex.hooks.invocation.status, 'unknown');
  assert.equal(report.codex.hooks.stdout_delivery_receipt.status, 'unknown');
  assert.equal(report.codex.hooks.provider_acceptance, 'unknown');
  assert.equal(report.codex.hooks.trust, 'unknown');
  assert.deepEqual(files(), before, 'Diagnostics changed the project, home, or hook configuration');
  evidence = { installedVersion: report.codex.version.value,
    appServerStartupArguments: report.codex.app_server.startup_arguments,
    defaultDoctorDatabaseOnly: true, projectAndHomeUnchanged: true,
    configurationDoesNotProveDeliveryOrTrust: true, inferenceCalled: false };
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...evidence, temporaryDirectoriesRemoved: true }));
console.log('INSTALLED_CODEX_DIAGNOSTICS_OK');
