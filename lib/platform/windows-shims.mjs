import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CliError } from '../shared/errors.mjs';
import { captureDirectory } from './windows-filesystem.mjs';
import { createWindowsPrivateDirectory, inspectWindowsPrivateDirectory, sameWindowsFileIdentity } from './windows-private-state.mjs';
import { resolveWindowsCommand } from './windows-command.mjs';

const TOOLS = ['claude', 'codex'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const runner = new URL('./windows-shim-runner.mjs', import.meta.url).href;
const defaultDirectory = () => path.join(os.homedir(), '.hcc-shims');
const names = tool => [`${tool}.exe`, `${tool}.exe.nodepath`, `${tool}.exe.mjs`];
const manifestName = tool => `${tool}.exe.hcc.json`;
const conflict = name => new CliError('WINDOWS_SHIM_CONFLICT',
  `HCC cannot replace or remove an unrecognized or modified launcher: ${name}. Preserve your changes and restore the owned files before retrying.`);

function exists(file) {
  try { fs.lstatSync(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function withDirectory(shimDir, create, fn, { pin = true } = {}) {
  if (!exists(shimDir)) {
    if (!create) return fn(null);
    createWindowsPrivateDirectory(shimDir);
  }
  const observed = inspectWindowsPrivateDirectory(shimDir);
  const lease = captureDirectory(shimDir, { pin });
  let directory;
  try {
    if (!sameWindowsFileIdentity(observed.identity, lease.snapshot().identity) || lease.security().private !== true) throw conflict(shimDir);
    directory = lease.openDirectory('');
    const result = fn(directory);
    directory.assertUnchanged();
    if (directory.security().private !== true) throw conflict(shimDir);
    return result;
  } finally { directory?.close(); lease.close(); }
}

function read(directory, name, limit = 10 * 1024 * 1024) {
  let file;
  try {
    file = directory.openFile(name);
    if (file.security().private !== true) throw conflict(name);
    const snapshot = file.snapshot();
    if (BigInt(snapshot.size) > BigInt(limit)) throw conflict(name);
    const bytes = file.read(limit); file.assertUnchanged();
    return { bytes, identity: snapshot.identity };
  } catch (error) { if (error.code === 'PROJECT_FILE_NOT_FOUND') return null; throw error; }
  finally { file?.close(); }
}

function inspectTool(directory, tool) {
  if (!directory) return { manifest: null, record: null, files: {} };
  const record = read(directory, manifestName(tool), 65536);
  let manifest = null;
  if (record) {
    try { manifest = JSON.parse(record.bytes.toString('utf8')); } catch { throw conflict(manifestName(tool)); }
    if (manifest?.version !== 1 || manifest.owner !== 'hello-cc' || manifest.tool !== tool ||
        typeof manifest.hccBin !== 'string' || typeof manifest.realBin !== 'string' ||
        !path.isAbsolute(manifest.hccBin) || !path.isAbsolute(manifest.realBin) ||
        !manifest.files || Object.keys(manifest.files).sort().join('\0') !== names(tool).sort().join('\0') ||
        Object.values(manifest.files).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) {
      throw conflict(manifestName(tool));
    }
  }
  const files = {};
  for (const name of names(tool)) {
    const file = read(directory, name);
    if (file && (!manifest || hash(file.bytes) !== manifest.files[name])) throw conflict(name);
    files[name] = file;
  }
  return { manifest, record, files };
}

function launcherBytes() {
  const target = path.join(packageRoot, 'native', 'bin', `win32-${process.arch}`);
  let manifest, bytes, source;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(target, 'hcc-shim.json'), 'utf8'));
    bytes = fs.readFileSync(path.join(target, 'hcc-shim.exe'));
    source = fs.readFileSync(path.join(packageRoot, 'native', 'windows', 'launcher', 'shim.cc'));
  } catch { throw new CliError('WINDOWS_SHIM_UNAVAILABLE', 'The Windows launcher component is missing. Reinstall HCC.'); }
  if (manifest.manifestVersion !== 1 || manifest.platform !== 'win32' || manifest.arch !== process.arch ||
      manifest.binarySha256 !== hash(bytes) || manifest.sourceSha256 !== hash(source)) {
    throw new CliError('WINDOWS_SHIM_UNAVAILABLE', 'The Windows launcher component does not match this installation. Reinstall HCC.');
  }
  return bytes;
}

export function findWindowsRealBinary(name, options = {}) {
  try {
    const command = resolveWindowsCommand(name, options);
    return command.kind === 'node-script' ? command.args[0]
      : command.kind === 'powershell-script' ? command.args.at(-1) : command.file;
  } catch (error) {
    if (['WINDOWS_COMMAND_NOT_FOUND', 'WINDOWS_SHIM_RECURSION'].includes(error.code)) return null;
    throw error;
  }
}

function publish(directory, name, bytes, previous) {
  if (previous?.bytes.equals(bytes)) return false;
  directory.publish(name, bytes, { private: true, operation: previous ? 'replace' : 'create',
    ...(previous ? { expectedIdentity: previous.identity, expectedBytes: previous.bytes } : {}) });
  return true;
}

export function installWindowsShims(hccBin, { shimDir = defaultDirectory(), realBins = {}, env = process.env } = {}) {
  hccBin = fs.realpathSync.native(hccBin);
  const binary = launcherBytes();
  return withDirectory(shimDir, true, directory => {
    // Preflight both providers before the first publication. Unrelated files
    // and locally customized launchers never become implicitly HCC-owned.
    const existing = Object.fromEntries(TOOLS.map(tool => [tool, inspectTool(directory, tool)]));
    const plans = TOOLS.map(tool => {
      const requested = realBins[tool];
      const previous = existing[tool].manifest?.realBin;
      const realBin = requested ? findWindowsRealBinary(requested, { env })
        : (previous && findWindowsRealBinary(previous, { env })) || findWindowsRealBinary(tool, { env });
      // Explicit recursion is an error, while an absent PATH provider is skipped.
      if (requested && !realBin) resolveWindowsCommand(requested, { env });
      if (!realBin) return { tool };
      const config = { tool, hccBin, realBin };
      const files = {
        [`${tool}.exe`]: binary,
        [`${tool}.exe.nodepath`]: Buffer.from('\ufeff' + process.execPath, 'utf16le'),
        [`${tool}.exe.mjs`]: Buffer.from(`// HCC_WINDOWS_SHIM v1\nimport { runWindowsShim } from ${JSON.stringify(runner)};\nawait runWindowsShim(${JSON.stringify(config)}, process.argv.slice(2));\n`)
      };
      const manifest = { version: 1, owner: 'hello-cc', ...config,
        files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, hash(bytes)])) };
      return { tool, files, manifest };
    });
    const installed = [], changed = [], skipped = [];
    for (const { tool, files, manifest } of plans) {
      if (!files) { skipped.push(`${tool} (not found on PATH)`); continue; }
      let modified = false;
      // The executable is published last, so a new launcher cannot start before
      // its literal Node path and dispatcher exist. A partial update fails closed.
      for (const name of [`${tool}.exe.nodepath`, `${tool}.exe.mjs`, `${tool}.exe`]) {
        modified = publish(directory, name, files[name], existing[tool].files[name]) || modified;
      }
      modified = publish(directory, manifestName(tool), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), existing[tool].record) || modified;
      const filename = path.join(shimDir, `${tool}.exe`);
      installed.push(filename); if (modified) changed.push(filename);
    }
    return { shimDir, installed, changed, skipped };
  });
}

export function uninstallWindowsShims({ shimDir = defaultDirectory() } = {}) {
  return withDirectory(shimDir, false, directory => {
    if (!directory) return [];
    const existing = Object.fromEntries(TOOLS.map(tool => [tool, inspectTool(directory, tool)]));
    const removed = [];
    for (const tool of TOOLS) {
      const state = existing[tool];
      if (!state.manifest) continue;
      for (const name of names(tool)) {
        const file = state.files[name];
        if (file) directory.removeFile(name, { expectedIdentity: file.identity, expectedBytes: file.bytes });
      }
      directory.removeFile(manifestName(tool), { expectedIdentity: state.record.identity, expectedBytes: state.record.bytes });
      removed.push(path.join(shimDir, `${tool}.exe`));
    }
    return removed;
  });
}

export function windowsShimStatus({ shimDir = defaultDirectory() } = {}) {
  return withDirectory(shimDir, false, directory => {
    const tools = {};
    for (const tool of TOOLS) {
      let installed = false, reason;
      try {
        const state = inspectTool(directory, tool);
        installed = Boolean(state.manifest && names(tool).every(name => state.files[name]));
      } catch (error) { reason = error.code || 'WINDOWS_SHIM_CONFLICT'; }
      tools[tool] = { installed, path: path.join(shimDir, `${tool}.exe`), ...(reason ? { reason } : {}) };
    }
    return { shimDir, tools, installed: Object.values(tools).some(tool => tool.installed), complete: Object.values(tools).every(tool => tool.installed) };
  }, { pin: false });
}
