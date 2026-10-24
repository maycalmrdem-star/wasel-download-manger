const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, Menu, Tray, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { autoUpdater } = require('electron-updater');
const { DownloadManager } = require('./download-manager');
const { isSupportedLanguage, SUPPORTED_LANGUAGES } = require('./languages');

let mainWindow;
let manager;
let parseDownloadProtocolUrl;
let isClosing = false;
let pendingProtocolUrls = [];
let protocolQueue = Promise.resolve();
let tray;
let updateCheckTimer;
let lastUpdateProgress = 0;
const hasSingleInstanceLock = app.requestSingleInstanceLock();

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function processProtocolUrl(rawUrl) {
  if (!/^wasel:/i.test(rawUrl)) return;
  if (!manager || !mainWindow) {
    pendingProtocolUrls.push(rawUrl);
    return;
  }

  protocolQueue = protocolQueue.then(async () => {
    const url = parseDownloadProtocolUrl(rawUrl);
    showMainWindow();
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['إضافة إلى قائمة التنزيل', 'إلغاء'],
      defaultId: 1,
      cancelId: 1,
      title: 'واصل — طلب تنزيل جديد',
      message: 'هل تريد إضافة هذا الرابط إلى قائمة التنزيلات؟',
      detail: url,
      noLink: true
    });
    if (answer.response === 0) {
      await manager.add({ url, startImmediately: true });
    }
  }).catch((error) => {
    dialog.showErrorBox('تعذر استقبال رابط التنزيل', error.message);
  });
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    processProtocolUrl(url);
  });

  app.on('second-instance', (_event, commandLine) => {
    const protocolUrl = commandLine.find((argument) => /^wasel:/i.test(argument));
    showMainWindow();
    if (protocolUrl) processProtocolUrl(protocolUrl);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 760,
    minHeight: 420,
    backgroundColor: '#171d24',
    title: 'واصل — مدير التحميلات',
    frame: false,
    icon: path.join(__dirname, '..', 'assets', 'wasel.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.on('close', (event) => {
    if (!isClosing) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('maximize', () => broadcast('window:maximized', true));
  mainWindow.on('unmaximize', () => broadcast('window:maximized', false));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(startUpdateChecks, 1200);
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(path.join(__dirname, 'index.html')).href) {
      event.preventDefault();
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', 'wasel.ico'));
  tray.setToolTip('واصل — مدير التحميلات');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  updateTrayMenu();
}

function updateTrayMenu(downloadState = manager?.getState()) {
  if (!tray || tray.isDestroyed() || !downloadState) return;
  const activeCount = downloadState.downloads.filter((item) => item.status === 'downloading').length;
  const hasRunningDownloads = downloadState.downloads.some((item) =>
    item.status === 'downloading' || item.status === 'queued'
  );
  tray.setToolTip(activeCount
    ? `واصل — ${activeCount} تنزيل نشط`
    : 'واصل — مدير التحميلات');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'فتح واصل', click: showMainWindow },
    {
      label: hasRunningDownloads ? 'إيقاف التنزيلات مؤقتًا' : 'استئناف التنزيلات',
      click: () => {
        const action = hasRunningDownloads ? manager.pauseAll() : manager.resumeAll();
        action.catch((error) => dialog.showErrorBox('تعذر التحكم بالتنزيلات', error.message));
      }
    },
    { type: 'separator' },
    { label: 'إنهاء واصل', click: () => app.quit() }
  ]));
}

function publishUpdateStatus(key, detail = '', type = 'info') {
  broadcast('updates:status', { key, detail, type });
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    publishUpdateStatus('التحديثات التلقائية متاحة في النسخة المثبتة فقط.');
    return false;
  }
  if (!process.env.GH_TOKEN) {
    publishUpdateStatus('للبحث عن تحديثات المستودع الخاص، اضبط GH_TOKEN للمستخدم ثم أعد تشغيل واصل.', 'error');
    return false;
  }
  const result = await autoUpdater.checkForUpdates();
  return Boolean(result?.updateInfo);
}

function startUpdateChecks() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  lastUpdateProgress = 0;
  autoUpdater.on('checking-for-update', () => publishUpdateStatus('يجري التحقق من وجود تحديثات...'));
  autoUpdater.on('update-available', (info) => {
    publishUpdateStatus('يتوفر تحديث واصل', info.version);
  });
  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    if (percent >= lastUpdateProgress + 10) {
      lastUpdateProgress = percent;
      publishUpdateStatus('تنزيل التحديث', String(percent));
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    publishUpdateStatus('اكتمل تنزيل واصل', info.version);
    const installPrompt = () => dialog.showMessageBox({
      type: 'info',
      title: 'تحديث واصل جاهز',
      message: `اكتمل تنزيل واصل ${info.version}.`,
      detail: 'أعد تشغيل التطبيق الآن لتثبيت التحديث، أو اختر لاحقًا.',
      buttons: ['إعادة التشغيل والتثبيت', 'لاحقًا'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    }).catch((error) => {
      dialog.showErrorBox('تعذر تثبيت تحديث واصل', error.message);
    });
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: 'تحديث واصل جاهز',
        body: 'انقر لإعادة التشغيل وتثبيت التحديث.'
      });
      notification.on('click', installPrompt);
      notification.show();
    } else {
      installPrompt();
    }
  });
  autoUpdater.on('error', (error) => {
    publishUpdateStatus('تعذر التحقق من التحديث', error.message, 'error');
  });
  checkForUpdates().catch((error) => {
    publishUpdateStatus('تعذر التحقق من التحديث', error.message, 'error');
  });
  updateCheckTimer = setInterval(() => {
    checkForUpdates().catch((error) => {
      publishUpdateStatus('تعذر التحقق من التحديث', error.message, 'error');
    });
  }, 6 * 60 * 60 * 1000);
  updateCheckTimer.unref();
}

function registerIpc() {
  ipcMain.handle('languages:list', async () => {
    const resources = await Promise.all(SUPPORTED_LANGUAGES.map(async (code) => {
      const locale = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'lang', `${code}.json`), 'utf8'));
      return { code, name: locale.name, direction: locale.direction };
    }));
    return resources;
  });
  ipcMain.handle('languages:get', async (_event, code) => {
    if (!isSupportedLanguage(code)) throw new Error('لغة الواجهة المحددة غير مدعومة.');
    return JSON.parse(await fs.readFile(path.join(__dirname, '..', 'lang', `${code}.json`), 'utf8'));
  });
  ipcMain.handle('window:action', (event, action) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (action === 'minimize') window.minimize();
    else if (action === 'maximize') {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      return window.isMaximized();
    } else if (action === 'close') window.close();
    else if (action === 'quit') app.quit();
  });
  ipcMain.handle('window:is-maximized', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window?.isMaximized() ?? false;
  });
  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('downloads:get-state', () => manager.getState());
  ipcMain.handle('downloads:add', (_event, input) => manager.add(input));
  ipcMain.handle('downloads:pause', (_event, id) => manager.pause(id));
  ipcMain.handle('downloads:resume', (_event, id) => manager.resume(id));
  ipcMain.handle('downloads:cancel', (_event, id) => manager.cancel(id));
  ipcMain.handle('downloads:remove', (_event, id) => manager.remove(id));
  ipcMain.handle('downloads:remove-with-file', (_event, id) => manager.remove(id, { deleteFile: true }));
  ipcMain.handle('downloads:clear-completed', () => manager.clearCompleted());
  ipcMain.handle('downloads:pause-all', () => manager.pauseAll());
  ipcMain.handle('downloads:resume-all', () => manager.resumeAll());
  ipcMain.handle('downloads:stop-all', () => manager.pauseAll());
  ipcMain.handle('downloads:update-settings', (_event, settings) => manager.updateSettings(settings));
  ipcMain.handle('downloads:choose-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      defaultPath: manager.getState().settings.outputFolder
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return manager.setOutputFolder(result.filePaths[0]);
  });
  ipcMain.handle('downloads:open-file', async (_event, id) => {
    const item = manager.getDownload(id);
    if (!item || item.status !== 'completed') throw new Error('الملف غير متاح للفتح.');
    const error = await shell.openPath(item.savePath);
    if (error) throw new Error(error);
  });
  ipcMain.handle('downloads:show-file', (_event, id) => {
    const item = manager.getDownload(id);
    if (!item) throw new Error('تعذر العثور على التنزيل.');
    shell.showItemInFolder(item.savePath);
  });
  ipcMain.handle('downloads:open-folder', async () => {
    const error = await shell.openPath(manager.getState().settings.outputFolder);
    if (error) throw new Error(error);
  });
  ipcMain.handle('downloads:open-external', async (_event, url) => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('الرابط غير مسموح.');
    await shell.openExternal(parsed.href);
  });
  ipcMain.handle('downloads:copy-text', (_event, text) => clipboard.writeText(String(text)));
  ipcMain.handle('downloads:read-clipboard', () => clipboard.readText());
  ipcMain.handle('downloads:export', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'تصدير قائمة التنزيلات',
      defaultPath: 'wasel-downloads.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return false;
    await fs.writeFile(result.filePath, JSON.stringify(manager.getState(), null, 2), 'utf8');
    return true;
  });
  ipcMain.handle('downloads:import', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'استيراد قائمة التنزيلات',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || result.filePaths.length === 0) return false;
    const imported = JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
    if (!Array.isArray(imported.downloads)) throw new Error('ملف القائمة لا يحتوي على تنسيـق واصل صالح.');
    for (const [index, item] of imported.downloads.entries()) {
      if (!item || typeof item.url !== 'string' || typeof item.fileName !== 'string') {
        throw new Error(`العنصر رقم ${index + 1} لا يحتوي على رابط واسم ملف صالحين.`);
      }
      let parsed;
      try {
        parsed = new URL(item.url);
      } catch {
        throw new Error(`رابط العنصر رقم ${index + 1} غير صالح.`);
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`بروتوكول العنصر رقم ${index + 1} غير مدعوم.`);
      }
    }
    for (const item of imported.downloads) {
      await manager.add({ url: item.url, fileName: item.fileName, startImmediately: false });
    }
    return imported.downloads.length > 0;
  });
  ipcMain.handle('app:get-version', () => app.getVersion());
  ipcMain.handle('help:open', async () => {
    const error = await shell.openPath(path.join(__dirname, '..', 'README.md'));
    if (error) throw new Error(error);
  });
  ipcMain.handle('help:extension-guide', async () => {
    const error = await shell.openPath(path.join(__dirname, '..', 'extension', 'INSTALL.md'));
    if (error) throw new Error(error);
  });
  ipcMain.handle('app:get-extension-path', () => path.join(app.getAppPath(), 'extension'));
}

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  ({ parseDownloadProtocolUrl } = await import('../extension/link-protocol.js'));
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient('wasel', process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient('wasel');
  }
  const dataDirectory = path.join(app.getPath('userData'), 'downloads');
  await fs.mkdir(dataDirectory, { recursive: true });
  manager = new DownloadManager({
    dataFile: path.join(dataDirectory, 'library.json'),
    defaultFolder: path.join(app.getPath('downloads'), 'Wasel'),
    onChange: (state) => {
      broadcast('downloads:changed', state);
      updateTrayMenu(state);
    }
  });
  await manager.initialize();
  registerIpc();
  createWindow();
  createTray();
  const startupUrl = process.argv.find((argument) => /^wasel:/i.test(argument));
  if (startupUrl) pendingProtocolUrls.push(startupUrl);
  for (const protocolUrl of pendingProtocolUrls) processProtocolUrl(protocolUrl);
  pendingProtocolUrls = [];

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    showMainWindow();
  });
}).catch((error) => {
  dialog.showErrorBox('تعذر تشغيل واصل', error.message);
  app.quit();
});

app.on('before-quit', (event) => {
  clearInterval(updateCheckTimer);
  if (!manager || isClosing) return;
  event.preventDefault();
  isClosing = true;
  manager.shutdown().then(() => app.quit()).catch((error) => {
    dialog.showErrorBox('تعذر حفظ التنزيلات', error.message);
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') app.quit();
});
