---
title: 主循环机制：六道闸门守着一个几乎没人经过的出口
description: 一个 agent 主循环里最复杂的一段代码，是模型说"我做完了"之后才跑的那 400 行——六道闸门依次拦它。实测 426 轮里只有 40 轮走到那里，六道闸门总共只响了 1 次。这篇把闸门链的形状从约束推出来，交出触发率实测，指出真正的偏差发生在闸门之前（一个模型宣称 end_turn 却仍在调工具，3/6 轮），以及为什么这个偏差只写进了 warn.log 而没进结构化轨迹。
date: "2026-08-09"
series: Agent 架构
audience: engineer
highlight: 426 轮实测 · 六道闸门共响 1 次 · 一个模型 6 轮里 3 轮协议偏差
tags: [Agent 架构, 主循环, 机制解析, 实测]
---

# 主循环机制：六道闸门守着一个几乎没人经过的出口

你让 agent 改三个文件，它改完两个就停下来说"完成了"。第一反应大概是
"模型不够聪明"，于是你换个更强的模型。

换模型不解决这件事。**这是 harness 的活**——模型宣称结束的那一刻，
有没有人查一遍它到底做完没有。sid-code 在那个位置放了六道闸门。

但闸门有触发率。这篇的主要内容是：那六道闸门实测只响过 1 次，
而同一批数据里真正出问题的地方在闸门之前。

::: tip 结论先放这里
- 主循环有 22 个 `continue`（回到下一轮）、6 个 `break`、23 个 `return`。
  「继续还是收尾」不是一个 if，是 51 个出口。
- 六道 `end_turn` 闸门（Stop Hooks / 未答复兜底 / todo 完成度 / 假设交付 /
  token 预算 / goal 判定）在 43 个会话、426 轮里总共触发 1 次（2026-08-09 实测）。
- 不是闸门坏了：426 轮里只有 40 轮（9.4%）走到 `end_turn` 分支，
  其余 386 轮都是 `tool_use` 直接续。闸门链的分母比想象的小一个量级，
  而其中四道还各有前置条件，真实分母要再小一层。
- 出乎意料的那一项：`gpt-5.6-luna` 在 6 轮里有 3 轮宣称 `end_turn`
  却仍在 content 里带 `tool_use`（协议偏差）。兜底代码把它接住了，
  但这件事只写进 warn.log，一条结构化轨迹事件都没有——
  于是它无法被聚合，我是靠比对两个计数器差 1 才发现的。
- 主循环默认没有轮次上限（`maxTurns: 0` → `Infinity`），
  这是刻意对齐 claude-code 的取舍，代价写在边界节里。
:::

## 一、约束：为什么"继续还是收尾"不能是一个 if

先把不可协商的事实摆出来。

约束一：**模型的 `stop_reason` 是它的自我声明，不是事实。**
协议层给你的信号只有一个字符串。`end_turn` 的含义是"模型认为该停了"，
而不是"任务完成了"。这两件事在弱模型上分叉得很厉害。

约束二：harness 不能读心，只能读状态。你没法问模型"你真做完了吗"——
问了它会说做完了。能查的只有外部可观测的状态：todo 清单里还有没有未勾选项、
假设登记表里还有没有未结清的假设、预算还剩多少。

约束三：拦下来之后必须给模型一个可执行的动作，否则纯烧 token。
拦住一个"其实真做完了"的收尾，模型下一轮无事可做，只会把上一轮的话重说一遍。

按最直觉的做法：`if (stopReason === "end_turn") return;` —— 一行搞定。

后果不可接受：约束一说这个字符串是自我声明。信它，就等于把完成度校验
外包给了被校验的对象。实测那个"改完两个文件就说完成"的现象，
根源就在这里——模型的自我声明与交付事实不一致，而 harness 全盘接受。

所以只能在 `end_turn` 与真正 `return` 之间插一段校验。而校验不止一种
（todo 是一种、假设是一种、预算是一种），且它们的判据互不相同，
于是它必然是一条链而不是一个 if。

链的形状由约束三逼出来：每道闸门拦下之后要注入一段"接下来该做什么"的提示，
然后 `continue` 回到下一轮。这个动作在代码里叫「软续命」——
不是强杀、不是直接放行，是给模型一次带着新信息重试的机会。

副作用一定有（没有说明推导漏了约束）：每道闸门都得有自己的续命预算，
预算耗尽必须放行。放行时还要区分"真没做完"和"做完了忘标记"——
这两种外部观测一模一样，但对用户说的话必须不同，
说错了就是假警报。这一层区分后面会讲到。

## 二、闸门链的形状

`end_turn` 分支的入口条件在 `src/query/loop.ts:2976`：

```ts
if (isEndTurnLike && !hasPendingToolUse) {
```

`isEndTurnLike` 是白名单匹配（`end_turn` / `stop` / `stop_sequence`），
不是黑名单。这个方向很要紧，是从 claude-code 的一个教训抄来的：
`error → hook blocking → retry → error → …` 的死亡螺旋，
根源是"模型从未真正产出响应"时仍跑了基于响应内容的修复流程。
白名单对未知的 `stopReason` 天然 fail-closed，黑名单每新增一种未识别错误
就重新打开一次口子。

进了这个分支，六道闸门依次跑：

| 闸门 | 判据 | 续命上限 | 位置 |
| --- | --- | --- | --- |
| Stop Hooks | 用户配的 hook 返回 blocking | 无硬上限（计数） | `loop.ts:2987` |
| 未答复兜底 | 本轮只思考没答复 | 2 | `loop.ts:3020` |
| todo 完成度 | 清单仍有未勾选项 | 3 | `loop.ts:3056` |
| 假设交付门禁 | 登记表有未结清假设 | 1 或 2（分档） | `loop.ts:3139` |
| token 预算续写 | 本轮带了 `+500k` 预算指令 | 按预算 | `loop.ts:3263` |
| Goal Gate | 独立评估者判定未达成 | 按配置 | `loop.ts:3308` |

顺序不是随便排的：不依赖 todo 的排在依赖 todo 的前面。
"未答复兜底"放在 todo 闸门之前，因为完成度校验链原本全以 todo 存在为前提，
模型不建 todo 就整条链失效。这是一个真实事故推出来的顺序——
模型思考漂移进正文、一个字有效答复都没有，而它也没建 todo，
于是当时所有闸门一起哑火。

再看 todo 闸门里那段"放行时怎么说话"的区分（`loop.ts:3056` 起）。
续命 3 次耗尽后，代码要在两种收尾之间选：

- 真没做完 → 列出未完成项，如实呈现，不假装完成。
- 做完了忘标记 → 中性收尾，不报未完成。

判据是「连续 3 次都在输出实质正文（≥200 字符）却始终不翻状态位」。
这里有一个精巧的前提：本闸门只在 `!hasPendingToolUse` 分支到达，
即本轮没有任何工具调用，所以 `todo_write` 本轮必然没执行。
于是"有产出却不翻状态位"只需判正文长度，不需要再比对 `writeVersion`。

为什么把这段单拎出来讲：**它是"少一层区分就会产生假警报"的具体例子。**
不做这个区分，一个已经交完完整报告的会话会被告知"仍有 5 项未完成"，
而用户会去找那 5 项不存在的缺口。

## 三、实测：六道闸门总共响了 1 次

口径先交代清楚。

分母：`~/.sid-code/trajectories/sessions/` 下 43 个会话的 `events.jsonl`，
时间跨 2026-07-10 至 2026-08-08，共 426 次模型调用（`AfterModel` 事件数）。
这是滚动窗口，你跑出来的数会不同——旧会话会被清理，
`prompt-cache` 那篇就撞过同一个脚本两天后只剩一半会话的情况。

仪器：每个 `continue` 前调 `setTransition()`（`src/query/transition.ts`），
往轨迹写一条 `LoopTransition` 事件，带 `type` 与轮次。

<details>
<summary>复现命令（2026-08-09 实测）</summary>

```bash
cd ~/.sid-code/trajectories/sessions && python3 -c "
import json,glob,collections
c=collections.Counter()
for f in glob.glob('*/events.jsonl'):
    for line in open(f,errors='ignore'):
        try: d=json.loads(line)
        except: continue
        if d.get('event')=='LoopTransition':
            c[(d.get('data') or {}).get('type')]+=1
for k,v in c.most_common(): print(v,k)
"
```
</details>

结果：

| `LoopTransition.type` | 次数 |
| --- | --- |
| `tool_use` | 387 |
| `timeout_retry` | 1 |
| `todo_gate_retry` | 1 |
| 其余 20 种（含全部六道闸门） | 0 |

六道 `end_turn` 闸门加起来触发 1 次。22 个 `continue` 出口里，
实测被走过的只有 3 个。

先别急着说闸门是死代码。**结论反常时先怀疑仪器**——这是本项目吃过教训的一条纪律：
只记 hit 不记 write，会把"每轮重写"误判成"网关不支持"。
所以我先审仪器的覆盖面：

```
loop 主体内 continue 总数: 22
其中有 setTransition 覆盖: 22
```

<details>
<summary>覆盖率审计脚本</summary>

```bash
python3 - <<'EOF'
import re
src = open('src/query/loop.ts', errors='ignore').read().split('\n')
HEAD = 'while (state.turnCount < state.maxTurns)'
start = next(i for i, l in enumerate(src) if HEAD in l)
n = cov = 0
for i in range(start, 4112):
    if not re.match(r'^\s*continue;\s*$', src[i]):
        continue
    n += 1
    back = range(i - 1, max(start, i - 60), -1)
    if any('setTransition(' in src[j] for j in back):
        cov += 1
print(f"continue: {n}, instrumented: {cov}")
EOF
```

一个坑：按 14 行窗口回溯会误报 2 处未覆盖（L2292 / L2341），
它们的 `setTransition` 分别在 77 行和 16 行之外——
超时重试路径中间插了退避睡眠与遥测，压缩路径中间插了 banner 构造。
窗口取窄会把"覆盖了"读成"漏了"，这正是仪器审计本身也需要审的原因。
</details>

仪器是全的。那 0 就是真的 0。

## 四、真正的解释：分母小一个量级

闸门链的分母不是 426，是走到 `end_turn` 分支的轮次。

| `stop_reason` | 轮次 | 占比 |
| --- | --- | --- |
| `tool_use` | 386 | 90.6% |
| `end_turn` | 40 | 9.4% |
| 合计 | 426 | 100% |

90.6% 的轮次根本不经过闸门链。模型在调工具，闸门链在等一个
"我做完了"的声明——而这个声明在 43 个会话里只出现 40 次
（平均每会话 0.93 次，因为多数会话就是一条用户消息一次收尾）。

再往下切一层。六道闸门里有四道有前置条件：

- todo 闸门需要 todo 清单非空。实测 43 个会话里只有 4 个用过
  `todo_write`（21 次调用），落在这 4 个会话里的 `end_turn` 只有 6 次。
  也就是说 todo 闸门的真实分母是 6，不是 426。它响了 1 次 —— 1/6。
- 假设交付门禁需要 `hypothesis_register` 工具已注册，
  而它默认关闭（`src/query/hypothesis-ledger.ts:355`，需 `SID_ENABLE_HYPOTHESIS=1`）。
  关闭的依据是受控 A/B：开关 ON/OFF 准确率同为 5.00/5，而 ON 多花 +75% input。
  它的分母是 0，触发 0 次是正确行为，不是缺陷。
- token 预算续写只在用户输入带 `+500k` 这类指令时生效。窗口内没有。
- Goal Gate 只在 `/goal` active 时生效。窗口内没有。

于是"六道闸门响 1 次"这个数字要重新读：真正有分母的闸门只有两道
（Stop Hooks 与未答复兜底也需要外部条件），其中 todo 闸门在它自己的
6 次机会里响了 1 次。

**一道防线的触发率，分母必须是"前置条件成立的次数"，而不是"总轮次"。**
用总轮次当分母，会把"条件很少成立"误读成"机制没生效"，
接着去修一个没坏的东西。这条教训脱离 sid-code 也成立——
任何带前置条件的兜底逻辑，报触发率时都得先报前置条件命中率。

那唯一响的一次值得看一眼。会话 `20260807-183739-a6fb7063`，第 34 轮：

```
AfterModel      stop_reason=end_turn  in=71108 out=656
LoopTransition  {"type":"todo_gate_retry","turn":34}
NoProgressNag   {"kind":"work-log","turn":35,"nagCount":1,"cap":2}
BeforeModel     index=35
```

模型在第 34 轮宣称结束，todo 闸门拦下、注入提醒、第 35 轮继续。
机制按设计工作了。它只是很少有机会工作。

## 五、出乎意料的那一项：偏差发生在闸门之前

统计的时候两个计数器对不上：`LoopTransition:tool_use` 有 387 次，
而 `stop_reason=tool_use` 只有 386 次。

差 1。按数字自洽的要求，这个 1 必须解释掉。

逐会话比对，找到四个不一致的会话：

| 会话 | `stop_reason=tool_use` | `transition=tool_use` |
| --- | --- | --- |
| `20260808-150140` | 5 | 4 |
| `20260809-052940` | 30 | 29 |
| `20260809-051052` | 0 | 1 |
| `20260809-051215` | 0 | 2 |

前两个差 -1 是尾部截断（两个会话都没有 `SessionEnd` 事件，即异常退出：
最后一轮的 `AfterModel` 已写、`LoopTransition` 没写完）。后两个是反的：
零次 `tool_use` 停止原因，却有 tool_use 转移。

展开看：

```
SessionStart      model=gpt-5.6-luna
UserPromptSubmit  "在 /tmp/... 写入一行 hello，然后告诉我完成了"
AfterModelRaw     stop=end_turn  content=["tool_use"]   ← 矛盾
PreToolUse        tool_name=read
LoopTransition    {"type":"tool_use","turn":1}
AfterModelRaw     stop=end_turn  content=["tool_use"]   ← 又一次
PreToolUse        tool_name=write
LoopTransition    {"type":"tool_use","turn":2}
AfterModelRaw     stop=end_turn  content=["text"]
SessionEnd        exit_status=end_turn
```

`stop_reason=end_turn`，而 content 里是 `tool_use`。模型说"我完事了"，
同时递给你一个待执行的工具调用——协议层的自相矛盾。

按模型聚合：

| 模型 | 轮次 | `end_turn` | 其中带 `tool_use` |
| --- | --- | --- | --- |
| glm-5.2 | 256 | 21 | 0 |
| origin-deepseek-v4-flash | 58 | 5 | 0 |
| origin-deepseek-v4-pro | 54 | 4 | 0 |
| claude-opus-5 | 30 | 0 | 0 |
| ali-deepseek-v4-pro | 22 | 4 | 0 |
| gpt-5.6-luna | 6 | 6 | 3 |
| 合计 | 426 | 40 | 3 |

集中在一个渠道上，6 轮里 3 轮。其余五个模型 370 轮零偏差。

⚠ 口径警告，这个数我得自己先拆掉：样本量只有 6 轮，不足以下"这个模型有 50%
偏差率"的结论。能说的只有"这个渠道出现过这种偏差、其他渠道在 370 轮里没出现过"。
要下率的结论得专门跑受控对照，我没跑。

代码接住了这件事。`loop.ts:2938` 单独算了一个 `hasPendingToolUse`，
入口条件是 `isEndTurnLike && !hasPendingToolUse` —— 带 tool_use 就不进闸门链，
fall-through 到下面的工具执行分支正常执行。轨迹里那两个会话的工具确实都跑了。

**没有这个 fall-through，后果是任务静默停在第一步**：
模型请求 read，harness 看见 `end_turn` 直接收尾，工具从没执行，
用户看到的是"它说完成了，但文件没动"。

## 六、但它没有被记进轨迹

兜底代码在执行工具之前打了一条 warn（`loop.ts:2968`）：

```
[WARN] [QUERY_LOOP] stop_reason 与 content 不一致：声称 end_turn/stop
但含 tool_use（疑似代理协议偏差，已自动兜底执行工具）
{"stopReason":"end_turn","toolUseCount":1,"model":"gpt-5.6-luna"}
```

注释写得很清楚，意图是"把被动兜住升级为主动暴露：便于按 model 聚合发现
哪家第三方代理有此协议偏差"。

但它是 `log.warn`，不是 `deps.traceAppendEvent`。两者的差别：

```bash
# 结构化轨迹里：0 条
# （grep 到的那 1 条是某次用户提问正文里的"不一致"，不是本事件）
grep -h '不一致' */events.jsonl | wc -l          # → 1

# 非结构化日志里：3 条，正是那 3 次协议偏差
grep -h 'content 不一致' */warn.log | wc -l      # → 3
```

**按 model 聚合是这条 warn 自己写下的目标，而 warn.log 聚合不了。**
`src/trace/digest.ts` 对 warn.log 的处理只是给出一个文件指针
（`digest.ts:1519`），不解析内容；而 `LoopTransition` 那类事件是被
逐条读进去做统计的。同一个机制，一个进得了 `/trace` 的表，一个进不了。

这不是"忘了埋点"那么简单。它属于「仪器少记一个维度，就让两种故障塌缩成
一个观测」这一族：F2 fall-through 兜底成功、和"从未发生过偏差"，
在结构化轨迹里长得一模一样（都是 0 条事件）。
我发现它靠的是两个计数器差 1，而不是靠查询这个机制本身。

北极星归属上，这条属于「底座 · 可度量」：主循环的偏差归因能力
比它的兜底能力弱一档。兜底是对的，可见性是缺的。

顺带交代张力，因为这篇讲的机制正处在两个方向的拉扯上：
六道闸门服务的是「更安全」（不让模型假装完成），
代价直接落在「更快」和「更省」上——每次软续命都是一整轮额外的模型调用，
todo 闸门那唯一一次续命花了 71k input token。
所以每道闸门都有续命上限，且假设门禁在 A/B 显示"准确率没变、input +75%"
之后被默认关掉了。这不是妥协的遗憾，是取舍被数据裁决了。

## 七、当前的能力边界

主循环默认没有轮次上限。`maxTurns: 0`（`src/config/config.ts:792`）
在 `loop.ts:560` 被转成 `Infinity`。这是刻意对齐 claude-code
（交互模式也无硬上限），尊重"不打断长任务"。
绕法：`SID_MAX_TURNS=<N>` 开一个软阈值提醒（`src/query/soft-turn-limit.ts`），
超过 N 轮注入一次自省提示。注意它只提醒不强杀，不会掐断任务。
失效方向偏安全（宁可多跑不误杀），但对接弱模型的长任务仍需要人盯着 ESC。

F2 协议偏差不进结构化轨迹（上一节）。绕法：
`grep 'content 不一致' ~/.sid-code/trajectories/sessions/*/warn.log`
能查，但按模型聚合要自己写脚本，`/trace` 里看不到。

闸门触发率无法从 `/trace` 直接读出前置条件命中率。
轨迹里有 `LoopTransition` 这个分子，没有"todo 非空的 end_turn 轮次"这个分母，
第四节那两个数（4 个会话用过 todo、6 次 end_turn 落在其中）是我用
`PreToolUse.tool_name` 交叉算出来的。绕法：本文的脚本可复用，
但它是外部拼接，不是内建口径。

假设交付门禁与 Goal Gate 在本窗口分母为 0，所以本文对它们
只做了代码级核对（C 级证据），**没有实测过它们在真实任务里的行为**。
这两道闸门的效果未经验证。

样本偏斜：43 个会话里 glm-5.2 占 256 轮（60%），
claude-opus-5 只有 30 轮且 0 次 `end_turn`（都停在多轮工具链里）。
跨模型比较偏差率的样本量不够，第五节那张表只能读作"出现过 / 没出现过"。

## 相关

- [JIT 上下文：让规则在正确的时刻进入上下文](/blog/jit-context) ——
  闸门链注入的提醒挤在同一个位置，这篇讲那个位置的注入是怎么定时的
- [Prompt Cache：一个读错的字段名，把 95% 的命中率记成 2.2%](/blog/prompt-cache) ——
  同一条纪律的另一个案例：判据方法对、认错了代码路径，以及滚动窗口怎么让复现数对不上
- [环境变量](/ref/env) —— `SID_MAX_TURNS` / `SID_ENABLE_HYPOTHESIS` 的确切取值与默认值（这页从源码生成，改名会被门禁抓到）
- [排查手册](/use/troubleshooting) —— "它说完成了但活没干完"的现场该先看哪几个信号
