import fs from 'node:fs/promises';

// Directory junctions exercise Windows reparse handling without requiring the
// symbolic-link privilege. A denied file-symlink fixture is recorded explicitly.
export async function directoryLink(target, filename) {
  return fs.symlink(target, filename, process.platform === 'win32' ? 'junction' : 'dir');
}

export async function fileLink(t, target, filename) {
  try { await fs.symlink(target, filename, 'file'); return true; }
  catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.diagnostic('File-symlink case requires SeCreateSymbolicLinkPrivilege or Developer Mode; directory-junction and hard-link cases still run.');
    return false;
  }
}
