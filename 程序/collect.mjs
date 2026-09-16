// 采集入口：按平台间隔采集 → state.json + history 落盘 → 规则引擎 → toast 通知 → 看板数据
// 分平台调度：Codex 与余额（DeepSeek/GLM）可用不同间隔；未到期的平台沿用上次结果（标记 carried）。
import { ensureDataDir, loadConfig, readJsonSafe, writeJsonAtomic, appendJsonl, nowISO, DATA_DIR, ROOT_DIR, DAY_MS, detectSystemProxy, readHistoryRows, pruneHistory, applyTiers, compactSeries, loadSuppression, saveSuppression, rechargedSince, enabledPlatforms } from './lib/common.mjs';
import { collectCodex } from './collectors/codex.mjs';
import { collectCodexFallback } from './collectors/codex-fallback.mjs';
import { collectDeepSeek } from './collectors/deepseek.mjs';
import { collectGlm } from './collectors/glm.mjs';
import { evaluateRules } from './alert/rules.mjs';
import { notify } from './alert/notify.mjs';
import { buildDashboardData } from './tools/build-dashboard-data.mjs';
import fs from 'node:fs';
import path from 'node:path';

const STATE_FILE = () => `${DATA_DIR}\\state.json`;
const historyFile = (name) => `${DATA_DIR}\\history\\${name}.jsonl`;
const TOLERANCE_MS = 5000; // 计划任务的触发抖动容忍

async function tryCollect(name, fn, cfg) {
  const started = Date.now();
  try {
    const data = await fn(cfg);
    return { ok: true, data, atMs: Date.now(), durationMs: Date.now() - started };
  } catch (e) {
    // 没配密钥（NO_KEY）不是采集故障：标记 unconfigured，不累加健康失败、不发采集异常告警
    const unconfigured = e?.code === 'NO_KEY';
    return { ok: false, ...(unconfigured ? { unconfigured: true } : {}), error: sanitizeError(e), atMs: Date.now(), durationMs: Date.now() - started };
  }
}

// 错误信息净化：任何疑似密钥/token 的内容一律打码（防泄漏到 state/看板/日志）
function sanitizeError(e) {
  let s = String(e?.message ?? e).slice(0, 300);
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***');
  s = s.replace(/eyJ[A-Za-z0-9._-]{20,}/g, '***JWT***');
  s = s.replace(/[0-9a-f]{32}(\.[A-Za-z0-9]+)?/g, '***KEY***'); // 智谱 key 形如 hex.secret
  s = s.replace(/sk-[A-Za-z0-9]+/g, 'sk-***');
  return s;
}

// 是否到期：上次成功采集时间 + 间隔；上次失败则本次立即重试
function isDue(prevRes, intervalMinutes, now) {
  if (!prevRes || !prevRes.atMs) return true;
  if (prevRes.ok === false) return true; // 失败尽快重试，不等间隔
  return now - prevRes.atMs >= intervalMinutes * 60000 - TOLERANCE_MS;
}

export async function runCollection({ notify: doNotify = true, forceAll = false } = {}) {
  ensureDataDir();
  if (fs.existsSync(path.join(DATA_DIR, 'upgrade-transaction.json'))) throw new Error('程序正在升级，请稍后重试采集');
  const cfg = loadConfig();
  const enabled = enabledPlatforms(cfg); // 平台开关（config.platforms 缺省 = 全开）
  if (!cfg.proxy) cfg.proxy = detectSystemProxy(); // 代理端口自动探测（clash 换端口不再中断）
  const prevState = readJsonSafe(STATE_FILE()) ?? {};
  const prevAlertsFile = readJsonSafe(`${DATA_DIR}\\alerts.json`) ?? { fired: [], history: [], state: {} };
  if (!prevAlertsFile.history) prevAlertsFile.history = prevAlertsFile.fired ?? []; // 兼容旧格式回填

  const now = Date.now();
  const codexIv = num(cfg.intervals?.codexMinutes, 5);
  const balanceIv = num(cfg.intervals?.balanceMinutes, 5);
  const prevCur = prevState.current ?? {};
  // 被关闭的平台一律视为「不需要采」：due=false → 不采集、不写历史、不参与规则（state 里由 disabled 占位结果标记）
  const due = {
    codex: enabled.codex && (forceAll || isDue(prevCur.codex, codexIv, now)),
    deepseek: enabled.deepseek && (forceAll || isDue(prevCur.deepseek, balanceIv, now)),
    glm: enabled.glm && (forceAll || isDue(prevCur.glm, balanceIv, now)),
  };

  const [codexRaw, deepseekRes, glmRes] = await Promise.all([
    takeOne('codex', collectCodex, cfg, { on: enabled.codex, due: due.codex, prev: prevCur.codex }),
    takeOne('deepseek', collectDeepSeek, cfg, { on: enabled.deepseek, due: due.deepseek, prev: prevCur.deepseek }),
    takeOne('glm', collectGlm, cfg, { on: enabled.glm, due: due.glm, prev: prevCur.glm }),
  ]);

  // Codex 降级：实时接口失败 → 本地会话文件快照（标记 degraded，看板可见快照延迟）
  let codex = codexRaw;
  if (due.codex && !codexRaw.ok) {
    try {
      const fb = collectCodexFallback(cfg.codexHome);
      codex = { ok: true, degraded: true, error: codexRaw.error, data: fb, atMs: codexRaw.atMs };
    } catch (fbErr) {
      codex = { ok: false, degradedAttempted: true, ...(codexRaw.unconfigured ? { unconfigured: true } : {}), error: `${codexRaw.error} | 降级也失败: ${sanitizeError(fbErr)}`, atMs: codexRaw.atMs };
    }
  }

  const sampled = { codex: due.codex, deepseek: due.deepseek, glm: due.glm };
  // 余额提醒抑制：若某平台在被抑制后余额回升（充值），自动解除
  const suppression = autoClearSuppression({ glm: glmRes, deepseek: deepseekRes }, sampled);
  const state = {
    collectedAt: nowISO(),
    collectedAtMs: now,
    proxy: cfg.proxy ?? null,
    platforms: enabled,   // 生效的平台开关（看板据此把关闭的平台标为「已关闭」）
    sampled,
    intervalMinutes: { codex: codexIv, balance: balanceIv },
    suppression,
    current: { codex, deepseek: deepseekRes, glm: glmRes },
    health: buildHealth(prevState, { codex, deepseek: deepseekRes, glm: glmRes }, sampled),
    health24h: buildHealth24h(prevState.health24h, { codex, deepseek: deepseekRes, glm: glmRes }, sampled, now),
    stats: computeStats(cfg),
  };

  writeJsonAtomic(STATE_FILE(), {
    collectedAt: state.collectedAt, collectedAtMs: state.collectedAtMs, proxy: state.proxy,
    platforms: enabled,
    sampled, intervalMinutes: state.intervalMinutes,
    current: state.current, health: state.health, health24h: state.health24h, stats: state.stats,
    lastMaintenanceAtMs: prevState.lastMaintenanceAtMs ?? 0,
  });

  // 趋势历史：仅记录本轮真实采样的平台（跳采沿用值不写入，避免重复点）
  for (const [name, res] of [['codex', codex], ['deepseek', deepseekRes], ['glm', glmRes]]) {
    if (due[name] && res.ok && !res.carried) appendJsonl(historyFile(name), { ts: now, ...res.data });
  }

  // 规则引擎（只处理本轮采样的平台）
  const alerts = evaluateRules(null, state, cfg, prevAlertsFile.state ?? null);
  alerts.alertState.lastFiredAt = pruneLastFired(alerts.alertState.lastFiredAt, cfg);
  if (alerts.fired.length || alerts.alertState) {
    const history = [...(prevAlertsFile.history ?? []), ...alerts.fired].slice(-200);
    writeJsonAtomic(`${DATA_DIR}\\alerts.json`, { updated: state.collectedAt, fired: alerts.fired, history, state: alerts.alertState });
    if (alerts.fired.length && doNotify) await notify(alerts.fired, cfg);
  }

  // 维护（分层降采样 + 过期清理）：每小时执行一次，避免每分钟重写大文件
  const didMaintain = maintenance(cfg, prevState);
  if (didMaintain) {
    const cur = readJsonSafe(STATE_FILE()) ?? {};
    writeJsonAtomic(STATE_FILE(), { ...cur, lastMaintenanceAtMs: Date.now() });
  }

  writeDashboardData();
  return { state, alerts };
}

// 单平台取数决策：开关关闭 → 关闭占位结果（不采集、不写历史、不参与规则；看板据 disabled 标记展示）；
// 未到期 → 沿用上次（carried）；否则真实采集。
function takeOne(name, collect, cfg, { on, due: isDueNow, prev }) {
  if (!on) return { ok: false, disabled: true, error: `平台已在 config.json 的 platforms 段关闭（${name}）`, atMs: null, carried: false };
  return isDueNow ? tryCollect(name, collect, cfg) : carry(prev);
}

function carry(prev) {
  if (!prev) return { ok: false, error: '暂无历史数据（等待首次采集）', atMs: null, carried: false };
  return { ...prev, carried: true }; // 沿用上次结果（atMs 保持上次真实采集时间）
}

function num(v, dflt) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

// 余额提醒抑制：返回当前生效的抑制表；检测到充值（余额回升）时自动解除并落地
function autoClearSuppression(results, sampled) {
  const sup = loadSuppression();
  let changed = false;
  for (const [platform, key] of [['glm', 'glm'], ['deepseek', 'deepseek']]) {
    const s = sup[platform];
    if (!s) continue;
    const res = results[platform];
    if (sampled[platform] === false || !res?.ok) continue; // 本轮没取到新余额，不判定
    const bal = Number(platform === 'glm' ? res.data?.balance : res.data?.totalBalance);
    if (rechargedSince(s, bal)) {
      delete sup[platform];
      changed = true;
      console.log(`[balance-mute] 检测到 ${platform} 余额回升（¥${Number(s.balanceAt).toFixed(2)} → ¥${bal.toFixed(2)}），已自动恢复余额提醒`);
    }
  }
  if (changed) saveSuppression(sup);
  return sup;
}

// ---- 统计（供规则与看板：闲置判断、消耗速率、触顶预测、异常消耗、健康度）----

function computeStats(cfg) {
  const now = Date.now();
  const codexRows = readHistoryRows('codex', now - 7 * DAY_MS);
  let codexMax5h7d = null;
  for (const r of codexRows) {
    const v = Number(r.fiveHour?.usedPercent);
    if (Number.isFinite(v)) codexMax5h7d = codexMax5h7d == null ? v : Math.max(codexMax5h7d, v);
  }
  return {
    codexMax5h7d,
    codexSamples7d: codexRows.length,
    burn: {
      glm: burnRate('glm', r => Number(r.balance), 3),
      deepseek: burnRate('deepseek', r => Number(r.totalBalance), 3),
    },
    trend: codexTrend(cfg, codexRows),      // 触顶预测
    anomaly: spendAnomaly(now),             // 异常消耗预警
  };
}

// 触顶预测：取近 N 分钟的 5h 用量样本做线性斜率，外推"还剩多少分钟到 100%"
function codexTrend(cfg, rows) {
  const win = (Number(cfg.predict?.slopeWindowMinutes) || 30) * 60000;
  const now = Date.now();
  const pts = rows.filter(r => r.ts >= now - win && Number.isFinite(Number(r.fiveHour?.usedPercent)))
    .map(r => ({ ts: r.ts, v: Number(r.fiveHour.usedPercent) }));
  if (pts.length < 3) return null;
  const used = pts[pts.length - 1].v;
  const spanMin = (pts[pts.length - 1].ts - pts[0].ts) / 60000;
  if (spanMin < 3) return null;
  const slopePerMin = (pts[pts.length - 1].v - pts[0].v) / spanMin; // 百分点/分钟
  if (!(slopePerMin > 0.01)) return { used, slopePerMin: 0, projectedMinutes: null };
  return { used, slopePerMin: Number(slopePerMin.toFixed(3)), projectedMinutes: Math.round((100 - used) / slopePerMin) };
}

// 异常消耗：当日消耗 vs 近 7 日日均（按 UTC+8 日期切分，用历史余额下降段求和）
function spendAnomaly(now) {
  const out = {};
  for (const [name, pick] of [['deepseek', r => Number(r.totalBalance)], ['glm', r => Number(r.balance)]]) {
    const rows = readHistoryRows(name, now - 8 * DAY_MS);
    if (rows.length < 10) continue;
    const byDay = new Map();
    for (const r of rows) {
      const k = new Date(r.ts + 8 * 3600e3).toISOString().slice(0, 10);
      const list = byDay.get(k) ?? [];
      list.push({ ts: r.ts, v: pick(r) });
      byDay.set(k, list);
    }
    const todayKey = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
    const spendOf = list => {
      let s = 0;
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1].v, b = list[i].v;
        if (Number.isFinite(a) && Number.isFinite(b) && b < a) s += a - b;
      }
      return s;
    };
    const days = [...byDay.keys()].sort();
    const today = days.includes(todayKey) ? spendOf(byDay.get(todayKey)) : 0;
    const history = days.filter(d => d !== todayKey).map(d => spendOf(byDay.get(d)));
    if (!history.length) continue;
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    out[name] = { today: Number(today.toFixed(2)), mean: Number(mean.toFixed(2)), ratio: mean > 0 ? Number((today / mean).toFixed(2)) : null };
  }
  return out;
}

// 健康度（近 24 小时的采集成功率与耗时）
function buildHealth24h(prev, results, sampled, now) {
  const keepMs = 24 * 3600 * 1000;
  const base = (prev && now - (prev.startedAtMs ?? 0) < keepMs)
    ? prev
    : { startedAtMs: now, platforms: {} };
  const platforms = { ...(base.platforms ?? {}) };
  for (const name of ['codex', 'deepseek', 'glm']) {
    const res = results[name];
    // 未采样的轮次不计入；已关闭 / 未配置密钥的平台也不计入（它们不是失败）
    if (sampled[name] === false || res.disabled === true || res.unconfigured === true) continue;
    const p = platforms[name] ?? { ok: 0, fail: 0, ms: 0, runs: 0 };
    p.runs += 1;
    if (res.ok) p.ok += 1; else p.fail += 1;
    p.ms += Number(res.durationMs) || 0;
    platforms[name] = p;
  }
  return { startedAtMs: base.startedAtMs, platforms };
}

// 消耗速率：只累加"下降段"（充值导致的跃升不计入），单位 ¥/天
function burnRate(name, pick, days) {
  const now = Date.now();
  const rows = readHistoryRows(name, now - days * DAY_MS);
  if (rows.length < 2) return null;
  let spent = 0;
  for (let i = 1; i < rows.length; i++) {
    const a = pick(rows[i - 1]), b = pick(rows[i]);
    if (Number.isFinite(a) && Number.isFinite(b) && b < a) spent += a - b;
  }
  const spanDays = Math.max((rows[rows.length - 1].ts - rows[0].ts) / DAY_MS, 1 / 24);
  return { perDay: Number((spent / spanDays).toFixed(3)), spent: Number(spent.toFixed(2)), samples: rows.length, spanDays: Number(spanDays.toFixed(2)) };
}

// ---- 维护 ----

function pruneLastFired(lastFiredAt, cfg) {
  const keepMs = num(cfg.history?.stateKeepDays, 7) * DAY_MS;
  const cutoff = Date.now() - keepMs;
  const out = {};
  for (const [k, ts] of Object.entries(lastFiredAt ?? {})) if (ts >= cutoff) out[k] = ts;
  return out;
}

function maintenance(cfg, prevState) {
  const now = Date.now();
  const last = Number(prevState.lastMaintenanceAtMs ?? 0);
  if (now - last < 3600 * 1000) return false;

  const tiers = cfg.history?.tiers ?? [];
  const keepDays = num(cfg.history?.keepDays, 0);

  for (const name of ['codex', 'deepseek', 'glm']) {
    try {
      const r = applyTiers(name, tiers, now); // 分级降采样（永久保留，不删除）
      if (r.removed) console.log(`[maintenance] ${name}: 降采样合并 ${r.removed} 行（${r.total} → ${r.kept}）`);
      if (keepDays > 0) pruneHistory(name, now - keepDays * DAY_MS); // 仅在显式配置保留期时才删除
    } catch (e) {
      console.error(`[maintenance] ${name} 失败:`, String(e.message ?? e).slice(0, 120));
    }
  }
  try { buildSeriesCache(now); } catch (e) { console.error('[maintenance] 长周期序列缓存失败:', String(e.message ?? e).slice(0, 120)); }
  if (cfg.attribution?.enabled !== false) {
    // 归因分析较慢（要扫描会话文件），放到每小时维护里，不阻塞每分钟的采集
    import('./tools/attribution.mjs')
      .then(m => m.buildAttribution(cfg))
      .then(r => console.log(`[maintenance] 额度归因：扫描 ${r.scannedFiles} 个会话文件，近 7 天 ${(r.total7 / 1e6).toFixed(1)}M tokens`))
      .catch(e => console.error('[maintenance] 额度归因失败:', String(e.message ?? e).slice(0, 120)));
  }
  rotateLog(5 * 1024 * 1024); // 采集日志超过 5MB 时轮转（1 分钟粒度下必要）
  return true;
}

// 长周期序列缓存：把 30 天 / 全部 两个窗口的降采样序列 + 按日聚合写成小文件，
// 让每分钟的看板数据注入无需读取完整历史。
function buildSeriesCache(now) {
  const out = { generatedAtMs: now };
  for (const name of ['codex', 'deepseek', 'glm']) {
    const rows = readHistoryRows(name, 0); // 全量（分级降采样后体积有界）
    out[name] = {
      d30: compactSeries(name, rows.filter(r => r.ts >= now - 30 * DAY_MS), 500),
      all: compactSeries(name, rows, 500),
      daily: buildDaily(rows, name),
    };
  }
  writeJsonAtomic(path.join(DATA_DIR, 'series-cache.json'), out);
  return out;
}

// 按日聚合（本地 UTC+8 日期）：
//   codex           → max5h 当日 5h 窗口用量峰值 / avg5h 均值 / max7d 周窗口峰值 / n 采样数
//   deepseek, glm   → spend 当日消耗金额（余额下降段之和）/ first,last 当日首末余额 / n 采样数
function buildDaily(rows, name) {
  const days = {};
  const key = ts => new Date(ts + 8 * 3600e3).toISOString().slice(0, 10);
  let prevBal = null;
  for (const r of rows) {
    const k = key(r.ts);
    const d = days[k] ?? (days[k] = { n: 0 });
    d.n += 1;
    if (name === 'codex') {
      const u = Number(r.fiveHour?.usedPercent), w = Number(r.weekly?.usedPercent);
      if (Number.isFinite(u)) {
        d.max5h = Math.max(d.max5h ?? 0, u);
        d.sum5h = (d.sum5h ?? 0) + u;
        d.n5h = (d.n5h ?? 0) + 1;
      }
      if (Number.isFinite(w)) d.max7d = Math.max(d.max7d ?? 0, w);
    } else {
      const b = Number(name === 'glm' ? r.balance : r.totalBalance);
      if (Number.isFinite(b)) {
        if (d.first == null) d.first = b;
        d.last = b;
        if (prevBal != null && b < prevBal) d.spend = Number(((d.spend ?? 0) + (prevBal - b)).toFixed(4));
        prevBal = b;
      }
    }
  }
  const out = {};
  for (const [k, d] of Object.entries(days)) {
    out[k] = {
      n: d.n,
      ...(d.n5h ? { max5h: Math.round(d.max5h), avg5h: Math.round((d.sum5h / d.n5h) * 10) / 10, max7d: Math.round(d.max7d ?? 0) } : {}),
      ...(d.last != null ? { spend: d.spend ?? 0, first: Number(d.first.toFixed(2)), last: Number(d.last.toFixed(2)) } : {}),
    };
  }
  return out;
}

// 日志轮转：collect.log → collect.log.1（覆盖旧档），保持可读且不无限增长
function rotateLog(maxBytes) {
  const p = path.join(DATA_DIR, 'collect.log');
  try {
    if (fs.statSync(p).size < maxBytes) return;
    fs.renameSync(p, `${p}.1`);
  } catch { /* 文件不存在或正被写入，忽略 */ }
}

// ---- 看板数据注入 ----

function writeDashboardData() {
  try {
    fs.writeFileSync(path.join(ROOT_DIR, 'dashboard-data.js'), buildDashboardData());
  } catch (e) {
    console.error('[dashboard] 数据注入生成失败:', e.message);
  }
}

function buildHealth(prevState, results, sampled) {
  const prev = prevState.health ?? {};
  const consecutiveFailures = {};
  const lastErrors = {};
  for (const name of ['codex', 'deepseek', 'glm']) {
    const res = results[name];
    if (sampled[name] === false) { // 本轮未采样：沿用上次健康状态
      consecutiveFailures[name] = prev.consecutiveFailures?.[name] ?? 0;
      lastErrors[name] = prev.lastErrors?.[name] ?? null;
      continue;
    }
    if (res.disabled === true || res.unconfigured === true) { // 已关闭 / 未配置密钥：不计失败、不留错误
      consecutiveFailures[name] = 0;
      lastErrors[name] = null;
      continue;
    }
    const ok = res.ok;
    consecutiveFailures[name] = ok ? 0 : ((prev.consecutiveFailures?.[name] ?? 0) + 1);
    lastErrors[name] = ok ? null : res.error ?? 'unknown';
  }
  const lastOkAt = {};
  for (const name of ['codex', 'deepseek', 'glm']) {
    lastOkAt[name] = results[name].ok ? (results[name].atMs ?? Date.now()) : (prev.lastOkAt?.[name] ?? null);
  }
  return { consecutiveFailures, lastErrors, lastOkAt };
}

// CLI 直接运行（--all 忽略间隔，强制采集全部平台）
if (process.argv[1] && process.argv[1].endsWith('collect.mjs')) {
  runCollection({ forceAll: process.argv.includes('--all') })
    .then(({ state, alerts }) => {
      const c = state.current;
      const line = (r, f) => r.ok
        ? `${r.carried ? '· 沿用' : '✓'} ${f(r.data)}`
        : r.disabled ? '⏸ 已关闭（config.json → platforms）'
        : r.unconfigured ? `∅ 未配置：${r.error?.slice(0, 80)}`
        : `✗ ${r.error?.slice(0, 80)}`;
      const off = Object.entries(state.platforms ?? {}).filter(([, v]) => !v).map(([k]) => k);
      console.log(`采集完成 ${state.collectedAt}（网络: ${state.proxy ?? '直连'} · 间隔: Codex ${state.intervalMinutes.codex}min / 余额 ${state.intervalMinutes.balance}min${off.length ? ` · 已关闭: ${off.join('/')}` : ''}）`);
      console.log(line(c.codex, d => `Codex  5h=${d.fiveHour.usedPercent}% 周=${d.weekly.usedPercent}%${d.limitReached ? ' [限流]' : ''}`));
      console.log(line(c.deepseek, d => `DeepSeek ¥${d.totalBalance.toFixed(2)}`));
      console.log(line(c.glm, d => `GLM    ¥${Number(d.balance).toFixed(2)}`));
      const burn = state.stats?.burn ?? {};
      if (burn.glm?.perDay) console.log(`消耗速率：GLM ¥${burn.glm.perDay}/天 · DeepSeek ¥${(burn.deepseek?.perDay ?? 0)}/天`);
      console.log(`提醒: ${alerts.fired.length ? alerts.fired.map(a => `${a.level} ${a.title}`).join(' | ') : '无'}`);
    })
    .catch(e => { console.error('采集流程异常:', e); process.exit(1); });
}
