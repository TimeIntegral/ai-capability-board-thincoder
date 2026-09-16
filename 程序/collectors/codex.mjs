import { execFileSync } from 'node:child_process';
import { readCodexAuth } from '../lib/common.mjs';

// Codex 实时额度：chatgpt.com/backend-api/codex/usage
// 鉴权：~/.codex/auth.json 的 OAuth access_token（Codex 自动续期，每次现读）
// 网络：Node fetch 不走系统代理，用系统 curl；先走配置/系统代理，失败再试直连（TUN 模式）。
export async function collectCodex(cfg) {
  const { accessToken, accountId } = readCodexAuth(cfg.codexHome);

  const attempt = (proxy) => {
    const args = ['-s'];
    if (proxy) args.push('-x', proxy);
    args.push('-m', '12', '-w', '\n__HTTP__%{http_code}',
      'https://chatgpt.com/backend-api/codex/usage',
      '-H', `Authorization: Bearer ${accessToken}`,
      '-H', `ChatGPT-Account-Id: ${accountId}`,
      '-H', 'Accept: application/json',
      '-H', 'User-Agent: codex_cli_rs');
    let raw = '', err = null;
    try {
      raw = execFileSync('curl', args, { encoding: 'utf8' });
    } catch (e) {
      // curl 非零退出（瞬时网络错误/HTTP 错误）时 stdout 里可能仍有完整响应，先解析再决定是否抛
      raw = String(e.stdout ?? '');
      err = e;
    }
    const [body, code] = String(raw).split('\n__HTTP__');
    if (code === '200' && body.trim().startsWith('{')) return JSON.parse(body);
    throw err ?? new Error(`codex usage HTTP ${code || '?'}: ${String(body).slice(0, 200).replace(/\s+/g, ' ')}`);
  };

  const candidates = [cfg.proxy, null].filter((v, i, a) => a.indexOf(v) === i); // 代理 → 直连
  let lastErr;
  for (const proxy of candidates) {
    try { return shapeCodex(attempt(proxy)); } catch (e) { lastErr = e; }
  }
  try { return shapeCodex(attempt(candidates[0] ?? null)); } catch (e) { lastErr = e; } // 瞬时抖动再给一次机会

  // 关键：execFileSync 的报错信息含完整命令行（带 token），绝不外传——抛净化后的错误
  throw new Error(`codex usage 请求失败（代理+直连均已尝试）：${String(lastErr?.status ?? lastErr?.code ?? 'network error')}`);
}

function shapeCodex(j) {
  const rl = j.rate_limit ?? {};
  const p = rl.primary_window ?? {};
  const s = rl.secondary_window ?? {};
  return {
    ok: true,
    plan: j.plan_type,
    email: j.email,
    fiveHour: {
      usedPercent: p.used_percent ?? null,
      windowMinutes: Math.round((p.limit_window_seconds ?? 18000) / 60),
      resetAt: p.reset_at ? p.reset_at * 1000 : null,
      resetAfterSeconds: p.reset_after_seconds ?? null,
    },
    weekly: {
      usedPercent: s.used_percent ?? null,
      windowMinutes: Math.round((s.limit_window_seconds ?? 604800) / 60),
      resetAt: s.reset_at ? s.reset_at * 1000 : null,
      resetAfterSeconds: s.reset_after_seconds ?? null,
    },
    limitReached: !!rl.limit_reached,
    limitReachedType: rl.rate_limit_reached_type ?? null,
    credits: { hasCredits: !!rl.credits?.has_credits, balance: String(rl.credits?.balance ?? '0') },
    modelUsage: Object.fromEntries(Object.entries(j.model_usage ?? {}).map(([m, v]) => [m, { available: !!v.available, availableAt: v.available_at }])),
  };
}
