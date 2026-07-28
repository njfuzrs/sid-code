---
title: Worktree 隔离
description: 在独立 worktree 里干活，含 symlink node_modules 的跨分支 lockfile 风险。
---

# Worktree 隔离

让它在一个独立的工作副本里改代码，你的主工作区一个字不动。

适合两种场景：**让它自己折腾一个改动，你同时在主仓干别的**；
**几个任务并行做，各自不互相踩**。

## 快速上手

启动即进入一个隔离 worktree：

```bash
sid-code --worktree=my-feature
```

省略名字会自动起一个可读的名字（`brave-eagle-42` 这种形态）：

```bash
sid-code --worktree
```

看现在有哪些：

```text
/worktree
```

真实输出：

```text
Worktrees:
    demo-feature [worktree-demo-feature] 命名 3m ✎未提交

提示: /worktree clean 清理过期临时 Worktree
```

分支名、创建时长、有没有未提交改动一眼看清。

## 详细说明

### 建在哪、基于什么

worktree 建在 `<项目根>/.sid-code/worktrees/<名字>/`，分支名是 `worktree-<名字>`。

基准 ref 默认是 **`fresh`**：从 `origin/<默认分支>` 切，本地没有就先 fetch，
实在拿不到才 fallback 到 `HEAD`。这个默认值的意思是"从远端最新的主干开始"，
而不是从你当前这个可能改了一半的工作区开始。

想从当前 HEAD 切：

```json
{
  "worktree": {
    "baseRef": "head"
  }
}
```

### 创建时它替你做的四件事

1. **symlink `node_modules` 到主仓** —— 免装依赖、省磁盘。有代价，见下一节。
2. **复制 `settings.local.json`** —— 你的本地配置跟着过去（可关：`copyLocalSettings: false`）
3. **`.worktreeinclude`** —— 主仓根下放这个文件（gitignore 语法），列出需要跟过去的
   gitignored 文件。`.env` / `.secrets` 这类东西 `git worktree add` 不会带，
   但开发时往往必须有。
4. **创建期告警** —— 检测到风险时提示，不替你做决定。

`.worktreeinclude` 例子：

```text
# 这些 gitignored 文件需要跟随 worktree
.env
.env.local
config/secrets.yaml
```

### ⚠ symlink node_modules 的跨分支 lockfile 风险

这是本页最需要你知道的一件事。

`node_modules` 是软链到主仓的，所以 **worktree 里跑的是主仓的依赖版本**。
如果这个分支的 lockfile 和主仓不同（比如它加了个新依赖，或者你切的是几周前的分支），
你会撞上静默的 `module not found` 或者版本错乱——代码看着没问题，跑起来莫名报错。

创建时会做 lockfile hash 比对，不一致就告警。真实告警文本：

```text
依赖不一致：bun.lock 与主仓不同，但 node_modules 是 symlink 到主仓的。
   worktree 里跑的将是**主仓的依赖版本**，可能导致 module not found / 版本错乱。
   建议：在此 worktree 内重装依赖（如 pnpm/bun/npm install），或删除 node_modules 软链后独立安装。
```

支持的 lockfile：`pnpm-lock.yaml`、`bun.lock`、`bun.lockb`、`package-lock.json`、`yarn.lock`。
lockfile 一致时**零输出**，不制造噪音。

它**不会自动帮你 install**——install 有一堆边界情况（哪个包管理器、要不要 frozen、
装多久），自动跑弊大于利。看到告警你自己决定：

```bash
cd .sid-code/worktrees/my-feature
rm node_modules        # 删掉软链
pnpm install           # 独立安装
```

想从一开始就不 symlink：

```json
{
  "worktree": {
    "symlinkDirectories": []
  }
}
```

代价是每个 worktree 都要装一份依赖，磁盘和时间都要花。默认 symlink 是因为大多数
时候分支间 lockfile 是一样的，这时候 symlink 纯赚。

### 数据库 migration 提醒

并行 worktree 共享同一个数据库时，migration 会互相打架。检测到
`prisma/`、`drizzle.config.ts`、`knexfile.js`、`alembic.ini`、`migrations/`
这类标记时会提示：

```text
检测到数据库 migration（prisma/migrations）。
   并行 worktree 共享同一数据库时，migration 可能互相冲突（table already exists / schema 覆盖）。
   建议：为本 worktree 指向独立 DB（改 DATABASE_URL），或用 Neon/PlanetScale 等 DB 分支。
```

纯提示，零副作用。真要并行跑带 migration 的活，给每个 worktree 一个独立库。

### 其它配置

```json
{
  "worktree": {
    "symlinkDirectories": ["node_modules", ".venv"],
    "sparsePaths": ["src", "tests"],
    "baseRef": "fresh",
    "commitAttribution": false,
    "copyLocalSettings": true
  }
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `symlinkDirectories` | `["node_modules"]` | 要软链的目录 |
| `sparsePaths` | `[]`（不启用） | sparse-checkout，只签出这几个路径。大仓库里能显著提速 |
| `baseRef` | `fresh` | `fresh` = origin/默认分支，`head` = 当前 HEAD |
| `commitAttribution` | `false` | 是否装 commit 归因 hook |
| `copyLocalSettings` | `true` | 是否复制 `settings.local.json` |

配置读取全程容错——settings 写错了会退回全默认值，**绝不因为配置问题阻断 worktree 创建**。

### 清理

```text
/worktree clean
```

只清理**临时** worktree（子代理、Workflow、Swarm 建的那些，名字形如 `agent-xxxxxxxx`、
`wf_...`、`swarm-...`），默认阈值 30 天。**你自己命名的永远不碰**——
`/worktree` 列表里标"命名"的就是这类。

被 `git worktree lock` 锁住的也跳过，那通常意味着另一个进程正在用。

### 和子代理并行的关系

子代理可以各自跑在独立 worktree 里，这样多个 agent 同时改文件不会冲突。
`/batch` 就是这个模式：把任务拆成独立单元，各自 worktree 并行执行。

```text
/batch 把 src/legacy/ 下每个文件的 class 组件改成函数式
```

worktree 隔离有实际开销（创建 + 磁盘），所以只在 agent 真的会并行改文件时才值得。
纯读的探索任务不需要。

### 从 PR 继续工作：`--from-pr`

不是每次都从主干切 worktree——有时你想**接着一个已存在的 PR 往下做**。
`--from-pr <number>` 从 PR 恢复会话上下文（`src/session/from-pr.ts`，对齐 claude-code）：

```bash
sid-code --from-pr 42
```

它做两件事之一，取决于 PR 描述里有没有内嵌会话 id：

| PR 描述情况 | 行为 |
| --- | --- |
| 内嵌了 `sid-session: <id>` / `session-id: <id>` 之类标记 | **恢复原会话**——转到正常 resume 流程，把那次做 PR 时的工作上下文原样接回来 |
| 没有内嵌 id | **注入 PR 上下文到新会话**——把 PR 的标题、描述、改动文件列表拼成一段初始上下文，让模型带着"这个 PR 改了什么"的背景开始 |

注入的上下文长这样（`from-pr.ts` 的 `buildPrContextText`）：

```text
我正在基于 PR #42 继续工作，以下是该 PR 的上下文：

标题：修复 add 函数的边界条件
分支：fix/add → main

描述：
<PR body 原文>

改动文件（3）：
  - src/calc.ts
  - tests/calc.test.ts
  - README.md
```

依赖 `gh` CLI（`gh pr view`）。`gh` 不可用 / 未登录 / PR 不存在时**报错降级而非静默吞**
——PR 恢复失败用户需要知道为什么。常见错误：

```text
错误: --from-pr 需要一个 PR 编号（数字），收到: "abc"
错误: gh pr view 42 失败：未找到 gh CLI。请先安装 GitHub CLI...
```

配合 worktree 用最顺——基于 PR 开一个隔离工作副本：

```bash
sid-code --from-pr 42 --worktree=pr-42-fix
```

这样新会话带着 PR 上下文开始，改动又隔离在 `worktree-pr-42-fix` 里，不碰主工作区。

## Git 集成与提交归因

用 sid-code 提交代码时，commit message 和 PR 描述默认会带一行归因尾注，
标明这次改动是 sid-code 协作的产物。这是**默认开启**的，可以关、可以改。

### 归因长什么样

| 位置 | 默认尾注 | 配置字段 |
| --- | --- | --- |
| commit message 末尾 | `Co-Authored-By: sid-code <noreply@sid-code.cc>` | `git.commitAttribution` |
| PR 描述末尾 | `🤖 Generated with sid-code` | `git.prAttribution` |

commit 归因与正文之间空一行（vim `Co-Authored-By` 惯例）。这两条是**独立可配**的——
关掉 commit 归因不影响 PR 归因，反之亦然（`src/tool/git-attribution.ts`）。

### 怎么配 / 怎么关

settings.json 的 `git` 字段（`src/config/config.ts:659-672`）：

```json
{
  "git": {
    "commitAttribution": {
      "enabled": true,
      "text": "Co-Authored-By: sid-code <noreply@sid-code.cc>"
    },
    "prAttribution": {
      "enabled": true,
      "text": "🤖 Generated with sid-code"
    }
  }
}
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `commitAttribution.enabled` | `true` | 是否给 commit 加归因 |
| `commitAttribution.text` | `Co-Authored-By: sid-code <noreply@sid-code.cc>` | 自定义归因文本（空串回退默认） |
| `prAttribution.enabled` | `true` | 是否给 PR 加归因 |
| `prAttribution.text` | `🤖 Generated with sid-code` | 自定义 PR 归因文本 |

关掉某一类：

```json
{ "git": { "commitAttribution": { "enabled": false } } }
```

`enabled: false` 时对应路径完全不出现归因文字（不是"加个空行"，是 prompt 里压根不提）。
`text` 设成空串或纯空白会回退到默认值，不会生成一个没有内容的尾注。

### 归因什么时候触发

**只有 sid-code 执行的 git 操作才加归因**，不是所有 git commit 都加：

- `/commit`、`/commit-push-pr`、`/pr-workflow`、`/pr` 这些 skill 的 prompt 里会动态注入归因指令，
  模型写 commit/PR 时按指令追加——这是主路径
- worktree 内若装了 `prepare-commit-msg` hook（`worktree.commitAttribution: true`），
  你手动 `git commit` 也会触发

所以**非 worktree 的普通仓库里，你绕过 sid-code 手动 `git commit` 不会带归因**。
想让 worktree 里的裸 commit 也带归因，要把上面的 `worktree.commitAttribution` 设 `true`。

### worktree 的 `commitAttribution` 和全局 `git.commitAttribution` 什么关系

容易混，因为名字一样但管的事不同：

| 开关 | 位置 | 默认 | 管什么 |
| --- | --- | --- | --- |
| `worktree.commitAttribution` | `worktree` 段 | `false` | **是否装** prepare-commit-msg hook（布尔值） |
| `git.commitAttribution.enabled` | `git` 段 | `true` | **归因文本**是否启用（装了 hook 后写什么内容） |

关系链（`src/worktree/manager.ts:499-501`）：

```text
worktree.commitAttribution: true  → 装 prepare-commit-msg hook
  └─ hook 内读 git.commitAttribution
       ├─ enabled: false → 跳过（hook 装了但不写内容）
       └─ enabled: true  → 写 text（或默认值）进 commit message
```

所以：

- 想全局关归因 → 设 `git.commitAttribution.enabled: false`（所有路径都关）
- 只想关 worktree 的 hook（保留 skill prompt 归因）→ 设 `worktree.commitAttribution: false`
- 默认状态下 worktree 不装 hook（`false`），但 skill prompt 归因是开的（`git.commitAttribution.enabled` 默认 `true`）

::: tip 自定义归因文本
想把"sid-code"换成你们团队的名字，改 `text` 字段即可。比如内部规范要求写
`Co-Authored-By: dev-bot <bot@company.com>`，设成：
`{ "git": { "commitAttribution": { "text": "Co-Authored-By: dev-bot <bot@company.com>" } } }`。
:::

## 常见问题

**worktree 里跑测试报 `module not found`，主仓好的。**
八成就是上面那个 lockfile 问题。检查两边 lockfile 是否一致，不一致就在 worktree 里
重装依赖。

**创建时没看到任何告警，是没检查吗。**
lockfile 一致 + 没有 DB 标记时是零输出的，这是设计——不制造噪音。

**`.env` 没跟过去。**
`git worktree add` 不带 gitignored 文件。在主仓根建 `.worktreeinclude` 列出来。

**改完了怎么合回去。**
就是普通的 git 分支，`worktree-<名字>`。正常 merge / PR 流程，没有特殊之处。

**`/worktree clean` 没删掉我那个不用了的 worktree。**
你自己命名的不会被自动清理。手动删：`git worktree remove <路径>`。

**大仓库里创建很慢。**
用 `sparsePaths` 只签出你要动的目录。

**能在 worktree 里再开 worktree 吗。**
不建议。嵌套的路径解析和依赖软链会绕起来，收益也不明确。

## 相关

- [子代理](/extend/subagents) —— 并行执行时 worktree 隔离怎么用
- [会话管理](/use/sessions) —— worktree 里的会话与主仓共享记忆，但会话按目录分桶
- [记忆与 CLAUDE.md](/use/memory) —— 记忆按 git 顶层目录分桶，多 worktree 共享
- [settings.json 字段](/ref/settings) —— `worktree` 段完整字段
- [CLI 参数与子命令](/ref/cli) —— `--worktree` 参数
