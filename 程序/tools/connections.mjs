import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { ROOT_DIR, loadConfig, cardSettings } from '../lib/common.mjs';

const root = ROOT_DIR;                       // 项目根（config.json / secrets.json / data 那一层）
const CODE = path.join(root, '程序');         // 程序代码目录：tools\ 以及各 .mjs 都在这里
const names = ['codex', 'deepseek', 'glm'];
// 提醒阈值：连接窗口只露四条「提醒线」——用量到多少 % / 余额低于多少钱时**开始提醒**
// （程序\alert\rules.mjs 的 codex5hWarn / codexWeekWarn / dsLow / glmLow）。
// 紧急阈值（*Critical）与预测、异常参数不在窗口里，保持配置文件里的值不动；
// 键名与取值范围与命令行白名单 tools/edit-config.mjs 同源（多实现面纪律：各面独立实现、语义同源）。
export const THRESHOLD_RANGES = {
  codex5hWarn: [50, 100],
  codexWeekWarn: [50, 100],
  dsLow: [1, 1000],
  glmLow: [1, 1000],
};
// 交给窗口预填的现状值：配置语义的唯一权威在 node 侧（模板默认 + 用户值合并，见 lib/common.mjs:21），
// 窗口只负责显示。经环境变量下发：不进命令行、不进 URL、不落盘（阈值不是密钥，但仍沿用同一条通路纪律）。
// 取不到值的键不放进结果——窗口自己回退到内置默认值（与 config.template.json 同源）。
export function thresholdEditorValues(cfg) {
  const out = {};
  for (const key of Object.keys(THRESHOLD_RANGES)) {
    const value = Number(cfg?.thresholds?.[key]);
    if (Number.isFinite(value)) out[key] = value;
  }
  return out;
}
// 看板显示卡片的现状值：show = 这一家在看板上显不显示（缺键 = 显示，见 lib/common.mjs 的 cardSettings）。
// 窗口用它预填「看板显示卡片」那一勾；保存时只把「与默认不同」的那几家写进配置（同一条环境变量通路）。
// 这里不做任何推断，也就不需要 state —— 配置本身就能算出来（读不到配置时不注入，窗口回退到默认「显示」）。
export function cardsEditorValues(cfg) {
  try { return cardSettings(cfg); } catch { return null; }
}
// 看板卡片上的「启用平台」经协议发来 aiquotaboard://connect?platform=xxx（契约见 docs/连接与发布隔离.md）。
// 只认这三个名字；缺参数、空值、其它值一律返回 '' = 完整窗口（老行为）。
// 这里是浏览器字符串进入本进程的唯一入口，所以白名单校验放在最外层，不进命令行。
export function parsePlatform(argv = process.argv.slice(2)) {
  const hit = argv.find(a => String(a).startsWith('--platform='));
  const value = hit ? String(hit).slice('--platform='.length).trim().toLowerCase() : '';
  return names.includes(value) ? value : '';
}
function readObject(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw 0;
    return value;
  } catch { throw new Error('已有设置无法读取，请先修复或恢复备份；未覆盖原文件。'); }
}
function atomic(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function saveConnections(directory, input) {
  // platforms 允许只给一部分：聚焦窗口（点某张卡片的「启用平台」）只写选中那一家，其余平台原样保留。
  // 逐项校验：没给平台、给了不认识的名字、值不是布尔，一律拒绝（全量窗口仍然三家都送来，行为不变）。
  const platforms = input?.platforms;
  if (!platforms || typeof platforms !== 'object' || Array.isArray(platforms)) throw new Error('请选择要连接的平台。');
  const chosen = Object.keys(platforms);
  if (!chosen.length) throw new Error('请选择要连接的平台。');
  if (chosen.some(n => !names.includes(n))) throw new Error('不支持的平台。');
  if (chosen.some(n => typeof platforms[n] !== 'boolean')) throw new Error('请选择要连接的平台。');
  const keys = input.keys ?? {};
  if (Object.keys(keys).some(n => !['deepseek', 'glm'].includes(n))) throw new Error('不支持的密钥类型。');
  for (const key of Object.values(keys)) {
    if (typeof key !== 'string' || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error('密钥格式不正确，请重新粘贴。');
  }
  // thresholds 同样允许只给一部分（聚焦窗口只写那一家）；整段缺省 = 老载荷，一条不写（向后兼容）。
  // 逐项白名单 + 范围校验：不认识的键、非数值、越界一律拒绝——拒绝发生在任何写入之前。
  const thresholds = input.thresholds;
  const thresholdPatch = {};
  if (thresholds != null) {
    if (typeof thresholds !== 'object' || Array.isArray(thresholds)) throw new Error('提醒数值无法读取，请重新打开窗口。');
    for (const [key, raw] of Object.entries(thresholds)) {
      const range = THRESHOLD_RANGES[key];
      if (!range) throw new Error('不支持的提醒设置。');
      const value = Number(raw);
      if (!Number.isFinite(value) || value < range[0] || value > range[1]) throw new Error('提醒数值超出范围，请重新填写。');
      thresholdPatch[key] = value;
    }
  }
  // cards（看板显示哪几家）同样允许只给一部分，整段缺省 = 老窗口载荷，一条不写（向后兼容）。
  // 值：false = 不显示；true = 显示；null = 回到默认（把显式值删掉——默认就是显示）。
  // 白名单 + 类型校验，拒绝发生在任何写入之前；与 thresholds 同一条纪律。
  const cards = input?.cards;
  const cardPatch = {}, cardClear = [];
  if (cards != null) {
    if (typeof cards !== 'object' || Array.isArray(cards)) throw new Error('看板显示设置无法读取，请重新打开窗口。');
    for (const [key, raw] of Object.entries(cards)) {
      if (!names.includes(key)) throw new Error('不支持的看板显示设置。');
      if (raw === null) { cardClear.push(key); continue; }
      if (typeof raw !== 'boolean') throw new Error('看板显示设置无法读取，请重新打开窗口。');
      cardPatch[key] = raw;
    }
  }
  const configFile = path.join(directory, 'config.json');
  const secretsFile = path.join(directory, 'secrets.json');
  // Validate both existing files before any write; blank inputs preserve existing credentials.
  const config = readObject(configFile), secrets = readObject(secretsFile);
  let changed = false;
  for (const n of ['deepseek', 'glm']) if (keys[n]?.trim()) { secrets[n] = keys[n].trim(); changed = true; }
  const previous = fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile) : null;
  if (changed) atomic(secretsFile, secrets);
  const next = { ...config, platforms: { ...config.platforms, ...input.platforms } };
  // 阈值只合并送来的键：窗口没露的（紧急阈值 / 预测 / 异常）与其余字段原样保留。
  // 一个键都没送 = 不新建 thresholds 段，也不把已有值改写成空。
  if (Object.keys(thresholdPatch).length) next.thresholds = { ...config.thresholds, ...thresholdPatch };
  // 卡片显示只动送来的那几家；dashboard 段其它字段（刷新秒数 / 主题 …）原样保留。
  // 三家都回到默认（显示）时把 cards 整段删掉——配置里应该是「没有设置」，不是「设置了空」。
  if (Object.keys(cardPatch).length || cardClear.length) {
    const merged = { ...(config.dashboard?.cards ?? {}), ...cardPatch };
    for (const key of cardClear) delete merged[key];
    const dashboard = { ...(config.dashboard ?? {}) };
    if (Object.keys(merged).length) dashboard.cards = merged;
    else delete dashboard.cards;
    next.dashboard = dashboard;
  }
  try { atomic(configFile, next); }
  catch (error) {
    if (changed) {
      if (previous === null) fs.unlinkSync(secretsFile);
      else atomic(secretsFile, JSON.parse(previous.toString('utf8')));
    }
    throw error;
  }
}

function run(script, args = [], timeout = 120000) {
  execFileSync(process.execPath, [path.join(CODE, script), ...args], { cwd: root, timeout, windowsHide: true, stdio: 'ignore' });
}
async function main() {
  if (process.argv.includes('--save')) {
    let body = '';
    for await (const chunk of process.stdin) { body += chunk; if (body.length > 20000) throw new Error('输入过长。'); }
    saveConnections(root, JSON.parse(body));
    body = '';
    const development = fs.existsSync(path.join(root, '.git'));
    let automatic = false, collected = false;
    if (!development) { try { run('tools/install.mjs', ['--skip-verify']); automatic = true; } catch {} }
    try { run('collect.mjs', ['--all'], 90000); collected = true; } catch {}
    const state = readObject(path.join(root, 'data/state.json'));
    const lines = names.map(n => {
      const r = state.current?.[n];
      return `${n === 'glm' ? 'GLM' : n === 'codex' ? 'Codex' : 'DeepSeek'}：${!collected ? '验证未完成，请重试' : r?.disabled ? '未启用' : r?.ok ? (r.degraded ? '使用本地记录，实时连接待恢复' : '已连接') : r?.unconfigured ? (n === 'codex' ? '请先在 Codex 登录' : '请补充密钥') : '未连接，请检查账号、密钥或网络后重试'}`;
    });
    try { run('tools/setup-check.mjs'); } catch {}
    lines.push(development ? '开发预览：未注册后台任务。日常使用请安装发布包。' : automatic ? '自动采集已开启，可返回看板。' : '设置已保存，但自动采集未开启，请重试。');
    process.stdout.write(lines.join('\n'));
  } else {
    const platform = parsePlatform();
    // 探测失败也要把窗口开出来（它是本机唯一的配置入口）：状态读不到只影响预填，窗口侧对缺失状态本就容错。
    try { run('tools/setup-check.mjs'); } catch {}
    const env = { ...process.env }; delete env.PSModulePath;
    // 窗口要预填的现状值（阈值 + 卡片显示）：读不到就不注入，窗口自己回退（少一次崩溃面）。
    // 两条都走环境变量：不进命令行、不进 URL、不落盘。
    let cfg = null;
    try { cfg = loadConfig(); } catch { cfg = null; }
    if (cfg) {
      try { env.BOARD_THRESHOLDS = JSON.stringify(thresholdEditorValues(cfg)); }
      catch { delete env.BOARD_THRESHOLDS; }
      const cards = cardsEditorValues(cfg);
      if (cards) env.BOARD_CARDS = JSON.stringify(cards); else delete env.BOARD_CARDS;
    } else { delete env.BOARD_THRESHOLDS; delete env.BOARD_CARDS; }
    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(CODE, 'tools/connections.ps1'), '-NodeExe', process.execPath];
    if (platform) args.push('-Platform', platform);   // 只配置这一家；不带 = 三家都显示（老行为）
    execFileSync('powershell.exe', args, { env, windowsHide: true, stdio: 'ignore' });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch { process.stdout.write('未完成连接。已有设置可能无法读取，或保存失败；请检查后重试。'); process.exitCode = 1; }
}
