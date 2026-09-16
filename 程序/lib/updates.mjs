import fs from 'node:fs';
import path from 'node:path';

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
export async function fetchBounded(url, limit, { fetcher = fetch, timeout = 12000 } = {}) {
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
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('下载内容超过大小限制');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error('下载跳转次数过多');
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
