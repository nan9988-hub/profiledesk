const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, session, WebContentsView } = require('electron');
const {
  MOBILE_DEVICE_PROFILES,
  normalizeEnvironment,
  normalizeProxy,
  normalizeUrl,
  resolveUserAgent,
} = require('../shared/model');

function safeFileName(input) {
  return String(input || 'download')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .slice(0, 180);
}

class ProfileManager {
  constructor({ mainWindow, store, vault, rootDir, safeMode = false, onEvent }) {
    this.mainWindow = mainWindow;
    this.store = store;
    this.vault = vault;
    this.rootDir = rootDir;
    this.safeMode = Boolean(safeMode);
    this.profileRoot = path.join(rootDir, 'profiles');
    this.downloadRoot = path.join(rootDir, 'downloads');
    this.instances = new Map();
    this.configuredSessions = new WeakSet();
    this.activeId = null;
    this.bounds = { x: 300, y: 110, width: 800, height: 500 };
    this.onEvent = onEvent;
    this.maxRunningAccounts = 8;
    this.idleStopMinutes = 30;
    this.memoryLimitMb = 4096;
    this.startQueue = Promise.resolve();
    this.resourceTimer = null;
    this.usageTimer = null;
    this.cpuSample = this.cpuTimes();
    this.lastResourceWarningAt = 0;
    this.acceptingStarts = true;
    this.blockedAccountIds = new Set();
    app.on('login', (event, webContents, _details, authInfo, callback) => {
      if (!authInfo.isProxy) return;
      const entry = [...this.instances.entries()]
        .find(([, instance]) => instance.view.webContents.id === webContents.id);
      if (!entry) return;
      const account = this.store.findAccount(entry[0]);
      if (!account?.proxy?.username || !account.proxy.secretRef) return;
      event.preventDefault();
      callback(account.proxy.username, this.vault.get(account.proxy.secretRef));
    });
  }

  async init() {
    await Promise.all([
      fs.promises.mkdir(this.profileRoot, { recursive: true }),
      fs.promises.mkdir(this.downloadRoot, { recursive: true }),
    ]);
    this.resourceTimer = setInterval(() => this.sweepResources().catch(() => {}), 60000);
    this.resourceTimer.unref?.();
    this.usageTimer = setInterval(() => this.reportResourceUsage(), 2000);
    this.usageTimer.unref?.();
  }

  profilePath(accountId) {
    return this.accountPath(this.profileRoot, accountId);
  }

  accountPath(parent, accountId) {
    const target = path.resolve(parent, String(accountId || ''));
    const relative = path.relative(parent, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('账户数据路径无效');
    return target;
  }

  getSession(accountId) {
    const existing = this.instances.get(accountId);
    if (existing) return existing.session;
    const account = this.store.findAccount(accountId);
    if (!account) throw new Error('账户不存在');
    if (account.storageMode === 'incognito') {
      return session.fromPartition(`profiledesk-incognito-${accountId}`, { cache: true });
    }
    return session.fromPath(this.profilePath(accountId), { cache: true });
  }

  async applyProxy(accountId, proxyInput) {
    const proxy = normalizeProxy(proxyInput);
    if (proxy.mode === 'fixed_servers' && !proxy.server) {
      throw new Error('自定义代理地址不能为空');
    }
    const ses = this.getSession(accountId);
    if (proxy.mode === 'system') {
      await ses.setProxy({ mode: 'system' });
    } else if (proxy.mode === 'direct') {
      await ses.setProxy({ mode: 'direct' });
    } else {
      await ses.setProxy({
        mode: 'fixed_servers',
        proxyRules: proxy.server,
        proxyBypassRules: proxy.bypassRules || '<local>',
      });
    }
    await ses.closeAllConnections();
    await this.store.updateAccount(accountId, { proxy });
    return proxy;
  }

  configureSession(account, ses) {
    if (this.configuredSessions.has(ses)) return;
    this.configuredSessions.add(ses);
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const current = this.store.findAccount(account.id);
      const language = current?.environment?.acceptLanguage;
      if (language) details.requestHeaders['Accept-Language'] = language;
      if (current?.environment?.doNotTrack) details.requestHeaders.DNT = '1';
      callback({ requestHeaders: details.requestHeaders });
    });

    ses.setPermissionCheckHandler((_webContents, permission) => {
      return !['media', 'geolocation', 'notifications', 'midiSysex', 'openExternal'].includes(permission);
    });
    ses.setPermissionRequestHandler((_webContents, permission, callback) => {
      callback(!['media', 'geolocation', 'notifications', 'midiSysex', 'openExternal'].includes(permission));
    });

    const accountDownloadDir = this.accountPath(this.downloadRoot, account.id);
    fs.mkdirSync(accountDownloadDir, { recursive: true });
    ses.on('will-download', (_event, item) => {
      const target = path.join(accountDownloadDir, safeFileName(item.getFilename()));
      item.setSavePath(target);
      this.emit('download-started', { accountId: account.id, filename: item.getFilename(), target });
    });
  }

  layoutForEnvironment(environment) {
    const normalized = normalizeEnvironment(environment);
    if (this.safeMode || normalized.deviceType !== 'mobile') {
      return { bounds: this.bounds, profile: null };
    }
    const profile = MOBILE_DEVICE_PROFILES[normalized.mobileDevice]
      || MOBILE_DEVICE_PROFILES['pixel-11-pro'];
    const width = Math.max(1, Math.min(this.bounds.width, profile.width));
    return {
      bounds: {
        x: this.bounds.x + Math.max(0, Math.floor((this.bounds.width - width) / 2)),
        y: this.bounds.y,
        width,
        height: this.bounds.height,
      },
      profile,
    };
  }

  applyEnvironmentToInstance(account, instance) {
    const environment = normalizeEnvironment(account.environment);
    const contents = instance.view.webContents;
    contents.setUserAgent(resolveUserAgent(environment) || instance.defaultUserAgent);
    const layout = this.layoutForEnvironment(environment);
    instance.view.setBounds(layout.bounds);
    instance.environmentLayout = layout.profile?.id || 'desktop';
    return layout.profile;
  }

  applyEnvironment(accountId, { reload = false } = {}) {
    const account = this.store.findAccount(accountId);
    if (!account) throw new Error('账户不存在');
    const environment = normalizeEnvironment(account.environment);
    const profile = environment.deviceType === 'mobile'
      ? MOBILE_DEVICE_PROFILES[environment.mobileDevice]
      : null;
    const instance = this.instances.get(accountId);
    if (instance) {
      this.applyEnvironmentToInstance(account, instance);
      if (reload && !instance.view.webContents.isDestroyed()) instance.view.webContents.reload();
    }
    return {
      running: Boolean(instance),
      device: profile?.id || 'desktop',
      label: profile?.label || 'PC桌面设备',
    };
  }

  start(accountId, options = {}) {
    if (!this.acceptingStarts || this.blockedAccountIds.has(accountId)) return Promise.reject(new Error('账户正在关闭或删除'));
    const result = this.startQueue.then(() => this.startInternal(accountId, options));
    this.startQueue = result.catch(() => {});
    return result;
  }

  async startInternal(accountId, options = {}) {
    const running = this.instances.get(accountId);
    if (running) {
      if (options.activate !== false) this.activate(accountId);
      return { accountId, status: 'running' };
    }
    const account = this.store.findAccount(accountId);
    if (!account) throw new Error('账户不存在');
    if (account.pendingDeletion) throw new Error('账户已等待下次启动删除');
    await this.enforceCapacity(accountId);
    const ses = this.getSession(accountId);
    this.configureSession(account, ses);
    await this.applyProxy(accountId, account.proxy);

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: false,
      },
    });
    view.setBackgroundColor('#0c111d');
    view.setVisible(false);
    const contents = view.webContents;
    contents.setBackgroundThrottling(true);
    contents.setAudioMuted(Boolean(account.muted));

    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (!/^https?:\/\//i.test(url)) event.preventDefault();
    });
    contents.on('did-navigate', (_event, url) => this.handleNavigation(accountId, url));
    contents.on('did-navigate-in-page', (_event, url) => this.handleNavigation(accountId, url));
    contents.on('page-title-updated', (_event, title) => this.emit('title', { accountId, title }));
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (isMainFrame && code !== -3) {
        this.store.updateAccount(accountId, { lastError: `${description} (${code})` }).catch(() => {});
        this.emit('load-error', { accountId, code, description, url });
      }
    });
    contents.on('render-process-gone', (_event, details) => this.handleCrash(accountId, details).catch(() => {}));
    contents.on('did-finish-load', () => this.tryAutoFill(accountId).catch(() => {}));

    this.mainWindow.contentView.addChildView(view);
    const instance = {
      view,
      session: ses,
      lastActiveAt: Date.now(),
      defaultUserAgent: contents.getUserAgent(),
      environmentLayout: 'desktop',
    };
    this.instances.set(accountId, instance);
    this.applyEnvironmentToInstance(account, instance);
    await this.store.updateAccount(accountId, {
      status: 'running',
      lastOpenedAt: new Date().toISOString(),
      lastError: '',
    });
    await contents.loadURL(normalizeUrl(account.storageMode === 'incognito'
      ? account.startUrl
      : (account.currentUrl || account.startUrl)));
    if (options.activate !== false) this.activate(accountId);
    this.emit('started', { accountId });
    return { accountId, status: 'running' };
  }

  async handleNavigation(accountId, url) {
    const account = this.store.findAccount(accountId);
    if (account?.storageMode !== 'incognito') {
      await this.store.updateAccount(accountId, { currentUrl: url, lastError: '' }).catch(() => {});
    }
    this.emit('navigation', {
      accountId,
      url,
      canGoBack: this.instances.get(accountId)?.view.webContents.canGoBack() || false,
      canGoForward: this.instances.get(accountId)?.view.webContents.canGoForward() || false,
    });
  }

  async tryAutoFill(accountId) {
    const account = this.store.findAccount(accountId);
    const instance = this.instances.get(accountId);
    if (!account?.autoLogin?.enabled || !instance || !account.autoLogin.secretRef) return;
    const current = new URL(instance.view.webContents.getURL());
    const login = new URL(account.autoLogin.loginUrl);
    if (current.origin !== login.origin) return;
    if (current.protocol !== 'https:' && current.hostname !== 'localhost') return;
    const usernameSelector = account.autoLogin.usernameSelector;
    const passwordSelector = account.autoLogin.passwordSelector;
    if (!usernameSelector || !passwordSelector) return;
    const password = this.vault.get(account.autoLogin.secretRef);
    const script = `(() => {
      const setValue = (selector, value) => {
        const element = document.querySelector(selector);
        if (!element) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter ? setter.call(element, value) : (element.value = value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      return {
        username: setValue(${JSON.stringify(usernameSelector)}, ${JSON.stringify(account.username)}),
        password: setValue(${JSON.stringify(passwordSelector)}, ${JSON.stringify(password)})
      };
    })()`;
    await instance.view.webContents.executeJavaScript(script, true);
    this.emit('credentials-filled', { accountId });
  }

  activate(accountId) {
    if (!this.instances.has(accountId)) return false;
    for (const [id, instance] of this.instances) {
      instance.view.setVisible(id === accountId);
      if (id === accountId) {
        const account = this.store.findAccount(id);
        if (account) this.applyEnvironmentToInstance(account, instance);
        instance.lastActiveAt = Date.now();
      }
    }
    this.activeId = accountId;
    this.emit('activated', { accountId });
    return true;
  }

  setBounds(bounds) {
    const next = {
      x: Math.max(0, Math.round(bounds.x || 0)),
      y: Math.max(0, Math.round(bounds.y || 0)),
      width: Math.max(1, Math.round(bounds.width || 1)),
      height: Math.max(1, Math.round(bounds.height || 1)),
    };
    this.bounds = next;
    if (this.activeId) {
      const account = this.store.findAccount(this.activeId);
      const instance = this.instances.get(this.activeId);
      if (account && instance) this.applyEnvironmentToInstance(account, instance);
    }
  }

  async stop(accountId) {
    const instance = this.instances.get(accountId);
    if (!instance) return { accountId, status: 'stopped' };
    await this.disposeInstance(accountId, true);
    await this.store.updateAccount(accountId, { status: 'stopped' });
    this.emit('stopped', { accountId });
    return { accountId, status: 'stopped' };
  }

  async setMuted(accountId, muted) {
    const account = this.store.findAccount(accountId);
    if (!account) throw new Error('账户不存在');
    if (account.pendingDeletion) throw new Error('账户已等待下次启动删除');
    const nextMuted = Boolean(muted);
    const contents = this.instances.get(accountId)?.view.webContents;
    if (contents && !contents.isDestroyed()) contents.setAudioMuted(nextMuted);
    const updated = await this.store.updateAccount(accountId, { muted: nextMuted });
    this.emit('audio-state', { accountId, muted: nextMuted });
    return updated;
  }

  async disposeInstance(accountId, flush) {
    const instance = this.instances.get(accountId);
    if (!instance) return;
    const incognito = this.store.findAccount(accountId)?.storageMode === 'incognito';
    const wasActive = this.activeId === accountId;
    try {
      const flushResult = flush && !incognito ? instance.session.flushStorageData() : null;
      if (flushResult && typeof flushResult.then === 'function') await flushResult;
    } catch {
      // Closing the isolated view remains safe even if Chromium cannot flush a damaged profile.
    }
    try { instance.view.setVisible(false); } catch {}
    try { this.mainWindow.contentView.removeChildView(instance.view); } catch {}
    try {
      if (!instance.view.webContents.isDestroyed()) instance.view.webContents.close();
    } catch {}
    if (incognito) {
      await Promise.all([
        instance.session.clearCache().catch(() => {}),
        instance.session.clearStorageData().catch(() => {}),
        instance.session.closeAllConnections().catch(() => {}),
      ]);
      this.emit('incognito-cleared', { accountId });
    }
    this.instances.delete(accountId);
    if (wasActive) {
      this.activeId = null;
      const nextId = this.instances.keys().next().value;
      if (nextId) this.activate(nextId);
    }
  }

  async stopAll() {
    for (const id of [...this.instances.keys()]) await this.stop(id);
  }

  async handleCrash(accountId, details) {
    await this.disposeInstance(accountId, false);
    await this.store.updateAccount(accountId, { status: 'crashed', lastError: details.reason });
    this.emit('crashed', { accountId, reason: details.reason });
  }

  updateResourceLimits({ maxRunningAccounts, idleStopMinutes, memoryLimitMb } = {}) {
    this.maxRunningAccounts = Math.min(30, Math.max(1, Number.parseInt(maxRunningAccounts, 10) || 8));
    this.idleStopMinutes = Math.min(1440, Math.max(0, Number.parseInt(idleStopMinutes, 10) || 0));
    this.memoryLimitMb = Math.min(32768, Math.max(1024, Number.parseInt(memoryLimitMb, 10) || 4096));
    return this.trimToLimit();
  }

  async enforceCapacity(incomingId) {
    while (!this.instances.has(incomingId) && this.instances.size >= this.maxRunningAccounts) {
      const candidate = [...this.instances.entries()]
        .filter(([id]) => id !== incomingId)
        .sort((left, right) => left[1].lastActiveAt - right[1].lastActiveAt)
        .find(([id]) => id !== this.activeId) || [...this.instances.entries()][0];
      if (!candidate) break;
      await this.stop(candidate[0]);
      this.emit('resource-released', { accountId: candidate[0], reason: 'limit' });
    }
  }

  async trimToLimit() {
    while (this.instances.size > this.maxRunningAccounts) {
      const candidate = [...this.instances.entries()]
        .sort((left, right) => left[1].lastActiveAt - right[1].lastActiveAt)
        .find(([id]) => id !== this.activeId) || [...this.instances.entries()][0];
      if (!candidate) break;
      await this.stop(candidate[0]);
      this.emit('resource-released', { accountId: candidate[0], reason: 'limit' });
    }
  }

  async stopIdleInstances() {
    if (!this.idleStopMinutes) return;
    const cutoff = Date.now() - this.idleStopMinutes * 60 * 1000;
    const idleIds = [...this.instances.entries()]
      .filter(([id, instance]) => id !== this.activeId && instance.lastActiveAt < cutoff)
      .map(([id]) => id);
    for (const id of idleIds) {
      await this.stop(id);
      this.emit('resource-released', { accountId: id, reason: 'idle' });
    }
  }

  workingSetMb() {
    try {
      const totalKb = app.getAppMetrics().reduce((total, metric) => total + Number(metric.memory?.workingSetSize || 0), 0);
      return totalKb / 1024;
    } catch {
      return 0;
    }
  }

  cpuTimes() {
    return os.cpus().reduce((result, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      result.idle += cpu.times.idle;
      result.total += total;
      return result;
    }, { idle: 0, total: 0 });
  }

  resourceUsage() {
    const currentCpu = this.cpuTimes();
    const idleDelta = currentCpu.idle - this.cpuSample.idle;
    const totalDelta = currentCpu.total - this.cpuSample.total;
    this.cpuSample = currentCpu;
    const totalMemory = os.totalmem();
    const usedMemory = Math.max(0, totalMemory - os.freemem());
    let appCpuPercent = 0;
    try {
      appCpuPercent = app.getAppMetrics().reduce(
        (sum, metric) => sum + Number(metric.cpu?.percentCPUUsage || 0),
        0,
      );
    } catch {
      appCpuPercent = 0;
    }
    return {
      systemCpuPercent: totalDelta > 0
        ? Math.min(100, Math.max(0, ((totalDelta - idleDelta) / totalDelta) * 100))
        : 0,
      systemMemoryPercent: totalMemory > 0 ? Math.min(100, (usedMemory / totalMemory) * 100) : 0,
      appMemoryMb: this.workingSetMb(),
      appCpuPercent: Math.max(0, appCpuPercent),
      runningAccounts: this.instances.size,
      memoryLimitMb: this.memoryLimitMb,
    };
  }

  reportResourceUsage() {
    const usage = this.resourceUsage();
    this.emit('resource-usage', usage);
    const reasons = [];
    if (usage.appMemoryMb >= this.memoryLimitMb) reasons.push('ProfileDesk内存达到提醒阈值');
    if (usage.systemMemoryPercent >= 90) reasons.push('系统内存占用超过90%');
    if (usage.systemCpuPercent >= 95) reasons.push('系统CPU占用超过95%');
    const now = Date.now();
    if (reasons.length && now - this.lastResourceWarningAt >= 60000) {
      this.lastResourceWarningAt = now;
      this.emit('resource-warning', { ...usage, reasons });
    }
    return usage;
  }

  async sweepResources() {
    await this.stopIdleInstances();
    this.reportResourceUsage();
  }

  async prepareAccountDeletion(accountId) {
    this.blockedAccountIds.add(accountId);
    await this.startQueue.catch(() => {});
    if (this.instances.has(accountId)) await this.stop(accountId);
    const browserSession = this.getSession(accountId);
    await Promise.all([
      browserSession.clearCache().catch(() => {}),
      browserSession.clearStorageData().catch(() => {}),
      browserSession.closeAllConnections().catch(() => {}),
    ]);
    return {
      pendingPaths: [this.profilePath(accountId), this.accountPath(this.downloadRoot, accountId)],
    };
  }

  async prepareStorageModeChange(accountId, nextMode) {
    const account = this.store.findAccount(accountId);
    if (!account) throw new Error('账户不存在');
    const currentMode = account.storageMode === 'incognito' ? 'incognito' : 'persistent';
    if (currentMode === nextMode) return { pendingPaths: [] };
    if (this.instances.has(accountId)) await this.stop(accountId);
    const oldSession = currentMode === 'incognito'
      ? session.fromPartition(`profiledesk-incognito-${accountId}`, { cache: true })
      : session.fromPath(this.profilePath(accountId), { cache: true });
    await Promise.all([
      oldSession.clearCache().catch(() => {}),
      oldSession.clearStorageData().catch(() => {}),
      oldSession.closeAllConnections().catch(() => {}),
    ]);
    if (nextMode !== 'incognito') return { pendingPaths: [] };
    const target = this.profilePath(accountId);
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      return { pendingPaths: [] };
    } catch {
      return { pendingPaths: [target] };
    }
  }

  async shutdown() {
    this.acceptingStarts = false;
    await this.startQueue.catch(() => {});
    if (this.resourceTimer) clearInterval(this.resourceTimer);
    this.resourceTimer = null;
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageTimer = null;
    await this.stopAll();
  }

  async navigate(accountId, url) {
    if (!this.instances.has(accountId)) await this.start(accountId);
    const target = normalizeUrl(url);
    await this.instances.get(accountId).view.webContents.loadURL(target);
    return target;
  }

  command(accountId, command) {
    const contents = this.instances.get(accountId)?.view.webContents;
    if (!contents) throw new Error('账户窗口尚未启动');
    if (command === 'back' && contents.canGoBack()) contents.goBack();
    else if (command === 'forward' && contents.canGoForward()) contents.goForward();
    else if (command === 'reload') contents.reload();
    else if (command === 'home') {
      const account = this.store.findAccount(accountId);
      contents.loadURL(account.startUrl).catch(() => {});
    }
  }

  async clear(accountId, mode, origin = '') {
    const ses = this.getSession(accountId);
    if (mode === 'cache') {
      await ses.clearCache();
    } else if (mode === 'history') {
      await Promise.all([ses.clearCache(), ses.clearStorageData({ storages: ['indexdb', 'serviceworkers', 'cachestorage'] })]);
    } else if (mode === 'site') {
      if (!origin) throw new Error('无法确定当前站点');
      await ses.clearStorageData({ origin, storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] });
    } else if (mode === 'all') {
      await Promise.all([ses.clearCache(), ses.clearStorageData()]);
    } else {
      throw new Error('未知清理模式');
    }
    this.emit('cleared', { accountId, mode });
    return true;
  }

  currentUrl(accountId) {
    return this.instances.get(accountId)?.view.webContents.getURL()
      || this.store.findAccount(accountId)?.currentUrl
      || '';
  }

  isRunning(accountId) {
    return this.instances.has(accountId);
  }

  emit(type, payload) {
    this.onEvent?.({ type, ...payload });
  }
}

module.exports = { ProfileManager };
