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

$root = Split-Path (Split-Path -Parent $PSScriptRoot) -Parent
$statusFile = Join-Path $root 'data/setup-status.json'
$status = $null
if (Test-Path $statusFile) { try { $status = Get-Content -LiteralPath $statusFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch {} }
# 看板显示哪几家的现状值（node 侧按 config.dashboard.cards 算好经 BOARD_CARDS 注入，与阈值同一条通路）：
# show = 这一家在看板上显不显示。这里不做任何推断。
$boardCards = $null
if ($env:BOARD_CARDS) { try { $boardCards = $env:BOARD_CARDS | ConvertFrom-Json } catch { $boardCards = $null } }
$colors = @{
  Canvas=[Drawing.Color]::FromArgb(248,250,252); Card=[Drawing.Color]::White; Soft=[Drawing.Color]::FromArgb(241,245,249)
  Accent=[Drawing.Color]::FromArgb(37,99,235); Text=[Drawing.Color]::FromArgb(15,23,42); Muted=[Drawing.Color]::FromArgb(100,116,139)
  Success=[Drawing.Color]::FromArgb(22,101,52)
}
$font=New-Object Drawing.Font('Microsoft YaHei UI',9)
$fontSmall=New-Object Drawing.Font('Microsoft YaHei UI',8.5)
$fontTitle=New-Object Drawing.Font('Microsoft YaHei UI',19,[Drawing.FontStyle]::Bold)
$fontSection=New-Object Drawing.Font('Microsoft YaHei UI',10,[Drawing.FontStyle]::Bold)
$fontStrong=New-Object Drawing.Font('Microsoft YaHei UI',9.5,[Drawing.FontStyle]::Bold)

$form=New-Object Windows.Forms.Form
$form.Text='AI 能力看板 · 连接平台'; $form.ClientSize=New-Object Drawing.Size(720,655); $form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'; $form.MaximizeBox=$false; $form.MinimizeBox=$true; $form.Font=$font; $form.BackColor=$colors.Canvas
$form.AutoScaleMode=[Windows.Forms.AutoScaleMode]::Dpi
$form.Add_Shown({$null=$form.BeginInvoke([Action]{[void][ConnectionWindow]::ShowWindow($form.Handle,5);[void][ConnectionWindow]::SetForegroundWindow($form.Handle);$form.Activate()})})

function New-Label($text,$x,$y,$width,$height,$parent=$form,$color=$colors.Text,$useFont=$font){
  $item=New-Object Windows.Forms.Label; $item.Text=$text; $item.Location=New-Object Drawing.Point($x,$y); $item.Size=New-Object Drawing.Size($width,$height)
  $item.ForeColor=$color; $item.Font=$useFont; $item.BackColor=[Drawing.Color]::Transparent; $parent.Controls.Add($item); return $item
}
function New-Panel($x,$y,$width,$height,$color=$colors.Card){
  $panel=New-Object Windows.Forms.Panel; $panel.Location=New-Object Drawing.Point($x,$y); $panel.Size=New-Object Drawing.Size($width,$height)
  $panel.BackColor=$color; $form.Controls.Add($panel); return $panel
}
function New-Button($text,$x,$y,$width,$height,$primary=$false){
  $item=New-Object Windows.Forms.Button; $item.Text=$text; $item.Location=New-Object Drawing.Point($x,$y); $item.Size=New-Object Drawing.Size($width,$height)
  $item.FlatStyle='Flat'; $item.Cursor=[Windows.Forms.Cursors]::Hand; $item.FlatAppearance.BorderSize=if($primary){0}else{1}
  $item.FlatAppearance.BorderColor=[Drawing.Color]::FromArgb(203,213,225); $item.BackColor=if($primary){$colors.Accent}else{$colors.Card}
  $item.ForeColor=if($primary){[Drawing.Color]::White}else{$colors.Text}; $item.Font=if($primary){$fontStrong}else{$font}; $form.Controls.Add($item); return $item
}

$heading=New-Label '连接平台' 28 22 660 38 $form $colors.Text $fontTitle
$subtitle=New-Label '选择要使用的平台。已有账号会自动复用。' 30 66 660 25 $form $colors.Muted $font
$checks=@{}; $inputs=@{}; $hints=@{}; $descs=@{}; $displays=@{}; $notes=@{}
$tip=New-Object Windows.Forms.ToolTip
$names=@('codex','deepseek','glm'); $labels=@{codex='Codex';deepseek='DeepSeek';glm='GLM'}
$focus=if($Platform -and $names -contains $Platform.ToLower()){$Platform.ToLower()}else{''}
function KeyHint($name){
  if(([string]$status.$name.source)-like '*ThinCoder*'){return '已从 ThinCoder 读到密钥'}
  if($status.$name.found){return '已有密钥，留空复用'}
  return '尚未添加密钥'
}
# 「看板显示卡片」这一勾的预填值：show = 这一家在看板上显不显示（node 侧算好，缺键 = 显示）。
# 注入拿不到就按默认「显示」——不再跟平台开关联动：隐不隐藏只看用户自己这一勾。
function CardShown($name){
  if($boardCards-and($boardCards.PSObject.Properties.Name-contains$name)){return [bool]$boardCards.$name.show}
  return $true
}
function Set-CardState($check){
  $check.Parent.BackColor=if($check.Checked){$colors.Card}else{$colors.Soft}
  $check.BackColor=$check.Parent.BackColor
  foreach($control in $check.Parent.Controls){
    if($control -is [Windows.Forms.TextBox] -or $control -is [Windows.Forms.LinkLabel]){$control.Enabled=$check.Checked}
  }
}
function Add-PlatformCard($name,$y,$height){
  $card=New-Panel 28 $y 664 $height
  $check=New-Object Windows.Forms.CheckBox; $check.Text=$labels[$name]; $check.Location=New-Object Drawing.Point(18,16); $check.Size=New-Object Drawing.Size(118,30)
  $check.Font=$fontStrong; $check.ForeColor=$colors.Text; $check.BackColor=$colors.Card
  $check.Checked=if($focus-eq$name){$true}else{if($status.lastCollect.atMs){[bool]$status.platforms.$name}else{[bool]($status.platforms.$name-or$status.$name.found)}}
  $check.Tag=$name   # 事件处理器在函数返回后看不到函数局部变量，平台名靠 Tag 带过去
  $card.Controls.Add($check); $checks[$name]=$check
  $detail=if($name-eq'codex'){'订阅额度'}elseif($name-eq'deepseek'){'查看按量计费余额。'}else{'API 余额'}
  $descs[$name]=New-Label $detail 150 13 220 24 $card $colors.Text $fontStrong
  if($name-eq'codex'){
    $ready=[bool]$status.codex.found; $text=if($ready){'已发现本机登录，保存后验证连接'}else{'请先在 Codex 客户端登录'}
    $notes[$name]=New-Label $text 150 38 220 22 $card $(if($ready){$colors.Success}else{$colors.Muted}) $fontSmall
  }else{
    $hints[$name]=New-Label (KeyHint $name) 150 39 210 22 $card $(if($status.$name.found){$colors.Success}else{$colors.Muted}) $fontSmall
    $box=New-Object Windows.Forms.TextBox; $box.Location=New-Object Drawing.Point(376,13); $box.Size=New-Object Drawing.Size(244,27)
    $box.UseSystemPasswordChar=$true; $box.MaxLength=4096; $box.BorderStyle='FixedSingle'; $box.Font=$font; $card.Controls.Add($box); $inputs[$name]=$box
    $link=New-Object Windows.Forms.LinkLabel; $link.Text='获取 API Key'; $link.Location=New-Object Drawing.Point(529,45); $link.Size=New-Object Drawing.Size(92,21)
    $link.Font=$fontSmall; $link.LinkColor=$colors.Accent; $link.ActiveLinkColor=$colors.Accent
    $link.Tag=if($name-eq'deepseek'){'https://platform.deepseek.com/'}else{'https://www.bigmodel.cn/'}
    $link.Add_LinkClicked({param($sender,$eventArgs) Start-Process $sender.Tag}); $card.Controls.Add($link)
  }
  # 「看板显示卡片」：与上面那个平台开关是两件事——开关管采集与提醒，这一勾只管看板上显不显示这一家的内容
  # （卡片、趋势图、热力图页签、额度去向与采集健康里那一家的内容）。默认 = 显示，取消勾选才是「不要这一家」。
  $display=New-Object Windows.Forms.CheckBox; $display.Text='看板显示卡片'
  $display.Location=New-Object Drawing.Point(376,$(if($name-eq'codex'){36}else{44})); $display.Size=New-Object Drawing.Size($(if($name-eq'codex'){240}else{140}),24)
  $display.Font=$fontSmall; $display.ForeColor=$colors.Text; $display.BackColor=$colors.Card; $display.Checked=(CardShown $name)
  $card.Controls.Add($display); $displays[$name]=$display
  $tip.SetToolTip($display,'不勾：看板上不显示这一家的内容（卡片与图表）。采集与提醒照常，不受影响。')
  $check.Add_CheckedChanged({param($sender,$eventArgs)
    Set-CardState $sender   # 平台开关只管自己那一行（灰掉/恢复密钥框）：与卡片显示不再联动
  })
  Set-CardState $check
  return $card
}
if($focus){
  $form.Text='AI 能力看板 · '+$labels[$focus]; $heading.Text='配置 '+$labels[$focus]; $subtitle.Text='只修改当前平台，其他平台保持不变。'
  $null=Add-PlatformCard $focus 104 $(if($focus-eq'codex'){72}else{78}); $sectionY=210
}else{
  $null=Add-PlatformCard 'codex' 104 64; $null=Add-PlatformCard 'deepseek' 176 78; $null=Add-PlatformCard 'glm' 262 78; $sectionY=362
}

$thresholdFields=@(
  [pscustomobject]@{key='codex5hWarn';platform='codex';label='5 小时用量';suffix='%';min=50;max=100;step=5;dflt=80}
  [pscustomobject]@{key='codexWeekWarn';platform='codex';label='近 7 天用量';suffix='%';min=50;max=100;step=5;dflt=80}
  [pscustomobject]@{key='dsLow';platform='deepseek';label='余额低于';suffix='元';min=1;max=1000;step=1;dflt=5}
  [pscustomobject]@{key='glmLow';platform='glm';label='余额低于';suffix='元';min=1;max=1000;step=1;dflt=5}
)
$currentThresholds=$null; if($env:BOARD_THRESHOLDS){try{$currentThresholds=$env:BOARD_THRESHOLDS|ConvertFrom-Json}catch{}}
function ThresholdValue($field){
  $raw=$field.dflt; if($currentThresholds){$prop=$currentThresholds.PSObject.Properties[$field.key];if($prop){$raw=$prop.Value}}
  $n=0.0;if(![double]::TryParse([string]$raw,[ref]$n)){$n=$field.dflt};return [decimal][Math]::Min($field.max,[Math]::Max($field.min,[Math]::Round($n)))
}
$shownFields=@($thresholdFields|Where-Object{!$focus-or$_.platform-eq$focus})
$null=New-Label '提醒设置' 30 $sectionY 200 25 $form $colors.Text $fontSection
$null=New-Label '达到以下数值时提醒' 116 ($sectionY+1) 220 22 $form $colors.Muted $fontSmall
$thresholdPanelHeight=if($shownFields.Count-gt 2){86}else{54}; $thresholdPanel=New-Panel 28 ($sectionY+28) 664 $thresholdPanelHeight $colors.Soft
$spins=@{}
for($i=0;$i-lt$shownFields.Count;$i++){
  $field=$shownFields[$i];$col=$i%2;$row=[Math]::Floor($i/2);$x=18+$col*322;$y=13+$row*32
  $labelText=if($focus){$field.label}else{"$($labels[$field.platform]) · $($field.label)"};$null=New-Label $labelText $x $y 154 25 $thresholdPanel $colors.Text $fontSmall
  $spin=New-Object Windows.Forms.NumericUpDown;$spin.Location=New-Object Drawing.Point(($x+158),($y-1));$spin.Size=New-Object Drawing.Size(66,26)
  $spin.Minimum=$field.min;$spin.Maximum=$field.max;$spin.Increment=$field.step;$spin.Value=ThresholdValue $field;$spin.TextAlign='Right';$spin.BorderStyle='FixedSingle';$spin.Font=$font
  $thresholdPanel.Controls.Add($spin);$spins[$field.key]=$spin;$null=New-Label $field.suffix ($x+230) $y 34 25 $thresholdPanel $colors.Muted $fontSmall
}
$bottomY=$sectionY+28+$thresholdPanelHeight+14;$form.ClientSize=New-Object Drawing.Size(720,($bottomY+166))
$null=New-Label '密钥只保存在本机；留空不会覆盖已有密钥。' 30 $bottomY 650 24 $form $colors.Muted $fontSmall
$button=New-Button '保存并验证' 30 ($bottomY+37) 152 38 $true;$cancel=New-Button '取消' 192 ($bottomY+37) 84 38 $false;$cancel.Add_Click({$form.Close()})
$result=New-Label '保存后会立即验证，并开启后台自动采集。' 30 ($bottomY+88) 650 52 $form $colors.Muted $fontSmall
$timer=New-Object Windows.Forms.Timer;$timer.Interval=250;$script:worker=$null;$script:readTask=$null
$button.Add_Click({
  try{
    $payload=@{platforms=@{};keys=@{};thresholds=@{};cards=@{}}
    foreach($name in $(if($focus){@($focus)}else{$names})){
      $payload.platforms[$name]=$checks[$name].Checked
      # 卡片显示：默认就是显示 —— 勾着 = 写 null（把显式值删掉，回到默认）；取消勾选 = 写 false（记住「不要这一家」）。
      $payload.cards[$name]=if($displays[$name].Checked){$null}else{$false}
    }
    foreach($name in @('deepseek','glm')){if($inputs.ContainsKey($name)){$payload.keys[$name]=$inputs[$name].Text}};foreach($field in $shownFields){$payload.thresholds[$field.key]=[int]$spins[$field.key].Value}
    $psi=New-Object Diagnostics.ProcessStartInfo;$psi.FileName=$NodeExe;$psi.Arguments='"'+(Join-Path $PSScriptRoot 'connections.mjs')+'" --save';$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
    $psi.RedirectStandardInput=$true;$psi.RedirectStandardOutput=$true;$psi.RedirectStandardError=$true;$psi.StandardOutputEncoding=[Text.Encoding]::UTF8
    $script:worker=[Diagnostics.Process]::Start($psi);$script:readTask=$script:worker.StandardOutput.ReadToEndAsync();$script:errorTask=$script:worker.StandardError.ReadToEndAsync()
    $script:worker.StandardInput.Write(($payload|ConvertTo-Json -Compress));$script:worker.StandardInput.Close();foreach($box in $inputs.Values){$box.Clear()};$payload=$null
    $button.Enabled=$false;$cancel.Enabled=$false;$button.Text='正在验证…';$result.ForeColor=$colors.Muted;$result.Text='正在保存设置并连接平台，请稍候。';$timer.Start()
  }catch{$result.ForeColor=[Drawing.Color]::FromArgb(185,28,28);$result.Text='无法启动连接，请关闭窗口后重试。';$button.Enabled=$true;$cancel.Enabled=$true}
})
$timer.Add_Tick({if($script:worker.HasExited-and$script:readTask.IsCompleted){$timer.Stop();$result.Text=$script:readTask.Result;$result.ForeColor=$colors.Text;$button.Text='保存并验证';$button.Enabled=$true;$cancel.Enabled=$true;$script:worker.Dispose();$script:worker=$null}})
$form.Add_FormClosing({param($sender,$eventArgs)if($script:worker){$eventArgs.Cancel=$true;$result.Text='正在完成验证，请稍候。'}})

if($PreviewPath){
  $form.Show();$form.Refresh()
  if($SmokeTest){
    $probe=if($focus){$focus}else{'deepseek'};if(!$inputs[$probe]){throw '连接窗口交互测试只支持带密钥框的平台'};if($focus-and($checks.Count-ne 1-or!$checks.ContainsKey($focus))){throw '聚焦模式只能渲染被点的那一家'}
    if(Test-Path $statusFile){if(!$status){throw '状态文件存在却未读入'};foreach($name in @('deepseek','glm')){if($hints.ContainsKey($name)){
      $want=if(([string]$status.$name.source)-like '*ThinCoder*'){'已从 ThinCoder 读到密钥'}else{'已有密钥，留空复用'};if($hints[$name].Text-ne$want){throw "密钥来源提示不符（$name）"}
      if([Windows.Forms.TextRenderer]::MeasureText($hints[$name].Text,$hints[$name].Font).Width-gt$hints[$name].Width){throw "密钥来源提示被截断（$name）"}
    }}}
    if($descs.ContainsKey('deepseek')){if($descs['deepseek'].Text-ne'查看按量计费余额。'-or$descs['deepseek'].Text-match'Coding Plan'){throw 'DeepSeek 说明行不符'}}
    # 「看板显示卡片」那一勾：必须在自己那一行里、不压住密钥框与链接、文字不被截断，
    # 预填值 = node 侧注入的生效值（注入拿不到时按默认「显示」，不报错）。
    foreach($name in @($displays.Keys)){
      $display=$displays[$name];$panel=$display.Parent
      if($display.Left-lt 0-or$display.Top-lt 0-or($display.Left+$display.Width)-gt$panel.Width-or($display.Top+$display.Height)-gt$panel.Height){throw "看板显示勾选框越出行（$name）"}
      if([Windows.Forms.TextRenderer]::MeasureText($display.Text,$display.Font).Width-gt($display.Width-22)){throw "看板显示勾选框文字被截断（$name）"}
      foreach($other in $panel.Controls){if($other-eq$display){continue}
        if($other.Visible-and$other.Left-lt($display.Left+$display.Width)-and($other.Left+$other.Width)-gt$display.Left-and$other.Top-lt($display.Top+$display.Height)-and($other.Top+$other.Height)-gt$display.Top){throw "看板显示勾选框与「$($other.Text)」重叠（$name）"}}
      if($boardCards-and($boardCards.PSObject.Properties.Name-contains$name)){if($display.Checked-ne[bool]$boardCards.$name.show){throw "看板显示的预填值与注入不符（$name）"}}
    }
    foreach($name in @($notes.Keys)){   # Codex 那一行的状态文字（为新加的那一勾让出了位置）不能被截断
      if([Windows.Forms.TextRenderer]::MeasureText($notes[$name].Text,$notes[$name].Font).Width-gt$notes[$name].Width){throw "平台状态行被截断（$name）"}
    }
    $checks[$probe].Checked=$true;$inputs[$probe].Text='fixture-value';foreach($field in $shownFields){$spin=$spins[$field.key];$spin.Value=if($spin.Value-ge$spin.Maximum){$spin.Minimum}else{$spin.Value+1}}
    $displays[$probe].Checked=-not$displays[$probe].Checked   # 把这一勾拨到与默认相反：证明控件里的值真的上了载荷（与阈值倒一格同理）
    $button.PerformClick();$until=[DateTime]::UtcNow.AddSeconds(15);while($script:worker-and[DateTime]::UtcNow-lt$until){[Windows.Forms.Application]::DoEvents();Start-Sleep -Milliseconds 20}
    if($script:worker-or$result.Text-ne'连接测试通过'-or$inputs[$probe].Text-ne''-or!$button.Enabled-or![ConnectionWindow]::IsWindowVisible($form.Handle)){throw '连接窗口交互测试失败'}
  }
  $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height);$form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)));$bitmap.Save($PreviewPath);$bitmap.Dispose();$form.Dispose()
}else{[void]$form.ShowDialog()}
$timer.Dispose()
