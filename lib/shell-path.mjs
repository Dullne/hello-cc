import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export function pathEntryLine(shellType) {
  if (shellType === 'fish') return 'set -gx PATH $HOME/.hcc-shims $PATH  # hello-cc shims';
  return '_hcc_shims="$HOME/.hcc-shims"; PATH="${PATH//:${_hcc_shims}:/:}"; PATH="${PATH#${_hcc_shims}:}"; PATH="${PATH%:${_hcc_shims}}"; export PATH="${_hcc_shims}:$PATH"; unset _hcc_shims  # hello-cc shims';
}

export function removePathEntryLines(content) {
  return String(content || '')
    .split('\n')
    .filter(line => !line.includes('.hcc-shims'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
}

export function insertPathEntry(content, shellType) {
  const line = pathEntryLine(shellType);
  const cleaned = removePathEntryLines(content);
  if (shellType === 'fish') return `${cleaned}${cleaned ? '\n' : ''}${line}\n`;

  const lines = cleaned ? cleaned.split('\n') : [];
  let insertAt = 0;
  if (lines[0]?.startsWith('#!')) insertAt = 1;
  for (let i = insertAt; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (!text || text.startsWith('#')) continue;
    insertAt = i;
    break;
  }
  lines.splice(insertAt, 0, line);
  const withEarlyEntry = lines.join('\n').replace(/\s+$/, '');
  return `${withEarlyEntry}${withEarlyEntry ? '\n' : ''}${line}\n`;
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
  if (!alreadyPresent) fs.writeFileSync(rcFile, next);
  return { rcFile, shellType, alreadyPresent };
}

export function uninstallPathEntry() {
  const { path: rcFile } = detectShellRc();
  try {
    const content = fs.readFileSync(rcFile, 'utf8');
    const filtered = content
      .split('\n')
      .filter(line => !line.includes('.hcc-shims'))
      .join('\n');
    fs.writeFileSync(rcFile, filtered);
    return { rcFile };
  } catch {
    return { rcFile, error: 'could not modify shell rc' };
  }
}
