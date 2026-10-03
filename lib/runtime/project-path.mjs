import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { CliError } from '../shared/errors.mjs';

function pathIsWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
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

function privateDirectory(directory, description) {
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
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw projectPathForbidden(`${description} changed during validation: ${directory}`);
    }
    if (process.platform !== 'win32' && (opened.mode & 0o777) !== 0o700) {
      fs.fchmodSync(fd, 0o700);
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
  const stateDir = path.join(root, '.hello-cc');
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
    const canonical = secureExisting
      ? privateDirectory(stateDir, 'Project state directory')
      : fs.realpathSync(stateDir);
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
    if (createParents && privateDirectory(current, 'Database parent directory') !== current) {
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

export function resolveProjectDatabase({ root, db, createStateDir = false, createDatabaseParents = false }) {
  const requestedRoot = path.resolve(String(root || ''));
  const canonicalRoot = canonicalProjectRoot(requestedRoot);
  const rawDb = path.resolve(String(db || path.join(requestedRoot, '.hello-cc', 'mesh.db')));
  let requestedDb = pathIsWithin(requestedRoot, rawDb)
    ? path.join(canonicalRoot, path.relative(requestedRoot, rawDb))
    : rawDb;
  const intendedStateDir = path.join(canonicalRoot, '.hello-cc');
  if (!pathIsWithin(intendedStateDir, requestedDb)) {
    try {
      const canonicalParent = fs.realpathSync(path.dirname(requestedDb));
      const canonicalCandidate = path.join(canonicalParent, path.basename(requestedDb));
      if (pathIsWithin(intendedStateDir, canonicalCandidate)) requestedDb = canonicalCandidate;
    } catch {}
  }
  if (!pathIsWithin(intendedStateDir, requestedDb)) {
    throw projectPathForbidden(`Database path must live under ${intendedStateDir}`);
  }
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

export function ensurePrivateProjectBufferDirectory(root, directoryName = 'bufs', { create = true } = {}) {
  if (!directoryName || directoryName !== path.basename(directoryName) ||
      directoryName === '.' || directoryName === '..') {
    throw projectPathForbidden(`Invalid buffer directory name: ${directoryName}`);
  }
  const canonicalRoot = canonicalProjectRoot(root);
  const state = ensureStateDirectory(canonicalRoot, create, true);
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
  if (privateDirectory(directory, 'Buffer directory') !== directory) {
    throw projectPathForbidden(`Buffer directory escapes project state directory: ${directory}`);
  }
  return directory;
}
