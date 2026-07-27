---
title: 扩展方式总览
description: Skill / Hook / 子代理 / MCP / 插件 五条扩展路径的选择表：什么场景用哪个。
---

# 扩展方式总览

sid-code 有五条扩展路径。它们不是同一件事的五种写法，**入口时机完全不同**——
选错了不是效率差一点，是压根不会触发。这页帮你在动手前选对。

## 先看这张表

想干什么 → 用哪个：

| 你想做的事 | 该用 | 为什么不是别的 |
| --- | --- | --- |
| 让它知道项目约定（用 bun 不用 npm、注释写中文） | **CLAUDE.md** | 每轮都在上下文里，成本最低。见[记忆与 CLAUDE.md](/use/memory) |
| 把一套多步流程教给它（修 bug 的 SOP、发版流程） | **[Skill](/extend/skills)** | 按需加载：不触发时只占一行摘要，触发了才展开全文 |
| 在固定时机**强制**跑一段命令（提交前 lint、拦住 `git push`） | **[Hook](/extend/hooks)** | 唯一能**阻断**工具执行的机制。Skill/CLAUDE.md 都是"建议"，模型可以不听 |
| 派人去干独立的活（并行读 20 个文件、跑一轮 review） | **[子代理](/extend/subagents)** | 独立上下文，不污染主对话；还能按类型分级到便宜模型省钱 |
| 接内部系统（工单、发布平台、公司知识库） | **[MCP](/extend/mcp)** | 标准协议，一次接入所有支持 MCP 的客户端都能用 |
| 把符号级导航做准（跳定义、找引用、类型错误自动反馈） | **[LSP](/extend/lsp)** | 装好 language server 就零配置生效，不用配任何东西 |
| 在 CI / 脚本里非交互跑 | **[无头模式](/extend/headless)** | `-p` + `--output-format json`，当 SDK 用 |
| 把上面几样打包分发给团队 | **[插件](/extend/plugins)** | 一个目录同时带命令 / Skill / Hook / MCP，`--plugin-dir` 一行接入 |

## 关键区别：谁能拦住模型

这是选择时最容易踩的一条。五条路径里**只有 Hook 能阻断**：

| 机制 | 模型能不听吗 | 触发方式 |
| --- | --- | --- |
| CLAUDE.md | 能（是提示词） | 每轮注入上下文 |
| Skill | 能（是提示词） | 模型按 description 自主判断，或用户 `/name` 手动触发 |
| 子代理 | 能（是工具） | 模型决定调不调 |
| MCP | 能（是工具） | 模型决定调不调 |
| **Hook** | **不能** | 代码级：事件到了就跑，`exit 2` 直接阻断工具 |

所以"禁止直接 push 到 master"这类**硬约束**必须写成 Hook。写进 CLAUDE.md 只是
"希望它别这么做"——大部分时候有效，但没有保证。

## 加载成本对比

扩展不是免费的，都要占上下文。按"没触发时的固定开销"排：

| 机制 | 未触发时的开销 | 说明 |
| --- | --- | --- |
| CLAUDE.md | 全文，每轮都在 | 写多少占多少，这是唯一无条件常驻的 |
| Skill | 一行摘要 | 实测 8 个内置 Skill 的摘要合计约 0.5K token（启动日志：`附件: Skill 摘要列表(0.5K tok, priority=8)`） |
| Hook | 0 | 配置不进上下文，模型不知道 hook 存在 |
| 子代理 | 0（`sub_agent` 工具本身几百 token） | 子代理的活在独立上下文里跑，只回结果 |
| MCP | 默认 0 | MCP 工具默认延迟加载，模型要用先走 `tool_search`。见 [MCP](/extend/mcp) |

**推论**：想教一堆流程，别全塞 CLAUDE.md——那是每轮都付钱。拆成 Skill，用到才付。

## 最小示例：一条命令验证扩展生效

拿插件最快——不用改任何配置文件，`--plugin-dir` 一个参数就能加载：

```bash
mkdir -p /tmp/demo-plugin/commands
cat > /tmp/demo-plugin/plugin.json <<'EOF'
{ "name": "demo", "version": "0.1.0", "description": "验证插件加载", "commands": "commands/" }
EOF
cat > /tmp/demo-plugin/commands/ping.md <<'EOF'
---
description: 回一句 pong
---
回答「pong」，不要说别的。
EOF

sid-code --plugin-dir /tmp/demo-plugin
```

进会话后输入 `/demo:ping`（插件命令带 `插件名:` 前缀）。启动日志会有：

```text
● [PLUGIN] 加载了 1 个插件命令
```

## 配置放在哪

五条路径的配置位置，一张表记住：

| 机制 | 用户级（全局） | 项目级（跟仓库走） |
| --- | --- | --- |
| CLAUDE.md | `~/.sid-code/CLAUDE.md` | `<项目>/CLAUDE.md` |
| Skill | `~/.sid-code/skills/<名>/SKILL.md` | `<项目>/.sid-code/skills/<名>/SKILL.md` |
| Hook | `~/.sid-code/settings.json` 的 `hooks` | `<项目>/.sid-code/settings.json` |
| 子代理 | `~/.sid-code/agents/*.md` | `<项目>/.sid-code/agents/*.md` |
| MCP | `~/.sid-code/settings.json` 的 `mcpServers` | `<项目>/.mcp.json` |
| 插件 | `~/.sid-code/plugins/` | `--plugin-dir <路径>`（会话级） |

::: tip 项目级扩展有信任门槛
项目级 Skill / 命令 / 子代理来自仓库，等于"别人的代码"，默认要确认才加载。
交互模式下会提示你确认；**`-p` 无头模式下默认直接跳过不加载**。
CI 里要用项目级扩展，得显式打开信任——细节见 [Skill](/extend/skills#常见问题)。
:::

## 常见问题

### 配了但没生效，先查哪个

按"触发条件是否满足"排查，顺序是：

1. **Hook** → 事件名是不是 snake_case、格式是不是平铺。见 [Hook 指南](/extend/hooks)
2. **Skill** → 项目级的话是不是被信任门槛拦了；`description` 写得太含糊模型不会主动触发
3. **MCP** → 是不是没走 `tool_search`（默认延迟加载，工具不在首轮工具池里）
4. **插件** → 看启动日志有没有 `[PLUGIN] 加载了 N 个...`

### Skill 和插件是什么关系

插件是**分发容器**，Skill 是**内容**。一个插件里可以装 Skill、命令、Hook、MCP 配置。
自己用写 Skill 就够；要发给团队十个人用，打成插件——他们一个 `--plugin-dir` 全拿到。

### 想同时用好几个，会冲突吗

会，且有明确的优先级。同名时：**managed（企业下发）> 用户级 > 项目级**，
插件内部则是 inline（`--plugin-dir`）> 已安装 > 内置。
这个顺序的意思是：企业策略压得住个人配置，`--plugin-dir` 能覆盖已安装的同名插件方便调试。

## 相关

- [Skill](/extend/skills) — 把流程封装成可复用单元
- [Hook 指南](/extend/hooks) — 唯一能阻断的机制
- [子代理](/extend/subagents) — 独立上下文 + 按类型分级省钱
- [MCP](/extend/mcp) — 接内部系统
- [代码智能（LSP）](/extend/lsp) — 符号级导航与诊断注入
- [无头模式与脚本化](/extend/headless) — 在 CI 里跑
- [插件与 Bridge](/extend/plugins) — 打包分发
- [settings.json 字段](/ref/settings) — 全部配置字段的类型与默认值
