import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveConnections, parsePlatform, thresholdEditorValues, cardsEditorValues, THRESHOLD_RANGES } from './connections.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-connections-'));
  t.after(() => {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('board-connections-')) throw new Error('unsafe fixture');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const platforms = { codex: true, deepseek: false, glm: false };
test('blank credentials preserve existing keys and unrelated settings', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ intervals: { codexMinutes: 9 } }));
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ deepseek: 'fixture', extra: 'keep' }));
  saveConnections(dir, { platforms, keys: { deepseek: '' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'))), { deepseek: 'fixture', extra: 'keep' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).intervals.codexMinutes, 9);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).platforms.glm, false);
});
test('invalid input and broken files do not overwrite existing files', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  for (const input of [{ platforms, keys: { codex: 'bad' } }, { platforms, keys: { glm: 'bad\nvalue' } }, { platforms, keys: { glm: 'fixture' } }]) assert.throws(() => saveConnections(dir, input));
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false);
});
test('new keys saved locally without changing other provider', t => {
  const dir = fixture(t);
  saveConnections(dir, { platforms, keys: { glm: ' fixture ' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'))), { glm: 'fixture' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'secrets.json']);
});

test('platform argument is whitelisted; absent or unknown means the full window', () => {
  assert.equal(parsePlatform(['--platform=deepseek']), 'deepseek');
  assert.equal(parsePlatform(['--platform=GLM']), 'glm');            // 大小写不敏感
  assert.equal(parsePlatform(['--save', '--platform=codex']), 'codex');
  for (const argv of [[], ['--save'], ['--platform='], ['--platform=openai'], ['--platform=deepseek;calc'], ['x--platform=glm']]) {
    assert.equal(parsePlatform(argv), '', JSON.stringify(argv));
  }
});

test('native window passes secrets only through stdin and clears input', { skip: process.platform !== 'win32' }, t => {
  const dir = fixture(t);
  // 夹具按真实目录结构布局：程序在 <dir>/程序/tools/ 下（connections.ps1 自己往上一级找项目根）
  const tools = path.join(dir, '程序', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'connections.ps1'), path.join(tools, 'connections.ps1'));
  fs.writeFileSync(path.join(tools, 'connections.mjs'), `let text=''; for await (const part of process.stdin) text+=part; const p=JSON.parse(text); if(process.argv.length!==3 || process.argv[2]!=='--save' || p.keys.deepseek!=='fixture-value' || p.platforms.deepseek!==true) process.exit(1); process.stdout.write('连接测试通过');`);
  const env = { ...process.env }; delete env.PSModulePath;
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'connections.ps1'), '-NodeExe', process.execPath, '-PreviewPath', path.join(dir, 'preview.png'), '-SmokeTest'], { env, timeout: 25000, windowsHide: true, stdio: 'pipe' });
  assert.ok(fs.statSync(path.join(dir, 'preview.png')).size > 1000);
});

test('native tray menu renders in an isolated preview', { skip: process.platform !== 'win32' }, t => {
  const dir = fixture(t);
  const tools = path.join(dir, '程序', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'));
  fs.copyFileSync(path.join(import.meta.dirname, 'tray.ps1'), path.join(tools, 'tray.ps1'));
  fs.writeFileSync(path.join(dir, 'dashboard.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ tray: { pollSeconds: 60 } }));
  fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({ current: {
    codex: { ok: true, data: { fiveHour: { usedPercent: 25 } } },
    deepseek: { ok: true, data: { totalBalance: 12.5 } },
    glm: { ok: true, data: { balance: 8 } },
  } }));
  const preview = path.join(dir, 'tray.png');
  const env = { ...process.env }; delete env.PSModulePath;
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'tray.ps1'), '-PreviewPath', preview], { env, timeout: 25000, windowsHide: true, stdio: 'pipe' });
  assert.ok(fs.statSync(preview).size > 1000);
});

test('focused window passes secrets only through stdin, clears input and saves one platform', { skip: process.platform !== 'win32' }, t => {
  const dir = fixture(t);
  const tools = path.join(dir, '程序', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'connections.ps1'), path.join(tools, 'connections.ps1'));
  // 夹具只接受「载荷里只有 glm 一家」：多写一家、少写、或把其它平台写成 null 都算失败。
  // 这就是聚焦模式的承诺 —— 点哪张卡片只写哪一家，其它平台的开关不被碰。
  fs.writeFileSync(path.join(tools, 'connections.mjs'), `let text=''; for await (const part of process.stdin) text+=part; const p=JSON.parse(text); const ok=process.argv.length===3 && process.argv[2]==='--save' && JSON.stringify(p.platforms)==='{"glm":true}' && JSON.stringify(p.keys)==='{"glm":"fixture-value"}'; if(!ok) process.exit(1); process.stdout.write('连接测试通过');`);
  const env = { ...process.env }; delete env.PSModulePath;
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'connections.ps1'), '-NodeExe', process.execPath, '-Platform', 'glm', '-PreviewPath', path.join(dir, 'focus.png'), '-SmokeTest'], { env, timeout: 25000, windowsHide: true, stdio: 'pipe' });
  assert.ok(fs.statSync(path.join(dir, 'focus.png')).size > 1000);
});

// ---- 提醒阈值（连接窗口新增的那一段）----

test('editor prefill takes the four exposed thresholds out of the merged config', () => {
  assert.deepEqual(
    thresholdEditorValues({ thresholds: { codex5hWarn: 85, codexWeekWarn: 70, dsLow: 33, glmLow: 7, codex5hCritical: 95, dsCritical: 10 } }),
    { codex5hWarn: 85, codexWeekWarn: 70, dsLow: 33, glmLow: 7 });   // 只带窗口会显示的那四个
  assert.deepEqual(thresholdEditorValues({}), {});                    // 缺配置 → 空（窗口自己回退内置默认值）
  assert.deepEqual(thresholdEditorValues(null), {});
  assert.deepEqual(thresholdEditorValues({ thresholds: { dsLow: 'nope' } }), {});
});

test('thresholds merge into config and leave the keys the window does not show alone', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    intervals: { codexMinutes: 9 },
    platforms: { glm: true },
    thresholds: { codex5hWarn: 50, codex5hCritical: 93, codexWeekWarn: 55, dsLow: 9, dsCritical: 4, glmLow: 3, glmCritical: 2 },
  }));
  saveConnections(dir, { platforms, keys: {}, thresholds: { codex5hWarn: 85, dsLow: 30 } });
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
  assert.equal(cfg.thresholds.codex5hWarn, 85);
  assert.equal(cfg.thresholds.dsLow, 30);
  assert.equal(cfg.thresholds.codex5hCritical, 93);                  // 窗口没露的键：原样保留
  assert.equal(cfg.thresholds.glmCritical, 2);
  assert.equal(cfg.thresholds.codexWeekWarn, 55);
  assert.equal(cfg.intervals.codexMinutes, 9);                       // 其余字段也不受影响
  assert.deepEqual(cfg.platforms, platforms);
});

test('payload without a thresholds section leaves that section untouched (old window)', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ thresholds: { glmLow: 7 } }));
  saveConnections(dir, { platforms, keys: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).thresholds, { glmLow: 7 });
});

test('out-of-range, unknown or non-numeric thresholds are rejected before any write', t => {
  const dir = fixture(t);
  const before = JSON.stringify({ platforms: { glm: true }, thresholds: { dsLow: 20 } });
  fs.writeFileSync(path.join(dir, 'config.json'), before);
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ glm: 'fixture' }));
  const bad = [
    { thresholds: { dsLow: 0 } },                       // 低于下限
    { thresholds: { dsLow: 1001 } },                    // 高于上限
    { thresholds: { codex5hWarn: 40 } },                // Codex 百分比低于下限
    { thresholds: { codexWeekWarn: 101 } },             // 高于上限
    { thresholds: { codex5hCritical: 95 } },            // 白名单外（窗口不露这条，不许凭空写）
    { thresholds: { dsLow: 'abc' } },
    { thresholds: { dsLow: null } },
    { thresholds: [] },
  ];
  for (const input of bad) {
    assert.throws(() => saveConnections(dir, { ...input, platforms, keys: { glm: 'newfixture' } }), JSON.stringify(input));
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'))), { glm: 'fixture' });
  }
});

test('native window shows the injected thresholds and sends them back with the rest', { skip: process.platform !== 'win32' }, t => {
  const dir = fixture(t);
  const tools = path.join(dir, '程序', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'connections.ps1'), path.join(tools, 'connections.ps1'));
  const dump = path.join(dir, 'payload.json');
  // 桩两件事：把窗口送来的原始载荷落盘（下一段喂给真实的 saveConnections），
  // 以及核对载荷里的四个值 = 注入值 +1（smoke 夹具把每条控件都往上拨了一格，
  // 所以这里证明的是「控件里的值」上了载荷，而不是注入值原样回写）。
  fs.writeFileSync(path.join(tools, 'connections.mjs'), `import fs from 'node:fs';
let text=''; for await (const part of process.stdin) text+=part;
fs.writeFileSync(${JSON.stringify(dump)}, text);
const p=JSON.parse(text); const want={codex5hWarn:86,codexWeekWarn:71,dsLow:34,glmLow:8}; const got=p.thresholds??{};
const ok=process.argv.length===3 && process.argv[2]==='--save' && p.platforms.deepseek===true
  && Object.keys(want).every(k=>got[k]===want[k]) && Object.keys(got).length===Object.keys(want).length;
process.stdout.write(ok?'连接测试通过':'阈值载荷不符');`);
  const env = { ...process.env, BOARD_THRESHOLDS: JSON.stringify({ codex5hWarn: 85, codexWeekWarn: 70, dsLow: 33, glmLow: 7 }) };
  delete env.PSModulePath;
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'connections.ps1'), '-NodeExe', process.execPath, '-PreviewPath', path.join(dir, 'preview.png'), '-SmokeTest'], { env, timeout: 25000, windowsHide: true, stdio: 'pipe' });
  assert.ok(fs.statSync(path.join(dir, 'preview.png')).size > 1000);

  // 端到端：窗口 → stdin JSON → 真实的 saveConnections → config.json。
  // 已经有自定义值的紧急阈值与其它字段不能被碰，平台开关与密钥只按窗口送来的那份变。
  const target = fixture(t);
  fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify({
    intervals: { codexMinutes: 9 },
    platforms: { codex: false, deepseek: false, glm: false },
    thresholds: { codex5hWarn: 50, codex5hCritical: 93, codexWeekWarn: 55, dsLow: 9, dsCritical: 4, glmLow: 3, glmCritical: 2 },
  }));
  fs.writeFileSync(path.join(target, 'secrets.json'), JSON.stringify({ deepseek: 'keep-me', extra: 'keep' }));
  saveConnections(target, JSON.parse(fs.readFileSync(dump, 'utf8')));
  const cfg = JSON.parse(fs.readFileSync(path.join(target, 'config.json')));
  assert.deepEqual(
    { codex5hWarn: cfg.thresholds.codex5hWarn, codexWeekWarn: cfg.thresholds.codexWeekWarn, dsLow: cfg.thresholds.dsLow, glmLow: cfg.thresholds.glmLow },
    { codex5hWarn: 86, codexWeekWarn: 71, dsLow: 34, glmLow: 8 });
  assert.equal(cfg.thresholds.codex5hCritical, 93);                  // 窗口没露的照旧
  assert.equal(cfg.thresholds.dsCritical, 4);
  assert.equal(cfg.intervals.codexMinutes, 9);
  assert.deepEqual(cfg.platforms, { codex: false, deepseek: true, glm: false });   // 只有探针那家被勾上
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'secrets.json'))), { deepseek: 'fixture-value', extra: 'keep' });
});

test('focused window sends only that platform thresholds', { skip: process.platform !== 'win32' }, t => {
  const dir = fixture(t);
  const tools = path.join(dir, '程序', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'connections.ps1'), path.join(tools, 'connections.ps1'));
  fs.writeFileSync(path.join(tools, 'connections.mjs'), `let text=''; for await (const part of process.stdin) text+=part; const p=JSON.parse(text); const ok=process.argv.length===3 && process.argv[2]==='--save' && JSON.stringify(p.platforms)==='{"glm":true}' && JSON.stringify(p.thresholds)==='{"glmLow":8}'; if(!ok) process.exit(1); process.stdout.write('连接测试通过');`);
  const env = { ...process.env, BOARD_THRESHOLDS: JSON.stringify({ codex5hWarn: 85, codexWeekWarn: 70, dsLow: 33, glmLow: 7 }) };
  delete env.PSModulePath;
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'connections.ps1'), '-NodeExe', process.execPath, '-Platform', 'glm', '-PreviewPath', path.join(dir, 'focus-thresholds.png'), '-SmokeTest'], { env, timeout: 25000, windowsHide: true, stdio: 'pipe' });
  assert.ok(fs.statSync(path.join(dir, 'focus-thresholds.png')).size > 1000);
});

// ---- 密钥来源提示（2026-09-17：装了 ThinCoder 的用户必须看得见「密钥是从那儿拿到的」）----

test('key source hint: says "read from ThinCoder" only for that source', { skip: process.platform !== 'win32' }, t => {
  const dir = fixture(t);
  const tools = path.join(dir, '程序', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'connections.ps1'), path.join(tools, 'connections.ps1'));
  fs.writeFileSync(path.join(tools, 'connections.mjs'), `let text=''; for await (const part of process.stdin) text+=part; const p=JSON.parse(text); if (p.keys.deepseek !== 'fixture-value') process.exit(1); process.stdout.write('连接测试通过');`);
  // 桩状态：一家从 ThinCoder 配置读到、一家从 secrets.json 读到 —— 两行提示必须分开，否则等于没说来源。
  // 断言在窗口里跑（-SmokeTest）：文案真的写出来了，而且一行放得下（210px 标签不被截断）。
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'setup-status.json'), JSON.stringify({
    checkedAtMs: 1,
    platforms: { codex: true, deepseek: true, glm: true },
    codex: { found: true, note: 'stub' },
    deepseek: { found: true, source: 'ThinCoder 配置', length: 35, note: 'stub' },
    glm: { found: true, source: 'secrets.json', length: 32, note: 'stub' },
    lastCollect: { atMs: 1 },
  }));
  const env = { ...process.env }; delete env.PSModulePath; delete env.BOARD_THRESHOLDS;
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'connections.ps1'), '-NodeExe', process.execPath, '-PreviewPath', path.join(dir, 'hints.png'), '-SmokeTest'], { env, timeout: 25000, windowsHide: true, stdio: 'pipe' });
  assert.ok(fs.statSync(path.join(dir, 'hints.png')).size > 1000);
});

// ---- 余额提醒线的内置回退默认值（2026-09-17：余额类统一为 5 元）----

test('window fallback defaults match config.template.json (balance warning lines are 5)', { skip: process.platform !== 'win32' }, t => {
  const tpl = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'config.template.json'), 'utf8'));
  const want = {
    codex5hWarn: tpl.thresholds.codex5hWarn, codexWeekWarn: tpl.thresholds.codexWeekWarn,
    dsLow: tpl.thresholds.dsLow, glmLow: tpl.thresholds.glmLow,
  };
  assert.equal(tpl.thresholds.dsLow, 5);       // 余额类：低于 5 元提醒（产品定的值写死在此，改动必现形）
  assert.equal(tpl.thresholds.glmLow, 5);
  assert.equal(tpl.thresholds.dsCritical, 2);  // 急线：DeepSeek 与 GLM 同构 5/2（低线高于急线，两级才都可达）
  assert.equal(tpl.thresholds.glmCritical, 2);
  for (const [k, v] of Object.entries(want)) {   // 默认值必须落在窗口/node 两侧的范围校验里，否则控件画不出来
    assert.ok(v >= THRESHOLD_RANGES[k][0] && v <= THRESHOLD_RANGES[k][1], `${k} 默认值 ${v} 超出 ${THRESHOLD_RANGES[k]}`);
  }
  const dir = fixture(t);
  const tools = path.join(dir, '程序', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'connections.ps1'), path.join(tools, 'connections.ps1'));
  const dump = path.join(dir, 'payload.json');
  fs.writeFileSync(path.join(tools, 'connections.mjs'), `import fs from 'node:fs';
let text=''; for await (const part of process.stdin) text+=part;
fs.writeFileSync(${JSON.stringify(dump)}, text);
process.stdout.write('连接测试通过');`);
  const env = { ...process.env }; delete env.PSModulePath; delete env.BOARD_THRESHOLDS;   // 没有注入 → 窗口只能拿自己的内置默认值画
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'connections.ps1'), '-NodeExe', process.execPath, '-PreviewPath', path.join(dir, 'defaults.png'), '-SmokeTest'], { env, timeout: 25000, windowsHide: true, stdio: 'pipe' });
  const got = JSON.parse(fs.readFileSync(dump, 'utf8')).thresholds;
  // smoke 夹具把每条控件都 +1（证明控件里的值真的上了载荷），所以载荷 = 内置默认值 + 1：
  // 逐键对上模板即证明「窗口内置默认值」与「模板默认值」同源 —— 两边漂移必红。
  assert.deepEqual(got, Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v + 1])));
  assert.ok(fs.statSync(path.join(dir, 'defaults.png')).size > 1000);
});

// ---- 看板显示（2026-09-20 收敛：不要自动隐藏，只看用户自己的设置）----
// 两件事分得很清：config.platforms 管采集与提醒，dashboard.cards 只管看板上显不显示这一家；
// 不显示 = 卡片、趋势图、热力图页签、额度去向、采集健康、GLM 充值记录里的这一家一起收（见 dashboard.html 的 applyVisibility）。

test('显示规则：只看用户设置 —— 缺键 = 显示（关掉采集的平台也照样显示），只有显式 false 才不显示', () => {
  const show = cfg => Object.fromEntries(Object.entries(cardsEditorValues(cfg)).map(([k, v]) => [k, v.show]));
  const all = { codex: true, deepseek: true, glm: true };

  assert.deepEqual(show({}), all, '什么都没设置 → 三家都显示');
  assert.deepEqual(show({ dashboard: {} }), all);
  assert.deepEqual(show({ dashboard: { cards: { $comment: '说明' } } }), all, '模板原样复制（只有 $comment）→ 照旧显示');
  assert.deepEqual(show({ dashboard: { cards: { glm: false } } }), { codex: true, deepseek: true, glm: false });
  assert.deepEqual(show({ dashboard: { cards: { codex: true, deepseek: false } } }), { codex: true, deepseek: false, glm: true }, '显式 true 也算数（老版本写下的）');
  assert.deepEqual(show({ platforms: { codex: false, deepseek: false, glm: false } }), all, '关掉采集不再影响显示（「关掉就不出卡」的自动判断已删除）');
  assert.deepEqual(show({ dashboard: { cards: { codex: null, glm: 'no' } } }), all, '值不是布尔 → 按「没设置」处理');
});

test('cardsEditorValues 拿不到配置也不炸：一律按默认「显示」（不再需要 state）', () => {
  for (const cfg of [null, undefined, {}]) {
    assert.deepEqual(Object.fromEntries(Object.entries(cardsEditorValues(cfg)).map(([k, v]) => [k, v.show])), { codex: true, deepseek: true, glm: true });
  }
});

test('卡片显示合并进 config.json 的 dashboard.cards，只动送来的那几家', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    intervals: { codexMinutes: 9 },
    dashboard: { refreshSeconds: 30, theme: 'dark', cards: { glm: false } },
  }));
  saveConnections(dir, { platforms, keys: {}, cards: { codex: true } });
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')));
  assert.deepEqual(cfg.dashboard.cards, { glm: false, codex: true });   // 没送的那家原样保留
  assert.equal(cfg.dashboard.refreshSeconds, 30);                      // dashboard 段其它字段不动
  assert.equal(cfg.dashboard.theme, 'dark');
  assert.equal(cfg.intervals.codexMinutes, 9);
});

test('cards 写 null = 回到默认（删掉显式值），一条不剩就把这一段删掉', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dashboard: { cards: { glm: false, codex: true } } }));
  saveConnections(dir, { platforms, keys: {}, cards: { glm: null } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).dashboard.cards, { codex: true });
  saveConnections(dir, { platforms, keys: {}, cards: { codex: null } });
  assert.equal('cards' in JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).dashboard, false);
});

test('载荷没有 cards 段（老窗口）时不动 dashboard', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ dashboard: { cards: { glm: false } } }));
  saveConnections(dir, { platforms, keys: {} });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).dashboard.cards, { glm: false });
});

test('cards 里的非法值在写入之前被拒绝', t => {
  const dir = fixture(t);
  const before = JSON.stringify({ platforms: { glm: true }, dashboard: { cards: { glm: false } } });
  fs.writeFileSync(path.join(dir, 'config.json'), before);
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ glm: 'fixture' }));
  for (const input of [{ cards: { openai: true } }, { cards: { glm: 'yes' } }, { cards: { glm: 1 } }, { cards: [] }]) {
    assert.throws(() => saveConnections(dir, { ...input, platforms, keys: { glm: 'newfixture' } }), JSON.stringify(input));
    assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), before);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'))), { glm: 'fixture' });
  }
});

test('窗口的「看板显示卡片」：预填注入值；取消勾选的那家写 false，勾着的写 null（回到默认显示）', { skip: process.platform !== 'win32' }, t => {
  const dir = fixture(t);
  const tools = path.join(dir, '程序', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'connections.ps1'), path.join(tools, 'connections.ps1'));
  const dump = path.join(dir, 'payload.json');
  // 桩：探针那一家（deepseek）被 smoke 夹具拨翻了一次（预填勾着 → 变成不勾），所以它写 false；
  // 另两家没动（勾着）= 默认显示 → 写 null（把显式值删掉，不把「显示」钉死成一次性设置）。
  fs.writeFileSync(path.join(tools, 'connections.mjs'), `import fs from 'node:fs';
let text=''; for await (const part of process.stdin) text+=part;
fs.writeFileSync(${JSON.stringify(dump)}, text);
const p=JSON.parse(text), c=p.cards||{};
const ok=process.argv.length===3 && process.argv[2]==='--save' && Object.keys(c).length===3
  && c.codex===null && c.deepseek===false && c.glm===null;
process.stdout.write(ok?'连接测试通过':'看板显示载荷不符');`);
  // 状态桩：三家都没开采集（平台的勾由 smoke 夹具打开；与卡片显示无关，两者不再联动）
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'setup-status.json'), JSON.stringify({
    checkedAtMs: 1, platforms: { codex: false, deepseek: false, glm: false },
    codex: { found: false }, deepseek: { found: true, source: 'secrets.json' }, glm: { found: true, source: 'secrets.json' },
    lastCollect: { atMs: 1 },
  }));
  // 注入：三家都显示（默认）→ 三个控件都预填勾上；smoke 夹具会把探针那一家拨到不勾
  const cards = { codex: { show: true }, deepseek: { show: true }, glm: { show: true } };
  const env = { ...process.env, BOARD_CARDS: JSON.stringify(cards) };
  delete env.PSModulePath; delete env.BOARD_THRESHOLDS;
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'connections.ps1'), '-NodeExe', process.execPath, '-PreviewPath', path.join(dir, 'cards.png'), '-SmokeTest'], { env, timeout: 25000, windowsHide: true, stdio: 'pipe' });
  assert.ok(fs.statSync(path.join(dir, 'cards.png')).size > 1000);

  // 端到端：这份载荷喂给真实的 saveConnections —— deepseek 落成「不显示」；
  // 原有那一条（glm 固定显示）因为拿到的是 null（回到默认）被清掉。
  const target = fixture(t);
  fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify({ dashboard: { cards: { glm: false } } }));
  saveConnections(target, JSON.parse(fs.readFileSync(dump, 'utf8')));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, 'config.json'))).dashboard.cards, { deepseek: false });
});
