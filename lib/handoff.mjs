import { runGit } from './runtime/project-context.mjs';

export function normalizeListText(value, fallback = []) {
  if (value === undefined || value === null || value === '') return JSON.stringify(fallback);
  const text = String(value);
  try {
    JSON.parse(text);
    return text;
  } catch {
    return JSON.stringify(text.split(',').map((item) => item.trim()).filter(Boolean));
  }
}

export function changedFiles(cwd) {
  const unstaged = runGit(['diff', '--name-only'], cwd);
  const staged = runGit(['diff', '--cached', '--name-only'], cwd);
  const files = new Set();
  for (const block of [unstaged, staged]) {
    if (!block) continue;
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  }
  return [...files].sort();
}
