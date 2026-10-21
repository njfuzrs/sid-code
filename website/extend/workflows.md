---
title: Dynamic Workflows
description: 什么时候该用多 agent 编排、pipeline 和 parallel 怎么选、跑挂了怎么 resume、结论怎么回收不撞上下文上限。
---

# Dynamic Workflows

子代理是「开一个独立上下文干一件子活」。**Dynamic Workflows 是「把一整件大活拆成几十个子活，编排着跑、跑挂了能续」**——穷尽分解（fan-out）、对抗校验（verify）、或单上下文装不下的规模（迁移/审计/扫荡）。

读完这页你能做到四件事：

- 判断一个任务该用 Workflow 还是一堆普通子代理就够
- 写出能跑的编排脚本，选对 `pipeline` 还是 `parallel`
- 跑挂了用 `resume_from_run_id` 续上，不浪费已完成的 agent 调用
- 用 `/workflows` 看进度、用 `/batch` 当用户入口

::: tip 为什么它叫「Dynamic」
脚本负责流程控制（`parallel`/`pipeline`/`loop`），模型只负责填每个 `agent()` 格子。
脚本是确定性的、可重放的；模型调用是不确定的、但被 journal 缓存。
两者组合起来，迭代开发时改脚本不重跑已完成的格子——这是 resume 能成立的前提。
:::

## 什么时候用 Workflow

判断标准：**这件活的子任务之间，你要不要精确控制并发与编排顺序**。

| 场景 | 用不用 Workflow | 为什么 |
| --- | --- | --- |
| 审计全仓 200 个文件，每个独立检查 | ✅ Workflow | 天然 fan-out，pipeline 逐项推进墙钟最短 |
| 改完代码用 `verify` 子代理对抗式复核 | ✅ Workflow | 编排「改→验→改」循环，journal 让迭代不浪费 |
| 整仓从 CommonJS 迁到 ESM | ✅ Workflow | 规模装不进单上下文，分批 fan-out + worktree 隔离 |
| 「这个函数被谁调用」 | ❌ 一个 `explore` 子代理 | 单点查找，编排的开销比干活大 |
| 「改一下这行的变量名」 | ❌ 直接改 | 见[子代理](/extend/subagents)的判断表 |

Workflow 工具是**延迟加载**的（`shouldDefer = true`，不进首轮上下文），模型按需通过 `tool_search` 调出。所以你不需要记它的参数——需要的时候让它「用 Workflow 编排」就行。

## 快速上手

### 用 `/batch` 当入口（最常见）

`/batch` 是 Workflow 的用户入口，不用手写脚本：

```text
/batch 给 src/command/commands/ 下每个命令目录补一个 README.md
```

它的设计取舍很明确——不自造执行引擎，而是把你的意图翻译成结构化编排指令（`packages/cli/src/command/commands/batch/batch.ts` 注释写明了：已有 Workflow 工具 + worktree 基建，自造 batch 引擎会重复且更弱）。模型收到后会：

1. 先探查得到确定的工作清单（逐个命令目录）
2. 用 Workflow 工具做 fan-out 编排（`pipeline` 逐目录推进）
3. 并行改文件可能冲突时加 `isolation:'worktree'`
4. 注意并发上限，分批推进

### 用 `/workflows` 看进度

```text
/workflows          # 列出所有 run
/workflows wf_a3f2  # 看某个 run 的详情
```

`/workflows`（别名 `/wf`）是**查看入口**，不做 resume——resume 完全由 Workflow 工具的 `resume_from_run_id` 参数提供（`packages/cli/src/command/commands/workflows/index.ts`）。

无参列出所有 run（运行中优先、按开始时间倒序）；带 runId 看详情，含各 `agent()` 调用的结果预览——快照读自 `~/.sid-code/workflows/journals/<runId>.jsonl`。

## 详细说明

### 两个原语：pipeline 与 parallel

这是写脚本时的核心选择。**默认用 `pipeline`**——无屏障逐项推进墙钟更短（`packages/core/src/tool/workflow.ts` 的 usageGuide 明确写了这条）。

| 维度 | `pipeline(items, ...stages)` | `parallel(thunks)` |
| --- | --- | --- |
| 语义 | 无屏障逐项推进 | 屏障语义 |
| 执行 | 每个 item 独立穿过所有 stage，不同 item 的 stage 可交错 | 所有 thunk 同时启动，`Promise.all` 等全部完成 |
| 墙钟 | 更短——最慢单链决定总时间 | 更长——stage N 要等全部 stage N-1 完成 |
| 错误 | 某 stage 抛错 → 该 item 落 null，跳过剩余 stage，其他 item 不受影响 | 每个 thunk 抛错落 null，调用本身不 reject |
| 上限 | 4096 items/call；单 run 共 ≤ 1000 个 agent | 4096 items/call；单 run 共 ≤ 1000 个 agent |
| 什么时候用 | **默认** | 仅当 stage N 需要全部 stage N-1 结果时才用屏障 |

**只有一种情况该用 `parallel`**：后一步必须等前一步全部完成。比如「先并行审计 10 个模块、拿到全部结果后再综合排序」——综合这一步需要全部审计结果，这时才上屏障。

### agent() 的选项

`agent(prompt, opts?)` 开一个子代理格子，选项控制怎么跑（`packages/core/src/workflow/types.ts`、`packages/core/src/workflow/sub-agent-runner.ts`）：

| 选项 | 作用 |
| --- | --- |
| `schema` | 强制结构化输出，`agent()` 返回已校验对象（`packages/core/src/workflow/json-schema-validator.ts` 零依赖自研校验） |
| `label` | 覆盖显示标签（展示用，不影响缓存键） |
| `phase` | 显式归到某进度组——防 `pipeline`/`parallel` 内 `phase()` 全局态竞态 |
| `model` | 覆盖模型；省略 = 继承主循环模型 |
| `effort` | 覆盖推理强度（`low`/`medium`/`high`/`xhigh`/`max`） |
| `isolation` | `"worktree"` = 独立 git worktree。**贵！**仅当 agent 并行改文件会冲突时用 |
| `agentType` | 用自定义子代理类型（从[子代理](/extend/subagents)同一注册表解析，如 `explore`/`verify`） |

::: warning worktree 隔离有代价
`isolation:'worktree'` 给每个 agent 一个独立工作区，代价是起 worktree 的开销 + 可能的 lockfile 风险（见[Worktree 隔离](/use/worktree)）。只有「多个 agent 同时改文件、改的路径会撞」时才值得。只读探索用 `agentType:'explore'` 就行，不需要隔离。
:::

### 跑挂了怎么 resume

这是 Workflow 相对「派一堆子代理」的核心优势。流程：

1. Workflow 工具跑完（或中途失败）会返回 `script_path` 和 `runId`
2. 编辑脚本文件修复问题
3. 用 `{ script_path: "<path>", resume_from_run_id: "<runId>" }` 重跑
4. 未改动的 `agent()` 调用直接返回缓存，只重跑改动及其之后的

#### 「保存下来」保存的是两个不同的东西

容易混，分开说：

- **脚本** → `~/.sid-code/workflows/scripts/<名字>-<runId>.js`。每次 run 都自动落盘一份。
  用途是**复用与迭代**：改它、把它给同事、或下次用 `{ name: "<名字>" }` 直接加载一个跑过的脚本
  （`packages/core/src/tool/workflow.ts` 的 `resolveScript`：`script` > `script_path` > `name`）。
- **journal** → `~/.sid-code/workflows/journals/<runId>.jsonl`，append-only。
  用途是**resume 缓存**：每个 `agent()` 调用的结果追加一行，重跑时命中就不真跑。

两者互不依赖：删掉 journal 只是让那个 run 无法 resume（脚本还在），删掉脚本则连复用的入口都没了。

#### resume 的收益，算给你看

假设一个 44 文件的批量任务总共要烧 1700 万 token（实测 8 文件 321 万，按比例推），跑到第 30 个时你按了 ESC 或 API 挂了：

- **不 resume**：重跑 44 个，前 30 个的约 **1160 万 token 白烧一遍**
- **resume**：前 30 个直接返回 journal 里的结果，只跑剩下 14 个，约 **540 万 token**

#### 三个边界，别理解错

- **它不是自动续跑。** 挂了之后不会自己接着跑——你得**主动**发起一次重跑并传回 `runId`。
- **只缓存成功的结果。** 失败（返回 `null`）不写盘（`packages/core/src/workflow/runtime.ts` 的 `agent()`：
  「一次 flake 会在 resume 时被永久回放」是这里的 P0-1）。失败那一步重跑时会真的重跑。
- **改了哪一步，从那一步之后重跑；没改的直接复用。**

#### 缓存键：结构性位置 + 指纹

键 = **脚本结构位置** `key` + `fingerprint`（prompt + opts 的 sha256 前 16 位 hex，
`packages/core/src/workflow/journal.ts`）。指纹只纳入影响结果的字段
（`prompt`/`schema`/`model`/`effort`/`agentType`/`isolation`），排除展示用的 `label`/`phase`。

`key` 由调用作用域生成（`packages/core/src/workflow/runtime.ts` 的 `CallScope`）：
顶层第 3 个位置是 `"3"`，`parallel` 里第 2 个 thunk 的第 1 格是 `"p1/0"`。
**它与完成顺序无关**——早期版本用全局自增的 `callIndex`，`pipeline`/`parallel` 下时序一变，
同 prompt 的并行分支就会互相拿到对方的缓存（cc #63102 那个串台形态）。
纯串行脚本的 key 恰好是 `"0","1",…`，与老 journal 的 `callIndex` 一致，旧记录照常命中。

**为什么不是纯 prompt hash**：避免「两个不同调用点但 prompt 恰好相同」串台。
key 区分调用点、fingerprint 区分脚本是否改过——脚本改了某格的 prompt，指纹变，触发重跑；
没改的格子指纹不变，直接命中缓存。

### 确定性守卫：为什么禁 `Date.now()` 和 `Math.random()`

脚本跑在 `node:vm` 隔离的沙箱里（`packages/core/src/workflow/sandbox.ts`），有两个硬限制：

- **`Date.now()` 被禁**——抛 `"[workflow] Date.now() 被禁(非确定性,破坏 resume)"`（`sandbox.ts`）。需要时间戳时从 `args` 传进来。
- **`Math.random()` 被禁**——抛 `"[workflow] Math.random() 被禁(非确定性,破坏 resume)"`（`sandbox.ts`）。
- **无参 `new Date()` 被禁**，但 `new Date(ts)`（带参）和 `Date.parse`/`Date.UTC` 放行——它们是确定性的纯函数（`sandbox.ts`）。

原因直指 resume 语义：journal 按「结构位置 key + fingerprint」缓存 agent 结果。如果脚本里用了
`Date.now()` 或 `Math.random()`，它们的值会混进 prompt 或 opts，每次重跑算出的 fingerprint 都不一样，
`resume_from_run_id` 永远不命中缓存，所有 agent 全部重跑——resume 就坏了。
所以沙箱在运行时直接抛错，而不是放过去让缓存静默失效。**确定性是可重放的前提**（`sandbox.ts` 注释）。

## 一个完整脚本长什么样

脚本格式硬性要求（`packages/core/src/tool/workflow.ts`）：

- 必须以 `export const meta = { name, description }` 纯字面量开头（不能是变量引用）
- `meta.phases` 可选，是**对象数组**、每项含字符串 `title`：`phases: [{ title: "探查" }]`（写成字符串数组会被拒）
- 纯 JavaScript，**不能含 TypeScript 类型标注**（跑在 vm 沙箱里，不经过 tsc）
- 随后用 `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` / `args` / `budget` 编写

一个审计 5 个模块、每模块独立检查、最后汇总的脚本骨架：

```javascript
export const meta = {
  name: "audit-modules",
  description: "审计 command/ 下各子目录的命令实现",
  phases: [{ title: "探查" }, { title: "审计" }, { title: "汇总" }],
};

// phase() 切换进度组，log() 透传叙述行（都只影响展示，不影响结果）
const dirs = await agent("列出 src/command/commands/ 下所有子目录", {
  schema: {
    type: "object",
    properties: { dirs: { type: "array", items: { type: "string" } } },
    required: ["dirs"],
  },
  phase: "探查",
});

// pipeline：每个目录独立穿过「审计→记录」两个 stage，不同目录可交错
// 不带 schema 的 agent() 返回的是字符串；下一步要读 .issues，所以这里必须给 schema
const results = await pipeline(
  dirs.dirs,
  (dir) =>
    agent(`审计 ${dir} 目录的命令实现，找出未处理的错误分支`, {
      agentType: "verify",
      phase: "审计",
      schema: {
        type: "object",
        properties: { issues: { type: "array", items: { type: "string" } } },
        required: ["issues"],
      },
    }),
  (audit, dir) => {
    log(`${dir} 审计完成，发现 ${audit.issues.length} 处`);
    return { dir, issues: audit.issues };
  }
);

// 汇总要等全部审计结果——pipeline 已经 await 完，直接调 agent() 即可，不需要再包 parallel。
// ⚠️ 但这个写法只对「结论短 + 数量少」成立：这里 5 个模块、每份几个 issue，塞得进一个 prompt。
//    数量上到几十、或每份结论变长，**汇总这一步会先撞上下文上限**——拆出去的部分不会撞，
//    收回来的部分会。详见下文「结论回收：汇总那一步也会撞上限」。
const summary = await agent(
  `把以下 ${results.length} 份审计结果合并成一份报告：${JSON.stringify(results)}`,
  { phase: "汇总" }
);

return summary;
```

跑挂了想改「审计」那步的 prompt，只改脚本里那行，重跑时探查那步命中缓存、审计那步及之后重跑。

## 结论回收：汇总那一步也会撞上限

这是 Workflow 最容易被忽略的一处限制：**拆出去的部分不会撞上限，收回来的部分会。**

### 为什么拆出去不撞、收回来撞

每个 `agent()` 是**独立子代理**，有自己的上下文。它读 5000 行代码、跑十几轮 grep，都发生在自己的窗口里，
跑完只交回**结论**。所以 44 个文件 × 每个 5000 token 原始材料 = 22 万 token，
从头到尾**没有任何一个上下文同时装下它们**——这是 Workflow 真正治好的部分。

但结论要收回来。它们全在脚本的 `results` 数组里，最后由某个 agent 汇总，
而**汇总 agent 只有一份上下文**。上例的 `JSON.stringify(results)` 是原样全塞：
44 个文件 × 每个结论 3000 字 ≈ 13 万 token 进一个 prompt，直接撞上限。

所以判据不是「任务有多大」，而是：

> **能跑的最大规模 ≈ 单上下文预算 ÷ 每个结论的 token 数。**
> 可扩展性取决于**结论压缩比**，不取决于任务规模。

### 三层解法，按优先级

**第一层：把每个结论压下去。** 最有效。用 `schema` 强制 worker 只返回必要字段
（`{file, line, reason}`），而不是整段代码或散文。44 份 × 50 token = 2200 token，汇总毫无压力。
**结论的大小是设计出来的，不是固有的**——让 worker 报 `file:line` + 一句话，不要让 worker 复述代码。

**第二层：分层归约（map-reduce 两级）。** 结论压不下去时，先分组归约再汇总：

```javascript
// 上例的变体：把「一步汇总」换成两级归约。可独立试跑（results 从 args 传入）。
export const meta = {
  name: "audit-modules-reduce",
  description: "两级归约：结论装不进一个 prompt 时，先分组归约再汇总",
  phases: [{ title: "归约" }, { title: "汇总" }],
};

const results = args ?? [];

const GROUPS = 8;
const per = Math.max(1, Math.ceil(results.length / GROUPS));
const partials = [];
for (let i = 0; i < results.length; i += per) {
  const slice = results.slice(i, i + per);
  partials.push(
    await agent(
      `把以下 ${slice.length} 份审计结果归约成要点清单，每条带 file:line，不要复述代码：${JSON.stringify(slice)}`,
      { phase: "归约" }
    )
  );
}
return await agent(
  `把以下 ${partials.length} 份要点清单合并成最终报告：${JSON.stringify(partials)}`,
  { phase: "汇总" }
);
```

三层四层同理，脚本里一个 `for` 循环就行。**框架不提供内置 reduce**：`parallel` / `pipeline`
都只是 map（逐项映射），跨 item 的聚合要自己写。

**第三层：兜底压缩。** 主循环撞上下文上限时有 `reactiveCompact` 会自动压缩后继续
（`packages/core/src/query/reactive-compact.ts`）。但那是**兜底不是方案**：
压缩会丢信息，你只是把失败推迟到了下一轮。

### 判据：Workflow 治「宽」，不治「深」

「复杂任务」要分两种看：

- **量上的复杂**——44 个模块、300 个文件、50 个 API，每项都是独立检查。**适配**。
  深度浅、结论能压缩、互不依赖。
- **质上的复杂**——一个 5000 行核心模块，要理解它跟 20 个调用方的交互才能改对。**不适配**，
  因为切不开。硬切给 5 个 worker，每个都只看得到局部，汇总时细节又装不下，
  最终结论比一个 agent 老实读完还差。

三条全满足才用：**能切开 + 结论能压 + 每项不需要全局视野**。缺任何一个，
省下的墙钟都会在汇总那一步赔回去。

## 常见问题

### `/batch` 和 Workflow 工具是什么关系

`/batch` 是**用户意图翻译层**，不是执行引擎。数据流：

```text
/batch <任务>  →  submit_prompt  →  模型调 workflow 工具  →  注册 local_workflow task  →  /workflows 可查
```

`/batch` 把任务转成结构化编排指令引导模型，实际执行由 Workflow 工具完成（`packages/cli/src/command/commands/batch/batch.ts`）。`/workflows` 是查看入口。三者各管一段。

### 为什么要用 Workflow 而不是直接派一堆子代理

三个普通子代理给不了的：

1. **resume**：派子代理跑挂了只能从头再来；Workflow 的 journal 让改脚本后续跑
2. **结构化编排**：`pipeline`/`parallel` 精确控制并发与顺序，子代理只能一个个串行或全并行
3. **预算控制**：`budget_total` 给整次编排一个 token 硬顶，子代理没有编排级预算

### 脚本里能用 `await import` 吗

不能。脚本跑在 `node:vm` 隔离的沙箱里，只能用沙箱注入的全局（`agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`）。需要外部数据时从 `args` 传进来（`args` 在脚本里以全局变量逐字可见）。

### journal 文件会一直涨吗

journal 是 append-only JSONL，每个 run 一个文件（`~/.sid-code/workflows/journals/<runId>.jsonl`）。run 完成后文件不再增长。没有自动清理——想清就删 `~/.sid-code/workflows/journals/` 下的旧文件，不影响任何运行时行为（只影响能否 resume 那个 run）。

### Workflow 和[定时任务](/team/scheduled)有关系吗

没有直接关系。但 daemon 触发的无头任务如果想跑编排，用的也是同一套 Workflow 工具——无头模式（`-p`）下 Workflow 工具同样可用。

## 相关

- [子代理](/extend/subagents) —— 单个子代理怎么派、怎么分级模型；Workflow 的 `agentType` 复用同一注册表
- [Worktree 隔离](/use/worktree) —— `isolation:'worktree'` 的代价与 lockfile 风险
- [无头模式与脚本化](/extend/headless) —— `-p` 模式下 Workflow 工具同样可用
- [扩展方式总览](/extend/) —— Workflow 与其他扩展方式的取舍
- [内置工具](/ref/tools) —— `workflow` 工具的完整参数定义
