import path from 'node:path';
import { stopOwned } from './windows-integration.mjs';
const root = path.dirname(import.meta.dirname);
try {
  stopOwned(root, { remove: true, isolated: process.argv.includes('--isolated') });
  console.log('后台采集、托盘、自启和按钮注册已清理；历史与配置已保留。');
} catch { console.error('卸载未完全完成，请关闭看板后重试。'); process.exitCode = 1; }
