// 看板桩测试：无头浏览器 + 注入的假目录句柄 + 真实点击驱动
// 用法：node tools/test-dashboard.mjs [--case T6] [--list]
//
// 覆盖设计档 3.2 的 T1–T18 / T28–T37（T23–T27 为人工步骤）与 A1–A7 / A11–A16 的桩内部分。
// 真实选择器 / 真实落盘 / 真实安装 / 真实试采 / 句柄持久化 / Firefox 兜底 = 人工验收步骤：
// 原生文件夹选择器无法被 CDP 驱动（Page.handleFileChooser 只对 <input type=file> 生效）。
//
// 机制：把 dashboard.html 复制到 data/__test-dashboard__/run-<id>/，在主页本前注入测试引导脚本
// （插桩 / 桩 showDirectoryPicker / 短超时 / 驱动点击），用 --headless=new --virtual-time-budget --dump-dom 回读结果节点。
// 纪律：不得依赖 IndexedDB（无头 file:// 下 indexedDB.open 的回调不返回）；
//       测试夹具里的「密钥」一律是带连字符的哨兵串，不长成真密钥的形状（发布闸门会扫本文件）——
//       哨兵值固定放在桩的 secrets.json 里：向导必须既不读也不写它（T6 / T11）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.dirname(import.meta.dirname);
const TMP = path.join(ROOT, 'data', '__test-dashboard__');
const PAGE = path.join(ROOT, 'dashboard.html');
const BASELINE = path.join(TMP, 'baseline-dashboard.html');
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
  function abortErr() { var e = new Error('user aborted'); e.name = 'AbortError'; return e; }
  // ---- 假文件系统：flat spec -> node 树；记录写操作；可注入写失败 ----
  function mkdir(name, p) { return { name: name, kind: 'dir', dirs: {}, files: {}, path: p }; }
  // 目录名默认 = 本页所在目录名（贴近真实：用户选的就是看板所在文件夹；软警告只在刻意不同的用例里出现）
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
  function del(rel) { var l = ensure(root, rel.split('/')); delete l.parent.files[l.name]; }
  function read(rel) { var l = ensure(root, rel.split('/')); var f = l.parent.files[l.name]; return f ? f.text : null; }
  (C.files || []).forEach(function (f) { put(f[0], f[1]); });
  var writeTries = {};
  function fileHandle(node, name) {
    return {
      name: name, kind: 'file',
      getFile: function () { out.ops.push({ op: 'read', file: node.path + name }); return Promise.resolve({ text: function () { return Promise.resolve(node.files[name].text); } }); },
      createWritable: function () {
        var key = node.path + name;
        var n = (writeTries[key] = (writeTries[key] || 0) + 1);
        var rule = C.failWrite && C.failWrite[key];
        var fail = rule === 'always' || (typeof rule === 'number' && n <= rule);
        var buf = null;
        out.ops.push({ op: 'writeStart', file: key, n: n, fail: !!fail });
        return Promise.resolve({
          write: function (text) { if (fail) { var e = new Error('simulated write failure'); e.name = 'NotReadableError'; return Promise.reject(e); } buf = String(text); return Promise.resolve(); },
          close: function () { if (!fail) { node.files[name].text = buf; out.ops.push({ op: 'writeOk', file: key, len: buf.length, text: C.redact ? null : buf }); } return Promise.resolve(); },
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
  function nowriteHandle() {
    var h = dirHandle(root);
    h.getFileHandle = function (name, opts) {
      if (!(name in root.files)) { if (opts && opts.create) root.files[name] = { text: '' }; else return Promise.reject(notFound()); }
      var fh = fileHandle(root, name);
      delete fh.createWritable;
      return Promise.resolve(fh);
    };
    return h;
  }
  if (C.sdp === 'none') window.showDirectoryPicker = undefined;
  else if (C.sdp === 'abort') window.showDirectoryPicker = function () { out.counts.sdp++; return Promise.reject(abortErr()); };
  else if (C.sdp === 'nowrite') window.showDirectoryPicker = function () { out.counts.sdp++; return Promise.resolve(nowriteHandle()); };
  else window.showDirectoryPicker = function () { out.counts.sdp++; return Promise.resolve(dirHandle(root)); };
  // ---- 「系统侧」模拟：协议触发时写状态文件 / 更新看板数据 ----
  var payloads = (C.collectPayloads || []).slice();
  // status / installStatus 传数组 = 每次探测依次取一份（最后一份反复用）：用于「重新检查后状态变了」的用例
  var statusSeq = Array.isArray(C.status) ? C.status.slice() : null;
  var installSeq = Array.isArray(C.installStatus) ? C.installStatus.slice() : null;
  function nextOf(seq, one) { return seq ? (seq.length > 1 ? seq.shift() : seq[0]) : one; }
  function writeStatus(tpl) { var o = {}; for (var k in tpl) o[k] = tpl[k]; o.checkedAtMs = Date.now(); put('data/setup-status.json', JSON.stringify(o)); out.ops.push({ op: 'status', task: !!o.autoRun && !!o.autoRun.taskRegistered }); }
  function onProtocol(url) {
    var act = String(url).split('://')[1] || '';
    act = act.split('?')[0].replace(/\/+$/, '');
    if (act === 'setupcheck' && (C.status || statusSeq)) writeStatus(nextOf(statusSeq, C.status));
    else if (act === 'setupinstall' && (C.installStatus || installSeq)) writeStatus(nextOf(installSeq, C.installStatus));
    else if (act === 'collect' && payloads.length) put('dashboard-data.js', 'window.DASHBOARD_DATA = ' + JSON.stringify(payloads.shift()) + ';\n');
  }
  // ---- 驱动辅助 ----
  var T = {
    q: function (s) { return document.querySelector(s); },
    has: function (s) { return !!document.querySelector(s); },
    click: function (s) { var el = document.querySelector(s); if (!el) throw new Error('missing click target: ' + s); el.click(); },
    set: function (s, v) { var el = document.querySelector(s); if (!el) throw new Error('missing input: ' + s); el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); },
    uncheck: function (s) { var el = document.querySelector(s); if (!el) throw new Error('missing box: ' + s); el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); },
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
    pw: function () { return [].map.call(document.querySelectorAll('input[type=password]'), function (i) { return i.value; }); },
  };
  window.addEventListener('load', function () {
    out.loadCounts = JSON.parse(JSON.stringify(out.counts));
    (async function () {
      try {
        if (C.timeouts && typeof SETUP_TIMEOUTS === 'object') { for (var k in C.timeouts) SETUP_TIMEOUTS[k] = C.timeouts[k]; }
        await (new Function('t', 'return (async () => {' + C.driver + '})();'))(T);
      }
      catch (e) { out.errors.push('driver: ' + ((e && e.message) || String(e))); }
      var ids = [], seen = {};
      [].forEach.call(document.querySelectorAll('[id]'), function (el) { ids.push(el.id); if (!seen[el.id]) seen[el.id] = 1; else if (seen[el.id] === 1) { seen[el.id] = 2; out.dupIds = (out.dupIds || []).concat(el.id); } });
      out.ids = ids;
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
  const args = ['--headless=new', '--disable-gpu', '--no-first-run', '--dump-dom'];
  if (!c.realTime) args.push('--virtual-time-budget=' + (c.budget || 40000));
  args.push(url);
  const dump = execFileSync(c.browser, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 128 * 1024 * 1024 });
  const m = dump.match(/<div id="__result__"[^>]*data-json="([^"]*)"/);
  const res = m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null;
  return { res, dump };
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
// page 字段 = 注入页面的桩配置（dirName/files/status/collectPayloads/failWrite/sdp/driver/redact）
const FS_OK = [['collect.mjs', '// stub'], ['dashboard.html', '<html></html>']];
const STATUS_OK = {
  platforms: { codex: true, deepseek: true, glm: true },
  config: { parse: 'ok' },
  codex: { found: true, note: '' }, deepseek: { found: true, source: 'secrets.json', length: 12, note: '' }, glm: { found: true, source: 'secrets.json', length: 12, note: '' },
  secrets: { exists: true, platforms: ['deepseek', 'glm'] },
  autoRun: { taskRegistered: true, taskName: 'AI-Capability-Board-Collect' },
};
const PLAT_STATUS = {
  platforms: { codex: true, deepseek: true, glm: true },
  config: { parse: 'ok' },
  codex: { found: false, note: '' }, deepseek: { found: true, source: 'secrets.json', length: 12, note: '' }, glm: { found: false, note: '' },
  secrets: { exists: true, platforms: ['deepseek'] },
  autoRun: { taskRegistered: true, taskName: 'AI-Capability-Board-Collect' },
};
const MISS_STATUS = {
  platforms: { codex: true, deepseek: true, glm: true },
  config: { parse: 'ok' },
  codex: { found: false, note: '' }, deepseek: { found: false, note: '' }, glm: { found: false, note: '' },
  secrets: { exists: true, platforms: [] },
  autoRun: { taskRegistered: true, taskName: 'AI-Capability-Board-Collect' },
};
const COL_OK = { collectedAtMs: 2, codex: { ok: true }, deepseek: { ok: true }, glm: { ok: true } };
// 试采成功夹具：页面要求 collectedAtMs 变新，所以页面初始数据用 1、协议触发后写比它大的值
function colOk(at = 900001) { return { collectedAtMs: at, codex: { ok: true }, deepseek: { ok: true }, glm: { ok: true } }; }
// 公共驱动：走到步骤 2 / 步骤 3 / 步骤 4（保存前）
// 打开向导：无数据页走 #setupStartBtn；有数据时走「配置」面板里的入口（两条真实路径）
const OPEN_WIZARD = `
  if (!t.has('#setupStartBtn')) { t.click('#cfgPanelBtn'); await t.untilSel('[data-setup-open]'); }
  t.click(t.has('#setupStartBtn') ? '#setupStartBtn' : '[data-setup-open]'); t.click('#legacyConnections');
  await t.untilSel('#setupPick');
`;
const TO_STEP2 = OPEN_WIZARD + `
  t.click('#setupPick');
  await t.untilSel('#setupProbe');
  await t.untilSel('#setupNext1:not([disabled])');
  t.click('#setupNext1');
  await t.untilSel('#setupNext2');
`;
const TO_STEP3 = TO_STEP2 + `t.click('#setupNext2'); await t.untilSel('#setupNext3');`;
const TO_STEP4 = TO_STEP3 + `t.click('#setupNext3'); await t.untilSel('#setupSave');`;
const SAVE = `t.click('#setupSave'); await t.untilSel('#setupNext4');`;
// 初始 dashboard-data.js 必须同时存在于桩文件系统（页面经目录句柄读它比较 collectedAtMs）
const dataJsOf = c => c.dataJs ?? c.page?.dataJs;
function pageCfg(c) {
  const cfg = { ...(c.page || {}) };
  delete cfg.dataJs;
  const dj = dataJsOf(c);
  if (dj && !(cfg.files || []).some(f => f[0] === 'dashboard-data.js')) cfg.files = [...(cfg.files || []), ['dashboard-data.js', dj]];
  return cfg;
}

const CASES = [
  { id: 'T38', desc: '本机连接入口无需浏览器文件权限',
    page: { sdp: 'none', driver: `t.click('#setupStartBtn'); t.snapshot({ panel: t.has('#connectionPanel.on'), picker: t.has('#setupPick'), input: t.count('#connectionPanel input') }); t.click('#openConnections'); await t.wait(50); t.snapshot({ urls: t.ops('iframe').map(o => o.url) });` },
    check: r => [['连接面板可见', r.res.snap.panel], ['不要求目录权限、不接收密钥', !r.res.snap.picker && r.res.snap.input === 0], ['只发送固定连接动作', r.res.snap.urls.length === 1 && r.res.snap.urls[0] === 'aiquotaboard://connect']]
  },
  {
    id: 'T1', desc: '无数据开屏主入口',
    page: { sdp: 'ok', driver: `
      t.snapshot({ noData: t.has('#noData'), startBtn: t.has('#setupStartBtn'), fallbackMarked: t.count('#noData [data-fallback]') });
      var bad = [].filter.call(document.querySelectorAll('#noData a, #noData button'), function (el) { return el.id !== 'setupStartBtn' && !el.closest('[data-fallback]'); });
      t.snapshot({ unmarked: bad.length });
      t.click('#setupStartBtn'); t.click('#legacyConnections');
      await t.untilSel('#setupOverlay.on');
      t.snapshot({ overlayDisplay: getComputedStyle(document.querySelector('#setupOverlay')).display });
    ` },
    check: r => [
      ['#noData 与 #setupStartBtn 存在', r.res.snap.noData && r.res.snap.startBtn],
      ['#noData 内非向导入口全部带 data-fallback', r.res.snap.unmarked === 0, 'unmarked=' + r.res.snap.unmarked],
      ['点击后 #setupOverlay 可见', r.res.snap.overlayDisplay === 'flex', r.res.snap.overlayDisplay],
    ],
  },
  {
    id: 'T2', desc: '能力检测通过 → 选文件夹步',
    page: { sdp: 'ok', driver: `t.click('#setupStartBtn'); t.click('#legacyConnections'); await t.untilSel('#setupPick'); t.snapshot({ pick: t.has('#setupPick'), fallback: t.has('#setupFallback'), sdp: t.ops().length });` },
    check: r => [
      ['进入选文件夹步（#setupPick）', r.res.snap.pick],
      ['未误报能力不足面板', r.res.snap.fallback === false],
      ['点击主入口本身未触发协议', r.res.snap.sdp === 0],
    ],
  },
  {
    id: 'T3A', desc: '能力检测不通过（无 showDirectoryPicker）',
    page: { sdp: 'none', driver: `
      t.click('#setupStartBtn'); t.click('#legacyConnections');
      await t.untilSel('#setupFallback');
      t.click('#setupFallbackNotepad'); t.click('#setupFallbackConsole');
      await t.wait(50);
      t.snapshot({ fb: t.has('#setupFallback'), urls: t.ops('iframe').map(function (o) { return o.url; }) });
    ` },
    check: r => [
      ['兜底面板可见', r.res.snap.fb === true],
      ['两条替代入口可点且都触发动作', r.res.snap.urls.length === 2 && /openfile/.test(r.res.snap.urls[0]) && /setup/.test(r.res.snap.urls[1]), JSON.stringify(r.res.snap.urls)],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T3B', desc: '能力检测不通过（选中句柄不可写）',
    page: { sdp: 'nowrite', files: FS_OK, driver: `
      t.click('#setupStartBtn'); t.click('#legacyConnections'); await t.untilSel('#setupPick'); t.click('#setupPick');
      await t.untilSel('#setupFallback');
      t.click('#setupFallbackNotepad'); t.click('#setupFallbackConsole'); await t.wait(50);
      t.snapshot({ fb: t.has('#setupFallback'), writes: t.unwritten() });
    ` },
    check: r => [
      ['兜底面板可见', r.res.snap.fb === true],
      ['未发生任何写入', r.res.snap.writes === 0],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T4', desc: '目录校验通过 → 进入检测步',
    page: { sdp: 'ok', status: STATUS_OK, files: FS_OK, driver: `
      t.click('#setupStartBtn'); t.click('#legacyConnections'); await t.untilSel('#setupPick'); t.click('#setupPick');
      await t.untilSel('#setupProbe');
      t.snapshot({ probe: t.has('#setupProbe'), msg0bad: (t.attr('#setupMsg0', 'class') || '').indexOf('bad') >= 0 });
    ` },
    check: r => [
      ['校验通过并进入检测步', r.res.snap.probe && !r.res.snap.msg0bad],
      ['无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors)],
    ],
  },
  {
    id: 'T5', desc: '选错文件夹 → 拒绝且零写入',
    page: { sdp: 'ok', files: [['dashboard.html', '<html></html>']], driver: `
      t.click('#setupStartBtn'); t.click('#legacyConnections'); await t.untilSel('#setupPick'); t.click('#setupPick');
      await t.untilSel('#setupMsg0.bad');
      t.snapshot({ rejected: t.attr('#setupMsg0', 'class'), writes: t.unwritten() });
    ` },
    check: r => [
      ['出现拒绝态', /(^|\s)bad(\s|$)/.test(r.res.snap.rejected || '')],
      ['桩上写调用数 = 0', r.res.snap.writes === 0],
    ],
  },
  {
    id: 'T6', desc: '保存只写 config.json：密钥文件一字未动',
    page: {
      sdp: 'ok', status: PLAT_STATUS,
      files: [...FS_OK, ['config.json', '{"thresholds":{"glmLow":7},"theme":"dark"}'], ['secrets.json', '{"deepseek":"OLD-DS-KEY-1","custom":"keep-me"}']],
      driver: TO_STEP4 + `
      t.click('#setupSave');
      await t.untilSel('#setupNext4');
      t.snapshot({ sec: t.read('secrets.json'), secWrites: t.opCount('writeStart', 'secrets.json'), secReads: t.opCount('read', 'secrets.json'), cfg: t.read('config.json') });
    ` },
    check: r => {
      const cfg = JSON.parse(r.res.snap.cfg || '{}');
      return [
        ['密钥文件内容一字未动（旧密钥与未知字段都在）', r.res.snap.sec === '{"deepseek":"OLD-DS-KEY-1","custom":"keep-me"}', String(r.res.snap.sec).slice(0, 60)],
        ['密钥文件零写入、零读取（向导不碰它）', r.res.snap.secWrites === 0 && r.res.snap.secReads === 0, 'w=' + r.res.snap.secWrites + ' r=' + r.res.snap.secReads],
        ['config 其它字段未被动', cfg.thresholds && cfg.thresholds.glmLow === 7 && cfg.theme === 'dark'],
        ['platforms 按选择写入', cfg.platforms && cfg.platforms.codex === true && cfg.platforms.glm === true],
      ];
    },
  },
  {
    id: 'T7', desc: '第 4 步：没找到密钥 → 引导装 ThinCoder（无输入框、给官方地址）',
    page: {
      sdp: 'ok', status: [MISS_STATUS, PLAT_STATUS], files: FS_OK,
      driver: TO_STEP3 + `
      t.snapshot({ pw: t.pw().length, keyInputs: t.count('[id^=setupKey-]'), guide: t.count('[data-guide=thincoder]'),
                   href: t.attr('#setupTcLink', 'href'), privacy: t.has('#setupPrivacy') });
      t.click('#setupRecheck3');
      await t.untilSel('[data-plat=deepseek][data-key=found]');
      t.snapshot({ after: [t.attr('[data-plat=deepseek]', 'data-key'), t.attr('[data-plat=glm]', 'data-key')], guide2: t.count('[data-guide=thincoder]') });
    ` },
    check: r => [
      ['第 4 步没有任何密钥输入框', r.res.snap.pw === 0 && r.res.snap.keyInputs === 0, 'pw=' + r.res.snap.pw + ' key=' + r.res.snap.keyInputs],
      ['没找到密钥时出现 ThinCoder 引导入口', r.res.snap.guide >= 1 && r.res.snap.href === 'https://thincoder.com/install.html', r.res.snap.guide + '/' + r.res.snap.href],
      ['本步含「不会上传到任何地方」的安全承诺行', r.res.snap.privacy === true],
      ['「重新检查」按新状态重渲染（DeepSeek 变 found / GLM 仍 missing）', JSON.stringify(r.res.snap.after) === '["found","missing"]', JSON.stringify(r.res.snap.after)],
      ['仍有缺密钥的平台 → 引导还在', r.res.snap.guide2 >= 1, String(r.res.snap.guide2)],
    ],
  },
  {
    id: 'T8', desc: '已有密钥：不引导装 ThinCoder（老用户不被烦）',
    page: {
      sdp: 'ok', status: STATUS_OK,
      files: [...FS_OK, ['secrets.json', '{"deepseek":"OLD-DS-KEY-1","glm":"OLD-GLM-KEY"}']],
      driver: TO_STEP3 + `
      t.snapshot({ keys: [t.attr('[data-plat=deepseek]', 'data-key'), t.attr('[data-plat=glm]', 'data-key')],
                   src: t.q('[data-plat=deepseek] .st').textContent,
                   guide: t.count('[data-guide=thincoder]'), tcLink: t.has('#setupTcLink'),
                   writes: t.unwritten(), sec: t.read('secrets.json') });
    ` },
    check: r => [
      ['两家都标为 found（用的是已有密钥）', JSON.stringify(r.res.snap.keys) === '["found","found"]', JSON.stringify(r.res.snap.keys)],
      ['行内显示来源标签', /已经有密钥了（来自：/.test(r.res.snap.src || ''), r.res.snap.src],
      ['不出现 ThinCoder 引导（也不提下载）', r.res.snap.guide === 0 && r.res.snap.tcLink === false, 'guide=' + r.res.snap.guide],
      ['旧密钥文件保持原样且零写入', r.res.snap.sec === '{"deepseek":"OLD-DS-KEY-1","glm":"OLD-GLM-KEY"}' && r.res.snap.writes === 0, String(r.res.snap.sec).slice(0, 60)],
    ],
  },
  {
    id: 'T9', desc: '坏 JSON → 备份并重建（只备份坏掉的那一个文件）',
    page: {
      sdp: 'ok', status: PLAT_STATUS,
      files: [...FS_OK, ['config.json', '{broken'], ['secrets.json', '{"deepseek":"OLD-DS-KEY-1"}']],
      driver: TO_STEP4 + `
      t.click('#setupSave');
      await t.untilSel('#setupRebuild');
      t.snapshot({ writesBefore: t.unwritten() });
      t.click('#setupRebuild');
      await t.untilSel('#setupNext4');
      t.snapshot({ ops: t.ops().map(function (o) { return o.op + ':' + (o.file || ''); }), bak: t.read('data/config.json.broken.bak'), cfg: t.read('config.json'), sec: t.read('secrets.json') });
    ` },
    check: r => {
      const ops = r.res.snap.ops || [];
      const iBak = ops.indexOf('writeOk:data/config.json.broken.bak'), iCfg = ops.indexOf('writeOk:config.json');
      const cfg = JSON.parse(r.res.snap.cfg || '{}');
      return [
        ['不点按钮前零写入', r.res.snap.writesBefore === 0],
        ['先写备份、再写干净版', iBak >= 0 && iCfg > iBak, JSON.stringify(ops.slice(0, 10))],
        ['备份内容 = 原坏文件', r.res.snap.bak === '{broken'],
        ['干净版按选择写入平台开关', cfg.platforms && cfg.platforms.codex === true && cfg.platforms.glm === true, JSON.stringify(cfg)],
        ['密钥文件不进备份面、也不被碰', !ops.some(o => /secrets/.test(o)) && r.res.snap.sec === '{"deepseek":"OLD-DS-KEY-1"}', JSON.stringify(ops.filter(o => /secrets/.test(o)))],
      ];
    },
  },
  {
    id: 'T10', desc: '写失败 → 回滚原内容（config.json）',
    page: {
      sdp: 'ok', status: PLAT_STATUS,
      files: [...FS_OK, ['config.json', '{"thresholds":{"glmLow":7}}']],
      failWrite: { 'config.json': 1 },
      driver: TO_STEP4 + `
      t.click('#setupSave');
      await t.untilSel('#setupMsg4[data-rollback]');
      await t.wait(50);
      t.snapshot({ rb: t.attr('#setupMsg4', 'data-rollback'), tries: t.opCount('writeStart', 'config.json'), cfg: t.read('config.json'), retry: t.has('#setupRetry4') });
    ` },
    check: r => [
      ['失败后尝试回滚（等于第二次写）', r.res.snap.tries === 2, 'tries=' + r.res.snap.tries],
      ['UI 标记回滚成功', r.res.snap.rb === 'ok', r.res.snap.rb],
      ['原内容已写回', r.res.snap.cfg === '{"thresholds":{"glmLow":7}}', String(r.res.snap.cfg).slice(0, 60)],
      ['给出重试出口', r.res.snap.retry === true],
    ],
  },
  {
    id: 'T11', desc: '密钥不外泄（桩内：密钥文件不被读、不被写；存储 / iframe / console / DOM 无密钥串）',
    page: {
      sdp: 'ok', status: PLAT_STATUS,
      files: [...FS_OK, ['secrets.json', '{"deepseek":"SENTINEL-DS-LEAK","glm":"SENTINEL-GLM-LEAK"}'], ['config.json', '{"theme":"dark"}']],
      redact: true,
      driver: TO_STEP4 + `
      t.snapshot({ pw: t.pw().length });
      t.click('#setupSave'); await t.untilSel('#setupNext4');
      t.click('#setupNext4'); await t.untilSel('#setupCollect');
      t.click('#setupCollect');
      await t.untilSel('#setupNext5');
      t.snapshot({ urls: t.ops('iframe').map(function (o) { return o.url; }),
                   secReads: t.opCount('read', 'secrets.json'), secWrites: t.opCount('writeStart', 'secrets.json'),
                   cfg: t.read('config.json') || '' });
    `,
      collectPayloads: [colOk()],
    },
    check: r => {
      const dom = r.dump.replace(/<script[\s\S]*?<\/script>/g, '');
      const sentinel = /SENTINEL-(DS|GLM)-LEAK/;
      const domLeak = sentinel.test(dom);
      const urlsLeak = (r.res.snap.urls || []).some(u => sentinel.test(u));
      const consoleLeak = (r.res.console || []).some(l => sentinel.test(l));
      return [
        ['保存确实发生（config.json 已写入平台开关）', /"platforms"/.test(r.res.snap.cfg), String(r.res.snap.cfg).slice(0, 60)],
        ['向导全程未读取密钥文件', r.res.snap.secReads === 0, 'reads=' + r.res.snap.secReads],
        ['向导全程未写入密钥文件', r.res.snap.secWrites === 0, 'writes=' + r.res.snap.secWrites],
        ['页面里没有任何密钥输入框', r.res.snap.pw === 0, 'pw=' + r.res.snap.pw],
        ['存储 API 无写入', (r.res.counts || {}).storeSet === 0, 'storeSet=' + (r.res.counts || {}).storeSet],
        ['iframe src 不含密钥串', !urlsLeak],
        ['console 不含密钥串', !consoleLeak],
        ['DOM 不含密钥串', !domLeak],
      ];
    },
  },
  {
    id: 'T12', desc: '平台开关写入（只动 platforms 三键）',
    page: {
      sdp: 'ok', status: STATUS_OK,
      files: [...FS_OK, ['config.json', '{"thresholds":{"glmLow":7},"projectsRoots":["X"]}']],
      driver: TO_STEP2 + `
      t.uncheck('#setupPlat-glm');
      await t.wait(30);
      t.click('#setupNext2'); await t.untilSel('#setupNext3'); t.click('#setupNext3'); await t.untilSel('#setupSave'); t.click('#setupSave');
      await t.untilSel('#setupNext4');
      t.snapshot({ cfg: t.read('config.json') });
    ` },
    check: r => {
      const cfg = JSON.parse(r.res.snap.cfg || '{}');
      return [
        ['三家开关按选择写入', cfg.platforms && cfg.platforms.codex === true && cfg.platforms.deepseek === true && cfg.platforms.glm === false, JSON.stringify(cfg.platforms)],
        ['其它键不受影响', cfg.thresholds && cfg.thresholds.glmLow === 7 && JSON.stringify(cfg.projectsRoots) === '["X"]'],
      ];
    },
  },
  {
    id: 'T13', desc: 'config.json 不存在 → 新建且只含 platforms',
    page: {
      sdp: 'ok', status: STATUS_OK, files: FS_OK,
      driver: TO_STEP4 + `t.click('#setupSave'); await t.untilSel('#setupNext4'); t.snapshot({ cfg: t.read('config.json'), keys: Object.keys(JSON.parse(t.read('config.json') || '{}')) });`,
    },
    check: r => [
      ['文件已新建', !!r.res.snap.cfg],
      ['只含 platforms 一个顶层键', JSON.stringify(r.res.snap.keys) === '["platforms"]', JSON.stringify(r.res.snap.keys)],
    ],
  },
  {
    id: 'T14', desc: '探测结果渲染与预选映射（2.2.12 M1–M4）',
    page: {
      sdp: 'ok', status: PLAT_STATUS, files: FS_OK,
      driver: TO_STEP2 + `
      t.snapshot({
        codex: [t.attr('[data-plat=codex]', 'data-setup-state'), t.q('#setupPlat-codex').checked],
        ds: [t.attr('[data-plat=deepseek]', 'data-setup-state'), t.attr('[data-plat=deepseek]', 'data-src'), t.q('#setupPlat-deepseek').checked],
        glm: [t.attr('[data-plat=glm]', 'data-setup-state'), t.q('#setupPlat-glm').checked],
      });
      t.click('#setupNext2');
      await t.untilSel('#setupNext3');
      t.snapshot({ pw: t.pw().length, keyInputs: t.count('[id^=setupKey-]'), guide: t.count('[data-guide=thincoder]'), guideText: (document.querySelector('[data-guide=thincoder]') || {}).textContent || '', codexInputs: t.count('[data-plat=codex] input') });
    ` },
    check: r => [
      ['Codex: missing + 勾选', JSON.stringify(r.res.snap.codex) === '["missing",true]', JSON.stringify(r.res.snap.codex)],
      ['DeepSeek: ready + 来源标签 + 勾选', JSON.stringify(r.res.snap.ds) === '["ready","secrets.json",true]', JSON.stringify(r.res.snap.ds)],
      ['GLM: missing + 勾选', JSON.stringify(r.res.snap.glm) === '["missing",true]', JSON.stringify(r.res.snap.glm)],
      ['步骤 4 无任何密钥输入框', r.res.snap.pw === 0 && r.res.snap.keyInputs === 0, 'pw=' + r.res.snap.pw + ' key=' + r.res.snap.keyInputs],
      ['缺密钥的 GLM 触发 ThinCoder 引导且点名 GLM', r.res.snap.guide === 1 && /GLM/.test(r.res.snap.guideText), r.res.snap.guide + '/' + String(r.res.snap.guideText).slice(0, 40)],
      ['Codex 行无输入控件', r.res.snap.codexInputs === 0],
    ],
  },
  {
    id: 'T15', desc: '探测超时降级（含手动模式进入步 6）',
    page: {
      sdp: 'ok', status: null, files: FS_OK,
      timeouts: { probeMs: 400, pollMs: 50, collectMs: 500, installWaitMs: 50 },
      collectPayloads: [colOk()],
      driver: `
      t.click('#setupStartBtn'); t.click('#legacyConnections'); await t.untilSel('#setupPick'); t.click('#setupPick');
      await t.untilSel('#setupRecheck');
      t.snapshot({ guide: t.count('[data-guide=vbs]'), skip: t.has('#setupSkip') });
      t.click('#setupSkip');
      await t.untilSel('#setupNext2');
      t.snapshot({ s1: t.attr('[data-plat=codex]', 'data-setup-state'), s2: t.attr('[data-plat=deepseek]', 'data-setup-state'), s3: t.attr('[data-plat=glm]', 'data-setup-state'), recheck2: t.has('#setupRecheck2') });
      // M1 的行内「重新检测」入口必须可达：回步 1 → 再跳过 → 回到步 2
      t.click('#setupRecheck2');
      await t.untilSel('#setupProbe');
      await t.untilSel('#setupSkip');
      t.click('#setupSkip');
      await t.untilSel('#setupNext2');
      t.snapshot({ roundTrip: t.has('#setupRecheck2') });
      t.click('#setupNext2'); await t.untilSel('#setupNext3'); t.click('#setupNext3');
      await t.untilSel('#setupSave'); t.click('#setupSave'); await t.untilSel('#setupNext4');
      t.click('#setupNext4'); await t.untilSel('#setupCollect'); t.click('#setupCollect');
      await t.untilSel('#setupNext5'); t.click('#setupNext5');
      await t.untilSel('#setupAutoState');
      t.snapshot({ auto: t.attr('#setupAutoState', 'data-auto'), install: t.has('#setupInstall'), recheck: t.has('#setupRecheck6'), guide6: t.count('#setupBody [data-guide=vbs]') });
    ` },
    check: r => [
      ['超时面板给出两条出口', r.res.snap.guide > 0 && r.res.snap.skip === true],
      ['跳过检测后各家状态 unknown', r.res.snap.s1 === 'unknown' && r.res.snap.s2 === 'unknown' && r.res.snap.s3 === 'unknown', JSON.stringify([r.res.snap.s1, r.res.snap.s2, r.res.snap.s3])],
      ['手动模式有可用的「重新检测」入口（M1）', r.res.snap.recheck2 === true && r.res.snap.roundTrip === true],
      ['步骤 6 呈现「状态未知」', r.res.snap.auto === 'unknown', r.res.snap.auto],
      ['步骤 6 有两条开启路径 + 重新检测', r.res.snap.install === true && r.res.snap.guide6 > 0 && r.res.snap.recheck === true],
    ],
  },
  {
    id: 'T16', desc: '试采成功呈现',
    page: {
      sdp: 'ok', status: STATUS_OK, files: FS_OK,
      dataJs: 'window.DASHBOARD_DATA = {"collectedAtMs":1};\n',
      collectPayloads: [colOk(900001)],
      timeouts: { collectMs: 8000, pollMs: 50 },
      driver: TO_STEP4 + `
      t.click('#setupSave'); await t.untilSel('#setupNext4');
      t.click('#setupNext4'); await t.untilSel('#setupCollect'); t.click('#setupCollect');
      await t.untilSel('#setupNext5');
      t.snapshot({ ok: t.count('[data-state=ok]'), sum: t.attr('#setupMsg5', 'data-sum') });
      t.click('#setupNext5'); await t.untilSel('#setupNext6');
      t.click('#setupNext6'); await t.untilSel('#setupDone');
      t.snapshot({ done: t.has('#setupDone') });
    ` },
    check: r => [
      ['三行结果都为成功态', r.res.snap.ok === 3, 'ok=' + r.res.snap.ok],
      ['汇总为完成态', r.res.snap.sum === 'done', r.res.snap.sum],
      ['完成后进入第 8 步（「以后自动采」落点）', r.res.snap.done === true],
    ],
  },
  {
    id: 'T17', desc: '试采超时 → 重试 + 手动兜底',
    page: {
      sdp: 'ok', status: STATUS_OK, files: FS_OK,
      dataJs: 'window.DASHBOARD_DATA = {"collectedAtMs":1};\n',
      collectPayloads: [colOk(1)],
      timeouts: { collectMs: 400, pollMs: 40 },
      driver: TO_STEP4 + `
      t.click('#setupSave'); await t.untilSel('#setupNext4');
      t.click('#setupNext4'); await t.untilSel('#setupCollect'); t.click('#setupCollect');
      await t.untilSel('#setupRetry5');
      t.snapshot({ sum: t.attr('#setupMsg5', 'data-sum'), manual: t.attr('#setupMsg5', 'data-manual'), next: t.has('#setupNext5') });
    ` },
    check: r => [
      ['出现超时态', r.res.snap.sum === 'timeout', r.res.snap.sum],
      ['给出重试出口', r.res.snap.next === true],
      ['给出手动采集兜底标记', r.res.snap.manual === 'vbs', r.res.snap.manual],
    ],
  },
  {
    id: 'T18', desc: '页面健康（重复 id / JS 错误）',
    page: {
      sdp: 'ok', status: PLAT_STATUS, files: [...FS_OK, ['secrets.json', '{"deepseek":"x"}']],
      dataJs: 'window.DASHBOARD_DATA = {"collectedAtMs":1};\n',
      collectPayloads: [colOk(900002)],
      timeouts: { collectMs: 8000, pollMs: 50 },
      driver: TO_STEP4 + `
      t.click('#setupSave'); await t.untilSel('#setupNext4');
      t.click('#setupNext4'); await t.untilSel('#setupCollect'); t.click('#setupCollect'); await t.untilSel('#setupNext5');
      t.click('#setupNext5'); await t.untilSel('#setupNext6'); t.click('#setupNext6'); await t.untilSel('#setupDone');
    ` },
    check: r => [['全程无 JS 错误', r.res.errors.length === 0, JSON.stringify(r.res.errors.slice(0, 3))]],
  },
  {
    id: 'T28', desc: '探测发现配置损坏（警告 + 修复引导 + 不阻塞）',
    page: {
      sdp: 'ok', status: { ...PLAT_STATUS, config: { parse: 'broken' } }, files: FS_OK,
      driver: `
      t.click('#setupStartBtn'); t.click('#legacyConnections'); await t.untilSel('#setupPick'); t.click('#setupPick');
      await t.untilSel('#setupNext1:not([disabled])');
      t.snapshot({ broken: t.has('#setupCfgBroken'), next: t.has('#setupNext1') });
    ` },
    check: r => [
      ['检测步出现配置损坏警告', r.res.snap.broken === true],
      ['不阻塞（可继续）', r.res.snap.next === true],
    ],
  },
  {
    id: 'T29', desc: '写失败且回滚也失败 → 明确告知可能读不出来',
    page: {
      sdp: 'ok', status: PLAT_STATUS,
      files: [...FS_OK, ['config.json', '{"theme":"dark"}']],
      failWrite: { 'config.json': 'always' },
      driver: TO_STEP4 + `
      t.click('#setupSave');
      await t.untilSel('#setupMsg4[data-rollback=failed]');
      t.snapshot({ rb: t.attr('#setupMsg4', 'data-rollback'), retry: t.has('#setupRetry4') });
    ` },
    check: r => [
      ['UI 明确回滚也失败', r.res.snap.rb === 'failed', r.res.snap.rb],
      ['仍给出重试出口', r.res.snap.retry === true],
    ],
  },
  {
    id: 'T30', desc: '三家全关 = 警告不阻塞',
    page: {
      sdp: 'ok', status: STATUS_OK, files: FS_OK,
      dataJs: 'window.DASHBOARD_DATA = {"collectedAtMs":1};\n',
      collectPayloads: [{ collectedAtMs: 900003, codex: { disabled: true }, deepseek: { disabled: true }, glm: { disabled: true } }],
      timeouts: { collectMs: 8000, pollMs: 50 },
      driver: TO_STEP2 + `
      t.uncheck('#setupPlat-codex'); t.uncheck('#setupPlat-deepseek'); t.uncheck('#setupPlat-glm');
      await t.wait(30);
      t.snapshot({ sel: t.attr('#setupMsg2', 'data-sel'), nextLabel: t.q('#setupNext2').textContent });
      t.click('#setupNext2'); await t.untilSel('#setupNext3'); t.click('#setupNext3'); await t.untilSel('#setupSave');
      t.click('#setupSave'); await t.untilSel('#setupNext4');
      t.click('#setupNext4'); await t.untilSel('#setupCollect'); t.click('#setupCollect'); await t.untilSel('#setupNext5');
      t.snapshot({ sum: t.attr('#setupMsg5', 'data-sum'), off: t.count('[data-state=off]'), cfg: t.read('config.json') });
    ` },
    check: r => {
      const cfg = JSON.parse(r.res.snap.cfg || '{}');
      return [
        ['选择步出现「三家全关」警告', r.res.snap.sel === 'all-off'],
        ['警告不阻塞（仍要保存 = 可继续）', /仍要保存/.test(r.res.snap.nextLabel || '')],
        ['试采汇总给出同一结论', r.res.snap.sum === 'all-off' && r.res.snap.off === 3, r.res.snap.sum + '/' + r.res.snap.off],
        ['全关状态确实写入', cfg.platforms && cfg.platforms.codex === false && cfg.platforms.glm === false, JSON.stringify(cfg.platforms)],
      ];
    },
  },
  {
    id: 'T31', desc: '向导打开 < 200ms（非虚拟时间单跑 + 同步可见）', realTime: true,
    page: { sdp: 'ok', files: FS_OK, driver: `
      await t.untilSel('#setupStartBtn', 8000);
      var t0 = performance.now();
      document.querySelector('#setupStartBtn').click();
      var disp = getComputedStyle(document.querySelector('#connectionPanel')).display;
      var dt = performance.now() - t0;
      t.snapshot({ disp: disp, ms: dt, pick: !!document.querySelector('#openConnections') });
    ` },
    check: r => [
      ['点击后连接面板同步可见', r.res.snap.disp === 'flex', String(r.res.snap.disp)],
      ['同步段 < 200ms', r.res.snap.ms < 200, Number(r.res.snap.ms).toFixed(1) + 'ms'],
      ['同一同步段里已渲染首屏内容', r.res.snap.pick === true],
    ],
  },
  {
    id: 'T33', desc: '用户取消文件夹选择',
    page: { sdp: 'abort', files: FS_OK, driver: `
      t.click('#setupStartBtn'); t.click('#legacyConnections'); await t.untilSel('#setupPick'); t.click('#setupPick');
      await t.untilSel('#setupMsg0');
      await t.wait(30);
      t.snapshot({ cls: t.attr('#setupMsg0', 'class'), repick: t.has('#setupPick'), writes: t.unwritten() });
    ` },
    check: r => [
      ['中性提示（不是错误色）', r.res.snap.cls === 'msg', r.res.snap.cls],
      ['可重试', r.res.snap.repick === true],
      ['零写入', r.res.snap.writes === 0],
    ],
  },
  {
    id: 'T34', desc: '目录名与本页不同 → 软警告，可继续',
    page: { sdp: 'ok', dirName: 'some-other-folder', files: FS_OK, status: STATUS_OK, driver: `
      t.click('#setupStartBtn'); t.click('#legacyConnections'); await t.untilSel('#setupPick'); t.click('#setupPick');
      await t.untilSel('#setupGo');
      t.snapshot({ go: t.has('#setupGo'), re: t.has('#setupRe') });
      t.click('#setupGo');
      await t.untilSel('#setupProbe');
      t.snapshot({ step1: t.has('#setupProbe') });
    ` },
    check: r => [
      ['软警告 + 两个出口', r.res.snap.go && r.res.snap.re],
      ['「继续」不被阻断', r.res.snap.step1 === true],
    ],
  },
  {
    id: 'T35', desc: '某平台密钥没通过（分平台结果行）',
    page: {
      sdp: 'ok', status: STATUS_OK, files: FS_OK,
      dataJs: 'window.DASHBOARD_DATA = {"collectedAtMs":1};\n',
      collectPayloads: [{ collectedAtMs: 900004, codex: { ok: true }, deepseek: { ok: false, error: 'HTTP 401 Authentication Fails' }, glm: { ok: true } }],
      timeouts: { collectMs: 8000, pollMs: 50 },
      driver: TO_STEP4 + `
      t.click('#setupSave'); await t.untilSel('#setupNext4');
      t.click('#setupNext4'); await t.untilSel('#setupCollect'); t.click('#setupCollect'); await t.untilSel('#setupNext5');
      t.snapshot({ ds: [t.attr('[data-plat=deepseek]', 'data-state'), t.attr('[data-plat=deepseek]', 'data-fix')], codex: t.attr('[data-plat=codex]', 'data-state'), glm: t.attr('[data-plat=glm]', 'data-state') });
    ` },
    check: r => [
      ['失败行标为 fail + 给出重填指引', JSON.stringify(r.res.snap.ds) === '["fail","rekey"]', JSON.stringify(r.res.snap.ds)],
      ['其余两行不受影响', r.res.snap.codex === 'ok' && r.res.snap.glm === 'ok', r.res.snap.codex + '/' + r.res.snap.glm],
    ],
  },
  {
    id: 'T36', desc: 'Codex 没有登录信息',
    page: {
      sdp: 'ok', status: PLAT_STATUS, files: FS_OK,
      dataJs: 'window.DASHBOARD_DATA = {"collectedAtMs":1};\n',
      collectPayloads: [{ collectedAtMs: 900005, codex: { ok: false, unconfigured: true, error: '未找到 Codex 登录凭证' }, deepseek: { ok: true }, glm: { ok: true } }],
      timeouts: { collectMs: 8000, pollMs: 50 },
      driver: TO_STEP4 + `
      t.click('#setupSave'); await t.untilSel('#setupNext4');
      t.click('#setupNext4'); await t.untilSel('#setupCollect'); t.click('#setupCollect'); await t.untilSel('#setupNext5');
      t.snapshot({ codex: [t.attr('[data-plat=codex]', 'data-state'), t.attr('[data-plat=codex]', 'data-fix')], ds: t.attr('[data-plat=deepseek]', 'data-state') });
    ` },
    check: r => [
      ['Codex 行给出「先登录」指引', JSON.stringify(r.res.snap.codex) === '["unconfigured","login-codex"]', JSON.stringify(r.res.snap.codex)],
      ['不影响其他两家', r.res.snap.ds === 'ok'],
    ],
  },
  {
    id: 'T37', desc: '幂等与回访（两次打开、不点保存 = 零写入）',
    page: {
      sdp: 'ok', status: PLAT_STATUS, files: FS_OK,
      driver: TO_STEP2 + `
      t.snapshot({ firstReady: t.attr('[data-plat=deepseek]', 'data-setup-state'), writes1: t.unwritten() });
      t.click('#setupNext2'); await t.untilSel('#setupNext3');
      t.snapshot({ noAsk: [t.has('#setupKey-deepseek'), t.has('#setupRe-deepseek'), t.has('#setupKey-glm')] });
      t.esc();
      await t.until(function () { return !document.querySelector('#setupOverlay.on'); }, 3000, 'overlay closed');
      t.click('#setupStartBtn'); t.click('#legacyConnections');
      await t.untilSel('#setupNext3');
      t.snapshot({ again: [t.has('#setupKey-deepseek'), t.has('#setupRe-deepseek'), t.has('#setupKey-glm')], writes2: t.unwritten() });
    ` },
    check: r => [
      ['第一次打开显示既有状态', r.res.snap.firstReady === 'ready', r.res.snap.firstReady],
      ['已找到的不重复问（无输入框、无重填入口）', JSON.stringify(r.res.snap.noAsk) === '[false,false,false]', JSON.stringify(r.res.snap.noAsk)],
      ['第二次打开仍是既有现状（不倒退、不重复问）', JSON.stringify(r.res.snap.again) === '[false,false,false]', JSON.stringify(r.res.snap.again)],
      ['两次打开零写入', r.res.snap.writes1 === 0 && r.res.snap.writes2 === 0],
    ],
  },
];

// ---------- T32：首屏无影响（与本文件写死的期望清单对比） ----------
// 为什么不用「开工前快照文件」：快照放在 data/__test-dashboard__/（不进仓库），
// 新克隆的机器上没有 → T32 整组（5 条断言）静默跳过 → 报“全过”是假绿（隔离副本尤其如此）。
// 改成写死期望清单：① 永远会跑；② 谁改了首屏，这里就红，必须显式改这份清单（意图可见）。
// 更新方法：跑 node tools/test-dashboard.mjs，失败信息会列出「多出/少了」，核对后改这里。
const T32_EXPECTED_IDS = ['alertCount','alerts-table','attrBars','attrHint','attrNote','attrSeg','backupBtn','bg1','cap-codex','cap-ds','cap-glm','cards','cfgBtn','cfgGrid','cfgOverlay','cfgPanel','cfgPanelBtn','cfgSave','changes-ds','changes-glm','chartHint','dashboard-data-script','exportBtn','fresh','healthHint','healthList','heat','heatDays','heatFoot','heatMonths','heatNote','heatSeg','heatSummary','heatTip','heatWrap','helpBtn','helpOverlay','hint-codex','intervalNote','modelBars','modelHint','modelNote','modelSummary','mute','packs-table','pauseBtn','refreshBtn','ring','ringTxt','setupBar','stats-codex','stats-ds','stats-glm','strip','supportBtn','tcBars','tcHint','tcNote','tcSeg','tcSummary','themeBtn','toolNote','updated','usageStyle','winSeg','wrap-codex','wrap-ds','wrap-glm'];
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
  check('T32', '向导 DOM 懒创建（#setupOverlay / #setupFallback 不在 DOM）', !b.res.present.overlay && !b.res.present.fallback, JSON.stringify(b.res.present));
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
