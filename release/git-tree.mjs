// 「我现在站的这棵树是哪种树」—— 只回答这一个问题，发布链的三处闸门共用同一份判据。
//
// 为什么要它（设计档 A3 / K2）：包里的悬浮看板 exe 只能由**冻结提交**编出来。
//   · 冻结树 = release/prepare.mjs 用 `git worktree add --detach <提交>` 建出的链接工作树；
//   · 开发（主）工作树里编出的 exe 一旦留下，就是「下次构建捡到那份旧 exe」的入口。
// 三层闸门（release/build-panel.mjs 拒绝编译 / release/publish.mjs 复核记录并拒绝开发目录里的产物 /
// 程序/tools/test-panel.mjs 的 T5 机判）判「这棵树是哪种树」时都问这里，避免三处各写一套 git 判断。
//
// git 的事实（本机实测）：主工作树的 --git-dir 与 --git-common-dir 指向同一个目录；
// 链接工作树（git worktree add 建的）两个不一致 —— --git-dir 指向 <主仓>/.git/worktrees/<名字>。
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// git 命令的薄封装：失败返回 null（不是 git 仓库、git 不在 PATH 等），由调用方决定怎么办。
export function gitOut(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  } catch { return null; }
}

// 返回值：
//   'worktree' —— 链接工作树（= 冻结构建树，exe 允许在这里编出来）
//   'primary'  —— 主工作树（= 开发目录，这里不该有面板构建产物）
//   'nogit'    —— 不是 git 仓库（追不到提交，发布链一律拒绝）
export function 树类型(root) {
  const gitDir = gitOut(root, ['rev-parse', '--git-dir']);
  const common = gitOut(root, ['rev-parse', '--git-common-dir']);
  if (gitDir === null || common === null) return 'nogit';
  return path.resolve(root, gitDir) === path.resolve(root, common) ? 'primary' : 'worktree';
}
