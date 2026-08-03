import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  applyBufferPlan,
  bufferPlanGcCutoffs,
  deferBufferPlan,
  planBufferFiles,
  pruneBufferFiles
} from '../lib/runtime/buffer-gc.mjs';

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-buffer-gc-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFile(file, contents, mtimeMs) {
  fs.writeFileSync(file, contents);
  const timestamp = new Date(mtimeMs);
  fs.utimesSync(file, timestamp, timestamp);
}

test('prunes only old dead buffers and reports protected and unknown files', (t) => {
  const directory = tempDirectory(t);
  const cutoffMs = Date.now() - 60_000;
  const oldMs = cutoffMs - 60_000;
  const newMs = cutoffMs + 30_000;
  const protectedFile = path.join(directory, 'protected.out');
  const deadFile = path.join(directory, 'dead.out');
  const unknownFile = path.join(directory, 'unknown.out');
  const newFile = path.join(directory, 'new.out');

  writeFile(protectedFile, 'protected', oldMs);
  writeFile(deadFile, 'dead', oldMs);
  writeFile(unknownFile, 'unknown', oldMs);
  writeFile(newFile, 'new', newMs);

  const result = pruneBufferFiles({
    directories: [directory],
    cutoffMs,
    protectedPaths: new Set([protectedFile]),
    unknownPaths: new Set([unknownFile]),
    dryRun: false
  });

  assert.deepEqual(result, { deleted: 1, protected: 1, deferred: 1 });
  assert.equal(fs.existsSync(deadFile), false);
  assert.equal(fs.existsSync(protectedFile), true);
  assert.equal(fs.existsSync(unknownFile), true);
  assert.equal(fs.existsSync(newFile), true);
});

test('dry-run and apply produce the same plan without dry-run deletion', (t) => {
  const dryDirectory = tempDirectory(t);
  const applyDirectory = tempDirectory(t);
  const cutoffMs = Date.now() - 60_000;
  const oldMs = cutoffMs - 60_000;

  for (const directory of [dryDirectory, applyDirectory]) {
    writeFile(path.join(directory, 'protected.out'), 'protected', oldMs);
    writeFile(path.join(directory, 'dead.out'), 'dead', oldMs);
    writeFile(path.join(directory, 'unknown.out'), 'unknown', oldMs);
  }

  const dryResult = pruneBufferFiles({
    directories: [dryDirectory],
    cutoffMs,
    protectedPaths: [path.join(dryDirectory, 'protected.out')],
    unknownPaths: [path.join(dryDirectory, 'unknown.out')],
    dryRun: true
  });
  const applyResult = pruneBufferFiles({
    directories: [applyDirectory],
    cutoffMs,
    protectedPaths: [path.join(applyDirectory, 'protected.out')],
    unknownPaths: [path.join(applyDirectory, 'unknown.out')],
    dryRun: false
  });

  assert.deepEqual(dryResult, applyResult);
  assert.equal(fs.existsSync(path.join(dryDirectory, 'dead.out')), true);
  assert.equal(fs.existsSync(path.join(applyDirectory, 'dead.out')), false);
});

test('clock cutoffs cover would-delete entries while grace preserves evidence classes', (t) => {
  const directory = tempDirectory(t);
  const retentionSec = 60;
  const cutoffMs = Date.now() - 60_000;
  const oldMs = Math.floor((cutoffMs - 60_000) / 1000) * 1000;
  const protectedFile = path.join(directory, 'protected.out');
  const unknownFile = path.join(directory, 'unknown.out');
  const deleteFile = path.join(directory, 'delete.out');
  for (const file of [protectedFile, unknownFile, deleteFile]) writeFile(file, file, oldMs);

  const plan = planBufferFiles({
    directories: [directory],
    cutoffMs,
    protectedPaths: [protectedFile],
    unknownPaths: [unknownFile]
  });

  assert.deepEqual(
    bufferPlanGcCutoffs(plan, retentionSec),
    [Math.floor(oldMs / 1000) + retentionSec]
  );
  assert.deepEqual(deferBufferPlan(plan), { deleted: 0, protected: 1, deferred: 2 });
  assert.equal(fs.existsSync(deleteFile), true);
});

test('normalizes relative directories and protection paths to absolute paths', (t) => {
  const root = tempDirectory(t);
  const directory = path.join(root, 'bufs');
  fs.mkdirSync(directory);
  const cutoffMs = Date.now() - 60_000;
  const protectedFile = path.join(directory, 'protected.out');
  writeFile(protectedFile, 'protected', cutoffMs - 60_000);

  const relativeDirectory = path.relative(process.cwd(), directory);
  const relativeFile = path.relative(process.cwd(), protectedFile);
  const plan = planBufferFiles({
    directories: [relativeDirectory],
    cutoffMs,
    protectedPaths: [relativeFile]
  });

  assert.deepEqual(plan.protectedPaths, [path.join(fs.realpathSync(directory), 'protected.out')]);
  assert.deepEqual(plan.deletePaths, []);
});

test('deduplicates directories and ignores missing or symlinked directory roots', (t) => {
  const root = tempDirectory(t);
  const directory = path.join(root, 'bufs');
  const symlinkTarget = path.join(root, 'outside');
  const symlinkDirectory = path.join(root, 'linked-bufs');
  fs.mkdirSync(directory);
  fs.mkdirSync(symlinkTarget);
  fs.symlinkSync(symlinkTarget, symlinkDirectory);
  const cutoffMs = Date.now() - 60_000;
  const deleteFile = path.join(directory, 'delete.out');
  const protectedFile = path.join(directory, 'protected.out');
  writeFile(deleteFile, 'delete', cutoffMs - 60_000);
  writeFile(protectedFile, 'protected', cutoffMs - 60_000);
  const outsideFile = path.join(symlinkTarget, 'outside.out');
  writeFile(outsideFile, 'outside', cutoffMs - 60_000);

  const duplicatePlan = planBufferFiles({
    directories: [directory, directory, path.join(root, 'missing')],
    cutoffMs,
    protectedPaths: [protectedFile]
  });
  const canonicalDirectory = fs.realpathSync(directory);
  assert.deepEqual(duplicatePlan.deletePaths, [path.join(canonicalDirectory, 'delete.out')]);
  assert.deepEqual(duplicatePlan.protectedPaths, [path.join(canonicalDirectory, 'protected.out')]);

  assert.deepEqual(pruneBufferFiles({
    directories: [symlinkDirectory],
    cutoffMs,
    dryRun: true
  }), { deleted: 0, protected: 0, deferred: 0 });
  assert.equal(fs.existsSync(outsideFile), true);
});

test('canonicalizes ancestor symlink aliases before protection and deduplication', (t) => {
  const root = tempDirectory(t);
  const realRoot = path.join(root, 'real');
  const aliasRoot = path.join(root, 'alias');
  const directory = path.join(realRoot, 'bufs');
  fs.mkdirSync(directory, { recursive: true });
  fs.symlinkSync(realRoot, aliasRoot);
  const cutoffMs = Date.now() - 60_000;
  const protectedFile = path.join(directory, 'active.out');
  writeFile(protectedFile, 'active', cutoffMs - 60_000);

  const options = {
    directories: [directory, path.join(aliasRoot, 'bufs')],
    cutoffMs,
    protectedPaths: [protectedFile]
  };
  const dryResult = pruneBufferFiles({ ...options, dryRun: true });
  const applyResult = pruneBufferFiles({ ...options, dryRun: false });

  assert.deepEqual(dryResult, { deleted: 0, protected: 1, deferred: 0 });
  assert.deepEqual(applyResult, dryResult);
  assert.equal(fs.existsSync(protectedFile), true);
});

test('rejects a directory replaced by an external symlink before realpath resolution', (t) => {
  const root = tempDirectory(t);
  const directory = path.join(root, 'bufs');
  const movedDirectory = path.join(root, 'moved-bufs');
  const outsideDirectory = path.join(root, 'outside');
  fs.mkdirSync(directory);
  fs.mkdirSync(outsideDirectory);
  const cutoffMs = Date.now() - 60_000;
  const outsideFile = path.join(outsideDirectory, 'outside.out');
  writeFile(outsideFile, 'outside', cutoffMs - 60_000);

  const originalRealpathSync = fs.realpathSync;
  let replaced = false;
  fs.realpathSync = function interceptedRealpath(value, ...args) {
    if (!replaced && path.resolve(String(value)) === path.resolve(directory)) {
      replaced = true;
      fs.renameSync(directory, movedDirectory);
      fs.symlinkSync(outsideDirectory, directory);
    }
    return originalRealpathSync.call(this, value, ...args);
  };
  t.after(() => { fs.realpathSync = originalRealpathSync; });

  const plan = planBufferFiles({ directories: [directory], cutoffMs });
  const result = applyBufferPlan(plan);
  assert.deepEqual(plan.deletePaths, []);
  assert.deepEqual(result, { deleted: 0, protected: 0, deferred: 0 });
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside');
});

test('rejects a directory rebound after realpath resolution', (t) => {
  const root = tempDirectory(t);
  const directory = path.join(root, 'bufs');
  const movedDirectory = path.join(root, 'moved-bufs');
  fs.mkdirSync(directory);
  const cutoffMs = Date.now() - 60_000;

  const originalRealpathSync = fs.realpathSync;
  let rebound = false;
  let outsideFile = null;
  fs.realpathSync = function interceptedRealpath(value, ...args) {
    const resolved = originalRealpathSync.call(this, value, ...args);
    if (!rebound && path.resolve(String(value)) === path.resolve(directory)) {
      rebound = true;
      fs.renameSync(directory, movedDirectory);
      fs.mkdirSync(directory);
      outsideFile = path.join(directory, 'outside.out');
      writeFile(outsideFile, 'replacement', cutoffMs - 60_000);
    }
    return resolved;
  };
  t.after(() => { fs.realpathSync = originalRealpathSync; });

  const plan = planBufferFiles({ directories: [directory], cutoffMs });
  const result = applyBufferPlan(plan);
  assert.deepEqual(plan.deletePaths, []);
  assert.deepEqual(result, { deleted: 0, protected: 0, deferred: 0 });
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'replacement');
});

test('rejects evidence whose parent changes identity during canonicalization', (t) => {
  const root = tempDirectory(t);
  const evidenceDirectory = path.join(root, 'evidence-bufs');
  const movedEvidenceDirectory = path.join(root, 'moved-evidence-bufs');
  const outsideDirectory = path.join(root, 'outside');
  fs.mkdirSync(evidenceDirectory);
  fs.mkdirSync(outsideDirectory);
  const cutoffMs = Date.now() - 60_000;
  const outsideFile = path.join(outsideDirectory, 'active.out');
  writeFile(outsideFile, 'outside', cutoffMs - 60_000);

  const originalRealpathSync = fs.realpathSync;
  let replaced = false;
  fs.realpathSync = function interceptedRealpath(value, ...args) {
    if (!replaced && path.resolve(String(value)) === path.resolve(evidenceDirectory)) {
      replaced = true;
      fs.renameSync(evidenceDirectory, movedEvidenceDirectory);
      fs.symlinkSync(outsideDirectory, evidenceDirectory);
    }
    return originalRealpathSync.call(this, value, ...args);
  };
  t.after(() => { fs.realpathSync = originalRealpathSync; });

  const plan = planBufferFiles({
    directories: [outsideDirectory],
    cutoffMs,
    protectedPaths: [path.join(evidenceDirectory, 'active.out')]
  });
  assert.deepEqual(plan.protectedPaths, []);
  assert.deepEqual(plan.deletePaths, [path.join(originalRealpathSync(outsideDirectory), 'active.out')]);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside');
});

test('uses lstat, accepts regular files and FIFOs, and never follows symlinks', (t) => {
  const directory = tempDirectory(t);
  const cutoffMs = Date.now() - 60_000;
  const oldMs = cutoffMs - 60_000;
  const regularFile = path.join(directory, 'regular.out');
  const fifoFile = path.join(directory, 'active.pipe');
  const targetFile = path.join(directory, 'target.out');
  const symlinkFile = path.join(directory, 'alias.out');
  writeFile(regularFile, 'regular', oldMs);
  writeFile(targetFile, 'target', oldMs);
  fs.symlinkSync(targetFile, symlinkFile);

  const mkfifo = spawnSync('mkfifo', [fifoFile], { encoding: 'utf8' });
  if (mkfifo.status !== 0) {
    t.skip(`mkfifo unavailable: ${mkfifo.stderr || mkfifo.stdout}`);
    return;
  }
  const timestamp = new Date(oldMs);
  fs.utimesSync(fifoFile, timestamp, timestamp);

  const result = pruneBufferFiles({
    directories: [directory],
    cutoffMs,
    protectedPaths: [targetFile],
    unknownPaths: [fifoFile],
    dryRun: false
  });

  assert.deepEqual(result, { deleted: 1, protected: 1, deferred: 1 });
  assert.equal(fs.existsSync(regularFile), false);
  assert.equal(fs.existsSync(targetFile), true);
  assert.equal(fs.lstatSync(symlinkFile).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(fifoFile).isFIFO(), true);
});

test('defers a candidate replaced or refreshed after planning', (t) => {
  const directory = tempDirectory(t);
  const cutoffMs = Date.now() - 60_000;
  const oldMs = cutoffMs - 60_000;
  const candidate = path.join(directory, 'candidate.out');
  writeFile(candidate, 'old', oldMs);

  const replacedPlan = planBufferFiles({ directories: [directory], cutoffMs });
  fs.renameSync(candidate, `${candidate}.old`);
  writeFile(candidate, 'replacement', cutoffMs + 30_000);
  assert.deepEqual(applyBufferPlan(replacedPlan), { deleted: 0, protected: 0, deferred: 1 });
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'replacement');

  fs.rmSync(candidate);
  fs.renameSync(`${candidate}.old`, candidate);
  const refreshedPlan = planBufferFiles({ directories: [directory], cutoffMs });
  writeFile(candidate, 'refreshed', cutoffMs + 30_000);
  assert.deepEqual(applyBufferPlan(refreshedPlan), { deleted: 0, protected: 0, deferred: 1 });
  assert.equal(fs.readFileSync(candidate, 'utf8'), 'refreshed');
});

test('defers when a planned directory is replaced by a symlink', (t) => {
  const root = tempDirectory(t);
  const directory = path.join(root, 'bufs');
  const movedDirectory = path.join(root, 'moved-bufs');
  fs.mkdirSync(directory);
  const cutoffMs = Date.now() - 60_000;
  const candidate = path.join(directory, 'candidate.out');
  writeFile(candidate, 'old', cutoffMs - 60_000);

  const plan = planBufferFiles({ directories: [directory], cutoffMs });
  fs.renameSync(directory, movedDirectory);
  fs.symlinkSync(movedDirectory, directory);

  assert.deepEqual(applyBufferPlan(plan), { deleted: 0, protected: 0, deferred: 1 });
  assert.equal(fs.readFileSync(path.join(movedDirectory, 'candidate.out'), 'utf8'), 'old');
});
