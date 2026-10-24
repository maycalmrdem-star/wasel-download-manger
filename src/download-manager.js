const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isSupportedLanguage } = require('./languages');

const MAX_ACTIVE_DOWNLOADS = 3;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

class DownloadManager {
  constructor({ dataFile, defaultFolder, onChange = () => {} }) {
    this.dataFile = dataFile;
    this.defaultFolder = defaultFolder;
    this.onChange = onChange;
    this.items = [];
    this.active = new Map();
    this.settings = { theme: 'dark', language: 'ara', maxActiveDownloads: MAX_ACTIVE_DOWNLOADS };
    this.persistChain = Promise.resolve();
    this.shuttingDown = false;
    this.tick = setInterval(() => this.reportProgress(), 500);
    this.tick.unref();
  }

  async initialize() {
    await ensureDirectory(this.defaultFolder);
    try {
      const stored = JSON.parse(await fsp.readFile(this.dataFile, 'utf8'));
      if (Array.isArray(stored.items)) this.items = stored.items;
      if (stored.settings && ['light', 'dark'].includes(stored.settings.theme)) {
        this.settings.theme = stored.settings.theme;
      }
      if (stored.settings && isSupportedLanguage(stored.settings.language)) {
        this.settings.language = stored.settings.language;
      }
      if (stored.settings && Number.isInteger(stored.settings.maxActiveDownloads)) {
        this.settings.maxActiveDownloads = Math.min(10, Math.max(1, stored.settings.maxActiveDownloads));
      }
      if (stored.settings && typeof stored.settings.outputFolder === 'string') {
        const storedFolder = path.resolve(stored.settings.outputFolder);
        await ensureDirectory(storedFolder);
        this.defaultFolder = storedFolder;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    for (const item of this.items) {
      if (item.status === 'downloading') item.status = 'paused';
      if (item.status === 'queued') item.status = 'paused';
      if (item.status === 'downloading' || item.status === 'paused') {
        item.receivedBytes = await this.getPartialSize(item);
      }
    }
    await this.persist();
    this.publish();
  }

  getState() {
    return {
      downloads: this.items.map((item) => ({ ...item })),
      settings: { outputFolder: this.defaultFolder, ...this.settings },
      maxActiveDownloads: this.settings.maxActiveDownloads
    };
  }

  getDownload(id) {
    return this.items.find((item) => item.id === id);
  }

  async add({ url, fileName, startImmediately = true } = {}) {
    if (typeof url !== 'string' || !url.trim()) throw new Error('أدخل رابطًا صالحًا.');
    let parsed;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw new Error('صيغة الرابط غير صحيحة.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('يدعم واصل روابط HTTP وHTTPS فقط.');
    }

    await ensureDirectory(this.defaultFolder);
    let urlFileName = path.posix.basename(parsed.pathname);
    try {
      urlFileName = decodeURIComponent(urlFileName);
    } catch {
      // Keep the encoded filename when the URL contains malformed escapes.
    }
    const suggestedName = cleanFileName(
      typeof fileName === 'string' && fileName.trim()
        ? fileName
        : urlFileName || 'download'
    );
    const reservedNames = new Set(this.items.map((item) => item.fileName.toLowerCase()));
    let fileNameUnique = uniqueName(suggestedName, reservedNames);
    let suffix = 1;
    while (
      reservedNames.has(fileNameUnique.toLowerCase()) ||
      await fileExists(path.join(this.defaultFolder, fileNameUnique)) ||
      await fileExists(path.join(this.defaultFolder, `${fileNameUnique}.part`))
    ) {
      const extension = path.extname(suggestedName);
      const base = suggestedName.slice(0, suggestedName.length - extension.length);
      fileNameUnique = `${base} (${suffix})${extension}`;
      suffix += 1;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const item = {
      id,
      url: parsed.href,
      fileName: fileNameUnique,
      savePath: path.join(this.defaultFolder, fileNameUnique),
      status: startImmediately ? 'queued' : 'paused',
      category: categoryFor(fileNameUnique),
      receivedBytes: 0,
      totalBytes: 0,
      speed: 0,
      createdAt: new Date().toISOString(),
      error: null
    };
    this.items.unshift(item);
    await this.persist();
    this.publish();
    this.schedule();
    return { ...item };
  }

  async pause(id) {
    const item = this.requireItem(id);
    if (item.status !== 'downloading' && item.status !== 'queued') return;
    item.status = 'paused';
    const active = this.active.get(id);
    if (active) {
      active.stopReason = 'paused';
      active.request?.destroy();
      await active.done;
    }
    await this.persist();
    this.publish();
  }

  async resume(id) {
    const item = this.requireItem(id);
    if (!['paused', 'error'].includes(item.status)) return;
    item.status = 'queued';
    item.error = null;
    await this.persist();
    this.publish();
    this.schedule();
  }

  async cancel(id) {
    const item = this.requireItem(id);
    if (item.status === 'completed') return;
    item.status = 'cancelled';
    item.error = null;
    const active = this.active.get(id);
    if (active) active.stopReason = 'cancelled';
    active?.request?.destroy();
    if (active?.done) await active.done;
    await this.removePartial(item);
    item.receivedBytes = 0;
    item.totalBytes = 0;
    await this.persist();
    this.publish();
  }

  async remove(id, { deleteFile = false } = {}) {
    const item = this.requireItem(id);
    if (item.status === 'downloading' || item.status === 'queued') {
      throw new Error('أوقف التنزيل أو ألغِه قبل حذفه من القائمة.');
    }
    await this.removePartial(item);
    if (deleteFile && item.status === 'completed') {
      await fsp.unlink(item.savePath);
    }
    this.items = this.items.filter((entry) => entry.id !== id);
    await this.persist();
    this.publish();
  }

  async clearCompleted() {
    this.items = this.items.filter((item) => item.status !== 'completed');
    await this.persist();
    this.publish();
  }

  async pauseAll() {
    await Promise.all(this.items
      .filter((item) => item.status === 'downloading' || item.status === 'queued')
      .map((item) => this.pause(item.id)));
  }

  async resumeAll() {
    await Promise.all(this.items
      .filter((item) => ['paused', 'error'].includes(item.status))
      .map((item) => this.resume(item.id)));
  }

  async stopAll() {
    await this.pauseAll();
  }

  async setOutputFolder(folder) {
    if (typeof folder !== 'string' || !folder.trim()) throw new Error('اختر مجلد تنزيل صالحًا.');
    const resolvedFolder = path.resolve(folder);
    const folderInfo = await fsp.stat(resolvedFolder);
    if (!folderInfo.isDirectory()) throw new Error('المسار المحدد ليس مجلدًا.');
    this.defaultFolder = resolvedFolder;
    await this.persist();
    this.publish();
    return this.getState().settings;
  }

  async updateSettings(settings) {
    if (settings.theme !== undefined) {
      if (!['light', 'dark'].includes(settings.theme)) throw new Error('المظهر المحدد غير صالح.');
      this.settings.theme = settings.theme;
    }
    if (settings.language !== undefined) {
      if (!isSupportedLanguage(settings.language)) throw new Error('لغة الواجهة المحددة غير مدعومة.');
      this.settings.language = settings.language;
    }
    if (settings.maxActiveDownloads !== undefined) {
      const value = Number(settings.maxActiveDownloads);
      if (!Number.isInteger(value) || value < 1 || value > 10) {
        throw new Error('عدد التنزيلات المتزامنة يجب أن يكون بين 1 و10.');
      }
      this.settings.maxActiveDownloads = value;
    }
    await this.persist();
    this.publish();
    this.schedule();
    return this.getState().settings;
  }

  async shutdown() {
    this.shuttingDown = true;
    clearInterval(this.tick);
    const activeDownloads = [...this.active.entries()];
    for (const [id, active] of activeDownloads) {
      const item = this.getDownload(id);
      if (item && item.status === 'downloading') item.status = 'paused';
      active.stopReason = 'shutdown';
      active.request?.destroy();
    }
    await Promise.all(activeDownloads.map(([, active]) => active.done));
    await this.persist();
  }

  requireItem(id) {
    const item = this.getDownload(id);
    if (!item) throw new Error('تعذر العثور على التنزيل.');
    return item;
  }

  schedule() {
    if (this.shuttingDown) return;
    while (this.active.size < this.settings.maxActiveDownloads) {
      const item = this.items.find((entry) => entry.status === 'queued');
      if (!item) break;
      const startedAt = Date.now();
      const control = {
        request: null,
        lastBytes: item.receivedBytes,
        lastTime: startedAt,
        samples: [[startedAt, item.receivedBytes]]
      };
      this.active.set(item.id, control);
      item.status = 'downloading';
      this.publish();
      control.done = this.runDownload(item, control).finally(async () => {
        this.active.delete(item.id);
        try {
          await this.persist();
        } finally {
          this.publish();
          this.schedule();
        }
      }).catch((error) => {
        item.status = 'error';
        item.error = `تعذر حفظ حالة التنزيل: ${error.message}`;
        this.publish();
        this.schedule();
      });
    }
  }

  async runDownload(item, control) {
    let offset = 0;
    try {
      await ensureDirectory(path.dirname(item.savePath));
      offset = await this.getPartialSize(item);
      item.receivedBytes = offset;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const headers = offset > 0 ? { Range: `bytes=${offset}-` } : {};
        const { response, request } = await this.openResponse(item.url, headers, control);
        const status = response.statusCode || 0;

        if (status === 416 && offset > 0) {
          const range = response.headers['content-range'] || '';
          const total = Number(range.match(/\/(\d+)$/)?.[1]);
          response.resume();
          if (Number.isFinite(total) && total === offset) {
            item.totalBytes = total;
            break;
          }
          await this.removePartial(item);
          offset = 0;
          continue;
        }

        const append = offset > 0 && status === 206;
        if (offset > 0 && status === 200) {
          response.resume();
          request.destroy();
          await this.removePartial(item);
          offset = 0;
          continue;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          throw new Error(`استجاب الخادم بالرمز ${status}.`);
        }
        if (append) {
          const start = Number(response.headers['content-range']?.match(/^bytes (\d+)-/)?.[1]);
          if (start !== offset) {
            response.resume();
            throw new Error('أرسل الخادم نطاق استئناف غير متوقع.');
          }
        }

        const contentLength = Number(response.headers['content-length']);
        const contentRangeTotal = Number(response.headers['content-range']?.match(/\/(\d+)$/)?.[1]);
        item.totalBytes = Number.isFinite(contentRangeTotal)
          ? contentRangeTotal
          : Number.isFinite(contentLength) ? offset + contentLength : 0;
        item.receivedBytes = append ? offset : 0;
        const output = fs.createWriteStream(`${item.savePath}.part`, { flags: append ? 'a' : 'w' });
        const progress = new Transform({
          transform: (chunk, _encoding, callback) => {
            item.receivedBytes += chunk.length;
            callback(null, chunk);
          }
        });
        await pipeline(response, progress, output);
        item.receivedBytes = await this.getPartialSize(item);
        if (item.totalBytes > 0 && item.receivedBytes !== item.totalBytes) {
          throw new Error(`انقطع الاتصال قبل اكتمال الملف (${item.receivedBytes}/${item.totalBytes} بايت).`);
        }
        break;
      }

      if (control.stopReason || item.status === 'paused' || item.status === 'cancelled' || this.shuttingDown) return;
      if (item.totalBytes > 0 && item.receivedBytes !== item.totalBytes) {
        throw new Error('تعذر استئناف التنزيل من هذا الخادم.');
      }
      await fsp.rename(`${item.savePath}.part`, item.savePath);
      item.status = 'completed';
      item.receivedBytes = await fsp.stat(item.savePath).then((file) => file.size);
      item.totalBytes = item.receivedBytes;
      item.error = null;
    } catch (error) {
      let reportedError = error;
      try {
        item.receivedBytes = await this.getPartialSize(item);
      } catch (partialError) {
        if (['EACCES', 'EPERM'].includes(partialError.code)) reportedError = partialError;
      }
      if (control.stopReason || item.status === 'paused' || item.status === 'cancelled' || this.shuttingDown) return;
      item.status = 'error';
      item.error = ['EACCES', 'EPERM'].includes(reportedError.code)
        ? `لا توجد صلاحية للكتابة إلى مسار الحفظ "${item.savePath}". اختر مجلدًا آخر أو تحقق من صلاحيات القرص. (${reportedError.code})`
        : reportedError.message || 'حدث خطأ أثناء التنزيل.';
    }
  }

  openResponse(rawUrl, headers, control, redirects = 0) {
    return new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(rawUrl);
      } catch (error) {
        reject(error);
        return;
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        reject(new Error('أعاد الخادم توجيه الرابط إلى بروتوكول غير مدعوم.'));
        return;
      }
      if (redirects > 10) {
        reject(new Error('تجاوز الرابط الحد المسموح به من التحويلات.'));
        return;
      }
      const transport = parsed.protocol === 'https:' ? https : http;
      const request = transport.get(parsed, { headers }, (response) => {
        if (REDIRECT_CODES.has(response.statusCode) && response.headers.location) {
          const nextUrl = new URL(response.headers.location, parsed).href;
          response.resume();
          this.openResponse(nextUrl, headers, control, redirects + 1).then(resolve, reject);
          return;
        }
        resolve({ response, request });
      });
      control.request = request;
      request.setTimeout(30_000, () => request.destroy(new Error('انتهت مهلة الاتصال بالخادم.')));
      request.once('error', reject);
    });
  }

  async getPartialSize(item) {
    try {
      return (await fsp.stat(`${item.savePath}.part`)).size;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async removePartial(item) {
    try {
      await fsp.unlink(`${item.savePath}.part`);
    } catch (error) {
      if (error.code === 'ENOTDIR') {
        throw new Error(`جزء من مسار التنزيل ليس مجلدًا: ${resolvedFolder}`);
      }
      if (error.code !== 'ENOENT') throw error;
    }
  }

  reportProgress() {
    let changed = false;
    const now = Date.now();
    for (const [id, control] of this.active) {
      const item = this.getDownload(id);
      if (!item || item.status !== 'downloading') continue;
      control.samples.push([now, item.receivedBytes]);
      while (control.samples.length > 1 && now - control.samples[0][0] > 3000) {
        control.samples.shift();
      }
      const [sampleTime, sampleBytes] = control.samples[0];
      const deltaTime = now - sampleTime;
      item.speed = deltaTime >= 500
        ? Math.max(0, Math.round(((item.receivedBytes - sampleBytes) * 1000) / deltaTime))
        : 0;
      control.lastBytes = item.receivedBytes;
      control.lastTime = now;
      changed = true;
    }
    if (changed) this.publish();
  }

  publish() {
    this.onChange(this.getState());
  }

  persist() {
    const contents = JSON.stringify({
      items: this.items,
      settings: { outputFolder: this.defaultFolder, ...this.settings }
    }, null, 2);
    this.persistChain = this.persistChain.then(() =>
      fsp.writeFile(this.dataFile, contents, 'utf8')
    );
    return this.persistChain;
  }
}

async function ensureDirectory(folder) {
  const resolvedFolder = path.resolve(folder);
  try {
    const info = await fsp.stat(resolvedFolder);
    if (!info.isDirectory()) throw new Error(`مسار التنزيل ليس مجلدًا: ${folder}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (path.normalize(resolvedFolder) === path.normalize(path.parse(resolvedFolder).root)) {
      throw new Error(`قرص الحفظ غير متاح: ${resolvedFolder}. اختر مجلدًا على قرص متصل وقابل للكتابة.`);
    }
    await fsp.mkdir(resolvedFolder, { recursive: true });
  }
}

function cleanFileName(value) {
  const cleaned = path.basename(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(cleaned)
    ? cleaned
    : 'download';
}

function uniqueName(fileName, reserved) {
  const extension = path.extname(fileName);
  const base = fileName.slice(0, fileName.length - extension.length);
  let result = fileName;
  let index = 1;
  while (reserved.has(result.toLowerCase())) {
    result = `${base} (${index})${extension}`;
    index += 1;
  }
  return result;
}

function categoryFor(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  if (['.mp4', '.mkv', '.mov', '.avi', '.mp3', '.wav', '.webm'].includes(extension)) return 'media';
  if (['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.txt'].includes(extension)) return 'documents';
  if (['.zip', '.rar', '.7z', '.gz', '.tar'].includes(extension)) return 'archives';
  if (['.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp'].includes(extension)) return 'images';
  if (['.exe', '.msi', '.dmg', '.deb', '.apk'].includes(extension)) return 'software';
  return 'other';
}

async function fileExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

module.exports = { DownloadManager, categoryFor, cleanFileName, uniqueName };
