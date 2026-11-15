import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { spawnWindowsOwnedProcess } from '../../lib/platform/windows-process.mjs';

const args = process.argv.slice(2), patterns = [];
let logDirectory, timeoutMs = 180000, concurrency = 1;
while (args.length) {
  const argument = args.shift();
  if (argument === '--log-dir') logDirectory = args.shift();
  else if (argument === '--file-timeout-ms') timeoutMs = Number(args.shift());
  else if (argument === '--concurrency') concurrency = Number(args.shift());
  else if (argument.startsWith('--')) throw new Error(`Unknown option: ${argument}`);
  else patterns.push(argument);
}
if (!logDirectory || !patterns.length || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 2400000 ||
    !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  throw new Error('Usage: run-bounded-tests.mjs --log-dir DIR [--file-timeout-ms MS] [--concurrency N] FILE...');
}
const files = [...new Set(patterns.flatMap(pattern => {
  const matches = fs.existsSync(pattern) ? [path.resolve(pattern)] : fs.globSync(pattern).map(file => path.resolve(file));
  if (!matches.length) throw new Error(`No test files matched: ${pattern}`);
  return matches;
}))].sort();
if (!files.length) throw new Error('No test files matched');
fs.mkdirSync(logDirectory, { recursive: true });
const progress = new URL('./test-progress.mjs', import.meta.url).href;
const report = { node: process.version, platform: process.platform, startedAt: new Date().toISOString(), files: [] };
const save = () => fs.writeFileSync(path.join(logDirectory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
save();

let nextFile = 0, halted = false;
async function runFile(index) {
  const file = files[index];
  const entry = { file: path.relative(process.cwd(), file), log: `${String(index + 1).padStart(3, '0')}-${path.basename(file)}.log`,
    startedAt: new Date().toISOString(), timeoutMs, timedOut: false, exitCode: null };
  report.files.push(entry); save();
  const log = fs.openSync(path.join(logDirectory, entry.log), 'w');
  const write = text => { fs.writeSync(log, text); process.stdout.write(text); };
  write(`[${entry.startedAt}] FILE START ${entry.file}\n`);
  const started = performance.now();
  const env = { ...process.env };
  // A nested node:test invocation must get its own runner/reporters rather than
  // inheriting the outer runner's private IPC serialization mode.
  delete env.NODE_TEST_CONTEXT;
  const childArguments = ['--test', '--test-concurrency=1', `--test-timeout=${timeoutMs}`,
    '--test-reporter=spec', `--test-reporter=${progress}`,
    '--test-reporter-destination=stdout', '--test-reporter-destination=stdout', file];
  const child = process.platform === 'win32'
    ? spawnWindowsOwnedProcess(process.execPath, childArguments, { cwd: process.cwd(), env })
    : spawn(process.execPath, childArguments, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdin?.end();
  child.stdout.on('data', data => write(data));
  child.stderr.on('data', data => write(data));
  let finalDeadline;
  await new Promise(resolve => {
    let finished = false;
    const finish = (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline); clearTimeout(finalDeadline);
      entry.exitCode = code; entry.signal = signal;
      resolve();
    };
    child.once('error', error => { write(`RUNNER ERROR ${error.code || error.message}\n`); finish(1, null); });
    child.once('close', finish);
    const deadline = setTimeout(() => {
      entry.timedOut = true;
      write(`[${new Date().toISOString()}] FILE TIMEOUT ${entry.file} after ${timeoutMs}ms; terminating its test process tree\n`);
      save();
      if (process.platform === 'win32') child.kill();
      else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      // Even broken descendant pipe inheritance cannot hold the supervisor
      // forever. A timeout remains a failure, including if assertions passed.
      finalDeadline = setTimeout(() => {
        entry.cleanupUnconfirmed = true;
        if (process.platform === 'win32') child.kill(); else child.kill('SIGKILL');
        child.stdout.destroy(); child.stderr.destroy(); child.unref?.();
        finish(null, 'timeout');
      }, 7000);
    }, timeoutMs);
  });
  entry.durationMs = Math.round(performance.now() - started);
  entry.finishedAt = new Date().toISOString();
  write(`[${entry.finishedAt}] FILE END ${entry.file} exit=${entry.exitCode} timeout=${entry.timedOut} duration_ms=${entry.durationMs}\n`);
  fs.closeSync(log); save();
  if (entry.exitCode !== 0 || entry.timedOut) process.exitCode = 1;
  if (entry.timedOut) halted = true;
}
async function worker() {
  while (!halted && nextFile < files.length) await runFile(nextFile++);
}
await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
report.finishedAt = new Date().toISOString();
report.complete = report.files.length === files.length && report.files.every(file => file.exitCode === 0 && !file.timedOut);
save();
// If even Job termination cannot confirm closure, preserve the failed receipt
// and exit the owner so Windows closes every remaining owned Job handle.
if (report.files.some(file => file.cleanupUnconfirmed)) process.exit(1);
