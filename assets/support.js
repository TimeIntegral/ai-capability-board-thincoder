/* Independent update/feedback UI; file:// compatible, no remote executable scripts. */
(() => {
  'use strict';
  const info = window.BOARD_PRODUCT || {};
  let state = { currentVersion: info.version || '未知', channels: info.channels || {}, automatic: true, notifications: true };
  let timer, waitingUntil = 0, previousData = '';
  const make = (tag, text, className) => {
    const el = document.createElement(tag); if (text) el.textContent = text;
    if (className) el.className = className; return el;
  };
  const overlay = make('div', '', 'overlay'); overlay.id = 'supportOverlay';
  const modal = make('div', '', 'modal'); modal.style.maxWidth = '620px';
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
  function button(label, action, primary = false) {
    const b = make('button', label, `btn${primary ? ' primary' : ''}`);
    b.addEventListener('click', action); return b;
  }
  function link(label, href) {
    const a = make('a', label, 'btn');
    try { const u = new URL(href); if (u.protocol !== 'https:' || u.username || u.password) return make('span', '入口尚未配置', 'muted'); a.href = u.href; }
    catch { return make('span', '入口尚未配置', 'muted'); }
    a.target = '_blank'; a.rel = 'noopener noreferrer'; return a;
  }
  function open() { overlay.classList.add('on'); render(); modal.querySelector('button')?.focus(); poll(); }
  function close() { overlay.classList.remove('on'); document.getElementById('supportBtn')?.focus(); }
  function render() {
    modal.replaceChildren(make('h3', '帮助与反馈'), make('p', `当前版本 v${state.currentVersion}`));
    const status = make('p', state.message || '可手动检查更新；自动检查每天最多一次。'); status.id = 'updateMessage'; status.setAttribute('aria-live', 'polite'); modal.append(status);
    const actions = make('div', '', 'actions');
    actions.append(button('检查更新', () => command('check')));
    if (state.available && state.manifest) {
      modal.append(make('h4', `新版本 v${state.manifest.version}`));
      const notes = make('p', state.manifest.notes || '改进与修复'); notes.style.whiteSpace = 'pre-wrap'; modal.append(notes);
      const upgrade = button('立即更新', () => command('install'), true);
      upgrade.disabled = state.phase === 'downloading';
      actions.append(upgrade, button('稍后提醒', () => command('later')), link('查看更新说明', state.manifest.releaseUrl));
      modal.append(make('p', '升级保留配置和历史；下载校验后打开安装向导。', 'muted'));
    }
    modal.append(actions);
    for (const [name, label, action] of [['automatic', '每天自动检查更新', 'auto'], ['notifications', '允许托盘提示新版本', 'notify']]) {
      const row = make('label', '', 'hint'); row.style.cssText = 'display:block;margin:12px 0';
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = state[name] !== false;
      check.addEventListener('change', () => command(`${action}-${check.checked ? 'on' : 'off'}`)); row.append(check, document.createTextNode(` ${label}`)); modal.append(row);
    }
    modal.append(make('h4', '交流与问题反馈'));
    const contact = make('div', '', 'actions');
    contact.append(link('加入用户群', state.channels?.community), link('提交问题', state.channels?.github ? `${state.channels.github}/issues` : ''));
    contact.append(button('复制反馈信息', async () => {
      const text = `软件版本：v${state.currentVersion}\n系统：${navigator.platform || 'Windows'}\n遇到的问题：\n复现步骤：\n希望的结果：\n`;
      try { await navigator.clipboard.writeText(text); status.textContent = '已复制反馈模板，可粘贴到群内或问题页面。'; }
      catch { const box = make('textarea'); box.value = text; box.style.cssText = 'width:100%;height:140px'; modal.append(box); box.focus(); box.select(); status.textContent = '请复制下方反馈模板。'; }
    }));
    modal.append(contact, make('p', '入群页面会提供最新二维码；反馈模板不含密钥、用量和项目路径。', 'muted'));
    modal.append(button('关闭', close));
    banner.replaceChildren();
    const show = !!state.available && state.manifest && !(state.snoozeUntil > Date.now());
    banner.hidden = !show; banner.style.display = show ? 'flex' : 'none';
    if (show) banner.append(make('strong', `发现新版本 v${state.manifest.version}`), button('查看与更新', open, true), button('稍后提醒', () => command('later')));
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
