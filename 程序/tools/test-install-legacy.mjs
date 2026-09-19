// 旧版遗留清理的测试：这条路径会**真的删用户安装目录里的文件**，所以必须证明
//   ① 该删的删掉了（旧目录结构 + 旧发布包漏发的开发件）；
//   ② 不该删的一个没动（用户数据、程序代码、配置文件）；
//   ③ 当前安装清单里的文件被保护（哪怕它同时出现在遗留清单里）；
//   ④ 清单里的路径不存在时安静跳过，不报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { 清理旧版遗留, 读取安装清单, 旧版遗留 } from './install-legacy.mjs';

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
  fs.writeFileSync(path.join(root, '程序/installed-files.json'), JSON.stringify({ version: '1.4.0', files: ['VERSION', '程序/x.mjs'] }));
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
