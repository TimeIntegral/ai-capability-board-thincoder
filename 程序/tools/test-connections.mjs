import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { saveConnections } from './connections.mjs';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-connections-'));
  t.after(() => {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('board-connections-')) throw new Error('unsafe fixture');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const platforms = { codex: true, deepseek: false, glm: false };
test('blank credentials preserve existing keys and unrelated settings', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ intervals: { codexMinutes: 9 } }));
  fs.writeFileSync(path.join(dir, 'secrets.json'), JSON.stringify({ deepseek: 'fixture', extra: 'keep' }));
  saveConnections(dir, { platforms, keys: { deepseek: '' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'))), { deepseek: 'fixture', extra: 'keep' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).intervals.codexMinutes, 9);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).platforms.glm, false);
});
test('invalid input and broken files do not overwrite existing files', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken');
  for (const input of [{ platforms, keys: { codex: 'bad' } }, { platforms, keys: { glm: 'bad\nvalue' } }, { platforms, keys: { glm: 'fixture' } }]) assert.throws(() => saveConnections(dir, input));
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), '{broken');
  assert.equal(fs.existsSync(path.join(dir, 'secrets.json')), false);
});
test('new keys saved locally without changing other provider', t => {
  const dir = fixture(t);
  saveConnections(dir, { platforms, keys: { glm: ' fixture ' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'secrets.json'))), { glm: 'fixture' });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['config.json', 'secrets.json']);
});

test('native window passes secrets only through stdin and clears input', { skip: process.platform !== 'win32' }, t => {
  const dir = fixture(t);
  // 夹具按真实目录结构布局：程序在 <dir>/程序/tools/ 下（connections.ps1 自己往上一级找项目根）
  const tools = path.join(dir, '程序', 'tools');
  fs.mkdirSync(tools, { recursive: true });
  fs.copyFileSync(path.join(import.meta.dirname, 'connections.ps1'), path.join(tools, 'connections.ps1'));
  fs.writeFileSync(path.join(tools, 'connections.mjs'), `let text=''; for await (const part of process.stdin) text+=part; const p=JSON.parse(text); if(process.argv.length!==3 || process.argv[2]!=='--save' || p.keys.deepseek!=='fixture-value' || p.platforms.deepseek!==true) process.exit(1); process.stdout.write('连接测试通过');`);
  const env = { ...process.env }; delete env.PSModulePath;
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(tools, 'connections.ps1'), '-NodeExe', process.execPath, '-PreviewPath', path.join(dir, 'preview.png'), '-SmokeTest'], { env, timeout: 25000, windowsHide: true, stdio: 'pipe' });
  assert.ok(fs.statSync(path.join(dir, 'preview.png')).size > 1000);
});
