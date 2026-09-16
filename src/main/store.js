const fs = require('node:fs');
const path = require('node:path');
const {
  createAccount,
  createSite,
  normalizeAvatarDataUrl,
  normalizeAutoLogin,
  normalizeEnvironment,
  normalizeProxy,
  normalizeStorageMode,
  normalizeUrl,
  nowIso,
  publicAccount,
} = require('../shared/model');

class WorkspaceStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
    this.file = path.join(rootDir, 'workspace.json');
    this.data = { schemaVersion: 1, sites: [], accounts: [], snapshots: [], restoreIds: [] };
  }

  async init() {
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    try {
      const raw = await fs.promises.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.schemaVersion !== 1) throw new Error('不支持的数据版本');
      const restoreIds = Array.isArray(parsed.restoreIds)
        ? parsed.restoreIds
        : (parsed.accounts || []).filter((account) => account.status === 'running').map((account) => account.id);
      this.data = {
        schemaVersion: 1,
        sites: Array.isArray(parsed.sites)
          ? parsed.sites.map((site) => ({
            ...site,
            logoDataUrl: normalizeAvatarDataUrl(site.logoDataUrl),
            pendingDeletion: Boolean(site.pendingDeletion),
            deletionRequestedAt: site.pendingDeletion ? String(site.deletionRequestedAt || '') : null,
          }))
          : [],
        accounts: Array.isArray(parsed.accounts)
          ? parsed.accounts.map((account) => ({
            ...account,
            storageMode: normalizeStorageMode(account.storageMode),
            muted: Boolean(account.muted),
            pendingDeletion: Boolean(account.pendingDeletion),
            deletionRequestedAt: account.pendingDeletion ? String(account.deletionRequestedAt || '') : null,
            status: account.pendingDeletion ? 'pending-delete' : 'stopped',
          }))
          : [],
        snapshots: Array.isArray(parsed.snapshots) ? parsed.snapshots : [],
        restoreIds,
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = `${this.file}.invalid-${Date.now()}`;
        await fs.promises.copyFile(this.file, backup).catch(() => {});
      }
      await this.save();
    }
    return this.publicState();
  }

  publicState() {
    return {
      schemaVersion: this.data.schemaVersion,
      sites: structuredClone(this.data.sites),
      accounts: this.data.accounts.map(publicAccount),
      snapshots: structuredClone(this.data.snapshots),
    };
  }

  async save() {
    const tmp = `${this.file}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    await fs.promises.writeFile(tmp, payload, { mode: 0o600 });
    await fs.promises.rename(tmp, this.file);
  }

  findSite(id) {
    return this.data.sites.find((site) => site.id === id);
  }

  findAccount(id) {
    return this.data.accounts.find((account) => account.id === id);
  }

  async addSite(input) {
    const site = createSite(input);
    this.data.sites.push(site);
    await this.save();
    return structuredClone(site);
  }

  async updateSite(id, patch) {
    const site = this.findSite(id);
    if (!site) throw new Error('业务站不存在');
    if (site.pendingDeletion) throw new Error('业务站已等待下次启动删除');
    if (Object.hasOwn(patch, 'name')) {
      const name = String(patch.name || '').trim().slice(0, 80);
      if (!name) throw new Error('业务站名称不能为空');
      site.name = name;
    }
    if (Object.hasOwn(patch, 'homeUrl')) site.homeUrl = normalizeUrl(patch.homeUrl);
    if (Object.hasOwn(patch, 'logoDataUrl')) site.logoDataUrl = normalizeAvatarDataUrl(patch.logoDataUrl);
    if (Object.hasOwn(patch, 'color')) {
      site.color = ['blue', 'purple', 'green', 'orange', 'red', 'slate'].includes(patch.color) ? patch.color : 'blue';
    }
    site.updatedAt = nowIso();
    await this.save();
    return structuredClone(site);
  }

  async markSitesPendingDeletion(ids) {
    const selected = new Set(ids);
    const requestedAt = nowIso();
    for (const site of this.data.sites) {
      if (!selected.has(site.id) || site.pendingDeletion) continue;
      site.pendingDeletion = true;
      site.deletionRequestedAt = requestedAt;
      site.updatedAt = requestedAt;
    }
    await this.save();
  }

  async removeSites(ids) {
    const selected = new Set(ids);
    const occupied = new Set(this.data.accounts.map((account) => account.siteId));
    this.data.sites = this.data.sites.filter((site) => !selected.has(site.id) || occupied.has(site.id));
    await this.save();
  }

  async addAccount(input) {
    const site = this.findSite(input.siteId);
    const account = createAccount(input, site);
    this.data.accounts.push(account);
    await this.save();
    return publicAccount(account);
  }

  async importBatch(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('没有可导入的数据');
    if (rows.length > 500) throw new Error('单次最多导入500个账户');
    const sites = [...this.data.sites];
    const accounts = [...this.data.accounts];
    const created = [];
    let sitesAdded = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('批量数据格式无效');
      const siteName = String(row.siteName || '').trim();
      if (!siteName) throw new Error('批量数据缺少业务站名称');
      let site = sites.find((item) => item.name === siteName);
      if (!site) {
        if (!row.homeUrl && !row.startUrl) throw new Error(`业务站“${siteName}”缺少地址`);
        site = createSite({
          name: siteName,
          homeUrl: row.homeUrl || row.startUrl,
          color: row.siteColor || row.color,
        });
        sites.push(site);
        sitesAdded += 1;
      }
      const accountName = String(row.accountName || row.name || '').trim();
      if (!accountName) continue;
      const account = createAccount({
        siteId: site.id,
        name: accountName,
        username: row.username,
        startUrl: row.startUrl || row.homeUrl || site.homeUrl,
        note: row.note,
        tags: typeof row.tags === 'string' ? row.tags.split(',').map((v) => v.trim()).filter(Boolean) : row.tags,
        proxy: row.proxy,
        storageMode: row.storageMode,
      }, site);
      accounts.push(account);
      created.push(publicAccount(account));
    }
    this.data.sites = sites;
    this.data.accounts = accounts;
    await this.save();
    return { sitesAdded, accountsAdded: created.length, accounts: created };
  }

  async updateAccount(id, patch) {
    const account = this.findAccount(id);
    if (!account) throw new Error('账户不存在');
    if (account.pendingDeletion) throw new Error('账户已等待下次启动删除');
    const allowed = ['name', 'avatarDataUrl', 'username', 'startUrl', 'currentUrl', 'note', 'tags', 'storageMode', 'muted', 'proxy', 'environment', 'autoLogin', 'status', 'lastError', 'lastOpenedAt'];
    for (const key of allowed) {
      if (!Object.hasOwn(patch, key)) continue;
      if (key === 'name') {
        const name = String(patch.name || '').trim().slice(0, 80);
        if (!name) throw new Error('账户名称不能为空');
        account.name = name;
      } else if (key === 'avatarDataUrl') account.avatarDataUrl = normalizeAvatarDataUrl(patch.avatarDataUrl);
      else if (key === 'username') account.username = String(patch.username || '').trim().slice(0, 300);
      else if (key === 'storageMode') account.storageMode = normalizeStorageMode(patch.storageMode);
      else if (key === 'muted') account.muted = Boolean(patch.muted);
      else if (key === 'startUrl' || key === 'currentUrl') account[key] = normalizeUrl(patch[key]);
      else if (key === 'proxy') account.proxy = normalizeProxy({ ...account.proxy, ...patch.proxy });
      else if (key === 'environment') account.environment = normalizeEnvironment({ ...account.environment, ...patch.environment });
      else if (key === 'autoLogin') account.autoLogin = normalizeAutoLogin({ ...account.autoLogin, ...patch.autoLogin }, account.startUrl);
      else account[key] = structuredClone(patch[key]);
    }
    account.updatedAt = nowIso();
    await this.save();
    return publicAccount(account);
  }

  async markAccountsPendingDeletion(ids) {
    const selected = new Set(ids);
    const requestedAt = nowIso();
    const marked = [];
    for (const account of this.data.accounts) {
      if (!selected.has(account.id) || account.pendingDeletion) continue;
      account.pendingDeletion = true;
      account.deletionRequestedAt = requestedAt;
      account.status = 'pending-delete';
      account.lastError = '';
      account.updatedAt = requestedAt;
      marked.push(account);
    }
    this.data.snapshots = this.data.snapshots.filter((item) => !selected.has(item.accountId));
    this.data.restoreIds = this.data.restoreIds.filter((id) => !selected.has(id));
    await this.save();
    return marked.map(publicAccount);
  }

  async removeAccounts(ids) {
    const selected = new Set(ids);
    const removed = this.data.accounts.filter((account) => selected.has(account.id));
    this.data.accounts = this.data.accounts.filter((account) => !selected.has(account.id));
    this.data.snapshots = this.data.snapshots.filter((item) => !selected.has(item.accountId));
    this.data.restoreIds = this.data.restoreIds.filter((id) => !selected.has(id));
    await this.save();
    return removed;
  }

  async addSnapshot(metadata) {
    this.data.snapshots.push(metadata);
    await this.save();
    return structuredClone(metadata);
  }

  async removeSnapshot(id) {
    this.data.snapshots = this.data.snapshots.filter((item) => item.id !== id);
    await this.save();
  }

  async removeSnapshotsForAccounts(accountIds) {
    const selected = new Set(accountIds);
    this.data.snapshots = this.data.snapshots.filter((item) => !selected.has(item.accountId));
    await this.save();
  }

  async setRestoreIds(ids) {
    this.data.restoreIds = [...new Set(Array.isArray(ids) ? ids : [])]
      .filter((id) => {
        const account = this.findAccount(id);
        return account && !account.pendingDeletion && account.storageMode !== 'incognito';
      });
    await this.save();
  }
}

module.exports = { WorkspaceStore };
