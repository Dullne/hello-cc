import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planBufferFiles, applyBufferPlan } from '../lib/runtime/buffer-gc.mjs';
import { applyClockSafeBufferPlan } from '../lib/runtime/buffer-gc-protocol.mjs';

test('Windows GC defers legacy buffer files without treating age as ownership', { skip: process.platform !== 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-win-buffer-gc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'legacy.out'); fs.writeFileSync(file, 'owned by an unknown legacy producer');
  fs.utimesSync(file, new Date(0), new Date(0));
  const plan = planBufferFiles({ directories: [dir], cutoffMs: Date.now() });
  assert.equal(plan.deleteEntries.length, 0);
  assert.deepEqual(plan.unknownPaths, [file]);
  assert.deepEqual(applyBufferPlan(plan), { deleted: 0, protected: 0, deferred: 1 });
  assert.equal(fs.readFileSync(file, 'utf8'), 'owned by an unknown legacy producer');
});

test('Windows GC cannot execute a stored POSIX deletion plan', { skip: process.platform !== 'win32' }, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-win-buffer-plan-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'legacy.out'); fs.writeFileSync(file, 'keep');
  const stat = fs.lstatSync(file), directory = fs.lstatSync(dir);
  const plan = { cutoffMs: Date.now() + 1000, protectedEntries: [], unknownEntries: [], deleteEntries: [{
    path: file, directory: { path: dir, identity: `${directory.dev}:${directory.ino}` },
    stat: Object.fromEntries(['dev', 'ino', 'mode', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]))
  }] };
  assert.deepEqual(applyBufferPlan(plan), { deleted: 0, protected: 0, deferred: 1 });
  let batches = 0, observed = 0;
  const db = new Proxy({}, { get() { throw new Error('Unsupported Windows buffer apply must not mutate SQL clock state'); } });
  assert.deepEqual(applyClockSafeBufferPlan({ db, plan, retentionSec: 0,
    afterBatch: () => { batches++; }, nowSec: () => { observed++; return 1; } }),
  { deleted: 0, protected: 0, deferred: 1, complete: false, graceActive: false });
  assert.equal(batches, 0); assert.equal(observed, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

test('Windows empty buffer plan completes without taking POSIX deletion leases', { skip: process.platform !== 'win32' }, () => {
  const plan = { cutoffMs: Date.now(), protectedEntries: [], unknownEntries: [], deleteEntries: [] };
  const db = new Proxy({}, { get() { throw new Error('Empty plan does not need a buffer transaction'); } });
  assert.deepEqual(applyClockSafeBufferPlan({ db, plan, retentionSec: 0 }),
    { deleted: 0, protected: 0, deferred: 0, complete: true, graceActive: false });
});
