const CATEGORY_LABELS = {
  archives: 'ملفات مضغوطة',
  documents: 'مستندات',
  media: 'موسيقى وفيديو',
  software: 'برامج',
  images: 'صور',
  other: 'أخرى'
};

const STATUS_LABELS = {
  queued: 'في قائمة الانتظار',
  downloading: 'يستقبل البيانات...',
  paused: 'متوقف مؤقتًا',
  completed: 'مكتمل',
  error: 'خطأ',
  cancelled: 'ملغى'
};

window.WaselIcons.hydrate();

const state = {
  downloads: [],
  settings: { outputFolder: '', theme: 'dark', language: 'ara', maxActiveDownloads: 3 },
  locale: { name: 'العربية', locale: 'ar', direction: 'rtl', translations: {} },
  filter: 'all',
  category: '',
  query: '',
  sort: 'createdAt',
  sortDirection: -1,
  selected: new Set(),
  contextId: null,
  progressId: null,
  scheduleTimer: null,
  scheduleTarget: null
};

const rowsElement = document.getElementById('downloadRows');
const backdrop = document.getElementById('modalBackdrop');
const dialogs = [...document.querySelectorAll('.dialog')];
const contextMenu = document.getElementById('contextMenu');
let toastTimer;
const originalTextNodes = new WeakMap();
const originalAttributes = new WeakMap();

function translate(text) {
  return state.locale.translations?.[text] || text;
}

function applyTranslations() {
  document.documentElement.lang = state.locale.locale || 'ar';
  document.documentElement.dir = state.locale.direction || 'rtl';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!originalTextNodes.has(node)) originalTextNodes.set(node, node.nodeValue);
    const original = originalTextNodes.get(node);
    const trimmed = original.trim();
    const translated = state.locale.translations?.[trimmed];
    if (translated) {
      const start = original.match(/^\s*/)?.[0] || '';
      const end = original.match(/\s*$/)?.[0] || '';
      node.nodeValue = `${start}${translated}${end}`;
    } else {
      node.nodeValue = original;
    }
  }

  for (const element of document.querySelectorAll('[placeholder], [title], [aria-label]')) {
    let original = originalAttributes.get(element);
    if (!original) {
      original = {};
      originalAttributes.set(element, original);
    }
    for (const attribute of ['placeholder', 'title', 'aria-label']) {
      if (!element.hasAttribute(attribute)) continue;
      if (original[attribute] === undefined) original[attribute] = element.getAttribute(attribute);
      const value = original[attribute];
      element.setAttribute(attribute, state.locale.translations?.[value] || value);
    }
  }
}

async function loadLocale(language) {
  const locale = await window.wasel.getLanguage(language);
  const fallback = language === 'ara' ? null : await window.wasel.getLanguage('eng');
  state.locale = fallback
    ? { ...locale, translations: { ...fallback.translations, ...locale.translations } }
    : locale;
  state.settings.language = language;
  applyTranslations();
  render();
}

async function populateLanguageOptions() {
  const languages = await window.wasel.listLanguages();
  const selector = document.getElementById('languageSelect');
  selector.replaceChildren(...languages.map((language) => {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = language.name;
    return option;
  }));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatRate(bytes) {
  if (!bytes || bytes < 1) return '—';
  return `${formatBytes(bytes)}/s`;
}

function formatEta(item) {
  if (!item.speed || item.speed < 1 || !item.totalBytes) return '—';
  const seconds = Math.max(0, Math.ceil((item.totalBytes - item.receivedBytes) / item.speed));
  const units = state.locale.direction === 'rtl'
    ? { seconds: 'ث', minutes: 'د', hours: 'س' }
    : { seconds: 's', minutes: 'm', hours: 'h' };
  if (seconds < 60) return `${seconds} ${units.seconds}`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} ${units.minutes} ${seconds % 60} ${units.seconds}`;
  return `${Math.floor(seconds / 3600)} ${units.hours} ${Math.floor((seconds % 3600) / 60)} ${units.minutes}`;
}

function percent(item) {
  if (item.status === 'completed') return 100;
  if (!item.totalBytes || item.totalBytes <= 0) return 0;
  return Math.min(100, Math.max(0, Math.floor((item.receivedBytes / item.totalBytes) * 100)));
}

function iconFor(item) {
  const icons = {
    archives: 'archive', documents: 'document', media: 'media', software: 'software',
    images: 'image', other: 'download'
  };
  return icons[item.category] || icons.other;
}

function statusFor(item) {
  if (item.status === 'downloading') return `${percent(item)}%`;
  return STATUS_LABELS[item.status] || item.status;
}

function filterItems() {
  let items = state.downloads.filter((item) => {
    if (state.filter === 'unfinished' && ['completed', 'cancelled'].includes(item.status)) return false;
    if (state.filter === 'completed' && item.status !== 'completed') return false;
    if (state.filter === 'all' && state.category && item.category !== state.category) return false;
    if (state.query) {
      const query = state.query.toLocaleLowerCase(state.locale.locale || 'ar');
      const text = `${item.fileName} ${item.url} ${item.status}`.toLocaleLowerCase(state.locale.locale || 'ar');
      if (!text.includes(query)) return false;
    }
    return true;
  });
  window.wasel.onUpdateStatus(({ key, detail, type }) => {
    const prefix = translate(key);
    const suffix = key === 'يتوفر تحديث واصل'
      ? ` ${detail} ${translate('وسيتم تنزيله تلقائيًا.')}`
      : key === 'تنزيل التحديث'
        ? ` ${detail}%`
        : key === 'اكتمل تنزيل واصل'
          ? ` ${detail}. ${translate('اختر إعادة التشغيل لتثبيته.')}`
          : key === 'تعذر التحقق من التحديث'
            ? `: ${detail}`
            : '';
    showToast(`${prefix}${suffix}`, type);
  });
  items.sort((a, b) => {
    let left = a[state.sort];
    let right = b[state.sort];
    if (state.sort === 'createdAt') {
      left = Date.parse(left) || 0;
      right = Date.parse(right) || 0;
    }
    if (typeof left === 'string') return left.localeCompare(right, state.locale.locale || 'ar') * state.sortDirection;
    return ((Number(left) || 0) - (Number(right) || 0)) * state.sortDirection;
  });
  return items;
}

function selectedItems() {
  return state.downloads.filter((item) => state.selected.has(item.id));
}

function fileRow(item) {
  const host = (() => {
    try { return new URL(item.url).host; } catch { return ''; }
  })();
  const date = new Date(item.createdAt);
  const validDate = !Number.isNaN(date.valueOf());
  const isSelected = state.selected.has(item.id);
  return `<tr data-id="${escapeHtml(item.id)}" class="status-${escapeHtml(item.status)} ${isSelected ? 'selected' : ''}" aria-selected="${isSelected}">
    <td class="select-cell"><input type="checkbox" data-select-row="${escapeHtml(item.id)}" aria-label="${escapeHtml(translate('تحديد'))} ${escapeHtml(item.fileName)}" ${isSelected ? 'checked' : ''}></td>
    <td class="name-cell" title="${escapeHtml(item.fileName)}"><div class="file-cell">${window.WaselIcons.markup(iconFor(item), 'file-type-icon')}<b class="file-name">${escapeHtml(item.fileName)}</b></div></td>
    <td class="queue-cell"><span class="queue-mark" title="قائمة التنزيل الرئيسية">▤</span></td>
    <td class="size-cell" data-value="${Number(item.totalBytes) || 0}">${formatBytes(item.totalBytes)}</td>
    <td class="status-cell" title="${escapeHtml(item.error || STATUS_LABELS[item.status] || '')}">${escapeHtml(statusFor(item))}</td>
    <td class="time-cell">${item.status === 'downloading' ? formatEta(item) : '—'}</td>
    <td class="rate-cell">${item.status === 'downloading' ? formatRate(item.speed) : '—'}</td>
    <td class="date-cell" title="${validDate ? date.toLocaleString(state.locale.locale) : ''}">${validDate ? date.toLocaleDateString(state.locale.locale) : '—'}</td>
    <td title="${escapeHtml(item.error || host)}">${escapeHtml(item.error || host)}</td>
  </tr>`;
}

function renderTableRows() {
  const items = filterItems();
  if (!items.length) {
    rowsElement.innerHTML = '';
    return;
  }
  const tableWrap = document.getElementById('tableWrap');
  const rowHeight = 23;
  const first = Math.max(0, Math.floor(tableWrap.scrollTop / rowHeight) - 2);
  const count = Math.ceil(tableWrap.clientHeight / rowHeight) + 8;
  const last = Math.min(items.length, first + count);
  const topSpace = first * rowHeight;
  const bottomSpace = Math.max(0, (items.length - last) * rowHeight);
  rowsElement.innerHTML = `${topSpace ? `<tr class="virtual-spacer"><td colspan="9" style="height:${topSpace}px"></td></tr>` : ''}${items.slice(first, last).map(fileRow).join('')}${bottomSpace ? `<tr class="virtual-spacer"><td colspan="9" style="height:${bottomSpace}px"></td></tr>` : ''}`;
}

function updateSelectionUI() {
  const items = filterItems();
  rowsElement.querySelectorAll('tr[data-id]').forEach((row) => {
    const selected = state.selected.has(row.dataset.id);
    row.classList.toggle('selected', selected);
    row.setAttribute('aria-selected', String(selected));
    const checkbox = row.querySelector('[data-select-row]');
    if (checkbox) checkbox.checked = selected;
  });
  document.getElementById('selectAll').checked = items.length > 0 && items.every((item) => state.selected.has(item.id));
  document.getElementById('selectionSummary').textContent = state.selected.size
    ? `${translate('تم تحديد')} ${state.selected.size} ${translate('ملف')}`
    : translate('لم يتم تحديد أي ملف');
  updateActionStates();
}

function render() {
  const items = filterItems();
  renderTableRows();
  const empty = document.getElementById('emptyState');
  empty.hidden = items.length > 0;
  document.getElementById('tableTotal').textContent = String(items.length);
  document.getElementById('countAll').textContent = String(state.downloads.length);
  document.getElementById('countCompleted').textContent = String(state.downloads.filter((item) => item.status === 'completed').length);
  document.getElementById('countUnfinished').textContent = String(state.downloads.filter((item) => !['completed', 'cancelled'].includes(item.status)).length);
  document.getElementById('countQueue').textContent = String(state.downloads.filter((item) => item.status === 'queued' || item.status === 'downloading').length);
  document.querySelectorAll('[data-count-category]').forEach((element) => {
    element.textContent = String(state.downloads.filter((item) => item.category === element.dataset.countCategory).length);
  });

  const active = state.downloads.filter((item) => item.status === 'downloading');
  const queued = state.downloads.filter((item) => item.status === 'queued').length;
  const completed = state.downloads.filter((item) => item.status === 'completed').length;
  const totalSpeed = active.reduce((sum, item) => sum + (item.speed || 0), 0);
  document.getElementById('statusCounts').textContent =
    `${state.downloads.length} ${translate('التنزيلات')} · ${active.length} ${translate('نشط')} · ${completed} ${translate('مكتمل')}`;
  document.getElementById('statusFolder').textContent = state.settings.outputFolder || '—';
  document.getElementById('statusFolder').title = state.settings.outputFolder || '';
  document.getElementById('statusSpeed').textContent = `↓ ${formatRate(totalSpeed) === '—' ? '0 KB/s' : formatRate(totalSpeed)}`;
  document.getElementById('statusLimiter').textContent = `${translate('قيد الانتظار')}: ${queued}`;
  document.title = `${state.downloads.length} ${translate('التنزيلات')} — ${translate('عنوان التطبيق')}`;
  updateSelectionUI();
  updateProgressDialog();
  applyTranslations();
}

function setSelection(id, selected) {
  if (selected) state.selected.add(id);
  else state.selected.delete(id);
  updateSelectionUI();
}

function updateActionStates() {
  const chosen = selectedItems();
  const hasSelection = chosen.length > 0;
  const canResume = chosen.some((item) => ['paused', 'error', 'cancelled'].includes(item.status));
  const canPause = chosen.some((item) => ['downloading', 'queued'].includes(item.status));
  const canDeleteCompleted = state.downloads.some((item) => item.status === 'completed');
  document.querySelectorAll('[data-command="resume-selected"]').forEach((button) => { button.disabled = !canResume; });
  document.querySelectorAll('[data-command="pause-selected"]').forEach((button) => { button.disabled = !canPause; });
  document.querySelectorAll('[data-command="delete"]').forEach((button) => { button.disabled = !hasSelection; });
  document.querySelectorAll('[data-command="clear-completed"]').forEach((button) => { button.disabled = !canDeleteCompleted; });
  document.querySelectorAll('[data-command="stop-all"]').forEach((button) => {
    button.disabled = !state.downloads.some((item) => item.status === 'downloading' || item.status === 'queued');
  });
  document.querySelectorAll('[data-command="open"], [data-command="show"], [data-command="copy-url"]').forEach((button) => {
    button.disabled = !hasSelection;
  });
  const contextItem = state.downloads.find((item) => item.id === state.contextId);
  const contextResume = contextMenu.querySelector('[data-context="resume"]');
  const contextPause = contextMenu.querySelector('[data-context="pause"]');
  const contextCancel = contextMenu.querySelector('[data-context="cancel"]');
  const contextOpen = contextMenu.querySelector('[data-context="open"]');
  if (contextResume) contextResume.disabled = !contextItem || !['paused', 'error', 'cancelled'].includes(contextItem.status);
  if (contextPause) contextPause.disabled = !contextItem || !['downloading', 'queued'].includes(contextItem.status);
  if (contextCancel) contextCancel.disabled = !contextItem || !['downloading', 'queued'].includes(contextItem.status);
  if (contextOpen) contextOpen.disabled = !contextItem;
}

function setFilter(filter, category = '') {
  state.filter = filter;
  state.category = category;
  state.selected.clear();
  document.getElementById('tableWrap').scrollTop = 0;
  document.querySelectorAll('.tree-item').forEach((item) => {
    const active = category
      ? item.dataset.category === category
      : item.dataset.filter === filter && !item.dataset.category;
    item.classList.toggle('selected', active);
  });
  const title = category
    ? CATEGORY_LABELS[category]
    : ({ all: 'كل التنزيلات', unfinished: 'التنزيلات غير المكتملة', completed: 'التنزيلات المكتملة' }[filter] || 'كل التنزيلات');
  document.getElementById('tableTitle').textContent = title;
  render();
}

function setState(nextState) {
  state.downloads = nextState.downloads;
  state.settings = nextState.settings;
  document.body.dataset.theme = state.settings.theme || 'light';
  render();
}

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast visible ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3000);
}

function showDialog(id) {
  contextMenu.hidden = true;
  for (const dialog of dialogs) dialog.hidden = dialog.id !== id;
  backdrop.hidden = false;
  if (id === 'addDialog') {
    document.getElementById('dialogFolder').textContent = state.settings.outputFolder;
    document.getElementById('urlError').textContent = '';
    document.getElementById('urlInput').focus();
  }
  if (id === 'optionsDialog') {
    document.getElementById('languageSelect').value = state.settings.language || 'ara';
    document.getElementById('themeSelect').value = state.settings.theme;
    document.getElementById('concurrencySelect').value = String(state.settings.maxActiveDownloads);
    document.getElementById('optionsFolder').textContent = state.settings.outputFolder;
  }
  if (id === 'scheduleDialog') updateScheduleNotice();
}

function closeDialog() {
  backdrop.hidden = true;
  for (const dialog of dialogs) dialog.hidden = true;
}

function showInfo(title, message) {
  document.getElementById('infoTitle').textContent = title;
  document.getElementById('infoMessage').textContent = message;
  showDialog('infoDialog');
}

function showDeleteDialog(ids) {
  state.deleteIds = ids;
  const count = ids.length;
  document.getElementById('deleteTitle').textContent = count > 1 ? 'حذف التنزيلات' : 'حذف التنزيل';
  document.getElementById('deleteMessage').textContent = `هل تريد إزالة ${count > 1 ? `${count} تنزيلات محددة` : 'التنزيل المحدد'} من القائمة؟`;
  document.getElementById('deleteFromDisk').checked = false;
  showDialog('deleteDialog');
}

function currentItem(id = state.progressId) {
  return state.downloads.find((item) => item.id === id);
}

function updateProgressDialog() {
  const item = currentItem();
  if (!item || document.getElementById('progressDialog').hidden) return;
  const amount = percent(item);
  const dialog = document.getElementById('progressDialog');
  document.getElementById('progressTitle').textContent = `${amount}% ${item.fileName}`;
  document.getElementById('progressUrl').textContent = item.url;
  document.getElementById('progressUrl').title = item.url;
  document.getElementById('progressUrl').dataset.url = item.url;
  document.getElementById('progressStatus').textContent = item.error ? `خطأ: ${item.error}` : STATUS_LABELS[item.status] || item.status;
  document.getElementById('progressSize').textContent = formatBytes(item.totalBytes);
  document.getElementById('progressReceived').textContent = `${formatBytes(item.receivedBytes)} (${amount}%)`;
  document.getElementById('progressRate').textContent = formatRate(item.speed);
  document.getElementById('progressEta').textContent = item.status === 'downloading' ? formatEta(item) : '—';
  document.getElementById('progressBar').style.width = `${amount}%`;
  document.getElementById('progressPercent').textContent = `${amount}%`;
  document.getElementById('detailsPath').textContent = item.savePath;
  document.getElementById('detailsPath').title = item.savePath;
  document.getElementById('detailsCategory').textContent = CATEGORY_LABELS[item.category] || CATEGORY_LABELS.other;
  document.getElementById('detailsResume').textContent = item.receivedBytes > 0 ? 'نعم، عند دعم الخادم' : 'غير معروف بعد';
  document.getElementById('connectionLog').textContent = [
    `الرابط: ${item.url}`,
    `الحالة: ${STATUS_LABELS[item.status] || item.status}`,
    item.error ? `الخطأ: ${item.error}` : `البيانات: ${formatBytes(item.receivedBytes)}`
  ].join('\n');
  const pauseButton = document.getElementById('progressPause');
  pauseButton.textContent = ['downloading', 'queued'].includes(item.status) ? 'إيقاف مؤقت' : 'استئناف';
  pauseButton.disabled = item.status === 'completed';
  dialog.dataset.status = item.status;
}

function openProgress(id) {
  state.progressId = id;
  document.getElementById('progressStatusView').hidden = false;
  document.getElementById('progressDetailsView').hidden = true;
  document.querySelectorAll('.progress-tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.progressTab === 'status'));
  showDialog('progressDialog');
  updateProgressDialog();
}

async function addUrls(rawText, { startImmediately = true, fileName = '' } = {}) {
  const urls = rawText.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  if (urls.length === 0) throw new Error('أدخل رابط تنزيل واحدًا على الأقل.');
  const normalized = urls.map((url) => /^www\./i.test(url) ? `https://${url}` : url);
  const badUrl = normalized.find((url) => {
    try { return !['http:', 'https:'].includes(new URL(url).protocol); } catch { return true; }
  });
  if (badUrl) throw new Error(`الرابط غير صالح أو البروتوكول غير مدعوم: ${badUrl}`);
  const added = [];
  for (let index = 0; index < normalized.length; index += 1) {
    added.push(await window.wasel.add({
      url: normalized[index],
      fileName: normalized.length === 1 ? fileName : '',
      startImmediately
    }));
  }
  return added;
}

async function safeCall(action, successMessage) {
  try {
    const result = await action();
    if (successMessage && result !== false) showToast(successMessage);
    return result;
  } catch (error) {
    showToast(error.message || 'تعذر تنفيذ العملية.', 'error');
    return false;
  }
}

async function resumeSelected() {
  const items = selectedItems().filter((item) => ['paused', 'error', 'cancelled'].includes(item.status));
  if (!items.length) return;
  await safeCall(() => Promise.all(items.map((item) => window.wasel.resume(item.id))), 'تم استئناف التنزيلات المحددة.');
}

async function pauseSelected() {
  const items = selectedItems().filter((item) => ['downloading', 'queued'].includes(item.status));
  if (!items.length) return;
  await safeCall(() => Promise.all(items.map((item) => window.wasel.pause(item.id))), 'تم إيقاف التنزيلات المحددة مؤقتًا.');
}

async function deleteSelected(deleteFile = false) {
  const ids = state.deleteIds || [];
  for (const id of ids) {
    const item = state.downloads.find((entry) => entry.id === id);
    if (!item) continue;
    if (item.status === 'downloading' || item.status === 'queued') await window.wasel.pause(id);
    if (deleteFile) await window.wasel.removeWithFile(id);
    else await window.wasel.remove(id);
  }
  state.selected.clear();
  state.deleteIds = [];
  closeDialog();
  showToast('تم حذف العناصر المحددة.');
}

function scheduleStart() {
  clearTimeout(state.scheduleTimer);
  const input = document.getElementById('scheduleTime').value;
  if (!input) {
    showToast('اختر وقت البدء أولًا.', 'error');
    return;
  }
  const [hours, minutes] = input.split(':').map(Number);
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  if (target <= new Date()) target.setDate(target.getDate() + 1);
  state.scheduleTarget = target;
  state.scheduleTimer = setTimeout(async () => {
    state.scheduleTarget = null;
    await safeCall(() => window.wasel.resumeAll(), 'بدأت التنزيلات المجدولة.');
    updateScheduleNotice();
  }, target.getTime() - Date.now());
  updateScheduleNotice();
  closeDialog();
  showToast(`تمت جدولة التنزيلات في ${target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`);
}

function updateScheduleNotice() {
  const notice = document.getElementById('scheduleNotice');
  if (!state.scheduleTarget) {
    notice.textContent = 'لا توجد جدولة نشطة. تعمل الجدولة ما دام التطبيق مفتوحًا.';
    return;
  }
  notice.textContent = `موعد البدء: ${state.scheduleTarget.toLocaleString()}`;
}

async function handleCommand(command, id = null) {
  const targetId = id || state.contextId;
  const item = state.downloads.find((entry) => entry.id === targetId);
  switch (command) {
    case 'add':
      document.getElementById('downloadForm').reset();
      document.getElementById('startImmediately').checked = true;
      showDialog('addDialog');
      break;
    case 'paste': {
      const clipboard = await safeCall(() => window.wasel.readClipboard());
      const url = typeof clipboard === 'string' ? clipboard.split(/\r?\n/).find((line) => /^https?:\/\/|^www\./i.test(line.trim())) : '';
      document.getElementById('downloadForm').reset();
      document.getElementById('urlInput').value = url || '';
      showDialog('addDialog');
      break;
    }
    case 'resume-selected': await resumeSelected(); break;
    case 'pause-selected': await pauseSelected(); break;
    case 'stop-all':
      await safeCall(() => window.wasel.pauseAll(), 'توقفت التنزيلات مؤقتًا مع الاحتفاظ بالأجزاء المنزلة.');
      break;
    case 'delete':
      if (state.selected.size) showDeleteDialog([...state.selected]);
      break;
    case 'clear-completed':
      if (!state.downloads.some((entry) => entry.status === 'completed')) return;
      if (confirm('إزالة جميع التنزيلات المكتملة من القائمة؟ ستبقى الملفات على القرص.')) {
        await safeCall(() => window.wasel.clearCompleted(), 'تمت إزالة التنزيلات المكتملة من القائمة.');
        state.selected.clear();
      }
      break;
    case 'open':
      if (item?.status === 'completed') await safeCall(() => window.wasel.openFile(item.id));
      else if (item) openProgress(item.id);
      break;
    case 'show':
      if (item) await safeCall(() => window.wasel.showFile(item.id));
      break;
    case 'copy-url':
      if (item) await safeCall(() => window.wasel.copyText(item.url), 'تم نسخ الرابط.');
      break;
    case 'copy-path':
      if (item) await safeCall(() => window.wasel.copyText(item.savePath), 'تم نسخ مسار الملف.');
      break;
    case 'resume':
      if (item) await safeCall(() => window.wasel.resume(item.id), 'أُضيف التنزيل إلى قائمة الانتظار.');
      break;
    case 'pause':
    case 'cancel':
      if (item) await safeCall(() => window.wasel.pause(item.id), 'تم إيقاف التنزيل مع الاحتفاظ بالملف الجزئي.');
      break;
    case 'delete-file':
      if (item) showDeleteDialog([item.id]);
      if (item) document.getElementById('deleteFromDisk').checked = true;
      break;
    case 'open-folder':
      await safeCall(() => window.wasel.openFolder());
      break;
    case 'options': showDialog('optionsDialog'); break;
    case 'scheduler': showDialog('scheduleDialog'); break;
    case 'export':
      if (await safeCall(() => window.wasel.exportDownloads())) showToast('تم تصدير قائمة التنزيلات.');
      break;
    case 'import':
      if (await safeCall(() => window.wasel.importDownloads())) showToast('تم استيراد القائمة.');
      break;
    case 'toggle-categories':
      document.getElementById('categoryPanel').classList.toggle('hidden-panel');
      break;
    case 'toggle-status':
      document.getElementById('statusBar').classList.toggle('hidden-status');
      break;
    case 'theme-light':
      await safeCall(() => window.wasel.updateSettings({ theme: 'light' }));
      break;
    case 'theme-dark':
      await safeCall(() => window.wasel.updateSettings({ theme: 'dark' }));
      break;
    case 'refresh': {
      const refreshed = await safeCall(() => window.wasel.getState());
      if (refreshed) {
        state.downloads = refreshed.downloads;
        state.settings = refreshed.settings;
        render();
      }
      break;
    }
    case 'shortcuts':
      showInfo('اختصارات لوحة المفاتيح', 'Ctrl+N: إضافة رابط\nCtrl+Shift+V: إضافة رابط من الحافظة\nCtrl+R: استئناف المحدد\nCtrl+P: إيقاف المحدد مؤقتًا\nCtrl+Shift+S: إيقاف الكل مؤقتًا\nCtrl+F: البحث\nF4: إظهار أو إخفاء التصنيفات\nF5: تحديث القائمة\nDelete: حذف المحدد\nEscape: إغلاق النافذة أو القائمة');
      break;
    case 'help': await safeCall(() => window.wasel.openHelp()); break;
    case 'check-updates':
      await safeCall(() => window.wasel.checkForUpdates(), 'بدأ البحث عن تحديثات واصل.');
      break;
    case 'extension-guide':
      document.getElementById('extensionGuideDialog').dataset.browser = 'chrome';
      document.querySelectorAll('[data-extension-tab]').forEach((tab) => {
        tab.classList.toggle('active', tab.dataset.extensionTab === 'chrome');
      });
      document.querySelectorAll('[data-extension-panel]').forEach((panel) => {
        panel.hidden = panel.dataset.extensionPanel !== 'chrome';
      });
      showDialog('extensionGuideDialog');
      window.wasel.getExtensionPath()
        .then((extensionPath) => {
          document.querySelectorAll('[data-extension-path]').forEach((element) => {
            element.textContent = `${extensionPath}${element.dataset.pathSuffix || ''}`;
          });
        })
        .catch((error) => showToast(error.message || 'تعذر تحديد مجلد الإضافة.', 'error'));
      break;
    case 'about': {
      const version = await window.wasel.getAppVersion();
      showInfo(
        translate('حول واصل'),
        `${translate('عنوان التطبيق')}\n${translate('الإصدار')} ${version}\n${translate('برمجة')}: زروقي أحمد معاذ — Zerouki Ahmed Mouad\n${translate('مفتوح المصدر')}`
      );
      break;
    }
    case 'license':
      showInfo('ترخيص واصل', 'واصل تطبيق مجاني ومفتوح المصدر. لا يحتوي على مفاتيح تسجيل أو قيود ترخيص تجارية.');
      break;
    case 'exit':
      await window.wasel.windowAction('quit');
      break;
    default:
      break;
  }
}

document.querySelectorAll('[data-command]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.menu-entry.open').forEach((entry) => entry.classList.remove('open'));
    handleCommand(button.dataset.command);
  });
});

document.querySelectorAll('.menu-trigger[data-menu]').forEach((button) => {
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const parent = button.closest('.menu-entry');
    const wasOpen = parent.classList.contains('open');
    document.querySelectorAll('.menu-entry.open').forEach((entry) => entry.classList.remove('open'));
    if (!wasOpen) parent.classList.add('open');
  });
});

function updateMaximizeControl(maximized) {
  const button = document.querySelector('[data-window-action="maximize"]');
  if (!button) return;
  button.querySelector('.maximize-icon').hidden = maximized;
  button.querySelector('.restore-icon').hidden = !maximized;
  button.setAttribute('aria-label', translate(maximized ? 'استعادة حجم النافذة' : 'تكبير النافذة'));
  button.title = translate(maximized ? 'استعادة' : 'تكبير');
}

document.querySelectorAll('[data-window-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      const maximized = await window.wasel.windowAction(button.dataset.windowAction);
      if (button.dataset.windowAction === 'maximize' && typeof maximized === 'boolean') {
        updateMaximizeControl(maximized);
      }
    } catch (error) {
      showToast(error.message || 'تعذر تنفيذ إجراء النافذة.', 'error');
    }
  });
});

document.querySelector('.window-titlebar').addEventListener('dblclick', async (event) => {
  if (event.target.closest('.window-controls')) return;
  try {
    const maximized = await window.wasel.windowAction('maximize');
    if (typeof maximized === 'boolean') updateMaximizeControl(maximized);
  } catch (error) {
    showToast(error.message || 'تعذر تغيير حجم النافذة.', 'error');
  }
});

window.wasel.onWindowMaximized(updateMaximizeControl);
window.wasel.isWindowMaximized().then(updateMaximizeControl).catch((error) => {
  showToast(error.message || 'تعذر تحديد حالة النافذة.', 'error');
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu-entry')) {
    document.querySelectorAll('.menu-entry.open').forEach((entry) => entry.classList.remove('open'));
  }
  if (!event.target.closest('.context-menu')) contextMenu.hidden = true;
});

document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', closeDialog));
backdrop.addEventListener('click', (event) => {
  if (event.target === backdrop) closeDialog();
});

document.querySelectorAll('[data-extension-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    const browser = tab.dataset.extensionTab;
    document.getElementById('extensionGuideDialog').dataset.browser = browser;
    document.querySelectorAll('[data-extension-tab]').forEach((entry) => {
      entry.classList.toggle('active', entry === tab);
    });
    document.querySelectorAll('[data-extension-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.extensionPanel !== browser;
    });
  });
});

document.querySelectorAll('[data-copy-build]').forEach((button) => {
  button.addEventListener('click', async () => {
    await safeCall(() => window.wasel.copyText('npm run build:ts'), 'تم نسخ أمر البناء.');
  });
});
document.querySelectorAll('[data-copy-extension-path]').forEach((button) => {
  button.addEventListener('click', async () => {
    const extensionPath = await safeCall(() => window.wasel.getExtensionPath());
    const filePath = button.dataset.copyExtensionPath === 'manifest'
      ? `${extensionPath}\\manifest.json`
      : extensionPath;
    if (extensionPath) await safeCall(() => window.wasel.copyText(filePath), 'تم نسخ مسار الإضافة.');
  });
});

document.getElementById('downloadForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('urlError');
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  error.textContent = '';
  try {
    const added = await addUrls(document.getElementById('urlInput').value, {
      startImmediately: document.getElementById('startImmediately').checked,
      fileName: document.getElementById('fileNameInput').value
    });
    closeDialog();
    setFilter('all');
    state.selected = new Set(added.map((item) => item.id));
    render();
    showToast(`أُضيف ${added.length} تنزيل إلى القائمة.`);
  } catch (reason) {
    error.textContent = reason.message || 'تعذر إضافة الرابط.';
  } finally {
    button.disabled = false;
  }
});

document.getElementById('downloadLater').addEventListener('click', async () => {
  document.getElementById('startImmediately').checked = false;
  document.getElementById('downloadForm').requestSubmit();
});
async function chooseDownloadFolder() {
  const settings = await safeCall(() => window.wasel.chooseFolder());
  if (!settings) return;
  document.getElementById('dialogFolder').textContent = settings.outputFolder;
  document.getElementById('optionsFolder').textContent = settings.outputFolder;
}

document.getElementById('browseFolder').addEventListener('click', chooseDownloadFolder);
document.getElementById('optionsBrowse').addEventListener('click', chooseDownloadFolder);
document.getElementById('saveOptions').addEventListener('click', async () => {
  const previousLanguage = state.settings.language || 'ara';
  const result = await safeCall(() => window.wasel.updateSettings({
    theme: document.getElementById('themeSelect').value,
    language: document.getElementById('languageSelect').value,
    maxActiveDownloads: Number(document.getElementById('concurrencySelect').value)
  }), 'تم حفظ الإعدادات.');
  if (result !== false) {
    try {
      const selectedLanguage = document.getElementById('languageSelect').value;
      if (selectedLanguage !== previousLanguage) await loadLocale(selectedLanguage);
      closeDialog();
    } catch (error) {
      showToast(error.message || 'تعذر تحميل ملف اللغة.', 'error');
    }
  }
});

document.getElementById('saveSchedule').addEventListener('click', scheduleStart);
document.getElementById('cancelSchedule').addEventListener('click', () => {
  clearTimeout(state.scheduleTimer);
  state.scheduleTimer = null;
  state.scheduleTarget = null;
  updateScheduleNotice();
  showToast('تم إلغاء الجدولة.');
});

document.getElementById('confirmDelete').addEventListener('click', () => deleteSelected(document.getElementById('deleteFromDisk').checked)
  .catch((error) => showToast(error.message || 'تعذر حذف العناصر.', 'error')));

document.querySelectorAll('.tree-item').forEach((button) => {
  button.addEventListener('click', () => {
    if (button.dataset.category) setFilter('all', button.dataset.category);
    else setFilter(button.dataset.filter);
  });
});
document.getElementById('hideCategories').addEventListener('click', () => document.getElementById('categoryPanel').classList.add('hidden-panel'));

document.getElementById('searchInput').addEventListener('input', (event) => {
  state.query = event.target.value.trim();
  render();
});
document.getElementById('selectAll').addEventListener('change', (event) => {
  for (const item of filterItems()) {
    if (event.target.checked) state.selected.add(item.id);
    else state.selected.delete(item.id);
  }
  updateSelectionUI();
});

rowsElement.addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-select-row]');
  if (!checkbox) return;
  setSelection(checkbox.dataset.selectRow, checkbox.checked);
});

rowsElement.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (!row || event.target.closest('input')) return;
  const visibleItems = filterItems();
  if (event.ctrlKey || event.metaKey) {
    setSelection(row.dataset.id, !state.selected.has(row.dataset.id));
  } else if (event.shiftKey && state.lastSelectedId) {
    const start = visibleItems.findIndex((item) => item.id === state.lastSelectedId);
    const end = visibleItems.findIndex((item) => item.id === row.dataset.id);
    if (start >= 0 && end >= 0) {
      state.selected.clear();
      for (const item of visibleItems.slice(Math.min(start, end), Math.max(start, end) + 1)) state.selected.add(item.id);
      updateSelectionUI();
    }
    state.lastSelectedId = row.dataset.id;
  } else {
    state.selected.clear();
    state.selected.add(row.dataset.id);
    state.lastSelectedId = row.dataset.id;
    updateSelectionUI();
  }
});

rowsElement.addEventListener('dblclick', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (row) handleCommand('open', row.dataset.id);
});

rowsElement.addEventListener('contextmenu', (event) => {
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  event.preventDefault();
  state.contextId = row.dataset.id;
  if (!state.selected.has(state.contextId)) {
    state.selected.clear();
    state.selected.add(state.contextId);
    render();
  }
  contextMenu.style.left = `${Math.min(event.clientX, window.innerWidth - 220)}px`;
  contextMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 260)}px`;
  contextMenu.hidden = false;
});

contextMenu.addEventListener('click', (event) => {
  const button = event.target.closest('[data-context]');
  if (!button) return;
  contextMenu.hidden = true;
  const actions = {
    open: 'open', show: 'show', resume: 'resume', pause: 'pause', cancel: 'cancel',
    'copy-url': 'copy-url', 'copy-path': 'copy-path', delete: 'delete', 'delete-file': 'delete-file'
  };
  handleCommand(actions[button.dataset.context], state.contextId);
});

document.querySelectorAll('.download-table th[data-sort]').forEach((header) => {
  header.addEventListener('click', () => {
    if (state.sort === header.dataset.sort) state.sortDirection *= -1;
    else {
      state.sort = header.dataset.sort;
      state.sortDirection = 1;
    }
    document.querySelectorAll('.sort-indicator').forEach((indicator) => { indicator.textContent = '↕'; });
    header.querySelector('.sort-indicator').textContent = state.sortDirection === 1 ? '↑' : '↓';
    render();
  });
});
document.getElementById('tableWrap').addEventListener('scroll', renderTableRows, { passive: true });
window.addEventListener('resize', renderTableRows);

document.querySelectorAll('.progress-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    const showDetails = tab.dataset.progressTab === 'details';
    document.getElementById('progressStatusView').hidden = showDetails;
    document.getElementById('progressDetailsView').hidden = !showDetails;
    document.querySelectorAll('.progress-tab').forEach((entry) => entry.classList.toggle('active', entry === tab));
  });
});
document.getElementById('progressUrl').addEventListener('click', async (event) => {
  event.preventDefault();
  await safeCall(() => window.wasel.openExternal(event.currentTarget.dataset.url));
});
document.getElementById('progressUrl').addEventListener('contextmenu', async (event) => {
  event.preventDefault();
  await safeCall(() => window.wasel.copyText(event.currentTarget.dataset.url), 'تم نسخ رابط التنزيل.');
});
document.querySelectorAll('[data-progress-action]').forEach((button) => {
  button.addEventListener('click', async () => {
    const item = currentItem();
    if (!item) return;
    if (button.dataset.progressAction === 'pause') {
      if (['downloading', 'queued'].includes(item.status)) await safeCall(() => window.wasel.pause(item.id), 'تم إيقاف التنزيل مؤقتًا.');
      else await safeCall(() => window.wasel.resume(item.id), 'أُضيف التنزيل إلى قائمة الانتظار.');
    } else {
      await safeCall(() => window.wasel.pause(item.id), 'تم إيقاف التنزيل مع الاحتفاظ بالجزء.');
      closeDialog();
    }
  });
});

document.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (event.key === 'Escape') {
    if (!contextMenu.hidden) contextMenu.hidden = true;
    else if (!backdrop.hidden) closeDialog();
    else document.querySelectorAll('.menu-entry.open').forEach((entry) => entry.classList.remove('open'));
    return;
  }
  if ((event.ctrlKey || event.metaKey) && key === 'n') {
    event.preventDefault();
    handleCommand('add');
  } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'v') {
    event.preventDefault();
    handleCommand('paste');
  } else if ((event.ctrlKey || event.metaKey) && key === 'f') {
    event.preventDefault();
    document.getElementById('searchInput').focus();
  } else if ((event.ctrlKey || event.metaKey) && key === 'r') {
    event.preventDefault();
    resumeSelected();
  } else if ((event.ctrlKey || event.metaKey) && key === 'p') {
    event.preventDefault();
    pauseSelected();
  } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 's') {
    event.preventDefault();
    handleCommand('stop-all');
  } else if (key === 'delete' && state.selected.size && backdrop.hidden) {
    showDeleteDialog([...state.selected]);
  } else if (key === 'f4') {
    document.getElementById('categoryPanel').classList.toggle('hidden-panel');
  } else if (key === 'f5') {
    window.wasel.getState().then(setState).catch((error) => showToast(error.message, 'error'));
  }
});

document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', async (event) => {
  event.preventDefault();
  const values = [...new Set([
    event.dataTransfer.getData('text/uri-list'),
    event.dataTransfer.getData('text/plain')
  ].filter(Boolean).join('\n').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(https?:\/\/|www\.)/i.test(line)))];
  if (values.length) {
    const added = await safeCall(() => addUrls(values.join('\n'), { startImmediately: true }));
    if (added) showToast(`${translate('تمت إضافة الروابط المسحوبة')} (${added.length}) ${translate('وبدأت التنزيلات فورًا')}.`);
  }
});

let renderTimer;
window.wasel.onChange((nextState) => {
  setState(nextState);
});
Promise.all([window.wasel.getState(), populateLanguageOptions()])
  .then(async ([nextState]) => {
    setState(nextState);
    await loadLocale(nextState.settings.language || 'ara');
  })
  .catch((error) => showToast(error.message || 'تعذر تهيئة التطبيق أو ملفات اللغات.', 'error'));
