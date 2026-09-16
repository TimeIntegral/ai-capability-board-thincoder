param([string]$NodeExe, [string]$PreviewPath, [switch]$SmokeTest)
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
function Label($text, $x, $y, $width, $height) {
  $item = New-Object Windows.Forms.Label
  $item.Text = $text; $item.Location = New-Object Drawing.Point($x,$y); $item.Size = New-Object Drawing.Size($width,$height)
  $form.Controls.Add($item); return $item
}
$heading = Label '连接你使用的平台' 28 22 610 38
$heading.Font = New-Object Drawing.Font('Microsoft YaHei UI', 18, [Drawing.FontStyle]::Bold)
$null = Label '已有账号自动复用，只补缺少的密钥；选一家就可以开始。' 30 68 610 28
$checks = @{}; $inputs = @{}
$names = @('codex','deepseek','glm')
for ($i=0; $i -lt 3; $i++) {
  $name = $names[$i]; $y = 112 + $i * 90
  $check = New-Object Windows.Forms.CheckBox
  $check.Text = @('Codex','DeepSeek','GLM')[$i]
  $check.Location = New-Object Drawing.Point(30,$y); $check.Size = New-Object Drawing.Size(125,28)
  $check.Checked = if ($status.lastCollect.atMs) { [bool]$status.platforms.$name } else { [bool]($status.platforms.$name -or $status.$name.found) }
  $form.Controls.Add($check); $checks[$name] = $check
  $detail = if ($name -eq 'codex') { '查看订阅额度；请先在 Codex 客户端登录。' } else { '查看 API 余额；不代表聊天订阅或 Coding Plan 额度。' }
  $null = Label $detail 160 $y 490 25
  if ($name -eq 'codex') {
    $null = Label $(if ($status.codex.found) { '已发现本机登录，保存后验证连接。' } else { '登录后可直接点下方按钮验证，无需填写密钥。' }) 160 ($y+30) 490 28
  } else {
    $box = New-Object Windows.Forms.TextBox
    $box.Location = New-Object Drawing.Point(160,($y+29)); $box.Size = New-Object Drawing.Size(280,28)
    $box.UseSystemPasswordChar = $true; $box.MaxLength = 4096
    $form.Controls.Add($box); $inputs[$name] = $box
    $hint = if ($status.$name.found) { '已有密钥，留空复用' } else { '在左侧粘贴 API Key' }
    $null = Label $hint 449 ($y+28) 210 24
    $link = New-Object Windows.Forms.LinkLabel
    $link.Text = '打开平台获取密钥'
    $link.Location = New-Object Drawing.Point(449,($y+52)); $link.Size = New-Object Drawing.Size(190,24)
    $link.Tag = if ($name -eq 'deepseek') { 'https://platform.deepseek.com/' } else { 'https://www.bigmodel.cn/' }
    $link.Add_LinkClicked({ param($sender,$eventArgs) Start-Process $sender.Tag -WindowStyle Hidden })
    $form.Controls.Add($link)
  }
}
$null = Label '密钥仅保存到本机，不会传给看板页面。已有密钥留空不改。' 30 387 620 25
$button = New-Object Windows.Forms.Button
$button.Text = '保存并验证连接'; $button.Location = New-Object Drawing.Point(30,428); $button.Size = New-Object Drawing.Size(190,40)
$form.Controls.Add($button)
$result = Label '完成后会开启自动采集；未连接的平台可以以后再补。' 30 484 625 72
$timer = New-Object Windows.Forms.Timer; $timer.Interval = 250
$script:worker = $null; $script:readTask = $null
$button.Add_Click({
  try {
    $payload = @{ platforms=@{}; keys=@{} }
    foreach ($name in $names) { $payload.platforms[$name] = $checks[$name].Checked }
    foreach ($name in @('deepseek','glm')) { $payload.keys[$name] = $inputs[$name].Text }
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
    $form.ClientSize = New-Object Drawing.Size(680,650); $result.Height = 150
    $script:worker.Dispose(); $script:worker = $null
  }
})
$form.Add_FormClosing({ param($sender,$eventArgs)
  if ($script:worker) { $eventArgs.Cancel = $true; $result.Text = '正在完成连接，请等待结果后关闭。' }
})
if ($PreviewPath) {
  $form.Show(); $form.Refresh()
  if ($SmokeTest) {
    $checks['deepseek'].Checked = $true
    $inputs['deepseek'].Text = 'fixture-value'
    $button.PerformClick()
    $until = [DateTime]::UtcNow.AddSeconds(15)
    while ($script:worker -and [DateTime]::UtcNow -lt $until) {
      [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 20
    }
    if ($script:worker -or $result.Text -ne '连接测试通过' -or $inputs['deepseek'].Text -ne '' -or !$button.Enabled -or ![ConnectionWindow]::IsWindowVisible($form.Handle)) { throw '连接窗口交互测试失败' }
  }
  $bitmap = New-Object Drawing.Bitmap($form.Width,$form.Height)
  $form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)))
  $bitmap.Save($PreviewPath); $bitmap.Dispose(); $form.Dispose()
} else { [void]$form.ShowDialog() }
$timer.Dispose()
