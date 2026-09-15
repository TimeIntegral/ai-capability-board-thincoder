// 首次配置向导（双击「首次配置.bat」运行，也可以 node tools/setup.mjs）
//
// 六步：① 环境自检 ② 自动探测 ③ 选平台 ④ 填密钥（只问缺的）⑤ 保存设置 ⑥ 装进系统 + 试采一次
//
// 给谁用：不懂技术的用户。所以措辞全部是人话（不出现 JSON / schema / HTTP 状态码这类黑话），
// 每一步都告诉他「现在在干什么、可以直接回车」。
//
// 四条硬约束（都是反复踩过坑才定下来的）：
//   · 幂等：反复运行结果一致——已经选好的平台不会被改回默认，已经填过的密钥不会再问第二遍；
//   · 不挂死：stdin 不是控制台（管道喂输入、或者输入直接结束）时按「建议值」往下走，绝不卡在等输入；
//   · 不留半截文件：配置只在第 ⑤ 步一次性原子写入（先写临时文件再改名），任何时刻 Ctrl+C 退出都不会损坏已有设置；
//   · 密钥只进内存与密钥文件：不打印、不回显、不进日志（连长度之外的任何信息都不出现在屏幕上）。
//
// 开关（给自动化测试用，普通用户不用管）：
//   --no-install   跳过第 ⑥ 步里「注册计划任务 / 桌面快捷方式 / 托盘」的动作（在临时目录里试向导时用）

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import {
  CONFIG_FILE, SECRETS_FILE, ROOT_DIR, DATA_DIR,
  loadConfig, platformEnabled, resolveApiKey, readCodexAuth, writeJsonAtomic,
} from '../lib/common.mjs';
import { runFirstRunCheck, printReport, friendlyError, isAuthFailure, sourceLabel } from './first-run-check.mjs';

const NODE = process.execPath;
const SKIP_INSTALL = process.argv.includes('--no-install');
const LABEL = { codex: 'Codex', deepseek: 'DeepSeek', glm: 'GLM' };
const ORDER = ['codex', 'deepseek', 'glm'];
const KEYED = ['deepseek', 'glm'];              // 需要粘贴密钥的平台（Codex 用自己的登录信息）
const BAT = '「首次配置.bat」';
const RETRY = `重新双击${BAT}`;

let saved = false;                               // 第 ⑤ 步是否已经落盘（决定 Ctrl+C 时的措辞）

// ================= 交互输入层 =================
// 一个「读一行」的抽象，三种环境都要稳：
//   ① 双击运行（控制台）：正常一问一答，粘贴密钥时关掉回显；
//   ② 管道 / 文件喂输入（自动化测试）：按行读，行为与手动输入一致；
//   ③ 输入已经结束（stdin 接 NUL、管道提前关闭）：立刻返回 null，调用方用「建议值」兜底，不挂死。
// 为什么不用 rl.question：非终端输入会一次性把整段喂进来，question 之前到达的行会被丢掉；
// 自己用一个队列接住每一行，问的时候再取，才不会丢输入、也不会卡住。
function createPrompter() {
  const tty = Boolean(process.stdin.isTTY);
  const queue = [];        // 已到达、还没被问到的行
  const waiters = [];      // 正在等输入的回调
  let rl = null;
  let closingSelf = false;
  let eof = false;         // 输入已结束：之后每次提问都直接走「建议值」

  const settle = (line) => {
    const w = waiters.shift();
    if (w) w(line); else queue.push(line);
  };

  function ensure() {
    if (rl) return rl;
    rl = readline.createInterface({
      input: process.stdin,
      output: tty ? process.stdout : undefined,
      terminal: tty,
      historySize: 0,
    });
    rl.on('line', settle);
    rl.on('close', () => {
      if (closingSelf) { closingSelf = false; return; }
      eof = true;
      while (waiters.length) waiters.shift()(null);
    });
    return rl;
  }

  // 读一行（问题会显示出来）。返回去掉首尾空白的字符串；输入已结束 → null
  function ask(question) {
    if (question) process.stdout.write(question);
    ensure();
    // 管道输入的换行不会被回显，自己补一个，否则记录里所有问答挤在一行
    const done = (v) => {
      if (!tty) process.stdout.write('\n');
      return v === null ? null : String(v).trim();
    };
    if (queue.length) return Promise.resolve(done(queue.shift()));
    if (eof) return Promise.resolve(done(null));
    return new Promise((resolve) => waiters.push((line) => resolve(done(line))));
  }

  // 不回显地读一行（粘贴密钥用）。控制台里临时切到原始模式逐键读取；管道输入本来就不回显。
  async function askHidden(question) {
    if (question) process.stdout.write(question);
    if (!tty) return ask('');
    if (eof) return null;
    if (rl) { const r = rl; rl = null; closingSelf = true; r.close(); }
    const r = await readRawLine();
    process.stdout.write('\n');
    if (r.cancelled) cancel();
    return r.value;
  }

  // 原始模式逐键读一行：Enter 结束、退格删字、Ctrl+C 退出；屏幕上什么都不显示
  function readRawLine() {
    return new Promise((resolve) => {
      const stdin = process.stdin;
      const wasRaw = Boolean(stdin.isRaw);
      let value = '', done = false, skipEsc = false;
      const finish = (v, cancelled = false) => {
        if (done) return;
        done = true;
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        try { stdin.setRawMode(wasRaw); } catch { /* 非控制台：无所谓 */ }
        stdin.pause();
        resolve(cancelled ? { cancelled: true } : { value: v });
      };
      const onEnd = () => finish(null);
      const onData = (buf) => {
        for (const ch of buf.toString('utf8')) {
          if (ch === '\r' || ch === '\n') return finish(value);
          if (ch === '\u0003') return finish(null, true);              // 原始模式下 Ctrl+C 不触发信号，自己处理
          if (ch === '\u007f' || ch === '\b') { value = value.replace(/.$/su, ''); continue; }
          if (ch === '\u001b') { skipEsc = true; continue; }           // 方向键等控制序列：整段丢掉
          if (skipEsc) { if (/[A-Za-z~]$/.test(ch)) skipEsc = false; continue; }
          if (ch.charCodeAt(0) < 0x20) continue;
          value += ch;
        }
        if (value.length > 4096) finish(value);                        // 粘进来的东西不可能无限长
      };
      try { stdin.setRawMode(true); } catch { /* 忽略：下面照样能读到数据 */ }
      stdin.on('data', onData);
      stdin.on('end', onEnd);
      stdin.resume();
    });
  }

  function close() {
    waiters.length = 0;
    if (rl) { const r = rl; rl = null; closingSelf = true; r.close(); }
    try { process.stdin.pause(); } catch { /* 忽略 */ }
  }

  return { tty, ask, askHidden, close };
}

const prompter = createPrompter();

// 是 / 否 问句（回车 = 否）。输入结束时也按「否」处理——不做用户没明确要求的动作
async function confirm(question) {
  const a = (await prompter.ask(`${question}（输入 y 表示是，直接回车 = 否）：`)) ?? '';
  return /^(y|yes|是|好|要)$/i.test(a.trim());
}

// Ctrl+C / 取消：说清当前状态，然后退出（配置要么没动、要么已经完整落盘）
function cancel() {
  prompter.close();
  console.log('\n');
  console.log(saved
    ? `已取消：刚才的选择已经保存好了，剩下的步骤没做完。想继续就${RETRY}。`
    : `已取消：没有改动任何配置。想配置的时候再双击${BAT}。`);
  process.exit(130);
}
process.on('SIGINT', cancel);

// ================= 小工具 =================

const step = (n, title) => console.log(`\n【第 ${n} 步 / 共 6 步】${title}`);

// 读一个本机的设置文件：不存在 → 空对象；存在但读不出来 → 标成 broken（不静默覆盖）
function readJsonFile(file) {
  if (!fs.existsSync(file)) return { data: {}, exists: false, broken: false };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return { data: {}, exists: true, broken: true };
    return { data: j, exists: true, broken: false };
  } catch {
    return { data: {}, exists: true, broken: true };
  }
}

// 坏文件先挪到 data 目录留底（data 已被排除在公开范围外，不会跟着仓库走）
function stashBroken(file) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const dest = path.join(DATA_DIR, `${path.basename(file)}.broken.bak`);
    fs.copyFileSync(file, dest);
    return true;
  } catch { return false; }
}

// 密钥文件：原子写 + 权限收紧（Windows 上 chmod 语义有限，尽力而为）
function writeSecrets(obj) {
  const tmp = `${SECRETS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* 尽力而为 */ }
  fs.renameSync(tmp, SECRETS_FILE);
  try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* 尽力而为 */ }
}

// 用户自己写进配置里的平台开关（没写就是 undefined，交给「探测结果」当建议）
function explicitPlatform(userCfg, name) {
  const p = userCfg?.platforms;
  return (p && typeof p === 'object' && typeof p[name] === 'boolean') ? p[name] : undefined;
}

// ================= ① 环境自检 =================

function probeWritable() {
  const probe = path.join(DATA_DIR, '.write-probe');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: friendlyError(e?.message ?? e) };
  }
}

function checkEnvironment() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const okNode = major > 20 || (major === 20 && minor >= 11);
  console.log(okNode
    ? `  ✓ 运行环境：Node ${process.versions.node}，够用`
    : `  ✗ 运行环境太老：现在是 Node ${process.versions.node}，需要 20.11 或更新`);
  if (!okNode) {
    console.log(`    怎么办：到 https://nodejs.org 装一个新版；如果用的是发布包，${BAT}会自动用它自带的运行环境。`);
  }
  const w = probeWritable();
  console.log(w.ok
    ? `  ✓ 项目目录可以写：${ROOT_DIR}`
    : `  ✗ 项目目录写不进去：${ROOT_DIR}（${w.error}）`);
  if (!w.ok) console.log('    怎么办：把整个文件夹挪到自己的文档目录再试（Program Files 之类的位置需要管理员权限）。');
  return okNode && w.ok;
}

// ================= ② 自动探测 =================
// 只报「有没有」和「从哪来的、多长」——密钥本身一个字符都不打印。

function detectCodex(cfg) {
  const p = path.join(cfg.codexHome, 'auth.json');
  if (!fs.existsSync(p)) return { found: false, note: '没找到登录信息（要先去 Codex 桌面端登录一次）' };
  try {
    readCodexAuth(cfg.codexHome);
    return { found: true, note: '已检测到本机 Codex 登录信息' };
  } catch {
    return { found: false, note: '登录信息不完整（去 Codex 桌面端登录一次）' };
  }
}

function detectKey(name, cfg) {
  try {
    const { key, source } = resolveApiKey(name, cfg);
    return { found: true, source, length: key.length, note: `已找到密钥（来源：${sourceLabel(source)}，长度 ${key.length}）` };
  } catch (e) {
    if (e?.code === 'NO_KEY') {
      const broken = /解析失败/.test(String(e?.message ?? ''));
      return { found: false, note: broken ? '密钥文件坏了、读不出来（下一步会让你重新填）' : '没找到密钥' };
    }
    return { found: false, note: `密钥读取出错：${friendlyError(e?.message ?? e)}` };
  }
}

function detectAll(cfg) {
  const d = { codex: detectCodex(cfg), deepseek: detectKey('deepseek', cfg), glm: detectKey('glm', cfg) };
  for (const n of ORDER) console.log(`  ${d[n].found ? '✓' : '·'} ${LABEL[n]}：${d[n].note}`);
  if (!ORDER.some(n => d[n].found)) console.log('  （一家都没探测到：别急，下一步可以手动选，密钥随时能补。）');
  return d;
}

// ================= ③ 选平台 =================

function printPlatformTable(sel, detections) {
  for (const [i, n] of ORDER.entries()) {
    console.log(`  [${i + 1}] ${sel[n] ? '开启' : '关闭'}   ${LABEL[n].padEnd(9)}${detections[n].note}`);
  }
}

async function choosePlatforms(detections, userCfg) {
  const sel = {};
  for (const n of ORDER) {
    const explicit = explicitPlatform(userCfg, n);          // 以前选过的，尊重原选择（重跑时不会被改回去）
    sel[n] = explicit === undefined ? detections[n].found : explicit;
  }
  console.log('  当前建议（能探测到的就建议开启）：');
  printPlatformTable(sel, detections);
  for (;;) {
    const ans = (await prompter.ask('\n  直接回车 = 就用上面的建议；想改哪家，输入它的编号（多个用空格隔开）再回车：')) ?? '';
    if (!ans) break;
    const idx = [...new Set((ans.match(/\d/g) ?? []))].map(Number).filter(i => i >= 1 && i <= ORDER.length);
    if (!idx.length) {
      console.log('  （没看懂：想切换哪家就输入它的编号，比如只切第 2 家就输入 2，同时切两家就输入 1 3）');
      continue;
    }
    for (const i of idx) sel[ORDER[i - 1]] = !sel[ORDER[i - 1]];
    console.log('');
    printPlatformTable(sel, detections);
  }
  return sel;
}

// ================= ④ 只问缺的 =================

async function askMissingKeys(sel, detections) {
  const keys = {};
  const need = ORDER.filter(n => sel[n] && !detections[n].found);
  if (!need.length) {
    console.log('  要开启的平台都已经有密钥了，这一步跳过。');
    return keys;
  }
  console.log('  要开启、但还没找到密钥的平台，现在补一下（直接回车 = 先跳过，之后随时能补）：');
  for (const n of need) {
    if (!KEYED.includes(n)) {
      console.log(`\n  · ${LABEL[n]} 不用填密钥：它读的是你自己在 Codex 桌面端的登录状态。`);
      console.log(`    现在没登录，所以暂时采不到；想用它就先登录一次，再${RETRY}。`);
      continue;
    }
    console.log(`\n  把 ${LABEL[n]} 的密钥粘贴进来，然后按回车（粘贴时屏幕上不会显示，这是正常的）：`);
    const key = ((await prompter.askHidden('  > ')) ?? '').trim();
    if (!key) {
      console.log(`  已跳过 ${LABEL[n]}：它会显示成「未配置」，不影响别的平台。`);
      continue;
    }
    keys[n] = key;
    console.log(`  收到 ${LABEL[n]} 的密钥（长度 ${key.length}；不会显示、不会写进日志）。`);
    if (key.length < 8 || /\s/.test(key)) {
      console.log(`  这个看着不太像密钥 —— 先存下了；万一试采失败，再${RETRY}重贴一次。`);
    }
  }
  return keys;
}

// ================= ⑤ 保存设置 =================

function saveSettings(sel, keys) {
  const notes = [];
  const user = readJsonFile(CONFIG_FILE);
  if (user.broken) {
    notes.push(stashBroken(CONFIG_FILE)
      ? '原来的配置文件读不出来（格式坏了），已留底到 data 目录，这次重新写一份干净的'
      : '原来的配置文件读不出来（格式坏了），这次覆盖成新的');
  }
  const next = { ...user.data };
  next.platforms = { ...(next.platforms && typeof next.platforms === 'object' ? next.platforms : {}), ...sel };
  writeJsonAtomic(CONFIG_FILE, next);

  // 写完立刻回读确认：说的和存的一致才算数
  const after = loadConfig();
  const mismatch = ORDER.filter(n => platformEnabled(after, n) !== sel[n]);
  if (mismatch.length) throw new Error(`平台开关没写进去：${mismatch.map(n => LABEL[n]).join('、')}`);
  notes.push(`平台开关：${ORDER.map(n => `${LABEL[n]} ${sel[n] ? '开' : '关'}`).join(' · ')}`);

  const names = Object.keys(keys);
  if (names.length) {
    const sec = readJsonFile(SECRETS_FILE);
    if (sec.broken) {
      notes.push(stashBroken(SECRETS_FILE)
        ? '原来的密钥文件读不出来（格式坏了），已留底到 data 目录，这次重新写一份干净的'
        : '原来的密钥文件读不出来（格式坏了），这次覆盖成新的');
    }
    writeSecrets({ ...sec.data, ...keys });
    const back = readJsonFile(SECRETS_FILE);
    for (const n of names) if (back.data[n] !== keys[n]) throw new Error(`${LABEL[n]} 的密钥没存进去`);
    notes.push(`密钥已存好：${names.map(n => LABEL[n]).join('、')}（只存在本机，不会上传、不会跟着仓库公开）`);
  } else {
    notes.push('这次不用填新密钥');
  }
  for (const n of notes) console.log(`  ✓ ${n}`);
}

// ================= ⑥ 安装 + 试采 =================

function runInstaller() {
  const script = path.join(import.meta.dirname, 'install.mjs');
  console.log(`  （会注册后台采集任务、桌面快捷方式、托盘图标；装完就不用管了）\n`);
  execFileSync(NODE, [script, '--skip-verify'], { stdio: 'inherit', timeout: 300000 });
}

// 刚填的密钥被服务端拒了（401/403）→ 问一次要不要重贴；只问这一种情况，网络类故障重贴也没用
// 注意：这一步必须发生在「打印报告」之前——先把可能的问题修掉，最后只看到一份干净的结论。
async function maybeFixBadKeys(summary, keys) {
  const bad = summary.results.filter(r => r.level === 'failed' && keys[r.name] && isAuthFailure(r.rawFull ?? ''));
  if (!bad.length) return summary;
  let retried = false;
  for (const r of bad) {
    console.log('');
    if (!(await confirm(`  ${LABEL[r.name]} 的密钥没通过验证。现在重新粘贴一次吗？`))) continue;
    const key = ((await prompter.askHidden(`  把 ${LABEL[r.name]} 的密钥重新粘贴进来：`)) ?? '').trim();
    if (!key) {
      console.log(`  好，先这样 —— 之后${RETRY}随时能补。`);
      continue;
    }
    writeSecrets({ ...readJsonFile(SECRETS_FILE).data, [r.name]: key });
    console.log(`  已更新（长度 ${key.length}）。`);
    retried = true;
  }
  if (!retried) return summary;
  console.log('\n  再试采一次…');
  return runFirstRunCheck({ silent: true });
}

// ================= 主流程 =================

console.log('========================================');
console.log('  AI 能力看板 · 首次配置');
console.log('========================================');
console.log('这个向导会带你走六步：自检 → 探测 → 选平台 → 填密钥 → 保存 → 装进系统并试采一次。');
console.log('每一步都能直接回车；随时按 Ctrl+C 可以退出，设置不会留下半截。');

step(1, '环境自检');
if (!checkEnvironment()) {
  console.log('\n环境不满足，先不上手改配置。按上面的提示处理完，再双击一次' + BAT + '。');
  prompter.close();
  process.exit(1);
}

const cfg = loadConfig();

step(2, '自动探测本机已有的能力');
const detections = detectAll(cfg);

step(3, '选要看的平台');
const selection = await choosePlatforms(detections, readJsonFile(CONFIG_FILE).data);

step(4, '填密钥（只问缺的）');
const newKeys = await askMissingKeys(selection, detections);

step(5, '保存设置');
try {
  saveSettings(selection, newKeys);
  saved = true;
} catch (e) {
  console.log(`  ✗ 保存失败：${friendlyError(e?.message ?? e)}`);
  console.log(`    文件不会写成半截（要么没动过，要么是完整的一份）。再双击一次${BAT}试试。`);
  prompter.close();
  process.exit(1);
}

step(6, '装进系统 + 试采一次');
if (SKIP_INSTALL) {
  console.log('  （本次带 --no-install：跳过注册后台任务 / 快捷方式 / 托盘）');
} else {
  try {
    runInstaller();
  } catch {
    console.log('  ⚠ 安装这一步没能全部完成（上面有 ❌ 就看那几行）。');
    console.log('    不影响这次保存的设置，之后双击「安装定时任务.bat」重试即可。');
  }
}

console.log('\n—— 试采一次，确认真能采到数据 ——');
console.log('  正在试采一次（要联网，最多十几秒）…');
// 先静默采集：可能有「密钥填错了」要当场重填，修完再一次性把结论打出来（用户只看一份报告）
let summary = await runFirstRunCheck({ silent: true });
summary = await maybeFixBadKeys(summary, newKeys);
console.log('');
printReport(summary);
console.log(`（想改设置 / 补密钥：随时重新双击${BAT}）`);

prompter.close();
// 退出码只表示「向导本身跑完了没有」：缺密钥 / 某个平台没采到属于「结果待处理」，
// 上面已经把下一步写清楚了；用非 0 退出会让「首次配置.bat」再报一次「未完成」，反而误导用户。
process.exitCode = 0;
