import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserAssetPath, BROWSER_ASSET_PATHS } from '../lib/web/browser-assets.mjs';

test('browser module entry has a complete recursive graph of explicitly served local modules', () => {
  // Parse actual ESM imports/re-exports without evaluating browser code. VM
  // modules require this flag on Node 24; one child parses the complete graph.
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import vm from 'node:vm';
    const { browserAssetPath, BROWSER_ASSET_PATHS } = await import(process.argv[1]);
    const visited = new Set();
    function inspect(url) {
      if (visited.has(url.pathname)) return;
      const file = browserAssetPath(url.pathname);
      assert.ok(file, 'Unserved browser dependency: ' + url.pathname);
      visited.add(url.pathname);
      const module = new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier:url.href });
      for (const dependency of module.dependencySpecifiers) {
        assert.match(dependency, /^\\.{1,2}\\//, 'Browser dependency must be local, never a Node builtin/package: ' + dependency);
        const target = new URL(dependency, url);
        assert.equal(target.origin, url.origin);
        inspect(target);
      }
    }
    inspect(new URL('https://hcc.invalid/assets/web/browser/core.mjs'));
    // Parse every public module, including any leaf that is not currently
    // reachable from the entry. Its dependencies must also remain public.
    for (const pathname of BROWSER_ASSET_PATHS) inspect(new URL(pathname, 'https://hcc.invalid'));
    console.log(JSON.stringify([...visited]));
  `;
  const output = execFileSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', source,
    new URL('../lib/web/browser-assets.mjs', import.meta.url).href], { encoding:'utf8', stdio:['ignore','pipe','pipe'] });
  const paths = JSON.parse(output);
  for (const required of ['/assets/web/ui-agent-start.mjs', '/assets/integrations/mcp-elicitation.mjs', '/assets/integrations/mcp-url-elicitation.mjs']) {
    assert.ok(paths.includes(required), 'Graph must include ' + required);
  }
});

test('only the two shared MCP validators are public integration modules', () => {
  const paths = BROWSER_ASSET_PATHS.filter(path => path.startsWith('/assets/integrations/'));
  assert.deepEqual(paths, ['/assets/integrations/mcp-elicitation.mjs', '/assets/integrations/mcp-url-elicitation.mjs']);
  for (const name of ['mcp-elicitation.mjs', 'mcp-url-elicitation.mjs']) {
    assert.equal(browserAssetPath('/assets/integrations/' + name), fileURLToPath(new URL('../lib/integrations/' + name, import.meta.url)));
  }
  for (const path of ['/assets/web/http-routes.mjs', '/assets/integrations/native/jsonrpc.mjs',
    '/assets/integrations/codex-account.mjs', '/assets/web/../http-routes.mjs', '/assets/integrations/../runtime/state.mjs',
    '/assets/web/%2e%2e/http-routes.mjs', '/assets/web/browser/core.mjs/', '/assets/web/browser/core.mjs?source=1',
    '/assets/web/browser\\core.mjs', '/assets/web/browser/core.mjs\0', '/ASSETS/web/browser/core.mjs']) {
    assert.equal(browserAssetPath(path), null);
  }
});
