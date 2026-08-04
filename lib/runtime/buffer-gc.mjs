import fs from 'node:fs';
import path from 'node:path';

function eligibleBufferStat(stat) {
  return stat.isFile() || stat.isFIFO();
}

function objectIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function sameDirectoryObject(left, right) {
  return left.isDirectory() &&
    right.isDirectory() &&
    left.dev === right.dev &&
    left.ino === right.ino;
}

function statIdentity(stat) {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs
  };
}

function sameStatIdentity(left, right) {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function canonicalEntryPath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const resolved = path.resolve(value);
  const suppliedParent = path.dirname(resolved);
  try {
    const suppliedStat = fs.statSync(suppliedParent);
    const canonicalParent = fs.realpathSync(suppliedParent);
    const canonicalStat = fs.lstatSync(canonicalParent);
    if (canonicalStat.isSymbolicLink() || !sameDirectoryObject(suppliedStat, canonicalStat)) return null;
    return path.join(canonicalParent, path.basename(resolved));
  } catch {
    return null;
  }
}

function evidenceSnapshot(values) {
  const paths = new Set();
  const identities = new Set();
  for (const value of values || []) {
    const file = canonicalEntryPath(value);
    if (!file) continue;
    paths.add(file);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isSymbolicLink() && eligibleBufferStat(stat)) identities.add(objectIdentity(stat));
    } catch {}
  }
  return { paths, identities };
}

export function refreshBufferPlanEvidence(plan, {
  protectedPaths = [],
  unknownPaths = [],
  gcCutoffs = []
} = {}) {
  if (!plan || !Array.isArray(plan.deleteEntries)) {
    throw new TypeError('valid buffer GC plan required');
  }
  const protectedEvidence = evidenceSnapshot(protectedPaths);
  const unknownEvidence = evidenceSnapshot(unknownPaths);
  const protectedEntries = [];
  const unknownEntries = [];
  const deleteEntries = [];
  for (const entry of plan.deleteEntries) {
    const identity = `${entry?.stat?.dev}:${entry?.stat?.ino}`;
    if (protectedEvidence.paths.has(entry.path) || protectedEvidence.identities.has(identity)) {
      protectedEntries.push(entry);
    } else if (unknownEvidence.paths.has(entry.path) || unknownEvidence.identities.has(identity)) {
      unknownEntries.push(entry);
    } else {
      deleteEntries.push(entry);
    }
  }
  return {
    ...plan,
    evidenceGcCutoffs: [...new Set([
      ...(plan.evidenceGcCutoffs || []),
      ...gcCutoffs
    ])].sort((left, right) => left - right),
    protectedPaths: protectedEntries.map((entry) => entry.path),
    unknownPaths: unknownEntries.map((entry) => entry.path),
    deletePaths: deleteEntries.map((entry) => entry.path),
    protectedEntries,
    unknownEntries,
    deleteEntries
  };
}

function canonicalDirectories(values) {
  const directories = [];
  const seenPaths = new Set();
  const seenIdentities = new Set();
  for (const value of values || []) {
    if (typeof value !== 'string' || value.length === 0) continue;
    const resolved = path.resolve(value);
    let suppliedStat;
    try { suppliedStat = fs.lstatSync(resolved); } catch { continue; }
    if (!suppliedStat.isDirectory() || suppliedStat.isSymbolicLink()) continue;

    let directory;
    let stat;
    try {
      directory = fs.realpathSync(resolved);
      stat = fs.lstatSync(directory);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !sameDirectoryObject(suppliedStat, stat)) continue;
    const identity = objectIdentity(stat);
    if (seenPaths.has(directory) || seenIdentities.has(identity)) continue;
    seenPaths.add(directory);
    seenIdentities.add(identity);
    directories.push({ path: directory, identity });
  }
  return directories;
}

export function planBufferFiles({
  directories = [],
  cutoffMs,
  protectedPaths = [],
  unknownPaths = [],
  evidenceGcCutoffs = []
} = {}) {
  if (!Number.isFinite(cutoffMs)) throw new TypeError('cutoffMs must be a finite number');

  const protectedEvidence = evidenceSnapshot(protectedPaths);
  const unknownEvidence = evidenceSnapshot(unknownPaths);
  const seenIdentities = new Set();
  const protectedEntries = [];
  const unknownEntries = [];
  const deleteEntries = [];

  for (const directory of canonicalDirectories(directories)) {
    let names;
    try { names = fs.readdirSync(directory.path); } catch { continue; }
    for (const name of names) {
      const file = path.resolve(directory.path, name);
      if (path.dirname(file) !== directory.path) continue;

      let stat;
      try { stat = fs.lstatSync(file); } catch { continue; }
      if (stat.isSymbolicLink() || !eligibleBufferStat(stat) || stat.mtimeMs >= cutoffMs) continue;
      const identity = objectIdentity(stat);
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);

      const entry = {
        path: file,
        stat: statIdentity(stat),
        directory: { path: directory.path, identity: directory.identity }
      };
      if (protectedEvidence.paths.has(file) || protectedEvidence.identities.has(identity)) protectedEntries.push(entry);
      else if (unknownEvidence.paths.has(file) || unknownEvidence.identities.has(identity)) unknownEntries.push(entry);
      else deleteEntries.push(entry);
    }
  }

  return {
    cutoffMs,
    evidenceGcCutoffs: [...evidenceGcCutoffs],
    protectedPaths: protectedEntries.map((entry) => entry.path),
    unknownPaths: unknownEntries.map((entry) => entry.path),
    deletePaths: deleteEntries.map((entry) => entry.path),
    protectedEntries,
    unknownEntries,
    deleteEntries
  };
}

export function applyBufferPlan(plan) {
  if (!plan || !Number.isFinite(plan.cutoffMs) || !Array.isArray(plan.deleteEntries)) {
    throw new TypeError('valid buffer GC plan required');
  }

  const result = {
    deleted: 0,
    protected: plan.protectedEntries?.length || 0,
    deferred: plan.unknownEntries?.length || 0
  };

  for (const entry of plan.deleteEntries) {
    try {
      const directory = fs.lstatSync(entry.directory.path);
      if (directory.isSymbolicLink() ||
          !directory.isDirectory() ||
          objectIdentity(directory) !== entry.directory.identity ||
          fs.realpathSync(entry.directory.path) !== entry.directory.path) {
        result.deferred += 1;
        continue;
      }
      const current = fs.lstatSync(entry.path);
      if (current.isSymbolicLink() ||
          !eligibleBufferStat(current) ||
          current.mtimeMs >= plan.cutoffMs ||
          !sameStatIdentity(entry.stat, statIdentity(current))) {
        result.deferred += 1;
        continue;
      }
      fs.unlinkSync(entry.path);
      result.deleted += 1;
    } catch {
      result.deferred += 1;
    }
  }
  return result;
}

export function bufferPlanGcCutoffs(plan, retentionSec) {
  if (!plan || !Number.isFinite(plan.cutoffMs)) {
    throw new TypeError('valid buffer GC plan required');
  }
  if (!Number.isSafeInteger(retentionSec) || retentionSec < 0) {
    throw new TypeError('retentionSec must be a non-negative safe integer');
  }
  const entryCutoffs = plan.deleteEntries.map((entry) => {
    const boundary = Math.max(0, Math.floor(Number(entry?.stat?.mtimeMs) / 1000) + retentionSec);
    if (!Number.isSafeInteger(boundary)) {
      throw new TypeError('buffer GC boundary must be a non-negative safe integer');
    }
    return boundary;
  });
  const evidenceCutoffs = plan.evidenceGcCutoffs || [];
  if (!Array.isArray(evidenceCutoffs) || evidenceCutoffs.some((cutoff) =>
    !Number.isSafeInteger(cutoff) || cutoff < 0)) {
    throw new TypeError('buffer evidence GC cutoffs must be non-negative safe integers');
  }
  return [...new Set([...entryCutoffs, ...evidenceCutoffs])].sort((left, right) => left - right);
}

export function deferBufferPlan(plan) {
  if (!plan || !Array.isArray(plan.deleteEntries)) {
    throw new TypeError('valid buffer GC plan required');
  }
  return {
    deleted: 0,
    protected: plan.protectedEntries?.length || 0,
    deferred: (plan.unknownEntries?.length || 0) + plan.deleteEntries.length
  };
}

export function pruneBufferFiles(options = {}) {
  const plan = planBufferFiles(options);
  if (options.dryRun) {
    return {
      deleted: plan.deleteEntries.length,
      protected: plan.protectedEntries.length,
      deferred: plan.unknownEntries.length
    };
  }
  return applyBufferPlan(plan);
}
