---
Status: rejected
Date: 2026-11-14
Source: bash 只读判定与 cd 复合命令对齐 claude-code：缺陷修复与验收方案（2026-11-14）
---
# 不放开 `git ls-remote`，也不放开 `git grep` 的文件/越界 path 参数

## 决定了什么

方案 B8 的现象段写「CC 只读表里的 24 条 `git <子命令>`，sid 判非只读的有 3 条：
`git worktree list`、`git grep`、`git ls-remote`」。本 PR（PR-2）只放开前两条，
`git ls-remote` 与 `git grep` 的四个参数形态**保持非只读**：

- `git ls-remote`（全部形态）
- `git grep -f <file>` / `--file=<file>`
- `git grep --no-index` / `--untracked`
- `git grep --pathspec-from-file=<file>`
- `git grep <pattern> -- <绝对路径 | ../ 越界 | ~ 开头>`

## 放弃了什么（以及为什么不选）

**`git ls-remote` 不放开：只读与否取决于部署环境，不能写死。**
它确实不改本地仓库，但会发起**网络请求**：内网环境下可能触发代理认证、企业 SSO 凭据提示、
甚至把仓库 URL（可能含 token）带到外部。CC 的表把它算只读，是因为 CC 的默认部署形态是
公网单机；本仓的北极星第一条是「企业级——内部网关、企业 SSO」，同一份命令在不同部署下
风险不同。**判据不该由命令文本单独决定**，而 `isReadOnlyCommand` 恰恰是纯文本函数。
如果将来要做，正确位置是权限层（能读到网络策略与凭据配置），不是只读表。
放开条件：出现「本机已配置企业网络策略、且 ls-remote 目标域名在白名单内」这类上下文判定时。

**`git grep -f <file>` 不放开：它读一个**任意路径**的文件，而权限层现在没有路径校验。**
方案原文写的是「`-f <file>` 读文件，路径交给 B5 校验」——B5（只读命令的路径参数工作区校验）
尚未落地。在 B5 之前放开，`git grep -f /etc/shadow foo` 会零确认读取工作区外的文件，
并把其中匹配到的行输出到会话里。放开条件：B5 落地且 `isReadOnlyCommand` 能拿到
pathValidator（或权限层补一道 `-f` 目标校验）。

**`--no-index` / `--untracked` / `--pathspec-from-file` 不放开：pathspec 会脱离仓库边界。**
`--no-index` 让 `git grep` 在**文件系统**任意路径上搜索（`git grep --no-index foo /etc` 会
真的读 `/etc`），`--untracked` 把未跟踪文件纳入搜索范围，`--pathspec-from-file` 从文件读
pathspec（同样绕开静态检查）。三者都能把「只读」变成「任意读」。放开条件同 `-f`：等 B5 的
路径校验能覆盖 bash 参数。

**pathspec 的越界形态不放开：粗判只做「不出仓库」，精确校验属于 B5。**
本 PR 的 `isSafeGitPathspec` 拒绝绝对路径、`..`、`~`，但**不**做 realpath / symlink / `/add-dir`
级的校验——那需要 pathValidator，而 `isReadOnlyCommand` 拿不到上下文。所以这里是
「宁可多问一次」的粗判，不是完整实现。放开条件：B5 把路径校验下沉到能拿到上下文的层。

## 拿什么证明它生效了

`packages/core/tests/tool/git-worktree-grep-readonly.test.ts` 里两组用例锁住这些形态
**修后仍判非只读**（`isReadOnlyCommand(...)` 断言 `false`）：

- 「能执行任意程序的 flag 必须拦住」组：`-O` / `--open-files-in-pager` / 未知 flag；
- 「绕开权限层路径校验的形态：等 B5 落地前一律不放行」组：`-f` / `--file=` / `--no-index` /
  `--untracked` / `--pathspec-from-file` / `-- ../outside` / `-- /etc` / `-- ~/x`；
- 「`git ls-remote` 保持非只读（刻意不放开）」组：裸形态与 `--heads` 形态。

变异自证：把 `git grep` 分支改成无条件 `continue`（等于把它整条放进只读表）后，
上述两组共 **2 例变红**，恢复后 173 pass / 0 fail。这说明这些断言不是恒绿的。

**将来重新提议这件事时，先读这份 Note**：上述四条各自有明确的放开前置条件
（B5 落地 / 网络策略上下文可读），不是「当时懒得做」。
