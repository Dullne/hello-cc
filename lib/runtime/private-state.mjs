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
const MANIFEST_VERSION = 1;
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
  return {
    version: MANIFEST_VERSION,
    canonicalRoot: root.canonical,
    dev: root.stat.dev.toString(),
    ino: root.stat.ino.toString()
  };
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

function ensureManifest(directory, root, create) {
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
    const temporary = path.join(path.dirname(directory),
      `.${path.basename(directory)}.manifest-tmp-${randomBytes(16).toString('hex')}`);
    let fd;
    try {
      fd = fs.openSync(temporary, FILE_CREATE_FLAGS, 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(expectedManifest(root))}\n`);
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
  const expected = expectedManifest(root);
  if (actual?.version !== expected.version || actual.canonicalRoot !== expected.canonicalRoot ||
      actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw forbidden(`Project root identity differs from private state binding: ${root.canonical}. ` +
      'Back up the old private store and authority marker, stop all writers, and review both root identities ' +
      'before manual recovery; automatic rebinding is refused.');
  }
}

function assertProjectUnchanged(root) {
  let current;
  try { current = canonicalProjectRoot(root.requested); }
  catch { throw forbidden(`Project root changed during private state validation: ${root.requested}`); }
  if (current.canonical !== root.canonical || !sameIdentity(current.stat, root.stat)) {
    throw forbidden(`Project root changed during private state validation: ${root.requested}`);
  }
}

// Path derivation is read-only. A missing project root gets a lexical absolute
// path solely for hashing; state access always requires an existing directory.
export function privateProjectStateDir(root) {
  const project = canonicalProjectRoot(root, { allowMissing: true });
  return statePath(project.canonical, canonicalHome({ allowMissing: true }));
}

export function privateProjectAuthorityPath(root) {
  return `${privateProjectStateDir(root)}.authority.json`;
}

export function inspectPrivateProjectAuthority(root) {
  const project = canonicalProjectRoot(root);
  const marker = privateProjectAuthorityPath(project.canonical);
  try { fs.lstatSync(marker); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw inspectError(error, 'project authority marker', marker);
  }
  const actual = readManifest(marker);
  const expected = expectedManifest(project);
  if (actual?.version !== expected.version || actual.canonicalRoot !== expected.canonicalRoot ||
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

function writePrivateProjectAuthorityKind(project, home, projects, kind) {
  if (!AUTHORITY_KINDS.has(kind)) throw forbidden(`Invalid project authority kind: ${kind}`);
  const marker = `${statePath(project.canonical, home)}.authority.json`;
  const current = inspectPrivateProjectAuthority(project.canonical);
  if (current === kind) return marker;
  if (!AUTHORITY_TRANSITIONS[current ?? 'missing']?.has(kind)) {
    throw forbidden(`Invalid project authority transition ${current ?? 'missing'} -> ${kind}: ${marker}`);
  }
  const contents = `${JSON.stringify({ ...expectedManifest(project), kind })}\n`;
  const temporary = `${marker}.tmp-${randomBytes(16).toString('hex')}`;
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
  fsyncDirectory(projects);
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
  const directory = statePath(project.canonical, home);
  return withFileLock(`${directory}.transition`, () => {
    inspectHomeAncestry(home);
    inspectDirectory(global, 'global state directory', { mode: 0o700 });
    inspectDirectory(projects, 'private projects directory', { mode: 0o700 });
    assertProjectUnchanged(project);
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
  const directory = statePath(project.canonical, home);

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

  ensureManifest(directory, project, Boolean(create));
  if (create && (authority === null || authority === 'pending' || authority === 'reset')) {
    fsyncDirectory(projects);
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
  return withPrivateProjectStateTransition(root, ({ directory, projects, authorityKind, setAuthorityKind }) => {
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
    fsyncDirectory(projects);
    setAuthorityKind('reset');
    return directory;
  });
}
