// 额度去向归因：解析本地 Codex 会话文件（~/.codex/sessions/**/rollout-*.jsonl），
// 按「项目目录」聚合 token 用量——回答"额度被谁吃掉了"。这是官方页面给不了的信息。
//
// 数据来源：
//   · turn_context 记录的 cwd  → 该轮属于哪个项目（会话中途切目录也能正确归属）
//   · event_msg / token_count 的 info.last_token_usage.total_tokens → 该轮实际消耗
//
// **增量扫描**：会话文件是只追加的。每个文件缓存 {大小, 已消费字节偏移, 按日聚合}，
// 下次只读新增的尾巴（文件没变大就完全不读）。首次全量约 2 秒 / 895MB，之后每小时的
// 维护几乎零 IO——只有正在写入的那个会话文件会被读几十 KB。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DAY_MS, ensureDataDir, writeJsonAtomic } from '../lib/common.mjs';

const CACHE_FILE = () => path.join(DATA_DIR, 'attribution-cache.json');
const CACHE_VERSION = 5;   // v5：权限/沙箱字段可能是对象需归一；v4 加使用方式画像，v3 加模型 first，v2 加按模型聚合

// 一行里只要不含这些关键字，就不可能是我需要的事件类型，直接跳过 JSON.parse
const HINTS = ['"turn_context"', '"session_meta"', '"token_count"'];

function listFiles(root, filter, maxDepth = 4) {
  const out = [];
  (function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (filter(e.name)) out.push(p);
    }
  })(root, 0);
  return out;
}

// 项目名：取目录名；Codex 云端项目目录是一串 hash，标注为「ChatGPT 云端项目」
function projectName(cwd) {
  if (!cwd) return '（未知）';
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
  if (cwd.includes('.chatgpt-projects')) return `ChatGPT 云端项目 ${base.slice(0, 10)}`;
  return base;
}

const dayKey = ts => new Date(ts + 8 * 3600e3).toISOString().slice(0, 10); // 本地 UTC+8 日期

// 从字节偏移处增量读取，按行解析；返回新的偏移与命中数
async function readFrom(file, init) {
  const st = fs.statSync(file);
  let offset = init?.offset ?? 0;
  let cwd = init?.cwd ?? null;
  let model = init?.model ?? null;
  const byDay = init?.byDay ?? {};
  const byModel = init?.byModel ?? {};
  const byPolicy = init?.byPolicy ?? { approval: {}, sandbox: {}, effort: {}, turns: 0 };
  byPolicy.approval = byPolicy.approval ?? {};
  byPolicy.sandbox = byPolicy.sandbox ?? {};
  byPolicy.effort = byPolicy.effort ?? {};
  let firstTs = init?.firstTs ?? 0, lastTs = init?.lastTs ?? 0, hits = 0;

  // 文件被重写/截断（大小反而变小）→ 从头再来
  if (st.size < offset) {
    offset = 0;
    for (const k of Object.keys(byDay)) delete byDay[k];
    for (const k of Object.keys(byModel)) delete byModel[k];
    byPolicy.approval = {}; byPolicy.sandbox = {}; byPolicy.effort = {}; byPolicy.turns = 0;
  }

  if (st.size > offset) {
    const stream = fs.createReadStream(file, { start: offset });
    let buf = '';
    let bytes = offset;
    const handleLine = line => {
      if (!line || line[0] !== '{') return;
      if (!HINTS.some(h => line.includes(h))) return;
      let o;
      try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'turn_context') {
        cwd = o.payload?.cwd ?? cwd;
        model = o.payload?.model ?? model;     // 模型随会话推进可能切换，以最近一轮为准
        // 使用方式画像：每一轮都记一次权限模式与沙箱策略（回答"我怎么用它"）
        const p = o.payload ?? {};
        const ap = p.approval_policy;
        const sb = p.sandbox_policy;
        const ef = p.effort ?? p.collaboration_mode?.settings?.reasoning_effort ?? null;
        // 个别版本里这两个字段是对象而非字符串，统一取可读值，避免出现 "[object Object]" 这种键
        const apKey = typeof ap === 'string' ? ap : (ap?.type ?? ap?.id ?? '(未知)');
        const sbKey = typeof sb === 'string' ? sb : (sb?.type ?? '(未知)');
        byPolicy.approval[apKey] = (byPolicy.approval[apKey] ?? 0) + 1;
        byPolicy.sandbox[sbKey] = (byPolicy.sandbox[sbKey] ?? 0) + 1;
        if (ef) byPolicy.effort[String(ef)] = (byPolicy.effort[String(ef)] ?? 0) + 1;
        byPolicy.turns += 1;
        return;
      }
      if (o.type === 'session_meta') { if (!cwd) cwd = o.payload?.cwd ?? null; return; }
      if (o.type !== 'event_msg' || o.payload?.type !== 'token_count') return;
      const tokens = Number(o.payload?.info?.last_token_usage?.total_tokens) || 0;
      if (tokens <= 0) return;
      const ts = Date.parse(o.timestamp);
      if (!Number.isFinite(ts)) return;
      const k = dayKey(ts);
      const d = byDay[k] ?? (byDay[k] = { t: 0, n: 0 });
      d.t += tokens; d.n += 1;
      const mk = model ?? '（未记录）';
      const mo = byModel[mk] ?? (byModel[mk] = { t: 0, n: 0, first: 0, last: 0 });
      mo.t += tokens; mo.n += 1;
      if (!mo.first || ts < mo.first) mo.first = ts;
      if (ts > mo.last) mo.last = ts;
      if (!firstTs || ts < firstTs) firstTs = ts;
      if (ts > lastTs) lastTs = ts;
      hits += 1;
    };
    for await (const chunk of stream) {
      bytes += chunk.length;
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
    }
    // 末尾若是半行，偏移停在这半行之前，下次从整行处继续
    offset = bytes - Buffer.byteLength(buf, 'utf8');
  }
  return { size: st.size, mtimeMs: st.mtimeMs, offset, cwd, model, byDay, byModel, byPolicy, firstTs, lastTs, hits };
}

export async function buildAttribution(cfg) {
  const root = path.join(cfg.codexHome, 'sessions');
  const now = Date.now();
  const cutoffs = { d7: dayKey(now - 7 * DAY_MS), d30: dayKey(now - 30 * DAY_MS) };

  const cache = (() => {
    try {
      const c = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8'));
      if (c.version === CACHE_VERSION && c.files) return c;
    } catch { /* 首次或缓存损坏 */ }
    return { version: CACHE_VERSION, files: {} };
  })();

  const files = listFiles(root, n => n.endsWith('.jsonl'));
  const acc = new Map();      // 项目名 → 聚合
  const models = new Map();   // 模型 → 聚合（含模型×项目交叉）
  const style = { approval: {}, sandbox: {}, effort: {}, turns: 0 };   // 使用方式画像
  const nextFiles = {};
  let scanned = 0, reused = 0, readBytes = 0, skipped = 0;
  const maxBytes = (Number(cfg.attribution?.maxFileMB) || 1024) * 1024 * 1024;
  const t0 = Date.now();

  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { skipped += 1; continue; }
    if (st.size > maxBytes) { skipped += 1; continue; }

    const prev = cache.files[f];
    let rec;
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      rec = prev; reused += 1;                       // 文件没动 → 一个字节都不用读
    } else {
      try {
        rec = await readFrom(f, prev);
        rec.readBytes = Math.max(0, (rec.offset - (prev?.offset ?? 0)));
        readBytes += rec.readBytes;
        scanned += 1;
      } catch { skipped += 1; continue; }
    }
    nextFiles[f] = rec;

    const key = projectName(rec.cwd);
    const p = acc.get(key) ?? {
      project: key, cwd: rec.cwd, tokens7: 0, tokens30: 0, tokensAll: 0,
      turns7: 0, turns30: 0, turnsAll: 0, firstTs: rec.firstTs || now, lastTs: rec.lastTs || 0, sessions: 0,
    };
    for (const [day, v] of Object.entries(rec.byDay ?? {})) {
      p.tokensAll += v.t; p.turnsAll += v.n;
      if (day >= cutoffs.d30) { p.tokens30 += v.t; p.turns30 += v.n; }
      if (day >= cutoffs.d7) { p.tokens7 += v.t; p.turns7 += v.n; }
    }
    if (rec.firstTs && rec.firstTs < p.firstTs) p.firstTs = rec.firstTs;
    if (rec.lastTs && rec.lastTs > p.lastTs) p.lastTs = rec.lastTs;
    p.sessions += 1;
    acc.set(key, p);

    // 模型聚合：全局 + 模型×项目（每个会话文件归属一个项目，可直接交叉）
    for (const [mk, mv] of Object.entries(rec.byModel ?? {})) {
      const g = models.get(mk) ?? (models.set(mk, { model: mk, turns: 0, tokens: 0, firstMs: 0, lastMs: 0, projects: new Map() }), models.get(mk));
      g.turns += mv.n; g.tokens += mv.t;
      if (mv.first && (!g.firstMs || mv.first < g.firstMs)) g.firstMs = mv.first;
      if (mv.last && (!g.lastMs || mv.last > g.lastMs)) g.lastMs = mv.last;
      g.projects.set(key, (g.projects.get(key) ?? 0) + mv.n);
    }

    // 使用方式画像：权限模式 / 沙箱策略 / 推理强度（每一轮记一次）
    const pol = rec.byPolicy ?? {};
    for (const dim of ['approval', 'sandbox', 'effort']) {
      for (const [k, v] of Object.entries(pol[dim] ?? {})) style[dim][k] = (style[dim][k] ?? 0) + v;
    }
    style.turns += pol.turns ?? 0;
  }

  writeJsonAtomic(CACHE_FILE(), { version: CACHE_VERSION, generatedAtMs: now, files: nextFiles });

  const tc = buildThinCoderIndex();
  const list = mergeProjectRows([...acc.values()], tc.projects, now);
  const codexRows = list.filter(p => p.hasCodex);
  const sumTokens = k => codexRows.reduce((s, x) => s + (x[k] ?? 0), 0);   // token 合计只算有 Codex 归因的行

  const out = {
    generatedAtMs: now,
    scanMs: Date.now() - t0,
    scannedFiles: scanned,
    reusedFiles: reused,
    skippedFiles: skipped,
    readMB: Number((readBytes / 1048576).toFixed(2)),
    thinCoderProjectCount: tc.projects.length,
    codexProjectCount: codexRows.length,
    thinCoderOnlyProjectCount: list.length - codexRows.length,
    total7: sumTokens('tokens7'),
    total30: sumTokens('tokens30'),
    totalAll: sumTokens('tokensAll'),
    projects: list,
    thinCoder: tc,
    // 模型使用画像：接口能给的只是"哪些可用"，这里回答"实际在用哪个、用在哪、什么时候换的"
    models: [...models.values()]
      .map(m => ({
        model: m.model, turns: m.turns, tokens: m.tokens, firstMs: m.firstMs, lastMs: m.lastMs,
        topProjects: [...m.projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([project, turns]) => ({ project, turns })),
        projectCount: m.projects.size,
      }))
      .sort((a, b) => b.turns - a.turns),
    // 使用方式画像：你实际是怎么用它的（放权程度 / 沙箱策略 / 推理强度 / 单轮任务规模）
    usageStyle: {
      ...style,
      avgTokensPerTurn: style.turns > 0 ? Math.round(sumTokens('tokensAll') / Math.max(1, codexRows.reduce((s, x) => s + (x.turnsAll ?? 0), 0))) : null,
    },
    coverage: {
      fromMs: list.reduce((m, x) => Math.min(m, x.firstTs), now),
      toMs: list.reduce((m, x) => Math.max(m, x.lastTs), 0),
    },
  };
  ensureDataDir();
  writeJsonAtomic(path.join(DATA_DIR, 'attribution.json'), out);
  return out;
}

// 「额度去向」表的行集合 = （有 Codex 会话的项目）∪（有 ThinCoder 会话的项目），按 cwd 匹配
// （Windows 路径大小写不敏感；Codex 行按目录名归并，cwd 是唯一可靠的连接键）。
//
// 为什么要有并集：只用 ThinCoder、没用 Codex 的项目此前在这张表里完全看不见——表是按 Codex 会话
// 目录生成行的，ThinCoder 索引只给已有的行"贴"一个会话数，从不用来产生行（2026-09-20 用户报的就是这个）。
//
// 只有 ThinCoder 的行**没有 Codex token 数据**：token / 轮次一律 null，不是 0——
// 0 会被读成"用了但为零"，而事实是"本机没有它的 token 记录"（看板把 null 渲染成「—」）。
//
// 排序：有 Codex 的行在前（按 token 用量降序），只有 ThinCoder 的行排在其后（按会话数降序、再按最近使用）。
// 理由：这些行 token 为 0，混排会永远沉底且彼此无次序；看板默认按用量排且是稳定排序，因此会保留这个次序。
export function mergeProjectRows(codexRows, tcProjects, now = Date.now()) {
  // 没有 cwd 的 ThinCoder 记录（只有 manifest、正文文件缺失）定位不到项目目录 → 不进这张表；
  // 它们仍在「ThinCoder 项目」表里，那里对该情形有专门说明。
  const tcByCwd = new Map();
  for (const t of tcProjects ?? []) {
    if (!t?.cwd) continue;
    const k = t.cwd.toLowerCase();
    if (!tcByCwd.has(k)) tcByCwd.set(k, t);
  }
  const used = new Set();
  const rows = (codexRows ?? []).map(r => {
    const t = tcByCwd.get((r.cwd ?? '').toLowerCase());
    if (t) used.add(t.cwd.toLowerCase());
    return {
      ...r,
      hasCodex: true,
      thinCoderSessions: t?.sessions ?? 0,
      // 会话数也按窗口给一份：行集合要跟着「近 7 天 / 近 30 天 / 全部」变，得知道窗口内有没有用过
      thinCoderSessions7: t?.sessions7 ?? 0,
      thinCoderSessions30: t?.sessions30 ?? 0,
      thinCoderLastMs: t?.lastMs ?? null,
    };
  });
  for (const t of tcByCwd.values()) {
    if (used.has(t.cwd.toLowerCase())) continue;
    rows.push({
      project: t.project, cwd: t.cwd, hasCodex: false,
      tokens7: null, tokens30: null, tokensAll: null,
      turns7: null, turns30: null, turnsAll: null,
      sessions: 0, firstTs: t.firstMs || now, lastTs: t.lastMs || 0,
      thinCoderSessions: t.sessions, thinCoderSessions7: t.sessions7,
      thinCoderSessions30: t.sessions30, thinCoderLastMs: t.lastMs,
    });
  }
  const withCodex = rows.filter(r => r.hasCodex).sort((a, b) => (b.tokensAll ?? 0) - (a.tokensAll ?? 0));
  const tcOnly = rows.filter(r => !r.hasCodex)
    .sort((a, b) => (b.thinCoderSessions - a.thinCoderSessions) || (b.lastTs - a.lastTs));
  return [...withCodex, ...tcOnly];
}

// ThinCoder 项目索引：会话文件头部即 `{"version":2,"cwd":"..."}`，manifest 里有每个槽位的
// 消息数/轮次。两者按 hash 关联后按项目目录聚合——回答"哪些项目用过 ThinCoder、用得多不多"。
// 与 Codex 归因同理，按 7 天 / 30 天 / 全部 三档聚合（以会话自身的 updatedAt 归档）。
export function buildThinCoderIndex() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const dir = path.join(home, '.thincoder', 'sessions');
  const empty = { projects: [], totalSessions: 0, total7: 0, total30: 0, totalAll: 0, sessionDir: dir };
  if (!fs.existsSync(dir)) return empty;

  const byHash = new Map(); // hash -> { cwd, slots: [{ts, messages, turns}], lastMs }
  const readHead = full => {
    try {
      const fd = fs.openSync(full, 'r');
      const buf = Buffer.alloc(600);
      const n = fs.readSync(fd, buf, 0, 600, 0);
      fs.closeSync(fd);
      return buf.subarray(0, n).toString('utf8');
    } catch { return ''; }
  };
  const jsonHead = full => {
    const head = readHead(full);
    const i = head.indexOf('"history"');
    const trimmed = i > 0 ? head.slice(0, i).replace(/,\s*$/, '') + '}' : head;
    try { return JSON.parse(trimmed); } catch { return null; }
  };

  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^([0-9a-f]{40})\.json\.(\d+|manifest)$/);
    if (!m) continue;
    const [, hash, slot] = m;
    const full = path.join(dir, f);
    const rec = byHash.get(hash) ?? { cwd: '', lastMs: 0, slots: [] };
    try {
      if (slot === 'manifest') {
        // 一个 hash 可以有多个槽位，每个槽位是一次独立会话 —— 逐槽位记录，口径才准
        const j = JSON.parse(fs.readFileSync(full, 'utf8'));
        rec.slots = rec.slots.filter(s => !s.provisional);   // manifest 是权威来源，弃掉先前的兜底记录
        for (const s of Object.values(j.slots ?? {})) {
          const ts = Number(s.updatedAt ?? s.ts) || 0;
          rec.slots.push({ ts, messages: Number(s.messageCount) || 0, turns: Number(s.turnCount) || 0 });
          rec.lastMs = Math.max(rec.lastMs, ts);
        }
      } else {
        const j = jsonHead(full);
        if (j) {
          if (j.cwd) rec.cwd = j.cwd;                                    // 取该 hash 最近写入的 cwd
          rec.lastMs = Math.max(rec.lastMs, Number(j.updatedAt) || 0);
          // 兜底：manifest 缺失时至少算一次会话（provisional 记录在读到 manifest 后被丢弃）
          if (!rec.slots.length) rec.slots.push({ ts: Number(j.updatedAt) || 0, messages: 0, turns: 0, provisional: true });
        }
      }
    } catch { /* 跳过读不到的文件 */ }
    byHash.set(hash, rec);
  }

  const now = Date.now();
  const d7 = now - 7 * DAY_MS, d30 = now - 30 * DAY_MS;
  const acc = new Map(); // cwd(小写) -> 聚合
  for (const rec of byHash.values()) {
    const cwd = rec.cwd || '';
    if (/\\AppData\\Local\\Temp\\/i.test(cwd)) continue;   // 排除 thincoder 自检产生的临时探针目录
    const key = cwd.toLowerCase() || '(unknown)';
    const p = acc.get(key) ?? {
      cwd, project: cwd ? projectName(cwd) : '（无路径记录）', unknown: !cwd,
      sessions: 0, sessions7: 0, sessions30: 0,
      turns: 0, turns7: 0, turns30: 0,
      messages: 0, lastMs: 0, firstMs: 0,
    };
    for (const s of rec.slots.length ? rec.slots : [{ ts: rec.lastMs, messages: 0, turns: 0 }]) {
      p.sessions += 1;
      p.turns += s.turns;
      p.messages += s.messages;
      if (s.ts >= d7) { p.sessions7 += 1; p.turns7 += s.turns; }
      if (s.ts >= d30) { p.sessions30 += 1; p.turns30 += s.turns; }
      if (s.ts && (!p.firstMs || s.ts < p.firstMs)) p.firstMs = s.ts;
    }
    p.lastMs = Math.max(p.lastMs, rec.lastMs);
    acc.set(key, p);
  }

  const projects = [...acc.values()].sort((a, b) => b.lastMs - a.lastMs);
  return {
    projects,
    scannedFiles: fs.readdirSync(dir).length,
    sessionDir: dir,
    totalSessions: projects.reduce((s, p) => s + p.sessions, 0),
    total7: projects.reduce((s, p) => s + p.sessions7, 0),
    total30: projects.reduce((s, p) => s + p.sessions30, 0),
    totalAll: projects.reduce((s, p) => s + p.sessions, 0),
  };
}

// CLI：node 程序/tools/attribution.mjs [--rebuild]
if (process.argv[1] && process.argv[1].endsWith('attribution.mjs')) {
  const { loadConfig } = await import('../lib/common.mjs');
  if (process.argv.includes('--rebuild')) { fs.rmSync(CACHE_FILE(), { force: true }); console.log('已清空增量缓存，将全量重建'); }
  const out = await buildAttribution(loadConfig());
  const M = t => `${(t / 1e6).toFixed(1)}M`;
  console.log(`本次：复用 ${out.reusedFiles} 个未变文件 · 实读 ${out.scannedFiles} 个（${out.readMB}MB）· 跳过 ${out.skippedFiles} · 耗时 ${(out.scanMs / 1000).toFixed(2)}s`);
  console.log(`近 7 天 ${M(out.total7)} · 近 30 天 ${M(out.total30)} · 全部 ${M(out.totalAll)} tokens`);
  console.log(`\nThinCoder：${out.thinCoder.projects.length} 个项目 / ${out.thinCoder.totalAll} 个会话（近 7 天 ${out.thinCoder.total7} · 近 30 天 ${out.thinCoder.total30}）`);
  console.log(`额度去向表：${out.projects.length} 行 = 有 Codex 的 ${out.codexProjectCount} 个 + 只有 ThinCoder 的 ${out.thinCoderOnlyProjectCount} 个`);
  console.log('\n模型使用画像:');
  const tot = out.models.reduce((s, m) => s + m.turns, 0);
  for (const m of out.models) {
    const top = m.topProjects[0];
    console.log(`  ${m.model.padEnd(18)} ${String(m.turns).padStart(5)} 轮 ${(m.tokens / 1e6).toFixed(1).padStart(7)}M ${(m.turns / tot * 100).toFixed(1).padStart(5)}%  最近 ${new Date(m.lastMs).toLocaleDateString('zh-CN')}  主要用在 ${top ? top.project : '—'}`);
  }
  const fmtRow = p => `${p.project.padEnd(30)} ${(p.tokensAll == null ? '—' : M(p.tokensAll)).padStart(8)} · ${String(p.turnsAll ?? '—').padStart(4)} 轮${p.thinCoderSessions ? ` · TC ${p.thinCoderSessions}（7 天 ${p.thinCoderSessions7} · 30 天 ${p.thinCoderSessions30}）` : ''}`;
  console.log('\n额度去向（前 8 行）:');
  for (const p of out.projects.slice(0, 8)) console.log(`  ${fmtRow(p)}`);
  const tcOnly = out.projects.filter(p => !p.hasCodex);
  console.log(`\n只有 ThinCoder 的行（${tcOnly.length} 个，表内排在 Codex 行之后）:`);
  for (const p of tcOnly) console.log(`  ${fmtRow(p)}`);
}
