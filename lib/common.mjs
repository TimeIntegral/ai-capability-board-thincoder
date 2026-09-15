import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const ROOT_DIR = ROOT;
export const DATA_DIR = path.join(ROOT, 'data');
export const CONFIG_FILE = path.join(ROOT, 'config.json');
export const HOUR_MS = 3600 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function ensureDataDir() {
  fs.mkdirSync(path.join(DATA_DIR, 'history'), { recursive: true });
}

export function loadConfig() {
  const templatePath = path.join(ROOT, 'config.template.json');
  const configPath = path.join(ROOT, 'config.json');
  const defaults = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  let user = {};
  if (fs.existsSync(configPath)) {
    try { user = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (e) { console.error(`[config] config.json 解析失败，使用默认配置: ${e.message}`); }
  }
  const merged = { ...defaults, ...user };
  for (const sec of ['thresholds', 'dnd', 'cooldown', 'hysteresis', 'release', 'mute', 'history',
    'dashboard', 'notify', 'intervals', 'predict', 'anomaly', 'attribution', 'backup', 'tray', 'links', 'platforms']) {
    merged[sec] = { ...(defaults[sec] ?? {}), ...(user[sec] ?? {}) };
  }
  // links 是两层结构（平台 → {name,usage,topup}），逐平台合并，避免只改一个字段就丢掉其余字段
  for (const p of Object.keys(defaults.links ?? {})) {
    if (p.startsWith('$')) continue;
    merged.links[p] = { ...(defaults.links?.[p] ?? {}), ...(user.links?.[p] ?? {}) };
  }
  // 随用户名变化的路径不能写在模板里（模板要能发布给任何人）。
  // 留空 → 按当前用户的家目录推导；配置里显式写了就以配置为准（老用户行为不变）。
  const home = os.homedir();
  if (!merged.codexHome) merged.codexHome = path.join(home, '.codex');
  if (!merged.thinCoderConfig) merged.thinCoderConfig = path.join(home, '.thincoder', 'config.json');
  // 通知的「打开看板」按钮：没配就指向本机的 dashboard.html（安装位置因人而异，运行时算）
  if (!merged.notify?.launchUrl) {
    merged.notify = { ...(merged.notify ?? {}), launchUrl: pathToFileURL(path.join(ROOT, 'dashboard.html')).href };
  }
  return merged;
}

// ---- 平台开关（config.platforms）----
// 语义：只有显式 false 才关闭；缺这一段、缺某个键、或整段不是对象 → 该平台视为开启（与加开关前的行为完全一致）。

export const PLATFORMS = ['codex', 'deepseek', 'glm'];

export function platformEnabled(cfg, name) {
  const p = cfg?.platforms;
  if (!p || typeof p !== 'object') return true;
  return p[name] !== false;
}

export function enabledPlatforms(cfg) {
  const out = {};
  for (const n of PLATFORMS) out[n] = platformEnabled(cfg, n);
  return out;
}

// ---- 路径白名单（看板上「打开文件夹 / 启动 ThinCoder」的越界防护）----
// 发布版的默认值是**空的**：每个人把项目放在哪儿都不同，写死任何路径都对别人是错的，
// 且会把自己的目录结构泄漏进公开代码。留空 = 只允许本项目自身目录。
export function isAllowedPath(cfg, target) {
  const roots = [ROOT_DIR, ...(Array.isArray(cfg?.projectsRoots) ? cfg.projectsRoots : [])];
  const extra = Array.isArray(cfg?.tcRoots) ? cfg.tcRoots : [];   // 额外放行的常用目录（本人自配）
  const resolved = path.resolve(target).toLowerCase();
  return [...roots, ...extra]
    .map(p => path.resolve(p).toLowerCase())
    .some(r => resolved === r || resolved.startsWith(r + path.sep));
}

export function allowedRootsText(cfg) {
  const roots = [ROOT_DIR, ...(Array.isArray(cfg?.projectsRoots) ? cfg.projectsRoots : [])];
  const extra = Array.isArray(cfg?.tcRoots) ? cfg.tcRoots : [];
  return [...roots, ...extra].join(' / ');
}

// ---- 凭证读取（只读不写，永不进日志/看板）----
// 纪律：密钥值只允许存在于内存里的请求头；错误信息、日志、state.json 中只允许出现「来源标签」，永不出现密钥本身。

export const SECRETS_FILE = path.join(ROOT, 'secrets.json');

const PLATFORM_LABEL = { codex: 'Codex', deepseek: 'DeepSeek', glm: 'GLM' };
const ENV_KEY_NAMES = { deepseek: 'DEEPSEEK_API_KEY', glm: 'GLM_API_KEY' };

// 凭证缺失/配置错误：带 code='NO_KEY'，让上层把「没配密钥」与「网络/接口故障」区分开
// （没配密钥 = 该平台标为「未配置」，不刷采集异常告警）
function credentialError(message) {
  const e = new Error(message);
  e.code = 'NO_KEY';
  return e;
}

function validKey(v) { return (typeof v === 'string' && v.trim()) ? v.trim() : null; }

export function readCodexAuth(codexHome) {
  const p = path.join(codexHome, 'auth.json');
  if (!fs.existsSync(p)) {
    // 本机没装 Codex / 从未登录 —— 属于「未配置」，不是采集故障
    throw credentialError(`未找到 Codex 登录凭证（${p}）：本机若不用 Codex，可在 config.json 的 platforms 段把 codex 设为 false`);
  }
  const auth = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (!auth?.tokens?.access_token) throw new Error('codex auth.json 中无 access_token（可能未登录）');
  return { accessToken: auth.tokens.access_token, accountId: auth.tokens.account_id, lastRefresh: auth.last_refresh ?? null };
}

let _thinCoder = null;
function thinCoderConfig(cfgPath) {
  if (!_thinCoder) _thinCoder = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  return _thinCoder;
}

// secrets.json：{"deepseek":"sk-xxx","glm":"xxx"}（已被 .gitignore 排除，不会随仓库公开）
// 解析失败时不把文件内容带进错误信息——原文里可能就是密钥；解析失败也算「未配置」（可读、可自愈）
function secretsFile() {
  if (!fs.existsSync(SECRETS_FILE)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    return (j && typeof j === 'object' && !Array.isArray(j)) ? j : null;
  } catch { throw credentialError('secrets.json 解析失败：不是合法 JSON，请检查文件格式'); }
}

// ThinCoder 配置（向后兼容：装了 ThinCoder 的用户继续免配置）；读不到 / 没有该 provider → null，交给下一路
function thinCoderApiKey(platform, cfgPath) {
  if (!cfgPath || !fs.existsSync(cfgPath)) return null;
  let cfg;
  try { cfg = thinCoderConfig(cfgPath); } catch { return null; }
  return validKey(cfg?.providers?.find(x => x?.name === platform)?.apiKey);
}

// API Key 解析（按优先级）：① 项目根 secrets.json ② ThinCoder 配置 ③ 环境变量 DEEPSEEK_API_KEY / GLM_API_KEY
// 三路都没有 → 抛可读错误（说明去哪儿填密钥）。返回 { key, source }，source 只含来源标签。
export function resolveApiKey(platform, cfg) {
  const cfgPath = typeof cfg === 'string' ? cfg : cfg?.thinCoderConfig; // 兼容旧调用：直接传 ThinCoder 配置路径
  const fromSecrets = validKey(secretsFile()?.[platform]);
  if (fromSecrets) return { key: fromSecrets, source: 'secrets.json' };
  const fromThinCoder = thinCoderApiKey(platform, cfgPath);
  if (fromThinCoder) return { key: fromThinCoder, source: 'ThinCoder 配置' };
  const envName = ENV_KEY_NAMES[platform];
  const fromEnv = validKey(envName ? process.env[envName] : null);
  if (fromEnv) return { key: fromEnv, source: `环境变量 ${envName}` };
  throw credentialError(`${PLATFORM_LABEL[platform] ?? platform} 未配置密钥：请在项目根目录 secrets.json 中填写 {"${platform}":"你的密钥"}${envName ? `，或设置环境变量 ${envName}` : ''}`);
}

// 便捷读取（只要密钥值；需要来源标签时直接用 resolveApiKey）
export function readDeepSeekKey(cfg) { return resolveApiKey('deepseek', cfg).key; }
export function readGlmKey(cfg) { return resolveApiKey('glm', cfg).key; }

// ---- 通用工具 ----

export function nowISO() { return new Date().toISOString(); }

export function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, p);
}

// 追加一行 JSON（趋势历史用），文件不存在则创建
export function appendJsonl(p, obj) {
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}

// 时区固定 UTC+8（用户本地）
const fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
export function fmtLocal(ms) { return fmt.format(new Date(ms)).replace(/\//g, '-'); }

export function humanDuration(seconds) {
  if (seconds <= 0) return '已过期';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    const hh = h % 24;
    return hh ? `${d}天${hh}小时` : `${d}天`;
  }
  return h ? `${h}小时${m}分` : `${m}分钟`;
}

export function isDnd(cfg, d = new Date()) {
  if (!cfg.dnd?.enabled) return false;
  const shanghai = new Date(d.getTime() + 8 * 3600 * 1000); // UTC+8
  const mins = shanghai.getUTCHours() * 60 + shanghai.getUTCMinutes();
  const [fh, fm] = cfg.dnd.from.split(':').map(Number);
  const [th, tm] = cfg.dnd.to.split(':').map(Number);
  const from = fh * 60 + fm, to = th * 60 + tm;
  return from > to ? (mins >= from || mins < to) : (mins >= from && mins < to);
}

// ---- 系统代理自动探测（Codex 走 chatgpt.com 需要代理；config.proxy 优先于探测）----

export function detectSystemProxy() {
  const regPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  try {
    const en = execFileSync('reg', ['query', regPath, '/v', 'ProxyEnable'], { encoding: 'utf8', timeout: 8000 });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(en)) return null;
    const out = execFileSync('reg', ['query', regPath, '/v', 'ProxyServer'], { encoding: 'utf8', timeout: 8000 });
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    if (!m) return null;
    const v = m[1].trim();
    return /^https?:\/\//i.test(v) ? v : `http://${v}`;
  } catch { return null; }
}

// ---- 静音（临时关闭提醒；P0 是否放行由 config.mute.allowP0 决定）----

export function loadMute() {
  const m = readJsonSafe(path.join(DATA_DIR, 'mute.json'));
  if (!m || !m.until) return { active: false, until: null, note: null };
  return { active: m.until > Date.now(), until: m.until, note: m.note ?? null };
}

export function saveMute(untilMs, note) {
  ensureDataDir();
  writeJsonAtomic(path.join(DATA_DIR, 'mute.json'), { until: untilMs, note: note ?? null, setAt: Date.now() });
}

export function clearMute() {
  try { fs.unlinkSync(path.join(DATA_DIR, 'mute.json')); return true; } catch { return false; }
}

// ---- 余额提醒抑制（「不再提醒」直到下次充值）----
// 语义：用户主动点「不再提醒」后，该平台的余额提醒停发；检测到余额回升（充值）→ 自动恢复。

export function loadSuppression() {
  const s = readJsonSafe(path.join(DATA_DIR, 'balance-mute.json'));
  return (s && typeof s === 'object') ? s : {};
}

export function saveSuppression(obj) {
  ensureDataDir();
  writeJsonAtomic(path.join(DATA_DIR, 'balance-mute.json'), obj);
}

export function suppressPlatform(platform, balance, note) {
  const s = loadSuppression();
  s[platform] = { atMs: Date.now(), balanceAt: Number(balance), note: note ?? null };
  saveSuppression(s);
  return s[platform];
}

export function clearSuppression(platform) {
  const s = loadSuppression();
  if (!s[platform]) return false;
  delete s[platform];
  saveSuppression(s);
  return true;
}

// 是否因充值而应自动恢复：余额比抑制时高（充值到账）
export function rechargedSince(suppression, currentBalance) {
  if (!suppression) return false;
  const base = Number(suppression.balanceAt);
  const cur = Number(currentBalance);
  return Number.isFinite(base) && Number.isFinite(cur) && cur > base + 0.01;
}

// ---- 趋势历史读写 ----

// 尾部读取：默认只读文件末尾若干字节（1 分钟粒度下 8MB ≈ 14 天），
// 若窗口未被覆盖再成倍扩大，最坏退化为全量读取。
export function readHistoryRows(name, sinceMs = 0, opts = {}) {
  const p = path.join(DATA_DIR, 'history', `${name}.jsonl`);
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];
    const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
    let readSize = Math.min(size, maxBytes);
    for (;;) {
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, size - readSize);
      let text = buf.toString('utf8');
      if (readSize < size) {
        const nl = text.indexOf('\n'); // 丢弃可能被截断的首行
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      const rows = parseRows(text, sinceMs);
      if (rows.length && rows[0].ts <= sinceMs) return rows; // 已覆盖所需窗口
      if (readSize >= size) return rows;                     // 已读到文件头
      readSize = Math.min(size, readSize * 4);
    }
  } finally { fs.closeSync(fd); }
}

function parseRows(text, sinceMs) {
  const rows = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const o = JSON.parse(l); if (!sinceMs || o.ts >= sinceMs) rows.push(o); } catch { /* 跳过坏行 */ }
  }
  return rows;
}

// 把历史行压缩为 [ts, a, b?] 点序列：codex = [ts, 已用5h%, 已用7d%]，余额 = [ts, 余额]
// 超长时按时间桶降采样，且桶内优先保留"峰值"样本（避免抹平用量峰值）
export function compactSeries(name, rows, max = 400) {
  if (!rows?.length) return [];
  const pickA = r => Number(name === 'codex' ? r.fiveHour?.usedPercent : (name === 'glm' ? r.balance : r.totalBalance));
  const pickB = r => (name === 'codex' ? Number(r.weekly?.usedPercent) : null);
  let list = rows;
  if (rows.length > max) {
    const bucket = Math.ceil(rows.length / max);
    const out = [];
    for (let i = 0; i < rows.length; i += bucket) {
      const chunk = rows.slice(i, i + bucket);
      let best = chunk[chunk.length - 1];
      for (const r of chunk) {
        const a = pickA(r), b = pickA(best);
        if (Number.isFinite(a) && (!Number.isFinite(b) || a > b)) best = r;
      }
      out.push(best);
    }
    list = out;
  }
  return list.map(r => {
    const a = pickA(r), b = pickB(r);
    return Number.isFinite(b) ? [r.ts, a, b] : [r.ts, a];
  });
}

// 分级降采样（永久保留）：按数据年龄套用不同时间桶，越老越粗；不删除数据。
// tiers 例：[{olderThanDays:7,bucketMinutes:5},{olderThanDays:30,bucketMinutes:60}]（顺序无关，代码取最粗的匹配档）
// 返回 { removed, total, kept }
export function applyTiers(name, tiers, nowMs = Date.now()) {
  const p = path.join(DATA_DIR, 'history', `${name}.jsonl`);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return { removed: 0, total: 0, kept: 0 }; }
  // 取「最粗的匹配档」：年龄 ≥ 多个阈值时用最大阈值那一档（越老越粗），因此按阈值降序查找
  const sorted = [...(tiers ?? [])].sort((a, b) => b.olderThanDays - a.olderThanDays);
  const lines = text.split('\n').filter(Boolean);
  const buckets = new Map(); // 旧数据：按 (粒度:桶序号) 归并，同桶保留最新样本
  const raw = [];            // 新数据：原样保留
  let total = 0;
  for (const l of lines) {
    total += 1;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    const ageDays = (nowMs - o.ts) / 86400000;
    const tier = sorted.find(t => ageDays >= t.olderThanDays);
    if (!tier) { raw.push(l); continue; }
    buckets.set(`${tier.bucketMinutes}:${Math.floor(o.ts / (tier.bucketMinutes * 60000))}`, l);
  }
  // 桶内数据必然比 raw 老（按年龄阈值划分），因此 桶在前、raw 在后 = 时间有序
  const kept = [...buckets.values(), ...raw];
  const removed = total - kept.length;
  if (removed < 50) return { removed: 0, total, kept: total };
  fs.writeFileSync(p, kept.length ? kept.join('\n') + '\n' : '');
  return { removed, total, kept: kept.length };
}

// 保留 cutoffMs 之后的行（keepDays>0 时使用），返回删除条数
export function pruneHistory(name, cutoffMs) {
  const p = path.join(DATA_DIR, 'history', `${name}.jsonl`);
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch { return 0; }
  const lines = text.split('\n').filter(Boolean);
  const kept = [];
  for (const l of lines) {
    try { const o = JSON.parse(l); if (o.ts >= cutoffMs) kept.push(l); } catch { /* 丢弃坏行 */ }
  }
  if (kept.length === lines.length) return 0;
  fs.writeFileSync(p, kept.length ? kept.join('\n') + '\n' : '');
  return lines.length - kept.length;
}
