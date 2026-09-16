// 注册通知应用名（AppUserModelID）——让 Windows 通知显示为「AI 能力看板」而不是 Windows PowerShell
// 用法：node 程序/tools/register-app-id.mjs
// 说明：非打包桌面应用需要在 HKCU\Software\Classes\AppUserModelId\<AppId> 下登记 DisplayName，
//       否则自定义 AppId 的通知可能不显示（toast 发送失败时会自动回退到 PowerShell AppId）。
import { execFileSync } from 'node:child_process';

const APP_ID = 'AIQuotaBoard';
const DISPLAY_NAME = 'AI 能力看板';
const KEY = `HKCU\\Software\\Classes\\AppUserModelId\\${APP_ID}`;

// ⚠️ 校验不能用 `reg query` 的输出来比对：它按控制台代码页输出中文，
//    在非 UTF-8 代码页下会变成乱码，导致"明明写对了却报失败"（环境相关的假故障）。
// 改用 PowerShell 读注册表（Unicode 安全），并用码点比对，彻底避开代码页。
function verify() {
  const script = `
$v = (Get-ItemProperty -Path 'HKCU:\\Software\\Classes\\AppUserModelId\\${APP_ID}' -Name DisplayName -ErrorAction SilentlyContinue).DisplayName
if ($null -eq $v) { 'MISSING' } else { ($v.ToCharArray() | ForEach-Object { [int]$_ }) -join ',' }
`;
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', b64],
    { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const expected = [...DISPLAY_NAME].map(c => c.codePointAt(0)).join(',');
  return { out, expected, ok: out === expected };
}

try {
  execFileSync('reg', ['add', KEY, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', DISPLAY_NAME, '/f'], { encoding: 'utf8', timeout: 15000 });
  const v = verify();
  if (v.ok) console.log(`✅ 已注册通知应用名：${DISPLAY_NAME}`);
  else { console.error(`⚠️ 注册结果异常：期望码点 [${v.expected}]，实际 [${v.out}]`); process.exit(1); }
} catch (e) {
  console.error('❌ 注册失败:', String(e.message ?? e).slice(0, 200));
  process.exit(1);
}
