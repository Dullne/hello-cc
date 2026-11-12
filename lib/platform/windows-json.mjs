import fs from 'node:fs';
import path from 'node:path';
import { captureDirectory } from './windows-filesystem.mjs';
import { CliError } from '../shared/errors.mjs';

const MAX_JSON_BYTES = 10 * 1024 * 1024;

function requireMethod(object, name) {
  if (typeof object?.[name] !== 'function') throw new CliError('WINDOWS_NATIVE_UNAVAILABLE',
    `The Windows file component does not provide ${name}.`);
}

// Existing ancestry is opened without following reparse points. Every new
// component is created relative to a retained parent with a private DACL.
export function withWindowsJsonParent(filePath, fn) {
  const absolute = path.resolve(filePath);
  const missing = [];
  let ancestor = path.dirname(absolute);
  for (;;) {
    try { fs.lstatSync(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
  const held = [];
  try {
    const root = captureDirectory(ancestor, { pin: true }); held.push(root);
    let current = root.openDirectory(''); held.push(current);
    for (const name of missing) {
      requireMethod(current, 'createDirectory');
      let next;
      try { next = current.createDirectory(name, { private: true }); }
      catch (error) {
        if (error.code !== 'PROJECT_FILE_EXISTS') throw error;
        next = current.openDirectory(name);
      }
      held.push(next);
      // A concurrent creator must satisfy the same private-directory contract.
      if (next.security().private !== true) throw new CliError('PROJECT_PATH_FORBIDDEN',
        'The newly created JSON parent is not private.');
      current = next;
    }
    current.assertUnchanged();
    return fn(current, path.basename(absolute));
  } finally {
    for (const handle of held.reverse()) handle.close();
  }
}

export function writeWindowsJson(filePath, data) {
  const bytes = Buffer.from(JSON.stringify(data, null, 2) + '\n');
  if (bytes.length > MAX_JSON_BYTES) throw new CliError('BAD_ARGS', 'JSON file exceeds the 10 MiB write limit');
  return withWindowsJsonParent(filePath, (parent, name) => {
    requireMethod(parent, 'publish');
    let previous;
    let expectedIdentity;
    let expectedBytes;
    try {
      previous = parent.openFile(name);
      const snapshot = previous.snapshot();
      if (BigInt(snapshot.size) > BigInt(MAX_JSON_BYTES)) throw new CliError('BAD_ARGS',
        'Existing JSON file exceeds the 10 MiB write limit');
      expectedIdentity = snapshot.identity;
      expectedBytes = previous.read(MAX_JSON_BYTES);
      previous.assertUnchanged();
    } catch (error) {
      if (error.code !== 'PROJECT_FILE_NOT_FOUND') throw error;
    } finally { previous?.close(); }
    return parent.publish(name, bytes, {
      operation: expectedIdentity ? 'replace' : 'create', private: true,
      ...(expectedIdentity ? { expectedIdentity, expectedBytes } : {})
    });
  });
}
