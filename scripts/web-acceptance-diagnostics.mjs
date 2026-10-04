// Public CI annotations deliberately exclude receipt messages, URLs and paths.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const PHASES = new Set(['source-browser', 'installed-package', 'installed-browser']);
const OUTCOMES = new Set(['success', 'failure', 'skipped', 'cancelled']);
const SCRIPTS = new Set([
  'web-workbench-acceptance.mjs', 'web-workbench-installed-acceptance.mjs',
  'web-session-tools-checks.mjs', 'web-file-preview-checks.mjs'
]);

/** Retain one bounded local acceptance-script location, never the surrounding stack. */
export function acceptanceSourceLocation(stack) {
  if (typeof stack !== 'string' || stack.length > 65536) return 'unavailable';
  for (const line of stack.split('\n').slice(1, 33)) {
    const frame = line.trim();
    if (!frame.startsWith('at ')) continue;
    const location = frame.match(/\(([^()\r\n]+)\)$/)?.[1] || frame.slice(3).replace(/^async /, '');
    const match = location.match(/^(?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^?#\r\n]*[\\/]scripts[\\/]([^\\/:]+):([1-9]\d{0,5}):([1-9]\d{0,5})$/);
    if (match && SCRIPTS.has(match[1])) return `${match[1]}:${Number(match[2])}:${Number(match[3])}`;
  }
  return 'unavailable';
}

function readReceipt(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) return { status: 'invalid' };
    const bytes = Buffer.alloc(stat.size);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) return { status: 'invalid' };
    const value = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { status: 'invalid' };
    return { status: 'present', value };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'missing' : 'invalid' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function annotation(phase, receipt) {
  if (!PHASES.has(phase)) throw new TypeError('Invalid acceptance diagnostics phase');
  const value = receipt.value;
  const result = value?.success === true ? 'success' : value?.success === false ? 'failure' : 'unknown';
  const count = Array.isArray(value?.checks) && value.checks.length <= 10000 ? value.checks.length : 'unknown';
  const location = acceptanceSourceLocation(value?.failure?.stack);
  // Every interpolated string is fixed vocabulary, a bounded number or a
  // whitelisted basename. Receipt text cannot introduce workflow commands.
  return `::error title=Web acceptance diagnostic::phase=${phase} step=failure receipt=${receipt.status} result=${result} completed_checks=${count} source=${location}`;
}

export function webAcceptanceDiagnostics({ outputDir, sourceOutcome, installedOutcome }) {
  if (typeof outputDir !== 'string' || !outputDir || !OUTCOMES.has(sourceOutcome) || !OUTCOMES.has(installedOutcome)) {
    throw new TypeError('Invalid acceptance diagnostics options');
  }
  const lines = [];
  if (sourceOutcome === 'failure') lines.push(annotation('source-browser', readReceipt(path.join(outputDir, 'source', 'evidence.json'))));
  if (installedOutcome === 'failure') {
    lines.push(annotation('installed-package', readReceipt(path.join(outputDir, 'installed', 'evidence.json'))));
    // The wrapper captures child stderr in a log. Read the child's fixed
    // receipt independently, even when the parent receipt is unavailable.
    const browser = readReceipt(path.join(outputDir, 'installed', 'browser', 'evidence.json'));
    if (browser.status !== 'missing') lines.push(annotation('installed-browser', browser));
  }
  return lines;
}

function main(args) {
  try {
    const options = new Map();
    for (let index = 0; index < args.length; index += 2) {
      if (!['--output-dir', '--source-outcome', '--installed-outcome'].includes(args[index]) || !args[index + 1] || options.has(args[index])) {
        throw new TypeError('Invalid acceptance diagnostics arguments');
      }
      options.set(args[index], args[index + 1]);
    }
    const lines = webAcceptanceDiagnostics({ outputDir: options.get('--output-dir'), sourceOutcome: options.get('--source-outcome'), installedOutcome: options.get('--installed-outcome') });
    if (lines.length) process.stdout.write(lines.join('\n') + '\n');
  } catch {
    // A diagnostics failure must not expose a filesystem error or obscure the
    // acceptance step's existing failure with a second thrown exception.
    process.stdout.write('::error title=Web acceptance diagnostic::phase=diagnostics receipt=unavailable\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2));
