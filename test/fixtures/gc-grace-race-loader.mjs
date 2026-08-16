const helperSource = `
import { DatabaseSync as __gcTestDatabaseSync } from 'node:sqlite';

function __gcTestExtendGrace() {
  const dbPath = process.env.HCC_TEST_GC_GRACE_DB;
  if (!dbPath) throw new Error('HCC_TEST_GC_GRACE_DB is required');
  const other = new __gcTestDatabaseSync(dbPath, { timeout: 5000 });
  try {
    other.prepare(\`
      INSERT INTO meta(key, value) VALUES ('clock_grace_until', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    \`).run(String(Math.floor(Date.now() / 1000) + 300));
  } finally {
    other.close();
  }
}
`;

function instrumentProtocol(source) {
  let result = helperSource + source;
  result = result.replace(
    '  for (let offset = 0; offset < plan.deleteEntries.length; offset += batchSize) {',
    `  if (process.env.HCC_TEST_GC_GRACE_PHASE === 'before-first-buffer-batch') __gcTestExtendGrace();\n\n` +
    '  for (let offset = 0; offset < plan.deleteEntries.length; offset += batchSize) {'
  );
  result = result.replace(
    '    if (afterBatch) afterBatch({ offset, size: entries.length, result: { ...result } });',
    `    if (afterBatch) afterBatch({ offset, size: entries.length, result: { ...result } });\n` +
    `    if (offset === 0 && process.env.HCC_TEST_GC_GRACE_PHASE === 'after-first-buffer-batch') {\n` +
    `      __gcTestExtendGrace();\n` +
    `    }`
  );
  return result;
}

function instrumentGcCommand(source) {
  let result = helperSource + source;
  result = result.replace(
    '  // A clock jump can make every lock look expired at once.',
    `  if (process.env.HCC_TEST_GC_GRACE_PHASE === 'before-locks') __gcTestExtendGrace();\n\n` +
    '  // A clock jump can make every lock look expired at once.'
  );
  result = result.replace(
    '    results.deferred_expired_locks += lockResult.deferred;',
    `    results.deferred_expired_locks += lockResult.deferred;\n` +
    `    if (process.env.HCC_TEST_GC_GRACE_PHASE === 'after-locks') __gcTestExtendGrace();`
  );
  return result;
}

function instrumentGcPlan(source) {
  let result = helperSource + source;
  result = result.replace(
    '  const processBatches = () => {',
    '  let __gcTestHistoryBatches = 0;\n  const processBatches = () => {'
  );
  result = result.replace(
    '      options.afterBatch?.({ plan, result, totals: { ...totals } });',
    `      options.afterBatch?.({ plan, result, totals: { ...totals } });\n` +
    `      __gcTestHistoryBatches += 1;\n` +
    `      if (__gcTestHistoryBatches === 1 && process.env.HCC_TEST_GC_GRACE_PHASE === 'after-first-history-batch') {\n` +
    `        __gcTestExtendGrace();\n` +
    `      }`
  );
  return result;
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context);
  const source = String(loaded.source);
  let instrumented = source;
  if (url.endsWith('/lib/runtime/buffer-gc-protocol.mjs')) instrumented = instrumentProtocol(source);
  else if (url.endsWith('/lib/core/coordination/gc-plan.mjs')) instrumented = instrumentGcPlan(source);
  else if (url.endsWith('/lib/cli/commands/gc.mjs')) instrumented = instrumentGcCommand(source);
  else return loaded;
  if (instrumented === source) throw new Error(`GC grace race loader did not instrument ${url}`);
  return { ...loaded, source: instrumented, shortCircuit: true };
}
