// 静音开关：临时关闭提醒（P0 是否穿透由 config.mute.allowP0 决定）
// 用法：
//   node mute.mjs            → 静音 2 小时（默认）
//   node mute.mjs 30m         → 静音 30 分钟
//   node mute.mjs 4h "开会"    → 静音 4 小时，附注
//   node mute.mjs off         → 取消静音
//   node mute.mjs status      → 查看当前状态
import { loadConfig, loadMute, saveMute, clearMute, fmtLocal } from './lib/common.mjs';

const [, , arg1, arg2] = process.argv;

function parseDuration(s) {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)?$/i.exec(String(s ?? '2h'));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'h').toLowerCase();
  return Math.round(n * (unit === 'm' ? 60 : unit === 'h' ? 3600 : 86400) * 1000);
}

function status() {
  const mute = loadMute();
  const cfg = loadConfig();
  if (mute.active) {
    const mins = Math.round((mute.until - Date.now()) / 60000);
    console.log(`🔇 已静音 · 剩余 ${mins} 分钟（至 ${fmtLocal(mute.until)}）${mute.note ? ' · ' + mute.note : ''}`);
    console.log(`   P0 提醒${cfg.mute?.allowP0 !== false ? '仍会送达' : '同样被静音'}`);
  } else {
    console.log('🔔 未静音（提醒正常送达）');
  }
}

if (arg1 === 'off' || arg1 === 'clear') {
  const done = clearMute();
  console.log(done ? '🔔 已取消静音' : '🔔 当前本就未静音');
} else if (arg1 === 'status' || arg1 === '--status') {
  status();
} else if (arg1) {
  const ms = parseDuration(arg1);
  if (!ms) { console.error(`无法解析时长 "${arg1}"（示例：30m / 2h / 1d）`); process.exit(1); }
  saveMute(Date.now() + ms, arg2 ?? null);
  status();
} else {
  saveMute(Date.now() + 2 * 3600 * 1000, null);
  status();
}
