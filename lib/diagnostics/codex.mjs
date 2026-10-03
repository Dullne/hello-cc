import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'];
const INVOCATION_TYPES = ['hook.sessionstart', 'hook.userpromptsubmit', 'hook.pretooluse', 'hook.posttooluse', 'hook.stop'];
const MAX_PROBE_BYTES = 64 * 1024;
const MAX_HOOK_BYTES = 1024 * 1024;

export function unknownCodexDiagnostics(reason = 'diagnostic_unavailable') {
  return { installed: { status: 'unknown' }, version: { status: 'unknown', value: null, reason },
    app_server: { status: 'unknown', startup_arguments: null, protocol_handshake: 'unknown', reason },
    hooks: { configuration: { status: 'unknown', reason }, invocation: { status: 'unknown', evidence: null, reason },
      stdout_delivery_receipt: { status: 'unknown', reason: 'no_explicit_stdout_delivery_receipt_is_recorded' },
      provider_acceptance: 'unknown', trust: 'unknown' }, inference_called: false };
}

function probeFailure(result) {
  if (result?.error?.code === 'ENOENT') return 'not_found';
  if (result?.error?.code === 'ETIMEDOUT') return 'timed_out';
  return 'probe_failed';
}

function runProbe(args, ctx, env, run) {
  try {
    return run('codex', args, { cwd: ctx.root,
      env: { ...env, HCC_SHIM_NO_ATTACH: '1', HCC_SHIM_ENSURED: '1' },
      encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', maxBuffer: MAX_PROBE_BYTES,
      shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return { status: null, error: { code: 'PROBE_FAILED' } };
  }
}

function isolatedProbes(ctx, env, run) {
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hcc-codex-doctor-'));
    const probeHome = path.join(directory, 'home');
    const probeCodexHome = path.join(directory, 'codex-home');
    fs.mkdirSync(probeHome); fs.mkdirSync(probeCodexHome);
    // Even --version/--help can create Codex startup wrappers. Keep those
    // writes away from the user's account/configuration directories.
    const probeEnv = { ...env, HOME: probeHome, USERPROFILE: probeHome, CODEX_HOME: probeCodexHome };
    return { version: runProbe(['--version'], ctx, probeEnv, run),
      help: runProbe(['app-server', '--help'], ctx, probeEnv, run) };
  } catch {
    const unavailable = { status: null, error: { code: 'PROBE_FAILED' } };
    return { version: unavailable, help: unavailable };
  } finally {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
}

function hooksConfiguration(env, homedir) {
  const directory = env.CODEX_HOME || path.join(homedir(), '.codex');
  const file = path.resolve(directory, 'hooks.json');
  const result = { status: 'unknown', path: file, matched_events: [], required_events: [...HOOK_EVENTS] };
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > MAX_HOOK_BYTES) return { ...result, reason: 'unreadable_configuration' };
    // Only this hooks file is inspected. Commands and arbitrary configuration
    // values never enter the diagnostic output or get executed.
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const event of HOOK_EVENTS) {
      const entries = value?.hooks?.[event];
      if (Array.isArray(entries) && entries.some(entry => Array.isArray(entry?.hooks) &&
          entry.hooks.some(hook => hook?.type === 'command' && typeof hook.command === 'string' &&
            (/\bhcc\b.*\bhook\b/.test(hook.command) || /hello-cc.*hook/.test(hook.command))))) {
        result.matched_events.push(event);
      }
    }
    return { ...result, status: result.matched_events.length === HOOK_EVENTS.length ? 'present' : 'missing' };
  } catch (error) {
    return { ...result, status: error?.code === 'ENOENT' ? 'missing' : 'unknown',
      reason: error?.code === 'ENOENT' ? 'file_not_found' : 'unreadable_configuration' };
  }
}

function hookInvocation(db) {
  const result = { status: 'unknown', evidence: null, provider_at_event: 'unknown',
    scope: 'project events matched to the current Codex peer kind; historical provider identity is not verified' };
  try {
    const placeholders = INVOCATION_TYPES.map(() => '?').join(',');
    const row = db.prepare(`SELECT e.id, e.type, e.created_at FROM events e
      JOIN peers p ON p.id = e.actor WHERE p.kind = 'codex' AND e.type IN (${placeholders})
      ORDER BY e.id DESC LIMIT 1`).get(...INVOCATION_TYPES);
    return row ? { ...result, status: 'present', evidence: { event_id: row.id, type: row.type, created_at: row.created_at } }
      : { ...result, reason: 'no_matching_invocation' };
  } catch {
    return { ...result, reason: 'events_unavailable' };
  }
}

// Explicitly opt-in and read-only: no server/session is started, hooks are not
// executed, and no account, auth.json, config.toml or trust state is inspected.
export function diagnoseCodex(ctx, db, { env = process.env, run = spawnSync, homedir = os.homedir } = {}) {
  const probes = isolatedProbes(ctx, env, run);
  const versionProbe = probes.version;
  const versionText = !versionProbe.error && versionProbe.status === 0 ? String(versionProbe.stdout || '').trim() : '';
  const match = versionText.match(/^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)$/);
  const version = match ? { status: 'known', value: match[1], evidence: 'codex --version' }
    : { status: 'unknown', value: null, reason: versionText ? 'unexpected_output' : probeFailure(versionProbe) };
  const helpProbe = probes.help;
  const help = !helpProbe.error && helpProbe.status === 0 ? String(helpProbe.stdout || '') : '';
  const advertised = /\bUsage:\s+codex\s+app-server(?:\s|$)/i.test(help);
  const startup = /(?:^|\s)--listen(?=\s|[=,]|$)/m.test(help) && /stdio:\/\//.test(help)
    ? ['--listen', 'stdio://'] : /(?:^|\s)--stdio(?=\s|[=,]|$)/m.test(help) ? ['--stdio'] : null;
  const appServer = { status: advertised ? 'advertised' : 'unknown',
    startup_arguments: advertised ? startup : null, protocol_handshake: 'unknown',
    ...(advertised ? { evidence: 'codex app-server --help' }
      : { reason: help ? 'unexpected_output' : probeFailure(helpProbe) }) };
  return { installed: { status: match || advertised ? 'present'
      : versionProbe.error?.code === 'ENOENT' && helpProbe.error?.code === 'ENOENT' ? 'missing' : 'unknown' },
    version, app_server: appServer,
    hooks: { configuration: hooksConfiguration(env, homedir), invocation: hookInvocation(db),
      stdout_delivery_receipt: { status: 'unknown', reason: 'no_explicit_stdout_delivery_receipt_is_recorded' },
      provider_acceptance: 'unknown', trust: 'unknown' },
    inference_called: false };
}
