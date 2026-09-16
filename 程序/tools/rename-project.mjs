// 项目文件夹改名（把「20260906-AI大模型额度看板」改成新名字）
//
// 为什么不在会话里直接跑：改名的目标目录里有正在运行的进程（本 agent 的工作目录、托盘脚本），
// Windows 不允许重命名被占用为工作目录的文件夹；而且改完之后当前会话的相对路径全部失效。
// 所以设计成**由用户在项目外**执行：
//
//   cd /d <项目所在目录>
//   node 20260906-AI大模型额度看板\程序\tools\rename-project.mjs 20260906-AI能力看板
//
// 步骤：停托盘 → 重命名文件夹 → 改写文件里的绝对路径 → 用新路径重跑安装（任务/快捷方式/协议/托盘）
// 加 --dry 只做检查与预演，不改任何东西。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { ROOT_DIR } from '../lib/common.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const newName = args.find(a => !a.startsWith('--'));
const OLD_ROOT = ROOT_DIR;                                   // 当前项目根（改名前）

const log = m => console.log(m);
const die = m => { console.error('❌ ' + m); process.exit(1); };

if (!newName) die('用法：node 程序/tools/rename-project.mjs <新文件夹名> [--dry]');
if (newName !== path.basename(newName)) die('新名字只能是单层文件夹名，不能带路径分隔符');
if (/[\\/:*?"<>|]/.test(newName)) die('新名字含 Windows 不允许的字符');

const parent = path.dirname(OLD_ROOT);
const NEW_ROOT = path.join(parent, newName);
if (NEW_ROOT.toLowerCase() === OLD_ROOT.toLowerCase()) die('新名字与当前名字相同');
if (fs.existsSync(NEW_ROOT)) die(`目标已存在：${NEW_ROOT}`);

// 必须在项目外执行：否则重命名会因目录被占用而失败
const cwdResolved = path.resolve(process.cwd()).toLowerCase();
if (cwdResolved === OLD_ROOT.toLowerCase() || cwdResolved.startsWith(OLD_ROOT.toLowerCase() + path.sep)) {
  die(`请在项目**外**执行（当前工作目录在项目内）：\n   cd /d "${parent}"\n   node "${path.relative(parent, path.join(OLD_ROOT, '程序', 'tools', 'rename-project.mjs'))}" ${newName}`);
}

log(`项目根：${OLD_ROOT}`);
log(`新名字：${newName}`);
log(`目标：  ${NEW_ROOT}\n`);

// 需要改写绝对路径的文本文件（只挑确定含项目路径的；.vbs/.ps1 用自身位置推导路径，无需改）
const REWRITE = ['config.json', 'config.template.json', 'dashboard-data.js', 'README.md', 'CHANGELOG.md'];
const EXT_OK = new Set(['.json', '.md', '.mjs', '.js', '.html', '.txt', '.bat']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.thincoder', 'data', 'backups']);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out); }
    else out.push(path.join(dir, e.name));
  }
  return out;
}

// 找出所有出现旧绝对路径的文本文件（报告用；实际只改 REWRITE 白名单里的）
const files = walk(OLD_ROOT);
const absHits = [];
for (const f of files) {
  if (!EXT_OK.has(path.extname(f).toLowerCase())) continue;
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (text.includes(OLD_ROOT) || text.includes(OLD_ROOT.replace(/\\/g, '/'))) absHits.push(path.relative(OLD_ROOT, f));
}
log(`含旧路径的文件（共 ${absHits.length} 个）：`);
for (const f of absHits) log(`   ${REWRITE.includes(f) ? '将改写' : '保留（运行时自动生成或已用相对路径）'}  ${f}`);
log('');

if (dry) { log('（--dry 预演结束，未做任何改动）'); process.exit(0); }

// 1) 停托盘（它把项目目录当成工作目录，会挡住重命名）
try {
  const script = `
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*tray.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
'托盘已停止'
`;
  const b64 = Buffer.from(script, 'utf16le').toString('base64');
  log('① ' + execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', b64], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] }).trim());
} catch (e) { log('① 停托盘失败（继续）：' + String(e.message).slice(0, 80)); }

// 2) 重命名文件夹
try {
  fs.renameSync(OLD_ROOT, NEW_ROOT);
  log(`② 已重命名 → ${NEW_ROOT}`);
} catch (e) {
  die(`重命名失败（目录可能仍被占用，请关闭占用它的程序后重试）：${e.message}`);
}

// 3) 改写文件里的绝对路径
let rewritten = 0;
for (const rel of REWRITE) {
  const f = path.join(NEW_ROOT, rel);
  if (!fs.existsSync(f)) continue;
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const next = text.split(OLD_ROOT).join(NEW_ROOT).split(OLD_ROOT.replace(/\\/g, '/')).join(NEW_ROOT.replace(/\\/g, '/'));
  if (next !== text) { fs.writeFileSync(f, next); rewritten += 1; }
}
log(`③ 已改写 ${rewritten} 个文件里的绝对路径`);

// 4) 用新路径重跑安装（重注册任务、快捷方式、协议、托盘）
try {
  const out = execFileSync('node', [path.join(NEW_ROOT, '程序', 'tools', 'install.mjs')], { encoding: 'utf8', timeout: 300000, cwd: NEW_ROOT });
  log('④ 重新注册完成：');
  for (const line of out.trim().split('\n')) log('   ' + line);
} catch (e) {
  log('④ 重新注册失败，请手动执行：node "' + path.join(NEW_ROOT, '程序', 'tools', 'install.mjs') + '"');
  log('   ' + String(e.message).slice(0, 200));
}

log('\n完成。注意：');
log('  · 当前会话的工作目录仍是旧路径，请**重启会话**再继续；');
log('  · 桌面快捷方式已指向新路径，双击即可打开看板。');
