import { CliError } from './shared/errors.mjs';

export function compactText(value, limit = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}\u2026` : text;
}

export function formatJson(ok, dataOrError) {
  if (ok) return JSON.stringify({ ok: true, data: dataOrError }, null, 2);
  return JSON.stringify({ ok: false, error: dataOrError }, null, 2);
}

export function printResult(ctx, data, render) {
  if (ctx.json) {
    console.log(formatJson(true, data));
  } else {
    const output = render ? render(data) : String(data ?? '');
    if (output) console.log(output);
  }
}

export function shellQuoteArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function shellExports(values, shell = process.platform === 'win32' ? 'powershell' : 'posix') {
  if (!['powershell', 'cmd', 'posix'].includes(shell)) {
    throw new CliError('BAD_ARGS', '--shell must be powershell, cmd, or posix');
  }
  return Object.entries(values).map(([key, value]) => {
    const text = String(value);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || text.includes('\0')) {
      throw new CliError('BAD_ARGS', 'Shell environment output requires valid variable names and values without NUL characters');
    }
    if (shell === 'powershell') {
      // PowerShell treats all four curly single quotes (including low and
      // reversed forms) as delimiters. Double each literal quote faithfully.
      return `$env:${key} = '${text.replace(/['\u2018-\u201b]/g, quote => quote + quote)}'`;
    }
    if (shell === 'cmd') {
      // Quoted SET protects operators, but quotes, expansion and control
      // characters cannot be safely shared by interactive and batch callers.
      if (/[\x00-\x1f\x7f"%!]/.test(text)) {
        throw new CliError('BAD_ARGS', `Cannot safely represent ${key} in cmd; use --shell powershell or --json instead`);
      }
      return `set "${key}=${text}"`;
    }
    return `export ${key}=${shellQuoteArg(text)}`;
  }).join('\n');
}

export function table(rows, columns) {
  if (!rows.length) return '(none)';
  const widths = columns.map((col) => Math.max(col.label.length, ...rows.map((row) => String(col.value(row) ?? '').length)));
  const header = columns.map((col, i) => col.label.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows.map((row) => columns.map((col, i) => String(col.value(row) ?? '').padEnd(widths[i])).join('  '));
  return [header, sep, ...body].join('\n');
}
