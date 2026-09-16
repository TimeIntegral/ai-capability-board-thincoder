import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { powershell, psQuote } from '../tools/windows-integration.mjs';
import { repositories } from '../lib/updates.mjs';

const root = path.dirname(import.meta.dirname);
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const channels = JSON.parse(fs.readFileSync(path.join(root, 'release/channels.json'), 'utf8'));
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
const files = [...walk(stage), 'release/installed-files.json'];
if (files.some(f => /^(data|backups|private)\//.test(f) || ['config.json', 'secrets.json', 'dashboard-data.js', 'update-data.js'].includes(f))) throw new Error('安装包包含私人文件');
fs.writeFileSync(path.join(stage, 'release/installed-files.json'), JSON.stringify({ version, files }, null, 2));
execFileSync(compiler, [`/DStageDir=${stage}`, `/DAppVersion=${version}`, `/DOutputDir=${path.join(root, 'dist')}`, path.join(root, 'release/installer.iss')], { stdio: 'inherit', windowsHide: true });
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
fs.writeFileSync(path.join(root, 'dist/build-result.json'), JSON.stringify({ stage, installer: path.join(root, 'dist', name), version, files: files.length }, null, 2));
console.log(`安装包完成：${name}；发布时同时上传 latest.json、SHA256SUMS.txt 和便携 ZIP。`);
