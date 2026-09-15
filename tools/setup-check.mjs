// 环境探测：把「这台电脑已经有什么」写进 data/setup-status.json（看板内的配置向导读它）
// 用法：node tools/setup-check.mjs   （无参数；退出码 0 = 已写盘；字段契约见设计档 2.2.3）
//
// 纪律（NFR-1 / NFR-5）：只报「有没有、从哪来、多长」，永不打印/落盘任何密钥值；
// 不修改 config.json / secrets.json / state.json（只读）；错误文本先脱敏再上屏。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIG_FILE, DATA_DIR, ROOT_DIR, loadConfig, platformEnabled, resolveApiKey, readCodexAuth, writeJsonAtomic } from '../lib/common.mjs';
import { maskSecrets, sourceLabel } from './first-run-check.mjs';

const STATUS_FILE = path.join(DATA_DIR, 'setup-status.json');
const TASK_NAME = 'AI-Capability-Board-Collect';   // 与 tools/install.mjs:17 的常量保持一致

const safe = fn => { try { return fn(); } catch { return null; } };

// config.json 的可解析性：loadConfig 会静默回退默认值，不能拿它的结果判断——自读原文试解析
function configParse() {
  if (!fs.existsSync(CONFIG_FILE)) return 'missing';
  try { JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); return 'ok'; } catch { return 'broken'; }
}

function detectCodex(cfg) {
  const p = path.join(cfg.codexHome, 'auth.json');
  if (!fs.existsSync(p)) return { found: false, note: '没找到登录信息（要先去 Codex 客户端登录一次）' };
  try { readCodexAuth(cfg.codexHome); return { found: true, note: '已检测到本机 Codex 登录信息' }; }
  catch { return { found: false, note: '登录信息不完整（去 Codex 客户端登录一次）' }; }
}

function detectKey(name, cfg) {
  try {
    const { key, source } = resolveApiKey(name, cfg);
    return { found: true, source, length: key.length, note: `已找到密钥（来源：${sourceLabel(source)}，长度 ${key.length}）` };
  } catch (e) {
    if (e?.code === 'NO_KEY') {
      const broken = /解析失败/.test(String(e?.message ?? ''));
      return { found: false, note: broken ? '密钥文件坏了、读不出来（向导里可以重新填）' : '没找到密钥' };
    }
    return { found: false, note: `密钥读取出错：${maskSecrets(e?.message ?? e)}`.slice(0, 120) };
  }
}

// 只扫键名集合，不读任何值
function scanSecrets() {
  const p = path.join(ROOT_DIR, 'secrets.json');
  if (!fs.existsSync(p)) return { exists: false, platforms: [] };
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { exists: true, platforms: (j && typeof j === 'object' && !Array.isArray(j)) ? Object.keys(j) : [] };
  } catch { return { exists: true, platforms: [] }; }
}

function taskRegistered() {
  try {
    execFileSync('schtasks', ['/Query', '/TN', TASK_NAME], { stdio: 'ignore', timeout: 15000 });
    return true;   // 真实查一次计划任务：开启状态一律以实查为准，不以「点过按钮」为准
  } catch { return false; }
}

function lastCollectAt() {
  const s = safe(() => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8')));
  return Number.isFinite(Number(s?.collectedAtMs)) ? Number(s.collectedAtMs) : null;
}

const cfg = loadConfig();
const status = {
  checkedAtMs: Date.now(),
  platforms: { codex: platformEnabled(cfg, 'codex'), deepseek: platformEnabled(cfg, 'deepseek'), glm: platformEnabled(cfg, 'glm') },
  config: { parse: configParse() },
  codex: detectCodex(cfg),
  deepseek: detectKey('deepseek', cfg),
  glm: detectKey('glm', cfg),
  secrets: scanSecrets(),
  autoRun: { taskRegistered: taskRegistered(), taskName: TASK_NAME },
  lastCollect: { atMs: lastCollectAt() },
  runtime: { nodeVersion: process.version, portable: process.execPath.toLowerCase().includes(`${path.sep}runtime${path.sep}`) },
};
fs.mkdirSync(DATA_DIR, { recursive: true });
writeJsonAtomic(STATUS_FILE, status);
// stdout 一行摘要（进 data/protocol.log）——只报状态与来源，不含任何密钥值
console.log(`${new Date().toISOString()} 环境探测：配置=${status.config.parse} 计划任务=${status.autoRun.taskRegistered ? '已注册' : '未注册'} Codex=${status.codex.found ? '有' : '无'} DeepSeek=${status.deepseek.found ? '有密钥' : '无'} GLM=${status.glm.found ? '有密钥' : '无'}`);
