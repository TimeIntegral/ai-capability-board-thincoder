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
import { powershell, psQuote, stopOwned, 写面板自启快捷方式, PANEL_SHORTCUT } from './windows-integration.mjs';
import { 分类, 从stage推导 } from '../../release/publish-files.mjs';
import { 树类型 } from '../../release/git-tree.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const EXE = path.join(ROOT, '程序', 'bin', 'board.exe');
const RECORD = path.join(ROOT, '程序', 'bin', 'panel-build.json');
const 有exe = fs.existsSync(EXE) && fs.existsSync(RECORD);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const 读 = rel => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } };
const skip若未编译 = () => (!有exe ? '还没编译面板（开发目录不产 exe，A3 —— 要编就在冻结树里编：node release/prepare.mjs，或在 private/ 下的链接工作树里编）' : false);

// 本机另有**别处**的看板在跑（比如用户自己的日常版）：单实例锁是会话级的（Local\AICapabilityBoard-Panel），
//   会被它占着 —— 本树起的面板会立刻退出并去唤出它（等于去动别人的窗口）。这几条用例要真起面板，
//   遇到这种情况一律跳过并写明理由（换一台隔离机跑就是全绿）；停别人的进程与强夺锁都不是测试该干的事。
const 外来面板在跑 = () => {
  try {
    const e = EXE.replace(/'/g, "''");
    const n = Number(String(powershell(`@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'board.exe' -and $_.ExecutablePath -ine '${e}' }).Count`)).trim());
    return n > 0 ? `本机另有一个别处的看板在跑（${n} 个，路径不是 ${EXE}）—— 单实例锁被它占着，本用例会去动别人的窗口，故跳过` : false;
  } catch { return false; }
};

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
  assert.ok(r.checks.length >= 93, `自检项太少（${r.checks.length} 条）—— 用例可能没跑全（2026-10-27 基线 93：原 81 + T34 字高/对比度/标签/卡片行 5 条 + T36 模型累计 6 条 + T12 会话起点 1 条）`);
  for (const id of ['T6-panelH', 'T7-detach', 'T8-clamp', 'T9-remain', 'T10-shared-unit', 'T11-hidden', 'T12-today', 'T12-session-start', 'T13-running', 'T14-quota', 'T15-change', 'T16-list',
    'T28-read-balance', 'T28-hidden', 'T28-shown-again', 'T29-retain', 'T29-firstfail', 'T30-fillet', 'T30-hairline',
    'T31-line', 'T31-hidden', 'T34-contrast', 'T34-cadence-height', 'T34-child', 'T34-card-row', 'T36-sum', 'T36-no-done', 'T36-stale-open', 'T36-cross-midnight', 'T36-child-sum', 'T36-session']) {
    assert.ok(r.checks.some(c => c.id === id), `自检缺少用例 ${id}`);
  }
  assert.match(r.summary, /fail=0/, `自检汇总不是全绿：${r.summary}`);
});

// 2026-09-27 的缺陷：面板现场读的那条路（Model.Build）根本没调 BalSnapshot.Read，
//   余额快照只存在于自检里 —— 自检全绿而面板永远「数据 —」。行为判据在自检 T28/T29（跑的就是 Model.Build）；
//   这里再钉一道「接线」：那条路上必须真的调过一次读（“自检替产品把活干了”这个坑就在这条判据上）。
test('现场读路径确实读了余额快照（Model.Build → BalSnapshot.Read）', () => {
  const 源 = 读('程序/panel/Model.cs') ?? '';
  const build = 源.split('public static Model Build(Model prev)')[1] ?? '';
  const body = build.split('public static Model BuildFor')[0] ?? '';
  assert.match(body, /ReadBalance\(prev\)|BalSnapshot\.Read\(/, 'Model.Build（现场读）必须读余额快照（只读额度、余额拿空快照 = 面板永远显示「数据 —」）');
  assert.ok(/public void ReadBalance\(Model prev\)[\s\S]*?BalSnapshot\.Read\(Ctx\.DataRoot\)/.test(源), 'ReadBalance 里必须真的调 BalSnapshot.Read(Ctx.DataRoot)');
  assert.ok(!/bal\s*=\s*bal\s*\?\?\s*new BalSnapshot\(\);/.test(body), '现场读那条路不许再用「空快照」当余额');
});

// 轮廓可见性：贴边那侧的内凹圆角只能靠「形状轮廓」读出来 —— 描边值必须是唯一出处（Geo.HAIRLINE），
//   且不允许面板里再写死一个当时那种 5% 白（与深色桌面同亮，等于没画）。判据本体在自检 T30。
test('轮廓描边取 Geo.HAIRLINE（不得写死 5% 白）', () => {
  const 源 = 读('程序/panel/Panel.cs') ?? '';
  assert.match(源, /Stroke = Brush\(Geo\.HAIRLINE\)/, '面板/收起条的描边必须取 Geo.HAIRLINE');
  assert.ok(!/#0DFFFFFF/.test(源), '面板里不许再写死 #0DFFFFFF（5% 白；压在深色桌面上与桌面同亮 → 贴边之后看不到轮廓）');
  const geo = 读('程序/panel/Geo.cs') ?? '';
  assert.match(geo, /HAIRLINE = "#([0-9A-Fa-f]{2})FFFFFF"/, 'Geo.HAIRLINE 必须是 8 位 #AARRGGBB');
  const m = geo.match(/HAIRLINE = "#([0-9A-Fa-f]{2})FFFFFF"/);
  assert.ok(parseInt(m[1], 16) >= 32, `Geo.HAIRLINE 的 α 太小（${m[1]}）—— 深色桌面上读不出来`);
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
    /^(正在干活|等你回答|空闲)$/,
    /^写入 (\d+[smhd]|\d+h\d{2}m|—) 前$/,
    // 2026-10-27：卡片第三行的「已 X」换成「模型 X」= 本会话模型累计运行（不是上一条事件到现在）
    /^模型 (\d+:)?\d{2}:\d{2}$/,
    /^\d+ 轮$/,
    /^子代理 \d+ 个在跑 · 最长 .+$/,
    // 余额节奏（充值不算消耗；24 小时没花钱；两种花钱说法）
    /^最近 ¥10 用了 .+$/,
    /^充值后花了 ¥[\d,]+\.\d{2} · 用时 .+$/,
    /^花了 ¥[\d,]+\.\d{2} · 用时 .+$/,
    /^最近 24 小时没花钱$/,
  ];
  // 旧四态、「会话」、裸计时与旧的「已 X」现已不上屏：它们还在词表里就等于给过期文案留了后门
  const 已废弃 = [/^会话$/, /^(正在运行|已完成|今天没用过)$/, /^(\d+:)?\d{2}:\d{2}$/, /^已 (\d+:)?\d{2}:\d{2}$/];
  const 遗留 = r.screens.filter(t => 已废弃.some(re => re.test(t.trim())));
  assert.deepEqual(遗留, [], `旧文案又冒出来了：\n  ${遗留.join('\n  ')}`);
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

// ── 开发目录不产 exe（A3 / T5）────────────────────────────────────────────
// 冻结树里这条不适用（那里的 exe 正是要有的）；它管**开发（主）工作树**：
// 开发目录里落下构建产物 = 下次构建捡到旧 exe 的入口 —— 这里既查现状，也查「编译当场拒绝」这个机制本身。
test('T5 开发目录不产 exe：程序/bin 下没有构建产物，且编译脚本在开发目录里当场拒绝', () => {
  if (树类型(ROOT) !== 'primary') return;                 // 冻结树 / 非 git 目录：这条不适用
  const bin = path.join(ROOT, '程序', 'bin');
  const 残留 = fs.existsSync(bin) ? fs.readdirSync(bin) : [];
  assert.deepEqual(残留, [], `开发目录里不该有面板构建产物（设计档 A3），实际有：${残留.join('、')} —— 删掉它们；要看面板请在 private/ 下建冻结工作树来编（设计档 2.2.10）`);
  const r = spawnSync(process.execPath, ['release/build-panel.mjs'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.notEqual(r.status, 0, '在开发目录里编面板必须被拒绝（exe 只能出自冻结提交）');
  assert.match(`${r.stdout}${r.stderr}`, /冻结/, '拒绝理由里应当说清「只在冻结提交上编」');
  assert.ok(!fs.existsSync(EXE) && !fs.existsSync(RECORD), '被拒绝的编译不许留下任何产物');
});

// ── 单实例（T17）────────────────────────────────────────────────────────
test('T17 单实例：连起两次只留一个面板窗口，第二次唤出已有并退出码 0', { skip: skip若未编译() || 外来面板在跑() }, () => {
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
  assert.match(文本, /ExecutablePath -ieq \(Join-Path \$root '程序\\\\bin\\\\board\.exe'\)/,
    '规则必须按**可执行文件路径**匹配，而且路径里的反斜杠要写成两条（模板字符串里写一条会被 JS 当转义吃掉）');
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

// ── 升级针的**行为**判据（T18b）────────────────────────────────────────────
// 契约文本对了不等于针是通的：2026-09-27 的演练实测过这个坑 —— 模板字符串里写 '程序\bin\board.exe'，
// \b 被 JS 吃成退格符，针的路径与真实 exe 路径永远不相等（T18 只看源码文本，看不出来）。
// 这里真起一个面板，再调本树里的 stopOwned（isolated:false、remove 默认 false = 只停进程），必须真的停掉。
test('T18b 升级针行为：面板在跑时 stopOwned 真的把它停掉（不是只对得上文本）', { skip: skip若未编译() || 外来面板在跑() }, () => {
  const 状态 = path.join(process.env.TEMP, `panel-state-needle-${Date.now()}.json`);
  const 个数 = () => Number(String(powershell(`@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'board.exe' -and $_.ExecutablePath -ieq ${psQuote(EXE)} }).Count`)).trim());
  try {
    powershell(`Start-Process -FilePath ${psQuote(EXE)} -ArgumentList @('--data', ${psQuote(ROOT)}, '--state', ${psQuote(状态)}, '--form', 'micro', '--seconds', '900') -WindowStyle Hidden`);
    for (let i = 0; i < 20 && 个数() === 0; i++) powershell('Start-Sleep -Milliseconds 250');
    assert.equal(个数(), 1, '面板没起来（是不是有别的 board.exe 占着单实例锁？）—— 行为判据没法判');
    stopOwned(ROOT);          // 真实安装/卸载走的同一条路（remove 默认 false：只停进程，不碰用户数据）
    assert.equal(个数(), 0, 'stopOwned 没停掉面板 —— 针的路径与真实 exe 路径对不上（转义或拼写）');
  } finally {
    powershell(`Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'board.exe' -and $_.ExecutablePath -ieq ${psQuote(EXE)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`);
    try { fs.unlinkSync(状态); } catch { }
  }
});

test('T35 开机自启：悬浮看板的 lnk 真进启动文件夹，卸载时真能清掉', { skip: skip若未编译() }, (t) => {
  // 2026-10-27 真机根因：install.mjs 模板字符串里 `\$` 写成了单反斜杠 —— lnk 落到 Programs 目录、
  //   名叫「Startup 悬浮看板.lnk」，开机永远不执行（真机上那个文件就是证据）。
  // 这条用例不只看源码：真建一次、读回三项、再让卸载路径真删一次。
  const 启动目录 = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const lnk = path.join(启动目录, PANEL_SHORTCUT + '.lnk');
  const 状态 = path.join(process.env.LOCALAPPDATA ?? '', 'AICapabilityBoard', 'panel-state.json');
  const 状态备份 = fs.existsSync(状态) ? fs.readFileSync(状态) : null;
  const tmpRoot = fs.mkdtempSync(path.join(process.env.TEMP, 'board-auto-'));
  const 读快捷方式 = file => {
    const out = powershell(`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$ws = New-Object -ComObject WScript.Shell
$l = $ws.CreateShortcut(${psQuote(file)})
Write-Output $l.TargetPath
Write-Output $l.Arguments
Write-Output $l.WorkingDirectory
`).replace(/\r/g, '').split('\n');
    return { TargetPath: out[0] ?? '', Arguments: out[1] ?? '', WorkingDirectory: out[2] ?? '' };
  };
  // 本机可能已有一份**别处安装**的日常版占着同一个 lnk 名（用户真机就是这样）：与「外来面板在跑」同一纪律 ——
  //   不碰别人的开机自启，本条登记为跳过（换一台干净机器跑就是全绿）。它指向本构建树（上次跑挂的残留）则照旧报红。
  if (fs.existsSync(lnk)) {
    const 已有 = 读快捷方式(lnk);
    if (path.resolve(已有.WorkingDirectory || '.').toLowerCase() !== path.resolve(tmpRoot).toLowerCase()) {
      t.skip(`启动文件夹里已有一份别处安装的开机自启（工作目录 ${已有.WorkingDirectory}）—— 不碰它，本用例跳过`);
      return;
    }
    assert.fail(`启动文件夹里已有一条指向本构建树的 lnk（${lnk}）—— 上次跑挂的残留，先人工清掉再跑`);
  }
  const 错名 = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup 悬浮看板.lnk');
  const 错名本来就有 = fs.existsSync(错名);
  try {
    fs.mkdirSync(path.join(tmpRoot, '快捷操作'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, '快捷操作', '悬浮看板.vbs'), path.join(tmpRoot, '快捷操作', '悬浮看板.vbs'));
    fs.mkdirSync(path.join(tmpRoot, '程序', 'bin'), { recursive: true });
    fs.copyFileSync(EXE, path.join(tmpRoot, '程序', 'bin', 'board.exe'));

    // ① 建：真落到启动文件夹，且三项都对
    const 建 = 写面板自启快捷方式(tmpRoot);
    assert.equal(建.enabled, true, '自启没有建成');
    assert.equal(path.resolve(建.file).toLowerCase(), path.resolve(lnk).toLowerCase(), `自启 lnk 落题位置不对：${建.file}`);
    assert.ok(fs.existsSync(lnk), `启动文件夹里没有 ${PANEL_SHORTCUT}.lnk —— 开机不会自启`);
    const 指向 = 读快捷方式(lnk);
    assert.equal(指向.TargetPath.toLowerCase(), path.join(process.env.SystemRoot, 'system32', 'wscript.exe').toLowerCase(), `lnk 指向不对：${指向.TargetPath}`);
    assert.ok(指向.Arguments.includes('悬浮看板.vbs'), `lnk 参数不对：${指向.Arguments}`);
    assert.equal(path.resolve(指向.WorkingDirectory).toLowerCase(), path.resolve(tmpRoot).toLowerCase(), `lnk 工作目录不对：${指向.WorkingDirectory}`);
    // 旧 bug 造出来的错名文件：我们这一次不许**再新造**一个。
    // （真机上它还在 —— 那是历史遗留，归它自己那个安装目录去清；测试不碰别人的 lnk）
    assert.equal(fs.existsSync(错名), 错名本来就有, `错名文件的存在状态被改变了：${错名}`);

    // ② 关开关：启动文件夹里的 lnk 必须消失
    const 关 = 写面板自启快捷方式(tmpRoot, { 启用: false });
    assert.equal(关.enabled, false);
    assert.ok(!fs.existsSync(lnk), '关掉自启之后 lnk 还在（下次开机还会把面板拉起来）');

    // ③ 再建一次，交给卸载那条路清（真实卸载就是调 stopOwned(remove)）
    写面板自启快捷方式(tmpRoot);
    assert.ok(fs.existsSync(lnk));
    stopOwned(tmpRoot, { remove: true });
    assert.ok(!fs.existsSync(lnk), '卸载后悬浮看板的 lnk 还留在启动文件夹里（与「删套件」自相矛盾）');
  } finally {
    try { if (fs.existsSync(lnk)) fs.unlinkSync(lnk); } catch { }
    try { if (状态备份 === null) { if (fs.existsSync(状态)) fs.unlinkSync(状态); } else fs.writeFileSync(状态, 状态备份); } catch { }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { }
  }
});

// 源码级回归针：install.mjs 里再出现 `\${...`（JS 模板字符串把 ${...} 转义成字面量）
//   就说明路径又会拼错 —— 历史缺陷就是这个形状，不靠人眼盯。
test('T35b install.mjs 不再把 ${...} 在模板字符串里转义（路径拼错的老毛病）', () => {
  const t = 读('程序/tools/install.mjs') ?? '';
  // 只认「落单的反斜杠 + ${」（`\\${` 是真反斜杠 + 插值，是对的；奇偶要看前一个字符）
  assert.ok(!/(?<!\\)\\\$\{/.test(t), 'install.mjs 里又出现了 `\\${...}`：JS 会把它当字面量丢给 PowerShell（变量未定义 = 空，且分隔符丢失）');
  assert.ok(t.includes('写面板自启快捷方式'), 'install.mjs 的悬浮看板自启应当走 windows-integration.mjs 里的唯一实现');
  assert.ok((读('程序/tools/windows-integration.mjs') ?? '').includes("'${PANEL_SHORTCUT}'"), '卸载侧也要认悬浮看板那个 lnk 名');
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
test('T21 窗口属性读回：透明 / 穿透 / 置顶 / 不抢焦点 / 不占任务栏', { skip: skip若未编译() || 外来面板在跑() }, () => {
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
