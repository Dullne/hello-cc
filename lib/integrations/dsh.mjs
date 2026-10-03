import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CliError } from '../shared/errors.mjs';
import { withFileLock } from '../shared/file-lock.mjs';
import { commandPath } from '../cli-runtime.mjs';
import { shellQuoteArg } from '../format.mjs';

export const DSH_BASELINE_VERSION = '0.2.0-rc.2';
export const DSH_INSTALL_HINT = `npm install -g @deepseek-ai/dsh@${DSH_BASELINE_VERSION}`;
export const DSH_HOOK_EVENTS = Object.freeze([
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'
]);
const MANAGED_BY = 'hello-cc/dsh';
const ARTIFACTS = ['hooks.json', 'cordis.patch.yml', 'managed.json'];
const SESSION_MARKERS = new Set([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONVERSATION_ID', 'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT',
  'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_CONVERSATION_ID',
  'CODEX_PARENT_THREAD_ID', 'CODEX_PROJECT_DIR', 'CODEX_MANAGED_BY_NPM', 'CODEX_MANAGED_BY_BUN'
]);

function forbidden(file, reason) {
  return new CliError('DSH_CONFIG_CONFLICT',
    `Refusing to modify dsh integration at ${file}: ${reason}. Preserve or move the existing file, then run hcc dsh setup.`);
}

function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function sameObject(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function integrationPaths(ctx, create = false) {
  let root;
  try { root = fs.realpathSync(ctx.root); }
  catch { throw new CliError('BAD_ARGS', `Project root does not exist: ${ctx.root}`); }
  if (!fs.statSync(root).isDirectory()) throw new CliError('BAD_ARGS', `Project root is not a directory: ${root}`);
  const stateDir = path.join(root, '.hello-cc');
  const directory = path.join(stateDir, 'dsh');
  const parents = [];
  for (const dir of [root, stateDir, directory]) {
    let stat = lstat(dir);
    if (!stat && create) {
      try { fs.mkdirSync(dir, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      stat = lstat(dir);
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw forbidden(dir, 'expected an ordinary directory, found a symlink or other object');
    }
    if (stat) parents.push({ file: dir, stat });
  }
  return { root, directory, parents, hooksPath: path.join(directory, 'hooks.json'),
    patchPath: path.join(directory, 'cordis.patch.yml'), manifestPath: path.join(directory, 'managed.json') };
}

function assertParents(paths) {
  for (const parent of paths.parents) {
    const current = lstat(parent.file);
    if (!current?.isDirectory() || current.isSymbolicLink() || !sameObject(current, parent.stat)) {
      throw forbidden(parent.file, 'directory identity changed');
    }
  }
}

function readArtifact(paths, name) {
  assertParents(paths);
  const file = path.join(paths.directory, name);
  const stat = lstat(file);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw forbidden(file, 'expected an ordinary file with no symlink or hard-link alias');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!sameObject(fs.fstatSync(fd), stat)) throw forbidden(file, 'file identity changed');
    const content = fs.readFileSync(fd, 'utf8');
    if (!sameObject(lstat(file), stat)) throw forbidden(file, 'file identity changed');
    assertParents(paths);
    return { content, stat };
  } finally { fs.closeSync(fd); }
}

function jsonText(value) { return JSON.stringify(value, null, 2) + '\n'; }
function hash(content) { return createHash('sha256').update(content).digest('hex'); }

function generatedArtifacts(paths, options = {}, recorded = null) {
  const mode = options.mode || 'hooks';
  if (!['hooks', 'cordis', 'off'].includes(mode)) throw new CliError('BAD_ARGS', 'dsh mode must be hooks, cordis, or off');
  const hccBin = path.resolve(options.hccBin || commandPath());
  const nodeBin = path.resolve(options.nodeBin || process.execPath);
  const hookPrefix = `${shellQuoteArg(nodeBin)} ${shellQuoteArg(hccBin)} hook`;
  const hooks = {};
  for (const event of DSH_HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: 'command', command: `${hookPrefix} ${event.toLowerCase()} --provider dsh` }] }];
  }
  const hooksContent = jsonText({ _helloCc: { managedBy: MANAGED_BY, schema: 1 }, hooks });
  // JSON-quoted strings are valid YAML scalars, including spaces, quotes and newlines.
  // Omitting projectDir lets the official bridge use each session's own cwd.
  const pluginPath = recorded?.pluginPath || fileURLToPath(new URL('./dsh-cordis.mjs', import.meta.url));
  const pluginName = mode === 'cordis' ? pluginPath : '@deepseek-ai/dsh-hooks-claude-code';
  const patchContent = mode === 'off' ? '# Generated by hello-cc. Integration disabled.\n[]\n' : [
    '# Generated by hello-cc. Run hcc dsh setup to refresh; keep custom patches separate.',
    '- insert:',
    `    - id: hello-cc-dsh-${mode === 'cordis' ? 'cordis' : 'hooks'}`,
    `      name: ${JSON.stringify(pluginName)}`,
    '      config:',
    ...(mode === 'cordis' ? ['        maxContextChars: 16000', '        maxToolChars: 16000'] : [
      `        configPath: ${JSON.stringify(paths.hooksPath)}`, '        defaultTimeoutMs: 10000']),
    ''
  ].join('\n');
  const manifest = { managedBy: MANAGED_BY, schema: 1, baselineVersion: DSH_BASELINE_VERSION,
    root: paths.root, hccBin, nodeBin,
    ...(options.mode !== undefined ? { mode } : {}),
    ...(mode === 'cordis' && !recorded?.legacy ? { pluginPath } : {}),
    files: { 'hooks.json': hash(hooksContent), 'cordis.patch.yml': hash(patchContent) } };
  return { 'hooks.json': hooksContent, 'cordis.patch.yml': patchContent, 'managed.json': jsonText(manifest) };
}

function inspectArtifacts(paths, desired) {
  const existing = {};
  for (const name of ARTIFACTS) existing[name] = readArtifact(paths, name);
  let recorded = desired;
  if (existing['managed.json']) {
    let manifest;
    try { manifest = JSON.parse(existing['managed.json'].content); }
    catch { throw forbidden(paths.manifestPath, 'managed manifest is invalid JSON'); }
    if (manifest?.managedBy !== MANAGED_BY || manifest?.schema !== 1 ||
        manifest?.baselineVersion !== DSH_BASELINE_VERSION || manifest?.root !== paths.root ||
        (manifest.mode !== undefined && !['hooks', 'cordis', 'off'].includes(manifest.mode)) ||
        typeof manifest?.hccBin !== 'string' || !path.isAbsolute(manifest.hccBin) ||
        typeof manifest?.nodeBin !== 'string' || !path.isAbsolute(manifest.nodeBin) ||
        (manifest.pluginPath !== undefined && (typeof manifest.pluginPath !== 'string' || !path.isAbsolute(manifest.pluginPath)))) {
      throw forbidden(paths.manifestPath, 'managed manifest has foreign or unsupported ownership');
    }
    let pluginPath = manifest.pluginPath;
    if (manifest.mode === 'cordis' && pluginPath === undefined) {
      // Schema-1 manifests predate pluginPath. Recover their module location
      // only from an unchanged hash-bound overlay, then verify its full template.
      const overlay = existing['cordis.patch.yml'];
      if (overlay) {
        if (manifest.files?.['cordis.patch.yml'] !== hash(overlay.content)) {
          throw forbidden(paths.patchPath, 'managed Cordis overlay was edited');
        }
        const scalar = overlay.content.match(/^      name: (.+)$/m)?.[1];
        try { pluginPath = JSON.parse(scalar); } catch {}
        if (typeof pluginPath !== 'string' || !path.isAbsolute(pluginPath)) {
          throw forbidden(paths.patchPath, 'recorded Cordis module path is invalid');
        }
      } else if (path.basename(manifest.hccBin) === 'hcc.mjs' && path.basename(path.dirname(manifest.hccBin)) === 'bin') {
        pluginPath = path.resolve(path.dirname(manifest.hccBin), '../lib/integrations/dsh-cordis.mjs');
      } else {
        throw forbidden(paths.manifestPath, 'legacy Cordis module location cannot be established without its overlay');
      }
    }
    recorded = generatedArtifacts(paths, manifest, { pluginPath, legacy: manifest.pluginPath === undefined });
  }
  for (const name of ARTIFACTS) {
    if (existing[name] && existing[name].content !== recorded[name]) {
      throw forbidden(path.join(paths.directory, name), 'managed content was edited or belongs to another integration');
    }
  }
  const missing = ARTIFACTS.filter((name) => !existing[name]);
  const current = missing.length === 0 && ARTIFACTS.every((name) => existing[name].content === desired[name]);
  return { existing, missing, current };
}

function writeArtifact(paths, name, content, previous) {
  const file = path.join(paths.directory, name);
  const tmp = path.join(paths.directory, `.${name}.${randomUUID()}.tmp`);
  try {
    assertParents(paths);
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o600 });
    const current = readArtifact(paths, name);
    if (Boolean(current) !== Boolean(previous) || (current &&
        (!sameObject(current.stat, previous.stat) || current.content !== previous.content))) {
      throw forbidden(file, 'file changed during setup');
    }
    assertParents(paths);
    fs.renameSync(tmp, file);
  } finally {
    assertParents(paths);
    try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function selectedOptions(paths, options) {
  if (options.mode !== undefined) return options;
  const existing = readArtifact(paths, 'managed.json');
  if (!existing) return { ...options, mode: 'hooks' };
  try { return { ...options, mode: JSON.parse(existing.content).mode }; }
  catch { return options; } // Ownership/JSON errors are reported by inspectArtifacts.
}

export function ensureDshIntegration(ctx, options = {}) {
  const paths = integrationPaths(ctx, true);
  return withFileLock(paths.manifestPath, () => {
    options = selectedOptions(paths, options);
    const desired = generatedArtifacts(paths, options);
    const inspection = inspectArtifacts(paths, desired);
    const changed = [];
    for (const name of ARTIFACTS) {
      if (inspection.existing[name]?.content === desired[name]) continue;
      writeArtifact(paths, name, desired[name], inspection.existing[name]);
      changed.push(path.join(paths.directory, name));
    }
    return { root: paths.root, hooksPath: paths.hooksPath, patchPath: paths.patchPath,
      manifestPath: paths.manifestPath, ready: true, mode: options.mode || 'hooks', changed, baselineVersion: DSH_BASELINE_VERSION };
  }, { createParent: false });
}

export function inspectDshIntegration(ctx, options = {}) {
  try {
    const paths = integrationPaths(ctx);
    options = selectedOptions(paths, options);
    const inspection = inspectArtifacts(paths, generatedArtifacts(paths, options));
    return { root: paths.root, hooksPath: paths.hooksPath, patchPath: paths.patchPath,
      manifestPath: paths.manifestPath, ready: inspection.current, mode: options.mode || 'hooks',
      state: inspection.current ? (options.mode === 'off' ? 'disabled' : 'ready') : inspection.missing.length ? 'missing' : 'refresh-needed',
      missing: inspection.missing, baselineVersion: DSH_BASELINE_VERSION };
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return { root: path.resolve(ctx.root), ready: false, state: 'conflict',
      error: { code: error.code, message: error.message }, baselineVersion: DSH_BASELINE_VERSION };
  }
}

export function resolveDshBinary(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const candidates = options.dshBin
    ? [path.resolve(cwd, options.dshBin)]
    : String(env.PATH || '').split(path.delimiter).filter(Boolean).map((dir) => path.resolve(cwd, dir, 'dsh'));
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (!fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      return real;
    } catch {}
  }
  return null;
}

export function createDshEnvironment(env = process.env, options = {}) {
  const filtered = {};
  for (const name of Object.keys(env)) {
    if (name.startsWith('HCC_') || SESSION_MARKERS.has(name)) continue;
    if (env[name] !== undefined) filtered[name] = env[name];
  }
  if (options.dshHome) filtered.DSH_HOME = path.resolve(options.cwd || process.cwd(), options.dshHome);
  return filtered;
}

export async function launchDshWeb(ctx, options = {}) {
  const binary = resolveDshBinary({ ...options, cwd: ctx.cwd || process.cwd() });
  const location = options.dshBin ? `: ${options.dshBin}` : ' on PATH';
  if (!binary) throw new CliError('DSH_NOT_FOUND',
    `dsh executable not found${location}. Install it with: ${DSH_INSTALL_HINT}; or pass --dsh-bin /absolute/path/to/dsh.`);
  const setup = ensureDshIntegration(ctx, options);
  const env = createDshEnvironment(options.env || process.env, { dshHome: options.dshHome, cwd: ctx.cwd });
  const args = ['web', '--patch', setup.patchPath, ...(options.args || [])];
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: setup.root, env, stdio: options.stdio || 'inherit' });
    const handlers = new Map();
    const cleanup = () => {
      for (const signal of handlers.keys()) process.removeListener(signal, handlers.get(signal));
    };
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => { if (!child.killed) child.kill(signal); };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    child.once('error', (error) => {
      cleanup();
      reject(new CliError('DSH_LAUNCH_FAILED', `Could not launch dsh: ${error.message}`));
    });
    child.once('exit', (code, signal) => { cleanup(); resolve({ code, signal, binary, ...setup }); });
  });
}
