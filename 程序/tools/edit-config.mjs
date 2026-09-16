// 看板内的配置编辑（经 aiquotaboard://config?set=key:value,key:value 调用）
// 白名单校验：只允许修改有限的几个数值项，避免协议被滥用写入任意配置。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, loadConfig, writeJsonAtomic } from '../lib/common.mjs';

// [最小值, 最大值] 白名单（含区间，闭区间）
// 数值型配置（带范围校验，防止看板传进来一个离谱的值把提醒搞坏）
const ALLOWED = {
  'thresholds.codex5hWarn': [50, 100],
  'thresholds.codex5hCritical': [50, 100],
  'thresholds.codexWeekWarn': [50, 100],
  'thresholds.dsLow': [1, 1000],
  'thresholds.dsCritical': [1, 1000],
  'thresholds.glmLow': [1, 1000],
  'thresholds.glmCritical': [1, 1000],
  'predict.warnMinutes': [5, 240],
  'predict.minUsedPercent': [10, 95],
  'anomaly.factor': [1.5, 10],
  'anomaly.minAmount': [1, 1000],
};

// 布尔开关：看板「配置」面板里的平台启停按钮走这里
// （平台开关直接影响采集，所以只允许白名单内的键，不接受任意布尔字段）
const ALLOWED_BOOL = ['platforms.codex', 'platforms.deepseek', 'platforms.glm'];

export function applyConfigEdits(spec) {
  const cfg = loadConfig();
  const applied = [];
  const rejected = [];
  for (const pair of String(spec).split(',')) {
    const i = pair.indexOf(':');
    if (i <= 0) continue;
    const key = pair.slice(0, i).trim();
    const rawText = pair.slice(i + 1).trim();
    const [section, field] = key.split('.');
    // 布尔分支必须在数值之前：Number('true') 是 NaN，会被下面当成"超出范围"误报
    if (ALLOWED_BOOL.includes(key)) {
      if (rawText !== 'true' && rawText !== 'false') { rejected.push(`${key}(只能是 true/false)`); continue; }
      cfg[section] = cfg[section] ?? {};
      cfg[section][field] = rawText === 'true';
      applied.push(`${key}=${rawText}`);
      continue;
    }
    const raw = Number(rawText);
    const range = ALLOWED[key];
    if (!range) { rejected.push(`${key}(不允许)`); continue; }
    if (!Number.isFinite(raw) || raw < range[0] || raw > range[1]) { rejected.push(`${key}(超出 ${range[0]}~${range[1]})`); continue; }
    cfg[section] = cfg[section] ?? {};
    cfg[section][field] = raw;
    applied.push(`${key}=${raw}`);
  }
  if (applied.length) writeJsonAtomic(CONFIG_FILE, cfg);
  return { applied, rejected };
}

// CLI：node 程序/tools/edit-config.mjs "thresholds.glmLow:8,anomaly.factor:4"
if (process.argv[1] && process.argv[1].endsWith('edit-config.mjs')) {
  const spec = process.argv[2] ?? '';
  const { applied, rejected } = applyConfigEdits(spec);
  console.log(`${new Date().toISOString()} 配置编辑：${applied.join(' ') || '(无)'}${rejected.length ? ' · 拒绝: ' + rejected.join(' ') : ''}`);
}
