# AI 能力看板 —— 托盘常驻图标（PowerShell + WinForms NotifyIcon，零依赖）
# 悬停显示三平台状态；双击打开看板；右键菜单：打开看板 / 立即采集 / 静音 / 退出
# 由「托盘图标.vbs」隐藏窗口启动；开机自启由 tools/install.mjs 在启动文件夹创建快捷方式。
param([int]$PollSeconds = 0)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$root = Split-Path -Parent $PSScriptRoot          # 项目根目录（本脚本在 tools\ 下）
$dataDir = Join-Path $root 'data'
$stateFile = Join-Path $dataDir 'state.json'
$icoFile = Join-Path $root 'icon.ico'
$dash = Join-Path $root 'dashboard.html'
$nodeExe = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $nodeExe)) { $nodeExe = 'node' }
$updateFile = Join-Path $dataDir 'update-status.json'
$noticeFile = Join-Path $dataDir 'update-notified.json'
$lastUpdateCheck = [DateTime]::MinValue

function Get-Config {
  try {
    $cfg = Join-Path $root 'config.json'
    if (Test-Path $cfg) { return Get-Content $cfg -Raw -Encoding UTF8 | ConvertFrom-Json }
  } catch { }
  return $null
}
$cfg = Get-Config
if ($PollSeconds -le 0) {
  if ($cfg -and $cfg.tray -and $cfg.tray.pollSeconds) { $PollSeconds = [int]$cfg.tray.pollSeconds } else { $PollSeconds = 60 }
}

function Get-Status {
  try {
    if (-not (Test-Path $stateFile)) { return '尚未采集数据' }
    $s = Get-Content $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $parts = @()
    $c = $s.current.codex
    if ($c -and $c.ok) {
      $used = [double]$c.data.fiveHour.usedPercent
      $parts += ('Codex 剩余 {0}%' -f [int](100 - $used))
    } else { $parts += 'Codex 无数据' }
    $d = $s.current.deepseek
    if ($d -and $d.ok) { $parts += ('DeepSeek ¥{0:N2}' -f [double]$d.data.totalBalance) } else { $parts += 'DeepSeek 无数据' }
    $g = $s.current.glm
    if ($g -and $g.ok) { $parts += ('GLM ¥{0:N2}' -f [double]$g.data.balance) } else { $parts += 'GLM 无数据' }
    return ($parts -join ' · ')
  } catch { return '读取 state.json 失败' }
}

function Wait-Task {
  try {
    $task = Get-ScheduledTask -TaskName 'AI-Capability-Board-Collect' -ErrorAction Stop
    $task | Start-ScheduledTask -ErrorAction Stop
    return
  } catch { }
  Start-Process -FilePath $nodeExe -ArgumentList 'collect.mjs' -WorkingDirectory $root -WindowStyle Hidden
}

function Invoke-Node {
  param([string]$Script, [string]$Args = '')
  $argList = @($Script)
  if ($Args) { $argList += $Args.Split(' ') }
  Start-Process -FilePath $nodeExe -ArgumentList $argList -WorkingDirectory $root -WindowStyle Hidden
}

# ---- 托盘图标 ----
$notify = New-Object System.Windows.Forms.NotifyIcon
try { $notify.Icon = New-Object System.Drawing.Icon($icoFile) }
catch { $notify.Icon = [System.Drawing.SystemIcons]::Application }

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('打开看板（双击图标）')
$miOpen.add_Click({ Start-Process $dash })
$miCollect = $menu.Items.Add('立即采集一次')
$miCollect.add_Click({ Wait-Task })
$null = $menu.Items.Add('-')
$miUpdate = $menu.Items.Add('检查更新与反馈')
$miUpdate.add_Click({ Invoke-Node 'tools/update.mjs' 'check'; Start-Process (([Uri]$dash).AbsoluteUri + '#support') })
$null = $menu.Items.Add('-')
$miMute2 = $menu.Items.Add('静音 2 小时')
$miMute2.add_Click({ Invoke-Node 'mute.mjs' '120m' })
$miMuteOff = $menu.Items.Add('取消静音')
$miMuteOff.add_Click({ Invoke-Node 'mute.mjs' 'off' })
$null = $menu.Items.Add('-')
$miExit = $menu.Items.Add('退出托盘')
$miExit.add_Click({
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.Visible = $true
$notify.add_DoubleClick({ Start-Process $dash })

function Update-Tray {
  $text = Get-Status
  # NotifyIcon.Text 上限 63 字符
  if ($text.Length -gt 62) { $text = $text.Substring(0, 62) }
  $notify.Text = $text
  if (([DateTime]::Now - $script:lastUpdateCheck).TotalHours -ge 1) {
    $script:lastUpdateCheck = [DateTime]::Now
    Invoke-Node 'tools/update.mjs' 'auto'
  }
  try {
    if (Test-Path -LiteralPath (Join-Path $dataDir 'upgrade-transaction.json')) {
      $notify.Visible = $false
      [System.Windows.Forms.Application]::Exit()
      return
    }
    $u = Get-Content -LiteralPath $updateFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($u.available -and $u.notifications -ne $false -and $u.snoozeUntil -lt [DateTimeOffset]::Now.ToUnixTimeMilliseconds()) {
      $seen = if (Test-Path -LiteralPath $noticeFile) { Get-Content -LiteralPath $noticeFile -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
      if ($seen.version -ne $u.manifest.version) {
        $notify.BalloonTipTitle = '看板有新版本 v' + $u.manifest.version
        $notify.BalloonTipText = '打开看板，在帮助与反馈中查看更新。配置与历史会保留。'
        $notify.ShowBalloonTip(6000)
        @{version=$u.manifest.version} | ConvertTo-Json | Set-Content -LiteralPath $noticeFile -Encoding UTF8
      }
    }
  } catch { }
}

$menu.add_Opening({ Update-Tray })
Update-Tray

# 首次提示（只在真正弹出托盘时提示一次）
try {
  $notify.BalloonTipTitle = 'AI 能力看板已常驻托盘'
  $notify.BalloonTipText = "双击图标打开看板；右键查看更多操作。`n$((Get-Status))"
  $notify.ShowBalloonTip(4000)
} catch { }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(5, $PollSeconds) * 1000
$timer.add_Tick({ Update-Tray })
$timer.Start()

[System.Windows.Forms.Application]::Run()

