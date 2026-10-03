import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSessionSync } from '../lib/web/browser/session-sync.mjs';

// Execute the shipped ESM's lifecycle functions with controlled collaborators.
// The complete public module graph is parsed by web-browser-assets.test.mjs;
// browser acceptance exercises the complete bootstrap and real DOM separately.
const source = fs.readFileSync(new URL('../lib/web/browser/core.mjs', import.meta.url), 'utf8');
function shippedFunction(name) {
  const start = source.indexOf('    async function ' + name + '(');
  assert.ok(start >= 0);
  const end = source.indexOf('\n    }', start);
  assert.ok(end > start);
  return source.slice(start, end + 6);
}
function shippedListener(startMarker, endMarker) {
  const start = source.indexOf(startMarker), end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

test('project loading canonicalizes explicit roots before binding structured session state', async () => {
  for (const requested of ['/project/', '/alias/project', 'relative-project', '']) {
    const scopes = [], rendered = [], locations = [];
    const context = vm.createContext({ currentProject: requested, projects: [],
      api: async () => ({ projects: [{ root: '/project' }], current: { root: '/project' } }),
      projectRequests: { setRoot: value => scopes.push(value) },
      renderProjects: () => rendered.push(context.currentProject),
      updateLocationProject: () => locations.push(context.currentProject)
    });
    vm.runInContext(shippedFunction('loadProjects'), context);
    await vm.runInContext('loadProjects()', context);
    assert.equal(context.currentProject, '/project');
    assert.deepEqual(scopes, ['/project']);
    assert.deepEqual(rendered, ['/project']);
    assert.deepEqual(locations, ['/project']);
    let accepted = 0, recoveries = 0;
    const receiver = createSessionSync({ root: context.currentProject, sessionId: 'native-one', onState: () => accepted++, requestSnapshot: () => recoveries++ });
    receiver.receive({ type: 'state_sync', protocol: 1, root: '/project', sessionId: 'native-one', executorId: 'executor',
      generation: 'generation', revision: 0, channel: 'native', mode: 'snapshot', state: { executorId: 'executor' } });
    assert.equal(accepted, 1); assert.equal(recoveries, 0);
  }
});

test('adding a project selects the server-returned canonical root and never the typed alias', async () => {
  const elements = new Map(), selections = [], requests = [];
  const node = id => {
    if (!elements.has(id)) elements.set(id, { disabled: false, hidden: false, value: '', textContent: '',
      addEventListener(type, callback) { this[type] = callback; } });
    return elements.get(id);
  };
  node('projectPath').value = ' /project-alias/ ';
  const context = vm.createContext({ document: { getElementById: node }, currentProject: '/old-project', projectDialog: node('projectDialog'),
    api: async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { project: { root: '/canonical-project' } }; },
    loadProjects: async () => {}, switchProject: async root => selections.push(root),
    closeDialog: dialog => { dialog.hidden = true; }, tr: (_key, fallback) => fallback
  });
  vm.runInContext(shippedListener("    document.getElementById('projectForm').addEventListener", '\n    function clearSessionFilters'), context);
  await node('projectForm').submit({ preventDefault() {} });
  assert.deepEqual(requests, [{ url: '/api/projects', body: { root: '/project-alias/' } }]);
  assert.deepEqual(selections, ['/canonical-project']);
  assert.equal(node('projectDialog').hidden, true);
  assert.equal(node('projectDialogError').hidden, true);
  assert.equal(node('addProjectBtn').disabled, false);
});

test('bfcache restoration reloads disposed lifecycles once without replaying input or mutations', () => {
  const handlers = new Map(), calls = [];
  const context = vm.createContext({
    window: { addEventListener: (event, callback) => handlers.set(event, callback) },
    location: { reload: () => calls.push('reload') },
    stopDataPoll: () => calls.push('stop-data'), stopProjectPoll: () => calls.push('stop-projects'),
    projectRequests: { dispose: () => calls.push('dispose-requests') },
    fetch: () => { throw new Error('Restoration must not send a request or input'); }
  });
  vm.runInContext(shippedListener("    window.addEventListener('pagehide', () => { stopDataPoll();", '\n    stopCancelBtn.addEventListener'), context);
  handlers.get('pageshow')({ persisted: false });
  assert.deepEqual(calls, []);
  handlers.get('pagehide')({ persisted: true });
  assert.deepEqual(calls, ['stop-data', 'stop-projects', 'dispose-requests']);
  handlers.get('pageshow')({ persisted: true });
  assert.deepEqual(calls, ['stop-data', 'stop-projects', 'dispose-requests', 'reload']);
});
