import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { atomicJson } from '../lib/updates.mjs';
import { stopOwned } from './windows-integration.mjs';
import { ROOT_DIR } from '../lib/common.mjs';

const ROOT = ROOT_DIR;                       // 项目根（VERSION / backups / data 都在那一层）
const PERSONAL = ['config.json', 'secrets.json', 'data', 'dashboard-data.js', 'update-data.js'];
function contained(root, relative) {
  const full = path.resolve(root, relative);
  if (!relative || path.isAbsolute(relative) || !full.startsWith(path.resolve(root) + path.sep)) throw new Error('快照路径越界');
  let current = path.resolve(root);
  for (const part of path.relative(root, full).split(path.sep)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('快照路径不能穿过链接');
  }
  return full;
}
function copyTree(source, target) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('快照不接受链接目录');
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(source)) {
      if (['updates', 'update.lock', 'upgrade-transaction.json'].includes(name)) continue;
      copyTree(path.join(source, name), path.join(target, name));
    }
  } else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target); }
}
export function prepareUpgrade(root = ROOT, { isolated = false } = {}) {
  if (!fs.existsSync(path.join(root, 'VERSION'))) return;
  const marker = path.join(root, 'data/upgrade-transaction.json');
  if (fs.existsSync(marker)) throw new Error('上一次升级尚未收尾，请先运行恢复');
  const manifestPath = path.join(root, 'release/installed-files.json');
  // 2026-09-17 目录整理后的清单（脚本 → 「快捷操作」、程序代码 → 「程序」）。
  // 只在装好的版本里没有 installed-files.json 时用到（开发/便携场景）。
  const files = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')).files :
    ['VERSION', 'dashboard.html', '程序', '快捷操作', 'assets', 'release', 'runtime', 'config.template.json'];
  const relative = `backups/upgrade-${Date.now()}`;
  const backup = contained(root, relative);
  // Write a guard before stopping tasks; the collector respects it even if manually triggered.
  atomicJson(marker, { backup: relative, phase: 'preparing', createdAt: Date.now(), isolated });
  try {
    stopOwned(root, { isolated });
    const copied = [];
    for (const file of [...new Set([...files, ...PERSONAL])]) {
      const source = contained(root, file);
      if (fs.existsSync(source)) { copyTree(source, contained(backup, file)); copied.push(file); }
    }
    atomicJson(path.join(backup, 'snapshot.json'), { files: copied, createdAt: Date.now() });
    atomicJson(marker, { backup: relative, phase: 'prepared', createdAt: Date.now(), isolated });
    return backup;
  } catch (e) { fs.rmSync(marker, { force: true }); resume(root, isolated); throw e; }
}
function resume(root, isolated) {
  if (!isolated && fs.existsSync(path.join(root, '程序/tools/install.mjs'))) {
    execFileSync(path.join(root, 'runtime/node.exe'), [path.join(root, '程序/tools/install.mjs'), '--skip-verify'], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
  }
}
export function finishUpgrade(root = ROOT, { rollback = false, isolated = false } = {}) {
  const marker = path.join(root, 'data/upgrade-transaction.json');
  if (!fs.existsSync(marker)) return;
  const transaction = JSON.parse(fs.readFileSync(marker, 'utf8'));
  const backup = contained(root, transaction.backup);
  if (!transaction.backup.startsWith('backups/upgrade-')) throw new Error('快照目录不正确');
  if (rollback) {
    const snapshot = JSON.parse(fs.readFileSync(path.join(backup, 'snapshot.json'), 'utf8'));
    for (const file of snapshot.files) {
      // User data is never overwritten during installation, and may have changed independently.
      if (PERSONAL.includes(file) || file.startsWith('data/')) continue;
      copyTree(contained(backup, file), contained(root, file));
    }
  }
  fs.unlinkSync(marker);
  if (rollback) resume(root, isolated || transaction.isolated);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const action = process.argv[2];
    const opt = { isolated: process.argv.includes('--isolated') };
    if (action === 'prepare') prepareUpgrade(ROOT, opt);
    else if (['finish', 'rollback'].includes(action)) finishUpgrade(ROOT, { ...opt, rollback: action === 'rollback' });
    else throw new Error('未知升级操作');
  } catch { console.error('升级准备或恢复未完成，备份已保留，请通过帮助与反馈联系维护者'); process.exitCode = 1; }
}
