---
Status: proposed
Date: 2026-08-28
---
# 路 B 对照侧接入 mini-SWE-agent：只做格式转换与必控变量固化，一个指标都不重算

## 决定了什么

新增三个文件，把「同模型换 harness」这个对照实验的**对照侧**做成可复算的两条命令。
**本次只做准备，刻意不跑真实评测** —— 原因见下面「放弃了什么」第一条。

| 文件 | 职责 |
| --- | --- |
| `evals/external-benchmarks/swe-bench/run-mini.sh` | 驱动 mini 跑我们那 10 条 subset，把 4 个必控变量写死 |
| `evals/external-benchmarks/swe-bench/mini-adapt.ts` | 把 mini 产物转成 `grade.ts` 认的形状（`predictions.jsonl` + `records.jsonl` + `run-meta.mini.json`） |
| `tests/eval/swe-bench-mini-adapt.test.ts` | 41 条断言 + 4 条变异自证 |

**服务的北极星方向是「更准」。** `CLAUDE.md` 把「更准」的主语定义为 harness 而非模型，
这需要一个「控制模型、只换 harness」的对照实验 —— 路 B 就是它，而对照侧此前只有
A7.14.4 那条手敲命令。

七个具体决定：

1. **`step_limit=80` / `cost_limit=0` 写死成脚本常量，不做可调旋钮。**
   A7.14.8 已裁决这两个值。做成旋钮就会有人在跑不出想要结果时调它，
   而调完之后两边不可比、报告上看不出来。
2. **必控变量对账做成门禁，按严重度分级**：模型不同 → `exit 2`；
   网关不同源 → 报警放行；退化挑中 → 报警。**不许静默退化**。
3. **`permission_denials` 落 `null` 而不是 `0`**（本次最重要的一条口径）。
   mini 没有权限层，这是「结构性不适用」而非「量到了是 0」。
   落 0 会把「这个 harness 没有这层防线」伪装成「一次没被拦」——
   与 A7.13.2 完全同型，而两者在数据上同形、结论方向相反。
4. **`setup_ms`/`extract_ms` 省略而不是落 0**：`grade.ts` 对缺字段的处理是
   「跳过分解、不做假汇总」，正是想要的；落 0 会破坏
   `setup+agent+extract===wall` 那条不变量。
5. **未知 `exit_status` 一律映射成 `agent_error`，不猜**。
   一个没见过的状态被当成正常提交，会让链路故障伪装成低分。
6. **subset 从 `verified-subset.yaml` 现取，不硬编码 id 列表**。
   硬编码的形态是 subset 重新生成后两边跑的题目悄悄不同了，而两份报告都正常。
7. **判据函数一律复用 `runner.ts` 的既有实现**（`isTestPath` / `normalizePatch` /
   `patchOnlyAddsFiles`）。「哪些路径算测试文件」是判断，两侧口径必须逐字节一致，
   否则那些字段根本不可比 —— 这是记忆里「没用既有口径、自己另找源」那个错误的第五次，
   认出来就别再踩。

**它牺牲了什么（自检第 3 问）**：**耗时对比的精度**。mini 不记逐题墙钟，
我们也没在外面计时，所以 `wall_ms`/`agent_ms` 落 0（=没量）。
路 B 这一轮能拿到的是**分数与轮数的差值，不是耗时的差值**。
换来的是不在适配器里假造一个耗时数 —— 假造的代价是那个数会被当真并写进报告。

## 放弃了什么（以及为什么不选）

- **本次就把路 B 跑起来。** 否决，理由是资源冲突且**会污染路 B 自己的产出**：
  本机只有一个 colima profile（`swebench`，8 vCPU/16GiB），而 harbor 的 A10 对照
  此刻正在同一个 daemon 上跑；镜像全是 amd64、在 aarch64 VM 上走 qemu 全模拟。
  CPU 争抢的后果不是"慢一点"：① 会把 qemu 下的超时推过线，形态是
  `VerifierTimeoutError`，**长得像链路坏了**（harbor README 已记同型教训）；
  ② 耗时口径被污染，而**没有任何字段能记录"当时另一边在编 cython 扩展"**。
  磁盘不是阻碍（VM 数据盘剩 108G、宿主剩 547G），CPU 与耗时口径才是。
  → 裁决：**串行，等 harbor A10 跑完**。顺序上也无损，两条曲线刻意不比分数。

- **在适配器里"修正"不对齐的必控变量**（比如把 mini 的 250 改写成 80 再落盘）。
  否决：那等于让一轮不可比的数据长得可比。适配器**只报告、不改值**，
  `run-meta.mini.json` 里落的是实际值 250。有断言钉住这条（变异 C）。

- **给 `permission_denials` 走 fallback**（mini 侧没有就读别的源顶上）。
  否决：这正是 A7.13.2 刚拆掉的那个代理判据的形态。缺就是缺，落 null 并写进
  `unaccounted` 说明「本 harness 结构性缺此机制」。

- **放宽 `RunRecord` 的类型，让 `edits_inside_repo` 也能落 null。**
  否决：`RunRecord` 是 sid-code 侧的事实源，为一个对照 harness 放宽它的类型，
  会让我方将来"没量到"也能悄悄落 null 而不被发现。
  代价承认：这两个字段只能落 0，靠 `unaccounted` 里的统一点破兜住语义。

- **复用 `record.ts` 做转换**。否决：它的输入是容器里 git diff 的**原始输出**
  （numstat + diff 两段），而 mini 的 `preds.json` 里已经是成品 patch。
  复用等于先把成品拆回 raw 再解析一遍，凭空多一层可失败的转换。

- **用 `+++ b/X` 解析 diff 路径**（第一版就是这么写的）。否决：纯删除文件的
  hunk 里 `+++` 是 `/dev/null`，路径只在 `diff --git` 行上 → 会**漏掉**该文件，
  `patch_touches_tests` 假阴性。改用与 `runner.ts newFilePaths` 同一个正则。
  有断言 + 变异自证 D 钉住。

- **跳过 `-c <默认 config>`**（命令看起来更短）。否决：上游 `--help` 用红字警告这条 ——
  一旦设了 `-c`，默认 config **整份失效**（含 `instance_template`），
  而形态是 agent 拿到空模板照样跑完。

- **在 `run-mini.sh` 里报任何通过率**。否决：`exit_status=Submitted` **不等于 solved**
  （A7.14.4 实测点破），判分归官方 harness。脚本收尾显式打这句话。

## 拿什么证明它生效了

**已经跑过、有输出的**：

```
bun test ./tests/eval/swe-bench-mini-adapt.test.ts   → 41 pass / 0 fail / 81 expect
bun run affected-tests:run                            → 1200 pass / 0 fail（51 文件）
make build                                            → 通过，自检 4 项全过
grep -c "will always be undefined"                    → 0
bun run lint / format:check / lint:boundary            → 全过（format 修过一次）
bun run docs:gen-reference --check                     → 参考页与源码一致
```

**四条变异自证**（`CLAUDE.md`：新增门禁必做变异自证。对着**真实实现**改坏，
不是对着测试替身 —— A7.17.7 ③ 的教训）。每次都**只红对应那一条 + 它的自证条**：

| 变异（改真源文件） | 实际翻红 |
| --- | --- |
| `permission_denials: null` → `0` | 「permission_denials 是 null，不是 0」+ 变异 A → 2 fail |
| 未知 exit_status 映射成 `patch_produced` | 「未知状态 → agent_error」+ 变异 B → 2 fail |
| `step_limit: sl` → 有值时改写成裁决值 | 「不许悄悄修正必控变量」+ 变异 C → 2 fail |
| `parseDiffPaths` 改用 `+++` 解析 | 「纯删除文件也能取到路径」+ 变异 D → 2 fail |

四次全部还原后回到 41 pass / 0 fail，`git status` 只剩本次三个新文件。

**端到端实测（不调模型、不起容器）**：按 mini 的真实输出格式造一份产物
（`preds.json` dict-of-dict + `<iid>/<iid>.traj.json`），跑转换 → 产出三个文件，
逐字段核对：`permission_denials: null` ✅、`host_slept_ms: null` ✅、
`setup_ms`/`extract_ms` 已省略 ✅、`patch_bytes: 468`（normalizePatch 后）✅、
`comparability_notes: []`（必控变量对齐）✅。产物已清理。

**`--dry-run` 实测**：10 条题目正确解析、网关与 smoke-10 同源
（`code.ppchat.vip`）、`step_limit 80 / cost_limit 0`、key 只打印长度不打印值。

### 🔴 准备过程中挖出的三个真实缺陷（都是"不报错"那类）

这三个是本次最有价值的产出 —— 它们都在 dry-run 阶段暴露，若直接开跑则会
**污染一整轮数据而报告看起来正常**。

**① 取 key 与取 URL 的挑法不一致 → 上游 401，而 401 长得像"凭据过期"。**
`~/.sid-code/settings.json` 里**有两个条目的 `model_id` 都是 `claude-sonnet-5`**
（`claude-sonnet-5-gateway`→uniapi / `claude-sonnet-5-ppchat`→ppchat）。
只按 model_id 挑会拿到**先出现的那个**（uniapi），而 smoke-10 用的是 ppchat ——
于是"同模型"成立而"同网关"不成立。两个网关的限流、缓存策略、计价口径都不同，
**且这些差异全部落在 harness 差值里、事后无法分离**。
修法：优先按 smoke-10 的 `gateway_host` 精确匹配，退化时显式报 `fallback`。

**② mini 的启动横幅走 stdout，不是 stderr。**
`This is mini-swe-agent version 2.4.6...` 共 4 行由 rich console 写 **stdout**，
所以 `2>/dev/null` **治不了**它。第一版脚本因此报
「❌ mini 内置 config 不在：This is mini-swe-agent version 2.4.6...」——
形态是**文件明明在，脚本说找不到**，而报错里那段横幅把人引向别的方向。
更危险的是 `read -r GW_HOST GW_URL KEY_LEN` 那处：横幅会被拆成
`GW_HOST="This"` / `GW_URL="is"`，三个变量都有值、脚本一路往下跑。
修法：不需要 mini 包的取值一律改用系统 `python3`（少一个污染点），
需要的那处 `| tail -1`。
> ⚠️ **归因教训**：我第一版注释写的是「横幅走 stderr，`$( )` 只捕获 stdout 所以不进变量」——
> 这个假设**没核就写进了注释**。实测 `2>&1 >/dev/null` 后横幅仍在 stdout。
> 这是「回源码核对却核错了源」的同型，只不过核错的是自己的推断而非别人的代码。

**③ subset 解析的字符类漏了引号 → 零命中。**
`verified-subset.yaml` 里 instance_id 是**带双引号**的
（`instance_id: "astropy__astropy-12907"`），第一版正则 `[A-Za-z0-9_.\-]+` 漏了引号
→ **一条都匹配不到**，而兜底把它报成"形状变了"，把人引向 subset 而不是那行正则。
与记忆里「密钥正则的前缀盲区」同型：字符类漏一个字符即全漏。
修法：`["']?` 包住，并加一条重复 id 的反向自证（**分母悄悄变小 = 分数虚高**）。

### ⚠️ 还没证明的（不在本 Note 内打勾）

- **真实评测一轮都没跑**。转换器只在造出来的产物上验证过 —— 形状逐字取自
  `run/benchmarks/swebench.py` 与 `agents/default.py` 的真实源码（version 2.4.6，
  `trajectory_format: mini-swe-agent-1.1`），但**造的产物不等于真产物**。
- **`grade.ts` 吃 mini 侧 records 的行为未验证**。`permission_denials: null` 走的是
  `aggregatePermissionDenials` 的 notMeasured 分支（A7.17.7 已有 7 条断言），
  但**没有用 mini 侧数据端到端跑过一次判分**。
- **mini 版本已从 preflight 时漂到 2.4.6**（v2 有迁移指南）。我核过
  `trajectory_format` 仍是 `1.1`、`step_limit`/`cost_limit` 语义未变
  （`0 < cost_limit` 才判停，所以 0=不限与我方一致），但**没有跑过一题**验证
  A7.14.4 那条命令在 2.4.6 上仍然通。

**最终判据不是"脚本能跑"，是**：路 B 那一轮跑完后，
`run-meta.mini.json` 的 `comparability_notes` 为空（必控变量真的对齐）
且两侧 `grade.ts` 报告能并排。按本仓「防线自己成了它当初要消灭的死功能」那条教训，
在那之前这三个文件的状态如实是**「已建成，未在真实数据上验证」**。
