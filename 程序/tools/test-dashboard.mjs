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
//   T32 首屏 id 清单（写死期望值，谁改首屏谁显式改它）。
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
import { ROOT_DIR } from '../lib/common.mjs';

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
    return el;
  };
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
// 初始 dashboard-data.js 必须同时存在于桩文件系统（旧流程经目录句柄读它；现在仅供页面自身加载）
const dataJsOf = c => c.dataJs ?? c.page?.dataJs;

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

function pageCfg(c) {
  const cfg = { ...(c.page || {}) };
  delete cfg.dataJs;
  const dj = dataJsOf(c);
  if (dj && !(cfg.files || []).some(f => f[0] === 'dashboard-data.js')) cfg.files = [...(cfg.files || []), ['dashboard-data.js', dj]];
  return cfg;
}

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
        backupInHeader: !!document.querySelector('header #backupBtn'),
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
      ['帮助与反馈 / 备份已移入顶栏', r.res.snap.supportInHeader === true && r.res.snap.backupInHeader === true],
      ['没有孤立标题或空卡片（视觉完整性）', r.res.snap.orphan === 0 && r.res.snap.emptyCards === 0, 'orphan=' + r.res.snap.orphan + ' empty=' + r.res.snap.emptyCards],
      ['向导与静音按钮的死代码符号全部不存在', r.res.snap.dead.every(x => x === true), JSON.stringify(r.res.snap.dead)],
      ['保留 fireProtocol / setupWizardOpen', r.res.snap.kept.every(x => x === true), JSON.stringify(r.res.snap.kept)],
      ['页面已无 aiquotaboard://setup 引用', r.res.snap.setupUrl === false],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T40', desc: '保留的非配置入口仍可用（备份）；快捷键与帮助浮层整块移除后按键不再有行为',
    page: {
      sdp: 'none', dataJs: liveJs(LIVE_DATA),
      driver: `
      await t.untilSel('#backupBtn');
      t.click('#backupBtn');
      await t.wait(50);
      t.snapshot({ urls: t.ops('iframe').map(function (o) { return o.url; }), toast: t.has('#toastNote'), toastText: t.text('#toastNote') });
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
      ['备份按钮发固定备份动作', JSON.stringify(r.res.snap.urls) === '["aiquotaboard://backup"]', JSON.stringify(r.res.snap.urls)],
      ['轻提示有宿主与文案（不再依赖工具区）', r.res.snap.toast === true && /备份/.test(r.res.snap.toastText || ''), String(r.res.snap.toastText)],
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
];


// ---------- T32：首屏无影响（与本文件写死的期望清单对比） ----------
// 为什么不用「开工前快照文件」：快照放在 data/__test-dashboard__/（不进仓库），
// 新克隆的机器上没有 → T32 整组（5 条断言）静默跳过 → 报“全过”是假绿（隔离副本尤其如此）。
// 改成写死期望清单：① 永远会跑；② 谁改了首屏，这里就红，必须显式改这份清单（意图可见）。
// 更新方法：跑 node 程序/tools/test-dashboard.mjs，失败信息会列出「多出/少了」，核对后改这里。
// 2026-09-17：移除「工具」区与设置向导后，删掉 backupBtn 之外的工具区 id（cfgBtn / cfgGrid / cfgOverlay / cfgSave / helpBtn / toolNote）；
//             backupBtn 与 supportBtn 仍在这张清单里——它们已移入顶栏，id 不变。
// 2026-09-17：顶栏删掉「暂停 / 导出」两个按钮（没人用）——清单里同步去掉 pauseBtn / exportBtn。
// 2026-09-17：顶栏删掉「静音 2 小时」按钮与其状态 chip（静音改由托盘菜单提供）——清单里同步去掉 mute / muteBtn。
// 2026-09-17：顶部那行紧凑摘要条（三个 .tile 小块）整行删除（与大卡片信息重复）——清单里同步去掉 strip。
// 2026-09-17：键盘快捷键与「快捷键帮助浮层」整块删除（页脚「按 ? 查看」同批移除）——清单里同步去掉 helpOverlay。
const T32_EXPECTED_IDS = ['alertCount','alerts-table','attrBars','attrHint','attrNote','attrSeg','backupBtn','bg1','cap-codex','cap-ds','cap-glm','cards','cfgPanelBtn','changes-ds','changes-glm','chartHint','dashboard-data-script','fresh','healthHint','healthList','heat','heatDays','heatFoot','heatMonths','heatNote','heatSeg','heatSummary','heatTip','heatWrap','hint-codex','intervalNote','modelBars','modelHint','modelNote','modelSummary','packs-table','refreshBtn','ring','ringTxt','setupBar','stats-codex','stats-ds','stats-glm','supportBtn','tcBars','tcHint','tcNote','tcSeg','tcSummary','themeBtn','updated','usageStyle','winSeg','wrap-codex','wrap-ds','wrap-glm'];
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
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (failures.length) { console.log('失败明细：'); for (const f of failures) console.log('  - ' + f); }
process.exit(fail ? 1 : 0);
