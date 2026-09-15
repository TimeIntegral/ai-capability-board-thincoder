// 中文完成提示：静默安装脚本「启用自动采集.vbs」的正常路径调用它弹结果框
// 用法：node tools/setup-notify.mjs --ok        （安装完成）
//       node tools/setup-notify.mjs --fail      （有步骤没成功）
//       node tools/setup-notify.mjs --emit-b64  （打印三段载荷，供 启用自动采集.vbs 内嵌；零副作用、不弹框）
//
// 为什么有这个文件：.vbs 必须保持纯 ASCII（Windows 脚本宿主按 GBK 读，中文会吞换行），
// 而用户裁定「完成提示必须中文、必须有」——中文写在这里（UTF-8 正常），
// 弹框走 PowerShell -EncodedCommand（UTF-16LE base64，与 tools/install.mjs 的 ps() 同法），中文零编码风险、零新依赖。
// 本文件是三态文案的唯一源（成功 / 失败 / 守卫）：.vbs 内嵌载荷由 --emit-b64 生成（同源同文案）。
import { execFileSync } from 'node:child_process';

const TITLE = 'AI 能力看板';
const TEXT = {
  ok: '自动采集已开启，设置也保存好了。\n\n回到看板点一下「重新检测」，就能看到采集结果；以后它会自己采，不用管。',
  fail: '自动采集没能完全装好（有步骤没成功）。\n\n设置已经保存；想看哪一步失败，双击项目里的「安装定时任务.bat」，或回看板重试一次。',
  noinstall: '没找到要用的安装脚本，这次没有开始安装。\n\n请把「启用自动采集.vbs」放回看板所在的文件夹里（和看板页面在一起），再双击一次。',
};

// 载荷生成 = 纯函数：作为模块被 import 时零副作用（不弹框），T39 直接断言各段载荷（成功 / 失败 / 守卫）
export function buildNotifyPayload(mode) {
  const text = TEXT[mode] ?? TEXT.fail;   // 未知状态不谎报成功
  const ps = `Add-Type -AssemblyName System.Windows.Forms\n[System.Windows.Forms.MessageBox]::Show('${text.replace(/'/g, "''")}', '${TITLE}') | Out-Null`;
  return Buffer.from(ps, 'utf16le').toString('base64');
}

function popup(b64) {
  execFileSync('powershell.exe', ['-NoProfile', '-EncodedCommand', b64], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 120000, windowsHide: true });
}

const arg = process.argv[2] ?? '';
if (process.argv[1] && process.argv[1].endsWith('setup-notify.mjs')) {
  if (arg === '--emit-b64') {
    console.log(`b64Ok = "${buildNotifyPayload('ok')}"`);
    console.log(`b64Fail = "${buildNotifyPayload('fail')}"`);
    console.log(`b64NoInstall = "${buildNotifyPayload('noinstall')}"`);
  } else if (arg === '--ok' || arg === '--fail') {
    try {
      popup(buildNotifyPayload(arg.slice(2)));   // 退出码 0 = 弹框链路已执行
    } catch (e) {
      console.error(`弹框失败：${String(e?.message ?? e).slice(0, 200)}`);
      process.exitCode = 1;                      // .vbs 据此走退化路径（弹自身内嵌载荷）
    }
  } else {
    console.error('用法：node tools/setup-notify.mjs --ok | --fail | --emit-b64');
    process.exitCode = 2;                        // 参数缺失/未知：不谎报成功
  }
}
