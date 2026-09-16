const { randomUUID } = require('node:crypto');

const DEFAULT_ENVIRONMENT = Object.freeze({
  preset: 'privacy',
  deviceType: 'desktop',
  mobileDevice: 'pixel-11-pro',
  browserPreset: 'system',
  acceptLanguage: '',
  userAgent: '',
  doNotTrack: true,
  denyMediaPermissions: true,
});

const SITE_COLORS = Object.freeze(['blue', 'purple', 'green', 'orange', 'red', 'slate']);
const STORAGE_MODES = Object.freeze(['persistent', 'incognito']);
const DEVICE_TYPES = Object.freeze(['desktop', 'mobile']);
const MOBILE_DEVICE_PROFILES = Object.freeze({
  'pixel-11-pro': Object.freeze({
    id: 'pixel-11-pro',
    label: 'Google Pixel 11 Pro',
    platform: 'android',
    width: 427,
    height: 952,
    deviceScaleFactor: 3,
  }),
  'iphone-17-pro': Object.freeze({
    id: 'iphone-17-pro',
    label: 'Apple iPhone 17 Pro',
    platform: 'ios',
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
  }),
});
const MOBILE_DEVICES = Object.freeze(Object.keys(MOBILE_DEVICE_PROFILES));
const BROWSER_PRESETS = Object.freeze(['system', 'chrome', 'edge', 'firefox', 'safari', 'custom']);
const MAX_AVATAR_DATA_URL_LENGTH = 150 * 1024;

const DEFAULT_PROXY = Object.freeze({
  mode: 'system',
  server: '',
  bypassRules: '<local>',
  username: '',
  secretRef: '',
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeUrl(input) {
  const value = String(input || '').trim();
  if (!value) return 'https://example.com/';
  const explicitScheme = value.match(/^([a-z][a-z\d+.-]*):/i)?.[1]?.toLowerCase();
  if (explicitScheme && !['http', 'https'].includes(explicitScheme)) {
    throw new Error('仅允许 HTTP 或 HTTPS 地址');
  }
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('网址格式无效');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('仅允许 HTTP 或 HTTPS 地址');
  }
  return parsed.toString();
}

function normalizeProxy(value = {}) {
  const mode = ['system', 'direct', 'fixed_servers'].includes(value.mode)
    ? value.mode
    : 'system';
  return {
    ...DEFAULT_PROXY,
    ...value,
    mode,
    server: String(value.server || '').trim(),
    bypassRules: String(value.bypassRules || '<local>').trim(),
    username: String(value.username || '').trim(),
    secretRef: String(value.secretRef || '').trim(),
  };
}

function normalizeStorageMode(value) {
  return STORAGE_MODES.includes(value) ? value : 'persistent';
}

function normalizeEnvironment(value = {}) {
  const acceptLanguage = String(value.acceptLanguage || '').trim();
  if (acceptLanguage && !/^[A-Za-z0-9,;=._* -]{1,200}$/.test(acceptLanguage)) {
    throw new Error('浏览器语言格式无效');
  }
  const deviceType = DEVICE_TYPES.includes(value.deviceType) ? value.deviceType : 'desktop';
  const mobileDevice = MOBILE_DEVICES.includes(value.mobileDevice) ? value.mobileDevice : 'pixel-11-pro';
  const browserPreset = BROWSER_PRESETS.includes(value.browserPreset) ? value.browserPreset : 'system';
  const userAgent = String(value.userAgent || '').replace(/[\r\n]/g, '').trim().slice(0, 512);
  if (browserPreset === 'custom' && !userAgent) throw new Error('自定义 User-Agent 不能为空');
  return {
    ...DEFAULT_ENVIRONMENT,
    preset: 'privacy',
    deviceType,
    mobileDevice,
    browserPreset,
    acceptLanguage,
    userAgent,
    doNotTrack: value.doNotTrack !== false,
    denyMediaPermissions: value.denyMediaPermissions !== false,
  };
}

function normalizeAvatarDataUrl(value) {
  const avatar = String(value || '').trim();
  if (!avatar) return '';
  if (avatar.length > MAX_AVATAR_DATA_URL_LENGTH) throw new Error('账户头像数据过大');
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar)) {
    throw new Error('账户头像格式无效');
  }
  return avatar;
}

function resolveUserAgent(environment = {}, chromiumVersion = process.versions.chrome || '152.0.0.0') {
  const normalized = normalizeEnvironment(environment);
  if (normalized.browserPreset === 'system' && normalized.deviceType === 'desktop') return '';
  if (normalized.browserPreset === 'custom') return normalized.userAgent;
  const chromiumMajor = String(chromiumVersion).match(/^\d+/)?.[0] || '152';
  if (normalized.deviceType === 'mobile') {
    const isIphone = normalized.mobileDevice === 'iphone-17-pro';
    const preset = normalized.browserPreset === 'system'
      ? (isIphone ? 'safari' : 'chrome')
      : normalized.browserPreset;
    if (isIphone) {
      if (preset === 'chrome') {
        return `Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/${chromiumMajor}.0.0.0 Mobile/15E148 Safari/604.1`;
      }
      if (preset === 'edge') {
        return `Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/${chromiumMajor}.0.0.0 Mobile/15E148 Safari/605.1.15`;
      }
      if (preset === 'firefox') {
        return 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/147.0 Mobile/15E148 Safari/605.1.15';
      }
      return 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
    }
    if (preset === 'firefox') {
      return 'Mozilla/5.0 (Android 17; Mobile; Pixel 11 Pro; rv:147.0) Gecko/147.0 Firefox/147.0';
    }
    const edgeSuffix = preset === 'edge' ? ` EdgA/${chromiumMajor}.0.0.0` : '';
    return `Mozilla/5.0 (Linux; Android 17; Pixel 11 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumMajor}.0.0.0 Mobile Safari/537.36${edgeSuffix}`;
  }
  if (normalized.browserPreset === 'firefox') {
    return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:147.0) Gecko/20100101 Firefox/147.0';
  }
  if (normalized.browserPreset === 'safari') {
    return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  }
  const edgeSuffix = normalized.browserPreset === 'edge' ? ` Edg/${chromiumMajor}.0.0.0` : '';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromiumMajor}.0.0.0 Safari/537.36${edgeSuffix}`;
}

function normalizeAutoLogin(value = {}, startUrl) {
  const limited = (input) => String(input || '').trim().slice(0, 300);
  return {
    enabled: Boolean(value.enabled),
    loginUrl: value.loginUrl ? normalizeUrl(value.loginUrl) : startUrl,
    usernameSelector: limited(value.usernameSelector),
    passwordSelector: limited(value.passwordSelector),
    submitSelector: limited(value.submitSelector),
    submitAutomatically: false,
    secretRef: String(value.secretRef || '').trim(),
  };
}

function createSite(input = {}) {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('业务站名称不能为空');
  return {
    id: input.id || randomUUID(),
    name,
    homeUrl: normalizeUrl(input.homeUrl),
    color: SITE_COLORS.includes(input.color) ? input.color : 'blue',
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    note: String(input.note || ''),
    createdAt: input.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function createAccount(input = {}, site) {
  if (!site) throw new Error('找不到所属业务站');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('账户名称不能为空');
  const startUrl = normalizeUrl(input.startUrl || site.homeUrl);
  return {
    id: input.id || randomUUID(),
    siteId: site.id,
    name,
    avatarDataUrl: normalizeAvatarDataUrl(input.avatarDataUrl),
    username: String(input.username || '').trim(),
    startUrl,
    currentUrl: startUrl,
    tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
    note: String(input.note || ''),
    storageMode: normalizeStorageMode(input.storageMode),
    proxy: normalizeProxy(input.proxy),
    environment: normalizeEnvironment(input.environment),
    autoLogin: normalizeAutoLogin(input.autoLogin, startUrl),
    status: 'stopped',
    lastError: '',
    lastOpenedAt: null,
    createdAt: input.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

function publicAccount(account) {
  return {
    ...account,
    proxy: { ...account.proxy, hasPassword: Boolean(account.proxy?.secretRef), secretRef: '' },
    autoLogin: {
      ...account.autoLogin,
      hasPassword: Boolean(account.autoLogin?.secretRef),
      secretRef: '',
    },
  };
}

module.exports = {
  DEFAULT_ENVIRONMENT,
  DEFAULT_PROXY,
  BROWSER_PRESETS,
  DEVICE_TYPES,
  MOBILE_DEVICES,
  MOBILE_DEVICE_PROFILES,
  MAX_AVATAR_DATA_URL_LENGTH,
  SITE_COLORS,
  STORAGE_MODES,
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
  resolveUserAgent,
};
