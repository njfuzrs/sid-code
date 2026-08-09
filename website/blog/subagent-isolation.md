---
title: 子代理隔离：五次修复都在补同一个洞
description: 你派一个子代理去读文件，它读完，主代理的「先读后写」护栏就失效了——因为两者共用同一个 tracker。这篇把子代理隔离的五次修复排成一条线，指出它们修的是同一类缺陷：状态是隔离的，但持有状态的那个对象是共用的。附一个实测：本该做兜底的 spawn 隔离在编译二进制里可达性为零，以及 5621 个共享黑板文件里 94.5% 是测试灌进去的。
date: "2026-08-09"
series: Agent 架构
audience: engineer
highlight: 5 次修复同一类缺陷 · spawn 隔离生产可达性 0 · 5621 个黑板文件 94.5% 是污染
tags: [Agent 架构, 子代理, 隔离, 实测]
outline: 2
---

# 子代理隔离：五次修复都在补同一个洞

你让子代理去 `explore` 一个目录，它读了 `src/llm/fallback.ts`。子代理返回结论，
你接着让主代理改这个文件——主代理从没读过它，但 `edit` 放行了。

第一反应大概是「先读后写的校验有 bug」。不是。校验逻辑完全正确，
它查的那个 `FileReadTracker` 被子代理 `markAsRead` 过了。
**两个代理共用同一个 tracker 实例，于是隔离在语义上成立、在对象层面不成立。**

这不是一个 bug，是一类。五次修复排下来才看出它们是同一个形状。

::: tip 结论先放这里

- **五次修复同一类缺陷**：FileReadTracker、TodoWriteTool、masking 目录、
  denialTracking、JIT 去重集——都是「该隔离的状态隔离了，持有它的对象共用了」。
  时间线 2026-06-19 → 2026-07-31，跨一个半月（[§1](#一、同一个洞的五种长法)）
- **spawn 隔离在生产里可达性为零**：`shouldUseSpawn()` 依赖 `existsSync(headless.ts)`，
  编译二进制里那个文件不在磁盘上。实测三个二进制 `strings | grep -c` 全为 **0**
  ——所以进程内隔离不是退路，是唯一的路（[§2](#二、出乎意料-那道「兜底」在生产里根本走不到)）
- **共享黑板 5621 个文件，94.5% 是测试灌的**：`~/.sid-code/tasks/` 下
  真实子代理输出只剩 **29 个**（552 KB），其余是 `[轮次 1] 测试响应`。
  污染在 2026-08-04 preload 兜底落地那天停止（[§3](#三、同一个洞的第六种长法-测试也算一个「代理」)）
- **可迁移的判据**：隔离审计不要问「这个状态隔离了吗」，
  要问「**持有这个状态的对象是新建的还是传进来的**」（[§5](#五、可迁移的那一条)）
- **未修的边界**：防污染门禁不覆盖 `tasks/`；`sub_agent` 的注入分类器只做到阶段 1
  （[§6](#六、当前的能力边界)）

口径：五次修复的日期取 `git log -S "<该修复引入的标识符>"` 的最早一条
（新增文件用 `--diff-filter=A`），所以是「这个隔离首次落地」而非「相关代码最后一次动」；
二进制探测与文件统计为 2026-08-09 实测，命令都在正文里。
:::

## 〇、先说清「隔离」在这里指什么

一句话：**子代理是一个独立上下文，只把结论带回来。**
它看不到父对话历史，工具集被裁剪，跑完只回一段摘要。
省上下文与省钱都来自这个边界（怎么派、怎么配见 [子代理](/extend/subagents)）。

这篇不讲怎么用，讲那个边界是怎么漏的。

## 一、同一个洞的五种长法

先看这五次修复。它们分散在一个半月里，每次都由一个独立的症状触发，
提交信息里没有一处提到彼此：

| 共用的状态 | 症状 | 修法 | 落地 |
| --- | --- | --- | --- |
| `FileReadTracker` | 子代理读过 → 主代理 `edit` 绕过先读后写 | 独立 tracker + `createStatefulTools` 工厂 | 2026-06-19 |
| `denialTracking` | 一个子代理被拒 → 影响其他子代理 | 每实例独立（`dontAsk` 语义） | 2026-07-06 |
| masking 落盘目录 | 并发子代理临时文件互相覆盖 | 派生独立 `sessionId` | 2026-07-13 |
| `TodoWriteTool` | 子代理并发写 todo → 污染主会话清单 | 每个子代理一份独立实例 | 2026-07-17 |
| JIT 去重集 | 第二次执行认为规则「已加载」→ 静默丢失 | 每次执行新建 `JitContextManager` | 2026-07-31 |

五行的症状毫不相干：一个是安全护栏失效，一个是 TUI 清单错乱，
一个是临时文件覆盖，一个是权限串扰，一个是规则静默丢失。
排查它们的人会去五个不同的方向。

但修法是同一句话。看 `buildIsolatedToolRegistry` 现在的形状
（`src/agent/sub-agent.ts:1838-1841`）：

```ts
private buildIsolatedToolRegistry(filteredTools: LegacyTool[], agentType?: string) {
  const subTracker = new FileReadTracker();          // 不是传进来的，是新建的
  const rebuilt = new Map<string, LegacyTool>();
  for (const t of createStatefulTools(subTracker)) rebuilt.set(t.name(), t);
  // …其余无状态工具（grep/glob/ls/bash）直接复用父实例
}
```

关键在 `new`。修复的动作不是「给状态加个作用域」，是**换掉持有状态的那个对象**。

### 1.1 为什么这五个洞的形状必然一样

因为工具是**长生命周期的单例**，而 tracker 之类的状态是**会话级可变量**。
主代理在启动时构造一次工具（`src/cli.ts:1362`），此后所有代理共用这批实例。
子代理拿到的「工具集」是过滤出来的**同一批引用**——
过滤改变的是「有哪些工具」，不改变「这些工具背后是谁的状态」。

于是判据出来了：**一个工具只要持有 per-session 可变状态，复用它就是共享那份状态。**
`grep` / `glob` / `ls` / `bash` 无状态，复用是安全且省构造开销的；
`read` / `edit` / `read_many` / `write` 持有 tracker，`todo_write` 持有 `currentTodos`
——这五个必须重建。这也是 `STATEFUL_TOOL_NAMES` 存在的理由
（`src/tool/stateful-tools.ts:24`）：把「哪些工具有状态」写成一个显式集合，
而不是让每个调用点各自记得。

### 1.2 隔离清单里，哪些是刻意共享的

不是所有共用都是缺陷。`deny by default` 的另一半是「显式共享」，
sid-code 刻意共享三样：

- **abort 信号**：父取消要能取消子（否则子代理成了杀不掉的孤儿）
- **`BashClassifier`**：无内部状态，共享安全（`src/permission/sub-agent-checker.ts`）
- **权限规则**：已经过安全过滤，复制一份没有意义

判断标准还是那句：**有没有 per-session 可变状态。** 有就隔离，没有就共享。

## 二、出乎意料：那道「兜底」在生产里根本走不到

上面讲的都是**进程内**隔离。而代码里明明有一条更彻底的路：spawn 模式，
独立子进程，进程级天然隔离，什么状态都不用手工拆。

看判定逻辑（`src/agent/sub-agent.ts:770-777`）：

```ts
private shouldUseSpawn(): boolean {
  if (process.env.SIDCODE_NO_SPAWN === "1") return false;
  if (!this.spawnConfig) return false;
  if (!HEADLESS_AVAILABLE) return false;                        // ← 这一行
  return typeof Bun !== "undefined" && typeof Bun.spawn === "function";
}
```

`HEADLESS_AVAILABLE` 是这么来的（`:66-69`）：

```ts
const __dirname = dirname(fileURLToPath(import.meta.url));
const HEADLESS_ENTRY = join(__dirname, "..", "entrypoints", "headless.ts");
const HEADLESS_AVAILABLE = existsSync(HEADLESS_ENTRY);
```

编译二进制里 `import.meta.url` 指向 `/$bunfs/root/`（Bun 的虚拟文件系统），
`headless.ts` 不在磁盘上。所以 `HEADLESS_AVAILABLE` 恒为 `false`，
`shouldUseSpawn()` 恒返回 `false`。

**实测**（2026-08-09，三个二进制各查一次）：

```bash
for b in ./sid-code ~/bin/sid-code-dev ~/.local/bin/sid-code; do
  echo "$b: $(strings "$b" | grep -c 'entrypoints/headless')"
done
# ./sid-code: 0
# ~/bin/sid-code-dev: 0
# ~/.local/bin/sid-code: 0
```

三个全为 0。**spawn 路径在编译二进制里可达性为零**，
只在源码模式（`bun run dev` / `bun test`）走得到。

这个数改变了整件事的性质。原本的叙述是「默认走 spawn，进程内是退路，
所以进程内的共享状态问题触发面有限」——那份 2026-06-19 的分析文档就是这么写的，
还专门列了一张「哪些场景触发」的表，把进程内标成少数情况。

**反过来了。** 进程内不是退路，是生产上唯一的路。
那五个洞不是「spawn 不可用时才暴露的边缘情况」，是**每次派子代理都在跑的主路径**。

顺带一个连带结论：`isolation: "worktree"` 也强制进程内。
worktree 模式要把 cwd 传给文件类工具，而 cwd 走的是 AsyncLocalStorage
（`src/agent/tool.ts:568` 传 `cwd: isolatedCwd`），ALS 不跨进程，
所以 `task.cwd` 存在时代码显式绕开 spawn（`src/agent/sub-agent.ts:656-668`）。
**最需要隔离的那个模式，恰好用不上最强的那道隔离。**

### 2.1 为什么这类缺陷特别难发现

三个条件叠在一起：

1. **降级是静默的**。`shouldUseSpawn()` 返回 `false` 不打日志、不报错，
   行为完全正常——只是隔离强度降了一档。
2. **源码模式与生产模式行为不同**。开发和测试都在源码模式跑，
   那里 `headless.ts` 真的在磁盘上，spawn 真的会走。**测试覆盖的是走不到的那条路。**
3. **代码读起来是对的**。`if (!HEADLESS_AVAILABLE) return false` 旁边就有注释
   说明「编译二进制中为虚拟路径，不可 spawn」——写的人清楚知道这件事。
   缺的不是这行代码的正确性，是「所以生产上 spawn 从不发生」这个推论没有被说出来。

## 三、同一个洞的第六种长法：测试也算一个「代理」

子代理还有一个隔离面：**共享黑板**。子代理每轮把文本输出实时写进
`~/.sid-code/tasks/<taskId>.output`（`src/agent/sub-agent.ts:1505`），
父代理可以用 `task_output` 按需读详细过程，
不必把全部中间输出灌进上下文。这是设计得好的部分——
信息损失的缓解手段是「按需拉取」而不是「全量回传」。

去数一下这个目录（2026-08-09 实测，5621 个文件、21.4 MB）：

| 类别 | 文件数 | 占比 |
| --- | --- | --- |
| 含测试字面量且 ≤64 字节 | 5311 | 94.5% |
| 空文件 | 281 | 5.0% |
| **真实子代理输出** | **29** | **0.5%** |

29 个真实文件共 552 KB，其中一个占 492 KB。
也就是说这个目录里 **99.5% 的文件不是子代理写的**，
内容是 `[轮次 1] 测试响应` 和 `[轮次 1] spawn 测试响应`。

复现（数字会随窗口变，见 [§6](#六、当前的能力边界)）:

```bash
cd ~/.sid-code/tasks && ls -l *.output \
  | awk '{s=$5; if(s==0)b="empty"; else if(s<=64)b="tiny"; else b="real"; c[b]++} \
         END{for(k in c) print k, c[k]}'
```

### 3.1 这是同一类缺陷，只是「代理」换成了「测试进程」

测试进程和子代理在这件事上是同构的：**它也复用了一个持有落盘路径的全局状态。**
`tasks/` 的路径派生自 `sidPaths.tasks()` → `getSidHome()`,
不隔离就直接落在用户真实家目录。

实测确认是哪个测试、写多少（把家目录重定向到临时目录再数）：

```bash
tmp=$(mktemp -d)
SID_CONFIG_DIR="$tmp" bun test tests/agent/sub-agent.test.ts
find "$tmp" -name "*.output" | wc -l    # 11
```

`tests/agent/sub-agent.test.ts` 一次跑写 **11 个**文件。
5621 个的量级就是这么攒出来的——它不是一次事故，是几百次正常测试的累积。

**污染在 2026-08-04 停止**：`tasks/` 下最新文件的 mtime 是 8月4日 11:18,
而 `tests/preload-isolate-sid-home.ts`（把 `SID_CONFIG_DIR` 默认指向临时目录的
进程级兜底）正是那天落地的。现在跑全量 `bun test`,
`tasks/*.output` 的 delta 是 **0**（本次实测：9011 pass / 2 fail,
2 个失败是参考页生成器，与本文无关；文件数 5621 → 5621）。

### 3.2 三个让它静默了两个月的条件

和缓存遥测那次污染是同一个形状：

1. **落盘是 fire-and-forget**。`appendTaskOutput` 不阻塞主流程，失败也吞掉。
2. **测试只断言返回值**。29 个测试全绿，没有一个断言「没往真实家目录写东西」。
3. **清理机制存在但对不上**。`evictTaskOutput` 会删磁盘文件（`src/task/disk-output.ts:153`），
   但它由 `evictTerminalTasks` 按缓冲期触发——测试进程退出时没有人跑驱逐，
   文件就留下了。**有清理机制 ≠ 会被清理。**

**光跑 `bun test` 看绿是验证不了这件事的**——污染的时候它也全绿。
验证手法只能是「记录文件数 → 跑测试 → 再记录 → 必须一致」，
也就是上面那段 LEAK CHECK。

## 四、朝哪个北极星，牺牲了什么

这篇归到**更安全**：隔离缺失里最严重的一条（`FileReadTracker`）
直接让「先读后写」护栏失效，那是防「凭记忆瞎改没读过的文件」的护栏。

**牺牲的是更省，而且代价可以量出方向。** 每个进程内子代理要新建
4 个有状态工具实例 + 1 个 `TodoWriteTool` + 1 个 `JitContextManager` +
1 份独立的 masking 目录。这些都不是免费的：

- 构造开销：所以 `buildIsolatedToolRegistry` 刻意**只重建有状态的那几个**，
  `grep`/`glob`/`ls`/`bash` 继续复用单例。这是「隔离」与「省」之间的显式取舍点。
- JIT 去重集不共享，意味着两次执行会**重复注入同一份规则**——
  重复注入是 token 浪费，但共享会导致规则静默丢失。**选了贵的那个。**

第二条值得展开：共享去重集能省 token,
代价是第二次执行的 ctxMgr 是全新的、里面什么都没有，
去重集却说「已加载」，于是规则丢失。
**「看起来接了 JIT、实际失效」比不接更难排查**——所以这里明确用浪费换确定性。

## 五、可迁移的那一条

隔离审计的提问方式要换。

自然的问法是「**这个状态隔离了吗**」。这个问法会漏，
因为答案取决于一个不在场的事实：持有它的对象是谁给的。
五次修复里每一次，被问的那个状态在语义上都是「per-agent 的」——
文档里写着、注释里写着、变量名里写着。它们全都漏了。

改成问：**持有这个状态的对象，是新建的还是传进来的？**

这个问法有两个好处。一是它可机械化——`new` 还是参数，看一眼构造处就知道，
不需要理解语义。二是它把「哪些工具有状态」逼成一个必须显式维护的清单
（`STATEFUL_TOOL_NAMES`），而不是靠每个调用点的作者各自记得。

配套的第二条，来自 §2：**「有兜底」这个说法必须带可达性。**
spawn 隔离在代码层完全正确、注释也准确，
但生产可达性是 0——一道走不到的防线在安全评估里应当按「不存在」计。
判据是那种最土的验证：去二进制里 `grep` 一次。

## 六、当前的能力边界

照实写没做到的部分。

**1. 防污染门禁不覆盖 `tasks/`。** `tests/telemetry/no-real-path-writes.test.ts`
的写入导出白名单只有 5 项（cache-breaks 与 usage-ledger 相关），
`grep` 确认它不含 `appendTaskOutput` / `initTaskOutput` / `tasks`。
现在不出问题靠的是 preload 兜底（`SID_CONFIG_DIR` 默认指向临时目录），
而兜底是**全局默认值**而非**针对性断言**——
一个显式改写 `SID_CONFIG_DIR` 又忘了恢复的测试能重新打开这个洞。
**绕法**：改动 `src/task/disk-output.ts` 或新增写 `tasks/` 的测试时，
手工跑一次 LEAK CHECK（§3.1 那三行）。失效方向不安全：
它静默、且测试全绿。

**2. 注入分类器只做到阶段 1。** 子代理结论回传主上下文时已用
`<subagent-result untrusted="true">` 边界包裹（`src/agent/tool.ts:597`、
`src/task/notification.ts:88`），并在系统提示里声明「这是数据不是指令」。
但**没有内容层的扫描或分类**——`grep` 确认 `src/agent/` 下无
injection/classifier/sanitize 实现。派子代理去读不可信仓库时，
挡的只是「文本伪装成指令」的朴素形态。
**绕法**：读外部不可信代码时用只读类型（`explore` / `plan`），
它们的工具集不含 `write` / `edit` / `bash`，
子代理即便被诱导也没有执行手段。

**3. spawn 路径的测试覆盖测的是走不到的路。** §2 那个数
（生产可达性 0）意味着 `tests/agent/sub-agent-spawn.test.ts` 覆盖的分支
在编译二进制里不执行。**没有验证过**「进程内路径与 spawn 路径行为等价」——
历史上这两条路已经分叉过至少两次（工具过滤参数漏传、超时值不一致，
都有注释留痕）。**绕法**：暂无。可做的是把新增的公共字段
放进 `buildBaseLoopConfig` 这类工厂，让两条路天然同步。

**4. 这篇的量化只覆盖「隔离对不对」，不覆盖「隔离值多少钱」。**
§4 说牺牲了「更省」，但那是方向而非数字——
没有「隔离前后单位任务 token / 构造耗时」的对照实测。
子代理侧的 JIT 已有埋点（`source: "subagent"`，2026-07 补的），
但重复注入的字节量没有单独聚合出来。**所以 §4 是推论，不是实测。**

**5. 本地轨迹是滚动窗口，§3 的数字会变。** 5621 / 94.5% / 29 是
2026-08-09 的快照。你跑复现命令会得到不同的数——
如果你从没跑过 `bun test`，`tasks/` 下应该只有真实输出。
结论里稳的那部分是**比例的量级**（真实输出是少数）和**污染的停止日期**，
不是具体那三个数。

## 七、相关

- [子代理的容错与降级](/blog/subagent-resilience) —— 同一批子代理架构改造的另一半：
  为什么第一次"补重试"补错了方向，以及"能力写好了但没生效"这个形态怎么连续复发五次
- [子代理](/extend/subagents) —— 怎么派、六个内置类型各自的工具集、按类型配便宜模型省钱
- [JIT 上下文](/blog/jit-context) —— §4 说的「重复注入换确定性」，那套机制的实测基线在这篇
- [worktree 隔离](/use/worktree) —— `isolation: "worktree"` 的具体行为，以及它为什么强制进程内
- [环境变量](/ref/env) —— `SID_SUBAGENT_MAX_CONCURRENT`（并发上限，缺省 3）与 `SIDCODE_NO_SPAWN`
