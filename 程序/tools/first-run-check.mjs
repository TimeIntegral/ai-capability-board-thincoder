// 首次采集验证：装好 / 配好之后立刻跑一次真实采集，把「到底成没成」用人话汇报给用户。
//
// 为什么单独一个文件：安装收尾（install.mjs）要用它，而且这一步
// 必须能被**单独调用**——install.mjs 会注册真实的计划任务与桌面快捷方式，不适合为了验证反复执行。
// 抽成模块后即可单独复用，也能自己跑：
//
//   node 程序/tools/first-run-check.mjs        跑一次采集并打印报告（退出码 0 = 都通，1 = 有平台没通）
//   import { runFirstRunCheck } from './first-run-check.mjs';
//
// 纪律：
//   · 错误信息先净化再上屏（采集器已经净化过一次，这里再兜一道），密钥永不打印；
//   · 输出对象是不懂技术的用户——先给一句人话，再给一句能照做的下一步，不甩 HTTP 状态码。
//
// 注意：这一步是**真实采集**（会写 data/、可能弹一条提醒），不是演练。

const LABEL = { codex: 'Codex', deepseek: 'DeepSeek', glm: 'GLM' };
const ORDER = ['codex', 'deepseek', 'glm'];

// ---- 对外用的符号与措辞 ----
const SYMBOL = { ok: '✓', unconfigured: '⚠', disabled: '⚠', failed: '✗' };

// 重跑配置向导的提示语（多个地方要用，抽出来免得三处措辞不一致）
// 2026-09-17：控制台问答向导已删除；重跑配置的唯一入口是看板页面里的设置向导。
const RETRY_HINT = '打开看板，点右上角「配置」→「打开配置向导」重走一遍';

// 密钥打码：第二道防线（第一道在采集器里）。宁可过度打码，也不能让密钥上屏或进日志。
export function maskSecrets(text) {
  return String(text ?? '')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, 'Bearer ***')
    .replace(/eyJ[A-Za-z0-9._-]{20,}/g, '***JWT***')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
    .replace(/\b[0-9a-f]{32}(\.[A-Za-z0-9]+)?\b/gi, '***KEY***');
}

// 原始错误里能安全展示的部分：打码 + 砍掉响应正文（正文里可能出现密钥的残余字符），只留「接口 + 状态」
function briefDetail(raw) {
  return maskSecrets(raw).replace(/\{.*$/s, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// 鉴权类失败（密钥填错 / 登录过期）：错误文案五花八门（HTTP 401 / code=401 / 令牌已过期），集中在这里判一次
export function isAuthFailure(raw) {
  return /HTTP 40[13]|code=40[13]|令牌已过期|验证不正确|Authentication Fails|未通过验证/i.test(maskSecrets(raw));
}

// 把技术错误翻成人话（name 用于区分平台：Codex 的「鉴权失败」= 登录过期，不是密钥填错）
export function friendlyError(raw, name) {
  const s = maskSecrets(raw);
  if (isAuthFailure(s)) {
    return name === 'codex'
      ? 'Codex 的登录状态失效了（打开 Codex 桌面端登录一次就会自动续期）'
      : '密钥没通过验证（多半是粘贴时少了字符，或者密钥已经失效）';
  }
  if (/HTTP 429/.test(s)) return '请求太频繁被暂时拦住了，等几分钟再试';
  if (/HTTP 5\d\d/.test(s)) return '对方服务器暂时有问题，过一会儿再试';
  if (/请求失败（代理\+直连均已尝试）|socket hang up|fetch failed/i.test(s)) {
    return name === 'codex'
      ? '没能连上 Codex 的服务：要么是代理 / VPN 没开，要么是登录状态过期了（打开 Codex 桌面端登录一次就会自动续期）'
      : '没能连上对方的服务（多半是网络不通）';
  }
  if (/timeout|timed out|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network/i.test(s)) {
    return '网络没连上（Codex 通常要开着代理 / VPN）';
  }
  if (/未配置密钥|NO_KEY/.test(s)) return '还没填密钥';
  return briefDetail(s) || '原因不明';
}

// 密钥来源标签（只报来源，不报内容）
export function sourceLabel(src) {
  if (!src) return '';
  return src === 'secrets.json' ? '本机密钥文件' : src;
}

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }

// ---- 每个平台这一轮的结果 → 一句话 ----

function describeOk(name, res) {
  const d = res.data ?? {};
  if (name === 'codex') {
    const u = num(d.fiveHour?.usedPercent), w = num(d.weekly?.usedPercent);
    const parts = [];
    if (u !== null) parts.push(`5 小时窗口已用 ${Math.round(u)}%（还剩 ${Math.max(0, 100 - Math.round(u))}%）`);
    if (w !== null) parts.push(`本周已用 ${Math.round(w)}%`);
    let s = `Codex 已经能采到数据${parts.length ? '：' + parts.join(' · ') : ''}`;
    if (res.degraded) {
      const age = num(d.snapshotAgeMinutes);
      s += `。这次没连上实时接口，用的是本机记录${age !== null ? `（快照约 ${age} 分钟前）` : ''}`;
    }
    return s;
  }
  if (name === 'deepseek') {
    const b = num(d.totalBalance);
    return `DeepSeek 已经能采到数据${b !== null ? `：余额 ¥${b.toFixed(2)}` : ''}`
      + (d.keySource ? `（密钥来源：${sourceLabel(d.keySource)}）` : '');
  }
  const b = num(d.balance);
  return `GLM 已经能采到数据${b !== null ? `：余额 ¥${b.toFixed(2)}` : ''}`
    + (d.keySource ? `（密钥来源：${sourceLabel(d.keySource)}）` : '');
}

// 返回 { name, label, level, text, hint, rawFull? }
// 注意不在报告里另贴「技术细节」：认得出来的失败已经翻译成人话，认不出来的会直接把人话里带上原话（friendlyError 的兜底）——
// 面向不懂技术的用户，少一行黑话就少一分害怕。原始错误另有去向：state.json 的 health.lastErrors（已净化）。
export function describePlatform(name, res) {
  const label = LABEL[name] ?? name;
  if (!res) {
    return { name, label, level: 'failed', text: `${label} 这一轮没有结果（采集可能没跑起来）`, hint: `再双击一次「安装定时任务.bat」试试` };
  }
  if (res.disabled === true) {
    return {
      name, label, level: 'disabled',
      text: `${label} 现在是关着的（配置里关掉了它）`,
      hint: `想用 ${label}：${RETRY_HINT}，把它选成开启`,
    };
  }
  if (res.unconfigured === true) {
    const hint = name === 'codex'
      ? '想用 Codex：先用 Codex 桌面端登录一次，再' + RETRY_HINT
      : `想用 ${label}：先用 ThinCoder 把密钥配好（或在「配置」面板里点「编辑密钥文件」自己填），再${RETRY_HINT}`;
    const why = name === 'codex' ? '本机没找到 Codex 的登录信息' : '还没填密钥';
    return { name, label, level: 'unconfigured', text: `${label} 还没配置好：${why}`, hint };
  }
  if (!res.ok) {
    const hint = name === 'codex'
      ? '先确认代理 / VPN 开着；还不行就打开 Codex 桌面端登录一次，再双击「安装定时任务.bat」重试'
      : `检查密钥填得对不对、账户里还有没有余额；改完${RETRY_HINT}`;
    return {
      name, label, level: 'failed',
      text: `${label} 采集失败：${friendlyError(res.error, name)}`,
      hint, rawFull: maskSecrets(res.error),
    };
  }
  return { name, label, level: 'ok', text: describeOk(name, res), hint: '' };
}

// ---- 汇总成「一句结论 + 一条下一步」----

export function summarize(state) {
  const current = state?.current ?? {};
  const results = ORDER.map(name => describePlatform(name, current[name]));
  const by = lv => results.filter(r => r.level === lv);
  const okLabels = by('ok').map(r => r.label);
  const needKeyLabels = by('unconfigured').map(r => r.label);
  const failedLabels = by('failed').map(r => r.label);
  const offLabels = by('disabled').map(r => r.label);

  let verdict;
  if (failedLabels.length) {
    verdict = {
      level: 'failed',
      text: `⚠ 还差一步：${failedLabels.join('、')} 这次没采到数据 —— 按上面的提示处理，处理完再${RETRY_HINT}。`,
    };
  } else if (needKeyLabels.length) {
    verdict = {
      level: 'warn',
      text: `⚠ 还差一步：${needKeyLabels.join('、')} 还没配好 —— 按上面的提示把密钥补上，再${RETRY_HINT}。`,
    };
  } else if (!okLabels.length) {
    verdict = {
      level: 'warn',
      text: `⚠ 现在三家平台都是关着的，采不到任何数据 —— ${RETRY_HINT}，把想看的平台打开。`,
    };
  } else {
    verdict = {
      level: 'ok',
      text: `✅ 成功了：${okLabels.join('、')} 都能正常采集${offLabels.length ? `（${offLabels.join('、')} 按你的选择关着）` : ''}。看板在桌面（「AI 能力看板」），双击就能看；以后它会自己采，不用管。`,
    };
  }
  return { results, allOk: !failedLabels.length && !needKeyLabels.length && okLabels.length > 0, verdict, okLabels, needKeyLabels, failedLabels, offLabels };
}

export function reportLines(summary) {
  const lines = [];
  for (const r of summary.results) {
    lines.push(`${SYMBOL[r.level] ?? '·'} ${r.text}`);
    if (r.hint) lines.push(`   ↳ ${r.hint}`);
  }
  lines.push('');
  lines.push(summary.verdict.text);
  return lines;
}

export function printReport(summary) {
  for (const l of reportLines(summary)) console.log(l);
}

// 跑一次真实采集（forceAll=true 忽略间隔，保证每个开启的平台都真的取一次数）
export async function collectOnce({ forceAll = true } = {}) {
  const { runCollection } = await import('../collect.mjs');
  const { state } = await runCollection({ forceAll });
  return state;
}

// 完整一步：采集 → 汇总 → 打印。返回结构化结果（调用方可以据此再做事，比如引导重填密钥）
export async function runFirstRunCheck({ silent = false, forceAll = true } = {}) {
  if (!silent) console.log('  正在试采一次（要联网，最多十几秒）…');
  let summary;
  try {
    summary = summarize(await collectOnce({ forceAll }));
  } catch (e) {
    const text = `✗ 试采没能跑起来：${friendlyError(e?.message ?? e)}`;
    summary = { results: [], allOk: false, verdict: { level: 'failed', text: `⚠ ${text} —— 再双击一次「安装定时任务.bat」试试。` }, okLabels: [], needKeyLabels: [], failedLabels: ['试采'], offLabels: [] };
  }
  if (!silent) printReport(summary);
  return summary;
}

// 单独运行：node 程序/tools/first-run-check.mjs
if (process.argv[1] && process.argv[1].endsWith('first-run-check.mjs')) {
  console.log('—— 试采一次，确认真的能采到数据 ——');
  const s = await runFirstRunCheck();
  process.exitCode = s.allOk ? 0 : 1;
}
