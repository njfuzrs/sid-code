---
title: Hermes Agent 深入研究（2026-08 快照）
description: 20 章逐节成册，按目录跳章查阅——把 Nous Research 的 Hermes Agent 交叉核验到版本号级别：三套版本号并存且 PyPI 上有官方包却被文档判为不支持、83 个内置工具 / 59 个 toolset、24 个渠道平台、7 个终端后端、24 个插件 Hook、95 条斜杠命令、27 个 LSP server、单文件 27814 行的 gateway、以及一条真的接线了的学习闭环。这是一份手册，不是读完就走的文章。
date: "2026-08-09"
series: 深入研究
audience: engineer
highlight: 20 章逐节可查 · 核验至 HEAD 372b3b7bb / PyPI 0.19.0 / tag v2026.8.3 · 截至 2026-08-09 快照
tags: [Hermes Agent, Nous Research, 深入研究, 学习闭环, 渠道, 参考]
outline: [2, 3]
---

# Hermes Agent 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-09
- **被调研版本**：这个项目**同时存在三套互不相等的版本号**，所以这里必须全列（这本身是本文的一条发现，见文首 danger 框与 §19）：
  —— `pyproject.toml` = **0.20.0**
  —— PyPI `hermes-agent` 最新 = **0.19.0**（2026-07-20 发布）
  —— 最新 git tag = **`v2026.8.3`**（2026-08-03，release 标题写「Hermes Agent v0.20.0 (2026.8.3)」）
  本地 clone 的最新提交是 **`372b3b7bb`**（2026-08-08 11:49:17 -0700）。
- **证据形态**：**本地源码实查 + GitHub REST API / PyPI registry 实查 + 仓库内文档源文件**。
  与本系列的 Claude Code / Codex / opencode 三篇不同，本篇的**代码结构类断言
  直接来自本地 clone 的源码**（`~/Code/person/github/hermes-agent`），
  而不是二手分析；但**行为类断言仍以仓库内文档为据，我们没有把它装起来跑过**。
  这个区别在每一章里都尽量标清了。
- **一手性说明**：计数类事实（工具数、toolset 数、渠道数、Hook 事件数、斜杠命令数、
  LSP server 数）**全部用脚本从源码里数出来**，判据在正文里给出，不是目测；
  Star 数 / 语言占比 / issue 与 PR 数 / 版本时间线取自 GitHub REST API 与 PyPI registry。
- **时效边界**：这个仓库累计 **21,330 个提交**、**1,505 个远端分支**，
  单月峰值 **5,675 个提交**（2026-07）。**这是 2026-08-09 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://hermes-agent.nousresearch.com/docs/)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 四条容易被想当然、而在 2026-08 都不成立的说法
1. **「它在 PyPI 上，所以 `pip install hermes-agent` 是一条正常安装路径」**——
   **包是真的，路径是被官方否掉的。** PyPI 上确实有 `hermes-agent`，
   author 写着 `Nous Research`，最新 `0.19.0`（2026-07-20，wheel 10,144,439 字节），
   一共 11 个 release。但官方文档 `website/docs/getting-started/platform-support.md:47`
   把 **「installs via `pypi`（`uv tool install hermes-agent`、`pip install hermes-agent` 等）」
   明确列在 `## Unsupported` 段落下**，同段还写明「PRs to fix them will _not_ be accepted」。
   中文快速上手页说得更直白：「这是唯一受支持的安装方式……**请勿使用 `pip install hermes-agent`**」。
   **一个自己在发、同时又声明不支持的包**——这是本文最反直觉的一处。见 §19。
2. **「227k star 的项目，issue 区大概几千条」**——**量级差一位数，而且大头是 PR 不是 issue。**
   实测 `open_issues_count` = **29,686**，但这个字段 GitHub 是把 issue 和 PR 混在一起算的。
   拆开数：**open PR 19,823 条、open issue 9,847 条**。
   **未合并的 PR 数量是未关闭 issue 的两倍**，配合 **1,505 个远端分支**看，
   这是一个贡献量远超合并吞吐的仓库。见 §18。
3. **「`hermes update` 就是重装一次包」**——**不是，它是 `git pull`。**
   `hermes_cli/update_cmd.py`（5,555 行）走的是 `git pull --ff-only` +
   失败时的 ZIP 兜底，并且带 `_validate_critical_files_syntax` /
   `_validate_critical_modules_import` 两道校验来在拉坏时自动回滚。
   官方安装是 `curl install.sh | bash`，在 `~/.hermes/hermes-agent` 放一个受管 venv。
   **这不是包管理器分发模型，是「托管一个 git 工作副本」模型。** 见 §19。
4. **「`AGENTS.md` 是仓库的权威说明，照它写就行」**——
   **它自己就有已漂移的段落。** `AGENTS.md:723` 的「Built-in skins」只列 4 个
   （`default` / `ares` / `mono` / `slate`），而 `hermes_cli/skin_engine.py:201`
   的 `_BUILTIN_SKINS` 实际有 **9 个**。
   时间线很能说明问题：文档写于 `b4b46d1b6`（2026-03-10 00:51），
   而 `poseidon` / `sisyphus` / `charizard` 三个皮肤在 **同一天 02:11** 由
   `4945240fc` 加入——**文档在落地后 80 分钟就过期了，并且一直没补**。
   有意思的是**面向用户的文档站没漂**：`website/docs/user-guide/features/skins.md`
   把 9 个全列了。所以漂移只发生在给贡献者/agent 看的那份。见 §17。

前三条都是「按包管理器直觉套一个非包管理器项目」的代价。本文标注的现状同样会漂移——
引用前先看一眼日期。
:::

::: tip 这一篇的证据形态与边界
和 `ref-openclaw` / `ref-reasonix` / `ref-kimi-code` 一样，本篇多了一层**本地 clone 的源码**，
所以能给出「工具到底是 83 个还是 56 个」（§4）、
「`AGENTS.md` 的皮肤清单在落地 80 分钟后就过期」（§17）
这种**能用 `git log -S` 定位到具体 commit** 的判据。

代价是**边界必须说清**：源码能证明「代码里有什么」，**不能证明「跑起来是什么行为」**。
本文没有把 Hermes Agent 装起来跑过——所有行为描述（学习闭环是否真的产出可用技能、
七个终端后端是否都通、Honcho 用户建模的实际效果）都来自仓库内文档与代码注释，
属**厂商口径**，见文末未验证块（§20）。

还有一层特殊边界：**这个仓库的体量本身就是一种阅读障碍**。
`gateway/run.py` 单文件 **27,814 行**，`cli.py` **18,611 行**，
`hermes_cli/web_server.py` **17,951 行**。本文读的是这些文件的结构、
接口与注释，**没有对任何一个大文件做逐行审计**——
「某个分支实际是否可达」这类问题本文答不了。
:::

---

## 1. 产品概述与身份辨析

Hermes Agent 的自我定位不是 coding agent，而是**会跨会话学习的个人 AI 助理**。
README 的第一句是「**The self-improving AI agent built by Nous Research**」，
紧跟的差异化主张是「it's the only agent with a built-in learning loop」。
`AGENTS.md:7` 的内部表述更克制也更准确：

> Hermes is a personal AI agent that runs the same agent core across a CLI, a
> messaging gateway (Telegram, Discord, Slack, and ~20 other platforms), a TUI,
> and an Electron desktop app.

**这句话里「same agent core across N surfaces」是理解整个仓库结构的钥匙**——
它不是一个 CLI 加了几个适配器，而是一个 agent 核心被 CLI / gateway / TUI /
Electron / ACP / API server 六种前端复用（§14）。

**四条硬身份事实：**

| 项 | 值 | 判据 |
| --- | --- | --- |
| 仓库 | `NousResearch/hermes-agent` | GitHub API |
| 许可 | **MIT** | API `license.spdx_id`，`LICENSE` 文件 |
| 创建时间 | **2025-07-22T22:22:28Z** | API `created_at` |
| 是否 fork | **否**（`fork=false`，`parent=null`） | API |

**它不是任何项目的 fork，但它的 topics 里有别人的名字。** 仓库 topics 实测包含
`openclaw`、`clawdbot`、`moltbot`、`claude-code`、`codex`——
前三个是 OpenClaw 那条改名链上的名字（见本系列 `ref-openclaw`）。
这些 topic 不代表血缘，代表**迁入目标**：仓库里有 `hermes claw migrate` 子命令
（`hermes_cli/claw.py`，809 行）专门把 OpenClaw 的配置搬过来，
`_OPENCLAW_DIR_NAMES = (".openclaw", ".clawdbot", ".moltbot")`（`claw.py:56`）
三个历史目录名全认，`hermes setup` 向导还会自动探测 `~/.openclaw` 并主动提议迁移。

代码层面的借鉴是**点状且被注明的**，不是整体照搬。全仓检索只有一处：
`agent/conversation_loop.py:7015` 的注释「Inspired by clawdbot's "incomplete-text" recovery」。
与 Codex 的关系同样是点状引用——`tools/approval.py` 里有一条 `rm` 规则注明
「Port of openai/codex#33464」。

**一句话辨析**：Hermes Agent 是 Nous Research 从零起的独立项目，
把 OpenClaw / Claude Code / Codex 当作**迁移来源与灵感来源**，而不是代码来源。

---

## 2. 增长曲线：从 3 个人到 2,524 个作者身份

**这个仓库的历史分两段，中间的拐点在 2026 年 2 月，陡到不可能是自然增长。**

初始提交 `21d80ca6`（2025-07-22 18:32 -0700，作者 Teknium）只有 **8 个文件、865 行**，
其中还包括两个误提交的 `__pycache__/*.pyc`。文件清单是
`run_agent.py`（324 行）、`model_tools.py`（272 行）、`web_tools.py`（265 行）、
一个 **0 字节的 `terminal_tool.py`**、`requirements.txt`（2 行）。
**今天的 `run_agent.py` 是 8,242 行，而它已经不再是主循环了**（§3）。

**按月提交数（`git log --date=format:'%Y-%m'` 计数）：**

| 月份 | 提交数 | | 月份 | 提交数 |
| --- | --- | --- | --- | --- |
| 2025-07 | 9 | | 2026-03 | 2,522 |
| 2025-08 | 10 | | 2026-04 | **4,084** |
| 2025-09 | 7 | | 2026-05 | 3,326 |
| 2025-10 | 11 | | 2026-06 | 3,988 |
| 2025-11 | 23 | | 2026-07 | **5,675** |
| 2026-01 | 32 | | 2026-08（9 日为止） | 1,164 |
| 2026-02 | 480 | | | |

（2025-12 一条提交都没有。）

**拐点的量级**：2026-01 是 32 个提交，2026-02 是 480 个——**一个月涨了 15 倍**。
作者数的变化更极端：**截至 2026-02-01 全仓只有 4 个作者身份、91 个提交**，
而且那 4 个里 `teknium` 和 `Teknium` 是同一个人的两种拼写
（另两个是 `Dakota`、`hjc-puro`）——**真实人数是 3 个**。

**作者总数取决于你怎么数，三个口径都列在这里**（这类数字最容易被引用时张冠李戴）：

| 口径 | 值 |
| --- | --- |
| `git shortlog -sn HEAD`（应用 `.mailmap` 归并后） | **2,524** |
| `git log --format=%an \| sort -u`（原始作者名字符串） | 2,530 |
| `git log --format=%aE \| sort -u`（原始作者邮箱） | 2,601 |
| GitHub contributors API 可见 | **393**（该端点上限 500，故偏低而非偏高） |

后三个数都不是「人数」：前两个数的是字符串，API 数的是关联到 GitHub 账号的贡献者。
**本文之后凡说「作者数」一律指 2,524 这个归并后的口径。**

**提交量最大的几位**（`git shortlog -sn`，注意同一人仍可能有多个身份）：
`Teknium` 6,408 + `teknium1` 1,277、`Brooklyn Nicholson` 1,975 + `brooklyn!` 816、
`kshitijk4poor` 863 + `kshitij` 577。仓库根有 `.mailmap`（5,743 字节）在做身份合并，
说明这个问题他们自己也在治理——**但从上面这几组仍未合并的重名看，治理得并不彻底**。

**这条曲线要怎么读**：一个从 2025-07 就存在、但前 7 个月只有 3 个人和 91 个提交的项目，
在 2026-02 之后变成月均数千提交、2,500+ 作者身份的仓库。
**规模是真的，但「2,530 个贡献者」不等于 2,530 个人在做核心设计**——
从 open PR 19,823 条（§18）看，大量贡献停在 PR 阶段。

---

## 3. 仓库结构与巨型模块

**这个仓库的形状是「Python 核心 + TypeScript 前端」，比例大约 4:1。**
GitHub `/languages` 端点返回总计 80,015,383 字节：

| 语言 | 字节 | 占比 |
| --- | --- | --- |
| **Python** | 61,573,869 | **76.95%** |
| **TypeScript** | 16,098,226 | **20.12%** |
| JavaScript | 540,502 | 0.68% |
| TeX | 434,546 | 0.54% |
| Shell | 362,349 | 0.45% |
| PowerShell | 237,657 | 0.30% |
| Rust | 169,972 | 0.21% |
| Nix | 121,176 | 0.15% |

按 tracked 文件数与行数交叉核对：**`.py` 3,951 个文件 / 1,532,618 行**，
**`.ts` + `.tsx` 2,020 个文件 / 453,574 行**，全仓 tracked 文件 **8,609 个**。
Rust 那 0.21% 来自 `apps/bootstrap-installer/src-tauri`（Tauri 安装器），
不是 agent 核心；PowerShell 那 0.30% 是原生 Windows 支持（§19）。

**顶层目录职责**（tracked 文件数）：

| 目录 | 文件数 | 职责 |
| --- | --- | --- |
| `apps/` | 1,574 | Electron 桌面应用 + Tauri bootstrap 安装器 + 共享包 |
| `optional-skills/` | 535 | 不默认装的技能库（§10） |
| `skills/` | 467 | 随仓库分发的内置技能（§10） |
| `ui-tui/` | 450 | TypeScript TUI（含自家 ink fork，§17） |
| `plugins/` | 339 | 插件（含 34 个模型 provider、8 个记忆后端，§8/§11） |
| `hermes_cli/` | 269 | CLI 全部子命令与配置（§13） |
| `agent/` | 187 | agent 核心（上下文、压缩、学习闭环、LSP，§5/§9） |
| `tools/` | 139 | 工具实现与执行环境（§4/§6） |
| `web/` | 169 | 浏览器 dashboard（Vite + React） |
| `gateway/` | 91 | 消息网关与平台适配（§7） |
| `cron/` | 13 | 定时任务引擎（§12） |
| `tui_gateway/` | 23 | TUI 与后端之间的 WS 协议层 |
| `acp_adapter/` | 11 | ACP（Agent Client Protocol）适配器 |
| `providers/` | 3 | provider 抽象基类（实现在 `plugins/model-providers/`） |

**十个最大的 Python 模块（按行数）——这是本文最该先给你的一张表**，
因为它决定了你按目录找代码时会撞上什么：

| 行数 | 文件 |
| --- | --- |
| **27,814** | `gateway/run.py` |
| **18,611** | `cli.py` |
| **17,951** | `hermes_cli/web_server.py` |
| **12,657** | `hermes_cli/main.py` |
| **10,399** | `hermes_state.py` |
| 8,242 | `run_agent.py` |
| 7,637 | `agent/conversation_loop.py` |
| 7,588 | `tools/mcp_tool.py` |
| 7,202 | `agent/context_compressor.py` |
| 5,706 | `gateway/slash_commands.py` |

**`gateway/run.py` 单文件 27,814 行**——这是本文见过的所有 coding agent 仓库里最大的单个源文件。
`cli.py` 按字节算是 865,421 字节。**这两个数字本身就是一条工程事实**：
一个 2,500 作者、月均数千提交的仓库，其核心汇聚点没有被拆开。

**已经拆过一部分，但没拆到底。** `agent/conversation_loop.py` 的文件头注释说得很清楚：

> This is the biggest single chunk pulled out of `run_agent.py`: the
> roughly 3,900-line `run_conversation` body that drives one user turn…
> `_ra().AIAgent.run_conversation` is now a thin forwarder.

所以真实的主循环在 `agent/conversation_loop.py`，
`run_agent.py` 里的 `AIAgent.run_conversation` 只是个转发器——
**照着初始提交的印象去 `run_agent.py` 找主循环会找错地方**（§5）。
拆分同时保留了向后兼容的黑魔法：`_ra()` 间接层专门让
「在 `run_agent` 上打 patch」的既有测试继续生效。

---

## 4. 工具系统：83 个内置工具 / 59 个 toolset / 56 个 core

**「Hermes 有多少工具」这个问题有三个都对但量的不是同一件事的答案**，
先把口径分清，否则很容易引用错：

| 口径 | 值 | 含义 |
| --- | --- | --- |
| `tools/` 下静态注册的工具 | **83** | 代码里存在的全部内置工具 |
| `_HERMES_CORE_TOOLS` | **56** | 默认会进模型 schema 的那一批 |
| `TOOLSETS` 顶层键 | **59** | 工具的分组单位（含 25 个平台预设） |
| `_HERMES_WEBHOOK_SAFE_TOOLS` | **4** | webhook 场景的最小集 |

**83 这个数的判据**是对 `tools/` 递归做 AST 遍历，
数 `registry.register(...)` 里 `name=` 为字面量的调用（不是正则数括号）：

```python
import ast, pathlib
for p in pathlib.Path('tools').rglob('*.py'):
    tree = ast.parse(p.read_text(encoding='utf-8', errors='replace'))
    for n in ast.walk(tree):
        if (isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
                and n.func.attr == 'register'):
            # 取 keywords 里的 name= 字面量
            ...
# → 83 个唯一名字，0 个重名
```

**同一次遍历还发现三件值得单独说的事**：

1. **另有 3 处 `name` 非字面量的动态注册，全在 `tools/mcp_tool.py`（:6303、:6454、:6487）**——
   那是 MCP 工具在运行时注入注册表的入口（§15）。
   所以「83」是内置工具数，**接了 MCP 之后模型看到的工具会更多**，且数量取决于你的配置。
2. **`plugins/` 目录下 `registry.register` 调用数为 0。** 随仓库分发的 18 个插件
   一个都没有注册模型工具——它们走的是平台适配、记忆后端、模型 provider
   这些**不占模型 schema** 的扩展点。这与 `AGENTS.md` 的「footprint ladder」是一致的（见下）。
3. **`tests/` 里有 4 处注册**，其中 `test_plugins.py:856` 的 `gated_override_target`
   是唯一的重名（测的正是「插件覆盖内置工具要显式授权」这条规则）。

**按 toolset 分布（83 个的归属）：**

| toolset | 数量 | 工具 |
| --- | --- | --- |
| `kanban` | **12** | `kanban_show` / `list` / `create` / `complete` / `block` / `unblock` / `comment` / `link` / `heartbeat` / `attach` / `attach_url` / `attachments` |
| `browser` | **10** | `browser_navigate` / `snapshot` / `click` / `type` / `scroll` / `back` / `press` / `get_images` / `vision` / `console` |
| `desktop_ui` | 7 | `read_terminal` / `close_terminal` / `focus_pane` / `open_preview` / `read_preview` / `read_window_below` / `react_to_message` |
| `file` | 4 | `read_file` / `write_file` / `patch` / `search_files` |
| `homeassistant` | 4 | `ha_list_entities` / `ha_get_state` / `ha_list_services` / `ha_call_service` |
| `feishu_drive` | 4 | 4 个飞书云文档评论工具 |
| `skills` | 3 | `skills_list` / `skill_view` / `skill_manage` |
| `project` | 3 | `project_create` / `project_list` / `project_switch` |
| `video_gen` | 3 | `video_generate` / `xai_video_edit` / `xai_video_extend` |
| `terminal` | 2 | `terminal` / `process` |
| `web` | 2 | `web_search` / `web_extract` |
| `browser-cdp` | 2 | `browser_cdp` / `browser_dialog` |
| 其余 14 个 toolset | 各 1 | `memory`、`todo`、`clarify`、`delegate_task`、`execute_code`、`cronjob`、`session_search`、`computer_use`、`vision_analyze`、`video_analyze`、`image_generate`、`text_to_speech`、`x_search`、`discord`、`discord_admin`、`feishu_doc_read` |
| `<toolset 为动态值>` | 11 | `bfl_flux3_*` 6 个 + `yb_*`（元宝）5 个 |

**`TOOLSETS` 那 59 个键里有 25 个是 `hermes-` 前缀的平台预设**——
`hermes-cli`、`hermes-telegram`、`hermes-discord`、`hermes-whatsapp`、`hermes-slack`、
`hermes-signal`、`hermes-feishu`、`hermes-weixin`、`hermes-qqbot`、`hermes-wecom`、
`hermes-dingtalk`、`hermes-email`、`hermes-sms`、`hermes-matrix`、`hermes-mattermost`、
`hermes-bluebubbles`、`hermes-yuanbao`、`hermes-webhook`、`hermes-cron`、`hermes-gateway`、
`hermes-acp`、`hermes-api-server`、`hermes-homeassistant`、`hermes-wecom-callback` 等。
**它们不是工具分组，是「某个前端默认开哪些工具」的配方**——
这正是 §1 那句「same agent core across N surfaces」在工具层的落点。

**「为什么 core 只有 56 个」这件事仓库写下了明确理由。** `AGENTS.md:7` 把它列为
两条支配一切设计决策的属性之一：

> **The core is a narrow waist; capability lives at the edges.** Every model
> tool we add is sent on every API call, so the bar for a new *core* tool is
> high.

配套的 **Footprint Ladder**（`AGENTS.md:182`）给出六级阶梯，
要求新能力选**占用永久 schema 最少**的那一级：

| 级 | 手段 | 模型 schema 开销 |
| --- | --- | --- |
| 1 | 扩展已有代码 | 零 |
| 2 | **CLI 命令 + 技能**（`hermes cron`、`hermes webhook` 这类） | **零** |
| 3 | **服务门控工具**（`check_fn`，前置条件未配就不出现） | 未配时为零 |
| 4 | 插件（`~/.hermes/plugins/` 或 pip 包） | 零（不入 core） |
| 5 | **MCP server（进 catalog）** | 零永久 core schema |
| 6 | 新 core 工具 | **每次 API 调用都付** |

它还写了一条针对本仓库现状的合流规则：
「当 3 个以上 open PR 想接同一*类*东西（记忆后端、provider、通知器）时，
不要一个个 merge——设计一个 ABC + 编排器，把内置实现包成第一个 provider，
再把竞争的 PR 变成针对该接口的插件。」
**`plugins/memory/` 下那 8 个记忆后端（§11）与 `plugins/model-providers/` 下那 34 个
provider（§8）就是这条规则的产物**，而 `plugins/` 注册工具数为 0 是它的可核验结果。

**工具注册表本身的三个工程细节**（`tools/registry.py`，1,001 行）：

- **`check_fn` 结果进程级 TTL 缓存**（`_CHECK_FN_TTL_SECONDS = 30.0`，
  失败宽限 60 秒，缓存上限 512）。注释特意点明：因此
  **`check_fn` 里不能放「按会话才有答案」的判断**——一个进程服务多个会话。
- **插件覆盖内置工具要显式授权**。`register(override=True)` 时会查
  `_plugin_override_policy`；未在 `config.yaml` 里给该插件设
  `allow_tool_override: true` 就直接 `raise PermissionError`，并按 ERROR 级记日志。
- **注册表带 `_generation` 单调计数器 + `RLock`**，因为 MCP 动态刷新会在
  其他线程读取工具元数据时改注册表，读者靠 generation 做 memo 失效。

---

## 5. Agent 核心：AIAgent 与同步主循环

**核心类是 `run_agent.py` 里的 `AIAgent`，但主循环的实现已经搬到
`agent/conversation_loop.py`（7,637 行）。** 这一节先给你定位，再给行为。

**`AIAgent.__init__` 的参数量本身是一条事实**：`AGENTS.md:353` 直说
「The real `AIAgent.__init__` takes ~60 parameters」，并且在文档里只列了
一个「你通常会碰到的最小子集」，让读者去读源码拿全表。
关键的几个默认值：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `max_iterations` | **500** | 单轮对话内的工具调用迭代上限（与子代理共享该语义） |
| `api_mode` | — | `"chat_completions"` / `"codex_responses"` 等，决定走哪套协议 |
| `model` | `""` | 留空则稍后从 config / provider 解析 |
| `platform` | `None` | `"cli"`、`"telegram"` …… 决定平台 toolset 预设（§4） |

**两个入口的分工**：`chat(message) -> str` 是简易接口只回最终字符串；
`run_conversation(...) -> dict` 是全量接口，返回 `final_response` + `messages`。

**主循环是完全同步的**，`AGENTS.md:389` 给出的骨架（文档自述，非本文反编译）：

```python
while (api_call_count < self.max_iterations and self.iteration_budget.remaining > 0) \
        or self._budget_grace_call:
    if self._interrupt_requested: break
    response = client.chat.completions.create(model=model, messages=messages, tools=tool_schemas)
    if response.tool_calls:
        for tool_call in response.tool_calls:
            result = handle_function_call(tool_call.name, tool_call.args, task_id)
            messages.append(tool_result_message(result))
        api_call_count += 1
    else:
        return response.content
```

**三个值得单独记住的细节：**

1. **「one-turn grace call」**：`or self._budget_grace_call` 这一项让预算耗尽后
   还能再发一次请求——用途是让模型有机会把话说完/收尾，而不是硬截断在工具调用中间。
2. **迭代预算是独立对象**，不是一个裸计数器。`agent/iteration_budget.py`（62 行）
   是个带锁的 consume/refund 计数器，注释写明：
   父 agent 的上限来自 `max_iterations`（默认 500），
   **每个子代理的上限来自 `delegation.max_iterations`（默认 50）**——
   父子预算是分开的（§9）。
3. **消息格式是 OpenAI 风格**（`system`/`user`/`assistant`/`tool`），
   **推理内容存在 `assistant_msg["reasoning"]`**，是消息对象上的自定义字段。

**「prompt cache 神圣」是这个仓库的第一原则，而且能在代码里核验到。**
`AGENTS.md:7` 把它列为两条支配性属性之首：

> **Per-conversation prompt caching is sacred.** A long-lived conversation
> reuses a cached prefix every turn. Anything that mutates past context,
> swaps toolsets, or rebuilds the system prompt mid-conversation invalidates
> that cache and multiplies the user's cost. We do not do it (the one
> exception is context compression).

这条原则在多处留下了可核验的痕迹（这些是代码注释，属**设计意图的一手证据**，
但「实际命中率」本文没有实测）：

| 位置 | 为保 cache 做的让步 |
| --- | --- |
| `tools/memory_tool.py:13` | `MEMORY.md`/`USER.md` 在系统提示词里是**会话开始时的冻结快照**；中途写入立即落盘但**不改提示词**，下次会话才刷新 |
| `tools/memory_tool.py:154` | 「Never mutated mid-session. Keeps prefix cache stable.」 |
| `agent/skill_commands.py:492` | 重载技能**不**让技能提示词缓存失效 |
| `agent/coding_context.py:825` | 输出必须**逐字节稳定**才能保住 cache |
| `agent/background_review.py:7` | 后台复盘 fork「never touches」主对话与 prompt cache |
| `agent/curator.py:19` | curator 走 auxiliary client，永不碰主会话 prompt cache |
| `agent/message_sanitization.py:519` | 不合并两类内容，因为合并会改 id 从而废掉 cache |

**代价是「功能上更方便」的做法被主动放弃了**——
比如「写完 memory 立刻在本轮生效」这件事，它选择了不做。
`prompt_caching.cache_ttl` 默认 `"5m"`，配置注释建议长会话改 `"1h"`。

**上下文压缩是唯一被允许打破缓存的操作**，实现在
`agent/context_compressor.py`（7,202 行）+ `agent/conversation_compression.py`（4,035 行）。
压缩机制的要点（取自文件头注释与 `cli-config.yaml.example:407` 的配置说明）：

- **按 API 返回的真实 token 数触发**，不用估算值：
  `prompt_tokens >= threshold% × model context_length` 时压缩；
- **保护头部 3 轮**（系统提示词、初始请求、首个回复）与**尾部 N 条**
  （默认 20 条消息 ≈ 最近 10 个完整回合），尾部用 **token 预算**而不是固定条数；
- 压缩前先做一遍**廉价的工具输出剪枝**（不调 LLM），再把中段交给 auxiliary 模型总结；
- 摘要模板带 **Resolved / Pending 问题追踪**，且历史段落的标题刻意改成
  「仅供参考」的措辞，**避免被后续轮次读成仍待执行的指令**；
- 压缩会**切分 SQLite 会话并轮转 `session_id`**，靠 `parent_session_id` 串成链（§16）；
- 启动时有一道 `check_compression_model_feasibility` 探针：
  auxiliary 模型上下文装不下主模型的压缩阈值时会告警、
  可能时自动下调本会话阈值，低于 `MINIMUM_CONTEXT_LENGTH` 则**硬拒绝**。

**上下文引擎是可插拔的。** `agent/context_engine.py`（489 行）是 ABC，
由 `context.engine` 配置项选择，默认 `"compressor"`，
第三方引擎（注释举例 LCM）可以放到 `plugins/context_engine/<name>/`，
并且**允许自带工具**（注释举例 `lcm_grep`）。同一时刻只有一个引擎生效。

**工具循环护栏**（`cli-config.yaml.example:395`）是一组独立于预算的止损规则，
默认只告警不硬停：

| 触发条件 | 告警阈值 | 硬停阈值 | 硬停默认 |
| --- | --- | --- | --- |
| 完全相同的失败重复 | 2 | 5 | `hard_stop_enabled: false` |
| 同一工具反复失败 | 3 | 8 | 同上 |
| 幂等且无进展 | 2 | 5 | 同上 |

---

## 6. 终端后端：7 个，README 与代码一致

**这是本文核对下来 README 与代码完全吻合的一处**（值得单独说，因为 §17 有不吻合的）。
README 写「Seven terminal backends — local, Docker, SSH, Singularity, Modal, Daytona,
and Vercel Sandbox」，代码里 `tools/terminal_tool.py` 的 `_create_environment()`
恰好有 **7 个 `env_type ==` 分支**，名字逐一对应：

```python
import re
t = open('tools/terminal_tool.py').read()
i = t.find('def _create_environment')
re.findall(r'env_type == "([a-z_]+)"', t[i:i+9000])
# → ['local', 'docker', 'singularity', 'modal', 'daytona', 'vercel_sandbox', 'ssh']
```

`tools/environments/` 下的实现类也一一对应：

| 后端 | 实现 | 特点 |
| --- | --- | --- |
| `local` | `local.py` `LocalEnvironment` | **默认**，直接在宿主机执行 |
| `docker` | `docker.py` `DockerEnvironment` | 带**孤儿容器回收器**（见下） |
| `ssh` | `ssh.py` `SSHEnvironment` | 远程主机 |
| `singularity` | `singularity.py` `SingularityEnvironment` | HPC / 集群场景 |
| `modal` | `modal.py` + `managed_modal.py` | **两种模式**：direct 与 Nous 托管 |
| `daytona` | `daytona.py` `DaytonaEnvironment` | 无服务器持久化 |
| `vercel_sandbox` | `vercel_sandbox.py` `VercelSandboxEnvironment` | 无服务器沙箱 |

选择方式是 `TERMINAL_ENV` 环境变量（默认 `"local"`，`terminal_tool.py:793`），
也可由 `config.yaml` 的 `terminal` 段决定；
Modal 的 direct / 托管二选一走 `terminal.modal_mode`。

**「无服务器持久化」是 README 主打的差异点**：
Daytona 与 Modal 支持环境在空闲时休眠、按需唤醒，
README 的说法是「costing nearly nothing between sessions」。
**这是厂商声明，本文未实测**（§20）。

**统一接口 + 一个重要含义**：所有后端实现同一个 `BaseEnvironment` ABC
（`tools/environments/base.py`，581 行处定义）。
`SECURITY.md` 点明了一个容易被忽略的后果：
**`read_file` / `write_file` / `patch` 三个文件工具也走这个后端**，
因为它们是构建在 shell 契约之上的——所以换成容器后端时，
文件工具**也**到不了后端没暴露的路径。
反过来说，**不走 shell 的代码路径不受它约束**（§10 的安全边界）。

**一个从事故里长出来的细节**：Docker 后端有 `_maybe_reap_docker_orphans`，
一次性清理前一个 Hermes 进程在 SIGKILL / OOM / 终端被关时留下的带标签容器
（`atexit` 钩子来不及跑的情况）。它被限制为**每进程只跑一次**，
理由写在注释里：否则并行子代理 / RL 基准会把回收器跑 N 遍。
可用 `terminal.docker_orphan_reaper: false` 关掉（注释引 issue #20561）。

---

## 7. Gateway 与 24 个渠道平台

**gateway 是一个单进程控制面，把 agent 核心接到所有聊天渠道上。**
实现集中在 `gateway/run.py`——**27,814 行，全仓最大的单个文件**（§3）。

**渠道数的单一事实源是 `gateway/config.py:272` 的 `Platform` 枚举，实测 24 个成员：**

```python
import ast
tree = ast.parse(open('gateway/config.py').read())
# 取 class Platform(Enum) 下的 Assign 节点 → 24 个
```

| 分类 | 成员（枚举值） |
| --- | --- |
| **本地 / 内部**（4） | `local`（= CLI）、`relay`、`api_server`、`webhook` |
| **国际主流 IM**（8） | `telegram`、`discord`、`slack`、`signal`、`matrix`、`mattermost`、`whatsapp`、`whatsapp_cloud` |
| **中国生态**（7） | `feishu`、`wecom`、`wecom_callback`、`weixin`、`dingtalk`、`qqbot`、`yuanbao` |
| **其他通道**（5） | `email`、`sms`、`homeassistant`、`bluebubbles`（iMessage）、`msgraph_webhook` |

**注意 `AGENTS.md` 说的是「Telegram, Discord, Slack, and ~20 other platforms」**——
按 24 个总数算，「~20 other」略微高估（应是 21 个 other，
但其中 4 个是本地/内部通道，真正的「其他聊天平台」是 17 个）。
**这个差异小到属于文档口语化，不算错**，但如果你要引用一个精确数字，
用 24（枚举成员）或 17（真正的第三方聊天平台）。

**`whatsapp` 与 `whatsapp_cloud` 是两个独立成员**，
`wecom` 与 `wecom_callback` 也是——所以按「产品」数会比按枚举数少。
这是计数口径最容易出分歧的地方。

**适配器有两条注册路径，这是插件化留的口子**：

1. **内置适配器**走 `gateway/run.py:13951` 的 `_create_adapter()` 里的 if/elif 链
   （`platform == Platform.X` 逐个判断）。
2. **插件适配器**走 `gateway/platform_registry.py`（381 行）的
   `platform_registry.register(PlatformEntry(...))`，
   **查找时插件优先**，找不到才落回内置的 if/elif。
   文件头的示例用 IRC 举例，说明第三方接一个新渠道不需要改 `run.py`。

**`PlatformEntry` 里有一个从线上故障学来的字段拆分，值得单独记**：
`check_fn` 与 `ensure_deps_fn` 是**两个**字段而不是一个。注释写明了原因（引 issue #79812）：

> when the ACTIVE installer was registered as `check_fn`, every status display
> pip-installed SDKs as a side effect (desktop boot-loop at 94%…)

所以现在的契约是：
`check_fn` **必须无副作用**（会被 `hermes setup` / `hermes status` / dashboard
就绪探针反复调用），装依赖的逻辑必须放 `ensure_deps_fn`，
只在 gateway 真要把该平台拉起来时才调。

**gateway 目录里那批文件名本身就是一张「分布式消息系统会遇到什么」的清单**：
`turn_lease.py`（回合租约）、`delivery_ledger.py`（投递账本）、
`session_stall.py`（会话卡死）、`restart_loop_guard.py`（重启循环守卫）、
`drain_control.py`（排空控制）、`scale_to_zero.py`（缩容到零）、
`shutdown_watchdog.py` / `shutdown_forensics.py` / `shutdown_flush.py`（三个关停相关）、
`dead_targets.py`（死目标）、`code_skew.py`（代码版本偏斜）、
`agent_cache_pressure.py`（缓存压力）、`memory_monitor.py`。
**这些不是抽象设计，是「多平台常驻进程」在生产里踩出来的坑的固化。**

**gateway 侧的斜杠命令另有一套实现**：`gateway/slash_commands.py`（5,706 行，
`GatewaySlashCommandsMixin`），与 CLI 侧共用 `hermes_cli/commands.py` 的注册表（§13）。

---

## 8. 模型与 Provider：38 个规范条目 + 34 个插件目录

**「支持多少 provider」也是个有多个口径的问题**，而且这里的两个数**不是同一件事**：

| 口径 | 值 | 含义 |
| --- | --- | --- |
| `CANONICAL_PROVIDERS` 静态条目 | **38** | provider **身份**的单一事实源 |
| `plugins/model-providers/` 目录 | **34** | provider **实现**（另有 1 个 `README.md`） |
| `_build_provider_choices()` 的兜底静态表 | 31 | 仅当上面那个 import 失败时才用 |

**先说清主次**：`hermes_cli/models.py:1116` 的 `CANONICAL_PROVIDERS`
（`list[ProviderEntry]`，每项 `slug` / `label` / `tui_desc`）
是文件注释自称的「single source of truth for provider identity」，
`hermes model`、`/model`、`list_authenticated_providers` 全部从它派生。
`hermes_cli/main.py:10624` 的 `_build_provider_choices()` **优先**从它构造 `--provider` 选项，
只在 `import` 抛异常时才落回那张 31 项的静态表——
**所以引用「支持 N 个 provider」时不要引那张兜底表**。

**而且 38 不是终值**：`models.py:1157` 之后有一段自动扩展逻辑，
把 `providers/` 目录里注册的 provider 追加进 `CANONICAL_PROVIDERS`
（按 slug 去重）。`providers/` 只有抽象层——`base.py`（238 行）定义
`ProviderProfile`，其 `auth_type` 字段的取值是
`api_key | oauth_device_code | oauth_external | copilot | aws_sdk`，
**五种认证形态**，这解释了为什么 provider 不能只用一个 API key 抽象打平。

**38 个规范 provider 里的几类**（slug / label，节选）：

| 类别 | 条目 |
| --- | --- |
| 自家 | `nous`（Nous Portal，描述称 300+ 模型且捆绑工具调用） |
| 聚合 | `openrouter`、`moa`（Mixture of Agents，命名预设）、`kilocode`、`opencode-zen` |
| 订阅态 OAuth | `openai-codex`（走 ChatGPT 订阅或 API key）、`xai-oauth`（SuperGrok / Premium+）、`copilot` / `copilot-acp`、`qwen-oauth`、`minimax-oauth` |
| 第一方 API | `anthropic`、`openai-api`、`gemini`、`vertex`、`xai`、`deepseek`、`fireworks`、`novita`、`nvidia`、`huggingface` |
| 中国生态 | `alibaba`（Qwen Cloud/DashScope）、`zai`（Z.AI/GLM）、`kimi-coding` / `kimi-coding-cn`、`minimax` / `minimax-cn`、`stepfun`、`xiaomi`（MiMo）、`tencent-tokenhub` |
| 云平台 | `bedrock`、`azure-foundry`、`ollama-cloud` |
| 本地 | `lmstudio`（本地桌面应用自带模型服务） |

**`moa`（Mixture of Agents）是个不太常见的存在**：它作为一个 provider 出现在列表里，
但语义是「命名预设，聚合器在参考模型之后行动」——
配套有 `hermes moa list/configure/delete` 子命令和 `/moa` 斜杠命令（§13）。

**`api_mode` 是与 provider 正交的第二个维度**（§5）：
`chat_completions` / `codex_responses` 等。仓库里能看到多套适配器：
`agent/anthropic_adapter.py`、`agent/codex_responses_adapter.py`、
`agent/gemini_native_adapter.py`、`agent/bedrock_adapter.py`、
`agent/azure_identity_adapter.py`、`agent/copilot_acp_client.py`。
**所以「换模型」在这个仓库里不等于「换 base_url」**，
不同 provider 可能走完全不同的请求/响应协议。

**辅助模型（auxiliary）是一条独立的模型链路**，默认与主模型不同。
`cli-config.yaml.example:583` 说明它用于：图像分析、浏览器截图分析、
网页摘要、TTS 音频标签插入、**上下文压缩**。
默认走 OpenRouter 或 Nous Portal 上的 Gemini Flash 并从凭据自动探测，
配置注释对改动给了少见的直白警告：
「Overriding these with providers other than OpenRouter or Nous Portal is
EXPERIMENTAL and may not work…Change at your own risk」。

---

## 9. 子代理与委派

**委派工具是单个 `delegate_task`（`tools/delegate_tool.py`，4,347 行）**，
`delegation` toolset 下只有它一个。它的契约在文件头写得比多数实现清楚：

> Spawns child AIAgent instances with isolated context, inherited toolsets,
> and their own terminal sessions. …
> The parent's context only sees the delegation call and the summary result,
> never the child's intermediate tool calls or reasoning.

**每个子代理拿到什么**（文件头自述）：

- 全新对话（**不继承父的历史**）；
- 自己的 `task_id`（因而是自己的终端会话与文件操作缓存）；
- 父的 toolsets，但**剥掉 child-only blocked 的工具**；
- 一个由委派目标 + 上下文拼出的聚焦系统提示词。

**这个设计的取舍很明确**：父上下文只看到「委派调用 + 摘要结果」，
中间过程全部不进父上下文——**省 token、保 cache（§5），代价是父无法审查子的推理过程**。

**默认限额（`cli-config.yaml.example:1316`）：**

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `delegation.max_iterations` | **50** | 每个子代理的工具调用轮次上限（父是 500） |
| `max_concurrent_children` | **3** | 每批并行子代理数，下限 1，**无上限** |
| `max_spawn_depth` | **1** | 委派树深度，范围 1–3，1 = 扁平 |
| `orchestrator_enabled` | `true` | `role="orchestrator"` 子代理的总开关 |
| `subagent_auto_approve` | `false` | 子代理撞到危险命令确认时的行为 |
| `inherit_mcp_toolsets` | `true` | 显式收窄子 toolset 时是否仍保留父的 MCP toolset |

配置注释里有两处值得单独摘出来：

1. **`max_concurrent_children` 没有上限，但有警告**：
   「WARNING: values above 10 multiply API cost linearly」。
2. **`subagent_auto_approve` 的两个取值都不理想，而且原因写明了**：
   子代理遇到危险命令确认时，要么自动拒绝（默认），要么自动同意一次；
   **不能阻塞等 stdin，因为父 TUI 持有 stdin，阻塞会死锁**。
   两种选择**都会打一条 `logger.warning` 审计行**，
   注释建议只在 cron / batch 流水线里才翻成 `true`。
   ——**这是一处诚实的取舍披露**：自动同意有风险，自动拒绝会让子代理任务失败，
   而技术上没有第三条路。

**深度 2 需要中间层显式是 orchestrator**（`role="orchestrator"`），
且顶层模型调用在后台跑、orchestrator 子代理会等自己的 worker 以便汇总——
这是文件头描述的编排语义。

**子代理还能换模型换 provider**：`delegation.model` / `delegation.provider`
留空则继承父，填了会自动解析完整凭据（base_url、api_key）。
注释列出支持的 provider 子集：`openrouter`、`nous`、`zai`、`kimi-coding`、`minimax`。

**另一条「零上下文成本」的并行手段是 `execute_code`**（`code_execution` toolset）。
README 的说法是「Write Python scripts that call tools via RPC, collapsing
multi-step pipelines into zero-context-cost turns」——
即让模型写一段 Python，脚本内部通过 RPC 调用工具，
**多步流水线的中间结果不进对话上下文**。本文未实测其实际开销。

---

## 10. 技能系统：76 个内置 + 114 个可选

**技能是这个项目的主要扩展面**（§4 的 footprint ladder 第 2 级），
分两批随仓库分发，**都是文件系统里的目录 + `SKILL.md`**：

| 目录 | 分类数 | `SKILL.md` 数 | 默认是否加载 |
| --- | --- | --- | --- |
| `skills/` | 14 | **76** | 是 |
| `optional-skills/` | 21 | **114** | 否，按需装 |

判据是 `find <dir> -name SKILL.md | wc -l`。合计 **190 个技能**。

**`skills/`（内置）按分类：**
`creative` 16、`productivity` 15、`software-development` 11、`github` 7、
`research` 5、`mlops` 5、`autonomous-ai-agents` 5、`apple` 4、`media` 3、
`email` 2、`social-media` 1、`smart-home` 1、`note-taking` 1。
（第 14 个目录 `index-cache/` 里没有 `SKILL.md`——它放的是
`anthropics_skills_skills_.json`、`openai_skills_skills_.json`、`lobehub_index.json`
三个**外部技能市场的索引缓存**。）

**`optional-skills/`（可选）按分类**——注意头部分布与内置完全不同：
`mlops` **31**、`creative` 14、`research` 12、`finance` 9、`productivity` 7、
`security` 6、`devops` 6、`autonomous-ai-agents` 5、
`software-development` 3、`payments` 3、`mcp` 3、`blockchain` 3、
`web-development` 2、`health` 2、`gaming` 2，
以及 6 个各 1 个的分类（`yuanbao`、`migration`、`email`、`dogfood`、
`data-science`、`communication`）。

**`mlops` 在可选库里占 31 个是最大的单一分类**，
并且 `optional-skills/mlops/training/unsloth/references/` 下有
`llms-full.md`（1,077,327 字节）与 `llms-txt.md`（813,089 字节）两个大文件——
**这是「知识库型技能」的形态**：精简的 `SKILL.md` 当索引，
大块参考资料放 `references/` 按需用 `skill_view` 载入（见下）。
考虑到 Nous Research 本身是做模型训练的，这个分布不意外。

**技能相关的模型工具只有 3 个**（`skills` toolset）：
`skills_list`、`skill_view`、`skill_manage`。
写操作全部收在 `skill_manage` 一个工具里（`tools/skill_manager_tool.py`，1,810 行），
6 个 action：`create`、`edit`（整体重写 `SKILL.md`）、`patch`（定点替换）、
`delete`、`write_file`（增/改支撑文件）、`remove_file`。
新建的技能落在 `~/.hermes/skills/`，而已有技能（内置 / hub 装的 / 用户建的）
可以就地改。

**「技能」与「记忆」的分工，文件头给了一句可引用的定义**：

> Skills are the agent's procedural memory: they capture *how to do a specific
> type of task* based on proven experience. General memory (MEMORY.md, USER.md) is
> broad and declarative. Skills are narrow and actionable.

**frontmatter 规范**（`AGENTS.md:909`）：标准字段 `name`、`description`、
`version`、`author`、`license`、`platforms`（OS 门控，如 `[macos]`、`[linux, macos]`），
以及 `metadata.hermes.{tags,category,related_skills,config}`。
其中 `metadata.hermes.config` 是**技能声明自己需要的 config.yaml 配置项**——
存到 `skills.config.<key>`，在 `hermes setup` 时提示填写，加载时注入。

**「HARDLINE」写作标准里有一条可以当场验证的，本文验证了。**
`AGENTS.md:921` 要求 `description` **≤ 60 字符、一句话、以句号结尾**，
理由是「长描述会撑大技能清单，并在载入很多技能时稀释模型注意力」，
文档还附了断言脚本。**照它的判据全量跑一遍：**

```python
import re, pathlib
for root in ('skills', 'optional-skills'):
    for p in pathlib.Path(root).rglob('SKILL.md'):
        m = re.search(r'^description:\s*(.*)$', p.read_text(errors='replace'), re.M)
        assert m and len(m.group(1).strip().strip('"\'')) <= 60
```

**结果：190 个技能全部通过，0 个违规**（`skills/` 76/76，`optional-skills/` 114/114）。
**在一个 2,500 作者、月均数千提交的仓库里，一条纯风格约定做到 100% 合规，
说明它是被 review 真正拦住的，不只是写在文档里。**
其余标准包括：SKILL.md 里提到的工具必须是原生 Hermes 工具或该技能显式依赖的 MCP server
（不能发明命令）、复杂技能目标 ~200 行、固定的章节顺序（含 `## Verification`）。

**与外部标准的兼容**：README 声明兼容 [agentskills.io](https://agentskills.io) 开放标准，
`tools/skills_tool.py` 里有对应引用。
`skills/index-cache/` 里那三个索引缓存（Anthropic / OpenAI / LobeHub）
说明它也在从外部技能市场取索引。**本文未实测安装外部技能的流程。**

---

## 11. 学习闭环：README 的头号主张，接线情况如何

**README 的第一句差异化主张是「the only agent with a built-in learning loop」**，
并列出五件事：从经验创建技能、使用中自我改进、自我提醒持久化知识、
搜索自己的历史对话、跨会话建立对用户的模型。
**这一节的目的不是评价这个主张，而是核验它在代码里接到了什么程度。**

**结论先给**：这条闭环**是真的接线了的**——不是空的脚手架。
四个组件都有实现、有调用点、有触发条件、有配置项。
下面逐个给判据；**但「产出的技能质量如何」本文测不了**（§20）。

### 11.1 四个组件与调用点

| 组件 | 实现 | 行数 | 生产调用点 |
| --- | --- | --- | --- |
| **每轮后台复盘** | `agent/background_review.py` | 1,081 | `agent/turn_finalizer.py:757` → `agent._spawn_background_review()`（`run_agent.py:1801`） |
| **技能策展（curator）** | `agent/curator.py` | 2,019 | `cli.py:15180`、`gateway/run.py:26889` → `maybe_run_curator()` |
| **历史会话搜索** | `tools/session_search_tool.py` | 1,161 | `session_search` 工具（FTS5，§16） |
| **跨会话用户建模** | `plugins/memory/honcho/` | — | 记忆 provider 插件（见 11.4） |

### 11.2 后台复盘：每轮之后 fork 一个自己

`agent/background_review.py` 的文件头把契约写得很完整：

> After every turn, `AIAgent.run_conversation` may call
> `spawn_background_review` to fire off a daemon thread that replays
> the conversation snapshot in a forked `AIAgent` and asks itself
> "should any skill/memory be saved or updated?". Writes go straight to
> the memory + skill stores. Main conversation and prompt cache are never
> touched.

**四条硬约束**（都能在代码里对上）：

1. **fork 继承父的运行时**（provider、model、base_url、凭据、缓存的系统提示词），
   目的是**打到同一个 prefix cache**、用同一套认证（§5）；
2. **工具白名单只有记忆与技能管理工具**，其余在运行时被拒；
3. **跑在 daemon 线程里，在响应已经送给用户之后**才启动——
   `turn_finalizer.py:750` 的注释：「so it never competes with the user's task
   for model attention」；
4. **best-effort**：`turn_finalizer.py` 里那个调用被 `try/except: pass` 包着，
   注释写明「Background review is best-effort」。

**触发条件是两个独立计数器，任一到点就触发**（`agent/turn_context.py:597`
与 `agent/turn_finalizer.py:733`）：

| 触发器 | 计数单位 | 代码默认 | 随仓库配置示例的值 | 配置键 |
| --- | --- | --- | --- | --- |
| 记忆复盘 | **用户回合数** | 10 | `10` | `memory.nudge_interval` |
| 技能复盘 | **本轮的工具迭代次数** | 10 | **`15`** | `skills.creation_nudge_interval` |

⚠ **这里有一处代码默认值与随仓库配置示例不一致**，引用时要注意区别：
`agent/agent_init.py:1788` 的硬编码默认是 `10`，
而 `cli-config.yaml.example:816` 写的是 `creation_nudge_interval: 15`。
逻辑是 `int(skills_config.get("creation_nudge_interval", 10))`——
**配置文件里有值就用配置的，硬编码 10 只在键缺失时生效**。
所以按仓库自带示例配置跑，技能复盘是每 15 次工具迭代一次，不是 10 次。
（记忆那条两边都是 10，无歧义。）

**还有两道抑制条件**（`turn_finalizer.py:755`）：
`final_response` 为空或本轮被中断时不触发；
`skip_background_review=True` 时不触发——
**cron 会话默认属于后者**，注释给了成本理由：

> review forks spawn another AIAgent (~30K tokens / event) and cron sessions
> have no human-in-the-loop benefit from the review.

**「~30K tokens / event」是仓库自己给的量级**，
这也是理解这套闭环代价的关键数字：**它不是免费的**，
按记忆每 10 个用户回合触发一次算，长会话里这是一笔持续开销。
（这是代码注释里的自述值，**本文未实测**。）

**记忆还有一条「临终写入」机制**：`memory.flush_min_turns`（默认 6）——
在上下文即将丢失前（压缩、`/new`、`/reset`、退出）给 agent 一轮机会保存记忆；
退出/重置场景下只在会话至少有这么多用户回合时才触发。

### 11.3 Curator：只归档，从不删除

`agent/curator.py`（2,019 行）是技能库的后台维护者，
**由「不活跃」触发而不是 cron**：agent 空闲且距上次 curator 运行超过
`interval_hours` 时，`maybe_run_curator()` fork 一个 AIAgent 去做审查。
状态存在 `.curator_state`（`last_run_at`、`paused` 等）。

**文件头列了四条「strict invariants」，其中两条值得记住：**

- **只碰 agent 自己创建的技能**（`tools/skill_usage.is_agent_created` 判定）——
  用户手写的和内置的它不动；
- **永不自动删除，只归档，且归档可恢复**（原文「Never auto-deletes — only
  archives. Archive is recoverable.」）；
- 被 pin 的技能绕过所有自动状态迁移；
- 用 auxiliary client，**永不碰主会话的 prompt cache**（§5）。

它能做的动作是：按派生的活跃度时间戳自动迁移生命周期状态，
以及 fork 一个后台审查 agent 通过 `skill_manage` 做
pin / archive / consolidate / patch。
配套有 `hermes curator` 子命令与 `/curator` 斜杠命令（§13）。

**「只归档不删除」是一个可核验的保守设计**——
在一个允许 agent 自主改自己技能库的系统里，这条不可逆性边界划得比较克制。

### 11.4 用户建模与外部记忆：8 个 provider

**内置记忆是文件式的两个库**（`tools/memory_tool.py`，1,248 行）：
`MEMORY.md`（agent 自己的观察：环境事实、项目约定、工具怪癖）与
`USER.md`（关于用户的：偏好、沟通风格、期望、工作习惯）。
条目分隔符是 `§`，**限额按字符数而不是 token 数计**——
注释给的理由是「char counts are model-independent」。
配置里 `user_char_limit: 1375` 并注明「~500 tokens」。
两个库在系统提示词里是**会话开始时的冻结快照**（§5）。

**外部记忆是插件化的，`plugins/memory/` 下有 8 个 provider**：
`honcho`、`mem0`、`supermemory`、`byterover`、`hindsight`、
`holographic`、`openviking`、`retaindb`。
README 单独点名的是 [Honcho](https://github.com/plastic-labs/honcho)
的「dialectic user modeling」，用来跨会话建立对用户的模型。
`plugins/memory/honcho/` 下有独立的 `cli.py` / `client.py` / `config_schema.py`。

**这 8 个 provider 正是 §4 那条合流规则的产物**：
与其逐个 merge「接某个记忆服务」的 PR，不如定义一个 provider 接口，
把内置实现包成第一个 provider，让竞争的 PR 变成插件。
`plugins/memory/query_rewrite.py` 是共享的查询重写层。

**「学习可视化」有专门的渲染**：`agent/learning_graph.py`（328 行）
把「非基础的、学到的/profile 技能」+「`MEMORY.md`/`USER.md` 的记忆块」
作为一等节点组图，技能间的边取自声明的 `related_skills`，
记忆到技能的边**靠词法重叠推导**（文件头自述）。
对应 `hermes learning` / `hermes memory-graph` 子命令与 `/journey` 斜杠命令。

---

## 12. 定时任务：进程内 ticker + 可缩容到零的托管模式

**cron 是这个项目里少见的「同一功能有两套调度后端」的子系统**，
而两套的存在理由是**成本**，不是冗余。

**默认路径是进程内 ticker**：`cron/scheduler.py`（5,094 行）提供 `tick()`，
由 gateway 的后台线程**每 60 秒**调一次。
并发安全靠文件锁 `~/.hermes/cron/.tick.lock`，保证多进程重叠时只有一个 tick 在跑。

**第二条路径是 Chronos 托管 cron**（`plugins/cron_providers/chronos/`），
它解决的问题在 `docs/chronos-managed-cron-contract.md` 里写得很清楚：

> Chronos lets a hosted Hermes gateway **scale to zero** while idle and still
> fire cron jobs. Instead of an in-process 60-second ticker, the agent asks NAS
> to arm exactly **one external one-shot per job at that job's real next-fire
> time**. …Between fires the agent process can be fully stopped — it wakes only
> on a genuine fire.

**取舍很直接**：进程内 ticker 要求进程常驻（每 60 秒醒一次），
托管模式把「下一次何时触发」外置给 NAS（Nous Account Service），
换来进程可以完全停掉。配合 `gateway/scale_to_zero.py` 一起看，
这是为「$5 VPS / serverless」这个部署场景做的（§1 README 主张）。

文档还刻意划了一条抽象边界：NAS 底层用什么外部调度器是**NAS 的实现细节**，
「The agent never talks to it, never holds its credentials, and never names it」。
调度后端本身也是插件化的（`cron/scheduler_provider.py`，367 行）。

**用户不需要写 cron 表达式——这是刻意的设计。**
`cron/blueprint_catalog.py`（760 行）的注释写明：

> Design choice: users never type raw cron. A blueprint carries a fixed
> recurrence in `schedule_template` and parameterizes only the human-friendly
> parts (time-of-day, weekday set).

**内置 blueprint 实测 15 个**（`CATALOG: List[AutomationBlueprint]`，AST 计数）：

| 分类 | 数量 | blueprint key |
| --- | --- | --- |
| `daily` | 5 | `morning-brief`、`workday-start`、`evening-winddown`、`learn-daily`、`on-this-day` |
| `general` | 7 | `custom-reminder`、`news-digest`、`bill-renewal-watch`、`price-watch`、`habit-checkin`、`hydration-move`、`gratitude-journal` |
| `weekly` | 2 | `weekly-review`、`meal-plan` |
| `email` | 1 | `important-mail` |

**一个 blueprint 定义会被四个界面各自渲染成原生形态**（文件头自述）：
dashboard/GUI 渲染成表单（每个 slot 一个字段）、
CLI/TUI/messenger 渲染成预填好的 `/blueprint` 斜杠命令、
agent 拿它当种子提示词（缺的 slot 它会问）、
文档目录渲染成可复制命令 + `hermes://` 深链。
**单一事实源是 slot schema**，`blueprint_form_schema` / `blueprint_slash_command` /
`fill_blueprint` 三个函数从同一份 schema 派生，
且 `fill_blueprint` 最终产出的是 `cron.jobs.create_job` 的 kwargs——
注释特意说明「so there is no second job engine」。

**这套「有屏幕就给表单、有聊天就让 agent 问」的分流**，
是 §1 那句「same core across N surfaces」在功能层最完整的一个例子。

其余组件：`cron/jobs.py`（3,252 行，任务 CRUD）、
`cron/executions.py`（执行记录）、`cron/monitor.py`、
`cron/lifecycle_guard.py`（714 行）、
`cron/suggestions.py` + `suggestion_catalog.py`（**4 个**建议条目）、
`cron/notepad.py`。模型侧只有一个 `cronjob` 工具（§4）。

---

## 13. 命令面：95 条斜杠命令 / 71 个 CLI 子命令

**命令有两套并存的体系，注册表是分开的**——查的时候别混：

| 体系 | 数量 | 单一事实源 |
| --- | --- | --- |
| **斜杠命令**（会话内） | **95** | `hermes_cli/commands.py:102` `COMMAND_REGISTRY` |
| **CLI 子命令**（shell 里） | **71** | `hermes_cli/main.py:10620` `_BUILTIN_SUBCOMMANDS` |

### 13.1 95 条斜杠命令

判据是对 `COMMAND_REGISTRY`（`list[CommandDef]`）做 AST 计数。**按 category 分布：**

| category | 数量 |
| --- | --- |
| Session | **37** |
| Configuration | 21 |
| Tools & Skills | 19 |
| Info | 17 |
| Exit | 1 |

**全部 95 条**（按注册顺序）：
`/start` `/new` `/topic` `/clear` `/redraw` `/history` `/save` `/retry` `/prompt`
`/undo` `/title` `/handoff` `/branch` `/compress` `/rollback` `/snapshot` `/export`
`/import` `/stop` `/pause` `/approve` `/deny` `/background` `/agents` `/journey`
`/queue` `/steer` `/goal` `/heartbeat` `/refine` `/moa` `/subgoal` `/status`
`/egress` `/context` `/whoami` `/profile` `/sethome` `/resume` `/sessions` `/config`
`/model` `/codex-runtime` `/personality` `/statusbar` `/battery` `/timestamps`
`/diff` `/verbose` `/focus` `/footer` `/yolo` `/approvals` `/reasoning` `/fast`
`/skin` `/indicator` `/voice` `/wake` `/busy` `/tools` `/toolsets` `/skills`
`/memory` `/bundles` `/pet` `/hatch` `/learn` `/init` `/cron` `/suggestions`
`/blueprint` `/curator` `/kanban` `/reload` `/reload-mcp` `/reload-skills`
`/browser` `/plugins` `/commands` `/help` `/restart` `/usage` `/subscription`
`/topup` `/insights` `/platforms` `/platform` `/copy` `/paste` `/image` `/update`
`/version` `/debug` `/quit`

**`CommandDef` 里有个不常见但很实用的字段：`busy_policy`。**
它决定「agent 正忙时收到这条命令怎么办」，驱动 `gateway/run.py` 里的
`_dispatch_busy_slash_command`，替代手写的 if 链。实测分布：

| `busy_policy` | 命令数 | 行为 |
| --- | --- | --- |
| （默认，未显式声明） | 66 | 拒绝，等 agent 空闲 |
| `dispatch` | **24** | **agent 忙着也照跑** |
| `reject`（显式声明） | 3 | 同默认，但意图写明 |
| `interrupt_then_dispatch` | **2** | 先打断当前任务再执行 |

**「24 条命令可以在 agent 忙时执行」是这个设计的价值所在**——
`/status`、`/stop`、`/steer` 这类命令如果必须等空闲才生效就没有意义了。
把它做成注册表字段而不是散落的 if 判断，是这个仓库少见的「反 27,814 行」的做法。

**平台适配的两个上限也写进了这里**：
Telegram 菜单默认最多 60 条命令（Bot API 硬上限 100，`_TELEGRAM_BOT_API_MAX_COMMANDS`），
Slack 最多 50 条（`_SLACK_MAX_SLASH_COMMANDS`），命令名长度上限 32 字符。
**95 条命令装不进 Telegram 的 60 个菜单位**，所以有
`_TELEGRAM_MENU_PRIORITY`（`prepend` / `append` / `replace` 三种模式）来做优先级裁剪。

另外 `cli_only` 的有 35 条、`gateway_only` 的有 9 条——
**所以没有任何一个前端能看到全部 95 条**。

### 13.2 71 个 CLI 子命令

`_BUILTIN_SUBCOMMANDS` 是一个 `frozenset`，
注释说明它的用途是**在不触发插件发现的情况下让 argparse 认识子命令**——
插件发现会 eager import `google.cloud.pubsub_v1` / `aiohttp` / `grpc`，
「can take 500ms+」，所以这份清单是启动性能优化。
注释还给了维护契约：漏一个只是多花一次发现开销，
**多写一个则会让插件注册的同名命令静默解析失败**。

全部 71 个：
`acp` `approvals` `auth` `backup` `bundles` `chat` `checkpoints` `claw` `completion`
`computer-use` `config` `console` `cron` `curator` `dashboard` `debug` `desktop`
`doctor` `dump` `egress` `fallback` `gateway` `gui` `help` `hooks` `import`
`import-agent` `insights` `journey` `kanban` `learning` `login` `logout` `logs`
`lsp` `mcp` `memory` `memory-graph` `migrate` `moa` `model` `monitoring` `pairing`
`pause` `pets` `plugins` `portal` `profile` `project` `prompt-size` `proxy`
`resume` `secrets` `security` `send` `serve` `sessions` `setup` `skills` `skin`
`slack` `status` `sync` `tools` `uninstall` `update` `verify` `version` `webhook`
`whatsapp` `whatsapp-cloud`

**入口点有三个**（`pyproject.toml:358`）：
`hermes` → `hermes_cli.main:main`、
`hermes-agent` → `run_agent:main`、
`hermes-acp` → `acp_adapter.entry:main`。

---

## 14. 六个前端共用一个核心

**§1 那句「same agent core across a CLI, a messaging gateway, a TUI, and an
Electron desktop app」实际上少数了两个。** 按代码数，前端有六种：

| 前端 | 实现 | 技术栈 | 入口 |
| --- | --- | --- | --- |
| **经典 CLI** | `cli.py`（18,611 行） | Python + prompt_toolkit | `hermes` |
| **TUI** | `ui-tui/` + `tui_gateway/` | **TypeScript (Ink) + Python** | `hermes --tui` / `HERMES_TUI=1` |
| **消息网关** | `gateway/`（`run.py` 27,814 行） | Python | `hermes gateway`（24 个平台，§7） |
| **Web dashboard** | `web/` + `hermes_cli/web_server.py`（17,951 行） | Vite + React / Python | `hermes dashboard` / `serve` |
| **Electron 桌面应用** | `apps/desktop/`（`package.json` 版本 0.17.0） | Electron + TS | `hermes desktop` / `gui` |
| **ACP 适配器** | `acp_adapter/`（11 个文件） | Python | `hermes-acp` / `hermes acp` |

（另有 `api_server` 与 `webhook` 两个 `Platform` 枚举成员算作程序化入口，§7。）

**TUI 的进程模型是这六个里最值得看的一个**，因为它是跨语言的
（`AGENTS.md:467`，仓库自述）：

```
hermes --tui
  └─ Node (Ink)  ──stdio JSON-RPC──  Python (tui_gateway)
       │                                  └─ AIAgent + tools + sessions
       └─ renders transcript, composer, prompts, activity
```

**职责切分是一句话**：「TypeScript owns the screen. Python owns sessions, tools,
model calls, and slash command logic.」
传输是 **stdio 上的换行分隔 JSON-RPC**（Ink 发请求，Python 发事件），
方法/事件全表在 `tui_gateway/server.py`。

**斜杠命令在 TUI 里走两级分流**：
`/help` `/quit` `/clear` `/resume` `/copy` `/paste` 这类客户端命令在 `app.tsx` 本地处理；
其余走 `slash.exec` 进一个**常驻的 `_SlashWorker` 子进程**，
再回落到 `command.dispatch`（`tui_gateway/slash_worker.py`）。
**常驻 worker 的存在理由是启动开销**——与 §13 那份
`_BUILTIN_SUBCOMMANDS` 清单同一个动机。

**TUI 用的是自家 fork 的 Ink**：`ui-tui/packages/hermes-ink`（`@hermes/ink`），
以 `file:./packages/hermes-ink` 的形式被工作区依赖。
`ui-tui/` 还带 `npm run visual`（视觉回归脚本）与 vitest。

**这个 TUI 也被嵌进 dashboard 与桌面应用**：
`AGENTS.md:518` 讲「TUI in the Dashboard（`hermes dashboard` → `/chat`）」，
`:531` 讲 Electron 聊天应用——**同一个 Ink 实现被三处复用**。

**npm workspaces 的组织**（根 `package.json`）：
`apps/*`、`ui-tui`、`ui-tui/packages/*`、`web`、`tests-js`。
根包名 `hermes-agent` 版本 `1.0.0` 且 `private: true`——
**这个 `1.0.0` 是占位值，不是产品版本**（§19 讲版本号乱象时会再提）。

---

## 15. MCP 与 ACP

**MCP 客户端是全仓第八大的 Python 文件**：`tools/mcp_tool.py`，**7,588 行**。
它是「连外部 MCP server」的客户端实现，
而 §4 提到的三处动态注册（:6303 / :6454 / :6487）就在这里——
**MCP 工具是运行时注入注册表的，所以内置 83 个工具之外，
模型实际看到多少工具取决于你接了什么**。

**周边配套的模块数量说明这条路径踩过不少坑**：
`tools/mcp_oauth.py` / `mcp_oauth_manager.py` / `mcp_dashboard_oauth.py`（三套 OAuth 相关）、
`tools/mcp_schema_cache.py`（schema 缓存）、
`tools/mcp_stdio_watchdog.py`（stdio 看门狗）。
斜杠命令侧有 `/reload-mcp`，CLI 侧有 `hermes mcp` 子命令（含 `catalog`、`install`、`picker`）。

**MCP catalog 是一份「只由 PR 合并决定」的白名单**，
`hermes_cli/mcp_catalog.py`（831 行）的文件头把策略写得很硬：

> Entries are added only by merging a PR into hermes-agent. Presence in the
> `optional-mcps/` directory = Nous approval. **No community tier, no trust
> signals beyond "it's in the catalog".**

**实测 `optional-mcps/` 下有 6 个条目**，各带一个 `manifest.yaml`：
`blender`、`comfy-cloud`、`figma`、`linear`、`n8n`、`unreal-engine`。
**全部默认关闭**（ships disabled），用 `hermes mcp install <name>` 或交互式 picker 启用。

**manifest 的 pin 规则与依赖供应链同一套标准**（同一段注释）：
包启动器要精确版本（`uvx pkg==X`、`npx pkg@X`），
git 安装要完整 commit SHA，且**被 pin 的 release 在 pin 的时候至少已发布两周**。
**MCP 永不自动更新**——用户必须显式重跑 `hermes mcp install <name>`。
安装时提示的密钥进 `~/.hermes/.env`（遵守「.env 只放密钥」的规则，§19）。

**这套 catalog 策略是一个明确的取舍**：它牺牲了生态规模
（没有社区层、没有第三方信任信号），换取「目录里的都过了 PR review」这一条简单保证。
**代价是 6 个条目远少于任何公共 MCP 注册表**。

**ACP（Agent Client Protocol）是反向的一条**：
`acp_adapter/` 让 Hermes 作为 agent 被外部编辑器/客户端驱动
（`hermes-acp` 入口，`hermes-acp` toolset）。
模块构成：`server.py`、`session.py`、`tools.py`、`permissions.py`、
`edit_approval.py`、`provenance.py`、`events.py`、`auth.py`。
**注意 `copilot-acp` 是走 ACP 的一个 provider**（§8）——
即 Hermes 既能当 ACP server，也能当 ACP client 去接 Copilot。

---

## 16. 状态持久化：SQLite + 双 FTS5 索引

**会话状态存在 SQLite，取代了早期的 per-session JSONL。**
主实现 `hermes_state.py`（**10,399 行**，全仓第五大），
schema 在 `hermes_state_common.py` 的 `SCHEMA_SQL`。

**文件头列的关键设计决策**（仓库自述）：

- **WAL 模式**，支持并发读 + 单写（gateway 要同时服务多平台）；
- **FTS5 虚拟表**做跨会话全文检索；
- **压缩触发会话切分**，靠 `parent_session_id` 串链（§5）；
- **batch runner 与 RL trajectory 不存这里**（是独立系统）；
- **会话打 source 标签**（`cli`、`telegram`、`discord`…）用于过滤。

**9 张主表**（`SCHEMA_SQL`）：
`schema_version`、`system_prompts`、`sessions`、`messages`、
`session_model_usage`、`state_meta`、`gateway_routing`、
`compression_locks`、`async_delegations`。

**整个 `hermes_state_common.py` 里的 DDL 语句计数**（`grep -c` 判据，
注意其中只有一部分在 `SCHEMA_SQL` 字面量内，其余分散在按需建表/建索引的常量里）：

| DDL | 数量 |
| --- | --- |
| `CREATE TABLE` | **9**（全部在 `SCHEMA_SQL` 内） |
| `CREATE INDEX` | **17**（11 个在 `SCHEMA_SQL` 内） |
| `CREATE TRIGGER` | **12** |
| `CREATE VIRTUAL TABLE` | **4**（FTS5，见下） |
| `CREATE VIEW` | 1 |

其中三张值得单独说：
`system_prompts` **把系统提示词单独存一张表并按 hash 索引**
（`idx_sessions_system_prompt_hash`）——这与 §5 的 prompt cache 原则一致，
提示词是被当作可复用的、有身份的对象管理的；
`compression_locks` 说明压缩是**带锁的跨进程操作**；
`async_delegations` 对应 §9 的异步委派投递。

**FTS5 索引不是一套，而是三个家族并存，外加两个遗留副本**——
这也是上面那 4 个 `CREATE VIRTUAL TABLE` 的来源（`SCHEMA_VERSION = 25`）：

| 常量 | 虚拟表 | 分词器 | 用途 |
| --- | --- | --- | --- |
| `FTS_SQL` | `messages_fts` | 默认（`unicode61`） | 主全文索引，external-content 挂在 `messages` 上 |
| `FTS_TRIGRAM_SQL` | `messages_fts_trigram` | **`trigram`** | 子串匹配（`unicode61` 做不到的） |
| `FTS_CJK_TABLE_SQL` | **`messages_fts_cjk`** | **`cjk_unicode61`** | **中日韩分词** |
| `LEGACY_FTS_SQL` / `LEGACY_FTS_TRIGRAM_SQL` | 同名的 `messages_fts` / `messages_fts_trigram` | — | **仅供 v23 之前的老库**，新装不会创建 |

**中文用户尤其该注意第三行。** 默认的 `unicode61` 分词器对中日韩文本
几乎无效（不按字切分），所以仓库额外建了一套 CJK 索引：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_cjk USING fts5(
    content, tool_name, tool_calls,
    content='messages_fts_cjk_src',
    content_rowid='id',
    tokenize='cjk_unicode61'
);
```

**这是 `session_search` 工具（§11）能检索中文历史对话的前提。**
现代的三套都用 external-content 模式（挂在 `messages` 表上，
经一个排除 `role='tool'` 的视图），靠触发器同步。

**那两个 legacy 常量的注释解释了「为什么不能直接升级」**：
v11–v22 的老库里，每个虚拟表**自己存一份**
`content || tool_name || tool_calls` 的拷贝，
且 trigram 表索引了**包括 `role='tool'` 在内的所有行**。
新装一律生在 v23 的 external-content schema 上，
而老库**绝不能被喂 v23 的 DDL**——否则会创建出 external-content 的
trigram 源视图，把库留在「混合的、坏掉的」状态。
迁移由 `optimize_fts_storage()`（对应 `hermes db optimize`）在用户显式选择时执行。
**这是一处「宁可让两套 schema 并存，也不做隐式迁移」的保守取舍。**

**围绕这套索引有一段罕见的、写得很细的危险注释**——
它记录了一个真实的 FTS5 损坏隐患，值得引用：

> …must keep its triggers DROPPED — an external-content 'delete' op for a
> rowid the index never held is the canonical FTS5 index-corruption hazard
> the v23 marker gating exists to prevent.

配套机制是用 `state_meta` 里的 `fts_cjk_rebuild_high_water` /
`fts_cjk_rebuild_progress` 两个水位标记，
让触发器只对「已进索引的 rowid 区间」生效，从而支持**在线渐进重建索引**
而不产生「删除索引里从未存在过的 rowid」这种损坏。
**这类注释是判断一个仓库工程成熟度的好指标**：
它记的不是「怎么用」，而是「为什么这里不能改成看起来更简洁的写法」。

**会话相关的其他机制**：
`hermes_state_portability.py` 做跨版本导入导出
（对应 `hermes dump` / `hermes import` / `hermes backup`）；
`hermes_cli/checkpoints.py` 对应 `/snapshot` `/rollback`；
`agent/session_activity.py` 的 `ActivityProvenance` 记录活动来源。
`sqlite_leak_fix.png`（832,292 字节）还留在仓库根——
一张调 SQLite 泄漏时的截图，**说明这套东西的稳定性是踩出来的**。

---

## 17. 插件与 Hook：24 个事件 / 9 个皮肤

### 17.1 插件系统

**`plugins/` 下有 18 个目录**，但它们不是同一类东西——
**分成五种契约，各有各的扩展点**（`AGENTS.md:774`）：

| 契约 | 目录 | 数量 | 是否占模型 schema |
| --- | --- | --- | --- |
| 通用插件 | `plugins/<name>/` | — | 否 |
| **模型 provider** | `plugins/model-providers/<name>/` | **34** | 否（§8） |
| **记忆 provider** | `plugins/memory/<name>/` | **8** | 否（§11） |
| 上下文引擎 | `plugins/context_engine/<name>/` | — | 可自带工具（§5） |
| dashboard / image-gen | `plugins/dashboard_auth/`、`plugins/image_gen/` | — | 否 |

其余通用插件：`browser`、`cron_providers`（含 Chronos，§12）、`disk-cleanup`、
`google_meet`、`hermes-achievements`、`kanban`、`observability`、`platforms`、
`security-guidance`、`spotify`、`teams_pipeline`、`video_gen`、`web`。
**`plugins/` 下注册的模型工具数为 0**（§4）——这是整套设计的可核验结果。

`plugins/hermes-achievements/` 是个意外的存在（带 HD 截图各 1.4MB）——
一个成就系统插件，说明这个项目的产品定位里有明确的消费级/游戏化成分
（配合 `/pet` `/hatch` 两条斜杠命令和 `hermes pets` 子命令看，§13）。

### 17.2 Hook：24 个插件事件，只有 1 个能阻断

**单一事实源是 `hermes_cli/plugins.py:136` 的 `VALID_HOOKS`，实测 24 个：**

| 分组 | 事件 |
| --- | --- |
| **工具**（4） | `pre_tool_call`、`post_tool_call`、`transform_tool_result`、`transform_terminal_output` |
| **LLM**（3） | `pre_llm_call`、`post_llm_call`、`transform_llm_output` |
| **API**（3） | `pre_api_request`、`post_api_request`、`api_request_error` |
| **会话**（4） | `on_session_start`、`on_session_end`、`on_session_finalize`、`on_session_reset` |
| **子代理**（2） | `subagent_start`、`subagent_stop` |
| **审批**（2） | `pre_approval_request`、`post_approval_response` |
| **Kanban**（3） | `kanban_task_claimed`、`kanban_task_completed`、`kanban_task_blocked` |
| **其他**（3） | `pre_verify`、`on_skill_lifecycle`、`pre_gateway_dispatch` |

**关键约束：`agent/shell_hooks.py:173` 的 `_BLOCKING_EVENTS = frozenset({"pre_tool_call"})`
——24 个事件里只有 1 个能阻断执行。** 其余都是观察或改写型。
阻断的退出码是 `BLOCK_EXIT_CODE = 2`（与 Claude Code 的约定一致）。

**shell hook（外部脚本）能测的事件是 12 个**
（`hermes_cli/hooks.py` 的 `_DEFAULT_PAYLOADS`）：
`pre_tool_call`、`post_tool_call`、`pre_llm_call`、`post_llm_call`、`pre_verify`、
`on_session_start`、`on_session_end`、`on_session_finalize`、`on_session_reset`、
`pre_api_request`、`post_api_request`、`subagent_stop`。
**`hermes hooks test` / `hermes hooks doctor` 送进脚本的 stdin
与生产触发时完全同形**（走同一个 `_serialize_payload`）——
这是个不常见但很实用的设计。

**`pre_verify` 值得单独说**：它是「验证循环闸门」，
在 agent 改过代码、即将验证/收尾时触发一次，
回调可以返回 `{"action": "continue", "message": "..."}` 让 agent 继续干活。
注释明确说它**也接受 Claude Code 的 Stop 形状**
（`{"decision": "block", "reason": "..."}`），并受 `agent.max_verify_nudges` 约束。
**这是本文见到的、少数把「兼容另一个产品的 hook 协议」写进注释的地方。**

安全侧：shell hook 有 `shell-hooks-allowlist.json` 允许清单，
默认超时 60 秒、上限 300 秒；`hermes hooks` 列出配置时会检查
**脚本在批准之后是否被改动过**（比对 mtime），改过就提示重新校验。
另有出站 webhook（`agent/outbound_webhooks.py`），
`hermes hooks` 会显示每个目标是 `signed` 还是 `UNSIGNED`。

### 17.3 皮肤：代码 9 个，`AGENTS.md` 还写 4 个

**这是文首 danger 框第 4 条的完整证据。**
`hermes_cli/skin_engine.py:201` 的 `_BUILTIN_SKINS` 实测 **9 个**：
`default`、`ares`、`mono`、`slate`、`daylight`、`warm-lightmode`、
`poseidon`、`sisyphus`、`charizard`。

而 `AGENTS.md:723` 的清单**只有前 4 个**。用 `git log -S` 定位漂移时间线：

| 事件 | commit | 时间 |
| --- | --- | --- |
| `AGENTS.md` 写下 4 个皮肤的文档 | `b4b46d1b6` | 2026-03-10 **00:51** -0700 |
| `poseidon`/`sisyphus`/`charizard` 落地 | `4945240fc` | 2026-03-10 **02:11** -0700 |
| `warm-lightmode` 落地 | `6dc8f8e9c` | 2026-04-13 |
| `daylight` 落地 | `bc93641c4` | 2026-04-14 |

**文档在写下 80 分钟后就过期了，而且此后四个月没补。**

**但要给个公道的对照：面向用户的文档站没漂。**
`website/docs/user-guide/features/skins.md` 的表格把 9 个全列了，
每个都有描述、品牌名与视觉说明。
**所以漂移只发生在 `AGENTS.md` 这份「给贡献者和 agent 看」的文件里**——
考虑到这个仓库把 `AGENTS.md`（1,474 行）当作 agent 的工作说明书，
这处漂移的实际影响是「照它写代码的 agent 会以为只有 4 个皮肤」。

（皮肤除颜色外还能定制品牌名、spinner 动词、ASCII banner——
`ares` 有剑盾 banner 和「forging」「marching」这类动词，
`sisyphus` 的 spinner 是「pushing uphill」「resetting the boulder」。）

---

## 18. 安全模型：把「什么不是边界」写进文档

**这是本文读到的最坦率的一份安全文档，值得逐条摘。**
`SECURITY.md` 的做法不是列举防护措施，而是**先声明唯一的边界，
再把自家的一堆防护明确降级为「不是边界」**。

### 18.1 唯一的边界

`SECURITY.md` §2.2 的原文（加粗是原文的）：

> **The only security boundary against an adversarial LLM is the
> operating system.** Nothing inside the agent process constitutes
> containment — not the approval gate, not output redaction, not any
> pattern scanner, not any tool allowlist. Any in-process component
> that screens LLM output is a heuristic operating on an
> attacker-influenced string, and this policy treats it as such.

**两种被支持的 OS 级隔离姿态，且明确说了各自防什么：**

| 姿态 | 做法 | 适用场景 |
| --- | --- | --- |
| **终端后端隔离** | 非默认后端（容器/远程/云沙箱，§6），文件工具也走它 | 担心 LLM 发出破坏性 shell 或乱写文件，**但运营方本身可信** |
| **整进程包裹** | 自家 Docker 镜像 + Compose，或 [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) | agent 要吃**运营方不控制的输入**（开放网络、入站邮件、多人频道、不可信 MCP）；生产/共享部署 |

**整进程包裹覆盖「每一条代码路径」**——shell、代码执行、MCP、文件工具、
插件、hook、技能加载全都受同一套文件系统/网络/进程策略约束。
OpenShell 那条还提供 L7 出站控制与推理路由策略、策略热重载、
凭据从 Provider store 注入而**不落沙箱文件系统**。

**然后是一句罕见的、直接点名「你这样用就是在支持范围之外」的话：**

> Operators running the default local backend with untrusted input
> surfaces, or running a terminal-backend sandbox and expecting it to
> contain code paths that don't go through the shell, are operating
> outside the supported security posture.

**注意第二半句**：终端后端隔离**只**约束走 shell 的路径（§6），
指望它拦住不走 shell 的代码路径（MCP、插件、hook、技能 import）是误用。

### 18.2 被明确降级的四个「非边界」

§2.4 标题就叫 In-Process Heuristics，开头两句是
「They are useful. They are not boundaries.」：

| 组件 | 文档自己给的失效理由 |
| --- | --- |
| **审批门** | 「Shell is Turing-complete; a denylist over shell strings is **structurally incomplete**. The gate catches cooperative-mode mistakes, not adversarial output.」 |
| **输出脱敏** | 「A motivated output producer will defeat it.」 |
| **Skills Guard** | 只是 review 辅助；第三方技能的边界是**安装前人工审阅** |
| **插件** | §2.5：插件以**完整 agent 权限**加载进进程，能读同样的凭据、调同样的工具 |

**Skills Guard 那条附带一句很重要的操作提醒**：
审阅一个技能意味着读它的 Python 代码和脚本，不只是读 `SKILL.md` 描述——
**因为技能在 import 时就会执行任意 Python**。

§2.5 还划了责任边界：「A malicious or buggy plugin is not a vulnerability in
Hermes Agent itself」，但**插件安装/发现路径上让运营方看不清自己在装什么的 bug
属于漏洞范围**。

### 18.3 审批门的实现规模

**尽管文档说它不是边界，实现上仍然很重**：`tools/approval.py` **4,553 行**，
`DANGEROUS_PATTERNS` 实测 **77 条**规则（AST 计数）。

规则的写法能看出是被真实绕过案例推着长的。举一例——
GNU `rm` 允许标志跟在操作数后面（`rm build/ -rf`），
所以除了常规的两条 `rm -r` 规则外还有第三条专门匹配「标志在操作数之后」，
且这条正则被刻意限制为：**不跨命令分隔符**（`;` `|` `&` 换行，
避免把后段管道的 `-r` 算到 `rm` 头上）、**不跨引号**
（避免 `git commit -m "rm x" --amend` 被误判）、
**不跨 ` -- ` 结束选项分隔符**（`--` 之后 `-rf` 是文件名不是标志）。
注释注明这条是「Port of openai/codex#33464」。

**两个安全实现细节值得单独记：**

1. **YOLO 模式在模块导入时冻结**（`tools/approval.py:36`）：
   ```python
   _YOLO_MODE_FROZEN: bool = is_truthy_value(os.getenv("HERMES_YOLO_MODE", ""))
   ```
   注释给的理由是**提权路径**：每次调用都读 `os.environ` 的话，
   任何在本进程内运行的技能都能设这个变量、**瞬间绕过所有审批检查**。
2. **审批会话身份用 `contextvars` 而不是进程级全局**：
   gateway 在 executor 线程里并发跑 agent 回合，
   读进程级 env 做会话身份会串号。

### 18.4 凭据作用域与外部面

**§2.3 凭据裁剪**：传给低信任内部组件（shell 子进程、MCP 子进程、
cron 脚本、代码执行子进程）的环境**默认剥掉 provider API key 与 gateway token**，
只有运营方或已加载技能显式声明的变量才透传（对应 `tools/env_passthrough.py`）。

**§2.6 外部面**列了四类并给出统一规则：
gateway 平台适配器、网络暴露的 HTTP 面（API server、dashboard、kanban 的 HTTP 端点）、
编辑器/IDE 适配器（ACP）、TUI gateway（本地 IPC 的 JSON-RPC）。
统一规则第一条是**每个跨信任边界的面都必须有授权**——
网络面的边界是网络（要运营方配置调用方允许清单），
本地 IPC 面的边界是宿主用户账户。

**出站方向另有一道**：`hermes egress` 子命令 + `/egress` 斜杠命令，
`main.py:11388` 注释称其为「iron-proxy outbound credential-injection firewall」。

**供应链**：`.github/workflows/` 里有 `osv-scanner.yml`、
`supply-chain-audit.yml`、`uv-lockfile-check.yml`、`lockfile-diff.yml`；
`pyproject.toml` 有 `exclude-newer = "14 days"`（依赖必须至少发布 14 天，
与 §15 的 MCP pin 规则同一套标准），
并有一条针对 `discord.py` 固定 `pynacl<1.6` 的显式 override
（注释说明 1.5.0 有已知漏洞，上游未发补丁版）。
`tools/osv_check.py` 说明 OSV 查询也做进了运行时。

---

## 19. 分发与版本号：三套并存，PyPI 上的包被自己判为不支持

**这一节是文首 danger 框第 1、3 条的完整证据，也是本文最反直觉的一章。**

### 19.1 三套版本号

**同一时刻，这个项目有三套互不相等的版本号在流通：**

| 来源 | 值 | 判据 |
| --- | --- | --- |
| `pyproject.toml` | **0.20.0** | `[project] version` |
| PyPI `hermes-agent` 最新 | **0.19.0** | registry API，2026-07-20 发布 |
| 最新 git tag | **`v2026.8.3`** | tags API，2026-08-03 |
| 根 `package.json` | `1.0.0` | **占位值**，`private: true`（§14） |
| `apps/desktop/package.json` | `0.17.0` | Electron 应用自己的版本 |

**GitHub release 的标题把前两套缝在一起**：
最新 release 的 tag 是 `v2026.8.3`，标题写「**Hermes Agent v0.20.0 (2026.8.3)**」。
所以官方口径是「语义版本 + 日期版本」双轨，
**日期 tag 是发布事件的标识，语义版本是产品代号**。

**部分 release 还有代号**：
`v2026.7.20` = 「The Quicksilver Release」（v0.19.0）、
`v2026.7.1` = 「The Judgment Release」（v0.18.0）、
`v2026.6.5` = 「The Surface Release」（v0.16.0）、
`v2026.5.28` = 「The Velocity Release」（v0.15.0）、
`v2026.5.7` = 「The Tenacity Release」（v0.13.0）。

**发布节奏**（24 个 release，page 1）：2026-04 起大致每周到每两周一个，
最密的时候同日两个（`v2026.7.7` 与 `v2026.7.7.2` 相隔不到 2 小时，
`v2026.5.29` 与 `v2026.5.29.2` 同日）——**说明有过热修**。

### 19.2 PyPI 上的包：真的存在，且被官方判为不支持

**这是本文最需要读者注意的一条。** PyPI 上的 `hermes-agent` 是真包：

| 项 | 值 |
| --- | --- |
| 最新版本 | **0.19.0**（2026-07-20T18:37:26） |
| author | **Nous Research** |
| summary | 「The self-improving AI agent — creates skills from experience…」 |
| requires_python | `>=3.11,<3.14` |
| 文件 | `hermes_agent-0.19.0-py3-none-any.whl`（**10,144,439 字节**）+ `.tar.gz`（14,282,599 字节） |
| release 总数 | **11**（最早 `0.13.0`，2026-05-14） |

**而官方文档 `website/docs/getting-started/platform-support.md:47`
把它列在 `## Unsupported` 段落下：**

> These platforms and distribution methods are **not** supported. …
> They may be broken right now, they may break more in the future.
> **PRs to fix them will _not_ be accepted**, and any code that keeps
> compatibility with them may be removed at any point.
>
> - installs via the AUR …
> - macOS on x86 (Intel) processors
> - **installs via `pypi` (e.g. `uv tool install hermes-agent`, `pip install hermes-agent`, etc.)**
> - installs via `brew` (`brew install hermes-agent`)

中文快速上手页说得更直接：
「这是唯一受支持的安装方式 —— 包括开发用途。**请勿使用 `pip install hermes-agent`**。」

**所以现状是：一个组织在 PyPI 上持续发布自己的包（11 个版本，最近一次 2026-07-20），
同时在文档里声明用这个包安装不受支持、相关修复 PR 不会被接受。**

⚠ **本文未能核验的部分**：**没有找到任何公开说明解释这个包为什么继续发布**。
可能的解释包括「给下游/库用户当依赖用」「历史遗留未下架」「内部构建产物顺带上传」，
但**这些都是我们的推测，仓库里没有依据**。能证实的只有上面那张表和那段文档。
`0.19.0` 之后 PyPI 停更（截至 2026-08-09 已 20 天），
而同期 git tag 又发了 `v2026.7.30` 和 `v2026.8.3` 两个——
**PyPI 与 git 的发布节奏已经脱钩。**

### 19.3 受支持的分发方式：托管一个 git 工作副本

**官方路径是一行脚本**：

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash   # Linux/macOS/WSL2/Termux
iex (irm https://hermes-agent.nousresearch.com/install.ps1)          # Windows 原生
```

它在 `~/.hermes/hermes-agent` 建一个**受管的隔离环境**
（独立的 uv 托管解释器 + venv）。仓库里另有 `setup-hermes.sh`
给手动 clone 的开发者用（建 Python 3.11 venv、按平台装依赖、
把 `hermes` 命令软链到用户 bin 目录）。

**关键差异：`hermes update` 不是重装包，是 `git pull`。**
`hermes_cli/update_cmd.py`（**5,555 行**）的实现要点：

- 主路径 `git pull --ff-only`（`:1624`）；
- **ZIP 兜底**（`:735`）——注释说明它的存在是为了应对 Windows 上
  git 文件 I/O 损坏的情况；
- 拉完做两道校验：`_validate_critical_files_syntax`（语法）与
  `_validate_critical_modules_import`（可导入性），
  注释写明目的是**拉坏时自动回滚**而不是让用户面对一个起不来的安装；
- `_reload_updated_runtime_modules()` 支持热加载更新后的模块；
- 更新后校验 `state.db` 是否存活（§16）；
- `updates.pre_update_backup`（默认 `false`）可在每次更新前打包整个
  `HERMES_HOME`，`backup_keep: 5` 保留 5 份。

注释里还有一处针对本仓库特殊性的优化：
「A bare `git fetch origin` pulls every ref, and this repo carries…」——
**因为有 1,505 个远端分支（§2），裸 fetch 的代价很高**，
所以代码刻意只 fetch 需要的 ref。

**这个模型的取舍**：能热更新、能回滚、能应对 Windows 的 git 怪癖，
代价是**每个安装都是一个 git 工作副本**，
且更新逻辑要自己实现包管理器本该提供的完整性校验（5,555 行的由来）。

### 19.4 平台分层

文档把平台分成 Tier 1 / Tier 2 / Unsupported，
**Tier 1 的承诺是「strive to never break installations and updates」，
且 Tier 1 的回归优先级高于其他平台**：

| Tier 1 | 安装方式 |
| --- | --- |
| macOS（**Apple Silicon**） | Hermes Desktop、`install.sh` |
| Windows 10/11（x86_64、aarch64） | Hermes Desktop、`install.ps1`（部分功能不可用，有 feature matrix） |
| Linux / WSL2（x86_64、aarch64） | `install.sh` |

Tier 2 含 **Android（Termux，aarch64）** 与 **Nix**——
Nix 那行的备注是罕见的坦白：「Breaks often due to node.js packaging woes.
Best of luck~! &lt;3」。
Unsupported 含 AUR、**macOS x86（Intel）**、PyPI、Homebrew。

**Windows 是原生支持而非仅 WSL**：有 `install.ps1`、
`hermes_cli/gateway_windows.py`、PowerShell 占语言比 0.30%（§3），
`constraints-termux.txt` 则对应 Termux 那条。
Docker 侧有 `docker/` 目录（18 个文件）与 `.hadolint.yaml`。

---

## 20. 工程规模、测试与本文的边界

### 20.1 测试与 CI

| 项 | 值 | 判据 |
| --- | --- | --- |
| `tests/` 下 Python 文件 | **2,816** | `git ls-files` |
| `test_` 前缀函数 | **23,100** | `grep -rh "^def test_\|^    def test_"` |
| `tests-js/` 文件 | 7 | `git ls-files` |
| GitHub Actions workflow | **25** | `.github/workflows/` |

**23,100 个测试函数对 1,532,618 行 Python**，粗算约每 66 行一个测试函数。
（这是**数量**指标，不是覆盖率——本文没有跑测试也没有测覆盖率，见 20.3。）

25 个 workflow 里有几个能看出这个项目的特殊运维压力：
`contributor-check.yml`、`history-check.yml`、`label-rerun.yml`、`review-labels.yml`
（都与 §18 那 19,823 条 open PR 的分诊压力有关）、
`skills-index.yml` + `skills-index-freshness.yml`（技能索引新鲜度，§10）、
`install-e2e.yml` + `install-e2e-run.yml` + `installer-tests.yml`（安装路径 E2E，§19）、
`e2e-desktop.yml`、`docker-lint.yml`、`osv-scanner.yml`、`supply-chain-audit.yml`。

### 20.2 配置面与文档站

| 项 | 值 |
| --- | --- |
| `cli-config.yaml.example` | **1,747 行**，21 个顶层键 |
| `.env.example` | 496 行；活跃 11 个 + 注释 114 个 = **并集 125 个**环境变量 |
| `pyproject.toml` 核心依赖 | **34** |
| 可选依赖 extras | 40+ 组（`messaging`、`cron`、`slack`、`matrix`、`mcp`、`computer-use`、`acp`、`vision`、`voice`、`termux`、`all`…） |
| 文档站页面 | **392**（`user-guide` 299 / `guides` 34 / `developer-guide` 34 / `reference` 12 / `getting-started` 7 / `integrations` 4） |
| 中文本地化页面 | **317**（`website/i18n/zh-Hans/`） |
| `AGENTS.md` | 1,474 行 |

**21 个 config 顶层键**：`agent`、`model`、`memory`、`skills`、`terminal`、
`browser`、`delegation`、`compression`、`context`（经 `context.engine`）、
`code_execution`、`database`、`display`、`streaming`、`stt`、`telemetry`、
`prompt_caching`、`session_reset`、`platform_toolsets`、`tool_loop_guardrails`、
`updates`、`group_sessions_per_user`、`max_concurrent_sessions`。

**「`.env` 只放密钥」是一条被写进多处的硬规矩**（§15 的 MCP 安装、
`AGENTS.md:647` 的「.env variables (SECRETS ONLY — API keys, tokens, passwords)」），
非密钥配置一律进 `config.yaml`。

**中文本地化 317 页对 392 页英文原文，覆盖率约 81%**——
对一个海外项目来说是罕见的投入度，
配合 §16 那套专门的 CJK FTS5 索引和 §7 那 7 个中国生态渠道
（飞书/企微/微信/钉钉/QQ/元宝）一起看，**中文场景是被认真对待的**。

### 20.3 未能核验的部分（照实说）

**这一节比前面 19 章都重要**——它划出本文的可信边界。

**完全未验证（没跑起来，全部是仓库自述）：**

- **我们没有安装、也没有运行过 Hermes Agent。** 所有行为描述——
  学习闭环产出的技能到底可不可用（§11）、
  7 个终端后端是否都通、Daytona/Modal 的「休眠唤醒近乎零成本」（§6）、
  Chronos 缩容到零的实际时序（§12）、
  Honcho 用户建模的实际效果（§11.4）、
  两套 FTS5 索引的中文检索质量（§16）——**全部来自仓库内文档与代码注释，属厂商声明**。
- **「~30K tokens / event」的复盘成本**（§11.2）是代码注释里的自述值，未实测。
- **上下文压缩的实际效果与 prompt cache 命中率**（§5）——
  代码里能看到为保 cache 做的所有让步，但**省了多少钱本文测不出来**。
- **`AGENTS.md` 说 `AIAgent.__init__` 有「~60 参数」**（§5）——
  这是文档自述，本文没有逐个数过。

**源码里看得到、但意图或状态不明的：**

- **PyPI 上的包为什么继续发布，同时文档又声明不支持**（§19.2）——
  只记录现象，**没有找到任何公开说明**，也无法排除「历史遗留未下架」这类平凡解释。
- **`AGENTS.md` 的皮肤清单漂移了 4 个月没人补**（§17.3）——
  现象可核验（`git log -S` 定位到分钟），但**是疏忽还是有意不维护，无从判断**。
- **19,823 条 open PR 的构成**（见文首 danger 框第 2 条与 §2）——
  本文只拿到总数，**没有抽样分析这些 PR 的质量、重复率或停滞原因**。
  「贡献量远超合并吞吐」是从数字推的，不是从 PR 内容验证的。
- **`gateway/run.py` 那 27,814 行里有多少是活跃路径**（§3、§7）——
  只数了行数，**没做可达性分析**。同理 `cli.py` 的 18,611 行。
- **125 个环境变量里实际有多少在生效**（20.2）——只做了并集统计。
- **`plugins/hermes-achievements/` 这个成就系统的产品意图**（§17.1）。
- **`batch_runner.py`（1,330 行）与 RL trajectory 那条链路**——
  `hermes_state.py` 注释说它们是「separate systems」，本文没有展开。

**属于二手、本文只能标注不能核验的：**

- **227,456 star / 44,549 fork 的真实性与构成**——取自 GitHub API，
  但**star 的自然增长与运营推动无法区分**。
- **`open_issues_count`（29,686）与 search 拆分之和（29,670）差 16**（见文首 danger 框第 2 条）——
  推测是 search 索引延迟，**未能证实**。
- **2,524 个作者身份里有多少是真人**（§2）——`.mailmap` 只做了部分归并，
  本文给了三个口径但**无法给出真实人数**。
- **README「the only agent with a built-in learning loop」这个「only」**——
  这是竞品比较类声明，**本文不核验也不背书**；§11 只核验了
  「这条闭环在自家代码里接到了什么程度」。
- **NVIDIA OpenShell 集成的实际隔离强度**（§18.1）——
  依赖第三方项目，本文未验证。

**方法论上的三处自我修正**（留作记录，因为它们正是「脚本计数也会错」的例子）：

1. **工具计数**：第一版用正则数 `.register(` 得到 83，但**当时无法区分
   `name` 是字面量还是变量**；改用 AST 后才发现另有 **15 处动态注册**
   （3 处在 `tools/mcp_tool.py`，其余在 `tests/` 与 `scripts/`），
   以及 `tests/` 里有 1 处故意的重名。**数值没变，但判据的可信度完全不同**（§4）。
2. **作者数**：初稿写「`git shortlog` 数出 2,530 个」——**这是张冠李戴**。
   `git shortlog` 应用 `.mailmap` 后是 **2,524**，2,530 是原始 `%an` 去重值，
   原始邮箱去重是 2,601。**三个数差得不多，但归错方法就是错的**（§2）。
3. **FTS5 索引数**：初稿写「两套 FTS5 索引，第二套是专为 CJK 建的」——
   **漏了一整个家族**。清点 `CREATE VIRTUAL TABLE` 后是 **4 个**：
   现代的三套（默认 / `trigram` / `cjk_unicode61`）**加上两个同名的 legacy 副本**。
   错因是**只搜了 `tokenize=` 关键字**——而默认分词器的那套根本不写 `tokenize=`，
   于是它在第一版里隐身了。**按「特征字段」搜会漏掉「取默认值」的那一个**（§16）。

这些地方本文用「我没有核验」明确标注，而不是含糊过去。

---

## 参考资料

**一手（本文的主要证据来源）：**

- 本地 clone 源码：`NousResearch/hermes-agent` @ `372b3b7bb`（2026-08-08）
- 仓库内文档：`README.md`、`AGENTS.md`（1,474 行）、`SECURITY.md`、
  `CONTRIBUTING.md`、`cli-config.yaml.example`（1,747 行）、`.env.example`、
  `docs/chronos-managed-cron-contract.md`、`gateway/platforms/ADDING_A_PLATFORM.md`
- GitHub REST API：`/repos`、`/languages`、`/releases`、`/tags`、
  `/contributors`、`/search/issues`
- PyPI registry：`https://pypi.org/pypi/hermes-agent/json`

**官方：**

- [Hermes Agent 官网](https://hermes-agent.nousresearch.com/)
- [文档站](https://hermes-agent.nousresearch.com/docs/)（392 页；中文 317 页）
- [Nous Portal](https://portal.nousresearch.com)
- [GitHub 仓库](https://github.com/NousResearch/hermes-agent)

**相关：**

- [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)（§18 的整进程隔离方案之一）
- [Honcho](https://github.com/plastic-labs/honcho)（§11 的用户建模 provider）
- [agentskills.io](https://agentskills.io)（§10 声明兼容的技能标准）

**本系列其他篇**（同为逐章手册，可横向对照）：
`ref-claude-code`、`ref-codex`、`ref-opencode`、`ref-openclaw`、
`ref-reasonix`、`ref-kimi-code`。
