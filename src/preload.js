const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wasel', {
  listLanguages: () => ipcRenderer.invoke('languages:list'),
  getLanguage: (code) => ipcRenderer.invoke('languages:get', code),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  isWindowMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  onWindowMaximized: (callback) => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on('window:maximized', listener);
    return () => ipcRenderer.removeListener('window:maximized', listener);
  },
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  getUpdateStatus: () => ipcRenderer.invoke('updates:get-status'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  },
  getState: () => ipcRenderer.invoke('downloads:get-state'),
  add: (input) => ipcRenderer.invoke('downloads:add', input),
  pause: (id) => ipcRenderer.invoke('downloads:pause', id),
  resume: (id) => ipcRenderer.invoke('downloads:resume', id),
  cancel: (id) => ipcRenderer.invoke('downloads:cancel', id),
  remove: (id) => ipcRenderer.invoke('downloads:remove', id),
  removeWithFile: (id) => ipcRenderer.invoke('downloads:remove-with-file', id),
  clearCompleted: () => ipcRenderer.invoke('downloads:clear-completed'),
  pauseAll: () => ipcRenderer.invoke('downloads:pause-all'),
  resumeAll: () => ipcRenderer.invoke('downloads:resume-all'),
  stopAll: () => ipcRenderer.invoke('downloads:stop-all'),
  updateSettings: (settings) => ipcRenderer.invoke('downloads:update-settings', settings),
  chooseFolder: () => ipcRenderer.invoke('downloads:choose-folder'),
  openFile: (id) => ipcRenderer.invoke('downloads:open-file', id),
  showFile: (id) => ipcRenderer.invoke('downloads:show-file', id),
  openFolder: () => ipcRenderer.invoke('downloads:open-folder'),
  openExternal: (url) => ipcRenderer.invoke('downloads:open-external', url),
  copyText: (text) => ipcRenderer.invoke('downloads:copy-text', text),
  readClipboard: () => ipcRenderer.invoke('downloads:read-clipboard'),
  exportDownloads: () => ipcRenderer.invoke('downloads:export'),
  importDownloads: () => ipcRenderer.invoke('downloads:import'),
  openHelp: () => ipcRenderer.invoke('help:open'),
  openExtensionGuide: () => ipcRenderer.invoke('help:extension-guide'),
  getExtensionPath: () => ipcRenderer.invoke('app:get-extension-path'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  onChange: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('downloads:changed', listener);
    return () => ipcRenderer.removeListener('downloads:changed', listener);
  }
});
