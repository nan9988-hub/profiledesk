const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const LOCATOR_VERSION = 1;

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function pathExists(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function overwriteFile(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r+');
    const stat = await handle.stat();
    const block = Buffer.alloc(Math.min(1024 * 1024, Math.max(1, stat.size)));
    for (let offset = 0; offset < stat.size; offset += block.length) {
      await handle.write(block, 0, Math.min(block.length, stat.size - offset), offset);
    }
    await handle.sync();
    await handle.truncate(0);
  } catch {
    // Some Chromium or system files cannot be overwritten; deletion is still attempted.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function secureRemoveTree(target) {
  if (!await pathExists(target)) return { files: 0, failures: 0 };
  let files = 0;
  let failures = 0;
  const walk = async (entry) => {
    let stat;
    try {
      stat = await fs.promises.lstat(entry);
    } catch {
      failures += 1;
      return;
    }
    if (stat.isSymbolicLink()) {
      await fs.promises.unlink(entry).catch(() => { failures += 1; });
      return;
    }
    if (stat.isDirectory()) {
      const children = await fs.promises.readdir(entry).catch(() => {
        failures += 1;
        return [];
      });
      children.sort((left, right) => Number(left === '.profiledesk-data-root.json') - Number(right === '.profiledesk-data-root.json'));
      for (const child of children) await walk(path.join(entry, child));
      await fs.promises.rmdir(entry).catch(() => { failures += 1; });
      return;
    }
    files += 1;
    await overwriteFile(entry);
    await fs.promises.unlink(entry).catch(() => { failures += 1; });
  };
  await walk(path.resolve(target));
  await fs.promises.rm(target, { recursive: true, force: true }).catch(() => { failures += 1; });
  return { files, failures };
}

class DataDirectoryService {
  constructor(defaultUserData) {
    this.defaultUserData = path.resolve(defaultUserData);
    this.defaultRoot = path.join(this.defaultUserData, 'workspace');
    this.locatorFile = path.join(this.defaultUserData, 'profiledesk-location.json');
    this.data = {
      version: LOCATOR_VERSION,
      activeRoot: this.defaultRoot,
      rootToken: randomUUID(),
      pendingMigration: null,
      pendingWipe: '',
      cleanupRoots: [],
      pendingDeletes: [],
    };
  }

  async readLocator() {
    await fs.promises.mkdir(this.defaultUserData, { recursive: true });
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.locatorFile, 'utf8'));
      this.data = {
        version: LOCATOR_VERSION,
        activeRoot: String(parsed.activeRoot || this.defaultRoot),
        rootToken: String(parsed.rootToken || randomUUID()),
        pendingMigration: parsed.pendingMigration || null,
        pendingWipe: String(parsed.pendingWipe || ''),
        cleanupRoots: Array.isArray(parsed.cleanupRoots) ? parsed.cleanupRoots.map(String).slice(0, 10) : [],
        pendingDeletes: Array.isArray(parsed.pendingDeletes) ? parsed.pendingDeletes.map(String).slice(0, 1000) : [],
      };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await fs.promises.copyFile(this.locatorFile, `${this.locatorFile}.invalid-${Date.now()}`).catch(() => {});
      }
      await this.save();
    }
  }

  async save() {
    const temporary = `${this.locatorFile}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await fs.promises.rename(temporary, this.locatorFile);
  }

  assertOwnedRoot(target) {
    const resolved = path.resolve(target);
    if (samePath(resolved, this.defaultRoot)) return resolved;
    if (path.basename(resolved) !== 'ProfileDeskData') throw new Error('数据目录格式无效');
    if (samePath(resolved, path.parse(resolved).root)) throw new Error('不能把磁盘根目录作为数据目录');
    return resolved;
  }

  markerFile(root) {
    return path.join(root, '.profiledesk-data-root.json');
  }

  async ensureOwnership(root, allowCreate = false) {
    const marker = this.markerFile(root);
    try {
      const parsed = JSON.parse(await fs.promises.readFile(marker, 'utf8'));
      if (parsed.app !== 'ProfileDesk' || parsed.token !== this.data.rootToken) throw new Error('数据目录所有权标记不匹配');
    } catch (error) {
      if (!allowCreate || (error.code && error.code !== 'ENOENT')) throw error;
      await fs.promises.mkdir(root, { recursive: true });
      await fs.promises.writeFile(marker, JSON.stringify({ app: 'ProfileDesk', token: this.data.rootToken }), { mode: 0o600 });
    }
  }

  targetForBase(baseDirectory) {
    const base = path.resolve(String(baseDirectory || ''));
    if (!baseDirectory || samePath(base, path.parse(base).root)) throw new Error('请选择普通文件夹，不能选择磁盘根目录');
    return this.assertOwnedRoot(path.join(base, 'ProfileDeskData'));
  }

  assertAccountDataPath(rootDir, target) {
    const root = this.assertOwnedRoot(rootDir);
    const resolved = path.resolve(String(target || ''));
    const allowedParents = [path.join(root, 'profiles'), path.join(root, 'downloads')];
    if (!allowedParents.some((parent) => samePath(path.dirname(resolved), parent))) {
      throw new Error('待删除账户数据路径超出允许范围');
    }
    return resolved;
  }

  async init() {
    await this.readLocator();
    await this.save();
    this.data.activeRoot = this.assertOwnedRoot(this.data.activeRoot);

    if (this.data.pendingWipe) {
      const wipeRoot = this.assertOwnedRoot(this.data.pendingWipe);
      if (!samePath(wipeRoot, this.data.activeRoot)) throw new Error('待删除目录与当前数据目录不一致');
      if (await pathExists(wipeRoot)) {
        await this.ensureOwnership(wipeRoot);
        await secureRemoveTree(wipeRoot);
      }
      this.data.pendingWipe = '';
      this.data.pendingDeletes = [];
      await this.save();
    }

    const mayInitializeCurrent = samePath(this.data.activeRoot, this.defaultRoot) || !await pathExists(this.data.activeRoot);
    await this.ensureOwnership(this.data.activeRoot, mayInitializeCurrent);
    if (this.data.pendingDeletes.length) {
      const remaining = [];
      for (const item of this.data.pendingDeletes) {
        try {
          const target = this.assertAccountDataPath(this.data.activeRoot, item);
          await secureRemoveTree(target);
          if (await pathExists(target)) remaining.push(target);
        } catch {
          remaining.push(item);
        }
      }
      this.data.pendingDeletes = remaining;
      await this.save();
    }

    const pending = this.data.pendingMigration;
    if (pending) {
      const source = this.assertOwnedRoot(pending.sourceRoot);
      const target = this.assertOwnedRoot(pending.targetRoot);
      if (!samePath(source, this.data.activeRoot)) throw new Error('待迁移目录与当前数据目录不一致');
      if (isInside(source, target) || isInside(target, source)) throw new Error('新旧数据目录不能互相嵌套');
      await this.ensureOwnership(source);
      if (await pathExists(target)) {
        await this.ensureOwnership(target);
      } else {
        const staging = `${target}.migrating-${randomUUID()}`;
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        if (await pathExists(source)) await fs.promises.cp(source, staging, { recursive: true, errorOnExist: true });
        else await fs.promises.mkdir(staging, { recursive: true });
        await fs.promises.rename(staging, target);
      }
      this.data.activeRoot = target;
      this.data.pendingMigration = null;
      this.data.cleanupRoots = [...new Set([...this.data.cleanupRoots, source])];
      await this.save();
      await secureRemoveTree(source);
      this.data.cleanupRoots = this.data.cleanupRoots.filter((item) => !samePath(item, source));
      await this.save();
    }

    for (const item of [...this.data.cleanupRoots]) {
      const cleanupRoot = this.assertOwnedRoot(item);
      if (samePath(cleanupRoot, this.data.activeRoot)) continue;
      if (await pathExists(cleanupRoot)) {
        await this.ensureOwnership(cleanupRoot);
        await secureRemoveTree(cleanupRoot);
      }
      this.data.cleanupRoots = this.data.cleanupRoots.filter((value) => !samePath(value, cleanupRoot));
      await this.save();
    }

    const mayInitializeDefault = samePath(this.data.activeRoot, this.defaultRoot);
    await this.ensureOwnership(this.data.activeRoot, mayInitializeDefault || !await pathExists(this.data.activeRoot));
    return this.data.activeRoot;
  }

  async scheduleMigration(sourceRoot, baseDirectory) {
    const source = this.assertOwnedRoot(sourceRoot);
    const target = this.targetForBase(baseDirectory);
    if (samePath(source, target)) return { changed: false, targetRoot: target };
    if (isInside(source, target) || isInside(target, source)) throw new Error('新旧数据目录不能互相嵌套');
    if (await pathExists(target)) throw new Error('目标中的 ProfileDeskData 已存在，请选择其他文件夹');
    await this.ensureOwnership(source);
    this.data.activeRoot = source;
    this.data.pendingMigration = { sourceRoot: source, targetRoot: target };
    await this.save();
    return { changed: true, targetRoot: target };
  }

  async scheduleWipe(rootDir) {
    const target = this.assertOwnedRoot(rootDir);
    if (!samePath(target, this.data.activeRoot)) throw new Error('只能删除当前数据目录');
    await this.ensureOwnership(target);
    this.data.pendingWipe = target;
    await this.save();
  }

  async scheduleAccountDataRemoval(rootDir, paths) {
    const root = this.assertOwnedRoot(rootDir);
    if (!samePath(root, this.data.activeRoot)) throw new Error('只能登记当前数据目录中的账户文件');
    await this.ensureOwnership(root);
    const targets = (Array.isArray(paths) ? paths : []).map((item) => this.assertAccountDataPath(root, item));
    this.data.pendingDeletes = [...new Set([...this.data.pendingDeletes, ...targets])].slice(0, 1000);
    await this.save();
    return targets.length;
  }

  async removeAccountDataNow(rootDir, paths) {
    const root = this.assertOwnedRoot(rootDir);
    if (!samePath(root, this.data.activeRoot)) throw new Error('只能清理当前数据目录中的账户文件');
    await this.ensureOwnership(root);
    const targets = (Array.isArray(paths) ? paths : []).map((item) => this.assertAccountDataPath(root, item));
    const remaining = [];
    for (const target of targets) {
      await secureRemoveTree(target);
      if (await pathExists(target)) remaining.push(target);
    }
    const selected = new Set(targets.map((item) => path.resolve(item)));
    this.data.pendingDeletes = this.data.pendingDeletes.filter((item) => !selected.has(path.resolve(item)));
    this.data.pendingDeletes = [...new Set([...this.data.pendingDeletes, ...remaining])].slice(0, 1000);
    await this.save();
    return { removed: targets.length - remaining.length, pendingPaths: remaining };
  }
}

module.exports = { DataDirectoryService, secureRemoveTree };
