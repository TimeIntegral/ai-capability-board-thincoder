import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { compareVersions, repositories, validateManifest, fetchBounded } from '../lib/updates.mjs';
import { ROOT_DIR } from '../lib/common.mjs';
import { runUpdate, watchInstall, openCommand } from './update.mjs';
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
// 分批吐的响应：进度回调要按块触发，页面上的百分比就是它一路写到状态文件里的
function chunkedFetch(buffer, parts, probe) {
  const size = Math.ceil(buffer.length / parts);
  return async () => {
    let index = 0;                                   // 每次请求各自从头吐（换镜像重试时会重新数）
    return new Response(new ReadableStream({
      pull(controller) {
        probe?.();
        const from = index * size;
        if (from >= buffer.length) { controller.close(); return; }
        index += 1;
        controller.enqueue(new Uint8Array(buffer.subarray(from, from + size)));
      },
    }), { status: 200, headers: { 'content-length': String(buffer.length) } });
  };
}
// 假安装器进程：只记参数、按脚本给退出码（或报 spawn 错误）。真装一次会动用户机器，测试里一律不让它跑。
function fakeInstaller({ code = 0, error = null } = {}) {
  const calls = [];
  const impl = (exe, args, options) => {
    calls.push({ exe, args, options });
    const listeners = {};
    const child = { once(name, fn) { listeners[name] = fn; return child; } };
    setImmediate(() => { if (error) listeners.error?.(error); else listeners.exit?.(code); });
    return child;
  };
  impl.calls = calls;
  return impl;
}
// 页面读的就是这两个文件（data/update-status.json 真源 + update-data.js 注入副本）
const readStatus = root => JSON.parse(fs.readFileSync(path.join(root, 'data/update-status.json'), 'utf8'));
// 监看进程的桩：不真等（sleep）、不真开浏览器（open）
const watchStub = extra => ({ sleep: () => Promise.resolve(), open: async () => { }, ...extra });

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
  assert.equal(fs.existsSync(path.join(root, 'data/updates')), false);   // 检查更新不下载任何东西：下载目录只在用户点「立即更新」时才建
});
test('failed checks preserve verified update, never launch or expose request errors', async t => {
  const root = fixture(t);
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  const state = await runUpdate('check', { root, now: 200000, fetcher: async () => { throw new Error('PRIVATE_REQUEST_DETAIL'); } });
  assert.equal(state.available, true); assert.equal(state.phase, 'error');
  assert.ok(!JSON.stringify(state).includes('PRIVATE_REQUEST_DETAIL'));
});
// ── 「立即更新」的四条路径（2026-09-20）────────────────────────────────────────────
// 全部用桩（假响应 / 假安装器进程 / 假「重开看板」）：测试绝不真的装东西 ——
// 用户机器上真装的只有用户自己点的那一次。
const INSTALL_MSG = '正在安装，看板会关闭后自动打开';
const UPDATES_DIR = 'data/updates';
const setupName = `setup-${futureFixture}.exe`;

test('下载成功 → 校验通过 → 交接安装：进度一路写进状态文件（页面读的就是它）', async t => {
  const root = fixture(t);
  const opts = { root, now: 100000, fetcher: async () => response(manifest) };
  await runUpdate('check', opts);
  const seen = [];
  const launched = [];
  const state = await runUpdate('install', { ...opts, now: 140000,
    // 每吐一块就读一次状态文件：页面上的百分比来路就是这里（真源 + 注入副本）
    fetcher: chunkedFetch(bytes, 4, () => seen.push(readStatus(root).progress?.percent ?? null)),
    launch: async (exe, r, version) => launched.push({ exe, root: r, version, size: fs.statSync(exe).size }) });
  const percents = seen.filter(n => Number.isFinite(n));
  assert.ok(new Set(percents).size >= 2, `进度要逐块变（页面才看得到动）：${JSON.stringify(seen)}`);
  assert.ok(Math.max(...percents) > 0, `进度要能超过 0%：${JSON.stringify(seen)}`);
  assert.deepEqual(launched, [{ exe: path.join(root, ...UPDATES_DIR.split('/'), setupName), root, version: futureFixture, size: bytes.length }]);
  assert.equal(fs.existsSync(path.join(root, ...UPDATES_DIR.split('/'), `${setupName}.part`)), false, '不该留下半截下载');
  const written = readStatus(root);
  assert.equal(written.phase, 'installing');
  assert.equal(written.message, INSTALL_MSG);
  assert.equal('progress' in written, false, '安装阶段不该还挂着下载进度');
  assert.ok(fs.readFileSync(path.join(root, 'update-data.js'), 'utf8').includes(INSTALL_MSG), '注入副本要带上同一份状态');
  assert.equal(state.phase, 'installing');
});
test('下载失败 → 不落盘、不交接，页面拿到「下载没成功」而不是内部错误', async t => {
  const root = fixture(t);
  const opts = { root, now: 100000, fetcher: async () => response(manifest) };
  await runUpdate('check', opts);
  let launched = 0;
  const state = await runUpdate('install', { ...opts, now: 140000,
    fetcher: async () => { throw new Error('PRIVATE_REQUEST_DETAIL'); }, launch: async () => { launched++; } });
  assert.equal(state.phase, 'error');
  assert.equal(state.message, '下载没成功，看板还是原来的版本，请稍后重试');
  assert.ok(!JSON.stringify(state).includes('PRIVATE_REQUEST_DETAIL'), '网络错误的原文不能进状态文件');
  assert.equal(state.available, true, '失败要给重试留路');
  assert.equal(launched, 0, '没下下来就绝不能交给安装器');
  assert.deepEqual(fs.readdirSync(path.join(root, ...UPDATES_DIR.split('/'))), [], '下载失败不留残件');
});
test('校验失败 → 拒绝安装：截断 / 没有 PE 头 / 哈希不对，一个字节都不落盘', async t => {
  const root = fixture(t);
  const opts = { root, now: 100000, fetcher: async () => response(manifest) };
  await runUpdate('check', opts);
  const tampered = Buffer.from(bytes); tampered[900] = 0x00;
  const bad = { 截断: bytes.subarray(0, bytes.length - 8), 没有PE头: Buffer.alloc(bytes.length, 0x45), 哈希不对: tampered };
  for (const [name, pack] of Object.entries(bad)) {
    let launched = 0;
    const state = await runUpdate('install', { ...opts, now: 140000, fetcher: async () => response(pack), launch: async () => { launched++; } });
    assert.equal(state.phase, 'error', name);
    assert.equal(state.message, '安装包校验失败，已停止安装，看板还是原来的版本', name);
    assert.equal(launched, 0, `${name}：校验没过就不能交给安装器`);
    assert.deepEqual(fs.readdirSync(path.join(root, ...UPDATES_DIR.split('/'))), [], `${name}：坏包不能落盘`);
  }
});
test('安装成功：写「已更新到 vX」、看板重新打开、这个版本不再提示', async t => {
  const root = fixture(t);
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  const spawn = fakeInstaller({ code: 0 });
  const opened = [];
  fs.writeFileSync(path.join(root, 'VERSION'), futureFixture);      // 安装器已经把版本号换了
  const result = await watchInstall(root, path.join(root, setupName), futureFixture, watchStub({ spawnImpl: spawn, open: async r => { opened.push(r); } }));
  assert.equal(result.done, true);
  const state = readStatus(root);
  assert.equal(state.phase, 'installed');
  assert.equal(state.message, `已更新到 v${futureFixture}`);
  assert.equal(state.available, false, '装完就不该再提示这一版');
  assert.equal(state.currentVersion, futureFixture, 'currentVersion 要从 VERSION 现读：不然页面会继续弹「立即更新」');
  assert.equal(state.progress, undefined);
  assert.deepEqual(opened, [root], '装完要把看板打开：用户得看到新版本');
});
test('安装失败（退出码 1 / 用户取消 1602 / 起不来）：给明确结果、仍可重试、看板照旧打开', async t => {
  for (const [code, message] of [[1, '更新没装成，看板还是原来的版本'], [1602, '安装被取消了，看板还是原来的版本'], [1223, '安装被取消了，看板还是原来的版本']]) {
    const root = fixture(t);
    await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
    const opened = [];
    await watchInstall(root, path.join(root, setupName), futureFixture, watchStub({ spawnImpl: fakeInstaller({ code }), open: async r => { opened.push(r); } }));
    const state = readStatus(root);
    assert.equal(state.phase, 'error', `退出码 ${code}`);
    assert.equal(state.message, message, `退出码 ${code}`);
    assert.equal(state.available, true, `退出码 ${code}：失败了要能重试`);
    assert.deepEqual(opened, [root], `退出码 ${code}：失败也要把看板打开，用户得看见结果`);
  }
  const root = fixture(t);
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  await watchInstall(root, path.join(root, setupName), futureFixture, watchStub({ spawnImpl: fakeInstaller({ error: new Error('ENOENT') }) }));
  assert.equal(readStatus(root).message, '更新没装成，看板还是原来的版本', '安装器起不来也算没装成，不能停在「安装中」');
});
test('交给安装器的参数：/SILENT 看得见进度（不是 /VERYSILENT）、/NORESTART、/DIR 原地覆盖', async t => {
  const root = fixture(t);
  await runUpdate('check', { root, now: 100000, fetcher: async () => response(manifest) });
  const spawn = fakeInstaller({ code: 0 });
  await watchInstall(root, path.join(root, setupName), futureFixture, watchStub({ spawnImpl: spawn }));
  const [call] = spawn.calls;
  assert.deepEqual(call.args, ['/SILENT', '/NORESTART', '/SP-', `/DIR=${root}`]);
  assert.equal(call.options.windowsHide, false, '安装窗口要看得见（用户要能看到安装进度）');
});
test('装完重开看板：既有打开方式 + 落在「帮助与反馈」', () => {
  const cmd = openCommand(path.join(os.tmpdir(), 'board-open'));
  assert.ok(cmd.startsWith("Start-Process 'file:///"), cmd);
  assert.ok(cmd.endsWith("#support'"), cmd);
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
  // 跳过之后又改主意（在帮助与反馈里主动点「立即更新」）：得真能装上 —— available=false 只是「不再主动提示」的意思
  const afterSkip = await runUpdate('install', { ...opts, now: 400000, fetcher: async () => response(bytes), launch: async () => { } });
  assert.equal(afterSkip.phase, 'installing', '跳过之后点「立即更新」要真装上，不能说「请先检查更新」');
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
  assert.ok(actions.includes('install'), `白名单里应当有 install（「立即更新」的执行端）：${line}`);
  // Windows 脚本宿主按系统 ANSI 码页读 .vbs：混进非 ASCII 字节会吞掉换行、把脚本搞成语法错误（踩过）
  const vbsBuf = fs.readFileSync(path.join(ROOT_DIR, '程序', '运行协议.vbs'));
  assert.equal([...vbsBuf].filter(b => b > 0x7F).length, 0, '程序/运行协议.vbs 必须保持纯 ASCII');
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
