import { UI_TRANSLATIONS } from './ui-i18n.mjs';

// Shared by the login page and the console so preferences take effect before paint.
export const uiPreferencesCss = `
  :root {
    color-scheme: dark;
    --bg: #101214;
    --panel: #181b1f;
    --panel-2: #20242a;
    --border: #303640;
    --text: #eef2f6;
    --muted: #a3adba;
    --accent: #40c4aa;
    --on-accent: #06211b;
    --warn: #f2bb4f;
    --danger: #ff6b6b;
    --ok: #75d17c;
    --input-bg: #0d0f12;
    --terminal-bg: #0b0d10;
    --card-bg: #111418;
    --hover-bg: #29323c;
    --primary-bg: #1b5f54;
    --primary-border: #2b9c86;
    --danger-bg: #5d252a;
    --danger-border: #aa444c;
    --selection-bg: #23465a;
    --overlay: rgba(0, 0, 0, .64);
    --control-height: 36px;
    --space: 12px;
    --small-font: 12px;
    --body-font: 14px;
    --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    --sans: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --bg: #eef2f6;
    --panel: #f8fafc;
    --panel-2: #e9eef4;
    --border: #cbd4df;
    --text: #17212b;
    --muted: #526273;
    --accent: #087b65;
    --on-accent: #ffffff;
    --warn: #986013;
    --danger: #b5303d;
    --ok: #23743b;
    --input-bg: #ffffff;
    --terminal-bg: #ffffff;
    --card-bg: #ffffff;
    --hover-bg: #e1e9f2;
    --primary-bg: #d1f2e8;
    --primary-border: #249079;
    --danger-bg: #ffe7e9;
    --danger-border: #cc6670;
    --selection-bg: #c8e8f8;
    --overlay: rgba(16, 24, 32, .42);
  }
  :root[data-density="compact"] {
    --control-height: 30px;
    --space: 8px;
    --small-font: 11px;
    --body-font: 13px;
  }
`;

export const TERMINAL_THEMES = Object.freeze({
  dark: Object.freeze({
    background: '#0b0d10', foreground: '#eef2f6', cursor: '#7dd3fc', cursorAccent: '#0b0d10',
    selectionBackground: '#23465a', selectionForeground: '#ffffff',
    black: '#1c2026', red: '#ff6b6b', green: '#75d17c', yellow: '#f2bb4f',
    blue: '#7baaff', magenta: '#c99bff', cyan: '#40c4cc', white: '#d6dde6',
    brightBlack: '#727f91', brightRed: '#ff9696', brightGreen: '#a1e8a7', brightYellow: '#ffe08a',
    brightBlue: '#aecaff', brightMagenta: '#dfbfff', brightCyan: '#82e4eb', brightWhite: '#ffffff',
  }),
  light: Object.freeze({
    background: '#ffffff', foreground: '#17212b', cursor: '#086b99', cursorAccent: '#ffffff',
    selectionBackground: '#c8e8f8', selectionForeground: '#17212b',
    black: '#17212b', red: '#b5303d', green: '#23743b', yellow: '#986013',
    blue: '#225dac', magenta: '#8144a8', cyan: '#087b83', white: '#69788a',
    brightBlack: '#526273', brightRed: '#ca3d49', brightGreen: '#2b8243', brightYellow: '#a57213',
    brightBlue: '#286ac2', brightMagenta: '#9451bc', brightCyan: '#09868d', brightWhite: '#8996a6',
  }),
});

function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function uiPreferencesScript() {
  return `(() => {
    const dictionaries = ${scriptJson(UI_TRANSLATIONS)};
    const fontSizes = [12, 13, 14, 15, 16, 18, 20];
    const keys = {
      language: 'hcc.lang', theme: 'hcc.theme', density: 'hcc.density',
      terminalTheme: 'hcc.terminalTheme', fontSize: 'hcc.fontSize'
    };
    const defaults = {
      language: 'system', theme: 'system', density: 'comfortable',
      terminalTheme: 'system', fontSize: 14
    };
    const choices = {
      language: ['system', 'en', 'zh'], theme: ['system', 'dark', 'light'],
      density: ['comfortable', 'compact'], terminalTheme: ['system', 'dark', 'light']
    };
    const ids = {
      language: 'langSelect', theme: 'themeSelect', density: 'densitySelect',
      terminalTheme: 'terminalThemeSelect', fontSize: 'fontSizeSelect'
    };
    const bound = new WeakSet();
    const memoryStorage = new Map();
    function safeGet(key) {
      if (memoryStorage.has(key)) return memoryStorage.get(key);
      try { return window.localStorage.getItem(key); } catch (_) { return null; }
    }
    function safeSet(key, value) {
      const text = String(value);
      memoryStorage.set(key, text);
      try { window.localStorage.setItem(key, text); return true; } catch (_) { return false; }
    }
    function valid(key, value) {
      if (key === 'fontSize') {
        const number = typeof value === 'number' ? value : Number(value);
        return fontSizes.includes(number) ? number : undefined;
      }
      return choices[key] && choices[key].includes(value) ? value : undefined;
    }
    let preferences = Object.freeze(Object.fromEntries(Object.keys(defaults).map((key) => {
      const value = valid(key, safeGet(keys[key]));
      return [key, value === undefined ? defaults[key] : value];
    })));
    let colorMedia = null;
    try {
      if (typeof window.matchMedia === 'function') colorMedia = window.matchMedia('(prefers-color-scheme: dark)');
    } catch (_) {}
    function language() {
      return preferences.language === 'system'
        ? ((navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en')
        : preferences.language;
    }
    function theme() {
      return preferences.theme === 'system' ? (colorMedia ? (colorMedia.matches ? 'dark' : 'light') : 'dark') : preferences.theme;
    }
    function tr(key, fallback = '') {
      return dictionaries[language()]?.[key] || dictionaries.en?.[key] || fallback || key;
    }
    function nodes(root, selector) {
      const result = Array.from(root.querySelectorAll(selector));
      if (root.matches && root.matches(selector)) result.unshift(root);
      return result;
    }
    function translate(root = document) {
      nodes(root, '[data-i18n]').forEach((element) => {
        element.textContent = tr(element.getAttribute('data-i18n'), element.textContent);
      });
      [
        ['data-i18n-placeholder', 'placeholder'], ['data-i18n-title', 'title'],
        ['data-i18n-aria', 'aria-label'], ['data-i18n-aria-label', 'aria-label']
      ].forEach(([source, target]) => {
        nodes(root, '[' + source + ']').forEach((element) => {
          element.setAttribute(target, tr(element.getAttribute(source), element.getAttribute(target) || ''));
        });
      });
    }
    function syncControls(root = document) {
      Object.entries(ids).forEach(([key, id]) => {
        nodes(root, '[id="' + id + '"]').forEach((element) => { element.value = String(preferences[key]); });
      });
    }
    function apply() {
      document.documentElement.lang = language() === 'zh' ? 'zh-CN' : 'en';
      document.documentElement.dataset.theme = theme();
      document.documentElement.dataset.density = preferences.density;
      syncControls();
      translate();
    }
    function notify(changed) {
      window.dispatchEvent(new CustomEvent('hcc:preferences', {
        detail: { preferences, language: language(), theme: theme(), changed }
      }));
    }
    function update(patch) {
      if (!patch || typeof patch !== 'object') return preferences;
      const next = { ...preferences };
      const changed = [];
      Object.keys(defaults).forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
        const value = valid(key, patch[key]);
        if (value === undefined || value === next[key]) return;
        next[key] = value;
        changed.push(key);
        safeSet(keys[key], value);
      });
      preferences = Object.freeze(next);
      apply();
      if (changed.length) notify(changed);
      return preferences;
    }
    function bindControls(root = document) {
      Object.entries(ids).forEach(([key, id]) => {
        nodes(root, '[id="' + id + '"]').forEach((element) => {
          if (bound.has(element)) return;
          bound.add(element);
          element.addEventListener('change', () => update({ [key]: element.value }));
        });
      });
      syncControls(root);
      translate(root);
    }
    window.hccUi = {
      get preferences() { return preferences; },
      get language() { return language(); },
      get theme() { return theme(); },
      safeGet, safeSet, tr, translate, update, bindControls
    };
    apply();
    const followSystemTheme = () => {
      if (preferences.theme !== 'system') return;
      apply();
      notify(['resolvedTheme']);
    };
    if (colorMedia?.addEventListener) colorMedia.addEventListener('change', followSystemTheme);
    else if (colorMedia?.addListener) colorMedia.addListener(followSystemTheme);
    window.addEventListener('languagechange', () => {
      if (preferences.language !== 'system') return;
      apply();
      notify(['resolvedLanguage']);
    });
  })();`;
}

export function preferenceControlsHtml({ terminal = false } = {}) {
  const common = `
    <label class="preference-field" for="langSelect">
      <span data-i18n="language">Language</span>
      <select id="langSelect">
        <option value="system" data-i18n="setting.system">Follow system</option>
        <option value="en">English</option>
        <option value="zh">中文</option>
      </select>
    </label>
    <label class="preference-field" for="themeSelect">
      <span data-i18n="theme">Appearance</span>
      <select id="themeSelect">
        <option value="system" data-i18n="setting.system">Follow system</option>
        <option value="dark" data-i18n="theme.dark">Dark</option>
        <option value="light" data-i18n="theme.light">Light</option>
      </select>
    </label>
    <label class="preference-field" for="densitySelect">
      <span data-i18n="density">Density</span>
      <select id="densitySelect">
        <option value="comfortable" data-i18n="density.comfortable">Comfortable</option>
        <option value="compact" data-i18n="density.compact">Compact</option>
      </select>
    </label>`;
  if (!terminal) return common;
  return common + `
    <label class="preference-field" for="terminalThemeSelect">
      <span data-i18n="terminalTheme">Terminal appearance</span>
      <select id="terminalThemeSelect">
        <option value="system" data-i18n="terminalTheme.follow">Follow appearance</option>
        <option value="dark" data-i18n="theme.dark">Dark</option>
        <option value="light" data-i18n="theme.light">Light</option>
      </select>
    </label>
    <label class="preference-field" for="fontSizeSelect">
      <span data-i18n="fontSize">Terminal font size</span>
      <select id="fontSizeSelect">
        ${[12, 13, 14, 15, 16, 18, 20].map((size) => `<option value="${size}">${size} px</option>`).join('\n        ')}
      </select>
    </label>`;
}
