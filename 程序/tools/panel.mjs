// 悬浮看板的开关（唯一执行端）：三处入口（网页面板按钮 / 托盘菜单 / 面板右键）都走它。
//
// 为什么要有它：装完就一直在的东西必须关得掉，而且关掉之后还得能开回来 ——
//   开关的真相源只有一个：config.json 的 panel.enabled（与 tray.enabled 同一套先例；缺字段 = 开）。
//   面板进程自己也读这个字段（读不到就退出），升级事务文件在时同样退出（照托盘的第二道保险）。
//
// 用法：node 程序/tools/panel.mjs on|off|toggle|status
//   on     开启：写 panel.enabled=true，然后拉起面板（已在跑就不重开）
//   off    关闭：写 panel.enabled=false，然后只停「这个安装目录里的」board.exe（按路径，不按名字裸杀）
//   toggle 取反
//   status 只报告：enabled=… running=…（不改任何东西）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { powershell, psQuote } from './windows-integration.mjs';

export const 面板相对路径 = '程序/bin/board.exe';

export function 配置路径(root) { return path.join(root, 'config.json'); }

// 读开关：缺字段 / 读不到 / 坏 JSON 一律当「开」（与面板进程同一条纪律：不假装用户关过）
export function 面板已启用(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(配置路径(root), 'utf8'));
    return !(cfg?.panel && cfg.panel.enabled === false);
  } catch { return true; }
}

// 写开关：只动 panel.enabled 这一个字段，别的原样保留；写不进去就把错误抛给调用方（不静默）
export function 设置面板(root, enabled) {
  const file = 配置路径(root);
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cfg = {}; }
  cfg.panel = { ...(cfg.panel ?? {}), enabled: !!enabled };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return cfg.panel.enabled;
}

// 面板在不在跑：按**可执行文件路径**匹配（与 windows-integration.mjs 的 stopOwned 第三条规则同一条判据）
export function 面板在跑(root) {
  const exe = path.join(root, ...面板相对路径.split('/'));
  const out = powershell(`$exe = ${psQuote(exe)}
$n = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'board.exe' -and $_.ExecutablePath -ieq $exe }).Count
Write-Output $n`);
  return Number(String(out).trim()) > 0;
}

// 只停这一个安装目录里的面板：**不按名字裸杀**（avoid 误伤别人的同名程序）
export function 停面板(root) {
  const exe = path.join(root, ...面板相对路径.split('/'));
  powershell(`$exe = ${psQuote(exe)}
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'board.exe' -and $_.ExecutablePath -ieq $exe } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
}

// 拉起面板：**直接起 exe**（不能去跑「悬浮看板.vbs」—— 那个入口自己会回来调本工具，会变成无限递归）
export function 起面板(root) {
  const exe = path.join(root, ...面板相对路径.split('/'));
  if (!fs.existsSync(exe)) {
    throw new Error(`找不到面板 exe（${面板相对路径}）—— 先跑 node release/build-panel.mjs 或重装`);
  }
  powershell(`Start-Process -FilePath ${psQuote(exe)} -WorkingDirectory ${psQuote(root)} -WindowStyle Hidden`);
  return 面板相对路径;
}

function 主流程() {
  const root = process.env.AI_BOARD_ROOT || path.resolve(import.meta.dirname, '..', '..');
  const arg = (process.argv[2] ?? 'status').toLowerCase();
  if (!['on', 'off', 'toggle', 'status'].includes(arg)) {
    console.error(`用法：node 程序/tools/panel.mjs on|off|toggle|status（收到的是「${arg}」）`);
    process.exitCode = 2;
    return;
  }
  const 之前 = 面板已启用(root);
  if (arg === 'status') {
    let running = false;
    try { running = 面板在跑(root); } catch { running = false; }
    console.log(`悬浮看板：${之前 ? '开' : '关'}（config.json panel.enabled=${之前}）· 进程${running ? '在跑' : '没跑'} · 目录 ${root}`);
    return;
  }
  const 目标 = arg === 'toggle' ? !之前 : arg === 'on';
  设置面板(root, 目标);
  if (目标) {
    let note = '已在运行，不重开';
    try {
      if (!面板在跑(root)) note = `已拉起（${起面板(root)}）`;
    } catch (e) {
      console.error(`开关已写（开），但拉起面板失败：${String(e.message ?? e).slice(0, 200)}`);
      process.exitCode = 1;
      return;
    }
    console.log(`悬浮看板：开（panel.enabled=true）· ${note}`);
  } else {
    try { 停面板(root); } catch (e) {
      console.error(`开关已写（关），但停面板失败：${String(e.message ?? e).slice(0, 200)}`);
      process.exitCode = 1;
      return;
    }
    console.log('悬浮看板：关（panel.enabled=false，面板已停）');
  }
}

const 是脚本入口 = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (是脚本入口) 主流程();
