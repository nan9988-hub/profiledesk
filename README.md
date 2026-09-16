# ProfileDesk

ProfileDesk 是一个面向 Windows 与 macOS 的本地多账户隔离浏览器工作台。每个账户使用独立的 Chromium Session 目录，Cookie、缓存、登录状态、站点存储、下载目录和代理配置互不共享。

当前版本：`0.2.13`

## 已实现

- 业务站与账户树形管理、搜索、多选和批量导入。
- IM式业务站分组与账户列表；业务站可折叠，侧栏分隔线支持自由拖动、方向键微调和双击恢复默认宽度。最窄仍给38px头像保留左右间距；进入窄栏后业务站显示彩色背景、图标和随宽度缩放的名称，账户只显示头像并可悬停查看名称。
- 账户支持本地上传头像；图片保存前裁剪压缩为128×128，原始路径不会写入配置。
- 批量启动、停止、刷新、清缓存和创建快照。
- 账户行直接删除，以及带主进程二次确认的批量删除；同步清理隔离Profile、下载、快照和已保存凭据。
- Windows若仍占用Chromium Profile文件，账户记录会先安全移除，软件自动重启并在会话加载前完成残留文件清理，不再因`EBUSY`中断删除。
- 每账户可选择持久模式或无痕模式，两种模式都互相隔离。持久模式保留登录状态；无痕模式使用内存Session，停止账户、退出软件或浏览进程崩溃后自动清除Cookie、缓存、LocalStorage、IndexedDB、Service Worker与浏览位置，并且不会加入下次自动恢复。
- 无痕模式仍保留账户名称、头像、代理、UA和自动登录配置；用户主动下载的文件也会保留。无痕账户不允许保存状态快照，导出账户配置时不包含临时Cookie。
- 内置浏览器视图，主窗口支持自由拖动和缩放。
- 顶部本地网络、强制直连、自定义 HTTP/HTTPS/SOCKS 代理入口。
- 当前窗口后退、前进、刷新、首页和地址栏。
- 每账户可选择PC、Google Pixel 11 Pro或Apple iPhone 17 Pro，以及Chrome、Edge、Firefox、Safari常用UA预设或自定义User-Agent。移动模式会使用对应设备宽度的兼容视口与移动UA，保存后自动刷新运行中的业务站；浏览器内核仍保持Chromium，网页本身需要支持响应式布局。v0.2.10为解决部分Windows电脑从v0.2.8开始的原生闪退，移除了启动恢复阶段的Chromium设备模拟接口调用。
- 当前账户缓存、离线存储、Cookie/站点数据分级清理。
- 逻辑状态快照：Cookie、当前网址、代理与环境设置。
- 加密 `.pdesk` 导出、导入，跨 Windows/macOS 使用用户密码解密。
- 自动登录安全框架：域名白名单、HTTPS限制、系统安全存储、默认不自动提交。
- DNS、TCP 80/443、TLS证书、浏览器线路HTTP状态和耗时检测。
- 崩溃状态记录和标签页地址恢复。
- 可选4位以上启动密码；解锁前不加载或返回账户数据，连续错误带临时限速。
- 可配置全局快捷键：显示/隐藏窗口、切换上/下一个运行账户、收起/展开侧栏。
- 可迁移到用户指定的数据目录；迁移在重启后、浏览会话加载前执行。
- 本地JSONL重要操作日志，记录添加、删除、清理、快照、导入导出和设置变更，不记录密码内容。
- 底部实时显示系统CPU、系统内存和ProfileDesk内存；资源过高只提醒，不自动关闭窗口。
- 运行账户数量上限、可关闭的非当前账户闲置自动停止、后台节流与崩溃视图回收，防止浏览实例无限增长。
- 启用启动密码后可执行全数据尽力覆盖删除，并在空白状态下重启。
- 严格的Electron安全默认值：沙箱、上下文隔离、关闭Node集成、限制导航和新窗口。
- Windows启动过程写入`%APPDATA%\profiledesk\startup.log`；启动失败会显示错误和日志位置，不再静默闪退。若上一次在启动阶段异常退出，下次会自动进入安全模式，关闭硬件加速并跳过账户恢复，不删除账户数据。

## 重要边界

ProfileDesk保证本机浏览数据隔离，但不承诺不同账号无法被业务网站关联。网站仍可通过出口IP、设备特征、账号资料和操作行为判断关联。请遵守目标网站条款。

不要在未审计或未签名的测试版本中存放钱包助记词、服务器根凭据或其他不可恢复的高价值秘密。

更完整的信任边界与发布要求见 [`docs/SECURITY.md`](docs/SECURITY.md)。

## 本地运行

```bash
npm ci --allow-git=all
npm start
```

npm 12默认禁止Git来源依赖；Electron构建链包含固定到官方仓库提交的`@electron/node-gyp`，因此安装命令对本次依赖解析显式启用Git来源。项目已包含`package-lock.json`，本地和GitHub构建都使用`npm ci`锁定完整依赖树。Windows本地还需要安装Git for Windows。

npm 12还会阻止未审批的依赖安装脚本。本项目只在`package.json`中批准固定版本的`electron-winstaller@5.4.0`，用于Windows安装包构建；不要使用全量脚本审批。

无需管理员权限。首次启动会在系统应用数据目录创建配置、Profile、快照与下载目录。

软件设置中可以选择新的数据存放位置。ProfileDesk会在所选文件夹下创建专用的`ProfileDeskData`目录，不会把所选父目录中的其他文件纳入删除范围。迁移会重启软件，并在新会话启动前复制数据、切换位置和清理旧目录。

## 验证

```bash
npm run verify
```

## 构建

Windows：

```bash
npm run dist:win
```

也可以在 Windows 解压目录双击 `build-windows.cmd`。它会调用`build-windows.ps1`执行构建，无论成功或失败，CMD窗口都会停留等待按键，并把完整输出写入`build-windows.log`。完成后安装包和便携版位于 `release`。

如果生成后的Windows程序打开即退出，先双击`run-windows-debug.cmd`。它会从`release\win-unpacked`以安全模式启动，并生成`profiledesk-windows-debug.log`；应用自己的启动阶段日志位于`%APPDATA%\profiledesk\startup.log`。安全模式不会删除数据，可先把异常账户改回PC设备后再正常启动。

macOS：

```bash
npm run dist:mac
```

该命令同时生成 Intel x64 与 Apple Silicon arm64 两套 macOS DMG。GitHub Actions会把两种架构分别构建并上传，只上传最终DMG，不上传未压缩的`.app`目录、重复ZIP或blockmap：

- `ProfileDesk-macOS-Intel`：Intel处理器Mac。
- `ProfileDesk-macOS-AppleSilicon`：M1/M2/M3/M4等Apple芯片Mac。

按电脑架构下载其中一个即可，不需要同时下载两套。

macOS正式分发需要Apple Developer证书与公证配置；Windows正式分发建议配置代码签名证书。未签名开发包会触发系统安全提醒。

GitHub Actions中的Windows构建会分别显示两个下载项：

- `ProfileDesk-Windows-Installer`：安装版。
- `ProfileDesk-Windows-Portable`：单文件便携版。

两者都会附带`SHA256SUMS.txt`，构建机还会对输出目录运行Microsoft Defender扫描。安全扫描只能发现已知威胁，不能替代数字签名；未签名且下载量较少的新EXE仍可能被Chrome或SmartScreen以“不常见/可能有危险”拦截。

macOS构建会自动区分两种模式：

- 未配置Developer ID证书：生成无签名开发包，并关闭Hardened Runtime，避免Apple Silicon上“无签名但启用强化运行时”导致应用无法启动。此包只适合自己测试，首次打开仍需在“系统设置 → 隐私与安全性”中选择“仍要打开”。
- 配置Developer ID证书及公证凭据：保持Hardened Runtime，自动签名并提交Apple公证，适合向其他用户分发。

GitHub Actions正式签名需要在仓库`Settings → Secrets and variables → Actions`中配置：

Windows：

- `WIN_CSC_LINK`：代码签名服务提供的PKCS#12证书路径、可下载地址或Base64内容；具体形式以证书服务商和electron-builder支持方式为准。
- `WIN_CSC_KEY_PASSWORD`：证书密码。

配置后，工作流会要求安装版和便携版的Authenticode签名状态均为`Valid`，否则构建失败。证书私钥不得提交到GitHub仓库。若使用Azure Artifact Signing或硬件/云托管EV证书，需要按服务商要求把签名步骤接入工作流，不能把不可导出的硬件私钥直接放入Secret。

macOS：

- `MAC_CSC_LINK`：从钥匙串导出的Developer ID Application `.p12`文件的Base64内容。
- `MAC_CSC_KEY_PASSWORD`：导出`.p12`时设置的密码。
- `APPLE_ID`：Apple Developer账号。
- `APPLE_APP_SPECIFIC_PASSWORD`：Apple ID生成的App专用密码。
- `APPLE_TEAM_ID`：Apple Developer团队ID。

如果这些Secrets为空，工作流仍会成功生成开发包，但不会把它显示成Apple已验证的软件。

### macOS提示“已损坏”时

先确认下载的是自己GitHub仓库构建的Artifact，并将`ProfileDesk.app`从DMG拖入“应用程序”。尝试打开一次后，进入“系统设置 → 隐私与安全性”，找到ProfileDesk并点“仍要打开”。如果没有这个按钮，可在终端对已确认可信的本机副本执行：

```bash
xattr -dr com.apple.quarantine "/Applications/ProfileDesk.app"
codesign --force --deep --sign - "/Applications/ProfileDesk.app"
codesign --verify --deep --strict --verbose=2 "/Applications/ProfileDesk.app"
open "/Applications/ProfileDesk.app"
```

如果前两条提示权限不足，再只给对应命令加`sudo`。不要对来源不明的软件执行移除隔离或临时签名命令。

也可以推送到GitHub后运行仓库自带的双平台构建工作流。

构建脚本固定使用`--publish never`，避免`electron-builder`自行寻找Token或误发布。工作流使用独立的`release`任务自动发布：只有推送与`package.json`版本完全一致的`v*`标签时，才会在四个平台构建全部成功后创建GitHub Release。发布过程先建立草稿、上传全部文件和统一`SHA256SUMS.txt`，最后再公开，防止用户看到缺少文件的半成品Release。

### GitHub自动发布

以当前版本为例，在项目目录执行：

```bash
git add .
git commit -m "Release v0.2.13"
git push origin HEAD
git tag v0.2.13
git push origin v0.2.13
```

推送标签后，进入仓库的`Actions → Build desktop packages`查看进度。Windows安装版、Windows单文件便携版、Intel Mac和Apple Silicon Mac必须全部构建成功，随后才会自动出现在仓库右侧的`Releases`中。

普通提交和在Actions页面点击`Run workflow`只构建测试包，不会自动公开Release。发布下一版本前必须先修改`package.json`中的版本；标签不匹配时工作流会主动失败，避免把错误版本发布出去。

工作流使用GitHub自动提供的`GITHUB_TOKEN`发布，不需要额外创建个人访问令牌。仓库的Actions权限需要允许工作流写入内容；工作流已经只给发布任务配置`contents: write`，构建任务仍保持只读权限。

Windows 本机不能完成可正常分发的 macOS 签名与公证；可以在 Windows 上把代码推送到 GitHub，然后由工作流的 Windows/macOS 构建机自动生成全部包。

## 数据与清理语义

- 仅清缓存：保留登录。
- 缓存与离线记录：保留Cookie，但删除缓存、IndexedDB、Service Worker与CacheStorage。
- 当前站点数据：删除当前业务站Cookie与站点存储，会退出当前站点。
- 重置环境：删除该账户全部浏览数据，会完全退出。

完整Profile目录不能在浏览器运行时直接复制。本版快照使用Cookie与配置的逻辑快照，避免复制运行中的LevelDB/SQLite文件导致损坏。

“清空并粉碎全部数据”只在已经启用启动密码、密码校验成功、输入指定确认文字并通过系统二次确认后执行。软件会在重启后、任何浏览会话创建前覆盖可写普通文件并递归删除应用专用数据目录。SSD磨损均衡、文件系统快照、杀毒隔离区和系统/云备份可能保留底层副本，因此该功能不承诺法证级不可恢复；高敏感设备仍应使用全盘加密和可信的系统级擦除工具。

## 自动登录

优先复用已有登录会话。只有登录失效时，才会在精确匹配的HTTPS来源上填充凭据。短信、二维码、验证码、2FA和支付确认必须由用户完成。

## 首版停止线

首版不包含云同步、团队权限、验证码绕过、复杂硬件指纹伪造、批量注册和网站风控规避。
