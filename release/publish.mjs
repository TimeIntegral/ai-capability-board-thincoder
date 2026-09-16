// 发布闸门：本地 → GitHub 的唯一出口（本项目「本地领先是常态，GitHub 只放发布版」的机械保障）
// 用法：node release/publish.mjs [--dry] [--version X.Y.Z] [--tag]
//
// 流程（任何一步不过就 exit 1 拒绝发布，绝不放行）：
//   ① 取文件清单 —— git 将跟踪的全部文件（= 下一次 push 会公开的范围）
//   ② 审计       —— 密钥 / 个人信息 / 禁入路径，逐行扫（规则见 audit-rules.json）
//   ③ 版本一致性 —— VERSION ↔ CHANGELOG 顶部 ↔ 代码里的版本常量 ↔ --version
//   ④ 打包       —— dist/ai-capability-board-v<版本>.zip（代码 + 便携 Node 运行时；仅非 --dry）
//   ⑤ 打标签     —— git tag v<版本>（仅 --tag 且非 --dry）
//   ⑥ 下一步     —— 打印提交 / 推送 / 上传的具体命令
//
// 设计原则（见 release/README.md）：默认拒绝 —— 拿不准就报错停下。
// 零外部依赖：只用 node: 内置模块，唯一的子进程是 git。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(import.meta.dirname);              // 仓库根目录
const RULES_FILE = path.join(import.meta.dirname, 'audit-rules.json');
// 本机专属词表（gitignore，不进仓库）：用户名、项目根目录名、真实项目名。
// 为什么分开：通用规则表要公开，而它要拦的恰恰是这些不能公开的词；把词表写进公开文件
// 等于把"你的用户名 / 项目清单"一并公开。所以通用模式走 audit-rules.json，个人词走这一份。
const RULES_LOCAL_FILE = path.join(import.meta.dirname, 'audit-rules.local.json');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const DIST_DIR = path.join(ROOT, 'dist');
const RUNTIME_DIR = path.join(ROOT, 'runtime');               // 便携 Node 运行时（被 gitignore，随发布包走）
const RUNTIME_RECORD = path.join(import.meta.dirname, 'portable-node.json');
const ZIP_BASE = 'ai-capability-board';                      // 发布包名（纯 ASCII：别的解压工具不会把它弄乱码）
const SNIPPET_CHARS = 12;                                    // 命中片段最多显示几个字符（脱敏）
const MAX_SCAN_BYTES = 8 * 1024 * 1024;                      // 单文件审计上限：超过就拒绝，不跳过
const BIG_FILE_BYTES = 16 * 1024 * 1024;                     // 超过这个大小换较轻的压缩级别（80MB 的 node.exe 用 9 级要压很久）

// 自豁免：规则表必须原样列出「个人信息」词表（本机用户名、真实项目名…），否则它会拦下自己。
// 只豁免「个人信息」这一类 —— 密钥类照常扫该文件，因为规则表里本来就不该出现真密钥。
const SELF_EXEMPT = { 'release/audit-rules.json': ['个人信息'] };

// ── 打印小工具 ──────────────────────────────────────────────────────────
const blank = () => console.log('');
const stepHead = (no, title) => console.log(`\n${no} ${title}`);
const ok = msg => console.log(`   ✅ ${msg}`);
const info = msg => console.log(`   ${msg}`);
// 用「抛哨兵 + 设 exitCode」而不是 process.exit() 直接退：Windows 上 process.exit() 会截断还没 flush
// 的 stdout —— 而本脚本的产物恰恰是最后打印的下一步命令（用户要照抄，也可能被重定向进日志）。
const GATE_STOP = Symbol('闸门拒绝');
function die(msg) { console.error(`\n❌ ${msg}`); throw GATE_STOP; }
const firstLine = s => String(s ?? '').split('\n')[0].slice(0, 200);
const humanSize = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${(b / 1024).toFixed(1)}KB`);

function usage() {
  console.log(`发布闸门 —— 用法：node release/publish.mjs [--dry] [--version X.Y.Z] [--tag] [--no-runtime]

  （无参数）        审计 → 版本一致性 → 打包（代码 + 便携运行时）→ 打印下一步
  --dry             只审计 + 查版本 + 查运行时，不打包、不打标签
  --version X.Y.Z   声明「这次发的是 X.Y.Z」，必须与 VERSION 文件一致（不一致就拒绝）
  --tag             审计与打包都通过后打 git 标签 v<版本>（要求工作区干净，否则标签会指向上一个提交）
  --no-runtime      本次发布包不带便携 Node 运行时（没装 Node 的用户无法「解压即用」，请确认是有意的）
  -h, --help        显示这段帮助`);
}

// ── ① 文件清单 ──────────────────────────────────────────────────────────
// -z：NUL 分隔、不做引号转义。Windows 上 git 默认会把中文文件名输出成 "\345\256\211…" 这样的
// 八进制转义（本仓库有 7 个中文名文件），照原样读会读到不存在的路径 —— 必须用 -z 拿原始字节。
function listPublishFiles() {
  let buf;
  try {
    buf = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  } catch (e) {
    if (e.code === 'ENOENT') die('未找到 git：闸门需要 git 才知道「哪些文件会被跟踪并公开」');
    die(`git ls-files 失败：${firstLine(e.stderr?.toString?.() ?? e.message)}`);
  }
  const listed = buf.toString('utf8').split('\0').filter(Boolean);
  const files = [];
  const missing = [];   // 索引里有、磁盘上没了（已删除但还没提交）
  for (const rel of listed) (fs.existsSync(path.join(ROOT, rel)) ? files : missing).push(rel);
  return { files: files.sort(), missing: missing.sort() };
}

// 逐个读一遍：审计与「版本常量」检查共用，不重复读盘。
// 二进制（前 8KB 里出现 NUL 字节）不扫内容 —— 但会列出来，让人知道它进了发布包。
function readPublishables(files) {
  const texts = new Map();
  const binary = [];
  let bytes = 0;
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const size = fs.statSync(abs).size;
    if (size > MAX_SCAN_BYTES) {
      die(`${rel} 有 ${(size / 1048576).toFixed(1)}MB，超过审计上限 —— 不扫就不发布（删掉它，或调大 publish.mjs 里的 MAX_SCAN_BYTES）；大体积发布物（如便携 Node 运行时）不该进 git，应该由打包步骤单独处理`);
    }
    const buf = fs.readFileSync(abs);
    bytes += buf.length;
    if (buf.subarray(0, 8192).includes(0)) { binary.push(rel); continue; }
    texts.set(rel, buf.toString('utf8'));
  }
  return { texts, binary, bytes };
}

// ── ② 审计 ──────────────────────────────────────────────────────────────
// 规则表顶层除 $ 开头的说明外，每个键是一个「类别」，值是规则数组。
// 规则字段写错一律报错停下 —— 一个静默失效的规则比没有规则更危险。
// 返回 { rules, exemptions }；$豁免 是「确认过不是秘密」的放行名单（条目必须是文件+规则+理由三项齐全）。
function loadRules() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
  } catch (e) {
    die(`读不了规则表 ${path.relative(ROOT, RULES_FILE)}：${firstLine(e.message)}`);
  }
  const rules = [];
  const seen = new Set();
  // 先合并本机词表（同 id 会报重复，避免两份表各自漂移）
  let localCount = 0;
  if (fs.existsSync(RULES_LOCAL_FILE)) {
    try {
      const local = JSON.parse(fs.readFileSync(RULES_LOCAL_FILE, 'utf8'));
      for (const [类别, list] of Object.entries(local)) {
        if (类别.startsWith('$')) continue;
        if (!Array.isArray(list)) die(`本机词表里「${类别}」不是一个数组`);
        raw[类别] = [...(Array.isArray(raw[类别]) ? raw[类别] : []), ...list];
        localCount += list.length;
      }
    } catch (e) {
      die(`读不了本机词表 ${path.relative(ROOT, RULES_LOCAL_FILE)}：${firstLine(e.message)}`);
    }
  }
  for (const [类别, list] of Object.entries(raw)) {
    if (类别.startsWith('$')) continue;
    if (!Array.isArray(list)) die(`规则表里「${类别}」不是一个数组`);
    for (const r of list) {
      for (const 字段 of ['id', '描述', '模式', '严重级']) {
        if (!r[字段]) die(`规则表 ${类别}/ 里有一条缺少「${字段}」字段：${JSON.stringify(r).slice(0, 120)}`);
      }
      if (seen.has(r.id)) die(`规则 id 重复：${r.id}`);
      seen.add(r.id);
      const 目标 = r.目标 ?? '内容';
      if (目标 !== '内容' && 目标 !== '路径') die(`规则 ${r.id} 的「目标」只能是「内容」或「路径」，现在是「${目标}」`);
      if (r.严重级 !== 'block' && r.严重级 !== 'warn') die(`规则 ${r.id} 的「严重级」只能是 block 或 warn，现在是「${r.严重级}」`);
      let re;
      try {
        re = new RegExp(r.模式, 'g');
      } catch (e) {
        die(`规则 ${r.id} 的「模式」不是合法正则：${firstLine(e.message)}`);
      }
      rules.push({ ...r, 类别, 目标, re });
    }
  }
  if (!rules.length) die('规则表里一条规则都没有 —— 空的闸门等于没有闸门');
  return { rules, exemptions: loadExemptions(raw.$豁免 ?? [], rules), localCount };
}

// $豁免：逐条放行。粒度卡死在三件事上 —— 哪个文件、哪条规则、什么形状的命中；
// 理由（说明）必填。任何一项写错都报错（拼错的豁免等于没豁免，不能让它静默失效）。
function loadExemptions(list, rules) {
  if (!Array.isArray(list)) die('规则表里的「$豁免」不是一个数组');
  return list.map(e => {
    for (const 字段 of ['文件', '规则', '说明']) {
      if (!e[字段]) die(`$豁免 里有一条缺少「${字段}」字段：${JSON.stringify(e).slice(0, 120)}`);
    }
    const rule = rules.find(r => r.id === e.规则);
    if (!rule) die(`$豁免 里的规则 id 不存在：${e.规则}（先看看 audit-rules.json 里的 id 拼对没有）`);
    const re = (模式, 字段) => {
      try { return new RegExp(模式); } catch (err) { die(`$豁免 的「${字段}」不是合法正则：${模式}`); }
      return null;
    };
    return { rule, 文件Re: re(e.文件, '文件'), 命中Re: e.命中 ? re(e.命中, '命中') : null, 说明: e.说明 };
  });
}

const 匹配豁免 = (exemptions, rel, rule, full) => exemptions.find(
  x => x.rule === rule && x.文件Re.test(rel) && (x.命中Re ? x.命中Re.test(full) : true));

const 豁免自身 = (rel, 类别) => (SELF_EXEMPT[rel] ?? []).includes(类别);

// 逐行扫一个文件的内容：同一行同一规则可能命中多处（每一处都算命中——只取第一处会把
// 「第一处已被 $豁免、第二处是真东西」这种情况静默放过）。命中片段只在打印时截断（脱敏）。
function scanText(rel, text, rules, exemptions, box) {
  const lines = text.split('\n');
  for (const r of rules) {
    if (r.目标 !== '内容' || 豁免自身(rel, r.类别)) continue;
    for (let i = 0; i < lines.length; i++) {
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(lines[i])) !== null) {
        if (m.index === r.re.lastIndex) r.re.lastIndex += 1;   // 防零长度匹配卡死（规则写错时）
        const hit = { rel, line: i + 1, rule: r, full: m[0] };
        const ex = 匹配豁免(exemptions, rel, r, m[0]);
        if (ex) box.exempted.push({ ...hit, 豁免说明: ex.说明 });
        else box.hits.push(hit);
      }
    }
  }
}

function runAudit({ files, texts }, rules, exemptions) {
  const box = { hits: [], exempted: [] };
  for (const rel of files) {
    for (const r of rules) {
      if (r.目标 !== '路径' || 豁免自身(rel, r.类别)) continue;
      r.re.lastIndex = 0;
      if (!r.re.test(rel)) continue;
      const hit = { rel, line: null, rule: r, full: rel };
      const ex = 匹配豁免(exemptions, rel, r, rel);
      if (ex) box.exempted.push({ ...hit, 豁免说明: ex.说明 });
      else box.hits.push(hit);
    }
  }
  for (const [rel, text] of texts) scanText(rel, text, rules, exemptions, box);
  const byPos = (a, b) => (a.rel === b.rel ? (a.line ?? 0) - (b.line ?? 0) : a.rel.localeCompare(b.rel));
  box.hits.sort(byPos);
  box.exempted.sort(byPos);
  return box;
}

function printAudit({ hits, exempted }, { files, binary, bytes, localCount }) {
  stepHead('②', `审计 ${files.length} 个文件（${(bytes / 1024).toFixed(0)}KB 内容 + 路径）`);
  if (binary.length) info(`○ 内容不扫（二进制）：${binary.join('、')}`);
  if (localCount) info(`○ 已合并本机专属词表 audit-rules.local.json（${localCount} 条，属于本机标识，不进仓库）`);
  const 自豁免文件 = files.filter(f => SELF_EXEMPT[f]);
  if (自豁免文件.length) info(`○ 自带豁免（该文件必须原样列出这些词）：${自豁免文件.join('、')} —— 只跳过「${[...new Set(Object.values(SELF_EXEMPT).flat())].join('、')}」类，密钥类照扫`);
  if (!hits.length) { ok('未命中任何规则'); }

  const blocked = hits.filter(h => h.rule.严重级 === 'block');
  const warned = hits.filter(h => h.rule.严重级 === 'warn');
  if (hits.length) {
    blank();
    for (const h of hits) {
      const 位置 = h.line == null ? h.rel : `${h.rel}:${h.line}`;
      const 因 = `${h.rule.类别}·${h.rule.描述}`;
      console.log(`   ${h.rule.严重级 === 'block' ? '❌' : '⚠️'} ${位置}  ${因}  「${h.full.slice(0, SNIPPET_CHARS)}…」`);
    }
    const tally = new Map();
    for (const h of hits) tally.set(h.rule, (tally.get(h.rule) ?? 0) + 1);
    blank();
    info(`按规则汇总（${blocked.length} 处拒绝 / ${warned.length} 处提醒）：`);
    for (const [r, n] of tally) info(`  [${r.id}] ${r.类别}·${r.描述} ×${n}`);
    blank();
    info('怎么修：把命中片段改掉（脱敏/改成占位符/从配置读），或把它挪到 .gitignore 覆盖的位置（private/、data/、config.json…）。');
  }

  // 豁免一律大声打印：放行了什么、凭什么，得看得见
  if (exempted.length) {
    blank();
    info(`○ 按规则表的「$豁免」放行 ${exempted.length} 处（每一条都写明了理由）：`);
    for (const h of exempted) {
      const 位置 = h.line == null ? h.rel : `${h.rel}:${h.line}`;
      info(`  ${位置}  [${h.rule.id}]  「${h.full.slice(0, SNIPPET_CHARS)}…」  ${h.豁免说明}`);
    }
  }
}

// ── ③ 版本一致性 ────────────────────────────────────────────────────────
function readVersion() {
  if (!fs.existsSync(VERSION_FILE)) die('仓库根目录没有 VERSION 文件 —— 它是版本号的唯一事实源，必须先建');
  const v = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  if (!/^\d+\.\d+\.\d+$/.test(v)) die(`VERSION 里不是 x.y.z 形式的版本号：「${v.slice(0, 40)}」`);
  return v;
}

// CHANGELOG 顶部的版本 = 第一个形如 "## 1.2.3" 的标题
function changelogTopVersion(text) {
  const m = text.match(/^##\s+v?(\d+\.\d+\.\d+)/m);
  return m ? { version: m[1], line: text.slice(0, m.index).split('\n').length } : { version: null, line: null };
}

// 代码里的版本常量（如 VERSION = 'x.y.z'）—— 目前仓库里一个都没有，规则留着：
// 以后谁加了，一不一致会被这条拦住。大小写不敏感（VERSION / Version / appVersion / APP_VERSION 都要扫到），
// 但**注释里写的例子不算** —— 否则「在注释里举例说明」就会变成拦下自己的地雷。
function findVersionConstants(texts) {
  const out = [];
  const re = /(?:APP_|app)?version["']?\s*[:=]\s*['"`](\d+\.\d+\.\d+)['"`]/gi;
  const 注释行 = /^\s*(\/\/|\/\*|\*|#|<!--)/;
  const 行内注释 = /\/\/|\/\*|<!--/;
  for (const [rel, text] of texts) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const m = re.exec(lines[i]);
      if (!m) continue;
      if (注释行.test(lines[i]) || 行内注释.test(lines[i].slice(0, m.index))) continue;
      out.push({ rel, line: i + 1, version: m[1] });
    }
  }
  return out;
}

function checkVersions(version, texts, cliVersion) {
  const problems = [];
  const 顶部 = changelogTopVersion(texts.get('CHANGELOG.md') ?? '');
  const 常量 = findVersionConstants(texts);

  info(`VERSION              ${version}   （唯一事实源）`);
  info(`CHANGELOG 顶部        ${顶部.version ?? '（没找到 "## x.y.z" 标题）'}${顶部.version === version ? '' : '   ← 与 VERSION 不一致'}`);
  info(`代码里的版本常量      ${常量.length ? 常量.map(c => `${c.rel}:${c.line}=${c.version}`).join('、') : '未发现'}`);
  info(`命令行 --version      ${cliVersion ?? '（未指定，默认用 VERSION）'}`);

  if (!texts.has('CHANGELOG.md')) {
    problems.push(`仓库里没有 CHANGELOG.md（或被 .gitignore 挡住了）—— 发布说明总得有地方写，顶部要有一条 "## ${version}" 记录`);
  } else if (顶部.version !== version) {
    problems.push(`CHANGELOG.md 顶部是 ${顶部.version ?? '（缺失）'}，VERSION 是 ${version} —— 先在 CHANGELOG 顶部补一条 "## ${version} - <日期>" 的记录，或者把 VERSION 改回 ${顶部.version ?? '正确版本'}`);
  }
  if (cliVersion && cliVersion !== version) {
    problems.push(`命令行 --version ${cliVersion} 与 VERSION ${version} 不一致 —— 改 VERSION 文件，或去掉 --version`);
  }
  for (const c of 常量) {
    if (c.version !== version) problems.push(`${c.rel}:${c.line} 的版本常量是 ${c.version}，与 VERSION ${version} 不一致 —— 要么把它改成 ${version}，要么它根本不是发布版本号（那就改名避开 VERSION 这个关键字）`);
  }
  return problems;
}

// ── ④ 打包：自己写最小 zip（不用外部工具） ──────────────────────────────
// 为什么不用 PowerShell 的 Compress-Archive（tools/backup.mjs 用的是它）：
//   ① 本仓库有 7 个中文文件名（安装定时任务.bat 等）。Windows PowerShell 5.1 的 Compress-Archive
//      不写「UTF-8 名称」标志位，换一台机器 / 换个解压工具就可能全是乱码。
//   ② 本项目目录名本身含中文，外部工具的代码页/区域设置正是最容易翻车的地方（同类坑已踩过：
//      Node 的 fs.cpSync 在中文路径下会原生崩溃）。
//   ③ 自己写能保证输出字节可复现、名称一律 UTF-8 + 置通用标志位 11，任何解压工具都能正确还原。
//   ④ 只用 node:zlib（deflateRawSync 压缩、crc32 校验），依然是零依赖、单进程。
const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff, 0); return b; };
const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };

// MS-DOS 时间格式（zip 从 1980 年起算，秒只有 2 秒精度）
function dosDateTime(d) {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

// 一个条目：名称为 UTF-8；压不小就原样存储（方法 0），否则 deflate（方法 8）。
// 大文件（80MB 的 node.exe）用 6 级 —— 9 级要多花几十秒，压缩收益却很小。
function makeEntry(name, data, mtime) {
  const nameBuf = Buffer.from(name, 'utf8');
  const deflated = zlib.deflateRawSync(data, { level: data.length > BIG_FILE_BYTES ? 6 : 9 });
  const stored = deflated.length >= data.length;
  return {
    nameBuf,
    crc: zlib.crc32(data) >>> 0,
    method: stored ? 0 : 8,
    body: stored ? data : deflated,
    size: data.length,
    mtime,
  };
}

const localHeader = e => {
  const { time, date } = dosDateTime(e.mtime);
  return Buffer.concat([
    u32(0x04034b50), u16(20), u16(0x0800), u16(e.method), u16(time), u16(date),
    u32(e.crc), u32(e.body.length), u32(e.size), u16(e.nameBuf.length), u16(0), e.nameBuf,
  ]);
};

const centralHeader = e => {
  const { time, date } = dosDateTime(e.mtime);
  return Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(e.method), u16(time), u16(date),
    u32(e.crc), u32(e.body.length), u32(e.size), u16(e.nameBuf.length), u16(0), u16(0),
    u16(0), u16(0), u32(0), u32(e.offset), e.nameBuf,
  ]);
};

function writeZip(zipPath, entries) {
  if (entries.length > 0xffff) die(`发布文件有 ${entries.length} 个，超过 zip 格式上限（65535）`);
  const chunks = [];
  let offset = 0;
  for (const e of entries) {
    const h = localHeader(e);
    e.offset = offset;
    chunks.push(h, e.body);
    offset += h.length + e.body.length;
  }
  const cdStart = offset;
  for (const e of entries) {
    const h = centralHeader(e);
    chunks.push(h);
    offset += h.length;
  }
  const cdSize = offset - cdStart;
  if (cdStart > 0xffffffff) die('发布内容超过 4GB，这个最小 zip 写入器不支持');
  chunks.push(Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cdSize), u32(cdStart), u16(0),
  ]));
  fs.writeFileSync(zipPath, Buffer.concat(chunks));
}

// 自检：把刚写出的 zip 重新读一遍（中央目录 → 局部头 → 解压 → 比对大小与 CRC）。
// 一个悄悄写坏的发布包，正是这道闸门存在的意义，所以宁可多花 10ms 自己验一遍。
function verifyZip(zipPath, expectedNames) {
  const buf = fs.readFileSync(zipPath);
  const eocdAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdAt < 0) die('zip 自检失败：找不到中央目录结尾');
  const count = buf.readUInt16LE(eocdAt + 10);
  const cdSize = buf.readUInt32LE(eocdAt + 12);
  const cdAt = buf.readUInt32LE(eocdAt + 16);
  if (cdAt + cdSize !== eocdAt) die('zip 自检失败：中央目录长度对不上');
  if (count !== expectedNames.length) die(`zip 自检失败：包里有 ${count} 个条目，应为 ${expectedNames.length} 个`);

  const got = new Set();
  let p = cdAt;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) die('zip 自检失败：中央目录条目签名不对');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const body = buf.subarray(dataAt, dataAt + csize);
    const raw = method === 0 ? body : zlib.inflateRawSync(body);
    if (raw.length !== usize || (zlib.crc32(raw) >>> 0) !== crc) die(`zip 自检失败：条目损坏 —— ${name}`);
    got.add(name);
    p += 46 + nameLen + extraLen + commentLen;
  }
  for (const name of expectedNames) if (!got.has(name)) die(`zip 自检失败：包里少了 ${name}`);
}

// ── ④a 便携 Node 运行时（随发布包走，不进 git） ─────────────────────────
// 项目对用户的承诺是「解压即用」（CHANGELOG、快捷操作/安装定时任务.bat、快捷操作/立即采集一次.vbs 都优先用 runtime\node.exe）。
// 它 80MB、被 .gitignore 排除，所以不在 git 清单里、也不做逐行审计 —— 替代品是
// 「下载时记录的官方 SHA256」：对不上就拒绝，绝不把来路不明的运行时打进发布包。
function walkDir(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkDir(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

function inspectRuntime() {
  const 先跑 = '先跑 node release/make-portable.mjs 下载；确实要发纯代码包就加 --no-runtime';
  if (!fs.existsSync(RUNTIME_DIR)) {
    return { files: [], bytes: 0, problems: [`没有 runtime/ 目录，发布包带不上便携 Node 运行时（没装 Node 的用户就做不到「解压即用」）—— ${先跑}`] };
  }
  const files = walkDir(RUNTIME_DIR).sort();
  const exe = path.join(RUNTIME_DIR, 'node.exe');
  if (!files.includes('node.exe')) {
    return { files, bytes: 0, problems: [`runtime/ 里没有 node.exe —— ${先跑}`] };
  }
  const bytes = files.reduce((n, rel) => n + fs.statSync(path.join(RUNTIME_DIR, rel)).size, 0);
  let record = {};
  try { record = JSON.parse(fs.readFileSync(RUNTIME_RECORD, 'utf8')); } catch { record = {}; }
  const rec = String(record.sha256 ?? '').toLowerCase();
  const actual = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  if (!rec) {
    return { files, bytes, problems: [`release/portable-node.json 里没有 sha256 记录，无从核对运行时真伪 —— ${先跑}`] };
  }
  if (rec !== actual) {
    return { files, bytes, problems: [`runtime/node.exe 的 SHA256 与记录不符（记录 ${rec.slice(0, 12)}… / 实际 ${actual.slice(0, 12)}…）—— 可能被替换或下载不完整，重跑 node release/make-portable.mjs --force`] };
  }
  return { files, bytes, exeBytes: fs.statSync(exe).size, version: record.version ?? '未知', problems: [] };
}

function packZip(files, version, runtime) {
  if (typeof zlib.crc32 !== 'function') die('当前 Node 太老（没有 zlib.crc32，需要 22.2 以上）—— 没能力给 zip 自检，就不打包');
  const prefix = `${ZIP_BASE}-v${version}/`;   // 压缩包内的一级目录：解压时不会把文件撒到用户目录里
  const entries = [];
  const add = (abs, name) => entries.push({ name, ...makeEntry(name, fs.readFileSync(abs), fs.statSync(abs).mtime) });
  for (const rel of files) add(path.join(ROOT, rel), prefix + rel);
  // 运行时保持仓库里的目录结构（安装脚本按 runtime\node.exe 找它）
  for (const rel of runtime.files) add(path.join(RUNTIME_DIR, rel), `${prefix}runtime/${rel}`);
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const zipPath = path.join(DIST_DIR, `${ZIP_BASE}-v${version}.zip`);
  writeZip(zipPath, entries);
  verifyZip(zipPath, entries.map(e => e.name));
  return {
    zipPath,
    prefix,
    count: entries.length,
    runtimeFiles: runtime.files.length,
    rawBytes: entries.reduce((n, e) => n + e.size, 0),
    size: fs.statSync(zipPath).size,
  };
}

// ── ⑤ 打标签 ────────────────────────────────────────────────────────────
function makeTag(version) {
  const tag = `v${version}`;
  const git = args => execFileSync('git', args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exists = args => { try { git(args); return true; } catch { return false; } };
  if (exists(['rev-parse', '-q', '--verify', `refs/tags/${tag}`])) {
    die(`标签 ${tag} 已存在 —— 闸门不改动已有标签（要重打先 git tag -d ${tag}）`);
  }
  if (!exists(['rev-parse', '-q', '--verify', 'HEAD'])) {
    die(`仓库还没有第一个提交，打不了标签 —— 先 git add -A && git commit，再跑一次 --tag`);
  }
  // 标签必须落在「即将发布的那个提交」上。工作区有未提交改动时打标签，标签会指向上一个提交，
  // 而发布包来自工作区 —— 两者对不上（这正是靠记性最容易出的错），所以直接拒绝。
  if (git(['status', '--porcelain']).toString('utf8').trim()) {
    die('工作区还有未提交的改动，打标签会指向**上一个提交**（而发布包来自工作区，两者对不上）—— 先 git add -A && git commit，再重跑 --tag');
  }
  try {
    git(['tag', tag]);
  } catch (e) {
    die(`打标签失败：${firstLine(e.stderr?.toString?.() ?? e.message)}`);
  }
  return { tag, head: git(['rev-parse', '--short', 'HEAD']).toString('utf8').trim() };
}

// ── ⑥ 下一步 ────────────────────────────────────────────────────────────
function nextSteps({ version, zipPath, tag }) {
  const gitOut = args => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; } };
  const branch = gitOut(['branch', '--show-current']) || 'master';
  const remote = gitOut(['remote', 'get-url', 'origin']);
  const zipRel = path.relative(ROOT, zipPath).split(path.sep).join('/');

  stepHead('⑥', '下一步（闸门只管到这儿，推送与上传由你决定）');
  if (tag) {
    info(`1) 提交：已提交 ✓（--tag 要求工作区干净，标签 ${tag} 就落在刚提交的这次上）`);
  } else {
    info(`1) 提交：git add -A && git commit -m "release: v${version}"`);
  }
  if (remote) {
    info(`2) 推送：git push origin ${branch}${tag ? ` --tags        （把 ${tag} 一起推上去）` : ''}`);
  } else {
    info('2) 先配远程仓库：git remote add origin <你的仓库地址>');
    info(`   推送：git push -u origin ${branch}${tag ? ' --tags' : ''}`);
  }
  info(`3) 上传：${zipRel} → GitHub Releases${tag ? `（标签 ${tag}，可在 Releases 页直接选中）` : '（本次没打标签，先在仓库页 New release 建标签）'}`);
  blank();
  info('提醒：本地领先是常态 —— 这次审计通过只说明「此刻工作区里所有会被跟踪的文件都能公开」。');
  if (!tag) info('      要打标签的话：先提交，再跑 node release/publish.mjs --tag（标签必须落在已提交的内容上）。');
  info('      推之前又改了文件？再跑一次 node release/publish.mjs --dry。');
}

// ── 主流程 ──────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opt = { dry: false, tag: false, version: null, help: false, runtime: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') opt.dry = true;
    else if (a === '--tag') opt.tag = true;
    else if (a === '--no-runtime') opt.runtime = false;
    else if (a === '--version') opt.version = argv[++i] ?? '';
    else if (a.startsWith('--version=')) opt.version = a.slice('--version='.length);
    else if (a === '-h' || a === '--help') opt.help = true;
    else die(`不认识的参数：${a}（需要帮助就加 --help）`);
  }
  return opt;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) { usage(); return 0; }
  if (!opt.dry && execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).trim()) {
    die('工作区还有未提交改动：先保存提交，再运行 node release/prepare.mjs。预审仍可使用 --dry。');
  }
  if (opt.version !== null && !/^\d+\.\d+\.\d+$/.test(opt.version)) {
    die(`--version 需要一个 x.y.z 形式的版本号，收到的是「${opt.version || '(空)'}」`);
  }

  console.log(`发布闸门${opt.dry ? '（预演 --dry：只审计，不打包、不打标签）' : ''}   ${new Date().toLocaleString('zh-CN')}`);

  // ① 文件清单
  stepHead('①', '取文件清单（git 将跟踪的全部文件 = 下一次 push 会公开的范围）');
  const { files, missing } = listPublishFiles();
  info(`共 ${files.length} 个文件`);
  if (missing.length) info(`○ 索引里有、磁盘上已删除（不扫）：${missing.join('、')}`);
  if (!files.length) die('一个文件都没取到 —— 确认当前目录是 git 仓库、且在仓库根目录下跑这个脚本');

  // 规则表先加载：规则写错就别往下走了
  const { rules, exemptions, localCount } = loadRules();
  const { texts, binary, bytes } = readPublishables(files);

  // ② 审计
  const audit = runAudit({ files, texts }, rules, exemptions);
  printAudit(audit, { files, binary, bytes, localCount });

  // ③ 版本一致性 + 便携运行时预检 —— 这三步都跑完再汇总：一次把所有问题告诉你，省得来回两趟
  blank();
  const version = readVersion();
  stepHead('③', '版本一致性');
  const problems = checkVersions(version, texts, opt.version);

  blank();
  stepHead('③b', '便携 Node 运行时（发布包专用，不逐行审计）');
  const runtime = opt.runtime ? inspectRuntime() : { files: [], bytes: 0, problems: [], skipped: true };
  if (opt.runtime === false) {
    info('○ --no-runtime：本次发布包不带运行时 —— 没装 Node 的用户无法「解压即用」（确认这是有意的）');
  } else if (runtime.problems.length) {
    for (const p of runtime.problems) info(`❌ ${p}`);
  } else {
    info(`runtime/node.exe  ${humanSize(runtime.exeBytes)}（Node ${runtime.version}），SHA256 与 release/portable-node.json 一致 ✓`);
  }

  // 汇总拒绝
  const blocked = audit.hits.filter(h => h.rule.严重级 === 'block');
  if (blocked.length || problems.length || runtime.problems.length) {
    blank();
    console.log('════════ 发布被拒绝 ════════');
    if (blocked.length) console.log(`   审计命中 ${blocked.length} 处（个人信息 / 密钥 / 禁入路径）`);
    for (const p of problems) console.log(`   版本不一致：${p}`);
    for (const p of runtime.problems) console.log(`   运行时：${p}`);
    console.log('   默认拒绝：先修掉上面这些，再跑一次 node release/publish.mjs --dry');
    return 1;
  }
  ok('审计通过、版本一致、运行时已核对');

  if (opt.dry) {
    stepHead('④ ⑤', '预演模式：跳过打包与打标签');
    const 运行时数 = runtime.files.length ? ` + 便携运行时 ${runtime.files.length} 个文件（${humanSize(runtime.bytes)}）` : '（不含运行时）';
    info(`正式发布会打包：代码 ${files.length} 个文件${运行时数} → dist/${ZIP_BASE}-v${version}.zip`);
    info(`正式发布跑：node release/publish.mjs${opt.tag ? ' --tag' : ''}`);
    return 0;
  }

  // ④ 打包
  stepHead('④', '打包');
  const zip = packZip(files, version, runtime);
  ok(`${path.relative(ROOT, zip.zipPath).split(path.sep).join('/')}  ${humanSize(zip.size)}（原始 ${humanSize(zip.rawBytes)}，${zip.count} 个文件，自检通过）`);
  info(`压缩包内一级目录：${zip.prefix}     dist/ 已在 .gitignore 里，不会进仓库`);
  if (zip.runtimeFiles) {
    info(`含便携 Node 运行时 runtime/node.exe（${humanSize(runtime.exeBytes)}）—— 它是二进制，不逐行审计，改由 SHA256 核对来源`);
  } else {
    info('不含便携 Node 运行时：没装 Node 的用户无法直接用（本次是 --no-runtime）');
  }

  // ⑤ 打标签
  stepHead('⑤', '打标签');
  let tag = null;
  if (!opt.tag) {
    info('未传 --tag，跳过（需要时加 --tag；标签只在本机，推送时加 --tags 才会上远端）');
  } else {
    const t = makeTag(version);
    tag = t.tag;
    ok(`git tag ${tag} → 指向当前提交 ${t.head}`);
  }

  // ⑥ 下一步
  nextSteps({ version, zipPath: zip.zipPath, tag });
  return 0;
}

// 用 exitCode + 哨兵异常退出，不用 process.exit()：Windows 上后者会截断未 flush 的 stdout。
try {
  process.exitCode = main();
} catch (e) {
  if (e !== GATE_STOP) throw e;   // 真异常照常抛出（带栈）；闸门拒绝是干净退出
  process.exitCode = 1;
}
