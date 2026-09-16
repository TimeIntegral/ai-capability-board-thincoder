# AI 能力看板 —— 托盘常驻图标（PowerShell + WinForms NotifyIcon，零依赖）
# 悬停显示三平台状态；双击打开看板；右键菜单：打开看板 / 立即采集 / 静音 / 退出
# 由「托盘图标.vbs」隐藏窗口启动；开机自启由 <程序>/tools/install.mjs 在启动文件夹创建快捷方式。
param([int]$PollSeconds = 0, [string]$PreviewPath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$code = Split-Path -Parent $PSScriptRoot          # 程序目录（本脚本在它的 tools\ 下）
$root = Split-Path -Parent $code                  # 看板根目录（dashboard.html / config.json / data 在那一层）
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
  Start-Process -FilePath $nodeExe -ArgumentList (Join-Path $code 'collect.mjs') -WorkingDirectory $root -WindowStyle Hidden
}

function Invoke-Node {
  param([string]$Script, [string]$Args = '')
  $argList = @((Join-Path $code $Script))
  if ($Args) { $argList += $Args.Split(' ') }
  Start-Process -FilePath $nodeExe -ArgumentList $argList -WorkingDirectory $root -WindowStyle Hidden
}

# ---- 托盘图标 ----
$notify = New-Object System.Windows.Forms.NotifyIcon
try { $notify.Icon = New-Object System.Drawing.Icon($icoFile) }
catch { $notify.Icon = [System.Drawing.SystemIcons]::Application }

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $false
$menu.BackColor = [Drawing.Color]::White
$menu.ForeColor = [Drawing.Color]::FromArgb(15,23,42)
$menu.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9)
$menu.Padding = New-Object Windows.Forms.Padding(6)
$menu.Renderer = New-Object Windows.Forms.ToolStripProfessionalRenderer
$miTitle = $menu.Items.Add('AI 能力看板')
$miTitle.Enabled = $false
$miTitle.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9.5, [Drawing.FontStyle]::Bold)
$miStatus = $menu.Items.Add('正在读取状态…')
$miStatus.Enabled = $false
$miStatus.ForeColor = [Drawing.Color]::FromArgb(100,116,139)
$null = $menu.Items.Add('-')
$miOpen = $menu.Items.Add('打开看板')
$miOpen.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9, [Drawing.FontStyle]::Bold)
$miOpen.ShortcutKeyDisplayString = '双击'
$miOpen.add_Click({ Start-Process $dash })
$miCollect = $menu.Items.Add('立即刷新数据')
$miCollect.add_Click({ Wait-Task })
$miSettings = $menu.Items.Add('连接与提醒设置…')
$miSettings.add_Click({ Invoke-Node 'tools/connections.mjs' })
$null = $menu.Items.Add('-')
$miUpdate = $menu.Items.Add('检查更新')
$miUpdate.add_Click({ Invoke-Node 'tools/update.mjs' 'check'; Start-Process (([Uri]$dash).AbsoluteUri + '#support') })
$null = $menu.Items.Add('-')
$miMute2 = $menu.Items.Add('静音 2 小时')
$miMute2.add_Click({ Invoke-Node 'mute.mjs' '120m' })
$miMuteOff = $menu.Items.Add('取消静音')
$miMuteOff.add_Click({ Invoke-Node 'mute.mjs' 'off' })
$null = $menu.Items.Add('-')
$miExit = $menu.Items.Add('退出')
$miExit.add_Click({
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.Visible = -not [bool]$PreviewPath
$notify.add_DoubleClick({ Start-Process $dash })

function Update-Tray {
  $text = Get-Status
  # NotifyIcon.Text 上限 63 字符
  if ($text.Length -gt 62) { $text = $text.Substring(0, 62) }
  $notify.Text = $text
  $miStatus.Text = $text
  try {
    $mute = Get-Content -LiteralPath (Join-Path $dataDir 'mute.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $muted = [double]$mute.until -gt [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
  } catch { $muted = $false }
  $miMute2.Visible = -not $muted
  $miMuteOff.Visible = $muted
  if (-not $PreviewPath -and ([DateTime]::Now - $script:lastUpdateCheck).TotalHours -ge 1) {
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

foreach ($item in $menu.Items) {
  if ($item -is [Windows.Forms.ToolStripMenuItem]) {
    $item.Padding = New-Object Windows.Forms.Padding(10,6,10,6)
    $item.Margin = New-Object Windows.Forms.Padding(0,1,0,1)
  }
}

if ($PreviewPath) {
  $preview = New-Object Windows.Forms.Form
  $preview.Text = '托盘菜单预览'; $preview.ClientSize = New-Object Drawing.Size(360,400)
  $preview.StartPosition = 'CenterScreen'; $preview.BackColor = [Drawing.Color]::FromArgb(241,245,249)
  $preview.Show(); $menu.Show($preview, (New-Object Drawing.Point(30,30)))
  [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 150
  $size = $menu.Size
  $bitmap = New-Object Drawing.Bitmap($size.Width,$size.Height)
  $menu.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$size.Width,$size.Height)))
  $bitmap.Save($PreviewPath); $bitmap.Dispose(); $menu.Close(); $preview.Close(); $notify.Dispose()
  return
}

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
