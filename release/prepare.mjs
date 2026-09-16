// Freeze HEAD into a detached worktree; developer files never enter a release build.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const root = path.dirname(import.meta.dirname);
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
if (git(['status', '--porcelain']).trim()) throw new Error('请先保存代码提交，再准备发布。开发中的文件不会进入发布包。');
const commit = git(['rev-parse', 'HEAD']).trim();
const version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
const target = path.join(root, 'private', `release-${version}-${commit.slice(0, 8)}-${Date.now()}`);
git(['worktree', 'add', '--detach', target, commit]);
fs.mkdirSync(path.join(target, 'runtime'), { recursive: true });
for (const name of fs.readdirSync(path.join(root, 'runtime'))) {
  const source = path.join(root, 'runtime', name);
  if (fs.statSync(source).isFile()) fs.copyFileSync(source, path.join(target, 'runtime', name));
}
const localRules = path.join(root, 'release/audit-rules.local.json');
if (fs.existsSync(localRules)) fs.copyFileSync(localRules, path.join(target, 'release/audit-rules.local.json'));
const env = { ...process.env, ISCC: process.env.ISCC || path.join(root, 'private/build-tools/inno/ISCC.exe') };
const run = args => execFileSync(process.execPath, args, { cwd: target, env, windowsHide: true, stdio: 'inherit' });
run(['--test', 'tools/test-connections.mjs', 'tools/test-distribution.mjs']);
run(['release/build-installer.mjs']);
fs.mkdirSync(path.join(target, 'private/build-tools'), { recursive: true });
run(['tools/test-installer.mjs']);
const output = path.join(root, 'dist', `candidate-${version}-${commit.slice(0, 8)}`);
fs.mkdirSync(output, { recursive: true });
for (const name of [`ai-capability-board-v${version}.zip`, `ai-capability-board-v${version}-windows-x64-setup.exe`, 'latest.json', 'SHA256SUMS.txt']) fs.copyFileSync(path.join(target, 'dist', name), path.join(output, name));
fs.writeFileSync(path.join(output, 'release-snapshot.json'), JSON.stringify({ version, commit, state: 'candidate', builtAt: new Date().toISOString() }, null, 2));
console.log(`候选版已完成：${output}\n代码快照：${commit}\n尚未上传或发布；继续开发不影响这份候选版。`);
