// 常驻悬浮看板的验收测试（开发期工具：跑得比快速门禁久，发布流水线在冻结构建树里跑它）。
//
// 覆盖设计档 3.2 的用例：T6–T16（面板 --selftest 的机判读数行）、T1–T4（编译产物与来源核对）、
// T17（单实例）、T18（升级针契约）、T19（入口与纪律）、T21（真机窗口属性读回，需桌面会话；没有就登记为跳过）。
// 纪律：夹具一律指到临时目录；不写真实状态文件、不动真实数据文件；对发布链的«篡改-核对»试验一律在 finally 里还原。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { powershell, psQuote } from './windows-integration.mjs';
import { 分类, 从stage推导 } from '../../release/publish-files.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXE = path.join(ROOT, '程序', 'bin', 'board.exe');
const RECORD = path.join(ROOT, '程序', 'bin', 'panel-build.json');
const 有exe = fs.existsSync(EXE) && fs.existsSync(RECORD);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const 读 = rel => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } };
const skip若未编译 = () => (!有exe ? '还没编译面板（先跑 node release/build-panel.mjs）' : false);

// ── 面板自检（T6–T16）──────────────────────────────────────────────────────
function 跑自检(extra = []) {
  const r = spawnSync(EXE, ['--selftest', '--data', ROOT, ...extra], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const out = `${r.stdout ?? ''}`;
  return {
    code: r.status,
    out,
    checks: out.split(/\r?\n/).filter(l => l.startsWith('CHECK ')).map(l => {
      const m = l.match(/^CHECK (\S+) (PASS|FAIL) ?(.*)$/);
      return m ? { id: m[1], ok: m[2] === 'PASS', detail: m[3] } : { id: '?', ok: false, detail: l };
    }),
    reads: out.split(/\r?\n/).filter(l => l.startsWith('READ ')),
    screens: out.split(/\r?\n/).filter(l => l.startsWith('SCREEN ')).map(l => l.slice(7)),
    proj: (out.split(/\r?\n/).find(l => l.startsWith('SCREENPROJ ')) ?? '').slice(11).trim(),
    summary: (out.split(/\r?\n/).find(l => l.startsWith('SUMMARY ')) ?? '').trim(),
  };
}

test('T6–T16 面板自检全部通过（几何 / 拖动阈值 / 位置记忆 / 口径 / 陈旧 / 扫动 / 词表清单）', { skip: skip若未编译() }, () => {
  const r = 跑自检();
  const 失败 = r.checks.filter(c => !c.ok);
  assert.equal(失败.length, 0, `自检有失败项：\n${失败.map(c => `  ${c.id} ${c.detail}`).join('\n')}`);
  assert.ok(r.checks.length >= 40, `自检项太少（${r.checks.length} 条）—— 用例可能没跑全`);
  for (const id of ['T6-panelH', 'T7-detach', 'T8-clamp', 'T9-remain', 'T10-shared-unit', 'T11-hidden', 'T12-today', 'T13-running', 'T14-quota', 'T15-change', 'T16-list']) {
    assert.ok(r.checks.some(c => c.id === id), `自检缺少用例 ${id}`);
  }
  assert.match(r.summary, /fail=0/, `自检汇总不是全绿：${r.summary}`);
});

test('T16 上屏文本 ⊆ 固定词表（无解释性句子）', { skip: skip若未编译() }, () => {
  const r = 跑自检();
  assert.ok(r.screens.length >= 15, `上屏文本清单太少（${r.screens.length} 条）`);
  // 词表：每一行必须被下面某一条模式命中；命中不了 = 出现了计划外的文字
  const 词表 = [
    /^—$/,
    /^Codex$/,
    /^Codex (5h|7 天)$/,
    /^5h 还剩$/, /^7 天 还剩$/,
    /^数据 \d{1,2}\/\d{1,2} \d{1,2}:\d{2}$/,
    /^(刷新|已过) \d{1,2}\/\d{1,2} \d{1,2}:\d{2}$/,
    /^(刷新|已过) \d{1,2}:\d{2}$/,
    /^下次刷新 (5h|7 天) 窗口 .+ 后$/,
    /^刷新窗口都已过 · 数据 .+$/,
    /^余额$/,
    /^余额 .+$/,
    /^1 圈 = ¥[\d,]+$/,
    /^\d+ 圈$/, /^<0\.01 圈$/,
    /^¥[\d,]+\.\d{2}$/, /^[A-Z]{3} [\d,]+\.\d{2}$/,
    /^(沿用|<0\.01 圈)( · (沿用|<0\.01 圈))*$/,
    /^(DeepSeek|智谱 GLM)$/,
    /^今天 · 这个项目$/,
    /^最近 \d{1,2}\/\d{1,2} \d{1,2}:\d{2}$/, /^最近 —$/,
    /^今天 \d+ 轮 · (占今天 \d+%|今天还没有活动)$/,
    /^今天 0 轮 · 读不到会话记录$/,
    /^近 7 天 \d+ 轮 · \d+ 个会话（(attribution\.json|现算)）$/,
    /^近 7 天 —$/,
    /^(正在运行|等你回答|已完成|今天没用过)$/,
    /^写入 (\d+[smhd]|\d+h\d{2}m|—) 前$/,
    /^会话$/,
    /^(\d+:)?\d{2}:\d{2}$/,
  ];
  const 越界 = r.screens.filter(t => t.trim() && !词表.some(re => re.test(t.trim())));
  assert.deepEqual(越界, [], `这些上屏文本不在词表里（可能是解释性文字）：\n  ${越界.join('\n  ')}`);
  // 项目名是目录名（开放集）：不当词表比对，但要像目录名（不是一句话）
  assert.ok(r.proj.length > 0 && r.proj.length <= 64, `项目名异常：「${r.proj}」`);
  assert.ok(!/[。，！？；：]/.test(r.proj), `项目名看起来像一句话：「${r.proj}」`);
});

// ── 编译产物与来源记录（T1 / A1）──────────────────────────────────────────
test('T1 编译产物与来源记录齐全，且 --verify 核对通过', { skip: skip若未编译() }, () => {
  const rec = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
  assert.ok(rec.exeSha256 && rec.sources?.length > 0 && rec.compiler?.path, '来源记录字段不全');
  assert.equal(rec.exeSha256, sha(EXE), '记录里的出厂 SHA256 与 exe 不符');
  for (const s of rec.sources) {
    const p = path.join(ROOT, ...s.path.split('/'));
    assert.ok(fs.existsSync(p), `记录里的源文件不在：${s.path}`);
    assert.equal(sha(p), s.sha256, `源文件与记录不符：${s.path}`);
  }
  const out = execFileSync(process.execPath, ['release/build-panel.mjs', '--verify'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.match(out, /来源核对通过/);
});

test('T2/T3 来源核对挡得住篡改（改 exe 一字节 / 改记录 → 发布闸门拒绝）', { skip: skip若未编译() }, () => {
  const 原记录 = fs.readFileSync(RECORD);
  const 原exe = fs.readFileSync(EXE);
  try {
    // ① 记录被改（等价于「exe 被换过」）
    const rec = JSON.parse(原记录.toString('utf8'));
    rec.exeSha256 = 'deadbeef'.repeat(8);
    fs.writeFileSync(RECORD, JSON.stringify(rec, null, 2));
    const r1 = spawnSync(process.execPath, ['release/publish.mjs', '--dry'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    assert.notEqual(r1.status, 0, '记录对不上时闸门必须拒绝');
    assert.match(`${r1.stdout}${r1.stderr}`, /悬浮看板/, '拒绝理由里应当点名悬浮看板');
    // ② 真改 exe 一字节（记录不动）
    fs.writeFileSync(RECORD, 原记录);
    const buf = Buffer.from(原exe);
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
    fs.writeFileSync(EXE, buf);
    const r2 = spawnSync(process.execPath, ['release/publish.mjs', '--dry'], { cwd: ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    assert.notEqual(r2.status, 0, 'exe 被改一字节时闸门必须拒绝');
    assert.match(`${r2.stdout}${r2.stderr}`, /SHA256 与记录不符/);
  } finally {
    fs.writeFileSync(RECORD, 原记录);
    fs.writeFileSync(EXE, 原exe);
  }
  assert.equal(sha(EXE), JSON.parse(原记录.toString('utf8')).exeSha256, '试验后 exe 必须还原');
});

// ── 发布链分类（T4）────────────────────────────────────────────────────────
test('T4 三层分类：exe 归「构建时加入」，面板源码与开关脚本已归类', () => {
  const 层次 = 分类(['程序/panel/Panel.cs', '快捷操作/悬浮看板.vbs', '程序/tools/panel.mjs', '程序/tools/test-panel.mjs']);
  assert.deepEqual(层次.未分类, [], `有文件没归类：${层次.未分类.join('、')}`);
  assert.deepEqual(层次.冲突, []);
  assert.ok(层次.仅开发.includes('程序/panel/Panel.cs'), '面板源码属于「仅供开发」');
  assert.ok(层次.仅开发.includes('程序/tools/test-panel.mjs'), '开发期测试属于「仅供开发」');
  assert.ok(层次.发布.includes('程序/tools/panel.mjs') && 层次.发布.includes('快捷操作/悬浮看板.vbs'), '开关脚本与入口要进发布层');
  // exe 不在 git 清单里，所以它不进 分类()，而由 从stage推导 认成「构建时加入」
  const { 构建时, 安装清单 } = 从stage推导(['程序/bin/board.exe']);
  assert.ok(构建时.includes('程序/bin/board.exe'), 'exe 必须被认成「构建时加入」');
  assert.ok(安装清单.includes('程序/bin/board.exe'), 'exe 必须进 L3 安装清单');
});

// ── 单实例（T17）────────────────────────────────────────────────────────
test('T17 单实例：连起两次只留一个面板窗口，第二次唤出已有并退出码 0', { skip: skip若未编译() }, () => {
  const 数据 = path.join(ROOT, 'data');
  const 状态 = path.join(process.env.TEMP, `panel-state-test-${Date.now()}.json`);
  const 起 = () => spawnSync(EXE, ['--data', ROOT, '--state', 状态, '--form', 'micro', '--seconds', '8'], { windowsHide: true, encoding: 'utf8' });
  try {
    const a = 起();
    // 第一次是 GUI 进程：它不会立刻退出，spawnSync 会等到 --seconds 结束；所以这里用后台起法
    assert.ok(true);
    const 个数 = () => Number(String(powershell(`$e = ${psQuote(EXE)}
@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'board.exe' -and $_.ExecutablePath -ieq $e }).Count`)).trim());
    // 后台起两个，中间隔 2 秒：第二个应当立刻退出并唤出第一个
    powershell(`Start-Process -FilePath ${psQuote(EXE)} -ArgumentList @('--data', ${psQuote(ROOT)}, '--state', ${psQuote(状态)}, '--form', 'micro', '--seconds', '12') -WindowStyle Hidden`);
    powershell(`Start-Sleep -Milliseconds 2500`);
    const r2 = spawnSync(EXE, ['--data', ROOT, '--state', 状态, '--form', 'micro', '--seconds', '3'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(r2.status, 0, '第二次启动应当以 0 退出（唤出已有面板）');
    assert.match(`${r2.stderr}${r2.stdout}`, /已在运行/);
    assert.equal(个数(), 1, '同一份 exe 只应有一个进程');
    void a;
  } finally {
    powershell(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'board.exe' -and $_.ExecutablePath -ieq ${psQuote(EXE)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    try { fs.unlinkSync(状态); } catch { }
  }
});

// ── 升级针契约（T18）与入口纪律（T19）────────────────────────────────────
test('T18 升级针：按 exe 路径匹配，绝不按名字裸杀', () => {
  const 文本 = 读('程序/tools/windows-integration.mjs') ?? '';
  assert.match(文本, /board\.exe/, 'stopOwned 里没有面板进程的规则');
  assert.match(文本, /ExecutablePath -ieq \(Join-Path \$root '程序\\bin\\board\.exe'\)/, '规则必须按**可执行文件路径**匹配');
  assert.ok(!/Stop-Process[^\n]*-Name\s+'?board\.exe/.test(文本), '不许按名字裸杀 board.exe');
  assert.ok(!/Get-Process\s+board/.test(文本));
  for (const rel of ['程序/tools/uninstall.mjs', '程序/tools/upgrade-lifecycle.mjs']) {
    const t = 读(rel) ?? '';
    assert.ok(t.includes('stopOwned'), `${rel} 应当走 stopOwned 收口`);
  }
  // 装完拉起：同样按路径先停旧的再起新的
  assert.match(读('程序/tools/install.mjs') ?? '', /board\.exe[^\n]*ExecutablePath|ExecutablePath -ieq '\$\{exe\}'/, 'install.mjs 装完拉起前应当按 exe 路径停旧的');
  assert.match(读('程序/tools/panel.mjs') ?? '', /ExecutablePath -ieq/, '开关执行端同样按路径匹配');
});

test('T19 入口与纪律：.vbs 纯 ASCII、指向正确；先看我.txt 有入口；面板不读密钥', () => {
  const vbs = fs.readFileSync(path.join(ROOT, '快捷操作', '悬浮看板.vbs'));
  const 非ascii = [...vbs].filter(b => b > 127).length;
  assert.equal(非ascii, 0, `悬浮看板.vbs 有 ${非ascii} 个非 ASCII 字节（Windows 脚本宿主按 ANSI 读）`);
  const 协议 = fs.readFileSync(path.join(ROOT, '程序', '运行协议.vbs'));
  assert.equal([...协议].filter(b => b > 127).length, 0, '运行协议.vbs 必须保持纯 ASCII');
  assert.match(读('先看我.txt') ?? '', /悬浮看板\.vbs/, '先看我.txt 里应当有悬浮看板入口');
  // 面板不读密钥（代码走查：源码里不出现 secrets.json / auth.json）
  const 源码 = fs.readdirSync(path.join(ROOT, '程序', 'panel')).filter(f => f.endsWith('.cs'))
    .map(f => fs.readFileSync(path.join(ROOT, '程序', 'panel', f), 'utf8')).join('\n');
  assert.ok(!/secrets\.json|auth\.json/.test(源码), '面板源码里不许出现密钥文件');
  // 发布清单已归类
  const { 未分类 } = 分类(['程序/panel/Panel.cs', '程序/tools/panel.mjs', '快捷操作/悬浮看板.vbs']);
  assert.deepEqual(未分类, []);
});

// ── 真机窗口属性读回（T21 / A4；需要桌面会话，没有就跳过）─────────────────
test('T21 窗口属性读回：透明 / 穿透 / 置顶 / 不抢焦点 / 不占任务栏', { skip: skip若未编译() }, () => {
  if (process.env.PANEL_SKIP_WINDOW === '1') return;   // 明确跳过（无桌面会话时由调用方设）
  const 状态 = path.join(process.env.TEMP, `panel-state-probe-${Date.now()}.json`);
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Nat -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
public delegate bool EnumProc(IntPtr h, IntPtr l);
public struct RECT { public int Left, Top, Right, Bottom; }
public struct POINT { public int X, Y; }
public static IntPtr FindTop(uint pid) {
  IntPtr found = IntPtr.Zero;
  EnumWindows(delegate(IntPtr h, IntPtr l) {
    uint p; GetWindowThreadProcessId(h, out p);
    if (p == pid && IsWindowVisible(h)) { found = h; return false; }
    return true;
  }, IntPtr.Zero);
  return found;
}
'@
[void][Nat.Win]::SetProcessDPIAware()
Start-Process -FilePath ${psQuote(EXE)} -ArgumentList @('--data', ${psQuote(ROOT)}, '--state', ${psQuote(状态)}, '--form', 'medium', '--seconds', '25') -WindowStyle Hidden
Start-Sleep -Milliseconds 1500
$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'board.exe' -and $_.ExecutablePath -ieq ${psQuote(EXE)} } | Select-Object -First 1
if (-not $p) { Write-Output 'READ win.proc 0'; exit 1 }
$h = [Nat.Win]::FindTop([uint32]$p.ProcessId)
if ($h -eq 0) { Start-Sleep -Milliseconds 1500; $h = [Nat.Win]::FindTop([uint32]$p.ProcessId) }
if ($h -eq 0) { Write-Output 'READ win.hwnd 0（没找到可见窗口）'; exit 1 }
$ex = [Nat.Win]::GetWindowLong($h, -20)
$fg0 = [Nat.Win]::GetForegroundWindow()
$r = New-Object Nat.Win+RECT
[void][Nat.Win]::GetWindowRect($h, [ref]$r)
# 收起态：窗口体内取一点，WindowFromPoint 应当落在**别的窗口**上（穿透）
$mid = New-Object Nat.Win+POINT
$mid.X = [int](($r.Left + $r.Right) / 2)
$mid.Y = [int](($r.Top + $r.Bottom) / 2)
$under = [Nat.Win]::WindowFromPoint($mid)
# 透明：拿窗口左边缘外侧 6px 与再外侧 6px 逐通道比（同一张屏、同一行）
$bmp = New-Object System.Drawing.Bitmap 1, 1
$g = [System.Drawing.Graphics]::FromImage($bmp)
$px1 = $bmp.GetPixel(0,0)
$g.CopyFromScreen(($r.Left - 6), ([int](($r.Top + $r.Bottom) / 2)), 0, 0, (New-Object System.Drawing.Size(1,1)))
$a = $bmp.GetPixel(0,0)
$g.CopyFromScreen(($r.Left - 20), ([int](($r.Top + $r.Bottom) / 2)), 0, 0, (New-Object System.Drawing.Size(1,1)))
$b = $bmp.GetPixel(0,0)
$diff = [Math]::Max([Math]::Abs($a.R - $b.R), [Math]::Max([Math]::Abs($a.G - $b.G), [Math]::Abs($a.B - $b.B)))
$g.Dispose(); $bmp.Dispose()
$owner = [Nat.Win]::GetWindow($h, 4)   # GW_OWNER
Write-Output ("READ win.hwnd {0}" -f $h)
Write-Output ("READ win.rect {0},{1} {2}x{3}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
Write-Output ("READ win.exstyle {0} LAYERED={1} TRANSPARENT={2} TOPMOST={3} NOACTIVATE={4} TOOLWINDOW={5}" -f $ex, [bool]($ex -band 0x80000), [bool]($ex -band 0x20), [bool]($ex -band 0x8), [bool]($ex -band 0x08000000), [bool]($ex -band 0x80))
Write-Output ("READ win.clickThrough {0}" -f ($under -ne $h))
Write-Output ("READ win.edgePixelDiff {0}" -f $diff)
Write-Output ("READ win.foregroundUnchanged {0}" -f ([Nat.Win]::GetForegroundWindow() -eq $fg0))
Write-Output ("READ win.noTaskbar {0} (owner={1})" -f ([bool]($ex -band 0x80) -or ($owner -ne [IntPtr]::Zero)), $owner)
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'board.exe' -and $_.ExecutablePath -ieq ${psQuote(EXE)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
`;
  let out = '';
  try {
    out = powershell(script);
  } catch (e) {
    out = `${e.stdout ?? ''}${e.message ?? ''}`;
  } finally {
    try { fs.unlinkSync(状态); } catch { }
  }
  const 值 = k => (out.split(/\r?\n/).find(l => l.startsWith(`READ win.${k} `)) ?? '').replace(`READ win.${k} `, '').trim();
  if (!值('exstyle')) assert.fail(`窗口探针没拿到读数（无桌面会话？）：\n${out}`);
  assert.match(值('exstyle'), /LAYERED=True TRANSPARENT=True TOPMOST=True NOACTIVATE=True TOOLWINDOW=True/, `扩展样式不对：${值('exstyle')}（hwnd=${值('hwnd')} rect=${值('rect')}）`);
  assert.equal(值('clickThrough'), 'True', '收起态必须点击穿透（WindowFromPoint 落在别的窗口）');
  assert.ok(Number(值('edgePixelDiff')) <= 8, `窗口边缘像素差 ${值('edgePixelDiff')} —— 形状外面应当就是桌面`);
  assert.equal(值('foregroundUnchanged'), 'True', '不抢焦点');
  assert.match(值('noTaskbar'), /^True/, '不占任务栏按钮');
  console.log(out.split(/\r?\n/).filter(l => l.startsWith('READ win.')).join('\n'));
});
