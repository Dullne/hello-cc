import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

function candidatePorts(root) {
  // Keep the fixture's bind-only availability check aligned with the four
  // deterministic candidates in lib/shared/file-lock.mjs.
  const key = path.join(root, '.hello-cc', 'native', 'service-owner');
  const ports = [];
  for (let index = 0; ports.length < 4; index += 1) {
    const input = index === 0 ? key : `hcc-file-lock-port-v1\0${index}\0${key}`;
    const port = 20_000 + createHash('sha256').update(input).digest().readUInt32BE(0) % 40_000;
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

// This removes environmental collisions from fixtures; it does not relax the
// product's conservative refusal of an unidentified listener. Bind only our
// candidate ports, never connect to or inspect an existing process.
export async function createNativeTestRoot(prefix) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    const listeners = [];
    let failure;
    try {
      for (const port of candidatePorts(root)) {
        const listener = net.createServer();
        listeners.push(listener);
        await new Promise((resolve, reject) => {
          listener.once('error', reject);
          listener.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
        });
      }
    } catch (error) { failure = error; }
    finally {
      await Promise.all(listeners.map((listener) => new Promise((resolve, reject) => listener.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }))));
    }
    if (!failure) return root;
    fs.rmSync(root, { recursive: true, force: true });
    if (failure.code !== 'EADDRINUSE') throw failure;
  }
  throw new Error('Could not allocate a native test root with four available ownership ports');
}
