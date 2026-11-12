import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { UI_TRANSLATIONS } from '../lib/web/ui-i18n.mjs';

const source = fs.readFileSync(new URL('../lib/web/browser/core.mjs', import.meta.url), 'utf8');
function shipped(name) {
  const start = source.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, 'Missing shipped browser function: ' + name);
  const end = source.indexOf('\n    }', start);
  return source.slice(start, end + 6);
}

test('Windows terminal controls require declared capability and connection ownership before sending bytes', () => {
  const sent = [];
  const session = { id: 'terminal-1', type: 'windows-terminal', status: 'running', terminal_capabilities: { input: false, resize: true, terminate: false } };
  const context = vm.createContext({ sessions: [session], active: session.id, ws: { readyState: 1, send: value => sent.push(JSON.parse(value)) },
    WebSocket: { OPEN: 1 }, sessionActionTokens: new Map([[session.id, 'action-token']]), canControl: () => true, controlEpoch: () => 7,
    lastControlNotice: 0, document: { getElementById: () => ({}) }, tr: key => key });
  vm.runInContext(shipped('terminalCapability') + '\n' + shipped('sendTerminalInput'), context);
  assert.equal(vm.runInContext("sendTerminalInput('literal input')", context), false);
  assert.deepEqual(sent, []);
  assert.equal(vm.runInContext("terminalCapability('terminate')", context), false);
  delete session.terminal_capabilities;
  assert.equal(vm.runInContext("terminalCapability('input')", context), false);
  session.terminal_capabilities = { input: true };
  vm.runInContext("sendTerminalInput('中文 input', 'receipt-1')", context);
  assert.deepEqual(sent, [{ type: 'input', data: '中文 input', action_token: 'action-token', epoch: 7, input_id: 'receipt-1' }]);
  session.type = 'tmux'; delete session.terminal_capabilities;
  assert.equal(vm.runInContext("terminalCapability('input')", context), true);
});

test('Windows terminal copy distinguishes persistent detach from explicit process termination in both languages', () => {
  for (const language of ['en', 'zh']) {
    assert.ok(UI_TRANSLATIONS[language]['terminal.terminate']);
    assert.ok(UI_TRANSLATIONS[language]['terminal.terminateHelp']);
    assert.ok(UI_TRANSLATIONS[language]['terminal.leaveHelp']);
    assert.doesNotMatch(UI_TRANSLATIONS[language]['terminal.leaveHelp'], /tmux/i);
  }
});
