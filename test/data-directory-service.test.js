const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DataDirectoryService } = require('../src/main/data-directory-service');

test('data directory migration preserves data and removes the old root', async (t) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-data-'));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const userData = path.join(parent, 'user-data');
  const destinationBase = path.join(parent, 'custom');
  const service = new DataDirectoryService(userData);
  const source = await service.init();
  await fs.promises.writeFile(path.join(source, 'sample.txt'), 'preserved');
  await service.scheduleMigration(source, destinationBase);

  const restarted = new DataDirectoryService(userData);
  const target = await restarted.init();
  assert.equal(target, path.join(destinationBase, 'ProfileDeskData'));
  assert.equal(await fs.promises.readFile(path.join(target, 'sample.txt'), 'utf8'), 'preserved');
  await assert.rejects(() => fs.promises.access(source));
});

test('scheduled wipe removes all data and recreates an owned empty root', async (t) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-wipe-'));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const userData = path.join(parent, 'user-data');
  const service = new DataDirectoryService(userData);
  const root = await service.init();
  await fs.promises.writeFile(path.join(root, 'secret.txt'), 'sensitive');
  await service.scheduleWipe(root);

  const restarted = new DataDirectoryService(userData);
  const recreated = await restarted.init();
  assert.equal(recreated, root);
  await assert.rejects(() => fs.promises.access(path.join(root, 'secret.txt')));
  assert.equal(JSON.parse(await fs.promises.readFile(path.join(root, '.profiledesk-data-root.json'), 'utf8')).app, 'ProfileDesk');
});

test('wipe refuses a directory without the matching ownership marker', async (t) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-wipe-safety-'));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const userData = path.join(parent, 'user-data');
  const unrelated = path.join(parent, 'unrelated', 'ProfileDeskData');
  await fs.promises.mkdir(userData, { recursive: true });
  await fs.promises.mkdir(unrelated, { recursive: true });
  await fs.promises.writeFile(path.join(unrelated, 'important.txt'), 'keep');
  await fs.promises.writeFile(path.join(userData, 'profiledesk-location.json'), JSON.stringify({
    version: 1,
    activeRoot: unrelated,
    rootToken: 'not-owned',
    pendingWipe: unrelated,
  }));
  const service = new DataDirectoryService(userData);
  await assert.rejects(() => service.init());
  assert.equal(await fs.promises.readFile(path.join(unrelated, 'important.txt'), 'utf8'), 'keep');
});

test('pending account data is deleted before browser sessions start', async (t) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-account-cleanup-'));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const userData = path.join(parent, 'user-data');
  const service = new DataDirectoryService(userData);
  const root = await service.init();
  const profile = path.join(root, 'profiles', 'account-id');
  const download = path.join(root, 'downloads', 'account-id');
  await fs.promises.mkdir(profile, { recursive: true });
  await fs.promises.mkdir(download, { recursive: true });
  await fs.promises.writeFile(path.join(profile, 'Cookies'), 'locked-before-restart');
  await fs.promises.writeFile(path.join(download, 'file.txt'), 'download');
  await service.scheduleAccountDataRemoval(root, [profile, download]);

  const restarted = new DataDirectoryService(userData);
  await restarted.init();
  await assert.rejects(() => fs.promises.access(profile));
  await assert.rejects(() => fs.promises.access(download));
});

test('pending account cleanup rejects paths outside profile and download roots', async (t) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-account-cleanup-safety-'));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const service = new DataDirectoryService(path.join(parent, 'user-data'));
  const root = await service.init();
  await assert.rejects(() => service.scheduleAccountDataRemoval(root, [path.join(parent, 'unrelated')]));
});

test('startup account cleanup can remove validated profile paths immediately', async (t) => {
  const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'profiledesk-account-cleanup-now-'));
  t.after(() => fs.promises.rm(parent, { recursive: true, force: true }));
  const service = new DataDirectoryService(path.join(parent, 'user-data'));
  const root = await service.init();
  const profile = path.join(root, 'profiles', 'pending-account');
  await fs.promises.mkdir(profile, { recursive: true });
  await fs.promises.writeFile(path.join(profile, 'Cache'), 'remove-on-start');
  const result = await service.removeAccountDataNow(root, [profile]);
  assert.equal(result.removed, 1);
  assert.deepEqual(result.pendingPaths, []);
  await assert.rejects(() => fs.promises.access(profile));
});
