import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const psQuote = text => `'${String(text).replace(/'/g, "''")}'`;
export function powershell(script) {
  const env = { ...process.env };
  delete env.PSModulePath; // A caller running PowerShell 7 can otherwise break Windows PowerShell modules.
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'\n${script}`, 'utf16le').toString('base64')],
    { env, encoding: 'utf8', windowsHide: true, timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'] });
}

// Only touch registrations belonging to this installation. A developer checkout can coexist.
export function stopOwned(root, { remove = false, isolated = false } = {}) {
  if (isolated) return;
  powershell(`
$root = ${psQuote(path.resolve(root))}
$collectVbs = Join-Path $root '运行采集.vbs'
$tray = Join-Path $root 'tools\\tray.ps1'
$protocol = Join-Path $root '运行协议.vbs'
$runtime = Join-Path $root 'runtime\\node.exe'
$owned = $false
foreach ($name in @('AI-Capability-Board-Collect','AI-Quota-Board-Collect')) {
  $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
  if ($task -and @($task.Actions | Where-Object { $_.Arguments -eq ('"' + $collectVbs + '"') }).Count -gt 0) {
    $owned = $true
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    ${remove ? 'Unregister-ScheduledTask -TaskName $name -Confirm:$false' : 'Disable-ScheduledTask -TaskName $name | Out-Null'}
  }
}
Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -ne ${process.pid} -and (
    ($_.Name -eq 'powershell.exe' -and $_.CommandLine -and $_.CommandLine.IndexOf(('"' + $tray + '"'), [StringComparison]::OrdinalIgnoreCase) -ge 0) -or
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
  if ($command.Contains(('"' + $protocol + '"'))) {
    Remove-Item -LiteralPath $key -Recurse -Force
    $appKey = 'HKCU:\\Software\\Classes\\AppUserModelId\\AIQuotaBoard'
    if (Test-Path -LiteralPath $appKey) { Remove-Item -LiteralPath $appKey -Recurse -Force }
  }
}
` : ''}
`);
}
