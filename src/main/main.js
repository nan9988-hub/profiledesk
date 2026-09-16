const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  safeStorage,
  shell,
} = require('electron');
const { WorkspaceStore } = require('./store');
const { SecretVault } = require('./vault');
const { ProfileManager } = require('./profile-manager');
const { SnapshotService } = require('./snapshot-service');
const { decryptPackage, encryptPackage } = require('./crypto-package');
const { runDiagnostics } = require('./diagnostics');
const { SettingsService } = require('./settings-service');
const { AuditLogger } = require('./audit-logger');
const { DataDirectoryService } = require('./data-directory-service');
const { normalizeStorageMode } = require('../shared/model');

app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');

let safeMode = process.argv.includes('--safe-mode');
let startupComplete = false;
let fatalDialogShown = false;

function startupLog(phase, error = null) {
  try {
    const directory = app.getPath('userData');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'startup.log');
    const stat = fs.existsSync(file) ? fs.statSync(file) : null;
    if (stat?.size > 1024 * 1024) {
      fs.rmSync(`${file}.previous`, { force: true });
      fs.renameSync(file, `${file}.previous`);
    }
    const detail = error
      ? String(error?.stack || error?.message || error).replace(/[\r\n]+/g, ' | ').slice(0, 8000)
      : '';
    fs.appendFileSync(file, `${new Date().toISOString()} ${phase}${detail ? ` ${detail}` : ''}\n`, 'utf8');
    return file;
  } catch {
    return '';
  }
}

function startupMarkerFile() {
  return path.join(app.getPath('userData'), 'startup-in-progress');
}

function showFatalError(error) {
  const logFile = startupLog('FATAL', error);
  console.error('ProfileDesk fatal error:', error);
  if (fatalDialogShown) return;
  fatalDialogShown = true;
  const message = [
    String(error?.message || error || '未知启动错误'),
    logFile ? `\n错误日志：${logFile}` : '',
    '\n可在命令行添加 --safe-mode 启动，跳过账户恢复和设备模拟。',
  ].join('');
  try { dialog.showErrorBox('ProfileDesk 启动失败', message); } catch {}
}

let mainWindow;
let store;
let vault;
let profiles;
let snapshots;
let settings;
let audit;
let dataDirectories;
let rootDir;
let isUnlocked = true;
let shuttingDown = false;
let restoreSave = Promise.resolve();
let restoreSessionsStarted = false;
let unlockFailures = 0;
let unlockBlockedUntil = 0;

function publicAppSettings() {
  return {
    ...settings.publicSettings(),
    dataDirectory: rootDir,
    logDirectory: audit?.directory || path.join(rootDir, 'logs'),
  };
}

function logAction(action, details = {}) {
  return audit?.log(action, details).catch((error) => console.error('Audit log error:', error.message));
}

function relaunchSoon() {
  shuttingDown = true;
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 350);
}

async function scheduleAccountDeletions(accounts) {
  const selected = accounts.map((account) => account.id);
  const pendingPaths = [];
  for (const account of accounts) {
    const result = await profiles.prepareAccountDeletion(account.id);
    pendingPaths.push(...result.pendingPaths);
  }
  const snapshotCount = await snapshots.removeForAccounts(selected);
  await vault.removeMany(accounts.flatMap((account) => [account.proxy?.secretRef, account.autoLogin?.secretRef]));
  await store.markAccountsPendingDeletion(selected);
  if (pendingPaths.length) await dataDirectories.scheduleAccountDataRemoval(rootDir, pendingPaths);
  await logAction('accounts.deletion_scheduled', {
    count: accounts.length,
    accountIds: accounts.map((account) => account.id),
    accountNames: accounts.map((account) => account.name),
    snapshotCount,
    restartCleanupPaths: pendingPaths.length,
  });
  return { count: accounts.length, pendingPaths: pendingPaths.length };
}

async function deleteAccounts(ids) {
  const selected = [...new Set(Array.isArray(ids) ? ids.map(String) : [])].slice(0, 500);
  const accounts = selected.map((id) => store.findAccount(id)).filter((account) => account && !account.pendingDeletion);
  if (!accounts.length) throw new Error('没有可删除的账户');
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '删除隔离账户',
    message: `确定删除 ${accounts.length} 个账户？`,
    detail: '将立即停止账户、清除浏览数据并将账户置为不可打开；Profile和下载目录会在下次启动、其他账户恢复前删除。当前其他已登录窗口不会重启。此操作不可撤销。',
    buttons: ['删除账户', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response !== 0) return { canceled: true, count: 0 };
  await scheduleAccountDeletions(accounts);
  send('workspace:changed', store.publicState());
  return { canceled: false, count: accounts.length, scheduled: true };
}

async function deleteSite(id) {
  const site = store.findSite(String(id));
  if (!site || site.pendingDeletion) throw new Error('业务站不存在或已等待删除');
  const siteAccounts = store.data.accounts.filter((account) => account.siteId === site.id);
  const accounts = siteAccounts.filter((account) => !account.pendingDeletion);
  const answer = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    title: '删除业务站',
    message: `确定删除业务站“${site.name}”？`,
    detail: siteAccounts.length
      ? `该业务站包含 ${siteAccounts.length} 个账户。账户会立即停止、清除浏览数据并置灰，下次启动时连同业务站一起删除。其他已登录窗口不会重启。`
      : '该业务站将在下次启动时移除。此操作不可撤销。',
    buttons: ['删除业务站', '取消'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response !== 0) return { canceled: true, count: 0 };
  if (accounts.length) await scheduleAccountDeletions(accounts);
  await store.markSitesPendingDeletion([site.id]);
  await logAction('site.deletion_scheduled', { siteId: site.id, name: site.name, accountCount: accounts.length });
  send('workspace:changed', store.publicState());
  return { canceled: false, count: accounts.length, scheduled: true };
}

async function finalizePendingAccountDeletions() {
  const accounts = store.data.accounts.filter((account) => account.pendingDeletion);
  const sites = store.data.sites.filter((site) => site.pendingDeletion);
  if (accounts.length) {
    const paths = accounts.flatMap((account) => [
      path.join(rootDir, 'profiles', account.id),
      path.join(rootDir, 'downloads', account.id),
    ]);
    const cleanup = await dataDirectories.removeAccountDataNow(rootDir, paths);
    await snapshots.removeForAccounts(accounts.map((account) => account.id));
    await vault.removeMany(accounts.flatMap((account) => [account.proxy?.secretRef, account.autoLogin?.secretRef]));
    await store.removeAccounts(accounts.map((account) => account.id));
    await logAction('accounts.deletion_completed', {
      count: accounts.length,
      accountIds: accounts.map((account) => account.id),
      remainingPaths: cleanup.pendingPaths.length,
    });
  }
  if (sites.length) {
    await store.removeSites(sites.map((site) => site.id));
    await logAction('sites.deletion_completed', { count: sites.length, siteIds: sites.map((site) => site.id) });
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function assertObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求参数无效');
  return value;
}

function ensureUnlocked() {
  if (!isUnlocked) throw new Error('应用已锁定，请先输入启动密码');
}

function cycleRunningAccount(offset) {
  if (!isUnlocked || !profiles) return;
  const ids = store.data.accounts
    .filter((account) => !account.pendingDeletion && profiles.isRunning(account.id))
    .map((account) => account.id);
  if (!ids.length) return;
  const currentIndex = ids.indexOf(profiles.activeId);
  const nextIndex = currentIndex === -1
    ? (offset > 0 ? 0 : ids.length - 1)
    : (currentIndex + offset + ids.length) % ids.length;
  const nextId = ids[nextIndex];
  profiles.activate(nextId);
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

function registerGlobalShortcuts() {
  globalShortcut.unregisterAll();
  const unavailable = [];
  const shortcuts = settings.publicSettings().shortcuts;
  const actions = {
    showHide: () => {
      if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    },
    nextAccount: () => cycleRunningAccount(1),
    previousAccount: () => cycleRunningAccount(-1),
    toggleSidebar: () => send('app:shortcut', { action: 'toggle-sidebar' }),
  };
  for (const [name, accelerator] of Object.entries(shortcuts)) {
    try {
      if (!globalShortcut.register(accelerator, actions[name])) unavailable.push({ name, accelerator });
    } catch {
      unavailable.push({ name, accelerator });
    }
  }
  return unavailable;
}

async function restorePreviousSessions() {
  if (!isUnlocked || restoreSessionsStarted) return;
  restoreSessionsStarted = true;
  send('workspace:changed', store.publicState());
  const restoreIds = store.data.restoreIds
    .filter((id) => {
      const account = store.findAccount(id);
      return account && !account.pendingDeletion && account.storageMode !== 'incognito';
    })
    .slice(0, settings.publicSettings().maxRunningAccounts);
  let restoreCursor = 0;
  const restoreWorker = async () => {
    while (restoreCursor < restoreIds.length) {
      const id = restoreIds[restoreCursor++];
      await profiles.start(id, { activate: false }).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, restoreIds.length) }, restoreWorker));
  if (restoreIds[0] && profiles.isRunning(restoreIds[0])) profiles.activate(restoreIds[0]);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    resizable: true,
    title: 'ProfileDesk',
    backgroundColor: '#08101d',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('close', (event) => {
    if (!shuttingDown && profiles) {
      event.preventDefault();
      shuttingDown = true;
      const restoreIds = isUnlocked ? [...profiles.instances.keys()] : store.data.restoreIds;
      restoreSave.catch(() => {})
        .then(() => store.setRestoreIds(restoreIds))
        .then(() => profiles.shutdown())
        .finally(() => mainWindow.close());
    }
  });
  return mainWindow;
}

function registerIpc() {
  const handleUnlocked = (channel, handler) => ipcMain.handle(channel, (event, ...args) => {
    ensureUnlocked();
    return handler(event, ...args);
  });

  ipcMain.handle('app:get-bootstrap', () => ({
    locked: !isUnlocked,
    safeMode,
    settings: publicAppSettings(),
  }));
  ipcMain.handle('app:unlock', async (_event, password) => {
    if (isUnlocked) return { state: store.publicState(), settings: publicAppSettings() };
    const now = Date.now();
    if (now < unlockBlockedUntil) {
      throw new Error(`密码错误次数过多，请在${Math.ceil((unlockBlockedUntil - now) / 1000)}秒后重试`);
    }
    if (!settings.verifyPassword(password)) {
      unlockFailures += 1;
      if (unlockFailures >= 5) {
        unlockBlockedUntil = Date.now() + 30000;
        unlockFailures = 0;
      }
      throw new Error('启动密码不正确');
    }
    unlockFailures = 0;
    unlockBlockedUntil = 0;
    isUnlocked = true;
    await logAction('app.unlocked');
    restorePreviousSessions().catch(() => {});
    return { state: store.publicState(), settings: publicAppSettings() };
  });
  handleUnlocked('app:update-settings', async (_event, input) => {
    const safeInput = assertObject(input);
    const result = await settings.update(safeInput);
    await profiles.updateResourceLimits(result);
    const unavailableShortcuts = registerGlobalShortcuts();
    let relaunching = false;
    if (safeInput.dataBaseDirectory) {
      const targetRoot = dataDirectories.targetForBase(safeInput.dataBaseDirectory);
      const answer = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: '迁移数据目录',
        message: '迁移全部本地数据并重启 ProfileDesk？',
        detail: `目标目录：${targetRoot}\n迁移期间请勿关闭软件。完成后旧目录会被尽力覆盖并删除。`,
        buttons: ['迁移并重启', '取消迁移'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (answer.response === 0) {
        const migration = await dataDirectories.scheduleMigration(rootDir, safeInput.dataBaseDirectory);
        relaunching = migration.changed;
        if (relaunching) {
          await logAction('data.migration_scheduled', { from: rootDir, to: targetRoot });
          await profiles.shutdown();
        }
      }
    }
    await logAction('settings.updated', {
      launchPasswordEnabled: result.launchPasswordEnabled,
      maxRunningAccounts: result.maxRunningAccounts,
      idleStopMinutes: result.idleStopMinutes,
      memoryLimitMb: result.memoryLimitMb,
      relaunching,
    });
    if (relaunching) relaunchSoon();
    return { settings: publicAppSettings(), unavailableShortcuts, relaunching };
  });
  handleUnlocked('app:select-data-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 ProfileDesk 数据存放位置',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return {
      canceled: false,
      baseDirectory: result.filePaths[0],
      dataDirectory: dataDirectories.targetForBase(result.filePaths[0]),
    };
  });
  handleUnlocked('app:open-log-directory', async () => {
    await fs.promises.mkdir(audit.directory, { recursive: true });
    const error = await shell.openPath(audit.directory);
    if (error) throw new Error(error);
    return true;
  });
  handleUnlocked('app:wipe-all-data', async (_event, input) => {
    const safeInput = assertObject(input);
    if (!settings.isLockedOnLaunch()) throw new Error('必须先设置并保存启动密码');
    if (!settings.verifyPassword(safeInput.password)) throw new Error('启动密码不正确');
    if (safeInput.confirmation !== '永久删除全部数据') throw new Error('确认文字不正确');
    const answer = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '永久删除全部数据',
      message: '最后确认：删除 ProfileDesk 的全部本地数据？',
      detail: '所有账户、登录状态、缓存、快照、下载记录、已保存密码、设置和本地日志都将删除。软件随后重启为空白状态。',
      buttons: ['永久删除并重启', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (answer.response !== 0) return { canceled: true };
    await dataDirectories.scheduleWipe(rootDir);
    await logAction('data.wipe_scheduled', { rootDir });
    await profiles.shutdown();
    relaunchSoon();
    return { canceled: false, scheduled: true };
  });

  handleUnlocked('workspace:get-state', () => store.publicState());
  handleUnlocked('workspace:add-site', async (_event, input) => {
    const result = await store.addSite(assertObject(input));
    await logAction('site.added', { siteId: result.id, name: result.name });
    send('workspace:changed', store.publicState());
    return result;
  });
  handleUnlocked('workspace:update-site', async (_event, id, patch) => {
    const result = await store.updateSite(String(id), assertObject(patch));
    await logAction('site.updated', { siteId: result.id, fields: Object.keys(patch) });
    send('workspace:changed', store.publicState());
    return result;
  });
  handleUnlocked('workspace:delete-site', (_event, id) => deleteSite(id));
  handleUnlocked('workspace:add-account', async (_event, input) => {
    const result = await store.addAccount(assertObject(input));
    await logAction('account.added', { accountId: result.id, name: result.name, siteId: result.siteId });
    send('workspace:changed', store.publicState());
    return result;
  });
  handleUnlocked('workspace:import-batch', async (_event, rows) => {
    const result = await store.importBatch(rows);
    await logAction('workspace.batch_imported', { sitesAdded: result.sitesAdded, accountsAdded: result.accountsAdded });
    send('workspace:changed', store.publicState());
    return result;
  });
  handleUnlocked('workspace:update-account', async (_event, id, patch) => {
    const account = store.findAccount(id);
    if (!account) throw new Error('账户不存在');
    const safePatch = assertObject(patch);
    const previousStorageMode = account.storageMode === 'incognito' ? 'incognito' : 'persistent';
    let storageCleanup = { pendingPaths: [] };
    if (Object.hasOwn(safePatch, 'storageMode')) {
      safePatch.storageMode = normalizeStorageMode(safePatch.storageMode);
      storageCleanup = await profiles.prepareStorageModeChange(id, safePatch.storageMode);
      if (safePatch.storageMode === 'incognito') {
        safePatch.currentUrl = safePatch.startUrl || account.startUrl;
        safePatch.lastError = '';
      }
    }
    if (safePatch.password !== undefined) {
      const previousRef = account.autoLogin?.secretRef;
      safePatch.autoLogin = { ...(account.autoLogin || {}), ...(safePatch.autoLogin || {}) };
      safePatch.autoLogin.secretRef = safePatch.password
        ? await vault.set(safePatch.password, previousRef)
        : '';
      if (!safePatch.password && previousRef) await vault.remove(previousRef);
      delete safePatch.password;
    }
    if (safePatch.proxyPassword !== undefined) {
      const previousRef = account.proxy?.secretRef;
      safePatch.proxy = { ...(account.proxy || {}), ...(safePatch.proxy || {}) };
      safePatch.proxy.secretRef = safePatch.proxyPassword
        ? await vault.set(safePatch.proxyPassword, previousRef)
        : '';
      if (!safePatch.proxyPassword && previousRef) await vault.remove(previousRef);
      delete safePatch.proxyPassword;
    }
    const result = await store.updateAccount(id, safePatch);
    if (previousStorageMode !== result.storageMode && result.storageMode === 'incognito') {
      await snapshots.removeForAccounts([id]);
      await store.removeSnapshotsForAccounts([id]);
    }
    if (storageCleanup.pendingPaths.length) {
      await dataDirectories.scheduleAccountDataRemoval(rootDir, storageCleanup.pendingPaths);
    }
    await logAction('account.updated', { accountId: id, fields: Object.keys(safePatch).filter((key) => !key.toLowerCase().includes('password')) });
    send('workspace:changed', store.publicState());
    return { ...result, cleanupPending: storageCleanup.pendingPaths.length > 0 };
  });
  handleUnlocked('workspace:delete-accounts', (_event, ids) => deleteAccounts(ids));

  handleUnlocked('browser:start', (_event, id, options) => profiles.start(id, options));
  handleUnlocked('browser:stop', (_event, id) => profiles.stop(id));
  handleUnlocked('browser:activate', (_event, id) => profiles.activate(id));
  handleUnlocked('browser:navigate', (_event, id, url) => profiles.navigate(id, url));
  handleUnlocked('browser:command', (_event, id, command) => profiles.command(id, command));
  handleUnlocked('browser:apply-environment', async (_event, id) => {
    const result = profiles.applyEnvironment(id, { reload: true });
    await logAction('account.environment_applied', { accountId: id, device: result.device });
    return result;
  });
  handleUnlocked('browser:set-muted', async (_event, id, muted) => {
    const result = await profiles.setMuted(String(id), Boolean(muted));
    await logAction('account.audio_changed', { accountId: id, muted: result.muted });
    send('workspace:changed', store.publicState());
    return result;
  });
  handleUnlocked('browser:set-bounds', (_event, bounds) => profiles.setBounds(assertObject(bounds)));
  handleUnlocked('browser:set-proxy', async (_event, id, proxy) => {
    const result = await profiles.applyProxy(id, proxy);
    await logAction('account.proxy_changed', { accountId: id, mode: result.mode });
    send('workspace:changed', store.publicState());
    return result;
  });
  handleUnlocked('browser:clear', async (_event, id, mode) => {
    const raw = profiles.currentUrl(id) || store.findAccount(id)?.startUrl;
    const origin = raw ? new URL(raw).origin : '';
    const result = await profiles.clear(id, mode, origin);
    await logAction('account.browser_data_cleared', { accountId: id, mode });
    return result;
  });

  handleUnlocked('diagnostics:run', async (_event, id) => {
    const account = store.findAccount(id);
    if (!account) throw new Error('账户不存在');
    const ses = profiles.getSession(id);
    await profiles.applyProxy(id, account.proxy);
    return runDiagnostics(profiles.currentUrl(id) || account.startUrl, ses);
  });

  handleUnlocked('snapshot:create', async (_event, id, label) => {
    const account = store.findAccount(id);
    if (!account) throw new Error('账户不存在');
    if (account.storageMode === 'incognito') throw new Error('无痕账户不能保存状态快照');
    const result = await snapshots.create(account, profiles.getSession(id), label);
    await logAction('snapshot.created', { accountId: id, snapshotId: result.id, label: result.label });
    send('workspace:changed', store.publicState());
    return result;
  });
  handleUnlocked('snapshot:restore', async (_event, snapshotId) => {
    const metadata = store.data.snapshots.find((item) => item.id === snapshotId);
    if (!metadata) throw new Error('快照不存在');
    const account = store.findAccount(metadata.accountId);
    if (!account) throw new Error('账户不存在');
    if (account.storageMode === 'incognito') throw new Error('无痕账户不能还原状态快照');
    if (profiles.isRunning(account.id)) await profiles.stop(account.id);
    const payload = await snapshots.restore(metadata, account, profiles.getSession(account.id));
    await store.updateAccount(account.id, {
      currentUrl: payload.account.currentUrl,
      proxy: payload.account.proxy,
      environment: payload.account.environment,
    });
    await logAction('snapshot.restored', { accountId: account.id, snapshotId });
    send('workspace:changed', store.publicState());
    return true;
  });

  handleUnlocked('bulk:run', async (_event, ids, action) => {
    if (!Array.isArray(ids) || ids.length > 500) throw new Error('批量账户数量无效');
    const queue = [...new Set(ids)];
    const results = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const id = queue[cursor++];
        try {
          if (action === 'start') await profiles.start(id, { activate: false });
          else if (action === 'stop') await profiles.stop(id);
          else if (action === 'reload') profiles.command(id, 'reload');
          else if (action === 'clear-cache') await profiles.clear(id, 'cache');
          else if (action === 'snapshot') {
            const account = store.findAccount(id);
            if (account?.storageMode === 'incognito') throw new Error('无痕账户不能保存状态快照');
            await snapshots.create(account, profiles.getSession(id));
          } else throw new Error('不支持的批量操作');
          results.push({ id, ok: true });
        } catch (error) {
          results.push({ id, ok: false, error: error.message });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
    await logAction('accounts.bulk_action', {
      action,
      requested: queue.length,
      succeeded: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
    });
    send('workspace:changed', store.publicState());
    return results;
  });

  handleUnlocked('package:export', async (_event, { ids, password }) => {
    if (!Array.isArray(ids) || !password || password.length < 8) {
      throw new Error('请选择账户，并使用至少8位导出密码');
    }
    const selected = store.data.accounts.filter((account) => ids.includes(account.id));
    if (!selected.length) throw new Error('没有选择要导出的账户');
    const sites = store.data.sites.filter((site) => selected.some((account) => account.siteId === site.id));
    const accounts = [];
    for (const account of selected) {
      const portableAccount = structuredClone(account);
      portableAccount.proxy.secretRef = '';
      portableAccount.autoLogin.secretRef = '';
      let cookies = [];
      if (account.storageMode !== 'incognito') {
        const ses = profiles.getSession(account.id);
        await ses.flushStorageData();
        cookies = await ses.cookies.get({});
      }
      accounts.push({ account: portableAccount, cookies });
    }
    const payload = { format: 1, exportedAt: new Date().toISOString(), sites, accounts };
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出账户环境',
      defaultPath: `ProfileDesk-${Date.now()}.pdesk`,
      filters: [{ name: 'ProfileDesk加密包', extensions: ['pdesk'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    await fs.promises.writeFile(result.filePath, encryptPackage(payload, password), { mode: 0o600 });
    await logAction('package.exported', { count: accounts.length, fileName: path.basename(result.filePath) });
    return { canceled: false, filePath: result.filePath, count: accounts.length };
  });

  handleUnlocked('package:import', async (_event, password) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入账户环境',
      properties: ['openFile'],
      filters: [{ name: 'ProfileDesk加密包', extensions: ['pdesk'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const importFile = result.filePaths[0];
    const stat = await fs.promises.stat(importFile);
    if (stat.size > 100 * 1024 * 1024) throw new Error('导入包超过100MB安全限制');
    const payload = decryptPackage(await fs.promises.readFile(importFile), password);
    if (payload.format !== 1 || !Array.isArray(payload.accounts) || !Array.isArray(payload.sites)) {
      throw new Error('导入包版本不支持');
    }
    if (payload.accounts.length > 500) throw new Error('单次最多导入500个账户');
    let count = 0;
    for (const entry of payload.accounts) {
      if (!entry?.account || !Array.isArray(entry.cookies)) throw new Error('导入包账户数据无效');
      if (entry.cookies.length > 10000) throw new Error('单个账户Cookie数量异常');
      const oldSite = payload.sites.find((site) => site.id === entry.account.siteId);
      let site = store.data.sites.find((item) => item.name === oldSite?.name);
      if (!site) site = await store.addSite({
        name: oldSite?.name || '已导入业务站',
        homeUrl: oldSite?.homeUrl || entry.account.startUrl,
        color: oldSite?.color,
      });
      const account = await store.addAccount({
        ...entry.account,
        id: undefined,
        siteId: site.id,
        name: `${entry.account.name}（导入）`,
        proxy: { ...(entry.account.proxy || {}), secretRef: '' },
        autoLogin: { ...(entry.account.autoLogin || {}), enabled: false, secretRef: '' },
      });
      const ses = account.storageMode === 'incognito' ? null : profiles.getSession(account.id);
      for (const cookie of ses ? (entry.cookies || []) : []) {
        const domain = String(cookie.domain || '').replace(/^\./, '');
        if (!domain) continue;
        const next = {
          url: `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`,
          name: cookie.name,
          value: cookie.value,
          domain: cookie.domain,
          path: cookie.path,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
        };
        if (cookie.expirationDate) next.expirationDate = cookie.expirationDate;
        if (cookie.sameSite && cookie.sameSite !== 'unspecified') next.sameSite = cookie.sameSite;
        await ses.cookies.set(next).catch(() => {});
      }
      if (ses) await ses.flushStorageData();
      count += 1;
    }
    send('workspace:changed', store.publicState());
    await logAction('package.imported', { count, fileName: path.basename(importFile) });
    return { canceled: false, count };
  });
}

async function startApplication() {
  const marker = startupMarkerFile();
  if (!safeMode && fs.existsSync(marker)) safeMode = true;
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf8');
  startupLog(`START version=${app.getVersion()} safeMode=${safeMode}`);
  Menu.setApplicationMenu(null);
  startupLog('PHASE data-directory');
  dataDirectories = new DataDirectoryService(app.getPath('userData'));
  rootDir = await dataDirectories.init();
  startupLog('PHASE local-services');
  store = new WorkspaceStore(rootDir);
  vault = new SecretVault(rootDir, safeStorage);
  settings = new SettingsService(rootDir);
  audit = new AuditLogger(rootDir);
  await Promise.all([store.init(), vault.init(), settings.init(), audit.init()]);
  snapshots = new SnapshotService(rootDir, store, vault);
  await snapshots.init();
  await finalizePendingAccountDeletions();
  await logAction('app.started', { version: app.getVersion(), dataDirectory: rootDir });
  isUnlocked = !settings.isLockedOnLaunch();
  startupLog('PHASE main-window');
  createMainWindow();
  profiles = new ProfileManager({
    mainWindow,
    store,
    vault,
    rootDir,
    safeMode,
    onEvent: (event) => {
      send('browser:event', event);
      if (['started', 'stopped', 'crashed', 'navigation'].includes(event.type)) {
        send('workspace:changed', store.publicState());
      }
      if (['started', 'stopped', 'crashed', 'resource-released'].includes(event.type)) {
        logAction(`browser.${event.type}`, { accountId: event.accountId, reason: event.reason || '' });
      }
      if (!shuttingDown && ['started', 'stopped', 'crashed'].includes(event.type)) {
        const ids = [...profiles.instances.keys()];
        restoreSave = restoreSave.catch(() => {}).then(() => store.setRestoreIds(ids));
      }
    },
  });
  startupLog('PHASE browser-manager');
  await profiles.init();
  await profiles.updateResourceLimits(settings.publicSettings());
  registerIpc();
  registerGlobalShortcuts();
  startupLog('PHASE renderer');
  await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (!mainWindow.isVisible()) mainWindow.show();
  if (isUnlocked && !safeMode) {
    startupLog('PHASE restore-sessions');
    await restorePreviousSessions();
  }
  startupComplete = true;
  startupLog('READY');
  fs.rmSync(marker, { force: true });
}

if (!safeMode && fs.existsSync(startupMarkerFile())) safeMode = true;
if (safeMode) app.disableHardwareAcceleration();

app.whenReady().then(startApplication).catch((error) => {
  showFatalError(error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());

process.on('uncaughtException', (error) => {
  startupLog(startupComplete ? 'UNCAUGHT' : 'STARTUP-UNCAUGHT', error);
  console.error('Uncaught exception:', error.message);
  if (!startupComplete) showFatalError(error);
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  startupLog(startupComplete ? 'UNHANDLED-REJECTION' : 'STARTUP-REJECTION', error);
  console.error('Unhandled rejection:', error.message);
  if (!startupComplete) showFatalError(error);
});
