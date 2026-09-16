// 生成看板数据注入文件 dashboard-data.js（避免 file:// CORS，看板以 <script> 引入）
// 数据只含展示字段，绝不含密钥/token
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DAY_MS, ensureDataDir, fmtLocal, humanDuration, loadMute, loadConfig, loadSuppression, compactSeries, readHistoryRows } from '../lib/common.mjs';

export function buildDashboardData() {
  ensureDataDir();
  const state = safeJson(`${DATA_DIR}\\state.json`) ?? { current: {} };
  const alerts = safeJson(`${DATA_DIR}\\alerts.json`) ?? { fired: [], state: {} };
  const cache = safeJson(`${DATA_DIR}\\series-cache.json`) ?? {}; // 长周期序列 + 按日聚合（每小时维护生成）
  const cfg = loadConfig();
  const now = Date.now();
  const mute = loadMute();
  const stats = state.stats ?? {};

  const out = {
    generatedAtMs: now,
    collectedAtMs: state.collectedAtMs ?? null,
    collectedAtText: state.collectedAtMs ? fmtLocal(state.collectedAtMs) : null,
    health: state.health ?? null,
    mute: { active: mute.active, until: mute.until, untilText: mute.until ? fmtLocal(mute.until) : null, note: mute.note ?? null },
    suppression: loadSuppression(),
    config: {
      refreshSeconds: cfg.dashboard?.refreshSeconds ?? 60,
      defaultWindow: cfg.dashboard?.defaultWindow ?? 'h24',
      theme: cfg.dashboard?.theme ?? 'auto',
      staleMinutes: cfg.staleMinutes ?? 15,
    },
    thresholds: {
      glmLow: cfg.thresholds?.glmLow ?? 5, glmCritical: cfg.thresholds?.glmCritical ?? 2,
      dsLow: cfg.thresholds?.dsLow ?? 5, dsCritical: cfg.thresholds?.dsCritical ?? 2,
      codex5hWarn: cfg.thresholds?.codex5hWarn ?? 80, codex5hCritical: cfg.thresholds?.codex5hCritical ?? 95,
      codexWeekWarn: cfg.thresholds?.codexWeekWarn ?? 80,
    },
    intervals: state.intervalMinutes ?? { codex: 5, balance: 5 },
    codex: shapeCodex(state.current?.codex, now),
    deepseek: shapeDeepseek(state.current?.deepseek, stats.burn?.deepseek, now),
    glm: shapeGlm(state.current?.glm, stats.burn?.glm, now),
    stats: {
      codexMax5h7d: stats.codexMax5h7d ?? null,
      codexSamples7d: stats.codexSamples7d ?? null,
      trend: stats.trend ?? null,      // 触顶预测
      anomaly: stats.anomaly ?? null,  // 当日消耗异常
    },
    health24h: state.health24h ?? null,
    platforms: state.platforms ?? null,                     // 生效的平台开关（config.platforms）
    models: { available: state.current?.codex?.data?.modelUsage ?? {} },   // 接口报告的模型可用性
    links: (() => { const l = {}; for (const [k, v] of Object.entries(cfg.links ?? {})) { if (!k.startsWith('$')) l[k] = v; } return l; })(),
    predict: { ...(cfg.predict ?? {}) },
    anomaly: { ...(cfg.anomaly ?? {}) },
    attribution: safeJson(`${DATA_DIR}\\attribution.json`) ?? null, // 额度去向（每小时维护生成）
    recentAlerts: (alerts.history ?? alerts.fired ?? []).slice(-40).reverse(),
    daily: buildDaily(cache),   // 按日聚合（热力图与区间统计用）
    history: buildHistory(cache), // 趋势数据内联（file:// 下 fetch 不可用）
  };
  return `window.DASHBOARD_DATA = ${JSON.stringify(out, null, 1)};\n`;
}

// 合并三个平台的按日聚合：{ 日期: { codex:{...}, deepseek:{...}, glm:{...} } }
function buildDaily(cache) {
  const days = new Set();
  for (const name of ['codex', 'deepseek', 'glm']) {
    for (const k of Object.keys(cache[name]?.daily ?? {})) days.add(k);
  }
  const out = {};
  for (const k of [...days].sort()) {
    out[k] = {
      codex: cache.codex?.daily?.[k] ?? null,
      deepseek: cache.deepseek?.daily?.[k] ?? null,
      glm: cache.glm?.daily?.[k] ?? null,
    };
  }
  return out;
}

// 读取 data/history/*.jsonl（尾部读取），提供 24h / 7d / 30d / 全部 四档
function buildHistory(cache) {
  const now = Date.now();
  const out = {};
  for (const name of ['codex', 'deepseek', 'glm']) {
    out[name] = {
      h24: compactSeries(name, readHistoryRows(name, now - DAY_MS), 400),
      d7: compactSeries(name, readHistoryRows(name, now - 7 * DAY_MS), 400),
      d30: cache[name]?.d30 ?? [],
      all: cache[name]?.all ?? [],
    };
  }
  return out;
}

function safeJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

function projectedDays(balance, burn) {
  if (!burn || !(burn.perDay > 0)) return null;
  return Math.max(0, Math.floor(balance / burn.perDay));
}

// 平台状态：关闭 / 未配置 不是故障，看板要能与"采集失败"区分开显示
function platformFlags(res) {
  return {
    disabled: !!res.disabled,
    unconfigured: !!res.unconfigured,
    keySource: res.data?.keySource ?? null,   // 密钥从哪来的（secrets.json / ThinCoder 配置 / 环境变量）
  };
}

function shapeCodex(res) {
  if (!res) return { ok: false, missing: true };
  if (!res.ok) return { ok: false, error: res.error, atMs: res.atMs ?? null, ...platformFlags(res) };
  const d = res.data;
  const five = { ...d.fiveHour, resetText: d.fiveHour.resetAt ? fmtLocal(d.fiveHour.resetAt) : null, resetAfter: d.fiveHour.resetAfterSeconds != null ? humanDuration(d.fiveHour.resetAfterSeconds) : null };
  const week = { ...d.weekly, resetText: d.weekly.resetAt ? fmtLocal(d.weekly.resetAt) : null, resetAfter: d.weekly.resetAfterSeconds != null ? humanDuration(d.weekly.resetAfterSeconds) : null };
  return {
    ok: true, degraded: !!res.degraded, carried: !!res.carried, source: d.source ?? 'live',
    snapshotAgeMinutes: d.snapshotAgeMinutes ?? null, error: res.error ?? null,
    atMs: res.atMs ?? null, ageMinutes: res.atMs ? Math.round((Date.now() - res.atMs) / 60000) : null,
    keySource: d.keySource ?? '~/.codex/auth.json',   // Codex 的凭据来自登录文件，不走 secrets.json
    plan: d.plan, email: d.email, fiveHour: five, weekly: week,
    limitReached: d.limitReached, limitReachedType: d.limitReachedType, credits: d.credits,
  };
}

function shapeDeepseek(res, burn) {
  if (!res) return { ok: false, missing: true };
  if (!res.ok) return { ok: false, error: res.error, atMs: res.atMs ?? null, ...platformFlags(res) };
  const d = res.data;
  return {
    ok: true, carried: !!res.carried, atMs: res.atMs ?? null,
    ageMinutes: res.atMs ? Math.round((Date.now() - res.atMs) / 60000) : null,
    keySource: d.keySource ?? null,
    currency: d.currency, totalBalance: d.totalBalance, grantedBalance: d.grantedBalance,
    toppedUpBalance: d.toppedUpBalance, isAvailable: d.isAvailable,
    burnPerDay: burn?.perDay ?? null, projectedDays: projectedDays(d.totalBalance, burn),
  };
}

function shapeGlm(res, burn) {
  if (!res) return { ok: false, missing: true };
  if (!res.ok) return { ok: false, error: res.error, atMs: res.atMs ?? null, ...platformFlags(res) };
  const d = res.data;
  const now = Date.now();
  const packs = (d.packs ?? []).map(p => ({
    amount: p.amount, paidAt: p.paidAt, expiryTime: p.expiryTime, expiryStatus: p.expiryStatus,
    daysLeft: Math.floor((new Date(p.expiryTime.replace(' ', 'T') + '+08:00').getTime() - now) / DAY_MS),
  })).sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''));
  return {
    ok: true, carried: !!res.carried, atMs: res.atMs ?? null,
    ageMinutes: res.atMs ? Math.round((Date.now() - res.atMs) / 60000) : null,
    keySource: d.keySource ?? null,
    balance: d.balance, availableBalance: d.availableBalance, rechargeAmount: d.rechargeAmount,
    giveAmount: d.giveAmount, totalSpendAmount: d.totalSpendAmount,
    depleted: Number(d.balance) <= 0,
    burnPerDay: burn?.perDay ?? null, projectedDays: projectedDays(Number(d.balance), burn),
    packs,
  };
}

// CLI：node 程序/tools/build-dashboard-data.mjs
if (process.argv[1] && process.argv[1].endsWith('build-dashboard-data.mjs')) {
  fs.writeFileSync(path.join(import.meta.dirname, '..', '..', 'dashboard-data.js'), buildDashboardData());
  console.log('dashboard-data.js 已生成');
}
