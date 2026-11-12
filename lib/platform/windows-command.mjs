import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../shared/errors.mjs';

const EXECUTABLES = new Set(['.exe', '.com']);
const NODE_SCRIPTS = new Set(['.js', '.mjs', '.cjs']);
const DEFAULT_EXTENSIONS = '.COM;.EXE;.BAT;.CMD';
const MAX_WRAPPER_BYTES = 64 * 1024;

// Node selects the first lexical key when a Windows environment has duplicate
// names differing only in case. Make that choice once, before updating PATH.
export function windowsEnvironment(env = process.env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new CliError('WINDOWS_ENV_INVALID', 'Windows command environment must be an object');
  }
  const result = {};
  for (const key of Object.keys(env).sort()) {
    const name = key.toUpperCase();
    if (env[key] === undefined || Object.hasOwn(result, name)) continue;
    const value = String(env[key]);
    if (!name || /[=\0]/.test(name) || value.includes('\0')) {
      throw new CliError('WINDOWS_ENV_INVALID', 'Windows environment names and values must not contain NUL or invalid names');
    }
    Object.defineProperty(result, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function existingFile(filename) {
  try { return fs.statSync(filename).isFile(); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw new CliError('WINDOWS_COMMAND_INACCESSIBLE', `Cannot inspect Windows command: ${filename}`, { cause: error.code });
  }
}

function pathDirectories(env, cwd) {
  return (env.PATH || '').split(';').filter(entry => entry.trim()).map(entry => {
    const trimmed = entry.trim();
    return path.resolve(cwd, /^"[^"]*"$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed);
  });
}

function commandCandidates(command, env, cwd) {
  const explicit = /[/\\]/.test(command) || path.isAbsolute(command) || /^[A-Za-z]:/.test(command);
  const extensions = [...new Set((env.PATHEXT ?? DEFAULT_EXTENSIONS).split(';')
    .map(value => value.trim().toLowerCase()).filter(value => /^\.[a-z0-9]+$/.test(value)))];
  const names = path.extname(command) ? [command] : extensions.map(extension => command + extension);
  return { explicit, candidates: (explicit ? [cwd] : pathDirectories(env, cwd))
    .flatMap(directory => names.map(name => path.resolve(directory, name))) };
}

function hccWrapper(filename, content = '') {
  const canonical = fs.realpathSync.native(filename);
  return [filename, canonical].some(value => value.split(/[/\\]/).some(part => part.toLowerCase() === '.hcc-shims')) ||
    /(?:hello-cc shim|HCC_SHIM_ENSURED|HCC_WINDOWS_SHIM)/i.test(content);
}

function readWrapper(filename) {
  if (fs.statSync(filename).size > MAX_WRAPPER_BYTES) return null;
  return fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
}

function wrapperFailure(filename) {
  return new CliError('WINDOWS_WRAPPER_UNSUPPORTED',
    `Cannot safely resolve Windows wrapper ${filename}. Use the provider's actual .exe or Node .js entry, or reinstall its npm launcher.`);
}

function assertNotHccTarget(filename) {
  if (hccWrapper(filename)) throw new CliError('WINDOWS_SHIM_RECURSION',
    `The resolved command points back into an HCC wrapper: ${filename}. Select the actual provider installation.`);
}

function normalizedBatch(text) {
  return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join('\n');
}

function npmDistributionTarget(filename, normalized) {
  for (const name of ['npm', 'npx']) {
    const variable = name.toUpperCase();
    const expected = [
      ":: Created by npm, please don't edit manually.", '@ECHO OFF', 'SETLOCAL',
      'SET "NODE_EXE=%~dp0\\node.exe"', 'IF NOT EXIST "%NODE_EXE%" (', 'SET "NODE_EXE=node"', ')',
      'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
      `SET "${variable}_CLI_JS=%~dp0\\node_modules\\npm\\bin\\${name}-cli.js"`,
      'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
      `SET "NPM_PREFIX_${variable}_CLI_JS=%%F\\node_modules\\npm\\bin\\${name}-cli.js"`, ')',
      `IF EXIST "%NPM_PREFIX_${variable}_CLI_JS%" (`, `SET "${variable}_CLI_JS=%NPM_PREFIX_${variable}_CLI_JS%"`, ')',
      `"%NODE_EXE%" "%${variable}_CLI_JS%" %*`
    ].join('\n');
    if (normalized !== expected) continue;
    // Intentionally select the npm installation named by this launcher, using
    // HCC's current Node. Do not run npm-prefix.js or silently follow a global
    // prefix to a different installation during command resolution.
    const target = path.join(path.dirname(filename), 'node_modules', 'npm', 'bin', `${name}-cli.js`);
    if (!existingFile(target)) throw wrapperFailure(filename);
    assertNotHccTarget(target);
    return { file: process.execPath, args: [target], kind: 'node-script' };
  }
  return null;
}

function npmTarget(filename, content) {
  const normalized = normalizedBatch(content);
  const distribution = npmDistributionTarget(filename, normalized);
  if (distribution) return distribution;
  const match = /"%dp0%\\([^"\r\n]+)" +%\*$/.exec(normalized);
  if (!match) throw wrapperFailure(filename);
  const relative = match[1];
  // Only literal package paths are accepted. Never expand batch variables or
  // interpret commands, shebang arguments, environment assignments or redirects.
  if (/[%!^&|<>()]/.test(relative)) throw wrapperFailure(filename);
  const head = '@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT /b\n:start\nSETLOCAL\nCALL :find_dp0\n';
  const node = head + 'IF EXIST "%dp0%\\node.exe" (\nSET "_prog=%dp0%\\node.exe"\n) ELSE (\nSET "_prog=node"\nSET PATHEXT=%PATHEXT:;.JS;=;%\n)\n' +
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relative}" %*`;
  const direct = head + `"%dp0%\\${relative}"   %*`;
  if (normalized !== node && normalized !== direct) throw wrapperFailure(filename);
  const directory = path.dirname(filename);
  const target = path.resolve(directory, ...relative.split(/[/\\]/));
  const packageRoot = path.basename(directory).toLowerCase() === '.bin' &&
      path.basename(path.dirname(directory)).toLowerCase() === 'node_modules'
    ? path.dirname(directory) : path.join(directory, 'node_modules');
  const within = path.relative(packageRoot, target);
  if (!within || within === '..' || within.startsWith('..' + path.sep) || path.isAbsolute(within) || !existingFile(target)) {
    throw wrapperFailure(filename);
  }
  const extension = path.extname(target).toLowerCase();
  assertNotHccTarget(target);
  if (normalized === node && NODE_SCRIPTS.has(extension)) return { file: process.execPath, args: [target], kind: 'node-script' };
  if (normalized === direct && EXECUTABLES.has(extension)) return { file: target, args: [], kind: 'executable' };
  throw wrapperFailure(filename);
}

function powershellHost(env, cwd) {
  for (const name of ['pwsh.exe', 'powershell.exe']) {
    for (const directory of pathDirectories(env, cwd)) {
      const candidate = path.join(directory, name);
      if (existingFile(candidate) && !hccWrapper(candidate)) return candidate;
    }
  }
  if (env.SYSTEMROOT) {
    const candidate = path.join(env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (existingFile(candidate)) return candidate;
  }
  throw new CliError('WINDOWS_POWERSHELL_NOT_FOUND', 'PowerShell is required for this .ps1 command. Install PowerShell or select the provider executable.');
}

// Returned args are an invocation prefix. Append caller arguments unchanged;
// launch with shell:false and windowsHide:true. This resolves files, not trust:
// the owned process launcher still verifies cwd and establishes process ownership.
export function resolveWindowsCommand(command, { env = process.env, cwd = process.cwd() } = {}) {
  if (typeof command !== 'string' || !command.trim() || /[\x00-\x1f\x7f]/.test(command)) {
    throw new CliError('WINDOWS_COMMAND_INVALID', 'Windows command must be a nonempty executable name or path, without control characters');
  }
  const environment = windowsEnvironment(env);
  const { explicit, candidates } = commandCandidates(command, environment, cwd);
  let skippedHcc = false;
  for (const filename of candidates) {
    if (!existingFile(filename)) continue;
    const extension = path.extname(filename).toLowerCase();
    const script = ['.cmd', '.bat', '.ps1'].includes(extension);
    const content = script ? readWrapper(filename) : '';
    if (hccWrapper(filename, content || '')) {
      skippedHcc = true;
      if (!explicit) continue;
      break;
    }
    if (EXECUTABLES.has(extension)) return { file: filename, args: [], kind: 'executable' };
    if (NODE_SCRIPTS.has(extension)) return { file: process.execPath, args: [filename], kind: 'node-script' };
    if (extension === '.cmd' || extension === '.bat') {
      if (content === null) throw wrapperFailure(filename);
      return npmTarget(filename, content);
    }
    if (extension === '.ps1') return { file: powershellHost(environment, cwd),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', filename], kind: 'powershell-script' };
    throw new CliError('WINDOWS_COMMAND_UNSUPPORTED', `Unsupported Windows command type: ${filename}. Select an .exe, Node script, or PowerShell script.`);
  }
  if (skippedHcc) throw new CliError('WINDOWS_SHIM_RECURSION', `Only an HCC wrapper was found for ${command}. Add the actual provider installation to PATH.`);
  throw new CliError('WINDOWS_COMMAND_NOT_FOUND', `Windows command not found: ${command}. Install it or provide its executable path.`);
}
