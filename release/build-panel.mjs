// 编译悬浮看板（构建机专用；发布层与安装层都不需要它）
//
// 为什么在 release/ 下：这一层已经是「只有构建机需要」的发布工具（与 make-portable.mjs 同族），
//   新增一个文件不用碰三层清单；源码放 程序/panel/（「仅供开发」条目），exe 落 程序/bin/（构建时加入）。
// 依赖：系统自带的 .NET Framework 4 编译器 + WPF 运行时程序集，零第三方依赖、不联网、不安装任何东西。
// 纪律（设计档 2.1.2 / A3）：编译只在 release/prepare.mjs 建出的**冻结工作树**里发生 ——
//   包里的 exe 必须能追到「这个提交」，绝不允许把开发目录里编好的 exe 打进包。
//   这条纪律由三层机器闸门守着（不靠「人记得把开发目录里那份删掉」）：
//     ① 本脚本：树不是链接工作树（开发主工作树）→ 当场拒绝；程序/panel/ 有未提交改动 → 拒绝；
//     ② release/publish.mjs：记录 tree.kind 不是冻结树 → 拒绝；开发目录里出现构建产物 → 拒绝；
//     ③ 程序/tools/test-panel.mjs 的 T5：开发目录里有产物、或编译没被拒绝 → 测试红。
//   要在本机看面板效果（不发布）：git worktree add --detach private/panel-run HEAD，
//   在那棵树里跑本脚本，起 private/panel-run/程序/bin/board.exe —— private/ 被 gitignore、也永远不进包。
// 用法：node release/build-panel.mjs [--verify]
//   --verify：只核对（记录里的源文件 SHA256 与当前树一致、exe 与记录一致），不重新编译。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { 树类型, gitOut } from './git-tree.mjs';

const root = path.dirname(import.meta.dirname);
const PANEL_DIR = path.join(root, '程序', 'panel');
const OUT_DIR = path.join(root, '程序', 'bin');
const EXE = path.join(OUT_DIR, 'board.exe');
const RECORD = path.join(OUT_DIR, 'panel-build.json');
// 系统目录：从环境变量取（不写死盘符字面量 —— 发布闸门的个人信息规则会挡下来）
const winDir = process.env.SystemRoot || process.env.WINDIR
  || path.join(`${process.env.SystemDrive ?? ''}${path.sep}`, 'Windows');
const NET_DIR = path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const CSC = path.join(NET_DIR, 'csc.exe');
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rel = p => path.relative(root, p).split(path.sep).join('/');
const die = msg => { console.error(`\n❌ 编译悬浮看板失败：${msg}`); process.exit(1); };

// ── 纪律闸门（A3）：编译只在冻结（链接）工作树里发生 ──────────────────────────
const tree = 树类型(root);
if (tree !== 'worktree') {
  die([
    `这里是${tree === 'primary' ? '开发（主）工作树' : '一个不是 git 仓库的目录'}：面板 exe 只在冻结提交上编（设计档 A3），开发目录不产 exe`,
    '   · 要出包：node release/prepare.mjs（它自己建冻结树并在里面编）',
    '   · 要看面板效果：git worktree add --detach private/panel-run HEAD，在那棵树里跑本脚本，起它的 程序/bin/board.exe',
  ].join('\n'));
}
// 源码必须是某个提交里的那份：有未提交改动时编出来的 exe 追不到提交（来源就断了）
const 脏源码 = (gitOut(root, ['status', '--porcelain', '--', '程序/panel']) ?? '').trim();
if (脏源码) {
  die([
    '程序/panel/ 下的源码有未提交改动，不能编进发布产物（来源必须是一个提交）：',
    ...脏源码.split('\n').slice(0, 6).map(l => `   ${l}`),
  ].join('\n'));
}

if (!fs.existsSync(CSC)) die(`找不到系统自带的编译器 ${CSC}（需要 Windows 10/11 + .NET Framework 4.x）`);
if (!fs.existsSync(PANEL_DIR)) die(`找不到面板源码目录 ${PANEL_DIR}`);
const sources = fs.readdirSync(PANEL_DIR).filter(f => f.endsWith('.cs')).sort();
if (!sources.length) die('面板源码目录里没有 .cs 文件');

// 参考程序集直接指到运行时目录（本机没有 v4.x targeting pack 也能编，实测见设计档 2.1.1）
const refs = [
  path.join(NET_DIR, 'WPF', 'PresentationFramework.dll'),
  path.join(NET_DIR, 'WPF', 'PresentationCore.dll'),
  path.join(NET_DIR, 'WPF', 'WindowsBase.dll'),
  path.join(NET_DIR, 'System.Xaml.dll'),
  path.join(NET_DIR, 'System.dll'),
  path.join(NET_DIR, 'System.Core.dll'),
  path.join(NET_DIR, 'System.Xml.dll'),
  path.join(NET_DIR, 'System.Web.Extensions.dll'),   // JSON：.NET Framework 自带（不引第三方）
];
for (const r of refs) if (!fs.existsSync(r)) die(`缺少 .NET Framework 自带程序集：${r}`);

const record = () => ({
  schema: 1,
  commit: git(['rev-parse', 'HEAD']),
  // 这份 exe 是从哪种树里编出来的：发布闸门按它复核（不是冻结树 → 拒绝打包）。
  // clean 恒为真（上面有闸门拦着），写进记录是为了让闸门能独立复核一份**拿到的**记录。
  tree: { kind: tree, clean: !脏源码 },
  sources: sources.map(name => ({ path: `程序/panel/${name}`, sha256: sha256(path.join(PANEL_DIR, name)) })),
  compiler: { path: CSC, version: compilerVersion() },
  exe: '程序/bin/board.exe',
  exeSha256: fs.existsSync(EXE) ? sha256(EXE) : '',
  builtAtIso: new Date().toISOString(),
});

function git(args) {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim(); }
  catch { return ''; }
}
let cachedVersion = null;
function compilerVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const out = execFileSync(CSC, ['/?'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024 });
    cachedVersion = (String(out).split(/\r?\n/).find(l => /Compiler|编译器/.test(l)) || '').trim() || '未知';
  } catch (e) {
    const text = String((e.stdout ?? '') + (e.stderr ?? ''));
    cachedVersion = (text.split(/\r?\n/).find(l => /Compiler|编译器/.test(l)) || '').trim() || '未知';
  }
  return cachedVersion;
}

if (process.argv.includes('--verify')) {
  if (!fs.existsSync(RECORD)) die('没有 程序/bin/panel-build.json —— 还没编译过');
  const rec = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
  const problems = [];
  if (rec.tree?.kind !== 'worktree') problems.push(`这份记录不是在冻结构建树里编出来的（tree.kind=${rec.tree?.kind ?? '（缺）'}）—— 发布产物只能出自冻结提交`);
  else if (rec.tree.clean !== true) problems.push('这份记录说编译时源码不干净 —— 来源必须是一个提交');
  if (!fs.existsSync(EXE)) problems.push('exe 不在（记录说编过）');
  else if (rec.exeSha256 !== sha256(EXE)) problems.push(`exe 的 SHA256 与记录不符（记录 ${String(rec.exeSha256).slice(0, 12)}… / 实际 ${sha256(EXE).slice(0, 12)}…）`);
  for (const s of rec.sources ?? []) {
    const p = path.join(root, ...s.path.split('/'));
    if (!fs.existsSync(p)) { problems.push(`源文件不在：${s.path}`); continue; }
    if (sha256(p) !== s.sha256) problems.push(`源文件与记录不符（漂移）：${s.path}`);
  }
  if (problems.length) die(problems.join('；'));
  console.log(`✅ 来源核对通过：exe ${sha256(EXE).slice(0, 12)}… · 提交 ${String(rec.commit).slice(0, 8)} · 源文件 ${rec.sources.length} 个 · ${rec.compiler.version}`);
  process.exit(0);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const args = ['/nologo', '/target:winexe', '/optimize+', '/platform:anycpu', '/langversion:5',
  '/out:' + EXE, ...refs.map(r => '/r:' + r), ...sources.map(s => path.join(PANEL_DIR, s))];
try {
  execFileSync(CSC, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
} catch (e) {
  die(`csc 退出码非 0（编译错误见上）`);
}
if (!fs.existsSync(EXE)) die('编译没有产出 exe');
const rec2 = record();
fs.writeFileSync(RECORD, JSON.stringify(rec2, null, 2) + '\n', 'utf8');
console.log(`✅ 悬浮看板已编译：${rel(EXE)}（${(fs.statSync(EXE).size / 1024).toFixed(1)}KB）`);
console.log(`   来源记录：${rel(RECORD)}（提交 ${String(rec2.commit).slice(0, 8) || '（不在 git 仓库里）'} · 源文件 ${rec2.sources.length} 个 · exe SHA256 ${rec2.exeSha256.slice(0, 12)}…）`);
console.log(`   编译器：${rec2.compiler.version}`);
