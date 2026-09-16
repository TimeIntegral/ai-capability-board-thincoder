import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, ensureDataDir, isDnd, loadMute, HOUR_MS } from '../lib/common.mjs';

// Windows toast 通知（PowerShell WinRT，零依赖）
// 设计：一次采集最多弹**一条**（多事件聚合成摘要）；静音优先于免打扰；P0 可穿透静音。
const QUEUE_FILE = `${DATA_DIR}\\notify-queue.json`;
const QUEUE_MAX = 50;
const APP_ID = 'AIQuotaBoard';                 // 自定义 AppUserModelID（安装脚本已注册）
const FALLBACK_APP_ID = 'Microsoft.Windows.PowerShell';

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&apos;').replace(/"/g, '&quot;');
}

// 点击通知 → 打开看板（protocol activation；实验性，失败不影响通知本身）
// silent=true → 无提示音（夜间免打扰时用，仍然可见）
// extraActions → 追加动作按钮，如 [{content:'不再提醒', url:'aiquotaboard://suppress?platform=glm'}]
function showToast(title, body, launchUrl, silent = false, extraActions = []) {
  const buttons = (extraActions.length || launchUrl) ? true : false;
  const ps = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $xml.GetElementsByTagName('text')
$t.Item(0).AppendChild($xml.CreateTextNode('${esc(title)}')) | Out-Null
$t.Item(1).AppendChild($xml.CreateTextNode('${esc(body)}')) | Out-Null
${buttons ? `
$actions = $xml.CreateElement('actions')
${extraActions.map(a => `
$a0 = $xml.CreateElement('action')
$a0.SetAttribute('content', '${esc(a.content)}')
$a0.SetAttribute('arguments', '${esc(a.url)}')
$a0.SetAttribute('activationType', 'protocol')
$actions.AppendChild($a0) | Out-Null
`).join('')}
${launchUrl ? `
$a1 = $xml.CreateElement('action')
$a1.SetAttribute('content', '打开看板')
$a1.SetAttribute('arguments', '${esc(launchUrl)}')
$a1.SetAttribute('activationType', 'protocol')
$actions.AppendChild($a1) | Out-Null
` : ''}
$xml.DocumentElement.AppendChild($actions) | Out-Null
` : ''}
${silent ? `
$audio = $xml.CreateElement('audio')
$audio.SetAttribute('silent', 'true')
$xml.DocumentElement.AppendChild($audio) | Out-Null
` : ''}
try {
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
} catch {
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${FALLBACK_APP_ID}').Show([Windows.UI.Notifications.ToastNotification]::new($xml))
}
`;
  const b64 = Buffer.from(ps, 'utf16le').toString('base64');
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', b64], { timeout: 30000, stdio: 'ignore' });
}

function esc(s) { return xmlEscape(s).replace(/'/g, "''"); }

function loadQueue() { try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; } }
function saveQueue(q) { ensureDataDir(); fs.writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 1)); }

const LEVEL_RANK = { P0: 0, P1: 1, P2: 2 };

export async function notify(fired, cfg) {
  if (!fired?.length) return { shown: 0, deferred: 0 };

  const mute = loadMute();
  const dnd = isDnd(cfg);
  const allowP0 = cfg.mute?.allowP0 !== false;
  // 中文路径需要百分号编码，否则 protocol 激活会失败
  const launchUrl = cfg.notify?.launchUrl ? encodeURI(cfg.notify.launchUrl) : null;

  // 静音：P1/P2 一律入队（P0 由 allowP0 决定是否穿透）
  // 免打扰：非 P0 入队
  const silenced = a =>
    (mute.active && (a.level !== 'P0' || !allowP0)) ||
    (dnd && a.level !== 'P0');

  const deferred = fired.filter(silenced);
  const immediate = fired.filter(a => !silenced(a));

  if (deferred.length) {
    const q = [...loadQueue(), ...deferred.map(a => ({ ...a, queuedAt: Date.now() }))];
    saveQueue(q.slice(-QUEUE_MAX)); // 队列上限，丢弃最旧的
  }

  let toSend = [...immediate];
  // 静音/免打扰结束后，把队列并进来一起发（聚合成一条）
  if (!silenced({ level: 'P1' }) && !silenced({ level: 'P2' })) {
    const q = loadQueue();
    if (q.length) {
      const fresh = q.filter(a => Date.now() - (a.queuedAt ?? 0) < 72 * HOUR_MS); // 超过 3 天的旧提醒丢弃
      if (fresh.length) toSend = [...toSend, ...fresh];
      saveQueue([]);
    }
  }
  if (!toSend.length) return { shown: 0, deferred: deferred.length };

  // 聚合：一次采集只弹一条
  const level = toSend.reduce((acc, a) => (LEVEL_RANK[a.level] < LEVEL_RANK[acc] ? a.level : acc), 'P2');
  const title = toSend.length === 1 ? toSend[0].title : `[${level}] ${toSend.length} 条额度提醒`;
  const body = toSend.length === 1
    ? toSend[0].body
    : toSend.slice(0, 3).map(a => `· ${a.title}`).join('\n') + (toSend.length > 3 ? `\n…等共 ${toSend.length} 条` : '');

  // 余额类提醒：若只涉及单一平台，附带「去充值」与「不再提醒」按钮
  // （触发去充值按钮的提醒类型：余额耗尽/紧急/偏低，以及该平台的异常消耗）
  const balancePlatforms = [...new Set(
    toSend.filter(a => a.key?.startsWith('balanceRe:') || a.key?.startsWith('anomaly:'))
      .map(a => a.key.startsWith('anomaly:') ? a.key.split(':')[1] : a.key.split(':')[1]?.split('.')[0])
      .filter(Boolean),
  )];
  const links = cfg?.links ?? {};
  const extraActions = [];
  if (balancePlatforms.length === 1) {
    const p = balancePlatforms[0];
    const topup = links[p]?.topup;
    if (topup) extraActions.push({ content: `去充值（${links[p]?.name ?? p}）`, url: topup });
    extraActions.push({ content: `不再提醒${links[p]?.name ?? (p === 'glm' ? 'GLM' : 'DeepSeek')}余额`, url: `aiquotaboard://suppress?platform=${p}` });
  }

  try { showToast(title, body, launchUrl, dnd, extraActions); return { shown: 1, deferred: deferred.length }; }
  catch (e) { logError(title, e); return { shown: 0, deferred: deferred.length }; }
}

function logError(title, e) {
  try { fs.appendFileSync(`${DATA_DIR}\\notify-errors.log`, `${new Date().toISOString()} toast失败 [${title}]: ${String(e).slice(0, 200)}\n`); } catch { /* 忽略 */ }
}
