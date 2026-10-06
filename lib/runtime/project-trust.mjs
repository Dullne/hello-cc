import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

// A private .hello-cc is only safe behind a pathname that another UID cannot
// rename. The ownership of the leaf alone is not sufficient: a writable
// non-sticky ancestor lets another UID replace its directory entry.
const aclCache = new Map();

export function unsafeDirectoryAcl(directory, stat = null) {
  let identity = stat;
  try { identity ||= fs.lstatSync(directory); }
  catch { return true; }
  const signature = `${identity.dev}:${identity.ino}:${identity.ctimeNs ?? identity.ctimeMs}`;
  // Number Stats carry milliseconds; BigInt Stats carry nanoseconds. Keep
  // both exact signatures instead of replacing one with the other on every
  // read through a different state-validation path.
  const cacheKey = `${typeof identity.dev === 'bigint' ? 'bigint' : 'number'}\0${directory}`;
  const cached = aclCache.get(cacheKey);
  if (cached?.signature === signature) return cached.unsafe;
  const ls = fs.existsSync('/bin/ls') ? '/bin/ls'
    : fs.existsSync('/usr/bin/ls') ? '/usr/bin/ls' : null;
  if (!ls) return true;
  const result = spawnSync(ls, process.platform === 'darwin'
    ? ['-lde', directory] : ['-ld', directory], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    env: { ...process.env, LC_ALL: 'C' }
  });
  if (result.status !== 0) return true;
  const [first, ...entries] = result.stdout.trim().split('\n');
  const permissions = first?.trim().split(/\s+/, 1)[0];
  if (!/^[-dlcbps][rwxStTs-]{9}[+@.]?$/.test(permissions)) return true;
  // A deny-only macOS ACL cannot grant another UID the ability to rebind a
  // directory entry. Unknown or allow ACL entries use the private fallback.
  const aclEntries = entries.filter((entry) => entry.trim().length > 0);
  const unsafe = process.platform === 'darwin'
    ? (aclEntries.length > 0
        ? aclEntries.some((entry) => !/^\s*\d+:\s+.+\sdeny\s+/.test(entry))
        : permissions[10] === '+')
    : permissions[10] === '+';
  if (aclCache.size >= 1024) aclCache.clear();
  aclCache.set(cacheKey, { signature, unsafe });
  return unsafe;
}

export function stableProjectStateRoot(root) {
  if (typeof process.getuid !== 'function') return null;
  const uid = process.getuid();
  let canonical;
  try { canonical = fs.realpathSync.native(path.resolve(root)); }
  catch { return null; }
  const parts = [];
  for (let current = canonical;; current = path.dirname(current)) {
    parts.push(current);
    if (path.dirname(current) === current) break;
  }
  parts.reverse();
  let parent = null;
  for (const component of parts) {
    let stat;
    try { stat = fs.lstatSync(component); }
    catch { return null; }
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
        (stat.uid !== uid && stat.uid !== 0) || unsafeDirectoryAcl(component, stat)) return null;
    if (parent) {
      const parentMode = parent.mode & 0o7777;
      if ((parentMode & 0o022) !== 0 &&
          ((parentMode & 0o1000) === 0 || (stat.uid !== uid && stat.uid !== 0))) {
        return null;
      }
    }
    parent = stat;
  }
  // A cross-UID-writable root can have its .hello-cc entry replaced. Keep its
  // state under the user's private state directory even when root is sticky.
  if ((parent.mode & 0o022) !== 0) return null;
  // A stable but read-only server directory (for example /etc) cannot host a
  // new project-local state directory. It remains selectable via private state.
  try { fs.accessSync(canonical, fs.constants.W_OK | fs.constants.X_OK); }
  catch { return null; }
  return canonical;
}
