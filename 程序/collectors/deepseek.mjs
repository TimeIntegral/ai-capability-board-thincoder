import { resolveApiKey } from '../lib/common.mjs';

// DeepSeek 余额：官方公开接口 GET /user/balance（Bearer API Key）
// 密钥来源（按优先级）：secrets.json → ThinCoder 配置 → 环境变量 DEEPSEEK_API_KEY
export async function collectDeepSeek(cfg) {
  const { key, source } = resolveApiKey('deepseek', cfg);
  const r = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error(`deepseek balance HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const info = j.balance_infos?.[0];
  if (!info) throw new Error('deepseek 响应中无 balance_infos');
  return {
    ok: true,
    keySource: source,   // 仅来源标签（不含密钥），便于看板/排查"密钥取到了哪一路"
    isAvailable: !!j.is_available,
    currency: info.currency,
    totalBalance: Number(info.total_balance),
    grantedBalance: Number(info.granted_balance),
    toppedUpBalance: Number(info.topped_up_balance),
  };
}

export function describeDeepSeek(d) {
  if (!d.ok) return '采集失败';
  return `DeepSeek 余额 ¥${d.totalBalance.toFixed(2)}（赠金 ¥${d.grantedBalance.toFixed(2)}）${d.isAvailable ? '' : ' ⛔ 账户不可用'}`;
}
