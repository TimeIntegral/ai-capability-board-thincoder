// 三层文件模型 —— 这是中间那层「发布层」的正列举清单（说明表见 release/README.md）。
//
//   L1 开发层 = 仓库里 git 跟踪的一切                （开发需要什么就有什么，默认不进包）
//   L2 发布层 = 本文件正列举出来的文件               （= 便携 ZIP 的内容 = 用户拿到的东西）
//   L3 安装层 = L2 + 安装时注入的文件                （= 用户机器上装完的最终形态）
//
// 为什么是白名单，而不是「全部减去黑名单」：排除清单会随着仓库新增文件**静默放行**。
// 2026-09-17 用户就是打开自己的安装目录看见 `.github\`（GitHub 的 issue 模板）才发现这件事的 ——
// 那时候的清单直接取 git ls-files，于是开发文档、构建脚本、AI 协作说明全跟着装进了用户机器。
// 白名单把方向反过来：**这里没列的文件，永远不进用户包**。新增文件两边都没归类时，
// 闸门不是"少装一个"，而是**直接停下**要人做决定（见 分类()）—— 默认拒绝，不猜。
//
// 谁读这份清单：
//   · release/publish.mjs        —— 打包（L2 进 ZIP；审计仍然覆盖整个 L1）
//   · release/build-installer.mjs —— 推导 L3 安装清单 + 生成安装器的文件清单
//   · 程序/tools/test-publish-files.mjs —— 把下面三条规矩钉成契约
//
// 三条规矩（测试逐条断言）：
//   ① 「发布层」每一条都必须在仓库里真实存在 —— 少了就是产物缺件，闸门拒绝；
//   ② L1 的每个文件要么在「发布层」、要么在「仅开发层」—— 未分类 = 停下，不许默默漏掉；
//   ③ 包内引用自洽 —— 包内 .mjs 的相对 import、.vbs/.bat 调用的程序脚本，都必须在包里
//      （这条防的是"分类分错了"：清单齐全但某个运行时文件被误归为开发件，产品在用户机上才会坏）。
import path from 'node:path';

// ── L2 发布层：进用户包的东西 ───────────────────────────────────────────────
// 条目写法：['路径', '为什么给用户']，或直接 '路径'（沿用上面那组注释的理由）。
// 路径以 / 分隔、相对仓库根；以 / 结尾 = 该目录下所有文件；含 * = 这一层内的通配。
// 加文件 = 在这里加一行；删文件 = 删那一行。**没加 = 不进包。**
export const 发布层 = [
  // ── 产品身份：用户一眼看到的门面 ──
  ['VERSION', '版本号：看板、更新检查、安装器都读它'],
  ['LICENSE', 'AGPL-3.0 全文：随包分发是许可要求，安装向导拿它当许可页'],
  ['icon.ico', '桌面快捷方式、安装列表、卸载列表的图标'],
  ['icon.svg', '图标源文件：icon.ico 缺失时 install.mjs 会用它重新生成'],
  ['dashboard.html', '看板页面本体'],
  ['config.template.json', '配置模板：首次生成 config.json、看板里改配置都读它'],
  ['先看我.txt', '安装目录里的第一份说明（用户打开文件夹先看到它）'],
  ['README.md', '项目说明：功能、口径、排错（也是对外门面）'],

  // ── 用户脚本：双击就能用的入口 ──
  ['快捷操作/启动看板.vbs', '打开看板；桌面快捷方式指向它'],
  ['快捷操作/连接平台.vbs', '第一次使用：选平台、填密钥'],
  ['快捷操作/启用自动采集.vbs', '注册后台自动采集（含中文提示的退化载荷）'],
  ['快捷操作/立即采集一次.vbs', '立即采集一次；计划任务也调它'],
  ['快捷操作/托盘图标.vbs', '任务栏托盘图标；开机自启指向它'],
  ['快捷操作/安装定时任务.bat', '一条命令重装/修复（调 程序/tools/install.mjs）'],
  ['快捷操作/卸载定时任务.bat', '彻底关掉自动采集（保留配置与历史）'],

  // ── 前端资源与 README 配图（前者由 dashboard.html 与「帮助与反馈」面板读取）──
  ['assets/product-info.js', '窗口全局 BOARD_PRODUCT：版本与渠道地址'],
  ['assets/support.js', '「帮助与反馈」面板'],
  // README 里引用的截图（页面不读它们，只有 README.md 引用）：README.md 在包里，图也得在包里，
  // 否则用户打开说明只能看见三条坏链接
  ['assets/dashboard-main.png', 'README「它长什么样」：主界面（三家额度同屏与用量趋势）'],
  ['assets/dashboard-history.png', 'README「它长什么样」：每日热力图（本地长期历史）'],
  ['assets/dashboard-attribution.png', 'README「它长什么样」：额度去向（按项目聚合的 token 用量）'],

  // ── 程序入口（计划任务、快捷操作、协议按钮调的就是这几个）──
  ['程序/collect.mjs', '采集入口：计划任务每次跑的就是它'],
  ['程序/mute.mjs', '临时静音（看板静音按钮经协议调用）'],
  ['程序/balance-mute.mjs', '按平台关闭余额提醒（「不再提醒」按钮经协议调用）'],
  ['程序/运行协议.vbs', 'aiquotaboard:// 协议处理器：看板与通知上的按钮都经它执行'],

  // ── 程序库与采集器 ──
  '程序/lib/common.mjs',
  '程序/lib/updates.mjs',
  '程序/collectors/codex.mjs',
  '程序/collectors/codex-fallback.mjs',
  '程序/collectors/deepseek.mjs',
  '程序/collectors/glm.mjs',
  '程序/alert/rules.mjs',
  '程序/alert/notify.mjs',
  ['程序/channels.json', '发布渠道地址（公开仓库、社区页）：检查更新时读它'],

  // ── 程序工具：安装、更新、升级、卸载与看板按钮的执行端 ──
  ['程序/tools/attribution.mjs', '额度归因：采集时调用，也可单独跑'],
  ['程序/tools/backup.mjs', '一键备份：打包历史与配置（命令行调用）'],
  ['程序/tools/build-dashboard-data.mjs', '生成 dashboard-data.js（采集后调用）'],
  ['程序/tools/connections.mjs', '本机连接窗口：接收并保存密钥'],
  ['程序/tools/connections.ps1', '连接窗口的原生表单（connections.mjs 调用）'],
  ['程序/tools/edit-config.mjs', '看板「配置」的执行端（白名单校验后写 config.json）'],
  ['程序/tools/first-run-check.mjs', '装完试采一次并给出下一步（install.mjs 收尾调用）'],
  ['程序/tools/install.mjs', '一键安装/修复：计划任务、图标、快捷方式、通知名、协议、托盘；顺带清掉旧版遗留'],
  ['程序/tools/install-legacy.mjs', '旧版遗留清单与清理逻辑（安装时调用）：升级后用户目录里不该留的东西靠它清掉'],
  ['程序/tools/launch.mjs', '打开看板前的收尾（启动看板.vbs 调用）'],
  ['程序/tools/make-icon.mjs', '缺 icon.ico 时按 icon.svg 生成（install.mjs 调用）'],
  ['程序/tools/open-config-file.mjs', '打开 config.json / secrets.json（协议按钮）'],
  ['程序/tools/open-path.mjs', '「打开文件夹」执行端（白名单校验）'],
  ['程序/tools/open-tc.mjs', '「启动 ThinCoder」执行端（白名单校验）'],
  ['程序/tools/register-app-id.mjs', '注册通知应用名（install.mjs 调用）'],
  ['程序/tools/register-protocol.mjs', '注册 aiquotaboard:// 协议（install.mjs 调用）'],
  ['程序/tools/set-task-interval.mjs', '按配置同步计划任务触发间隔（README 里给了用户）'],
  ['程序/tools/setup-check.mjs', '环境探测：平台有没有配好、密钥从哪来'],
  ['程序/tools/setup-notify.mjs', '首次启用的中文完成提示（启用自动采集.vbs 调用）'],
  ['程序/tools/tray.ps1', '托盘常驻脚本（托盘图标.vbs 调用）'],
  ['程序/tools/uninstall.mjs', '卸载清理：停掉后台、注销任务与协议，用户数据默认保留'],
  ['程序/tools/update.mjs', '检查更新与「跳过该版本」（看板「检查更新」、跳过按钮与启动时自动检查）'],
  ['程序/tools/upgrade-lifecycle.mjs', '升级前备份、失败回滚（安装器调用）'],
  ['程序/tools/windows-integration.mjs', '系统集成公共库：计划任务、快捷方式、托盘进程收口'],

  // ── 许可与用户文档（docs/ 里只留这两份）──
  ['docs/NODE-LICENSE.txt', '便携 Node 运行时的官方许可证：随包分发必须带（合规）'],
  ['docs/community.md', '用户群与反馈页：看板「帮助与反馈」链到它'],
];

// ── L1 仅开发层：明确「只在仓库里有意义」的东西 ─────────────────────────────
// 这份清单不是为了打包（打包只看 发布层），而是为了让 分类() 能回答
// 「L1 里每个文件都归好类了吗」。漏在这份清单之外的新文件 = 停下来做决定。
export const 仅供开发 = [
  // ── 仓库 / GitHub / AI 协作产物 ──
  ['.github/', 'GitHub 的 issue 模板：只有仓库页需要'],
  ['.gitignore', 'git 自己的忽略规则'],
  ['AGENTS.md', '给 AI 代理看的开发约定'],
  ['CHANGELOG.md', '改动历史（技术决策与踩坑记录）：在 GitHub 上读；用户看更新说明走看板里的「检查更新」'],
  // ── 开发文档：写给维护者的 ──
  ['docs/TODO.md', '待办与已知缺口台账'],
  ['docs/batches/', '批次档：每个批次做了什么、怎么验收的'],
  ['docs/design/', '设计档：需求与设计决策'],
  ['docs/requirements/', '需求档'],
  ['docs/连接与发布隔离.md', '连接窗口与发布隔离的设计说明'],
  // ── 发布/构建工具链：只有构建机需要 ──
  ['release/', '发布工具（审计、打包、构建安装器、便携运行时下载）：构建机专用'],
  // ── 测试与维护脚本：源码仓里跑，用户机器上用不到 ──
  ['程序/tools/test-*.mjs', '自动化测试（发布流水线在冻结的工作区里跑它们）'],
  ['程序/tools/rename-project.mjs', '维护者工具：改名项目文件夹（用户用不到）'],
];

// ── L3 安装时注入：不在 ZIP 里，由安装器写进安装目录 ───────────────────────
// 安装清单的路径是「安装层」的一个稳定接口：安装器写它、升级器读它、卸载清理由它把关。
export const 安装清单路径 = '程序/installed-files.json';
export const 安装时注入 = [
  [安装清单路径, '本机安装清单（这份安装包含哪些文件）：卸载与升级回滚靠它，安装器写入'],
];

// ── 构建时加入发布包的东西（不在 L1 里，所以不进上面的清单）──────────────────
// 它们由 release/publish.mjs 在打包时直接放进 ZIP，不在 git 清单里、也不做逐行审计，
// 改为按来源核对（见 release/portable-node.json）。安装后它们同样要留在用户机器上（L3）。
export const 运行时目录 = 'runtime/';
export const 构建时加入 = [
  [运行时目录, '便携 Node 运行时 node.exe：没装 Node 的用户靠它「解压即用」，安装后由卸载器/升级器按它收口'],
];

// ── 清单工具 ────────────────────────────────────────────────────────────────
const 规范化 = 条目 => (Array.isArray(条目) ? { 路径: 条目[0], 理由: 条目[1] ?? '' } : { 路径: 条目, 理由: '' });

// 条目 → 正则：`/` 结尾 = 目录前缀；`*` = 这一层内的通配（不跨 `/`）。
const 转正则 = 条目 => {
  const 路径 = 规范化(条目).路径;
  const 主体 = 路径.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${主体}${路径.endsWith('/') ? '' : '$'}`);
};

const 命中 = (条目表, rel) => 条目表.find(e => 转正则(e).test(rel));

// 把 L1 的全部文件分成三类，并报出「清单失效」（条目一条都没匹配到）的情况。
// 返回值里的 发布 / 仅开发 就是分类结果；未分类 与 冲突 非空时必须停下（调用方决定怎么报）。
export function 分类(files) {
  const 发布 = [];
  const 仅开发 = [];
  const 未分类 = [];
  const 冲突 = [];
  for (const rel of files) {
    const 是发布 = 命中(发布层, rel);
    const 是开发 = 命中(仅供开发, rel);
    if (是发布 && 是开发) 冲突.push(rel);
    else if (是发布) 发布.push(rel);
    else if (是开发) 仅开发.push(rel);
    else 未分类.push(rel);
  }
  const 失效 = (表, 结果) => 表.filter(e => !结果.some(f => 转正则(e).test(f))).map(e => 规范化(e).路径);
  return {
    发布: 发布.sort(),
    仅开发: 仅开发.sort(),
    未分类: 未分类.sort(),
    冲突: 冲突.sort(),
    失效发布: 失效(发布层, 发布),        // 发布层里对不上任何文件的条目 = 产物缺件（硬错）
    失效开发: 失效(仅供开发, 仅开发),      // 仅开发层里对不上任何文件的条目 = 清单过期（只提示）
  };
}

// L3 = L2 + 安装时注入。安装器只装这一份清单里的东西（不再 glob 整个 stage）。
export function 推导安装清单(发布文件) {
  return [...new Set([...发布文件, ...安装时注入.map(e => 规范化(e).路径)])].sort();
}

// build-installer.mjs 的接缝：拿 stage 里**实际解压出来的文件**，
// 分成「来自仓库的发布件 / 构建时加入的运行时 / 安装器注入的文件」，并给出 L3 安装清单。
// 任何一边多一个少一个都要被调用方挡下（不对 非空 = 产物与清单脱钩）。
export function 从stage推导(stage文件) {
  const 构建时前缀 = 构建时加入.map(e => 规范化(e).路径);
  const 注入路径 = new Set(安装时注入.map(e => 规范化(e).路径));
  const 构建时 = stage文件.filter(rel => 构建时前缀.some(p => rel === p || rel.startsWith(p)));
  // 注入项与运行时都不是仓库文件，不参与 L1/L2 分类。
  const 仓库件 = stage文件.filter(rel => !构建时.includes(rel) && !注入路径.has(rel));
  const 分层 = 分类(仓库件);
  return {
    分层,
    构建时,
    安装清单: 推导安装清单([...分层.发布, ...构建时, ...注入路径]),
    不对: [...分层.未分类, ...分层.仅开发, ...分层.冲突, ...分层.失效发布].sort(),
  };
}

// 生成 Inno Setup 的文件清单（build-installer.mjs 写文件，installer.iss 用 #include 读它）。
// 为什么不继续用 `Source: "{#StageDir}\*"` 全装：那样 stage 里**任何**东西都会被装进用户机器，
// 清单就管不住安装层了。逐条列出后，安装层与发布层是同一份事实。
export function 渲染安装器文件列表(安装清单) {
  const 头 = [
    '; 本文件由 release/build-installer.mjs 生成，请勿手改 —— 改清单请改 release/publish-files.mjs。',
    '; 每一条对应一个安装文件（L3 = 发布层 + 安装时注入），安装器只装这些，别的一概不装。',
  ];
  const 行 = 安装清单.map(rel => {
    if (/["\r\n;{}]/.test(rel)) throw new Error(`安装清单里的路径带 Inno 会误解析的字符（" ; { } 或换行）：${rel}`);
    const 反斜杠 = rel.replace(/\//g, '\\');
    const 目录 = 反斜杠.includes('\\') ? `\\${反斜杠.slice(0, 反斜杠.lastIndexOf('\\'))}` : '';
    return `Source: "{#StageDir}\\${反斜杠}"; DestDir: "{app}${目录}"; Flags: ignoreversion`;
  });
  return `${头.join('\n')}\n${行.join('\n')}\n`;
}

// 包内引用自洽检查（规矩 ③）。读文本由调用方提供（模块本身不碰磁盘，方便测试喂假数据）。
//   ① .mjs / .js 的相对 import：精确解析到仓库相对路径，必须在发布层里；
//   ② .vbs / .bat 里按名字调用的 .mjs / .ps1：按文件名找 —— 包里有同名文件即算通过。
// 提到了「仅开发层」路径的（例如某个 .bat 的提示文字里写着 release\make-portable.mjs）不算：
// 那是开发路径的说明文字，不是用户机器上的调用。
export function 检查悬空引用(读文本, 发布文件) {
  const 集合 = new Set(发布文件);
  const 文件名集合 = new Set(发布文件.map(rel => rel.slice(rel.lastIndexOf('/') + 1)));
  // 提到「仅开发层」路径的引用不算悬空：那是开发路径的说明文字（例如 安装定时任务.bat 的提示里
  // 写着 release\make-portable.mjs），不是用户机器上的调用。
  const 是开发路径 = ref => { const 归一 = ref.replace(/\\/g, '/').replace(/^\.\//, ''); return 仅供开发.some(e => 转正则(e).test(归一)); };
  const 问题 = [];
  const 记 = (rel, 引用) => { if (!问题.some(p => p.文件 === rel && p.引用 === 引用)) 问题.push({ 文件: rel, 引用 }); };
  for (const rel of 发布文件) {
    const 扩展 = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
    if (!['mjs', 'js', 'vbs', 'bat', 'ps1'].includes(扩展)) continue;
    const 文本 = 读文本(rel);
    if (typeof 文本 !== 'string') continue;
    if (扩展 === 'mjs' || 扩展 === 'js') {
      // ① 相对 import：精确解析成仓库相对路径
      for (const m of 文本.matchAll(/(?:from|import|import\()\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
        const 目标 = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
        if (!集合.has(目标)) 记(rel, 目标);
      }
    }
    if (扩展 === 'mjs' || 扩展 === 'js' || 扩展 === 'ps1') {
      // ③ 代码里按文件名点名的脚本（execFileSync(NODE, [path.join(dirname, 'make-icon.mjs')]) 这类不是 import
      //    语句，走不到 ①）：带引号字面量里的 .mjs / .ps1 文件名必须在包里。
      for (const m of 文本.matchAll(/['"]([^'"\s]*\.(?:mjs|ps1))['"]/g)) {
        const 引用 = m[1];
        if (引用.startsWith('.')) continue;                      // 相对路径归规则 ①，不重复报
        if (/[$%&{}]/.test(引用)) continue;                     // 拼接出来的路径，静态看不出，不管
        const 名 = 引用.split(/[\\/]/).pop();
        if (文件名集合.has(名)) continue;
        if (是开发路径(引用) || 是开发路径(`程序/tools/${名}`)) continue;
        记(rel, 引用);
      }
    }
    if (扩展 === 'vbs' || 扩展 === 'bat') {
      // ② 脚本里按路径调用的程序文件：脚本自己拼目录（prog & "\tools\x.mjs"），所以按文件名核对 ——
      //    包里有同名文件即算通过；对不上的再确认一次是不是开发路径的说明文字。
      for (const m of 文本.matchAll(/([A-Za-z0-9_.\u4e00-\u9fa5-]+(?:[\\/][A-Za-z0-9_.\u4e00-\u9fa5-]+)*\.(?:mjs|ps1))/g)) {
        const 引用 = m[1];
        if (文件名集合.has(引用.split(/[\\/]/).pop())) continue;
        if (是开发路径(引用)) continue;
        记(rel, 引用);
      }
    }
  }
  return 问题;
}

// ── 自检：清单自身写坏了要立刻报错（import 到这里的人不该拿到一份坏表）────────
for (const [名字, 表] of [['发布层', 发布层], ['仅供开发', 仅供开发], ['安装时注入', 安装时注入]]) {
  const 见过 = new Set();
  for (const e of 表) {
    const { 路径 } = 规范化(e);
    if (!路径) throw new Error(`发布清单里有一条空路径（${名字}）`);
    if (路径.startsWith('/') || 路径.includes('..')) throw new Error(`发布清单里的路径必须是仓库相对路径、且不许含 ..：${路径}（${名字}）`);
    if (见过.has(路径)) throw new Error(`发布清单里重复的条目：${路径}（${名字}）`);
    见过.add(路径);
  }
}
