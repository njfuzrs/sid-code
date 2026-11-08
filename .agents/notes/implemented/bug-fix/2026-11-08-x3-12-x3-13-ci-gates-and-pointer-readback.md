---
Status: implemented
Date: 2026-11-08
---
# X3-12/X3-13：死链与 NUL 门禁补 CI 兜底，发布指针写入补回读自证

## 决定了什么

**X3-12（门禁只在 hook 里，CI 无等价物）**

1. `ci.yml` 新增 `website` job（ubuntu）：根 `bun install` → `bun install --cwd website` →
   `bun run website:build`，并登记进 `all-checks-passed.needs`。
   死链检测不另写脚本 —— 它是 VitePress 构建的一部分（`ignoreDeadLinks: false`）。
2. **不做路径过滤**（文档原方案里的可选项）。本 job 与 test 矩阵并行，实测本机构建 19.7s、
   test 单平台约 8 分钟，并行 job 只在超过最长 job 时拉长总墙钟，边际成本接近零。
   反过来，路径过滤要在 CI 里再写一份「哪些改动算触及站点」的判据（参考页数据源分布在
   4 个包的 `src/` 与全部 `website/*.md`），判漏一类就是**一个新的静默失效**。
3. NUL 门禁改成一条测试 `tests/build/no-nul-bytes.test.ts`：`git ls-files` + 逐文件读字节判
   `0x00`（不用 grep，理由见文件头），扩展名清单与排除规则抄 `pre-commit.sh` 的
   `STAGED_SOURCES`，并有一条断言把两边钉死。不新增 CI job。
4. **北极星陈旧检测明确不进 CI**：它是时间阈值，进 CI 会让所有无关 PR 在某一天集体变红，
   正好诱导 `--no-verify`。这条从「缺口」改记为「刻意只放 hook」。
5. 按实际配置重写文档里漂移的门禁清单：`website/blog/sc-x3-engineering.md` §2.5
   （3 job / 9 道检查、lint job 补 3 项、其余 workflow 表补 `pr-auto-update`、
   pre-commit / pre-push 清单按脚本实际顺序）、`CONTRIBUTING.md`（job 数、九道门禁、
   汇聚门描述、hook 表格）、`.github/pull_request_template.md`、
   `scripts/git-hooks/push-scope.sh` 与 `tests/scripts/pre-push-scope.test.ts` 的
   「死链唯一落点」表述。

**X3-13（写通道指针缺回读自证）**

6. `release.sh` 抽出 `write_pointer <文件名> <版本号>`：mktemp 写版本 → `run_scp` → 回读
   `cat` 比较（`tr -d '[:space:]'` 去空白）。promote（`latest.txt`）与 upload（`beta.txt`）
   两处都改走它。
7. 函数用**返回码三态**而不是内部直接 `fail`：`0`=写入且回读一致；`1`=scp 失败（指针大概率
   仍是旧值，「重跑」安全）；`2`=已写入但回读不符（可能已写坏，「人工检查」才安全）。
   消息由调用点拼 —— 两条通道的失败语义不同。
8. beta 路径回读不符时**先置 `BETA_PUBLISHED=true` 再 fail**：scp 已把字节写出去过，此刻
   语义是「已对外，需人工核」，而 `on_exit` 据这个标志打印的正是「不要重跑」。
9. `rollback.sh` **本次不迁**（它已有等价实现与测试）。函数注释里写明这一点，并说明
   回读那行的 `|| true` 现在不承重（两个调用点都在 `||` 条件上下文、set -e 免疫），
   保留它是为将来 rollback 迁过来时的裸调用 —— 并为此专门补了一条 bare 语义测试。

## 放弃了什么（以及为什么不选）

- **放弃 `dorny/paths-filter` 只在 `website/` 变动时跑站点构建**：要 pin 第三方 action 的
  commit SHA（本仓统一要求），且判据本身是新的失效面；而并行 job 的墙钟成本本来就接近零。
- **放弃把 NUL 检查做成独立 CI job / step**：写成 `tests/build/` 测试即可复用 test job 的
  全量执行，还能对检测器本身做变异自证（构造 buffer 断言）。
- **放弃用 `grep` 检 NUL**：`grep -q "$(printf '\000')"` 的命令替换会把 NUL 剥成空串，
  判定完全反转（hook 注释里有实测记录）。用字节比较，不受 locale / 拼接影响。
- **放弃 `write_pointer` 内部统一 `fail`**：beta 路径需要在 scp 成功与回读之间插入
  `BETA_PUBLISHED=true`，函数内 fail 无处插入；返回码把语义决策留在调用点，函数保持纯机制。
- **放弃本次把 `rollback.sh` 迁到 `write_pointer`**：它已有回读 + 测试，迁过来等于把 PR
  扩大到「回滚」这条最不能出错的路径，收益低、风险高。
- **放弃删掉 `|| true`**：它在当前调用形态下确实不承重（第一版测试因此无法区分，已修正为
  bare 调用用例）。保留是因为函数会被第三个调用点复用；不保留则将来裸调用时 ssh 读失败会
  让发布脚本「无上下文地崩」而不是给出可读的 rc=2。

## 拿什么证明它生效了

**变异自证（每次都改坏 → 跑 → 恢复，`trap` 保证恢复）**

1. 把 `if [ "$_wp_readback" = "$_wp_ver" ]` 改成 `if true` →
   `bun test ./tests/release-channel.test.ts` 得 **44 pass / 2 fail**，红的正是
   「scp 成功但内容不对 → 返回码 2」与「ssh 读失败 → 返回码 2」。
2. 删掉回读那行的 `|| true` → **46 pass / 1 fail**，红的是「裸调用（set -e 生效）时
   ssh 读失败 → 仍是返回码 2」。
3. 从 `all-checks-passed.needs` 移除 `website` → `release-flow-contract.test.ts` 的
   「needs 覆盖除自己以外的全部 job」变红（79 pass / 3 fail，另两条见下）。
4. 用 `git add -N` 注入一个含 NUL 的 `nul-probe-tmp.ts` → `no-nul-bytes` 的
   「被追踪的源码里没有裸 NUL 字节」变红并点名该文件（3 pass / 1 fail）。

**门禁全绿（本地，worktree）**

- `bun run lint`：0 warnings / 0 errors（2953 files）。
- `bun run format:check`：All matched files use the correct format（2916 files）。
- `bun run typecheck:gate`：62 处错误 / 基线 64，「✓ 无新增类型错误」。
- `bun run docs:gen-reference --check`：参考页与源码一致、CLI 双源对账通过。
- `make build`：编译成功，产物自检 5 项全过（skill 内联 / ripgrep 平台 / review skill 等）。
- `bun test ./tests/release-channel.test.ts ./tests/release-flow-contract.test.ts
  ./tests/build/no-nul-bytes.test.ts ./tests/scripts/pre-push-scope.test.ts`：**144 pass / 0 fail**。
- `bun run website:build`：build complete in 17.55s，无死链。

**两处过程性发现（都已修，写在这里防止复发）**

- 本次把写指针收进函数后，`release-flow-contract.test.ts` 有 2 条「判据对象是
  `run_scp … .txt`」的断言失效（通道指针在原子切换之后、promote 合并稿在写指针之前）。
  **不变量没变**，只把判据对象换成 `write_pointer`，原语义与守护强度保持不变。
- `release-channel.test.ts` 的「上传段不再上传 latest.txt」原断言只拦 `run_scp … latest.txt`；
  写指针函数化后这条会成为**假绿**（新写法根本不经过 run_scp），已补一条
  `not.toMatch(/write_pointer\s+latest\.txt/)`。

**worktree 环境说明（不是代码问题）**

- worktree 的 `node_modules` 是主仓 symlink，主仓缺 `@sid-code/tui` / `yoga-layout` 链接，
  导致 `typecheck:gate` 与 `docs:gen-reference --check` 报 `Cannot find module`。
  按 CLAUDE.md 规程换成本地安装（`unlink node_modules` + `bun install --linker hoisted`）后
  两道门禁均通过；`bun.lock` 无改动。
- 因此本次**没有在 worktree 里跑全量 `bun test`**：选测脚本判定 full（`scripts/release.sh`
  属仓库级文件），但 worktree 路径含 `.sid-code` 会触发已知的 3 类环境性假失败
  （`ruleOwnerDir` 误判 / 子代理 cwd 提示）。全量由 CI 在正常 checkout 路径上跑
  （本 PR 的 `test` job 即为此）。相关域测试已单跑全绿（见上）。
