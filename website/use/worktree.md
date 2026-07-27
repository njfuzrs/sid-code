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
