// 用记事本打开白名单里的配置文件（供看板「配置」面板调用）
//
//   node 程序/tools/open-config-file.mjs secrets   # 打开 secrets.json（不存在就按模板创建）
//   node 程序/tools/open-config-file.mjs config    # 打开 config.json（不存在就从模板复制）
//
// 为什么要有它：看板是 file:// 页面，自己写不了文件；而让不懂技术的用户去"找到项目目录、
// 新建一个 json 文件、写上正确的花括号"是劝退级操作。这里给一个点了就能编辑的入口。
//
// 安全：只认白名单里的**固定文件名**，不接受任意路径（否则就成了任意文件打开器）；
//       密钥文件由本机用户自己编辑，不经过命令行参数，也就不存在"密钥进进程命令行"的泄漏面。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CONFIG_FILE, ROOT_DIR, SECRETS_FILE } from '../lib/common.mjs';

const name = (process.argv[2] ?? '').trim().toLowerCase();

const TARGETS = {
  secrets: {
    file: SECRETS_FILE,
    label: '密钥文件 secrets.json',
    // 空串会被 validKey() 当作"未配置"，所以留空模板是安全的（不会拿空密钥去调接口）
    template: '{\n  "deepseek": "",\n  "glm": ""\n}\n',
    hint: '把密钥填在两个引号之间（例如 "deepseek": "sk-xxxxxxxx"），保存后即可。留空表示暂不启用该平台。',
  },
  config: {
    file: CONFIG_FILE,
    label: '配置文件 config.json',
    template: null,   // 从 config.template.json 复制
    hint: 'platforms 段控制启用哪些平台；thresholds 是提醒阈值。改完保存即可，下一次采集生效。',
  },
};

const t = TARGETS[name];
if (!t) {
  console.log(`未知的配置项：${name || '(空)'}（可用：${Object.keys(TARGETS).join(' / ')}）`);
  process.exit(1);
}

let created = false;
if (!fs.existsSync(t.file)) {
  const body = t.template ?? fs.readFileSync(path.join(ROOT_DIR, 'config.template.json'), 'utf8');
  fs.writeFileSync(t.file, body);
  created = true;
}

console.log(`${new Date().toISOString()} 打开${t.label}${created ? '（已按模板新建）' : ''}：${t.file}`);
if (created) console.log(`提示：${t.hint}`);

// detached + unref：记事本独立于采集进程存在，本进程可以立刻退出
try {
  const p = spawn('notepad.exe', [t.file], { detached: true, stdio: 'ignore' });
  p.unref();
} catch (e) {
  // 记事本拉不起来时至少把路径打出来，用户还能自己找过去
  console.log(`无法自动打开编辑器（${String(e.message).slice(0, 80)}），请手动打开：${t.file}`);
  process.exit(1);
}
