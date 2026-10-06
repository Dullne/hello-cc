import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CliError } from '../shared/errors.mjs';
import { projectStateDir, legacyProjectStateDir } from './paths.mjs';
import { ensurePrivateProjectStateDir, inspectPrivateProjectAuthority } from './private-state.mjs';
import { unsafeDirectoryAcl } from './project-trust.mjs';

function pathIsWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function canonicalCandidateFromExistingParent(candidate) {
  let parent = path.dirname(candidate);
  const missing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(parent), ...missing.reverse(), path.basename(candidate));
    } catch (error) {
      if (error?.code !== 'ENOENT') return null;
      const next = path.dirname(parent);
      if (next === parent) return null;
      missing.push(path.basename(parent));
      parent = next;
    }
  }
}

function projectPathForbidden(message) {
  return new CliError('PROJECT_PATH_FORBIDDEN', message);
}

function canonicalProjectRoot(root) {
  const requested = path.resolve(String(root || ''));
  try {
    const canonical = fs.realpathSync(requested);
    if (!fs.statSync(canonical).isDirectory()) throw new Error('not a directory');
    return canonical;
  } catch {
    throw new CliError('PROJECT_NOT_REGISTERED', `Project root does not exist: ${requested}`);
  }
}

function privateDirectory(directory, description, { tighten = true } = {}) {
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch { throw projectPathForbidden(`Cannot inspect ${description}: ${directory}`); }
  if (stat.isSymbolicLink() || !stat.isDirectory() ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw projectPathForbidden(`${description} must be an owned real directory: ${directory}`);
  }

  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
        unsafeDirectoryAcl(directory, opened)) {
      throw projectPathForbidden(`${description} changed during validation: ${directory}`);
    }
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o700) {
      if (tighten) fs.fchmodSync(fd, 0o700);
      else if ((opened.mode & 0o022) !== 0) {
        throw projectPathForbidden(`${description} is writable by another user: ${directory}`);
      }
    }
    const current = fs.lstatSync(directory);
    if (current.isSymbolicLink() || current.dev !== stat.dev || current.ino !== stat.ino) {
      throw projectPathForbidden(`${description} changed during validation: ${directory}`);
    }
    return fs.realpathSync(directory);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw projectPathForbidden(`Cannot secure ${description}: ${directory}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function ensureStateDirectory(root, createStateDir, secureExisting = createStateDir) {
  const stateDir = projectStateDir(root);
  if (stateDir !== legacyProjectStateDir(root)) {
    const authority = inspectPrivateProjectAuthority(root);
    let privateEntryExists = false;
    try { fs.lstatSync(stateDir); privateEntryExists = true; }
    catch (error) {
      if (error?.code !== 'ENOENT') {
        throw projectPathForbidden(`Cannot inspect private project state: ${stateDir}`);
      }
    }
    // A crash can leave a pending marker with an empty directory or a valid
    // manifest not yet promoted to fresh. Older private stores may have no
    // sibling marker. Finish either binding before returning any existing
    // state, including during a read-only request.
    const finishBinding = privateEntryExists &&
      (authority === null || authority === 'pending');
    const existing = ensurePrivateProjectStateDir(root, { create: finishBinding });
    if (existing) return { stateDir, exists: true };
    if (authority === 'fresh' || authority === 'migrated') {
      throw new CliError('STATE_AUTHORITY_MISSING',
        `Previously established private project state is missing: ${stateDir}. Restore it from backup; ` +
        'if the legacy source still exists, stop all old writers and run ' +
        'hcc --root DIR migrate-state --offline --yes; otherwise run ' +
        'hcc --root DIR uninstall --purge --yes to explicitly reset the missing state.');
    }
    const legacy = legacyProjectStateDir(root);
    let legacyStat = null;
    try { legacyStat = fs.lstatSync(legacy); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw projectPathForbidden(`Cannot inspect legacy project state: ${legacy}`);
    }
    if (legacyStat && (legacyStat.isSymbolicLink() || !legacyStat.isDirectory())) {
      throw projectPathForbidden(`Legacy project state is not a real directory: ${legacy}`);
    }
    if (legacyStat) {
      throw new CliError('STATE_MIGRATION_REQUIRED',
        `Legacy project state requires an offline migration before use: ${legacy}`);
    }
    const secured = createStateDir ? ensurePrivateProjectStateDir(root, { create: true }) : null;
    return { stateDir, exists: Boolean(secured) };
  }
  let stateStat;
  try {
    stateStat = fs.lstatSync(stateDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw projectPathForbidden(`Cannot inspect project state directory: ${stateDir}`);
    }
    if (!createStateDir) return { stateDir, exists: false };
    try {
      fs.mkdirSync(stateDir, { mode: 0o700 });
      stateStat = fs.lstatSync(stateDir);
    } catch (error) {
      if (error?.code === 'EEXIST') stateStat = fs.lstatSync(stateDir);
      else throw projectPathForbidden(`Cannot create project state directory: ${stateDir}`);
    }
  }

  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    throw projectPathForbidden(`Project state directory must be a real directory: ${stateDir}`);
  }
  try {
    const canonical = privateDirectory(stateDir, 'Project state directory', { tighten: secureExisting });
    if (canonical !== stateDir || !pathIsWithin(root, canonical)) {
      throw projectPathForbidden(`Project state directory escapes its project root: ${stateDir}`);
    }
    return { stateDir: canonical, exists: true };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw projectPathForbidden(`Cannot resolve project state directory: ${stateDir}`);
  }
}

export function secureExistingProjectStateDirectory(root) {
  const canonicalRoot = canonicalProjectRoot(root);
  return ensureStateDirectory(canonicalRoot, false, true);
}

function validateDatabaseParent(stateDir, db, createParents = false) {
  const parent = path.dirname(db);
  const relative = path.relative(stateDir, parent);
  const segments = relative === '' ? [] : relative.split(path.sep);
  let current = stateDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (createParents) {
      try { fs.mkdirSync(current, { mode: 0o700 }); }
      catch (error) {
        if (error?.code !== 'EEXIST') {
          throw projectPathForbidden(`Cannot create database parent directory: ${current}`);
        }
      }
    }
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      throw projectPathForbidden(`Database parent directory does not exist: ${current}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw projectPathForbidden(`Database parent must contain only real directories: ${current}`);
    }
    if (privateDirectory(current, 'Database parent directory', { tighten: createParents }) !== current) {
      throw projectPathForbidden(`Database parent directory changed: ${current}`);
    }
  }

  try {
    const canonicalParent = fs.realpathSync(parent);
    if (canonicalParent !== stateDir && !pathIsWithin(stateDir, canonicalParent)) {
      throw projectPathForbidden(`Database parent escapes project state directory: ${parent}`);
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw projectPathForbidden(`Cannot resolve database parent directory: ${parent}`);
  }
}

function validateDatabaseTarget(stateDir, db) {
  let stat;
  try {
    stat = fs.lstatSync(db);
  } catch (error) {
    if (error?.code === 'ENOENT') return db;
    throw projectPathForbidden(`Cannot inspect project database: ${db}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw projectPathForbidden(`Project database must be a regular file: ${db}`);
  }
  try {
    const canonical = fs.realpathSync(db);
    if (!pathIsWithin(stateDir, canonical)) {
      throw projectPathForbidden(`Project database escapes project state directory: ${db}`);
    }
    return canonical;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw projectPathForbidden(`Cannot resolve project database: ${db}`);
  }
}

function databaseLocation({ root, db }) {
  const requestedRoot = path.resolve(String(root || ''));
  const canonicalRoot = canonicalProjectRoot(requestedRoot);
  const rawDb = path.resolve(String(db || path.join(requestedRoot, '.hello-cc', 'mesh.db')));
  const intendedStateDir = projectStateDir(canonicalRoot);
  const requestedLegacyState = legacyProjectStateDir(requestedRoot);
  const canonicalLegacyState = legacyProjectStateDir(canonicalRoot);
  const legacySpelling = pathIsWithin(requestedLegacyState, rawDb) ||
    pathIsWithin(canonicalLegacyState, rawDb);
  let requestedDb = pathIsWithin(requestedLegacyState, rawDb)
    ? path.join(intendedStateDir, path.relative(requestedLegacyState, rawDb))
    : pathIsWithin(canonicalLegacyState, rawDb)
      ? path.join(intendedStateDir, path.relative(canonicalLegacyState, rawDb))
      : rawDb;
  if (!pathIsWithin(intendedStateDir, requestedDb)) {
    // An explicit --db may be spelled through an alias of an ancestor such as
    // macOS /var -> /private/var, and its nested DB parents may not exist yet.
    // Canonicalize the nearest existing parent before containment checking;
    // validateDatabaseParent still rejects any newly created symlink segment.
    const canonicalCandidate = canonicalCandidateFromExistingParent(requestedDb);
    if (canonicalCandidate && pathIsWithin(intendedStateDir, canonicalCandidate)) {
      requestedDb = canonicalCandidate;
    }
  }
  if (!pathIsWithin(intendedStateDir, requestedDb)) {
    throw projectPathForbidden(`Database path must live under ${intendedStateDir}`);
  }
  return { canonicalRoot, intendedStateDir, requestedDb, legacySpelling };
}

// Check an explicitly requested DB path without creating a state directory,
// claiming a generation, or tightening permissions. The mutating resolver
// repeats all checks after selection; this is an admission guard, not a grant.
export function prevalidateProjectDatabaseLocation({ root, db }) {
  const location = databaseLocation({ root, db });
  const { canonicalRoot, intendedStateDir, requestedDb, legacySpelling } = location;
  // A direct private path from A must not be used to provision replacement B.
  // A legacy spelling is remapped to B's new generation after selection.
  if (!legacySpelling && intendedStateDir !== legacyProjectStateDir(canonicalRoot)) {
    inspectPrivateProjectAuthority(canonicalRoot);
  }
  const canonicalCandidate = canonicalCandidateFromExistingParent(requestedDb);
  if (!canonicalCandidate || !pathIsWithin(intendedStateDir, canonicalCandidate)) {
    throw projectPathForbidden(`Database path escapes project state directory: ${requestedDb}`);
  }
  for (let current = intendedStateDir;;) {
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error?.code !== 'ENOENT') {
        throw projectPathForbidden(`Cannot inspect database parent: ${current}`);
      }
    }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw projectPathForbidden(`Database parent must be a real directory: ${current}`);
    }
    if (current === path.dirname(requestedDb)) break;
    const next = path.join(current, path.relative(current, path.dirname(requestedDb)).split(path.sep)[0]);
    if (next === current) throw projectPathForbidden(`Invalid database parent: ${requestedDb}`);
    current = next;
  }
  try {
    const target = fs.lstatSync(requestedDb);
    if (target.isSymbolicLink() || !target.isFile()) {
      throw projectPathForbidden(`Project database must be a regular file: ${requestedDb}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof CliError) throw error;
      throw projectPathForbidden(`Cannot inspect project database: ${requestedDb}`);
    }
  }
  return location;
}

export function resolveProjectDatabase({ root, db, createStateDir = false, createDatabaseParents = false }) {
  const { canonicalRoot, intendedStateDir, requestedDb } = databaseLocation({ root, db });
  const state = ensureStateDirectory(canonicalRoot, Boolean(createStateDir));
  if (!state.exists) {
    return { root: canonicalRoot, stateDir: state.stateDir, db: requestedDb };
  }

  validateDatabaseParent(state.stateDir, requestedDb, Boolean(createDatabaseParents));
  return {
    root: canonicalRoot,
    stateDir: state.stateDir,
    db: validateDatabaseTarget(state.stateDir, requestedDb)
  };
}

export function ensurePrivateProjectStateSubdirectory(root, directoryName, { create = true } = {}) {
  if (!directoryName || directoryName !== path.basename(directoryName) ||
      directoryName === '.' || directoryName === '..') {
    throw projectPathForbidden(`Invalid buffer directory name: ${directoryName}`);
  }
  const canonicalRoot = canonicalProjectRoot(root);
  const state = ensureStateDirectory(canonicalRoot, create, create);
  if (!state.exists) return null;
  const { stateDir } = state;
  const directory = path.join(stateDir, directoryName);
  if (create) {
    try { fs.mkdirSync(directory, { mode: 0o700 }); }
    catch (error) {
      if (error?.code !== 'EEXIST') {
        throw projectPathForbidden(`Cannot create buffer directory: ${directory}`);
      }
    }
  } else {
    try { fs.lstatSync(directory); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw projectPathForbidden(`Cannot inspect buffer directory: ${directory}`);
    }
  }
  if (privateDirectory(directory, 'Project state subdirectory', { tighten: create }) !== directory) {
    throw projectPathForbidden(`Buffer directory escapes project state directory: ${directory}`);
  }
  return directory;
}

export function ensurePrivateProjectBufferDirectory(root, directoryName = 'bufs', options = {}) {
  return ensurePrivateProjectStateSubdirectory(root, directoryName, options);
}
