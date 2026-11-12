import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { installWindowsPathEntry, uninstallWindowsPathEntry, readWindowsPathRecord } from '../lib/platform/windows-user-path.mjs';

const windows = process.platform === 'win32';
const ps = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
function powershell(script) {
  const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); return result.stdout;
}
function fixture(t, initial, kind = 'ExpandString') {
  const registryKey = 'Software\\hello-cc\\tests\\' + randomUUID();
  const safe = value => "'" + value.replaceAll("'", "''") + "'";
  powershell(`$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${safe(registryKey)});try{$key.SetValue('Path',${safe(initial)},[Microsoft.Win32.RegistryValueKind]::${kind});$key.SetValue('Unrelated','keep')}finally{$key.Dispose()}`);
  t.after(() => powershell(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${safe(registryKey)},$false)`));
  const shimDir = "C:\\Users\\中文 %!&' user\\.hcc-shims";
  return { registryKey, shimDir, processEnv: { Path: 'C:\\system;' + initial }, broadcast: false };
}

test('Windows user PATH uses an isolated HKCU value, preserves expansion/type/unrelated entries, and uninstalls idempotently', { skip: !windows }, t => {
  const original = '%TOOLS%\\bin;C:\\Other tools;;'; const options = fixture(t, original);
  const first = installWindowsPathEntry(options);
  assert.equal(first.alreadyPresent, false); assert.equal(first.shellType, 'windows');
  const installed = readWindowsPathRecord(options);
  assert.equal(installed.path, options.shimDir + ';' + original); assert.equal(installed.kind, 'ExpandString');
  assert.equal(options.processEnv.PATH, options.shimDir + ';C:\\system;' + original);
  assert.equal(options.processEnv.Path, undefined);
  assert.equal(installWindowsPathEntry(options).alreadyPresent, true);
  assert.equal(uninstallWindowsPathEntry(options).removed, true);
  const removed = readWindowsPathRecord(options);
  assert.equal(removed.path, original); assert.equal(removed.kind, 'ExpandString'); assert.equal(removed.ownership, null);
  assert.equal(uninstallWindowsPathEntry(options).removed, false);
});

test('Windows PATH removal restores a preexisting matching entry and preserves later unrelated additions', { skip: !windows }, t => {
  const options = fixture(t, 'C:\\before;C:\\Users\\中文 %!&\' user\\.hcc-shims;C:\\after', 'String');
  installWindowsPathEntry(options);
  const quotedKey = options.registryKey.replaceAll("'", "''");
  powershell(`$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${quotedKey}',$true);try{$key.SetValue('Path',$key.GetValue('Path')+';C:\\added',[Microsoft.Win32.RegistryValueKind]::String)}finally{$key.Dispose()}`);
  uninstallWindowsPathEntry(options);
  assert.equal(readWindowsPathRecord(options).path, 'C:\\before;' + options.shimDir + ';C:\\after;C:\\added');
  assert.equal(readWindowsPathRecord(options).kind, 'String');
});

test('Windows PATH uninstall never claims an unmarked entry or accepts arbitrary registry locations', { skip: !windows }, t => {
  const options = fixture(t, 'C:\\keep');
  assert.equal(uninstallWindowsPathEntry(options).removed, false);
  assert.equal(readWindowsPathRecord(options).path, 'C:\\keep');
  assert.throws(() => installWindowsPathEntry({ ...options, registryKey: 'Software\\UnrelatedApp' }), { code: 'BAD_ARGS' });
});
