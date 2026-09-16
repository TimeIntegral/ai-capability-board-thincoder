// 一键安装/修复：注册计划任务（按配置的间隔）+ 桌面快捷方式 + 通知应用名
// 用法：node tools/install.mjs   （或双击 安装定时任务.bat）
// 开关：--skip-verify  不跑收尾的「首次采集验证」（首次配置向导会自己试采一次，避免连着采两遍）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../lib/common.mjs';
import { runFirstRunCheck } from './first-run-check.mjs';

const ROOT = path.dirname(import.meta.dirname);
// 用当前正在跑的这个 node 去拉起子脚本 —— 比写死 'node' 更可靠：
// 发布包内置便携 Node 时（runtime/node.exe），用户可能根本没装 Node，PATH 里没有 node。
// process.execPath 指向的就是此刻执行本文件的解释器，两种情况都正确。
const NODE = process.execPath;
// 项目于 2026-09-13 从「额度看板」更名为「能力看板」，任务名与快捷方式随之更新；
// 旧名会在安装时被清理，避免两个任务同时跑。
const TASK_NAME = 'AI-Capability-Board-Collect';
if (fs.existsSync(path.join(ROOT, '.git'))) {
  console.error('开发目录不注册后台任务。请使用独立安装版。');
  process.exit(1);
}
const LEGACY_TASK_NAMES = ['AI-Quota-Board-Collect'];
const SHORTCUT_NAME = 'AI 能力看板';
const LEGACY_SHORTCUT_NAMES = ['AI 额度看板'];
if (!fs.existsSync(path.join(ROOT, 'config.json'))) {
  fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify({ platforms: { codex: false, deepseek: false, glm: false } }, null, 2));
}
const cfg = loadConfig();
const codexIv = Number(cfg.intervals?.codexMinutes) || 5;
const balanceIv = Number(cfg.intervals?.balanceMinutes) || 5;
const minutes = Math.max(1, Math.min(codexIv, balanceIv));

function ps(script, timeout = 60000) {
  const env = { ...process.env }; delete env.PSModulePath;
  script = script.replaceAll(ROOT, ROOT.replace(/'/g, "''"));
  const b64 = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', b64], { env, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}

let failed = 0;
const step = (name, fn) => {
  try { const msg = fn(); console.log(`✅ ${name}${msg ? '：' + msg : ''}`); }
  catch (e) { failed++; console.error(`❌ ${name} 失败：${String(e.message ?? e).slice(0, 200)}`); }
};

// 1) 计划任务
step('计划任务已注册', () => {
  const vbs = path.join(ROOT, '运行采集.vbs');
  if (!fs.existsSync(vbs)) throw new Error(`未找到 ${vbs}`);
  ps(`
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${vbs}"' -WorkingDirectory '${ROOT}'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${minutes}) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
foreach ($old in @(${LEGACY_TASK_NAMES.map(n => `'${n}'`).join(',')})) {
  if (Get-ScheduledTask -TaskName $old -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $old -Confirm:$false }
}
`);
  return `${TASK_NAME} · 每 ${minutes} 分钟触发（Codex ${codexIv}min / 余额 ${balanceIv}min）`;
});

// 2) 图标（桌面快捷方式用）：缺 icon.ico 时按 icon.svg 生成
step('图标已就绪', () => {
  const ico = path.join(ROOT, 'icon.ico');
  if (!fs.existsSync(ico)) {
    const out = execFileSync(NODE, [path.join(import.meta.dirname, 'make-icon.mjs')], { encoding: 'utf8', timeout: 180000 });
    return out.trim().replace(/^✅\s*/, '');
  }
  return `icon.ico（${(fs.statSync(ico).size / 1024).toFixed(1)}KB）`;
});

// 3) 桌面快捷方式（旧名一并清理，避免桌面留两个图标）
step('桌面快捷方式已创建', () => {
  const dash = path.join(ROOT, 'start.vbs');
  const ico = path.join(ROOT, 'icon.ico');
  const icon = fs.existsSync(ico) ? ico : '%SystemRoot%\\System32\\imageres.dll,106';
  const out = ps(`
$ws = New-Object -ComObject WScript.Shell
$desk = [Environment]::GetFolderPath('Desktop')
foreach ($old in @(${LEGACY_SHORTCUT_NAMES.map(n => `'${n}'`).join(',')})) {
  $p = "$desk\\$old.lnk"; if (Test-Path $p) { Remove-Item $p -Force }
}
$lnk = $ws.CreateShortcut("$desk\\${SHORTCUT_NAME}.lnk")
$lnk.TargetPath = '${dash}'
$lnk.WorkingDirectory = '${ROOT}'
$lnk.IconLocation = '${icon}'
$lnk.Save()
Write-Output $desk
`);
  return out.trim() + '\\' + SHORTCUT_NAME + '.lnk';
});

// 3) 通知应用名（失败不影响主功能：通知会回退到 PowerShell 应用名）
step('通知应用名已注册', () => {
  const out = execFileSync(NODE, [path.join(import.meta.dirname, 'register-app-id.mjs')], { encoding: 'utf8', timeout: 30000 });
  return out.trim().replace(/^✅\s*/, '');
});

// 4) URL 协议（看板/通知上的「不再提醒」等按钮依赖它）
step('按钮协议已注册', () => {
  const out = execFileSync(NODE, [path.join(import.meta.dirname, 'register-protocol.mjs')], { encoding: 'utf8', timeout: 30000 });
  return out.trim().replace(/^✅\s*/, '');
});

// 5) 托盘常驻 + 开机自启
step('托盘图标已注册', () => {
  if (cfg.tray?.enabled === false) return '已在 config.json 中关闭（tray.enabled=false），跳过';
  const vbs = path.join(ROOT, '托盘图标.vbs');
  if (!fs.existsSync(vbs)) throw new Error(`未找到 ${vbs}`);
  const icon = path.join(ROOT, 'icon.ico');
  const out = ps(`
$ws = New-Object -ComObject WScript.Shell
$startup = [Environment]::GetFolderPath('Startup')
foreach ($old in @(${LEGACY_SHORTCUT_NAMES.map(n => `'${n}'`).join(',')})) {
  $p = "$startup\\$old 托盘.lnk"; if (Test-Path $p) { Remove-Item $p -Force }
}
$lnk = $ws.CreateShortcut("$startup\\${SHORTCUT_NAME} 托盘.lnk")
$lnk.TargetPath = 'wscript.exe'
$lnk.Arguments = '"${vbs}"'
$lnk.WorkingDirectory = '${ROOT}'
$lnk.IconLocation = '${icon}'
$lnk.Description = '${SHORTCUT_NAME}托盘图标（开机自动启动）'
$lnk.Save()
# 立即启动一份（已在运行则先结束旧的，保证用的是最新脚本）
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains('"${path.join(ROOT, 'tools', 'tray.ps1')}"') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Process 'wscript.exe' -ArgumentList '"${vbs}"' -WorkingDirectory '${ROOT}' -WindowStyle Hidden
Write-Output $startup
`);
  return out.trim() + '\\' + SHORTCUT_NAME + ' 托盘.lnk（开机自启，已启动）';
});

console.log(failed ? `\n⚠️ ${failed} 个步骤失败（其余已生效）` : '\n全部完成。采集会自动运行，看板双击桌面快捷方式打开，托盘图标常驻在任务栏。');

// 收尾验证：真跑一次采集，把「到底成没成」用人话汇报出来（最后一句永远是可照做的下一步）。
// 这一步只报事实，不改退出码——退出码仍然只反映上面六步的成败，免得「注册失败」与「采不到数据」两件事被混在一起。
if (!process.argv.includes('--skip-verify')) {
  console.log('\n—— 试采一次，确认真的能采到数据 ——');
  const check = await runFirstRunCheck();
  if (!check.allOk) console.log('（上面没通的平台不影响其他平台，按它给的下一步处理即可。）');
}

// 用 exitCode 而不是 process.exit：报告要完整刷出去（Windows 上直接 exit 可能截断管道里的输出）
process.exitCode = failed ? 1 : 0;
