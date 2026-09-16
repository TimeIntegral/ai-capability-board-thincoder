// 发布清单契约测试：把「三层文件模型」的规矩钉成断言（模型说明见 release/README.md）。
// 它管的是「有人往仓库加了文件，却忘了分类」这件事 —— 那种时候这里红、发布闸门也会停下，
// 而不是悄悄把文件塞进用户包（.github\ 就是这么漏进去的，2026-09-17）。
//
// 规矩（与 release/publish-files.mjs 顶部的三条对应）：
//   ① 发布层每一项都必须在仓库里真实存在 —— 少了就是产物缺件；
//   ② 仓库的每个文件要么进发布层、要么进仅开发层 —— 未分类 / 两边都占 = 红；
//   ③ 包内引用自洽 —— 包内 .mjs 的 import、.vbs/.bat 调用的程序脚本都在包里。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  发布层, 仅供开发, 安装时注入, 安装清单路径, 分类, 从stage推导, 推导安装清单, 渲染安装器文件列表, 检查悬空引用,
} from '../../release/publish-files.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const 读 = rel => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return null; } };

// 与 release/publish.mjs 同一口径：git 将跟踪的、且磁盘上真实存在的文件。
function 仓库文件() {
  const 原始 = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, windowsHide: true }).toString('utf8');
  return [...new Set(原始.split('\0').filter(Boolean))]
    .filter(rel => fs.existsSync(path.join(ROOT, rel))).sort();
}
const files = 仓库文件();
const 层次 = 分类(files);

test('发布层每一项都在仓库里存在（规矩 ①）', () => {
  assert.ok(files.length > 0, '一个文件都没取到 —— 确认在 git 仓库根目录下运行');
  assert.deepEqual(层次.失效发布, [],
    `发布清单里有对不上文件的条目（产物会缺件）：${层次.失效发布.join('、')} —— 文件改名/删除后同步改 release/publish-files.mjs`);
});

test('仓库的每个文件都归好了类（规矩 ②）', () => {
  assert.deepEqual(层次.未分类, [],
    `这些文件既不在发布层也不在仅开发层，先做决定再加进 release/publish-files.mjs：\n  ${层次.未分类.join('\n  ')}`);
  assert.deepEqual(层次.冲突, [],
    `同一个文件同时被归进两层（清单自相矛盾）：${层次.冲突.join('、')}`);
  assert.ok(层次.发布.length > 0, '发布层是空的 —— 包会是空壳');
});

test('新增文件默认不进包（黑名单时代漏发 .github\\ 的根因）', () => {
  // 三个真实形状：仓库根新增文件、发布层目录里新增文件、开发目录里新增文件。
  for (const 新文件 of ['临时-新文件.txt', '程序/tools/临时新脚本.mjs', 'assets/临时截图.png', '.github/workflows/ci.yml']) {
    const 结果 = 分类([新文件]);
    assert.equal(结果.发布.includes(新文件), false, `${新文件} 不该被当成发布层文件`);
  }
  // 前三个是「未分类」（必须有人做决定），.github/ 是「仅开发」（目录已归类）。
  assert.equal(分类(['临时-新文件.txt']).未分类.length, 1);
  assert.equal(分类(['程序/tools/临时新脚本.mjs']).未分类.length, 1);
  assert.equal(分类(['.github/workflows/ci.yml']).仅开发.length, 1);
  // 目录前缀条目（仅供开发）与文件级条目（发布层）都按预期命中。
  assert.equal(分类(['release/新的构建脚本.mjs']).仅开发.length, 1);
  assert.equal(分类(['程序/tools/test-新增测试.mjs']).仅开发.length, 1);
});

test('L3 = 发布层 + 安装时注入（规矩 ②的后半段：安装器不再全装 stage）', () => {
  const 安装清单 = 推导安装清单(层次.发布);
  const 注入路径 = 安装时注入.map(e => (Array.isArray(e) ? e[0] : e));
  assert.deepEqual(安装清单, [...new Set([...层次.发布, ...注入路径])].sort());
  for (const 项 of 注入路径) {
    assert.equal(层次.发布.includes(项), false, `安装时注入的项不该同时出现在发布层（那样便携包也会带上它）：${项}`);
  }
});

test('安装器文件列表逐条渲染（含中文路径），且与 L3 一一对应', () => {
  const 安装清单 = [...推导安装清单(层次.发布), '程序/临时-中文路径测试文件.json'];
  const 文本 = 渲染安装器文件列表(安装清单);
  const 行 = 文本.split('\n').filter(l => l.startsWith('Source:'));
  assert.equal(行.length, 安装清单.length);
  const i = 安装清单.indexOf('程序/tools/install.mjs');
  assert.ok(行[i].includes('{#StageDir}\\程序\\tools\\install.mjs'), `中文/子目录路径没渲染对：${行[i]}`);
  assert.ok(行[i].includes('DestDir: "{app}\\程序\\tools"'), `目标目录没渲染对：${行[i]}`);
  assert.ok(行[i].endsWith('Flags: ignoreversion'));
  assert.throws(() => 渲染安装器文件列表(['程序/带"引号.mjs']), /Inno/);
});

test('build-installer 的接缝：stage 里的内容（发布件 + 便携运行时 + 注入）能推出 L3', () => {
  // 真实 stage = 发布层 + runtime/node.exe（打包时加进来的，不在 git 清单里）+ 注入的安装清单。
  // 这里钉住 2026-09-17 踩到的一个坑：运行时不在 L1 清单里，曾经会被当成「未分类」把构建卡死。
  const stage = [...层次.发布, 'runtime/node.exe', ...安装时注入.map(e => (Array.isArray(e) ? e[0] : e))];
  const { 分层, 构建时, 安装清单, 不对 } = 从stage推导(stage);
  assert.deepEqual(构建时, ['runtime/node.exe']);
  assert.deepEqual(分层.发布, 层次.发布);
  assert.deepEqual(不对, []);
  assert.ok(安装清单.includes('runtime/node.exe'), '运行时必须进 L3（卸载器与升级链靠它）');
  assert.equal(安装清单.length, 层次.发布.length + 1 + 安装时注入.length);
  // 反向：stage 里混进不该给用户的文件 / 少了一个发布件，两种都要被报出来
  assert.ok(从stage推导([...stage, 'AGENTS.md']).不对.includes('AGENTS.md'));
  assert.ok(从stage推导(stage.filter(f => f !== 'VERSION')).不对.includes('VERSION'));
});

test('安装清单路径与读它的地方一致（改名时不会只改一半）', () => {
  // 运行时的两个模块不能 import 开发侧的清单模块（它不随包发），所以那里必须写实路径 ——
  // 这条断言保证改名时不会只改一半；构建器则必须用清单模块导出的常量。
  const 文件名 = 安装清单路径.split('/').pop();
  for (const rel of ['程序/tools/upgrade-lifecycle.mjs', '程序/tools/install-legacy.mjs']) {
    assert.ok((读(rel) ?? '').includes(文件名), `${rel} 里没提到 ${文件名} —— 安装清单改名后它没跟上`);
  }
  const 构建器 = 读('release/build-installer.mjs') ?? '';
  assert.ok(构建器.includes('安装清单路径'), 'release/build-installer.mjs 应当用 publish-files.mjs 导出的安装清单路径，不要自己写一份路径');
  assert.ok(!构建器.includes(`'${安装清单路径}'`) && !构建器.includes(`"${安装清单路径}"`), 'release/build-installer.mjs 里不该再写死安装清单路径');
});

test('包内引用自洽（规矩 ③）', () => {
  assert.deepEqual(检查悬空引用(读, 层次.发布), [],
    '包内出现了指向包外文件的引用 —— 对照 release/publish-files.mjs 看漏列或错分类');
});

test('引用检查不是走过场（喂坏数据必须报出来）', () => {
  assert.deepEqual(检查悬空引用(() => "import { x } from './missing.mjs';", ['程序/tools/a.mjs']),
    [{ 文件: '程序/tools/a.mjs', 引用: '程序/tools/missing.mjs' }]);
  assert.deepEqual(检查悬空引用(() => 'cmd /c "%NODE%" "%PROG%\\tools\\missing.mjs"', ['程序/tools/a.bat']),
    [{ 文件: '程序/tools/a.bat', 引用: 'tools\\missing.mjs' }]);
  // ③ 按文件名点名的脚本（execFileSync 而不是 import）也要管：这才是「误归类」最常出现的地方
  assert.deepEqual(检查悬空引用(() => "execFileSync(NODE, [path.join(import.meta.dirname, 'make-icon.mjs')])", ['程序/tools/a.mjs']),
    [{ 文件: '程序/tools/a.mjs', 引用: 'make-icon.mjs' }]);
  // 开发路径的说明文字不算悬空（安装定时任务.bat 的提示里写着 release\make-portable.mjs）；
  // 测试脚本自己也算开发件（名在仅供开发层的通配里）。
  assert.deepEqual(检查悬空引用(() => 'or run:  node release\\make-portable.mjs', ['快捷操作/x.bat']), []);
  assert.deepEqual(检查悬空引用(() => "run('test-rules.mjs')", ['程序/tools/a.mjs']), []);
});
