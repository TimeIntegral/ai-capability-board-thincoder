// 装好的目录里「不该留着的东西」—— 旧版结构残留 + 旧发布包漏发的开发件。
//
// 与 release/publish-files.mjs 的「仅供开发」清单是一对：
//   那边（发包侧）管「以后不再发给用户」；这份（安装侧）管「已经发出去的，升级时清掉」。
//   新增会被误发的路径 → 加进白名单那侧；已经装在用户机器上的 → 加进这份。
//
// 两条硬规矩：
//   ① 只删这份固定清单里的路径，绝不按模式扫目录（用户自己的东西不在清单里就不动）；
//   ② **当前安装清单（程序/installed-files.json）里的文件一律不删** —— 清理清单记的是历史残留，
//      安装清单记的是「这一版要什么」；两者万一冲突，以安装清单为准，否则会把刚装好的文件删掉。
import fs from 'node:fs';
import path from 'node:path';

export const 旧版遗留 = [
  // 2026-09-17 之前的目录结构：脚本散在根目录、程序代码散在根目录的 tools/lib/alert/collectors
  'start.vbs', '运行采集.vbs', '连接平台.vbs', '启用自动采集.vbs', '托盘图标.vbs',
  '安装定时任务.bat', '卸载定时任务.bat', '静音2小时.bat', '取消静音.bat',
  'collect.mjs', 'mute.mjs', 'balance-mute.mjs', '运行协议.vbs',
  'lib', 'collectors', 'alert', 'tools',
  // 旧发布包里漏发的开发件（当时的清单直接取 git 跟踪的全部文件）
  '.github', '.gitignore', 'AGENTS.md', 'CHANGELOG.md',
  'release',                                    // 发布工具目录（渠道地址与安装清单已改住「程序」下）
  'docs/TODO.md', 'docs/batches', 'docs/design', 'docs/requirements', 'docs/连接与发布隔离.md',
  '程序/tools/test-connections.mjs', '程序/tools/test-dashboard.mjs',
  '程序/tools/test-distribution.mjs', '程序/tools/test-installer.mjs',
  '程序/tools/test-isolated.mjs', '程序/tools/test-rules.mjs',
  '程序/tools/rename-project.mjs',
];

// 递归删除不用 fs.rmSync(recursive)：中文路径下 Node 的递归 fs API 踩过原生崩溃
// （见 backup.mjs 里 fs.cpSync 的同类记录），逐层自走是已验证安全的做法。
function removeTree(target) {
  if (fs.lstatSync(target).isDirectory()) {
    for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

// 清理 root 下清单里的残留。已安装 = 本次安装清单（相对路径数组，可省略）。
// 返回 { removed, stuck, kept }：删掉的 / 删不掉的（被占用）/ 因属于当前安装而保留的。
// 绝不抛异常打断安装 —— 删不掉留给下次。
export function 清理旧版遗留(root, 已安装 = []) {
  const 属于当前安装 = rel => 已安装.some(f => f === rel || f.startsWith(`${rel}/`));
  const removed = [];
  const stuck = [];
  const kept = [];
  for (const rel of 旧版遗留) {
    if (属于当前安装(rel)) { kept.push(rel); continue; }
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) continue;
    try { removeTree(target); removed.push(rel); } catch { stuck.push(rel); }
  }
  return { removed, stuck, kept };
}

// 读本次安装清单里的文件（没有清单就返回空数组：便携解压 / 开发目录）。
export function 读取安装清单(root) {
  try {
    const 清单 = JSON.parse(fs.readFileSync(path.join(root, '程序', 'installed-files.json'), 'utf8'));
    return Array.isArray(清单.files) ? 清单.files : [];
  } catch { return []; }
}
