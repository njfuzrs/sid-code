---
title: 记忆与 CLAUDE.md
description: 项目指令、个人记忆、团队记忆三层的作用范围与优先级。
---

# 记忆与 CLAUDE.md

不想每次开会话都重复交代"这个项目用 pnpm 不用 npm"、"提交信息写中文"、
"改完必须跑 `make check`"。把这些写一次，之后自动带上。

三种机制，别混：

| 机制 | 谁写 | 什么时候进上下文 | 适合放什么 |
| --- | --- | --- | --- |
| **CLAUDE.md** | 你手写 | 每次会话，全量 | 项目约定、规范、铁律 |
| **记忆**（save_memory） | 模型写，你确认 | 索引每次带，正文按需读 | 你的偏好、纠正、决策 |
| **团队记忆** | 团队共享目录 | 索引每次带 | 团队级规范与架构决策 |

先用 CLAUDE.md。写一个文件就生效，性价比最高。

## 快速上手

让它自己看一遍代码库，生成初版：

```text
/init
```

生成的 `CLAUDE.md` 在项目根。改成你要的，比如：

```markdown
# 项目约定

## 包管理
用 pnpm，不要用 npm 或 yarn。

## 提交
提交信息用中文，格式 `type: 描述`。不要加 emoji。

## 改完必须做
跑 `pnpm test` 和 `pnpm lint`，两个都过了才算完成。
```

下次开会话它就带上了。想确认到底加载了哪些文件：

```text
/memory list
```

## 详细说明

### CLAUDE.md 的层级与优先级

不止项目根一个文件。完整合并链，**后者覆盖/累积在前者之上**：

```text
企业 managed → 全局 → 用户规则目录 → 项目根 → 子目录 → .claude/rules/ → CLAUDE.local.md
```

| 层 | 位置 | 用途 |
| --- | --- | --- |
| managed | 系统级 managed 目录 | 组织策略基座，个人改不掉 |
| 全局（user） | `~/.claude/CLAUDE.md`，回退 `~/.sid-code/CLAUDE.md` | 你的个人习惯，跨所有项目 |
| 用户规则目录 | `~/.claude/rules/`，回退 `~/.sid-code/rules/` | 拆成多个文件的个人规则 |
| 项目根（project） | `<项目根>/CLAUDE.md` | 团队共享，检入代码库 |
| 子目录（subdir） | 父目录链上各级的 `CLAUDE.md` | 目录级细化规则，越深优先级越高 |
| 规则目录 | `<项目根>/.claude/rules/*.md` | 项目规则拆分 |
| local | `CLAUDE.local.md` | 你个人的项目内偏好，**不检入** |

文件名候选除了 `CLAUDE.md` 还认 `.claude/CLAUDE.md` 等，同层多个候选取优先级最高的那个。

**子目录这一层实际很好用**：在 `src/ui/` 放一个 `CLAUDE.md` 写"这个目录下的组件必须
用函数式写法"，只在动那个目录时生效，不污染全局。

### `CLAUDE.local.md` vs `CLAUDE.md`

同一个项目里两个人偏好不同的时候：

- `CLAUDE.md` —— 团队规范，检入 git，所有人一样
- `CLAUDE.local.md` —— 你自己的，加进 `.gitignore`，优先级最高

比如团队用 `CLAUDE.md` 规定"注释写英文"，你个人在 `CLAUDE.local.md` 里加
"跟我对话用中文"——两件事不冲突，各生效。

### CLAUDE.md 里能 import 别的文件

支持 `@路径` 引用，把大文件拆开：

```markdown
@docs/coding-style.md
@docs/review-checklist.md
```

**项目根之外的引用（含 `~/`）需要批准**。这是个安全边界：一个恶意仓库的
CLAUDE.md 不能靠 `@~/.ssh/id_rsa` 把你的私钥读进上下文。未批准的外部 import
会被跳过并提示。

### 写 CLAUDE.md 的实际建议

它进系统提示词，**每次请求都要发一遍**，所以长度是有成本的。

- **写"必须/不要"，别写"最好/建议"**。模糊的要求等于没要求。
- **写它猜不到的**。"用 TypeScript"这种从 `tsconfig.json` 就能看出来，不用写。
  该写的是"这个项目里 `any` 是禁的，宁可写 `unknown` 再 narrow"。
- **别堆到几百行**。没人遵守的规则是每次请求都在为它付费。写完一段时间回头看看
  哪几条它从来没违反过——那些其实不用写。
- **改动要慎重**。CLAUDE.md 在 prompt 前缀里，改一次缓存全失效，
  见[成本与用量](/use/cost)。

想看它现在占多少上下文，`/context` 里有独立的"记忆/CLAUDE.md"一项。

### 记忆：模型自己攒的东西

CLAUDE.md 是你手写的，记忆是模型用 `save_memory` 存的，跨会话可用。四类封闭分类：

| 类型 | 存什么 |
| --- | --- |
| `user` | 用户画像（角色、目标、知识水平、长期偏好） |
| `feedback` | 行为反馈（你的纠正与确认，含 Why 和怎么应用） |
| `project` | 项目上下文（进行中的工作、决策、截止日期，无法从代码推导的） |
| `reference` | 外部引用（URL、dashboard、工单的指针） |

触发方式最自然的就是直接说：

```text
以后都用 pnpm，记住
```

**它不该存什么**（这些约束写在系统提示词里）：

- 能从代码 / git / 文件内容直接推导的事实
- 临时会话状态、当前任务进展
- API Key、token、密码等凭证明文
- 已经在 CLAUDE.md 里的规则

存储在 `~/.sid-code/projects/<项目键>/memory/` 下。项目键用 **git 顶层目录**派生，
所以同一个仓库的多个 worktree 共享同一份记忆——在 worktree 里攒的记忆回主仓照样在。

管理命令：

```text
/memory list             列出记忆
/memory search <关键词>  搜
/memory show <名字>      看正文
/memory delete <名字>    删
/memory auto             切自动记忆开关
/memory reload           重新加载
```

**注入方式是"索引 + 按需读"**：每次会话只带一份 MEMORY.md 索引（名字 + 一行描述），
模型判断需要某条时才 Read 正文。所以记忆攒多了不会线性推高每次请求的成本。

自动记忆可以关：

```bash
SID_CODE_AUTO_MEMORY=false sid-code
```

或者写 settings 的 `autoMemory`。优先级是 env > settings > 默认开启。

### 记忆是快照，不是实时状态

系统提示词里对模型有一条明确约束：**记忆是"写入时的时间点观察"**。
引用记忆里关于代码行为或 `file:line` 的断言之前，要先对照当前代码验证。

这条很重要。三周前存的"认证逻辑在 `src/auth.ts:42`"现在大概率已经不对了。

### 团队记忆

共享目录模型：团队成员共用一个目录，写入后同步到各人本机，
团队 MEMORY.md 索引也注入每个会话——否则团队知识永远进不了上下文。

```bash
SID_CODE_TEAM_MEMORY='{"enabled":true,"dir":"/shared/team-memory"}' sid-code
```

推荐写进 settings 的 `teamMemory` 段而不是每次带环境变量。
团队场景的完整做法见[企业与团队](/team/defaults)。

## 常见问题

**CLAUDE.md 写了但它不遵守。**
先确认加载了：`/memory list` 或看 `/context` 里"记忆/CLAUDE.md"是否非零。
加载了还不遵守，通常是写法问题——把"建议用 X"改成"必须用 X，不要用 Y"。

**`@` import 的文件没被读进来。**
如果引用的路径在项目根之外（含 `~/`），需要批准才生效。这是防止恶意仓库读你本机文件的
设计，不是 bug。

**改了 CLAUDE.md 要重启吗。**
规则在会话启动时加载。改完想立刻生效，`/memory reload`。

**多个 CLAUDE.md 冲突了听谁的。**
按上面那条合并链，越靠后越优先。`CLAUDE.local.md` 最大。

**我在 worktree 里让它记的东西，回主仓没了。**
不该发生——记忆按 git 顶层目录分桶，多 worktree 共享。真遇到这情况先确认那个
worktree 是不是同一个仓库的（`git rev-parse --show-toplevel` 对比一下）。

**记忆里存了敏感信息怎么办。**
`/memory delete <名字>` 删掉。系统提示词里已经禁止存凭证，但如果你在对话里贴过
明文 key，它有可能被摘进 `project` 类记忆——发现了直接删。

**能不能完全不用记忆，只用 CLAUDE.md。**
可以，`autoMemory: false`。很多人就这么用，CLAUDE.md 已经覆盖大部分需求。

## 相关

- [上下文与压缩](/use/context) —— CLAUDE.md 占多少、怎么看
- [成本与用量](/use/cost) —— 为什么频繁改 CLAUDE.md 会变贵
- [Skill](/extend/skills) —— 比 CLAUDE.md 更重的复用单位：把一套流程打包
- [团队默认配置分发](/team/defaults) —— 团队记忆与配置怎么发
- [settings.json 字段](/ref/settings) —— `autoMemory` / `teamMemory` 字段
