// 打开本地项目文件夹（供看板「额度去向」每行点击调用）
// 用法：node tools/open-path.mjs <URI 编码后的路径>
// 安全：只允许打开「存在于本机、确实是目录」的路径；且路径必须落在白名单根目录下
// （lib/common.mjs 的 isAllowedPath：本项目目录 + config.projectsRoots + config.tcRoots）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, ROOT_DIR, isAllowedPath, allowedRootsText } from '../lib/common.mjs';

const raw = process.argv[2] ?? '';
const dry = process.argv.includes('--dry'); // 试运行：只做校验与日志，不真的弹资源管理器
let target = '';
try { target = decodeURIComponent(raw); } catch { target = raw; }
target = target.replace(/^file:\/\/\//, '').replace(/\//g, path.sep);

const log = msg => console.log(`${new Date().toISOString()} ${msg}`);

if (!target) { log('未提供路径'); process.exit(1); }

let stat;
try { stat = fs.statSync(target); } catch { log(`路径不存在：${target}`); process.exit(1); }
if (!stat.isDirectory()) { log(`不是目录：${target}`); process.exit(1); }

// 允许打开的根：项目自身目录 + config.projectsRoots（默认空——发布版不能写死别人的目录）
const cfg = loadConfig();
if (!isAllowedPath(cfg, target)) {
  log(`拒绝：${target} 不在允许的根目录内（${allowedRootsText(cfg)}）`);
  log('提示：把你自己的项目总目录填进 config.json 的 projectsRoots 即可放行。');
  process.exit(1);
}

// explorer.exe 打开成功也可能返回非 0，故不等待、不判断退出码
if (!dry) spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' }).unref();
log(`已打开${dry ? '（试运行，未实际打开）' : ''}：${target}`);
