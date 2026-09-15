// 在指定项目目录打开 ThinCoder 工作台（供看板「额度去向」中带 TC 标记的项目调用）
// 用法：node tools/open-tc.mjs <URI 编码后的目录路径> [--dry]
// 优先用 Windows Terminal（wt.exe）新开标签/窗口；没有 wt 时回退到 cmd start。
// 安全：与 open-path.mjs 同样的白名单校验（存在 + 是目录 + 落在允许的根目录内）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, ROOT_DIR, isAllowedPath, allowedRootsText } from '../lib/common.mjs';

const raw = process.argv[2] ?? '';
const dry = process.argv.includes('--dry');
let target = '';
try { target = decodeURIComponent(raw); } catch { target = raw; }
target = target.replace(/^file:\/\/\//, '').replace(/\//g, path.sep);

const log = msg => console.log(`${new Date().toISOString()} ${msg}`);
if (!target) { log('未提供路径'); process.exit(1); }

let stat;
try { stat = fs.statSync(target); } catch { log(`路径不存在：${target}`); process.exit(1); }
if (!stat.isDirectory()) { log(`不是目录：${target}`); process.exit(1); }

// 白名单与 open-path.mjs 同源（lib/common.mjs 的 isAllowedPath）：项目目录 + projectsRoots + tcRoots。
// 这三份清单默认都是空的——发布版不能写死任何人的目录结构（旧版曾把作者的个人目录清单硬编码在这里）。
const cfg2 = loadConfig();
if (!isAllowedPath(cfg2, target)) {
  log(`拒绝：${target} 不在允许的根目录内（${allowedRootsText(cfg2)}）`);
  log('提示：把你自己的项目总目录填进 config.json 的 projectsRoots；若要允许其他常用目录，填进 tcRoots。');
  process.exit(1);
}

const tcCmd = process.platform === 'win32' ? 'thincoder.cmd' : 'thincoder';
// 用 cmd /k 包一层：thincoder 退出后窗口保留（能看到报错）；有 Windows Terminal 则用它开新窗口
// ⚠️ 不能用 fs.existsSync 判断 wt.exe：它在受保护的 WindowsApps 目录下，existsSync 因 EACCES 会返回 false（假阴性），
//    改用 where.exe 走 PATH 探测。
let hasWt = false;
try {
  const { spawnSync } = await import('node:child_process');
  hasWt = spawnSync('where.exe', ['wt.exe'], { stdio: 'ignore', timeout: 10000 }).status === 0;
} catch { hasWt = false; }

if (dry) {
  log(`将执行：${hasWt ? `wt.exe -d "${target}" cmd /k ${tcCmd}` : `cmd start "ThinCoder" /D "${target}" cmd /k ${tcCmd}`}（试运行，未实际启动）`);
  process.exit(0);
}

if (hasWt) {
  spawn('wt.exe', ['-d', target, 'cmd', '/k', tcCmd], { detached: true, stdio: 'ignore' }).unref();
} else {
  spawn('cmd', ['/c', 'start', 'ThinCoder', '/D', target, 'cmd', '/k', tcCmd], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
}
log(`已在 ${target} 启动 ThinCoder 工作台${hasWt ? '（Windows Terminal）' : ''}`);
