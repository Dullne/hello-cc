// Shared deliberately small Markdown renderer. HTML and links remain escaped text.
// The callback is supplied by each surface so escaping stays consistent.
export function createSafeMarkdown(escape) {
    function inline(value, allowBold = true) {
      const tick = String.fromCharCode(96), source = String(value), fragments = [];
      let index = 0, plain = '';
      const flush = () => { if (plain) fragments.push(escape(plain)); plain = ''; };
      const codeEnd = start => {
        const end = source.indexOf(tick, start + 1), newline = source.indexOf('\n', start + 1);
        return end > start + 1 && (newline === -1 || end < newline) ? end : -1;
      };
      while (index < source.length) {
        if (source[index] === tick && codeEnd(index) !== -1) {
          const end = codeEnd(index);
          flush(); fragments.push('<code>' + escape(source.slice(index + 1, end)) + '</code>'); index = end + 1;
          continue;
        }
        const marker = source.slice(index, index + 2);
        if (allowBold && (marker === '**' || marker === '__')) {
          let end = index + 2;
          while (end < source.length && source[end] !== '\n') {
            // Code spans are opaque: bold markers inside them are literal text.
            if (source[end] === tick && codeEnd(end) !== -1) { end = codeEnd(end) + 1; continue; }
            if (source.startsWith(marker, end)) break;
            end += 1;
          }
          if (end > index + 2 && source.startsWith(marker, end)) {
            flush(); fragments.push('<strong>' + inline(source.slice(index + 2, end), false) + '</strong>'); index = end + 2;
            continue;
          }
        }
        plain += source[index]; index += 1;
      }
      flush(); return fragments.join('');
    }
    function markdown(value) {
      const lines = String(value).split('\n'), parts = [];
      let paragraph = [], list = [], listType = '', listStart = '', quote = [];
      const flushParagraph = () => { if (paragraph.length) parts.push('<p class="codex-prose">' + inline(paragraph.join('\n')) + '</p>'); paragraph = []; };
      const flushList = () => {
        if (list.length) parts.push('<' + listType + (listType === 'ol' && listStart !== '1' ? ' start="' + listStart + '"' : '') + '>'
          + list.map(line => '<li>' + inline(line) + '</li>').join('') + '</' + listType + '>');
        list = []; listType = ''; listStart = '';
      };
      const flushQuote = () => { if (quote.length) parts.push('<blockquote>' + quote.map(line => inline(line)).join('<br>') + '</blockquote>'); quote = []; };
      for (const line of lines) {
        const heading = /^(#{1,6})\s+(.+)$/.exec(line);
        const unordered = /^\s{0,3}[-+*]\s+(.+)$/.exec(line);
        const ordered = /^\s{0,3}(\d{1,9})[.)]\s+(.+)$/.exec(line);
        const quoted = /^\s{0,3}>\s?(.*)$/.exec(line);
        if (heading) {
          flushParagraph(); flushList(); flushQuote();
          const tag = 'h' + heading[1].length;
          parts.push('<' + tag + '>' + inline(heading[2].replace(/\s+#+\s*$/, '')) + '</' + tag + '>');
        } else if (unordered || ordered) {
          flushParagraph(); flushQuote();
          const nextType = unordered ? 'ul' : 'ol';
          if (listType && listType !== nextType) flushList();
          if (!listType) { listType = nextType; listStart = ordered ? String(Number(ordered[1])) : ''; }
          list.push(unordered ? unordered[1] : ordered[2]);
        } else if (quoted) {
          flushParagraph(); flushList(); quote.push(quoted[1]);
        } else {
          flushList(); flushQuote();
          if (!line.trim()) flushParagraph();
          else paragraph.push(line);
        }
      }
      flushParagraph(); flushList(); flushQuote();
      return '<div class="codex-markdown">' + parts.join('') + '</div>';
    }
  return markdown;
}

export function safeMarkdownScript() {
  return 'window.hccSafeMarkdown ||= (' + createSafeMarkdown.toString() + ');';
}

export function installSafeMarkdown() { const window = globalThis.window; window.hccSafeMarkdown ||= createSafeMarkdown; }
