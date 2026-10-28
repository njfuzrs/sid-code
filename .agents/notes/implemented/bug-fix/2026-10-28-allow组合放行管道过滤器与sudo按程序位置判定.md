---
Status: implemented
Date: 2026-10-28
---
# allow 组合放行管道过滤器、sudo 按程序位置判定、sed 只扫脚本参数

## 决定了什么

修 harness-bench P1v / P2v / P3v 的 7 次权限误拦（bench_fix 02b，Q2）。

N6（只读集单命令漏拦，02e）原计划和本 PR 合并，现在由 #459 单独提交，本 PR 不再改 `read-only-validation.ts`。
这样不会留下窗口期：本 PR 的放宽**不依赖只读集**。过滤器是独立的小白名单，不调 `isReadOnlyCommand`，所以 #459 先合还是后合，都不会让 `| find -delete`、`| awk system` 经 allow 组合放行。变异 M1 在不带 N6 的代码上实测 10 红，证实了这一点。

**Q2（放宽，修误拦）**

1. `permission/checker.ts` `checkAllowList`：复合命令从「每段都命中 allow」改为「**至少一段**命中 allow，其余每段命中 allow，或者是**管道下游纯过滤器**（`|` 之后），或者是**首段 `cd <工作区 / allowedDirectories 内> &&`**」。
   过滤器判定在新文件 `permission/allow-composition.ts`：白名单只有 `tail/head/grep/egrep/fgrep/wc/sort/uniq/cut/tr/nl`，每个程序逐个约束选项，不接受文件操作数，不接受写重定向（只放行 `2>&1`、`2>/dev/null`）和读重定向，也不接受 glob / 变量 / 命令替换 / 前导赋值 / 带路径的程序名。
   刻意不收 `awk`、`sed`、`xargs`、`tee`、`cat`、`less` 和任何 shell。
2. `sudo` 从原文正则 `/sudo\s+/` 改为**程序位置**判定（`checker.ts` `detectPrivilegeEscalation` + `shell-command-variants.ts` `listInvokedPrograms`）。沿 wrapper 链（`env`/`command`/`nohup`/`timeout`/`xargs`…）和 `find -exec/-execdir/-ok/-okdir` 找程序位置，去引号去转义后取 basename，命中 `sudo` 或 `doas`。引号未闭合时回退到原正则。
   名字「sudo 命令」、级别 high 不变。输入用 `expansion.variants`，不能用 `commands[].program`：展开时 sudo 已被当作 wrapper 剥掉。
3. `tool/bash/sed-validation.ts` `detectDangerousSed`：只对每个 sed 调用的**脚本参数**跑检测（`-e`/`--expression` 的值，没有就取第一个非选项参数），不再扫整条命令。`-f`/`--file` 判危险。AST 含 unknown 节点或解析抛错时回退到修前的整条命令正则。

**sed 收紧（同 PR，02b §3.3 已定）**：独立 `e`/`w`/`r` 命令的锚点扩展到「地址之后」（`1e`、`$e`、`/re/W f`）、「`{…}` 块内」（`{p;e}`）和「整段脚本」（裸 `e`），`-f`/`--file` 判危险。这些在修前单条就会放行。

**修订 #443 的一处判断**：#443 认为 high 级误报「只是多一次确认，有出口」，所以保留了 sudo 正则。这在**无头模式**下不成立：ask 直接落成 deny（P3v 实测）。本次只把 `sudo` 改成结构化判定。其余 high / medium（`chmod -R`、`git reset --hard` 等）仍然用正则，因为它们这一批没有实测误拦，回归面也大。
`dangerous-command-matrix.test.ts` J 组原来的 `echo "run sudo apt install x"` 断言「需确认」，锁住的正是这个误报形态，已改为断言放行。

**行为收紧（有意）**：`s\udo id`、`'sudo' id`、`doas id` 从「默认 ask」变成明确的 high「sudo 命令」；sed 的 `1e` / `$e` / `{p;e}` / 裸 `e` / `1r` / `1w` / `-f` 从放行变成需确认。

**牺牲方向**：Q2 牺牲**更安全**（放行面变大），换更准、更快。放大的部分可以逐条列举：allow 命中的命令后面可以接上表里的过滤器，前面可以接 `cd <工作区内> &&`。sed 收紧反过来，牺牲极少数合法 sed 脚本（`-f`）的免确认。

## 放弃了什么（以及为什么不选）

- **A：其余段「命中 allow 或 `isReadOnlyCommand(段)`」（P3 原文写法）**：最容易被重新提议，单独列出。只读集是为「单条只读命令免确认」设计的，从没按「接在 allow 命令后面」的标准审过。修前探针上 `find . -delete`、`awk 'BEGIN{system("id")}'`、`sort -o /tmp/x a` 单条就放行（02b 附录 B）。即使 N6（#459）修完，只读集里仍有 `cat`（`| cat /etc/passwd` 任意读）、`grep x /etc/passwd`、`tail < f` 等。变异 M1（把过滤器判定换成 `isReadOnlyCommand`）在带 N6 收紧的代码上实测仍有 6 条「必须仍拒」变红。
- **C：匹配前剥掉末尾的 `| tail/head`**：是 B 的特例，`| grep | head` 两段过滤、`2>&1` 位置变化都要再补。
- **D：只改拒绝文案（P1-09）**：不消除误拦，D-16 实测模型看到「重试不会改变结果」后照样重发 3 次。保留为另一个 PR。
- **E：采集台 allow 清单加 `Bash(tail *)`**：修的是测题而不是产品；而且会顺带放行 `tail -f /var/log/…`。
- **H：sudo 正则改成词首锚定**：`grep -n "a\|sudo 命令"` 里 `\|` 后面紧跟 `sudo`，照样命中；正则区分不了引号内外。
- **I：匹配前剥掉引号内容**：#443 已经否决过（`rm -rf '/'` 漏报）；同理 `'sudo' id` 会漏。
- **J：sudo 降级为 medium**：无头下 medium 同样落拒，等于没改。
- **L：sed 正则排除 `.test` 这类文件名**：`s.a.b.e` 形态的路径有无穷多。
- **等 N6 合入再提 Q2 / 硬绑同一 PR（02b/02e 原决定 J2）**：J2 的前提是「Q2 放宽会借只读集放行」。本 PR 的过滤器不走只读集，这个前提不成立，所以分开提交、按任意顺序合入都没有窗口期。

## 拿什么证明它生效了

- **探针**（02b 附录 A 加 16 条护栏用例，共 73 条；`SID_ROOT` 指向 worktree 源码）：修前 57 条里 26 条 `✗`，与附录 B 一致。修后的 `✗` 全部在预期内：
  - Q2 范围的 11 条误拦：10 条变为放行；`P3v#1-去merge-base` 按 #7 的口径（拒绝原因不再是 sudo）达标。它和 `P3v#1-去sudo去mb` 的拒绝原因从「sudo 命令」变成默认 ask，是因为 P3 清单 `Read, Grep, Glob` 里没有 bash allow，`git merge-base` 也还不在只读集（#459 加）。02b §1.1 写明 #7 的口径是「原因不是 sudo」，不是放行。
  - `find -delete`、`awk system`、`sort -o`、`git diff --output`、`gdo-P3` 等单条只读集漏拦留给 #459；本 PR 的 sed 部分已收紧 7 条 sed 漏拦。
  - `bun test x > out.txt`：02b 附录 B 已标注为可接受（allow 命中、写工作区内文件）。
  - 新增 16 条护栏（`cd /etc && …`、`cd <ws> && tail -5`、`cd <ws>; …`、`| cat /etc/passwd`、`| grep x /etc/passwd`、`| grep -r x`、`| grep a*`、`| tail < /etc/passwd`、`| sort -o`、`| uniq - /tmp/x`、`| sed e`、未闭合引号 sudo、`-execdir sudo` 等）全部符合预期。
- **新测试**：`tests/permission/allow-list-pipeline-filter.test.ts`（101 条）、`tests/tool/bash/sed-validation.test.ts` 新增 19 条。`dangerous-command-matrix.test.ts` 136 pass（含 #443 的 critical 硬拒）。
- **旧行为探测**：把 `checker.ts`、`shell-command-variants.ts`、`sed-validation.ts` 换回 main 后跑新测试，「变放行」10 条全红；sudo 误报 3 条、sudo 变形 3 条、sed 16 条也全红。证明测试确实测到了修前行为。
- **变异自证**（逐项改坏 → 跑测试 → 恢复）：
  - M1 过滤器换成 `isReadOnlyCommand` → 10 红（含 `| awk system`、`| find -delete`、`| cat /etc/passwd`、`| grep x /etc/passwd`、`| tail < /etc/passwd` 等）。#459 合入后 awk/find 两条不再红，其余仍红，M1 保持证明力（02e §4 的担心已覆盖）。
  - M2 去掉重定向检查 → 5 红；M3 去掉「必须在 `|` 之后」→ 1 红（`tail -5 && bun test x`）。
  - M4 去掉「至少一段命中 allow」→ **单独改 0 红**：`cd <ws> && tail -5` 里 `tail` 在首段管道的 s=0 位置，先被「`|` 之后」挡住。M3、M4 同时改坏后 2 红，所以 M4 是 M3 的第二道防线，单独看不到。
  - M5 cd 不校验目录 → 1 红；M6 sudo 不跳 wrapper → 4 红；M7 不处理 `-exec` → 2 红；M8 删掉 tokenize 回退 → 1 红；M9 sed 改回扫整条 → 16 红；M10 删掉 `-f` → 2 红。
- **门禁**：`bun run affected-tests:run` 2242 pass / 0 fail；手动补跑 `query/repeated-readonly-guard`、`low-yield-spin`、`p0-safety-bypass`、`p1-sensitive-bypass`、`bash-redirect-extraction` 共 218 pass；`make build` 自检通过，`will always be undefined` 0 处；lint、format:check、lint:boundary、lint:command-system、typecheck:gate（66 / 基线 66）全过；`docs:gen-reference` 无漂移。
- **全量 `bun test`**（rebase 前，基于 `d7f7b855`）：18140 pass / 2 fail。两条红同一根因：`memory/team/sync.ts` 用 `| 0` 截断毫秒时间戳。该测试不 import 本次改动的模块，在 main `d7f7b855` 上单跑同样失败；已由 #458 修复。合入 main（含 #458）后，`memory/team/sync.test.ts` 单跑 0 fail。
- **待 F2**：P1v / P2v 各跑 2 次 `sc-dev`，判据见 bench_fix 03-F2。
