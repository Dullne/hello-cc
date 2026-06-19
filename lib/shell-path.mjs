import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function pathEntryLine(shellType, position = 'final') {
  const suffix = position === 'early' ? 'early' : 'final';
  if (shellType === 'fish') return `set -gx PATH $HOME/.hcc-shims $PATH  # hello-cc shims (${suffix})`;
  return `_hcc_shims="$HOME/.hcc-shims"; PATH="\${PATH//:\${_hcc_shims}:/:}"; PATH="\${PATH#\${_hcc_shims}:}"; PATH="\${PATH%:\${_hcc_shims}}"; export PATH="\${_hcc_shims}:$PATH"; unset _hcc_shims  # hello-cc shims (${suffix})`;
}

export function removePathEntryLines(content) {
  return String(content || '')
    .split('\n')
    .filter(line => !isHelloCcShimPathLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

export function insertPathEntry(content, shellType) {
  const cleaned = removePathEntryLines(content);
  const finalLine = pathEntryLine(shellType, 'final');
  if (shellType === 'fish' || shellType === 'zsh') return `${cleaned}${cleaned ? '\n' : ''}${finalLine}\n`;

  const lines = cleaned ? cleaned.split('\n') : [];
  const earlyLine = pathEntryLine(shellType, 'early');
  let insertAt = 0;
  if (lines[0]?.startsWith('#!')) insertAt = 1;
  for (let i = insertAt; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text || text.startsWith('#')) continue;
    insertAt = i;
    break;
  }
  lines.splice(insertAt, 0, earlyLine);
  const withEarlyEntry = lines.join('\n').replace(/\s+$/, '');
  return `${withEarlyEntry}${withEarlyEntry ? '\n' : ''}${finalLine}\n`;
}

export function detectShellRc() {
  const shell = process.env.SHELL || '';
  if (shell.includes('zsh')) return { path: path.join(os.homedir(), '.zshrc'), type: 'zsh' };
  if (shell.includes('fish')) return { path: path.join(os.homedir(), '.config', 'fish', 'config.fish'), type: 'fish' };
  return { path: path.join(os.homedir(), '.bashrc'), type: 'bash' };
}

export function installPathEntry() {
  const { path: rcFile, type: shellType } = detectShellRc();
  let content = '';
  try { content = fs.readFileSync(rcFile, 'utf8'); } catch {}

  const next = insertPathEntry(content, shellType);
  const alreadyPresent = next === (content.endsWith('\n') ? content : `${content}\n`);
  if (!alreadyPresent) {
    fs.mkdirSync(path.dirname(rcFile), { recursive: true });
    fs.writeFileSync(rcFile, next);
  }
  return { rcFile, shellType, alreadyPresent };
}

export function uninstallPathEntry() {
  const { path: rcFile } = detectShellRc();
  let content = '';
  try {
    content = fs.readFileSync(rcFile, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { rcFile, removed: false, missing: true };
    return { rcFile, removed: false, error: 'could not read shell rc' };
  }
  const filtered = removePathEntryLines(content);
  if (filtered === content.replace(/\s+$/, '')) {
    return { rcFile, removed: false };
  }
  try {
    fs.writeFileSync(rcFile, filtered);
    return { rcFile, removed: true };
  } catch {
    return { rcFile, removed: false, error: 'could not modify shell rc' };
  }
}

function isHelloCcShimPathLine(line) {
  return String(line || '').includes('# hello-cc shims');
}
