// 旧版遗留清理与卸载删数据的测试：这条路径会**真的删用户安装目录里的文件**，所以必须证明
//   ① 该删的删掉了（旧目录结构 + 旧发布包漏发的开发件）；
//   ② 不该删的一个没动（用户数据、程序代码、配置文件）；
//   ③ 当前安装清单里的文件被保护（哪怕它同时出现在遗留清单里）；
//   ④ 清单里的路径不存在时安静跳过，不报错；
//   ⑤ 卸载时「连同数据一起删除」这条路径：先备份到安装目录之外，备份没成就一个文件都不删。
// 为什么归在这里：本文件管的就是「装好的目录里哪些文件会没、哪些绝对不能没」，
// 而卸载删数据正是其中最不可逆的那一条。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR } from '../lib/common.mjs';
import { powershell, psQuote } from './windows-integration.mjs';
import { 清理旧版遗留, 读取安装清单, 旧版遗留 } from './install-legacy.mjs';
import { 备份用户数据, 备份目录名, 用户数据, 退出码 } from './uninstall.mjs';

// 搭一个「旧版装完的目录」：程序文件 + 用户数据 + 一批开发件残留
function 旧安装目录() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-legacy-'));
  const 写 = (rel, 内容 = 'x') => {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 内容);
  };
  // 程序文件（这些必须留着）
  for (const rel of ['VERSION', 'dashboard.html', 'config.template.json', 'icon.ico', 'LICENSE',
    '程序/collect.mjs', '程序/tools/install.mjs', '程序/tools/update.mjs', '程序/channels.json',
    '快捷操作/启动看板.vbs', 'assets/support.js', 'docs/community.md', 'docs/NODE-LICENSE.txt']) 写(rel);
  // 用户数据（一个都不能动）
  for (const rel of ['config.json', 'secrets.json', 'dashboard-data.js', 'update-data.js',
    'data/history/2026-09-17.jsonl', 'backups/upgrade-123/snapshot.json']) 写(rel, 'user');
  // 旧版残留（该被删）
  for (const rel of ['.github/ISSUE_TEMPLATE/bug_report.yml', '.gitignore', 'AGENTS.md', 'CHANGELOG.md',
    'release/publish.mjs', 'release/installed-files.json', 'release/channels.json',
    'docs/TODO.md', 'docs/batches/2026-09-16-x.md', 'docs/design/安装升级与用户反馈.md',
    'docs/requirements/安装升级与用户反馈.md', 'docs/连接与发布隔离.md',
    '程序/tools/test-dashboard.mjs', '程序/tools/test-rules.mjs', '程序/tools/rename-project.mjs',
    'tools/install.mjs', 'lib/common.mjs', 'collect.mjs', '静音2小时.bat']) 写(rel);
  return root;
}

test('清理旧版遗留：删残留、留程序与用户数据', t => {
  const root = 旧安装目录();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { removed } = 清理旧版遗留(root);
  // ① 残留清掉了
  for (const rel of ['.github', '.gitignore', 'AGENTS.md', 'CHANGELOG.md', 'release', 'docs/TODO.md',
    'docs/batches', 'docs/design', 'docs/requirements', 'docs/连接与发布隔离.md',
    '程序/tools/test-dashboard.mjs', '程序/tools/test-rules.mjs', '程序/tools/rename-project.mjs',
    'tools', 'lib', 'collect.mjs', '静音2小时.bat']) {
    assert.equal(fs.existsSync(path.join(root, ...rel.split('/'))), false, `${rel} 应该被清掉`);
    assert.ok(removed.includes(rel), `${rel} 应该出现在 removed 里`);
  }
  // ② 程序文件与用户数据原样保留
  for (const rel of ['VERSION', 'dashboard.html', 'config.template.json', 'icon.ico', 'LICENSE',
    '程序/collect.mjs', '程序/tools/install.mjs', '程序/tools/update.mjs', '程序/channels.json',
    '快捷操作/启动看板.vbs', 'assets/support.js', 'docs/community.md', 'docs/NODE-LICENSE.txt',
    'config.json', 'secrets.json', 'dashboard-data.js', 'update-data.js',
    'data/history/2026-09-17.jsonl', 'backups/upgrade-123/snapshot.json']) {
    assert.equal(fs.existsSync(path.join(root, ...rel.split('/'))), true, `${rel} 不该被删`);
  }
  // ③ docs 只少了该少的那几份
  assert.deepEqual(fs.readdirSync(path.join(root, 'docs')).sort(), ['NODE-LICENSE.txt', 'community.md']);
});

test('安装清单保护：清单里有的文件，哪怕在遗留清单里也不删', t => {
  const root = 旧安装目录();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // 假设这一版又把 release/ 与 AGENTS.md 当程序文件装了（清单里就有它们）
  const { kept } = 清理旧版遗留(root, ['release/publish.mjs', 'AGENTS.md', '程序/collect.mjs']);
  assert.deepEqual(kept, ['AGENTS.md', 'release']);        // 目录条目按前缀命中
  assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'release/publish.mjs')), true);
  // 清单没提到的同级残留照删
  assert.equal(fs.existsSync(path.join(root, '.github')), false);
});

test('遗留清单里的路径不存在时安静跳过', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-legacy-empty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { removed, stuck } = 清理旧版遗留(root);
  assert.deepEqual(removed, []);
  assert.deepEqual(stuck, []);
});

test('读取安装清单：没有清单时返回空数组（便携解压/开发目录）', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-legacy-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(读取安装清单(root), []);
  fs.mkdirSync(path.join(root, '程序'), { recursive: true });
  fs.writeFileSync(path.join(root, '程序/installed-files.json'), JSON.stringify({ version: '1.4.1', files: ['VERSION', '程序/x.mjs'] }));
  assert.deepEqual(读取安装清单(root), ['VERSION', '程序/x.mjs']);
  fs.writeFileSync(path.join(root, '程序/installed-files.json'), '{ 坏 JSON');
  assert.deepEqual(读取安装清单(root), []);
});

test('遗留清单本身：没有用户数据路径，且与发布清单不冲突', () => {
  for (const rel of 旧版遗留) {
    assert.equal(/^(config\.json|secrets\.json|data|backups|dashboard-data\.js|update-data\.js)/.test(rel), false,
      `遗留清单里不该出现用户数据路径：${rel}`);
  }
});

// ── 卸载时删数据这条路径（2026-09-20）─────────────────────────────────
// 背景：用户卸载 1.3.0 时，安装器问的是「是否同时删除配置、密钥、历史记录及备份？」——
// 反向提问，他按了「是」，DelTree 连 backups/ 一起删，11 天历史全丢。
// 现在这条路径得同时满足：默认不动数据；真要删也必须在安装目录之外先有一份 zip；
// 备份没做成则一个文件都不删。下面把「安装器怎么问、怎么把门」与「备份本身可不可靠」都钉住。

// 搭一个「用了些日子的安装目录」：四种用户数据齐全（历史是主体）
function 待卸载目录() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-uninstall-'));
  for (const [rel, 内容] of [['config.json', '{"backup":{"keep":3}}'], ['secrets.json', '{"fixture":"PRIVATE_SENTINEL"}'],
    ['dashboard-data.js', 'window.BOARD_DATA={};'], ['update-data.js', 'window.UPDATE_DATA={};'],
    ['data/state.json', '{"codex":1}'], ['data/history/2026-09-17.jsonl', '{"at":1}'],
    ['data/history/2026-09-18.jsonl', '{"at":2}'], ['backups/upgrade-1/snapshot.json', '{}']]) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 内容);
  }
  return root;
}

function 列出文件(root, prefix = '') {
  return fs.readdirSync(path.join(root, prefix), { withFileTypes: true })
    .flatMap(e => e.isDirectory() ? 列出文件(root, `${prefix}${e.name}/`) : [`${prefix}${e.name}`]).sort();
}

// 独立读法（不调实现里的校验）：把 zip 里的条目名全列出来。
// 条目名统一成正斜杠再比 —— 不同 PowerShell/.NET 组合写出来的分隔符不完全一致。
function 读zip条目(zip) {
  const 输出 = powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead(${psQuote(zip)})
try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }`);
  return 输出.split(/\r?\n/).map(s => s.trim().replace(/\\/g, '/')).filter(Boolean).sort();
}

// 从 installer.iss 里取一个整数常量（两边的接口就是这几个退出码）
function 常量值(iss, 名) {
  const m = new RegExp(`${名}\\s*=\\s*(\\d+)\\s*;`).exec(iss);
  assert.ok(m, `installer.iss 里应该有常量 ${名}`);
  return Number(m[1]);
}

// installer.iss 里会被删掉的那几项（DelTree 的目录 + DeleteFile 的文件）。
// 不从正则里硬端反斜杠：{app} 之后、下一个引号之前那一段就是相对路径。
function 安装器删除项(iss) {
  const 项 = [];
  for (const line of iss.split(/\r?\n/).map(l => l.trim())) {
    if (!/^(DelTree|DeleteFile)\(ExpandConstant\(/.test(line)) continue;
    const 起 = line.indexOf('{app}');
    const 止 = line.indexOf("'", 起);
    if (起 < 0 || 止 < 0) continue;
    项.push(line.slice(起 + 5, 止).split(/[\\/]/).filter(Boolean).join('/'));
  }
  return 项.sort();
}

test('卸载前备份：用户数据一项不少地进 zip，且落在安装目录之外', t => {
  const root = 待卸载目录();
  const 输出目录 = fs.mkdtempSync(path.join(os.tmpdir(), 'board-uninstall-backup-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(输出目录, { recursive: true, force: true }); });
  const 应有 = 列出文件(root);
  const r = 备份用户数据(root, { 输出目录, 时间: new Date(2026, 8, 20, 12, 13, 7) });
  assert.equal(path.dirname(r.zip), 输出目录);
  assert.equal(path.basename(r.zip), `${备份目录名}-20260920-121307.zip`);
  assert.ok(path.relative(root, r.zip).startsWith('..'), `备份必须在安装目录之外：${r.zip}`);
  assert.deepEqual(读zip条目(r.zip), 应有, 'zip 要能打开，而且内容与安装目录里的用户数据一模一样');
  assert.ok(应有.some(f => f.startsWith('data/history/')), '夹具里得有历史记录，否则这条断言等于没测');
  assert.equal(r.含历史, true, '备份要认得自己带上了历史记录');
});

test('本来就没有数据：不产 zip，也不凭空建目录', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-uninstall-empty-'));
  const 输出目录 = path.join(os.tmpdir(), `board-uninstall-none-${Date.now()}`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = 备份用户数据(root, { 输出目录 });
  assert.equal(r.zip, null);
  assert.equal(fs.existsSync(输出目录), false);
});

test('备份做不成必须报错（安装器据此一个文件都不删）', t => {
  const root = 待卸载目录();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const 应有 = 列出文件(root);
  // 拿一个已经存在的**文件**当备份目录：连目录都建不出来，备份根本无从开始
  assert.throws(() => 备份用户数据(root, { 输出目录: path.join(root, 'data', 'state.json') }),
    e => ['EEXIST', 'ENOTDIR', 'ENOENT'].includes(e.code), '备份失败必须抛出，不能静默返回');
  assert.deepEqual(列出文件(root), 应有, '备份失败不能动数据一个文件');
});

test('安装器契约：默认保留数据，只有点「连同数据一起删除」才删，且删除前必须先备份', () => {
  const iss = fs.readFileSync(path.join(ROOT_DIR, 'release', 'installer.iss'), 'utf8');
  // ① 旧的坑：反问句不弄了 —— 用户就是在这句话上答错的。
  //    只看提问那次调用本身：注释里可以提旧文案，用户看到的字里不许再有「是否」。
  const 提问 = /SuppressibleTaskDialogMsgBox\([^;]*\)/.exec(iss)?.[0] ?? '';
  assert.ok(提问, '找不到卸载提问');
  assert.equal(提问.includes('是否'), false, '卸载提问里不能再出现「是否…」这种要二次翻译的问法');
  // ② 两个按钮的文字（用户看到的全部判据：各自写清后果，不多说一句）
  assert.match(iss, /Labels\[0\]\s*:=\s*'保留数据并卸载（推荐）'/, '第一个按钮（= 默认按钮）是保留，并明标（推荐）');
  assert.match(iss, /Labels\[1\]\s*:=\s*'连同数据一起删除'/, '第二个按钮才是删除');
  assert.equal(/Labels\[1\][^\r\n]*推荐/.test(iss), false, '「推荐」只能标在保留那一侧：删除那边永远不能显得值得选择');
  assert.ok(iss.includes('下次安装还能接着用'), '保留那一侧要说清还能接着用');
  assert.ok(iss.includes('无法恢复'), '删除那一侧要明说不可恢复');
  // ③ 只有「删除」那一个返回值算数：其余（含静默模式被抑制时的默认值）一律保留
  assert.match(iss, /SuppressibleTaskDialogMsgBox\([^;]*IDYES\)\s*=\s*IDNO/,
    '默认按钮 = 保留那一侧，且只有 IDNO 才当删除');
  // ④ 删除前必须先备份：备份调用在删除之前，且删除分支由备份结果把门
  const 备份位置 = iss.indexOf('--backup-user-data');
  assert.ok(备份位置 > 0, '安装器要调用 uninstall.mjs 的备份入口');
  assert.ok(备份位置 < iss.indexOf('DelTree('), '备份必须发生在删除之前');
  assert.match(iss, /DeleteUserData\s*:=\s*Backup\s*=\s*BR_OK/, '备份没做成（或没有数据）就不许删');
  // ⑤ 两边的用户数据清单是同一份：只改一边 = 有数据没备份就删了
  assert.deepEqual(安装器删除项(iss), [...用户数据].sort());
  // ⑥ 退出码两边一致：node 报的码就是 Inno 认的码
  assert.equal(常量值(iss, 'BR_OK'), 退出码.可以删);
  assert.equal(常量值(iss, 'BR_EMPTY'), 退出码.没有数据);
  assert.equal(常量值(iss, 'BR_FAILED'), 退出码.备份失败);
});
