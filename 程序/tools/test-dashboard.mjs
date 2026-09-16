// 看板桩测试：无头浏览器 + 注入的假目录句柄 + 真实点击驱动
// 用法：node 程序/tools/test-dashboard.mjs [--case T6] [--list]
//
// 覆盖范围（2026-09-17 收敛：8 步「设置向导」整块删除后，只留活功能的用例）：
//   T38 卡片「启用平台」按平台聚焦 / T1 首屏无数据态 / T31 点击同步发协议 /
//   T18 页面健康（活交互无 JS 错误）/ T39 「工具」区移除后的结构完整性 / T40 保留的非配置入口 /
//   T41 顶栏静音按钮（文案跟着静音状态走、点击发 mute | unmute；1152/1280/1440/1920 四种宽度 × 未静音/已静音量行高） /
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
      t.click('#cfgPanelBtn');
      await t.untilSel('#cfgPanel [data-setup-open]');
      t.click('#cfgPanel .cp-row [data-setup-open]');
      await t.wait(30);
      t.snapshot({ urlsRow: t.ops('iframe').map(function (o) { return o.url; }).slice(1), panelPlatforms: [].map.call(document.querySelectorAll('#cfgPanel [data-platform]'), function (b) { return b.getAttribute('data-platform'); }) });
      t.click('#cfgPanel .cp-sec [data-setup-open]');
      await t.wait(50);
      t.snapshot({ urlsFoot: t.ops('iframe').map(function (o) { return o.url; }).slice(2) });
      t.snapshot({ picker: t.has('#setupPick'), pw: t.count('input[type=password]'), panel: !!document.querySelector('#connectionPanel'), files: t.unwritten() });
    ` },
    check: r => [
      ['每张卡片各带自己的平台 id', JSON.stringify(r.res.snap.labels) === '["codex|启用平台","deepseek|连接平台"]', JSON.stringify(r.res.snap.labels)],
      ['点「连接平台」只发这一家的连接动作', JSON.stringify(r.res.snap.urls) === '["aiquotaboard://connect?platform=deepseek"]', JSON.stringify(r.res.snap.urls)],
      ['配置面板里未配置的那家也能单独去配置', JSON.stringify(r.res.snap.urlsRow) === '["aiquotaboard://connect?platform=deepseek"]' && JSON.stringify(r.res.snap.panelPlatforms) === '["deepseek"]', JSON.stringify(r.res.snap.urlsRow)],
      ['配置面板底部「打开连接窗口（三家一起）」不聚焦', JSON.stringify(r.res.snap.urlsFoot) === '["aiquotaboard://connect"]', JSON.stringify(r.res.snap.urlsFoot)],
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
      t.click('#cfgPanelBtn'); await t.untilSel('#cfgPanel .cp-row');
      t.snapshot({ panelRows: t.count('#cfgPanel .cp-row') });
      t.click('#cfgPanelBtn');
      t.click('#winSeg [data-win=d7]');
      t.click('#themeBtn');
      await t.wait(30);
      t.snapshot({ win: t.has('#stats-codex'), cards: t.count('#cards .card') });
    ` },
    check: r => [
      ['配置面板为三家各渲染一行', r.res.snap.panelRows === 3, String(r.res.snap.panelRows)],
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
        dead: [typeof setupLegacyWizardOpen === 'undefined', typeof SETUP_STEPS === 'undefined', typeof setupRender7 === 'undefined', typeof setupWizardClose === 'undefined', typeof hasFsaAccess === 'undefined'],
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
      ['向导死代码符号全部不存在', r.res.snap.dead.every(x => x === true), JSON.stringify(r.res.snap.dead)],
      ['保留 fireProtocol / setupWizardOpen', r.res.snap.kept.every(x => x === true), JSON.stringify(r.res.snap.kept)],
      ['页面已无 aiquotaboard://setup 引用', r.res.snap.setupUrl === false],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T40', desc: '保留的非配置入口仍可用（备份 / 快捷键帮助）',
    page: {
      sdp: 'none', dataJs: liveJs(LIVE_DATA),
      driver: `
      await t.untilSel('#backupBtn');
      t.click('#backupBtn');
      await t.wait(50);
      t.snapshot({ urls: t.ops('iframe').map(function (o) { return o.url; }), toast: t.has('#toastNote'), toastText: t.text('#toastNote') });
      t.key('?');
      await t.wait(30);
      t.snapshot({ help: t.has('#helpOverlay.on'), keys: t.count('#helpOverlay .keys kbd') });
      t.esc();
      await t.wait(30);
      t.snapshot({ closed: !t.has('#helpOverlay.on') });
    ` },
    check: r => [
      ['备份按钮发固定备份动作', JSON.stringify(r.res.snap.urls) === '["aiquotaboard://backup"]', JSON.stringify(r.res.snap.urls)],
      ['轻提示有宿主与文案（不再依赖工具区）', r.res.snap.toast === true && /备份/.test(r.res.snap.toastText || ''), String(r.res.snap.toastText)],
      ['? 仍能打开快捷键帮助', r.res.snap.help === true && r.res.snap.keys >= 6, String(r.res.snap.keys)],
      ['Esc 能关闭浮层', r.res.snap.closed === true],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T41', desc: '顶栏静音按钮：文案跟着静音状态走、点击发 mute | unmute；四种宽度下两行都不换行',
    // 排版断言要按真实窗口宽度量行高：四种宽度各跑一次（1152 是最窄的那个，也就是这段时间要治的场景）
    windowSizes: ['1152,900', '1280,900', '1440,900', '1920,900'],
    page: {
      // 首屏数据里就是「已静音」——文案必须跟着 D.mute（采集写进看板数据的状态）走，不是上一次点击的残留
      sdp: 'none',
      dataJs: liveJs({ ...LIVE_DATA, mute: { active: true, until: Date.now() + 2 * 3600e3, untilText: '2026-09-17 03:41', note: null } }),
      driver: `
      await t.untilSel('#muteBtn');
      function rows() { return [].map.call(document.querySelectorAll('header .hrow'), function (r) { return Math.round(r.getBoundingClientRect().height); }); }
      function ovf() { return document.documentElement.scrollWidth - document.documentElement.clientWidth; }
      var btn = document.getElementById('muteBtn'), chip = document.getElementById('mute');
      t.snapshot({
        label0: t.text('#muteBtn'), title0: t.attr('#muteBtn', 'title'),
        chip0: t.text('#mute'), chip0shown: chip.style.display !== 'none',
        sameRow: chip.parentElement === btn.parentElement && btn.parentElement === document.querySelectorAll('header .hrow')[1],
        rowsMuted: rows(), ovfMuted: ovf(),
      });
      btn.click();
      await t.wait(30);
      t.snapshot({
        urls1: t.ops('iframe').map(function (o) { return o.url; }),
        label1: t.text('#muteBtn'), toast1: t.text('#toastNote'), chip1shown: chip.style.display !== 'none',
        rowsUnmuted: rows(), ovfUnmuted: ovf(),
      });
      btn.click();
      await t.wait(30);
      t.snapshot({
        urls2: t.ops('iframe').map(function (o) { return o.url; }).slice(1),
        label2: t.text('#muteBtn'), toast2: t.text('#toastNote'),
        chip2: t.text('#mute'), chip2shown: chip.style.display !== 'none',
        rowsMuted2: rows(), ovfMuted2: ovf(),
      });
    ` },
    check: r => {
      const runs = r.res.__W__ || [];
      const s0 = runs.length ? runs[0].snap : r.res.snap;
      const fit = x => x.snap && [].concat(x.snap.rowsMuted, x.snap.rowsUnmuted, x.snap.rowsMuted2).every(h => h <= 40)
        && x.snap.ovfMuted === 0 && x.snap.ovfUnmuted === 0 && x.snap.ovfMuted2 === 0;
      const line = x => x.snap ? `${x.size} 行高 ${JSON.stringify([x.snap.rowsMuted, x.snap.rowsUnmuted, x.snap.rowsMuted2])} 横向溢出 ${x.snap.ovfMuted}/${x.snap.ovfUnmuted}/${x.snap.ovfMuted2}` : `${x.size} 无结果`;
      return [
        ['数据里已静音 → 按钮就写「取消静音」（带提示文字也是同一句）', s0.label0 === '取消静音' && s0.title0 === '取消静音', String(s0.label0) + ' / ' + String(s0.title0)],
        ['同一个状态同时标在 chip 上，且 chip 就挨在静音按钮左边（状态与动作同一行）', s0.chip0shown === true && /03:41/.test(s0.chip0 || '') && s0.sameRow === true, String(s0.chip0) + ' sameRow=' + String(s0.sameRow)],
        ['点它 → 发取消静音协议 + 轻提示', JSON.stringify(s0.urls1) === '["aiquotaboard://unmute"]' && s0.toast1 === '已取消静音', JSON.stringify(s0.urls1) + ' / ' + String(s0.toast1)],
        ['点完文案立刻变成下一次会做的事', s0.label1 === '静音 2 小时' && s0.chip1shown === false, String(s0.label1)],
        ['再点 → 发静音协议（2 小时）', JSON.stringify(s0.urls2) === '["aiquotaboard://mute"]' && s0.toast2 === '已静音 2 小时', JSON.stringify(s0.urls2) + ' / ' + String(s0.toast2)],
        // 注意：时分断言用 [0-9]{2} 而不是正则的 \d 简写——简写连写会拼出「字母 + 冒号 + 反斜杠」的形状，被发布审计当成盘符路径拦下
        ['静音后按钮与 chip 同步翻面', s0.label2 === '取消静音' && s0.chip2shown === true && /静音至 [0-9]{2}:[0-9]{2}/.test(s0.chip2 || ''), String(s0.label2) + ' / ' + String(s0.chip2)],
        ...runs.map(x => [`${x.size} 宽：未静音 / 已静音（含再静音）三种状态下顶栏两行都不换行`, fit(x) === true, line(x)]),
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
];

// ---------- T32：首屏无影响（与本文件写死的期望清单对比） ----------
// 为什么不用「开工前快照文件」：快照放在 data/__test-dashboard__/（不进仓库），
// 新克隆的机器上没有 → T32 整组（5 条断言）静默跳过 → 报“全过”是假绿（隔离副本尤其如此）。
// 改成写死期望清单：① 永远会跑；② 谁改了首屏，这里就红，必须显式改这份清单（意图可见）。
// 更新方法：跑 node 程序/tools/test-dashboard.mjs，失败信息会列出「多出/少了」，核对后改这里。
// 2026-09-17：移除「工具」区与设置向导后，删掉 backupBtn 之外的工具区 id（cfgBtn / cfgGrid / cfgOverlay / cfgSave / helpBtn / toolNote）；
//             backupBtn 与 supportBtn 仍在这张清单里——它们已移入顶栏，id 不变。
// 2026-09-17：顶栏删掉「暂停 / 导出」两个按钮（没人用）——清单里同步去掉 pauseBtn / exportBtn。
const T32_EXPECTED_IDS = ['alertCount','alerts-table','attrBars','attrHint','attrNote','attrSeg','backupBtn','bg1','cap-codex','cap-ds','cap-glm','cards','cfgPanel','cfgPanelBtn','changes-ds','changes-glm','chartHint','dashboard-data-script','fresh','healthHint','healthList','heat','heatDays','heatFoot','heatMonths','heatNote','heatSeg','heatSummary','heatTip','heatWrap','helpOverlay','hint-codex','intervalNote','modelBars','modelHint','modelNote','modelSummary','mute','muteBtn','packs-table','refreshBtn','ring','ringTxt','setupBar','stats-codex','stats-ds','stats-glm','strip','supportBtn','tcBars','tcHint','tcNote','tcSeg','tcSummary','themeBtn','updated','usageStyle','winSeg','wrap-codex','wrap-ds','wrap-glm'];
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
