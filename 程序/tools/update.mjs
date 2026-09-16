import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { repositories, compareVersions, validateManifest, fetchBounded, atomicJson } from '../lib/updates.mjs';
import { ROOT_DIR } from '../lib/common.mjs';

const ROOT = ROOT_DIR;                       // 项目根（VERSION / data / update-data.js 都在那一层）
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export async function runUpdate(action = 'auto', { root = ROOT, fetcher = fetch, now = Date.now() } = {}) {
  if (fs.existsSync(path.join(root, '.git'))) return { phase: 'development', available: false, automatic: false, message: '开发目录不自动升级，请使用独立安装版。' };
  if (!['auto', 'check', 'skip', 'auto-on', 'auto-off', 'notify-on', 'notify-off', 'status'].includes(action)) throw new Error('未知更新操作');
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
  const save = () => {
    state.updatedAt = now;
    atomicJson(file, state);
    const js = path.join(root, 'update-data.js');
    fs.writeFileSync(`${js}.tmp`, `window.BOARD_UPDATE=${JSON.stringify(state).replace(/</g, '\\u003c')};\n`);
    fs.renameSync(`${js}.tmp`, js);
  };
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
    state.message = ['请先检查更新', '下载或校验失败，原版本可继续使用，请稍后重试', '暂时无法获取更新，可能尚未发布新版本；当前功能不受影响'].includes(e.message)
      ? e.message : '更新暂时未完成，当前版本可继续使用，请稍后重试';
    save(); return state;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runUpdate(process.argv[2]).catch(() => { console.error('更新操作未完成，请稍后重试'); process.exitCode = 1; });
}
