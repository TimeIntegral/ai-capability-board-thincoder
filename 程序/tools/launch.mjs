import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { powershell, psQuote } from './windows-integration.mjs';
import { ROOT_DIR } from '../lib/common.mjs';

const root = ROOT_DIR;                       // 项目根（dashboard.html / config.json / data 那一层）
const CODE = path.join(root, '程序');         // 程序代码目录（tools\ 以及各 .mjs 都在这里）
fs.mkdirSync(path.join(root, 'data'), { recursive: true });
// Install only explicit first-run metadata. Existing user files are untouched.
if (!fs.existsSync(path.join(root, 'config.json'))) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ platforms: { codex: false, deepseek: false, glm: false } }, null, 2));
}
try {
  execFileSync(process.execPath, [path.join(CODE, 'tools/setup-check.mjs')], { windowsHide: true, timeout: 30000, stdio: 'ignore' });
  const p = spawn(process.execPath, [path.join(CODE, 'tools/update.mjs'), 'auto'], { detached: true, windowsHide: true, stdio: 'ignore' });
  p.on('error', () => {}); p.unref();
  const target = pathToFileURL(path.join(root, 'dashboard.html')).href;
  powershell(`Start-Process ${psQuote(target)}`);
} catch { process.exitCode = 1; }
