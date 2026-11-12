import path from 'node:path';
import fs from 'node:fs';
import { CliError } from '../../shared/errors.mjs';
import { assertSelectedCwdSnapshot, captureSelectedCwdSnapshot,
  sameSelectedCwdIdentity } from '../../process/selected-cwd-identity.mjs';
import { buildCodexCommand } from '../../integrations/providers.mjs';
import { isWindowsFileIdentity } from '../../platform/windows-private-state.mjs';
import { resolveWindowsCommand } from '../../platform/windows-command.mjs';

export const CODEX_THREAD_ROOT_EVENT = 'codex.thread.root-bound';
export const CODEX_SESSION_ORIGIN_ENV = 'HCC_CODEX_SESSION_ORIGIN';

function windowsCodexArguments(argv, { env = process.env, cwd = process.cwd() } = {}) {
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== 'string')) return null;
  try {
    const expected = resolveWindowsCommand('codex', { env, cwd });
    const actual = resolveWindowsCommand(argv[0], { env, cwd });
    const sameFile = (left, right) => fs.realpathSync.native(path.resolve(cwd, left)) === fs.realpathSync.native(path.resolve(cwd, right));
    if (!sameFile(expected.file, actual.file)) return null;
    const args = [...actual.args, ...argv.slice(1)];
    if (args.length < expected.args.length) return null;
    // Only the resolver's exact interpreter prefix is removed. In particular,
    // extra Node flags, alternate scripts, and arbitrary executables cannot
    // become first-party Codex commands merely by declaring kind=codex.
    for (let index = 0; index < expected.args.length; index += 1) {
      const fileArgument = expected.kind === 'node-script' && index === 0 ||
        expected.kind === 'powershell-script' && index === expected.args.length - 1;
      if (fileArgument ? !sameFile(expected.args[index], args[index]) : expected.args[index] !== args[index]) return null;
    }
    return args.slice(expected.args.length);
  } catch { return null; }
}

export function isDirectCodexNewInvocation(argv, options = {}) {
  if (process.platform === 'win32') return windowsCodexArguments(argv, options)?.length === 0;
  return Array.isArray(argv) && argv.length === 1 && typeof argv[0] === 'string' && path.basename(argv[0]) === 'codex';
}

function unverified() {
  return new CliError('CODEX_HISTORY_UNVERIFIED',
    'Codex thread has no trustworthy original project identity; manual review and association are required');
}

function invalid() {
  return new CliError('CODEX_HISTORY_BINDING_INVALID',
    'Codex thread has an invalid or conflicting original project identity');
}

function checkedThreadId(threadId) {
  if (typeof threadId !== 'string' || !threadId.trim() || threadId.length > 512 || /[\r\n\0]/.test(threadId)) {
    throw new CliError('BAD_REQUEST', 'A bounded Codex thread identity is required');
  }
  return threadId;
}

function rootIsValid(root) {
  if (typeof root?.canonical !== 'string' || !path.isAbsolute(root.canonical)) return false;
  if (root.identity?.platform === 'win32') return isWindowsFileIdentity(root.identity);
  return typeof root.identity?.dev === 'string' && /^\d+$/.test(root.identity.dev) &&
    typeof root.identity?.ino === 'string' && /^\d+$/.test(root.identity.ino) &&
    (root.identity?.birthtimeNs === null ||
      (typeof root.identity?.birthtimeNs === 'string' && /^\d+$/.test(root.identity.birthtimeNs)));
}

export function selectedCodexRootSnapshot(root, expected = null) {
  if (typeof expected?.assertUnchanged === 'function') expected.assertUnchanged();
  else if (expected) assertSelectedCwdSnapshot(expected);
  const snapshot = captureSelectedCwdSnapshot(root);
  if (expected && !sameSelectedCwdIdentity(snapshot, expected)) {
    throw new CliError('PROJECT_PATH_CHANGED', 'Selected project directory changed');
  }
  return snapshot;
}

// event.actor is the thread ID so corrupt receipt payloads can be isolated to
// their own thread. Unknown or invalid receipts never fall back to cwd text.
export function readCodexThreadRootBindings(db, threadId = null) {
  const bindings = new Map();
  const rows = threadId === null
    ? db.prepare('SELECT actor,payload FROM events WHERE type = ?').all(CODEX_THREAD_ROOT_EVENT)
    : db.prepare('SELECT actor,payload FROM events WHERE type = ? AND actor = ?')
      .all(CODEX_THREAD_ROOT_EVENT, checkedThreadId(threadId));
  for (const row of rows) {
    const id = row.actor;
    if (typeof id !== 'string' || !id || id.length > 512 || /[\r\n\0]/.test(id)) continue;
    let payload;
    try { payload = JSON.parse(row.payload); } catch { bindings.set(id, null); continue; }
    const root = payload?.root;
    if (payload?.version !== 1 || payload.thread_id !== id || !rootIsValid(root)) {
      bindings.set(id, null);
      continue;
    }
    const previous = bindings.get(id);
    if (previous === null || (previous && !sameSelectedCwdIdentity(previous, root))) {
      bindings.set(id, null);
    } else {
      bindings.set(id, root);
    }
  }
  return bindings;
}

export function assertCodexThreadRoot(db, threadId, selected, knownBindings = null) {
  checkedThreadId(threadId);
  if (typeof selected?.assertUnchanged === 'function') selected.assertUnchanged();
  else assertSelectedCwdSnapshot(selected);
  const bindings = knownBindings || readCodexThreadRootBindings(db, threadId);
  if (!bindings.has(threadId)) throw unverified();
  const original = bindings.get(threadId);
  if (!original) throw invalid();
  if (!sameSelectedCwdIdentity(original, selected)) {
    throw new CliError('PROJECT_PATH_FORBIDDEN', 'Codex thread belongs to a different project directory identity');
  }
  return original;
}

export function recordCodexThreadRoot(db, addEvent, threadId, selected, origin, { allowSame = false } = {}) {
  checkedThreadId(threadId);
  if (typeof selected?.assertUnchanged === 'function') selected.assertUnchanged();
  else assertSelectedCwdSnapshot(selected);
  const bindings = readCodexThreadRootBindings(db, threadId);
  if (bindings.has(threadId)) {
    if (allowSame && bindings.get(threadId) && sameSelectedCwdIdentity(bindings.get(threadId), selected)) return false;
    throw new CliError('CODEX_THREAD_ALREADY_BOUND', 'Codex thread already has a project identity');
  }
  addEvent(db, CODEX_THREAD_ROOT_EVENT, threadId, null, {
    version: 1, thread_id: threadId,
    root: { canonical: selected.canonical, identity: selected.identity }, origin
  });
  return true;
}

// Validate the command we will actually launch, not only a caller-supplied
// binding: a binding for thread X must never authorize `codex resume Y`.
// Return an origin marker only for a first-party new/fork command whose hook
// can safely persist the resulting thread's launch-time directory identity.
export function assertCodexTerminalLaunch(db, binding, { command, root, rootIdentity = null,
  cwd = root, cwdIdentity = null, argv = null, env = process.env } = {}) {
  if (binding?.provider !== 'codex') return null;
  const mode = binding.resume_mode || 'command';
  if (!['new', 'resume', 'fork', 'last', 'fork-last'].includes(mode)) return null;
  const selectedRoot = selectedCodexRootSnapshot(root, rootIdentity);
  const selectedCwd = selectedCodexRootSnapshot(cwd, cwdIdentity);
  if (!sameSelectedCwdIdentity(selectedRoot, selectedCwd)) {
    if (mode === 'new') return null;
    throw new CliError('PROJECT_PATH_FORBIDDEN', 'Codex history can only be opened in its selected project directory');
  }
  if (mode === 'new') {
    const directNew = isDirectCodexNewInvocation(argv, { env, cwd });
    return directNew || (process.platform !== 'win32' && !argv && command === 'codex') ? 'new' : null;
  }
  if (mode === 'last' || mode === 'fork-last') {
    throw new CliError('CODEX_HISTORY_ID_REQUIRED',
      'Codex --last cannot prove the selected thread identity; choose an explicit verified thread ID');
  }
  if (!binding.resume_arg) {
    throw new CliError('CODEX_HISTORY_ID_REQUIRED', 'Choose an explicit verified Codex thread ID');
  }
  const sourceId = checkedThreadId(binding.resume_arg);
  const expected = buildCodexCommand('history-check', mode === 'fork'
    ? { fork: true, resume: sourceId } : { resume: sourceId }).command;
  const windowsArgs = process.platform === 'win32' ? windowsCodexArguments(argv, { env, cwd }) : null;
  const commandMatches = process.platform === 'win32'
    ? windowsArgs?.length === 2 && windowsArgs[0] === mode && windowsArgs[1] === sourceId
    : Array.isArray(argv)
      ? argv.length === 3 && path.basename(argv[0]) === 'codex' && argv[1] === mode && argv[2] === sourceId
      : command === expected && (!binding.command || binding.command === expected);
  if (!commandMatches ||
      (mode === 'resume' && ((binding.provider_session_id && binding.provider_session_id !== sourceId) ||
        (binding.provider_session_name && binding.provider_session_name !== sourceId)))) {
    throw new CliError('CODEX_HISTORY_COMMAND_UNVERIFIED',
      'Codex history command does not match the verified thread identity');
  }
  assertCodexThreadRoot(db, sourceId, selectedRoot);
  return mode === 'fork' ? 'fork' : null;
}
