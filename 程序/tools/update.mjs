import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { repositories, compareVersions, validateManifest, fetchBounded, verifyInstaller, writeUpdateState, readUpdateState, atomicJson } from '../lib/updates.mjs';
import { ROOT_DIR } from '../lib/common.mjs';
import { powershell, psQuote } from './windows-integration.mjs';

const ROOT = ROOT_DIR;                       // 项目根（VERSION / data / update-data.js 都在那一层）
const SELF = fileURLToPath(import.meta.url);  // 本文件自己的路径（「安装监看」要再跑一遍它）
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
// 每一步失败都有自己的文案（用户要能分清「没下载成」「包坏了」「没装成」）：
// 这几句是固定串，同时是 catch 的白名单 —— 网络/库的错误文本里可能带请求细节，不能进状态文件。
const DOWNLOAD_FAILED = '下载没成功，看板还是原来的版本，请稍后重试';
const VERIFY_FAILED = '安装包校验失败，已停止安装，看板还是原来的版本';
const INSTALL_FAILED = '更新没装成，看板还是原来的版本';
const INSTALL_CANCELLED = '安装被取消了，看板还是原来的版本';
// Inno Setup 的退出码（文档口径；本机验证用的是桩安装器，没真装过）：
// 1602 = 用户按了取消；1223 = 被系统/权限拦下取消；其余非 0 都归到「更新没装成」。
const CANCELLED_CODES = [1602, 1223];
const WATCH_WAIT_MS = 2500;                  // 交接后给页面自己关掉的时间（页面每 1.5 秒读一次状态）

// now 是「本次操作的时间戳」，不是时钟函数：默认值要现取（写成 Date.now 会让 updatedAt / 限频时间全落空）。
export async function runUpdate(action = 'auto', { root = ROOT, fetcher = fetch, launch = launchInstaller, now = Date.now() } = {}) {
  if (fs.existsSync(path.join(root, '.git'))) return { phase: 'development', available: false, automatic: false, message: '开发目录不自动升级，请使用独立安装版。' };
  if (!['auto', 'check', 'install', 'skip', 'auto-on', 'auto-off', 'notify-on', 'notify-off', 'status'].includes(action)) throw new Error('未知更新操作');
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const lock = path.join(data, 'update.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, String(process.pid)); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); return; } catch (err) { if (err.code !== 'ESRCH') return; } }
    fs.unlinkSync(lock);
    return runUpdate(action, { root, fetcher, now });
  }
  const file = path.join(data, 'update-status.json');
  const prefsFile = path.join(data, 'update-preferences.json');
  // 默认值 = 「每天自动检查更新」默认不勾选（用户 2026-09-17 定）；改过这个开关的用户值存在 update-preferences.json 里，不受影响
  const prefs = read(prefsFile, { automatic: false, notifications: true });
  // 「已跳过的版本」（用户 2026-09-17 定：检测到新版本时只保留「跳过该版本」）。
  // 与两个开关同住一个偏好文件：这里是「用户对更新的选择」唯一的住处，整个 data/ 又随备份与升级保留，不另开文件。
  const skippedVersion = typeof prefs.skippedVersion === 'string' ? prefs.skippedVersion : null;
  // 渠道地址住在程序目录里（曾经在 release/，但那个目录是构建机专用的，不能随包发给用户）：
  // 它与 发布清单里的 程序/channels.json 是同一个文件，构建器最新的 latest.json 也读它。
  const channels = read(path.join(root, '程序', 'channels.json'), {});
  const currentVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const state = { ...read(file, {}), currentVersion, automatic: prefs.automatic !== false,
    notifications: prefs.notifications !== false, channels, skippedVersion, operation: action };
  const isNewer = m => !!m && compareVersions(m.version, currentVersion) > 0;
  // 「跳过之后」的状态文案只有这一处：缓存态、跳过动作、检查结果三个分支共用，改措辞不会漏改
  const skippedMessage = v => `已跳过 v${v}；发布更新的版本时会再提示`;
  // 状态的写口只有一个（lib/updates.mjs 的 writeUpdateState）：真源 data/update-status.json
  // 加页面读的 update-data.js。下载进度、安装收尾与这里写的都是同一份。
  const save = () => { state.updatedAt = now; writeUpdateState(root, state); };
  try {
    const repos = repositories(channels);
    if (state.manifest) {
      try { state.manifest = validateManifest(state.manifest, repos); } catch { delete state.manifest; }
    }
    // available 的语义是「要不要提示用户」：比当前版本新，且不是用户已经跳过的那个版本。
    // 看板横幅与托盘提示都只看 available，所以跳过之后两边一起安静，不必各自再加一遍判断。
    state.available = isNewer(state.manifest) && state.manifest.version !== skippedVersion;
    if (!state.available) {
      // 跳过的版本还留在缓存里 —— 状态行要说清「是跳过了」，不能显示成「已是最新版本」
      if (isNewer(state.manifest)) { state.phase = 'skipped'; state.message = skippedMessage(state.manifest.version); }
      else { state.phase = 'idle'; state.message = '当前版本已就绪'; }
    }
    if (action.startsWith('auto-') || action.startsWith('notify-')) {
      prefs[action.startsWith('auto-') ? 'automatic' : 'notifications'] = action.endsWith('-on');
      atomicJson(prefsFile, prefs);
      state.automatic = prefs.automatic !== false; state.notifications = prefs.notifications !== false;
    } else if (action === 'skip') {
      // 「跳过该版本」：记下版本号，同一版本此后不再提示；发布更新的版本时照常提示（available 按版本比较）。
      // 动作名三处同名：看板 assets/support.js → 协议白名单（程序/运行协议.vbs 的固定动作表）→ 这里；改名要三处一起改。
      if (!isNewer(state.manifest)) throw new Error('请先检查更新');
      prefs.skippedVersion = state.manifest.version;
      atomicJson(prefsFile, prefs);
      state.skippedVersion = prefs.skippedVersion;
      state.available = false; state.phase = 'skipped';
      state.message = skippedMessage(state.manifest.version);
    } else if (action === 'install') {
      // 「立即更新」：下载（带进度）→ 校验 → 交给「安装监看」（install-watch）跑安装器并收尾。
      // 动作名三处同名：看板 assets/support.js → 协议白名单（程序/运行协议.vbs 的固定动作表）→ 这里；改名要三处一起改。
      // 判据是「缓存的 manifest 比当前版本新」而不是 available：用户点过「跳过该版本」之后 available 会变 false
      // （那是「要不要主动提示」的意思），但他在帮助与反馈里主动点「立即更新」就是改主意了，得真的装上。
      if (!isNewer(state.manifest)) throw new Error('请先检查更新');
      const exe = await downloadInstaller(state, { root, fetcher, save });
      state.phase = 'installing'; state.message = '正在安装，看板会关闭后自动打开'; delete state.progress; save();
      await launch(exe, root, state.manifest.version);
    } else if (action === 'check' || action === 'auto') {
      const interval = action === 'auto' ? 24 * 3600000 : 30000;
      if ((action === 'auto' && !state.automatic) || (state.checkedAt && now - state.checkedAt < interval)) { save(); return state; }
      state.checkedAt = now; state.phase = 'checking'; state.message = '正在检查新版本…'; save();
      let manifest;
      for (const repo of repos) {
        try {
          const bytes = await fetchBounded(`${repo}/releases/latest/download/latest.json`, 64 * 1024, { fetcher });
          manifest = validateManifest(JSON.parse(bytes.toString('utf8')), repos); break;
        } catch { /* Try the next configured public mirror. */ }
      }
      if (!manifest) throw new Error('暂时无法获取更新，可能尚未发布新版本；当前功能不受影响');
      state.manifest = manifest;
      const newer = compareVersions(manifest.version, currentVersion) > 0;
      const skipped = newer && manifest.version === skippedVersion;
      state.available = newer && !skipped;
      state.phase = state.available ? 'available' : (skipped ? 'skipped' : 'current');
      state.message = state.available ? `发现新版本 v${manifest.version}`
        : skipped ? skippedMessage(manifest.version) : `已是最新版本 v${currentVersion}`;
    }
    save();
    return state;
  } catch (e) {
    state.phase = 'error';
    // Fixed messages only: network/library errors can embed request details.
    state.message = ['请先检查更新', DOWNLOAD_FAILED, VERIFY_FAILED, '暂时无法获取更新，可能尚未发布新版本；当前功能不受影响'].includes(e.message)
      ? e.message : '更新暂时未完成，当前版本可继续使用，请稍后重试';
    save(); return state;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

// ── 「立即更新」的执行端：下载 → 校验 → 交接安装监看 → 收尾重开看板 ──────────────

// 下载 + 校验 + 落盘。进度一路写进状态文件，页面轮询 update-data.js 就能看到百分比 ——
// 这就是这条链路的反馈通路（项目既有的「文件即信道」），不另开协议、也不让页面去猜。
// 镜像按 latest.json 的顺序试：下不动换下一个，包坏了也换下一个；只有哈希对得上的字节才落盘。
async function downloadInstaller(state, { root, fetcher, save }) {
  const manifest = state.manifest;
  const folder = path.join(root, 'data', 'updates');
  fs.mkdirSync(folder, { recursive: true });
  const exe = path.join(folder, `setup-${manifest.version}.exe`);
  pruneUpdates(folder, path.basename(exe));
  state.phase = 'downloading';
  state.message = '正在下载安装包…';
  state.progress = { received: 0, total: manifest.size, percent: 0 };
  save();
  let lastPercent = -1;
  const onProgress = ({ received, total }) => {
    const percent = total > 0 ? Math.min(99, Math.floor(received * 100 / total)) : 0;
    if (percent === lastPercent) return;            // 进度每变 1% 写一次（页面 1.5 秒读一次，写更勤没意义）
    lastPercent = percent;
    state.progress = { received, total, percent };
    state.message = `正在下载安装包… ${percent}%`;
    save();
  };
  let bytes = null, verifyFailed = false;
  for (const url of manifest.urls) {
    let chunk;
    try { chunk = await fetchBounded(url, manifest.size, { fetcher, timeout: 180000, onProgress }); }
    catch { continue; }                             // 这个镜像下不动：换下一个，最后统一报「没下载成」
    try { verifyInstaller(chunk, manifest); bytes = chunk; break; }
    catch { verifyFailed = true; }                  // 下到了但哈希/长度不对：换下一个镜像再试
  }
  // 拿到过字节但哈希对不上 = 包的问题；压根没下下来 = 网络的问题。两句话分开说，用户才知道要不要重试。
  if (!bytes) throw new Error(verifyFailed ? VERIFY_FAILED : DOWNLOAD_FAILED);
  fs.writeFileSync(`${exe}.part`, bytes); fs.renameSync(`${exe}.part`, exe);   // 只有校验过的字节才落盘
  return exe;
}

// 更新目录里的东西都是可再生的（安装包、监看进程用的 Exe 副本）：新一次安装开始前清掉上一版留下的。
// 正在被别的进程占着而删不掉的忽略 —— 下次安装还会再试。
function pruneUpdates(folder, keep) {
  for (const name of fs.readdirSync(folder)) {
    if (name === keep || !/^(setup-.*\.exe|setup-.*\.exe\.part|board-update-.*\.exe)$/.test(name)) continue;
    try { fs.unlinkSync(path.join(folder, name)); } catch { }
  }
}

// 交接：安装器要覆盖 runtime\node.exe，而这个更新进程自己就跑在它上面 ——
// Windows 上正在运行的 exe 换不掉，硬换的后果是「装了一半、等重启」，用户明确不接受。
// 所以先把 node 复制一份到 data/updates 下，用副本起「安装监看」，本进程随即退出：
// 监看进程从头到尾不碰被覆盖的文件，能一直等到安装结束。
function launchInstaller(exe, root, version) {
  const runtime = path.join(root, 'runtime', 'node.exe');
  const watcher = path.join(root, 'data', 'updates', `board-update-${process.pid}.exe`);
  fs.copyFileSync(fs.existsSync(runtime) ? runtime : process.execPath, watcher);
  const child = spawn(watcher, [SELF, 'install-watch', root, exe, version],
    { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

// 安装监看（install-watch）：交接出去的第二步 —— 等看板页面关掉 → 跑安装器 → 收尾写状态、重开看板。
// 放在同一个文件里而不是新开一个：发布层是逐文件白名单（release/publish-files.mjs），
// 新文件不进清单就不会随包发给用户，装上以后这一步就断了。
// 参数只有 update.mjs 自己会给（协议白名单里没有 install-watch，浏览器到不了这条路径）。
export async function watchInstall(root, exe, version, { spawnImpl = spawn, sleep = ms => new Promise(r => setTimeout(r, ms)), open = openBoard } = {}) {
  await sleep(WATCH_WAIT_MS);
  let code = -1;
  try { code = await runInstaller(exe, root, spawnImpl); } catch { code = -1; }      // 起不来也算没装成
  const done = code === 0;
  const before = readUpdateState(root);
  // 版本号从 VERSION 现读：安装器已经把它换成新版本了，页面靠 currentVersion 判断「还有没有更新的版本」
  // （装完还留着旧值，帮助与反馈就会继续弹「立即更新」）
  const state = { ...before, currentVersion: installedVersion(root, before.currentVersion), phase: done ? 'installed' : 'error',
    message: done ? `已更新到 v${version}` : (CANCELLED_CODES.includes(code) ? INSTALL_CANCELLED : INSTALL_FAILED),
    installerExit: code, updatedAt: Date.now() };
  delete state.progress;
  if (done) state.available = false;             // 装的就是这个版本，不必再提示
  writeUpdateState(root, state);
  try { await open(root); } catch { /* 打不开看板不算更新失败：版本已经装好了 */ }
  return { code, done, message: state.message };
}

// /SILENT：显示安装进度窗口、不问任何问题（/VERYSILENT 是全黑箱，用户看不到进度，明确不要它）。
// /NORESTART 不弹重启提示；/SP- 不问「是否继续」；/DIR 指到当前目录 —— 升级是原地覆盖，不另装一份。
function runInstaller(exe, root, spawnImpl) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(exe, ['/SILENT', '/NORESTART', '/SP-', `/DIR=${root}`], { stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? -1));
  });
}

// 安装目录里的 VERSION 是版本号的唯一事实源：装完现读一次（读不到就退回状态文件里那个旧值）。
function installedVersion(root, fallback) {
  try { return fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() || fallback; } catch { return fallback; }
}

// 装完把看板打开：走项目既有的打开方式（PowerShell Start-Process，与 launch.mjs 开看板同一招），
// 落在「帮助与反馈」上（#support，托盘菜单的「检查更新」也是这么开的）—— 用户一眼看到更新结果。
// 命令单独拼出来（openCommand）是为了能被测试逐字断言：真跑一次会真开一个浏览器窗口。
export function openCommand(root) {
  return `Start-Process ${psQuote(`${pathToFileURL(path.join(root, 'dashboard.html')).href}#support`)}`;
}

export function openBoard(root) {
  powershell(openCommand(root));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , action, ...rest] = process.argv;
  const job = action === 'install-watch' ? watchInstall(rest[0], rest[1], rest[2]) : runUpdate(action);
  job.catch(() => { console.error('更新操作未完成，请稍后重试'); process.exitCode = 1; });
}
