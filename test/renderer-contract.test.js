const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

test('renderer JavaScript only references element IDs present in HTML', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referenced = new Set([...script.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map((match) => match[1]));
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, []);
});

test('every preload invoke channel has a main-process handler', () => {
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const invoked = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]));
  const handled = new Set([
    ...[...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1]),
    ...[...main.matchAll(/handleUnlocked\('([^']+)'/g)].map((match) => match[1]),
  ]);
  assert.deepEqual([...invoked].filter((channel) => !handled.has(channel)), []);
});

test('resource pressure warns instead of closing accounts for memory usage', () => {
  const profileManager = fs.readFileSync(path.join(root, 'src/main/profile-manager.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  assert.match(profileManager, /this\.emit\('resource-warning'/);
  assert.doesNotMatch(profileManager, /reason:\s*'memory'/);
  assert.match(renderer, /event\.type === 'resource-usage'/);
});

test('sidebar has a bounded drag handle and mobile environments use a stable responsive viewport', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const profileManager = fs.readFileSync(path.join(root, 'src/main/profile-manager.js'), 'utf8');
  assert.match(html, /id="sidebar-resizer"/);
  assert.match(renderer, /SIDEBAR_MIN_WIDTH = Math\.ceil\(SIDEBAR_AVATAR_SIZE \* 1\.5\) \+ 14/);
  assert.match(renderer, /pointermove/);
  assert.doesNotMatch(profileManager, /enableDeviceEmulation/);
  assert.doesNotMatch(profileManager, /disableDeviceEmulation/);
  assert.match(profileManager, /MOBILE_DEVICE_PROFILES/);
  assert.match(profileManager, /Math\.min\(this\.bounds\.width, profile\.width\)/);
});

test('Windows startup failures are visible and can recover through safe mode', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const profileManager = fs.readFileSync(path.join(root, 'src/main/profile-manager.js'), 'utf8');
  const debugScript = fs.readFileSync(path.join(root, 'run-windows-debug.cmd'), 'utf8');
  assert.match(main, /startup\.log/);
  assert.match(main, /startup-in-progress/);
  assert.match(main, /--safe-mode/);
  assert.match(main, /showErrorBox\('ProfileDesk 启动失败'/);
  assert.match(main, /disableHardwareAcceleration/);
  assert.match(main, /\.catch\(\(error\) => \{/);
  assert.match(profileManager, /this\.safeMode/);
  assert.match(profileManager, /this\.safeMode/);
  assert.match(debugScript, /win-unpacked\\ProfileDesk\.exe/);
  assert.match(debugScript, /--safe-mode --enable-logging/);
});

test('Windows build launcher always pauses and writes a persistent build log', () => {
  const command = fs.readFileSync(path.join(root, 'build-windows.cmd'), 'utf8');
  const powershell = fs.readFileSync(path.join(root, 'build-windows.ps1'), 'utf8');
  assert.match(command, /powershell\.exe .*build-windows\.ps1/);
  assert.match(command, /pause >nul/);
  assert.match(command, /build-windows\.log/);
  assert.match(powershell, /Start-Transcript/);
  assert.match(powershell, /npm\.cmd ci --allow-git=all/);
  assert.match(powershell, /npm\.cmd run dist:win/);
  assert.match(powershell, /exit \$exitCode/);
});

test('incognito accounts use memory sessions, clear on close and skip snapshots', () => {
  const profileManager = fs.readFileSync(path.join(root, 'src/main/profile-manager.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  assert.match(profileManager, /session\.fromPartition\(`profiledesk-incognito-/);
  assert.match(profileManager, /instance\.session\.clearStorageData/);
  assert.match(main, /无痕账户不能保存状态快照/);
  assert.match(renderer, /无痕模式（关闭即清除）/);
});

test('account audio, right-click editing and deferred deletion are wired end to end', () => {
  const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'src/renderer/app.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src/main/main.js'), 'utf8');
  const profiles = fs.readFileSync(path.join(root, 'src/main/profile-manager.js'), 'utf8');
  assert.match(html, /id="sound-toggle"/);
  assert.match(html, /id="editor-delete-item"/);
  assert.match(renderer, /addEventListener\('contextmenu'/);
  assert.match(renderer, /function editSite/);
  assert.match(renderer, /删除业务站/);
  assert.match(preload, /browser:set-muted/);
  assert.match(main, /accounts\.deletion_scheduled/);
  assert.match(main, /finalizePendingAccountDeletions/);
  assert.match(profiles, /setAudioMuted/);
  assert.match(profiles, /prepareAccountDeletion/);
  assert.doesNotMatch(main, /cleanupPending\)\s*\{[\s\S]*relaunchSoon/);
});

test('GitHub Windows build supports signing, Defender scanning and separate downloads', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/build-desktop.yml'), 'utf8');
  assert.match(workflow, /CSC_LINK:\s*\$\{\{ secrets\.WIN_CSC_LINK \}\}/);
  assert.match(workflow, /Start-MpScan/);
  assert.match(workflow, /SHA256SUMS\.txt/);
  assert.match(workflow, /ProfileDesk-Windows-Installer/);
  assert.match(workflow, /ProfileDesk-Windows-Portable/);
});
