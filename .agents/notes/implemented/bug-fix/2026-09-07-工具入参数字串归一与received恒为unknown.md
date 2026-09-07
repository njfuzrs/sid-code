---
Status: implemented
Date: 2026-09-07
---
# 数字形态字符串在协议边界归一成 number；顺带修掉「实际收到 unknown」这句零信息量的错误消息

## 决定了什么

两个缺陷，同一个文件收口（`packages/core/src/tool/input-validator.ts`，4 个调用点共用）：

**缺陷 1 — 白烧往返（新增 `packages/core/src/tool/numeric-coerce.ts`）**

模型偶发给 `z.number()` 字段多打一对引号，被 zod 硬拒。实测三处，全在 `read.offset`：

| 会话 | 入参 | 轮数 |
| --- | --- | --- |
| `20260907-163824-da9094a7` | `offset:"117, 130"` | 2 |
| `20260907-163824-da9094a7` | `offset:"334, 360"` | 2 |
| `20260903-152752-56491335` | `offset:"1,1"` | 2 |

模型下一轮都自己改对了（`offset:117, limit:30`），**所以损失不是任务失败，
而是每次白烧一轮完整往返**（含全量上下文重发）。发给模型的 schema 是对的
（raw.jsonl 里确认 `"offset":{"type":"number"}`），是模型先违约——但**能不能自救
是 harness 的责任**：`"117"`→117 无损无歧义，我们既知道它要什么又拒绝执行，纯属自伤。

新模块在 `normalizeStrictNulls` 之后、`safeParse` 之前做一次归一，只认两种形态：
整串是十进制数（`"117"`/`" 117 "`/`"-3"`/`"1.5"`/`"1e3"`），或逗号/连字符区间取**首个**数
（`"117, 130"`→117，因为 offset 语义就是起点；余下的 130 属于 limit，**刻意不猜**——
猜错会静默读错范围，比报错更糟）。其余一律原样放回让 zod 报错。

判据走 schema 结构内省（`def.type === "number"`），不无脑扫 input：反例就在 read 自己的
schema 里——`pages` 是 `z.string()`，合法值形如 `"2,4,7"`，无脑转换会把**本来合法**的
调用改成非法的（修 A 造出 B）。

**缺陷 2 — 错误消息恒为「实际收到 unknown」**

`translateIssue` 写的是 `issue.received ?? "unknown"`，但 **zod v4 的 invalid_type issue
根本不含 `received` 字段**（实测 4.4.3 与 4.5.4：issue 只有 expected/code/path/message，
实际类型只出现在 message 文本里）。所以这个分支是死代码，**所有工具的所有类型错误**
都渲染成「实际收到 unknown」——对模型零信息量，还误导它以为参数值是 undefined。
改成从 message 提取真实类型，提不到才退回 unknown。

顺带记一条不一致：`grep.offset` 用 `z.coerce.number()`（`grep.ts:84`），`read.offset` 用裸
`z.number()`——**同名同语义字段，两个工具行为相反**。本次归一在协议层统一了这件事。

## 放弃了什么（以及为什么不选）

**① 把 `read.offset` 改成 `z.coerce.number()`（最直觉的方案）—— 否决，两条硬伤**

- **它修不了实际发生的这一例**。真实入参是 `"117, 130"`，`Number("117, 130")` = NaN，
  实测 `z.coerce.number().safeParse("117, 130").success === false`。改了等于没改。
- **它会静默吞掉危险值**：`safeParse("")`→0、`safeParse(null)`→0、`safeParse([])`→0、
  `safeParse(true)`→1。这正是 `nullish-normalize.ts` 顶部记录过的污染
  （grep 一次调用 4 个 coerce 字段全被 null 污染成 0，无报错无日志）。
  给 read.offset 加 coerce = 再开一个同样的洞。

这条否决已钉成可执行断言（`numeric-coerce.test.ts` 里那条「对照自证」），
哪天有人再提议 coerce，测试会当场告诉他代价。

**② 逐个工具改 zod（web_search.max_results / task_output.timeout / schedule_wakeup.delay_seconds 也是裸 number）—— 否决**

与 `nullish-normalize.ts` 拒绝「改 23 个工具」同一个理由：协议层的形态差异不该摊派给
每个工具作者。逐个改会漏，且后续新增 number 字段的人不会知道有这回事。

**③ 用 `safeParse(123)` 试探字段能否接受数字 —— 否决**

会把 `z.union([z.number(), z.string()])`、`z.any()` 一并判成 number，而这类字段模型传
字符串可能本就合法，我们没资格替它改。必须走结构内省。（`nullish-normalize.ts` 用
`safeParse(null)` 试探踩过同一个坑，那里也是改成了结构内省。）

**④ 顺手把 `"117, 130"` 的 130 猜成 limit —— 否决**

看着很聪明，但猜错就是静默读错范围。报错会被模型下一轮修正，静默读错不会。
只把 offset 修对，limit 交给 read 的 `DEFAULT_MAX_LINES` 兜底。

**⑤ 改 `read.pages` 的 describe 措辞（怀疑 `"2,4,7"` priming 出了 `"117, 130"`）—— 不做**

同一 schema 里 `pages` 确实用逗号表达区间，形态上有 priming 的可能，但这是**推测**，
拿不出证据（无法证伪）。改文案属于赌一个说不清的因果，而归一层无论根因是什么都生效。

## 拿什么证明它生效了

**归一层真的接进了生产路径（不是只写了个纯函数）** —— 测试里有一组走真实
`validateToolInput` 入口，喂的就是轨迹里那三条原始入参：

```
$ bun test ./packages/core/tests/tool/numeric-coerce.test.ts
 41 pass / 0 fail / 73 expect() calls
```

**变异自证（拆掉修复必须变红，否则测的是想象中的实现）** ——

| 变异 | 结果 |
| --- | --- |
| `const normalized = nullNormalized`（模块还在，拆掉接线） | **3 fail** |
| `issue.received ?? "unknown"`（received 修复退回原实现） | **1 fail** |
| 还原后复跑 | 41 pass / 0 fail |

变异 1 特意只拆接线、不删模块——它拦的正是「代码写好了但没接进真实入口」这种
零报错的失效形态。

**边界实测（22 组，逐条打表核过）** ——
接受 `"117"`/`" 117 "`/`"-3"`/`"1.5"`/`"1e3"`/`"117, 130"`/`"117-130"`/`"117，130"`；
拒绝 `""`/`"   "`/`"abc"`/`"117, abc"`/`"0x1f"`/`"Infinity"`/`"NaN"`/`true`/`[]`/`{}`；
`pages:"3"`/`"2,4,7"`/`"1-5"` 三条保持字符串且仍然合法（证明没有修 A 造出 B）。

**四道门禁** ——

```
$ bun run affected-tests            # 判定 selective → packages/core/tests/tool/
$ bun test ./packages/core/tests/tool/ --test-name-pattern '^(?!.*\[slow\])'
 1027 pass / 0 fail / 22210 expect() calls
$ bun run lint                      # oxlint 干净（首轮曾报 isNumberField 未使用 → 已删）
$ bun run format:check              # All matched files use the correct format
$ bun run lint:boundary             # 越界依赖 0 处
$ make build                        # 自检 5 项通过；grep 'will always be undefined' → 无
```

**朝向北极星哪个方向**：**更省**（消除白烧往返：每次失败重发一次全量上下文）
+ **更准**（②工具层：把一个必然失败的调用变成成功；错误消息带真实类型，提升自我纠错率）。
**牺牲了什么**：多一层入参改写——风险是「归一错了会静默读错位置」。
对价是把接受面压到最小（只认能确定意图的形态，拿不准一律放回报错），
且区间形态刻意只修 offset 不猜 limit。
