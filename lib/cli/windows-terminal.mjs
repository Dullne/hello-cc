import path from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { ensureTerminalHost } from '../terminal/client.mjs';
import { ensurePrivateProjectStateDir } from '../runtime/private-state.mjs';
import { captureSelectedCwdSnapshot, sameSelectedCwdIdentity, assertSelectedCwdSnapshot } from '../process/selected-cwd-identity.mjs';
import { launchEnvironmentFingerprint } from '../core/sessions/launch.mjs';
import { CliError } from '../shared/errors.mjs';

function projectContext(ctx) {
  const rootIdentity = ctx.initialRootIdentity || captureSelectedCwdSnapshot(ctx.root);
  assertSelectedCwdSnapshot(rootIdentity);
  return { root: rootIdentity.canonical, rootIdentity,
    stateDir: ensurePrivateProjectStateDir(rootIdentity.canonical), dbPath: path.resolve(ctx.dbPath) };
}
function sameProject(session, project) {
  return session.project?.root === project.root && session.project?.dbPath === project.dbPath &&
    sameSelectedCwdIdentity(session.project.rootIdentity, project.rootIdentity);
}
export async function listWindowsTerminals(ctx) {
  const project = projectContext(ctx), client = await ensureTerminalHost();
  return { client, sessions: (await client.list()).filter(session => sameProject(session, project)) };
}
export async function findWindowsTerminal(ctx, peer) {
  const { client, sessions } = await listWindowsTerminals(ctx);
  const selected = sessions.filter(session => session.peerId === peer || session.id === peer);
  if (selected.length !== 1) throw new CliError(selected.length ? 'TERMINAL_AMBIGUOUS' : 'TERMINAL_NOT_FOUND',
    selected.length ? 'More than one managed terminal matches this peer' : 'No managed terminal belongs to this peer in the selected project');
  return { client, session: selected[0] };
}

export async function createWindowsTerminal(ctx, input, { restartOnEnvChange = false } = {}) {
  const project = projectContext(ctx), client = await ensureTerminalHost();
  const existing = (await client.list()).find(session => session.peerId === input.peerId && sameProject(session, project));
  const requested = { ...input, project, id: 'wt-' + createHash('sha256')
    .update(JSON.stringify([project.root, project.dbPath, input.peerId])).digest('hex').slice(0, 32) };
  if (existing?.status === 'running') {
    const sameCommand = existing.command?.file === input.command.file &&
      JSON.stringify(existing.command.args) === JSON.stringify(input.command.args) &&
      sameSelectedCwdIdentity(existing.cwdIdentity, input.cwdIdentity);
    const sameEnvironment = existing.environmentFingerprint === launchEnvironmentFingerprint(input.env);
    if (sameCommand && sameEnvironment) return { client, session: existing, already: true };
    if (!sameCommand || !restartOnEnvChange) throw new CliError('TERMINAL_EXISTS',
      'This peer already has a managed terminal with different launch settings; inspect it before replacing it');
    await stopWindowsTerminalSession(client, existing, { force: true });
    await client.forget(existing.id, existing.generation);
  } else if (existing) {
    if (existing.status !== 'exited') throw new CliError('TERMINAL_CLOSE_UNCONFIRMED', 'The previous terminal has not confirmed its exit');
    await client.forget(existing.id, existing.generation);
  }
  return { client, session: await client.create(requested), already: false };
}

export async function stopWindowsTerminalSession(client, session, { force = false } = {}) {
  if (session.status === 'exited') return session;
  const connection = await client.connect(session.id, session.generation);
  try {
    if (!connection.control?.can_control) {
      if (!force) throw new CliError('CONTROL_HELD', 'Another viewer controls this terminal; use --force to take control before stopping it');
      await connection.action({ type: 'claim', epoch: connection.control.epoch, takeover: true });
    }
    return await connection.action({ type: 'terminate', epoch: connection.control.epoch });
  } finally { connection.close(); }
}

export async function attachWindowsTerminalSession(client, session, {
  input = process.stdin, output = process.stdout, errors = process.stderr, force = false
} = {}) {
  let connection, settled = false, attached = false, sequence = -1, earlyExit = null;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const decoder = new StringDecoder('utf8');
  let actions = Promise.resolve(), detaching = false;
  const wasRaw = Boolean(input.isRaw);
  const finish = (result, error) => {
    if (settled) return;
    settled = true;
    input.removeListener('data', onData); input.removeListener('end', onEnd); input.pause();
    output.removeListener('resize', onResize);
    process.removeListener('SIGTERM', onEnd); process.removeListener('SIGHUP', onEnd);
    if (input.isTTY) input.setRawMode(wasRaw);
    connection?.close();
    if (error) rejectDone(error); else resolveDone(result);
  };
  const exited = event => {
    if (!attached) { earlyExit = event; return; }
    if (event?.uncertain || event?.unconfirmed) finish(null, new CliError('TERMINAL_CLOSE_UNCONFIRMED', 'Terminal exit could not be confirmed'));
    else finish({ detached: false, exitCode: event?.exitCode ?? 0 });
  };
  const send = message => {
    actions = actions.then(async () => {
      if (settled) return;
      await connection.action({ ...message, epoch: connection.control.epoch });
    }).catch(error => finish(null, error));
    return actions;
  };
  const detach = () => {
    if (detaching || settled) return;
    detaching = true; input.pause();
    actions = actions.then(async () => {
      if (settled) return;
      if (connection.control?.can_control) await connection.action({ type: 'release', epoch: connection.control.epoch });
      finish({ detached: true, exitCode: null });
    }).catch(error => finish(null, error));
  };
  function onEnd() { detach(); }
  function onResize() {
    if (connection?.control?.can_control && output.columns && output.rows) send({ type: 'resize', cols: output.columns, rows: output.rows });
  }
  function onData(raw) {
    if (detaching || settled) return;
    const text = typeof raw === 'string' ? raw : decoder.write(raw);
    const marker = text.indexOf('\x1d'), accepted = marker < 0 ? text : text.slice(0, marker);
    if (accepted && connection.control?.can_control) {
      input.pause();
      const bytes = Buffer.from(accepted), chunks = new StringDecoder('utf8');
      for (let offset = 0; offset < bytes.length; offset += 60000) {
        const data = chunks.write(bytes.subarray(offset, offset + 60000));
        if (data) send({ type: 'input', data });
      }
      const tail = chunks.end(); if (tail) send({ type: 'input', data: tail });
      void actions.then(() => { if (!detaching && !settled) input.resume(); });
    }
    if (marker >= 0) detach();
  }
  try {
    connection = await client.connect(session.id, session.generation, { onFrame(frame) {
      if (settled) return;
      if (frame.type === 'snapshot') {
        if (sequence < 0) { output.write(frame.screen); sequence = frame.sequence; }
        if (frame.session.status === 'exited') exited(frame.session.exit);
        if (frame.session.status === 'close_unconfirmed') exited({ uncertain: true });
      } else if (frame.type === 'data' && frame.sequence > sequence) {
        output.write(frame.data); sequence = frame.sequence;
      } else if (frame.type === 'exit') exited(frame.event);
      else if (frame.type === 'disconnected') finish(null, new CliError('TERMINAL_CLIENT_DISCONNECTED',
        'Terminal connection closed; reconnect for its current screen before sending more input'));
    } });
    attached = true;
    if (earlyExit) exited(earlyExit);
    if (settled) { connection.close(); return done; }
    if (!connection.control?.can_control && force) await connection.action({ type: 'claim', epoch: connection.control.epoch, takeover: true });
    errors.write(connection.control?.can_control
      ? '\r\nAttached. Press Ctrl+] to detach and leave this terminal running.\r\n'
      : '\r\nViewing this terminal. Another client controls input; use --force to take control. Ctrl+] detaches.\r\n');
    if (input.isTTY) input.setRawMode(true);
    input.on('data', onData); input.once('end', onEnd); input.resume(); output.on('resize', onResize);
    process.once('SIGTERM', onEnd); process.once('SIGHUP', onEnd);
    onResize();
  } catch (error) { finish(null, error); }
  return done;
}
