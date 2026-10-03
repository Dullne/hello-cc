// Shared form controls for Web-owned and independent native executors.
export function interactionPanelScript() {
  return String.raw`(() => {
    if (window.hccInteractions) return;
    const drafts = new Map();
    let focus = null;
    function remember(container) {
      container.querySelectorAll('[data-interaction-field]').forEach(control => {
        if (!control.dataset.interactionField) return;
        drafts.set(control.dataset.interactionField, { value: control.value, checked: control.checked });
        if (control === document.activeElement) focus = { key: control.dataset.interactionField, start: control.selectionStart, end: control.selectionEnd };
      });
      while (drafts.size > 256) drafts.delete(drafts.keys().next().value);
    }
    function restore(container) {
      const live = new Set();
      container.querySelectorAll('[data-interaction-field]').forEach(control => {
        live.add(control.dataset.interactionField);
        const saved = drafts.get(control.dataset.interactionField);
        if (saved) { control.value = saved.value; if (control.type === 'checkbox') control.checked = saved.checked; }
        if (focus && focus.key === control.dataset.interactionField) { control.focus?.({preventScroll:true}); if (typeof focus.start === 'number') control.setSelectionRange?.(focus.start, focus.end); }
      });
      for (const key of drafts.keys()) if (!live.has(key)) drafts.delete(key);
      if (focus && !live.has(focus.key)) focus = null;
    }
    function form(request, key, esc, text) {
      const field = suffix => ' data-interaction-field="' + esc(key + ':' + suffix) + '"';
      if (request.kind === 'userInput') return (request.params?.questions || []).map((q, i) => {
        const label = '<label>' + esc(q.header || '') + '<p>' + esc(q.question || '') + '</p>';
        const free = '<input data-answer="' + i + '" type="' + (q.isSecret ? 'password' : 'text') + '" maxlength="8192" autocomplete="off"' + field('answer:' + i) + '>';
        if (!q.options?.length) return label + free + '</label>';
        return label + '<select data-question="' + i + '"' + field('question:' + i) + '><option value="">' + esc(text('Choose an answer', '请选择答案')) + '</option>'
          + q.options.map((o, n) => '<option value="' + n + '">' + esc(o.label + (o.description ? ' — ' + o.description : '')) + '</option>').join('')
          + (q.isOther ? '<option value="other">' + esc(text('Other (enter below)', '其他（在下方输入）')) + '</option>' : '') + '</select>'
          + (q.isOther ? free : '') + '</label>';
      }).join('');
      if (request.kind !== 'permissions') return '';
      const p = request.params?.permissions || {}, fs = p.fileSystem || {};
      const choice = (name, index, label) => '<label><input type="checkbox" data-permission="' + name + '" data-index="' + index + '"' + field(name + ':' + index) + '> ' + esc(label) + '</label>';
      return '<p>' + esc(text('Select the requested permissions to grant. Unchecked permissions remain denied.', '勾选要授予的请求权限，未勾选的权限不授予。')) + '</p>'
        + (p.network?.enabled === true ? choice('network', 0, text('Network access', '网络访问')) : '')
        + ['read', 'write'].map(type => (fs[type] || []).map((path, i) => (fs.entries || []).some(entry => entry.access === type && entry.path?.type === 'path' && entry.path.path === path) ? '' : choice(type, i, text(type === 'read' ? 'Read: ' : 'Write: ', type === 'read' ? '读取：' : '写入：') + path)).join('')).join('')
        + (fs.entries || []).map((entry, i) => entry.access === 'deny' ? '<p>' + esc(text('Retained denial: ', '保留禁止规则：') + JSON.stringify(entry.path)) + '</p>'
          : choice('entries', i, (entry.access === 'write' ? text('Write: ', '写入：') : text('Read: ', '读取：')) + JSON.stringify(entry.path))).join('')
        + '<label>' + esc(text('Permission duration', '权限有效期')) + '<select data-scope' + field('scope') + '><option value="turn">' + esc(text('This turn', '仅本轮')) + '</option><option value="session">' + esc(text('This session', '本会话')) + '</option></select></label>';
    }
    function payload(request, container, decision) {
      if (decision !== 'accept') return { decision };
      if (request.kind === 'userInput') {
        const answers = Object.create(null);
        for (const [i, q] of (request.params?.questions || []).entries()) {
          const select = container.querySelector('[data-question="' + i + '"]');
          const value = select && select.value !== 'other' ? q.options?.[Number(select.value)]?.label : container.querySelector('[data-answer="' + i + '"]')?.value;
          if ((select && select.value === '') || !value?.trim()) throw new Error('Please answer every question / 请回答每个问题');
          answers[q.id] = { answers: [value] };
        }
        return { answers };
      }
      if (request.kind !== 'permissions') return { decision };
      const wanted = request.params.permissions, permissions = {}, fs = {};
      container.querySelectorAll('[data-permission]').forEach(control => {
        if (!control.checked) return;
        const field = control.dataset.permission;
        if (field === 'network') permissions.network = { enabled: true };
        else { fs[field] ||= []; fs[field].push(wanted.fileSystem[field][Number(control.dataset.index)]); }
      });
      if (Object.keys(fs).length) {
        const denies = (wanted.fileSystem.entries || []).filter(entry => entry.access === 'deny');
        if (denies.length) fs.entries = [...(fs.entries || []), ...denies];
        if (wanted.fileSystem.globScanMaxDepth != null) fs.globScanMaxDepth = wanted.fileSystem.globScanMaxDepth;
        permissions.fileSystem = fs;
      }
      return { decision, permissions, scope: container.querySelector('[data-scope]').value };
    }
    function forget(key) { for (const field of drafts.keys()) if (field.startsWith(key + ':')) drafts.delete(field); }
    window.hccInteractions = { form, payload, remember, restore, forget };
  })();`;
}
