import fs from 'node:fs';
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

// ── 悬浮看板的开机自启快捷方式：建与删都住在这里（唯一出处）──────────────────
// 2026-10-27 真机实查的根因：install.mjs 那段 JS 模板字符串把路径分隔符写成了单反斜杠——
//   `"$startup\${SHORTCUT_NAME} 悬浮看板.lnk"` 里的 `\$` 被 JS 解释成「字面量 $」：
//   ① 分隔符没了；② `${SHORTCUT_NAME}` 原样丢给 PowerShell，而它是个未定义变量（= 空）。
//   于是 lnk 落到 **Programs 目录**、名叫「Startup 悬浮看板.lnk」——开机永远不执行。
//   真机上它就在那儿（Start Menu\\Programs\\Startup 悬浮看板.lnk，09/27 22:31:09，比托盘那个晚 4 秒），
//   而 Startup 目录里只有托盘。所以这里用 \\ 出真反斜杠，并且**建成后读回来逐项核对**：
//   WScript.Shell 的 Save 是静默失败的（路径不对、名字不对都只当没发生），不核对就等于没验证。
export const PANEL_SHORTCUT = 'AI 能力看板 悬浮看板';
// 上面那个 bug 造出来的错名文件：它在 Programs 里、名字却以 Startup 开头；怎么都不会被执行，见到就清。
export const PANEL_SHORTCUT_BAD = 'Startup 悬浮看板';

export function 写面板自启快捷方式(root, { 启用 = true, 启动目录 = '' } = {}) {
  const abs = path.resolve(root);
  const vbs = path.join(abs, '快捷操作', '悬浮看板.vbs');
  const icon = path.join(abs, 'icon.ico');
  const startup = 启动目录 ? `'${path.resolve(启动目录).replace(/'/g, "''")}'` : "[Environment]::GetFolderPath('Startup')";
  const out = powershell(`
# stdout 用 UTF-8：路径里有中文，按控制台默认代码页（936）回传就会变成乱码，
#   回执里的路径 JS 侧对不上盘（真机上表现为「建成了却说没建成」）
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$root = '${abs.replace(/'/g, "''")}'
$vbs = '${vbs.replace(/'/g, "''")}'
$icon = '${icon.replace(/'/g, "''")}'
$enabled = ${启用 ? '$true' : '$false'}
$startup = ${startup}
$wscript = Join-Path $env:SystemRoot 'system32\\wscript.exe'
$ws = New-Object -ComObject WScript.Shell
$file = Join-Path $startup '${PANEL_SHORTCUT}.lnk'
# 错名文件：无论开关都先清（它本身永远不会被执行；这也是它存在过的证据）
$bad = Join-Path ([Environment]::GetFolderPath('Programs')) '${PANEL_SHORTCUT_BAD}.lnk'
$badGone = $false
if (Test-Path -LiteralPath $bad) {
  $l = $ws.CreateShortcut($bad)
  if ($l.WorkingDirectory -eq $root) { Remove-Item -LiteralPath $bad -Force; $badGone = $true }
}
if (-not $enabled) {
  if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
  Write-Output ('off|' + $file + '|' + $badGone)
  exit 0
}
if (-not (Test-Path -LiteralPath $vbs)) { throw "找不到 $vbs（悬浮看板的启动脚本不在，不能建开机自启）" }
if (-not (Test-Path -LiteralPath $wscript)) { throw "找不到 $wscript" }
$lnk = $ws.CreateShortcut($file)
$lnk.TargetPath = $wscript
$lnk.Arguments = '"' + $vbs + '"'
$lnk.WorkingDirectory = $root
if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = $icon }
$lnk.Description = '${PANEL_SHORTCUT}（开机自动出现）'
$lnk.Save()
# 读回来核对：建错位置/建错名字/没写成，全在这里暴露
if (-not (Test-Path -LiteralPath $file)) { throw "快捷方式没建成：$file" }
$back = $ws.CreateShortcut($file)
if ($back.TargetPath -ne $wscript) { throw "快捷方式指向不对：$($back.TargetPath)（期望 $wscript）" }
if ($back.Arguments -notlike ('*' + $vbs + '*')) { throw "快捷方式参数不对：$($back.Arguments)" }
if ($back.WorkingDirectory -ne $root) { throw "快捷方式工作目录不对：$($back.WorkingDirectory)" }
Write-Output ('on|' + $file + '|' + $badGone)
`);
  const line = out.trim().split(/\r?\n/).filter(l => l.startsWith('on|') || l.startsWith('off|')).pop() ?? '';
  const [state, file, badGone] = line.split('|');
  if (!state) throw new Error(`自启快捷方式没有回执：${out}`);
  if (state === 'on' && !fs.existsSync(file)) throw new Error(`自启快捷方式没建成：${file}`);
  return { enabled: state === 'on', file, removedLegacy: badGone === 'True' };
}

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
    ($_.Name -eq 'node.exe' -and $_.ExecutablePath -eq $runtime) -or
    # 悬浮看板：**按可执行文件路径**匹配 —— 不按名字裸杀 board.exe（那样会误伤别人的同名程序）
    # 注意：这是 JS 模板字符串里的字面量，路径反斜杠必须写成「两条」——写一条会被 JS 当转义吃掉
    # （程序+退格+in+退格+oard.exe），针的路径就与真实 exe 路径永不相等：2026-09-27 演练实测踩过这个坑。
    ($_.Name -eq 'board.exe' -and $_.ExecutablePath -ieq (Join-Path $root '程序\\bin\\board.exe'))
  )
} | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }
${remove ? `
$ws = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Startup'))) {
  # 2026-10-27 补上「悬浮看板」那一个：以前卸载只删托盘，悬浮看板的 lnk 留在启动文件夹里，
  #   卸载完下次开机又把面板拉起来（与删除套件自相矛盾）。
  foreach ($name in @('AI 能力看板','AI 额度看板','AI 能力看板 托盘','AI 额度看板 托盘','${PANEL_SHORTCUT}','AI 额度看板 悬浮看板')) {
    $file = Join-Path $folder ($name + '.lnk')
    if (Test-Path -LiteralPath $file) {
      $link = $ws.CreateShortcut($file)
      if ($link.WorkingDirectory -eq $root) { Remove-Item -LiteralPath $file -Force }
    }
  }
}
# 老版本 bug 造出来的错名文件（落在 Programs 里，名叫「Startup 悬浮看板」）：卸载时一并清
$badPanel = Join-Path ([Environment]::GetFolderPath('Programs')) '${PANEL_SHORTCUT_BAD}.lnk'
if (Test-Path -LiteralPath $badPanel) {
  $link = $ws.CreateShortcut($badPanel)
  if ($link.WorkingDirectory -eq $root) { Remove-Item -LiteralPath $badPanel -Force }
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
    # 悬浮看板的状态文件（位置记忆）：它是用户偏好，与 config.json 同类 ——
    # 选「连同数据一起删除」时一并清掉。**不在安装目录里**（在 %LOCALAPPDATA%），
    # 所以 installer.iss 的删除分支碰不到它，这里单独按固定路径清。
    $panelDir = Join-Path $env:LOCALAPPDATA 'AICapabilityBoard'
    $panelState = Join-Path $panelDir 'panel-state.json'
    if (Test-Path -LiteralPath $panelState) { Remove-Item -LiteralPath $panelState -Force -ErrorAction SilentlyContinue }
    if ((Test-Path -LiteralPath $panelDir) -and -not @(Get-ChildItem -LiteralPath $panelDir -Force | Select-Object -First 1).Count) {
      Remove-Item -LiteralPath $panelDir -Force -ErrorAction SilentlyContinue
    }
    ` : ''}
`);
}
