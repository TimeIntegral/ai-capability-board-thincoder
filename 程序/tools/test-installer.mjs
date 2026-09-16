import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../lib/common.mjs';

const root = ROOT_DIR;                       // 项目根（VERSION / runtime / dist / private 在那一层）
const build = JSON.parse(fs.readFileSync(path.join(root, 'dist/build-result.json')));
const target = path.join(root, 'private', `安装演练 O'Brien ${Date.now()}`);
const common = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/BOARDISOLATED=1'];
const env = { ...process.env, PATH: `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}` };
delete env.PSModulePath;
function install(label) {
  execFileSync(build.installer, [...common, `/DIR=${target}`, `/LOG=${path.join(root, 'private/build-tools', `installer-${label}.log`)}`], { env, timeout: 180000, windowsHide: true });
}
install('new');
assert.equal(fs.readFileSync(path.join(target, 'VERSION'), 'utf8').trim(), build.version);
assert.ok(fs.existsSync(path.join(target, 'runtime/node.exe')));
assert.ok(!fs.existsSync(path.join(target, 'config.json')));
console.log('PASS：无系统 Node、中文/空格/单引号路径安装，运行环境和版本完整，未夹带私人配置');
fs.mkdirSync(path.join(target, 'data'), { recursive: true });
fs.writeFileSync(path.join(target, 'config.json'), '{"custom":"keep"}');
fs.writeFileSync(path.join(target, 'secrets.json'), '{"fixture":"PRIVATE_SENTINEL"}');
fs.writeFileSync(path.join(target, 'data/history-fixture.json'), 'user history');
fs.writeFileSync(path.join(target, 'VERSION'), '1.0.0');
install('upgrade');
assert.equal(fs.readFileSync(path.join(target, 'VERSION'), 'utf8').trim(), build.version);
assert.equal(fs.readFileSync(path.join(target, 'config.json'), 'utf8'), '{"custom":"keep"}');
assert.equal(fs.readFileSync(path.join(target, 'data/history-fixture.json'), 'utf8'), 'user history');
assert.equal(fs.readFileSync(path.join(target, 'secrets.json'), 'utf8'), '{"fixture":"PRIVATE_SENTINEL"}');
assert.ok(fs.readdirSync(path.join(target, 'backups')).some(n => n.startsWith('upgrade-')));
assert.ok(!fs.existsSync(path.join(target, 'data/upgrade-transaction.json')));
console.log('PASS：覆盖升级保留配置、密钥与历史，产生备份并清除升级锁');
fs.writeFileSync(path.join(target, 'VERSION'), '9.0.0');
assert.throws(() => install('downgrade'));
assert.equal(fs.readFileSync(path.join(target, 'VERSION'), 'utf8'), '9.0.0');
fs.writeFileSync(path.join(target, 'VERSION'), build.version);
console.log('PASS：旧安装包无法覆盖更高版本');
execFileSync(path.join(target, 'unins000.exe'), [...common, `/LOG=${path.join(root, 'private/build-tools/installer-uninstall.log')}`], { env, timeout: 120000, windowsHide: true });
// The uninstaller may spawn its temporary copy, so wait for its completion marker via a bounded loop.
for (let i = 0; i < 60 && fs.existsSync(path.join(target, 'dashboard.html')); i++) await new Promise(r => setTimeout(r, 250));
assert.ok(!fs.existsSync(path.join(target, 'dashboard.html')));
assert.equal(fs.readFileSync(path.join(target, 'secrets.json'), 'utf8'), '{"fixture":"PRIVATE_SENTINEL"}');
assert.equal(fs.readFileSync(path.join(target, 'data/history-fixture.json'), 'utf8'), 'user history');
console.log('PASS：卸载程序文件，默认保留配置与历史');
console.log('隔离模式未注册真实任务/协议；系统集成和原生选择器仍需另行实机验收。');
