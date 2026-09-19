/* Independent update/feedback UI; file:// compatible, no remote executable scripts. */
(() => {
  'use strict';
  const info = window.BOARD_PRODUCT || {};
  // automatic 的默认值与 程序/tools/update.mjs 里 update-preferences.json 的默认值同源：每天自动检查默认不勾选
  let state = { currentVersion: info.version || '未知', channels: info.channels || {}, automatic: false, notifications: true };
  let timer, waitingUntil = 0, previousData = '', lastPhase = null, closing = false, closeBlocked = false;
  // 「正在下载 / 正在安装」这两段的状态由 程序/tools/update.mjs（下载 + 交接）与它的「安装监看」进程
  // （安装收尾）写进 data/update-status.json 与 update-data.js，页面每 1.5 秒读一次：
  // 进度、百分比、文案全部来自那一份，页面不自己算、也不去猜。
  const BUSY = ['downloading', 'installing'];
  const busy = () => BUSY.includes(state.phase);
  const make = (tag, text, className) => {
    const el = document.createElement(tag); if (text) el.textContent = text;
    if (className) el.className = className; return el;
  };
  const overlay = make('div', '', 'overlay'); overlay.id = 'supportOverlay';
  const modal = make('div', '', 'modal');
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', '帮助与反馈');
  overlay.append(modal); document.body.append(overlay);
  const banner = make('div', '', 'card'); banner.id = 'updateBanner'; banner.hidden = true;
  banner.style.cssText = 'margin:12px 0;display:none;gap:12px;align-items:center;flex-wrap:wrap';
  const first = document.querySelector('.card'); first?.before(banner);
  // 更新动作只发固定协议（页面拿不到结果，结果看状态文件）：
  // install = 立即更新：下载（带进度）→ 校验 SHA256 → 自动关掉看板 → 装 → 装完自动重开看板；
  // skip    = 跳过该版本。动作名三处同名：本文件 → 协议白名单（程序/运行协议.vbs）→ 程序/tools/update.mjs，
  // 三处要一起改 —— 对不上的表现是「点了没反应」，静默失败最难查。
  function command(action) {
    const frame = document.createElement('iframe'); frame.style.display = 'none';
    frame.src = `aiquotaboard://update-${action}`; document.body.append(frame);
    setTimeout(() => frame.remove(), 1500);
    waitingUntil = Date.now() + 30000;
    state.message = '正在处理…若浏览器询问，请允许打开看板应用。'; render();
    clearTimeout(timer); poll();
  }
  function button(label, action) {
    const b = make('button', label, 'btn');
    b.addEventListener('click', action); return b;
  }
  // 「去下载」：开的那扇门——普通外链，浏览器打开该版本的 Release 页面。
  // 不走 aiquotaboard:// 协议白名单：那条路只给本机动作用，而且页面对结果一无所知；
  // 做法与看板既有外链（卡片 ↗、「安装 ThinCoder」）一致：<a target="_blank" rel="noopener noreferrer">。
  // 地址取 manifest.releaseUrl（latest.json 的字段，由 程序/lib/updates.mjs 的 allowedUrl 校验：只允许本项目发布渠道的 https 地址），
  // 这里不硬编码任何 URL。拿不到有效地址就不给按钮：点了不会发生任何事的按钮不该出现。
  function downloadLink() {
    let url;
    try { url = new URL(state.manifest?.releaseUrl); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const a = make('a', '去下载', 'btn');
    a.href = url.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  }
  // 版本比较只做一件事：判断缓存里的 manifest 是不是比当前版本新（决定「去下载」给不给、新版本块画不画）。
  // 不跟 available 走：用户点过「跳过」之后 available 会变 false（横幅要安静），
  // 但弹窗里仍要给「去下载」（2026-09-20 用户定：弹窗是用户主动打开的地方）。
  function newerVersion(v) {
    const a = String(v ?? '').split('.').map(Number), b = String(state.currentVersion ?? '').split('.').map(Number);
    if (a.length !== 3 || b.length !== 3 || a.some(Number.isNaN) || b.some(Number.isNaN)) return false;
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  }
  const hasNewer = () => !!state.manifest && newerVersion(state.manifest.version);
  // 维护者微信号 + 一键复制（这串字母数字手抄容易错）；
  // 复制结果就地在按钮旁反馈：原来写进标题下的状态行，离按钮 8 行远，点了像没反应
  const WECHAT_ID = 'lixiangcheng2017';
  function wechatBlock() {
    const row = make('div', '', 'row');
    const id = make('strong', WECHAT_ID);
    id.style.cssText = 'font: 600 14px/1.4 var(--mono, ui-monospace, monospace)';
    const note = make('span', '', 'muted'); note.setAttribute('aria-live', 'polite');
    row.append(make('span', '微信', 'muted'), id, button('复制', async () => {
      try { await navigator.clipboard.writeText(WECHAT_ID); note.textContent = '已复制'; }
      catch { note.textContent = `请手动复制：${WECHAT_ID}`; }
    }), note);
    return row;
  }
  // 「立即更新」点下去之后，这一页要不要自己关掉：看板是普通浏览器标签页（快捷方式、托盘、
  // aiquotaboard://open 都是 start dashboard.html），而只有「历史记录只有一条」的标签页才允许
  // window.close() —— 2026-09-20 实测（Edge 无头 + CDP）：命令行直接打开的页（history=1）关得掉，
  // 有前进后退历史的页（history=3）关不掉。所以：能关就关，关不掉时立刻把话说实话（见 statusText），
  // 绝不让页面上留着一句「看板会关闭」的假承诺。
  function closeSelf() {
    if (closing) return;
    closing = true;
    try { window.close(); } catch { /* 浏览器拒绝：下面的定时器会把文案改成实话 */ }
    setTimeout(() => { closeBlocked = true; render(); }, 1200);
  }
  // 阶段变化只看这一处：装的过程中新开的页面（第一眼就是 installing）不该自己消失
  function notePhase(next) {
    if (next.phase === 'installing' && lastPhase && lastPhase !== 'installing') closeSelf();
    lastPhase = next.phase;
  }
  // 状态行：正常就是 update.mjs 写下的那句（「已更新到 vX」「更新没装成…」的单一出处在这里），
  // 只有「本页关不掉」这一种情况本文件才换一句实话。
  function statusText() {
    if (closeBlocked && state.phase === 'installing') return '正在安装，完成后看板会自动打开；本页可以关掉';
    return state.message || '可手动检查更新。';
  }
  // 进度条：只有下载阶段有百分比（安装阶段的进度在安装器自己的窗口里 —— 它用 /SILENT 跑，看得见进度）。
  // DOM 用内联样式：这个文件不拥有 dashboard.html 的样式表。
  function progressBar() {
    if (state.phase !== 'downloading') return null;
    const percent = Math.max(0, Math.min(100, Number(state.progress?.percent) || 0));
    const row = make('div', '', 'row updateProgress');
    row.setAttribute('role', 'progressbar');
    row.setAttribute('aria-valuenow', String(percent));
    const track = make('span');
    track.style.cssText = 'display:inline-block;flex:1;min-width:160px;height:6px;border-radius:3px;background:rgba(127,127,127,.25)';
    const bar = make('span');
    bar.style.cssText = `display:inline-block;height:6px;border-radius:3px;background:#2563eb;width:${percent}%`;
    track.append(bar); row.append(track);
    return row;
  }
  // 三个更新动作只在两个地方出现（弹窗与横幅），写一份：立即更新 / 去下载 / 跳过该版本。
  // 少了哪个都会让用户没有出路：不动它就得能跳过，跳过之后还得能自己去下载。
  function updateActions() {
    const actions = make('div', '', 'actions');
    actions.append(button('立即更新', () => command('install')));
    const download = downloadLink();
    if (download) actions.append(download);
    if (state.skippedVersion !== state.manifest?.version) actions.append(button('跳过该版本', () => command('skip')));
    return actions;
  }
  function open() { overlay.classList.add('on'); render(); modal.querySelector('button')?.focus(); poll(); }
  function close() { overlay.classList.remove('on'); document.getElementById('supportBtn')?.focus(); }
  function render() {
    // 关闭在右上角图标（底部那个孤立在左下的「关闭」按钮去掉）
    const closeBtn = make('button', '×', 'x');
    closeBtn.type = 'button'; closeBtn.title = '关闭'; closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.addEventListener('click', close);
    modal.replaceChildren(make('h3', '帮助与反馈'), closeBtn, make('p', `当前版本 v${state.currentVersion}`, 'muted'));
    // 状态与「检查更新」同一行（按钮不再单独占一行飘在最右边）；下载/安装中不给「检查更新」——那会儿点它没有意义
    const row = make('div', '', 'row');
    const status = make('span', statusText(), 'spacer');
    status.id = 'updateMessage'; status.setAttribute('aria-live', 'polite');
    row.append(status);
    if (!busy()) row.append(button('检查更新', () => command('check')));
    modal.append(row);
    const bar = progressBar();
    if (bar) modal.append(bar);
    // 有新版本才画这一块：下载/安装中整块换成进度（动作收起来，免得半路再点一次）
    if (hasNewer() && !busy()) {
      modal.append(make('h4', `新版本 v${state.manifest.version}`));
      const notes = make('p', state.manifest.notes || '改进与修复', 'muted'); notes.style.whiteSpace = 'pre-wrap'; modal.append(notes);
      modal.append(updateActions());
    }
    const opts = make('div', '', 'opts');
    for (const [name, label, action] of [['automatic', '每天自动检查更新', 'auto'], ['notifications', '允许托盘提示新版本', 'notify']]) {
      const line = make('label');
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state[name] !== false;
      check.addEventListener('change', () => command(`${action}-${check.checked ? 'on' : 'off'}`));
      line.append(check, document.createTextNode(` ${label}`)); opts.append(line);
    }
    modal.append(opts, make('h4', '交流与问题反馈'), wechatBlock());
    // 横幅：有新版本就摆（下载/安装中摆进度，弹窗被关掉也看得见）；「跳过该版本」之后 available 变 false
    // 就整条安静下来 —— 跳过 = 不再打扰，弹窗里仍留着「去下载」这条出路。
    banner.replaceChildren();
    const show = !!state.available && !!state.manifest;
    banner.hidden = !show; banner.style.display = show ? 'flex' : 'none';
    if (show) {
      banner.append(make('strong', busy() ? statusText() : `发现新版本 v${state.manifest.version}`));
      if (busy()) { const b = progressBar(); if (b) banner.append(b); }
      else banner.append(updateActions());
    }
  }
  function poll() {
    clearTimeout(timer);
    const script = document.createElement('script'); script.src = `update-data.js?t=${Date.now()}`;
    const done = () => {
      script.remove();
      if (window.BOARD_UPDATE && JSON.stringify(window.BOARD_UPDATE) !== previousData) {
        previousData = JSON.stringify(window.BOARD_UPDATE); state = window.BOARD_UPDATE;
        if (state.updatedAt > waitingUntil - 30000) waitingUntil = 0; render();
        notePhase(state);
      }
      // 下载/安装中不判「没回应」：这两段本来就要等（下载几分钟是常事），状态文件一直在动
      else if (waitingUntil && Date.now() > waitingUntil && !busy()) { state.message = '尚未收到回应。请通过安装版启动看板后重试。'; waitingUntil = 0; render(); }
      // 下载/安装中一直快轮询（进度要看得见）；其余时候只有弹窗开着或刚点过按钮才快轮询
      timer = setTimeout(poll, overlay.classList.contains('on') || waitingUntil || busy() ? 1500 : 60000);
    };
    script.onload = done; script.onerror = done; document.head.append(script);
  }
  document.getElementById('supportBtn')?.addEventListener('click', open);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') {
      const nodes = [...modal.querySelectorAll('button:not(:disabled), a[href], input, textarea')];
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  render(); poll();
  if (location.hash === '#support') open();
})();
