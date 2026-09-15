// 注册 URL 协议 aiquotaboard:// —— 让通知按钮 / 看板按钮能直接执行「不再提醒余额」等动作
// 用法：node tools/register-protocol.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(import.meta.dirname);
const SCHEME = 'aiquotaboard';
const KEY = `HKCU\\Software\\Classes\\${SCHEME}`;
const VBS = path.join(ROOT, '运行协议.vbs');

if (!fs.existsSync(VBS)) { console.error(`❌ 未找到协议处理器: ${VBS}`); process.exit(1); }

const reg = args => execFileSync('reg', args, { encoding: 'utf8', timeout: 15000 });

try {
  reg(['add', KEY, '/ve', '/t', 'REG_SZ', '/d', 'URL:AI Quota Board', '/f']);
  reg(['add', KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f']);
  reg(['add', `${KEY}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', `wscript.exe "${VBS}" "%1"`, '/f']);
  const out = reg(['query', `${KEY}\\shell\\open\\command`, '/ve']);
  const ok = out.includes('运行协议.vbs') || out.includes(SCHEME);
  console.log(ok ? `✅ 已注册 URL 协议：${SCHEME}://（按钮动作可用）` : `⚠️ 注册结果异常:\n${out}`);
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('❌ 协议注册失败:', String(e.message ?? e).slice(0, 200));
  process.exit(1);
}
