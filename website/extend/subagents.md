---
title: 子代理
description: 把任务派给子代理，用自定义 agent 固化职责，并按类型分级模型省钱。
---

# 子代理

子代理是「开一个独立上下文去干一件子活，只把结论带回来」。两个真实收益：

- **省上下文**：搜索十个文件的过程不进主对话，只有结论进。主上下文不被中间垃圾撑爆
- **省钱**：搜索、读文件这类粗活不需要最强模型。按类型给便宜模型，成本能差好几倍

这页讲怎么派、怎么写自己的子代理、怎么配模型分级。

## 内置的六个

```bash
sid-code agents          # 列出全部可用子代理
sid-code agents --json   # 机器可读
```

实测输出（v0.1.592）：

| 名字 | 干什么 | 工具集 |
| --- | --- | --- |
| `explore` | 快速搜索分析代码库，只返回关键发现 | 只读（read / grep / glob / ls / read_many） |
| `plan` | 分析代码库并输出结构化实现方案 | 只读，同上 |
| `task` | 执行指定子任务 | 读写 + bash + 网络 |
| `verify` | 对抗式验证：验证某个结论/修复是否真成立 | 只读 + bash |
| `summarize` | 总结对话、提取关键信息 | 全部 |
| `general-purpose` | 通用，全工具集，适合复杂多步任务 | 全部 |

**最常用的是 `explore`**：让它去翻代码，你的主上下文只收结论。

### 会话内 `/agents`：看自定义 agent

上面 `sid-code agents` 是 CLI 命令，列出全部（内置 + 自定义）。会话里还有一个同名的斜杠命令 `/agents`，作用不同——它只列**你自己写的自定义 agent**，按来源分组：

```text
/agents
```

输出长这样（有自定义 agent 时）：

```text
自定义 Agents:

用户级 (~/.sid-code/agents/):
  • const-finder - 专门找导出的常量名 [工具: read, grep, glob]

项目级 (.sid-code/agents/):
  • db-migrator - 执行数据库迁移脚本 [工具: read, bash]
```

没有自定义 agent 时会提示你去哪个目录加文件。

**两者的区别**：

| | `sid-code agents`（CLI） | `/agents`（斜杠命令） |
| --- | --- | --- |
| 在哪用 | 终端，启动前 | 会话内 |
| 列什么 | 内置 6 个 + 全部自定义 | 只列自定义 |
| 用途 | 确认有哪些可用、`--json` 给脚本 | 写了自定义 agent 后快速确认有没有被加载到 |

所以「写了 `.md` 但模型不派它」时，先用 `/agents` 确认文件被识别了，再排查 frontmatter 的 `description` 是不是空。

## 派活

直接说就行，不用记语法：

```text
用 explore 子代理找出所有调用了 legacy_api 的地方
```

实测日志（一次真实派活）：

```text
● [QUERY_LOOP] 工具调用: sub_agent
● [PERMISSION] sub_agent() → 允许(allow规则)
● [TOOL] ▶ sub_agent {"description":"查找 src 下所有导出的常量","prompt":"..."}
● [TOOL] ✓ sub_agent (17662ms)
```

::: warning 子代理要单独放行权限
`sub_agent` 是一个工具，默认策略下**要确认**。非交互模式（`-p`）里没人能确认，
实测会直接落成：

```text
● [PERMISSION] sub_agent() → 需确认(默认策略)
● [PERMISSION] sub_agent() → 拒绝(非交互模式)
```

脚本里要用子代理，得显式放行：`--allow-tool "Agent"`（全部）或
`--allow-tool "Agent(explore)"`（只放行某类）。规则语法见[权限与人工确认](/use/permissions)。
:::

## 按类型分级模型（省钱的核心）

`~/.sid-code/settings.json`：

```json
{
  "model": "claude-sonnet-5",
  "subAgentModels": {
    "default": "glm-5.2",
    "verify": "claude-sonnet-5"
  }
}
```

含义：主对话用贵模型，子代理默认用便宜的，但**验证这一类仍用强模型**——
验证判错比搜索漏一条代价大得多，这里省钱不划算。

解析优先级（从高到低，实测逐级验证过）：

| # | 来源 | 说明 |
| --- | --- | --- |
| 1 | 单次调用指定的 model | 每次派活可覆盖 |
| 2 | `subAgentModels[类型]` | 按类型显式配置，永远优先 |
| 3 | `subAgentModels.default` | 你的兜底默认 |
| 4 | agent 定义里的 `model` | 自定义 agent 的 frontmatter |
| 5 | 语义档位（`modelTier`） | 从 `availableModels` 的价格自动派生 |
| 6 | 主模型 | 兜底，配错绝不会变更贵 |

### 零配置也已经在省钱了

第 5 层是自动的。实测：主模型 `claude-sonnet-5`，`availableModels` 里还有更便宜的
`glm-5.2`，**完全不配 `subAgentModels`** 时的实际派发：

```text
explore          → glm-5.2          ← 自动降到便宜档
plan             → glm-5.2          ← 自动降
summarize        → glm-5.2          ← 自动降
task             → claude-sonnet-5
verify           → claude-sonnet-5
general-purpose  → claude-sonnet-5
```

`explore` / `plan` / `summarize` 三类被标成 cheap 档，自动挑 `availableModels` 里最便宜的。
`task` / `verify` 要真干活或做判断，留在主模型。

档位派生不硬编码模型名单，而是**按 `availableModels` 里的 input 单价排序**。
所以要让它生效，`availableModels` 得配全（配置见[配置 LLM Provider](/start/configure)）。
想手动指定档位模型用环境变量：

```bash
export SID_CHEAP_MODEL=glm-5.2
export SID_STRONG_MODEL=claude-opus-5
```

::: tip 派生绝不会让你变贵
cheap 档如果算出来比主模型还贵（或就是主模型自己），就直接回退主模型而不是硬用。
配错方向的后果是「没省到」，不是「更贵了」。
:::

## 写自己的子代理

放一个 markdown 到 `<项目>/.sid-code/agents/`（用户级放 `~/.sid-code/agents/`）：

```markdown
---
description: 专门找导出的常量名，只返回名字列表
tools: read, grep, glob
modelTier: cheap
color: cyan
---

你只做一件事：在给定目录下找出所有导出的常量名。
只返回名字列表，不要解释、不要贴代码。
```

存盘后立刻能看到（实测）：

```text
可用子代理（共 7 个）:
  const-finder  [custom(project)]  模型: (主模型)
      专门找导出的常量名，只返回名字列表
      工具: read, grep, glob
```

frontmatter 可用字段：

| 字段 | 作用 |
| --- | --- |
| `description` | **必填**。模型据此判断什么时候该派它，写清楚触发场景 |
| `tools` | 工具白名单。**收窄工具集是最有效的约束**——只给 read/grep 它就不可能改文件 |
| `model` | 固定用某个模型；`inherit` 或留空 = 跟主模型 |
| `modelTier` | `cheap` / `strong` / `default`，让它自动挑档位 |
| `color` | UI 区分色 |
| `permissionMode` | 该 agent 专用的权限模式 |
| `background` | 是否默认后台执行 |
| `isolation` | 是否默认用独立 worktree（并行改文件时防冲突） |
| `skills` | 预加载的 skill 列表 |

也能在命令行临时注入，不落文件：

```bash
sid-code --agents '{"const-finder":{"description":"找导出常量","prompt":"只列名字","tools":["read","grep","glob"]}}'
```

让整个会话直接以某个子代理的人格跑：

```bash
sid-code --agent explore     # 本次会话就是个只读探索器
```

## 什么时候该用子代理

| 场景 | 用不用 | 为什么 |
| --- | --- | --- |
| 「这个函数在哪些地方被调用」 | ✅ `explore` | 搜索过程有一堆中间结果，不该进主上下文 |
| 「这十个文件各自干什么」 | ✅ 并行派多个 | 天然可并行，一次派一批比串行读快 |
| 「刚才那个修复真的成立吗」 | ✅ `verify` | 独立上下文才有对抗性，同一个上下文里它倾向自我确认 |
| 「改一下这行的变量名」 | ❌ 直接改 | 派活的开销（起 agent、传上下文）比干活本身大 |
| 「这个报错什么意思」 | ❌ 直接答 | 一轮对话的事 |

判断标准：**这件事的中间过程你想不想看见**。不想看见就派出去。

## 常见问题

### 派活失败：sub_agent 被拒

见上面的提示框——`sub_agent` 默认要确认，`-p` 模式下必须
`--allow-tool "Agent"` 显式放行。

### 我要求派某个子代理，它却自己干了

模型有时不调 `sub_agent`，而是把子代理的人格 prompt **内联到自己的思考里**接着干——
实测就撞到过一次：要求派 `const-finder`，它把 "你是一名 const-finder…" 写进了
`sub_agent` 的 prompt 参数，但没有传 `subagent_type`。
结果是活干对了，但 `Agent(const-finder)` 这条规则匹配不上（因为类型字段是空的）。

**影响**：按类型放行的规则、按类型分级的模型都会落到默认档。
要精确控制就用 `Agent`（裸工具名，匹配全部子代理）而不是 `Agent(具体类型)`。

### 自定义子代理没被识别

三个检查点：

```bash
# 1. 确认它被加载了
sid-code agents | grep 你的agent名

# 2. 目录对不对：<项目>/.sid-code/agents/*.md 或 ~/.sid-code/agents/*.md
# 3. frontmatter 里 description 是不是空的——空的话模型不知道什么时候派它
```

### 子代理花的钱算在哪

算在总费用里。子代理的 token 和费用会并入主会话的账，
`/cost` 的总费用是含它的（这是有意的——否则 `costLimit` 对子代理就失效了）。
细节见[成本与用量](/use/cost)。

### 想让子代理并行改文件

给它配 `isolation`，每个子代理拿一个独立 git worktree，互不冲突。
见[Worktree 隔离](/use/worktree)。

## 相关

- [成本与用量](/use/cost) —— 分级模型到底省了多少，怎么验证
- [权限与人工确认](/use/permissions) —— `Agent(type)` 规则语法
- [Worktree 隔离](/use/worktree) —— 并行改文件不冲突
- [Skill](/extend/skills) —— 打包一套流程；和子代理的区别是它不开新上下文
- [扩展方式总览](/extend/) —— 该用哪种扩展方式
- [CLI 参数与子命令](/ref/cli) —— `--agent` / `--agents` / `agents` 的完整说明
