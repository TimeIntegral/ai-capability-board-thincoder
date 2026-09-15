// 准备便携 Node 运行时（给发布包用）
//
// 为什么需要它：目标用户里有很多是不装开发环境的小白。项目本身是 Node 写的，
// 但让他先装 Node 再双击安装，多一道坎就少一半人。把 node.exe 打进发布包，
// 安装脚本优先用它 —— 解压双击即可，零依赖。
//
//   node release/make-portable.mjs                 # 默认版本
//   node release/make-portable.mjs --version v22.11.0
//   node release/make-portable.mjs --mirror https://nodejs.org/dist
//
// 安全：**校验和从官方 nodejs.org 取**，二进制可以从国内镜像下（快）——
// 两者分离，镜像被换包也过不了校验。下载到临时文件校验通过后才落到 runtime/。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const argOf = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ROOT = path.dirname(import.meta.dirname);
const RUNTIME = path.join(ROOT, 'runtime');
const TARGET = path.join(RUNTIME, 'node.exe');

const DEFAULT_VERSION = 'v22.11.0';                       // Node 22 为 LTS 线
const FILES = ['release/portable-node.json'];            // 记录来源，便于复现与排查

const cfgPath = path.join(ROOT, 'release', 'portable-node.json');
let saved = {};
try { saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* 首次运行 */ }

const version = argOf('--version') ?? saved.version ?? DEFAULT_VERSION;
const mirror = (argOf('--mirror') ?? saved.mirror ?? 'https://npmmirror.com/mirrors/node').replace(/\/$/, '');
const OFFICIAL = 'https://nodejs.org/dist';
const arch = process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
const force = args.includes('--force');

const log = m => console.log(m);
const mb = n => (n / 1048576).toFixed(1) + 'MB';

if (fs.existsSync(TARGET) && !force) {
  const st = fs.statSync(TARGET);
  log(`已存在 runtime/node.exe（${mb(st.size)}）—— 要重新下载加 --force`);
  process.exit(0);
}
fs.mkdirSync(RUNTIME, { recursive: true });

// ① 官方取校验和（可信源）
log(`① 从官方取校验和：${OFFICIAL}/${version}/SHASUMS256.txt`);
const sumsRes = await fetch(`${OFFICIAL}/${version}/SHASUMS256.txt`, { signal: AbortSignal.timeout(20000) });
if (!sumsRes.ok) throw new Error(`取校验和失败 HTTP ${sumsRes.status}（版本号写错？当前 ${version}）`);
const sums = await sumsRes.text();
const line = sums.split('\n').find(l => l.includes(`${arch}/node.exe`));
if (!line) throw new Error(`校验和文件里没有 ${arch}/node.exe`);
const expected = line.trim().split(/\s+/)[0];
log(`   期望 SHA256 ${expected.slice(0, 24)}…`);

// ② 下载二进制（镜像优先，失败回退官方）
const sources = [...new Set([`${mirror}/${version}/${arch}/node.exe`, `${OFFICIAL}/${version}/${arch}/node.exe`])];
const tmp = TARGET + '.part';
let ok = false;
for (const url of sources) {
  try {
    log(`② 下载 ${url}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
    if (!res.ok) { log(`   HTTP ${res.status}，换下一个源`); continue; }
    const total = Number(res.headers.get('content-length')) || 0;
    const buf = Buffer.from(await res.arrayBuffer());
    if (total && buf.length !== total) { log(`   长度不符（${buf.length} vs ${total}），换下一个源`); continue; }
    fs.writeFileSync(tmp, buf);
    log(`   已下载 ${mb(buf.length)}`);
    ok = true;
    break;
  } catch (e) { log(`   失败：${String(e.message).slice(0, 60)}，换下一个源`); }
}
if (!ok) throw new Error('所有下载源都失败——检查网络或代理后重试');

// ③ 校验（先校验临时文件，通过了才落正式位置）
log('③ 校验 SHA256');
const actual = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
if (actual !== expected) {
  fs.rmSync(tmp, { force: true });
  throw new Error(`校验不通过！期望 ${expected}\n             实际 ${actual}\n（文件已删除，可能存在中间人篡改或镜像未同步）`);
}
fs.renameSync(tmp, TARGET);
log('   校验通过 ✓');

// ④ 记录来源（复现与排查用）
fs.writeFileSync(cfgPath, JSON.stringify({
  $comment: '便携 Node 的来源记录：make-portable.mjs 下载时写入；安装脚本据此说明运行时来源',
  version, arch, mirror,
  sha256: expected,
  sizeBytes: fs.statSync(TARGET).size,
  fetchedAtMs: Date.now(),
}, null, 2) + '\n');

log(`\n完成：runtime/node.exe（${mb(fs.statSync(TARGET).size)}，来自 Node ${version} ${arch}）`);
log('提示：runtime/ 已被 .gitignore 排除，它只会打进发布包，不进代码仓库。');
log('      安装脚本会自动优先使用它；没有它时回退到系统安装的 node。');
