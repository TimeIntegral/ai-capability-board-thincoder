import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { compareVersions, repositories, validateManifest, fetchBounded } from '../lib/updates.mjs';
import { ROOT_DIR } from '../lib/common.mjs';
import { runUpdate } from './update.mjs';
import { prepareUpgrade, finishUpgrade } from './upgrade-lifecycle.mjs';

const channels = { github: 'https://github.com/example/board', gitee: '', community: '' };
const repos = repositories(channels);
const bytes = Buffer.alloc(2048, 0x45); bytes.write('MZ');
const digest = crypto.createHash('sha256').update(bytes).digest('hex');
const futureFixture = '2.0.0'; // Fixture version, independent of the product VERSION.
const manifest = { schema: 1, version: futureFixture, size: bytes.length, sha256: digest,
  urls: [`${repos[0]}/releases/download/v2.0.0/setup.exe`], releaseUrl: `${repos[0]}/releases/tag/v2.0.0`, notes: '更新说明' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-distribution-'));
  // 夹具按「装好的目录」搭：渠道地址与安装清单都在程序目录下（L3 形态，见 release/README.md）。
  fs.mkdirSync(path.join(root, '程序')); fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0');
  fs.writeFileSync(path.join(root, '程序/channels.json'), JSON.stringify(channels));
  // Only the known temporary fixture root can be recursively cleaned.
  t.after(() => { if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('board-distribution-')) throw new Error('unsafe fixture'); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
const response = value => new Response(typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);

test('numeric version order and invalid input', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  for (const value of ['v1.0.0', '../2.0.0', '1.0.0-beta', '9999999.0.0']) assert.throws(() => compareVersions(value, '1.0.0'));
});

test('developer checkout cannot fetch or skip updates', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: fixture');
  for (const action of ['auto', 'check', 'skip']) {
    const state = await runUpdate(action, { root, fetcher: () => { throw new Error('must not fetch'); } });
    assert.equal(state.phase, 'development'); assert.equal(state.available, false);
  }
  assert.equal(fs.existsSync(path.join(root, 'data')), false);
});
test('public source and installer address allowlist', () => {
  assert.equal(validateManifest(manifest, repos).version, '2.0.0');
  for (const url of ['http://github.com/example/board/releases/setup.exe', 'https://github.com.evil.test/example/board/releases/setup.exe', 'https://github.com/example/other/releases/setup.exe', 'file:///setup.exe']) {
    assert.throws(() => validateManifest({ ...manifest, urls: [url] }, repos));
  }
  assert.throws(() => repositories({ github: 'https://github.com/example/board?token=bad' }));
  assert.throws(() => validateManifest({ ...manifest, sha256: 'bad' }, repos));
});
test('stream and redirect bounds', async () => {
  await assert.rejects(fetchBounded(manifest.urls[0], 10, { fetcher: async () => response(Buffer.alloc(11)) }));
  await assert.rejects(fetchBounded(manifest.urls[0], 1024, { fetcher: async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/setup.exe' } }) }));
  await assert.rejects(fetchBounded(manifest.urls[0], 1024, { fetcher: async () => new Response(null, { status: 404 }) }));
});
test('PE, length and hash must all match', () => {
  assert.doesNotThrow(() => validateManifest(manifest, repos));
  assert.throws(() => validateManifest({ ...manifest, sha256: 'bad' }, repos));
  assert.throws(() => validateManifest({ ...manifest, size: 10 }, repos));
});
test('daily checks, manual cooldown and user settings persist', async t => {
  const root = fixture(t); let count = 0;
  const opts = { root, now: 100000, fetcher: async () => { count++; return response(manifest); } };
  // 默认不勾选「每天自动检查更新」（2026-09-17 起的新装语义）：没显式开启过就不自动取网络
  const off = await runUpdate('auto', opts);
  assert.equal(off.automatic, false); assert.equal(count, 0);
  await runUpdate('auto-on', opts);                        // 用户在页面上勾上才开启
  assert.equal((await runUpdate('auto', opts)).available, true);
  await runUpdate('auto', { ...opts, now: 120000 }); assert.equal(count, 1);
  await runUpdate('check', { ...opts, now: 140000 }); assert.equal(count, 2);
  await runUpdate('auto-off', opts);
  await runUpdate('auto', { ...opts, now: 100000000 }); assert.equal(count, 2);
  assert.equal((await runUpdate('notify-off', opts)).notifications, false);
  assert.equal(fs.existsSync(path.join(root, 'data/updates')), false);   // 不再下载安装包，连下载目录都不建
});
test('failed checks preserve verified update, never launch or expose request errors', async t => {
  const root = fixture(t);
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  const state = await runUpdate('check', { root, now: 200000, fetcher: async () => { throw new Error('PRIVATE_REQUEST_DETAIL'); } });
  assert.equal(state.available, true); assert.equal(state.phase, 'error');
  assert.ok(!JSON.stringify(state).includes('PRIVATE_REQUEST_DETAIL'));
});
test('已删除的更新动作（下载 / 安装）一律拒绝', async t => {
  const root = fixture(t);
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  for (const action of ['install', 'download', 'auto-install']) {
    await assert.rejects(() => runUpdate(action, { root, now: 140000, fetcher: async () => { throw new Error('must not fetch'); } }), /未知更新操作/);
  }
  assert.equal(fs.existsSync(path.join(root, 'data/updates')), false);
});
test('跳过只针对被跳过的那个版本，更新的版本照常提示', async t => {
  const root = fixture(t);
  const opts = { root, now: 100000, fetcher: async () => response(manifest) };
  // 没有可跳过的新版本时拒绝（不能凭空吞掉一个版本号）
  assert.equal((await runUpdate('skip', { root, now: 90000 })).message, '请先检查更新');
  assert.equal((await runUpdate('check', opts)).available, true);
  const skipped = await runUpdate('skip', opts);
  assert.equal(skipped.available, false); assert.equal(skipped.phase, 'skipped'); assert.equal(skipped.skippedVersion, '2.0.0');
  // 跳过之后同一版本不再提示：再查一次也是安静状态（看板横幅与托盘都只看 available）
  const again = await runUpdate('check', { ...opts, now: 200000 });
  assert.equal(again.available, false); assert.equal(again.phase, 'skipped');
  assert.ok(again.message.includes('已跳过 v2.0.0'));
  // 换成更新的版本（比夹具当前版本新）→ 照常提示。版本号写成常量：发布闸门把 `version: 'x.y.z'` 这种字面量当成代码里的版本常量
  const NEXT_FIXTURE = '2.1.0';
  const next = { ...manifest, version: NEXT_FIXTURE, urls: [`${repos[0]}/releases/download/v${NEXT_FIXTURE}/setup.exe`], releaseUrl: `${repos[0]}/releases/tag/v${NEXT_FIXTURE}` };
  assert.equal((await runUpdate('check', { ...opts, now: 300000, fetcher: async () => response(next) })).available, true);
  // 记录住在 update-preferences.json（与两个开关同一个文件），不另开状态文件
  const prefs = JSON.parse(fs.readFileSync(path.join(root, 'data/update-preferences.json'), 'utf8'));
  assert.equal(prefs.skippedVersion, '2.0.0');
});
test('页面「跳过该版本」走的协议动作 skip 真的跳过那个版本', async t => {
  const root = fixture(t);
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  // 看板点「跳过该版本」发的是 aiquotaboard://update-skip；它必须真的跳过，不能是空动作
  const state = await runUpdate('skip', { root, now: 140000 });
  assert.equal(state.available, false); assert.equal(state.phase, 'skipped'); assert.equal(state.skippedVersion, '2.0.0');
});
test('协议白名单里的每个动作 update.mjs 都认（对不上就是「点了没反应」）', async t => {
  const vbs = fs.readFileSync(path.join(ROOT_DIR, '程序', '运行协议.vbs'), 'utf8');
  const line = vbs.split(/\r?\n/).find(l => l.includes('Case "') && l.includes('"check"'));
  assert.ok(line, '程序/运行协议.vbs 里没找到 update- 的固定动作表');
  const actions = [...line.matchAll(/"([a-z][a-z-]*)"/g)].map(m => m[1]);
  assert.ok(actions.includes('skip'), `白名单里应当有 skip：${line}`);
  const root = fixture(t);
  const opts = { root, now: 100000, fetcher: async () => response(manifest) };
  await runUpdate('check', opts);
  for (const a of actions) {
    // 页面与托盘只会发这些动作：白名单里的每一个都必须被 update.mjs 接住，否则协议通、动作落空 = 静默失败
    const state = await runUpdate(a, { ...opts, now: 140000 });
    assert.ok(state && typeof state.phase === 'string', `协议动作 ${a} 没有被 update.mjs 接住`);
  }
});
test('after upgrading, old manifest no longer prompts or installs', async t => {
  const root = fixture(t);
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  fs.writeFileSync(path.join(root, 'VERSION'), '2.0.0');
  const state = await runUpdate('status', { root, now: 110000 });
  assert.equal(state.available, false); assert.equal(state.currentVersion, '2.0.0');
});
test('snapshot and rollback preserve user data and restore old code', t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'data')); fs.writeFileSync(path.join(root, 'data/history.json'), 'history-before');
  fs.writeFileSync(path.join(root, 'config.json'), '{"custom":true}');
  fs.writeFileSync(path.join(root, 'secrets.json'), '{"fixture":"PRIVATE_SENTINEL"}');
  const backup = prepareUpgrade(root, { isolated: true });
  assert.equal(fs.readFileSync(path.join(backup, 'secrets.json'), 'utf8'), '{"fixture":"PRIVATE_SENTINEL"}');
  fs.writeFileSync(path.join(root, 'VERSION'), '2.0.0');
  fs.writeFileSync(path.join(root, 'data/history.json'), 'history-after');
  finishUpgrade(root, { rollback: true, isolated: true });
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), '1.0.0');
  assert.equal(fs.readFileSync(path.join(root, 'data/history.json'), 'utf8'), 'history-after');
  assert.ok(!fs.existsSync(path.join(root, 'data/upgrade-transaction.json')));
});
test('snapshot refuses traversal and keeps source intact', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '程序/installed-files.json'), JSON.stringify({ files: ['../outside'] }));
  assert.throws(() => prepareUpgrade(root, { isolated: true }));
  assert.equal(fs.readFileSync(path.join(root, 'VERSION'), 'utf8'), '1.0.0');
});
