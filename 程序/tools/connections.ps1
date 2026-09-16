param([string]$NodeExe, [string]$PreviewPath, [switch]$SmokeTest, [string]$Platform)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ConnectionWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
}
'@
$root = Split-Path (Split-Path -Parent $PSScriptRoot) -Parent   # 看板根目录（本脚本在 <程序>\tools\ 下）
$status = $null
if (!$PreviewPath) { $status = Get-Content -LiteralPath (Join-Path $root 'data/setup-status.json') -Raw -Encoding UTF8 | ConvertFrom-Json }
$form = New-Object Windows.Forms.Form
$form.Text = 'AI 能力看板 · 连接平台'
$form.ClientSize = New-Object Drawing.Size(680, 570)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10)
$form.BackColor = [Drawing.Color]::White
$form.Add_Shown({
  # A hidden protocol host passes SW_HIDE to its first window. Explicitly reveal
  # only this dialog after the message loop starts; keep the console hidden.
  $null = $form.BeginInvoke([Action]{
    [void][ConnectionWindow]::ShowWindow($form.Handle, 5)
    [void][ConnectionWindow]::SetForegroundWindow($form.Handle)
    $form.Activate()
  })
})
function Label($text, $x, $y, $width, $height, $parent) {
  $item = New-Object Windows.Forms.Label
  $item.Text = $text; $item.Location = New-Object Drawing.Point($x,$y); $item.Size = New-Object Drawing.Size($width,$height)
  if (!$parent) { $parent = $form }      # default = the form itself; focus mode puts the row inside the card panel
  $parent.Controls.Add($item); return $item
}
$heading = Label '连接你使用的平台' 28 22 610 38
$heading.Font = New-Object Drawing.Font('Microsoft YaHei UI', 18, [Drawing.FontStyle]::Bold)
$subtitle = Label '已有账号自动复用，只补缺少的密钥；选一家就可以开始。' 30 68 610 28
$checks = @{}; $inputs = @{}
$names = @('codex','deepseek','glm')
$labels = @{ codex = 'Codex'; deepseek = 'DeepSeek'; glm = 'GLM' }
# Focus mode: a card button on the dashboard opens this window with a platform
# name (aiquotaboard://connect?platform=xxx -> connections.mjs --platform=x). It
# must configure ONLY that one: the other two are neither rendered nor written.
# No value, or a value outside the allowlist = the full window (unchanged).
$focus = if ($Platform -and $names -contains $Platform.ToLower()) { $Platform.ToLower() } else { '' }
# One platform row: checkbox + what it shows + key input (Codex has no key).
# $x/$y are relative to $parent, so the same row works in the form and in the card.
function Row($name, $x, $y, $parent) {
  $check = New-Object Windows.Forms.CheckBox
  $check.Text = $labels[$name]
  $check.Location = New-Object Drawing.Point($x,$y); $check.Size = New-Object Drawing.Size(125,28)
  # Prefill from the last probe; in focus mode the button that opened us promised
  # to ENABLE this platform, so it comes up checked (uncheck it to back out).
  $check.Checked = if ($focus -eq $name) { $true }
    else { if ($status.lastCollect.atMs) { [bool]$status.platforms.$name } else { [bool]($status.platforms.$name -or $status.$name.found) } }
  $parent.Controls.Add($check); $checks[$name] = $check
  $detail = if ($name -eq 'codex') { '查看订阅额度；请先在 Codex 客户端登录。' } else { '查看 API 余额；不代表聊天订阅或 Coding Plan 额度。' }
  $null = Label $detail ($x+130) $y 490 25 $parent
  if ($name -eq 'codex') {
    $null = Label $(if ($status.codex.found) { '已发现本机登录，保存后验证连接。' } else { '登录后可直接点下方按钮验证，无需填写密钥。' }) ($x+130) ($y+30) 490 28 $parent
  } else {
    $box = New-Object Windows.Forms.TextBox
    $box.Location = New-Object Drawing.Point(($x+130),($y+29)); $box.Size = New-Object Drawing.Size(280,28)
    $box.UseSystemPasswordChar = $true; $box.MaxLength = 4096
    $parent.Controls.Add($box); $inputs[$name] = $box
    $hint = if ($status.$name.found) { '已有密钥，留空复用' } else { '在左侧粘贴 API Key' }
    $null = Label $hint ($x+419) ($y+28) 210 24 $parent
    $link = New-Object Windows.Forms.LinkLabel
    $link.Text = '打开平台获取密钥'
    $link.Location = New-Object Drawing.Point(($x+419),($y+52)); $link.Size = New-Object Drawing.Size(190,24)
    $link.Tag = if ($name -eq 'deepseek') { 'https://platform.deepseek.com/' } else { 'https://www.bigmodel.cn/' }
    $link.Add_LinkClicked({ param($sender,$eventArgs) Start-Process $sender.Tag -WindowStyle Hidden })
    $parent.Controls.Add($link)
  }
}
if ($focus) {
  # Focus mode: this window shows the clicked platform and nothing else. No
  # "the other two stay unchanged" narration (he knows what he clicked) and no
  # pointer to where the others live — density over completeness.
  $form.Text = 'AI 能力看板 · 配置 ' + $labels[$focus]
  $heading.Text = '只配置 ' + $labels[$focus]
  $subtitle.Text = '已有账号自动复用，只补缺少的密钥。'
  $cardHeight = if ($focus -eq 'codex') { 112 } else { 132 }
  $card = New-Object Windows.Forms.Panel
  $card.Location = New-Object Drawing.Point(16,104); $card.Size = New-Object Drawing.Size(648,$cardHeight)
  $card.BackColor = [Drawing.Color]::FromArgb(244,248,255)
  $card.BorderStyle = [Windows.Forms.BorderStyle]::FixedSingle
  $form.Controls.Add($card)
  Row $focus 30 22 $card
  $sectionY = 104 + $cardHeight + 24   # one row instead of three: the window closes up, no dead band
} else {
  for ($i=0; $i -lt 3; $i++) { Row $names[$i] 30 (112 + $i * 84) $form }   # 行距 84：三行的总高直接决定窗口能否在 1366×768 上装下
  $sectionY = 368
}
# ---- 提醒时机（阈值）----
# 只露四条「提醒线」：用量到多少 % / 余额低于多少钱时**开始提醒**。它们直接决定用户会收到哪条提醒
# （程序\alert\rules.mjs 的 codex5hWarn / codexWeekWarn / dsLow / glmLow）；紧急阈值（*Critical，P0）、
# 触顶预测与异常消耗参数保持默认值——要改时走命令行的 程序\tools\edit-config.mjs（同一份白名单与范围）。
# 现状值由 connections.mjs 经环境变量 BOARD_THRESHOLDS 注入（配置语义的唯一权威在 node 侧：模板默认 + 用户值）；
# 注入缺失（例如直接跑本脚本）时退回下面的默认值（与 config.template.json 同源），窗口照样画得出来。
# 保存写的就是窗口里显示的值（所见即所写），范围由 node 侧白名单再校一遍。
$thresholdFields = @(
  [pscustomobject]@{ key='codex5hWarn';   platform='codex';    label='Codex 用到';        suffix='% 时提醒我'; min=50; max=100;  step=5; dflt=80 }
  [pscustomobject]@{ key='codexWeekWarn'; platform='codex';    label='Codex 近 7 天用到'; suffix='% 时提醒我'; min=50; max=100;  step=5; dflt=80 }
  [pscustomobject]@{ key='dsLow';         platform='deepseek'; label='DeepSeek 余额低于'; suffix=' 元时提醒我'; min=1;  max=1000; step=1; dflt=20 }
  [pscustomobject]@{ key='glmLow';        platform='glm';      label='GLM 余额低于';      suffix=' 元时提醒我'; min=1;  max=1000; step=1; dflt=5 }
)
$currentThresholds = $null
if ($env:BOARD_THRESHOLDS) { try { $currentThresholds = $env:BOARD_THRESHOLDS | ConvertFrom-Json } catch { $currentThresholds = $null } }
# 显示值 = 注入的现状值（取不到就用默认值），并夹进控件范围——配置被手改出离谱数值时窗口不能崩
function ThresholdValue($field) {
  $raw = $field.dflt
  if ($currentThresholds) { $prop = $currentThresholds.PSObject.Properties[$field.key]; if ($prop) { $raw = $prop.Value } }
  $n = 0.0
  if (![double]::TryParse([string]$raw, [ref]$n)) { $n = [double]$field.dflt }
  return [decimal][Math]::Min([double]$field.max, [Math]::Max([double]$field.min, [Math]::Round($n)))
}
$spins = @{}
# One threshold row: right-aligned wording, the number box, then its unit ("[80]% 时提醒我").
# 130/134/198/118 are the column geometry; two columns fit the 680-wide window (30 and 350).
function ThresholdRow($field, $x, $y) {
  $name = Label $field.label $x $y 130 28
  $name.TextAlign = 'MiddleRight'
  $spin = New-Object Windows.Forms.NumericUpDown
  $spin.Location = New-Object Drawing.Point(($x+134),($y+1)); $spin.Size = New-Object Drawing.Size(58,26)
  $spin.Minimum = [decimal]$field.min; $spin.Maximum = [decimal]$field.max
  $spin.Increment = [decimal]$field.step; $spin.DecimalPlaces = 0; $spin.TextAlign = 'Right'
  $spin.Value = ThresholdValue $field
  $form.Controls.Add($spin); $spins[$field.key] = $spin
  $null = Label $field.suffix ($x+198) $y 118 28
}
# 聚焦模式只画被点那家的提醒线（与平台开关同一条纪律：不碰其它家）
$shownFields = @($thresholdFields | Where-Object { !$focus -or $_.platform -eq $focus })
$sectionTitle = Label '提醒时机' 30 $sectionY 200 26
$sectionTitle.Font = New-Object Drawing.Font('Microsoft YaHei UI', 10, [Drawing.FontStyle]::Bold)
for ($i = 0; $i -lt $shownFields.Count; $i++) { ThresholdRow $shownFields[$i] (30 + ($i % 2) * 320) ($sectionY + 34 + [Math]::Floor($i / 2) * 32) }
$bottomY = $sectionY + 34 + [Math]::Ceiling($shownFields.Count / 2) * 32 + 12
# The bottom block (privacy note / save button / result) keeps one geometry in both modes; the window
# height is derived from it: note at $bottomY, button at +41 (h 40), result at +93 (h 72, 94 after a save).
# Client heights = bottomY + 177 (655 full / 495 codex / 515 balances) and +199 after a save (677 / 517 / 537).
# 为什么要这么抠：1366×768 笔记本上任务栏占 48，窗口外框必须 ≤ 720 —— 保存后的 677+39=716 是上限。
$form.ClientSize = New-Object Drawing.Size(680, ($bottomY + 177))
$null = Label '密钥仅保存到本机，不会传给看板页面。已有密钥留空不改。' 30 $bottomY 620 25
$button = New-Object Windows.Forms.Button
$button.Text = '保存并验证连接'; $button.Location = New-Object Drawing.Point(30,($bottomY+41)); $button.Size = New-Object Drawing.Size(190,40)
$form.Controls.Add($button)
$result = Label '完成后会开启自动采集；未连接的平台可以以后再补。' 30 ($bottomY+93) 625 72
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 250
$script:worker = $null; $script:readTask = $null
$button.Add_Click({
  try {
    $payload = @{ platforms=@{}; keys=@{} }
    # Only the rows actually rendered are written: focus mode must leave the other
    # platforms exactly as they are (a platform the user did not open is not config).
    foreach ($name in $(if ($focus) { @($focus) } else { $names })) { $payload.platforms[$name] = $checks[$name].Checked }
    foreach ($name in @('deepseek','glm')) { if ($inputs.ContainsKey($name)) { $payload.keys[$name] = $inputs[$name].Text } }
    # 阈值只写窗口里画出来的那几条（聚焦模式不碰其它家）；值取自媒体控件，别的来源一概不认
    $payload.thresholds = @{}
    foreach ($field in $shownFields) { $payload.thresholds[$field.key] = [int]$spins[$field.key].Value }
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = $NodeExe; $psi.Arguments = '"' + (Join-Path $PSScriptRoot 'connections.mjs') + '" --save'
    $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $script:worker = [Diagnostics.Process]::Start($psi)
    $script:readTask = $script:worker.StandardOutput.ReadToEndAsync()
    $script:errorTask = $script:worker.StandardError.ReadToEndAsync()
    $script:worker.StandardInput.Write(($payload | ConvertTo-Json -Compress)); $script:worker.StandardInput.Close()
    foreach ($box in $inputs.Values) { $box.Clear() }; $payload = $null
    $button.Enabled = $false; $result.Text = '正在保存、验证并开启采集，最多约四分钟。'; $timer.Start()
  } catch { $result.Text = '无法启动连接，请重新打开窗口后重试。'; $button.Enabled = $true }
})
$timer.Add_Tick({
  if ($script:worker.HasExited -and $script:readTask.IsCompleted) {
    $timer.Stop(); $result.Text = $script:readTask.Result; $button.Enabled = $true
    $form.ClientSize = New-Object Drawing.Size(680, ($bottomY + 199)); $result.Height = 94
    $script:worker.Dispose(); $script:worker = $null
  }
})
$form.Add_FormClosing({ param($sender,$eventArgs)
  if ($script:worker) { $eventArgs.Cancel = $true; $result.Text = '正在完成连接，请等待结果后关闭。' }
})
if ($PreviewPath) {
  $form.Show(); $form.Refresh()
  if ($SmokeTest) {
    # Stub harness (see tools/test-connections.mjs): the row under test is the
    # focused one when the window was opened for a single platform, else DeepSeek.
    $probe = if ($focus) { $focus } else { 'deepseek' }
    if (!$inputs[$probe]) { throw '连接窗口交互测试只支持带密钥框的平台（deepseek / glm）' }
    if ($focus -and ($checks.Count -ne 1 -or !$checks.ContainsKey($focus))) { throw '聚焦模式只能渲染被点的那一家' }
    $checks[$probe].Checked = $true
    $inputs[$probe].Text = 'fixture-value'
    # 阈值控件也要真的被改过：每条 +1（到顶就回到下限）。载荷必须反映控件里的新值，
    # 而不是 connections.mjs 注入的现状值 —— 否则「用户改了数字、存的却是旧值」这类回归测不出来。
    foreach ($field in $shownFields) {
      $spin = $spins[$field.key]
      $spin.Value = if ($spin.Value -ge $spin.Maximum) { $spin.Minimum } else { $spin.Value + 1 }
    }
    $button.PerformClick()
    $until = [DateTime]::UtcNow.AddSeconds(15)
    while ($script:worker -and [DateTime]::UtcNow -lt $until) {
      [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20
    }
    if ($script:worker -or $result.Text -ne '连接测试通过' -or $inputs[$probe].Text -ne '' -or !$button.Enabled -or ![ConnectionWindow]::IsWindowVisible($form.Handle)) { throw '连接窗口交互测试失败' }
  }
  $bitmap = New-Object Drawing.Bitmap($form.Width,$form.Height)
  $form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)))
  $bitmap.Save($PreviewPath); $bitmap.Dispose(); $form.Dispose()
} else { [void]$form.ShowDialog() }
$timer.Dispose()
