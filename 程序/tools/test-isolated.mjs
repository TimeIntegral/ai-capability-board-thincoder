// Run the legacy suites only in a fresh copy, never alongside real collection files.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT_DIR } from '../lib/common.mjs';
const root = ROOT_DIR;                       // 项目根（git ls-files / private 在那一层）
const target = path.join(root, 'private', `regression-${Date.now()}`);
fs.mkdirSync(target, { recursive: true });
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root }).toString('utf8').split('\0').filter(Boolean);
for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) continue;
  const dest = path.join(target, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(root, file), dest);
}
const cfg = JSON.parse(fs.readFileSync(path.join(target, 'config.template.json')));
cfg.codexHome = path.join(target, 'missing-codex'); cfg.thinCoderConfig = path.join(target, 'missing-thincoder.json');
cfg.platforms = { codex: false, deepseek: false, glm: false };
fs.writeFileSync(path.join(target, 'config.json'), JSON.stringify(cfg));
fs.mkdirSync(path.join(target, 'data/history'), { recursive: true });
// Read-only snapshot of history for the existing replay assertions; kept in private/.
const history = path.join(root, 'data/history');
if (fs.existsSync(history)) for (const file of fs.readdirSync(history).filter(f => f.endsWith('.jsonl'))) {
  fs.copyFileSync(path.join(history, file), path.join(target, 'data/history', file));
}
const env = { ...process.env }; delete env.PSModulePath;
const suites = ['test-rules.mjs', 'test-dashboard.mjs'];
let failures = 0;
for (const suite of suites) {
  const log = path.join(target, `${suite}.log`);
  try {
    const out = execFileSync(process.execPath, [path.join(target, '程序', 'tools', suite)], { cwd: target, env, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
    fs.writeFileSync(log, out); console.log(`${suite}: PASS\n${out.split('\n').slice(-7).join('\n')}`);
  } catch (e) { failures++; fs.writeFileSync(log, String(e.stdout ?? '') + String(e.stderr ?? '')); console.log(`${suite}: FAIL（查看独立副本日志）`); }
}
console.log(`独立验证记录：${target}`);
process.exitCode = failures ? 1 : 0;
