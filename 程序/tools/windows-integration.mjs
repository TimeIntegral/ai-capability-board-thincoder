import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const psQuote = text => `'${String(text).replace(/'/g, "''")}'`;
export function powershell(script) {
  const env = { ...process.env };
  delete env.PSModulePath; // A caller running PowerShell 7 can otherwise break Windows PowerShell modules.
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'\n${script}`, 'utf16le').toString('base64')],
    { env, encoding: 'utf8', windowsHide: true, timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
}

// 2026-09-17 目录整理：用户脚本进了「快捷操作」、程序代码进了「程序」。
// 本文件同时认新老两处位置 —— 覆盖升级后的机器上会短暂/长期并存两套注册
// （旧计划任务、旧协议命令、旧托盘进程），只认新位置就漏掉旧的那一套，删不干净。
const QUICK_OLD = ['快捷操作\\立即采集一次.vbs', '运行采集.vbs'];
const TRAY_OLD = ['程序\\tools\\tray.ps1', 'tools\\tray.ps1'];
const PROTOCOL_OLD = ['程序\\运行协议.vbs', '运行协议.vbs'];

// Only touch registrations belonging to this installation. A developer checkout can coexist.
export function stopOwned(root, { remove = false, isolated = false } = {}) {
  if (isolated) return;
  const abs = rels => rels.map(rel => path.join(root, rel));
  const psArray = values => values.map(v => psQuote(v)).join(',');
  const psQuotedArray = values => psArray(values.map(v => `"${v}"`));
  const collectVbs = abs(QUICK_OLD);
  const tray = abs(TRAY_OLD);
  const protocol = abs(PROTOCOL_OLD);
  const runtime = path.join(root, 'runtime', 'node.exe');
  powershell(`
$root = ${psQuote(path.resolve(root))}
$collectArgs = @(${psQuotedArray(collectVbs)})
$trayPaths = @(${psArray(tray)})
$protocolPaths = @(${psArray(protocol)})
$runtime = ${psQuote(runtime)}
# 大小写不敏感地看命令行里有没有出现这些路径中的任意一个
function Test-AnyHit([string]$haystack, [string[]]$needles) {
  foreach ($needle in $needles) {
    if ($haystack.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
  }
  return $false
}
$owned = $false
foreach ($name in @('AI-Capability-Board-Collect','AI-Quota-Board-Collect')) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task -and @($task.Actions | Where-Object { $collectArgs -contains $_.Arguments }).Count -gt 0) {
    $owned = $true
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    ${remove ? 'Unregister-ScheduledTask -TaskName $name -Confirm:$false' : 'Disable-ScheduledTask -TaskName $name | Out-Null'}
  }
}
Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne ${process.pid} -and (
    ($_.Name -eq 'powershell.exe' -and $_.CommandLine -and (Test-AnyHit $_.CommandLine $trayPaths)) -or
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -eq $runtime)
  )
} | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }
${remove ? `
$ws = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Startup'))) {
  foreach ($name in @('AI 能力看板','AI 额度看板','AI 能力看板 托盘','AI 额度看板 托盘')) {
    $file = Join-Path $folder ($name + '.lnk')
    if (Test-Path -LiteralPath $file) {
      $link = $ws.CreateShortcut($file)
      if ($link.WorkingDirectory -eq $root) { Remove-Item -LiteralPath $file -Force }
    }
  }
}
$key = 'HKCU:\\Software\\Classes\\aiquotaboard'
$commandKey = Join-Path $key 'shell\\open\\command'
if (Test-Path -LiteralPath $commandKey) {
  $command = (Get-Item -LiteralPath $commandKey).GetValue('')
  if (Test-AnyHit $command $protocolPaths) {
    Remove-Item -LiteralPath $key -Recurse -Force
    $appKey = 'HKCU:\\Software\\Classes\\AppUserModelId\\AIQuotaBoard'
    if (Test-Path -LiteralPath $appKey) { Remove-Item -LiteralPath $appKey -Recurse -Force }
  }
}
` : ''}
`);
}
