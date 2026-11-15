import path from 'node:path';

// CI and the developer entry point deliberately exercise the same Windows
// contracts. The unported POSIX fixture collection remains a separate suite.
const groups = {
  core: {
    timeoutMs: 20 * 60_000, fileTimeoutMs: 180_000, concurrency: 1,
    files: ['test/windows-*.test.mjs', 'test/ci-bounded-tests.test.mjs', 'test/fixture-cleanup.test.mjs',
      'test/completion-poller.test.mjs', 'test/doctor-codex.test.mjs', 'test/test-platform.test.mjs']
  },
  ui: {
    timeoutMs: 20 * 60_000, fileTimeoutMs: 180_000, concurrency: 1,
    files: ['test/web-ui-agent-start.test.mjs', 'test/web-ui-session-display.test.mjs',
      'test/web-ui-handoff.test.mjs', 'test/web-ui-terminal-command.test.mjs']
  },
  shared: {
    timeoutMs: 40 * 60_000, fileTimeoutMs: 2_100_000, concurrency: 3,
    files: ['test/native-runtime.test.mjs', 'test/web-native-sessions.test.mjs', 'test/web-structured-routes.test.mjs',
      'test/scoped-mcp.test.mjs', 'test/native-fixture-root.test.mjs', 'test/codex-terminal-history-boundary.test.mjs',
      'test/web-browser-lifecycle.test.mjs', 'test/web-files-platform.test.mjs']
  }
};

export function windowsTestStages(group, logDirectory) {
  const selected = groups[group];
  if (!selected || !logDirectory) throw new Error('A Windows core, ui or shared group and log directory are required');
  const stages = [{ name: group, timeoutMs: selected.timeoutMs,
    args: ['./.github/scripts/run-bounded-tests.mjs', '--log-dir', path.resolve(logDirectory),
      '--concurrency', String(selected.concurrency), '--file-timeout-ms', String(selected.fileTimeoutMs), ...selected.files] }];
  if (group === 'ui') stages.push({ name: 'audit', args: ['./scripts/check-free-identifiers.mjs'], timeoutMs: 120_000 });
  return stages;
}
