const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspaceStore } = require('../src/main/store');

test('workspace persists sites, isolated accounts and restore IDs', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-test-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  const site = await store.addSite({ name: 'Business', homeUrl: 'https://example.com' });
  const account = await store.addAccount({ siteId: site.id, name: 'Account 1' });
  await store.setRestoreIds([account.id, 'missing']);

  const reloaded = new WorkspaceStore(directory);
  await reloaded.init();
  assert.equal(reloaded.data.accounts.length, 1);
  assert.deepEqual(reloaded.data.restoreIds, [account.id]);
  assert.equal(reloaded.publicState().accounts[0].status, 'stopped');
});

test('workspace persists account avatars and browser environment presets', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-avatar-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  const site = await store.addSite({ name: 'Business', homeUrl: 'https://example.com', color: 'green' });
  const avatarDataUrl = 'data:image/webp;base64,UklGRg==';
  const account = await store.addAccount({ siteId: site.id, name: 'Mobile', avatarDataUrl });
  await store.updateAccount(account.id, {
    environment: { deviceType: 'mobile', mobileDevice: 'iphone-17-pro', browserPreset: 'chrome' },
  });
  const reloaded = new WorkspaceStore(directory);
  await reloaded.init();
  assert.equal(reloaded.data.sites[0].color, 'green');
  assert.equal(reloaded.data.accounts[0].avatarDataUrl, avatarDataUrl);
  assert.equal(reloaded.data.accounts[0].environment.deviceType, 'mobile');
  assert.equal(reloaded.data.accounts[0].environment.mobileDevice, 'iphone-17-pro');
  assert.equal(reloaded.data.accounts[0].environment.browserPreset, 'chrome');
});

test('incognito accounts persist configuration but are excluded from session restore', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-incognito-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  const site = await store.addSite({ name: 'Business', homeUrl: 'https://example.com' });
  const account = await store.addAccount({ siteId: site.id, name: 'Private', storageMode: 'incognito' });
  await store.setRestoreIds([account.id]);
  assert.equal(store.findAccount(account.id).storageMode, 'incognito');
  assert.deepEqual(store.data.restoreIds, []);

  const reloaded = new WorkspaceStore(directory);
  await reloaded.init();
  assert.equal(reloaded.findAccount(account.id).storageMode, 'incognito');
});

test('batch import enforces the maximum row count', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-limit-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  await assert.rejects(() => store.importBatch(Array.from({ length: 501 }, () => ({}))), /最多导入500/);
});

test('failed batch import is atomic', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-atomic-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  await assert.rejects(() => store.importBatch([
    { siteName: 'Valid', accountName: 'One', startUrl: 'https://example.com' },
    { siteName: '', accountName: 'Broken', startUrl: 'https://example.com' },
  ]), /缺少业务站名称/);
  assert.equal(store.data.sites.length, 0);
  assert.equal(store.data.accounts.length, 0);
});

test('batch import supports site-only rows and account rows together', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-mixed-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  const result = await store.importBatch([
    { siteName: 'Site Only', homeUrl: 'https://one.example' },
    { siteName: 'With Account', homeUrl: 'https://two.example', accountName: 'Operator A' },
  ]);
  assert.equal(result.sitesAdded, 2);
  assert.equal(result.accountsAdded, 1);
  assert.equal(store.data.sites.length, 2);
  assert.equal(store.data.accounts.length, 1);
});

test('removing accounts also removes their snapshots and restore IDs', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-remove-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  const site = await store.addSite({ name: 'Business', homeUrl: 'https://example.com' });
  const account = await store.addAccount({ siteId: site.id, name: 'Delete me' });
  store.data.snapshots.push({ id: 'snap', accountId: account.id });
  await store.setRestoreIds([account.id]);
  await store.removeAccounts([account.id]);
  assert.equal(store.data.accounts.length, 0);
  assert.equal(store.data.snapshots.length, 0);
  assert.deepEqual(store.data.restoreIds, []);
});

test('snapshot metadata can be removed when an account switches to incognito', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-private-snapshots-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  const site = await store.addSite({ name: 'Business', homeUrl: 'https://example.com' });
  const account = await store.addAccount({ siteId: site.id, name: 'Private later' });
  store.data.snapshots.push({ id: 'snap', accountId: account.id });
  await store.removeSnapshotsForAccounts([account.id]);
  assert.deepEqual(store.data.snapshots, []);
});

test('site editing persists its name, URL, logo and color', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-site-edit-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  const site = await store.addSite({ name: 'Before', homeUrl: 'https://before.example' });
  const logoDataUrl = 'data:image/webp;base64,UklGRg==';
  await store.updateSite(site.id, {
    name: 'After', homeUrl: 'https://after.example', logoDataUrl, color: 'orange',
  });
  const reloaded = new WorkspaceStore(directory);
  await reloaded.init();
  assert.equal(reloaded.findSite(site.id).name, 'After');
  assert.equal(reloaded.findSite(site.id).homeUrl, 'https://after.example/');
  assert.equal(reloaded.findSite(site.id).logoDataUrl, logoDataUrl);
  assert.equal(reloaded.findSite(site.id).color, 'orange');
});

test('pending deletion accounts and sites remain visible but cannot be restored', async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-pending-delete-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  await store.init();
  const site = await store.addSite({ name: 'Delete group', homeUrl: 'https://example.com' });
  const account = await store.addAccount({ siteId: site.id, name: 'Delete account', muted: true });
  await store.setRestoreIds([account.id]);
  await store.markAccountsPendingDeletion([account.id]);
  await store.markSitesPendingDeletion([site.id]);
  assert.equal(store.findAccount(account.id).pendingDeletion, true);
  assert.equal(store.findAccount(account.id).status, 'pending-delete');
  assert.equal(store.findAccount(account.id).muted, true);
  assert.equal(store.findSite(site.id).pendingDeletion, true);
  assert.deepEqual(store.data.restoreIds, []);
  await assert.rejects(() => store.updateAccount(account.id, { name: 'No' }), /等待下次启动删除/);
  await assert.rejects(() => store.updateSite(site.id, { name: 'No' }), /等待下次启动删除/);
});
