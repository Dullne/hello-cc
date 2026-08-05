import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { resolvePeerEvidence } from '../core/peers/evidence.mjs';
import { inspectProcessIdentity } from '../process/identity.mjs';

function canonicalDirectories(values) {
  const directories = [];
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value !== 'string' || value.length === 0) continue;
    try {
      const resolved = path.resolve(value);
      const supplied = fs.lstatSync(resolved);
      if (!supplied.isDirectory() || supplied.isSymbolicLink()) continue;
      const canonical = fs.realpathSync.native(resolved);
      const stat = fs.lstatSync(canonical);
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          stat.dev !== supplied.dev || stat.ino !== supplied.ino || seen.has(canonical)) continue;
      seen.add(canonical);
      directories.push(canonical);
    } catch {}
  }
  return directories;
}

function directoryPaths(directory) {
  try {
    return fs.readdirSync(directory).map((name) => path.resolve(directory, name));
  } catch {
    return [];
  }
}

export function externalBufferSessionIds(directory) {
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.endsWith('.out'))
      .map((name) => path.basename(name, '.out'))
      .sort();
  } catch {
    return [];
  }
}

function candidateSetForDirectories(candidatePaths, directorySet) {
  if (candidatePaths === null || candidatePaths === undefined) return null;
  const candidates = new Set();
  for (const file of candidatePaths || []) {
    if (typeof file !== 'string' || file.length === 0) continue;
    const resolved = path.resolve(file);
    if (directorySet.has(path.dirname(resolved))) candidates.add(resolved);
  }
  return candidates;
}

function candidateFiles(directory, candidateSet) {
  if (candidateSet === null) return directoryPaths(directory);
  return [...candidateSet].filter((file) => path.dirname(file) === directory);
}

function externalMetadataFiles(directory, candidateSet) {
  if (candidateSet === null) {
    return directoryPaths(directory).filter((file) => file.endsWith('.meta'));
  }
  const files = new Set();
  for (const file of candidateFiles(directory, candidateSet)) {
    const match = path.basename(file).match(/^(.*)\.(?:out|in|resize|meta)$/);
    if (match) files.add(path.resolve(directory, `${match[1]}.meta`));
  }
  return [...files];
}

function addExternalGroup(target, directory, id) {
  for (const suffix of ['out', 'in', 'resize', 'meta']) {
    target.add(path.resolve(directory, `${id}.${suffix}`));
  }
}

export function externalBufferEvidence(meta, inspectProcess = inspectProcessIdentity) {
  const processes = [];
  const wrapperPid = meta?.wrapper_pid || meta?.wrapperPid || null;
  const childPid = meta?.pid || null;
  if (wrapperPid) processes.push({
    name: 'wrapper',
    storedIdentity: meta?.wrapper_identity || meta?.wrapperIdentity || null,
    current: inspectProcess(wrapperPid)
  });
  if (childPid) processes.push({
    name: 'child',
    storedIdentity: meta?.child_identity || meta?.childIdentity || null,
    current: inspectProcess(childPid)
  });
  return resolvePeerEvidence({ peer: { status: 'running' }, processes });
}

export function externalBufferOwnerKey(meta) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const generation = typeof meta.generation === 'string' ? meta.generation.trim() : '';
  if (generation) return `generation:${generation}`;
  const wrapperPid = meta.wrapper_pid || meta.wrapperPid || null;
  const childPid = meta.pid || null;
  if (!wrapperPid && !childPid) return null;
  const identityTuple = (pid, identity) => ({
    pid: pid === null || pid === undefined ? null : String(pid),
    startToken: identity?.startToken || null,
    commandHash: identity?.commandHash || null
  });
  return JSON.stringify({
    wrapper: identityTuple(wrapperPid, meta.wrapper_identity || meta.wrapperIdentity || null),
    child: identityTuple(childPid, meta.child_identity || meta.childIdentity || null)
  });
}

export function readExternalBufferMetadata(file) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(file, flags);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('metadata is not a regular file');
    const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('metadata changed while being read');
    }
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

function safeTmuxPath(directory, row, runtimeId) {
  const safePane = String(row.runtime_target || '').replace(/[^A-Za-z0-9_-]/g, '');
  const safeId = String(runtimeId || '').replace(/[^A-Za-z0-9_.-]/g, '_');
  if (!safePane || !safeId) return null;
  return path.resolve(directory, `tmux-${safePane}-${safeId}.pipe`);
}

function contextBufferDirectory(ctx) {
  return path.resolve(ctx.root, '.hello-cc', 'bufs');
}

function boundedUnknown(referenceFile, {
  nowMs,
  monotonicNowMs,
  unknownGraceMs,
  unknownTracker,
  gcCutoffs
}) {
  let stat;
  try { stat = fs.lstatSync(referenceFile); } catch { return false; }
  if (stat.isSymbolicLink()) return false;
  const identity = `${stat.dev}:${stat.ino}`;
  const timestampMs = Math.floor(Math.max(Number(stat.mtimeMs), Number(stat.ctimeMs)));
  let cutoffMs = timestampMs + unknownGraceMs;
  if (unknownTracker) {
    const current = monotonicNowMs();
    if (!Number.isFinite(current) || current < 0) {
      throw new TypeError('monotonicNowMs must return a non-negative finite number');
    }
    const prior = unknownTracker.get(referenceFile);
    let sinceMonotonicMs;
    if (prior?.identity === identity && prior.state === 'unknown' &&
        Number.isFinite(prior.sinceMonotonicMs)) {
      sinceMonotonicMs = prior.sinceMonotonicMs;
      if (Number.isFinite(prior.cutoffMs)) cutoffMs = prior.cutoffMs;
    } else {
      const wallNow = nowMs();
      if (!Number.isFinite(wallNow)) throw new TypeError('nowMs must return a finite number');
      const persistedAgeMs = wallNow < timestampMs
        ? unknownGraceMs
        : Math.min(unknownGraceMs, Math.max(0, wallNow - timestampMs));
      const knownTransition = prior?.identity === identity;
      sinceMonotonicMs = knownTransition ? current : current - persistedAgeMs;
      cutoffMs = knownTransition ? wallNow + unknownGraceMs : timestampMs + unknownGraceMs;
      unknownTracker.set(referenceFile, { state: 'unknown', sinceMonotonicMs, cutoffMs, identity });
    }
    const cutoffSec = Math.max(0, Math.ceil(cutoffMs / 1000));
    if (Number.isSafeInteger(cutoffSec)) gcCutoffs.add(cutoffSec);
    const elapsedMs = current < sinceMonotonicMs
      ? unknownGraceMs
      : current - sinceMonotonicMs;
    return elapsedMs < unknownGraceMs;
  }
  const current = nowMs();
  if (!Number.isFinite(current)) throw new TypeError('nowMs must return a finite number');
  const cutoffSec = Math.max(0, Math.ceil(cutoffMs / 1000));
  if (Number.isSafeInteger(cutoffSec)) gcCutoffs.add(cutoffSec);
  const elapsedMs = current < timestampMs ? unknownGraceMs : current - timestampMs;
  return elapsedMs < unknownGraceMs;
}

function recordKnownEvidence(unknownTracker, file, state, monotonicNowMs) {
  if (!unknownTracker) return;
  let stat;
  try { stat = fs.lstatSync(file); } catch { unknownTracker.delete(file); return; }
  const observedMonotonicMs = monotonicNowMs();
  if (!Number.isFinite(observedMonotonicMs) || observedMonotonicMs < 0) {
    throw new TypeError('monotonicNowMs must return a non-negative finite number');
  }
  unknownTracker.set(file, {
    state,
    observedMonotonicMs,
    identity: `${stat.dev}:${stat.ino}`
  });
}

export function collectBufferEvidence({
  directories = [],
  projectDbs = [],
  sessions = [],
  inspectProcess = inspectProcessIdentity,
  observePeer = null,
  nowMs = Date.now,
  monotonicNowMs = () => performance.now(),
  unknownGraceMs = 120_000,
  unknownTracker = null,
  candidatePaths = null
} = {}) {
  if (!Number.isFinite(unknownGraceMs) || unknownGraceMs < 0) {
    throw new TypeError('unknownGraceMs must be a non-negative finite number');
  }
  if (unknownTracker !== null && !(unknownTracker instanceof Map)) {
    throw new TypeError('unknownTracker must be a Map');
  }
  const canonical = canonicalDirectories(directories);
  const directorySet = new Set(canonical);
  const candidateSet = candidateSetForDirectories(candidatePaths, directorySet);
  const relevant = (file) => candidateSet === null || candidateSet.has(path.resolve(file));
  const protectedPaths = new Set();
  const unknownPaths = new Set();
  const gcCutoffs = new Set();

  for (const session of sessions || []) {
    if (session?.status !== 'running' || session.type === 'external') continue;
    for (const file of [session.outFile, session.inFile, session.resizeFile, session.pipeFile, session.metaFile]) {
      if (typeof file === 'string' && file.length > 0) {
        const resolved = path.resolve(file);
        if (!relevant(resolved)) continue;
        protectedPaths.add(resolved);
        recordKnownEvidence(unknownTracker, resolved, 'live', monotonicNowMs);
      }
    }
  }

  for (const directory of canonical) {
    for (const file of externalMetadataFiles(directory, candidateSet)) {
      const id = path.basename(file, '.meta');
      let meta;
      try {
        meta = readExternalBufferMetadata(file);
      } catch {
        if (boundedUnknown(file, { nowMs, monotonicNowMs, unknownGraceMs, unknownTracker, gcCutoffs })) {
          addExternalGroup(unknownPaths, directory, id);
        }
        continue;
      }
      const evidence = externalBufferEvidence(meta, inspectProcess);
      if (evidence.state === 'live') {
        recordKnownEvidence(unknownTracker, file, 'live', monotonicNowMs);
        addExternalGroup(protectedPaths, directory, id);
      } else if (evidence.state === 'unknown' &&
          boundedUnknown(file, { nowMs, monotonicNowMs, unknownGraceMs, unknownTracker, gcCutoffs })) {
        addExternalGroup(unknownPaths, directory, id);
      } else if (evidence.state === 'dead') {
        recordKnownEvidence(unknownTracker, file, 'dead', monotonicNowMs);
      }
    }
  }

  const knownTmuxPaths = new Set();
  for (const entry of projectDbs || []) {
    const projectDirectory = contextBufferDirectory(entry.ctx);
    let canonicalProjectDirectory;
    try { canonicalProjectDirectory = fs.realpathSync.native(projectDirectory); } catch { continue; }
    if (!directorySet.has(canonicalProjectDirectory)) continue;
    let rows;
    try {
      rows = entry.db.prepare(`
        SELECT p.id, p.status, p.pid, p.pid_start_token, p.pid_command_hash,
               b.transport, b.runtime_session_id, b.runtime_target
        FROM peer_bindings b
        JOIN peers p ON p.id = b.peer
        WHERE b.transport = 'tmux' AND b.runtime_target IS NOT NULL
      `).all();
    } catch {
      continue;
    }
    for (const row of rows) {
      const runtimeIds = new Set([row.runtime_session_id, row.id].filter(Boolean));
      const files = [...runtimeIds]
        .map((runtimeId) => safeTmuxPath(canonicalProjectDirectory, row, runtimeId))
        .filter((file) => file && relevant(file));
      if (!files.length) continue;
      const evidence = observePeer
        ? observePeer(entry.ctx, row, row)
        : { state: 'unknown', reason: 'tmux_probe_missing' };
      for (const file of files) {
        knownTmuxPaths.add(file);
        if (evidence.state === 'live') {
          recordKnownEvidence(unknownTracker, file, 'live', monotonicNowMs);
          protectedPaths.add(file);
        } else if (evidence.state === 'unknown' &&
            boundedUnknown(file, { nowMs, monotonicNowMs, unknownGraceMs, unknownTracker, gcCutoffs })) {
          unknownPaths.add(file);
        } else if (evidence.state === 'dead') {
          recordKnownEvidence(unknownTracker, file, 'dead', monotonicNowMs);
        }
      }
    }
  }

  for (const directory of canonical) {
    for (const file of candidateFiles(directory, candidateSet)) {
      if (!file.endsWith('.pipe') || knownTmuxPaths.has(file)) continue;
      try {
        if (fs.lstatSync(file).isFIFO() &&
            boundedUnknown(file, { nowMs, monotonicNowMs, unknownGraceMs, unknownTracker, gcCutoffs })) {
          unknownPaths.add(file);
        }
      } catch {}
    }
  }

  if (unknownTracker) {
    for (const file of unknownTracker.keys()) {
      if (!relevant(file)) continue;
      try { fs.lstatSync(file); } catch { unknownTracker.delete(file); }
    }
  }

  for (const file of protectedPaths) unknownPaths.delete(file);
  return { protectedPaths, unknownPaths, gcCutoffs: [...gcCutoffs].sort((left, right) => left - right) };
}
