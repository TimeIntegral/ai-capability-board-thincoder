import { resolveApiKey, fmtLocal } from '../lib/common.mjs';

// 智谱 GLM：非公开 web 接口（前端逆向），API Key 鉴权。失效时抛错（上层降级处理）。
const B = 'https://www.bigmodel.cn/api';
const H = (key) => ({
  Authorization: `Bearer ${key}`,
  Accept: 'application/json',
  Referer: 'https://www.bigmodel.cn/finance-center/finance/overview',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0',
});

async function bizGet(key, url) {
  const r = await fetch(url, { headers: H(key), signal: AbortSignal.timeout(12000) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`glm ${url} 非 JSON 响应 HTTP ${r.status}: ${text.slice(0, 120)}`); }
  if (j.code && j.code !== 200) throw new Error(`glm ${url} code=${j.code} msg=${j.msg}`);
  return j.data ?? j;
}

// 密钥来源（按优先级）：secrets.json → ThinCoder 配置 → 环境变量 GLM_API_KEY
export async function collectGlm(cfg) {
  const { key, source } = resolveApiKey('glm', cfg);
  const rep = await bizGet(key, `${B}/biz/account/query-customer-account-report`);
  // 资源包到期（充值记录里带 expiryTime）——失败不阻塞主数据
  let packs = null;
  try {
    const list = await bizGet(key, `${B}/biz/recharge/user-recharge-list`);
    const rows = (list.rows ?? []).filter(x => x.payStatus === 'SUCCESS' && x.expiryTime);
    packs = rows.map(x => ({
      amount: x.totalAmount,
      paidAt: x.tradeSuccessTime,
      expiryTime: x.expiryTime,
      expiryStatus: x.expiryStatus,
    }));
  } catch { packs = null; }
  return {
    ok: true,
    keySource: source,  // 仅来源标签（不含密钥），便于看板/排查"密钥取到了哪一路"
    customerName: null, // 不需要展示用户名
    balance: rep.balance,
    availableBalance: rep.availableBalance,
    rechargeAmount: rep.rechargeAmount,
    giveAmount: rep.giveAmount,
    totalSpendAmount: rep.totalSpendAmount,
    frozenBalance: rep.frozenBalance,
    creditStatus: rep.creditStatus,
    packs,
  };
}

export function describeGlm(d) {
  if (!d.ok) return '采集失败';
  let s = `GLM 余额 ¥${Number(d.balance).toFixed(2)}（累计充值 ¥${Number(d.rechargeAmount).toFixed(2)} / 消费 ¥${Number(d.totalSpendAmount).toFixed(2)}）`;
  if (d.packs?.length) {
    const p = d.packs[0];
    s += `\n  资源包 ¥${p.amount}：${p.expiryTime} ${p.expiryStatus}`;
  }
  return s;
}
