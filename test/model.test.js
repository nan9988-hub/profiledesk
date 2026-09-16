const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MOBILE_DEVICE_PROFILES,
  createAccount,
  createSite,
  normalizeAvatarDataUrl,
  normalizeEnvironment,
  normalizeProxy,
  normalizeStorageMode,
  normalizeUrl,
  publicAccount,
  resolveUserAgent,
} = require('../src/shared/model');

test('normalizes web URLs and rejects unsafe schemes', () => {
  assert.equal(normalizeUrl('example.com/login'), 'https://example.com/login');
  assert.throws(() => normalizeUrl('file:///tmp/private'), /仅允许/);
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /仅允许/);
});

test('creates an isolated account model with safe defaults', () => {
  const site = createSite({ name: 'Demo', homeUrl: 'https://example.com' });
  const account = createAccount({ name: 'Account A', username: 'alice' }, site);
  assert.equal(account.siteId, site.id);
  assert.equal(account.proxy.mode, 'system');
  assert.equal(account.autoLogin.submitAutomatically, false);
  assert.equal(account.environment.doNotTrack, true);
  assert.equal(account.environment.deviceType, 'desktop');
  assert.equal(account.environment.mobileDevice, 'pixel-11-pro');
  assert.equal(account.environment.browserPreset, 'system');
  assert.equal(account.storageMode, 'persistent');
});

test('normalizes persistent and incognito storage modes', () => {
  const site = createSite({ name: 'Demo', homeUrl: 'https://example.com' });
  assert.equal(createAccount({ name: 'Private', storageMode: 'incognito' }, site).storageMode, 'incognito');
  assert.equal(normalizeStorageMode('unknown'), 'persistent');
});

test('normalizes site colors and validates local avatar data', () => {
  const site = createSite({ name: 'Demo', homeUrl: 'https://example.com', color: 'purple' });
  const avatar = 'data:image/png;base64,iVBORw0KGgo=';
  const account = createAccount({ name: 'Avatar', avatarDataUrl: avatar }, site);
  assert.equal(site.color, 'purple');
  assert.equal(account.avatarDataUrl, avatar);
  assert.equal(createSite({ name: 'Fallback', homeUrl: 'https://example.com', color: 'unsafe' }).color, 'blue');
  assert.throws(() => normalizeAvatarDataUrl('data:image/svg+xml;base64,PHN2Zz4='), /格式无效/);
});

test('resolves desktop and mobile browser user-agent presets', () => {
  const desktopEdge = resolveUserAgent({ deviceType: 'desktop', browserPreset: 'edge' }, '152.1.2.3');
  const mobileChrome = resolveUserAgent({ deviceType: 'mobile', browserPreset: 'chrome' }, '152.1.2.3');
  const iphoneSafari = resolveUserAgent({ deviceType: 'mobile', mobileDevice: 'iphone-17-pro', browserPreset: 'system' }, '152.1.2.3');
  assert.match(desktopEdge, /Windows NT 10\.0/);
  assert.match(desktopEdge, /Edg\/152/);
  assert.match(mobileChrome, /Android 17; Pixel 11 Pro/);
  assert.match(mobileChrome, /Mobile Safari/);
  assert.match(iphoneSafari, /iPhone OS 26_0/);
  assert.match(iphoneSafari, /Version\/26\.0/);
  assert.equal(normalizeEnvironment({ deviceType: 'mobile', mobileDevice: 'unknown' }).mobileDevice, 'pixel-11-pro');
  assert.equal(resolveUserAgent(normalizeEnvironment({ browserPreset: 'system' })), '');
  assert.throws(() => normalizeEnvironment({ browserPreset: 'custom', userAgent: '' }), /不能为空/);
});

test('mobile device profiles use current Pixel 11 Pro and iPhone 17 Pro viewport metrics', () => {
  assert.deepEqual(MOBILE_DEVICE_PROFILES['pixel-11-pro'], {
    id: 'pixel-11-pro', label: 'Google Pixel 11 Pro', platform: 'android', width: 427, height: 952, deviceScaleFactor: 3,
  });
  assert.deepEqual(MOBILE_DEVICE_PROFILES['iphone-17-pro'], {
    id: 'iphone-17-pro', label: 'Apple iPhone 17 Pro', platform: 'ios', width: 402, height: 874, deviceScaleFactor: 3,
  });
});

test('public account never exposes secret references', () => {
  const site = createSite({ name: 'Demo', homeUrl: 'https://example.com' });
  const account = createAccount({
    name: 'Account A',
    proxy: { secretRef: 'proxy-secret' },
    autoLogin: { secretRef: 'login-secret' },
  }, site);
  const result = publicAccount(account);
  assert.equal(result.proxy.secretRef, '');
  assert.equal(result.autoLogin.secretRef, '');
  assert.equal(result.proxy.hasPassword, true);
  assert.equal(result.autoLogin.hasPassword, true);
});

test('normalizes unsupported proxy modes to system', () => {
  assert.deepEqual(normalizeProxy({ mode: 'pac_script', server: 'x' }).mode, 'system');
});
