const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SUPPORTED_LANGUAGES } = require('../src/languages');
const { after, before, test } = require('node:test');
const { DownloadManager, categoryFor, cleanFileName, uniqueName } = require('../src/download-manager');

let tempDirectory;
let server;
let serverUrl;

before(async () => {
  tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wasel-test-'));
  server = http.createServer((request, response) => {
    const errorStatus = Number(new URL(request.url, 'http://localhost').pathname.match(/^\/http-error\/(\d+)$/)?.[1]);
    if ([400, 401, 403, 429, 503].includes(errorStatus)) {
      response.writeHead(errorStatus);
      response.end();
      return;
    }
    const content = request.url === '/slow'
      ? Buffer.alloc(512 * 1024, 0x5a)
      : Buffer.from('wasel download test payload');
    const range = request.headers.range;
    if (range) {
      const start = Number(range.match(/bytes=(\d+)-/)?.[1]);
      if (start >= content.length) {
        response.writeHead(416, { 'Content-Range': `bytes */${content.length}` });
        response.end();
        return;
      }
      response.writeHead(206, {
        'Content-Length': content.length - start,
        'Content-Range': `bytes ${start}-${content.length - 1}/${content.length}`,
        'Accept-Ranges': 'bytes'
      });
      sendContent(response, content, start);
      return;
    }
    response.writeHead(200, { 'Content-Length': content.length, 'Accept-Ranges': 'bytes' });
    sendContent(response, content, 0);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${server.address().port}/payload.txt`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tempDirectory, { recursive: true, force: true });
});

test('sanitizes filenames and assigns file categories', () => {
  assert.equal(cleanFileName('../bad:name?.zip'), 'bad_name_.zip');
  assert.equal(cleanFileName('CON.txt'), 'download');
  assert.equal(categoryFor('movie.mp4'), 'media');
  assert.equal(categoryFor('report.pdf'), 'documents');
  assert.equal(uniqueName('file.zip', new Set(['file.zip'])), 'file (1).zip');
});

test('ships 17 valid locale resources with translated labels and direction metadata', async () => {
  assert.equal(SUPPORTED_LANGUAGES.length, 17);
  assert.equal(new Set(SUPPORTED_LANGUAGES).size, 17);
  const root = path.join(__dirname, '..');
  const english = JSON.parse(await fs.readFile(path.join(root, 'lang', 'eng.json'), 'utf8'));
  for (const code of SUPPORTED_LANGUAGES) {
    const locale = JSON.parse(await fs.readFile(path.join(root, 'lang', `${code}.json`), 'utf8'));
    assert.equal(typeof locale.name, 'string', `${code} has a display name`);
    assert.ok(['ltr', 'rtl'].includes(locale.direction), `${code} has a valid text direction`);
    assert.equal(typeof locale.translations, 'object', `${code} has a translation map`);
    if (code !== 'ara') {
      for (const key of ['كل التنزيلات', 'إضافة رابط', 'الحالة']) {
        assert.equal(typeof locale.translations[key], 'string', `${code} translates ${key}`);
      }
    }
  }

  const html = await fs.readFile(path.join(root, 'src', 'index.html'), 'utf8');
  const visibleText = html.replace(/<[^>]*>/g, '\n').split('\n').map((text) => text.trim())
    .filter((text) => /[\u0600-\u06ff]/.test(text));
  const translatableAttributes = [...html.matchAll(/(?:placeholder|title|aria-label)="([^"]*)"/g)]
    .map((match) => match[1]).filter((text) => /[\u0600-\u06ff]/.test(text));
  const untranslated = [...new Set([...visibleText, ...translatableAttributes])]
    .filter((text) => !english.translations[text]);
  assert.deepEqual(untranslated, [], 'English fallback covers all static Arabic UI text and labels');

  const renderer = await fs.readFile(path.join(root, 'src', 'renderer.js'), 'utf8');
  assert.match(renderer, /\.\.\.fallback\.translations, \.\.\.locale\.translations/);
});

test('every renderer DOM ID exists and uses a supported language setting', async () => {
  const html = await fs.readFile(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  const renderer = await fs.readFile(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referencedIds = new Set([...renderer.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]));
  const missingIds = [...referencedIds].filter((id) => !ids.has(id));
  assert.deepEqual(missingIds, []);
  assert.match(renderer, /function setState\(/);
  assert.match(html, /id="languageSelect"/);
});

test('validates browser handoff links and rejects unsafe protocols and embedded credentials', async () => {
  const linkProtocol = await import(pathToFileURL(path.join(__dirname, '..', 'extension', 'link-protocol.js')));
  const { createDownloadProtocolUrl, normalizeHttpUrl, parseDownloadProtocolUrl } = linkProtocol;
  const normalized = normalizeHttpUrl('https://example.com/a file.zip');
  assert.equal(normalized, 'https://example.com/a%20file.zip');
  const handoff = createDownloadProtocolUrl(normalized);
  assert.equal(parseDownloadProtocolUrl(handoff), normalized);
  assert.throws(() => normalizeHttpUrl('file:///C:/secret.txt'), /Only HTTP and HTTPS/);
  assert.throws(() => normalizeHttpUrl('https://user:password@example.com/file'), /embedded credentials/);
  assert.throws(() => parseDownloadProtocolUrl('wasel://other?url=https%3A%2F%2Fexample.com%2Ffile'), /invalid/);
  assert.throws(() => parseDownloadProtocolUrl('wasel://download?url=https%3A%2F%2Fa.test&url=https%3A%2F%2Fb.test'), /exactly one/);
});

test('redirects enabled browser downloads to Wasel and leaves disabled downloads untouched', async () => {
  const calls = [];
  let captureListener;
  let captureEnabled = true;
  let resolveCancelled;
  const cancelled = () => new Promise((resolve) => { resolveCancelled = resolve; });
  const previousBrowser = globalThis.browser;
  globalThis.browser = {
    storage: { local: { get: async () => ({ captureBrowserDownloads: captureEnabled }) } },
    downloads: {
      onCreated: { addListener: (listener) => { captureListener = listener; } },
      cancel: async (id) => {
        calls.push(['cancel', id]);
        resolveCancelled();
      }
    },
    tabs: {
      create: async (details) => { calls.push(['open', details]); }
    }
  };

  try {
    const moduleUrl = `${pathToFileURL(path.join(__dirname, '..', 'extension', 'background.js')).href}?test=${Date.now()}`;
    await import(moduleUrl);
    assert.equal(typeof captureListener, 'function');

    const cancelCompleted = cancelled();
    captureListener({ id: 17, url: 'https://example.com/file.zip', state: 'in_progress' });
    await cancelCompleted;
    assert.deepEqual(calls, [
      ['open', { url: 'wasel://download?url=https%3A%2F%2Fexample.com%2Ffile.zip', active: false }],
      ['cancel', 17]
    ]);

    captureEnabled = false;
    calls.length = 0;
    captureListener({ id: 18, url: 'https://example.com/another.zip', state: 'in_progress' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(calls, []);
  } finally {
    if (previousBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = previousBrowser;
  }
});

test('ships a minimal-permission cross-browser extension and dedicated icon styling', async () => {
  const root = path.join(__dirname, '..');
  const linkProtocol = await import(pathToFileURL(path.join(root, 'extension', 'link-protocol.js')));
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.json'), 'utf8'));
  const firefoxManifest = JSON.parse(await fs.readFile(path.join(root, 'extension', 'manifest.firefox.json'), 'utf8'));
  const popup = await fs.readFile(path.join(root, 'extension', 'popup.html'), 'utf8');
  const popupScript = await fs.readFile(path.join(root, 'extension', 'popup.js'), 'utf8');
  const background = await fs.readFile(path.join(root, 'extension', 'background.js'), 'utf8');
  const downloadCapture = await import(pathToFileURL(path.join(root, 'extension', 'download-capture.js')));
  const html = await fs.readFile(path.join(root, 'src', 'index.html'), 'utf8');
  const icons = await fs.readFile(path.join(root, 'src', 'icons.js'), 'utf8');
  const installGuide = await fs.readFile(path.join(root, 'extension', 'INSTALL.md'), 'utf8');
  const enhancementStyles = await fs.readFile(path.join(root, 'src', 'ui-enhancements.css'), 'utf8');
  const appMain = await fs.readFile(path.join(root, 'src', 'main.js'), 'utf8');
  const preload = await fs.readFile(path.join(root, 'src', 'preload.js'), 'utf8');
  const renderer = await fs.readFile(path.join(root, 'src', 'renderer.js'), 'utf8');
  const solutionNotes = await fs.readFile(path.join(root, 'SOLUTION_NOTES.md'), 'utf8');
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const releaseWorkflow = await fs.readFile(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(firefoxManifest.version, packageJson.version);
  assert.deepEqual(manifest.permissions, ['activeTab', 'downloads', 'storage']);
  assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '128.0');
  assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });
  assert.deepEqual(firefoxManifest.background, { scripts: ['background.js'], type: 'module' });
  assert.deepEqual(firefoxManifest.permissions, manifest.permissions);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  assert.match(popup, /type="module" src="popup\.js"/);
  assert.match(popup, /id="captureDownloads"/);
  assert.match(popupScript, /from '\.\/link-protocol\.js'/);
  assert.match(popupScript, /captureBrowserDownloads/);
  assert.match(background, /api\.downloads\.onCreated\.addListener/);
  assert.match(background, /api\.downloads\.cancel\(download\.id\)/);
  assert.equal(downloadCapture.shouldCaptureDownload({ url: 'https://example.com/file.zip', state: 'in_progress' }), true);
  assert.equal(downloadCapture.shouldCaptureDownload({ url: 'https://example.com/file.zip', state: 'in_progress' }, false), false);
  assert.equal(downloadCapture.shouldCaptureDownload({ url: 'file:///C:/file.zip', state: 'in_progress' }), false);
  assert.equal(downloadCapture.shouldCaptureDownload({ url: 'https://user:pass@example.com/file.zip', state: 'in_progress' }), false);
  assert.equal(downloadCapture.shouldCaptureDownload({ url: 'https://example.com/file.zip', state: 'complete' }), false);
  assert.equal(downloadCapture.shouldCaptureDownload({ url: 'https://example.com/file.zip', state: 'in_progress', incognito: true }), false);
  assert.equal(downloadCapture.shouldCaptureDownload({ url: 'https://example.com/file.zip', state: 'in_progress', byExtensionId: 'test-extension' }), false);
  assert.equal(typeof linkProtocol.createDownloadProtocolUrl, 'function');
  assert.match(html, /href="\.\/icons\.css"/);
  assert.match(html, /href="\.\/ui-enhancements\.css"/);
  assert.match(html, /data-command="extension-guide"/);
  assert.match(html, /class="window-titlebar"/);
  assert.match(html, /id="connectionsPerDownloadSelect"/);
  assert.match(html, /id="startWithWindows"/);
  assert.match(html, /role="progressbar"/);
  assert.match(html, /data-window-action="minimize"/);
  assert.match(html, /data-window-action="maximize"/);
  assert.match(html, /data-window-action="close"/);
  assert.match(renderer, /querySelectorAll\('\.menu-trigger\[data-menu\]'\)/);
  assert.match(renderer, /onWindowMaximized\(updateMaximizeControl\)/);
  assert.equal([...renderer.matchAll(/onUpdateStatus\(/g)].length, 1, 'Updater status listener is registered only once');
  assert.match(renderer, /connectionsPerDownload: Number/);
  assert.match(renderer, /startWithWindows: document\.getElementById\('startWithWindows'\)\.checked/);
  assert.match(renderer, /addUrls\(values\.join\('\\n'\), \{ startImmediately: true \}\)/);
  assert.match(renderer, /new Set\(\[/);
  assert.match(appMain, /frame: false/);
  assert.match(appMain, /app\.setLoginItemSettings\(/);
  assert.match(appMain, /args: \['--hidden'\]/);
  assert.match(appMain, /autoUpdater\.checkForUpdates\(\)/);
  assert.match(appMain, /autoUpdater\.on\('update-not-available'/);
  assert.match(appMain, /updateCheckPromise/);
  assert.match(appMain, /updates:get-status/);
  assert.match(appMain, /updates:install/);
  assert.match(appMain, /يلزم إعداد GH_TOKEN للوصول إلى مستودع GitHub الخاص/);
  assert.match(preload, /getUpdateStatus: \(\) => ipcRenderer\.invoke\('updates:get-status'\)/);
  assert.match(preload, /installUpdate: \(\) => ipcRenderer\.invoke\('updates:install'\)/);
  assert.match(renderer, /function renderUpdateStatus\(status\)/);
  assert.match(renderer, /window\.wasel\.onUpdateStatus\(renderUpdateStatus\)/);
  assert.match(html, /id="updateDialog"/);
  assert.match(html, /id="checkUpdates"/);
  assert.match(html, /id="installUpdate"/);
  assert.match(enhancementStyles, /\.update-dialog/);
  assert.match(appMain, /process\.env\.GH_TOKEN/);
  assert.match(appMain, /ipcMain\.handle\('app:get-version', \(\) => app\.getVersion\(\)\)/);
  assert.match(renderer, /window\.wasel\.getAppVersion\(\)/);
  assert.match(appMain, /new Tray\(/);
  assert.match(appMain, /mainWindow\.hide\(\)/);
  assert.match(appMain, /label: 'إنهاء واصل'/);
  assert.match(appMain, /icon: path\.join\(__dirname, '\.\.', 'assets', 'wasel\.ico'\)/);
  assert.match(icons, /settings: '<path d="M4 7h8m4 0h4/);
  assert.match(icons, /function hydrate\(/);
  assert.match(icons, /software: '<rect x="3" y="4" width="18" height="13"/);
  assert.match(enhancementStyles, /:root\s*\{\s*--chrome: #171d24/);
  assert.match(enhancementStyles, /body\[data-theme="light"\]/);
  assert.match(enhancementStyles, /@keyframes progress-sheen/);
  assert.match(enhancementStyles, /prefers-reduced-motion: reduce/);
  assert.match(installGuide, /chrome:\/\/extensions/);
  assert.match(installGuide, /edge:\/\/extensions/);
  assert.match(installGuide, /about:debugging/);
  assert.match(html, /data-extension-tab="chrome"/);
  assert.match(html, /data-extension-tab="edge"/);
  assert.match(html, /data-extension-tab="firefox"/);
  assert.match(html, /tutorial\/chromium-extensions\.svg/);
  assert.match(html, /tutorial\/edge-extensions\.svg/);
  assert.match(html, /tutorial\/firefox-debugging\.svg/);
  assert.match(html, /extension-capture-tip/);
  assert.match(html, /dialog-titlebar[\s\S]*?viewBox="0 0 16 16"/);
  assert.match(packageJson.build.publish[0].provider, /github/);
  assert.equal(packageJson.build.publish[0].private, true);
  assert.equal(packageJson.devDependencies['electron-builder'] !== undefined, true);
  assert.equal(packageJson.dependencies['electron-updater'] !== undefined, true);
  assert.match(releaseWorkflow, /tags:\s*\r?\n\s+- "v\*"/);
  assert.match(releaseWorkflow, /contents:\s*write/);
  assert.match(releaseWorkflow, /GH_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  assert.match(installGuide, /صلاحيات `activeTab` و`downloads` و`storage`/);
  assert.match(installGuide, /GH_TOKEN/);
  assert.match(solutionNotes, /أزرار إطار النافذة/);
  assert.match(solutionNotes, /التحديثات والبناء/);
  assert.match(solutionNotes, /التقاط تنزيلات المتصفح/);
});

test('downloads an HTTP file, records it, and persists its completed state', async () => {
  const manager = new DownloadManager({
    dataFile: path.join(tempDirectory, 'library.json'),
    defaultFolder: path.join(tempDirectory, 'files')
  });
  await manager.initialize();
  const item = await manager.add({ url: serverUrl, fileName: 'sample.txt' });

  await waitFor(() => ['completed', 'error'].includes(manager.getDownload(item.id)?.status));
  assert.equal(manager.getDownload(item.id).status, 'completed', manager.getDownload(item.id).error);
  assert.equal(await fs.readFile(item.savePath, 'utf8'), 'wasel download test payload');
  const saved = JSON.parse(await fs.readFile(path.join(tempDirectory, 'library.json'), 'utf8'));
  assert.equal(saved.items[0].status, 'completed');
  await manager.shutdown();
});

test('explains HTTP 400, 401, 403, 429, and server-error responses', async () => {
  const manager = new DownloadManager({
    dataFile: path.join(tempDirectory, 'http-errors-library.json'),
    defaultFolder: path.join(tempDirectory, 'http-errors-files')
  });
  await manager.initialize();
  const expectedGuidance = new Map([
    [400, 'تحقق من الرابط'],
    [401, 'لا يستطيع واصل تجاوز المصادقة'],
    [403, 'رفض الخادم الوصول'],
    [429, 'قيّد الخادم الطلبات مؤقتًا'],
    [503, 'خطأ مؤقت في الخادم']
  ]);

  for (const [status, guidance] of expectedGuidance) {
    const url = `${serverUrl.slice(0, serverUrl.lastIndexOf('/'))}/http-error/${status}`;
    const item = await manager.add({ url, fileName: `http-${status}.bin` });
    await waitFor(() => ['completed', 'error'].includes(manager.getDownload(item.id)?.status));
    assert.equal(manager.getDownload(item.id).status, 'error');
    assert.match(manager.getDownload(item.id).error, new RegExp(`HTTP ${status}`));
    assert.match(manager.getDownload(item.id).error, new RegExp(guidance));
  }
  await manager.shutdown();
});

test('downloads byte ranges in parallel and assembles the original file without corruption', async () => {
  const content = Buffer.alloc(5 * 1024 * 1024 + 137);
  for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
  const receivedRanges = [];
  let activeRequests = 0;
  let maximumConcurrentRequests = 0;
  const rangeServer = http.createServer((request, response) => {
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (!range) {
      response.writeHead(200, { 'Content-Length': content.length });
      response.end(content);
      return;
    }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), content.length - 1);
    receivedRanges.push([start, end]);
    activeRequests += 1;
    maximumConcurrentRequests = Math.max(maximumConcurrentRequests, activeRequests);
    let cursor = start;
    let writeTimer;
    response.once('close', () => {
      clearTimeout(writeTimer);
      activeRequests -= 1;
    });
    setTimeout(() => {
      if (response.destroyed) return;
      response.writeHead(206, {
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${start}-${end}/${content.length}`,
        ETag: '"wasel-range-test"'
      });
      const writeNext = () => {
        if (response.destroyed) return;
        const next = Math.min(cursor + 64 * 1024, end + 1);
        response.write(content.subarray(cursor, next));
        cursor = next;
        if (cursor > end) response.end();
        else writeTimer = setTimeout(writeNext, 4);
      };
      writeNext();
    }, 30);
  });
  await new Promise((resolve) => rangeServer.listen(0, '127.0.0.1', resolve));
  const manager = new DownloadManager({
    dataFile: path.join(tempDirectory, 'parallel-library.json'),
    defaultFolder: path.join(tempDirectory, 'parallel-files')
  });

  try {
    await manager.initialize();
    await manager.updateSettings({ connectionsPerDownload: 4 });
    const url = `http://127.0.0.1:${rangeServer.address().port}/large.bin`;
    const item = await manager.add({ url, fileName: 'parallel.bin' });
    await waitFor(() => manager.getDownload(item.id)?.receivedBytes > 0);
    await manager.pause(item.id);
    assert.equal(manager.getDownload(item.id).status, 'paused');
    assert.ok(manager.getDownload(item.id).receivedBytes > 0, 'Completed range segments remain resumable after pausing');
    await manager.resume(item.id);
    await waitFor(() => ['completed', 'error'].includes(manager.getDownload(item.id)?.status));

    assert.equal(manager.getDownload(item.id).status, 'completed', manager.getDownload(item.id).error);
    assert.ok(maximumConcurrentRequests >= 2, `Expected parallel range requests; max=${maximumConcurrentRequests}`);
    assert.ok(receivedRanges.some(([start, end]) => start === 0 && end === 0), 'Range support is probed before parallel download');
    assert.ok(receivedRanges.some(([start]) => start > 0), 'The file is split into non-overlapping byte ranges');
    const downloaded = await fs.readFile(item.savePath);
    assert.deepEqual(downloaded, content);
  } finally {
    await manager.shutdown();
    await new Promise((resolve) => rangeServer.close(resolve));
  }
});

test('reports a blocked save path on the download row without losing the original path error', async () => {
  const manager = new DownloadManager({
    dataFile: path.join(tempDirectory, 'blocked-path-library.json'),
    defaultFolder: path.join(tempDirectory, 'blocked-path-downloads')
  });
  await manager.initialize();
  const blocker = path.join(tempDirectory, 'not-a-directory');
  await fs.writeFile(blocker, 'not a directory');
  const created = await manager.add({ url: `${serverUrl}/file.zip`, startImmediately: false });
  const item = manager.getDownload(created.id);
  item.savePath = path.join(blocker, 'file.zip');
  item.status = 'queued';
  manager.schedule();
  await manager.active.get(item.id).done;

  assert.equal(item.status, 'error');
  assert.match(item.error, /مسار التنزيل ليس مجلدًا/);
  assert.match(item.error, /not-a-directory/);
  await manager.shutdown();
});

test('pauses and resumes a partial download without losing or duplicating bytes', async () => {
  const manager = new DownloadManager({
    dataFile: path.join(tempDirectory, 'resume-library.json'),
    defaultFolder: path.join(tempDirectory, 'resume-files')
  });
  await manager.initialize();
  const item = await manager.add({ url: `${serverUrl.slice(0, serverUrl.lastIndexOf('/'))}/slow`, fileName: 'large.bin' });

  await waitFor(() => manager.getDownload(item.id)?.receivedBytes > 0);
  await manager.pause(item.id);
  await manager.resume(item.id);
  await waitFor(() => ['completed', 'error'].includes(manager.getDownload(item.id)?.status));
  assert.equal(manager.getDownload(item.id).status, 'completed', manager.getDownload(item.id).error);
  const downloaded = await fs.readFile(item.savePath);
  assert.equal(downloaded.length, 512 * 1024);
  assert.ok(downloaded.every((byte) => byte === 0x5a));
  await manager.shutdown();
});

test('persists theme and concurrency settings and pauses all active downloads safely', async () => {
  const dataFile = path.join(tempDirectory, 'settings-library.json');
  const manager = new DownloadManager({
    dataFile,
    defaultFolder: path.join(tempDirectory, 'settings-files')
  });
  await manager.initialize();
  assert.equal(manager.getState().settings.theme, 'dark');
  const fallbackFolder = manager.getState().settings.outputFolder;
  const rootFolder = path.parse(tempDirectory).root;
  const rootSettings = await manager.setOutputFolder(rootFolder);
  assert.equal(rootSettings.outputFolder, rootFolder);
  await manager.setOutputFolder(fallbackFolder);
  await manager.updateSettings({
    theme: 'dark',
    maxActiveDownloads: 5,
    connectionsPerDownload: 8,
    startWithWindows: true
  });
  assert.equal(manager.getState().settings.theme, 'dark');
  assert.equal(manager.getState().maxActiveDownloads, 5);
  assert.equal(manager.getState().settings.connectionsPerDownload, 8);
  assert.equal(manager.getState().settings.startWithWindows, true);
  await manager.updateSettings({ language: 'fra' });
  assert.equal(manager.getState().settings.language, 'fra');
  await assert.rejects(manager.updateSettings({ language: 'not-a-language' }), /لغة الواجهة المحددة غير مدعومة/);
  await assert.rejects(
    manager.updateSettings({ theme: 'light', language: 'not-a-language' }),
    /لغة الواجهة المحددة غير مدعومة/
  );
  assert.equal(manager.getState().settings.theme, 'dark', 'invalid settings do not partially update saved preferences');

  const item = await manager.add({
    url: `${serverUrl.slice(0, serverUrl.lastIndexOf('/'))}/slow`,
    fileName: 'pause-all.bin'
  });
  await waitFor(() => manager.getDownload(item.id)?.receivedBytes > 0);
  await manager.pauseAll();
  assert.equal(manager.getDownload(item.id).status, 'paused');
  assert.ok((await fs.stat(`${item.savePath}.part`)).size > 0);
  await manager.shutdown();

  const restored = new DownloadManager({
    dataFile,
    defaultFolder: path.join(tempDirectory, 'fallback')
  });
  await restored.initialize();
  assert.equal(restored.getState().settings.theme, 'dark');
  assert.equal(restored.getState().settings.language, 'fra');
  assert.equal(restored.getState().settings.maxActiveDownloads, 5);
  assert.equal(restored.getState().settings.connectionsPerDownload, 8);
  assert.equal(restored.getState().settings.startWithWindows, true);
  assert.equal(restored.getDownload(item.id).status, 'paused');
  await restored.shutdown();
});

test('recovers safely when an older configuration points at a drive root', async () => {
  const dataFile = path.join(tempDirectory, 'root-folder-library.json');
  const fallbackFolder = path.join(tempDirectory, 'safe-download-folder');
  await fs.writeFile(dataFile, JSON.stringify({
    downloads: [],
    settings: { outputFolder: path.parse(tempDirectory).root, theme: 'light' }
  }));

  const manager = new DownloadManager({ dataFile, defaultFolder: fallbackFolder });
  await manager.initialize();
  assert.equal(manager.getState().settings.outputFolder, path.parse(tempDirectory).root);
  assert.equal(manager.getState().settings.theme, 'light');
  await manager.shutdown();
});

function sendContent(response, content, start) {
  if (content.length < 1000) {
    response.end(content.subarray(start));
    return;
  }
  let offset = start;
  const writeNext = () => {
    if (response.destroyed || offset >= content.length) {
      if (!response.destroyed) response.end();
      return;
    }
    const end = Math.min(offset + 4096, content.length);
    response.write(content.subarray(offset, end));
    offset = end;
    setTimeout(writeNext, 5);
  };
  writeNext();
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for download to finish.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
