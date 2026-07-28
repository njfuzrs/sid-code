---
title: Dynamic Workflows
description: 什么时候该用多 agent 编排、pipeline 和 parallel 怎么选、跑挂了怎么 resume。
---

# Dynamic Workflows

子代理是「开一个独立上下文干一件子活」。**Dynamic Workflows 是「把一整件大活拆成几十个子活，编排着跑、跑挂了能续」**——穷尽分解（fan-out）、对抗校验（verify）、或单上下文装不下的规模（迁移/审计/扫荡）。

读完这页你能做到四件事：

- 判断一个任务该用 Workflow 还是一堆普通子代理就够
- 写出能跑的编排脚本，选对 `pipeline` 还是 `parallel`
- 跑挂了用 `resumeFromRunId` 续上，不浪费已完成的 agent 调用
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

它的设计取舍很明确——不自造执行引擎，而是把你的意图翻译成结构化编排指令（`src/command/commands/batch/batch.ts:7-12` 注释写明了：已有 Workflow 工具 + worktree 基建，自造 batch 引擎会重复且更弱）。模型收到后会：

1. 先探查得到确定的工作清单（逐个命令目录）
2. 用 Workflow 工具做 fan-out 编排（`pipeline` 逐目录推进）
3. 并行改文件可能冲突时加 `isolation:'worktree'`
4. 注意并发上限，分批推进

### 用 `/workflows` 看进度

```text
/workflows          # 列出所有 run
/workflows wf_a3f2  # 看某个 run 的详情
```

`/workflows`（别名 `/wf`）是**查看入口**，不做 resume——resume 完全由 Workflow 工具的 `resumeFromRunId` 参数提供（`src/command/commands/workflows/index.ts:9-22`）。

无参列出所有 run（运行中优先、按开始时间倒序）；带 runId 看详情，含各 `agent()` 调用的结果预览——快照读自 `~/.sid-code/workflows/journals/<runId>.jsonl`。

## 详细说明

### 两个原语：pipeline 与 parallel

这是写脚本时的核心选择。**默认用 `pipeline`**——无屏障逐项推进墙钟更短（`src/tool/workflow.ts:169` 的 usageGuide 明确写了这条）。

| 维度 | `pipeline(items, ...stages)` | `parallel(thunks)` |
| --- | --- | --- |
| 语义 | 无屏障逐项推进 | 屏障语义 |
| 执行 | 每个 item 独立穿过所有 stage，不同 item 的 stage 可交错 | 所有 thunk 同时启动，`Promise.all` 等全部完成 |
| 墙钟 | 更短——最慢单链决定总时间 | 更长——stage N 要等全部 stage N-1 完成 |
| 错误 | 某 stage 抛错 → 该 item 落 null，跳过剩余 stage，其他 item 不受影响 | 每个 thunk 抛错落 null，调用本身不 reject |
| 上限 | 4096 items/call | 4096 items/call |
| 什么时候用 | **默认** | 仅当 stage N 需要全部 stage N-1 结果时才用屏障 |

**只有一种情况该用 `parallel`**：后一步必须等前一步全部完成。比如「先并行审计 10 个模块、拿到全部结果后再综合排序」——综合这一步需要全部审计结果，这时才上屏障。

### agent() 的选项

`agent(prompt, opts?)` 开一个子代理格子，选项控制怎么跑（`src/workflow/types.ts:31-43`、`src/workflow/sub-agent-runner.ts`）：

| 选项 | 作用 |
| --- | --- |
| `schema` | 强制结构化输出，`agent()` 返回已校验对象（`src/workflow/json-schema-validator.ts` 零依赖自研校验） |
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

1. Workflow 工具跑完（或中途失败）会返回 `scriptPath` 和 `runId`
2. 编辑脚本文件修复问题
3. 用 `{ scriptPath: "<path>", resumeFromRunId: "<runId>" }` 重跑
4. 未改动的 `agent()` 调用直接返回缓存，只重跑改动及其之后的

缓存键是 `callIndex`（全局自增序号）+ `fingerprint`（prompt + opts 的 sha256 前 16 位 hex，`src/workflow/journal.ts:36-52`）。指纹只纳入影响结果的字段（`prompt`/`schema`/`model`/`effort`/`agentType`/`isolation`），排除展示用的 `label`/`phase`。

**为什么不是纯 prompt hash**：避免「两个不同调用点但 prompt 恰好相同」串台（journal 注释点名这是 cc #63102 的 bug）。callIndex 区分调用点、fingerprint 区分脚本是否改过——脚本改了某格的 prompt，指纹变，触发重跑；没改的格子指纹不变，直接命中缓存。

journal 落盘在 `~/.sid-code/workflows/journals/<runId>.jsonl`，append-only。

### 确定性守卫：为什么禁 `Date.now()` 和 `Math.random()`

脚本跑在 `node:vm` 隔离的沙箱里（`src/workflow/sandbox.ts`），有两个硬限制：

- **`Date.now()` 被禁**——抛 `"[workflow] Date.now() 被禁(非确定性,破坏 resume)"`（`sandbox.ts:64-68`）。需要时间戳时从 `args` 传进来。
- **`Math.random()` 被禁**——抛 `"[workflow] Math.random() 被禁(非确定性,破坏 resume)"`（`sandbox.ts:86-89`）。
- **无参 `new Date()` 被禁**，但 `new Date(ts)`（带参）和 `Date.parse`/`Date.UTC` 放行——它们是确定性的纯函数（`sandbox.ts:55-70`）。

原因直指 resume 语义：journal 按 `callIndex + fingerprint` 缓存 agent 结果。如果脚本里用了 `Date.now()` 或 `Math.random()`，同一 prompt 每次跑出不同结果，缓存命中但结果不一致——resume 就坏了。**确定性是可重放的前提**（`sandbox.ts:12-14` 注释）。

## 一个完整脚本长什么样

脚本格式硬性要求（`src/tool/workflow.ts:55-56`）：

- 必须以 `export const meta = { name, description }` 纯字面量开头（不能是变量引用）
- 纯 JavaScript，**不能含 TypeScript 类型标注**（跑在 vm 沙箱里，不经过 tsc）
- 随后用 `agent()` / `parallel()` / `pipeline()` / `phase()` / `log()` / `args` / `budget` 编写

一个审计 5 个模块、每模块独立检查、最后汇总的脚本骨架：

```javascript
export const meta = {
  name: "audit-modules",
  description: "审计 command/ 下各子目录的命令实现",
  phases: ["探查", "审计", "汇总"],
};

// phase() 切换进度组，log() 透传叙述行（都只影响展示，不影响结果）
const dirs = await agent("列出 src/command/commands/ 下所有子目录", {
  schema: { dirs: { type: "array", items: { type: "string" } } },
  phase: "探查",
});

// pipeline：每个目录独立穿过「审计→记录」两个 stage，不同目录可交错
const results = await pipeline(
  dirs.dirs,
  (dir) =>
    agent(`审计 ${dir} 目录的命令实现，找出未处理的错误分支`, {
      agentType: "verify",
      phase: "审计",
    }),
  (audit) => {
    log(`完成审计，发现 ${audit.issues?.length ?? 0} 处`);
    return audit;
  }
);

// parallel 在这里才合理：汇总需要全部审计结果
const summary = await parallel([
  () => agent(`把 ${results.length} 份审计结果合并成一份报告`, { phase: "汇总" }),
]);

return summary[0];
```

跑挂了想改「审计」那步的 prompt，只改脚本里那行，重跑时探查那步命中缓存、审计那步及之后重跑。

## 常见问题

### `/batch` 和 Workflow 工具是什么关系

`/batch` 是**用户意图翻译层**，不是执行引擎。数据流：

```text
/batch <任务>  →  submit_prompt  →  模型调 workflow 工具  →  注册 local_workflow task  →  /workflows 可查
```

`/batch` 把任务转成结构化编排指令引导模型，实际执行由 Workflow 工具完成（`src/command/commands/batch/batch.ts:18-53`）。`/workflows` 是查看入口。三者各管一段。

### 为什么要用 Workflow 而不是直接派一堆子代理

三个普通子代理给不了的：

1. **resume**：派子代理跑挂了只能从头再来；Workflow 的 journal 让改脚本后续跑
2. **结构化编排**：`pipeline`/`parallel` 精确控制并发与顺序，子代理只能一个个串行或全并行
3. **预算控制**：`budgetTotal` 给整次编排一个 token 硬顶，子代理没有编排级预算

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
