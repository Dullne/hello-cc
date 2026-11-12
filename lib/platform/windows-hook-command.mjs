import path from 'node:path';
import { CliError } from '../shared/errors.mjs';
import { windowsEnvironment } from './windows-command.mjs';

const OPTIONS = ' -NoLogo -NoProfile -NonInteractive -EncodedCommand ';
const EVENTS = new Set(['sessionstart', 'userpromptsubmit', 'pretooluse', 'posttooluse', 'stop']);
const PREAMBLE = '# HCC_WINDOWS_HOOK_V1\n' +
  '[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)\n' +
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n';
const quote = value => "'" + value.replaceAll("'", "''") + "'";

export function windowsHookCommand(hccBin, event, { shell = 'cmd' } = {}) {
  if (typeof hccBin !== 'string' || !path.win32.isAbsolute(hccBin) ||
      /[\0\r\n]/.test(hccBin) || !EVENTS.has(event) || !['cmd', 'powershell'].includes(shell)) {
    throw new CliError('BAD_ARGS', 'A Windows hook requires an absolute HCC script path and a known event');
  }
  const source = PREAMBLE + `& ${quote(process.execPath)} ${quote(hccBin)} 'hook' ${quote(event)}\nexit $LASTEXITCODE\n`;
  const systemRoot = windowsEnvironment(process.env).SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) || /["%\r\n\0]/.test(systemRoot)) {
    throw new CliError('WINDOWS_POWERSHELL_NOT_FOUND', 'A valid Windows system directory is required for hooks');
  }
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const prefix = shell === 'powershell' ? `& ${quote(powershell)}` : `"${powershell}"`;
  const command = prefix + OPTIONS + Buffer.from(source, 'utf16le').toString('base64');
  if (command.length > 30000) throw new CliError('BAD_ARGS', 'The Windows hook command exceeds the supported length');
  return command;
}

// Recognize only the complete generated form. Merely mentioning HCC, copying
// its marker into another script, or appending commands cannot claim ownership.
export function isWindowsHccHookCommand(command) {
  if (typeof command !== 'string' || command.length > 30000) return false;
  const separator = command.indexOf(OPTIONS);
  if (separator < 0) return false;
  const prefix = command.slice(0, separator);
  let powershell;
  if (/^"[^"\r\n]+"$/.test(prefix)) powershell = prefix.slice(1, -1);
  else if (/^& '(?:[^'\r\n]|'')*'$/.test(prefix)) powershell = prefix.slice(3, -1).replaceAll("''", "'");
  else return false;
  if (!path.win32.isAbsolute(powershell) || !/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i.test(powershell)) return false;
  const encoded = command.slice(separator + OPTIONS.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded || bytes.length % 2) return false;
  const source = bytes.toString('utf16le');
  if (!source.startsWith(PREAMBLE)) return false;
  const match = /^& '((?:[^'\r\n]|'')*)' '((?:[^'\r\n]|'')*)' 'hook' '([a-z]+)'\nexit \$LASTEXITCODE\n$/.exec(source.slice(PREAMBLE.length));
  if (!match || !EVENTS.has(match[3])) return false;
  const node = match[1].replaceAll("''", "'");
  const script = match[2].replaceAll("''", "'");
  return path.win32.isAbsolute(node) && path.win32.basename(node).toLowerCase() === 'node.exe' &&
    path.win32.isAbsolute(script) && ['hcc.mjs', 'hcc', 'hello-cc'].includes(path.win32.basename(script).toLowerCase());
}
