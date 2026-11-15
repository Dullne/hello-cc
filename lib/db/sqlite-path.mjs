import path from 'node:path';

// SQLite's Windows VFS needs an extended-length filename even when Node's
// filesystem APIs already accept the same long path. Apply this only at the
// SQLite boundary, after callers validate and retain the ordinary path.
export function sqliteDatabasePath(filename) {
  if (process.platform !== 'win32' || typeof filename !== 'string' ||
      filename === '' || filename === ':memory:' || /^file:/i.test(filename)) return filename;
  return path.toNamespacedPath(filename);
}
