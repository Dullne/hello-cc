import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { UI_TRANSLATIONS } from '../lib/web/ui-i18n.mjs';
import { uiPreferencesScript } from '../lib/web/ui-preferences.mjs';
import { webIndexHtml, webLoginPage } from '../lib/web/ui-template.mjs';
import { createHttpRoutes } from '../lib/web/http-routes.mjs';

class Element {
  constructor(attributes = {}, text = '') {
    this.attributes = { ...attributes };
    this.textContent = text;
    this.value = '';
    this.listeners = new Map();
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  matches(selector) {
    const match = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    return Boolean(match && Object.hasOwn(this.attributes, match[1]) &&
      (match[2] === undefined || this.attributes[match[1]] === match[2]));
  }
  querySelectorAll() { return []; }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  async emit(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) await listener(event);
  }
  focus() { this.focused = true; }
}

function browser({ stored = {}, blockedStorage = false, systemLanguage = 'en-US', dark = false, elements = [] } = {}) {
  const storage = new Map(Object.entries(stored));
  const listeners = new Map();
  const themeListeners = [];
  const events = [];
  const media = {
    matches: dark,
    addEventListener(name, listener) { if (name === 'change') themeListeners.push(listener); }
  };
  const document = {
    documentElement: { lang: '', dataset: {} },
    querySelectorAll(selector) { return elements.filter((element) => element.matches(selector)); },
    getElementById(id) { return elements.find((element) => element.getAttribute('id') === id) || null; }
  };
  const window = {
    localStorage: {
      getItem(key) { if (blockedStorage) throw new Error('Storage blocked'); return storage.get(key) ?? null; },
      setItem(key, value) { if (blockedStorage) throw new Error('Storage blocked'); storage.set(key, String(value)); }
    },
    matchMedia() { return media; },
    addEventListener(name, listener) {
      const handlers = listeners.get(name) || [];
      handlers.push(listener);
      listeners.set(name, handlers);
    },
    dispatchEvent(event) {
      events.push(event);
      for (const listener of listeners.get(event.type) || []) listener(event);
      return true;
    }
  };
  const navigator = { language: systemLanguage };
  const context = vm.createContext({
    window, document, navigator,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } }
  });
  new vm.Script(uiPreferencesScript(), { filename: 'ui-preferences.js' }).runInContext(context);
  return {
    context, ui: window.hccUi, window, document, navigator, storage, events,
    systemTheme(value) { media.matches = value; for (const listener of themeListeners) listener({ matches: value }); },
    systemLanguage(value) { navigator.language = value; window.dispatchEvent({ type: 'languagechange' }); }
  };
}

function inlineScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/.test(match[1]));
}

test('console and login ship valid scripts with CSP nonces and the shared settings bootstrap', () => {
  const nonce = 'ui-preferences-test-nonce';
  for (const render of [webIndexHtml, webLoginPage]) {
    const scripts = inlineScripts(render({ nonce }));
    assert.ok(scripts.length >= (render === webIndexHtml ? 1 : 2), 'Preferences run before page interaction code');
    if (render === webIndexHtml) assert.match(render({ nonce }), /type="module" src="\/assets\/web\/browser\/core\.mjs"/);
    for (const [, attributes, source] of scripts) {
      assert.match(attributes, new RegExp(`\\bnonce="${nonce}"`));
      assert.doesNotThrow(() => new vm.Script(source));
    }
    assert.match(scripts[0][2], /window\.hccUi/);
    assert.match(render({ nonce }), /id="langSelect"/);
    assert.match(render({ nonce }), /id="themeSelect"/);
  }
  assert.match(webIndexHtml({ nonce }), /<script src="\/assets\/addon-fit\.js"><\/script>/);
});

test('English and Chinese cover the same interface copy, including login and action feedback', () => {
  assert.deepEqual(Object.keys(UI_TRANSLATIONS.en).sort(), Object.keys(UI_TRANSLATIONS.zh).sort());
  for (const language of ['en', 'zh']) {
    for (const [key, value] of Object.entries(UI_TRANSLATIONS[language])) {
      assert.equal(typeof value, 'string', `${language}.${key}`);
      assert.ok(value.trim(), `${language}.${key} has usable copy`);
    }
  }
  assert.equal(UI_TRANSLATIONS.zh.language, '语言');
  assert.ok(UI_TRANSLATIONS.zh.loginTitle);
  assert.ok(UI_TRANSLATIONS.zh.networkError);
  assert.ok(UI_TRANSLATIONS.zh['action.task-next']);
});

test('existing language preference survives the upgrade and overrides browser language', () => {
  const b = browser({ stored: { 'hcc.lang': 'zh' }, systemLanguage: 'en-US' });
  assert.equal(b.ui.language, 'zh');
  assert.equal(b.document.documentElement.lang, 'zh-CN');
  assert.equal(b.ui.tr('language'), '语言');
  b.systemLanguage('de-DE');
  assert.equal(b.ui.language, 'zh');
  assert.equal(b.document.documentElement.lang, 'zh-CN');
});

test('invalid stored settings fall back safely and invalid updates preserve valid preferences', () => {
  const b = browser({ stored: {
    'hcc.lang': 'fr', 'hcc.theme': 'neon', 'hcc.density': 'tiny',
    'hcc.terminalTheme': 'transparent', 'hcc.fontSize': '17'
  } });
  assert.equal(b.ui.preferences.language, 'system');
  assert.equal(b.ui.preferences.theme, 'system');
  assert.equal(b.ui.preferences.density, 'comfortable');
  assert.equal(b.ui.preferences.terminalTheme, 'system');
  assert.equal(b.ui.preferences.fontSize, 14);
  b.ui.update({ fontSize: '20', theme: 'dark' });
  b.ui.update({ fontSize: 999, theme: '<script>', density: 'tiny', extra: 'ignored' });
  assert.equal(b.ui.preferences.fontSize, 20);
  assert.equal(b.ui.preferences.theme, 'dark');
  assert.equal(b.storage.get('hcc.fontSize'), '20');
  assert.equal(b.storage.get('hcc.theme'), 'dark');
  assert.equal(b.storage.has('extra'), false);
});

test('blocked browser storage does not stop bootstrap or live language and appearance changes', () => {
  const title = new Element({ 'data-i18n': 'projectState' });
  const b = browser({ blockedStorage: true, elements: [title] });
  assert.doesNotThrow(() => b.ui.update({ language: 'zh', theme: 'light', fontSize: 18 }));
  assert.equal(b.ui.language, 'zh');
  assert.equal(b.ui.theme, 'light');
  assert.equal(b.ui.preferences.fontSize, 18);
  assert.equal(title.textContent, '项目状态');
  assert.equal(b.ui.safeGet('hcc.lang'), 'zh');
  assert.equal(b.ui.safeGet('hcc.notWritten'), null);
  assert.equal(b.ui.safeSet('hcc.lang', 'en'), false);
  assert.equal(b.ui.safeGet('hcc.lang'), 'en');
});

test('system preferences track changes while explicit selections remain stable', () => {
  const b = browser({ systemLanguage: 'zh-TW', dark: false });
  assert.equal(b.ui.language, 'zh');
  assert.equal(b.ui.theme, 'light');
  b.systemTheme(true);
  assert.equal(b.document.documentElement.dataset.theme, 'dark');
  assert.equal(b.events.at(-1).type, 'hcc:preferences');
  b.systemLanguage('en-GB');
  assert.equal(b.document.documentElement.lang, 'en');
  b.ui.update({ theme: 'light', language: 'zh', density: 'compact' });
  b.systemTheme(true);
  b.systemLanguage('en-US');
  assert.equal(b.ui.theme, 'light');
  assert.equal(b.ui.language, 'zh');
  assert.equal(b.document.documentElement.dataset.density, 'compact');
  b.ui.update({ theme: 'system', language: 'system' });
  assert.equal(b.ui.theme, 'dark');
  assert.equal(b.ui.language, 'en');
});

test('settings controls persist choices and translate copy without modifying user input', async () => {
  const control = new Element({ id: 'langSelect' });
  const title = new Element({ 'data-i18n': 'projectState' });
  const message = new Element({ 'data-i18n-placeholder': 'messageBodyPlaceholder' });
  message.value = 'Keep this command: echo hello';
  const b = browser({ elements: [control, title, message] });
  b.ui.bindControls();
  b.ui.bindControls();
  assert.equal(control.listeners.get('change').length, 1);
  control.value = 'zh';
  await control.emit('change');
  assert.equal(b.ui.language, 'zh');
  assert.equal(b.storage.get('hcc.lang'), 'zh');
  assert.equal(title.textContent, '项目状态');
  assert.equal(message.value, 'Keep this command: echo hello');
  assert.equal(message.getAttribute('placeholder'), UI_TRANSLATIONS.zh.messageBodyPlaceholder);
});

test('login network failure permits retry and feedback follows the selected language', async () => {
  const form = new Element({ id: 'loginForm' });
  const input = new Element({ id: 'tok' });
  const button = new Element({ id: 'go', 'data-i18n': 'signIn' });
  const error = new Element({ id: 'err' });
  const b = browser({ elements: [form, input, button, error] });
  b.context.location = { href: '/login' };
  b.context.fetch = async () => { throw new Error('Offline'); };
  const scripts = inlineScripts(webLoginPage({ nonce: 'ui-login-test-nonce' }));
  new vm.Script(scripts.at(-1)[2]).runInContext(b.context);
  input.value = 'qa-access-token';
  await form.emit('submit', { preventDefault() {} });
  assert.equal(button.disabled, false);
  assert.equal(form.getAttribute('aria-busy'), 'false');
  assert.equal(error.textContent, UI_TRANSLATIONS.en.networkError);
  b.ui.update({ language: 'zh' });
  assert.equal(error.textContent, UI_TRANSLATIONS.zh.networkError);
  b.context.fetch = async (url, options) => {
    assert.equal(url, '/login');
    assert.equal(options.method, 'POST');
    assert.equal(JSON.parse(options.body).token, 'qa-access-token');
    return { ok: true };
  };
  await form.emit('submit', { preventDefault() {} });
  assert.equal(b.context.location.href, '/');
  assert.equal([...b.storage.values()].includes('qa-access-token'), false);
});

test('fit addon is served as JavaScript before authenticated runtime routes', async () => {
  const { handleWebRequest } = createHttpRoutes({});
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  await handleWebRequest({ method: 'GET', url: '/assets/addon-fit.js', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } }, response);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'application/javascript; charset=utf-8');
  assert.match(response.body.toString(), /FitAddon/);
  assert.match(response.body.toString(), /proposeDimensions/);
});

test('search addon is served locally as JavaScript before authenticated runtime routes', async () => {
  const { handleWebRequest } = createHttpRoutes({});
  const response = {
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
  await handleWebRequest({ method:'GET', url:'/assets/addon-search.js', headers:{host:'localhost'}, socket:{remoteAddress:'127.0.0.1'} }, response);
  assert.equal(response.status, 200);
  assert.equal(response.headers['Content-Type'], 'application/javascript; charset=utf-8');
  assert.match(response.body.toString(), /SearchAddon/);
  assert.match(response.body.toString(), /findPrevious/);
});
