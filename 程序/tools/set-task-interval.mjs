// 按 config.json 的 intervals 同步 Windows 计划任务的触发间隔
// 用法：node 程序/tools/set-task-interval.mjs
// 说明：任务按「最小间隔」触发（如 Codex 1 分钟、余额 5 分钟 → 任务每 1 分钟跑一次），
//       各平台是否真正取数由 collect.mjs 按自己的间隔判断。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig, ROOT_DIR } from '../lib/common.mjs';

const TASK_NAME = 'AI-Capability-Board-Collect';
const ROOT = ROOT_DIR;                       // 项目根（计划任务的 -WorkingDirectory 用它）
const cfg = loadConfig();
const codexIv = Number(cfg.intervals?.codexMinutes) || 5;
const balanceIv = Number(cfg.intervals?.balanceMinutes) || 5;
const minutes = Math.max(1, Math.min(codexIv, balanceIv));

const vbs = path.join(ROOT, '快捷操作', '立即采集一次.vbs');
if (!fs.existsSync(vbs)) { console.error(`❌ 未找到运行器: ${vbs}`); process.exit(1); }

function ps(script) {
  const b64 = Buffer.from(`$ProgressPreference='SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', b64], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'ignore'] });
}

try {
  const out = ps(`
$ErrorActionPreference = 'Stop'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${vbs}"' -WorkingDirectory '${ROOT}'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${minutes}) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
$t = Get-ScheduledTask -TaskName '${TASK_NAME}'
$info = $t.Triggers[0].Repetition.Interval
Write-Output "TASK-OK interval=$info"
`);
  console.log(out.trim().replace('TASK-OK ', '✅ 计划任务已同步：触发间隔 '));
  console.log(`   采集策略：Codex 每 ${codexIv} 分钟 · 余额（DeepSeek/GLM）每 ${balanceIv} 分钟`);
} catch (e) {
  console.error('❌ 同步失败:', String(e.message ?? e).slice(0, 300));
  process.exit(1);
}
