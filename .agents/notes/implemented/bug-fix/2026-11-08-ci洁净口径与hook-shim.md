---
Status: implemented
Date: 2026-11-08
---
# CI 洁净门禁改看未忽略新文件 + hook 安装器改装 shim（X3-10 / X3-11）

## 决定了什么

两项改动合成一个 PR，都是《20260927-工程化与交付》里「门禁读的不是它以为的东西」这一类。

**X3-10：CI「单测未污染工作区」不再闭眼看着新建文件。**
`.github/workflows/ci.yml` 的这一步原先用 `git status --porcelain --untracked-files=no`，
只拦「改了已追踪文件」。改成两条判据并行：

- `git status --porcelain --untracked-files=no` → 已追踪文件被改；
- `git ls-files --others --exclude-standard` → 仓库里新建的**未被 .gitignore 忽略**的文件。

两类各自打印、各自失败，报错文案区分「改了已追踪文件」与「新建了未忽略文件」。
选 `ls-files --others --exclude-standard` 而不是
`git status --porcelain -uall | grep '^??'`，是因为它直接表达「未忽略的新文件」，
不必再处理 porcelain 的引号转义与空输出被 grep 当成一行的问题。

**X3-11：安装器不再 `cp` 副本，改写成固定内容的转发 shim。**
`scripts/install-git-hooks.sh` 为 `pre-commit` / `pre-push` 各写一份固定 shim 到 git 的
hooks 目录，shim 每次执行时用 `git rev-parse --show-toplevel` 现取当前 checkout 的源文件
并 `exec` 转发。源文件更新后**不需要重装**，`cp` 快照与源文件各自漂移的失效面消失。

同时顺手收紧了三处：

- hooks 目录改为 **`core.hooksPath` 优先**（相对路径按工作树根解析），否则才用
  `--git-common-dir/hooks` —— 原先只认后者，而本机 `core.hooksPath` 恰好等于它，
  掩盖了「配了别处就装错位置」的可能；
- hook 名单显式写成 `pre-commit pre-push`。旧循环 `for src in "$SRC_DIR"/*.sh` 会把
  `push-scope.sh`（pre-push 的辅助脚本）也装成 `.git/hooks/push-scope`，那是个永远
  不会被 git 调用的死文件；
- shim 用 `printf` 生成而不是 `heredoc + cat`（`cat` 缺失时 heredoc 会静默产出空文件，
  X3-05 修 `release.sh` 远端脚本时踩过同款）。

## 放弃了什么（以及为什么不选）

**X3-10 不改成「只查 untracked」，也没改成裸 `git status --porcelain`。**
两端都留着，是因为它们对应两类不同的真实事故：已追踪文件被写脏（`holdout-sids.txt`
永封文件残留 `tampered-extra-line`，会导致推不上去）与新建文件型污染（`git add .`
会一起提交）。裸 `--porcelain`（默认 `-unormal`）会把未追踪**目录**列成一行，
定位时只知道「某个目录冒出来了」，所以这里用 `-uall` / `ls-files` 让报错点名具体文件。
它与 `release.sh` 发布前洁净门禁的口径仍一致（都是「`--porcelain` 不列忽略项」），
只是展示粒度更细 —— 两处语境不同，刻意不合并成一份实现。

**X3-10 没有先「只打印不 exit 1」观察一个 PR。**
方案文档要求先量存量再切阻断。本次在干净 worktree（worktree 新建 + `bun install` 后
`git status` 为空）跑了一次全量 `bun test`，结束后 `git status --porcelain -uall` 的 `??`
为零 —— 存量不欠账，直接切阻断。这一步的代价是跑一次 706s 的全量，比重开一个
观察 PR 便宜，且能当场拿到结论。

**X3-11 没有直接设 `core.hooksPath=scripts/git-hooks`。**
git 只认无扩展名的 `pre-commit` / `pre-push`，源文件叫 `*.sh`；而且这样会让 hook 变成
「只对有该目录的分支生效」，旧分支 checkout 后会直接没有 hook。shim 兼顾两点：
安装位置仍是 git 的标准位置，执行内容随 checkout 走。

**X3-11 没有用软链（`ln -s`）代替 shim。**
软链同样能随源文件更新，但它在 Windows / 某些文件系统上不可靠，且 `git pull` 把源文件
删掉时软链变成悬空链接，报错形态比 shim 的「找不到 → 打印提示 → 放行」更难读。
shim 是纯文本、可 review、可解释。

**X3-11 的 shim 在源文件缺失时选择「放行 + 提示」而不是「失败」。**
这是 2026-08-19 那次事故的另一面：hook 装在共享的 `.git/hooks`，而 checkout 可能是
一个还没有 `scripts/git-hooks/` 的旧分支。此时阻塞提交的代价（所有老分支无法提交）
远大于「这一个 hook 这次没跑」，且必然把人逼去 `--no-verify`。提示必须打印出来，
不能静默。

## 拿什么证明它生效了

**X3-10**

- 存量测量：worktree 内 `bun test` → `Ran 20068 tests across 1416 files. [706.42s]`；
  随后 `git status --porcelain --untracked-files=all | grep '^??'` 为空（零未忽略新文件）。
  （11 个 fail 全部是 worktree 路径导致的已知环境性假失败：`rules-paths-scope-nonempty`
  被 `.sid-code` 段误判、`isolated-subagent-cwd` 注入隔离提示、TUI 用例 5s 超时。）
- 行为测试（`tests/release-flow-contract.test.ts`）：从 `ci.yml` 抠出该 step 的真实
  `run` 脚本，在 tmpdir 真 git 仓库里用 `bash -eo pipefail -c` 跑 5 种场景 ——
  干净 / 新建未忽略文件 / 改已追踪文件 / 新建但被忽略 / 两者并存。
- **变异自证**：把 `untracked="$(git ls-files --others --exclude-standard)"` 改成
  `untracked=""`（等价于旧口径）→ 2 fail（「新建未忽略文件」「两者并存」）；恢复后 87 pass。

**X3-11**

- 行为测试（新增 `tests/build/install-git-hooks-shim.test.ts`，7 条）：安装后**只改源文件、
  不重装**再 `git commit`，断言执行的是新版本；安装产物不含源文件内容；源文件缺失时
  放行并提示；`push-scope.sh` 不被装成 hook；shim 保留 stdin；`core.hooksPath` 已设置时
  装到该目录；worktree 里能装上。
- **变异自证**：把安装器的 shim 生成段换回 `cp "$SRC_DIR/$_name.sh" "$_dst"` → 4 fail
  （核心的「不重装执行新内容」、产物断言、源文件缺失、worktree）；恢复后 7 pass。
- 手工复核：tmpdir 仓库里跑安装器，`.git/hooks/` 只多出 `pre-commit` / `pre-push`，
  `push-scope` 未被安装；shim 内容与设计一致。
