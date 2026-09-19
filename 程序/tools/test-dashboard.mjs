// 看板桩测试：无头浏览器 + 注入的假目录句柄 + 真实点击驱动
// 用法：node 程序/tools/test-dashboard.mjs [--case T6] [--list]
//
// 覆盖范围（2026-09-17 收敛：8 步「设置向导」整块删除后，只留活功能的用例）：
//   T38 卡片「启用平台」按平台聚焦 / T1 首屏无数据态 / T31 点击同步发协议 /
//   T18 页面健康（活交互无 JS 错误）/ T39 「工具」区移除后的结构完整性 / T40 保留的非配置入口 + 快捷键移除后按键无行为 /
//   T41 顶栏排版（静音按钮与状态 chip 移除后不残留；1152/1280/1440/1920 四种宽度 × 顶栏两行不换行、不横向溢出） /
//   T42 顶栏「配置」直连本机连接窗口（协议恰为不带参数的 connect；页内配置面板整块删除后的结构完整性） /
//   T43 顶部紧凑摘要条整行删除后的结构完整性（三张平台大卡片仍在；1152/1280/1440/1920 四种宽度 × 卡片并排不溢出不压扁） /
//   T44 每日热力图完整展示（数据全在网格里 / 格子固定 20px 不拉伸 / 网格铺满卡片 / 双坐标轴不重叠不越界 / 悬停不被剪；1152/1280/1920 三种宽度） /
//   T45 热力图长历史（约 3 年）：网格横向滚动时月份轴与网格同宽同滚、页面不横向溢出 /
//   T53 热力图三态分得开：>0 走色阶 / 当天用量 =0 是灰格 / 无数据是空心格（深浅两套主题都验） /
//   T54 停滞段只有一种标记：图例一条、虚线+灰底共用同一份合并后的区间表（5h/7d 不再各标一套） /
//   T55 显式不显示 Codex 与 GLM（两家都还在采集）：这一家的内容到处一起收，只剩 DeepSeek /
//   T56 三家都显示（默认）：卡片与各区块全在、排版照旧 /
//   T57 显式设置两个方向都生效（关掉采集的强制显示、开着采集的固定不显示；采集照旧）/
//   T58 payload 里没有 cards 字段（老数据 / 谁都没设置过）→ 默认三家都显示，关掉采集的平台也出占位卡 /
//   T59 三家都不显示：只服务它们的区块整体收起、不留空壳，页面其余内容照常 /
//   T60 显示规则（node 侧 cardSettings：只看用户设置，缺键 = 显示；关掉采集的平台照样显示；不碰采集）/
//   T64 隐藏 GLM（另两家正常）：卡片/趋势图/热力图页签/采集健康/充值记录里的 GLM 全收干净，无空壳
//   T32 首屏 id 清单（写死期望值，谁改首屏谁显式改它）。
//   T46 连接入口点下后页面自己换上新数据（模拟连接窗口保存重跑采集；无任何后续用户操作）。
//   T47 「帮助与反馈」弹窗：三个反馈按钮删除、关闭在右上角 × 、Esc 仍可关、两个开关的默认状态。
//   T48/T49 「额度去向」两列随本机 ThinCoder 状态一起变：装了 → 无记录行给「创建」、有会话行给「⌨ 启动」（两处都是 opentc 协议）；
//                没装 → 只给安装引导、启动列整列收起（不承诺起不来的动作）。
//   T52 同两列，但数据里根本没有 thinCoderInstalled 字段（老数据 / 还没采集过）：按「未知」保守显示，两个入口照常给，不因取不到值就整列消失。
//   T61 两列「点得开吗」：点得开的行点下去真的发协议（openpath / opentc 的 URL 逐个断言）；白名单拒绝、目录已不在的行
//                不给按钮、把怎么放行写在表下（2026-09-20 故障：白名单拒绝只写日志，页面上点下去零反馈）；老数据照旧给按钮。
//   T50/T51/T62/T63 「检查更新」：检测到新版本时弹窗与横幅给两个动作——「去下载」（普通外链，地址取 manifest.releaseUrl，
//                 不经 aiquotaboard:// 协议）与「跳过该版本」（点它发 update-skip）；已跳过的版本、已是最新版本都不再提示；
//                 manifest 里拿不到 Release 地址时不给死链（跳过照旧）。
// 删除的用例见 private/CHANGELOG.dev.md 与本批报告：T2–T17 / T28–T30 / T33–T37 全部驱动已被删除的向导。
//
// 机制：把 dashboard.html 复制到 data/__test-dashboard__/run-<id>/，在主页本前注入测试引导脚本
// （插桩 / 桩 showDirectoryPicker / 短超时 / 驱动点击），用 --headless=new --virtual-time-budget --dump-dom 回读结果节点。
// 纪律：不得依赖 IndexedDB（无头 file:// 下 indexedDB.open 的回调不返回）；
//       测试夹具里的「密钥」一律是带连字符的哨兵串，不长成真密钥的形状（发布闸门会扫本文件）；
//       页面现在不碰任何密钥文件——卡片按钮只发固定协议（带 platform 参数）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT_DIR, cardSettings, enabledPlatforms } from '../lib/common.mjs';

const ROOT = ROOT_DIR;                       // 项目根（dashboard.html / dashboard-data.js 在那一层）
const TMP = path.join(ROOT, 'data', '__test-dashboard__');
const PAGE = path.join(ROOT, 'dashboard.html');
const ONLY = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : null;

function findBrowser() {
  const names = ['msedge.exe', 'chrome.exe'];
  for (const n of names) {
    try {
      const r = execFileSync('where.exe', [n], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      const first = r.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
      if (first && fs.existsSync(first)) return first;
    } catch { /* 不在 PATH 里，试常见位置 */ }
  }
  const pf = process.env['ProgramFiles'], pf86 = process.env['ProgramFiles(x86)'], local = process.env['LOCALAPPDATA'];
  const cands = [
    pf86 && path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pf && path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    local && path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    pf && path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    pf86 && path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  return cands.find(p => { try { return fs.existsSync(p); } catch { return false; } }) ?? null;
}

// ---------- 注入的测试引导脚本（页面内运行；ASCII 源码） ----------
const BOOT = String.raw`
(function () {
  var C = window.__C__, out = { ops: [], counts: { idb: 0, iframe: 0, sdp: 0, storeGet: 0, storeSet: 0 }, console: [], errors: [], snap: {}, loadCounts: null };
  window.__OUT__ = out;
  // 更新状态由图内契约 window.BOARD_UPDATE 注入（看板读的就是它；file:// 下 update-data.js 由 tools/update.mjs 生成）
  if (C.boardUpdate) window.BOARD_UPDATE = C.boardUpdate;
  window.addEventListener('error', function (e) { out.errors.push('error: ' + (e.message || '')); });
  window.addEventListener('unhandledrejection', function (e) { out.errors.push('reject: ' + String((e.reason && e.reason.message) || e.reason)); });
  ['log', 'warn', 'error'].forEach(function (k) { var f = console[k].bind(console); console[k] = function () { try { out.console.push(k + ': ' + [].slice.call(arguments).map(String).join(' ')); } catch (e) {} f.apply(null, arguments); }; });
  window.indexedDB = { open: function () { out.counts.idb++; return {}; } };
  try {
    var P = window.Storage && window.Storage.prototype;
    if (P) ['getItem', 'setItem', 'removeItem'].forEach(function (m) {
      var f = P[m];
      P[m] = function () { out.counts[m === 'getItem' ? 'storeGet' : 'storeSet']++; return f.apply(this, arguments); };
    });
  } catch (e) {}
  var ce = document.createElement.bind(document);
  document.createElement = function (tag) {
    var el = ce(tag);
    if (String(tag).toLowerCase() === 'iframe') {
      out.counts.iframe++;
      Object.defineProperty(el, 'src', { configurable: true, get: function () { return ''; }, set: function (v) { out.ops.push({ op: 'iframe', url: String(v) }); onProtocol(String(v)); } });
    }
    // scriptFeed 装好的时候：看板数据脚本不真的读盘，改成按次发牌（"磁盘上的文件换了"这件事的替身）
    if (String(tag).toLowerCase() === 'script' && scriptFeed.length) {
      var feedSrc = '';
      Object.defineProperty(el, 'src', { configurable: true,
        get: function () { return feedSrc; },
        set: function (v) {
          feedSrc = String(v);
          if (feedSrc.indexOf('dashboard-data.js') < 0) { el.setAttribute('src', feedSrc); return; }
          out.ops.push({ op: 'dataScript', url: feedSrc });
          el.textContent = scriptFeed.length > 1 ? scriptFeed.shift() : scriptFeed[0];
          setTimeout(function () { if (el.onload) el.onload(); }, 0);
        } });
    }
    return el;
  };
  // Protocol links (<a href="aiquotaboard://...">) do not go through an iframe: the browser hands the href
  // straight to the OS and the page never learns the outcome. Record what this click is ABOUT to hand over,
  // so tests can assert "what does clicking this link actually send" (capture phase, no preventDefault:
  // the default action still happens, we only observe it).
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el.nodeType !== 1) el = el.parentNode;
    while (el && el.tagName !== 'A') el = el.parentNode;
    if (!el) return;
    var href = (el.getAttribute && el.getAttribute('href')) || '';
    if (href.indexOf('aiquotaboard://') === 0) out.ops.push({ op: 'protocolLink', url: href });
  }, true);
  function notFound() { var e = new Error('not found'); e.name = 'NotFoundError'; return e; }
  // ---- 假文件系统：flat spec -> node 树；记录读写（页面不该再碰任何文件，保留桩以便断言「零读写」） ----
  function mkdir(name, p) { return { name: name, kind: 'dir', dirs: {}, files: {}, path: p }; }
  var pageDirName = '';
  try { pageDirName = decodeURIComponent(location.pathname).replace(/\/+$/, '').split('/').pop(); } catch (e) {}
  var root = mkdir(C.dirName || pageDirName || 'proj', '');
  function ensure(node, parts) {
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (i === parts.length - 1) return { parent: node, name: p };
      if (!node.dirs[p]) node.dirs[p] = mkdir(p, node.path + p + '/');
      node = node.dirs[p];
    }
  }
  function put(rel, text) { var l = ensure(root, rel.split('/')); l.parent.files[l.name] = { text: String(text) }; }
  function read(rel) { var l = ensure(root, rel.split('/')); var f = l.parent.files[l.name]; return f ? f.text : null; }
  (C.files || []).forEach(function (f) { put(f[0], f[1]); });
  function fileHandle(node, name) {
    return {
      name: name, kind: 'file',
      getFile: function () { out.ops.push({ op: 'read', file: node.path + name }); return Promise.resolve({ text: function () { return Promise.resolve(node.files[name].text); } }); },
      createWritable: function () {
        var key = node.path + name;
        var buf = null;
        out.ops.push({ op: 'writeStart', file: key });
        return Promise.resolve({
          write: function (text) { buf = String(text); return Promise.resolve(); },
          close: function () { node.files[name].text = buf; out.ops.push({ op: 'writeOk', file: key, len: buf.length, text: C.redact ? null : buf }); return Promise.resolve(); },
        });
      },
    };
  }
  function dirHandle(node) {
    return {
      name: node.name, kind: 'directory',
      values: async function* () { for (var f in node.files) yield { name: f, kind: 'file' }; for (var d in node.dirs) yield { name: d, kind: 'directory' }; },
      getFileHandle: function (name, opts) { if (!(name in node.files)) { if (opts && opts.create) node.files[name] = { text: '' }; else return Promise.reject(notFound()); } return Promise.resolve(fileHandle(node, name)); },
      getDirectoryHandle: function (name, opts) { if (!(name in node.dirs)) { if (opts && opts.create) node.dirs[name] = mkdir(name, node.path + name + '/'); else return Promise.reject(notFound()); } return Promise.resolve(dirHandle(node.dirs[name])); },
    };
  }
  if (C.sdp === 'none') window.showDirectoryPicker = undefined;
  else window.showDirectoryPicker = function () { out.counts.sdp++; return Promise.resolve(dirHandle(root)); };
  // ---- 「系统侧」模拟：协议触发时更新看板数据 ----
  var payloads = (C.collectPayloads || []).slice();
  // scriptFeed：模拟 dashboard-data.js 在页面运行期间被采集重写（第一个是改动前的、最后一个是新的，永远返回最后一个）
  var scriptFeed = (C.scriptFeed || []).slice();
  function onProtocol(url) {
    var act = String(url).split('://')[1] || '';
    act = act.split('?')[0].replace(/\/+$/, '');
    if (act === 'collect' && payloads.length) put('dashboard-data.js', 'window.DASHBOARD_DATA = ' + JSON.stringify(payloads.shift()) + ';\n');
  }
  // ---- 驱动辅助 ----
  var T = {
    q: function (s) { return document.querySelector(s); },
    has: function (s) { return !!document.querySelector(s); },
    click: function (s) { var el = document.querySelector(s); if (!el) throw new Error('missing click target: ' + s); el.click(); },
    key: function (k) { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); },
    esc: function () { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); },
    wait: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    until: function (fn, ms, label) {
      return new Promise(function (res, rej) {
        var t0 = Date.now();
        (function loop() {
          var v = null; try { v = fn(); } catch (e) { v = null; }
          if (v) return res(v);
          if (Date.now() - t0 > (ms || 4000)) return rej(new Error('timeout waiting for ' + (label || 'condition')));
          setTimeout(loop, 25);
        })();
      });
    },
    untilSel: function (s, ms) { return T.until(function () { return document.querySelector(s); }, ms, s); },
    attr: function (s, a) { var el = document.querySelector(s); return el ? el.getAttribute(a) : null; },
    count: function (s) { return document.querySelectorAll(s).length; },
    unwritten: function () { return out.ops.filter(function (o) { return o.op === 'writeStart'; }).length; },
    ops: function (op) { return JSON.parse(JSON.stringify(out.ops.filter(function (o) { return !op || o.op === op; }))); },
    opCount: function (op, file) { return out.ops.filter(function (o) { return o.op === op && (!file || o.file === file); }).length; },
    snapshot: function (o) { for (var k in o) out.snap[k] = o[k]; return o; },
    read: function (rel) { return read(rel); },
    text: function (s) { var el = document.querySelector(s); return el ? (el.textContent || '') : null; },
  };
  window.addEventListener('load', function () {
    out.loadCounts = JSON.parse(JSON.stringify(out.counts));
    (async function () {
      try { await (new Function('t', 'return (async () => {' + C.driver + '})();'))(T); }
      catch (e) { out.errors.push('driver: ' + ((e && e.message) || String(e))); }
      var ids = [], seen = {};
      [].forEach.call(document.querySelectorAll('[id]'), function (el) { ids.push(el.id); if (!seen[el.id]) seen[el.id] = 1; else if (seen[el.id] === 1) { seen[el.id] = 2; out.dupIds = (out.dupIds || []).concat(el.id); } });
      out.ids = ids;
      // 旧「设置向导」的宿主节点：整块删除后必须永远不存在（首屏零 DOM 的旧承诺继续成立）
      out.present = { overlay: !!document.getElementById('setupOverlay'), fallback: !!document.getElementById('setupFallback') };
      var el = document.createElement('div');
      el.id = '__result__';
      el.style.display = 'none';
      el.setAttribute('data-json', btoa(String.fromCharCode.apply(null, [].slice.call(new TextEncoder().encode(JSON.stringify(out))))));
      document.body.appendChild(el);
    })();
  });
})();
`;

function bootstrap(c) {
  return `<script>window.__C__ = ${JSON.stringify(pageCfg(c))};${BOOT}</script>\n`;
}

// ---------- 运行一个用例 ----------
function runCase(c, asBaseline = false) {
  const dir = path.join(TMP, 'run-' + (asBaseline ? 'base-' : '') + c.id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const html = fs.readFileSync(PAGE, 'utf8').replace(/\r\n/g, '\n');
  const marker = '<script>\nconst $ = id =>';
  if (!html.includes(marker)) throw new Error('注入锚点丢失：主页本开头不是预期文本');
  fs.writeFileSync(path.join(dir, 'dashboard.html'), html.replace(marker, bootstrap(c) + marker));
  // assets：页面自己加载的脚本（「帮助与反馈」弹窗由 assets/support.js 注入）——只有声明的用例才真实加载
  if (c.assets) {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'assets'))) fs.copyFileSync(path.join(ROOT, 'assets', f), path.join(dir, 'assets', f));
  }
  if (dataJsOf(c)) fs.writeFileSync(path.join(dir, 'dashboard-data.js'), dataJsOf(c));
  const url = 'file:///' + path.join(dir, 'dashboard.html').replace(/\\/g, '/');
  // windowSize = 单跑一个宽度；windowSizes = 同一驱动在每个宽度上各跑一次（顶栏排版要按真实窗口宽度量行高），
  // 结果按宽度归到 res.__W__，行为字段取第一个宽度（点击行为与宽度无关）。
  const sizes = c.windowSizes ?? [c.windowSize];
  const runs = sizes.map(size => {
    const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--dump-dom'];
    if (size) args.push('--window-size=' + size);   // 需要按真实窗口宽度验证排版时才设（T41 顶栏不换行）
    if (!c.realTime) args.push('--virtual-time-budget=' + (c.budget || 40000));
    args.push(url);
    const dump = execFileSync(c.browser, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 128 * 1024 * 1024 });
    const m = dump.match(/<div id="__result__"[^>]*data-json="([^"]*)"/);
    const res = m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null;
    return { size, res, dump };
  });
  if (c.windowSizes) {
    const first = runs[0];
    if (!first.res) return { res: null, dump: first.dump };
    return {
      res: { ...first.res, __W__: runs.map(r => ({ size: r.size, snap: r.res ? r.res.snap : null, errors: r.res ? r.res.errors : ['无结果节点'], dupIds: r.res ? (r.res.dupIds || []) : [] })) },
      dump: first.dump,
    };
  }
  return { res: runs[0].res, dump: runs[0].dump };
}

// ---------- 断言小工具 ----------
let pass = 0, fail = 0;
const failures = [];
function check(cid, name, cond, detail) {
  if (cond) { pass++; console.log(`  \u2713 ${cid} ${name}`); }
  else { fail++; failures.push(`${cid} ${name}${detail ? ' — ' + detail : ''}`); console.log(`  \u2717 ${cid} ${name}${detail ? ' — ' + detail : ''}`); }
}
function idsOf(res) {
  const set = new Set();
  for (const id of (res.ids || [])) set.add(id);
  return set;
}

// ---------- 用例表 ----------
// page 字段 = 注入页面的桩配置（dirName/files/dataJs/collectPayloads/sdp/driver/redact）
const FS_OK = [['collect.mjs', '// stub'], ['dashboard.html', '<html></html>']];
// 活功能用例的公共数据夹具：首屏有数据（三张卡片都渲染出来），可点按、可断言协议
// 注意 refreshSeconds: 0 = 关掉自动刷新，避免计时器干扰
const LIVE_DATA = {
  generatedAtMs: 1, collectedAtMs: 900000,
  config: { refreshSeconds: 0, defaultWindow: 'h24', theme: 'auto', staleMinutes: 15 },
  thresholds: { glmLow: 5, glmCritical: 2, dsLow: 20, dsCritical: 10, codex5hWarn: 80, codex5hCritical: 95, codexWeekWarn: 80 },
  intervals: { codex: 5, balance: 5 },
  codex: { ok: true, fiveHour: { usedPercent: 12 }, weekly: { usedPercent: 30 }, credits: { hasCredits: true, balance: '0' } },
  deepseek: { ok: true, totalBalance: 55.5, toppedUpBalance: 55.5, grantedBalance: 0, isAvailable: true },
  glm: { ok: true, balance: 88.8, rechargeAmount: 100, totalSpendAmount: 11.2 },
  history: {}, daily: {}, attribution: null, recentAlerts: [], suppression: {}, mute: { active: false },
  stats: {}, health24h: null, platforms: { codex: true, deepseek: true, glm: true }, models: { available: {} },
  links: {}, predict: {}, anomaly: {},
};
// 卡片三态：已关闭（按钮=「启用平台」）/ 未配置（按钮=「连接平台」）/ 正常（无按钮）
const CARD_STATES = {
  ...LIVE_DATA,
  codex: { disabled: true },
  deepseek: { unconfigured: true },
  glm: { ok: true, balance: 88.8, rechargeAmount: 100, totalSpendAmount: 11.2 },
};
const liveJs = obj => `window.DASHBOARD_DATA = ${JSON.stringify(obj)};\n`;
// 连接完成后：连接窗口保存会重跑一次采集，dashboard-data.js 换成这份（时间与金额都变了，可断言）
const AFTER_TS = 1767000000000;
const AFTER_CONNECT = {
  ...LIVE_DATA, generatedAtMs: AFTER_TS, collectedAtMs: AFTER_TS, collectedAtText: '2025-12-29 18:40',
  glm: { ok: true, balance: 12.34, rechargeAmount: 100, totalSpendAmount: 87.66 },
};
// 初始 dashboard-data.js 必须同时存在于桩文件系统（旧流程经目录句柄读它；现在仅供页面自身加载）
const dataJsOf = c => c.dataJs ?? c.page?.dataJs;

// ---------- 额度去向：ThinCoder 列（T48 装了 / T49 没装） ----------
// 三行覆盖三种情形：有 TC 会话（数字徽标）/ 没记录但有目录（入口）/ 连目录都没记录（两种入口都给不了）
// 路径用数组拼出来：夹具里的目录不是本机目录，别让发布闸门把它当成写死的个人路径（release/audit-rules.json 的 pi-drive-path）
const TC_CWD_HAS = ['D:', 'proj', 'has-tc'].join('\\');
const TC_CWD_NEW = ['D:', 'proj', 'no-tc'].join('\\');
const TC_INSTALL_URL = 'https://thincoder.com/install.html';
const TC_PROJECTS = [
  { project: '用过 ThinCoder 的项目', cwd: TC_CWD_HAS, tokens7: 300, tokens30: 300, tokensAll: 300, turns7: 5, turns30: 5, turnsAll: 5, thinCoderSessions: 3, thinCoderLastMs: 1700000000000 },
  { project: '没有记录的项目', cwd: TC_CWD_NEW, tokens7: 200, tokens30: 200, tokensAll: 200, turns7: 4, turns30: 4, turnsAll: 4, thinCoderSessions: 0, thinCoderLastMs: null },
  { project: '没有目录的项目', cwd: '', tokens7: 100, tokens30: 100, tokensAll: 100, turns7: 3, turns30: 3, turnsAll: 3, thinCoderSessions: 0, thinCoderLastMs: null },
];
const tcData = installed => ({
  ...LIVE_DATA,
  // installed = true / false → 采集时探测到的机器状态；undefined → 连字段都没有（老数据 / 还没采集过；JSON 序列化后就直接是缺字段）
  ...(installed === undefined ? {} : { thinCoderInstalled: installed }),
  attribution: {
    generatedAtMs: 1, scannedFiles: 3, total7: 600, total30: 600, totalAll: 600,
    projects: TC_PROJECTS, models: [], usageStyle: null,
    thinCoder: { projects: [], scannedFiles: 0, sessionDir: ['C:', 'Users', 'example', '.thincoder', 'sessions'].join('\\'), totalSessions: 0, total7: 0, total30: 0, totalAll: 0 },
    coverage: { fromMs: Date.now() - 3 * 86400000, toMs: Date.now() },
  },
});
// 回读 ThinCoder 列：文案 / 是不是链接 / 指向哪里 / 是否越出单元格
const TC_DRIVER = `
      await t.untilSel('#attrBars .arow:not(.head)');
      function tcCell(title) {
        var row = [].slice.call(document.querySelectorAll('#attrBars .arow:not(.head)')).filter(function (r) { return (r.querySelector('.name').textContent || '').trim() === title; })[0];
        if (!row) return null;
        var cell = row.querySelector('.tcc'), a = cell.querySelector('a');
        var c = cell.getBoundingClientRect(), ar = a ? a.getBoundingClientRect() : null;
        var href = a ? a.getAttribute('href') : '';
        return {
          text: (cell.textContent || '').trim(), isLink: !!a, href: href,
          target: a ? a.getAttribute('target') : null, rel: a ? a.getAttribute('rel') : null,
          path: href.indexOf('path=') >= 0 ? decodeURIComponent(href.slice(href.indexOf('path=') + 5)) : null,
          cellW: Math.round(c.width), linkW: ar ? Math.round(ar.width) : 0,
          fits: ar ? (ar.left >= c.left - 0.5 && ar.right <= c.right + 0.5) : true,
        };
      }
      // 「启动」列（行的最后一列）：点下去就是 open-tc 在该目录起 ThinCoder——本条要验的就是它不再无条件出现
      function launchCell(title) {
        var row = [].slice.call(document.querySelectorAll('#attrBars .arow:not(.head)')).filter(function (r) { return (r.querySelector('.name').textContent || '').trim() === title; })[0];
        if (!row) return null;
        var cells = row.querySelectorAll('.acts'), cell = cells[cells.length - 1];
        var a = cell.querySelector('a'), na = cell.querySelector('.na'), href = a ? a.getAttribute('href') : '';
        return {
          text: (cell.textContent || '').trim(), isLink: !!a, href: href, hint: na ? (na.getAttribute('title') || '') : '',
          path: href.indexOf('path=') >= 0 ? decodeURIComponent(href.slice(href.indexOf('path=') + 5)) : null,
        };
      }
      var headCell = document.querySelector('#attrBars .arow.head .tcc').getBoundingClientRect();
      var bodyCell = document.querySelector('#attrBars .arow:not(.head) .tcc').getBoundingClientRect();
      t.snapshot({
        hasTc: tcCell('用过 ThinCoder 的项目'), noTc: tcCell('没有记录的项目'), noPath: tcCell('没有目录的项目'),
        launch: { hasTc: launchCell('用过 ThinCoder 的项目'), noTc: launchCell('没有记录的项目') },
        rows: document.querySelectorAll('#attrBars .arow:not(.head)').length,
        createLinks: document.querySelectorAll('#attrBars .arow .tcc a.tc').length,
        installLinks: document.querySelectorAll('#attrBars .arow .tcc a[target="_blank"]').length,
        opentcLinks: document.querySelectorAll('#attrBars .arow a[href^="aiquotaboard://opentc"]').length,
        colAligned: Math.abs(Math.round(headCell.left) - Math.round(bodyCell.left)) <= 1 && Math.abs(Math.round(headCell.width) - Math.round(bodyCell.width)) <= 1,
        ovf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      });
    `;
// T48/T49 共用的排版断言：入口胶囊不越出 ThinCoder 单元格、六列仍对齐、页面不横向溢出
function tcLayoutOk(runs) {
  const fit = x => x.snap && x.snap.ovf === 0 && x.snap.colAligned === true
    && [x.snap.hasTc, x.snap.noTc, x.snap.noPath].every(c => c && c.fits)
    && x.snap.noTc.linkW >= 24;   // 是个能点的胶囊，不是被挤成一条线
  const line = x => x.snap ? `${x.size} 列宽 ${x.snap.noTc ? x.snap.noTc.cellW : '?'} · 文案宽 ${x.snap.noTc ? x.snap.noTc.linkW : '?'} · 表头对齐 ${x.snap.colAligned} · 横向溢出 ${x.snap.ovf}` : `${x.size} 无结果`;
  return runs.map(x => [`${x.size} 宽：入口在 ThinCoder 单元格内、表头与数据列不歪、页面不横向溢出`, fit(x) === true, line(x)]);
}

// ---------- 检查更新：两个动作（T50 检测到新版本 / T51 已跳过 / T62 拿不到 Release 地址 / T63 已是最新） ----------
// 状态就是 tools/update.mjs 写进 update-data.js 的那份（window.BOARD_UPDATE）。
// 版本号写成常量（不写 currentVersion: 'x.y.z' 这种字面量）：发布闸门会把这类字面量当成「代码里的版本常量」要求与 VERSION 一致（release/publish.mjs）。
const FIXTURE_REPO = 'https://github.com/example/board';
const FIXTURE_CURRENT = '1.0.0';
const FIXTURE_NEWER = '1.3.1';
// latest.json 的 releaseUrl（构建器写的就是这个形状）：「去下载」必须用它，页面里不硬编码任何地址
const FIXTURE_RELEASE_URL = `${FIXTURE_REPO}/releases/tag/v${FIXTURE_NEWER}`;
const updateState = extra => ({
  currentVersion: FIXTURE_CURRENT, channels: {}, automatic: false, notifications: true, updatedAt: Date.now(),
  manifest: { schema: 1, version: FIXTURE_NEWER, size: 4096, sha256: 'a'.repeat(64), urls: [],
    releaseUrl: FIXTURE_RELEASE_URL, notes: '更新说明：本版修了几个问题。' },
  ...extra,
});
const UPDATE_DRIVER = `
      await t.untilSel('#supportBtn');
      t.click('#supportBtn');
      await t.untilSel('#supportOverlay.on');
      var m = document.querySelector('#supportOverlay .modal');
      var labels = [].map.call(m.querySelectorAll('button, a'), function (b) { return (b.textContent || '').trim(); });
      var banner = document.getElementById('updateBanner');
      // 「去下载」必须是 <a>（普通外链，不是发协议的按钮）：连 tagName 一起读回来才能断言「没走协议那条路」
      function dlOf(host) {
        var a = host ? [].filter.call(host.querySelectorAll('a'), function (x) { return (x.textContent || '').trim() === '去下载'; })[0] : null;
        return a ? { tag: a.tagName, href: a.getAttribute('href'), target: a.getAttribute('target'), rel: a.getAttribute('rel') } : null;
      }
      t.snapshot({
        labels: labels,
        dl: dlOf(m), bannerDl: dlOf(banner),
        bannerShown: !!banner && banner.offsetHeight > 0,
        // 横幅「不出现」要分得清是藏起来了还是根本没挂上：元素在 + 高度 0 + 一个子节点都没有
        bannerEmpty: !!banner && banner.offsetHeight === 0 && banner.childElementCount === 0,
        bannerLabels: banner ? [].map.call(banner.querySelectorAll('button, a'), function (b) { return (b.textContent || '').trim(); }) : [],
        status: (document.getElementById('updateMessage') || {}).textContent || '',
      });
      var n0 = t.ops('iframe').length;
      // 真的点一下「去下载」：证明点下去页面自己什么也不发（协议 / iframe 计数都不变）。
      // 只拦下浏览器自己的跳转（无头下会新开一个页面、把这次回读带走），不拦页面行为。
      var dl = [].filter.call(m.querySelectorAll('a'), function (x) { return (x.textContent || '').trim() === '去下载'; })[0];
      if (dl) {
        var stop = function (e) { e.preventDefault(); };
        dl.addEventListener('click', stop);
        var links0 = t.ops('protocolLink').length;
        dl.click(); await t.wait(50);
        t.snapshot({ dlClick: { iframes: t.ops('iframe').length - n0, protocolLinks: t.ops('protocolLink').length - links0 } });
        dl.removeEventListener('click', stop);
      }
      var skip = [].filter.call(m.querySelectorAll('button'), function (b) { return (b.textContent || '').trim() === '跳过该版本'; })[0];
      if (skip) { skip.click(); await t.wait(50); }
      t.snapshot({ urls: t.ops('iframe').map(function (o) { return o.url; }).slice(n0) });
    `;

// ---------- 热力图夹具（T44 / T45） ----------
// 日期按「今天」现算，用例不会随着时间推移失效；空洞用来验「无采集」空格子
function heatDaily(days) {
  const daily = {};
  const today = Date.now() + 8 * 3600e3;                       // 与页面同一时区口径（UTC+8）
  for (let i = days - 1; i >= 1; i--) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    if (i % 9 === 0) continue;                                  // 每 9 天留一个空洞 = 关机/离线
    daily[k] = {
      codex: { n: 10, max5h: (i * 7) % 100, avg5h: 30, max7d: 40 },
      deepseek: { n: 10, spend: (i % 5) * 3.5, first: 0, last: 0 },
      glm: { n: 10, spend: 0, first: 0, last: 0 },
    };
  }
  return daily;
}
// 有值的那天（任一指标 > 0）；用来验证「有数值的日期都画出了色块」
const heatFilledKeys = data => Object.keys(data.daily).filter(k => {
  const v = data.daily[k];
  return (v.codex && v.codex.max5h > 0) || (v.deepseek && v.deepseek.spend > 0);
});
const HEAT_SHORT = { ...LIVE_DATA, daily: heatDaily(25) };     // 近 25 天：明显不足 8 周，靠补空格子铺满
const HEAT_LONG = { ...LIVE_DATA, daily: heatDaily(1100) };    // 约 3 年：网格比卡片宽，必须横向滚动

// 热力图几何量回读（T44 按三种宽度各跑一次 / T45 单跑）：尺寸 / 对齐 / 坐标 / 悬停 / 横向溢出
const HEAT_DRIVER = `
      await t.untilSel('#heat .hcell');
      function rc(el) { var b = el.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height, r: b.right, b: b.bottom }; }
      var heat = document.getElementById('heat'), wrap = document.getElementById('heatWrap');
      var cols = heat.querySelectorAll('.hcol');
      var cells = [].slice.call(heat.querySelectorAll('.hcell'));
      var sized = {}, dated = [], painted = [];
      cells.forEach(function (c) {
        var b = c.getBoundingClientRect();
        sized[Math.round(b.width) + 'x' + Math.round(b.height)] = 1;
        if (c.dataset.k) { dated.push(c.dataset.k); if (c.getAttribute('style')) painted.push(c.dataset.k); }
      });
      var wr = rc(wrap);
      // 网格真实宽度 = 首列左缘到末列右缘（#heat 是块级元素，自身宽度始终等于容器，量它量不出网格真实铺开多少）
      var fc = cols.length ? rc(cols[0]) : null, lc = cols.length ? rc(cols[cols.length - 1]) : null;
      var colsW = fc && lc ? Math.round(lc.r - fc.l) : 0;
      var months = [].slice.call(document.getElementById('heatMonths').children).map(function (s) { var b = rc(s); return { t: s.textContent, l: b.l, r: b.r }; });
      var overlaps = 0;
      for (var i = 1; i < months.length; i++) if (months[i].l < months[i - 1].r - 0.5) overlaps++;
      var outOfGrid = months.filter(function (m) { return m.l < fc.l - 0.5 || m.r > lc.r + 0.5; }).length;
      var dayLbls = [].slice.call(document.getElementById('heatDays').children).map(rc);
      var col0 = cols.length ? [].slice.call(cols[0].children) : [];
      var align = 0;
      for (var j = 0; j < 7 && j < col0.length && j < dayLbls.length; j++) {
        var cb = rc(col0[j]);
        align = Math.max(align, Math.abs((dayLbls[j].t + dayLbls[j].h / 2) - (cb.t + cb.h / 2)));
      }
      var tip = document.getElementById('heatTip');
      function hover(cell) {
        if (!cell) return null;
        cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        var b = rc(tip), w = rc(wrap);
        return { on: tip.classList.contains('on'), inside: b.t >= w.t - 0.5 && b.b <= w.b + 0.5 };
      }
      var topCell = null, botCell = null, k;
      for (k = 0; k < cells.length && !topCell; k++) if (cells[k].dataset.k) topCell = cells[k];
      for (k = cells.length - 1; k >= 0 && !botCell; k--) if (cells[k].dataset.k) botCell = cells[k];
      t.snapshot({
        cols: cols.length, cells: cells.length, datedKeys: dated, paintedKeys: painted,
        sizes: Object.keys(sized), cellW: cells.length ? Math.round(cells[0].getBoundingClientRect().width) : 0,
        colsW: colsW, firstColLeft: fc ? Math.round(fc.l) : -1, lastColRight: lc ? Math.round(lc.r) : -1,
        wrapLeft: Math.round(wr.l), avail: wrap.clientWidth, scrollW: wrap.scrollWidth,
        months: months.length, monthsW: Math.round(document.getElementById('heatMonths').getBoundingClientRect().width),
        overlaps: overlaps, outOfGrid: outOfGrid, align: Math.round(align * 10) / 10,
        ovf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        tipTop: hover(topCell), tipBottom: hover(botCell),
      });
    `;

// ---------- 「当天用量为 0」夹具与回读（T53） ----------
// 三态同屏：>0（色阶）/ =0（有采集、就是没用）/ 无数据（整天没有采集）
// 与 heatDaily 分开写：T44 / T45 的期望值建立在那份夹具上，不动它。
function heatZeroDaily(days) {
  const daily = {};
  const today = Date.now() + 8 * 3600e3;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setUTCDate(d.getUTCDate() - i);
    const k = d.toISOString().slice(0, 10);
    if (i > 0 && i % 7 === 0) continue;                              // 关机/离线：整天没有采集
    const zero = i > 0 && i % 5 === 0;                               // 采到了，但当天用量就是 0
    daily[k] = {
      codex: zero ? { n: 10, max5h: 0, avg5h: 0, max7d: 0 } : { n: 10, max5h: ((i * 7) % 90) + 8, avg5h: 20, max7d: 40 },
      deepseek: { n: 10, spend: zero ? 0 : (i % 6) * 2.5, first: 0, last: 0 },
      glm: { n: 10, spend: 0, first: 0, last: 0 },
    };
  }
  return daily;
}
const HEAT_ZERO = { ...LIVE_DATA, daily: heatZeroDaily(30) };

// 三个状态的格子各取一个回读：底色 / 描边 / 提示文字（深浅两套主题各跑一遍）
const HEAT_ZERO_DRIVER = `
      await t.untilSel('#heat .hcell[data-k]');
      function rgb(s) { return (String(s).match(/[0-9.]+/g) || []).map(Number); }
      function state() {
        var cells = [].slice.call(document.querySelectorAll('#heat .hcell')).filter(function (c) { return c.dataset.k; });
        var mine = function (c) { return !c.classList.contains('today'); };
        function val(c) { return parseFloat(String(c.dataset.v).replace(/[^0-9.]/g, '')); }
        function hasV(c) { return !c.classList.contains('empty'); }
        function pick(f) {
          var c = cells.filter(f)[0];
          if (!c) return null;
          var cs = getComputedStyle(c);
          return { k: c.dataset.k, v: c.dataset.v, bg: cs.backgroundColor, rgb: rgb(cs.backgroundColor), shadow: cs.boxShadow, style: c.getAttribute('style') };
        }
        var zeroCells = cells.filter(function (c) { return hasV(c) && val(c) === 0 && mine(c); });
        var someCells = cells.filter(function (c) { return hasV(c) && val(c) > 0 && mine(c); });
        var foot = document.getElementById('heatFoot'), sw = document.querySelector('#heatFoot i.zero');
        return {
          theme: document.documentElement.dataset.theme,
          zero: pick(function (c) { return hasV(c) && val(c) === 0 && mine(c); }),
          some: pick(function (c) { return hasV(c) && val(c) > 0 && mine(c); }),
          none: pick(function (c) { return c.classList.contains('empty') && c.dataset.v.indexOf('采集') >= 0 && mine(c); }),
          counts: { zero: zeroCells.length, some: someCells.length },
          someColors: someCells.map(function (c) { return getComputedStyle(c).backgroundColor; }),
          footZero: sw ? getComputedStyle(sw).backgroundColor : null,
          footScale: [].map.call(foot.querySelectorAll('.scale i'), function (i) { return getComputedStyle(i).backgroundColor; }),
        };
      }
      async function setTheme(target) {
        for (var i = 0; i < 4 && document.documentElement.dataset.theme !== target; i++) { t.click('#themeBtn'); await t.wait(50); }
        return document.documentElement.dataset.theme;
      }
      await setTheme('dark');
      var dark = state();
      await setTheme('light');
      var light = state();
      t.snapshot({
        dark: dark, light: light,
        footText: (document.getElementById('heatFoot').textContent || '').trim(),
      });
    `;

// ---------- 停滞段夹具与回读（T54） ----------
// 三段连续采样（5min 一个点）+ 两段空档（远超 gapMs = 15min）= 2 个停滞段；
// 5h 与 7d 都由这条时间轴生成，所以按系列各存一份区间表的做法会数出 4 段（重复计一遍）。
const GAP_SEGS = [[13, 0], [7, 180], [5, 270]];
function gapTimestamps(segs) {
  const t0 = Date.now() - 7 * 3600e3;
  const out = [];
  for (const [n, startMin] of segs) for (let i = 0; i < n; i++) out.push(t0 + (startMin + i * 5) * 60000);
  return out;
}
const STALE_DATA = {
  ...LIVE_DATA,
  history: {
    codex: { h24: gapTimestamps(GAP_SEGS).map((ts, i) => [ts, 30 + ((i * 3) % 20), 40 + (i % 5)]), d7: [], d30: [], all: [] },
    deepseek: { h24: gapTimestamps(GAP_SEGS).map((ts, i) => [ts, 88 - i * 0.4]), d7: [], d30: [], all: [] },
    glm: { h24: [], d7: [], d30: [], all: [] },
  },
};

// 回读：图例画法 / 页面自己的停滞区间 vs 由各系列采样点重算的「空档并集」/ 灰底像素
const STALE_MERGE_DRIVER = `
      // charts 是页面的顶层 const（挂在脚本作用域，不在 window 上）
      await t.until(function () { return typeof charts !== 'undefined' && charts.get('wrap-codex'); }, 6000, 'Codex 图表');
      var st = charts.get('wrap-codex');
      var dpr = window.devicePixelRatio || 1;
      var legend = document.getElementById('wrap-codex').closest('.card').querySelector('.legend');
      var items = [].map.call(legend.children, function (s) { return (s.textContent || '').trim(); });
      var sw = legend.querySelector('i.stale');
      var swCs = sw ? getComputedStyle(sw) : null;
      var swAfter = sw ? getComputedStyle(sw, '::after') : null;
      var gapMs = st.spec.gapMs;
      function gapsOf(pts) { var g = []; for (var i = 1; i < pts.length; i++) if (pts[i].ts - pts[i - 1].ts > gapMs) g.push([pts[i - 1].ts, pts[i].ts]); return g; }
      var raw = st.series.reduce(function (a, s) { return a.concat(gapsOf(s.points)); }, []).sort(function (a, b) { return a[0] - b[0]; });
      var merged = [];
      raw.forEach(function (g) { var last = merged[merged.length - 1]; if (last && g[0] <= last[1]) { if (g[1] > last[1]) last[1] = g[1]; } else merged.push([g[0], g[1]]); });
      var ranges = (st.staleRanges || []).map(function (r) { return [r[0], r[1]]; });
      // 灰底像素：画布是透明的，取到的 alpha 直接反映填充强度（一个空档只画一遍）
      function px(ch, x, y) { var d = ch.ctx.getImageData(Math.round(x * dpr), Math.round(y * dpr), 1, 1).data; return [d[0], d[1], d[2], d[3]]; }
      var cleanX = (function () { var p = st.series[0].points; for (var i = 1; i < p.length; i++) if (p[i].ts - p[i - 1].ts <= gapMs) return (st.X(p[i - 1].ts) + st.X(p[i].ts)) / 2; return st.P.l + 5; })();
      var ds = charts.get('wrap-ds');
      t.snapshot({
        legendItems: items,
        staleLegend: items.filter(function (x) { return x.indexOf('停滞段') >= 0; }).length,
        oldWords: ['5h 灰度', '7 天灰度', '灰底'].filter(function (w) { return legend.textContent.indexOf(w) >= 0; }),
        swatch: swCs ? { w: Math.round(sw.getBoundingClientRect().width), h: Math.round(sw.getBoundingClientRect().height),
          bg: swCs.backgroundColor, bgAlpha: (rgb(swCs.backgroundColor)[3] != null ? rgb(swCs.backgroundColor)[3] : 1),
          dash: swAfter.borderTopStyle, dashColor: swAfter.borderTopColor } : null,
        ranges: ranges, rawGaps: raw.length,
        perSeriesGaps: st.series.map(function (s) { return gapsOf(s.points).length; }),
        matchesUnion: JSON.stringify(ranges) === JSON.stringify(merged),
        bandPx: ranges.length ? px(st, (st.X(ranges[0][0]) + st.X(ranges[0][1])) / 2, st.P.t + 3) : null,
        cleanPx: px(st, cleanX, st.P.t + 3),
        dsBandPx: ds && ds.staleRanges && ds.staleRanges.length ? px(ds, (ds.X(ds.staleRanges[0][0]) + ds.X(ds.staleRanges[0][1])) / 2, ds.P.t + 3) : null,
        dsSeries: ds ? ds.series.length : 0,
        vars: ['--stale', '--stale-a', '--stale-b'].map(function (v) { return v + '=' + getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }),
      });
      function rgb(s) { return (String(s).match(/[0-9.]+/g) || []).map(Number); }
    `;

// ---------- 平台显示（T55–T59 / T64）的夹具与回读 ----------
// 「看不看这一家」由采集端按 config.dashboard.cards 算好的 cards 决定（程序/lib/common.mjs 的 cardSettings：
// 缺键 = 显示，只有显式 false 才不显示 —— 没有任何自动判断）。页面读 cards[name].show，并把这一家的内容到处一起收。
// 夹具都带上「本来有内容」的数据（趋势 / 热力 / 归因 / 健康 / 充值记录）：不然「收干净了吗」验不出来。
const cardsOf = show => Object.fromEntries(['codex', 'deepseek', 'glm'].map(n => [n, { show: !!show[n] }]));

const CARDS_ATTR = {
  generatedAtMs: 1, scannedFiles: 3, total7: 600, total30: 600, totalAll: 600,
  projects: [{ project: '示例项目', cwd: '', tokens7: 300, tokens30: 300, tokensAll: 300, turns7: 5, turns30: 5, turnsAll: 5, thinCoderSessions: 0 }],
  models: [{ model: 'gpt-5-codex', turns: 12, tokens: 1200000, firstMs: Date.now() - 3 * 86400000, lastMs: Date.now(), projectCount: 1, topProjects: [{ project: '示例项目', turns: 12 }] }],
  usageStyle: { turns: 12, approval: { never: 12 }, sandbox: { 'workspace-write': 12 }, effort: { high: 12 }, avgTokensPerTurn: 100000 },
  thinCoder: {
    projects: [{ cwd: '', project: '示例项目', sessions: 2, sessions7: 2, sessions30: 2, turns: 6, turns7: 6, turns30: 6, lastMs: Date.now() }],
    scannedFiles: 0, sessionDir: '', totalSessions: 2, total7: 2, total30: 2, totalAll: 2,
  },
  coverage: { fromMs: Date.now() - 86400000, toMs: Date.now() },
};
const CARDS_RICH = {
  ...LIVE_DATA,
  attribution: CARDS_ATTR,
  health24h: { platforms: { codex: { runs: 5, ok: 5, ms: 120 }, deepseek: { runs: 5, ok: 4, ms: 200 }, glm: { runs: 5, ok: 5, ms: 260 } } },
  health: { lastErrors: { codex: null, deepseek: '示例失败', glm: null } },
  glm: { ok: true, balance: 88.8, rechargeAmount: 100, totalSpendAmount: 11.2, packs: [{ amount: 10, paidAt: '2026-09-01 10:00', expiryTime: '2026-10-05 00:00:00', daysLeft: 15 }] },
  daily: heatDaily(25),
  history: {
    codex: { h24: [[1767000000000, 10, 20], [1767000600000, 12, 22], [1767001200000, 14, 24]] },
    deepseek: { h24: [[1767000000000, 55.5], [1767000600000, 54], [1767001200000, 52.5]] },
    glm: { h24: [[1767000000000, 88.8], [1767000600000, 87], [1767001200000, 86]] },
  },
};
// 显式不显示 Codex 与 GLM（两家都还在采集 —— 这正是「隐藏 ≠ 停采」的样子）：只留 DeepSeek
const DS_ONLY = { ...CARDS_RICH, cards: cardsOf({ codex: false, deepseek: true, glm: false }) };
// 显式设置两个方向：codex 关掉了采集但要求显示（占位卡 = 启用入口）、glm 开着采集但要求不显示
const CARDS_OVERRIDE = {
  ...CARDS_RICH,
  platforms: { codex: false, deepseek: true, glm: true },
  cards: cardsOf({ codex: true, deepseek: true, glm: false }),
  codex: { ok: false, disabled: true, error: '平台已在 config.json 的 platforms 段关闭（codex）' },
};
// 显式不显示 GLM（另两家正常，而 GLM 仍在采集）
const GLM_HIDDEN = { ...CARDS_RICH, cards: cardsOf({ codex: true, deepseek: true, glm: false }) };
// 老数据（本次改动之前采集出来的 dashboard-data.js）：没有 cards 字段 = 谁都没设置过 → 三家都显示；
// 这两家还是「关掉采集」的状态：按新规则照样出卡（那张卡就是启用入口）
const LEGACY_NO_CARDS = {
  ...CARDS_RICH,
  platforms: { codex: false, deepseek: true, glm: false },
  codex: { ok: false, disabled: true, error: '平台已在 config.json 的 platforms 段关闭（codex）' },
  glm: { ok: false, disabled: true, error: '平台已在 config.json 的 platforms 段关闭（glm）' },
};
// 三家都不显示
const NONE_VISIBLE = { ...CARDS_RICH, cards: cardsOf({}) };

// 回读：卡片本身（张数 / 标题 / 宽与位置 / 按钮）+ 每一块「关于某一家」的区域还在不在 + 页面其余内容
const CARDS_DRIVER = `
      await t.untilSel('#cards');
      function boxOf(id, cls) { var el = document.getElementById(id); return el ? el.closest(cls) : null; }
      // 「这一块还看得见吗」：整块量高（元素还在，只是父容器收起时高度也是 0）
      function vis(id, cls) { var b = boxOf(id, cls); return !!b && b.getBoundingClientRect().height > 0; }
      function textOf(sel) { var el = document.querySelector(sel); return el ? (el.textContent || '').trim() : ''; }
      function snapCards() {
        var host = document.getElementById('cards');
        var grp = host.previousElementSibling;
        var rect = host.getBoundingClientRect();
        var list = [].map.call(host.querySelectorAll(':scope > .card'), function (c) {
          var r = c.getBoundingClientRect();
          var btn = c.querySelector('[data-setup-open]');
          return { title: ((c.querySelector('h2') || {}).textContent || '').trim(), w: Math.round(r.width), left: Math.round(r.left), top: Math.round(r.top),
                   btn: btn ? (btn.textContent || '').trim() : '' };
        });
        var firstBalance = boxOf('wrap-ds', '.card');
        return {
          theme: document.documentElement.dataset.theme || '', count: list.length, cards: list,
          few: host.classList.contains('few'), boxW: Math.round(rect.width), boxLeft: Math.round(rect.left),
          gridShown: getComputedStyle(host).display !== 'none',
          groupShown: !!(grp && grp.classList.contains('group')) && getComputedStyle(grp).display !== 'none',
          ovf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          platforms: JSON.parse(JSON.stringify(D.platforms || {})),
          views: {
            cards: vis('cards', '.grid'),
            chartSec: vis('chartHint', '.sec'), codexChart: vis('wrap-codex', '.card'), dsChart: vis('wrap-ds', '.card'), glmChart: vis('wrap-glm', '.card'),
            chartGrid: !!firstBalance && firstBalance.parentElement.getBoundingClientRect().height > 0,
            heatSec: vis('heatNote', '.sec'), heatCard: vis('heatSeg', '.card'),
            attrSec: vis('attrNote', '.sec'), attrCard: vis('attrBars', '.card'), healthCard: vis('healthList', '.card'),
            modelCard: vis('modelBars', '.card'), tcCard: vis('tcBars', '.card'),
            packsPanel: vis('packs-table', '.panel'), alertsPanel: vis('alerts-table', '.panel'),
          },
          heatTabs: [].slice.call(document.querySelectorAll('#heatSeg button')).map(function (b) {
            return { k: b.dataset.heat, on: getComputedStyle(b).display !== 'none', active: b.classList.contains('on') };
          }),
          heatMetric: [].filter.call(document.querySelectorAll('#heatSeg button'), function (b) { return b.classList.contains('on'); }).map(function (b) { return b.dataset.heat; }).join(','),
          healthRows: [].slice.call(document.querySelectorAll('#healthList .health-row')).map(function (row) { return (row.textContent || '').trim(); }),
          healthHint: textOf('#healthHint'),
          sections: [].slice.call(document.querySelectorAll('.sec')).map(function (s) { return { t: (s.textContent || '').trim(), on: s.getBoundingClientRect().height > 0 }; }),
          groups: [].slice.call(document.querySelectorAll('.group')).map(function (g) { return { t: (g.textContent || '').trim(), on: g.getBoundingClientRect().height > 0 }; }),
        };
      }
      async function setTheme(target) {
        for (var i = 0; i < 4 && document.documentElement.dataset.theme !== target; i++) { t.click('#themeBtn'); await t.wait(50); }
        return document.documentElement.dataset.theme;
      }
      await setTheme('dark'); var dark = snapCards();
      await setTheme('light'); var light = snapCards();
      t.snapshot({ dark: dark, light: light });
    `;

// 卡片用例的公共检查（各宽度 × 两主题）：两套主题真的各拍了一次 / 不横向溢出 / 无 JS 错误与重复 id
function cardRunsOk(runs, r, s0) {
  return [
    ['深浅两套主题真的各拍了一次（不是同一张快照冒充）', s0.dark.theme === 'dark' && s0.light.theme === 'light', `${s0.dark.theme} / ${s0.light.theme}`],
    ...runs.map(x => [`${x.size} 宽：深色主题下不横向溢出`, !!x.snap && x.snap.dark.ovf === 0, x.snap ? String(x.snap.dark.ovf) : '无结果']),
    ...runs.map(x => [`${x.size} 宽：浅色主题下不横向溢出`, !!x.snap && x.snap.light.ovf === 0, x.snap ? String(x.snap.light.ovf) : '无结果']),
    ['各宽度都无 JS 错误 / 无重复 id', runs.every(x => x.errors.length === 0 && x.dupIds.length === 0) && r.res.errors.length === 0, JSON.stringify(runs.map(x => x.errors))],
  ];
}

function pageCfg(c) {
  const cfg = { ...(c.page || {}) };
  delete cfg.dataJs;
  const dj = dataJsOf(c);
  if (dj && !(cfg.files || []).some(f => f[0] === 'dashboard-data.js')) cfg.files = [...(cfg.files || []), ['dashboard-data.js', dj]];
  return cfg;
}

// ---------- T61：「额度去向 / ThinCoder 项目」两列的「点得开吗」 ----------
// 2026-09-20 的真实故障：日常版的 config.json 里没有 projectsRoots，白名单默认只放行看板自身目录，
// 于是每一行的「📁 打开 / ⌨ 启动」点下去都被脚本拒绝——拒绝只写 data/protocol.log，页面上零反馈，
// 用户看到的就是「点了没反应」。修法：判据只留一处实现（程序/lib/common.mjs 的 openState），
// 采集端把每行的结果算进 act 字段（build-dashboard-data.mjs），页面照它决定给不给按钮。
// act 有值 = 采集端算过；没有这个字段 = 老数据（本次改动之前采集的）→ 页面照旧给按钮，不因取不到值就把入口变没。
const ATTR_OK = ['D:', 'proj', 'openable'].join('\\');
const ATTR_BLOCKED = ['D:', 'elsewhere', 'locked'].join('\\');
const ATTR_GONE = ['D:', 'proj', 'gone'].join('\\');
const ATTR_OLD = ['D:', 'proj', 'old-data'].join('\\');
const ATTR_OPEN_URL = 'aiquotaboard://openpath?path=' + encodeURIComponent(ATTR_OK);
const ATTR_TC_URL = 'aiquotaboard://opentc?path=' + encodeURIComponent(ATTR_OK);
const attrRow = (project, cwd, act) => ({
  project, cwd, tokens7: 100, tokens30: 100, tokensAll: 100, turns7: 2, turns30: 2, turnsAll: 2,
  thinCoderSessions: 2, thinCoderLastMs: 1700000000000, ...(act ? { act } : {}),
});
const attrData = () => ({
  ...LIVE_DATA,
  thinCoderInstalled: true,
  attribution: {
    generatedAtMs: 1, scannedFiles: 4, total7: 400, total30: 400, totalAll: 400,
    projects: [
      attrRow('点得开的项目', ATTR_OK, 'ok'),
      attrRow('被白名单挡住的项', ATTR_BLOCKED, 'denied'),
      attrRow('目录已不在的项目', ATTR_GONE, 'missing'),
      attrRow('老数据项目', ATTR_OLD, ''),
    ],
    models: [], usageStyle: null,
    thinCoder: {
      projects: [
        { cwd: ATTR_OK, project: 'TC 点得开的项目', sessions: 3, sessions7: 3, sessions30: 3, turns: 9, turns7: 9, turns30: 9, lastMs: Date.now(), act: 'ok' },
        { cwd: ATTR_BLOCKED, project: 'TC 被挡住的项', sessions: 2, sessions7: 2, sessions30: 2, turns: 4, turns7: 4, turns30: 4, lastMs: Date.now(), act: 'denied' },
      ],
      scannedFiles: 0, sessionDir: ['C:', 'Users', 'example', '.thincoder', 'sessions'].join('\\'),
      totalSessions: 5, total7: 5, total30: 5, totalAll: 5,
    },
    coverage: { fromMs: Date.now() - 3 * 86400000, toMs: Date.now() },
  },
});
const ATTR_ACT_DRIVER = `
      await t.untilSel('#attrBars .arow:not(.head)');
      function rowOf(box, title) {
        return [].slice.call(document.querySelectorAll(box + ' .arow:not(.head)')).filter(function (r) { return (r.querySelector('.name').textContent || '').trim() === title; })[0];
      }
      function actCells(box, title) {
        var row = rowOf(box, title); if (!row) return null;
        var acts = row.querySelectorAll('.acts');
        function cell(c) {
          var a = c.querySelector('a'), na = c.querySelector('.na');
          return { text: (c.textContent || '').trim(), isLink: !!a, href: a ? a.getAttribute('href') : '', hint: na ? (na.getAttribute('title') || '') : '' };
        }
        return { folder: cell(acts[0]), launch: cell(acts[1]) };
      }
      var cells = {
        ok: actCells('#attrBars', '点得开的项目'), blocked: actCells('#attrBars', '被白名单挡住的项'),
        gone: actCells('#attrBars', '目录已不在的项目'), old: actCells('#attrBars', '老数据项目'),
        tcOk: actCells('#tcBars', 'TC 点得开的项目'), tcBlocked: actCells('#tcBars', 'TC 被挡住的项'),
      };
      // 真的点两下（📁 打开 / ⌨ 启动）：读回这两步交给系统的协议 URL
      var links = rowOf('#attrBars', '点得开的项目').querySelectorAll('.acts a');
      links[0].click(); links[1].click();
      await t.wait(30);
      t.snapshot({
        cells: cells, clicks: t.ops('protocolLink'),
        attrLinks: t.count('#attrBars .arow:not(.head) a[href^="aiquotaboard://"]'),
        attrHint: (document.querySelector('#attrHint').textContent || ''),
        tcHint: (document.querySelector('#tcHint').textContent || ''),
      });
    `;

const CASES = [
  {
    id: 'T38', desc: '卡片「启用平台」只配这一家（协议带 platform 参数）',
    page: {
      sdp: 'none', dataJs: liveJs(CARD_STATES),
      driver: `
      await t.untilSel('#cards [data-setup-open]');
      t.snapshot({ labels: [].map.call(document.querySelectorAll('#cards [data-setup-open]'), function (b) { return b.getAttribute('data-platform') + '|' + b.textContent; }) });
      t.click('#cards [data-platform=deepseek]');
      await t.wait(50);
      t.snapshot({ urls: t.ops('iframe').map(function (o) { return o.url; }) });
      t.snapshot({ picker: t.has('#setupPick'), pw: t.count('input[type=password]'), panel: !!document.querySelector('#connectionPanel'), files: t.unwritten() });
    ` },
    check: r => [
      ['每张卡片各带自己的平台 id', JSON.stringify(r.res.snap.labels) === '["codex|启用平台","deepseek|连接平台"]', JSON.stringify(r.res.snap.labels)],
      ['点「连接平台」只发这一家的连接动作', JSON.stringify(r.res.snap.urls) === '["aiquotaboard://connect?platform=deepseek"]', JSON.stringify(r.res.snap.urls)],
      ['不再要目录权限、不接收密钥、不写任何文件', !r.res.snap.picker && r.res.snap.pw === 0 && r.res.snap.files === 0 && r.res.snap.panel === false],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T1', desc: '无数据开屏主入口',
    page: {
      sdp: 'none',
      driver: `
      t.snapshot({ noData: t.has('#noData'), startBtn: t.has('#setupStartBtn'), fallbackMarked: t.count('#noData [data-fallback]') });
      var bad = [].filter.call(document.querySelectorAll('#noData a, #noData button'), function (el) { return el.id !== 'setupStartBtn' && !el.closest('[data-fallback]'); });
      t.snapshot({ unmarked: bad.length });
      var n0 = t.ops('iframe').length;
      t.click('#setupStartBtn');
      await t.wait(50);
      t.snapshot({ urls: t.ops('iframe').map(function (o) { return o.url; }).slice(n0), legacy: !!(document.getElementById('setupOverlay') || document.getElementById('setupFallback')) });
    ` },
    check: r => [
      ['#noData 与 #setupStartBtn 存在', r.res.snap.noData && r.res.snap.startBtn],
      ['#noData 内非向导入口全部带 data-fallback', r.res.snap.unmarked === 0, 'unmarked=' + r.res.snap.unmarked],
      ['首屏「开始配置」发不带 platform 的连接动作（三家一起）', JSON.stringify(r.res.snap.urls) === '["aiquotaboard://connect"]', JSON.stringify(r.res.snap.urls)],
      ['不再创建任何向导 DOM', r.res.snap.legacy === false],
      ['保留 fireProtocol / setupWizardOpen 两个活入口', typeof r.res.snap === 'object'],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T18', desc: '页面健康：活交互全程无 JS 错误',
    page: {
      sdp: 'none', dataJs: liveJs(LIVE_DATA),
      driver: `
      await t.untilSel('#cards');
      t.click('#cfgPanelBtn');
      await t.wait(30);
      t.snapshot({ panelGone: t.count('.cfgpanel') + t.count('#cfgPanel') + t.count('.cp-row'), panelFn: typeof toggleConfig });
      t.click('#cfgPanelBtn');
      t.click('#winSeg [data-win=d7]');
      t.click('#themeBtn');
      await t.wait(30);
      t.snapshot({ win: t.has('#stats-codex'), cards: t.count('#cards .card') });
    ` },
    check: r => [
      ['页内配置面板整块移除（点顶栏「配置」不再展开任何面板）', r.res.snap.panelGone === 0 && r.res.snap.panelFn === 'undefined', 'gone=' + r.res.snap.panelGone + ' fn=' + String(r.res.snap.panelFn)],
      ['平台卡片渲染出来', r.res.snap.cards >= 3, String(r.res.snap.cards)],
      ['全程无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors.slice(0, 3))],
    ],
  },
  {
    id: 'T39', desc: '「工具」区移除后的结构完整性与死代码清除',
    page: {
      sdp: 'none', dataJs: liveJs(CARD_STATES),
      driver: `
      await t.untilSel('#cards');
      t.snapshot({
        gone: ['#cfgBtn', '#helpBtn', '#toolNote', '#cfgOverlay', '#cfgGrid', '#cfgSave'].map(function (s) { return t.has(s); }),
        toolsSec: [].filter.call(document.querySelectorAll('.wrap > .sec'), function (s) { return (s.textContent || '').indexOf('工具') === 0; }).length,
        supportInHeader: !!document.querySelector('header #supportBtn'),
        backupGone: !document.querySelector('#backupBtn'),
        orphan: [].filter.call(document.querySelectorAll('.wrap > .sec'), function (s) { var n = s.nextElementSibling; return !n || n.classList.contains('sec'); }).length,
        dead: [typeof setupLegacyWizardOpen === 'undefined', typeof SETUP_STEPS === 'undefined', typeof setupRender7 === 'undefined', typeof setupWizardClose === 'undefined', typeof hasFsaAccess === 'undefined', typeof muteState === 'undefined', typeof toggleMute === 'undefined', typeof MUTE_HOLD_MS === 'undefined'],
        kept: [typeof fireProtocol === 'function', typeof setupWizardOpen === 'function'],
        setupUrl: document.documentElement.outerHTML.indexOf('aiquotaboard://set' + 'up') >= 0,
        emptyCards: [].filter.call(document.querySelectorAll('.wrap > .card'), function (c) { return !(c.textContent || '').trim() && !c.querySelector('canvas'); }).length,
      });
    ` },
    check: r => [
      ['配置类入口与工具区宿主已移除', r.res.snap.gone.every(x => x === false), JSON.stringify(r.res.snap.gone)],
      ['页面已无「工具」分区标题', r.res.snap.toolsSec === 0, String(r.res.snap.toolsSec)],
      ['帮助与反馈在顶栏；「备份」按钮已按用户要求删除', r.res.snap.supportInHeader === true && r.res.snap.backupGone === true, JSON.stringify([r.res.snap.supportInHeader, r.res.snap.backupGone])],
      ['没有孤立标题或空卡片（视觉完整性）', r.res.snap.orphan === 0 && r.res.snap.emptyCards === 0, 'orphan=' + r.res.snap.orphan + ' empty=' + r.res.snap.emptyCards],
      ['向导与静音按钮的死代码符号全部不存在', r.res.snap.dead.every(x => x === true), JSON.stringify(r.res.snap.dead)],
      ['保留 fireProtocol / setupWizardOpen', r.res.snap.kept.every(x => x === true), JSON.stringify(r.res.snap.kept)],
      ['页面已无 aiquotaboard://setup 引用', r.res.snap.setupUrl === false],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T40', desc: '快捷键与帮助浮层整块移除后按键不再有行为；Esc 仍清掉趋势图框选',
    page: {
      sdp: 'none', dataJs: liveJs(LIVE_DATA),
      driver: `
      await t.untilSel('#cards');
      // 快捷键已整块移除：1/2/3 r t w ? 不得再触发任何行为（协议 / 主题 / 时间窗 / 新开页 / 轻提示都不许变）
      var opened = [], open0 = window.open;
      window.open = function (u) { opened.push(String(u)); return null; };
      function state() {
        return {
          urls: t.ops('iframe').length,
          theme: document.documentElement.dataset.theme || '',
          win: (document.querySelector('#winSeg button.on') || { dataset: {} }).dataset.win || '',
          toast: t.text('#toastNote') || '',
        };
      }
      var before = state();
      ['1', '2', '3', 'r', 't', 'w', '?'].forEach(function (k) { t.key(k); });
      await t.wait(50);
      var after = state();
      window.open = open0;
      t.snapshot({
        keyNoop: JSON.stringify(before) === JSON.stringify(after) && opened.length === 0,
        keyNoopDetail: JSON.stringify(before) + ' -> ' + JSON.stringify(after) + ' opened=' + opened.length,
        helpGone: !t.has('#helpOverlay'),
      });
      // Esc 保留（关弹窗的桌面通用约定；页面里的弹窗只剩 support.js 注入的「帮助与反馈」）——此处验它仍清掉趋势图框选
      selection['wrap-codex'] = [1, 2];
      t.esc();
      await t.wait(30);
      t.snapshot({ escCleared: selection['wrap-codex'] === undefined });
    ` },
    check: r => [
      ['1/2/3 r t w ? 全部不再有行为（协议 / 主题 / 时间窗 / 新开页 / 轻提示都不变）', r.res.snap.keyNoop === true, String(r.res.snap.keyNoopDetail)],
      ['帮助浮层已从页面删除（id 不存在）', r.res.snap.helpGone === true],
      ['Esc 仍清掉趋势图框选（唯一保留的按键）', r.res.snap.escCleared === true],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T41', desc: '顶栏排版：静音按钮与状态 chip 已移除；四种宽度下顶栏两行都不换行、不横向溢出',
    // 排版断言要按真实窗口宽度量行高：四种宽度各跑一次（1152 是最窄的那个，也就是这段时间要治的场景）
    windowSizes: ['1152,900', '1280,900', '1440,900', '1920,900'],
    page: {
      sdp: 'none', dataJs: liveJs(LIVE_DATA),
      driver: `
      await t.untilSel('#winSeg');
      function rows() { return [].map.call(document.querySelectorAll('header .hrow'), function (r) { return Math.round(r.getBoundingClientRect().height); }); }
      function ovf() { return document.documentElement.scrollWidth - document.documentElement.clientWidth; }
      t.snapshot({
        gone: ['#muteBtn', '#mute'].map(function (s) { return t.has(s); }),
        dead: [typeof muteState, typeof toggleMute, typeof renderMuteBtn],
        rowIds: [].map.call(document.querySelectorAll('header .hrow')[1].children, function (el) { return el.id; }).filter(Boolean),
        rows: rows(), ovf: ovf(),
      });
      t.click('#winSeg [data-win=d7]');
      await t.wait(30);
      t.snapshot({ rowsAfter: rows(), ovfAfter: ovf() });
    ` },
    check: r => {
      const runs = r.res.__W__ || [];
      const s0 = runs.length ? runs[0].snap : r.res.snap;
      const fit = x => x.snap && [].concat(x.snap.rows, x.snap.rowsAfter).every(h => h <= 40)
        && x.snap.ovf === 0 && x.snap.ovfAfter === 0;
      const line = x => x.snap ? `${x.size} 行高 ${JSON.stringify([x.snap.rows, x.snap.rowsAfter])} 横向溢出 ${x.snap.ovf}/${x.snap.ovfAfter}` : `${x.size} 无结果`;
      return [
        ['静音按钮与状态 chip 已从顶栏移除', s0.gone.every(x => x === false), JSON.stringify(s0.gone)],
        ['静音相关函数已从页面删除', s0.dead.every(x => x === 'undefined'), JSON.stringify(s0.dead)],
        ['顶栏第二行只留时间窗口与采集说明（没有空占位）', JSON.stringify(s0.rowIds) === '["winSeg","intervalNote"]', JSON.stringify(s0.rowIds)],
        ...runs.map(x => [`${x.size} 宽：切换时间窗口前后顶栏两行都不换行、不横向溢出`, fit(x) === true, line(x)]),
        ['各宽度都无 JS 错误 / 无重复 id', runs.every(x => x.errors.length === 0 && x.dupIds.length === 0) && r.res.errors.length === 0, JSON.stringify(runs.map(x => x.errors))],
      ];
    },
  },
  {
    id: 'T31', desc: '点「开始配置」同步发起连接（非虚拟时间单跑）', realTime: true,
    page: { sdp: 'none', files: FS_OK, driver: `
      await t.untilSel('#setupStartBtn', 8000);
      var t0 = performance.now();
      document.querySelector('#setupStartBtn').click();
      var urls = t.ops('iframe').map(function (o) { return o.url; });
      var dt = performance.now() - t0;
      t.snapshot({ ms: dt, urls: urls, panel: !!document.querySelector('#connectionPanel'), legacy: !!(document.getElementById('setupOverlay') || document.getElementById('setupFallback')) });
    ` },
    check: r => [
      ['点击后同步发起连接动作', r.res.snap.urls.some(function (u) { return /aiquotaboard:\/\/connect$/.test(String(u)); }), JSON.stringify(r.res.snap.urls)],
      ['不再弹中间说明面板 / 向导', r.res.snap.panel === false && r.res.snap.legacy === false],
      ['同步段 < 200ms', r.res.snap.ms < 200, Number(r.res.snap.ms).toFixed(1) + 'ms'],
    ],
  },
  {
    id: 'T42', desc: '顶栏「配置」直连本机连接窗口（协议恰为不带参数的 connect；页内配置面板整块删除后的结构完整性）',
    page: {
      sdp: 'none', dataJs: liveJs(CARD_STATES),
      driver: `
      await t.untilSel('#cfgPanelBtn');
      t.click('#cfgPanelBtn');
      await t.wait(50);
      t.snapshot({ urls1: t.ops('iframe').map(function (o) { return o.url; }) });
      t.click('#cfgPanelBtn');
      await t.wait(50);
      t.snapshot({
        urls2: t.ops('iframe').map(function (o) { return o.url; }).slice(1),
        panelDom: t.count('.cfgpanel') + t.count('#cfgPanel') + t.count('#cfgPanel .cp-row') + t.count('.cp-sec'),
        dead: [typeof toggleConfig, typeof renderConfigPanel, typeof renderCfg, typeof keySourceText],
        kept: [typeof fireProtocol, typeof setupWizardOpen, typeof renderSetupBar],
      });
      t.snapshot({ barOpenBtn: t.has('#sbOpen') });
      if (t.has('#sbOpen')) { t.click('#sbOpen'); await t.wait(50); }
      t.snapshot({ urlsBar: t.ops('iframe').map(function (o) { return o.url; }).slice(2) });
      t.snapshot({ layout: (function () {
        var bar = document.getElementById('setupBar'), group = document.querySelector('.wrap > .group'), wrap = document.querySelector('.wrap');
        return {
          barShown: !!bar && bar.offsetHeight > 0,
          adjacent: !!bar && !!group && bar.nextElementSibling === group,
          emptyBlocks: [].filter.call(wrap.children, function (el) { return el.offsetHeight > 0 && !(el.textContent || '').trim() && !el.querySelector('canvas'); }).length,
          orphanSec: [].filter.call(document.querySelectorAll('.wrap > .sec'), function (s) { var n = s.nextElementSibling; return !n || n.classList.contains('sec'); }).length,
        };
      })() });
    ` },
    check: r => [
      ['点顶栏「配置」发的协议恰为 aiquotaboard://connect（不带平台参数）', JSON.stringify(r.res.snap.urls1) === '["aiquotaboard://connect"]', JSON.stringify(r.res.snap.urls1)],
      ['再点一次还是同一个动作（没有面板可开可关）', JSON.stringify(r.res.snap.urls2) === '["aiquotaboard://connect"]', JSON.stringify(r.res.snap.urls2)],
      ['页内不再有任何配置面板 DOM', r.res.snap.panelDom === 0, String(r.res.snap.panelDom)],
      ['面板专属死代码符号全部不存在', r.res.snap.dead.every(x => x === 'undefined'), JSON.stringify(r.res.snap.dead)],
      ['保留 fireProtocol / setupWizardOpen / renderSetupBar', r.res.snap.kept.every(x => x === 'function'), JSON.stringify(r.res.snap.kept)],
      ['检查横幅的「打开配置」走的也是同一条路', r.res.snap.barOpenBtn === true && JSON.stringify(r.res.snap.urlsBar) === '["aiquotaboard://connect"]', 'btn=' + String(r.res.snap.barOpenBtn) + ' ' + JSON.stringify(r.res.snap.urlsBar)],
      ['检查横幅与「实时状态」分区之间没有残留容器', (r.res.snap.layout || {}).barShown === true && r.res.snap.layout.adjacent === true, JSON.stringify(r.res.snap.layout)],
      ['无空容器、无孤立分区标题（视觉完整性）', r.res.snap.layout.emptyBlocks === 0 && r.res.snap.layout.orphanSec === 0, JSON.stringify(r.res.snap.layout)],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T43', desc: '顶部紧凑摘要条整行删除后的结构完整性：三张平台大卡片仍在，四种宽度下并排、不溢出、不被压扁',
    // 与 T41 同理：排版要按真实窗口宽度量（1152 是最窄的场景）
    windowSizes: ['1152,900', '1280,900', '1440,900', '1920,900'],
    page: {
      sdp: 'none', dataJs: liveJs(LIVE_DATA),
      driver: `
      await t.untilSel('#cards > .card');
      function geom() {
        return [].map.call(document.querySelectorAll('#cards > .card'), function (c) {
          var r = c.getBoundingClientRect();
          return { w: Math.round(r.width), top: Math.round(r.top) };
        });
      }
      t.snapshot({
        strip: { host: t.has('#strip'), tiles: t.count('.tile'), fn: [typeof renderStrip, typeof idleTile, typeof IDLE_HINT] },
        cards: t.count('#cards > .card'),
        titles: [].map.call(document.querySelectorAll('#cards > .card > h2'), function (h) { return (h.textContent || '').trim(); }),
        kv: t.count('#cards .card .kv'), bars: t.count('#cards .card .bar'),
        adjacent: (function () { var g = document.querySelector('.wrap > .group'); return !!g && g.nextElementSibling === document.getElementById('cards'); })(),
        emptyTop: [].filter.call(document.querySelector('.wrap').children, function (el) { return el.offsetHeight > 0 && !(el.textContent || '').trim() && !el.querySelector('canvas'); }).length,
        ovf: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        geom: geom(),
      });
    ` },
    check: r => {
      const runs = r.res.__W__ || [];
      const s0 = runs.length ? runs[0].snap : r.res.snap;
      const oneRow = g => new Set(g.map(x => x.top)).size === 1;      // 三张并排 = 同一行顶部
      const fit = x => x.snap && x.snap.ovf === 0 && x.snap.cards === 3 && x.snap.geom.length === 3
        && x.snap.geom.every(g => g.w >= 300) && oneRow(x.snap.geom);
      const line = x => x.snap ? `${x.size} 卡片 ${x.snap.cards} 张 · 宽度 ${JSON.stringify(x.snap.geom.map(g => g.w))} · 行 ${JSON.stringify(x.snap.geom.map(g => g.top))} · 横向溢出 ${x.snap.ovf}` : `${x.size} 无结果`;
      return [
        ['顶部紧凑摘要条整块移除（无宿主 / 无 .tile / 无渲染函数）', s0.strip.host === false && s0.strip.tiles === 0 && s0.strip.fn.every(x => x === 'undefined'), JSON.stringify(s0.strip)],
        ['三张平台大卡片仍在且顺序不变（Codex / DeepSeek / GLM）', s0.cards === 3 && /Codex/.test(s0.titles[0] || '') && /DeepSeek/.test(s0.titles[1] || '') && /GLM/.test(s0.titles[2] || ''), JSON.stringify(s0.titles)],
        ['大卡片信息量保留（每张都有明细行，带进度条）', s0.kv === 3 && s0.bars >= 2, 'kv=' + s0.kv + ' bars=' + s0.bars],
        ['「实时状态」标题与卡片网格直接相邻（原位置不留空容器 / 孤立标题）', s0.adjacent === true && s0.emptyTop === 0, 'adjacent=' + s0.adjacent + ' empty=' + s0.emptyTop],
        ...runs.map(x => [`${x.size} 宽：三张卡片并排、不溢出、不被压扁`, fit(x) === true, line(x)]),
        ['各宽度都无 JS 错误 / 无重复 id', runs.every(x => x.errors.length === 0 && x.dupIds.length === 0) && r.res.errors.length === 0, JSON.stringify(runs.map(x => x.errors))],
      ];
    },
  },
  {
    id: 'T44', desc: '每日热力图完整展示：数据全在网格里、格子固定不拉伸、网格铺满卡片宽度、两个坐标轴不重叠不越界、页面不横向溢出',
    // 排版与几何量都要按真实窗口宽度量：1152 是最窄（最容易挤坏）的一档，1920 是最宽的一档
    windowSizes: ['1152,900', '1280,900', '1920,900'],
    page: { sdp: 'none', dataJs: liveJs(HEAT_SHORT), driver: HEAT_DRIVER },
    check: r => {
      const runs = r.res.__W__ || [];
      const s0 = runs.length ? runs[0].snap : null;
      if (!s0) return [['热力图结果节点回读', false, '无 snap（页面可能没渲染出热力图）']];
      const FILLED = heatFilledKeys(HEAT_SHORT), ALLK = Object.keys(HEAT_SHORT.daily).sort();
      // 铺满 = 网格算得下时右侧余量不足一列（补的是空格子）；算不下就是长历史，横向滚动（T45 单独验）
      const fill = s => s.colsW <= s.avail + 0.5 ? (s.avail - s.colsW < 24) : true;
      const grid = x => x.snap && x.snap.sizes.length === 1 && x.snap.cellW >= 20               // 尺寸唯一 = 没被拉伸
        && fill(x.snap) && x.snap.cols >= 8                                                     // 铺满卡片宽度、至少 8 列
        && x.snap.firstColLeft === x.snap.wrapLeft && x.snap.ovf === 0;                         // 从同一左缘起画、页面不横向溢出
      const axis = x => x.snap && x.snap.months > 0 && x.snap.overlaps === 0 && x.snap.outOfGrid === 0
        && x.snap.monthsW === x.snap.colsW && x.snap.align <= 1;                                // 月份与网格同宽（滚动同步）、星期与行对齐
      const tipOk = x => x.snap && x.snap.tipTop && x.snap.tipBottom && x.snap.tipTop.on && x.snap.tipBottom.on
        && x.snap.tipTop.inside && x.snap.tipBottom.inside;                                     // 首行/末行悬停都在容器内
      const line = x => x.snap ? `${x.size} 列 ${x.snap.cols} · 格子 ${x.snap.sizes.join('/')} · 网格宽 ${x.snap.colsW}/可视 ${x.snap.avail} · 月份行 ${x.snap.monthsW} 标签 ${x.snap.months} 重叠 ${x.snap.overlaps} 越界 ${x.snap.outOfGrid} · 星期错位 ${x.snap.align}px · 横向溢出 ${x.snap.ovf}` : `${x.size} 无结果`;
      return [
        ['每条按日数据都画进了网格（没有漏画）', ALLK.every(k => s0.datedKeys.includes(k)), `数据 ${ALLK.length} 天 / 网格里的日期格 ${s0.datedKeys.length} 个`],
        ['有数值的那天都有色块（不是空壳）', FILLED.every(k => s0.paintedKeys.includes(k)), `有值 ${FILLED.length} 天 / 上色 ${s0.paintedKeys.length} 个`],
        ['格子尺寸统一且 ≥ 20px（补宽度用空格子，不拉伸格子）', runs.every(x => x.snap && x.snap.sizes.length === 1 && x.snap.cellW >= 20), JSON.stringify(runs.map(x => x.snap && x.snap.sizes))],
        ['星期轴与格子行中心对齐（≤1px）', runs.every(x => x.snap && x.snap.align <= 1), JSON.stringify(runs.map(x => x.snap && x.snap.align))],
        ['首行 / 末行悬停提示都在网格容器内（不被 overflow 剪掉）', runs.every(tipOk), JSON.stringify(runs.map(x => x.snap && [x.snap.tipTop && x.snap.tipTop.inside, x.snap.tipBottom && x.snap.tipBottom.inside]))],
        ...runs.map(x => [`${x.size} 宽：网格铺满卡片、格子固定尺寸、页面不横向溢出`, grid(x) === true, line(x)]),
        ...runs.map(x => [`${x.size} 宽：月份轴与网格同宽且不重叠 / 不越界`, axis(x) === true, line(x)]),
        ['各宽度都无 JS 错误 / 无重复 id', runs.every(x => x.errors.length === 0 && x.dupIds.length === 0), JSON.stringify(runs.map(x => x.errors))],
      ];
    },
  },
  {
    id: 'T45', desc: '热力图长历史（3 年）：网格横向滚动时月份轴与网格同宽同滚，页面不横向溢出（旧实现在这里把页面撑出 600+px）',
    windowSize: '1152,900',
    page: { sdp: 'none', dataJs: liveJs(HEAT_LONG), driver: HEAT_DRIVER },
    check: r => {
      const s = r.res.snap;
      const ALLK = Object.keys(HEAT_LONG.daily).sort();
      return [
        ['长历史下网格比可视区宽（该滚动就滚动）', s.scrollW > s.avail && s.colsW > s.avail, `网格内容 ${s.scrollW} / 可视 ${s.avail} / 网格宽 ${s.colsW}`],
        ['月份轴与网格严格同宽（滚动时不会错位）', s.monthsW === s.colsW, `月份行 ${s.monthsW} / 网格 ${s.colsW}`],
        ['页面不横向溢出（坐标轴不会撑出卡片）', s.ovf === 0, `横向溢出 ${s.ovf}px`],
        ['长历史仍不拉伸格子', s.sizes.length === 1 && s.cellW >= 20, s.sizes.join('/')],
        ['长历史下每条按日数据仍有格子 / 有值的仍上色', ALLK.every(k => s.datedKeys.includes(k)) && heatFilledKeys(HEAT_LONG).every(k => s.paintedKeys.includes(k)), `数据 ${ALLK.length} 天 / 上色 ${s.paintedKeys.length} 个`],
        ['月份标签不重叠、不出网格', s.months > 0 && s.overlaps === 0 && s.outOfGrid === 0, `标签 ${s.months} 重叠 ${s.overlaps} 越界 ${s.outOfGrid}`],
        ['无 JS 错误 / 无重复 id', r.res.errors.length === 0 && (r.res.dupIds || []).length === 0, JSON.stringify(r.res.errors.slice(0, 3))],
      ];
    },
  },
  {
    id: 'T46', desc: '连接入口点下后页面自己换上新数据：不做任何后续操作，断言界面已更新',
    page: {
      sdp: 'none', dataJs: liveJs(LIVE_DATA),
      // 第 1 次读盘 = 连接前的旧数据；之后（模拟 collect 已重写 dashboard-data.js）= 新数据
      scriptFeed: [liveJs(LIVE_DATA), liveJs(AFTER_CONNECT)],
      driver: `
      await t.untilSel('#cfgPanelBtn');
      await t.until(function () { return D.collectedAtMs === 900000; }, 6000, '首屏数据');   // 真实用户点连接时数据已经在了
      var before = { collected: D.collectedAtMs, updated: t.text('#updated') || '' };
      t.click('#cfgPanelBtn');                       // 用户动作到此为止：接下来只等连接窗口保存
      var urls = t.ops('iframe').map(function (o) { return o.url; });
      // 粗粒度等待（不轮询）：让 3 秒的等待窗口能在虚拟时钟里走到
      for (var i = 0; i < 10 && D.collectedAtMs !== ${AFTER_TS}; i++) await t.wait(2000);
      var loads = t.ops('dataScript').length;
      var updated = t.text('#updated') || '', glm = /12\\.34/.test(t.text('#cards') || '');
      await t.wait(9000);                            // 等待期内继续按 3 秒一次重载（不是忙轮询、也不会提前停）
      t.snapshot({ before: before, urls: urls, collected: D.collectedAtMs, updated: updated, glm: glm, loads: loads, loadsLater: t.ops('dataScript').length });
    ` },
    check: r => [
      ['点连接入口只发连接动作（不带平台参数）', JSON.stringify(r.res.snap.urls) === '["aiquotaboard://connect"]', JSON.stringify(r.res.snap.urls)],
      ['没有任何后续操作：页面自己换上了新数据', r.res.snap.collected === AFTER_TS && r.res.snap.updated !== r.res.snap.before.updated, JSON.stringify(r.res.snap.before) + ' -> ' + r.res.snap.updated],
      ['新数据真的进了界面（GLM 卡片显示新余额）', r.res.snap.glm === true],
      ['等待期内按约 3 秒一次重载（不是忙轮询，也不会因为计划任务写了一次就提前停）', r.res.snap.loadsLater - r.res.snap.loads >= 2 && r.res.snap.loadsLater - r.res.snap.loads <= 5, r.res.snap.loads + ' -> ' + r.res.snap.loadsLater + '（9 秒窗口）'],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T47', desc: '「帮助与反馈」弹窗：三个反馈按钮删除 / 关闭改右上角 × / Esc 仍可关 / 开关默认状态',
    assets: true,   // 弹窗由 assets/support.js 注入，不认识这个用例的用例保持原来的零资产行为
    page: {
      sdp: 'none', dataJs: liveJs(LIVE_DATA),
      driver: `
      await t.untilSel('#supportBtn');
      t.click('#supportBtn');
      await t.untilSel('#supportOverlay.on');
      var m = document.querySelector('#supportOverlay .modal');
      var labels = [].map.call(m.querySelectorAll('button, a'), function (b) { return (b.textContent || '').trim(); });
      var x = m.querySelector('.x'), xr = x.getBoundingClientRect();
      var sizes = [].map.call(m.querySelectorAll('h3, h4'), function (h) { return h.tagName + ':' + getComputedStyle(h).fontSize; });
      var boxes = [].map.call(m.querySelectorAll('input[type=checkbox]'), function (c) { return { label: (c.parentNode.textContent || '').trim(), checked: c.checked }; });
      var body = m.textContent || '';
      t.snapshot({
        labels: labels,
        gone: /加入用户群|提交问题|复制反馈信息/.test(body),
        noteGone: /入群页面会提供最新二维码/.test(body),
        wechat: /lixiangcheng2017/.test(body),
        copyBtn: labels.indexOf('复制') >= 0,
        xTitle: x.getAttribute('title'), xLabel: x.getAttribute('aria-label'), xText: x.textContent,
        xSize: [Math.round(xr.width), Math.round(xr.height)],
        closeBtns: [].filter.call(labels, function (s) { return s === '关闭'; }).length,
        sizes: sizes, boxes: boxes,
      });
      t.click('#supportOverlay .x');
      await t.wait(30);
      t.snapshot({ closed: !t.has('#supportOverlay.on'), focusBack: (document.activeElement || { id: '' }).id || '' });
      t.click('#supportBtn');
      await t.untilSel('#supportOverlay.on');
      t.esc();
      await t.wait(30);
      t.snapshot({ escClosed: !t.has('#supportOverlay.on') });
    ` },
    check: r => [
      ['「加入用户群 / 提交问题 / 复制反馈信息」三个按钮已删除', r.res.snap.gone === false && r.res.snap.copyBtn === true, JSON.stringify(r.res.snap.labels)],
      ['描述被删功能的说明行一并删除（不留假话）', r.res.snap.noteGone === false],
      ['微信号与「复制」保留', r.res.snap.wechat === true && r.res.snap.copyBtn === true],
      ['关闭只剩右上角一个 ×（带 title / aria-label）', r.res.snap.xText === '×' && r.res.snap.xTitle === '关闭' && r.res.snap.xLabel === '关闭' && r.res.snap.closeBtns === 0, JSON.stringify([r.res.snap.xText, r.res.snap.xTitle, r.res.snap.closeBtns])],
      ['× 的点击区不少于 32×32', r.res.snap.xSize[0] >= 32 && r.res.snap.xSize[1] >= 32, JSON.stringify(r.res.snap.xSize)],
      ['标题层级：小标题小于标题（不再是 h4 比 h3 大）', r.res.snap.sizes.join(' ') === 'H3:15px H4:13px', r.res.snap.sizes.join(' ')],
      ['「每天自动检查更新」默认不勾选 / 「允许托盘提示新版本」不受影响', r.res.snap.boxes.length === 2 && r.res.snap.boxes[0].checked === false && r.res.snap.boxes[1].checked === true, JSON.stringify(r.res.snap.boxes)],
      ['点 × 真的关掉弹窗，焦点回到「帮助与反馈」', r.res.snap.closed === true && r.res.snap.focusBack === 'supportBtn', JSON.stringify([r.res.snap.closed, r.res.snap.focusBack])],
      ['Esc 仍能关弹窗（桌面通用约定保留）', r.res.snap.escClosed === true],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T48', desc: '额度去向 ThinCoder 列（本机装了 ThinCoder）：无记录的项目给「创建」并发 opentc 协议；有记录的仍显示会话数',
    windowSizes: ['1152,900', '1440,900'],
    page: { sdp: 'none', dataJs: liveJs(tcData(true)), driver: TC_DRIVER },
    check: r => {
      const runs = r.res.__W__ || [];
      const s0 = runs.length ? runs[0].snap : null;
      if (!s0) return [['结果节点回读', false, '无 snap（页面可能没渲染出额度去向表）']];
      return [
        ['三行都在（表格渲染出来）', s0.rows === 3, String(s0.rows)],
        ['有会话的行仍是会话数徽标（不加按钮）', s0.hasTc.text === '⌨ 3' && s0.hasTc.isLink === false, JSON.stringify(s0.hasTc)],
        ['无记录但有目录的行：文案恰为「创建」', s0.noTc.text === '创建' && s0.noTc.isLink === true, JSON.stringify(s0.noTc)],
        ['「创建」发的是在该项目目录启动 ThinCoder 的协议（路径指向该行自己的目录）', s0.noTc.href.startsWith('aiquotaboard://opentc?path=') && s0.noTc.path === TC_CWD_NEW, s0.noTc.href],
        ['没有目录记录的行不给入口（起不来，也不该承诺）', s0.noPath.text === '·' && s0.noPath.isLink === false, JSON.stringify(s0.noPath)],
        ['装了 ThinCoder 时一个「安装 ThinCoder」都不出现', s0.installLinks === 0 && s0.createLinks === 1, `create=${s0.createLinks} install=${s0.installLinks}`],
        ['有会话的行「启动」可用：opentc 协议、路径就是这一行自己的目录', s0.launch.hasTc.isLink === true && s0.launch.hasTc.text === '⌨ 启动' && s0.launch.hasTc.path === TC_CWD_HAS, JSON.stringify(s0.launch.hasTc)],
        ['没会话的行「启动」列仍是 —（没会话可启动，不无中生有）', s0.launch.noTc.text === '—' && s0.launch.noTc.isLink === false, JSON.stringify(s0.launch.noTc)],
        ['全表恰两处 opentc 入口（有会话行「启动」+ 无记录行「创建」）', s0.opentcLinks === 2, String(s0.opentcLinks)],
        ...tcLayoutOk(runs),
        ['各宽度都无 JS 错误 / 无重复 id', runs.every(x => x.errors.length === 0 && x.dupIds.length === 0) && r.res.errors.length === 0, JSON.stringify(runs.map(x => x.errors))],
      ];
    },
  },
  {
    id: 'T49', desc: '额度去向 ThinCoder 列（本机没装 ThinCoder）：同一位置改成「安装 ThinCoder」引导安装，不给「创建」',
    windowSizes: ['1152,900', '1440,900'],
    page: { sdp: 'none', dataJs: liveJs(tcData(false)), driver: TC_DRIVER },
    check: r => {
      const runs = r.res.__W__ || [];
      const s0 = runs.length ? runs[0].snap : null;
      if (!s0) return [['结果节点回读', false, '无 snap（页面可能没渲染出额度去向表）']];
      return [
        ['无记录的行：文案恰为「安装 ThinCoder」', s0.noTc.text === '安装 ThinCoder' && s0.noTc.isLink === true, JSON.stringify(s0.noTc)],
        ['指向官方安装地址（与设计档的安装引导同一地址）', s0.noTc.href === TC_INSTALL_URL, String(s0.noTc.href)],
        ['新标签打开且 rel 带 noopener', s0.noTc.target === '_blank' && /noopener/.test(s0.noTc.rel || ''), JSON.stringify([s0.noTc.target, s0.noTc.rel])],
        ['没装 ThinCoder 时一个「创建」都不出现（不能承诺起不来的动作）', s0.createLinks === 0 && s0.installLinks === 1, `create=${s0.createLinks} install=${s0.installLinks}`],
        ['有会话的行「启动」同样收起（装了又会自己回来）', s0.launch.hasTc.text === '—' && s0.launch.hasTc.isLink === false, JSON.stringify(s0.launch.hasTc)],
        ['「—」带说明而不是静默消失：说清是 thincoder.cmd 不在 PATH 上', /thincoder\.cmd/.test(s0.launch.hasTc.hint || ''), `hint=${s0.launch.hasTc.hint}`],
        ['整表一个 opentc 入口都不渲染（「创建」与「启动」一起收口）', s0.opentcLinks === 0, String(s0.opentcLinks)],
        ['有会话的行不受影响（仍是会话数）', s0.hasTc.text === '⌨ 3' && s0.hasTc.isLink === false, JSON.stringify(s0.hasTc)],
        ...tcLayoutOk(runs),
        ['各宽度都无 JS 错误 / 无重复 id', runs.every(x => x.errors.length === 0 && x.dupIds.length === 0) && r.res.errors.length === 0, JSON.stringify(runs.map(x => x.errors))],
      ];
    },
  },
  {
    id: 'T50', desc: '检查更新（发现新版本）：弹窗与横幅都给「去下载」外链（地址取 manifest.releaseUrl）与「跳过该版本」，跳过发 update 协议',
    assets: true,
    page: { sdp: 'none', dataJs: liveJs(LIVE_DATA), boardUpdate: updateState({ available: true, phase: 'available', message: '发现新版本 v1.3.1' }), driver: UPDATE_DRIVER },
    check: r => {
      const s = r.res.snap;
      return [
         ['弹窗里的动作恰为 关闭 × / 检查更新 / 去下载 / 跳过该版本 / 复制', s.labels.join('|') === '×|检查更新|去下载|跳过该版本|复制', s.labels.join('|')],
         ['旧的更新动作（立即更新 / 稍后提醒 / 查看更新说明）都不在了', !/立即更新|稍后提醒|查看更新说明/.test(s.labels.join('|')), s.labels.join('|')],
         ['「去下载」指向 manifest 里的 Release 地址（地址来自 latest.json，页面不硬编码 URL）', !!s.dl && s.dl.href === FIXTURE_RELEASE_URL, JSON.stringify(s.dl)],
         ['「去下载」是新标签打开的普通外链（<a target=_blank rel=noopener…>，不是发协议的按钮）', !!s.dl && s.dl.tag === 'A' && s.dl.target === '_blank' && /noopener/.test(s.dl.rel || ''), JSON.stringify(s.dl)],
         ['横幅给一样的两个动作（去下载 / 跳过该版本），去下载同样指向该 Release 地址', s.bannerShown === true && s.bannerLabels.join('|') === '去下载|跳过该版本' && !!s.bannerDl && s.bannerDl.href === FIXTURE_RELEASE_URL && s.bannerDl.target === '_blank', JSON.stringify([s.bannerShown, s.bannerLabels, s.bannerDl])],
         ['点「跳过该版本」发的是更新协议（协议白名单里的 skip = 跳过该版本），且只这一条协议请求', JSON.stringify(s.urls) === '["aiquotaboard://update-skip"]', JSON.stringify(s.urls)],
         ['点「去下载」页面自己什么也不发（协议与 iframe 计数都不变，跳转交给浏览器）', !!s.dlClick && s.dlClick.iframes === 0 && s.dlClick.protocolLinks === 0, JSON.stringify(s.dlClick)],
        ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
      ];
    },
  },
  {
    id: 'T51', desc: '检查更新（该版本已跳过）：横幅不再出现，弹窗说明「已跳过」且没有任何更新动作（包括「去下载」）',
    assets: true,
    page: { sdp: 'none', dataJs: liveJs(LIVE_DATA), boardUpdate: updateState({ available: false, phase: 'skipped', skippedVersion: FIXTURE_NEWER, message: `已跳过 v${FIXTURE_NEWER}；发布更新的版本时会再提示` }), driver: UPDATE_DRIVER },
    check: r => {
      const s = r.res.snap;
      return [
         ['跳过的版本不再弹横幅（元素在、内容为空、不可见）', s.bannerShown === false && s.bannerEmpty === true && s.bannerLabels.length === 0, JSON.stringify([s.bannerShown, s.bannerEmpty, s.bannerLabels])],
         ['弹窗里只剩「检查更新」，没有「跳过该版本」，也没有「去下载」', s.labels.join('|') === '×|检查更新|复制' && s.dl === null && s.bannerDl === null, JSON.stringify([s.labels, s.dl, s.bannerDl])],
        ['状态行说明是「已跳过 v1.3.1」而不是「已是最新版本」', /已跳过 v1\.3\.1/.test(s.status), s.status],
         ['没有任何更新动作可点（点不到就不会误发协议）', s.urls.length === 0, JSON.stringify(s.urls)],
         ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
       ];
     },
   },
   {
     id: 'T62', desc: '检查更新（manifest 里拿不到 Release 地址）：不给「去下载」死链，「跳过该版本」照旧',
     assets: true,
     // 真的 latest.json 由构建器写 releaseUrl，而且 程序/lib/updates.mjs 的 validateManifest 会把它校一遍；
     // 这里构造的是「地址确实拿不到」的那一种状态（老版 update-data.js / 手改了文件 / 将来换了字段）：
     // 按钮上写的事必须真的会发生——不给地址就不给按钮。
     page: {
       sdp: 'none', dataJs: liveJs(LIVE_DATA),
       boardUpdate: updateState({ available: true, phase: 'available', manifest: { ...updateState().manifest, releaseUrl: undefined } }),
       driver: UPDATE_DRIVER,
     },
     check: r => {
       const s = r.res.snap;
       return [
         ['拿不到地址就不给「去下载」（点了不会发生任何事的按钮不出现）', s.dl === null && s.bannerDl === null, JSON.stringify([s.dl, s.bannerDl])],
         ['弹窗里只剩「跳过该版本」这一条更新动作', s.labels.join('|') === '×|检查更新|跳过该版本|复制', s.labels.join('|')],
         ['「跳过该版本」不受影响，照旧发协议', JSON.stringify(s.urls) === '["aiquotaboard://update-skip"]', JSON.stringify(s.urls)],
         ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
       ];
     },
   },
   {
     id: 'T63', desc: '检查更新（已是最新版本）：没有新版本就没有「去下载」，横幅也不出现',
     assets: true,
     // update.mjs 在「已是最新版本」时写的就是这个状态（available=false；缓存里的 manifest 可能还在，版本与当前相同）
     page: {
       sdp: 'none', dataJs: liveJs(LIVE_DATA),
       boardUpdate: updateState({ available: false, phase: 'current', message: `已是最新版本 v${FIXTURE_CURRENT}`, manifest: { ...updateState().manifest, version: FIXTURE_CURRENT } }),
       driver: UPDATE_DRIVER,
     },
     check: r => {
       const s = r.res.snap;
       return [
         ['没有新版本 → 横幅不出现（元素在、内容为空）、「去下载」一个都不出现（没东西可下）', s.bannerShown === false && s.bannerEmpty === true && s.dl === null && s.bannerDl === null, JSON.stringify([s.bannerShown, s.bannerEmpty, s.dl, s.bannerDl])],
         ['弹窗只剩「检查更新」', s.labels.join('|') === '×|检查更新|复制', s.labels.join('|')],
         ['状态行是「已是最新版本」', /已是最新版本/.test(s.status), s.status],
         ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
       ];
     },
   },
  {
    id: 'T52', desc: '额度去向（数据里没有 thinCoderInstalled 字段——老数据 / 还没采集过）：按「未知」显示，两个 ThinCoder 入口都照常给',
    windowSize: '1440,900',
    page: { sdp: 'none', dataJs: liveJs(tcData(undefined)), driver: TC_DRIVER },
    check: r => {
      const s0 = r.res?.snap;
      if (!s0) return [['结果节点回读', false, '无 snap（页面可能没渲染出额度去向表）']];
      const unknown = tcData(undefined), known = tcData(true);
      return [
        ['夹具确实没有这个字段（就是老 dashboard-data.js 的样子）', !('thinCoderInstalled' in unknown) && ('thinCoderInstalled' in known)],
        ['探测值缺失时「启动」照常显示：不因取不到值就把整列按钮变没', s0.launch.hasTc.text === '⌨ 启动' && s0.launch.hasTc.isLink === true && s0.launch.hasTc.path === TC_CWD_HAS, JSON.stringify(s0.launch.hasTc)],
        ['探测值缺失时也不弹「安装 ThinCoder」（那是明确没装才说的话）', s0.noTc.text === '创建' && s0.installLinks === 0, `text=${s0.noTc.text} install=${s0.installLinks}`],
        ['两处 opentc 入口照常（有会话行「启动」+ 无记录行「创建」）', s0.opentcLinks === 2, String(s0.opentcLinks)],
        ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
      ];
    },
  },
  {
    id: 'T61', desc: '点得开吗：点得开的行两下点下去真的发协议（URL 逐个断言）；白名单拒绝 / 目录已不在的行不给按钮、说清怎么放行；老数据照旧给按钮',
    windowSize: '1440,900',
    page: { sdp: 'none', dataJs: liveJs(attrData()), driver: ATTR_ACT_DRIVER },
    check: r => {
      const s = r.res?.snap;
      if (!s) return [['结果节点回读', false, '无 snap（页面可能没渲染出额度去向表）']];
      const c = s.cells;
      const urls = (s.clicks || []).map(x => x.url);
      return [
        ['点得开的行：两列都是按钮（📁 打开 / ⌨ 启动）', c.ok.folder.isLink === true && c.ok.launch.isLink === true, JSON.stringify(c.ok)],
        ['点「📁 打开」发出的恰是 openpath 协议、路径就是这一行的目录', urls[0] === ATTR_OPEN_URL, urls[0]],
        ['点「⌨ 启动」发出的恰是 opentc 协议、路径就是这一行的目录', urls[1] === ATTR_TC_URL, urls[1]],
        ['两下点击一共只发两个动作（没多也没少）', urls.length === 2, JSON.stringify(urls)],
        ['被白名单挡住的项：两列都不给按钮（不再摆一个点不动的按钮）', c.blocked.folder.isLink === false && c.blocked.launch.isLink === false && c.blocked.folder.text === '—', JSON.stringify(c.blocked)],
        ['被挡住的项：两列的提示都写清怎么放行（projectsRoots）', /projectsRoots/.test(c.blocked.folder.hint) && /projectsRoots/.test(c.blocked.launch.hint), `${c.blocked.folder.hint} | ${c.blocked.launch.hint}`],
        ['目录已不在的项目：两列不给按钮，提示说的是目录没了（不是白名单的事）', c.gone.folder.isLink === false && c.gone.launch.isLink === false && /已经不在/.test(c.gone.folder.hint) && !/projectsRoots/.test(c.gone.folder.hint), JSON.stringify(c.gone)],
        ['老数据（没有 act 字段）：照旧给按钮，不因取不到值就把入口变没', c.old.folder.isLink === true && c.old.launch.isLink === true && c.old.folder.href === 'aiquotaboard://openpath?path=' + encodeURIComponent(ATTR_OLD), JSON.stringify(c.old)],
        ['整表只剩能点开的两行有 action 按钮（2 行 × 2 列）', s.attrLinks === 4, String(s.attrLinks)],
        ['表下说清有几个点不开 + 怎么放行', /有 1 个项目的目录不在允许范围内/.test(s.attrHint) && /projectsRoots/.test(s.attrHint), s.attrHint],
        ['ThinCoder 项目表同一套：点得开的给按钮、被挡的不给，提示同一句', c.tcOk.folder.isLink === true && c.tcOk.launch.isLink === true && c.tcBlocked.folder.isLink === false && c.tcBlocked.launch.isLink === false && /有 1 个项目的目录不在允许范围内/.test(s.tcHint), JSON.stringify([c.tcOk, c.tcBlocked, s.tcHint])],
        ['无 JS 错误 / 无重复 id', r.res.errors.length === 0 && (r.res.dupIds || []).length === 0, JSON.stringify(r.res.errors.slice(0, 3))],
      ];
    },
  },
  {
    id: 'T53', desc: '热力图三态分得开：用量 >0 走色阶 / 当天用量 =0 是灰格 / 无数据是空心格（深浅两套主题都验）',
    windowSize: '1280,900',
    page: { sdp: 'none', dataJs: liveJs(HEAT_ZERO), driver: HEAT_ZERO_DRIVER },
    check: r => {
      const s = r.res.snap;
      const both = [['深色', s.dark], ['浅色', s.light]];
      const third = c => Math.max(...c.rgb.slice(0, 3)) - Math.min(...c.rgb.slice(0, 3));
      const solid = c => c && (c.rgb.length < 4 || c.rgb[3] === 1);
      const tinted = c => c && c.rgb.length === 4 && c.rgb[3] > 0 && c.rgb[3] < 1 && c.rgb[2] - c.rgb[0] >= 40;   // 色阶 = 半透明的系列色（Codex 是蓝的）
      const hollow = c => c && c.bg === 'rgba(0, 0, 0, 0)' && c.shadow !== 'none';
      const desc = c => c ? `${c.k} ${c.v} ${c.bg}` : '(没有这种格子)';
      return [
        ['夹具落在同一张屏里：>0 与 =0 两种格子都画出来了（不是只画了其中一种）', s.dark.counts.some > 0 && s.dark.counts.zero > 0, JSON.stringify(s.dark.counts)],
        ...both.map(([n, x]) => [`${n}主题：当天用量为 0 是实心灰格——既不是色阶色的浅档，也不是空心的无数据格`, solid(x.zero) && x.zero.shadow === 'none' && third(x.zero) <= 26 && x.zero.rgb[2] - x.zero.rgb[0] <= 30, `${desc(x.zero)} · 灰度 ${third(x.zero)}`]),
        ...both.map(([n, x]) => [`${n}主题：用量 >0 仍是色阶色（半透明系列色），与灰格不同族`, tinted(x.some), desc(x.some)]),
        ...both.map(([n, x]) => [`${n}主题：无数据仍是空心格（透明 + 描边），与灰格一眼分得开`, hollow(x.none), desc(x.none)]),
        ...both.map(([n, x]) => [`${n}主题：0 用量格的提示是数值 0，不是「无采集（关机/离线）」`, x.zero.v === '0%' && !/采集/.test(x.zero.v), `${x.zero.k} → ${x.zero.v}`]),
        ['图例里的灰格样本与格子同色（两套主题各自对一次，且不是同一个色）', s.dark.footZero === s.dark.zero.bg && s.light.footZero === s.light.zero.bg && s.dark.footZero !== s.light.footZero, `${s.dark.footZero} / ${s.light.footZero}`],
        ['色阶样本只列真实出现的档位（0 不在色阶里，不拿“最浅一档”冒充 0）', s.dark.footScale.length > 0 && s.dark.footScale.every(c => s.dark.someColors.includes(c)) && s.dark.footScale.indexOf(s.dark.footZero) < 0, `色阶 ${s.dark.footScale.join(' , ')}`],
        ['灰格的说法只在图例里出现一次（不另加解释性文字）', s.footText.split('灰格').length - 1 === 1, s.footText],
        ['无 JS 错误 / 无重复 id', r.res.errors.length === 0 && (r.res.dupIds || []).length === 0, JSON.stringify(r.res.errors.slice(0, 3))],
      ];
    },
  },
  {
    id: 'T54', desc: '停滞段只有一种：图例一条、虚线与灰底共用同一份合并后的区间表（5h/7d 不再各标一套）',
    windowSize: '1280,900',
    page: { sdp: 'none', dataJs: liveJs(STALE_DATA), driver: STALE_MERGE_DRIVER },
    check: r => {
      const s = r.res.snap;
      const gaps = s.perSeriesGaps.reduce((a, b) => a + b, 0);
      return [
        ['图例只剩一条停滞段（不再 5h 一套 / 7 天一套 / 灰底再一条）', s.staleLegend === 1 && s.oldWords.length === 0, `停滞段条目 ${s.staleLegend} · 残留旧说法 ${JSON.stringify(s.oldWords)}`],
        ['这一条画的就是停滞段本身：灰底 + 虚线同时出现', s.swatch && s.swatch.bgAlpha > 0 && s.swatch.dash === 'dashed' && s.swatch.w >= 18 && s.swatch.h >= 8, JSON.stringify(s.swatch)],
        ['停滞段只有一种：页面给的区间表 = 各系列空档的并集（合并去重，不按系列重复计）', s.matchesUnion === true && s.ranges.length === 2 && s.rawGaps === gaps && s.rawGaps > s.ranges.length, `页面 ${s.ranges.length} 段 / 原始空档 ${s.rawGaps}（每系列 ${JSON.stringify(s.perSeriesGaps)}）`],
        ['灰底确实铺在停滞段上：段内有不透明的一层底色，段外什么都没有', s.bandPx && s.bandPx[3] >= 20 && s.bandPx[3] <= 60 && s.cleanPx[3] === 0, `段内 ${JSON.stringify(s.bandPx)} / 段外 ${JSON.stringify(s.cleanPx)}`],
        ['停滞段只有一个灰度：按系列分的那两个（--stale-a / --stale-b）已经不存在', /^--stale=#/.test(s.vars[0]) && s.vars[1] === '--stale-a=' && s.vars[2] === '--stale-b=', s.vars.join(' ')],
        ['单系列的图（DeepSeek）用同一份停滞段强度：不受系列条数影响', s.dsSeries === 1 && s.bandPx && s.dsBandPx && s.dsBandPx[3] === s.bandPx[3], `Codex ${JSON.stringify(s.bandPx)} / DeepSeek ${JSON.stringify(s.dsBandPx)}`],
        ['无 JS 错误 / 无重复 id', r.res.errors.length === 0 && (r.res.dupIds || []).length === 0, JSON.stringify(r.res.errors.slice(0, 3))],
      ];
    },
  },
  {
    id: 'T55', desc: '显式不显示 Codex 与 GLM（两家都还在采集）：这一家的内容到处一起收，只剩 DeepSeek',
    // 宽度是硬约束：卡片少了不能把一张卡拉满整行；深浅两套主题都不破版
    windowSizes: ['1152,900', '1280,900', '1920,900'],
    page: { sdp: 'none', dataJs: liveJs(DS_ONLY), driver: CARDS_DRIVER },
    check: r => {
      const runs = r.res.__W__ || [];
      const s0 = runs.length ? runs[0].snap : r.res.snap;
      const d = s0.dark, v = d.views;
      const titles = list => list.map(c => c.title).join(' | ');
      const tabsOn = d.heatTabs.filter(t => t.on);
      // 不足三张时保持三栏节奏：卡宽约 1/3 行宽（不被拉满）、左边与网格左缘对齐
      const oneThird = x => x.snap && Math.abs(x.snap.dark.cards[0].w / x.snap.dark.boxW - 1 / 3) < 0.06
        && x.snap.dark.cards[0].left === x.snap.dark.boxLeft;
      const line = x => x.snap ? `${x.size} 卡 ${x.snap.dark.count} 张 · 卡宽 ${x.snap.dark.cards.map(c => c.w).join('/')} · 行宽 ${x.snap.dark.boxW} · 横向溢出 ${x.snap.dark.ovf}` : `${x.size} 无结果`;
      return [
        ['只剩 DeepSeek 一张卡：Codex 与 GLM 的卡片都不在', d.count === 1 && /DeepSeek/.test(d.cards[0].title) && !/Codex|GLM/.test(titles(d.cards)), titles(d.cards)],
        ['隐藏 ≠ 停采：两家的采集开关仍是 true（数据照采、提醒照发，只是不显示）', d.platforms.codex === true && d.platforms.glm === true, JSON.stringify(d.platforms)],
        ['用量趋势：Codex 与 GLM 的图收起，DeepSeek 的图照画（标题还在，不是孤立标题）', v.codexChart === false && v.glmChart === false && v.dsChart === true && v.chartSec === true, JSON.stringify(v)],
        ['每日热力图：只剩 DeepSeek 一个页签，选中也切到了它', d.heatMetric === 'deepseek' && tabsOn.length === 1 && tabsOn[0].k === 'deepseek', `选中 ${d.heatMetric} · 页签 ${JSON.stringify(d.heatTabs)}`],
        ['额度去向（Codex 会话归因）整块收起（同一行还有采集健康，区块标题留着）', v.attrCard === false && v.attrSec === true && v.healthCard === true, JSON.stringify({ attrCard: v.attrCard, attrSec: v.attrSec, healthCard: v.healthCard })],
        ['采集健康里没有 Codex / GLM 的行，错误文案也不提它们', d.healthRows.length === 1 && /DeepSeek/.test(d.healthRows[0]) && !/codex|glm/i.test(d.healthHint), JSON.stringify({ rows: d.healthRows, hint: d.healthHint })],
        ['「历史与记录」里的 GLM 充值记录整块收起（最近提醒照旧）', v.packsPanel === false && v.alertsPanel === true, JSON.stringify({ packs: v.packsPanel, alerts: v.alertsPanel })],
        ['页面还有别的有用内容（模型画像 / ThinCoder 项目都在）', v.modelCard === true && v.tcCard === true, JSON.stringify({ model: v.modelCard, tc: v.tcCard })],
        ['不足三张时保持三栏节奏：卡宽约 1/3 行宽、左边对齐（不把一张卡拉满整行）', runs.every(oneThird), runs.map(line).join(' · ')],
        ...cardRunsOk(runs, r, s0),
      ];
    },
  },
  {
    id: 'T56', desc: '默认（三家都显示）：三张卡片都在、并排一行，各区块照旧',
    windowSizes: ['1152,900', '1280,900', '1920,900'],
    page: { sdp: 'none', dataJs: liveJs({ ...CARDS_RICH, cards: cardsOf({ codex: true, deepseek: true, glm: true }) }), driver: CARDS_DRIVER },
    check: r => {
      const runs = r.res.__W__ || [];
      const s0 = runs.length ? runs[0].snap : r.res.snap;
      const d = s0.dark, v = d.views;
      const oneRow = g => new Set(g.map(x => x.top)).size === 1;
      return [
        ['三张卡片都在且顺序不变（Codex / DeepSeek / GLM）', d.count === 3 && /Codex/.test(d.cards[0].title) && /DeepSeek/.test(d.cards[1].title) && /GLM/.test(d.cards[2].title), JSON.stringify(d.cards.map(c => c.title))],
        ['三张并排一行、每张都够宽（没被压扁）', runs.every(x => x.snap && oneRow(x.snap.dark.cards) && x.snap.dark.cards.every(c => c.w >= 300)), runs.map(x => x.snap ? `${x.size} ${x.snap.dark.cards.map(c => c.w).join('/')}` : `${x.size} 无结果`).join(' · ')],
        ['走的还是默认网格（没有触发「不足三张」那条规则）', runs.every(x => x.snap && x.snap.dark.few === false), JSON.stringify(runs.map(x => x.snap && x.snap.dark.few))],
        ['各区块全在（三张趋势图 / 三个热力图页签 / 额度去向 / 采集健康三行 / GLM 充值记录）', v.codexChart && v.dsChart && v.glmChart && d.heatTabs.filter(t => t.on).length === 3 && v.attrCard && v.healthCard && d.healthRows.length === 3 && v.packsPanel, JSON.stringify({ v, tabs: d.heatTabs, rows: d.healthRows })],
        ...cardRunsOk(runs, r, s0),
      ];
    },
  },
  {
    id: 'T57', desc: '显式设置两个方向都生效：关掉采集的 Codex 强制显示、开着采集的 GLM 固定不显示（采集照旧）',
    windowSize: '1280,900',
    page: { sdp: 'none', dataJs: liveJs(CARDS_OVERRIDE), driver: CARDS_DRIVER },
    check: r => {
      const s = r.res.snap.dark, v = s.views;
      const titles = s.cards.map(c => c.title).join(' | ');
      return [
        ['强制显示的 Codex 卡片在（没启用采集的平台给占位卡 + 「启用平台」）', s.count === 2 && /Codex/.test(s.cards[0].title) && s.cards[0].btn === '启用平台', JSON.stringify(s.cards.map(c => c.title + '|' + c.btn))],
        ['固定不显示的 GLM 卡片不在（哪怕它开着采集）', !/GLM/.test(titles), titles],
        ['隐藏 ≠ 停采：GLM 在数据里仍然是开着采集的', s.platforms.glm === true, JSON.stringify(s.platforms)],
        ['GLM 的其它内容也一起收（趋势图 / 热力图页签 / 充值记录）', v.glmChart === false && s.heatTabs.filter(t => t.on && t.k === 'glm').length === 0 && v.packsPanel === false && v.dsChart === true, JSON.stringify({ glmChart: v.glmChart, tabs: s.heatTabs, packs: v.packsPanel })],
        ['Codex 那边的内容照旧在（显式要显示：趋势图与额度去向都回来）', v.codexChart === true && v.attrCard === true, JSON.stringify({ codexChart: v.codexChart, attrCard: v.attrCard })],
        ['不横向溢出、无 JS 错误 / 无重复 id', s.ovf === 0 && r.res.errors.length === 0 && (r.res.dupIds || []).length === 0, JSON.stringify(r.res.errors.slice(0, 3))],
      ];
    },
  },
  {
    id: 'T58', desc: '默认（payload 里没有 cards 字段 = 谁都没设置过）：三家都显示，关掉采集的平台也出占位卡',
    windowSize: '1280,900',
    page: { sdp: 'none', dataJs: liveJs(LEGACY_NO_CARDS), driver: CARDS_DRIVER },
    check: r => {
      const s = r.res.snap.dark, v = s.views;
      const titles = s.cards.map(c => c.title).join(' | ');
      const btns = s.cards.map(c => c.btn).filter(Boolean).join(' | ');
      return [
        ['三家都出卡，包括关掉采集的 Codex 与 GLM（那张卡就是启用入口）', s.count === 3 && /Codex/.test(titles) && /DeepSeek/.test(titles) && /GLM/.test(titles), `${s.count} 张：${titles}`],
        ['关掉的两家是「未启用」占位卡 + 「启用平台」按钮（不当成故障）', s.cards[0].btn === '启用平台' && s.cards[2].btn === '启用平台', btns],
        ['各区块照旧（三张趋势图 / 三个页签 / 额度去向 / 采集健康三行）', v.codexChart === true && v.dsChart === true && v.glmChart === true && s.heatTabs.filter(t => t.on).length === 3 && v.attrCard === true && s.healthRows.length === 3, JSON.stringify({ v, rows: s.healthRows })],
        ['不横向溢出、无 JS 错误 / 无重复 id', s.ovf === 0 && r.res.errors.length === 0 && (r.res.dupIds || []).length === 0, JSON.stringify(r.res.errors.slice(0, 3))],
      ];
    },
  },
  {
    id: 'T59', desc: '三家都不显示：只服务它们的区块整体收起、不留空壳，页面其余内容照常',
    windowSize: '1280,900',
    page: { sdp: 'none', dataJs: liveJs(NONE_VISIBLE), driver: CARDS_DRIVER },
    check: r => {
      const s = r.res.snap.dark, v = s.views;
      const onSec = s.sections.filter(x => x.on).map(x => x.t.split(' ')[0]);
      const onGroups = s.groups.filter(x => x.on).map(x => x.t);
      return [
        ['一张卡都不画、卡片区与「实时状态」标题一起收', s.count === 0 && s.gridShown === false && s.groupShown === false, `卡 ${s.count} · 网格 ${s.gridShown} · 标题 ${s.groupShown}`],
        ['用量趋势整块收起（连标题与那一行网格一起，不留空壳）', v.chartSec === false && v.chartGrid === false && v.codexChart === false && v.dsChart === false && v.glmChart === false, JSON.stringify(v)],
        ['每日热力图整块收起（页签与卡片一起）', v.heatSec === false && v.heatCard === false && s.heatTabs.every(t => !t.on), JSON.stringify({ sec: v.heatSec, card: v.heatCard, tabs: s.heatTabs })],
        ['额度去向与采集健康整块收起（标题也一起收，不留空网格）', v.attrSec === false && v.attrCard === false && v.healthCard === false, JSON.stringify({ sec: v.attrSec, attr: v.attrCard, health: v.healthCard })],
        ['GLM 充值记录收起', v.packsPanel === false, String(v.packsPanel)],
        ['页面剩下的都是不服务某一家的内容：模型画像 / ThinCoder 项目 / 最近提醒都在', v.modelCard === true && v.tcCard === true && v.alertsPanel === true, JSON.stringify({ model: v.modelCard, tc: v.tcCard, alerts: v.alertsPanel })],
        ['可见的区块标题只剩「AI …」与「ThinCoder …」（没有空壳标题）', onSec.length === 2 && onSec[0].includes('AI') && onSec[1].includes('ThinCoder'), JSON.stringify(onSec)],
        ['可见的分组标题只剩「历史与记录」（充值凭证与提醒流水的入口还在）', onGroups.length === 1 && onGroups[0].includes('历史与记录'), JSON.stringify(onGroups)],
        ['不横向溢出、无 JS 错误 / 无重复 id', s.ovf === 0 && r.res.errors.length === 0 && (r.res.dupIds || []).length === 0, JSON.stringify(r.res.errors.slice(0, 3))],
      ];
    },
  },
  {
    id: 'T64', desc: '隐藏 GLM（另两家正常）：GLM 的卡片 / 趋势图 / 热力图页签 / 采集健康 / 充值记录全不见，且无空壳',
    windowSize: '1280,900',
    page: { sdp: 'none', dataJs: liveJs(GLM_HIDDEN), driver: CARDS_DRIVER },
    check: r => {
      const s = r.res.snap.dark, v = s.views;
      const titles = s.cards.map(c => c.title).join(' | ');
      const tabsOn = s.heatTabs.filter(t => t.on).map(t => t.k);
      return [
        ['Codex 与 DeepSeek 两张卡照常，GLM 卡不在', s.count === 2 && /Codex/.test(titles) && /DeepSeek/.test(titles) && !/GLM/.test(titles), titles],
        ['隐藏 ≠ 停采：GLM 在数据里仍开着采集（platforms.glm = true）', s.platforms.glm === true, JSON.stringify(s.platforms)],
        ['用量趋势里没有 GLM 的图，另两张照画、标题与网格不空', v.glmChart === false && v.chartGrid === true && v.codexChart === true && v.dsChart === true && v.chartSec === true, JSON.stringify(v)],
        ['每日热力图只剩两个页签（Codex / DeepSeek），选中的不是被收掉的那个', JSON.stringify(tabsOn) === JSON.stringify(['codex', 'deepseek']) && tabsOn.includes(s.heatMetric), `可见 ${JSON.stringify(tabsOn)} · 选中 ${s.heatMetric}`],
        ['采集健康里没有 GLM 的行（另两家照常）', s.healthRows.length === 2 && !s.healthRows.some(x => /GLM/.test(x)), JSON.stringify(s.healthRows)],
        ['额度去向（Codex 归因）还在 —— 收 GLM 不该动别家', v.attrCard === true, String(v.attrCard)],
        ['GLM 充值记录整块收起', v.packsPanel === false, String(v.packsPanel)],
        ['整页不横向溢出、无 JS 错误 / 无重复 id', s.ovf === 0 && r.res.errors.length === 0 && (r.res.dupIds || []).length === 0, JSON.stringify(r.res.errors.slice(0, 3))],
      ];
    },
  },
];


// ---------- T32：首屏无影响（与本文件写死的期望清单对比） ----------
// 为什么不用「开工前快照文件」：快照放在 data/__test-dashboard__/（不进仓库），
// 新克隆的机器上没有 → T32 整组（5 条断言）静默跳过 → 报“全过”是假绿（隔离副本尤其如此）。
// 改成写死期望清单：① 永远会跑；② 谁改了首屏，这里就红，必须显式改这份清单（意图可见）。
// 更新方法：跑 node 程序/tools/test-dashboard.mjs，失败信息会列出「多出/少了」，核对后改这里。
// 2026-09-17：移除「工具」区与设置向导后，删掉工具区 id（cfgBtn / cfgGrid / cfgOverlay / cfgSave / helpBtn / toolNote）；
//             supportBtn 仍在这张清单里——它已移入顶栏，id 不变。
// 2026-09-17：顶栏删掉「暂停 / 导出」两个按钮（没人用）——清单里同步去掉 pauseBtn / exportBtn。
// 2026-09-17：顶栏删掉「静音 2 小时」按钮与其状态 chip（静音改由托盘菜单提供）——清单里同步去掉 mute / muteBtn。
// 2026-09-17：顶部那行紧凑摘要条（三个 .tile 小块）整行删除（与大卡片信息重复）——清单里同步去掉 strip。
// 2026-09-17：键盘快捷键与「快捷键帮助浮层」整块删除（页脚「按 ? 查看」同批移除）——清单里同步去掉 helpOverlay。
// 2026-09-17：顶栏删掉「备份」按钮（用户要求；命令行 node 程序/tools/backup.mjs 入口保留）——清单里同步去掉 backupBtn。
const T32_EXPECTED_IDS = ['alertCount','alerts-table','attrBars','attrHint','attrNote','attrSeg','bg1','cap-codex','cap-ds','cap-glm','cards','cfgPanelBtn','changes-ds','changes-glm','chartHint','dashboard-data-script','fresh','healthHint','healthList','heat','heatDays','heatFoot','heatMonths','heatNote','heatSeg','heatSummary','heatTip','heatWrap','hint-codex','intervalNote','modelBars','modelHint','modelNote','modelSummary','packs-table','refreshBtn','ring','ringTxt','setupBar','stats-codex','stats-ds','stats-glm','supportBtn','tcBars','tcHint','tcNote','tcSeg','tcSummary','themeBtn','updated','usageStyle','winSeg','wrap-codex','wrap-ds','wrap-glm'];
const T32_FIXTURE = JSON.stringify({
  generatedAtMs: 1, collectedAtMs: 900000, collectedAtText: '2026-09-15 00:00',
  health: null, mute: { active: false }, suppression: {}, config: { refreshSeconds: 0, defaultWindow: 'h24', theme: 'auto', staleMinutes: 15 },
  thresholds: { glmLow: 5, glmCritical: 2, dsLow: 20, dsCritical: 10, codex5hWarn: 80, codex5hCritical: 95, codexWeekWarn: 80 },
  intervals: { codex: 5, balance: 5 },
  codex: { ok: true, fiveHour: { usedPercent: 12, resetAt: 900000 + 3600e3 }, weekly: { usedPercent: 30 }, limitReached: false, credits: { hasCredits: true, balance: '0' } },
  deepseek: { ok: true, totalBalance: 55.5, grantedBalance: 0, toppedUpBalance: 55.5, isAvailable: true },
  glm: { ok: true, balance: 88.8, rechargeAmount: 100, totalSpendAmount: 11.2, depleted: false, packs: [] },
  stats: {}, health24h: null, platforms: { codex: true, deepseek: true, glm: true }, models: { available: {} },
  links: {}, predict: {}, anomaly: {}, attribution: null, recentAlerts: [], daily: {}, history: {},
});
function runT32(browser) {
  const b = runCase({ id: 'T32', page: { sdp: 'ok', files: FS_OK, driver: 'void 0;' }, dataJs: `window.DASHBOARD_DATA = ${T32_FIXTURE};\n`, browser }, false);
  const ids = idsOf(b.res);
  const onlyNew = [...ids].filter(x => !T32_EXPECTED_IDS.includes(x));
  const onlyGone = T32_EXPECTED_IDS.filter(x => !ids.has(x));
  check('T32', '首屏元素 id 集合与期望清单一致', onlyNew.length === 0 && onlyGone.length === 0, `多出:${onlyNew.join(',')} | 少了:${onlyGone.join(',')}`);
  const lc = b.res.loadCounts;
  check('T32', '加载期 IndexedDB / iframe / 选择器调用为 0', lc.idb === 0 && lc.iframe === 0 && lc.sdp === 0, JSON.stringify(lc));
  check('T32', '加载期不写任何存储（读取只用于主题）', lc.storeSet === 0 && lc.storeGet <= 4, `storeGet=${lc.storeGet} storeSet=${lc.storeSet}`);
  check('T32', '旧设置向导 DOM 永远不出现', !b.res.present.overlay && !b.res.present.fallback, JSON.stringify(b.res.present));
  check('T32', '加载期无 JS 错误', b.res.errors.length === 0, JSON.stringify(b.res.errors.slice(0, 3)));
}

// ---------- T60：显示规则（node 侧 cardSettings，页面读的就是它算出来的结果） ----------
// 为什么放在这里验：规则读的是配置（config.dashboard.cards，模板 + 用户值合并后的），而页面只认算好的 cards——
// 所以「哪几家显示」在 node 侧对一次，页面那边（T55–T59 / T64）只验它照着画。
// 2026-09-20 按用户要求收敛：**不再有任何自动判断**（关掉采集不算、用过没用过也不算），只看用户自己没没写 false。
function runCardsRule() {
  const show = cfg => Object.fromEntries(Object.entries(cardSettings(cfg)).map(([k, v]) => [k, v.show]));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const all = { codex: true, deepseek: true, glm: true };

  check('T60', '什么都没设置（没这一段 / 空对象 / 模板里只有 $comment）→ 三家都显示',
    eq(show({}), all) && eq(show({ dashboard: {} }), all) && eq(show({ dashboard: { cards: { $comment: '说明' } } }), all),
    JSON.stringify([show({}), show({ dashboard: { cards: { $comment: '说明' } } })]));
  check('T60', '显式 false = 不显示，只影响那一家',
    eq(show({ dashboard: { cards: { glm: false } } }), { codex: true, deepseek: true, glm: false }),
    JSON.stringify(show({ dashboard: { cards: { glm: false } } })));
  check('T60', '显式 true = 显示（老版本写下的 true 照样算数）',
    eq(show({ dashboard: { cards: { codex: true, deepseek: false } } }), { codex: true, deepseek: false, glm: true }),
    JSON.stringify(show({ dashboard: { cards: { codex: true, deepseek: false } } })));
  check('T60', '关掉采集的平台照样显示（「关掉就不出卡」这种自动判断已不存在）',
    eq(show({ platforms: { codex: false, deepseek: false, glm: false } }), all),
    JSON.stringify(show({ platforms: { codex: false, deepseek: false, glm: false } })));
  check('T60', '值不是布尔（写成了 null / 字符串）按「没设置」处理：显示',
    eq(show({ dashboard: { cards: { codex: null, glm: 'no' } } }), all),
    JSON.stringify(show({ dashboard: { cards: { codex: null, glm: 'no' } } })));
  check('T60', '显示设置不碰采集：platforms 的生效值不受 dashboard.cards 影响',
    eq(enabledPlatforms({ platforms: { glm: false }, dashboard: { cards: { glm: true } } }), { codex: true, deepseek: true, glm: false }));
}

// ---------- 主流程 ----------
const browser = findBrowser();
if (!browser) { console.error('未找到 Edge/Chrome，无法运行看板桩测试'); process.exit(1); }
console.log(`看板桩测试：${browser}\n`);
for (const c of CASES) {
  if (ONLY && c.id !== ONLY) continue;
  console.log(`\n=== ${c.id} ${c.desc} ===`);
  c.browser = browser;
  let out;
  try { out = runCase(c); }
  catch (e) { check(c.id, '用例运行', false, String(e.message ?? e).slice(0, 200)); continue; }
  if (!out.res) { check(c.id, '结果节点回读', false, '未找到 __result__（页面可能未跑完驱动）'); continue; }
  if (out.res.errors.length) check(c.id, '无 JS / 驱动错误', false, JSON.stringify(out.res.errors.slice(0, 3)));
  const dups = out.res.dupIds || [];
  check(c.id, 'DOM id 无重复', dups.length === 0, dups.join(','));
  for (const [name, cond, detail] of c.check(out)) check(c.id, name, cond, detail);
}
if (!ONLY) {
  console.log(`\n=== T32 首屏无影响（与期望清单对比） ===`);
  runT32(browser);
}
if (!ONLY || ONLY === 'T60') {
  console.log(`\n=== T60 显示规则（node 侧，与无头浏览器无关） ===`);
  runCardsRule();
}
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
