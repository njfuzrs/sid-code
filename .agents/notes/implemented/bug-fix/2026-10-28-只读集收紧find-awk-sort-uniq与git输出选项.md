---
Status: implemented
Date: 2026-10-28
---
# 只读集收紧：find / awk / sort / uniq / git --output 按参数判，git merge-base 进只读

## 决定了什么

`packages/core/src/tool/bash/read-only-validation.ts` 的 `isReadOnlyCommand` 原先把下面这些单条命令判为只读。在 default + 无头模式下，它们经 checker Step 5.5 在工具级直接放行：

| 程序 | 旧行为 | 新判据（命中即非只读） |
|---|---|---|
| `find` | 无条件只读 | `-delete` `-exec` `-execdir` `-ok` `-okdir` `-fprint` `-fprint0` `-fprintf` `-fls` |
| `awk` / `gawk` / `mawk` | `awk: () => true`，gawk/mawk 不在表里 | 带 `-f`/`--file`；或脚本串（第一个位置参数，或 `-e`/`--source` 的值）含 `system`、`getline`、单个 `\|`、不接 `=` 的 `>` |
| `sort` | 无条件只读 | `-o` / `-oFILE` / `--output` / `--output=` |
| `uniq` | 无条件只读 | 位置参数超过 1 个（第二个是输出文件） |
| git 只读子命令 | 不看参数 | 任一参数为 `--output` 或以 `--output=` 开头 |
| `git merge-base` | 不在只读子命令里，判非只读 | 加进 `READ_ONLY_GIT_SUBCOMMANDS` |

原则是**看不懂就不算只读**：落到 ask，而不是硬拒。

awk 判据里排除 `>=` 和 `||`，因为它们在 awk 里只可能是比较和逻辑或。本地轨迹里修前判为只读的 awk 有 5 条，其中 3 条是 `NR>=12 && NR<=110`、`a || b` 这类行号筛选。不排除的话，60% 的只读 awk 会白弹确认。

本应和 Q2（02b，放宽 allow 组合）放在同一个 PR。这次单独提交，因为本改动只收紧、不放宽，先合入不会留下窗口期。Q2 合入时，02b 的 M1 要按 02e §4 核对：`| awk system` 已被本改动判为非只读，M1 的必红用例可能需要换成 `| cat /etc/passwd` 这类过滤器表外、只读集内的程序。

`isReadOnlyCommand` 还被 `tool/bash.ts`（并发安全、文件变更回扫、cwd 跟踪、写后状态失效）、`query/compact/microcompact.ts`、`query/repeated-readonly-guard.ts` 使用。改判为非只读的命令在这些地方按写操作处理，方向正确：`find -delete`、`sort -o` 确实写了盘。

## 放弃了什么（以及为什么不选）

- **把 `find`、`awk` 整个移出只读集**：`find . -name '*.ts'`、`awk '{print $1}'` 是最常见的只读用法，移出后在无头模式下全部变成拒绝，误拦多于漏拦。
- **awk 做真正的语法解析**：成本高。关键字判据已覆盖 `system()`、管道、写文件三条副作用通道。剩下的代价是 `$1 > 5` 这类数值比较、`/a|b/` 这类正则交替会落到 ask。本地轨迹里这类形态为 0 条，暂不为它加复杂度。
- **`>` 只在字符串字面量外、后面跟引号或标识符时才算**（02e §3 的备选）：只排除 `>=`、`||` 之后，本地轨迹的误拦已经是 0，更细的规则没有数据支撑。
- **只修 02b 矩阵里用到的几条**：漏拦单条命令就成立，和 allow 组合无关。只修一半等于留一半。
- **sed 的 `1e`/`1r`/`1w`/裸 `e`/`-f`**：属于 02b §4.3 的范围（`sed-validation.ts`），本 PR 不碰。

## 拿什么证明它生效了

- 新测试 `packages/core/tests/tool/readonly-side-effect-gaps.test.ts`：6 个用例，46 条断言，全绿。
- 变异自证：逐项恢复旧行为，每项都只让对应用例变红。
  - `find: () => true` → 只有 find 用例变红
  - `awk: () => true` → 只有 awk 用例变红
  - sort 恒真 → 只有 sort 用例变红
  - uniq 恒真 → 只有 uniq 用例变红
  - 删掉 `--output` 检查 → 只有 git --output 用例变红
  - 删掉 `merge-base` → 只有对照组变红
  - awk 正则退回 `/system|getline|[|>]/` → 只有对照组变红（`NR>=12` 那条）
- 02b 附录 A 探针（`PermissionChecker.check`，default + print，修前用主仓 `d7f7b855`，修后用本 worktree）：
  - P 清单：`find -delete`、`find -exec rm`、`awk system`、`cat|awk system($0)`、`sort -o`、`uniq a /tmp/x` 从 allow 变成 deny。
  - `git diff --output` 在 P 清单下仍是 allow。原因是 P 清单含 `Bash(git diff *)` 这条 allow 规则，属于规则匹配，不归只读集管。
  - P3 清单（只有 Read/Grep/Glob）下，`git diff --output` 从 allow 变成 deny，`git merge-base a b` 从 deny 变成 allow。
- 本地轨迹回放：`~/.sid-code/trajectories/sessions/*/events.jsonl` 里共 4889 条 bash 命令，修前判为只读的 762 条。修后只读→非只读 0 条；非只读→只读 14 条，全是 `git merge-base` 链。
- `bun run affected-tests:run`：1200 pass / 0 fail。`query/`、`permission/p0`、`p1`、`compact/` 中引用 `isReadOnlyCommand` 的测试另跑：158 pass / 0 fail。`make build` 自检通过。lint 四件套与 `typecheck:gate` 全部 exit 0。
- 全量 `bun test`：17992 pass / 2 fail。两条失败都和本改动无关：
  - 都不 import 本模块。
  - 在主仓 main `d7f7b855` 上单跑同样失败。
  - 成因：`memory/team/sync.ts:337` 的 `Math.max(mtimeMs) | 0` 在毫秒时间戳上 32 位溢出成负数（`k.conflict--2140179409.md`），导致 `team/sync.test.ts` 失败；`no-real-trajectory-writes-runtime` 因为受检子进程连带跑到这条而退出码为 1。
