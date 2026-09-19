/* Independent update/feedback UI; file:// compatible, no remote executable scripts. */
(() => {
  'use strict';
  const info = window.BOARD_PRODUCT || {};
  // automatic 的默认值与 程序/tools/update.mjs 里 update-preferences.json 的默认值同源：每天自动检查默认不勾选
  let state = { currentVersion: info.version || '未知', channels: info.channels || {}, automatic: false, notifications: true };
  let timer, waitingUntil = 0, previousData = '';
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
  // 「去下载」：检测到新版本时开的那扇门——普通外链，浏览器打开该版本的 Release 页面。
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
  function open() { overlay.classList.add('on'); render(); modal.querySelector('button')?.focus(); poll(); }
  function close() { overlay.classList.remove('on'); document.getElementById('supportBtn')?.focus(); }
  function render() {
    // 关闭改到右上角图标（底部那个孤立在左下的「关闭」按钮去掉）
    const closeBtn = make('button', '×', 'x');
    closeBtn.type = 'button'; closeBtn.title = '关闭'; closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.addEventListener('click', close);
    modal.replaceChildren(make('h3', '帮助与反馈'), closeBtn, make('p', `当前版本 v${state.currentVersion}`, 'muted'));
    // 状态与「检查更新」同一行（按钮不再单独占一行飘在最右边）
    const row = make('div', '', 'row');
    const status = make('span', state.message || '可手动检查更新。', 'spacer');
    status.id = 'updateMessage'; status.setAttribute('aria-live', 'polite');
    row.append(status, button('检查更新', () => command('check')));
    modal.append(row);
    // 「有新版本」只判断一处：弹窗与横幅要给一模一样的两个动作，两份条件各自演化会变成一边有门一边没有
    const newer = !!(state.available && state.manifest);
    if (newer) {
      modal.append(make('h4', `新版本 v${state.manifest.version}`));
      const notes = make('p', state.manifest.notes || '改进与修复', 'muted'); notes.style.whiteSpace = 'pre-wrap'; modal.append(notes);
      // 检测到新版本时给两个动作：去下载（外链，去该版本的 Release 页——2026-09-20 用户定：仍不自动下载、不自动安装，
      // 但要有地方可去）与 跳过该版本（2026-09-17 用户定：跳过只按版本记，不作废后续版本）。
      // 动作名 skip 三处同名：本文件 → 协议白名单（程序/运行协议.vbs 的固定动作表）→ tools/update.mjs。
      // 三处必须一起改：对不上的表现是「点了没反应」，静默失败最难查。
      const actions = make('div', '', 'actions');
      const download = downloadLink();
      if (download) actions.append(download);
      actions.append(button('跳过该版本', () => command('skip')));
      modal.append(actions);
    }
    const opts = make('div', '', 'opts');
    for (const [name, label, action] of [['automatic', '每天自动检查更新', 'auto'], ['notifications', '允许托盘提示新版本', 'notify']]) {
      const line = make('label');
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state[name] !== false;
      check.addEventListener('change', () => command(`${action}-${check.checked ? 'on' : 'off'}`));
      line.append(check, document.createTextNode(` ${label}`)); opts.append(line);
    }
    modal.append(opts, make('h4', '交流与问题反馈'), wechatBlock());
    banner.replaceChildren();
    const show = newer;
    banner.hidden = !show; banner.style.display = show ? 'flex' : 'none';
    if (show) {
      banner.append(make('strong', `发现新版本 v${state.manifest.version}`));
      const download = downloadLink();
      if (download) banner.append(download);
      banner.append(button('跳过该版本', () => command('skip')));
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
      }
      else if (waitingUntil && Date.now() > waitingUntil) { state.message = '尚未收到回应。请通过安装版启动看板后重试。'; waitingUntil = 0; render(); }
      timer = setTimeout(poll, overlay.classList.contains('on') || waitingUntil ? 1500 : 60000);
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
