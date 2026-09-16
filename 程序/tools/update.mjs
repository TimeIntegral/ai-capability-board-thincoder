import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { repositories, compareVersions, validateManifest, fetchBounded, verifyInstaller, atomicJson } from '../lib/updates.mjs';
import { ROOT_DIR } from '../lib/common.mjs';

const ROOT = ROOT_DIR;                       // 项目根（VERSION / data / update-data.js 都在那一层）
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };

export async function runUpdate(action = 'auto', { root = ROOT, fetcher = fetch, launch = launchInstaller, now = Date.now() } = {}) {
  if (fs.existsSync(path.join(root, '.git'))) return { phase: 'development', available: false, automatic: false, message: '开发目录不自动升级，请使用独立安装版。' };
  if (!['auto', 'check', 'install', 'later', 'auto-on', 'auto-off', 'notify-on', 'notify-off', 'status'].includes(action)) throw new Error('未知更新操作');
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
    return runUpdate(action, { root, fetcher, launch, now });
  }
  const file = path.join(data, 'update-status.json');
  const prefsFile = path.join(data, 'update-preferences.json');
  const prefs = read(prefsFile, { automatic: true, notifications: true });
  const channels = read(path.join(root, 'release/channels.json'), {});
  const currentVersion = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  const state = { ...read(file, {}), currentVersion, automatic: prefs.automatic !== false,
    notifications: prefs.notifications !== false, channels, operation: action };
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
    state.available = !!state.manifest && compareVersions(state.manifest.version, currentVersion) > 0;
    if (!state.available) { state.phase = 'idle'; state.message = '当前版本已就绪'; }
    if (action.startsWith('auto-') || action.startsWith('notify-')) {
      prefs[action.startsWith('auto-') ? 'automatic' : 'notifications'] = action.endsWith('-on');
      atomicJson(prefsFile, prefs);
      state.automatic = prefs.automatic !== false; state.notifications = prefs.notifications !== false;
    } else if (action === 'later') {
      state.snoozeUntil = now + 24 * 3600000;
    } else if (action === 'install') {
      if (!state.available) throw new Error('请先检查更新');
      state.phase = 'downloading'; state.message = '正在下载安装包，请稍候…'; save();
      let bytes;
      for (const url of state.manifest.urls) {
        try { bytes = await fetchBounded(url, state.manifest.size, { fetcher, timeout: 180000 }); verifyInstaller(bytes, state.manifest); break; }
        catch { bytes = null; }
      }
      if (!bytes) throw new Error('下载或校验失败，原版本可继续使用，请稍后重试');
      const folder = path.join(data, 'updates'); fs.mkdirSync(folder, { recursive: true });
      const exe = path.join(folder, `setup-${state.manifest.version}.exe`);
      fs.writeFileSync(`${exe}.part`, bytes); fs.renameSync(`${exe}.part`, exe);
      state.phase = 'ready'; state.message = '安装包已校验，正在打开升级向导'; save();
      await launch(exe, root);
      state.phase = 'installer-open'; state.message = '请在升级向导中完成安装；取消后仍可继续使用原版本';
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
      state.available = compareVersions(manifest.version, currentVersion) > 0;
      state.phase = state.available ? 'available' : 'current';
      state.message = state.available ? `发现新版本 v${manifest.version}` : `已是最新版本 v${currentVersion}`;
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

function launchInstaller(exe, root) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, ['/SP-', '/NORESTART', `/DIR=${root}`], { detached: true, stdio: 'ignore', windowsHide: false });
    p.once('error', reject); p.once('spawn', () => { p.unref(); resolve(); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runUpdate(process.argv[2]).catch(() => { console.error('更新操作未完成，请稍后重试'); process.exitCode = 1; });
}
