import fs from 'node:fs';
import path from 'node:path';
import { CliError } from '../shared/errors.mjs';
import { captureDirectory, inspectDirectory } from '../platform/windows-filesystem.mjs';
import { sameWindowsFileIdentity } from '../platform/windows-private-state.mjs';

function changed() {
  return new CliError('PROJECT_PATH_CHANGED', 'Selected working directory changed; create a new session from its current location');
}

function sameDirectory(left, right) {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev &&
    left.ino === right.ino && left.birthtimeNs === right.birthtimeNs;
}

export function sameSelectedCwdIdentity(left, right) {
  if (!left || !right || typeof left.canonical !== 'string' || left.canonical !== right.canonical) return false;
  if (left.identity?.platform === 'win32' || right.identity?.platform === 'win32') {
    return sameWindowsFileIdentity(left.identity, right.identity);
  }
  const valid = identity => identity && identity.platform === undefined &&
    typeof identity.dev === 'string' && /^(0|[1-9][0-9]*)$/.test(identity.dev) &&
    typeof identity.ino === 'string' && /^(0|[1-9][0-9]*)$/.test(identity.ino) &&
    (identity.birthtimeNs === null || (typeof identity.birthtimeNs === 'string' &&
      /^(0|[1-9][0-9]*)$/.test(identity.birthtimeNs)));
  return Boolean(valid(left.identity) && valid(right.identity) &&
    left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino &&
    left.identity.birthtimeNs === right.identity.birthtimeNs);
}

export function captureSelectedCwdSnapshot(cwd) {
  const binding = captureSelectedCwdIdentity(cwd);
  try {
    return Object.freeze({ requested: binding.requested, canonical: binding.canonical,
      identity: binding.identity });
  } finally { binding.release(); }
}

export function assertSelectedCwdSnapshot(snapshot) {
  const current = captureSelectedCwdIdentity(snapshot.requested);
  try {
    if (!sameSelectedCwdIdentity(snapshot, current)) throw changed();
  } finally { current.release(); }
}

// A provider protocol may require an absolute path even after its process was
// started in a pinned cwd. Keep the originally selected directory identifiable
// until the adapter closes, and recheck immediately before each path handoff.
// This does not make the subsequent provider-internal path lookup atomic.
export function captureSelectedCwdIdentity(cwd, expectedIdentity = null) {
  if (typeof cwd !== 'string' || !cwd) throw new CliError('BAD_ARGS', 'Selected working directory is required');
  const requested = path.resolve(cwd);
  let canonical;
  try { canonical = fs.realpathSync.native(requested); }
  catch { throw changed(); }

  if (process.platform === 'win32') return captureWindowsIdentity(requested, canonical, expectedIdentity);

  let fd;
  let initial;
  let mode = 'descriptor';
  try {
    fd = fs.openSync(canonical, fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
    initial = fs.fstatSync(fd, { bigint: true });
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fd = undefined;
    // Execute-only directories can still be valid provider workspaces. The
    // weaker stat-only mode preserves that contract without hiding the mode.
    if (error?.code !== 'EACCES') throw changed();
    mode = 'stat-only';
    try { initial = fs.statSync(canonical, { bigint: true }); }
    catch { throw changed(); }
  }
  let released = false;
  const identity = Object.freeze({ dev: initial.dev.toString(), ino: initial.ino.toString(),
    birthtimeNs: initial.birthtimeNs?.toString() || null });
  const binding = {
    requested, canonical, mode, identity,
    assertUnchanged() {
      if (released) throw changed();
      try {
        const selected = fs.statSync(requested, { bigint: true });
        const target = fs.statSync(canonical, { bigint: true });
        const original = fd === undefined ? initial : fs.fstatSync(fd, { bigint: true });
        if (!sameDirectory(initial, original) || !sameDirectory(initial, selected) ||
            !sameDirectory(initial, target)) throw changed();
      } catch { throw changed(); }
    },
    dropDescriptor() {
      if (released) return;
      if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
      binding.mode = 'stat-only';
    },
    release() {
      if (released) return;
      released = true;
      if (fd !== undefined) { fs.closeSync(fd); fd = undefined; }
    }
  };
  try {
    binding.assertUnchanged();
    if (expectedIdentity && !sameSelectedCwdIdentity(expectedIdentity, binding)) throw changed();
  }
  catch (error) { binding.release(); throw error; }
  return binding;
}

function captureWindowsIdentity(requested, canonical, expectedIdentity) {
  // Observation is deliberately non-mutating. A process launch must acquire a
  // separate pinned lease for the entire native operation that needs one.
  let lease = captureDirectory(canonical, { pin: false });
  const snapshot = lease.snapshot();
  canonical = snapshot.canonical;
  const identity = Object.freeze({ ...snapshot.identity });
  let released = false;
  const binding = {
    requested, canonical, mode: 'observed', identity,
    assertUnchanged() {
      if (released) throw changed();
      try {
        lease?.assertUnchanged();
        const selected = inspectDirectory(fs.realpathSync.native(requested));
        const target = inspectDirectory(canonical);
        if (!sameSelectedCwdIdentity(binding, selected) || !sameSelectedCwdIdentity(binding, target)) throw changed();
      } catch { throw changed(); }
    },
    dropDescriptor() {
      if (released) return;
      lease?.close(); lease = null;
      binding.mode = 'snapshot';
    },
    release() {
      if (released) return;
      released = true;
      lease?.close(); lease = null;
    }
  };
  try {
    binding.assertUnchanged();
    if (expectedIdentity && !sameSelectedCwdIdentity(expectedIdentity, binding)) throw changed();
  } catch (error) { binding.release(); throw error; }
  return binding;
}
