import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('..', import.meta.url));
const shell = path.join(repository, '.github/scripts/windows-test-shell.ps1');
const probe = path.join(repository, '.github/scripts/windows-token-owner-probe.mjs');
const psQuote = value => "'" + value.replaceAll("'", "''") + "'";

function runStep(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-ci-owner-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const step = path.join(root, 'step with spaces.ps1');
  fs.writeFileSync(step, source);
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', shell, step], {
    cwd: repository, env: { ...process.env, RUNNER_TEMP: root, HCC_SKIP_SHIM_INSTALL: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return { root, result };
}

test('Windows CI shell verifies the current-user default owner before children create private files and SQLite sidecars', { skip: process.platform !== 'win32' }, t => {
  const { root, result } = runStep(t, `& ${psQuote(process.execPath)} ${psQuote(probe)}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const logs = fs.readdirSync(path.join(root, 'hcc-windows-token-owner'));
  const tokenFile = logs.find(name => name.startsWith('token-owner-'));
  assert.ok(tokenFile, 'the shell must preserve the before/after token receipt');
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'hcc-windows-token-owner', tokenFile), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(receipt.after.ownerSid, receipt.after.userSid);
  assert.equal(receipt.before.userSid, receipt.after.userSid);
  assert.equal(receipt.adjusted, receipt.before.ownerSid !== receipt.before.userSid);
  const fileReceipt = JSON.parse(fs.readFileSync(path.join(root, 'hcc-windows-token-owner', 'private-files.json'), 'utf8'));
  assert.equal(fileReceipt.ok, true);
  assert.deepEqual(fileReceipt.files.map(file => file.name).sort(), ['child.txt', 'private', 'state.db', 'state.db-shm', 'state.db-wal']);
  for (const file of fileReceipt.files) {
    assert.equal(file.private, true);
    assert.equal(file.ownerSid, receipt.after.userSid);
  }
  assert.deepEqual(fs.readdirSync(root).sort(), ['hcc-windows-token-owner', 'step with spaces.ps1']);
});

test('Windows CI shell preserves a failing native command status', { skip: process.platform !== 'win32' }, t => {
  const { result } = runStep(t, `& ${psQuote(process.execPath)} -e 'process.exit(7)'`);
  assert.equal(result.status, 7, result.stdout + result.stderr);
});

test('Windows current-user default ownership can be set without elevation or a user change', { skip: process.platform !== 'win32' }, t => {
  const { result } = runStep(t, `
$initial = [HccCiTokenOwner]::Inspect()
[HccCiTokenOwner]::UseCurrentUserOwner()
$final = [HccCiTokenOwner]::Inspect()
if ($initial.userSid -ne $final.userSid -or $initial.elevated -ne $final.elevated -or $final.ownerSid -ne $final.userSid) { throw 'Token identity or elevation changed' }
Write-Output 'OWNER_API_VERIFIED'
`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /OWNER_API_VERIFIED/);
});

test('Windows CI shell refuses to continue after a PowerShell failure', { skip: process.platform !== 'win32' }, t => {
  const { result } = runStep(t, "Write-Error 'intentional shell failure'\nWrite-Output 'UNREACHABLE_AFTER_FAILURE'");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /intentional shell failure/);
  assert.doesNotMatch(result.stdout, /UNREACHABLE_AFTER_FAILURE/);
});
