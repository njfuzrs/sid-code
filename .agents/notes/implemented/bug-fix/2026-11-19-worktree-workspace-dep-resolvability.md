---
Status: implemented
Date: 2026-11-19
---
# worktree 依赖检查补上「workspace 包能否解析」，不再只看 lockfile 哈希

## 决定了什么

`checkDependencyConsistency` 原来只比对 lockfile hash。主仓根 `node_modules/@sid-code/`
缺某个 workspace 包链接（实测是 `tui`）时，新建 worktree symlink 进的是**同一个残缺目录**，
而 lockfile 完全一致 → 返回 null，一句告警都没有；直到 pre-commit 跑
`docs:gen-reference --check` 报 `Cannot find module '@sid-code/tui/...'` 才暴露。
2026-11-19 实测：4 个并行 agent 里 3 个源码+测试都做完了，卡在 pre-commit 提交不了。

新增 `checkWorkspaceDependencyResolvability(worktreePath, symlinkedDirs, mainRoot)`，
由 `checkDependencyConsistency` 合并输出（函数签名与调用方不变，多条告警用空行分隔）。判据：

- **只在 `symlinkedDirs` 含根 `node_modules` 时检查**——worktree 自己真实安装的那份里软链是
  worktree-local、可靠的；symlink 自父仓的那份才可能本身残缺，那才是 bug 场景。
- 扫 `packages/<pkg>/package.json` 的 dependencies / devDependencies / optionalDependencies /
  peerDependencies，收集 `workspace:` 前缀的依赖名（不按 `private` 过滤——`eval-framework` 没设 it，
  `tui` 也是要被检出的；跳过名为 `node_modules` 的条目）。
- 解析顺序同 Node：`packages/<pkg>/node_modules/<dep>` → 根 `node_modules/<dep>`。
  用 `existsSync`（**会跟随软链**，悬空链接返回 false，正是要判的情形，不用 `lstat`）。
- 整棵 `<wt>/node_modules` 不存在 → 只报一条「worktree 未安装依赖」，不逐个列包名。
- 修复命令**按位置区分**：根缺 → 在主仓补建 `ln -sfn ../../packages/<dir> <mainRoot>/node_modules/<dep>`；
  包内缺 → 在 worktree 内 `bun install`。本次踩坑的直接教训就是只知道「缺 tui」而去 worktree
  里 `bun install` 是无效的——bun 判 no changes 直接跳过。
- 新检查放在 lockfile 早退**之前**，否则「lockfile 一致」这条早退会把新告警整个挡住，
  而这正是缺陷的主场景（残缺 node_modules 恰恰是同一份 lockfile 装出来的）。

## 放弃了什么（以及为什么不选）

- **否决「改成 lstat 判悬空链接」**：悬空链接只是缺陷的一种形态；主仓缺的是整个目录项时
  `lstat` 也判不出来，而 `existsSync` 恰好覆盖「不存在 + 悬空」两种，且判的是「能不能 require」本身。
- **否决「对所有包都检查、不看 symlinkedDirs」**：worktree 自己的 `node_modules` 是独立安装的，
  缺包时 `bun install` 真能补上，告警会变成误导（给了错误的修复命令）+ 噪音。条件是「根 node_modules
  被 symlink」而不是「存在 node_modules」，就是这个原因。
- **否决「自动在主仓补建链接」**：会改主仓（其它 worktree 共用），且需要猜包目录名与链接名，
  出错会污染别人的工作区。只告警 + 给出一条可复制执行的命令，决策留给用户（对齐 CC「不猜」哲学）。
- **否决「node_modules 不存在时逐个报缺失包」**：那时真正原因是「没装依赖」，逐个报包名会把根因埋掉。
- **否决「按 `private` 过滤包」**：`packages/eval-framework` 没设 `private`，按它过滤会静默漏检，
  而 `tui`（设了 private）也是本次受害包——两个方向都错，字段本身不承载「是不是 workspace 成员」。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/worktree/advisories.test.ts` → **16 pass / 0 fail**（新增 5 条用例，
  既有 11 条未改）。
- `bun test ./packages/core/tests/worktree/` → **174 pass / 0 fail**（17 个文件，含 w19-w27-defects 等既有用例）。
- `./node_modules/.bin/oxlint` 两个改动文件 → 0 warnings / 0 errors。
- **变异自证**（edit 改坏 → 跑 → edit 改回 → 重跑）：
  - a. 删掉 `checkDependencyConsistency` 里调用新检查的两行 → 用例 1「真阳性」与用例 4「未安装依赖」
    都变红，实际值 `Received: null`（期望 `not.toBeNull()`）；恢复后 16 pass。
  - b. 把两处 `existsSync` 判定改成恒 `true`（等价「永远可解析」）→ 只有用例 1 变红
    （`Received: null`），用例 4 仍绿（它在判定前就 return）；恢复后与备份逐字节一致，16 pass。
