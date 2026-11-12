import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CliError } from '../shared/errors.mjs';
import { windowsEnvironment } from './windows-command.mjs';

// Data travels through the child's environment. The PowerShell program is
// fixed, uses .NET registry APIs, and never evaluates PATH or directory text.
const registryScript = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
$request=$env:HCC_WINDOWS_PATH_REQUEST | ConvertFrom-Json
function Read-Record($key) {
  $present=$null -ne $key -and $key.GetValueNames() -contains 'Path'
  $value=$null; $kind=$null; $ownership=$null
  if($present) { $value=$key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $kind=$key.GetValueKind('Path').ToString() }
  if($null -ne $key) { $ownership=$key.GetValue('HelloCcShimPath',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  return @{present=[bool]$present;path=$value;kind=$kind;ownership=$ownership}
}
$key=$null; $mutex=$null; $held=$false
try {
  if($request.action -eq 'write') {
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $mutex=New-Object System.Threading.Mutex($false,('Local\hello-cc-user-path-'+$sid))
    $held=$mutex.WaitOne(5000)
    if(!$held) { throw 'PATH_BUSY' }
  }
  $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($request.key,($request.action -eq 'write'))
  $current=Read-Record $key
  if($request.action -eq 'write') {
    foreach($field in @('present','path','kind','ownership')) {
      if($current[$field] -cne $request.expected.$field) { throw 'PATH_CHANGED' }
    }
    if($null -eq $key) { $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($request.key) }
    if($request.next.present) {
      $kind=[Microsoft.Win32.RegistryValueKind]::$($request.next.kind)
      $key.SetValue('Path',[string]$request.next.path,$kind)
    } else { $key.DeleteValue('Path',$false) }
    if($null -eq $request.next.ownership) { $key.DeleteValue('HelloCcShimPath',$false) }
    else { $key.SetValue('HelloCcShimPath',[string]$request.next.ownership,[Microsoft.Win32.RegistryValueKind]::String) }
    $key.Flush()
    $current=Read-Record $key
    if($request.broadcast) {
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HccEnvironmentNotice { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd,uint msg,UIntPtr wParam,string lParam,uint flags,uint timeout,out UIntPtr result); }'
      $result=[UIntPtr]::Zero
      [void][HccEnvironmentNotice]::SendMessageTimeout([IntPtr]0xffff,0x1a,[UIntPtr]::Zero,'Environment',2,1000,[ref]$result)
    }
  }
  $current | ConvertTo-Json -Compress
} finally {
  if($null -ne $key) { $key.Dispose() }
  if($held) { $mutex.ReleaseMutex() }
  if($null -ne $mutex) { $mutex.Dispose() }
}`;

function options(value = {}) {
  const registryKey = value.registryKey ?? 'Environment';
  // Production has one target. Tests use a disposable, explicitly named key;
  // an environment override cannot redirect writes into another application.
  if (registryKey !== 'Environment' && !/^Software\\hello-cc\\tests\\[a-f0-9-]{36}$/i.test(registryKey)) {
    throw new CliError('BAD_ARGS', 'Unsupported user PATH registry location');
  }
  const shimDir = value.shimDir ?? path.join(os.homedir(), '.hcc-shims');
  if (!path.win32.isAbsolute(shimDir) || /[;\0\r\n]/.test(shimDir)) throw new CliError('BAD_ARGS', 'The launcher directory cannot be represented as one Windows PATH entry');
  return { registryKey, shimDir, broadcast: registryKey === 'Environment' && value.broadcast !== false, processEnv: value.processEnv ?? process.env };
}

function registry(action, opts, extra = {}) {
  const env = windowsEnvironment();
  const host = path.join(env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  env.HCC_WINDOWS_PATH_REQUEST = JSON.stringify({ action, key: opts.registryKey, broadcast: opts.broadcast, ...extra });
  const result = spawnSync(host, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(registryScript, 'utf16le').toString('base64')], {
    env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000, maxBuffer: 1024 * 1024
  });
  if (result.status !== 0 || result.error) {
    const changed = String(result.stderr).includes('PATH_CHANGED');
    throw new CliError(changed ? 'WINDOWS_PATH_CONFLICT' : 'WINDOWS_PATH_UNCONFIRMED', changed
      ? 'Your user PATH changed during the update. Retry without closing other applications.'
      : 'The Windows user PATH update could not be confirmed. Check your user environment settings before retrying.',
    { reason: result.error?.code || 'registry_operation_failed' });
  }
  let record;
  try { record = JSON.parse(result.stdout.trim()); } catch { throw new CliError('WINDOWS_PATH_UNCONFIRMED', 'Cannot read the Windows user PATH result'); }
  if (typeof record.present !== 'boolean' || (record.present && (typeof record.path !== 'string' || !['String', 'ExpandString'].includes(record.kind))) ||
      (record.ownership !== null && typeof record.ownership !== 'string')) throw new CliError('WINDOWS_PATH_UNSUPPORTED', 'Windows user PATH must be a string or expandable string value');
  return record;
}

const normalized = value => path.win32.normalize(value.replace(/^"(.*)"$/, '$1')).replace(/[\\/]+$/, '').toLowerCase();
const isEntry = (value, shimDir) => normalized(value) === normalized(shimDir);
function ownership(record, shimDir) {
  if (record.ownership === null) return null;
  let value;
  try { value = JSON.parse(record.ownership); } catch { throw new CliError('WINDOWS_PATH_CONFLICT', 'The HCC PATH ownership record is invalid'); }
  if (value?.version !== 1 || typeof value.shimDir !== 'string' || !isEntry(value.shimDir, shimDir) ||
      typeof value.pathWasPresent !== 'boolean' || !Array.isArray(value.previousEntries) ||
      value.previousEntries.some(entry => !Number.isSafeInteger(entry.index) || entry.index < 0 || typeof entry.value !== 'string' || !isEntry(entry.value, shimDir))) {
    throw new CliError('WINDOWS_PATH_CONFLICT', 'The HCC PATH entry belongs to a different or unrecognized installation');
  }
  return value;
}
function updateProcessPath(env, shimDir, install) {
  const original = windowsEnvironment(env).PATH || '';
  const entries = original.split(';').filter(value => !isEntry(value, shimDir));
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = (install ? [shimDir, ...entries] : entries).join(';');
}

export function readWindowsPathRecord(value = {}) { return registry('read', options(value)); }

export function installWindowsPathEntry(value = {}) {
  const opts = options(value); const before = registry('read', opts);
  const entries = before.present ? before.path.split(';') : [];
  const owner = ownership(before, opts.shimDir) || { version: 1, shimDir: opts.shimDir, pathWasPresent: before.present,
    previousEntries: entries.flatMap((entry, index) => isEntry(entry, opts.shimDir) ? [{ index, value: entry }] : []) };
  const next = { present: true, path: [opts.shimDir, ...entries.filter(entry => !isEntry(entry, opts.shimDir))].join(';'),
    kind: before.kind || 'ExpandString', ownership: JSON.stringify(owner) };
  if (next.path.length > 32767) throw new CliError('WINDOWS_PATH_TOO_LONG', 'The updated Windows user PATH exceeds the supported length');
  const alreadyPresent = before.path === next.path && before.ownership === next.ownership;
  if (!alreadyPresent) registry('write', opts, { expected: before, next });
  updateProcessPath(opts.processEnv, opts.shimDir, true);
  return { rcFile: `HKCU\\${opts.registryKey}\\Path`, shellType: 'windows', alreadyPresent, restartRequired: !alreadyPresent };
}

export function uninstallWindowsPathEntry(value = {}) {
  const opts = options(value); const before = registry('read', opts); const owner = ownership(before, opts.shimDir);
  const rcFile = `HKCU\\${opts.registryKey}\\Path`;
  if (!owner) return { rcFile, removed: false, ...(!before.present ? { missing: true } : {}) };
  const entries = (before.present ? before.path.split(';') : []).filter(entry => !isEntry(entry, opts.shimDir));
  for (const entry of owner.previousEntries) entries.splice(Math.min(entry.index, entries.length), 0, entry.value);
  const present = owner.pathWasPresent || entries.length > 0;
  const next = { present, path: present ? entries.join(';') : null, kind: present ? before.kind || 'ExpandString' : null, ownership: null };
  registry('write', opts, { expected: before, next });
  updateProcessPath(opts.processEnv, opts.shimDir, false);
  return { rcFile, removed: true, restartRequired: true };
}
