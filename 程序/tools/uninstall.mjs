// 卸载：① 清理系统集成（计划任务、托盘、自启、按钮注册）；② 用户选了「连同数据一起删除」时，
// 先把数据备份到安装目录之外 —— **备份成功才允许删**（判定在 installer.iss，见下面的退出码）。
//
// 2026-09-20：这条备份路径是一场事故逼出来的。用户手动卸载 1.3.0 时，安装器问的是
// 「是否同时删除配置、密钥、历史记录及备份？」：那是个反向提问，而删除分支的 DelTree 连
// backups/ 一起删 —— 他按了「是」，11 天历史连最后一条退路都没了。现在改成：
//   ① 提问不带「是否」歧义，默认落在「保留」这一侧（installer.iss 的 AskUserData）；
//   ② 真要删，也必须先有一份 zip 落在安装目录之外，解压就能把历史原样取回来。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT_DIR } from '../lib/common.mjs';
import { powershell, psQuote, stopOwned } from './windows-integration.mjs';

// 用户数据 = 卸载时会被删掉的那几项，与 installer.iss 的删除分支同一份清单（测试会把两边对一遍）。
// 这里也是**备份范围**：删什么就先备什么，一个都不能漏（漏一项 = 那一项真的没了）。
export const 用户数据 = ['data', 'backups', 'config.json', 'secrets.json', 'dashboard-data.js', 'update-data.js'];

// 备份落点：安装目录之外、卸载与升级都不碰的固定目录。名字固定且纯 ASCII，因为
// installer.iss 要在卸载完成的提示里把它原样念给用户听（两边的路径必须对得上）。
export const 备份目录名 = 'AICapabilityBoard-backups';
export function 备份目录(环境 = process.env) {
  // 读不到 LOCALAPPDATA 时**不猜**别的目录：installer.iss 念的是 {localappdata}\AICapabilityBoard-backups，
  // 悄悄换个地方就等于把备份放进了用户找不到的角落。宁可备份失败（于是不删）。
  if (!环境.LOCALAPPDATA) throw new Error('读不到 LOCALAPPDATA，无法确定备份放在哪里');
  return path.join(环境.LOCALAPPDATA, 备份目录名);
}

// 退出码是给 installer.iss 看的唯一接口（Inno 里对应 BR_OK / BR_EMPTY / BR_FAILED）。
export const 退出码 = { 可以删: 0, 备份失败: 10, 没有数据: 20 };

const stamp = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  // 秒也要：卸载备份是一次性产物、不轮转，同分钟内两次打包（比如紧跟着又卸一次）
  // 会以同名覆盖掉前一份 —— 备份覆盖备份是最不该出现的事。
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// 递归数文件：**不要用 fs.rmSync/cpSync 那类递归 API** —— Node v24 在中文路径下会原生崩溃
// （见 backup.mjs 里的记录）。逐层 lstat 是已验证安全的做法。
function 数文件(p) {
  const st = fs.lstatSync(p);
  if (st.isDirectory()) return fs.readdirSync(p).reduce((n, name) => n + 数文件(path.join(p, name)), 0);
  return st.isFile() ? 1 : 0;
}

// 只读地打开 zip，回报条目名 + 有没有带历史记录（备份的全部意义就在 history）。
function 读zip(zip) {
  const 输出 = powershell(`Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead(${psQuote(zip)})
try { $z.Entries | ForEach-Object { $_.FullName } } finally { $z.Dispose() }`);
  // 条目名先统一成正斜杠再判：实测 Compress-Archive 在 Windows PowerShell 5.1 下写出来的是反斜杠，
  // 拿反斜杠的名字去比会把一份好备份误判成「没带历史」——那用户就永远删不掉数据（安全但不通）。
  const 条目 = 输出.split(/\r?\n/).map(s => s.trim().replace(/\\/g, '/')).filter(Boolean);
  if (!条目.length) throw new Error('备份读不出来（zip 打不开或里面是空的）');
  return { 条目, 含历史: 条目.some(name => name.startsWith('data/history/')) };
}

// 把用户数据打包成安装目录之外的一份 zip。**不删任何东西** —— 删不删由 installer.iss 决定：
// 本函数正常返回 = 可以删；抛异常 = 备份没做成，调用方必须放弃删除。
// 返回 { zip, 文件数, 条目, 含历史 }；本来就没有数据时 zip 为 null（不用备份，也没什么可删）。
export function 备份用户数据(root = ROOT_DIR, { 输出目录 = 备份目录(), 时间 = new Date() } = {}) {
  const 源 = 用户数据.map(rel => path.join(root, ...rel.split('/'))).filter(p => fs.existsSync(p));
  if (!源.length) return { zip: null, 文件数: 0, 条目: 0, 含历史: false };
  fs.mkdirSync(输出目录, { recursive: true });
  const zip = path.join(输出目录, `${备份目录名}-${stamp(时间)}.zip`);
  const 文件数 = 源.reduce((n, p) => n + 数文件(p), 0);
  // 与 backup.mjs 同一套打包方式（项目里已验证可用）：Compress-Archive 逐条收进去
  powershell(`$ProgressPreference='SilentlyContinue'
Compress-Archive -LiteralPath @(${源.map(psQuote).join(',')}) -DestinationPath ${psQuote(zip)} -Force`);
  // 打包没报错 ≠ 备份完整：条目数必须与源文件数逐个对上，源里有 history 就必须在 zip 里也有。
  // 对不上就当备份失败 —— 宁可不删，也不能拿一份半截 zip 换掉用户的全部历史。
  const { 条目, 含历史 } = 读zip(zip);
  const 历史目录 = path.join(root, 'data', 'history');
  const 源含历史 = fs.existsSync(历史目录) && fs.readdirSync(历史目录).length > 0;
  if (条目.length < 文件数 || (源含历史 && !含历史)) {
    throw new Error(`备份不完整（源 ${文件数} 个文件，zip 里 ${条目.length} 个条目${源含历史 && !含历史 ? '，且没有历史记录' : ''}）`);
  }
  return { zip, 文件数, 条目: 条目.length, 含历史 };
}

// 入口守卫：本模块会被测试 import，导入时绝不能顺手清理真实安装的系统集成
// （那是 stopOwned(remove) 干的事）。只有被当作脚本直接执行时才动。
const 是脚本入口 = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (是脚本入口) {
  const root = ROOT_DIR;                     // 项目根
  if (process.argv.includes('--backup-user-data')) {
    try {
      const r = 备份用户数据(root);
      if (!r.zip) { console.log('没有需要保留的数据。'); process.exitCode = 退出码.没有数据; }
      else console.log(`卸载前备份完成：${r.zip}（${r.文件数} 个文件，zip 内 ${r.条目} 个条目）`);
    } catch (e) {
      console.error(`卸载前备份未完成，安装器会保留数据：${String(e.message ?? e).slice(0, 200)}`);
      process.exitCode = 退出码.备份失败;
    }
  } else {
    try {
      stopOwned(root, { remove: true, isolated: process.argv.includes('--isolated') });
      console.log('后台采集、托盘、自启和按钮注册已清理；历史与配置已保留。');
    } catch { console.error('卸载未完全完成，请关闭看板后重试卸载。'); process.exitCode = 1; }
  }
}
