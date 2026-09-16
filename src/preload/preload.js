const { contextBridge, ipcRenderer } = require('electron');

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('profileDesk', Object.freeze({
  getBootstrap: () => invoke('app:get-bootstrap'),
  unlock: (password) => invoke('app:unlock', password),
  updateAppSettings: (input) => invoke('app:update-settings', input),
  selectDataDirectory: () => invoke('app:select-data-directory'),
  openLogDirectory: () => invoke('app:open-log-directory'),
  wipeAllData: (input) => invoke('app:wipe-all-data', input),
  getState: () => invoke('workspace:get-state'),
  addSite: (input) => invoke('workspace:add-site', input),
  updateSite: (id, patch) => invoke('workspace:update-site', id, patch),
  deleteSite: (id) => invoke('workspace:delete-site', id),
  addAccount: (input) => invoke('workspace:add-account', input),
  importBatch: (rows) => invoke('workspace:import-batch', rows),
  updateAccount: (id, patch) => invoke('workspace:update-account', id, patch),
  deleteAccounts: (ids) => invoke('workspace:delete-accounts', ids),
  start: (id, options) => invoke('browser:start', id, options),
  stop: (id) => invoke('browser:stop', id),
  activate: (id) => invoke('browser:activate', id),
  navigate: (id, url) => invoke('browser:navigate', id, url),
  command: (id, command) => invoke('browser:command', id, command),
  applyEnvironment: (id) => invoke('browser:apply-environment', id),
  setMuted: (id, muted) => invoke('browser:set-muted', id, muted),
  setBounds: (bounds) => invoke('browser:set-bounds', bounds),
  setProxy: (id, proxy) => invoke('browser:set-proxy', id, proxy),
  clear: (id, mode) => invoke('browser:clear', id, mode),
  runDiagnostics: (id) => invoke('diagnostics:run', id),
  createSnapshot: (id, label) => invoke('snapshot:create', id, label),
  restoreSnapshot: (id) => invoke('snapshot:restore', id),
  bulkRun: (ids, action) => invoke('bulk:run', ids, action),
  exportPackage: (ids, password) => invoke('package:export', { ids, password }),
  importPackage: (password) => invoke('package:import', password),
  onState: (callback) => subscribe('workspace:changed', callback),
  onBrowserEvent: (callback) => subscribe('browser:event', callback),
  onAppShortcut: (callback) => subscribe('app:shortcut', callback),
}));
