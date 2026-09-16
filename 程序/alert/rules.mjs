// 场景化提醒规则引擎（纯函数）：对比前次采集，产出待发提醒列表。
//
// 【为什么重写 · 2026-09-13】
// Codex 的 reset_at 是**滑动窗口值**（≈ 查询时刻 + 窗口长度，每次查询都往后挪），
// 旧实现把它当作"窗口身份"嵌进 alert key（reset:${resetAt}），导致：
//   resetAt 每 5 分钟变一次 → 每次都是全新 key → 冷却永不生效 → 每 5 分钟重复提醒。
// 现方案：规则只依赖「用量自身走势」，不再信任任何易变的时间戳：
//   · 释放提醒 = 峰值回落（peak ≥ 60% → ≤ 20% 且降幅 ≥ 30pt）
//   · 阈值提醒 = armed/滞回（≥阈值触发一次，回落到 阈值-hysteresis 才重新武装）
//   · 限流 / 降级 = 边沿触发 + 滞回，杜绝抖动刷屏
//
// 冷却：alertState.lastFiredAt[namespace:detail]，按 namespace 查 cfg.cooldown。

const HOUR = 3600 * 1000;

// prev 参数保留（调用方仍传入上一份快照）：当前规则不依赖它——所有比较基准都存在 alertState 里，
// 这样"上次是什么"与"上次是否已经提醒过"是同一份状态，不会出现两者不一致导致的重复提醒。
export function evaluateRules(prev, state, cfg, prevAlertState) {
  const fired = [];
  const st = normalizeState(prevAlertState);
  const now = state.collectedAtMs;
  const th = cfg.thresholds ?? {};
  const hys = cfg.hysteresis ?? {};
  const rel = cfg.release ?? {};

  // 幂等守卫：同一次采集被重复求值（手动+计划任务并发等）时直接返回，
  // 避免连续计数器被重复累加而提前触发。
  if (state.collectedAtMs && st.lastSampleMs === state.collectedAtMs) {
    return { fired: [], alertState: st };
  }
  st.lastSampleMs = state.collectedAtMs;

  const push = (key, level, title, body) => {
    const cd = cfg.cooldown[key.split(':')[0]] ?? cfg.cooldown.default;
    const last = st.lastFiredAt[key];
    if (last != null && cd >= 0 && now - last < cd * HOUR) return false;
    st.lastFiredAt[key] = now;
    fired.push({ key, level, title, body, ts: now });
    return true;
  };

  const cur = state.current ?? {};
  const curCodex = cur.codex?.ok ? cur.codex.data : null;
  const stats = state.stats ?? {};

  // 分平台采集：本轮未采样的平台直接跳过（不更新计数器、不触发提醒）
  const sampled = state.sampled ?? {};
  const iv = state.intervalMinutes ?? {};
  const codexIv = num(iv.codex, 5), balanceIv = num(iv.balance, 5);
  // 滞回按"分钟"配置，按各平台实际采集间隔换算成样本数（1 分钟制下不会变得过敏）
  const samples = (minutes, intervalMin) => Math.max(1, Math.ceil(num(minutes, 15) / Math.max(intervalMin, 0.25)));

  // ================= Codex =================
  if (curCodex && sampled.codex !== false) {
    const c5 = curCodex.fiveHour ?? {}, cw = curCodex.weekly ?? {};
    const u5 = num(c5.usedPercent), uw = num(cw.usedPercent);

    // --- 实时接口降级/恢复（双向滞回，按分钟配置：连续 N 分钟降级才提醒，M 分钟稳定才算恢复）---
    if (cur.codex.degraded === true) {
      st.codexDeg.degCount = (st.codexDeg.degCount ?? 0) + 1;
      st.codexDeg.liveCount = 0;
      if (st.codexDeg.degCount >= samples(hys.degradedFailMinutes, codexIv) && !st.codexDeg.alerted) {
        if (push('codexLink:status', 'P1', 'Codex 实时接口不可达 ⚠',
          '已降级为本地会话快照（数据非实时）· 恢复后自动切回并提醒')) st.codexDeg.alerted = true;
      }
    } else {
      st.codexDeg.liveCount = (st.codexDeg.liveCount ?? 0) + 1;
      st.codexDeg.degCount = 0;
      if (st.codexDeg.alerted && st.codexDeg.liveCount >= samples(hys.degradedRecoverMinutes, codexIv)) {
        // 与降级提醒共用 key：24h 内不重复告知（同一条连接状态线，一天最多一条）
        push('codexLink:status', 'P2', 'Codex 实时接口已恢复 ✅', '额度数据恢复实时更新');
        st.codexDeg.alerted = false;
      }
    }

    // --- 额度释放（替代旧的"重置"判定；滑动窗口下这才是真实可用信号）---
    const rel5 = releaseCheck(st, 'codex5h', u5, rel);
    if (rel5) {
      push('codexRelease:5h', 'P1', 'Codex 5h 额度已释放 ✅',
        `剩余从 ${Math.round(100 - rel5.peak)}% 回升到 ${Math.round(100 - u5)}%，可以继续使用`);
    }
    const relW = releaseCheck(st, 'codexWeek', uw, rel);
    if (relW) {
      push('codexRelease:week', 'P1', 'Codex 周额度已释放 ✅',
        `近 7 天剩余从 ${Math.round(100 - relW.peak)}% 回升到 ${Math.round(100 - uw)}%`);
    }

    // --- 阈值（armed + 滞回：穿越一次只提醒一次）；一律以「剩余额度」表述 ---
    armedGate(st, 'codex5h.80', u5, num(th.codex5hWarn, 80), num(hys.codex5h, 5), () =>
      push('codexThreshold:5h.80', 'P1', `Codex 5h 剩余额度不足 ${Math.max(0, 100 - Math.round(num(th.codex5hWarn, 80)))}%`,
        `近 5 小时窗口已用 ${Math.round(u5)}% · 剩余约 ${Math.max(0, 100 - Math.round(u5))}%`));
    armedGate(st, 'codex5h.95', u5, num(th.codex5hCritical, 95), num(hys.codex5hCritical, 3), () =>
      push('codexThreshold:5h.95', 'P0', `Codex 5h 剩余额度不足 ${Math.max(0, 100 - Math.round(num(th.codex5hCritical, 95)))}% ⚠`,
        `近 5 小时窗口已用 ${Math.round(u5)}% · 接近上限，继续使用可能触发限流`));
    armedGate(st, 'codexWeek.80', uw, num(th.codexWeekWarn, 80), num(hys.codexWeek, 5), () =>
      push('codexThreshold:week.80', 'P1', `Codex 近 7 天剩余额度不足 ${Math.max(0, 100 - Math.round(num(th.codexWeekWarn, 80)))}%`,
        `近 7 天已用 ${Math.round(uw)}% · 剩余约 ${Math.max(0, 100 - Math.round(uw))}%`));

    // --- 限流（边沿进入 + 同一 key 冷却节流"仍在限流"，避免紧跟首条提醒重复）---
    if (curCodex.limitReached) {
      const first = !st.limit.reached;
      st.limit.reached = true;
      push('codexLimit:active', 'P0',
        first ? 'Codex 已触发限流 ⛔' : 'Codex 仍在限流中 ⛔',
        first ? '额度恢复后会自动提醒' : '限流持续中，建议稍后再试');
    } else {
      if (st.limit.reached) push('codexLimit:recovered', 'P1', 'Codex 限流已解除 ✅', '额度已恢复可用');
      st.limit.reached = false;
    }

    // --- 订阅闲置（用本地 7 天历史的峰值判断，与滑动窗口语义解耦）---
    const peak7d = stats.codexMax5h7d;
    if (typeof peak7d === 'number' && peak7d < 5) {
      push('codexIdle:7d', 'P2', 'Codex 订阅似乎闲着 💤',
        `最近 7 天 5h 窗口用量峰值仅 ${Math.round(peak7d)}%，考虑是否需要继续 Plus 订阅`);
    }

    // --- 触顶预测（按近 N 分钟斜率外推；armed 闸门保证持续高速消耗时不会反复提醒）---
    const pred = stats.trend;
    if (cfg.predict?.enabled !== false && pred && pred.projectedMinutes != null) {
      const minUsed = num(cfg.predict?.minUsedPercent, 40);
      const warnMin = num(cfg.predict?.warnMinutes, 30);
      const near = u5 >= minUsed && pred.projectedMinutes <= warnMin;
      armedGate(st, 'codexPredict', near ? 1 : 0, 1, 1, () =>
        push('codexPredict:5h', 'P1', `Codex 5h 额度预计 ${pred.projectedMinutes} 分钟后触顶 ⏳`,
          `当前已用 ${Math.round(u5)}% · 近 ${num(cfg.predict?.slopeWindowMinutes, 30)} 分钟约 ${pred.slopePerMin.toFixed(2)} 个百分点/分钟`));
    }
  }

  // ================= 余额（GLM / DeepSeek）=================
  // 被用户「不再提醒」抑制的平台跳过提醒（余额与消耗速率仍照常采集/展示，充值后由 collect.mjs 自动解除）
  const sup = state.suppression ?? {};
  if (sampled.deepseek !== false && !sup.deepseek) {
    balanceRules(push, cur.deepseek, stats.burn?.deepseek, {
      name: 'DeepSeek', slot: 'ds',
      depleted: 'DeepSeek 余额已耗尽（¥0.00）', depletedBody: 'DeepSeek API 调用将失败，需充值后恢复',
      critical: num(th.dsCritical, 10), low: num(th.dsLow, 20),
    });
  }
  if (sampled.glm !== false && !sup.glm) {
    balanceRules(push, cur.glm, stats.burn?.glm, {
      name: 'GLM', slot: 'glm',
      depleted: 'GLM 余额已耗尽（¥0.00）', depletedBody: 'GLM API 调用将失败，需充值后恢复',
      critical: num(th.glmCritical, 2), low: num(th.glmLow, 5),
    });
  }

  // ================= 异常消耗（当日花费显著偏离近 7 日均值）=================
  for (const name of ['deepseek', 'glm']) {
    const a = stats.anomaly?.[name];
    if (!cfg.anomaly?.enabled || !a) continue;
    if (sampled[name] === false || sup[name]) continue;
    const factor = num(cfg.anomaly?.factor, 3), minAmount = num(cfg.anomaly?.minAmount, 5);
    const hot = a.mean > 0 && a.today > a.mean * factor && a.today > minAmount;
    armedGate(st, `anomaly.${name}`, hot ? 1 : 0, 1, 1, () =>
      push(`anomaly:${name}`, 'P1', `${name === 'glm' ? 'GLM' : 'DeepSeek'} 今日消耗异常 💸`,
        `今天已花 ¥${a.today.toFixed(2)}，是近 7 日均值（¥${a.mean.toFixed(2)}）的 ${a.ratio} 倍`));
  }

  // ================= 采集健康（滞回：连续失败才报，连续成功才算恢复）=================
  for (const name of ['codex', 'deepseek', 'glm']) {
    if (sampled[name] === false) continue; // 本轮未采样，不计入健康统计
    // 平台被关闭 / 未配置密钥：不是采集故障——不累计计数、不提醒（看板以「已关闭」「未配置」呈现）
    if (cur[name]?.disabled === true || cur[name]?.unconfigured === true) {
      st.health[name] = { fails: 0, succ: 0, alerted: false };
      continue;
    }
    const hs = st.health[name] ?? { fails: 0, succ: 0, alerted: false };
    const ok = cur[name]?.ok === true;
    if (ok) { hs.succ += 1; hs.fails = 0; } else { hs.fails += 1; hs.succ = 0; }
    const platformIv = name === 'codex' ? codexIv : balanceIv;

    if (hs.fails >= samples(hys.healthFailMinutes, platformIv)) {
      push(`health:${name}`, 'P0', `额度采集异常：${name}`,
        `已连续 ${hs.fails} 次失败 · ${state.health?.lastErrors?.[name] ?? ''}`);
      hs.alerted = true;
    } else if (hs.alerted && hs.succ >= samples(hys.healthRecoverMinutes, platformIv)) {
      push(`health:${name}.recovered`, 'P2', `额度采集已恢复 ✅ ${name}`, '数据恢复更新');
      hs.alerted = false;
    }
    st.health[name] = hs;
  }

  return { fired, alertState: st };
}

// ---- 内部实现 ----

function normalizeState(s) {
  const o = (s && typeof s === 'object') ? { ...s } : {};
  o.lastFiredAt = { ...(o.lastFiredAt ?? {}) };
  o.peak = { codex5h: 0, codexWeek: 0, ...(o.peak ?? {}) };
  o.armed = { 'codex5h.80': true, 'codex5h.95': true, 'codexWeek.80': true, ...(o.armed ?? {}) };
  o.limit = { reached: false, ...(o.limit ?? {}) };
  o.codexDeg = { degCount: 0, liveCount: 0, alerted: false, ...(o.codexDeg ?? {}) };
  o.health = { ...(o.health ?? {}) };
  return o;
}

function num(v, dflt = 0) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

// 峰值回落检测：命中则重置峰值并返回 {peak, used}
function releaseCheck(st, slot, used, rel) {
  const peak = Math.max(st.peak[slot] ?? 0, used);
  const hi = num(rel.peakHigh, 60), lo = num(rel.dropTo, 20), minDrop = num(rel.minDrop, 30);
  if (peak >= hi && used <= lo && (peak - used) >= minDrop) {
    st.peak[slot] = used;
    return { peak, used };
  }
  st.peak[slot] = peak;
  return null;
}

// armed/滞回闸门：≥阈值且已武装 → 触发并解除武装；回落到 阈值-hysteresis 以下 → 重新武装
function armedGate(st, slot, used, threshold, hysteresis, fire) {
  if (st.armed[slot] !== false) {
    if (used >= threshold) { st.armed[slot] = false; fire(); }
  } else if (used <= threshold - hysteresis) {
    st.armed[slot] = true;
  }
}

// 余额规则：耗尽(P0) / 紧急(P0) / 偏低(P1)，附消耗速率与预计可用天数
function balanceRules(push, res, burn, o) {
  if (!res?.ok) return;
  const bal = num(res.data?.balance ?? res.data?.totalBalance);
  const days = burn && burn.perDay > 0 ? Math.max(0, Math.floor(bal / burn.perDay)) : null;
  const tail = days != null
    ? `按近 3 天消耗 ¥${burn.perDay.toFixed(2)}/天，预计还可用约 ${days} 天`
    : '请及时充值';
  if (bal <= 0) push(`balanceRe:${o.slot}.depleted`, 'P0', o.depleted, o.depletedBody);
  else if (bal < o.critical) push(`balanceRe:${o.slot}.critical`, 'P0', `${o.name} 余额紧急：¥${bal.toFixed(2)}`, tail);
  else if (bal < o.low) push(`balanceRe:${o.slot}.low`, 'P1', `${o.name} 余额偏低：¥${bal.toFixed(2)}`, tail);
}
