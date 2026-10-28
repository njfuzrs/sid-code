---
Status: implemented
Date: 2026-10-28
---
# allow 组合放行管道过滤器、sudo 按程序位置判定、sed 只扫脚本、只读集收紧参数副作用

## 决定了什么

修 harness-bench P1v / P2v / P3v 的 7 次权限误拦（bench_fix 02b，Q2），同 PR 收紧只读集单命令漏拦（02e，N6）。
两边必须同时生效：Q2 放宽 allow 组合，N6 收紧只读集，分开合会留窗口期。

**Q2（放宽，修误拦）**

1. `permission/checker.ts` `checkAllowList`：复合命令从「每段都命中 allow」改为「**至少一段**命中 allow，其余每段命中 allow，或者是**管道下游纯过滤器**（`|` 之后），或者是**首段 `cd <工作区 / allowedDirectories 内> &&`**」。
   过滤器判定在新文件 `permission/allow-composition.ts`：白名单只有 `tail/head/grep/egrep/fgrep/wc/sort/uniq/cut/tr/nl`，每个程序逐个约束选项，不接受文件操作数，不接受写重定向（只放行 `2>&1`、`2>/dev/null`）和读重定向，也不接受 glob / 变量 / 命令替换 / 前导赋值 / 带路径的程序名。
   刻意不收 `awk`、`sed`、`xargs`、`tee`、`cat`、`less` 和任何 shell。
2. `sudo` 从原文正则 `/sudo\s+/` 改为**程序位置**判定（`checker.ts` `detectPrivilegeEscalation` + `shell-command-variants.ts` `listInvokedPrograms`）。沿 wrapper 链（`env`/`command`/`nohup`/`timeout`/`xargs`…）和 `find -exec/-execdir/-ok/-okdir` 找程序位置，去引号去转义后取 basename，命中 `sudo` 或 `doas`。引号未闭合时回退到原正则。
   名字「sudo 命令」、级别 high 不变。输入用 `expansion.variants`，不能用 `commands[].program`：展开时 sudo 已被当作 wrapper 剥掉。
3. `tool/bash/sed-validation.ts` `detectDangerousSed`：只对每个 sed 调用的**脚本参数**跑检测（`-e`/`--expression` 的值，没有就取第一个非选项参数），不再扫整条命令。`-f`/`--file` 判危险。AST 含 unknown 节点或解析抛错时回退到修前的整条命令正则。

**N6（收紧，修漏拦）** 全部改在 `tool/bash/read-only-validation.ts`，原则是看不懂就不算只读（落到 ask）：

- `find` 移入条件集：出现 `-delete/-exec/-execdir/-ok/-okdir/-fprint/-fprint0/-fprintf/-fls` 中任一项即非只读。
- `awk/gawk/mawk`：脚本含 `system`/`getline`，或者 `print`/`printf` 语句里（去掉字符串字面量后）出现 `>` / `|`，或者带 `-f`，即非只读。
- `sort` 出现 `-o`/`--output`/`--compress-program`（含组合短选项里的 `o`）即非只读；`uniq` 位置参数超过 1 个即非只读。
- git 只读子命令带 `--output` 即非只读；`merge-base` 加进只读子命令（P3v#1 去掉 sudo 后卡在这里）。
- sed 的 `1e` / `$e` / `{p;e}` / 裸 `e` / `1r` / `1w` / `-f` 由上面第 3 条一起收紧：独立命令的锚点扩展到「地址之后」和「整段脚本」。

**修订 #443 的一处判断**：#443 认为 high 级误报「只是多一次确认，有出口」，所以保留了 sudo 正则。这在**无头模式**下不成立：ask 直接落成 deny（P3v 实测）。本次只把 `sudo` 改成结构化判定。其余 high / medium（`chmod -R`、`git reset --hard` 等）仍然用正则，因为它们这一批没有实测误拦，回归面也大。
`dangerous-command-matrix.test.ts` J 组原来的 `echo "run sudo apt install x"` 断言「需确认」，锁住的正是这个误报形态，已改为断言放行。

**行为收紧（有意）**：`s\udo id`、`'sudo' id`、`doas id` 从「默认 ask」变成明确的 high「sudo 命令」；上面 N6 列出的命令从工具级只读放行变成需要确认。

**牺牲方向**：Q2 牺牲**更安全**（放行面变大），换更准、更快。放大的部分可以逐条列举：allow 命中的命令后面可以接上表里的过滤器，前面可以接 `cd <工作区内> &&`。N6 牺牲更准（极少数只读 awk 脚本会落到 ask），换更安全。

## 放弃了什么（以及为什么不选）

- **A：其余段「命中 allow 或 `isReadOnlyCommand(段)`」（P3 原文写法）**：最容易被重新提议，单独列出。只读集是为「单条只读命令免确认」设计的，从没按「接在 allow 命令后面」的标准审过。修前探针上 `find . -delete`、`awk 'BEGIN{system("id")}'`、`sort -o /tmp/x a` 单条就放行（02b 附录 B）。即使 N6 修完，只读集里仍有 `cat`（`| cat /etc/passwd` 任意读）、`grep x /etc/passwd`、`tail < f` 等。变异 M1（把过滤器判定换成 `isReadOnlyCommand`）在 N6 修完后实测仍然让 6 条「必须仍拒」变红。
- **C：匹配前剥掉末尾的 `| tail/head`**：是 B 的特例，`| grep | head` 两段过滤、`2>&1` 位置变化都要再补。
- **D：只改拒绝文案（P1-09）**：不消除误拦，D-16 实测模型看到「重试不会改变结果」后照样重发 3 次。保留为另一个 PR。
- **E：采集台 allow 清单加 `Bash(tail *)`**：修的是测题而不是产品；而且会顺带放行 `tail -f /var/log/…`。
- **H：sudo 正则改成词首锚定**：`grep -n "a\|sudo 命令"` 里 `\|` 后面紧跟 `sudo`，照样命中；正则区分不了引号内外。
- **I：匹配前剥掉引号内容**：#443 已经否决过（`rm -rf '/'` 漏报）；同理 `'sudo' id` 会漏。
- **J：sudo 降级为 medium**：无头下 medium 同样落拒，等于没改。
- **L：sed 正则排除 `.test` 这类文件名**：`s.a.b.e` 形态的路径有无穷多。
- **find / awk 整个移出只读集**：`find . -name`、`awk '{print $1}'` 是最常见的只读用法，无头下会变成拒绝，误拦大于漏拦。
- **awk 只要脚本含 `>` / `|` 就判非只读（02e 原方案）**：本地轨迹统计后放弃，见下一段的数字。改为只在 print/printf 语句里算。

## 拿什么证明它生效了

- **探针**（02b 附录 A，`SID_ROOT` 指向 worktree 源码）：修前 57 条里 26 条 `✗`，与附录 B 一致；修后剩 4 条 `✗`，都是预期内的：
  - `P3v#1-去merge-base`、`P3v#1-去sudo去mb`：拒绝原因从「sudo 命令」变成默认 ask。卡在 P3 清单 `Read, Grep, Glob` 里没有 bash allow，`cd` 前缀走不了 allow 组合。02b §1.1 写明 #7 的口径是「原因不是 sudo」，不是放行。
  - `git diff --output`：在 P 清单下命中 `Bash(git diff *)` allow，是用户显式授权；换成 P3 清单（无 allow）后判拒，已加探针用例 `gdo-P3` 核过。
  - `bun test x > out.txt`：02b 附录 B 已标注为可接受（allow 命中、写工作区内文件）。
  - 另加 16 条探针（`cd /etc && …`、`cd <ws> && tail -5`、`cd <ws>; …`、`| cat /etc/passwd`、`| grep x /etc/passwd`、`| grep -r x`、`| grep a*`、`| tail < /etc/passwd`、`| sort -o`、`| uniq - /tmp/x`、`| sed e`、未闭合引号 sudo、`-execdir sudo` 等），全部符合预期。
- **新测试**：`tests/permission/allow-list-pipeline-filter.test.ts`（101 条）、`tests/tool/read-only-side-effect-args.test.ts`（34 条）、`tests/tool/bash/sed-validation.test.ts` 新增 19 条。`dangerous-command-matrix.test.ts` 136 pass（含 #443 的 critical 硬拒）。
- **旧行为探测**：把 4 个源文件换回 `origin/main` 后跑这三份测试，49 条失败，「变放行」10 条全红；sudo 误报 3 条、sudo 变形 3 条、N6 17 条、sed 16 条也全红。证明测试确实测到了修前行为。
- **变异自证**（逐项改坏 → 跑 4 份测试 → 恢复）：
  - M1 过滤器换成 `isReadOnlyCommand` → 6 红（`| cat /etc/passwd`、`| grep x /etc/passwd`、`| grep -r x`、`| grep a*`、`| tail < /etc/passwd`、`| LD_PRELOAD=… tail`）。
  - M2 去掉重定向检查 → 5 红；M3 去掉「必须在 `|` 之后」→ 1 红（`tail -5 && bun test x`）。
  - M4 去掉「至少一段命中 allow」→ **单独改 0 红**：`cd <ws> && tail -5` 里 `tail` 在首段管道的 s=0 位置，被「`|` 之后」先挡住了。和 M3 同时改坏后 2 红，所以 M4 是 M3 的第二道防线，单独看不到。
  - M5 cd 不校验目录 → 1 红；M6 sudo 不跳 wrapper → 4 红；M7 不处理 `-exec` → 2 红；M8 删掉 tokenize 回退 → 1 红；M9 sed 改回扫整条 → 16 红；M10 删掉 `-f` → 2 红。
  - N6a–f（`find`/`awk`/`sort`/`uniq`/`--output` 逐项还原，awk 改回整段扫 `>|`）→ 分别 5 / 7 / 3 / 1 / 2 / 3 红。
- **awk 误拦量级**：本地 `~/.sid-code/trajectories` + `sessions` 里去重后 232 条命令、300 次 awk 调用。脚本含 `>` 或 `|` 的有 212 次（71%），其中只有 2 次在 print/printf 里，其余 210 次是 `NR>=10 && NR<=20`、`||` 这类比较或交替。按 02e 原判据会有七成 awk 落到 ask；按最终判据，300 次里 **0 次**被判非只读。那 2 次 print 里的 `|` 都在字符串字面量内（`printf "%d|%s\n"`），去掉字面量后不算。
- **门禁**：`bun run affected-tests:run` 2242 pass / 0 fail；手动补跑 `query/repeated-readonly-guard`、`low-yield-spin`、`p0-safety-bypass`、`p1-sensitive-bypass`、`bash-redirect-extraction` 共 218 pass；`make build` 自检通过，`will always be undefined` 0 处；lint、format:check、lint:boundary、lint:command-system、typecheck:gate（66 / 基线 66）全过；`docs:gen-reference` 无漂移。
- **全量 `bun test`**：18140 pass / 2 fail（459s）。两条红同一根因，与本 PR 无关：
  - `memory/team/sync.test.ts`「缺陷 8：冲突副本可见」：`sync.ts:337` 用 `Math.max(…) | 0` 截断毫秒时间戳，int32 溢出，副本名成了 `k.conflict--2139744052.md`（当天 `Date.now() | 0` 实测为负）。该测试不 import 本次改动的模块；在父仓 main `d7f7b855` 上单跑同样 1 fail。主仓工作区里已经有别人修这一处的在途改动（`sync.ts` / `store.ts` 未提交），本 PR 不碰。
  - `tests/build/no-real-trajectory-writes-runtime.test.ts`：门禁子进程跑 `memory/` 等四个目录时退出码为 1，就是上面这一条；假 HOME 下单跑四个目录 1621 pass / 1 fail，fail 的也是它。
- **待 F2**：P1v / P2v 各跑 2 次 `sc-dev`，判据见 bench_fix 03-F2。
