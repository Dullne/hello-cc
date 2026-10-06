import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { CliError } from '../shared/errors.mjs';
import { withFileLock } from '../shared/file-lock.mjs';
import { unsafeDirectoryAcl } from './project-trust.mjs';

const DIRECTORY_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const FILE_READ_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
const FILE_CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT |
  fs.constants.O_EXCL | fs.constants.O_NOFOLLOW;
const MANIFEST_NAME = '.project-root.json';
const LEGACY_MANIFEST_VERSION = 1;
const MANIFEST_VERSION = 2;
const GENERATION_VERSION = 2;
const GENERATION_NAME = /^[a-f0-9]{32}$/;
const DECIMAL_IDENTITY = /^(0|[1-9][0-9]*)$/;
const AUTHORITY_KINDS = new Set(['pending', 'fresh', 'migrated', 'purging', 'reset']);
const AUTHORITY_TRANSITIONS = {
  missing: new Set(['pending', 'migrated', 'purging']),
  pending: new Set(['fresh', 'migrated', 'purging']),
  fresh: new Set(['migrated', 'purging']),
  migrated: new Set(['purging']),
  purging: new Set(['reset']),
  reset: new Set(['fresh', 'migrated', 'purging'])
};

function forbidden(message) {
  return new CliError('PROJECT_PATH_FORBIDDEN', message);
}

function inspectError(error, description, target) {
  if (error instanceof CliError) return error;
  return forbidden(`Cannot inspect ${description}: ${target}`);
}

function ownerUid() {
  if (typeof process.getuid !== 'function' ||
      fs.constants.O_DIRECTORY === undefined || fs.constants.O_NOFOLLOW === undefined) {
    throw forbidden('Private project state requires POSIX ownership and no-follow file operations');
  }
  return BigInt(process.getuid());
}

function requestedRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw forbidden('Project root must be a non-empty path');
  }
  return path.resolve(root);
}

function canonicalProjectRoot(root, { allowMissing = false } = {}) {
  const requested = requestedRoot(root);
  let canonical;
  try {
    canonical = fs.realpathSync(requested);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      // A dangling symlink is an existing, invalid root rather than a missing one.
      try {
        if (fs.lstatSync(requested).isSymbolicLink()) {
          throw forbidden(`Project root is a dangling symlink: ${requested}`);
        }
      } catch (inspectionError) {
        if (inspectionError instanceof CliError) throw inspectionError;
        if (inspectionError?.code !== 'ENOENT') {
          throw inspectError(inspectionError, 'project root', requested);
        }
      }
      return { requested, canonical: requested, stat: null };
    }
    if (error?.code === 'ENOENT') {
      throw new CliError('PROJECT_NOT_REGISTERED', `Project root does not exist: ${requested}`);
    }
    throw inspectError(error, 'project root', requested);
  }

  let stat;
  try { stat = fs.statSync(canonical, { bigint: true }); }
  catch (error) { throw inspectError(error, 'project root', canonical); }
  if (!stat.isDirectory()) throw forbidden(`Project root is not a directory: ${requested}`);
  return { requested, canonical, stat };
}

function canonicalHome({ allowMissing = false } = {}) {
  const requested = path.resolve(os.homedir());
  try {
    const canonical = fs.realpathSync(requested);
    if (!fs.statSync(canonical).isDirectory()) throw forbidden(`Home is not a directory: ${requested}`);
    return canonical;
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') {
      try {
        fs.lstatSync(requested);
      } catch (inspectionError) {
        if (inspectionError?.code === 'ENOENT') return requested;
        throw inspectError(inspectionError, 'home directory', requested);
      }
      throw forbidden(`Home is an unresolved path: ${requested}`);
    }
    throw inspectError(error, 'home directory', requested);
  }
}

function statePath(canonicalRoot, home) {
  const hash = createHash('sha256').update(canonicalRoot).digest('hex');
  return path.join(home, '.hello-cc', 'projects', hash);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function modeOf(stat) {
  return Number(stat.mode & 0o7777n);
}

function inspectDirectory(target, description, {
  mode = null, tighten = false, allowReadOnlyPublic = false
} = {}) {
  let before;
  try { before = fs.lstatSync(target, { bigint: true }); }
  catch (error) { throw inspectError(error, description, target); }
  if (before.isSymbolicLink() || !before.isDirectory() || before.uid !== ownerUid()) {
    throw forbidden(`${description} must be a current-user-owned real directory: ${target}`);
  }
  let fd;
  try {
    fd = fs.openSync(target, DIRECTORY_FLAGS);
    let opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isDirectory() || !sameIdentity(before, opened) || opened.uid !== ownerUid() ||
        unsafeDirectoryAcl(target, opened)) {
      throw forbidden(`${description} changed during validation: ${target}`);
    }
    if (mode !== null && modeOf(opened) !== mode &&
        !(allowReadOnlyPublic && modeOf(opened) === 0o755)) {
      if (!tighten || (modeOf(opened) & 0o022) !== 0) {
        throw forbidden(`${description} must have mode ${mode.toString(8)}: ${target}`);
      }
      fs.fchmodSync(fd, mode);
      opened = fs.fstatSync(fd, { bigint: true });
      if (modeOf(opened) !== mode) {
        throw forbidden(`Cannot secure ${description}: ${target}`);
      }
    }
    const after = fs.lstatSync(target, { bigint: true });
    if (after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw forbidden(`${description} changed during validation: ${target}`);
    }
    return opened;
  } catch (error) {
    throw inspectError(error, description, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function inspectHomeAncestry(home) {
  const components = [];
  for (let current = home;; current = path.dirname(current)) {
    components.push(current);
    if (path.dirname(current) === current) break;
  }
  components.reverse();
  const uid = ownerUid();
  for (const component of components) {
    let stat;
    try { stat = fs.lstatSync(component, { bigint: true }); }
    catch (error) { throw inspectError(error, 'home ancestor', component); }
    const permissions = modeOf(stat);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0n) ||
        unsafeDirectoryAcl(component, stat)) {
      throw forbidden(`Home ancestor must be a trusted real directory: ${component}`);
    }
    // Sticky directories such as /tmp prevent another UID from renaming an
    // owned child. Their child is checked in the next iteration.
    if ((permissions & 0o022) !== 0 && (permissions & 0o1000) === 0) {
      throw forbidden(`Home ancestor is writable by another user: ${component}`);
    }
    let fd;
    try {
      fd = fs.openSync(component, DIRECTORY_FLAGS);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isDirectory() || !sameIdentity(stat, opened) || opened.uid !== stat.uid) {
        throw forbidden(`Home ancestor changed during validation: ${component}`);
      }
    } catch (error) {
      throw inspectError(error, 'home ancestor', component);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
}

function optionalDirectory(target, description, {
  create, mode, tighten = false, allowReadOnlyPublic = false
}) {
  let exists;
  try { fs.lstatSync(target); exists = true; }
  catch (error) {
    if (error?.code !== 'ENOENT') throw inspectError(error, description, target);
    exists = false;
  }
  if (!exists && !create) return false;
  if (!exists) {
    try { fs.mkdirSync(target, { mode }); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw forbidden(`Cannot create ${description}: ${target}`);
    }
  }
  inspectDirectory(target, description, {
    mode, tighten: create && tighten, allowReadOnlyPublic: !create && allowReadOnlyPublic
  });
  return true;
}

function expectedManifest(root) {
  const birthtimeNs = projectBirthtime(root);
  if (!birthtimeNs) throw forbidden(`Project directory has no stable birth time: ${root.canonical}`);
  return {
    version: MANIFEST_VERSION,
    canonicalRoot: root.canonical,
    dev: root.stat.dev.toString(),
    ino: root.stat.ino.toString(),
    birthtimeNs
  };
}

function projectBirthtime(project) {
  const birthtimeNs = project.stat?.birthtimeNs;
  return typeof birthtimeNs === 'bigint' && birthtimeNs > 0n ? birthtimeNs.toString() : null;
}

function validBirthtime(value) {
  return typeof value === 'string' && /^[1-9][0-9]*$/.test(value);
}

function generationParent(base) {
  return `${base}.generations`;
}

function validGenerationMarker(value, canonical, id) {
  return value?.version === GENERATION_VERSION && value.generation === id &&
    value.canonicalRoot === canonical && DECIMAL_IDENTITY.test(value.dev) &&
    DECIMAL_IDENTITY.test(value.ino) && validBirthtime(value.birthtimeNs) &&
    AUTHORITY_KINDS.has(value.kind);
}

function generationBinding(project, home) {
  if (!project.stat) return null;
  const base = statePath(project.canonical, home);
  const parent = generationParent(base);
  let entries;
  try {
    fs.lstatSync(parent);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw inspectError(error, 'private project generations', parent);
  }
  inspectDirectory(parent, 'private project generations', { mode: 0o700 });
  try { entries = fs.readdirSync(parent); }
  catch (error) { throw inspectError(error, 'private project generations', parent); }
  if (entries.length > 256) throw forbidden(`Too many private project generations: ${parent}`);
  const names = new Set(entries);
  const markers = new Set();
  let matched = null;
  for (const name of entries) {
    if (!name.endsWith('.authority.json')) continue;
    const id = name.slice(0, -'.authority.json'.length);
    if (!GENERATION_NAME.test(id)) throw forbidden(`Invalid private project generation: ${parent}`);
    markers.add(id);
    const actual = readManifest(path.join(parent, name));
    if (!validGenerationMarker(actual, project.canonical, id)) {
      throw forbidden(`Invalid private project generation marker: ${path.join(parent, name)}`);
    }
    if (actual.dev === project.stat.dev.toString() && actual.ino === project.stat.ino.toString() &&
        actual.birthtimeNs === projectBirthtime(project)) {
      if (matched) throw forbidden(`Ambiguous private project generation: ${project.canonical}`);
      matched = { directory: path.join(parent, id), marker: path.join(parent, name),
        generation: id, authority: actual, parent };
    }
  }
  for (const name of entries) {
    if (GENERATION_NAME.test(name)) {
      if (!markers.has(name)) throw forbidden(`Unbound private project generation: ${path.join(parent, name)}`);
      const entry = fs.lstatSync(path.join(parent, name));
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw forbidden(`Invalid private project generation directory: ${path.join(parent, name)}`);
      }
    } else if (!name.endsWith('.authority.json')) {
      throw forbidden(`Unexpected private project generation entry: ${path.join(parent, name)}`);
    }
  }
  const fence = readManifest(`${base}.authority.json`);
  if (fence?.version !== GENERATION_VERSION ||
      !['legacy-v1', 'legacy-v2'].includes(fence.fence) ||
      fence.canonicalRoot !== project.canonical || !DECIMAL_IDENTITY.test(fence.dev) ||
      !DECIMAL_IDENTITY.test(fence.ino) || !AUTHORITY_KINDS.has(fence.kind) ||
      (fence.fence === 'legacy-v1' ? fence.birthtimeNs !== null
        : !validBirthtime(fence.birthtimeNs))) {
    throw forbidden(`Private project generation fence is missing or invalid: ${base}`);
  }
  return matched;
}

function projectStateBinding(project, home) {
  return generationBinding(project, home) || {
    directory: statePath(project.canonical, home),
    marker: `${statePath(project.canonical, home)}.authority.json`,
    generation: null,
    parent: path.join(home, '.hello-cc', 'projects')
  };
}

function expectedGenerationManifest(project, generation) {
  const birthtimeNs = projectBirthtime(project);
  if (!birthtimeNs) throw forbidden(`Project directory has no stable birth time: ${project.canonical}`);
  return { version: GENERATION_VERSION, canonicalRoot: project.canonical,
    dev: project.stat.dev.toString(), ino: project.stat.ino.toString(),
    birthtimeNs, generation };
}

function expectedBindingManifest(project, binding) {
  return binding.generation
    ? expectedGenerationManifest(project, binding.generation)
    : expectedManifest(project);
}

function readManifest(manifestPath) {
  let before;
  try { before = fs.lstatSync(manifestPath, { bigint: true }); }
  catch (error) { throw inspectError(error, 'project state manifest', manifestPath); }
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== ownerUid() ||
      before.nlink !== 1n || modeOf(before) !== 0o600 || before.size > 16384n ||
      unsafeDirectoryAcl(manifestPath, before)) {
    throw forbidden(`Project state manifest must be a private regular file: ${manifestPath}`);
  }
  let fd;
  try {
    fd = fs.openSync(manifestPath, FILE_READ_FLAGS);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || !sameIdentity(before, opened) || opened.nlink !== 1n ||
        opened.uid !== ownerUid() || modeOf(opened) !== 0o600 || opened.size > 16384n ||
        unsafeDirectoryAcl(manifestPath, opened)) {
      throw forbidden(`Project state manifest changed during validation: ${manifestPath}`);
    }
    const data = fs.readFileSync(fd, { encoding: 'utf8' });
    const after = fs.lstatSync(manifestPath, { bigint: true });
    if (after.isSymbolicLink() || !sameIdentity(opened, after)) {
      throw forbidden(`Project state manifest changed during validation: ${manifestPath}`);
    }
    try { return JSON.parse(data); }
    catch { throw forbidden(`Invalid project state manifest: ${manifestPath}`); }
  } catch (error) {
    throw inspectError(error, 'project state manifest', manifestPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function ensureManifest(directory, root, create, binding) {
  const manifestPath = path.join(directory, MANIFEST_NAME);
  let exists;
  try { fs.lstatSync(manifestPath); exists = true; }
  catch (error) {
    if (error?.code !== 'ENOENT') throw inspectError(error, 'project state manifest', manifestPath);
    exists = false;
  }
  if (!exists) {
    if (!create || fs.readdirSync(directory).length !== 0) {
      throw forbidden(`Project state directory has no binding manifest: ${directory}`);
    }
    const temporary = path.join(path.dirname(binding.parent),
      `.${path.basename(directory)}.manifest-tmp-${randomBytes(16).toString('hex')}`);
    let fd;
    try {
      fd = fs.openSync(temporary, FILE_CREATE_FLAGS, 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(expectedBindingManifest(root, binding))}\n`);
      fs.fchmodSync(fd, 0o600);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, manifestPath);
      fsyncDirectory(directory);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw inspectError(error, 'project state manifest', manifestPath);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* A private temp is inert. */ }
    }
  }
  const actual = readManifest(manifestPath);
  const expected = expectedBindingManifest(root, binding);
  if (!binding.generation && actual?.version === LEGACY_MANIFEST_VERSION) {
    throw new CliError('STATE_BINDING_UPGRADE_REQUIRED',
      `Historical private project state requires explicit offline identity upgrade: ${directory}`);
  }
  if (actual?.version !== expected.version || actual.canonicalRoot !== expected.canonicalRoot ||
      actual.dev !== expected.dev || actual.ino !== expected.ino ||
      (!binding.generation && actual.birthtimeNs !== expected.birthtimeNs) ||
      (binding.generation && (actual.birthtimeNs !== expected.birthtimeNs ||
        actual.generation !== expected.generation))) {
    throw forbidden(`Project root identity differs from private state binding: ${root.canonical}. ` +
      'Back up the old private store and authority marker, stop all writers, and review both root identities ' +
      'before manual recovery; automatic rebinding is refused.');
  }
}

function assertProjectUnchanged(root) {
  let current;
  try { current = canonicalProjectRoot(root.requested); }
  catch { throw forbidden(`Project root changed during private state validation: ${root.requested}`); }
  if (current.canonical !== root.canonical || !sameIdentity(current.stat, root.stat) ||
      projectBirthtime(current) !== projectBirthtime(root)) {
    throw forbidden(`Project root changed during private state validation: ${root.requested}`);
  }
}

// Path derivation is read-only. A missing project root gets a lexical absolute
// path solely for hashing; state access always requires an existing directory.
export function privateProjectStateDir(root) {
  const project = canonicalProjectRoot(root, { allowMissing: true });
  return projectStateBinding(project, canonicalHome({ allowMissing: true })).directory;
}

export function privateProjectAuthorityPath(root) {
  const project = canonicalProjectRoot(root, { allowMissing: true });
  return projectStateBinding(project, canonicalHome({ allowMissing: true })).marker;
}

export function privateProjectStateManifest(root) {
  const project = canonicalProjectRoot(root);
  return expectedBindingManifest(project, projectStateBinding(project, canonicalHome()));
}

export function privateProjectGenerationFromPath(value) {
  if (typeof value !== 'string' || !value) return null;
  return value.match(/(?:^|[/\\])[a-f0-9]{64}\.generations[/\\]([a-f0-9]{32})(?:[/\\]|$)/)?.[1] || null;
}

function upgradeReceipt(project, kind) {
  return createHash('sha256').update(JSON.stringify({
    operation: 'private-binding-v1-to-v2',
    canonicalRoot: project.canonical,
    dev: project.stat.dev.toString(),
    ino: project.stat.ino.toString(),
    birthtimeNs: projectBirthtime(project),
    kind
  })).digest('hex');
}

function inspectBindingUpgrade(project, home) {
  inspectHomeAncestry(home);
  const global = path.join(home, '.hello-cc');
  const projects = path.join(global, 'projects');
  if (!optionalDirectory(global, 'global state directory', {
    create: false, mode: 0o700, allowReadOnlyPublic: true
  }) || !optionalDirectory(projects, 'private projects directory', {
    create: false, mode: 0o700
  })) return { status: 'not-required', receipt: null };
  const base = statePath(project.canonical, home);
  const marker = `${base}.authority.json`;
  let markerExists = false;
  try { fs.lstatSync(marker); markerExists = true; }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!markerExists) {
    try { fs.lstatSync(base); }
    catch (storeError) {
      if (storeError?.code === 'ENOENT') return { status: 'not-required', receipt: null };
      throw inspectError(storeError, 'private project state', base);
    }
    throw forbidden(`Historical private project state has no authority marker: ${base}`);
  }
  const authority = readManifest(marker);
  inspectDirectory(base, 'historical private project state', { mode: 0o700 });
  if (authority.version === LEGACY_MANIFEST_VERSION && authority.kind === 'pending') {
    let manifestPresent = false;
    try { fs.lstatSync(path.join(base, MANIFEST_NAME)); manifestPresent = true; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw inspectError(error, 'project state manifest', base);
    }
    if (!manifestPresent) {
      throw new CliError('STATE_BINDING_MANUAL_RECOVERY_REQUIRED',
        `Historical v1 initialization has no committed root manifest: ${base}. ` +
        'Cold-drain writers, back up the root, private directory and authority marker, ' +
        'and inspect any project-local legacy state before manual recovery. ' +
        'Do not purge or fabricate a v2 marker.');
    }
  }
  const manifest = readManifest(path.join(base, MANIFEST_NAME));
  const identity = expectedManifest(project);
  const kind = authority.kind ?? 'migrated';
  if (!['fresh', 'migrated'].includes(kind) ||
      authority.canonicalRoot !== project.canonical ||
      authority.dev !== identity.dev || authority.ino !== identity.ino ||
      manifest.canonicalRoot !== project.canonical ||
      manifest.dev !== identity.dev || manifest.ino !== identity.ino) {
    throw forbidden(`Cannot assert that current root owns historical private state: ${base}`);
  }
  if (authority.version === MANIFEST_VERSION && authority.fence === undefined &&
      manifest.version === MANIFEST_VERSION && authority.birthtimeNs === identity.birthtimeNs &&
      manifest.birthtimeNs === identity.birthtimeNs) {
    return { status: 'already-current', receipt: null, stateDir: base };
  }
  const receipt = upgradeReceipt(project, kind);
  const historical = authority.version === LEGACY_MANIFEST_VERSION &&
    manifest.version === LEGACY_MANIFEST_VERSION;
  const pending = authority.version === MANIFEST_VERSION &&
    authority.fence === 'upgrade-pending' && authority.upgradeReceipt === receipt &&
    authority.birthtimeNs === identity.birthtimeNs &&
    (manifest.version === LEGACY_MANIFEST_VERSION ||
      (manifest.version === MANIFEST_VERSION && manifest.birthtimeNs === identity.birthtimeNs));
  if (!historical && !pending) {
    throw forbidden(`Private binding upgrade state needs manual recovery: ${base}`);
  }
  return {
    status: pending ? 'pending' : 'required', receipt, stateDir: base,
    canonicalRoot: project.canonical,
    rootIdentity: { dev: identity.dev, ino: identity.ino,
      birthtimeNs: identity.birthtimeNs },
    warning: 'Receipt records current filesystem metadata, not proof that this root is historical A. '
      + 'Proceed only after verifying A independently and cold-draining every old writer.'
  };
}

export function inspectPrivateProjectBindingUpgrade(root) {
  const project = canonicalProjectRoot(root);
  return inspectBindingUpgrade(project, canonicalHome());
}

export function upgradePrivateProjectBinding(root, {
  confirmedOffline = false, confirmedHistoricalRoot = false,
  expectedReceipt = null, assertOffline = null
} = {}) {
  if (!confirmedOffline || !confirmedHistoricalRoot ||
      typeof expectedReceipt !== 'string' || !/^[a-f0-9]{64}$/.test(expectedReceipt) ||
      typeof assertOffline !== 'function') {
    throw new CliError('STATE_BINDING_UPGRADE_CONFIRMATION_REQUIRED',
      'Private binding upgrade requires --offline, --yes, --assert-historical-root and an exact inspection receipt');
  }
  const project = canonicalProjectRoot(root);
  const original = expectedManifest(project);
  return withPrivateProjectStateTransition(root, ({ projects, home }) => {
    assertFullProjectIdentity(project);
    const inspected = inspectBindingUpgrade(project, home);
    if (inspected.status === 'already-current' || inspected.status === 'not-required') return inspected;
    if (inspected.receipt !== expectedReceipt ||
        original.birthtimeNs !== inspected.rootIdentity.birthtimeNs) {
      throw new CliError('STATE_BINDING_UPGRADE_RECEIPT_MISMATCH',
        'Private binding inspection receipt or root identity changed; inspect again before upgrading');
    }
    if (assertOffline({ phase: 'before', stateDir: inspected.stateDir }) !== true) {
      throw new CliError('STATE_BINDING_UPGRADE_OFFLINE_REQUIRED',
        'Cannot establish cold-drained private state');
    }
    const marker = `${inspected.stateDir}.authority.json`;
    const manifestPath = path.join(inspected.stateDir, MANIFEST_NAME);
    let authority = readManifest(marker);
    if (inspected.status === 'required') {
      publishPrivateManifest(marker, { ...original, kind: authority.kind ?? 'migrated',
        fence: 'upgrade-pending', upgradeReceipt: expectedReceipt }, projects, authority);
      authority = readManifest(marker);
    }
    // Once the fence is durable, v1 readers reject the store. A crash in this
    // gap leaves a retryable pending state; v2 readers also reject it.
    const manifest = readManifest(manifestPath);
    if (manifest.version === LEGACY_MANIFEST_VERSION) {
      publishPrivateManifest(manifestPath, original, inspected.stateDir, manifest);
    }
    assertFullProjectIdentity(project);
    if (assertOffline({ phase: 'after', stateDir: inspected.stateDir }) !== true) {
      throw new CliError('STATE_BINDING_UPGRADE_OFFLINE_REQUIRED',
        'Private binding remains fenced because offline evidence changed');
    }
    publishPrivateManifest(marker, { ...original, kind: authority.kind }, projects, authority);
    assertFullProjectIdentity(project);
    return { status: 'upgraded', stateDir: inspected.stateDir,
      canonicalRoot: project.canonical, rootIdentity: inspected.rootIdentity };
  });
}

export function inspectPrivateProjectAuthority(root) {
  const project = canonicalProjectRoot(root);
  const binding = projectStateBinding(project, canonicalHome());
  const marker = binding.marker;
  try { fs.lstatSync(marker); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw inspectError(error, 'project authority marker', marker);
  }
  const actual = readManifest(marker);
  const expected = expectedBindingManifest(project, binding);
  if (!binding.generation && actual?.version === LEGACY_MANIFEST_VERSION) {
    throw new CliError('STATE_BINDING_UPGRADE_REQUIRED',
      `Historical private project state requires explicit offline identity upgrade: ${marker}`);
  }
  const valid = binding.generation
    ? actual?.version === expected.version && actual?.generation === expected.generation &&
      actual?.birthtimeNs === expected.birthtimeNs
    : actual?.version === expected.version && actual?.birthtimeNs === expected.birthtimeNs &&
      (actual.fence === undefined || actual.fence === 'legacy-v2');
  if (!valid || actual.canonicalRoot !== expected.canonicalRoot ||
      actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw forbidden(`Project authority marker differs from project root: ${marker}. ` +
      'Back up the old private store and authority marker, stop all writers, and review both root identities ' +
      'before manual recovery; automatic purge or rebinding is refused.');
  }
  // Markers from earlier releases were written only by offline migration.
  const kind = actual.kind ?? 'migrated';
  if (!AUTHORITY_KINDS.has(kind)) {
    throw forbidden(`Invalid project authority marker kind: ${marker}`);
  }
  return kind;
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, DIRECTORY_FLAGS);
  try { fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function publishPrivateManifest(marker, contents, parent, expected = null) {
  const temporary = path.join(path.dirname(parent),
    `.${path.basename(marker)}.tmp-${randomBytes(16).toString('hex')}`);
  let fd;
  try {
    fd = fs.openSync(temporary, FILE_CREATE_FLAGS, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(contents)}\n`);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (expected && JSON.stringify(readManifest(marker)) !== JSON.stringify(expected)) {
      throw forbidden(`Private project marker changed during publication: ${marker}`);
    }
    fs.renameSync(temporary, marker);
    fsyncDirectory(parent);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* An inert private temp is safe to leave. */ }
  }
}

function assertFullProjectIdentity(project, selected = null) {
  const current = canonicalProjectRoot(project.requested);
  if (current.canonical !== project.canonical || !sameIdentity(current.stat, project.stat) ||
      projectBirthtime(current) !== projectBirthtime(project) ||
      (selected && (selected.canonical !== project.canonical ||
        selected.identity?.dev !== project.stat.dev.toString() ||
        selected.identity?.ino !== project.stat.ino.toString() ||
        selected.identity?.birthtimeNs !== projectBirthtime(project)))) {
    throw forbidden(`Project root changed during private generation selection: ${project.requested}`);
  }
}

// A replacement root gets a separate store only after an explicit selection.
// The v2 fence at the v1 pathname makes older binaries reject *both* roots,
// while retaining A's original directory and manifest byte-for-byte.
export function provisionPrivateProjectGeneration(root, { expectedIdentity = null } = {}) {
  const project = canonicalProjectRoot(root);
  // Refuse unknown creation times before fencing an old binding or creating
  // generation records. Zero is an unavailable value, not a stable identity.
  expectedManifest(project);
  assertFullProjectIdentity(project, expectedIdentity);
  const home = canonicalHome();
  const base = statePath(project.canonical, home);
  return withPrivateProjectStateTransition(project.requested, ({ projects }) => {
    assertFullProjectIdentity(project, expectedIdentity);
    const existing = generationBinding(project, home);
    if (existing) return existing.directory;
    const marker = `${base}.authority.json`;
    let markerExists = false;
    try { fs.lstatSync(marker); markerExists = true; }
    catch (error) { if (error?.code !== 'ENOENT') throw inspectError(error, 'project authority marker', marker); }
    if (!markerExists) {
      try { fs.lstatSync(base); }
      catch (error) { if (error?.code === 'ENOENT') return null; throw inspectError(error, 'private project state', base); }
      throw forbidden(`Historical private project state has no authority marker: ${base}`);
    }
    let old;
    old = readManifest(marker);
    if (![LEGACY_MANIFEST_VERSION, GENERATION_VERSION].includes(old.version) ||
        (old.version === GENERATION_VERSION &&
          ((old.fence && !['legacy-v1', 'legacy-v2'].includes(old.fence)) ||
            (old.fence !== 'legacy-v1' && !validBirthtime(old.birthtimeNs)))) ||
        old.canonicalRoot !== project.canonical ||
        !DECIMAL_IDENTITY.test(old.dev) || !DECIMAL_IDENTITY.test(old.ino) ||
        !['fresh', 'migrated'].includes(old.version === LEGACY_MANIFEST_VERSION
          ? old.kind ?? 'migrated' : old.kind)) {
      throw forbidden(`Existing private project authority requires recovery: ${marker}`);
    }
    if (old.version === LEGACY_MANIFEST_VERSION) {
      throw new CliError('STATE_BINDING_UPGRADE_REQUIRED',
        `Historical v1 private state must be upgraded before selecting a replacement root: ${marker}. ` +
        'Restore and independently confirm historical A at this canonical path, cold-drain every writer, ' +
        'run migrate-state --inspect-private-binding, then migrate-state --upgrade-private-binding ' +
        '--offline --yes --assert-historical-root --expect-receipt=SHA256, and only then select B. ' +
        'Matching dev/ino alone does not prove the current root is A.');
    }
    if (old.fence === 'legacy-v1') {
      throw new CliError('STATE_BINDING_MANUAL_RECOVERY_REQUIRED',
        `A historical v1 store was already fenced without a saved root birth time: ${marker}. ` +
        'Preserve both stores, cold-drain writers, and review the original A root and generation records ' +
        'before manual recovery; further automatic provisioning is refused.');
    }
    if (old.dev === project.stat.dev.toString() && old.ino === project.stat.ino.toString()) {
      if (old.birthtimeNs === projectBirthtime(project) && old.fence !== 'legacy-v1') {
        return null; // The fully identified original v2 root is still selected.
      }
      if (old.birthtimeNs === null) {
        throw forbidden(`Historical project identity is ambiguous after fencing: ${project.canonical}`);
      }
    }
    inspectDirectory(base, 'historical private project state', { mode: 0o700 });
    const oldManifest = readManifest(path.join(base, MANIFEST_NAME));
    if (oldManifest.version !== MANIFEST_VERSION || oldManifest.canonicalRoot !== old.canonicalRoot ||
        oldManifest.dev !== old.dev || oldManifest.ino !== old.ino ||
        oldManifest.birthtimeNs !== old.birthtimeNs) {
      throw forbidden(`Historical private project state does not match its authority: ${base}`);
    }
    if (!old.fence) {
      publishPrivateManifest(marker, { ...old, fence: 'legacy-v2' }, projects, old);
    }
    const parent = generationParent(base);
    optionalDirectory(parent, 'private project generations', {
      create: true, mode: 0o700, tighten: true
    });
    fsyncDirectory(projects);
    const id = randomBytes(16).toString('hex');
    const generationMarker = path.join(parent, `${id}.authority.json`);
    if (fs.existsSync(generationMarker) || fs.existsSync(path.join(parent, id))) {
      throw forbidden(`Private project generation identifier already exists: ${id}`);
    }
    publishPrivateManifest(generationMarker,
      { ...expectedGenerationManifest(project, id), kind: 'pending' }, parent);
    assertFullProjectIdentity(project, expectedIdentity);
    return path.join(parent, id);
  });
}

function writePrivateProjectAuthorityKind(project, home, projects, kind) {
  if (!AUTHORITY_KINDS.has(kind)) throw forbidden(`Invalid project authority kind: ${kind}`);
  const binding = projectStateBinding(project, home);
  const marker = binding.marker;
  const current = inspectPrivateProjectAuthority(project.canonical);
  if (current === kind) return marker;
  if (!AUTHORITY_TRANSITIONS[current ?? 'missing']?.has(kind)) {
    throw forbidden(`Invalid project authority transition ${current ?? 'missing'} -> ${kind}: ${marker}`);
  }
  const previous = current === null ? null : readManifest(marker);
  const manifest = binding.generation
    ? expectedGenerationManifest(project, binding.generation)
    : { ...expectedManifest(project), ...(previous?.fence ? { fence: previous.fence } : {}) };
  const contents = `${JSON.stringify({ ...manifest, kind })}\n`;
  const temporary = path.join(path.dirname(binding.parent),
    `.${path.basename(marker)}.tmp-${randomBytes(16).toString('hex')}`);
  let fd;
  try {
    fd = fs.openSync(temporary, FILE_CREATE_FLAGS, 0o600);
    fs.writeFileSync(fd, contents);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    if (inspectPrivateProjectAuthority(project.canonical) !== current) {
      throw forbidden(`Project authority marker changed during update: ${marker}`);
    }
    // Even first publication is atomic: an interrupted writer only leaves an
    // inert temporary, never a truncated authority marker at the final name.
    fs.renameSync(temporary, marker);
  } catch (error) {
    throw inspectError(error, 'project authority marker', marker);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* A private temp is inert. */ }
  }
  fsyncDirectory(binding.parent);
  assertProjectUnchanged(project);
  return marker;
}

// Every operation that can establish, replace, or delete a private binding
// uses this one lock domain. The callback is synchronous and must not acquire
// the same transition lock again.
export function withPrivateProjectStateTransition(root, fn) {
  if (typeof fn !== 'function') throw new TypeError('private state transition requires a callback');
  const project = canonicalProjectRoot(root);
  const home = canonicalHome();
  inspectHomeAncestry(home);
  const global = path.join(home, '.hello-cc');
  const projects = path.join(global, 'projects');
  optionalDirectory(global, 'global state directory', {
    create: true, mode: 0o700, tighten: true
  });
  optionalDirectory(projects, 'private projects directory', {
    create: true, mode: 0o700, tighten: true
  });
  const legacyDirectory = statePath(project.canonical, home);
  return withFileLock(`${legacyDirectory}.transition`, () => {
    inspectHomeAncestry(home);
    inspectDirectory(global, 'global state directory', { mode: 0o700 });
    inspectDirectory(projects, 'private projects directory', { mode: 0o700 });
    assertProjectUnchanged(project);
    const directory = projectStateBinding(project, home).directory;
    const result = fn({
      directory, projects, project, home,
      authorityKind: () => inspectPrivateProjectAuthority(project.canonical),
      setAuthorityKind: (kind) => writePrivateProjectAuthorityKind(project, home, projects, kind)
    });
    assertProjectUnchanged(project);
    return result;
  }, { createParent: false, timeoutMs: 300000 });
}

export function privateStateBaseDir() {
  return path.join(canonicalHome({ allowMissing: true }), '.hello-cc');
}

// Global runtime pointers and the project registry share this parent. Check
// it even when no project has been routed to the private project store.
export function validatedGlobalStateDir() {
  const home = canonicalHome();
  inspectHomeAncestry(home);
  const global = path.join(home, '.hello-cc');
  optionalDirectory(global, 'global state directory', {
    create: false, mode: 0o700, allowReadOnlyPublic: true
  });
  return global;
}

export function ensurePrivateGlobalSubdirectory(name, { create = true } = {}) {
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    throw forbidden(`Invalid global state subdirectory: ${name}`);
  }
  const home = canonicalHome();
  inspectHomeAncestry(home);
  const global = path.join(home, '.hello-cc');
  if (!optionalDirectory(global, 'global state directory', {
    create, mode: 0o700, tighten: create, allowReadOnlyPublic: !create
  })) return null;
  const directory = path.join(global, name);
  if (!optionalDirectory(directory, 'global state subdirectory', {
    create, mode: 0o700, tighten: create
  })) return null;
  return directory;
}

function inspectPrivateProjectStateDir(project, home, create, setAuthorityKind = null) {
  inspectHomeAncestry(home);
  const global = path.join(home, '.hello-cc');
  const projects = path.join(global, 'projects');
  const binding = projectStateBinding(project, home);
  const directory = binding.directory;

  // A pre-existing 0755 global directory can be read without mutation. Only
  // create mode may tighten it, and writable-by-others directories are rejected.
  if (!optionalDirectory(global, 'global state directory', {
    create: Boolean(create), mode: 0o700, tighten: true,
    allowReadOnlyPublic: true
  })) return null;
  if (!optionalDirectory(projects, 'private projects directory', {
    create: Boolean(create), mode: 0o700, tighten: true
  })) return null;
  const authority = inspectPrivateProjectAuthority(project.canonical);
  let directoryExists = false;
  try { fs.lstatSync(directory); directoryExists = true; }
  catch (error) {
    if (error?.code !== 'ENOENT') throw inspectError(error, 'private project state directory', directory);
  }
  if (authority === 'purging' || (authority === 'reset' && directoryExists)) {
    throw new CliError('STATE_PURGE_INCOMPLETE',
      `Private project state purge is incomplete: ${directory}. Retry uninstall --purge --yes before use.`);
  }
  if ((authority === 'fresh' || authority === 'migrated') && !directoryExists) {
    throw new CliError('STATE_AUTHORITY_MISSING',
      `Previously established private project state is missing: ${directory}. Restore it from backup; ` +
      'if the legacy source still exists, stop all old writers and run ' +
      'hcc --root DIR migrate-state --offline --yes; otherwise run ' +
      'hcc --root DIR uninstall --purge --yes to explicitly reset the missing state.');
  }
  let manifestExists = false;
  if (directoryExists) {
    try { fs.lstatSync(path.join(directory, MANIFEST_NAME)); manifestExists = true; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw inspectError(error, 'project state manifest', directory);
    }
  }
  if (manifestExists && authority === null && !binding.generation &&
      readManifest(path.join(directory, MANIFEST_NAME)).version === LEGACY_MANIFEST_VERSION) {
    throw new CliError('STATE_BINDING_UPGRADE_REQUIRED',
      `Markerless historical private state requires reviewed offline recovery: ${directory}`);
  }
  if (create && !manifestExists) {
    // Resolver callers also check the legacy source. Repeat at the actual
    // transition boundary: a concurrent purge can invalidate their earlier
    // choice to finish an interrupted initialization.
    const legacy = path.join(project.canonical, '.hello-cc');
    try {
      const entry = fs.lstatSync(legacy);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw forbidden(`Legacy project state is not a real directory: ${legacy}`);
      }
      throw new CliError('STATE_MIGRATION_REQUIRED',
        `Legacy project state requires an offline migration before use: ${legacy}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (create && authority === null) {
    setAuthorityKind('pending');
  }
  if (!optionalDirectory(directory, 'private project state directory', {
    create: Boolean(create), mode: 0o700, tighten: true
  })) return null;

  ensureManifest(directory, project, Boolean(create), binding);
  if (create && (authority === null || authority === 'pending' || authority === 'reset')) {
    fsyncDirectory(binding.parent);
    setAuthorityKind('fresh');
  }
  assertProjectUnchanged(project);
  return directory;
}

export function ensurePrivateProjectStateDir(root, { create = false } = {}) {
  if (create) {
    return withPrivateProjectStateTransition(root, ({ project, home, setAuthorityKind }) =>
      inspectPrivateProjectStateDir(project, home, true, setAuthorityKind));
  }
  return inspectPrivateProjectStateDir(canonicalProjectRoot(root), canonicalHome(), false);
}

// The purging marker is a durable intent record. If deletion is interrupted,
// normal state access stays closed and an explicit purge retry completes it.
export function purgePrivateProjectState(root) {
  return withPrivateProjectStateTransition(root, ({ directory, authorityKind, setAuthorityKind }) => {
    // The directory may be partially deleted after an earlier crash, so its
    // manifest need not remain. Its private ownership and no-follow identity
    // are still required before recursive deletion.
    let exists = false;
    try { fs.lstatSync(directory); exists = true; }
    catch (error) {
      if (error?.code !== 'ENOENT') throw inspectError(error, 'private project state directory', directory);
    }
    if (exists) inspectDirectory(directory, 'private project state directory', { mode: 0o700 });
    authorityKind();
    setAuthorityKind('purging');
    fs.rmSync(directory, { recursive: true, force: true });
    fsyncDirectory(path.dirname(directory));
    setAuthorityKind('reset');
    return directory;
  });
}
