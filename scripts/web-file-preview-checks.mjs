// Reusable browser checks for normal, test-owned project artifacts.
// Shares the acceptance runtime; never starts an Agent or calls a model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export const FILE_PREVIEW_CHECKS = Object.freeze([
  'standalone', 'html', 'markdown', 'text', 'image', 'pdf', 'formats',
  'bounded-text', 'mobile', 'late-file', 'close-pending', 'project-switch', 'readonly'
]);

const sha256 = content => createHash('sha256').update(content).digest('hex');
function pngFixture() {
  const crc = bytes => {
    let value = -1;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    return (value ^ -1) >>> 0;
  };
  const chunk = (name, data) => {
    const type = Buffer.from(name), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([length, type, data, checksum]);
  };
  const width = 640, height = 320, rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    let color = [244, 249, 247];
    if (x > 55 && x < 590 && (y === 272 || y === 273)) color = [182, 204, 196];
    for (let bar = 0; bar < 5; bar++) {
      if (x > 75 + 100 * bar && x < 138 + 100 * bar && y > 215 - bar * 29 && y < 272) color = [19 + bar * 7, 125 + bar * 10, 107 + bar * 6];
    }
    for (let channel = 0; channel < 3; channel++) rows[offset + channel] = color[channel];
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function pdfFixture() {
  const stream = 'BT /F1 25 Tf 54 738 Td (Project report) Tj 0 -45 Td /F1 13 Tf (File preview acceptance fixture) Tj 0 -30 Td (All five sample milestones are complete.) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream'
  ];
  let text = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(text)); text += (index + 1) + ' 0 obj\n' + body + '\nendobj\n';
  }
  const xref = Buffer.byteLength(text);
  text += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
    + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(text);
}

function fixtures(sandbox) {
  const first = path.join(sandbox, 'preview project with spaces'), second = path.join(sandbox, 'second preview project');
  const files = new Map([
    [path.join(first, 'README.md'), '# Project handoff\n\nA **reviewable result** from the workspace.\n\n- Inspect the report\n- Review the chart\n- Read the source\n\n```js\nconst status = "complete";\n```\n'],
    [path.join(first, 'src/main.mjs'), 'export const greeting = "Hello from the project";\nexport const example = "<sample>";\n'],
    [path.join(first, 'artifacts/report.html'), '<!doctype html><html><head><title>Milestone report</title><style>body{font:16px system-ui;margin:0;padding:40px;background:#f5faf7;color:#174837}h1{font-size:32px}section{padding:22px;background:white;border:1px solid #cce2d5;border-radius:12px;margin-top:28px}strong{font-size:40px;color:#12876b}</style></head><body><h1>Milestone report</h1><p>Generated locally</p><section><strong>5 / 5</strong><h2>Milestones completed</h2><p>Inspect this saved artifact without starting an Agent.</p></section></body></html>'],
    [path.join(first, 'artifacts/chart.png'), pngFixture()],
    [path.join(first, 'artifacts/report.pdf'), pdfFixture()],
    [path.join(first, 'artifacts/sample.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text x="20" y="20">Source only</text></svg>'],
    [path.join(first, 'artifacts/data.bin'), Buffer.from([0, 1, 2, 255, 0, 4])],
    [path.join(first, 'large.txt'), 'Large text fixture\n' + 'example line\n'.repeat(100000)],
    [path.join(first, 'dist/index.html'), '<h1>Build output is browsable</h1>'],
    [path.join(second, 'SECOND.md'), '# Second project\n\nThe selected project owns this preview.\n']
  ]);
  for (const [filename, content] of files) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); fs.writeFileSync(filename, content);
  }
  return { first, second, files };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 15000); })]);
  } finally { clearTimeout(timer); }
}

// Delay delivery of an actual response. File contents and server behavior are
// unchanged; the only controlled variable is when the browser receives it.
async function delayedPreview(page, project, filename, whileHeld) {
  const arrived = deferred(), release = deferred(), settled = deferred(), completed = deferred();
  let heldRequest, routeError;
  const matches = url => url.pathname === '/api/files/preview' && url.searchParams.get('path') === filename && url.searchParams.get('root') === project;
  const finished = request => { if (request === heldRequest) completed.resolve(); };
  const handler = async route => {
    heldRequest = route.request();
    try {
      const response = await route.fetch();
      assert.equal(response.status(), 200, 'The delayed preview must be a real successful file read');
      arrived.resolve(); await release.promise; await route.fulfill({ response });
    } catch (error) { routeError = error; arrived.reject(error); }
    finally { settled.resolve(); }
  };
  page.on('requestfinished', finished); page.on('requestfailed', finished);
  await page.route(matches, handler);
  try {
    await page.evaluate(filename => window.hccFiles.open(filename), filename);
    await bounded(arrived.promise, 'preview response fetched');
    await whileHeld(); release.resolve();
    await bounded(settled.promise, 'preview response released');
    await bounded(completed.promise, 'preview request settled in browser');
    if (routeError && heldRequest.failure()?.errorText !== 'net::ERR_ABORTED') throw routeError;
    // Wait for the browser's next rendered state, not an arbitrary sleep.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return heldRequest.failure() ? 'cancelled-on-project-change' : 'delivered';
  } finally {
    release.resolve(); await page.unroute(matches, handler);
    page.off('requestfinished', finished); page.off('requestfailed', finished);
  }
}

export async function runFilePreviewChecks({ browser, base, token, sandbox, registerPage, adapters, check, shot, watch, browserInstrumentation, evidence }) {
  const { first, second, files } = fixtures(sandbox);
  const hashes = () => Object.fromEntries([...files.keys()].map(filename => [path.relative(sandbox, filename), sha256(fs.readFileSync(filename))]));
  const before = hashes(), providers = [...adapters.keys()], sends = providers.map(provider => adapters.get(provider).sent || 0);
  const receipt = evidence.filePreview = {
    schemaVersion: 1, checks: [], viewports: [{ width: 1440, height: 1000 }, { width: 390, height: 844 }],
    modelCalls: false, fileHashes: before, fileRequests: [], writeRequests: [],
    pdfScope: 'Typed PDF Blob, iframe handoff and downloaded bytes; browser PDF viewer internals and OS rendering are not asserted'
  };
  const pass = (id, label) => { receipt.checks.push(id); check('file preview: ' + label); };
  const previousProject = await registerPage.evaluate(() => window.hccHandoff.projectRoot);
  for (const project of [first, second]) {
    await registerPage.locator('#openProjectDialog').click();
    await registerPage.locator('#projectPath').fill(project);
    await registerPage.locator('#addProjectBtn').click();
    await registerPage.waitForFunction(project => window.hccHandoff.projectRoot === project &&
      document.getElementById('projectDialog').hidden, project);
  }
  await registerPage.locator('#projectSelect').selectOption(previousProject);
  await registerPage.waitForFunction(project => window.hccHandoff.projectRoot === project &&
    window.hccHandoff.actionToken && /(已连接|Connected)$/.test(document.getElementById('handoffConnection').textContent), previousProject);
  const context = await browser.newContext({ viewport: receipt.viewports[0], acceptDownloads: true });
  await context.addInitScript(browserInstrumentation);
  // Observe the normal browser Blob handoff. Fetching a blob: URL is outside
  // the preview flow and intentionally unavailable under the page's CSP.
  await context.addInitScript(() => {
    const create = URL.createObjectURL;
    window.__hccPreviewBlobs = new Map();
    URL.createObjectURL = function (blob) {
      const url = create.call(this, blob);
      window.__hccPreviewBlobs.set(url, { type: blob.type, size: blob.size });
      return url;
    };
  });
  const page = await context.newPage(); watch(page);
  const open = async () => {
    await page.locator('#filesBtn').click(); await page.locator('#filesDialog').waitFor({ state: 'visible' });
    await page.locator('#filesEntries button').first().waitFor();
  };
  const select = async filename => {
    const buttons = page.locator('#filesEntries button[data-file-path]');
    const index = (await buttons.evaluateAll(elements => elements.map(element => element.dataset.filePath))).indexOf(filename);
    assert.ok(index >= 0, 'Missing project entry: ' + filename); await buttons.nth(index).click();
  };
  const show = async filename => {
    await page.evaluate(filename => window.hccFiles.open(filename), filename);
    await page.waitForFunction(filename => document.getElementById('filesMeta').textContent.startsWith(filename + ' ·'), filename);
  };
  const fits = async () => {
    const box = await page.locator('#filesPanel').boundingBox(), viewport = page.viewportSize();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, JSON.stringify(box));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  };
  try {
    await page.goto(base + '/?token=' + token);
    await page.waitForFunction(() => window.hccFiles && window.hccHandoff?.actionToken &&
      /(已连接|Connected)$/.test(document.getElementById('handoffConnection').textContent));
    await page.locator('#projectSelect').selectOption(first);
    await page.waitForFunction(project => window.hccHandoff?.projectRoot === project, first);
    assert.equal(await page.title(), 'hello-cc'); assert.equal(new URL(page.url()).origin, base);
    assert.ok((await page.locator('body').innerText()).includes('hello-cc'));
    assert.equal(await page.locator('vite-error-overlay,nextjs-portal,#webpack-dev-server-client-overlay').count(), 0);
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== base || !url.pathname.startsWith('/api/')) return;
      const item = { method: request.method(), path: url.pathname, project: url.searchParams.get('root') };
      if (url.pathname.startsWith('/api/files/')) receipt.fileRequests.push(item);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) receipt.writeRequests.push(item);
    });
    await open(); await fits();
    const names = await page.locator('#filesEntries button').evaluateAll(buttons => buttons.map(button => button.dataset.filePath));
    assert.ok(names.includes('README.md') && names.includes('dist'));
    assert.equal(await page.evaluate(() => window.hccHandoff.sessions.length), 0);
    pass('standalone', 'standalone project files open with no Agent session');

    await select('artifacts'); await page.locator('[data-file-path="artifacts/report.html"]').waitFor();
    await select('artifacts/report.html'); await page.frameLocator('#filesFrame').locator('h1').waitFor();
    assert.equal(await page.frameLocator('#filesFrame').locator('h1').innerText(), 'Milestone report');
    assert.equal(await page.locator('#filesFrame').getAttribute('sandbox'), '');
    await shot(page, 'desktop-file-preview-html');
    await page.locator('#filesSourceBtn').click();
    assert.ok((await page.locator('#filesPreview pre').innerText()).includes('<h1>Milestone report</h1>'));
    await page.locator('#filesSourceBtn').click(); await page.frameLocator('#filesFrame').locator('h1').waitFor();
    pass('html', 'directory navigation and static HTML source/rendered switch work');

    await page.locator('#filesUp').click(); await page.locator('[data-file-path="README.md"]').waitFor();
    await select('README.md'); await page.locator('#filesPreview h1').waitFor();
    assert.equal(await page.locator('#filesPreview h1').innerText(), 'Project handoff');
    assert.equal(await page.locator('#filesPreview li').count(), 3);
    assert.equal(await page.locator('#filesPreview pre code').innerText(), 'const status = "complete";');
    pass('markdown', 'Markdown headings, lists and code blocks render');
    await show('src/main.mjs');
    assert.ok((await page.locator('#filesPreview pre').innerText()).includes('<sample>'));
    assert.equal(await page.locator('#filesPreview sample').count(), 0);
    pass('text', 'source files display literal text');

    await show('artifacts/chart.png');
    await page.waitForFunction(() => document.querySelector('#filesPreview img')?.naturalWidth === 640);
    const size = await page.locator('#filesPreview img').evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight, renderedWidth: image.clientWidth, renderedHeight: image.clientHeight }));
    assert.equal(size.height, 320); assert.ok(Math.abs(size.renderedWidth / size.renderedHeight - 2) < 0.02);
    await shot(page, 'desktop-file-preview-image');
    pass('image', 'PNG dimensions and displayed aspect ratio match the fixture');

    await show('artifacts/report.pdf'); await page.locator('#filesDownload').waitFor({ state: 'visible' });
    const pdfUrl = await page.locator('#filesFrame').getAttribute('src'); assert.match(pdfUrl, /^blob:/);
    assert.equal(await page.locator('#filesDownload').getAttribute('href'), pdfUrl);
    const blob = await page.evaluate(url => window.__hccPreviewBlobs.get(url), pdfUrl);
    assert.equal(blob.type, 'application/pdf');
    const expectedPdfHash = sha256(files.get(path.join(first, 'artifacts/report.pdf')));
    assert.equal(blob.size, files.get(path.join(first, 'artifacts/report.pdf')).length);
    const downloading = page.waitForEvent('download'); await page.locator('#filesDownload').click(); const download = await downloading;
    assert.equal(download.suggestedFilename(), 'report.pdf');
    const stream = await download.createReadStream(), chunks = [];
    assert.ok(stream, 'Downloaded PDF must be readable'); for await (const chunk of stream) chunks.push(chunk);
    assert.equal(sha256(Buffer.concat(chunks)), expectedPdfHash);
    receipt.pdf = { mime: blob.type, bytes: blob.size, sha256: expectedPdfHash, filename: download.suggestedFilename() };
    await shot(page, 'desktop-file-preview-pdf-handoff');
    pass('pdf', 'typed PDF Blob and downloaded bytes match the saved file');

    await show('artifacts/sample.svg'); assert.ok((await page.locator('#filesPreview pre').innerText()).includes('<svg'));
    assert.equal(await page.locator('#filesPreview svg').count(), 0);
    await show('artifacts/data.bin'); assert.ok((await page.locator('#filesPreview').innerText()).trim().length > 0);
    assert.equal(await page.locator('#filesPreview iframe,#filesPreview img').count(), 0);
    pass('formats', 'SVG remains source text and unsupported binary has an explicit state');
    await show('large.txt'); assert.ok((await page.locator('#filesPreviewStatus').innerText()).trim().length > 0);
    const large = await page.locator('#filesPreview pre').innerText();
    assert.ok(Buffer.byteLength(large) <= 1024 * 1024 && large.length < String(files.get(path.join(first, 'large.txt'))).length);
    pass('bounded-text', 'large text remains bounded with a visible truncation notice');

    await page.locator('#filesClose').click(); await page.setViewportSize(receipt.viewports[1]);
    await open(); await fits(); await shot(page, 'mobile-file-preview-list');
    await select('README.md'); await page.locator('#filesPreview h1').waitFor(); await fits();
    await shot(page, 'mobile-file-preview-markdown');
    await page.locator('#filesBack').click(); assert.equal(await page.locator('#filesEntries').isVisible(), true);
    await page.locator('#filesClose').click(); assert.equal(await page.locator('#filesDialog').isVisible(), false);
    pass('mobile', '390px list, preview, back and close fit the viewport');

    await page.setViewportSize(receipt.viewports[0]);
    receipt.lateFile = await delayedPreview(page, first, 'src/main.mjs', () => show('README.md'));
    assert.equal(await page.locator('#filesName').innerText(), 'README.md');
    assert.equal(await page.locator('#filesPreview h1').innerText(), 'Project handoff');
    pass('late-file', 'late previous-file response cannot replace the latest preview');
    await delayedPreview(page, first, 'src/main.mjs', () => page.locator('#filesClose').click());
    assert.equal(await page.locator('#filesDialog').isVisible(), false);
    assert.equal(await page.locator('#filesPreview').innerText(), '');
    await open(); assert.equal(await page.locator('#filesName').innerText(), '');
    pass('close-pending', 'closing a pending preview leaves the next dialog clean');

    receipt.lateProject = await delayedPreview(page, first, 'src/main.mjs', async () => {
      // The project selector is outside the modal. Close through its visible
      // control before switching, as a user would.
      await page.locator('#filesClose').click();
      await page.locator('#projectSelect').selectOption(second);
      await page.waitForFunction(project => window.hccHandoff.projectRoot === project, second);
      await open();
      const entries = await page.locator('#filesEntries button').evaluateAll(buttons => buttons.map(button => button.dataset.filePath));
      assert.ok(entries.includes('SECOND.md') && !entries.includes('README.md'));
      await select('SECOND.md'); await page.locator('#filesPreview h1').waitFor();
    });
    assert.equal(await page.locator('#filesProject').innerText(), second);
    assert.equal(await page.locator('#filesPreview h1').innerText(), 'Second project');
    pass('project-switch', 'project switch scopes reads and fences the prior project response');
    await page.locator('#filesClose').click();
    assert.equal(await page.evaluate(() => window.hccHandoff.sessions.length), 0);
    assert.deepEqual([...adapters.keys()], providers); assert.deepEqual(providers.map(provider => adapters.get(provider).sent || 0), sends);
    assert.deepEqual(hashes(), before);
    assert.deepEqual(receipt.writeRequests, [{ method: 'POST', path: '/api/projects/select', project: second }],
      'Only the explicit project switch may write selection metadata; previews must not mutate files or workers');
    assert.ok(receipt.fileRequests.length > 0 && receipt.fileRequests.every(request => request.method === 'GET' && [first, second].includes(request.project)));
    pass('readonly', 'preview preserves fixture bytes and makes no file writes or Agent sends');
    assert.deepEqual(receipt.checks, FILE_PREVIEW_CHECKS); receipt.success = true;
  } finally { await context.close(); }
}
