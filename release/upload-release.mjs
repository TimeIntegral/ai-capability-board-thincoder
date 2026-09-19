// 发布上传：候选版 → GitHub Release（本地 → 公开的最后一步）
// 用法：node release/upload-release.mjs [--dry] [--version X.Y.Z]
//
// 一条命令跑完：核对候选 → 查远端 → 建草稿 → 传四个附件 → 发布为正式版 → 实测下载核对。
//   （此前这一步是 %TEMP% 里的一次性脚本，2026-09-19 的 v1.4.0 就是这么发的；本文件把它固化下来。）
//
// ── 为什么"查远端"必须用列表 + tag 过滤，不能用 /releases/tags/<tag> ──────────────
// 2026-09-17 首次发布踩过的坑：`/releases/tags/v1.3.0` **不返回草稿**（GitHub 的设计），
// 于是刚建好的草稿在它眼里"不存在"，脚本以为自己还没建、又建了一个 —— 最后同一个 tag 上
// 挂着一个空草稿（id=390394251，2026-09-20 由人工确认后删除）。
// 现在两头都钉死：建之前，列表里同 tag 必须 0 个；建完立刻再列一次，必须**恰好 1 个**（就是刚建的那个）。
//
// ── 安全契约（比"跑通"更重要）──────────────────────────────────────────────
//   · 绝不删除、绝不修改任何既有 Release：本文件没有任何 DELETE，也不往既有 Release 上加附件。
//     同 tag 已经存在任何 Release（草稿或正式）→ 停下报告，交人工判断（项目规矩：发布后不覆盖）。
//   · 拿不准就停下：候选对不上、附件缺件、哈希不符、版本对不上 → exit 1，什么都不建、不传。
//   · 凭据只在内存：同一个进程里向 git 凭据助手要一次，不落盘、不进命令行、不打印；输出统一脱敏。
//   · --dry 只读：HTTP 层在预演模式下遇到非 GET 直接抛错 —— "预演不发写请求"由代码挡，不靠记性。
//   · 上传后自检：发布为正式版后**实测下载每个附件**，SHA256 与 SHA256SUMS.txt 逐字符比对
//     （release/上传说明.md 的硬要求：用户的自定义更新链就认这份清单）。
//
// 退出码：0 = 完成（--dry = 预演跑完并给出结论，含"真实运行会停下"的情形）；1 = 停下（拒绝执行 / 核对失败）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
// 渠道地址与「更新器同款校验」都来自用户侧那份实现：发布端与用户端用**同一套判据**，
// 不另写一份 —— 否则"发布端觉得没问题、用户端拒绝安装"这类错只能等用户撞上。
import { repositories, validateManifest } from '../程序/lib/updates.mjs';

const ROOT = path.dirname(import.meta.dirname);
const DIST_DIR = path.join(ROOT, 'dist');
const VERSION_FILE = path.join(ROOT, 'VERSION');
const CHANNELS_FILE = path.join(ROOT, '程序/channels.json');
const API_HOST = 'api.github.com';
const UPLOAD_HOST = 'uploads.github.com';
const 用户代理 = 'ai-capability-board-release-upload';
const 上传超时 = 15 * 60 * 1000;   // 安装包 22MB / 便携包 32MB：本机代理下走几分钟是正常的
const 下载超时 = 10 * 60 * 1000;
const 附件名 = version => [
  `ai-capability-board-v${version}-windows-x64-setup.exe`,
  `ai-capability-board-v${version}.zip`,
  'latest.json',
  'SHA256SUMS.txt',
];
let DRY = false;                  // 预演模式：main() 设置一次，HTTP 层据此拒绝一切写请求

// ── 打印小工具（与 release/publish.mjs 同一套观感）────────────────────────────
const blank = () => console.log('');
const stepHead = (no, title) => console.log(`\n${no} ${title}`);
const ok = msg => console.log(`   ✅ ${msg}`);
const info = msg => console.log(`   ${msg}`);
const note = msg => console.log(`   ○ ${msg}`);
// 用「抛哨兵 + 设 exitCode」而不是 process.exit()：Windows 上后者会截断还没 flush 的 stdout。
const 停下 = Symbol('停下');
function die(msg) { console.error(`\n⛔ ${msg}`); throw 停下; }
const firstLine = s => String(s ?? '').split('\n')[0].slice(0, 200);
const humanSize = b => (b >= 1048576 ? `${(b / 1048576).toFixed(1)}MB` : `${(b / 1024).toFixed(1)}KB`);

function usage() {
  console.log(`发布上传 —— 用法：node release/upload-release.mjs [--dry] [--version X.Y.Z]

  （无参数）        核对 dist/candidate-<版本>-<提交>/ → 建 Release 草稿 → 传四个附件 → 发布为正式版 → 实测下载核对
  --dry             只核对与打印计划：不建、不传、不发布（HTTP 层连写请求都不发）
  --version X.Y.Z   发这个版本（默认取 VERSION 文件；发布后继续开发、VERSION 已经涨号时用这个指定旧版本）
  -h, --help        显示这段帮助

  凭据来自 git 凭据助手（同一进程内读取，不落盘）；代理默认 http://127.0.0.1:7897（可用环境变量 RELEASE_UPLOAD_PROXY 覆盖）。
  同 tag 已有任何 Release → 停下报告，绝不覆盖；没有凭据时的人工兜底见 release/上传说明.md。`);
}

// ── 本机出口与仓库坐标 ──────────────────────────────────────────────────────
// 仓库坐标取自渠道地址（程序/channels.json）—— 与用户端更新器读的是同一份，不在这里再写一遍仓库名。
let _仓库 = null;
function 仓库坐标() {
  if (_仓库) return _仓库;
  const github = repositories(JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'))).find(u => /^https:\/\/github\.com\//.test(u));
  if (!github) die('程序/channels.json 里没有 github 渠道地址 —— 本脚本只支持 GitHub Releases');
  const [, owner, repo] = new URL(github).pathname.split('/');
  if (!owner || !repo) die(`渠道地址不对：${github}`);
  _仓库 = { owner, repo };
  return _仓库;
}

// 本机代理（本机 Clash）：显式写在这里，端口变了用环境变量覆盖，不改文件。
const 代理地址 = () => process.env.RELEASE_UPLOAD_PROXY ?? 'http://127.0.0.1:7897';
let _代理 = null;
function 代理端点() {
  if (!_代理) {
    let u;
    try { u = new URL(代理地址()); } catch { die(`代理地址不是合法 URL：${代理地址()}（可用环境变量 RELEASE_UPLOAD_PROXY 覆盖）`); }
    // CONNECT 隧道本身就是明文 HTTP（见 代理隧道()），所以只接 http 且必须写端口 ——
    // 把 https:// 或无端口的地址静默当成 80 端口，只会换来一个误导人的「代理通不通？」。
    if (u.protocol !== 'http:' || !u.port) die(`代理地址得是带端口的 http 地址（例：http://127.0.0.1:7897），收到：${代理地址()}`);
    _代理 = { host: u.hostname, port: Number(u.port) };
  }
  return _代理;
}

// ── 凭据：只在内存 ─────────────────────────────────────────────────────────
// 凭据助手的输出是「字段=值」行。字段前缀写成常量而不是内联字面量：审计规则会把
// 「字段名 + 等号 + 引号」当成写死的密钥赋值，而这里只是解析别人的输出，不是密钥。
const 凭据字段 = 'password=';
let _token = null;
function 取凭据() {
  if (_token) return _token;
  const r = spawnSync('git', ['credential', 'fill'], {
    cwd: ROOT,
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 90000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.error) die(`取凭据失败：${r.error.message}\n   人工兜底（在网页上上传）见 release/上传说明.md`);
  if (r.status !== 0) die(`取凭据失败：git credential fill 退出码 ${r.status}（本机凭据助手里没有 github.com）\n   人工兜底见 release/上传说明.md`);
  const line = String(r.stdout).split(/\r?\n/).find(l => l.startsWith(凭据字段));
  if (!line || !line.slice(凭据字段.length).trim()) die('取凭据失败：凭据助手的输出里没有密码字段');
  _token = line.slice(凭据字段.length).trim();
  return _token;
}
// 凡是往外打的文本都过一遍：即便某处意外带上了凭据，也不会落到终端/日志里
function 脱敏(s) {
  let out = String(s);
  if (_token) out = out.split(_token).join('***');
  return out.replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,})\b/g, '***');
}

// ── 代理隧道与 HTTP ────────────────────────────────────────────────────────
// 每请求一条 CONNECT 隧道（本机代理只做转发，不是 MITM，所以隧道里再自己 TLS）。
function 代理隧道() {
  const { host, port } = 代理端点();
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });
  agent.createConnection = (options, callback) => {
    const target = `${options.host}:${options.port || 443}`;
    const req = http.request({ host, port, method: 'CONNECT', path: target, headers: { host: target }, agent: false });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); callback(new Error(`代理 CONNECT 失败：HTTP ${res.statusCode}（${代理地址()} 通不通？）`)); return; }
      const t = tls.connect({ socket, servername: options.host });
      t.once('secureConnect', () => callback(null, t));
      t.once('error', e => callback(e));
    });
    req.once('error', e => callback(e));
    req.end();
  };
  return agent;
}

function 收响应(res, resolve) {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* 204 / 非 JSON：正文为空是正常的 */ }
    resolve({ status: res.statusCode, json, text });
  });
}

// JSON API。--dry 下只允许 GET —— 预演"不发写请求"由这里挡死。
function api(method, apiPath, { body } = {}) {
  if (DRY && method !== 'GET') throw new Error(`预演模式拒绝写请求：${method} ${apiPath}`);
  return new Promise((resolve, reject) => {
    const headers = {
      'user-agent': 用户代理,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: 'Bearer ' + 取凭据(),
    };
    let payload = null;
    if (body !== undefined) {
      payload = Buffer.from(JSON.stringify(body), 'utf8');
      headers['content-type'] = 'application/json';
      headers['content-length'] = payload.length;
    }
    const req = https.request({ host: API_HOST, path: apiPath, method, headers, agent: 代理隧道() }, res => 收响应(res, resolve));
    req.setTimeout(60000, () => req.destroy(new Error('请求超时 60s')));
    req.on('error', e => reject(new Error(脱敏(e.message))));
    if (payload) req.write(payload);
    req.end();
  });
}

// 附件上传：体积大，必须流式（不把文件读进内存）；带上本地大小与 SHA256 供上传后立即核对。
function 上传附件(releaseId, name, 文件) {
  if (DRY) throw new Error('预演模式拒绝上传');
  const { owner, repo } = 仓库坐标();
  return new Promise((resolve, reject) => {
    const headers = {
      'user-agent': 用户代理,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      authorization: 'Bearer ' + 取凭据(),
      'content-type': 'application/octet-stream',
      'content-length': fs.statSync(文件).size,
    };
    const req = https.request({
      host: UPLOAD_HOST,
      path: `/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
      method: 'POST',
      headers,
      agent: 代理隧道(),
    }, res => 收响应(res, resolve));
    req.setTimeout(上传超时, () => req.destroy(new Error(`上传超时（${上传超时 / 1000}s）`)));
    req.on('error', e => reject(new Error(脱敏(e.message))));
    const stream = fs.createReadStream(文件);
    stream.on('error', e => reject(new Error(脱敏(e.message))));
    stream.pipe(req);
  });
}

// 实测下载：只走公开地址（发布之后才有），不带凭据；GitHub 会 302 到 objects.githubusercontent.com，跟过去。
function 下载并算哈希(url, 剩余跳转 = 5) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new Error(`拒绝非 https 的下载地址：${url}`));
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, method: 'GET', headers: { 'user-agent': 用户代理 }, agent: 代理隧道() }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        const 下一个 = res.headers.location;
        if (!下一个 || 剩余跳转 <= 0) return reject(new Error(`下载跳转异常：HTTP ${res.statusCode}`));
        return resolve(下载并算哈希(new URL(下一个, url).href, 剩余跳转 - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`下载返回 HTTP ${res.statusCode}`)); }
      const hash = crypto.createHash('sha256');
      let 字节 = 0;
      res.on('data', c => { 字节 += c.length; hash.update(c); });
      res.on('end', () => resolve({ 字节, sha256: hash.digest('hex') }));
    });
    req.setTimeout(下载超时, () => req.destroy(new Error(`下载超时（${下载超时 / 1000}s）`)));
    req.on('error', e => reject(new Error(脱敏(e.message))));
    req.end();
  });
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const 文件摘要 = 文件 => crypto.createHash('sha256').update(fs.readFileSync(文件)).digest('hex');

// 逐字符比对两个十六进制串：不一致时给出第一个不同的位置（截断还是另一份构建，一眼能看出来）
function 首个不同位置(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function 本地标签提交(标签) {
  try {
    return execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${标签}`], { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null; }
}

// ── ① 核对候选版 ──────────────────────────────────────────────────────────
function 读版本(opt) {
  const 文件版本 = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  const 版本 = opt.version || 文件版本;
  if (!/^\d+\.\d+\.\d+$/.test(版本)) die(`版本号得是 x.y.z 形式：收到「${版本}」`);
  return { 版本, 文件版本 };
}

function 找候选目录(版本) {
  const 前缀 = `candidate-${版本}-`;
  const 命中 = (fs.existsSync(DIST_DIR) ? fs.readdirSync(DIST_DIR, { withFileTypes: true }) : [])
    .filter(e => e.isDirectory() && e.name.startsWith(前缀)).map(e => e.name).sort();
  if (!命中.length) die(`dist/ 里没有 ${版本} 的候选目录（找的是 ${前缀}<提交>）—— 先跑 node release/prepare.mjs 构建候选版`);
  if (命中.length > 1) {
    die(`dist/ 里有 ${命中.length} 个 ${版本} 的候选目录，不知道发哪一个：\n     ${命中.join('\n     ')}\n   → 删掉不用的那份（候选版是构建产物，删了不影响开发），再跑一次`);
  }
  return 命中[0];
}

function 解析校验清单(文本) {
  const 表 = new Map();
  for (const 行 of 文本.replace(/\r\n/g, '\n').split('\n')) {
    if (!行.trim()) continue;
    const m = 行.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!m) die(`SHA256SUMS.txt 有一行格式不对（期望「<64 位小写十六进制>  文件名」）：${行.slice(0, 120)}`);
    表.set(m[2], m[1]);
  }
  if (!表.size) die('SHA256SUMS.txt 里一条记录都没有');
  return 表;
}

// 候选目录的全部核对：快照 / 标签 / 附件 / 校验清单 / latest.json。任何一项不过就停下。
function 核对候选(候选名, 版本) {
  const 目录 = path.join(DIST_DIR, 候选名);
  const 快照文件 = path.join(目录, 'release-snapshot.json');
  if (!fs.existsSync(快照文件)) die(`候选目录里没有 release-snapshot.json：${候选名}\n   这份不是 prepare.mjs 产出的候选版，不猜、不发`);
  const 快照 = JSON.parse(fs.readFileSync(快照文件, 'utf8'));
  const 问题 = [];
  if (快照.version !== 版本) 问题.push(`候选记录的版本是 ${快照.version}，与要发的 ${版本} 不一致`);
  if (!/^[0-9a-f]{40}$/.test(String(快照.commit ?? ''))) 问题.push(`候选记录的 commit 不是 40 位提交号：${快照.commit}`);
  if (快照.state !== 'candidate') 问题.push(`候选记录的 state=${快照.state}，期望 candidate（这份不是候选版，或已被标记发出）`);
  const 提交 = String(快照.commit ?? '');
  if (!候选名.endsWith(`-${提交.slice(0, 8)}`)) 问题.push(`候选目录名与记录里的提交对不上：目录 ${候选名} / 记录 ${提交.slice(0, 8)}`);
  if (问题.length) die(`候选记录对不上：\n   ${问题.join('\n   ')}\n   候选目录：${候选名}`);
  ok(`候选记录：版本 ${版本} · 提交 ${提交.slice(0, 8)} · state=candidate（${候选名}）`);

  // 标签必须落在候选提交上：本机有这个标签就比；没有只是提示（GitHub 会在发布时按候选提交创建，发布后再核一遍）。
  const 本地 = 本地标签提交(`v${版本}`);
  if (本地 && 本地 !== 提交) die(`本机标签 v${版本} 指向 ${本地}，候选提交是 ${提交} —— 标签与候选版对不上，停下`);
  if (本地) ok(`本机标签 v${版本} → ${本地.slice(0, 8)}（与候选提交一致）`);
  else note(`本机还没有 v${版本} 标签：发布时 GitHub 会在候选提交上创建，发布后本脚本会核对标签指向`);

  // 四个附件 + 逐文件 SHA256
  const 附件 = 附件名(版本);
  const 文件哈希 = new Map();
  const 文件大小 = new Map();
  for (const 名 of 附件) {
    const 路径 = path.join(目录, 名);
    if (!fs.existsSync(路径)) { 问题.push(`候选目录里缺附件：${名}`); continue; }
    文件哈希.set(名, 文件摘要(路径));
    文件大小.set(名, fs.statSync(路径).size);
  }
  if (问题.length) die(`候选目录缺件（四个附件必须齐全）：\n   ${问题.join('\n   ')}`);

  // SHA256SUMS.txt：它列出的文件必须正好是「除它自己以外的三个附件」，且逐字符一致。
  const 校验表 = 解析校验清单(fs.readFileSync(path.join(目录, 'SHA256SUMS.txt'), 'utf8'));
  const 应列 = 附件.filter(名 => 名 !== 'SHA256SUMS.txt');
  const 少列 = 应列.filter(名 => !校验表.has(名));
  const 多列 = [...校验表.keys()].filter(名 => !应列.includes(名));
  if (少列.length) 问题.push(`SHA256SUMS.txt 里少了：${少列.join('、')}`);
  if (多列.length) 问题.push(`SHA256SUMS.txt 里多出不属于这次发布的条目：${多列.join('、')}`);
  for (const 名 of 应列) {
    if (!校验表.has(名) || !文件哈希.has(名)) continue;
    const 位置 = 首个不同位置(文件哈希.get(名), 校验表.get(名));
    if (位置 !== -1) 问题.push(`${名} 的 SHA256 与清单逐字符比对不一致（第 ${位置 + 1} 个字符起不同）：\n       本地 ${文件哈希.get(名)}\n       清单 ${校验表.get(名)}`);
  }
  if (问题.length) die(`候选文件与 SHA256SUMS.txt 对不上：\n   ${问题.join('\n   ')}`);
  ok(`四个附件齐全，SHA256 与 SHA256SUMS.txt 逐字符一致（${附件.map(名 => humanSize(文件大小.get(名))).join(' / ')}）`);

  // latest.json：用户「立即更新」全靠它 —— 用更新器同款校验过一遍，再比本机安装包。
  const manifest = JSON.parse(fs.readFileSync(path.join(目录, 'latest.json'), 'utf8'));
  let 归一 = null;
  try { 归一 = validateManifest(manifest, repositories(JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8')))); }
  catch (e) { 问题.push(`latest.json 过不了用户更新器的校验（程序/lib/updates.mjs）：${firstLine(e.message)}`); }
  if (归一) {
    const 安装包 = 附件[0];
    if (归一.version !== 版本) 问题.push(`latest.json 里的版本是 ${归一.version}，与 ${版本} 不一致`);
    if (归一.sha256 !== 文件哈希.get(安装包)) 问题.push('latest.json 的 sha256 与候选安装包不一致 —— 用户点了「立即更新」会校验失败');
    if (归一.size !== 文件大小.get(安装包)) 问题.push('latest.json 的 size 与候选安装包不一致');
    for (const u of 归一.urls) if (!u.includes(`/releases/download/v${版本}/`)) 问题.push(`latest.json 的下载地址不指向这次发布的标签：${u}`);
  }
  if (问题.length) die(`latest.json 与候选包对不上：\n   ${问题.join('\n   ')}`);
  ok('latest.json 过用户更新器同款校验，且指向这次发布的安装包');

  const 说明 = String(归一?.notes ?? '').trim();
  if (!说明) die('latest.json 里没有 notes（发布说明）—— 检查 CHANGELOG 顶部的版本段，重跑一次 node release/prepare.mjs');
  return { 目录, 提交, 附件, 文件哈希, 文件大小, 校验表, 说明 };
}

// ── ② 远端现状（带凭据，只读）────────────────────────────────────────────
const 描述 = r => `id=${r.id} tag=${r.tag_name} draft=${r.draft} published=${r.published_at || '-'} 附件=${(r.assets || []).length}`;

async function 列全部Release() {
  const { owner, repo } = 仓库坐标();
  const 全部 = [];
  for (let 页 = 1; 页 <= 20; 页++) {
    const res = await api('GET', `/repos/${owner}/${repo}/releases?per_page=100&page=${页}`);
    if (res.status === 401 || res.status === 403) die(`读 Release 列表被拒（HTTP ${res.status}）—— 凭据没有这个仓库的权限？`);
    if (res.status !== 200) die(`读 Release 列表失败：HTTP ${res.status} ${firstLine(res.text)}`);
    const arr = Array.isArray(res.json) ? res.json : [];
    全部.push(...arr);
    if (arr.length < 100) break;
  }
  return 全部;
}

// 远端标签指向哪个提交（轻量标签直接是提交；附注标签要再解一层）。没有这个标签就返回 null。
async function 远端标签提交(标签) {
  const { owner, repo } = 仓库坐标();
  const res = await api('GET', `/repos/${owner}/${repo}/git/ref/tags/${标签}`);
  if (res.status === 404) return null;
  if (res.status !== 200) die(`查远端标签失败：HTTP ${res.status} ${firstLine(res.text)}`);
  const 对象 = res.json?.object ?? {};
  if (对象.type === 'commit') return 对象.sha;
  if (对象.type === 'tag' && 对象.sha) {
    const 内 = await api('GET', `/repos/${owner}/${repo}/git/tags/${对象.sha}`);
    if (内.status !== 200) die(`解附注标签失败：HTTP ${内.status}`);
    return 内.json?.object?.sha ?? null;
  }
  return null;
}

// ── ③④⑤ 真实运行：建草稿 → 传附件 → 发布 ─────────────────────────────────
async function 建草稿(版本, 提交, 说明) {
  const { owner, repo } = 仓库坐标();
  const res = await api('POST', `/repos/${owner}/${repo}/releases`, {
    body: { tag_name: `v${版本}`, target_commitish: 提交, name: `v${版本}`, body: 说明, draft: true, prerelease: false },
  });
  if (res.status !== 201) die(`建 Release 失败：HTTP ${res.status} ${firstLine(res.text)}`);
  ok(`已建草稿：id=${res.json.id} tag=${res.json.tag_name} target=${String(res.json.target_commitish).slice(0, 8)} draft=${res.json.draft}`);
  return res.json;
}

// 建完立刻再列一次：同 tag 必须恰好 1 个（就是刚建的这个）—— 这一条正是 2026-09-17 那个坑的哨兵
async function 断言同标签唯一(标签, 期望id) {
  const 同标签 = (await 列全部Release()).filter(r => r.tag_name === 标签);
  if (同标签.length !== 1 || 同标签[0].id !== 期望id) {
    die(`刚建完草稿，但 ${标签} 上的 Release 不是恰好 1 个：\n   ${同标签.map(描述).join('\n   ') || '(0 个)'}\n   期望只有 id=${期望id}（绝不重复建草稿、也绝不删已有的）—— 停下，人工在网页上处理`);
  }
  ok(`${标签} 上恰好 1 个 Release（id=${期望id}）—— 没有重复草稿`);
}

async function 传全部附件(releaseId, 候选) {
  for (const 名 of 候选.附件) {
    const 大小 = 候选.文件大小.get(名);
    const t0 = Date.now();
    info(`上传 ${名}（${humanSize(大小)}）…`);
    const res = await 上传附件(releaseId, 名, path.join(候选.目录, 名));
    if (res.status !== 201) die(`上传 ${名} 失败：HTTP ${res.status} ${firstLine(res.text)}`);
    const 秒 = ((Date.now() - t0) / 1000).toFixed(1);
    if (res.json.size !== 大小) die(`上传后大小对不上：${名} 远端 ${res.json.size} / 本地 ${大小}`);
    const 远端摘要 = String(res.json.digest ?? '').replace(/^sha256:/, '');
    if (远端摘要 && 远端摘要 !== 候选.文件哈希.get(名)) die(`上传后 GitHub 算出的 SHA256 与本地不一致：${名}`);
    if (res.json.state !== 'uploaded') die(`上传后状态不是 uploaded：${名} state=${res.json.state}`);
    ok(`${名} 已上传（${humanSize(res.json.size)}，${秒}s${远端摘要 ? '，SHA256 一致' : ''}）`);
    if (!远端摘要) note('这次响应里没有 digest 字段：以第 ⑥ 步的实测下载为准');
  }
}

async function 发布为正式版(releaseId, 候选) {
  // 发布前再看一眼附件状态：不齐全就不发布（宁可在草稿上停下，也不发一个缺附件的正式版）
  const 现状 = (await 列全部Release()).find(r => r.id === releaseId);
  if (!现状) die(`刚建的草稿 id=${releaseId} 查不到了 —— 停下，人工确认`);
  if (现状.draft === false) die(`id=${releaseId} 已经是正式版本了 —— 本脚本不修改既有 Release，停下`);
  const 附件表 = new Map((现状.assets || []).map(a => [a.name, a]));
  const 没好 = 候选.附件.filter(名 => 附件表.get(名)?.state !== 'uploaded');
  if (没好.length) die(`附件没就绪（state 不是 uploaded）：${没好.join('、')} —— 不发布，先查清原因`);
  const { owner, repo } = 仓库坐标();
  const res = await api('PATCH', `/repos/${owner}/${repo}/releases/${releaseId}`, { body: { draft: false, prerelease: false } });
  if (res.status !== 200) die(`发布失败：HTTP ${res.status} ${firstLine(res.text)}`);
  ok(`已发布为正式版：tag=${res.json.tag_name} published=${res.json.published_at}`);
  info(`页面：${res.json.html_url}`);
  return res.json;
}

// ── ⑥ 实测下载核对（release/上传说明.md 的硬要求）──────────────────────────
async function 实测下载核对(版本, 候选) {
  // 发布之后 /releases/tags/<tag> 才查得到（草稿不返回 —— 这就是本文件开头那个坑的由来）
  const { owner, repo } = 仓库坐标();
  const res = await api('GET', `/repos/${owner}/${repo}/releases/tags/v${版本}`);
  if (res.status !== 200) die(`发布后仍查不到 v${版本} 的正式 Release（HTTP ${res.status}）—— 人工确认`);
  const 附件表 = new Map((res.json.assets || []).map(a => [a.name, a]));
  for (const 名 of 候选.附件) {
    const 资产 = 附件表.get(名);
    if (!资产) die(`发布后的 Release 上没有附件：${名}`);
    const t0 = Date.now();
    const { 字节, sha256 } = await 下载并算哈希(资产.browser_download_url);
    const 期望 = 名 === 'SHA256SUMS.txt' ? 候选.文件哈希.get(名) : 候选.校验表.get(名);
    const 位置 = 首个不同位置(sha256, 期望);
    if (字节 !== 候选.文件大小.get(名)) die(`下载回来的 ${名} 大小不对：${字节} / 本地 ${候选.文件大小.get(名)}`);
    if (位置 !== -1) {
      die(`下载回来的 ${名} 与 SHA256SUMS.txt 不一致（第 ${位置 + 1} 个字符起不同）：\n   实测 ${sha256}\n   清单 ${期望}\n   → 这次发布不要对外公布，先查清上传/下载链路`);
    }
    ok(`${名} 实测下载 ${humanSize(字节)}，SHA256 ${sha256.slice(0, 16)}… 与清单逐字符一致（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  }
  // 标签必须落在候选提交上：发布后复核一次（缺标签的那次由 GitHub 在发布时创建）
  const 远端提交 = await 远端标签提交(`v${版本}`);
  if (远端提交 && 远端提交 !== 候选.提交) die(`远端标签 v${版本} 指向 ${远端提交}，候选提交是 ${候选.提交} —— 标签与这次发布的内容对不上`);
  ok(远端提交 ? `远端标签 v${版本} → ${远端提交.slice(0, 8)}（与候选提交一致）` : `远端还没有 v${版本} 标签 —— 发布后 GitHub 没建，记得 git push origin v${版本}`);

  // 用户端的「检查更新」读的是**最新正式 Release**，而 GitHub 的 latest 按发布时间判定（不是版本号大小）：
  // 补发一个旧版本会把它顶成 latest（新用户下到旧版、老用户也不再被提示）。只提醒，不拦 —— 补发旧版本有时是有意的。
  const 最新 = await api('GET', `/repos/${owner}/${repo}/releases/latest`);
  if (最新.status === 200 && 最新.json?.tag_name !== `v${版本}`) {
    note(`注意：GitHub 的「最新正式 Release」现在是 ${最新.json?.tag_name}，不是刚发的 v${版本} —— `);
    note('latest 按发布时间判定、不按版本号大小，用户端的「检查更新」会跟着它走；确认这是有意的。');
  } else if (最新.status === 200) {
    ok(`v${版本} 就是「最新正式 Release」—— 用户端「检查更新」读到的就是它`);
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  const opt = { dry: false, version: null, help: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') opt.dry = true;
    else if (a === '--version') {
      opt.version = argv[++i] ?? '';
      if (!opt.version) die('--version 后面要跟一个 x.y.z 版本号（例：--version 1.4.0）');
    } else if (a.startsWith('--version=')) {
      opt.version = a.slice('--version='.length);
      if (!opt.version) die('--version= 后面要跟一个 x.y.z 版本号（例：--version=1.4.0）');
    } else if (a === '-h' || a === '--help') opt.help = true;
    else die(`不认识的参数：${a}（需要帮助就加 --help）`);
  }
  if (opt.help) { usage(); return 0; }
  DRY = opt.dry;
  console.log(`发布上传${DRY ? '（预演 --dry：只核对与打印计划，不建、不传、不发布）' : ''}   ${new Date().toLocaleString('zh-CN')}`);

  stepHead('①', '核对候选版');
  const { 版本, 文件版本 } = 读版本(opt);
  info(`要发的版本：${版本}${opt.version ? `（--version 指定；VERSION 文件是 ${文件版本}）` : '（取自 VERSION 文件）'}`);
  const 候选 = 核对候选(找候选目录(版本), 版本);

  stepHead('②', '查远端现状（带凭据，只读：列表 + tag 过滤）');
  const 标签 = `v${版本}`;
  const 同标签 = (await 列全部Release()).filter(r => r.tag_name === 标签);
  let 会停下 = false;
  if (同标签.length) {
    会停下 = true;
    console.log(`   ⛔ ${标签} 上已经有 ${同标签.length} 个 Release（项目规矩：发布后不覆盖，本脚本不改动任何既有 Release）：`);
    for (const r of 同标签) console.log(`      ${描述(r)}`);
    console.log(`      → 要发新版本请改 VERSION 并重新 prepare；要处理这里的草稿/附件请人工在网页上做。`);
  } else {
    ok(`${标签} 上还没有任何 Release（草稿或正式版）—— 可以新建`);
  }
  const 远端提交 = await 远端标签提交(标签);
  if (远端提交 && 远端提交 !== 候选.提交) die(`远端标签 ${标签} 指向 ${远端提交}，候选提交是 ${候选.提交} —— 标签与候选版对不上，停下`);
  if (远端提交) ok(`远端标签 ${标签} → ${远端提交.slice(0, 8)}（与候选提交一致）`);
  else note(`远端还没有 ${标签} 标签：发布时 GitHub 会在候选提交上创建，发布后本脚本会核对`);

  // 同 tag 已有 Release：**真实运行在这里就停下**（本文件的安全契约：绝不覆盖、也绝不在同一个 tag 上再建一个）。
  // 预演不做事，只把结论打印出来并 exit 0 —— 两条路走同一个判断，不会再分叉。
  if (会停下) {
    blank();
    if (!DRY) die(`${标签} 上已经有 ${同标签.length} 个 Release（见上面的报告）—— 不建、不传、不发布，停下。`);
    stepHead('◆', '预演结论：真实运行会停下（不动任何东西）');
    info('真实运行会在这里停下并 exit 1，不建、不传、不发布（原因见上）。');
    info('预演没有建、没有传、没有发布任何东西（HTTP 层在预演模式下只允许 GET）。');
    return 0;
  }

  if (DRY) {
    blank();
    stepHead('◆', '预演结论：可以发布');
    info('真实运行会做这四件事（每一步都能独立核对）：');
    info(`1) 建 Release 草稿：tag=${标签} target=${候选.提交.slice(0, 8)}「${候选.说明.split(/\r?\n/)[0].slice(0, 40)}…」`);
    info(`2) 上传 ${候选.附件.length} 个附件：${候选.附件.join('、')}`);
    info('3) 发布为正式版（draft=false，prerelease=false）');
    info('4) 实测下载四个附件，SHA256 与 SHA256SUMS.txt 逐字符比对，并复核远端标签指向');
    blank();
    info('预演没有建、没有传、没有发布任何东西（HTTP 层在预演模式下只允许 GET）。');
    return 0;
  }

  stepHead('③', '建 Release 草稿');
  const 草稿 = await 建草稿(版本, 候选.提交, 候选.说明);
  await 断言同标签唯一(标签, 草稿.id);

  stepHead('④', '上传四个附件');
  await 传全部附件(草稿.id, 候选);

  stepHead('⑤', '发布为正式版');
  await 发布为正式版(草稿.id, 候选);

  stepHead('⑥', '实测下载核对（用户依赖这份清单自动更新）');
  await 实测下载核对(版本, 候选);

  blank();
  console.log('════════ 发布完成 ════════');
  info(`标签：${标签}（远端指向 ${候选.提交.slice(0, 8)}${本地标签提交(标签) ? '' : '；本机还没这个标签，可 git tag 后 push'}）`);
  info(`还没推的代码/标签：git push origin --tags`);
  info('用户侧：看板「检查更新」读最新正式 Release 的 latest.json，无需其它动作。');
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (e !== 停下) throw e;   // 真异常照常抛出（带栈）；核对不过/拒绝执行是干净退出
  process.exitCode = 1;
}
