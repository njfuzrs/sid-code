---
title: Skill
description: 把团队的流程与规范封装成可复用的 skill：8 个内置 skill 干什么、自定义怎么写、为什么写了不生效。
---

# Skill

Skill 是**按需加载的流程说明书**。没触发时只占一行摘要，触发了才把完整流程展开给模型。

这是它和 CLAUDE.md 的核心区别：CLAUDE.md 每轮都在上下文里，写多少付多少；
Skill 平时只有摘要（实测 8 个内置 Skill 合计约 0.5K token），用到才付全文的钱。
想教一整套「修 bug 的标准流程」，写 Skill 而不是塞 CLAUDE.md。

## 快速上手

一个最小可用的自定义 Skill 只要一个文件。在项目里建：

```bash
mkdir -p .sid-code/skills/changelog-entry
cat > .sid-code/skills/changelog-entry/SKILL.md <<'EOF'
---
name: changelog-entry
description: 按本仓库约定把一条改动写成 CHANGELOG 条目：读最近一条提交，产出一行「- 类型: 描述」。
when-to-use: 当用户说「写 changelog」「补一条变更记录」时触发
mode: activate
allowed-tools: bash, read
---

# changelog-entry

1. 跑 `git log -1 --pretty=%s` 拿到最近一条提交标题。
2. 按 `- <类型>: <一句话描述>` 输出一行，类型取 feat/fix/docs/chore 之一。
3. 只输出那一行，不要解释。
EOF
```

然后让它干活：

```bash
sid-code -p "用 changelog-entry skill 生成一条变更记录"
```

实测输出（仓库最近一条提交是 `fix: 修正 add 函数的边界条件`）：

```text
- fix: 修正 add 函数的边界条件
```

::: danger 项目级 Skill 在 `-p` 下默认加载不到
上面那条命令**首次跑会失败**，模型会说「`changelog-entry` 这个 Skill 目前不存在」。
原因不是 Skill 写错了，是**信任门槛**：项目级扩展来自仓库（等于别人的代码），
默认要确认才加载，而 `-p` 无头模式下无法确认 → 直接跳过。

打开信任即可（`~/.sid-code/app.json`）：

```json
{ "trust_project_extensions": true }
```

交互模式不受影响——它会弹确认让你决定。详见[下方](#项目级-skill-写了但模型说不存在)。
:::

## 8 个内置 Skill

`sid-code` 自带 8 个，开箱可用，无需配置：

| 名称 | 干什么 | 模式 |
| --- | --- | --- |
| `bug-fix` | 修 bug 的完整 SOP：复现 → 定位根因（要 `file:line` 实证）→ 出方案 → 人工审批 → 实现 → 测试验证 | activate |
| `code-review` | 针对 PR diff 出结构化 review：bug / 安全漏洞 / 设计反模式，带行号和可执行建议 | delegate |
| `security-audit` | 8 类漏洞检测（注入 / 凭据泄露 / XSS / 认证绕过 / 弱加密 / CVE 依赖 / IaC 配置 / 数据泄露），带 CWE/OWASP 引用 | delegate |
| `code-governance` | 合规治理：license / PII / 合规元数据 / 审计 trail | delegate |
| `ci-self-heal` | 读 CI 失败日志出诊断：失败分类 + 根因假设 + 可执行 fix | delegate |
| `incident-rca` | 线上故障根因分析：跨 log / metric / trace / commit / ADR 五个维度构造假设，给 hotfix / 缓解 / 长期三档建议 | delegate |
| `skill-creator` | 帮你写 Skill（写 Skill 的 Skill） | activate |
| `claude-code-migration` | 把 Claude Code 的配置迁到 sid-code：只 copy 不 move，不删源文件，不静默覆盖 | activate |

在会话里用 `/skills` 看当前加载了哪些，或直接 `/bug-fix` 手动触发某一个。

::: tip delegate 类的定位
`code-review` / `security-audit` / `ci-self-heal` / `incident-rca` / `code-governance`
都是 delegate 模式——它们在**独立子代理**里跑，产出结构化报告回来，不占主对话上下文。
这几个专门为「给 AI 生成的代码兜底」设计：AI 写得快，但得有人复核。
:::

## activate 与 delegate 的区别

这是写 Skill 时第一个要决定的事，选错影响很大：

| | `mode: activate` | `mode: delegate`（默认） |
| --- | --- | --- |
| 在哪跑 | 注入**当前对话**，模型接着往下做 | 派**子代理**去跑，只把结果带回来 |
| 上下文 | 共享主对话，能看到之前聊的一切 | 独立上下文，看不到主对话历史 |
| 适合 | 流程要和当前任务咬合（改代码的 SOP、写 changelog） | 独立可交付的活（出一份 review 报告、审计报告） |
| 代价 | 占主对话上下文 | 多一次 LLM 调用，但主对话不膨胀 |

拿不准就用 `activate`——它行为更直观。真正需要"独立产出一份报告"时才用 delegate。

## SKILL.md 的字段

文件必须是 `<skill 目录>/SKILL.md`，YAML frontmatter + Markdown 正文。
frontmatter 字段用 **kebab-case**（`when-to-use`，不是 `whenToUse`）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | Skill 名，也是斜杠命令名（`/changelog-entry`） |
| `description` | 是 | **模型据此判断要不要触发**。写具体，别写"处理各种任务" |
| `when-to-use` | 否 | 触发场景的补充说明，给模型更明确的信号 |
| `mode` | 否 | `activate` / `delegate`（默认 delegate） |
| `allowed-tools` | 否 | 允许用的工具，逗号分隔。不写 = 不额外限制 |
| `max-turns` | 否 | delegate 模式最大轮次，默认 10，上限 50 |
| `timeout-mins` | 否 | delegate 模式超时（分钟），默认 2，上限 30 |
| `model` | 否 | 指定模型（比如让审计走更强的模型） |
| `effort` | 否 | 推理努力程度：`low` / `medium` / `high` / `max` |
| `disable-model-invocation` | 否 | `true` = 只能手动 `/name` 触发，模型不能自动调 |
| `user-invocable` | 否 | `false` = 不注册斜杠命令，只给模型自动调 |
| `paths` | 否 | glob 列表，只在操作匹配文件时才激活（条件激活） |
| `version` / `argument-hint` / `agent` / `shell` | 否 | 版本号 / 参数提示 / 子代理类型 / `!` 命令用的 shell |

正文里可以用 `${SKILL_DIR}` 引用 Skill 自己的目录——放脚本、模板文件都靠它定位。

## description 决定它会不会被触发

Skill 能不能自动生效，几乎全看 `description` 写得够不够具体。模型看到的只有摘要列表，
它靠 `description` 判断"这次任务该不该展开这个 Skill"。

对比一下内置 `ci-self-heal` 的写法：

```yaml
description: "针对 CI 失败日志输出结构化诊断与修复建议. 识别失败分类(test/lint/build/type/dependency/config/flaky/timeout) / 根因假设 / 可执行 fix, 引用具体 file:line."
when-to-use: "当 CI 失败日志可用且用户说 'CI 挂了' / 'build failed' / 'tests failing' / '帮我看下 CI' 时触发"
```

它把**触发词**直接列进去了（"CI 挂了"、"build failed"）。写成
`description: 处理 CI 相关问题` 的话，模型大概率不会触发它——太含糊，没有判断依据。

内置 Skill 还有一个做法值得抄：**显式写清和其他 Skill 的边界**。
`ci-self-heal` 的 `when-to-use` 里有一句「与 code-review 的关系是: review 看 PR diff,
ci-self-heal 看 CI log, 输入与目标场景明确不重叠」——多个 Skill 场景相近时，
这种说明能避免模型选错。

## 加载位置与优先级

| 位置 | 作用域 | 信任要求 |
| --- | --- | --- |
| 内置（随二进制分发） | 全局 | 无 |
| `~/.sid-code/skills/<名>/SKILL.md` | 用户级 | 无 |
| `~/.claude/skills/` | 用户级（Claude Code 兼容读取） | 无 |
| `<项目>/.sid-code/skills/<名>/SKILL.md` | 项目级 | **要** |
| `<项目>/.claude/skills/` | 项目级（兼容读取） | **要** |
| 插件提供的 skill | 看插件作用域 | 看来源 |
| 企业 managed 目录 | 全局，优先级最高 | 无（企业下发即可信） |

同名时优先级：**managed > 用户级 > 项目级**。企业策略压得住个人配置。

## 常见问题

### 项目级 Skill 写了但模型说不存在

`-p` 无头模式下**默认加载不到项目级 Skill**——这是设计而非 bug：项目级扩展来自仓库，
默认视作不可信，需要用户确认；而 `-p` 下没法确认，所以直接跳过。

实测对比同一个 Skill、同一条命令：

```text
# trust_project_extensions 未开
`changelog-entry` 这个 Skill 目前不存在。不过我可以直接帮你生成变更记录……

# 开了之后
- fix: 修正 add 函数的边界条件
```

解决方式二选一：

- 在 `~/.sid-code/app.json` 设 `"trust_project_extensions": true`（CI 里常用）
- 或把 Skill 挪到用户级 `~/.sid-code/skills/`（不受信任门槛约束）

交互模式不受影响，会弹确认给你决定。

### 怎么确认 Skill 到底加载了几个

开 `-d` 跑一次，日志会明说：

```text
● [SKILL] 加载了 8 个 Skill
● [SKILL] 发现 8 个 Skill（8 个已启用）
● [PROMPT] 附件: Skill 摘要列表(0.5K tok, priority=8)
```

`加载了 N 个` 对不上你的预期，就是有文件没被扫到（路径不对）或被信任门槛拦了。

### 不想让某个内置 Skill 参与

`~/.sid-code/settings.json` 里列进 `disabledSkills`：

```json
{ "disabledSkills": ["code-governance", "incident-rca"] }
```

### 改了 SKILL.md 要重启吗

不用。Skill 有热重载监听（启动日志 `[SKILL] Skill 热重载监听已启动`），存盘即生效。

### Skill 会自己乱跑吗

会被模型自主触发——这是它的设计意图。不想让模型自动调，加
`disable-model-invocation: true`，这样只能你手动 `/name` 触发。
带副作用的 Skill（会提交、会推送的）建议都加上。

## 相关

- [扩展方式总览](/extend/) — Skill / Hook / 子代理 / MCP 怎么选
- [记忆与 CLAUDE.md](/use/memory) — 什么该写进 CLAUDE.md 而不是 Skill
- [子代理](/extend/subagents) — delegate 模式底层用的就是子代理
- [斜杠命令](/ref/slash-commands) — `/skills` 等命令的完整列表
- [settings.json 字段](/ref/settings) — `disabledSkills` 等字段
