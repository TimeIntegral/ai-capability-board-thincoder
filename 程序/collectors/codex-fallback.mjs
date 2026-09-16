import fs from 'node:fs';
import path from 'node:path';
import { humanDuration } from '../lib/common.mjs';

// Codex 降级数据源：解析 ~/.codex/sessions 最新会话文件尾部的 rate_limits 快照。
// 用途：chatgpt.com 后端接口不可达时（代理节点失效等），提供最后已知额度 + 快照时间。
// 局限：快照只在 Codex 会话活动时更新——「实时性 = 你上次用 Codex 的时刻」。

export function collectCodexFallback(codexHome) {
  const root = path.join(codexHome, 'sessions');
  const files = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try { files.push({ p, size: fs.statSync(p).size, mtimeMs: fs.statSync(p).mtimeMs }); } catch { /* 跳过 */ }
      }
    }
  })(root);
  if (!files.length) throw new Error('sessions 目录无会话文件');
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const f of files.slice(0, 3)) { // 最新 3 个文件里找 rate_limits
    const rl = readLastRateLimits(f);
    if (rl) return rl;
  }
  throw new Error('最近会话文件中无 rate_limits 快照');
}

function readLastRateLimits(f) {
  const len = Math.min(f.size, 2 * 1024 * 1024);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(f.p, 'r');
  try { fs.readSync(fd, buf, 0, len, f.size - len); } finally { fs.closeSync(fd); }
  const lines = buf.toString('utf8').split('\n').filter(l => l.includes('"rate_limits"'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(lines[i].trim());
      const rl = obj?.payload?.rate_limits;
      if (!rl) continue;
      const tsMs = Date.parse(obj.timestamp);
      const p = rl.primary ?? {}, s = rl.secondary ?? {};
      const now = Date.now();
      return {
        ok: true,
        source: 'session-fallback',
        snapshotAtMs: tsMs,
        snapshotAgeMinutes: Math.round((now - tsMs) / 60000),
        plan: rl.plan_type ?? null,
        email: null,
        fiveHour: {
          usedPercent: p.used_percent ?? null,
          windowMinutes: p.window_minutes ?? 300,
          resetAt: p.resets_at ? p.resets_at * 1000 : null,
          resetAfterSeconds: p.resets_at ? Math.max(0, p.resets_at * 1000 - now) : null,
        },
        weekly: {
          usedPercent: s.used_percent ?? null,
          windowMinutes: s.window_minutes ?? 10080,
          resetAt: s.resets_at ? s.resets_at * 1000 : null,
          resetAfterSeconds: s.resets_at ? Math.max(0, s.resets_at * 1000 - now) : null,
        },
        limitReached: rl.rate_limit_reached_type != null,
        limitReachedType: rl.rate_limit_reached_type ?? null,
        credits: { hasCredits: !!rl.credits?.has_credits, balance: String(rl.credits?.balance ?? '0') },
        modelUsage: {},
      };
    } catch { /* 半行跳过 */ }
  }
  return null;
}

export function describeCodexFallback(d) {
  return `Codex[降级] 5h=${d.fiveHour.usedPercent}% 周=${d.weekly.usedPercent}%（快照 ${d.snapshotAgeMinutes} 分钟前）`;
}
