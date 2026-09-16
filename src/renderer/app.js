const api = window.profileDesk;

let workspace = { sites: [], accounts: [], snapshots: [] };
let activeAccountId = '';
let selectedIds = new Set();
let editorSave = null;
let toastTimer = null;
let appSettings = {
  launchPasswordEnabled: false,
  dataDirectory: '',
  logDirectory: '',
  maxRunningAccounts: 8,
  idleStopMinutes: 30,
  memoryLimitMb: 4096,
  shortcuts: {
    showHide: 'CommandOrControl+Shift+P',
    nextAccount: 'CommandOrControl+Shift+Right',
    previousAccount: 'CommandOrControl+Shift+Left',
    toggleSidebar: 'CommandOrControl+Shift+B',
  },
};
const SIDEBAR_AVATAR_SIZE = 38;
const SIDEBAR_MIN_WIDTH = Math.ceil(SIDEBAR_AVATAR_SIZE * 1.5) + 14;
const SIDEBAR_COMPACT_WIDTH = 104;
const SIDEBAR_COMPACT_THRESHOLD = 176;
const SIDEBAR_DEFAULT_WIDTH = 292;
const savedSidebarWidth = Number.parseInt(localStorage.getItem('profiledesk.sidebarWidth'), 10);
let sidebarCollapsed = localStorage.getItem('profiledesk.sidebarCollapsed') === '1';
let sidebarWidth = Number.isFinite(savedSidebarWidth)
  ? savedSidebarWidth
  : (sidebarCollapsed ? SIDEBAR_COMPACT_WIDTH : SIDEBAR_DEFAULT_WIDTH);
let expandedSidebarWidth = Math.max(SIDEBAR_DEFAULT_WIDTH, sidebarWidth);
let boundsFrame = 0;
let collapsedSiteIds = new Set();
try {
  const savedSites = JSON.parse(localStorage.getItem('profiledesk.collapsedSites') || '[]');
  if (Array.isArray(savedSites)) collapsedSiteIds = new Set(savedSites.map(String));
} catch {
  localStorage.removeItem('profiledesk.collapsedSites');
}

const $ = (selector) => document.querySelector(selector);
const accountById = (id) => workspace.accounts.find((account) => account.id === id);
const siteById = (id) => workspace.sites.find((site) => site.id === id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function friendlyError(error) {
  return String(error?.message || error || '操作失败')
    .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/i, '');
}

function initial(value) {
  return Array.from(String(value || '?').trim())[0]?.toUpperCase() || '?';
}

const SITE_COLOR_OPTIONS = [
  ['blue', '深蓝'],
  ['purple', '紫色'],
  ['green', '绿色'],
  ['orange', '橙色'],
  ['red', '红色'],
  ['slate', '灰蓝'],
];

function safeSiteColor(value) {
  return SITE_COLOR_OPTIONS.some(([id]) => id === value) ? value : 'blue';
}

function safeAvatarDataUrl(value) {
  const dataUrl = String(value || '');
  return dataUrl.length <= 150 * 1024
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)
    ? dataUrl
    : '';
}

function avatarContent(dataUrl, name) {
  const safe = safeAvatarDataUrl(dataUrl);
  return safe
    ? `<img src="${escapeHtml(safe)}" alt="${escapeHtml(name)}">`
    : `<span>${escapeHtml(initial(name))}</span>`;
}

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = String(message);
  toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 3500);
}

function setBusy(message) {
  $('#status-message').textContent = message || '就绪';
}

async function act(label, operation) {
  try {
    setBusy(label);
    const value = await operation();
    setBusy('就绪');
    return value;
  } catch (error) {
    setBusy('操作失败');
    showToast(friendlyError(error), true);
    throw error;
  }
}

function refreshWorkspace(next) {
  workspace = next;
  const valid = new Set(workspace.accounts.filter((account) => !account.pendingDeletion).map((account) => account.id));
  selectedIds = new Set([...selectedIds].filter((id) => valid.has(id)));
  if (activeAccountId && !valid.has(activeAccountId)) activeAccountId = '';
  renderTree();
  syncActiveUi();
}

function renderTree() {
  const query = $('#search').value.trim().toLowerCase();
  const tree = $('#account-tree');
  const blocks = [];
  for (const site of workspace.sites) {
    const accounts = workspace.accounts.filter((account) => account.siteId === site.id);
    const matching = accounts.filter((account) => {
      const haystack = [site.name, account.name, account.username, ...(account.tags || [])].join(' ').toLowerCase();
      return !query || haystack.includes(query);
    });
    if (query && !matching.length && !site.name.toLowerCase().includes(query)) continue;
    const isCollapsed = collapsedSiteIds.has(site.id) && !query;
    blocks.push(`<section class="site-group${isCollapsed ? ' is-collapsed' : ''}${site.pendingDeletion ? ' pending-deletion' : ''}">
      <div class="site-heading site-color-${safeSiteColor(site.color)}" data-toggle-site="${site.id}" data-site-id="${site.id}" title="${escapeHtml(site.name)}${site.pendingDeletion ? ' · 等待下次启动删除' : ' · 右键编辑'}">
        <span class="site-arrow">▾</span><span class="site-icon">${avatarContent(site.logoDataUrl, site.name)}</span><span class="site-name">${escapeHtml(site.name)}${site.pendingDeletion ? ' · 待删除' : ''}</span><span class="count">${accounts.length}</span>
      </div>
      <div class="site-accounts">${matching.map((account) => `<div class="account-row${account.id === activeAccountId ? ' active' : ''}${account.storageMode === 'incognito' ? ' incognito' : ''}${account.pendingDeletion ? ' pending-deletion' : ''}" data-account-id="${account.id}" title="${escapeHtml(account.name)} · ${account.pendingDeletion ? '等待下次启动删除' : `${account.storageMode === 'incognito' ? '无痕账户 · ' : ''}${escapeHtml(account.username || account.startUrl)} · 右键编辑`}">
        ${account.pendingDeletion ? '<span class="pending-placeholder">×</span>' : `<input type="checkbox" data-select-account="${account.id}" ${selectedIds.has(account.id) ? 'checked' : ''} aria-label="选择${escapeHtml(account.name)}">`}
        <span class="account-avatar">${avatarContent(account.avatarDataUrl, account.name)}</span>
        <span class="dot ${escapeHtml(account.status)}"></span>
        <div class="account-main"><strong>${escapeHtml(account.name)}${account.storageMode === 'incognito' ? '<em class="privacy-badge">无痕</em>' : ''}</strong><span>${account.pendingDeletion ? '下次启动自动清除' : escapeHtml(account.username || account.startUrl)}</span></div>
        ${account.pendingDeletion ? '<span class="pending-label">待清理</span>' : `<button class="row-delete" data-delete-account="${account.id}" title="删除账户" aria-label="删除${escapeHtml(account.name)}">删</button>`}
      </div>`).join('')}</div>
    </section>`);
  }
  tree.innerHTML = blocks.join('') || '<div class="empty-state-small">暂无账户，点击上方按钮添加。</div>';
  $('#selected-count').textContent = selectedIds.size;
  const selectableCount = workspace.accounts.filter((account) => !account.pendingDeletion).length;
  $('#select-all').checked = Boolean(selectableCount) && selectedIds.size === selectableCount;
}

function maximumSidebarWidth() {
  return Math.max(SIDEBAR_MIN_WIDTH, window.innerWidth - 560);
}

function updateSidebarState({ persist = true } = {}) {
  sidebarWidth = Math.min(maximumSidebarWidth(), Math.max(SIDEBAR_MIN_WIDTH, Math.round(sidebarWidth)));
  sidebarCollapsed = sidebarWidth < SIDEBAR_COMPACT_THRESHOLD;
  const compactProgress = Math.min(1, Math.max(0, (sidebarWidth - SIDEBAR_MIN_WIDTH) / (SIDEBAR_COMPACT_THRESHOLD - SIDEBAR_MIN_WIDTH)));
  const compactFontSize = (8.5 + compactProgress * 2.5).toFixed(2);
  document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
  document.documentElement.style.setProperty('--compact-site-font-size', `${compactFontSize}px`);
  $('#app').classList.toggle('sidebar-collapsed', sidebarCollapsed);
  $('#toggle-sidebar').title = sidebarCollapsed ? '展开账户栏' : '收起账户栏';
  $('#toggle-sidebar').setAttribute('aria-label', sidebarCollapsed ? '展开账户栏' : '收起账户栏');
  $('#sidebar-resizer').setAttribute('aria-valuenow', String(sidebarWidth));
  $('#sidebar-resizer').setAttribute('aria-valuemax', String(maximumSidebarWidth()));
  if (persist) {
    localStorage.setItem('profiledesk.sidebarWidth', String(sidebarWidth));
    localStorage.setItem('profiledesk.sidebarCollapsed', sidebarCollapsed ? '1' : '0');
  }
  requestBrowserBounds();
}

function toggleSidebar() {
  if (sidebarCollapsed) {
    sidebarWidth = Math.max(SIDEBAR_COMPACT_THRESHOLD, expandedSidebarWidth);
  } else {
    expandedSidebarWidth = sidebarWidth;
    sidebarWidth = SIDEBAR_COMPACT_WIDTH;
  }
  updateSidebarState();
}

function bindSidebarResizer() {
  const resizer = $('#sidebar-resizer');
  let activePointerId = null;
  const resizeTo = (clientX, persist = false) => {
    sidebarWidth = Math.min(maximumSidebarWidth(), Math.max(SIDEBAR_MIN_WIDTH, clientX));
    if (sidebarWidth >= SIDEBAR_COMPACT_THRESHOLD) expandedSidebarWidth = sidebarWidth;
    updateSidebarState({ persist });
  };
  resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    activePointerId = event.pointerId;
    resizer.setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-sidebar');
    event.preventDefault();
  });
  resizer.addEventListener('pointermove', (event) => {
    if (event.pointerId !== activePointerId) return;
    resizeTo(event.clientX);
  });
  const finish = (event) => {
    if (event.pointerId !== activePointerId) return;
    activePointerId = null;
    document.body.classList.remove('resizing-sidebar');
    updateSidebarState();
  };
  resizer.addEventListener('pointerup', finish);
  resizer.addEventListener('pointercancel', finish);
  resizer.addEventListener('dblclick', () => {
    sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
    expandedSidebarWidth = SIDEBAR_DEFAULT_WIDTH;
    updateSidebarState();
  });
  resizer.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    if (event.key === 'Home') sidebarWidth = SIDEBAR_DEFAULT_WIDTH;
    else sidebarWidth += event.key === 'ArrowLeft' ? -8 : 8;
    if (sidebarWidth >= SIDEBAR_COMPACT_THRESHOLD) expandedSidebarWidth = sidebarWidth;
    updateSidebarState();
    event.preventDefault();
  });
}

function syncActiveUi() {
  const account = accountById(activeAccountId);
  $('#empty-state').hidden = Boolean(account);
  $('#active-label').textContent = account ? `${siteById(account.siteId)?.name || ''} / ${account.name}${account.storageMode === 'incognito' ? ' · 无痕' : ''}` : '未选择账户';
  $('#create-snapshot').disabled = !account || account.storageMode === 'incognito';
  $('#create-snapshot').title = account?.storageMode === 'incognito' ? '无痕账户不会保存状态快照' : '保存当前账户状态快照';
  $('#sound-toggle').disabled = !account || account.pendingDeletion;
  $('#sound-toggle').textContent = account?.muted ? '🔇' : '🔊';
  $('#sound-toggle').title = account?.muted ? '当前账户已静音，点击恢复声音' : '点击将当前账户静音';
  if (account) {
    if (document.activeElement !== $('#address')) $('#address').value = account.currentUrl || account.startUrl;
    $('#proxy-mode').value = account.proxy?.mode || 'system';
    $('#security-indicator').textContent = (account.currentUrl || account.startUrl).startsWith('https:') ? '●' : '○';
    $('#security-indicator').title = (account.currentUrl || account.startUrl).startsWith('https:') ? 'HTTPS连接' : '非HTTPS连接';
  } else {
    $('#address').value = '';
    $('#proxy-mode').value = 'system';
    $('#security-indicator').textContent = '—';
  }
  requestBrowserBounds();
}

function requestBrowserBounds() {
  if (boundsFrame) cancelAnimationFrame(boundsFrame);
  boundsFrame = requestAnimationFrame(() => {
    boundsFrame = 0;
    const stage = $('#browser-stage');
    const modalOpen = Boolean(document.querySelector('dialog[open]'));
    const rect = stage.getBoundingClientRect();
    const bounds = modalOpen
      ? { x: 0, y: 0, width: 1, height: 1 }
      : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    api.setBounds(bounds).catch(() => {});
  });
}

async function activateAccount(id) {
  const account = accountById(id);
  if (!account) return;
  if (account.pendingDeletion) return showToast('该账户将在下次启动时删除，当前不可打开', true);
  activeAccountId = id;
  renderTree();
  syncActiveUi();
  await act(`正在打开 ${account.name}…`, async () => {
    await api.start(id);
    await api.activate(id);
    requestBrowserBounds();
  });
}

function field(label, name, value = '', type = 'text', extra = '') {
  return `<label for="field-${name}">${escapeHtml(label)}</label><input id="field-${name}" name="${name}" type="${type}" value="${escapeHtml(value)}" ${extra}>`;
}

function selectField(label, name, value, options) {
  const items = options.map(([optionValue, optionLabel]) => (
    `<option value="${escapeHtml(optionValue)}" ${optionValue === value ? 'selected' : ''}>${escapeHtml(optionLabel)}</option>`
  )).join('');
  return `<label for="field-${name}">${escapeHtml(label)}</label><select id="field-${name}" name="${name}">${items}</select>`;
}

function avatarField(dataUrl = '', name = '账户', options = {}) {
  const safe = safeAvatarDataUrl(dataUrl);
  const inputName = options.inputName || 'avatarDataUrl';
  const label = options.label || '账户头像';
  const subject = options.subject || '头像';
  return `<label>${escapeHtml(label)}</label><div class="avatar-picker">
    <span class="avatar-preview" data-avatar-preview>${avatarContent(safe, name)}</span>
    <div class="avatar-buttons"><button type="button" data-pick-avatar>本地上传</button><button type="button" data-remove-avatar ${safe ? '' : 'disabled'}>移除</button></div>
    <input type="hidden" name="${escapeHtml(inputName)}" value="${escapeHtml(safe)}">
    <input type="file" data-avatar-file accept="image/png,image/jpeg,image/webp" hidden>
  </div><span></span><span class="hint">${escapeHtml(subject)}支持PNG、JPG、WebP，原图最大5MB；保存前自动裁剪压缩为128×128，仅保存在本地数据中。</span>`;
}

async function avatarDataFromFile(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('头像只支持PNG、JPG或WebP');
  if (file.size > 5 * 1024 * 1024) throw new Error('头像原图不能超过5MB');
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('无法读取头像图片'));
      image.src = objectUrl;
    });
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error('头像图片尺寸无效');
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#17263a';
    context.fillRect(0, 0, 128, 128);
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      128,
      128,
    );
    const result = canvas.toDataURL('image/webp', 0.82);
    if (!safeAvatarDataUrl(result)) throw new Error('头像压缩后仍然过大');
    return result;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function bindAvatarPicker(inputName = 'avatarDataUrl') {
  const root = $('#editor-fields');
  const fileInput = root.querySelector('[data-avatar-file]');
  if (!fileInput) return;
  const valueInput = root.querySelector(`[name="${inputName}"]`);
  const preview = root.querySelector('[data-avatar-preview]');
  const removeButton = root.querySelector('[data-remove-avatar]');
  const nameInput = root.querySelector('[name="name"]');
  const renderPreview = () => {
    preview.innerHTML = avatarContent(valueInput.value, nameInput?.value || '账户');
    removeButton.disabled = !valueInput.value;
  };
  root.querySelector('[data-pick-avatar]').addEventListener('click', () => fileInput.click());
  removeButton.addEventListener('click', () => {
    valueInput.value = '';
    fileInput.value = '';
    renderPreview();
  });
  nameInput?.addEventListener('input', () => {
    if (!valueInput.value) renderPreview();
  });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      valueInput.value = await avatarDataFromFile(file);
      renderPreview();
    } catch (error) {
      fileInput.value = '';
      showToast(friendlyError(error), true);
    }
  });
}

function bindUserAgentFields() {
  const root = $('#editor-fields');
  const deviceType = root.querySelector('[name="deviceType"]');
  const mobileDevice = root.querySelector('[name="mobileDevice"]');
  const preset = root.querySelector('[name="browserPreset"]');
  const custom = root.querySelector('[name="userAgent"]');
  if (!preset || !custom) return;
  const sync = () => {
    custom.readOnly = preset.value !== 'custom';
    custom.placeholder = preset.value === 'custom'
      ? '输入完整User-Agent'
      : '当前使用内置预设；选择“自定义”后可编辑';
    if (mobileDevice) {
      const mobile = deviceType?.value === 'mobile';
      mobileDevice.closest('.device-field')?.classList.toggle('is-inactive', !mobile);
      mobileDevice.title = mobile ? '保存后按此设备尺寸刷新当前页面' : '切换到移动设备后生效';
    }
  };
  deviceType?.addEventListener('change', sync);
  mobileDevice?.addEventListener('change', sync);
  preset.addEventListener('change', sync);
  sync();
}

function checkField(label, name, checked, hint = '') {
  return `<label for="field-${name}">${escapeHtml(label)}</label><label><input id="field-${name}" name="${name}" type="checkbox" ${checked ? 'checked' : ''}> 启用</label>${hint ? `<span class="hint">${escapeHtml(hint)}</span>` : ''}`;
}

function openEditor(title, fields, save) {
  $('#editor-title').textContent = title;
  $('#editor-fields').innerHTML = fields;
  editorSave = save;
  const deleteButton = $('#editor-delete-item');
  deleteButton.hidden = true;
  deleteButton.onclick = null;
  deleteButton.textContent = '删除';
  $('#editor-dialog').showModal();
  requestBrowserBounds();
  $('#editor-fields input, #editor-fields select')?.focus();
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
  requestAnimationFrame(requestBrowserBounds);
}

function addSite() {
  openEditor('添加业务站', [
    field('业务站名称', 'name', '', 'text', 'required maxlength="80"'),
    field('首页地址', 'homeUrl', 'https://', 'url', 'required'),
    avatarField('', '业务站', { inputName: 'logoDataUrl', label: '业务站LOGO', subject: '业务站图标' }),
    selectField('折叠背景色', 'color', 'blue', SITE_COLOR_OPTIONS),
  ].join(''), async (data) => {
    await api.addSite({
      name: data.get('name'),
      homeUrl: data.get('homeUrl'),
      logoDataUrl: data.get('logoDataUrl'),
      color: data.get('color'),
    });
    showToast('业务站已添加');
  });
  bindAvatarPicker('logoDataUrl');
}

function editSite(siteId) {
  const site = siteById(siteId);
  if (!site || site.pendingDeletion) return showToast('该业务站将在下次启动时删除', true);
  openEditor(`编辑业务站 · ${site.name}`, [
    field('业务站名称', 'name', site.name, 'text', 'required maxlength="80"'),
    field('首页地址', 'homeUrl', site.homeUrl, 'url', 'required'),
    avatarField(site.logoDataUrl, site.name, { inputName: 'logoDataUrl', label: '业务站LOGO', subject: '业务站图标' }),
    selectField('折叠背景色', 'color', safeSiteColor(site.color), SITE_COLOR_OPTIONS),
    '<span></span><span class="hint">修改业务站首页不会自动覆盖现有账户各自的启动地址。</span>',
  ].join(''), async (data) => {
    await api.updateSite(site.id, Object.fromEntries(data));
    showToast('业务站配置已保存');
  });
  bindAvatarPicker('logoDataUrl');
  const deleteButton = $('#editor-delete-item');
  deleteButton.hidden = false;
  deleteButton.textContent = '删除业务站';
  deleteButton.onclick = async () => {
    closeDialog($('#editor-dialog'));
    const result = await act(`正在处理 ${site.name}…`, () => api.deleteSite(site.id));
    if (!result.canceled) showToast('业务站及其账户已置灰，将在下次启动时自动清除');
  };
}

function addAccount() {
  if (!workspace.sites.length) return addSite();
  const options = workspace.sites.map((site) => `<option value="${site.id}">${escapeHtml(site.name)}</option>`).join('');
  openEditor('添加隔离账户', [
    `<label for="field-siteId">所属业务站</label><select id="field-siteId" name="siteId">${options}</select>`,
    field('账户名称', 'name', '', 'text', 'required maxlength="80"'),
    avatarField('', '账户'),
    field('登录名/标识', 'username'),
    field('启动地址', 'startUrl', workspace.sites[0].homeUrl, 'url', 'required'),
    selectField('浏览数据模式', 'storageMode', 'persistent', [
      ['persistent', '持久模式（保留登录）'],
      ['incognito', '无痕模式（关闭即清除）'],
    ]),
    '<span></span><span class="hint">无痕账户停止、退出软件或崩溃后会清除Cookie、缓存及站点存储，不会自动恢复；手动下载的文件仍会保留。</span>',
  ].join(''), async (data) => {
    const result = await api.addAccount(Object.fromEntries(data));
    selectedIds.add(result.id);
    showToast('隔离账户已创建');
    await activateAccount(result.id);
  });
  bindAvatarPicker();
}

function editAccount(accountId = activeAccountId) {
  const account = accountById(accountId);
  if (!account) return showToast('请先选择账户', true);
  if (account.pendingDeletion) return showToast('该账户将在下次启动时删除', true);
  const env = account.environment || {};
  const login = account.autoLogin || {};
  openEditor(`环境与登录 · ${account.name}`, [
    field('账户名称', 'name', account.name, 'text', 'required maxlength="80"'),
    avatarField(account.avatarDataUrl, account.name),
    field('登录名', 'username', account.username),
    field('启动地址', 'startUrl', account.startUrl, 'url', 'required'),
    selectField('浏览数据模式', 'storageMode', account.storageMode || 'persistent', [
      ['persistent', '持久模式（保留登录）'],
      ['incognito', '无痕模式（关闭即清除）'],
    ]),
    '<span></span><span class="hint">切换模式会先停止账户并清除原浏览会话及已有快照。无痕模式不保存Cookie、缓存、站点存储、浏览位置或状态快照；下载文件和账户配置仍保留。</span>',
    selectField('设备类型', 'deviceType', env.deviceType || 'desktop', [
      ['desktop', 'PC桌面设备'],
      ['mobile', '移动设备'],
    ]),
    `<div class="device-field"><label for="field-mobileDevice">移动设备型号</label><select id="field-mobileDevice" name="mobileDevice">
      <option value="pixel-11-pro" ${(env.mobileDevice || 'pixel-11-pro') === 'pixel-11-pro' ? 'selected' : ''}>Google Pixel 11 Pro · Android 17</option>
      <option value="iphone-17-pro" ${env.mobileDevice === 'iphone-17-pro' ? 'selected' : ''}>Apple iPhone 17 Pro</option>
    </select></div>`,
    selectField('浏览器UA', 'browserPreset', env.browserPreset || 'system', [
      ['system', '自动匹配设备（推荐）'],
      ['chrome', 'Chrome'],
      ['edge', 'Microsoft Edge'],
      ['firefox', 'Firefox兼容标识'],
      ['safari', 'Safari兼容标识（iPhone）'],
      ['custom', '自定义User-Agent'],
    ]),
    field('浏览器语言', 'acceptLanguage', env.acceptLanguage, 'text', 'placeholder="zh-CN,zh;q=0.9,en;q=0.8"'),
    field('自定义User-Agent', 'userAgent', env.userAgent, 'text', 'maxlength="512"'),
    '<span></span><span class="hint">移动模式会应用对应设备宽度的兼容视口和移动UA，并在保存后自动刷新；网页本身仍需支持响应式移动布局。为保证Windows稳定性，不调用Chromium实验性设备模拟接口。</span>',
    checkField('拒绝跟踪', 'doNotTrack', env.doNotTrack, '向网站发送DNT请求头'),
    checkField('自动填充', 'autoLogin', login.enabled, '仅在完全匹配的HTTPS来源填充，不自动提交'),
    field('登录页地址', 'loginUrl', login.loginUrl || account.startUrl, 'url'),
    field('用户名选择器', 'usernameSelector', login.usernameSelector, 'text', 'placeholder="例如 input[name=email]"'),
    field('密码选择器', 'passwordSelector', login.passwordSelector, 'text', 'placeholder="例如 input[type=password]"'),
    field('登录密码', 'password', '', 'password', `placeholder="${login.hasPassword ? '已安全保存；留空保留' : '存入系统安全存储'}" autocomplete="new-password"`),
  ].join(''), async (data) => {
    const next = Object.fromEntries(data);
    const saved = await api.updateAccount(account.id, {
      name: next.name,
      avatarDataUrl: next.avatarDataUrl,
      username: next.username,
      startUrl: next.startUrl,
      storageMode: next.storageMode,
      environment: {
        ...env,
        deviceType: next.deviceType,
        mobileDevice: next.mobileDevice,
        browserPreset: next.browserPreset,
        acceptLanguage: next.acceptLanguage,
        userAgent: next.userAgent,
        doNotTrack: data.has('doNotTrack'),
      },
      autoLogin: {
        ...login,
        enabled: data.has('autoLogin'),
        loginUrl: next.loginUrl,
        usernameSelector: next.usernameSelector,
        passwordSelector: next.passwordSelector,
        submitAutomatically: false,
      },
      ...(next.password ? { password: next.password } : {}),
    });
    const applied = await api.applyEnvironment(account.id);
    showToast(saved.cleanupPending
      ? '配置已保存；旧会话残留将在下次启动前完成清理'
      : applied.running
      ? `配置已保存；已切换为${applied.label}并自动刷新`
      : '配置已保存；下次打开账户时应用设备环境');
  });
  bindAvatarPicker();
  bindUserAgentFields();
  const deleteButton = $('#editor-delete-item');
  deleteButton.hidden = false;
  deleteButton.textContent = '删除账户';
  deleteButton.onclick = async () => {
    closeDialog($('#editor-dialog'));
    await deleteAccountIds([account.id], account.name);
  };
}

function openAppSettings() {
  const shortcuts = appSettings.shortcuts || {};
  openEditor('软件安全与快捷键', [
    checkField('启动密码', 'launchPasswordEnabled', appSettings.launchPasswordEnabled, '启用后，下次打开软件必须先输入密码；锁定前不会加载账户会话'),
    field('当前启动密码', 'currentPassword', '', 'password', `placeholder="${appSettings.launchPasswordEnabled ? '修改设置时必须输入' : '尚未启用'}" autocomplete="current-password"`),
    field('新启动密码', 'newPassword', '', 'password', `placeholder="${appSettings.launchPasswordEnabled ? '留空保留原密码' : '启用时至少4位'}" minlength="4" autocomplete="new-password"`),
    field('显示/隐藏窗口', 'showHide', shortcuts.showHide),
    field('下一个账户', 'nextAccount', shortcuts.nextAccount),
    field('上一个账户', 'previousAccount', shortcuts.previousAccount),
    field('收起/展开侧栏', 'toggleSidebar', shortcuts.toggleSidebar),
    '<span></span><span class="hint">快捷键格式示例：CommandOrControl+Shift+P。账户切换只在已启动账户之间循环。</span>',
    field('同时运行上限', 'maxRunningAccounts', appSettings.maxRunningAccounts || 8, 'number', 'min="1" max="30" required'),
    field('闲置自动停止', 'idleStopMinutes', appSettings.idleStopMinutes ?? 30, 'number', 'min="0" max="1440" required'),
    '<span></span><span class="hint">单位：分钟；0表示关闭。只停止非当前账户，释放隐藏浏览进程；超过运行上限时优先停止最久未使用账户。</span>',
    field('内存提醒阈值(MB)', 'memoryLimitMb', appSettings.memoryLimitMb || 4096, 'number', 'min="1024" max="32768" step="256" required'),
    '<span></span><span class="hint">达到阈值时仅显示提醒，不会因为内存或CPU过高自动关闭账户窗口。</span>',
    `<label for="field-dataDirectoryDisplay">数据文件目录</label><div class="path-row"><input id="field-dataDirectoryDisplay" value="${escapeHtml(appSettings.dataDirectory || '')}" readonly><button type="button" data-choose-data-directory>选择</button><input type="hidden" name="dataBaseDirectory" value=""></div>`,
    `<label>本地操作日志</label><div class="path-row"><input value="${escapeHtml(appSettings.logDirectory || '')}" readonly><button type="button" data-open-log-directory>打开</button></div>`,
    '<span></span><span class="hint">记录添加、删除、清理、快照、导入导出和设置变更；保留90天，单文件最多5MB，不记录密码内容。</span>',
    '<label class="danger-zone">危险操作</label><div class="settings-action danger-zone"><button type="button" class="danger-button" data-open-wipe-dialog>清空并粉碎全部数据</button></div>',
  ].join(''), async (data) => {
    const next = Object.fromEntries(data);
    const result = await api.updateAppSettings({
      launchPasswordEnabled: data.has('launchPasswordEnabled'),
      currentPassword: next.currentPassword,
      newPassword: next.newPassword,
      shortcuts: {
        showHide: next.showHide,
        nextAccount: next.nextAccount,
        previousAccount: next.previousAccount,
        toggleSidebar: next.toggleSidebar,
      },
      maxRunningAccounts: next.maxRunningAccounts,
      idleStopMinutes: next.idleStopMinutes,
      memoryLimitMb: next.memoryLimitMb,
      dataBaseDirectory: next.dataBaseDirectory,
    });
    appSettings = result.settings;
    if (result.relaunching) {
      showToast('数据迁移已安排，软件即将重启');
      return;
    }
    if (result.unavailableShortcuts.length) {
      showToast(`设置已保存，但 ${result.unavailableShortcuts.map((item) => item.accelerator).join('、')} 已被系统占用`, true);
    } else {
      showToast('软件设置已保存');
    }
  });
  const fieldsRoot = $('#editor-fields');
  fieldsRoot.querySelector('[data-choose-data-directory]').addEventListener('click', async () => {
    const result = await act('正在选择数据目录…', () => api.selectDataDirectory());
    if (result.canceled) return;
    fieldsRoot.querySelector('#field-dataDirectoryDisplay').value = result.dataDirectory;
    fieldsRoot.querySelector('[name="dataBaseDirectory"]').value = result.baseDirectory;
  });
  fieldsRoot.querySelector('[data-open-log-directory]').addEventListener('click', () => {
    api.openLogDirectory().catch((error) => showToast(friendlyError(error), true));
  });
  fieldsRoot.querySelector('[data-open-wipe-dialog]').addEventListener('click', () => {
    if (!appSettings.launchPasswordEnabled) return showToast('请先启用并保存启动密码', true);
    closeDialog($('#editor-dialog'));
    $('#wipe-dialog').showModal();
    requestBrowserBounds();
    $('#wipe-password').focus();
  });
}

function editProxy() {
  const account = accountById(activeAccountId);
  if (!account) return showToast('请先选择账户', true);
  const proxy = account.proxy || {};
  openEditor(`代理配置 · ${account.name}`, [
    `<label for="field-mode">线路模式</label><select id="field-mode" name="mode">
      <option value="system" ${proxy.mode === 'system' ? 'selected' : ''}>本地/系统代理</option>
      <option value="direct" ${proxy.mode === 'direct' ? 'selected' : ''}>强制直连</option>
      <option value="fixed_servers" ${proxy.mode === 'fixed_servers' ? 'selected' : ''}>自定义代理</option>
    </select>`,
    field('代理地址', 'server', proxy.server, 'text', 'placeholder="http://host:port 或 socks5://host:port"'),
    field('绕过规则', 'bypassRules', proxy.bypassRules || '<local>'),
    field('用户名', 'username', proxy.username),
    field('代理密码', 'proxyPassword', '', 'password', `placeholder="${proxy.hasPassword ? '已安全保存；留空保留' : '可选'}" autocomplete="new-password"`),
    '<span></span><span class="hint">未选择自定义代理时默认走本机网络；代理账号认证需服务器支持。</span>',
  ].join(''), async (data) => {
    const next = Object.fromEntries(data);
    const patch = {
      proxy: { ...proxy, mode: next.mode, server: next.server, bypassRules: next.bypassRules, username: next.username },
      ...(next.proxyPassword ? { proxyPassword: next.proxyPassword } : {}),
    };
    await api.updateAccount(account.id, patch);
    await api.setProxy(account.id, patch.proxy);
    showToast('代理配置已应用');
  });
}

function openSnapshots() {
  const account = accountById(activeAccountId);
  if (!account) return showToast('请先选择账户', true);
  if (account.storageMode === 'incognito') return showToast('无痕账户不会保存状态快照', true);
  const items = workspace.snapshots
    .filter((snapshot) => snapshot.accountId === account.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('#snapshot-list').innerHTML = items.length ? items.map((snapshot) => `<div class="snapshot-item">
    <div><strong>${escapeHtml(snapshot.label)}</strong><span>${new Date(snapshot.createdAt).toLocaleString()}</span></div>
    <button type="button" data-restore-snapshot="${snapshot.id}">还原</button>
  </div>`).join('') : '<p>当前账户还没有快照。</p>';
  if (!$('#snapshot-dialog').open) $('#snapshot-dialog').showModal();
  requestBrowserBounds();
}

async function createSnapshot() {
  const account = accountById(activeAccountId);
  if (!account) return showToast('请先选择账户', true);
  if (account.storageMode === 'incognito') return showToast('无痕账户不会保存状态快照', true);
  const label = window.prompt('快照名称（可留空）', `${account.name} ${new Date().toLocaleString()}`);
  if (label === null) return;
  await act('正在保存快照…', () => api.createSnapshot(account.id, label));
  showToast('状态快照已加密保存');
  if ($('#snapshot-dialog').open) openSnapshots();
}

async function parseBatch() {
  const raw = $('#batch-input').value.trim();
  if (!raw) throw new Error('请粘贴批量数据');
  if (raw.startsWith('[')) return JSON.parse(raw);
  return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`第${index + 1}行不是有效JSON`); }
  });
}

async function deleteAccountIds(ids, label = '') {
  const result = await act(label ? `正在删除 ${label}…` : `正在删除 ${ids.length} 个账户…`, () => api.deleteAccounts(ids));
  if (!result.canceled) {
    ids.forEach((id) => selectedIds.delete(id));
    showToast(result.count > 1
      ? `已将 ${result.count} 个账户置灰，下次启动自动清除`
      : '账户已置灰并清除浏览数据，下次启动自动删除');
  }
  return result;
}

async function runBulk() {
  const ids = [...selectedIds];
  if (!ids.length) return showToast('请先勾选账户', true);
  const action = $('#bulk-action').value;
  if (action === 'delete') {
    await deleteAccountIds(ids);
    return;
  }
  const results = await act(`正在执行 ${ids.length} 个账户…`, () => api.bulkRun(ids, action));
  const failures = results.filter((result) => !result.ok);
  showToast(failures.length ? `完成：成功${results.length - failures.length}，失败${failures.length}` : `已完成 ${results.length} 个账户`, Boolean(failures.length));
}

async function runDiagnostics() {
  const account = accountById(activeAccountId);
  if (!account) return showToast('请先选择账户', true);
  $('#diagnostics-panel').hidden = false;
  $('#diagnostics-target').textContent = account.currentUrl || account.startUrl;
  $('#diagnostics-results').innerHTML = '<div class="check-card"><strong>检测中…</strong><span>请稍候</span></div>';
  requestBrowserBounds();
  const result = await act('正在检测网络…', () => api.runDiagnostics(account.id));
  $('#diagnostics-results').innerHTML = result.checks.map((check) => `<div class="check-card ${check.ok ? 'ok' : 'fail'}">
    <strong>${check.ok ? '✓' : '×'} ${escapeHtml(check.label)}</strong>
    <span>${check.durationMs} ms · ${escapeHtml(check.ok ? JSON.stringify(check.detail) : check.error)}</span>
  </div>`).join('');
}

$('#account-tree').addEventListener('click', async (event) => {
  const siteToggle = event.target.closest('[data-toggle-site]');
  if (siteToggle) {
    const id = siteToggle.dataset.toggleSite;
    if (collapsedSiteIds.has(id)) collapsedSiteIds.delete(id); else collapsedSiteIds.add(id);
    localStorage.setItem('profiledesk.collapsedSites', JSON.stringify([...collapsedSiteIds]));
    renderTree();
    return;
  }
  const deleteButton = event.target.closest('[data-delete-account]');
  if (deleteButton) {
    event.stopPropagation();
    const account = accountById(deleteButton.dataset.deleteAccount);
    if (!account) return;
    await deleteAccountIds([account.id], account.name);
    return;
  }
  if (event.target.matches('[data-select-account]')) return;
  const row = event.target.closest('[data-account-id]');
  if (row) await activateAccount(row.dataset.accountId);
});

$('#account-tree').addEventListener('contextmenu', (event) => {
  const row = event.target.closest('[data-account-id]');
  if (row) {
    event.preventDefault();
    editAccount(row.dataset.accountId);
    return;
  }
  const siteHeading = event.target.closest('[data-site-id]');
  if (siteHeading) {
    event.preventDefault();
    editSite(siteHeading.dataset.siteId);
  }
});

$('#account-tree').addEventListener('change', (event) => {
  const id = event.target.dataset.selectAccount;
  if (!id) return;
  if (event.target.checked) selectedIds.add(id); else selectedIds.delete(id);
  renderTree();
});

$('#add-site').addEventListener('click', addSite);
$('#add-account').addEventListener('click', addAccount);
$('#empty-add-account').addEventListener('click', addAccount);
$('#account-settings').addEventListener('click', () => editAccount());
$('#app-settings').addEventListener('click', openAppSettings);
$('#toggle-sidebar').addEventListener('click', toggleSidebar);
$('#proxy-config').addEventListener('click', editProxy);
$('#create-snapshot').addEventListener('click', openSnapshots);
$('#snapshot-create-new').addEventListener('click', createSnapshot);
$('#run-bulk').addEventListener('click', () => runBulk().catch(() => {}));
$('#run-diagnostics').addEventListener('click', () => runDiagnostics().catch(() => {}));
$('#close-diagnostics').addEventListener('click', () => { $('#diagnostics-panel').hidden = true; requestBrowserBounds(); });
$('#search').addEventListener('input', renderTree);

$('#sound-toggle').addEventListener('click', async () => {
  const account = accountById(activeAccountId);
  if (!account || account.pendingDeletion) return showToast('请先选择可用账户', true);
  const updated = await act(account.muted ? '正在恢复声音…' : '正在静音…', () => api.setMuted(account.id, !account.muted));
  showToast(updated.muted ? '当前账户已静音' : '当前账户声音已恢复');
});

$('#select-all').addEventListener('change', (event) => {
  selectedIds = event.target.checked
    ? new Set(workspace.accounts.filter((account) => !account.pendingDeletion).map((account) => account.id))
    : new Set();
  renderTree();
});

document.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => {
  if (!activeAccountId) return showToast('请先选择账户', true);
  api.command(activeAccountId, button.dataset.command).catch((error) => showToast(error.message, true));
}));

$('#address-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeAccountId) return showToast('请先选择账户', true);
  await act('正在打开地址…', () => api.navigate(activeAccountId, $('#address').value));
});

$('#proxy-mode').addEventListener('change', async (event) => {
  if (!activeAccountId) return;
  if (event.target.value === 'fixed_servers') return editProxy();
  const account = accountById(activeAccountId);
  await act('正在切换线路…', () => api.setProxy(activeAccountId, { ...account.proxy, mode: event.target.value }));
  showToast(event.target.value === 'system' ? '已使用本地/系统网络' : '已强制直连');
});

$('#clear-current').addEventListener('click', async () => {
  const account = accountById(activeAccountId);
  if (!account) return showToast('请先选择账户', true);
  const mode = $('#clear-mode').value;
  const destructive = ['site', 'all'].includes(mode);
  if (destructive && !window.confirm(mode === 'all' ? '这会清除该账户的全部登录状态与站点数据，确定继续？' : '这会退出当前站点，确定继续？')) return;
  await act('正在清理…', () => api.clear(account.id, mode));
  showToast('当前窗口已清理');
});

$('#editor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = $('#editor-submit');
  submit.disabled = true;
  try {
    await act('正在保存…', () => editorSave(new FormData(event.currentTarget)));
    closeDialog($('#editor-dialog'));
  } catch {
    // act() already surfaced a concise error to the user.
  } finally {
    submit.disabled = false;
  }
});

$('#batch-import').addEventListener('click', () => { $('#batch-dialog').showModal(); requestBrowserBounds(); });
$('#batch-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const rows = await parseBatch();
    const result = await act('正在批量添加…', () => api.importBatch(rows));
    closeDialog($('#batch-dialog'));
    $('#batch-input').value = '';
    showToast(`已新增 ${result.sitesAdded} 个业务站、${result.accountsAdded} 个账户`);
  } catch (error) {
    showToast(error.message, true);
  }
});

$('#wipe-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const result = await act('正在准备删除全部数据…', () => api.wipeAllData({
      password: $('#wipe-password').value,
      confirmation: $('#wipe-confirmation').value.trim(),
    }));
    if (result.canceled) return;
    showToast('软件将重启并删除全部数据');
  } catch {
    $('#wipe-password').select();
  }
});

$('#wipe-dialog').addEventListener('close', () => {
  $('#wipe-password').value = '';
  $('#wipe-confirmation').value = '';
});

document.addEventListener('click', (event) => {
  if (event.target.matches('[data-close-dialog]')) closeDialog(event.target.closest('dialog'));
  const id = event.target.dataset.restoreSnapshot;
  if (id && window.confirm('还原前会停止当前账户，并替换其Cookie与站点数据，确定继续？')) {
    act('正在还原快照…', async () => {
      await api.restoreSnapshot(id);
      closeDialog($('#snapshot-dialog'));
      await activateAccount(activeAccountId);
      showToast('快照已还原');
    }).catch(() => {});
  }
});

$('#export-package').addEventListener('click', async () => {
  const ids = selectedIds.size ? [...selectedIds] : (activeAccountId ? [activeAccountId] : []);
  if (!ids.length) return showToast('请选择要导出的账户', true);
  openEditor('导出加密环境', [
    field('导出密码', 'password', '', 'password', 'required minlength="8" autocomplete="new-password"'),
    '<span></span><span class="hint">至少8位；密码不会保存，忘记后无法恢复导出包。</span>',
  ].join(''), async (data) => {
    const result = await api.exportPackage(ids, data.get('password'));
    if (!result.canceled) showToast(`已导出 ${result.count} 个账户`);
  });
});

$('#import-package').addEventListener('click', async () => {
  openEditor('导入加密环境', [
    field('导入包密码', 'password', '', 'password', 'required autocomplete="current-password"'),
    '<span></span><span class="hint">导入包不携带自动登录或代理密码，导入后需重新配置。</span>',
  ].join(''), async (data) => {
    const result = await api.importPackage(data.get('password'));
    if (!result.canceled) showToast(`已导入 ${result.count} 个账户；凭据需重新配置`);
  });
});

api.onState(refreshWorkspace);
api.onBrowserEvent((event) => {
  if (event.type === 'resource-usage') {
    const cpu = Math.round(Number(event.systemCpuPercent) || 0);
    const memory = Math.round(Number(event.systemMemoryPercent) || 0);
    const appMemory = Math.round(Number(event.appMemoryMb) || 0);
    const usage = $('#resource-usage');
    usage.textContent = `CPU ${cpu}% · 内存 ${memory}% · 本应用 ${appMemory} MB`;
    usage.title = `系统CPU ${cpu}% · 系统内存 ${memory}% · ProfileDesk内存 ${appMemory} MB · 运行账户 ${Number(event.runningAccounts) || 0}`;
    return;
  }
  if (event.type === 'resource-warning') {
    showToast(`资源占用提醒：${(event.reasons || []).join('；')}。不会自动关闭当前窗口。`, true);
    return;
  }
  if (event.type === 'environment-warning') {
    showToast(event.reason || '当前系统无法应用移动设备模拟，已回退为普通窗口', true);
    return;
  }
  if (event.type === 'activated') {
    activeAccountId = event.accountId;
    renderTree();
    syncActiveUi();
  }
  if (event.type === 'resource-released') {
    const messages = {
      idle: '闲置账户已自动停止并释放资源',
      limit: '已停止最久未使用账户以控制资源占用',
    };
    showToast(messages[event.reason] || '后台账户已停止并释放资源');
    return;
  }
  if (event.accountId !== activeAccountId) return;
  if (event.type === 'navigation') {
    $('#address').value = event.url;
    $('#security-indicator').textContent = event.url.startsWith('https:') ? '●' : '○';
  } else if (event.type === 'load-error') {
    showToast(`页面加载失败：${event.description} (${event.code})`, true);
  } else if (event.type === 'crashed') {
    showToast(`浏览器进程异常退出：${event.reason}`, true);
  } else if (event.type === 'credentials-filled') {
    showToast('已在受信登录页填充凭据，请确认后登录');
  }
});

api.onAppShortcut((event) => {
  if (event.action === 'toggle-sidebar') toggleSidebar();
});

new ResizeObserver(requestBrowserBounds).observe($('#browser-stage'));
window.addEventListener('resize', () => updateSidebarState({ persist: false }));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('close', requestBrowserBounds));
$('#editor-dialog').addEventListener('close', () => {
  $('#editor-fields').replaceChildren();
  editorSave = null;
});

$('#lock-dialog').addEventListener('cancel', (event) => event.preventDefault());
$('#lock-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#unlock-submit');
  button.disabled = true;
  $('#unlock-error').textContent = '';
  try {
    const result = await api.unlock($('#unlock-password').value);
    appSettings = result.settings;
    $('#unlock-password').value = '';
    closeDialog($('#lock-dialog'));
    refreshWorkspace(result.state);
  } catch (error) {
    $('#unlock-error').textContent = friendlyError(error);
    $('#unlock-password').select();
  } finally {
    button.disabled = false;
  }
});

async function initialize() {
  bindSidebarResizer();
  updateSidebarState();
  const bootstrap = await api.getBootstrap();
  appSettings = bootstrap.settings;
  if (bootstrap.safeMode) {
    setBusy('安全模式：已跳过账户自动恢复并关闭硬件加速');
    showToast('当前以安全模式启动，可先检查账户设置后再正常重启');
  }
  if (bootstrap.locked) {
    $('#lock-dialog').showModal();
    requestBrowserBounds();
    $('#unlock-password').focus();
    return;
  }
  refreshWorkspace(await api.getState());
}

initialize().catch((error) => showToast(`初始化失败：${friendlyError(error)}`, true));
