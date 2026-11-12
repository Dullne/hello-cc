import { createInProcessClaudeAdapter } from './claude.mjs';
import { helperJson, helperError, CLAUDE_HELPER_PROTOCOL, CLAUDE_HELPER_MAX_FRAME,
  CLAUDE_HELPER_MAX_PENDING, CLAUDE_HELPER_MAX_BUFFERED } from './claude-helper-protocol.mjs';

let adapter, buffer = '', active = 0, failed = false;
const methods = new Map([['claude/open', 'open'], ['claude/send', 'send'],
  ['claude/interrupt', 'interrupt'], ['claude/respond', 'respond'], ['claude/close', 'close']]);
function fatal() {
  if (failed) return;
  failed = true;
  process.exit(74); // The owning supervisor terminates and drains this Job.
}
function write(frame) {
  if (failed) return;
  try {
    const line = helperJson({ jsonrpc: '2.0', ...frame }) + '\n';
    if (process.stdout.writableLength + Buffer.byteLength(line) > CLAUDE_HELPER_MAX_BUFFERED) return fatal();
    process.stdout.write(line);
  } catch { fatal(); }
}
async function handle(frame) {
  if (!frame || frame.jsonrpc !== '2.0' || !Number.isSafeInteger(frame.id) || frame.id < 1 ||
      typeof frame.method !== 'string' || ++active > CLAUDE_HELPER_MAX_PENDING) return fatal();
  try {
    let value;
    if (frame.method === 'claude/init') {
      if (adapter || frame.params?.protocol !== CLAUDE_HELPER_PROTOCOL) throw new Error('Invalid Claude helper initialization');
      adapter = createInProcessClaudeAdapter({ ...frame.params.options,
        onEvent: event => write({ method: 'claude/event', params: { event, snapshot: adapter.snapshot() } }) });
      value = { protocol: CLAUDE_HELPER_PROTOCOL };
    } else {
      const operation = methods.get(frame.method);
      if (!adapter || !operation) throw new Error('Unsupported Claude helper operation');
      value = await adapter[operation](frame.params);
    }
    write({ id: frame.id, result: { value: value ?? null, snapshot: adapter.snapshot() } });
  } catch (error) {
    write({ id: frame.id, result: { error: helperError(error), snapshot: adapter?.snapshot() } });
  } finally { active--; }
}
process.stdout.on('error', fatal);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (Buffer.byteLength(line) > CLAUDE_HELPER_MAX_FRAME) return fatal();
    let frame;
    try { frame = JSON.parse(line); } catch { return fatal(); }
    void handle(frame);
  }
  if (Buffer.byteLength(buffer) > CLAUDE_HELPER_MAX_FRAME) fatal();
});
process.stdin.on('error', fatal);
process.stdin.on('end', () => {
  // Closing pipes alone cannot prove SDK teardown. Exit this helper and let
  // the supervisor's owned Job close confirm all SDK descendants are gone.
  process.exit(0);
});
