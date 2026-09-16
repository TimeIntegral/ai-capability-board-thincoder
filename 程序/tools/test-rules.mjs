// 规则引擎测试：node 程序/tools/test-rules.mjs [--slow]
// 覆盖：① 回归复现（滑动 resetAt 不得重复提醒）② 阈值/释放语义 ③ 真实历史回放 ④ 幂等性
//       + 本批（看板内配置向导）：状态文件契约 / 密钥可读出 / 中文提示载荷；--slow 单跑真机不外泄扫描
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { evaluateRules } from '../alert/rules.mjs';
import { readHistoryRows, ROOT_DIR } from '../lib/common.mjs';

const cfg = JSON.parse(fs.readFileSync(new URL('../../config.template.json', import.meta.url), 'utf8'));
const T0 = Date.UTC(2026, 8, 13, 0, 0, 0);

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function mkCodex({ u5 = 0, uw = 0, reset5 = 1000, resetW = 2000, degraded = false, limitReached = false } = {}) {
  return {
    ok: true, degraded,
    data: {
      fiveHour: { usedPercent: u5, resetAt: reset5, resetAfterSeconds: 18000, windowMinutes: 300 },
      weekly: { usedPercent: uw, resetAt: resetW, resetAfterSeconds: 604800, windowMinutes: 10080 },
      limitReached, limitReachedType: null, credits: { hasCredits: false, balance: '0' },
    },
  };
}

// 每行：{ts, current, health, sampled, intervalMinutes}
function runSequence(rows, stats = {}, opts = {}) {
  let alertState = null;
  const all = [], doubles = [];
  for (const row of rows) {
    const base = {
      collectedAtMs: row.ts,
      current: row.current,
      health: row.health ?? { consecutiveFailures: {}, lastErrors: {} },
      stats,
      sampled: row.sampled ?? opts.sampled,
      intervalMinutes: row.intervalMinutes ?? opts.intervalMinutes,
      suppression: row.suppression ?? opts.suppression,
    };
    const r1 = evaluateRules(null, base, cfg, alertState);
    alertState = r1.alertState;
    all.push(...r1.fired);
    // 幂等：同一样本重复求值必须被守卫拦截（防并发采集重复累加计数）
    const r2 = evaluateRules(null, base, cfg, alertState);
    alertState = r2.alertState;
    doubles.push(...r2.fired);
  }
  return { fired: all, doubles };
}

console.log('\n=== 测试 A：回归 —— 滑动 resetAt + 低用量（旧版每 5 分钟重复提醒的场景）===');
{
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push({
      ts: T0 + i * 5 * 60000,
      current: {
        codex: mkCodex({ u5: 0, uw: 0, reset5: T0 + i * 5 * 60000 + 18000000, resetW: T0 + i * 5 * 60000 + 604800000 }),
        deepseek: { ok: true, data: { totalBalance: 100 } },
        glm: { ok: true, data: { balance: 50 } },
      },
    });
  }
  const { fired } = runSequence(rows, { codexMax5h7d: 50 });
  check('100 次采集 0 条提醒（旧实现会 100 条）', fired.length === 0, `实际 ${fired.length} 条: ${fired.map(f => f.key).join(',')}`);
}

console.log('\n=== 测试 B：阈值 armed/滞回 + 释放语义 ===');
{
  const ramp = [10, 10, 85, 88, 90, 95, 96, 15, 15, 12];
  const rows = ramp.map((u, i) => ({
    ts: T0 + i * 5 * 60000,
    current: {
      codex: mkCodex({ u5: u, uw: 10, reset5: T0 + i * 5 * 60000 + 18000000 }),
      deepseek: { ok: true, data: { totalBalance: 100 } },
      glm: { ok: true, data: { balance: 50 } },
    },
  }));
  const { fired, doubles } = runSequence(rows, { codexMax5h7d: 50 });
  const keys = fired.map(f => f.key);
  check('80% 阈值恰好触发 1 次', keys.filter(k => k === 'codexThreshold:5h.80').length === 1, keys.join(','));
  check('95% 阈值恰好触发 1 次', keys.filter(k => k === 'codexThreshold:5h.95').length === 1, keys.join(','));
  check('释放提醒恰好触发 1 次', keys.filter(k => k === 'codexRelease:5h').length === 1, keys.join(','));
  check('总提醒数 = 3', fired.length === 3, `实际 ${fired.length}: ${keys.join(',')}`);
  check('幂等守卫：同一样本重复求值 0 新增', doubles.length === 0, doubles.map(d => d.key).join(','));

  const jitter = [78, 82, 79, 81, 83, 80, 82].map((u, i) => ({
    ts: T0 + i * 5 * 60000,
    current: {
      codex: mkCodex({ u5: u, uw: 10, reset5: T0 + i * 5 * 60000 + 18000000 }),
      deepseek: { ok: true, data: { totalBalance: 100 } },
      glm: { ok: true, data: { balance: 50 } },
    },
  }));
  const jr = runSequence(jitter, { codexMax5h7d: 50 });
  const j80 = jr.fired.filter(f => f.key === 'codexThreshold:5h.80').length;
  check('80% 附近抖动 7 次只提醒 1 次', j80 === 1, `实际 ${j80} 次`);
}

console.log('\n=== 测试 C：真实历史回放（最近 7 天实际数据）===');
{
  const rows = readHistoryRows('codex', Date.now() - 7 * 86400e3);
  if (rows.length < 2) {
    console.log('  （历史样本不足，跳过）');
  } else {
    const seq = rows.map(r => ({
      ts: r.ts,
      current: {
        codex: { ok: true, degraded: !!r.source, data: { ...r } },
        deepseek: { ok: true, data: { totalBalance: 100 } },
        glm: { ok: true, data: { balance: 50 } },
      },
    }));
    const { fired } = runSequence(seq, {});
    const resetLike = fired.filter(f => /reset/i.test(f.key));
    check('回放中不产生任何 reset 类提醒（旧版会刷屏）', resetLike.length === 0, resetLike.slice(0, 3).map(f => f.key).join(','));

    // 反刷屏不变量：同一 key 的相邻两次提醒间隔 ≥ 30 分钟（阈值类冷却为 0.5h，其余更长）
    const times = {};
    let minGapMin = Infinity, minGapKey = null;
    for (const f of fired) {
      if (times[f.key] != null) {
        const gap = (f.ts - times[f.key]) / 60000;
        if (gap < minGapMin) { minGapMin = gap; minGapKey = f.key; }
      }
      times[f.key] = f.ts;
    }
    check('同一提醒的最小间隔 ≥ 30 分钟（无刷屏）', minGapMin === Infinity || minGapMin >= 30,
      minGapKey ? `${minGapKey} 间隔仅 ${minGapMin.toFixed(0)} 分钟` : '');

    const byKey = {};
    for (const f of fired) byKey[f.key] = (byKey[f.key] ?? 0) + 1;
    // 反刷屏的量化判据用「日均密度」而不是绝对条数：
    // 绝对上限会随历史变长而必然触顶（2026-09-13 实测：7 天 1242 个采样点、22 条提醒撞到旧的 ≤20 上限，
    // 而"同一 key 最小间隔 ≥30 分钟"那条断言全绿 —— 说明每条提醒都是合法触发，不是刷屏）。
    // 刷屏事故的真实特征是"每小时几十条"（旧版一天产生 99 条），用密度既能抓住它，又不会随时间失效。
    const perDay = fired.length / 7;
    check(`7 天 ${rows.length} 个采样点，提醒密度 ≤ 10 条/天（刷屏故障约 99 条/天）`, perDay <= 10, `实际 ${fired.length} 条 / 7 天 = ${perDay.toFixed(1)} 条/天`);
    console.log(`     提醒明细: ${JSON.stringify(byKey)}`);
  }
}

console.log('\n=== 测试 D：其他场景 ===');
{
  const lim = [false, true, true, true, false].map((lr, i) => ({
    ts: T0 + i * 5 * 60000,
    current: {
      codex: mkCodex({ u5: 99, uw: 20, limitReached: lr, reset5: 1 }),
      deepseek: { ok: true, data: { totalBalance: 100 } },
      glm: { ok: true, data: { balance: 50 } },
    },
  }));
  const lr = runSequence(lim, { codexMax5h7d: 50 });
  const lk = lr.fired.map(f => f.key);
  check('限流提醒用同一 key 且 25 分钟内只发 1 次（冷却 3h）', lk.filter(k => k === 'codexLimit:active').length === 1, lk.join(','));
  check('限流进入文案正确', lr.fired.some(f => f.key === 'codexLimit:active' && /已触发限流/.test(f.title)), lr.fired.map(f => f.title).join(','));
  check('限流恢复提醒 1 次', lk.filter(k => k === 'codexLimit:recovered').length === 1, lk.join(','));

  const bal = (glmBal, dsBal) => ({
    ts: T0,
    current: { codex: mkCodex({ u5: 10, uw: 10, reset5: 1 }), deepseek: { ok: true, data: { totalBalance: dsBal } }, glm: { ok: true, data: { balance: glmBal } } },
  });
  const b1 = runSequence([bal(0, 1.5)], { codexMax5h7d: 50 });
  check('GLM ¥0 → 耗尽 P0', b1.fired.some(f => f.key === 'balanceRe:glm.depleted' && f.level === 'P0'), b1.fired.map(f => f.key).join(','));
  check('DeepSeek ¥1.5 → 紧急 P0（低于默认急线 2）', b1.fired.some(f => f.key === 'balanceRe:ds.critical' && f.level === 'P0'), b1.fired.map(f => f.key).join(','));

  const b2 = runSequence([bal(1.5, 15)], { codexMax5h7d: 50 });
  check('GLM ¥1.5 → 紧急 P0', b2.fired.some(f => f.key === 'balanceRe:glm.critical' && f.level === 'P0'), b2.fired.map(f => f.key).join(','));
  // 余额提醒线默认值 2026-09-17 定为：低线 5 元 / 急线 2 元（DeepSeek 与 GLM 同构）。
  // 低线必须高于急线 —— 否则 balanceRules 先判 critical，¥15 这类余额会被急线抢先拦下，「偏低」P1 永远不可达。
  check('DeepSeek ¥15 → 不提醒（默认低线 5 元：低于 5 才算低，¥15 不过线）', !b2.fired.some(f => f.key.startsWith('balanceRe:ds')), b2.fired.map(f => f.key).join(','));

  // 同一组默认值下两级都必须可达：¥3 落在急线 2 与低线 5 之间 → P1（看板黄色「余额偏低」），¥1.5 在急线之下 → P0。
  const b2b = runSequence([bal(50, 3)], { codexMax5h7d: 50 });
  check('DeepSeek ¥3 → 偏低 P1（低线 5 与急线 2 之间，中间档可达）', b2b.fired.some(f => f.key === 'balanceRe:ds.low' && f.level === 'P1'), b2b.fired.map(f => f.key).join(','));
  check('DeepSeek ¥3 不越级报紧急', !b2b.fired.some(f => f.key === 'balanceRe:ds.critical'), b2b.fired.map(f => f.key).join(','));

  const b3 = runSequence([bal(3, 50)], { codexMax5h7d: 50 });
  check('GLM ¥3 → 偏低 P1（阈值 2/5 之间）', b3.fired.some(f => f.key === 'balanceRe:glm.low' && f.level === 'P1'), b3.fired.map(f => f.key).join(','));

  const b4 = runSequence([bal(2.5, 100)], { codexMax5h7d: 50, burn: { glm: { perDay: 1, spent: 3, samples: 10, spanDays: 3 }, deepseek: { perDay: 8, spent: 24, samples: 10, spanDays: 3 } } });
  check('余额提醒含「预计可用 X 天」', b4.fired.some(f => /预计还可用/.test(f.body ?? '')), JSON.stringify(b4.fired.map(f => f.body)));

  // ---- 默认值不变量（本次改动的核心风险：低线/急线一旦倒挂，P1 与看板黄色状态就死了）----
  // balanceRules 先判 critical(P0) 再判 low(P1)：低线必须严格高于急线，两级才都可达。
  for (const p of ['ds', 'glm']) {
    const lo = cfg.thresholds[`${p}Low`], crit = cfg.thresholds[`${p}Critical`];
    check(`默认阈值不变量（${p}）：低线 ${lo} 高于急线 ${crit}`, lo > crit, `low=${lo} critical=${crit}`);
  }
  // 同源：同一个默认值散落在四处（模板 / 规则引擎回退 / 下发看板 / 页面回退），任一处漂移即红。
  // 2026-09-17 上一轮的坑正是「只改了其中一处」——这条把四处一起钉住。
  {
    const read = f => fs.readFileSync(path.join(ROOT_DIR, f), 'utf8');
    const seen = {
      'config.template.json': cfg.thresholds.dsCritical,
      '程序/alert/rules.mjs': read('程序/alert/rules.mjs').match(/num\(th\.dsCritical,\s*(\d+)\)/)?.[1],
      '程序/tools/build-dashboard-data.mjs': read('程序/tools/build-dashboard-data.mjs').match(/dsCritical:\s*cfg\.thresholds\?\.dsCritical\s*\?\?\s*(\d+)/)?.[1],
      'dashboard.html': read('dashboard.html').match(/D\.thresholds\?\.dsCritical\s*\?\?\s*(\d+)/)?.[1],
    };
    check('dsCritical 默认值四处同源且为 2（模板/规则引擎/下发/页面）', Object.values(seen).map(Number).every(v => v === 2), JSON.stringify(seen));
  }

  const idle = runSequence([{
    ts: T0, current: { codex: mkCodex({ u5: 0, uw: 0, reset5: 1 }), deepseek: { ok: true, data: { totalBalance: 100 } }, glm: { ok: true, data: { balance: 50 } } },
  }], { codexMax5h7d: 2 });
  check('7 天峰值 2% → 订阅闲置提醒', idle.fired.some(f => f.key === 'codexIdle:7d'), idle.fired.map(f => f.key).join(','));

  // 降级滞回：需连续 3 次降级；恢复需连续 6 次稳定
  const deg = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({
    ts: T0 + (offset + i) * 5 * 60000,
    current: { codex: mkCodex({ u5: 10, uw: 10, degraded: true, reset5: T0 + (offset + i) * 5 * 60000 + 18000000 }), deepseek: { ok: true, data: { totalBalance: 100 } }, glm: { ok: true, data: { balance: 50 } } },
  }));
  const live = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({
    ts: T0 + (offset + i) * 5 * 60000,
    current: { codex: mkCodex({ u5: 10, uw: 10, reset5: T0 + (offset + i) * 5 * 60000 + 18000000 }), deepseek: { ok: true, data: { totalBalance: 100 } }, glm: { ok: true, data: { balance: 50 } } },
  }));
  const d1 = runSequence(deg(2), { codexMax5h7d: 50 });
  check('连续 2 次降级不提醒（滞回=3）', d1.fired.filter(f => f.key === 'codexLink:status').length === 0, d1.fired.map(f => f.key).join(','));
  const d2 = runSequence(deg(3), { codexMax5h7d: 50 });
  check('连续 3 次降级 → 提醒 1 次', d2.fired.filter(f => f.key === 'codexLink:status').length === 1, d2.fired.map(f => f.key).join(','));
  const d3 = runSequence([...deg(3), ...live(3, 3)], { codexMax5h7d: 50 });
  check('恢复 3 次（<6）不提醒', d3.fired.filter(f => f.key === 'codexLink:status' && /恢复/.test(f.title)).length === 0, d3.fired.map(f => f.key).join(','));
  const d4 = runSequence([...deg(3), ...live(6, 3)], { codexMax5h7d: 50 });
  check('恢复 6 次稳定 → 有恢复告知（与降级共用 key，冷却 24h 内合并）', d4.fired.filter(f => f.key === 'codexLink:status').length <= 2 && d4.fired.some(f => f.key === 'codexLink:status'), d4.fired.map(f => f.key).join(','));
  // 抖动场景（真实数据里 09-09 那种 1-2 样本反复切换）：不应产生任何降级/恢复提醒
  const flap = [];
  let t = 0;
  for (let i = 0; i < 8; i++) { flap.push(...deg(1, t)); t += 1; flap.push(...live(1, t)); t += 1; }
  const d5 = runSequence(flap, { codexMax5h7d: 50 });
  check('代理抖动（单样本反复切换）不产生降级/恢复提醒', d5.fired.filter(f => f.key === 'codexLink:status').length === 0, d5.fired.map(f => f.key).join(','));

  // 采集异常：连续 3 次失败才报，恢复需连续 2 次成功
  const hrow = (ok, i) => ({
    ts: T0 + i * 5 * 60000,
    current: { codex: mkCodex({ u5: 10, uw: 10, reset5: 1 }), deepseek: { ok, error: ok ? undefined : 'boom', data: ok ? { totalBalance: 100 } : undefined }, glm: { ok: true, data: { balance: 50 } } },
    health: { consecutiveFailures: { deepseek: ok ? 0 : 3 }, lastErrors: { deepseek: ok ? null : 'boom' } },
  });
  const hseq = runSequence([hrow(false, 0), hrow(false, 1), hrow(false, 2), hrow(true, 3), hrow(true, 4)], { codexMax5h7d: 50 });
  check('连续 3 次失败 → 采集异常 P0', hseq.fired.some(f => f.key === 'health:deepseek' && f.level === 'P0'), hseq.fired.map(f => f.key).join(','));
  check('连续 2 次成功 → 恢复提醒', hseq.fired.some(f => f.key === 'health:deepseek.recovered'), hseq.fired.map(f => f.key).join(','));
}

console.log('\n=== 测试 E：采集频率变化下的滞回换算（1 分钟制不得变过敏） ===');
{
  const deg1min = n => Array.from({ length: n }, (_, i) => ({
    ts: T0 + i * 60000,
    current: { codex: mkCodex({ u5: 10, uw: 10, degraded: true, reset5: T0 + i * 60000 + 18000000 }), deepseek: { ok: true, data: { totalBalance: 100 } }, glm: { ok: true, data: { balance: 50 } } },
    intervalMinutes: { codex: 1, balance: 5 },
  }));
  const e1 = runSequence(deg1min(3), { codexMax5h7d: 50 });
  check('1 分钟采集下，3 次降级（=3 分钟）不提醒（需 15 分钟）', e1.fired.filter(f => f.key === 'codexLink:status').length === 0, e1.fired.map(f => f.key).join(','));
  const e2 = runSequence(deg1min(15), { codexMax5h7d: 50 });
  check('1 分钟采集下，连续 15 分钟降级才提醒 1 次', e2.fired.filter(f => f.key === 'codexLink:status').length === 1, e2.fired.map(f => f.key).join(','));
  // 阈值类与频率无关（百分点滞回）
  const ramp1min = [10, 85, 88, 15].map((u, i) => ({
    ts: T0 + i * 60000,
    current: { codex: mkCodex({ u5: u, uw: 10, reset5: T0 + i * 60000 + 18000000 }), deepseek: { ok: true, data: { totalBalance: 100 } }, glm: { ok: true, data: { balance: 50 } } },
    intervalMinutes: { codex: 1, balance: 5 },
  }));
  const e3 = runSequence(ramp1min, { codexMax5h7d: 50 });
  check('1 分钟制下阈值/释放语义不变（各 1 次）',
    e3.fired.filter(f => f.key === 'codexThreshold:5h.80').length === 1 && e3.fired.filter(f => f.key === 'codexRelease:5h').length === 1,
    e3.fired.map(f => f.key).join(','));
}

console.log('\n=== 测试 F：跳采平台不参与判定（分平台间隔） ===');
{
  const rows = [0, 1, 2].map(i => ({
    ts: T0 + i * 60000,
    current: {
      codex: mkCodex({ u5: 0, uw: 0, reset5: 1 }),
      deepseek: { ok: false, error: 'boom' },   // 一直失败，但本轮未采样
      glm: { ok: true, data: { balance: 0 } },  // 余额为 0，但本轮未采样
    },
    sampled: { codex: true, deepseek: false, glm: false },
    intervalMinutes: { codex: 1, balance: 5 },
  }));
  const f1 = runSequence(rows, { codexMax5h7d: 50 });
  check('未采样平台不触发余额/健康提醒', f1.fired.length === 0, f1.fired.map(f => f.key).join(','));
}

console.log('\n=== 测试 G：分级降采样（永久保留） ===');
{
  const { applyTiers, DATA_DIR } = await import('../lib/common.mjs');
  const fs = await import('node:fs');
  const p = `${DATA_DIR}\\history\\__test_tier__.jsonl`;
  const DAY = 86400e3, MIN = 60000;
  const now = Date.now();
  const start = now - 400 * DAY;               // 覆盖 400 天，1 分钟一个样本（超长历史）
  const lines = [];
  for (let i = 0; i < 400 * 1440; i += 3) lines.push(JSON.stringify({ ts: start + i * MIN, marker: i }));
  fs.writeFileSync(p, lines.join('\n') + '\n');

  const tiers = [
    { olderThanDays: 7, bucketMinutes: 5 },
    { olderThanDays: 30, bucketMinutes: 60 },
    { olderThanDays: 365, bucketMinutes: 1440 },
  ];
  const r = applyTiers('__test_tier__', tiers, now);
  const keptRows = fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  fs.unlinkSync(p);

  const recent = keptRows.filter(x => x.ts >= now - 7 * DAY).length;
  const mid = keptRows.filter(x => x.ts >= now - 30 * DAY && x.ts < now - 7 * DAY).length;
  const old = keptRows.filter(x => x.ts < now - 365 * DAY).length;

  // 测试数据：每 3 分钟一个样本 → 每天 480 个；5 分钟桶 → 288/天，小时桶 → 24/天，天桶 → 1/天
  check('超长历史被大幅压缩（行数减少 >90%）', r.removed > lines.length * 0.9, `removed=${r.removed}/${lines.length}`);
  check('7 天内数据原样保留', recent === lines.filter((_, i) => start + i * 3 * MIN >= now - 7 * DAY).length, `recent=${recent}`);
  check('7-30 天档压到 5 分钟粒度（≈288 点/天）', mid > 23 * 280 && mid < 23 * 296, `mid=${mid}（期望 ≈${23 * 288}）`);
  check('1 年以上档压到天粒度（≈35 点）', old >= 30 && old <= 40, `old=${old}`);
  check('文件按时间有序（降采样后仍有序）', keptRows.every((x, i) => i === 0 || x.ts >= keptRows[i - 1].ts), '顺序异常');
  check('数据未被删除（最老的点仍在首日附近）', keptRows[0].ts >= start && keptRows[0].ts <= start + DAY, `首点距起点 ${((keptRows[0].ts - start) / DAY).toFixed(2)} 天`);
}

console.log('\n=== 测试 H：余额提醒抑制（「不再提醒」直到充值） ===');
{
  const { rechargedSince } = await import('../lib/common.mjs');
  const row = (sup) => ({
    ts: T0,
    current: {
      codex: mkCodex({ u5: 10, uw: 10, reset5: 1 }),
      deepseek: { ok: true, data: { totalBalance: 1 } },   // 低于 dsCritical(2) → 本应 P0
      glm: { ok: true, data: { balance: 0 } },             // 耗尽 → 本应 P0
    },
    suppression: sup,
  });
  const on = runSequence([row({})], { codexMax5h7d: 50 });
  check('无抑制时：GLM 耗尽与 DeepSeek 紧急各提醒 1 条', on.fired.filter(f => f.key.startsWith('balanceRe:')).length === 2, on.fired.map(f => f.key).join(','));

  const off = runSequence([row({ glm: { atMs: T0 - 1000, balanceAt: 0 } })], { codexMax5h7d: 50 });
  const keys = off.fired.map(f => f.key);
  check('抑制 GLM 后：GLM 余额提醒被跳过', !keys.some(k => k.includes('glm')), keys.join(','));
  check('抑制 GLM 不影响 DeepSeek 提醒', keys.includes('balanceRe:ds.critical'), keys.join(','));

  const both = runSequence([row({ glm: { atMs: T0 - 1000, balanceAt: 0 }, deepseek: { atMs: T0 - 1000, balanceAt: 5 } })], { codexMax5h7d: 50 });
  check('两个平台都抑制时不产生任何余额提醒', !both.fired.some(f => f.key.startsWith('balanceRe:')), both.fired.map(f => f.key).join(','));

  check('充值判定：余额回升 → 恢复', rechargedSince({ balanceAt: 0 }, 10) === true, '');
  check('充值判定：余额持平/下降 → 保持抑制', rechargedSince({ balanceAt: 10 }, 10) === false && rechargedSince({ balanceAt: 10 }, 8) === false, '');
}

console.log('\n=== 测试 I：触顶预测（按斜率外推，armed 闸门防重复） ===');
{
  const mk = (used, trend) => ({
    ts: T0,
    current: {
      codex: mkCodex({ u5: used, uw: 20, reset5: 1 }),
      deepseek: { ok: true, data: { totalBalance: 100 } },
      glm: { ok: true, data: { balance: 100 } },
    },
  });
  // 用量 60%，斜率 2 个百分点/分钟 → 20 分钟后触顶（阈值 30 分钟）→ 应提醒
  const near = runSequence([mk(60, null)], { codexMax5h7d: 60, trend: { used: 60, slopePerMin: 2, projectedMinutes: 20 } });
  const nearKeys = near.fired.map(f => f.key);
  check('预计 20 分钟触顶（阈值 30 分钟）→ 提醒', nearKeys.includes('codexPredict:5h'), nearKeys.join(','));
  check('文案含预计分钟数', (near.fired.find(f => f.key === 'codexPredict:5h')?.title ?? '').includes('20 分钟'), near.fired.find(f => f.key === 'codexPredict:5h')?.title);

  // 斜率慢（200 分钟后）→ 不提醒
  const far = runSequence([mk(60, null)], { codexMax5h7d: 60, trend: { used: 60, slopePerMin: 0.2, projectedMinutes: 200 } });
  check('预计 200 分钟触顶 → 不提醒', !far.fired.some(f => f.key === 'codexPredict:5h'), far.fired.map(f => f.key).join(','));

  // 用量低（20% < minUsedPercent 40）→ 即使斜率快也不提醒（避免低用量误报）
  const low = runSequence([mk(20, null)], { codexMax5h7d: 20, trend: { used: 20, slopePerMin: 4, projectedMinutes: 20 } });
  check('低用量（20%）+ 快斜率 → 不提醒', !low.fired.some(f => f.key === 'codexPredict:5h'), low.fired.map(f => f.key).join(','));

  // 持续高速消耗：armed 闸门保证不反复提醒
  const many = [];
  for (let i = 0; i < 20; i++) many.push(mk(60 + i * 0.5, null));
  const sustained = runSequence(many, { codexMax5h7d: 60, trend: { used: 70, slopePerMin: 2, projectedMinutes: 15 } });
  check('持续高速消耗不重复提醒（armed 闸门）', sustained.fired.filter(f => f.key === 'codexPredict:5h').length === 1,
    `实际 ${sustained.fired.filter(f => f.key === 'codexPredict:5h').length} 条`);

  // 无预测数据（样本不足）→ 不提醒，也不报错
  const none = runSequence([mk(60, null)], { codexMax5h7d: 60, trend: null });
  check('无预测数据时静默', !none.fired.some(f => f.key === 'codexPredict:5h'), none.fired.map(f => f.key).join(','));
}

console.log('\n=== 测试 J：异常消耗预警（当日 vs 近 7 日均值） ===');
{
  const row = () => ({
    ts: T0,
    current: {
      codex: mkCodex({ u5: 10, uw: 10, reset5: 1 }),
      deepseek: { ok: true, data: { totalBalance: 100 } },
      glm: { ok: true, data: { balance: 50 } },
    },
  });
  // 今天花 ¥20，均值 ¥5 → 4 倍（阈值 3 倍）且 > ¥5 → 提醒
  const hot = runSequence([row()], { codexMax5h7d: 10, anomaly: { deepseek: { today: 20, mean: 5, ratio: 4 }, glm: { today: 0.1, mean: 0.05, ratio: 2 } } });
  const hotKeys = hot.fired.map(f => f.key);
  check('DeepSeek 今日 4 倍于均值 → 提醒', hotKeys.includes('anomaly:deepseek'), hotKeys.join(','));
  check('GLM 仅 2 倍（未达 3 倍阈值）→ 不提醒', !hotKeys.includes('anomaly:glm'), hotKeys.join(','));

  // 倍数够但金额太小（¥2 < minAmount ¥5）→ 不提醒
  const small = runSequence([row()], { codexMax5h7d: 10, anomaly: { deepseek: { today: 2, mean: 0.1, ratio: 20 } } });
  check('倍数高但金额过小 → 不提醒', !small.fired.some(f => f.key === 'anomaly:deepseek'), small.fired.map(f => f.key).join(','));

  // 抑制该平台时也跳过异常提醒
  const sup = runSequence([{ ...row(), suppression: { deepseek: { atMs: T0 - 1000, balanceAt: 100 } } }],
    { codexMax5h7d: 10, anomaly: { deepseek: { today: 20, mean: 5, ratio: 4 } } });
  check('平台被「不再提醒」抑制时跳过异常预警', !sup.fired.some(f => f.key === 'anomaly:deepseek'), sup.fired.map(f => f.key).join(','));

  // 持续异常不重复（armed 闸门）
  const many = Array.from({ length: 10 }, row);
  const sustained = runSequence(many, { codexMax5h7d: 10, anomaly: { deepseek: { today: 20, mean: 5, ratio: 4 } } });
  check('持续异常不重复提醒', sustained.fired.filter(f => f.key === 'anomaly:deepseek').length === 1,
    `实际 ${sustained.fired.filter(f => f.key === 'anomaly:deepseek').length} 条`);
}

console.log('\n=== 测试 K：配置编辑白名单（协议写入的边界防护） ===');
{
  const { applyConfigEdits } = await import('./edit-config.mjs');
  const cfgUrl = new URL('../../config.json', import.meta.url);
  const read = () => fs.existsSync(cfgUrl) ? fs.readFileSync(cfgUrl, 'utf8') : null;
  const before = read();
  const restore = () => { if (before === null) fs.rmSync(cfgUrl, { force: true }); else fs.writeFileSync(cfgUrl, before); };
  // 注意：applyConfigEdits 会真的写 config.json —— 现场还原一律放 finally（中途崩溃也不留下被改过的配置）
  let err = null;
  try {
    const r1 = applyConfigEdits('thresholds.glmLow:abc,a.b.c:1,thresholds.dsLow:15');
    check('越界/未知/非数值一律拒绝，合法项通过', r1.applied.length === 1 && r1.rejected.length === 2,
      `applied=${JSON.stringify(r1.applied)} rejected=${JSON.stringify(r1.rejected)}`);
    const edited = read();
    check('合法项确实写入 config.json', JSON.parse(edited).thresholds.dsLow === 15, edited?.slice(0, 80));

    // 越界值不得写盘（与写入后的现场比，不看已被合法项改过的原值）
    const r2 = applyConfigEdits('thresholds.glmLow:99999');
    check('越界值被拒绝且不写盘', r2.applied.length === 0 && r2.rejected.length === 1, JSON.stringify(r2));
    check('拒绝路径同样不改动配置', read() === edited, '');
  } catch (e) { err = e; } finally { restore(); }
  check('K 用例运行无异常', !err, err ? String(err?.message ?? err).slice(0, 120) : '');
  check('用例结束后 config.json 已原样还原', read() === before, '还原失败');
}

// ===================== 看板内配置向导（本批新增用例；真机改写纪律：先备份、还原放 finally、失败信息只报来源与长度） =====================
const SLOW = process.argv.includes('--slow');
const snapshot = p => (fs.existsSync(p) ? fs.readFileSync(p) : null);
const putBack = (p, buf) => { if (buf === null) fs.rmSync(p, { force: true }); else fs.writeFileSync(p, buf); };
const hasSentinel = (buf, sent) => buf != null && String(buf).includes(sent);

console.log('\n=== 测试 L：状态文件契约（tools/setup-check.mjs → data/setup-status.json） ===');
{
  const secretsPath = path.join(ROOT_DIR, 'secrets.json');
  const configPath = path.join(ROOT_DIR, 'config.json');
  const statusPath = path.join(ROOT_DIR, 'data', 'setup-status.json');
  const SENT_DS = 'SENTINEL-T19-DS-KEY', SENT_GLM = 'SENTINEL-T19-GLM-KEY';
  const bSec = snapshot(secretsPath), bCfg = snapshot(configPath), bStatus = snapshot(statusPath);
  let err = null, out1 = '', st = null, st2 = null, raw1 = '';
  try {
    fs.writeFileSync(secretsPath, JSON.stringify({ deepseek: SENT_DS, glm: SENT_GLM }, null, 1));
    out1 = execFileSync(process.execPath, [path.join(ROOT_DIR, '程序', 'tools', 'setup-check.mjs')], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    raw1 = fs.readFileSync(statusPath, 'utf8');
    st = JSON.parse(raw1);
    fs.writeFileSync(configPath, '{broken');
    execFileSync(process.execPath, [path.join(ROOT_DIR, '程序', 'tools', 'setup-check.mjs')], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    st2 = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
  } catch (e) { err = e; } finally { putBack(secretsPath, bSec); putBack(configPath, bCfg); putBack(statusPath, bStatus); }
  check('L 用例运行无异常（真跑探测脚本两轮）', !err, err ? String(err?.message ?? err).slice(0, 160) : '');
  if (st) {
    check('字段齐全且类型正确', Number.isFinite(st.checkedAtMs)
      && typeof st.platforms?.codex === 'boolean' && typeof st.platforms?.deepseek === 'boolean' && typeof st.platforms?.glm === 'boolean'
      && ['ok', 'broken', 'missing'].includes(st.config?.parse)
      && typeof st.codex?.found === 'boolean' && typeof st.deepseek?.found === 'boolean' && typeof st.glm?.found === 'boolean'
      && Number.isFinite(st.deepseek?.length) && Array.isArray(st.secrets?.platforms)
      && typeof st.autoRun?.taskRegistered === 'boolean' && typeof st.autoRun?.taskName === 'string'
      && (st.lastCollect?.atMs === null || Number.isFinite(st.lastCollect?.atMs))
      && typeof st.runtime?.nodeVersion === 'string' && typeof st.runtime?.portable === 'boolean',
      JSON.stringify(st).slice(0, 200));
    check('正常配置 → config.parse = ok', st.config.parse === 'ok', st.config.parse);
    check('密钥只报来源与长度（来源 = 本机密钥文件、长度一致）', st.deepseek.source === 'secrets.json' && st.deepseek.length === SENT_DS.length && st.glm.length === SENT_GLM.length,
      `${st.deepseek.source} / ${st.deepseek.length}`);
    check('状态文件序列化后不含哨兵值', !hasSentinel(raw1, SENT_DS) && !hasSentinel(raw1, SENT_GLM), '');
    check('本轮 stdout 也不含哨兵值', !hasSentinel(out1, SENT_DS) && !hasSentinel(out1, SENT_GLM), out1.slice(0, 80));
  }
  if (st2) check('损坏的 config.json → config.parse = broken', st2.config.parse === 'broken', st2.config.parse);
  check('L 用例结束后现场已还原', String(snapshot(secretsPath)) === String(bSec) && String(snapshot(configPath)) === String(bCfg), '');
}

console.log('\n=== 测试 M：写出的密钥可被 resolveApiKey 读出 ===');
{
  const { resolveApiKey } = await import('../lib/common.mjs');
  const secretsPath = path.join(ROOT_DIR, 'secrets.json');
  const SENT = 'SENTINEL-T20-DS-KEY';
  const bSec = snapshot(secretsPath);
  let err = null, got = null;
  try {
    fs.writeFileSync(secretsPath, JSON.stringify({ deepseek: SENT }, null, 1));
    got = resolveApiKey('deepseek', JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config.json'), 'utf8')));
  } catch (e) { err = e; } finally { putBack(secretsPath, bSec); }
  check('M 用例运行无异常', !err, err ? String(err?.message ?? err).slice(0, 160) : '');
  check('来源 = secrets.json 且值一致（只报来源与长度）', !!got && got.source === 'secrets.json' && got.key === SENT,
    got ? `${got.source} len=${got.key.length}` : '（无结果）');
  check('M 用例结束后密钥文件已还原', String(snapshot(secretsPath)) === String(bSec), '');
}

console.log('\n=== 测试 N：中文提示载荷（两态 + 守卫态 + .vbs 内嵌载荷） ===');
{
  // 「import 零副作用」以墙钟作代理判据：若 import 触发弹框会阻塞进程、耗时立刻越界；仅极慢机器可能偏保守（有意的取舍）
  const t0 = Date.now();
  const { buildNotifyPayload } = await import('./setup-notify.mjs');
  check('作为模块 import 零副作用（未弹框：耗时 < 2s）', Date.now() - t0 < 2000, `${Date.now() - t0}ms`);
  const ok64 = buildNotifyPayload('ok'), fail64 = buildNotifyPayload('fail'), no64 = buildNotifyPayload('noinstall');
  const okTxt = Buffer.from(ok64, 'base64').toString('utf16le');
  const failTxt = Buffer.from(fail64, 'base64').toString('utf16le');
  check('两态载荷解码（UTF-16LE）后均为非空中文', /[\u4e00-\u9fff]/.test(okTxt) && /[\u4e00-\u9fff]/.test(failTxt), '');
  check('两态载荷可区分', okTxt !== failTxt, '');
  const vbsBuf = fs.readFileSync(path.join(ROOT_DIR, '快捷操作', '启用自动采集.vbs'));
  check('.vbs 源与全部载荷串零非 ASCII 字节', ![...vbsBuf].some(b => b > 0x7F), '');
  const vbsText = vbsBuf.toString('utf8');
  const grab = n => { const m = vbsText.match(new RegExp('^' + n + ' = "([^"\\r\\n]+)"$', 'm')); return m ? m[1] : null; };
  const vOk = grab('b64Ok'), vFail = grab('b64Fail'), vNo = grab('b64NoInstall');
  check('按固定名可抽取三段内嵌载荷（各为一条不折行字面量）', !!vOk && !!vFail && !!vNo, '');
  check('内嵌退化载荷与 .mjs 同源同文案（成功态）', vOk === ok64, '');
  check('内嵌退化载荷与 .mjs 同源同文案（失败态）', vFail === fail64, '');
  check('内嵌守卫载荷与 .mjs 同源同文案（守卫态）', vNo === no64, '');
  check('三段内嵌载荷解码均为非空中文', [vOk, vFail, vNo].every(x => /[\u4e00-\u9fff]/.test(Buffer.from(x ?? '', 'base64').toString('utf16le'))), '');
  check('三段内嵌载荷互不相同', new Set([vOk, vFail, vNo]).size === 3, '');
}

console.log('\n=== 测试 O：运行时文件不含密钥（真机扫描） ===');
if (!SLOW) {
  console.log('  （重 IO：起真实采集进程——默认跳过，单跑用 node 程序/tools/test-rules.mjs --slow）');
} else {
  const secretsPath = path.join(ROOT_DIR, 'secrets.json');
  const watch = [
    secretsPath,
    path.join(ROOT_DIR, 'dashboard-data.js'),
    path.join(ROOT_DIR, 'data', 'state.json'),
    path.join(ROOT_DIR, 'data', 'alerts.json'),
    path.join(ROOT_DIR, 'data', 'series-cache.json'),
    path.join(ROOT_DIR, 'data', 'notify-queue.json'),
    path.join(ROOT_DIR, 'data', 'balance-mute.json'),
    path.join(ROOT_DIR, 'data', 'protocol.log'),
    path.join(ROOT_DIR, 'data', 'collect.log'),
    path.join(ROOT_DIR, 'data', 'setup-status.json'),
  ];
  const SENT = 'SENTINEL-T38-DS-KEY';
  const snapshots = new Map(watch.map(p => [p, snapshot(p)]));
  let err = null, outs = '';
  try {
    fs.writeFileSync(secretsPath, JSON.stringify({ deepseek: SENT }, null, 1));
    outs += execFileSync(process.execPath, [path.join(ROOT_DIR, '程序', 'tools', 'setup-check.mjs')], { encoding: 'utf8', timeout: 60000 });
    // 真实采集一次（含联网；失败属预期——本轮只验「不外泄」）
    try {
      outs += execFileSync(process.execPath, [path.join(ROOT_DIR, '程序', 'collect.mjs')], { encoding: 'utf8', timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { outs += String(e.stdout ?? '') + String(e.stderr ?? ''); }
  } catch (e) { err = e; } finally {
    for (const [p, buf] of snapshots) putBack(p, buf);
  }
  check('O 用例运行无异常', !err, err ? String(err?.message ?? err).slice(0, 160) : '');
  const leaked = [];
  for (const p of watch) if (hasSentinel(snapshot(p), SENT)) leaked.push(path.basename(p));
  if (hasSentinel(outs, SENT)) leaked.push('stdout/stderr');
  check('运行时文件与本轮输出零哨兵命中（data/state.json · protocol.log · collect.log · dashboard-data.js …）', leaked.length === 0, leaked.join(','));
  check('O 用例结束后现场已还原', [...snapshots].every(([p, buf]) => String(snapshot(p)) === String(buf)), '');
}

console.log('\n=== 测试 P：余额类采集间隔 = 1 分钟（默认值钉死 + 健康滞回按实际间隔换算） ===');
{
  // 默认值：模板里余额与 Codex 同为 1 分钟（2026-09-17 用户要求「余额采集频次提到 1 分钟」）。
  // 用户自己的 config.json 是 gitignore 的用户数据，此处只能钉模板默认值——它决定新装/未显式覆盖的机器。
  check('config.template.json: codexMinutes = 1', cfg.intervals?.codexMinutes === 1, String(cfg.intervals?.codexMinutes));
  check('config.template.json: balanceMinutes = 1（余额与 Codex 同频）', cfg.intervals?.balanceMinutes === 1, String(cfg.intervals?.balanceMinutes));

  // 机制：健康滞回按「分钟」配置、按该平台实际间隔换算成样本数 —— 余额改 1 分钟后不得变得过敏。
  // （healthFailMinutes=15：1 分钟制要连续 15 次失败，若被当成 5 分钟制则 3 次就报警）
  const balRow = (i, ok) => ({
    ts: T0 + i * 60000,
    current: {
      codex: mkCodex({ u5: 0, uw: 0, reset5: 1 }),
      deepseek: ok ? { ok: true, data: { totalBalance: 100 } } : { ok: false, error: 'boom' },
      glm: { ok: true, data: { balance: 50 } },
    },
    sampled: { codex: false, deepseek: true, glm: true },
    intervalMinutes: { codex: 1, balance: 1 },
  });
  const fail14 = runSequence(Array.from({ length: 14 }, (_, i) => balRow(i, false)), { codexMax5h7d: 50 });
  check('余额 1 分钟制：连续 14 次失败（=14 分钟）不提醒（需 15 分钟）',
    fail14.fired.length === 0, fail14.fired.map(f => f.key).join(','));
  const fail15 = runSequence(Array.from({ length: 15 }, (_, i) => balRow(i, false)), { codexMax5h7d: 50 });
  check('余额 1 分钟制：连续 15 次失败才报采集异常（按实际间隔换算，未被当成 5 分钟）',
    fail15.fired.filter(f => f.key === 'health:deepseek' && f.level === 'P0').length === 1,
    fail15.fired.map(f => f.key).join(','));
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
