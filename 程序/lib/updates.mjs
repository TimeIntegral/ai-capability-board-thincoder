import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function compareVersions(a, b) {
  const parse = v => {
    if (typeof v !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(v)) throw new Error('版本格式不正确');
    return v.split('.').map(Number);
  };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return Math.sign(x[i] - y[i]);
  return 0;
}

export function repositories(channels) {
  return ['gitee', 'github'].flatMap(name => {
    const value = channels[name];
    if (!value) return [];
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.hostname !== `${name}.com` || u.port || u.username || u.password ||
        u.search || u.hash || !/^\/[\w.-]+\/[\w.-]+\/?$/.test(u.pathname)) throw new Error('发布渠道地址不正确');
    return [u.href.replace(/\/$/, '')];
  });
}

export function allowedUrl(value, repos) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash ||
      !repos.some(repo => u.href.startsWith(`${repo}/releases/`))) throw new Error('下载地址不属于本项目发布渠道');
  return u.href;
}

export function validateManifest(m, repos) {
  if (!m || m.schema !== 1) throw new Error('更新说明格式不支持');
  compareVersions(m.version, '0.0.0');
  if (!/^[a-f0-9]{64}$/.test(m.sha256) || !Number.isSafeInteger(m.size) || m.size < 1024 || m.size > 180 * 1024 * 1024) throw new Error('安装包校验信息不完整');
  const urls = (Array.isArray(m.urls) ? m.urls : []).map(u => allowedUrl(u, repos));
  if (!urls.length || urls.length > 4 || !urls.every(u => new URL(u).pathname.endsWith('.exe'))) throw new Error('安装包地址不正确');
  return { schema: 1, version: m.version, sha256: m.sha256, size: m.size, urls,
    notes: String(m.notes ?? '').slice(0, 4000), releaseUrl: allowedUrl(m.releaseUrl, repos) };
}

// Follow only publisher/CDN redirects; never attach a user's account credentials.
// onProgress 每读一块报一次 {received, total}：页面上的下载进度就是靠它一路写进 data/update-status.json
// （total 取 content-length，取不到就用调用方给的 limit —— 安装包的准确大小本来就在 latest.json 里）。
export async function fetchBounded(url, limit, { fetcher = fetch, timeout = 12000, onProgress } = {}) {
  let current = url;
  const signal = AbortSignal.timeout(timeout);
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetcher(current, { redirect: 'manual', signal, credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location'), current);
      const original = new URL(url);
      const trusted = next.hostname === original.hostname ||
        (original.hostname === 'github.com' && (next.hostname === 'release-assets.githubusercontent.com' || next.hostname === 'objects.githubusercontent.com'));
      await response.body?.cancel();
      if (!trusted || next.protocol !== 'https:' || next.port || next.username || next.password) throw new Error('下载跳转地址不受信任');
      current = next.href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 404 ? '尚未发布更新信息' : '暂时无法连接发布渠道'); }
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('下载内容超过大小限制'); }
    const total = Number(response.headers.get('content-length')) || limit;
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('下载内容超过大小限制');
      chunks.push(Buffer.from(chunk));
      onProgress?.({ received: size, total });
    }
    return Buffer.concat(chunks);
  }
  throw new Error('下载跳转次数过多');
}

// 安装包三项一起验：长度、PE 头（MZ）、SHA256。三项都来自 latest.json（只允许本项目发布渠道的 HTTPS 地址），
// 任何一项不符都拒绝安装 —— 校验不过的字节既不落盘也不交给安装器（不留「下了一半/装了一半」的状态）。
export function verifyInstaller(bytes, manifest) {
  if (bytes.length !== manifest.size || bytes[0] !== 0x4d || bytes[1] !== 0x5a ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('安装包校验失败，已停止安装');
}

// 更新状态只有一个写口：data/update-status.json（真源）+ update-data.js（页面用 <script> 读的注入副本）。
// 检查更新、下载安装、安装监看（update.mjs 的 install-watch）三处都走这里 —— 页面只认这一份状态。
export function writeUpdateState(root, state) {
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  atomicJson(path.join(data, 'update-status.json'), state);
  const js = path.join(root, 'update-data.js');
  fs.writeFileSync(`${js}.tmp`, `window.BOARD_UPDATE=${JSON.stringify(state).replace(/</g, '\\u003c')};\n`);
  fs.renameSync(`${js}.tmp`, js);
}

// 读回上一次写下的状态（安装监看进程要在同一份状态上收尾，保留 automatic / notifications / manifest 等字段）。
export function readUpdateState(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'data', 'update-status.json'), 'utf8')); } catch { return {}; }
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
