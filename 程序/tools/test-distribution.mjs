import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { compareVersions, repositories, validateManifest, fetchBounded, verifyInstaller } from '../lib/updates.mjs';
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

test('developer checkout cannot fetch or install updates', async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.git'), 'gitdir: fixture');
  for (const action of ['auto', 'check', 'install']) {
    const state = await runUpdate(action, { root, fetcher: () => { throw new Error('must not fetch'); }, launch: () => { throw new Error('must not launch'); } });
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
  assert.doesNotThrow(() => verifyInstaller(bytes, manifest));
  const corrupt = Buffer.from(bytes); corrupt[100]++;
  assert.throws(() => verifyInstaller(corrupt, manifest));
  assert.throws(() => verifyInstaller(bytes.subarray(0, 100), manifest));
});
test('daily checks, manual cooldown and user settings persist', async t => {
  const root = fixture(t); let count = 0;
  const opts = { root, now: 100000, fetcher: async () => { count++; return response(manifest); } };
  assert.equal((await runUpdate('auto', opts)).available, true);
  await runUpdate('auto', { ...opts, now: 120000 }); assert.equal(count, 1);
  await runUpdate('check', { ...opts, now: 140000 }); assert.equal(count, 2);
  await runUpdate('auto-off', opts);
  await runUpdate('auto', { ...opts, now: 100000000 }); assert.equal(count, 2);
  assert.equal((await runUpdate('notify-off', opts)).notifications, false);
  assert.equal((await runUpdate('later', opts)).snoozeUntil, opts.now + 86400000);
});
test('failed checks preserve verified update, never launch or expose request errors', async t => {
  const root = fixture(t);
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  const state = await runUpdate('check', { root, now: 200000, fetcher: async () => { throw new Error('PRIVATE_REQUEST_DETAIL'); } });
  assert.equal(state.available, true); assert.equal(state.phase, 'error');
  assert.ok(!JSON.stringify(state).includes('PRIVATE_REQUEST_DETAIL'));
});
test('install only launches verified bytes and exact target directory', async t => {
  const root = fixture(t); let launched;
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  const state = await runUpdate('install', { root, now: 140000, fetcher: async () => response(bytes), launch: async (exe, target) => { launched = { exe, target }; } });
  assert.equal(state.phase, 'installer-open'); assert.equal(launched.target, root);
  assert.deepEqual(fs.readFileSync(launched.exe), bytes);
  launched = null;
  const failed = await runUpdate('install', { root, now: 180000, fetcher: async () => response(Buffer.alloc(2048)), launch: async () => { launched = true; } });
  assert.equal(failed.phase, 'error'); assert.equal(launched, null);
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
