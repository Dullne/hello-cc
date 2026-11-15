import { spawn } from 'node:child_process';
import { spawnWindowsOwnedProcess } from '../lib/platform/windows-process.mjs';

// The outer acceptance process owns the complete lifecycle Job. Its inner
// public CLI launches intentionally hand services back to that outer owner.
export function runWindowsAcceptanceCommand(file, argv, {
  cwd = process.cwd(), env = process.env, timeoutMs = 120000, stage, ownProcessTree = true
}) {
  return new Promise((resolve, reject) => {
    const child = ownProcessTree ? spawnWindowsOwnedProcess(file, argv, { cwd, env })
      : spawn(file, argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdin?.end();
    let stdout = '', stderr = '', bytesSeen = 0, failure, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve(stdout);
    };
    const fail = error => {
      if (failure) return;
      failure = error;
      if (ownProcessTree) {
        void child.close({ timeoutMs: 5000 }).then(() => finish(error), () => {
          error.cleanupUnconfirmed = true; finish(error);
        });
      } else {
        // These descendants remain inside the outer lifecycle Job. Detach
        // inherited output pipes after a failed CLI so they cannot hold its
        // caller's event loop while authenticated lifecycle cleanup runs.
        child.kill(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(error);
      }
    };
    const commandError = code => {
      let diagnostic, acceptanceMessage;
      try {
        const parsed = JSON.parse(stderr.trim() || stdout.trim());
        diagnostic = parsed.error?.code || parsed.code;
        if (parsed.success === false && typeof parsed.message === 'string') acceptanceMessage = parsed.message.slice(0, 500);
      } catch {}
      return Object.assign(new Error(`${stage}: command exited ${code}${diagnostic ? ` (${diagnostic})` : ''}${acceptanceMessage ? `: ${acceptanceMessage}` : ''}`), { stage, exitCode: code });
    };
    const timer = setTimeout(() => fail(new Error(`${stage}: command deadline exceeded`)), timeoutMs);
    const append = key => bytes => {
      bytesSeen += bytes.length;
      if (bytesSeen > 4 * 1024 * 1024) { fail(new Error(`${stage}: excessive command output`)); return; }
      if (key === 'out') stdout += bytes; else stderr += bytes;
    };
    child.stdout.on('data', append('out')); child.stderr.on('data', append('err'));
    child.once('error', error => fail(new Error(`${stage}: ${error.code || 'spawn failed'}`)));
    child.once('exit', code => { if (code !== 0) fail(commandError(code)); });
    child.once('close', code => {
      // Once cancellation starts, close() must confirm its own completion.
      // An owned child also emits close when observation failed, before that
      // promise rejects; settling here would lose cleanupUnconfirmed.
      if (failure) return;
      if (code !== 0) finish(commandError(code));
      else finish();
    });
  });
}
