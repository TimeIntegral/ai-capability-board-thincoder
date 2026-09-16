import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { powershell, psQuote } from '../程序/tools/windows-integration.mjs';
import { repositories } from '../程序/lib/updates.mjs';
import { 从stage推导, 渲染安装器文件列表, 安装清单路径, 安装时注入 } from './publish-files.mjs';

// 三层文件模型里的 L2 → L3（说明表见 release/README.md）：
//   L2 发布层 = release/publish-files.mjs 正列举的文件 = 便携 ZIP 的内容（publish.mjs 打的）
//   L3 安装层 = L2 + 安装时注入（本文件写入的安装清单）= 安装器装到用户机器上的东西
// 安装器**不再**按「stage 里有什么就装什么」全装（旧写法 Source: "{#StageDir}\*"）：那样
// stage 里任何东西都会进用户机器，安装层就与发布层脱钩了。现在两个方向都卡死：
//   ① stage 里多出来的文件（不属于发布层）→ 报错停下；
//   ② 发布清单里有、stage 里没有的文件 → 报错停下（产物缺件，用户机上会打不开）。
const root = path.dirname(import.meta.dirname);
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
// 渠道地址住在程序目录里：它是发布层文件（随包给用户），运行时 程序/tools/update.mjs 读同一份。
const channels = JSON.parse(fs.readFileSync(path.join(root, '程序/channels.json'), 'utf8'));
const compiler = process.env.ISCC || path.join(root, 'private/build-tools/inno/ISCC.exe');
if (!fs.existsSync(compiler)) throw new Error('构建机需要 Inno Setup：设置 ISCC 为编译器路径，用户无需安装。');
fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
const product = `window.BOARD_PRODUCT=${JSON.stringify({ version, channels })};\n`;
if (fs.readFileSync(path.join(root, 'assets/product-info.js'), 'utf8').replace(/\r\n/g, '\n') !== product) {
  throw new Error('请先更新 assets/product-info.js 的版本与渠道并提交，再准备发布。构建不会修改源码。');
}
// Gate first, then stage precisely the audited archive (never glob the developer directory).
execFileSync(process.execPath, [path.join(root, 'release/publish.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true });
const stageBase = path.join(root, 'dist', `stage-${Date.now()}`);
const zip = path.join(root, 'dist', `ai-capability-board-v${version}.zip`);
powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem\n[IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zip)}, ${psQuote(stageBase)})`);
const stage = path.join(stageBase, `ai-capability-board-v${version}`);
const walk = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const rel = prefix + e.name;
  if (e.isSymbolicLink()) throw new Error('发布包不允许链接');
  return e.isDirectory() ? walk(path.join(dir, e.name), `${rel}/`) : [rel];
});

// ── L2 → L3：把 stage 与发布清单对齐，任何一边多/少都停下 ──────────────────
// 这里用 stage 的实际内容去比对清单（而不是信「打包没出错」），两侧都由 publish-files.mjs 判定：
// 未分类 / 仅开发 = stage 里混进了不该给用户的文件；失效发布 = 清单里有文件没进 stage。
// 便携运行时（runtime/）不在 git 清单里，但确实要随包走，由 从stage推导 单独认下。
const stageFiles = walk(stage);
const { 分层, 安装清单, 不对 } = 从stage推导(stageFiles);
if (不对.length) {
  const 多出来 = [...分层.未分类, ...分层.仅开发, ...分层.冲突];
  const 缺件 = 分层.失效发布;
  throw new Error([
    'stage 与发布清单对不上（release/publish-files.mjs）：',
    ...(多出来.length ? [`  stage 里有不属于发布层的文件：${多出来.join('、')}`] : []),
    ...(缺件.length ? [`  发布清单里的文件没进 stage：${缺件.join('、')}`] : []),
  ].join('\n'));
}

// 安装清单本身是 L3 独有的那一项：写进 stage，安装器会把它一起装到用户目录。
const 清单相对路径 = 安装清单路径;
const 清单文件 = path.join(stage, ...清单相对路径.split('/'));
fs.writeFileSync(清单文件, JSON.stringify({ version, files: 安装清单 }, null, 2));
if (安装清单.some(f => /^(data|backups|private)\//.test(f) || ['config.json', 'secrets.json', 'dashboard-data.js', 'update-data.js'].includes(f))) {
  throw new Error('安装包包含私人文件');
}
// 安装器逐条装的清单（installer.iss 用 #include 读它）：L3 由此与 L2 是同一份事实。
const 文件列表 = path.join(stageBase, 'installer-files.iss');
fs.writeFileSync(文件列表, 渲染安装器文件列表(安装清单));
execFileSync(compiler, [`/DStageDir=${stage}`, `/DFileList=${文件列表}`, `/DAppVersion=${version}`, `/DOutputDir=${path.join(root, 'dist')}`, path.join(root, 'release/installer.iss')], { stdio: 'inherit', windowsHide: true });
const name = `ai-capability-board-v${version}-windows-x64-setup.exe`;
const bytes = fs.readFileSync(path.join(root, 'dist', name));
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
const repos = repositories(channels);
const notes = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').split(/^## /m)[1]?.slice(0, 3500) || '安装与使用体验改进';
const manifest = { schema: 1, version, size: bytes.length, sha256,
  urls: repos.map(repo => `${repo}/releases/download/v${version}/${name}`),
  releaseUrl: `${channels.github}/releases/tag/v${version}`, notes };
fs.writeFileSync(path.join(root, 'dist/latest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(root, 'dist/SHA256SUMS.txt'), [name, path.basename(zip), 'latest.json'].map(f => `${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'dist', f))).digest('hex')}  ${f}`).join('\n') + '\n');
fs.writeFileSync(path.join(root, 'dist/build-result.json'), JSON.stringify({ stage, installer: path.join(root, 'dist', name), version, files: 安装清单.length, published: 分层.发布.length }, null, 2));
console.log(`安装包完成：${name}；发布时同时上传 latest.json、SHA256SUMS.txt 和便携 ZIP。`);
console.log(`安装层 ${安装清单.length} 个文件 = 发布层 ${分层.发布.length} 个 + 便携运行时 ${安装清单.length - 分层.发布.length - 安装时注入.length} 个 + 安装时注入（${清单相对路径}）；清单由 release/publish-files.mjs 推导。`);
