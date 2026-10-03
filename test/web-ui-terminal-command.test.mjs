import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { webIndexHtml } from '../lib/web/ui-template.mjs';

test('terminal menu quotes peer and registration arguments as single shell words', () => {
  const html = webIndexHtml({ nonce: 'test-session-nonce' });
  const match = html.match(/function terminalShellQuote[\s\S]*?(?=function formatActionResult)/);
  assert.ok(match, 'terminal action functions appear in the generated page');
  const { terminalCommandForAction, terminalShellQuote } = vm.runInNewContext(
    `${match[0]}\n({ terminalCommandForAction, terminalShellQuote })`
  );

  const peerId = "peer with spaces'; printf HCC_EXTRA_MARKER";
  const info = { peerId, session: { kind: 'claude code', role: "dev's agent" } };
  const command = terminalCommandForAction('register', info);
  assert.equal(command,
    `hcc register --peer ${terminalShellQuote(peerId)} --kind ${terminalShellQuote('claude code')} --role ${terminalShellQuote("dev's agent")}`);

  const result = spawnSync('/bin/sh', ['-c',
    `set -- ${command.slice('hcc register '.length)}; printf '%s\\n' "$#" "$2" "$4" "$6"`
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `6\n${peerId}\nclaude code\ndev's agent\n`);
  assert.equal(terminalCommandForAction('status', info), `hcc status --peer ${terminalShellQuote(peerId)}`);
});
