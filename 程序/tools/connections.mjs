import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { ROOT_DIR } from '../lib/common.mjs';

const root = ROOT_DIR;                       // 项目根（config.json / secrets.json / data 那一层）
const CODE = path.join(root, '程序');         // 程序代码目录：tools\ 以及各 .mjs 都在这里
const names = ['codex', 'deepseek', 'glm'];
function readObject(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw 0;
    return value;
  } catch { throw new Error('已有设置无法读取，请先修复或恢复备份；未覆盖原文件。'); }
}
function atomic(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  try { fs.writeFileSync(temp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function saveConnections(directory, input) {
  if (!input || !input.platforms || names.some(n => typeof input.platforms[n] !== 'boolean')) throw new Error('请选择要连接的平台。');
  if (Object.keys(input.platforms).some(n => !names.includes(n))) throw new Error('不支持的平台。');
  const keys = input.keys ?? {};
  if (Object.keys(keys).some(n => !['deepseek', 'glm'].includes(n))) throw new Error('不支持的密钥类型。');
  for (const key of Object.values(keys)) {
    if (typeof key !== 'string' || key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error('密钥格式不正确，请重新粘贴。');
  }
  const configFile = path.join(directory, 'config.json');
  const secretsFile = path.join(directory, 'secrets.json');
  // Validate both existing files before any write; blank inputs preserve existing credentials.
  const config = readObject(configFile), secrets = readObject(secretsFile);
  let changed = false;
  for (const n of ['deepseek', 'glm']) if (keys[n]?.trim()) { secrets[n] = keys[n].trim(); changed = true; }
  const previous = fs.existsSync(secretsFile) ? fs.readFileSync(secretsFile) : null;
  if (changed) atomic(secretsFile, secrets);
  try { atomic(configFile, { ...config, platforms: { ...config.platforms, ...input.platforms } }); }
  catch (error) {
    if (changed) {
      if (previous === null) fs.unlinkSync(secretsFile);
      else atomic(secretsFile, JSON.parse(previous.toString('utf8')));
    }
    throw error;
  }
}

function run(script, args = [], timeout = 120000) {
  execFileSync(process.execPath, [path.join(CODE, script), ...args], { cwd: root, timeout, windowsHide: true, stdio: 'ignore' });
}
async function main() {
  if (process.argv.includes('--save')) {
    let body = '';
    for await (const chunk of process.stdin) { body += chunk; if (body.length > 20000) throw new Error('输入过长。'); }
    saveConnections(root, JSON.parse(body));
    body = '';
    const development = fs.existsSync(path.join(root, '.git'));
    let automatic = false, collected = false;
    if (!development) { try { run('tools/install.mjs', ['--skip-verify']); automatic = true; } catch {} }
    try { run('collect.mjs', ['--all'], 90000); collected = true; } catch {}
    const state = readObject(path.join(root, 'data/state.json'));
    const lines = names.map(n => {
      const r = state.current?.[n];
      return `${n === 'glm' ? 'GLM' : n === 'codex' ? 'Codex' : 'DeepSeek'}：${!collected ? '验证未完成，请重试' : r?.disabled ? '未启用' : r?.ok ? (r.degraded ? '使用本地记录，实时连接待恢复' : '已连接') : r?.unconfigured ? (n === 'codex' ? '请先在 Codex 登录' : '请补充密钥') : '未连接，请检查账号、密钥或网络后重试'}`;
    });
    try { run('tools/setup-check.mjs'); } catch {}
    lines.push(development ? '开发预览：未注册后台任务。日常使用请安装发布包。' : automatic ? '自动采集已开启，可返回看板。' : '设置已保存，但自动采集未开启，请重试。');
    process.stdout.write(lines.join('\n'));
  } else {
    run('tools/setup-check.mjs');
    const env = { ...process.env }; delete env.PSModulePath;
    execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(CODE, 'tools/connections.ps1'), '-NodeExe', process.execPath], { env, windowsHide: true, stdio: 'ignore' });
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch { process.stdout.write('未完成连接。已有设置可能无法读取，或保存失败；请检查后重试。'); process.exitCode = 1; }
}
