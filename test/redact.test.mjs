import test from 'node:test';
import assert from 'node:assert/strict';
import { redactCliArgs, redactSecrets } from '../lib/shared/redact.mjs';
import { contentSecurityPolicy } from '../lib/web/http.mjs';
import { webIndexHtml, webLoginPage } from '../lib/web/ui-template.mjs';

const REDACTED = '[REDACTED]';

test('recursively clones arrays and objects while redacting secret-key values', () => {
  const secret = 'structured-secret-value';
  const input = {
    plain: 'visible',
    nested: {
      action_token: secret,
      Authorization: `Bearer ${secret}`,
      values: [{ apiKey: secret }, { password: secret }, { client_secret: secret }]
    }
  };

  const output = redactSecrets(input);

  assert.notEqual(output, input);
  assert.notEqual(output.nested, input.nested);
  assert.notEqual(output.nested.values, input.nested.values);
  assert.deepEqual(output, {
    plain: 'visible',
    nested: {
      action_token: REDACTED,
      Authorization: REDACTED,
      values: [{ apiKey: REDACTED }, { password: REDACTED }, { client_secret: REDACTED }]
    }
  });
  assert.equal(input.nested.action_token, secret);
});

test('redacts bearer, cookie, CLI token, and URL token fragments in strings', () => {
  const secret = 'fragment-secret-value';
  const inputs = [
    `Authorization: Bearer ${secret}`,
    `request failed with Bearer ${secret}`,
    `Cookie: hcc_sid=${secret}; theme=dark`,
    `Set-Cookie: hcc_sid=${secret}; HttpOnly`,
    `hcc web --token ${secret} --port 8787`,
    `hcc web --token=${secret}`,
    `http://host/?token=${secret}&root=/tmp/x`,
    `http://host/?root=/tmp/x&access_token=${secret}`
  ];

  for (const input of inputs) {
    const output = redactSecrets(input);
    assert.equal(output.includes(secret), false, output);
    assert.equal(output.includes(REDACTED), true, output);
  }
});

test('redacts an entire CLI token argument before argv boundaries are joined', () => {
  const secret = 'first-secret-part second-secret-part\nthird-secret-part';
  assert.deepEqual(
    redactCliArgs(['--port', '8787', '--token', secret, '--no-guidance']),
    ['--port', '8787', '--token', REDACTED, '--no-guidance']
  );
  assert.deepEqual(
    redactCliArgs([`--token=${secret}`, '--no-guidance']),
    [`--token=${REDACTED}`, '--no-guidance']
  );
});

test('replaces recursive references without mutating the source', () => {
  const input = { name: 'root', children: [] };
  input.self = input;
  input.children.push(input);

  const output = redactSecrets(input);

  assert.equal(output.name, 'root');
  assert.equal(output.self, '[Circular]');
  assert.equal(output.children[0], '[Circular]');
  assert.equal(input.self, input);
});

test('clones repeated non-recursive references without calling them circular', () => {
  const shared = { value: 'visible' };
  const output = redactSecrets({ first: shared, second: shared });

  assert.deepEqual(output, {
    first: { value: 'visible' },
    second: { value: 'visible' }
  });
  assert.notEqual(output.first, shared);
  assert.notEqual(output.second, shared);
});

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]));
}

test('index and login HTML nonce every inline script under the complete CSP', () => {
  const nonce = 'unit-test-nonce-0123456789';
  const policy = contentSecurityPolicy(nonce);
  const expected = "default-src 'self'; script-src 'self' 'nonce-unit-test-nonce-0123456789'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
  assert.equal(policy, expected);
  assert.doesNotMatch(policy.match(/script-src[^;]*/)?.[0] || '', /'unsafe-inline'/);

  for (const html of [webIndexHtml({ nonce }), webLoginPage({ nonce })]) {
    const scripts = inlineScripts(html);
    assert.ok(scripts.length > 0);
    for (const [, attributes] of scripts) {
      assert.match(attributes, new RegExp(`\\bnonce="${nonce}"`));
    }
    const injected = html.replace('</body>', '<script>globalThis.cspBypass = true;</script></body>');
    assert.equal(inlineScripts(injected).some(([, attributes]) => !/\bnonce=/.test(attributes)), true);
    assert.equal(policy.includes("'unsafe-inline'"), true);
    assert.equal((policy.match(/script-src[^;]*/)?.[0] || '').includes("'unsafe-inline'"), false);
  }
});

test('HTML renderers reject missing, weak, or attribute-breaking nonces', () => {
  for (const render of [webIndexHtml, webLoginPage]) {
    assert.throws(() => render(), /valid CSP nonce/);
    assert.throws(() => render({ nonce: 'short' }), /valid CSP nonce/);
    assert.throws(() => render({ nonce: '0123456789abcdef" onload="x' }), /valid CSP nonce/);
  }
  assert.throws(() => contentSecurityPolicy('short'), /valid CSP nonce/);
});
