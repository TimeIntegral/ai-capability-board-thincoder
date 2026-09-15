// 余额提醒开关（按平台）：
//   node balance-mute.mjs suppress glm      → 不再提醒 GLM 余额（直到下次充值自动恢复）
//   node balance-mute.mjs off glm           → 立即恢复 GLM 余额提醒
//   node balance-mute.mjs off all           → 全部恢复
//   node balance-mute.mjs status            → 查看当前状态
import { loadConfig, loadSuppression, suppressPlatform, clearSuppression, readJsonSafe, DATA_DIR, fmtLocal } from './lib/common.mjs';

const NAMES = { glm: 'GLM', deepseek: 'DeepSeek', ds: 'DeepSeek' };
const [, , action, arg] = process.argv;

const curBalance = platform => {
  const st = readJsonSafe(`${DATA_DIR}\\state.json`) ?? {};
  const res = st.current?.[platform];
  if (!res?.ok) return null;
  return Number(platform === 'glm' ? res.data?.balance : res.data?.totalBalance);
};

function status() {
  const sup = loadSuppression();
  const keys = Object.keys(sup);
  if (!keys.length) { console.log('🔔 所有平台的余额提醒均开启'); return; }
  for (const [p, v] of Object.entries(sup)) {
    const bal = curBalance(p);
    const recharged = bal != null && bal > Number(v.balanceAt) + 0.01;
    console.log(`🔕 ${NAMES[p] ?? p} 余额提醒已关闭（自 ${fmtLocal(v.atMs)} 起，当时余额 ¥${Number(v.balanceAt).toFixed(2)}）`);
    console.log(recharged ? `   ⚠ 检测到余额已回升，下次采集会自动恢复提醒` : `   当前余额 ¥${bal != null ? bal.toFixed(2) : '—'} · 充值后自动恢复`);
  }
  console.log('\n恢复：node balance-mute.mjs off <平台>');
}

if (action === 'status' || !action) {
  status();
} else if (action === 'suppress') {
  const p = (arg ?? '').toLowerCase();
  if (!p || !['glm', 'deepseek', 'ds'].includes(p)) { console.error('用法：node balance-mute.mjs suppress <glm|deepseek>'); process.exit(1); }
  const key = p === 'ds' ? 'deepseek' : p;
  const bal = curBalance(key);
  const rec = suppressPlatform(key, bal ?? 0);
  console.log(`🔕 已关闭 ${NAMES[key]} 余额提醒（当前余额 ¥${bal != null ? bal.toFixed(2) : '—'}）`);
  console.log('   下次充值（余额回升）会自动恢复；也可随时运行 off 恢复。');
} else if (action === 'off') {
  const p = (arg ?? 'all').toLowerCase();
  if (p === 'all') {
    const sup = loadSuppression();
    const keys = Object.keys(sup);
    for (const k of keys) clearSuppression(k);
    console.log(keys.length ? `🔔 已恢复全部余额提醒（${keys.join(', ')}）` : '🔔 本就没有关闭的平台');
  } else {
    const key = p === 'ds' ? 'deepseek' : p;
    console.log(clearSuppression(key) ? `🔔 已恢复 ${NAMES[key]} 余额提醒` : `🔔 ${NAMES[key]} 余额提醒本就开启`);
  }
} else {
  console.error(`未知操作 "${action}"（可用：suppress / off / status）`);
  process.exit(1);
}
