import { findWindowsTerminal } from './windows-terminal.mjs';
import { CliError } from '../shared/errors.mjs';

export async function injectWindowsTerminal(ctx, peer, data) {
  const { client, session } = await findWindowsTerminal(ctx, peer);
  if (session.status !== 'running') throw new CliError('SESSION_NOT_RUNNING', 'Terminal is not running');
  const connection = await client.connect(session.id, session.generation);
  try {
    if (!connection.control.can_control) throw new CliError('CONTROL_HELD',
      'Another client controls this terminal; release it before CLI injection');
    await connection.action({ type: 'input', epoch: connection.control.epoch, data });
    return { session: { id: session.id, peer_id: session.peerId, type: 'windows-terminal' }, bytes: Buffer.byteLength(data) };
  } finally {
    // An acknowledged one-shot injection does not retain the controller grace
    // period and block the next CLI invocation or a browser attachment.
    if (connection.control?.can_control) {
      try { await connection.action({ type: 'release', epoch: connection.control.epoch }); } catch {}
    }
    connection.close();
  }
}
