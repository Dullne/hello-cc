import { createSafeMarkdown } from './ui-safe-markdown.mjs';

const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
export function renderFileMarkdown(content) {
  const markdown = createSafeMarkdown(escape), parts = [];
  let prose = [], code = null, fence = '';
  for (const line of String(content).split('\n')) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!code && marker) {
      if (prose.length) parts.push(markdown(prose.join('\n')));
      prose = []; code = []; fence = marker[1];
    } else if (code && marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      parts.push('<pre><code>' + escape(code.join('\n')) + '</code></pre>'); code = null;
    } else (code || prose).push(line);
  }
  if (code) parts.push('<pre><code>' + escape(code.join('\n')) + '</code></pre>');
  if (prose.length) parts.push(markdown(prose.join('\n')));
  return parts.join('');
}

export function staticPreviewCss(value) {
  const css = String(value).replace(/\/\*[\s\S]*?\*\//g, '');
  // Escape sequences and resource-bearing CSS are omitted rather than decoded
  // into a second URL language. The preview CSP independently blocks requests.
  const resourceSyntax = /\\|url\s*\(|@import|@font-face|image-set\s*\(|expression\s*\(|behavior\s*:|-moz-binding|https?:/i;
  return resourceSyntax.test(css) ? '' : css;
}

export function staticPreviewNode(node) {
  if (node.nodeType === 3) return escape(node.textContent || '');
  if (node.nodeType !== 1 || (node.namespaceURI && node.namespaceURI !== 'http://www.w3.org/1999/xhtml')) return '';
  const tag = String(node.localName).toLowerCase();
  if (['script','iframe','object','embed','link','meta','base','title','template','noscript','svg','math','form','input','select','textarea','button','audio','video','source'].includes(tag)) return '';
  if (tag === 'style') return '<style>' + staticPreviewCss(node.textContent).replace(/</g, '\\3c ') + '</style>';
  const body = [...(node.childNodes || [])].map(staticPreviewNode).join('');
  if (!['html','head','body','main','article','section','header','footer','nav','aside','div','span','p','h1','h2','h3','h4','h5','h6','ul','ol','li','dl','dt','dd','table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col','pre','code','blockquote','strong','em','b','i','u','s','small','sub','sup','br','hr','img','a','figure','figcaption','details','summary','time'].includes(tag)) return body;
  if (['html','head','body'].includes(tag)) return body;
  const attrs = [];
  for (const attr of [...(node.attributes || [])]) {
    const name = attr.name.toLowerCase();
    if (['id','class','title','alt','width','height','colspan','rowspan','scope','dir','lang'].includes(name)) attrs.push(name + '="' + escape(attr.value) + '"');
    else if (name === 'style') { const css = staticPreviewCss(attr.value); if (css) attrs.push('style="' + escape(css) + '"'); }
    else if (tag === 'img' && name === 'src' && /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(attr.value)) attrs.push('src="' + escape(attr.value) + '"');
  }
  return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + body + (['br','hr','img','col'].includes(tag) ? '' : '</' + tag + '>');
}

export function staticHtmlPreview(content, document) {
  // Template contents are inert: parsing cannot start a subresource fetch or
  // execute a script. Rebuild the output rather than trusting the original DOM.
  const template = document.createElement('template'); template.innerHTML = String(content);
  const body = [...template.content.childNodes].map(staticPreviewNode).join('');
  const csp = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + escape(csp)
    + '"><meta name="referrer" content="no-referrer"><style>body{margin:20px;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap}</style></head><body>' + body + '</body></html>';
}

export const filesCss = `
  .files-dialog { width:min(1180px,96vw); height:min(850px,92dvh); max-width:none; display:flex; flex-direction:column; gap:12px; overflow:hidden; }
  .files-project,.files-meta { color:var(--muted); font-size:var(--small-font); overflow-wrap:anywhere; margin:0; }
  .files-layout { flex:1; min-height:0; display:grid; grid-template-columns:minmax(220px,29%) minmax(0,1fr); gap:12px; }
  .files-browser,.files-view { min-width:0; min-height:0; display:flex; flex-direction:column; gap:8px; }
  .files-browser { border-right:1px solid var(--border); padding-right:12px; }
  .files-path-form,.files-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
  .files-path-form input { min-width:0; flex:1; }
  .files-entries { overflow:auto; flex:1; min-height:0; display:flex; flex-direction:column; gap:4px; }
  .files-entries button { height:auto; min-height:36px; width:100%; text-align:left; overflow-wrap:anywhere; flex:none; }
  .files-entries button[aria-current="true"] { background:var(--selection-bg); border-color:var(--accent); }
  .files-preview { flex:1; min-width:0; min-height:0; overflow:auto; border:1px solid var(--border); border-radius:8px; padding:12px; }
  .files-preview pre { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:var(--small-font)/1.6 var(--mono); }
  .files-preview img { display:block; max-width:100%; height:auto; margin:auto; }
  .files-preview iframe { border:0; width:100%; height:100%; min-height:350px; background:white; }
  .files-preview:has(iframe) { padding:0; }
  .files-preview .codex-markdown { max-width:850px; margin:auto; }
  #filesBack { display:none; }
  .files-dialog [hidden] { display:none!important; }
  .files-dialog[data-main-window-required="true"] .files-layout { grid-template-columns:1fr; }
  .files-dialog[data-main-window-required="true"] .files-browser,.files-dialog[data-main-window-required="true"] .files-toolbar { display:none; }
  @media(max-width:700px) {
    .files-dialog { width:96vw; height:94dvh; padding:12px; }
    .files-layout { display:flex; }
    .files-browser,.files-view { flex:1; }
    .files-browser { border:0; padding:0; }
    .files-dialog[data-mobile-view="tree"] .files-view { display:none; }
    .files-dialog[data-mobile-view="preview"] .files-browser { display:none; }
    #filesBack { display:inline-flex; }
    .files-toolbar button,.files-entries button { min-height:44px; }
  }
`;

export function filesHtml() {
  return `<div class="dialog-overlay" id="filesDialog" role="dialog" aria-modal="true" aria-labelledby="filesTitle" hidden><section class="dialog files-dialog" id="filesPanel" data-mobile-view="tree">
    <header class="dialog-heading"><h3 id="filesTitle" data-i18n="files.title">Project files</h3><button id="filesClose" type="button" data-i18n-aria="close" aria-label="Close">×</button></header>
    <p class="files-project" id="filesProject"></p><p class="dialog-help" data-i18n="files.readOnly">Read-only previews. Files are not changed or sent to an Agent.</p>
    <div class="files-layout"><section class="files-browser">
      <form class="files-path-form" id="filesPathForm"><input id="filesPath" type="text" autocomplete="off" data-i18n-aria="files.path" aria-label="Project relative directory"><button id="filesGo" type="submit" data-i18n="files.go">Go</button></form>
      <div class="files-toolbar"><button id="filesUp" type="button" data-i18n="files.up">Parent directory</button><button id="filesRefresh" type="button" data-i18n="refresh">Refresh</button></div>
      <p class="dialog-help" id="filesTreeStatus" role="status"></p><div class="files-entries" id="filesEntries" data-i18n-aria="files.title" aria-label="Project files"></div>
    </section><section class="files-view">
      <div class="files-toolbar"><button id="filesBack" type="button" data-i18n="files.back">Back to files</button><strong id="filesName"></strong><button id="filesSourceBtn" type="button" data-i18n="files.source" aria-pressed="false" hidden>Source</button><button id="filesReload" type="button" data-i18n="refresh" hidden>Refresh</button><a id="filesDownload" data-i18n="files.download" hidden>Download PDF</a></div>
      <p class="files-meta" id="filesMeta"></p><p class="dialog-help" id="filesPreviewStatus" role="status"></p><div class="files-preview" id="filesPreview" tabindex="0"></div>
    </section></div>
  </section></div>`;
}

export function installFiles(browser = globalThis) {
  const { window, document } = browser, bridge = window.hccHandoff, byId = id => document.getElementById(id);
  const dialog = byId('filesDialog'), panel = byId('filesPanel'), preview = byId('filesPreview');
  const tr = key => bridge.tr(key);
  let revision = 0, treeSequence = 0, fileSequence = 0, root = '', directory = '', selected = '', value = null, source = false;
  const urls = new Set();
  const current = visit => !dialog.hidden && visit === revision && root === bridge.projectRoot;
  function release() { for (const url of urls) browser.URL.revokeObjectURL(url); urls.clear(); }
  function clearPreview() {
    preview.replaceChildren(); release(); value = null;
    for (const id of ['filesName','filesMeta','filesPreviewStatus']) byId(id).textContent = '';
    for (const id of ['filesSourceBtn','filesReload','filesDownload']) byId(id).hidden = true;
    byId('filesDownload').removeAttribute('href');
  }
  function blobUrl(content, mime) {
    const bytes = browser.Uint8Array.from(browser.atob(content), character => character.charCodeAt(0));
    const url = browser.URL.createObjectURL(new browser.Blob([bytes], { type:mime })); urls.add(url); return url;
  }
  function render() {
    if (!value) return;
    preview.replaceChildren(); release();
    const download = byId('filesDownload'); download.hidden = true; download.removeAttribute('href');
    byId('filesName').textContent = value.name || value.path;
    byId('filesMeta').textContent = value.path + ' · ' + (Number.isFinite(value.size) ? value.size + ' bytes' : '');
    const textual = value.encoding === 'utf8' && ['text','markdown','html'].includes(value.kind);
    const sourceOnly = value.kind === 'html' && value.truncated;
    byId('filesSourceBtn').hidden = !textual || value.kind === 'text' || sourceOnly;
    byId('filesSourceBtn').setAttribute('aria-pressed',String(source));
    byId('filesSourceBtn').textContent = tr(source ? 'files.rendered' : 'files.source');
    byId('filesReload').hidden = false;
    byId('filesPreviewStatus').textContent = [value.truncated ? tr('files.truncated') : '',
      value.kind === 'html' ? tr('files.htmlLimit') : value.kind === 'pdf' ? tr('files.pdfHelp') : ''].filter(Boolean).join(' ');
    if (textual && (source || sourceOnly || value.kind === 'text')) {
      const pre = document.createElement('pre'); pre.textContent = value.content || ''; preview.appendChild(pre);
    } else if (value.kind === 'markdown' && textual) {
      preview.innerHTML = renderFileMarkdown(value.content || '');
    } else if (value.kind === 'html' && textual) {
      const frame = document.createElement('iframe'); frame.id = 'filesFrame'; frame.title = tr('files.staticHtml');
      frame.setAttribute('sandbox',''); frame.referrerPolicy = 'no-referrer'; frame.srcdoc = staticHtmlPreview(value.content || '',document); preview.appendChild(frame);
    } else if (value.kind === 'image' && value.encoding === 'base64' && /^image\/(png|jpeg|gif|webp)$/.test(value.mime)) {
      const img = document.createElement('img'); img.alt = value.name || value.path; img.src = blobUrl(value.content,value.mime); preview.appendChild(img);
    } else if (value.kind === 'pdf' && value.encoding === 'base64' && value.mime === 'application/pdf' && browser.atob(value.content.slice(0,8)).startsWith('%PDF-')) {
      const url = blobUrl(value.content,'application/pdf');
      const frame = document.createElement('iframe'); frame.id = 'filesFrame'; frame.title = value.name || 'PDF';
      frame.referrerPolicy = 'no-referrer'; frame.src = url; preview.appendChild(frame);
      download.href = url; download.download = value.name || 'document.pdf'; download.hidden = false;
    } else preview.textContent = tr('files.unsupported');
  }
  async function tree(path = '') {
    if (bridge.draftScope === 'auxiliary') return;
    const visit = revision, sequence = ++treeSequence;
    directory = path; byId('filesPath').value = path; byId('filesUp').disabled = !path;
    byId('filesTreeStatus').textContent = tr('files.loading'); byId('filesEntries').replaceChildren();
    try {
      const result = await bridge.api('/api/files/tree?path=' + encodeURIComponent(path));
      if (!current(visit) || sequence !== treeSequence) return;
      directory = result.path || ''; byId('filesPath').value = directory; byId('filesUp').disabled = !directory;
      const entries = Array.isArray(result.entries) ? result.entries : [];
      byId('filesTreeStatus').textContent = result.truncated ? tr('files.treeTruncated') : entries.length ? '' : tr('files.empty');
      for (const entry of entries) {
        if (!['file','directory'].includes(entry.type) || typeof entry.path !== 'string') continue;
        const button = document.createElement('button'); button.type = 'button'; button.dataset.filePath = entry.path; button.dataset.fileType = entry.type;
        button.textContent = (entry.type === 'directory' ? '▸ ' : '') + entry.name;
        button.setAttribute('aria-current',String(entry.path === selected));
        button.addEventListener('click', () => entry.type === 'directory' ? tree(entry.path) : openFile(entry.path));
        byId('filesEntries').appendChild(button);
      }
    } catch (error) { if (current(visit) && sequence === treeSequence) byId('filesTreeStatus').textContent = error.detail || error.message; }
  }
  async function openFile(path) {
    if (bridge.draftScope === 'auxiliary') return;
    const visit = revision, sequence = ++fileSequence;
    selected = path; source = false; clearPreview(); panel.dataset.mobileView = 'preview';
    for (const button of byId('filesEntries').children) button.setAttribute('aria-current',String(button.dataset.filePath === path));
    byId('filesName').textContent = path; byId('filesPreviewStatus').textContent = tr('files.loading');
    byId('filesReload').hidden = false;
    try {
      const result = await bridge.api('/api/files/preview?path=' + encodeURIComponent(path));
      if (!current(visit) || sequence !== fileSequence) return;
      value = result; render();
    } catch (error) { if (current(visit) && sequence === fileSequence) byId('filesPreviewStatus').textContent = error.detail || error.message; }
  }
  function closed() { revision++; treeSequence++; fileSequence++; clearPreview(); }
  function reset() { closed(); if (!dialog.hidden) bridge.closeDialog(dialog); }
  function open(path = '') {
    if (bridge.draftScope === 'auxiliary') {
      try {
        if (window.parent !== window && window.parent.hccHandoff?.projectRoot === bridge.projectRoot && window.parent.hccFiles) {
          window.parent.hccFiles.open(path); return;
        }
      } catch { /* A detached or cross-origin parent cannot accept this request. */ }
      closed(); root = bridge.projectRoot; panel.dataset.mobileView = 'preview';
      panel.dataset.mainWindowRequired = 'true';
      byId('filesProject').textContent = root; preview.textContent = tr('files.mainWindowRequired');
      bridge.openDialog(dialog,byId('filesClose')); return;
    }
    delete panel.dataset.mainWindowRequired;
    closed(); root = bridge.projectRoot; directory = ''; selected = ''; panel.dataset.mobileView = path ? 'preview' : 'tree';
    byId('filesProject').textContent = root; bridge.openDialog(dialog,byId('filesPath'));
    void tree(path ? path.split('/').slice(0,-1).join('/') : '');
    if (path) void openFile(path); else preview.textContent = tr('files.select');
  }
  byId('filesBtn').addEventListener('click',() => open());
  byId('filesClose').addEventListener('click',() => bridge.closeDialog(dialog));
  byId('filesPathForm').addEventListener('submit',event => { event.preventDefault(); void tree(byId('filesPath').value.trim().replace(/^\.\/?$/,'')); });
  byId('filesUp').addEventListener('click',() => tree(directory.split('/').slice(0,-1).join('/')));
  byId('filesRefresh').addEventListener('click',() => tree(directory));
  byId('filesReload').addEventListener('click',() => selected && openFile(selected));
  byId('filesBack').addEventListener('click',() => { panel.dataset.mobileView = 'tree'; byId('filesPath').focus(); });
  byId('filesSourceBtn').addEventListener('click',() => { source = !source; render(); });
  window.addEventListener('hcc:preferences',() => { if (!dialog.hidden) render(); });
  window.addEventListener('pagehide',closed);
  window.hccFiles = { open,closed,reset };
}
