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

export function shellExports(values) {
  return Object.entries(values)
    .map(([key, value]) => `export ${key}=${shellQuoteArg(value)}`)
    .join('\n');
}

export function table(rows, columns) {
  if (!rows.length) return '(none)';
  const widths = columns.map((col) => Math.max(col.label.length, ...rows.map((row) => String(col.value(row) ?? '').length)));
  const header = columns.map((col, i) => col.label.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows.map((row) => columns.map((col, i) => String(col.value(row) ?? '').padEnd(widths[i])).join('  '));
  return [header, sep, ...body].join('\n');
}
