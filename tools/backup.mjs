// 一键备份：把配置、状态、全部历史与日志打包成 zip（永久保留的数据需要一个出口）
// 用法：node tools/backup.mjs   （或看板上的「备份」按钮，经 aiquotaboard://backup 调用）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, ROOT_DIR, loadConfig } from '../lib/common.mjs';

const KEEP_DEFAULT = 10;

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// 递归拷贝：**不要用 fs.cpSync** —— Node v24.14.0 在中文路径下会原生崩溃
// （exit 0xC0000409，无 JS 异常可捕获）。逐文件 copyFileSync 实测正常。
function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyRecursive(path.join(src, name), path.join(dst, name));
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

export function runBackup() {
  const cfg = loadConfig();
  const keep = Math.max(1, Number(cfg.backup?.keep) || KEEP_DEFAULT);
  const outDir = path.join(ROOT_DIR, 'backups');
  fs.mkdirSync(outDir, { recursive: true });

  // 暂存：只挑需要备份的内容（history 是主体，其余是配置与状态）
  const stage = path.join(outDir, `.stage-${stamp()}`);
  fs.mkdirSync(path.join(stage, 'data'), { recursive: true });
  const items = [
    ['data/history', 'data/history'],
    ['data/state.json', 'data/state.json'],
    ['data/alerts.json', 'data/alerts.json'],
    ['data/series-cache.json', 'data/series-cache.json'],
    ['data/mute.json', 'data/mute.json'],
    ['data/balance-mute.json', 'data/balance-mute.json'],
    ['data/attribution.json', 'data/attribution.json'],
    ['config.json', 'config.json'],
    ['config.template.json', 'config.template.json'],
  ];
  let copied = 0;
  for (const [from, to] of items) {
    const src = path.join(ROOT_DIR, from);
    if (!fs.existsSync(src)) continue;
    try { copyRecursive(src, path.join(stage, to)); copied += 1; } catch { /* 跳过读不到的文件 */ }
  }

  const zip = path.join(outDir, `quota-backup-${stamp()}.zip`);
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `$ProgressPreference='SilentlyContinue'; Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`],
    { stdio: 'ignore', timeout: 300000 });
  fs.rmSync(stage, { recursive: true, force: true });

  // 轮转：只保留最近 N 份
  const all = fs.readdirSync(outDir).filter(f => f.startsWith('quota-backup-') && f.endsWith('.zip')).sort();
  const removed = [];
  while (all.length > keep) { const f = all.shift(); fs.rmSync(path.join(outDir, f), { force: true }); removed.push(f); }

  const size = fs.statSync(zip).size;
  return { zip, sizeMB: Number((size / 1048576).toFixed(2)), copied, kept: all.length, removed };
}

if (process.argv[1] && process.argv[1].endsWith('backup.mjs')) {
  try {
    const r = runBackup();
    console.log(`${new Date().toISOString()} 备份完成：${path.basename(r.zip)}（${r.sizeMB}MB，含 ${r.copied} 项）${r.removed.length ? ` · 清理旧备份 ${r.removed.length} 份` : ''}`);
    console.log(r.zip);
  } catch (e) {
    console.error(`${new Date().toISOString()} 备份失败：${String(e.message ?? e).slice(0, 200)}`);
    process.exitCode = 1;
  }
}
