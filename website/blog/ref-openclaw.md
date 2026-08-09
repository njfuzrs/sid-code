---
title: OpenClaw 深入研究（2026-08 快照）
description: 22 章逐节成册，按目录跳章查阅——把 OpenClaw 的产品形态、架构与实现细节交叉核验到版本号级别：五次改名的沿革、Gateway 单进程控制面、27 个内置聊天渠道、51 个核心工具 / 13 个工具组 / 4 档 profile、16 个内部 Hook 事件 + 17 个插件 Hook、155 个 extensions、4 种沙箱后端、npm stable 停在 21 天前。这是一份手册，不是读完就走的文章。
date: "2026-08-08"
series: 热点开源项目研究
audience: engineer
highlight: 22 章逐节可查 · 核验至 2026.8.1 / npm 2026.7.1-2 · 截至 2026-08-08 快照
tags: [OpenClaw, 深入研究, 渠道, 沙箱, 插件, 参考]
outline: [2, 3]
---

# OpenClaw 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-08
- **被调研版本**：仓库 HEAD **`2026.8.1`**（`package.json`，bump 提交 `4863966`，2026-08-07），
  本地 checkout 最新提交 `bf0aadbc`（2026-08-08 15:16 +0800）；
  npm 上的 **stable（dist-tag `latest`）却停在 `2026.7.1-2`（2026-07-18）**——
  这个 21 天的落差本身是本文的一条发现，见文首 danger 框与 §21。
- **证据形态**：**本地源码实查 + GitHub REST API / npm registry 实查 + 仓库内文档源文件**。
  与本系列前三篇（Claude Code / Codex / opencode）不同，本篇的**代码结构类断言
  直接来自本地 clone 的源码**（`~/Code/person/github/openclaw`），
  而不是二手分析；但**行为类断言仍以仓库内文档为据，我们没有跑起来实测**。
  这个区别在每一章里都尽量标清了。
- **一手性说明**：计数类事实（渠道数、工具数、Hook 事件数、extensions 数）
  **全部用脚本从源码或文档表格里数出来**，不是目测，脚本判据在正文里给出；
  Star 数 / 语言占比 / 版本时间线取自 GitHub REST API 与 npm registry。
- **时效边界**：这个项目 2026 年前 7 个月在 npm 上发了 **244 个版本**（含预发布），
  git 仓库累计 **77,105 个提交**。**这是 2026-08-08 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://docs.openclaw.ai)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 三条广为流传但已经过期（或从未准确）的说法
读 OpenClaw 的第三方介绍时，这三条几乎必然会遇到，而它们**在 2026-08 都已经不成立**：

1. **「旧命令 `clawdbot` 和 `moltbot` 仍作为兼容 shim 可用」**——
   这句话在多个聚合站的「命名沿革」段落里逐字流传。**实测不成立**：
   `package.json` 的 `bin` 字段**自改名当天（2026-01-30，commit `9a71607`）起就只有
   `openclaw` 一个入口**。历史上确实存在过双入口——moltbot 时期的
   `6d16a65` 里是 `{moltbot}`，`44f9017` 里是 `{moltbot, clawdbot}`——
   但那扇窗口只开了三天。npm 上 `clawdbot` 包**冻结在 `2026.1.24-3`（2026-01-25）**，
   `moltbot` 包是个只有 2 个版本的 `0.1.0` 占位包（无 `bin`、无依赖）。
   现在残留的兼容面只有**三处，且都不是 CLI 命令**：旧状态目录 `~/.clawdbot`
   与旧配置名 `clawdbot.json`（`src/config/paths.ts:25-30`）、
   插件清单里的 legacy key `clawdbot`（`src/compat/legacy-names.ts:5`）、
   以及 `openclaw clawbot qr` 这个遗留子命令命名空间（注意拼写是 `clawbot` 不是 `clawdbot`）。
   顺带一提：`.moltbot` 状态目录的兼容**已被显式删除两次**
   （`3b56a62`，2026-02-14；`c5a941a`，2026-03-22）。见 §1、§20。
2. **「装了就能用 `npm install -g openclaw@latest` 拿到最新特性」**——
   语法没错，但**拿到的不是你以为的版本**。npm `latest` = `2026.7.1-2`（2026-07-18），
   而 `beta` 已经走到 `2026.7.2-beta.7`（2026-08-02），仓库 HEAD 是 `2026.8.1`。
   更反直觉的是：**`extended-stable`（`2026.6.34`，2026-08-04 发布）的发布时间比
   `latest` 晚了 17 天，版本号却更低**——因为它是「trailing 支持月」通道，
   在老版本线上继续打补丁。所以 `latest` 既不是最新代码，也不是最近发布的包。见 §21。
3. **「这是 Peter Steinberger 的个人项目」**——**版权与发包主体已经不是个人**。
   `LICENSE` 的 copyright 持有者是 **OpenClaw Foundation**，
   `package.json` 的 `author` 是 `OpenClaw Foundation (https://openclaw.org)`，
   仓库归属 `openclaw/openclaw` 组织，iOS 标识符已迁到 `openclawfoundation`
   （`3b56a62` 之后的 `feat`/`chore` 提交，2026-06-15）。
   基金会化的公开叙述（创始人 2026-02-14 加入 OpenAI、项目转入独立基金会）
   来自新闻报道，属**二手**；但**版权归属与 npm 发包主体的变更是仓库内可核验的一手事实**。
   见 §1、§22。

前两条都是「引用二手介绍而不回一手源」的典型代价。本文标注的现状同样会漂移——
引用前先看一眼日期。
:::

::: tip 这一篇和本系列前三篇最大的不同
`ref-claude-code` / `ref-codex` / `ref-opencode` 的证据都是**公开信息**
（文档、changelog、二手逆向分析）。本篇多了一层：**本地 clone 的源码**。

所以本文能给出前三篇给不出的那类断言——比如「内置聊天渠道到底是 27 个还是 47 个」
这种**文档页数与代码事实不一致**的地方（§3），或者「`bin` 字段从改名当天就只有一个入口」
这种**能用 `git log -S` 定位到具体 commit** 的判据。

代价是**边界必须说清**：源码能证明「代码里有什么」，**不能证明「跑起来是什么行为」**。
本文没有把 OpenClaw 装起来跑过——所有行为描述（沙箱是否真的隔离、
failover 是否真按文档轮转）都来自仓库内文档，属**厂商口径**，见文末未验证块。
:::

---

## 1. 产品概述与五次改名

OpenClaw 的自我定位不是 coding agent，而是**个人 AI 助理**。
GitHub 仓库描述是 "Your own personal AI assistant. Any OS. Any Platform. The lobster way. 🦞"，
`VISION.md` 第一句是 "OpenClaw is the AI that actually does things. It runs on your devices,
in your channels, with your rules."

**这个定位差异是理解它所有架构选择的前提**：它的主入口不是终端，而是**你已经在用的聊天软件**
（WhatsApp / Telegram / Slack / Discord / 飞书 / iMessage …）。
终端只是运维面。所以它有 27 个内置聊天渠道（§3）而 Claude Code 有 0 个，
它有 Gateway 常驻进程（§2）而 Codex CLI 没有。

**关键数据（截至 2026-08-08，GitHub API 与 npm registry 实查）：**

| 项 | 值 |
|---|---|
| GitHub Stars | **385,524** |
| Forks | **81,025** |
| Open Issues | **5,624** |
| Watchers | 1,764 |
| Contributors | **372**（`contributors` 端点分页 `rel="last"` 实测） |
| 仓库创建 | **2025-11-24** |
| 最近 push | 2026-08-08 |
| 累计提交 | **77,105** |
| git tags | **344** |
| 语言占比 | **TypeScript 89.15%**、Swift 5.09%、JavaScript 2.11%、Kotlin 2.03%、Shell 0.59%、CSS 0.38%、Python 0.32%、Go 0.12%、Rust 0.12% |
| 许可证 | **MIT**（见下方注意） |
| 仓库体积 | 2,401,665 KB（约 2.3 GB） |

> **⚠️ 一个 API 字段的坑：GitHub API 的 `license.spdx_id` 返回 `NOASSERTION`**
> （`license.key = "other"`），**但仓库根的 `LICENSE` 就是标准 MIT 全文**，
> `package.json` 的 `license` 字段也是 `"MIT"`。
> 原因是文件末尾多了一句 "Third-party notices for incorporated or adapted code are
> recorded in THIRD_PARTY_NOTICES.md."，GitHub 的许可证识别器因此判为不可识别。
> **只看 API 字段会得出「许可证不明」的错误结论。**

**代码规模（本地实查，脚本计数）：**

| 项 | 值 | 判据 |
|---|---|---|
| `src/` 非测试 TS 文件 | **7,869** | `find src -name '*.ts' ! -name '*.test.ts' \| wc -l` |
| `src/` 非测试 LOC | **1,708,978** | 同上 + `cat \| wc -l` |
| `src/` 内联测试文件 | **5,298** | `find src -name '*.test.ts'` |
| `test/` 目录测试文件 | **579** | `find test -name '*.test.ts'` |
| `src/` 顶层子目录 | **120** | `ls src/ \| wc -l` |
| `extensions/` 插件目录 | **155** | `find extensions -maxdepth 1 -mindepth 1 -type d` |
| `packages/` 内部包 | **22** | `ls packages/` |
| `skills/` 目录 | **51**（每个都有 `SKILL.md`） | `find skills -name SKILL.md` |
| `scripts/` 条目 | **571** | `ls scripts/ \| wc -l` |
| `.github/workflows/` | **82** | — |
| docs 页面（`.md`/`.mdx`） | **767** | `find docs -name '*.md' -o -name '*.mdx'` |
| `CHANGELOG.md` | **3,361,268 字节 / 17,342 行 / 117 个版本条目** | `grep -cE '^## [0-9]{4}\.'` |
| `package.json` | **116,495 字节**，**516 个 npm scripts**，64 deps / 44 devDeps | — |
| `taxonomy.yaml` | 710,477 字节 / 11,630 行 | — |
| `AGENTS.md`（根） | 66,176 字节 / 388 行（`CLAUDE.md` 是它的 symlink） | — |

> **`package.json` 有 116KB、516 个 script** 这件事值得单独记一笔——
> 这不是常规 Node 项目的形态，它把大量 CI / QA / 发布编排放进了 npm scripts。

**五次改名的完整沿革（`git log -S` 实查 `package.json` 的 `name` 字段，全部可定位到 commit）：**

| 名称 | 起始 commit | 日期 | 说明 |
|---|---|---|---|
| **warelay** | `16dfc1a` | **2025-11-24** | 首个提交就叫这个（"Add warelay CLI with Twilio webhook support"）。仓库创建同日 |
| **clawdis** | `5949ef0` | **2025-12-05** | "chore: rename package to clawdis" |
| **clawdbot** | `246adaa` | **2026-01-04** | "chore: rename project to clawdbot" |
| **moltbot** | `6d16a65` | **2026-01-27** | "refactor: rename clawdbot to moltbot with legacy compat"。**这次是被动改名**（商标请求，见下） |
| **openclaw** | `9a71607` | **2026-01-30** | "refactor: rename to openclaw"。距上次改名**只有 3 天** |

**多数第三方介绍只讲了后三个名字**（Clawdbot → Moltbot → OpenClaw），
漏掉了前两个（warelay、clawdis）。`VISION.md` 自己写的沿革也只有
"Warelay -> Clawdbot -> Moltbot -> OpenClaw" 四个——**漏了 clawdis**。
这一段是本文用 `git log -S '"name": "clawdis"'` 补上的：
它存在于 2025-12-05 到 2026-01-04 之间，约一个月。

> **改名原因属二手**：多方报道称 2026-01-27 那次是 Anthropic 就 "Clawd"/"Claude"
> 音近提出商标请求，2026-01-30 那次是创作者主动做完商标检索后的永久命名。
> **仓库里只有 commit message，没有原因说明**，所以原因这一层本文标为未核验（见文末）。

**产品形态（多入口）：**

| 入口 | 说明 |
|---|---|
| **聊天渠道** | 主入口。27 个内置渠道（§3） |
| **CLI** | `openclaw`，57 个顶层命令（§12） |
| **TUI** | `openclaw tui`，34 个斜杠命令（§13）。有 Gateway 模式与 local 模式 |
| **Control UI（Web）** | `openclaw dashboard` 打开；Gateway HTTP 服务托管 |
| **Companion apps** | `apps/` 下有 android / ios / linux / macos / macos-mlx-tts / swabble |
| **Nodes** | macOS / iOS / Android / headless 设备以 `role: node` 接入，提供摄像头 / 屏幕 / 定位等能力（§16） |
| **MCP server** | `openclaw` 可作为 MCP server 被别的 agent 调用（§17） |

**安装方式（README 实查）：**

```bash
# macOS / Linux / WSL2
curl -fsSL https://openclaw.ai/install.sh | bash

# Windows PowerShell
iwr -useb https://openclaw.ai/install.ps1 | iex

# 已自管 Node（要求 Node 22.22.3+ / 24.15+ / 25.9+）
npm install -g openclaw@latest
```

`engines.node` 实测是 `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`——
**这是个不连续区间**，把 Node 23 与 25.0–25.8 排除在外，比常见的 `>=22` 严格得多。

`docs/install/` 下有 **31 个页面**，覆盖 ansible / azure / bun / clawdock / daytona /
digitalocean / docker / fly / gcp / hetzner / hostinger / k8s / nix / oracle / podman /
railway / raspberry-pi / render / upstash 等部署路径。

---

## 2. 核心架构：Gateway 单进程控制面

OpenClaw 的架构中心是一个**常驻的 Gateway 进程**。这是它和 Claude Code / Codex CLI
最根本的形态差异：后两者是「一次会话一个进程」，OpenClaw 是「一台主机一个常驻守护进程」。

**Gateway 的职责（`docs/concepts/architecture.md` 实查）：**

- 持有**所有**消息渠道的连接（WhatsApp 走 Baileys、Telegram 走 grammY、Slack、Discord、Signal、iMessage、WebChat）
- 暴露一个**带类型的 WebSocket API**（请求 / 响应 / 服务端推送事件）
- 对入站帧做 **JSON Schema 校验**
- 发出 `agent`、`chat`、`presence`、`health`、`heartbeat`、`cron` 等事件
- 托管 canvas host：`/__openclaw__/canvas/`（agent 可编辑的 HTML/CSS/JS）与 `/__openclaw__/a2ui/`

**默认绑定 `127.0.0.1:18789`**，canvas host 复用同一端口。
**一台主机一个 Gateway**——文档明确写 "One Gateway per host; it is the only place that
opens a WhatsApp session."

**三类客户端都连同一个 WS server：**

| 角色 | 说明 |
|---|---|
| **控制面客户端** | macOS app / CLI / Web UI / 自动化。每个客户端一条 WS 连接，发 `health`/`status`/`send`/`agent` 请求，订阅 `tick`/`agent`/`presence`/`shutdown` 事件 |
| **Nodes** | 声明 `role: node` + 显式 caps/commands/permissions，暴露 `canvas.*`、`camera.*`、`screen.record`、`location.get` 等命令 |
| **WebChat** | 静态 UI，走同一套 WS API 拿历史与发送 |

**线协议（文档摘要，未实测）：**

- 传输：WebSocket，文本帧 + JSON payload
- **第一帧必须是 `connect`**
- 握手后：请求 `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`；
  事件 `{type:"event", event, payload, seq?, stateVersion?}`
- `hello-ok.features.methods` / `events` 是**发现元数据，不是所有可调用路由的自动 dump**
  （文档特意点明这一点）
- 共享密钥认证走 `connect.params.auth.token` 或 `.password`
- **副作用方法（`send`、`agent`）必须带 idempotency key** 才能安全重试，服务端有短期去重缓存
- 身份型认证模式（Tailscale Serve、非 loopback 的 `trusted-proxy`）从**请求头**满足认证，
  不走 `connect.params.auth.*`
- `gateway.auth.mode: "none"` 完全关闭共享密钥认证——文档明确要求**不要用在公网入口**

**设备配对与本地信任**：所有 WS 客户端（operator + node）在 `connect` 时带**设备身份**；
新设备 ID 需要配对审批，Gateway 随后签发**设备 token**。

**`packages/` 下 22 个内部包**，其中只有 3 个是公开发布的（其余 19 个是 `0.0.0-private`）：

| 包 | 版本 |
|---|---|
| `@openclaw/ai` | 2026.8.1（公开） |
| `@openclaw/gateway-client` | 2026.8.1（公开） |
| `@openclaw/gateway-protocol` | 2026.8.1（公开） |
| 其余 19 个（`agent-core`、`llm-core`、`plugin-sdk`、`sdk`、`net-policy`、`retry`、`terminal-core`、`tool-call-repair`、`model-catalog-core`、`memory-host-sdk`、`media-*`、`markdown-core`、`normalization-core`、`acp-core`、`workboard-contract`、`session-url-contract`、`plugin-package-contract`） | `0.0.0-private` |

> **`plugin-sdk` 是 private 这件事值得注意**：§18 会讲插件系统，
> 但**插件 SDK 包本身没有独立发布到 npm**——它随主包一起分发。

---

## 3. 内置聊天渠道：27 个（不是 47 个）

**这一节是本文最典型的「文档页数 ≠ 代码事实」案例。**

`docs/channels/` 下有 **47 个 `.md` 页面**，很容易被数成「支持 47 个渠道」。
**真实的内置渠道数是 27 个**，判据是生成物 `src/config/bundled-channel-config-metadata.generated.ts`
（290,208 字节，由 `scripts/generate-bundled-channel-config-metadata.ts` 生成）：

```python
import re
t = open('src/config/bundled-channel-config-metadata.generated.ts').read()
ids = re.findall(r'"channelId":"([^"]+)"', t)
# → 27 个，无重复；pluginId 也是 27 个不重复
```

交叉验证：`extensions/*/openclaw.plugin.json` 里带 `channels` 字段的插件**也正好是 27 个**，
渠道 id 集合与生成物完全一致。

**27 个内置渠道（按 id 字母序）：**

`buzz`、`clickclack`、`discord`、`feishu`、`googlechat`、`imessage`、`irc`、`line`、
`matrix`、`mattermost`、`msteams`、`nextcloud-talk`、`nostr`、`qa-channel`、`qqbot`、
`raft`、`reef`、`signal`、`slack`、`sms`、`synology-chat`、`telegram`、`tlon`、`twitch`、
`whatsapp`、`zalo`、`zalouser`

其中 **`qa-channel` 是唯一 `configurable: false` 的**（测试用渠道，不对用户开放配置），
所以**面向用户的内置渠道实际是 26 个**。

**那 20 个「有文档页但不是内置渠道」的是什么？** 逐页核对后分三类：

| 类型 | 页面 | 说明 |
|---|---|---|
| **外部插件渠道** | `wechat`、`wecom`、`yuanbao`、`zaloclawbot` | 通过外部插件接入（如 WeChat 走 `openclaw-weixin` 插件），**不在内置目录里** |
| **迁移 / 对照页** | `imessage-from-bluebubbles`、`matrix-migration` | 从别的实现迁过来的配置映射 |
| **跨渠道特性页** | `access-groups`、`ambient-room-events`、`bot-loop-protection`、`broadcast-groups`、`channel-routing`、`group-messages`、`groups`、`location`、`pairing`、`troubleshooting`、`index`、`discord-activities`、`matrix-presentation`、`matrix-push-rules` | 讲机制不讲某个渠道 |

**所以「27」和「47」都不算错，只是量的不是同一个东西**——
说「支持 47 个渠道」是把特性页和迁移页也算进去了。
本文之后凡提「内置渠道」一律指那 27 个。

**渠道相关的实现规模**：`src/channels/` 下有大量按关注点切分的模块
（`allowlist-match`、`bot-loop-protection`、`conversation-binding-context`、
`direct-dm-guard-policy`、`draft-preview-finalizer` …），
且**每个模块几乎都配一个同名 `.test.ts`**——这是整个仓库的一致风格（§19）。

---

## 4. 工具系统：51 个核心工具 / 11 个分区 / 13 个工具组 / 4 档 profile

**工具的单一事实源是 `src/agents/tool-catalog.ts`**（584 行）。
文件头的注释特意说明它必须保持「纯数据 + 极小的纯函数」，
因为它会被打进 Control UI 的构建产物，一旦在这里 value-import 服务端模块
就会把整个 gateway 依赖图拖进 UI 构建。

**脚本计数结果：51 个核心工具定义**，分布在 11 个分区：

```python
entries = re.findall(
    r'\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]*)",\s*description:[^}]*?'
    r'sectionId:\s*"([^"]+)",\s*profiles:\s*\[([^\]]*)\]', t, re.S)
# → 51
```

| 分区 | 数量 | 工具 |
|---|---|---|
| **sessions** | 15 | `sessions`、`sessions_list`、`sessions_history`、`sessions_search`、`sessions_send`、`sessions_spawn`、`sessions_yield`、`session_status`、`conversations_list`、`conversations_send`、`conversations_turn`、`subagents`、`spawn_task`、`dismiss_task`、`agents_wait` |
| **agents** | 7 | `agents_list`、`get_goal`、`create_goal`、`update_goal`、`update_plan`、`ask_user`、`skill_workshop` |
| **ui** | 6 | `browser`、`screen`、`terminal`、`canvas`、`show_widget`、`mobile_ui` |
| **media** | 5 | `image`、`image_generate`、`music_generate`、`video_generate`、`tts` |
| **fs** | 4 | `read`、`write`、`edit`、`apply_patch` |
| **runtime** | 3 | `exec`、`process`、`code_execution` |
| **web** | 3 | `web_search`、`x_search`、`web_fetch` |
| **nodes** | 3 | `nodes`、`computer`、`dashboard` |
| **memory** | 2 | `memory_search`、`memory_get` |
| **automation** | 2 | `cron`（显示名已改为 automations，见下）、`heartbeat_respond` |
| **messaging** | 1 | `message` |
| **gateway**（归在其他分区） | — | `gateway` |

**按 profile 统计**（同一工具可属多个 profile）：`coding` 40 个、`messaging` 14 个、`minimal` 1 个。

**4 档 tool profile**（`tools.profile`，`docs/gateway/config-tools.md` 实查）：

| Profile | 含什么 |
|---|---|
| `minimal` | **只有 `session_status`** |
| `coding` | `group:fs`、`group:runtime`、`group:web`、`group:sessions`、`group:memory`，加 `cron`、`get_goal`、`create_goal`、`update_goal`、`update_plan`、`ask_user`、`skill_workshop`、`image`、`image_generate`、`music_generate`、`video_generate` |
| `messaging` | `group:messaging` + 会话类工具 + `ask_user` |
| `full` | 无限制（等同不设） |

`coding` 与 `messaging` **额外隐式允许 `bundle-mcp`**（已配置的 MCP servers）。
本地 onboarding 在未设置时把新配置默认为 **`coding`**。

**13 个工具组**（脚本从表格数，`^\|\s*`(group:[a-z]+)`` 匹配）：

`group:runtime`、`group:fs`、`group:sessions`、`group:memory`、`group:web`、`group:ui`、
`group:automation`、`group:messaging`、`group:nodes`、`group:agents`、`group:media`、
`group:openclaw`、`group:plugins`

两个组是「元组」：**`group:openclaw`** = 上述所有内置工具**减去** `read`/`write`/`edit`/
`apply_patch`/`exec`/`process`/`canvas`（即去掉高危的文件与执行类），不含插件工具；
**`group:plugins`** = 所有已加载插件拥有的工具，含通过 `bundle-mcp` 暴露的 MCP servers。

**`bash` 是 `exec` 的别名**（文档明确写 "`bash` is accepted as an alias for `exec`"）。

**一个值得注意的设计：`spawn_task` / `dismiss_task` 的条件可见性。**
这两个工具让 coding agent **提议**后续工作而不直接启动：Control UI 把它渲染成可点的 chip，
Gateway 支持的 TUI 给等价的交互提示，接受后**新建一个 managed-worktree 会话**并把完整
prompt 发过去，当前 turn 继续跑。关键是：**只有当发起方的 operator surface 能接收并处理
Gateway 的 task-suggestion 事件时才提供这两个工具**——渠道会话与本地/嵌入式 TUI 会话
**收不到**，因为渠道传输还缺一个可移植的类型化 task action。
建议是**进程内**的，Gateway 重启即消失。

> **策略在模型调用前生效**：文档明确写 "Tool policy is enforced before the model call.
> If policy removes a tool, the model does not receive that tool's schema for the turn."
> 这一点和 Claude Code 的权限模型（工具 schema 常驻、调用时再拦）是不同取舍。

**为什么不该用 grep 数工具名**：本文第一次尝试用
`name:\s*"([a-z_]+)"\s*,\s*\n?\s*(?:description|inputSchema|parameters)`
在整个 `src/` 上扫，得到 **109 个候选**，里面混进了 CLI 命令名（`doctor`、`onboard`、`uninstall`）
和测试夹具（`failme`、`noop`、`undeclared_tool`）。
**目测或宽泛 grep 在这个仓库上必然虚高**，必须回到 `tool-catalog.ts` 这个单一事实源。

---

## 5. 权限与审批：exec 五档模式

OpenClaw 把「命令能不能跑」拆成**三个独立控制**（`docs/gateway/sandbox-vs-tool-policy-vs-elevated.md`）：

1. **Sandbox**（`agents.defaults.sandbox.*`）决定**工具在哪跑**（沙箱后端 vs 宿主）
2. **Tool policy**（`tools.*`）决定**哪些工具可用**
3. **Elevated**（`tools.elevated.*`）是**仅限 exec 的逃生舱**，在沙箱中时跳出沙箱执行

**`tools.exec.mode` 五档**（每档解析成 `security` + `ask` 两个底层值）：

| 模式 | security / ask | 行为 |
|---|---|---|
| `deny` | `deny` / `off` | 完全禁止宿主 exec |
| `allowlist` | `allowlist` / `off` | 只跑白名单命令，**未命中静默拒绝** |
| `ask` | `allowlist` / `on-miss` | 白名单命中直接跑，未命中**问人** |
| `auto` | `allowlist` / `on-miss` | 白名单命中直接跑，未命中先走**自动 review**，不能安全批准才转人工 |
| `full` | `full` / `off` | 无提示直接跑 |

**`auto` 是官方推荐默认**（"Use `auto` for coding agents that need useful host access
without making every miss a human prompt"）。`ask` 与 `auto` 共用同一套白名单设置，
差别只在 `auto` 多了个原生 auto-reviewer。

**与 Codex Guardian 的映射**：`tools.exec.mode: "auto"` 会把原生 Codex app-server 会话
推向 Guardian-reviewed 审批，典型落值 `approvalPolicy: on-request`、
`approvalsReviewer: auto_review`、`sandbox: workspace-write`。
文档明确说 **`auto` 会覆盖任何已配置的 Codex 沙箱/审批 override**，
因此**不会保留 `approvalPolicy: "never"` + `sandbox: "danger-full-access"` 这类遗留的不安全组合**——
这是个刻意的「不向后兼容不安全配置」决定。

**调试入口**：`openclaw sandbox explain`（可带 `--session` / `--agent` / `--json`）
打印生效的沙箱模式/scope/workspace 访问、当前会话是否被沙箱、
生效的沙箱工具 allow/deny **及其来源层级**、elevated 门与修复用的 key path。
另有 `openclaw exec-policy show` 看生效的 exec 策略。

`docs/tools/` 下有 `exec-approvals.md` 与 `exec-approvals-advanced.md` 两页专讲审批，
`permission-modes.md` 讲三套权限体系（OpenClaw host exec、Codex Guardian、ACPX harness）的对应关系。

---

## 6. 沙箱：4 种后端 / 3 档 mode / 3 档 scope

**三个正交设置**（`docs/gateway/sandboxing.md` 实查）：

| 设置 | key | 取值 | 默认 |
|---|---|---|---|
| Mode | `agents.defaults.sandbox.mode` | `off`、`non-main`、`all` | **`off`** |
| Scope | `agents.defaults.sandbox.scope` | `agent`、`session`、`shared` | `agent` |
| Backend | `agents.defaults.sandbox.backend` | `docker`、`podman`、`ssh`、`openshell` | `docker` |

**`non-main` 有个文档特意点明的「意外」**：它沙箱化除 agent 主会话之外的每个会话。
主会话 key 恒为 `agent:<agentId>:main`（或 `session.scope` 为 `global` 时是 `global`），
**不可配置**；而**群组/渠道会话用自己的 key，所以永远算 non-main，永远被沙箱**。
这是「为什么我在群里问它就跑不了命令」的答案。

**Scope 决定造几个容器**：`agent` = 每 agent 一个；`session` = 每会话一个；
`shared` = 所有被沙箱会话共用一个（此时**per-agent 的 docker/ssh/browser override 被忽略**）。

**非 shared 的运行时身份还包含解析后的 agent workspace 路径**——
防止「共用同一 agent/session key 的并存 workspace」互相串用 Docker / browser / SSH /
OpenShell / 插件沙箱状态。文档说明升级后首次使用会**按 workspace 限定的身份新建**运行时，
**旧的非 shared 运行时不被继承**，这是一次**刻意的一次性重置**。

**四后端能力矩阵（文档口径，未实测）：**

| 能力 | Docker/Podman | SSH | OpenShell |
|---|---|---|---|
| Shell 与子进程 | 容器内支持 | 远端主机支持 | 托管沙箱内支持 |
| 文件工具 | 走容器文件系统桥 | 走 SSH 文件系统桥 | `mirror`/`remote` 模式下走 SSH 桥 |
| workspace 访问 | `none`/`ro`/`rw` | 同 | 同 |
| 网络限制 | `docker.network`，**默认 `"none"`** | 由远端主机决定 | 由 OpenShell 策略决定 |
| **沙箱浏览器** | **支持**（独立 browser 容器） | 不支持 | 不支持 |
| 额外宿主目录 | `docker.binds`，需显式 `:ro`/`:rw` | 不支持挂载 | 不支持挂载 |
| 私有证书根 | 需 bake/mount 进镜像 | 配远端信任库 | 需在源镜像里带 |

**一条重要的边界**：沙箱后端**只隔离工具执行**，
**不把 Gateway、原生插件、控制面 RPC 移进沙箱**。
文档原文 "Native plugins remain in-process with the Gateway and share its trust boundary."
—— 也就是说**装一个原生插件等于给它 Gateway 的全部信任**（§18、§22 会再提）。

沙箱会话要用插件/MCP 工具，必须**同时**通过普通 tool policy **和** `tools.sandbox.tools`
两道门；`tools.sandbox.tools` 里要写 `bundle-mcp`（OpenClaw 托管的 MCP servers）、
具体插件 id，或 `group:plugins`。

`openclaw sandbox recreate` 用于重建，`openclaw sandbox list` / `explain` 用于查。

---

## 7. Hook 系统：两套并存（16 个内部事件 + 17 个插件钩子）

**OpenClaw 有两套 Hook，容易混淆，文档也把它们分开写在两处**
（`docs/automation/hooks.md` 与 `docs/plugins/hooks.md`）：

| | **内部 Hook（Gateway hooks）** | **插件 Hook** |
|---|---|---|
| 形态 | 事件驱动的**脚本**（带 `HOOK.md`） | **进程内**的插件代码 |
| 挂在哪 | 命令与生命周期事件 | agent/tool 生命周期与 gateway 管道 |
| 数量 | **16 个事件**（5 个族） | **17 个钩子** |
| 能否拦截 | 观察 / 注入为主 | **能拦截并改写**（`block`、`cancel`） |

**16 个内部 Hook 事件**（脚本从 `## Event types` 表格数，正则 `^\|\s*`([a-z:-]+)``）：

| 族 | 事件 |
|---|---|
| `command` | `command:new`、`command:reset`、`command:stop`、`command`（族级监听） |
| `session` | `session:auto-reset`、`session:compact:before`、`session:compact:after`、`session:patch` |
| `agent` | `agent:bootstrap` |
| `gateway` | `gateway:startup`、`gateway:shutdown`、`gateway:pre-restart` |
| `message` | `message:received`、`message:transcribed`、`message:preprocessed`、`message:sent` |

> **⚠️ 数这个数字踩过一次坑，值得记下来。** 我第一版正则写的是
> `^\|\s*`([a-z:]+)`` —— 漏掉了带连字符的 `session:auto-reset` 与 `gateway:pre-restart`，
> 数出 **14** 个。**这正是「计数必须写脚本、且脚本本身要复核」的理由**：
> 脚本不会像目测那样错得离谱，但会错在字符类这种细节上。正确值是 **16**。

Hook 可以订阅**具体 key**，也可以订阅**裸族名**（`command`/`session`/`agent`/`gateway`/`message`）
拿到该族所有 action。**OpenClaw core 不发别的事件**，所以写错名字的 hook 会静默死掉——
文档特意为此做了三层可诊断性：hook loader 会**打 warning**（举的例子就是 typo `command:nwe`）、
`openclaw hooks info <name>` 会**标记**它、并说明只有插件发自定义事件才可能触发别的名字。

**5 个内置 hook**（`src/hooks/bundled/` 实查，与文档表格一致）：

| Hook | 订阅事件 | 作用 |
|---|---|---|
| `boot-md` | `gateway:startup` | 启动时为每个配置的 agent scope 跑 `BOOT.md` |
| `bootstrap-extra-files` | `agent:bootstrap` | 注入额外 bootstrap 文件（如 monorepo 的 `AGENTS.md`） |
| `command-logger` | `command` | 把命令事件写到 `~/.openclaw/logs/commands.log` |
| `compaction-notifier` | `session:compact:before`、`session:compact:after` | 压缩开始/结束时在聊天里发可见通知 |
| `session-memory` | `command:new`、`command:reset` | `/new` 或 `/reset` 时把会话上下文存进 memory |

内置 hook **默认不开**，要 `openclaw hooks enable <hook-name>`。

**17 个插件 Hook**（脚本从 `docs/concepts/agent-loop.md` 的 Plugin hooks 表格数）：

`before_model_resolve`、`before_prompt_build`、`before_agent_reply`、`agent_end`、
`before_compaction`、`after_compaction`、`before_tool_call`、`after_tool_call`、
`before_install`、`tool_result_persist`、`message_received`、`message_sending`、
`message_sent`、`session_start`、`session_end`、`gateway_start`、`gateway_stop`

几个值得单独记的语义：

- **`before_model_resolve`** 在 session 加载**之前**跑（拿不到 `messages`），
  用途是**确定性地**覆盖 provider/model
- **`before_prompt_build`** 在 session 加载后跑（有 `messages`），可注入
  `prependContext` / `systemPrompt` / `prependSystemContext` / `appendSystemContext`；
  在支持 turn-scoped 工具面的 runtime 上还能用 `toolsAllow` **收窄**本轮工具。
  空 `toolsAllow` = 不提交任何可选工具；省略 = 不改。
  **不支持的 runtime 会拒绝收窄值而不是静默忽略它**——这个设计取向值得注意
- **`before_agent_reply`** 在 LLM 调用**前**，插件可以**接管这一轮**，返回合成回复或让它静默
- **`tool_result_persist`** **同步**改写工具结果，然后才写入 OpenClaw 自己的 transcript

**三条拦截决策规则**（文档明确列出，语义是「终态 + 无操作」而不是「后写覆盖先写」）：

- `before_tool_call`：`{block: true}` 是**终态**，停掉更低优先级的 handler；
  `{block: false}` 是**无操作**，**不会清除**之前的 block
- `before_install`：同上语义。但文档明确说**运营方的安装 allow/block 决策要用
  `security.installPolicy`，不要用 `before_install`**——因为前者能覆盖 CLI 安装与更新路径
- `message_sending`：`{cancel: true}` 终态，`{cancel: false}` 无操作

---

## 8. 记忆架构：五层 tier + 一个插件槽

OpenClaw 的记忆基础形态是**工作区里的纯 Markdown 文件**
（默认 `~/.openclaw/workspace`）。文档原文："The model only remembers what gets saved
to disk; there is no hidden state."

**四个记忆文件：**

| 文件 | 内容 | 加载时机 |
|---|---|---|
| `USER.md`（可选） | 稳定偏好、沟通风格、关系、活跃项目上下文，**写成指令式**（directives） | 会话开始，**独立小预算** |
| `MEMORY.md` | 长期记忆。持久的非画像类事实与决策 | 会话开始 |
| `memory/YYYY-MM-DD.md`（或带 slug） | 每日笔记 | 裸 `/new`/`/reset` 时自动加载**今天与昨天** |
| `DREAMS.md`（可选） | Dream Diary 与 dreaming sweep 摘要，**供人读** | 不注入 |

**五层 tier 模型**（`docs/concepts/memory-architecture.md`）：

| Tier | 载体 | 谁写 | 是否注入 |
|---|---|---|---|
| Instructions | `AGENTS.md` 与工作区指令文件 | **仅人类** | 总是，会话开始 |
| Curated core | `MEMORY.md`、`USER.md` | dreaming 整合；用户直接要求 | 总是，会话开始，**带预算** |
| Episodic | `memory/YYYY-MM-DD.md`、会话 transcript | agent 工作时；memory flush；transcript 捕获 | **从不**；按需可搜 |
| Prospective | standing intents（SQLite）与 cron jobs | `intent` 工具；定时任务 | 仅触发时 |
| Review | `DREAMS.md`、dreaming 报告 | dreaming 阶段 | **从不**；供人读 |

**最重要的边界是 curated core 与 episodic 之间**：curated 文件小、常驻上下文、
只能通过**带门的整合**写入；episodic 文件大、可追加、只能通过显式搜索工具或升级通道触达。
**不通过 promotion gate，任何东西都不能从 episodic 进 curated。**

**两条 recall 通道**：Lane 1 **always on、零模型调用**；Lane 2 是**升级**通道。

**Memory 是一个「只能装一个」的插件槽**（`VISION.md` 明确写
"Memory is a special plugin slot where only one memory plugin can be active at a time"）。
仓库里有 4 个 memory 相关 extension：`memory-core`、`memory-lancedb`、`memory-wiki`、
`active-memory`，文档另有 `memory-honcho`、`memory-qmd`、`memory-builtin` 三种后端页。
`VISION.md` 说未来计划**收敛到一个推荐默认**。

**Dreaming** 是它比较独特的一层：`docs/concepts/dreaming.md` 讲的是**带门的整合**
（consolidation with gates），配置在 `plugins.entries.memory-core.config.dreaming`。
它在 CHANGELOG 里**最早出现于 `2026.4.5`**，被 30 个版本条目提到。

> **命名变更留痕**：Control UI 里的 "Memory Palace browser" 已在 2026-07-29
> 改名为 **Memory Wiki**（commit `#115954`）。引用旧名的资料会对不上 UI。

---

## 9. Skills 系统：6 层优先级 + 51 个内置

**6 层加载优先级**（最高优先级在前，同名 skill 高层胜出）：

| 优先级 | 来源 | 路径 |
|---|---|---|
| 1（最高） | Workspace skills | `<workspace>/skills` |
| 2 | Project agent skills | `<workspace>/.agents/skills` |
| 3 | Personal agent skills | `~/.agents/skills`（仅默认 state） |
| 4 | Managed / local skills | `<state-dir>/skills` |
| 5 | Bundled skills | 随安装分发 |
| 6（最低） | Extra directories | `skills.load.extraDirs` + 插件 skills |

**发现规则**：只要 `SKILL.md` 出现在任一配置 root 下（**最深 6 层**）就会被发现；
**文件夹路径只用于组织，不参与命名**——skill 名与斜杠命令来自 `name` frontmatter
（缺失时用目录名），agent allowlist 也按这个 `name` 匹配。

**51 个内置 skill**（`find skills -name SKILL.md | wc -l` = 51，与目录数一致）：

`1password`、`apple-notes`、`apple-reminders`、`bear-notes`、`blogwatcher`、`blucli`、
`camsnap`、`clawhub`、`coding-agent`、`diagram-maker`、`eightctl`、`gemini`、`gh-issues`、
`github`、`gifgrep`、`gog`、`goplaces`、`healthcheck`、`himalaya`、`mcporter`、`meme-maker`、
`model-usage`、`nano-pdf`、`node-connect`、`node-inspect-debugger`、`notion`、`obsidian`、
`openai-whisper`、`openai-whisper-api`、`openhue`、`oracle`、`ordercli`、`peekaboo`、
`python-debugpy`、`sag`、`session-logs`、`sherpa-onnx-tts`、`skill-creator`、`songsee`、
`sonoscli`、`spike`、`spotify-player`、`summarize`、`taskflow`、`taskflow-inbox-triage`、
`things-mac`、`tmux`、`trello`、`video-frames`、`weather`、`xurl`

**这个清单本身就说明了产品定位**（§1）：`apple-notes`、`spotify-player`、`sonoscli`、
`openhue`、`things-mac`、`weather` 这类**根本不是编程工具**——
它们是「个人助理」要用的东西。对比 Claude Code 的 skill 生态，重心完全不同。

> **官方方向是「不再往 core 加 skill」**：`VISION.md` 的 "What We Will Not Merge" 第一条就是
> "New core skills when they can live on ClawHub"，
> 并说 "We still ship some bundled skills for baseline UX. New skills should be published
> through ClawHub first."（§18 讲 ClawHub）

**Token 成本是文档里少见地给了确定公式的地方**：

- 有 1+ 个 eligible skill 时才有**固定基础开销**（intro prose + `<available_skills>` 包装）
- **每个 skill ≈ 97 字符** + `name`/`description`/`location` 的长度
- 按 ~4 字符/token 算，**97 字符 ≈ 24 token/skill**（未计字段长度）
- 超出 `skills.limits.maxSkillsPromptChars` 时的降级顺序是：
  **先保住尽可能多的 skill 身份**（name/location/version，用无描述的紧凑格式），
  **再用剩余预算放缩短的描述**，没预算就**省略描述**；
  且提示里会带一句指向 `openclaw skills check` 的说明

**Codex 的 skill 目录不通用**：文档明确写 `$CODEX_HOME/skills` **不是** OpenClaw 的 skill root，
要用 `openclaw migrate plan codex` 盘点、`openclaw migrate codex` 复制过来。

---

## 10. 配置系统：JSON5 + `$include` + 5 层环境变量优先级

**配置文件**：`~/.openclaw/openclaw.json`（可被 `OPENCLAW_CONFIG_PATH` 覆盖），
格式是 **JSON5**（可带注释与尾逗号）。状态目录默认 `~/.openclaw`（`OPENCLAW_STATE_DIR` 可改）。

**`$include` 机制**（`docs/gateway/configuration.md` 实查）——这是它配置系统里最有意思的部分：

- **单文件**：替换所在对象
- **文件数组**：按顺序**深合并**（后者胜），最深 **10 层**嵌套
- **同级 key**：在 include **之后**合并（覆盖被 include 的值）
- **相对路径**：相对于**引用它的那个文件**解析
- 路径不得含 null 字节，解析前后都必须 **< 4096 字符**

**写回（write-through）的行为定义得很细**，这是个容易踩的地方：

- 当一次写只改动**一个**由**单文件 include** 支撑的顶层 section
  （如 `plugins: { $include: "./plugins.json5" }`），OpenClaw **更新那个被 include 的文件**，
  `openclaw.json` 保持不动
- **不支持写回的三种形态**：root include、include 数组、带同级覆盖的 include。
  这三种**fail closed**（直接失败），**而不是把配置拍平**

> **「fail closed 而不是拍平」是个正确但少见的选择**——拍平会静默毁掉用户的配置组织结构，
> 报错只是让这次写失败。同类工具在这里更常见的是静默重写整个文件。

**路径限制（confinement）**：`$include` 必须解析到 `openclaw.json` 所在目录**之下**；
要跨机器/用户共享配置树，得设 `OPENCLAW_INCLUDE_ROOTS`（POSIX 用 `:`，Windows 用 `;` 分隔）。
**符号链接会被解析后再检查**——所以「字面上在配置目录里、真实目标逃出所有允许 root」的路径
仍会被拒。

**热重载**：文档区分了 reload 模式、**哪些热生效 / 哪些需要重启**、以及 reload planning。
另有 **Config RPC** 供程序化更新。

**5 层环境变量优先级**（`docs/help/environment.md`，高到低）：

1. **进程环境**（Gateway 从父 shell/daemon 继承的）
2. **cwd 的 `.env`**（dotenv 默认，**不覆盖**已有值；**provider 凭据与受保护的运行时控制项会被忽略**）
3. **全局 `.env`**（`~/.openclaw/.env`，**推荐放 provider API key**；不覆盖，
   例外是 OpenClaw 托管的 systemd service 记录值）
4. **配置里的 `env` 块**（**仅当缺失时**才应用）
5. **可选的登录 shell 导入**（`env.shellEnv.enabled` 或 `OPENCLAW_LOAD_SHELL_ENV=1`，
   **只补缺失的期望 key**）

Ubuntu 全新安装若用默认 state dir，`~/.config/openclaw/gateway.env` 会作为全局 `.env`
**之后**的兼容回退；**两者冲突时保留 `~/.openclaw/.env` 并打 warning**。

**环境变量的文档化程度是个短板，需要照实写：**

| 项 | 数 | 判据 |
|---|---|---|
| 源码里出现的 `OPENCLAW_*` | **834** | `grep -rhoE 'OPENCLAW_[A-Z0-9_]+' src/ \| sort -u \| wc -l` |
| 文档标为「operator-facing 支持契约」的 | **30** | 从 `docs/help/environment.md` 的 supported 段落数 |

文档为此写了免责：**"Undocumented `OPENCLAW_*` variables are internal implementation
details and may disappear without notice."** ——
这个态度本身是清楚的，但**834 : 30 的比例意味着源码里绝大多数环境变量是不可依赖的**，
读源码时看到一个 `OPENCLAW_XXX` 不能假设它是稳定接口。

**严格校验**：文档有专门的 "Strict validation" 一节。
`VISION.md` 里有一条相关的产品纪律值得引："OpenClaw runtime code reads the current
configuration schema only. We do not keep long-lived aliases or compatibility branches
that silently accept old, renamed, or malformed config keys."
配套要求是：**任何让已有配置失效的改动，同一个改动必须带一个 doctor migration**，
`openclaw doctor --fix` 要能识别旧形态、解释它、必要时备份、并重写成规范格式。

---

## 11. Agent runtime：四层概念 + 两个 runtime 家族

**OpenClaw 把「谁在跑这一轮」拆成四层**，文档特意为此写了一张表
（`docs/concepts/agent-runtimes.md`），因为 provider 与 runtime 极易混淆：

| 层 | 例子 | 含义 |
|---|---|---|
| **Provider** | `anthropic`、`github-copilot`、`openai` | OpenClaw 如何认证、发现模型、命名 model ref |
| **Model** | `claude-opus-4-6`、`gpt-5.6-sol` | 本轮选中的模型 |
| **Agent runtime** | `claude-cli`、`codex`、`copilot`、`openclaw` | 执行这一轮的底层循环/后端 |
| **Channel** | Discord、Slack、Telegram、WhatsApp | 消息进出的地方 |

**"harness" 是实现 agent runtime 的代码术语**（如内置 Codex harness 实现 `codex` runtime）。
公开配置用**模型或 provider 条目上的 `agentRuntime.id`**；
**整 agent 级别的 runtime key 是遗留的、会被忽略**，`openclaw doctor --fix` 负责
移除旧的整 agent runtime pin 并把 legacy runtime model ref 重写成规范 provider/model ref。

**两个 runtime 家族：**

- **Embedded harness**：跑在 OpenClaw 自己的 prepared agent loop 里——
  内置 `openclaw` runtime，加上注册的插件 harness（如 `codex`、`copilot`）
- **CLI backend**：跑一个**本地 CLI 进程**，同时保持 model ref 规范。
  例：`anthropic/claude-opus-5` 配 model-scoped `agentRuntime.id: "claude-cli"`
  意思是「选 Anthropic 的模型，通过 Claude CLI 执行」。
  **`claude-cli` 不是 embedded harness id，不能传给 AgentHarness 选择逻辑**

> **这意味着 OpenClaw 可以把 Claude Code / Codex / Copilot CLI 当作后端来驱动**——
> 它不只是「另一个 agent」，也是一个**能编排别的 agent CLI 的外层**。
> §17 的 ACP 是同一思路的另一条路径。

**"Codex" 这个词在 OpenClaw 里指五个不同的东西**，文档专门列表消歧：

| 表面 | OpenClaw 里的名字/配置 | 干什么 |
|---|---|---|
| 原生 Codex app-server runtime | `openai/*` model ref | 通过 Codex app-server 跑 OpenAI embedded agent 轮次（常见的 ChatGPT/Codex 订阅设置） |
| Codex OAuth auth profile | `openai` OAuth profiles | 存 ChatGPT/Codex 订阅认证 |
| Codex ACP adapter | `runtime: "acp"` + `agentId: "codex"` | 通过外部 ACP/acpx 控制面跑 Codex |
| 原生 Codex 聊天控制命令集 | `/codex ...` | 从聊天里绑定/恢复/steer/停止/检查 Codex app-server 线程 |
| OpenAI Platform API 路径 | `openai/*` + API key | 直连 OpenAI 的 images / embeddings / speech / realtime |

**这五个表面是刻意互相独立的**。CHANGELOG 里 `Codex` 被 **73 个版本条目**提到
（最早 `2026.1.8`），是被提及最多的主题之一。

**Model failover 分两阶段**（`docs/concepts/model-failover.md`）：

1. **当前 provider 内的 auth profile 轮转**
2. **fallback 到 `agents.defaults.model.fallbacks` 的下一个模型**

几个具体规则：

- 候选链的构建**取决于选择来源**：配置默认值、cron job primary、自动选择的 fallback
  **可以**用配置的 fallbacks；而**用户显式的会话选择是 strict 的**（不 fallback）
- 胜出的 fallback **只用于当前这一轮**，**不改变会话已选的 provider/model**
- **纯 overload 耗尽**时（每个候选都只因过载失败、且尚无工具执行或助手输出开始），
  会**重试整个 turn-local 链最多 10 次**，指数退避；**30 秒后发一次状态通知**，
  避免用户干等
- 全部候选失败则抛 `FallbackSummaryError`，带每次尝试的细节与已知的最早 cooldown 到期时间
- 有 **auth failure skip cache** 与 **cooldown** 机制；
  还有 **session stickiness（cache-friendly）** ——
  这是为了不破坏 prompt cache 而刻意做的粘性

---

## 12. CLI：57 个顶层命令

**单一事实源是 `src/cli/command-catalog.ts`**（629 行，声明式的启动策略与快路径路由表）。
脚本从 `commandPath: [...]` 数出 **117 个 catalog 条目、57 个不重复的顶层命令**：

`acp`、`agent`、`agents`、`approvals`、`automations`、`backup`、`channels`、`chat`、
`commitments`、`completion`、`config`、`configure`、`crestodian`、`cron`、`daemon`、
`dashboard`、`devices`、`directory`、`docs`、`doctor`、`exec-approvals`、`exec-policy`、
`fleet`、`gateway`、`health`、`hooks`、`logs`、`mcp`、`memory`、`message`、`migrate`、
`models`、`node`、`nodes`、`onboard`、`pairing`、`plugins`、`proxy`、`qa`、`qr`、`reset`、
`secrets`、`security`、`sessions`、`setup`、`skills`、`status`、`system`、`tasks`、
`terminal`、`tool`、`tools`、`tui`、`uninstall`、`update`、`worker`、`worktrees`

（`docs/cli/` 下有 **66 个非 index 页面**，与 57 不完全对应——
文档页包含 `clawbot` 这类遗留命名空间页与若干拆分页。）

**catalog 里每个命令带的策略字段**很能说明启动性能是被认真对待的：

| 字段 | 作用 |
|---|---|
| `configGuard` | `run` / `skip` / `when-suppressed` |
| `loadPlugins` | `never` / `always` / `text-only` / 或一个按 argv 判断的函数 |
| `pluginRegistry.scope` | `all` / `channels` / `configured-channels` / `memory` |
| `ownsProtocolStdout` | 该命令是否独占 stdout（供 JSON/协议输出） |
| `hideBanner` | 是否隐藏 banner |
| `ensureCliPath` | — |
| `networkProxy` | `default` / `bypass` |

**`loadPlugins: "never"` 这类声明的意义是：不是每个 CLI 命令都要把 155 个 extension 拉起来。**
仓库里还有 `src/entry.version-fast-path.ts`、`src/entry.root-help-fast-path.ts`、
`src/entry.compile-cache.ts` 这些专门的快路径模块——
说明 `openclaw --version` / `--help` 这类高频调用被单独优化过。

**快速开始三条命令**（README）：

```bash
openclaw onboard --install-daemon   # 验证模型访问、创建 workspace、配置 Gateway
openclaw gateway status
openclaw dashboard                  # 打开 Control UI
```

`openclaw doctor --fix` 是配置修复的统一入口（§10 提到的 migration 契约）。
`crestodian` 这个命令名来自被改名的 system agent——2026-07-14 的
`feat(setup): rename Crestodian to OpenClaw system agent` 把它改成了 OpenClaw system agent，
但命令名保留着。

---

## 13. TUI：34 个斜杠命令 + 两种连接模式

`openclaw tui` 有**两种模式**（`docs/web/tui.md`）：

- **Gateway 模式**：连到常驻 Gateway
- **Local 模式**：本地起

**34 个斜杠命令**（脚本从 `## Slash commands` 段落数，正则 `` `(/[a-z][a-z0-9-]*) ``）：

`/abort`、`/activation`、`/agent`、`/agents`、`/auth`、`/btw`、`/context`、`/elev`、
`/elevated`、`/exit`、`/fast`、`/gateway-status`、`/goal`、`/gwstatus`、`/help`、`/model`、
`/models`、`/new`、`/openclaw`、`/queue`、`/quit`、`/reasoning`、`/reset`、`/session`、
`/sessions`、`/settings`、`/side`、`/status`、`/steer`、`/stop`、`/think`、`/trace`、
`/usage`、`/verbose`

（其中 `/elev`+`/elevated`、`/gateway-status`+`/gwstatus`、`/exit`+`/quit` 是别名对，
所以**不同功能约 31 个**。）

注意 **`docs/tools/slash-commands.md` 只列了 5 个**（`/dreaming`、`/pair`、`/voice`、
`/card`、`/codex`）——那一页讲的是**插件/特性提供的聊天命令**，不是 TUI 命令全集。
**这是本文第二处「文档页容易被数错」的地方**（第一处是渠道，§3）。

TUI 文档还覆盖：键盘快捷键、picker/overlay、发送与投递语义、
**本地 shell 命令**（`## Local shell commands`）、工具输出渲染、
**终端颜色**、历史与流式、连接细节。

`openclaw` 这个斜杠命令（`/openclaw`）是「OpenClaw setup and repair helper」，
即在 TUI 里跑安装修复。
CHANGELOG 里 `TUI` 被 **67 个版本条目**提到（最早 `2026.1.8`），是长期在改的表面。

---

## 14. Agent loop：串行化的 per-session 运行

**agent loop 是「把一条消息变成动作与回复」的串行化 per-session 运行**：
intake → 上下文组装 → 模型推理 → 工具执行 → 流式 → 持久化。

**入口只有两个**：Gateway RPC 的 `agent` / `agent.wait`，以及 CLI 的 `openclaw agent`。

**运行序列（`docs/concepts/agent-loop.md` 实查，5 步）：**

1. `agent` RPC 校验参数、解析会话（`sessionKey`/`sessionId`）、持久化会话元数据，
   **立即返回 `{runId, acceptedAt}`**（异步）
2. `agentCommand` 跑这一轮：解析 model + thinking/verbose/trace 默认值、加载 skills 快照、
   调 `runEmbeddedAgent`，并在嵌入循环没发生命周期事件时**补发一个 fallback 的 end/error**
3. `runEmbeddedAgent`：**通过 per-session 与全局队列串行化**、解析 model + auth profile、
   构建 OpenClaw session、订阅运行时事件、流式 assistant/tool delta、
   **强制 run timeout（到期 abort）**。对 Codex app-server 轮次，
   还会 abort「已接受但在终止事件前停止产出 app-server 进度」的轮次
4. `subscribeEmbeddedAgentSession` 把运行时事件桥接到 `agent` 流：
   tool 事件 → `stream:"tool"`，assistant delta → `stream:"assistant"`，
   生命周期 → `stream:"lifecycle"`（`phase: start|end|error`）
5. `agent.wait`（`waitForAgentRun`）等某个 `runId` 的 lifecycle end/error，
   返回 `{status: ok|error|timeout, startedAt, endedAt, error?}`

**并发模型**：运行按 **session key（session lane）串行化**，可选再过一个全局 lane，
防止 tool/session 竞态。**Transcript 写入由 per-session lane 与 SQLite writer queue 双重串行化**，
每次 append 或 rewrite **在其同步提交事务内校验当前会话身份**——
所以**一个过期的 run 无法覆盖更新的会话世代**。

**会话写锁**：写锁在流式开始前获取；
文档明确要求**任何后续的 transcript rewrite / 压缩 / 截断路径都必须拿同一把锁**才能改 SQLite 行。

**4 种队列模式**（`/queue`，控制「会话已有活跃 run 时，新入站消息怎么办」）：

| 模式 | 行为 |
|---|---|
| `steer` | 注入活跃 runtime。**在当前 assistant 轮次执行完它的工具调用之后、下一次 LLM 调用之前**投递所有待 steer 消息；Codex app-server 收到一个批量 `turn/steer`。若未在流式或不支持 steer，则等当前 run 结束再起 prompt |
| `followup` | 不 steer，每条消息入队，等当前 run 结束后作为后续轮次 |
| `collect` | 不 steer，把排队消息**合并成单个** followup 轮次（静默窗口后）。**若消息指向不同渠道/线程则各自 drain**，以保持路由 |
| `interrupt` | **abort 该会话的活跃 run**，然后跑最新那条消息 |

配置在 `messages.queue`，支持 `debounceMs`、`cap`、`drop: "summarize"`、
以及 `byChannel` 的**按渠道覆盖**（如 `{discord: "collect"}`）。

**超时与卡死诊断**：文档有独立的 `## Timeouts` 与 `### Stuck session diagnostics` 两节，
以及 `## Where things can end early`——即「这一轮可能在哪些地方提前结束」。

---

## 15. 上下文压缩：safeguard 模式 + 可插拔 provider

**压缩的基本流程**：把较早的对话轮次总结成一个紧凑条目 → 摘要存入会话 transcript →
保留近期消息。**完整历史留在磁盘上**，压缩只改变「下一轮模型看到什么」。

**工具块配对保护**：OpenClaw 选压缩切分点时**让 assistant 工具调用与它对应的 `toolResult`
保持配对**；如果切点落在工具块内部，**它会移动边界**以保住这一对，并保留当前未总结的尾部。

**新配置默认 `agents.defaults.compaction.mode: "safeguard"`**
（更严的护栏 + 摘要质量审计），要退回旧行为得显式设 `mode: "default"`。

**自动压缩默认开**，触发条件有两个：会话接近上下文上限，
**或**模型返回上下文溢出错误（此时压缩后重试）。
`agents.defaults.compaction.enabled: false` 只关掉**嵌入运行时的主动阈值压缩**——
**preflight 与 overflow-recovery 两条路径仍在**，手动 `/compact` 也仍可用。

**压缩前会自动提醒 agent 把重要笔记存进 memory 文件**，以防上下文丢失（§8）。

**用不同模型做压缩**：`agents.defaults.compaction.model` 可设成 `provider/model-id`
或 `agents.defaults.models` 下的裸别名。几个解析细节值得记：

- 裸别名在压缩开始前解析成规范 provider + model
- **若一个裸值同时匹配别名和已配置的字面 model ID，字面 ID 胜**
- 未匹配的裸值仍被当作**当前 provider 上的 model ID**
- 未设置时用当前会话模型；**若总结因「可 fallback 的 provider 错误」失败，
  会通过会话已有的 model fallback 链重试这次压缩**，
  且**这个 fallback 选择是临时的、不写回会话状态**
- **显式设了 `compaction.model` 的则保持精确，不继承会话 fallback 链**

**标识符保护**：压缩总结**默认保留不透明标识符**（`identifierPolicy: "strict"`），
可设 `"off"` 关掉。自定义指引应放进 compaction provider 的 `summarize()` 实现里。

其他相关机制：**active transcript byte guard**、**successor transcripts**、
**compaction notices**、**memory flush**、**可插拔 compaction provider**，
以及 `## Compaction vs pruning`（压缩与剪枝是两件事）。
`docs/concepts/session-pruning.md` 与 `docs/reference/session-management-compaction.md` 是配套页。

**溢出错误识别**：文档说它匹配「几十种 provider 特定的溢出错误串」
（Anthropic、OpenAI、Bedrock、Gemini、Ollama、OpenRouter 等），
举例包括 `request_too_large`。

---

## 16. Nodes：把设备能力挂进来

**Node 是以 `role: node` 连到同一个 Gateway WS 的设备**，
在 `connect` 里声明**显式的 caps / commands / permissions**。

**Node 暴露的命令族**（`docs/concepts/architecture.md`）：
`canvas.*`、`camera.*`、`screen.record`、`location.get`。

`docs/nodes/` 下 **12 页**：`audio`、`camera`、`computer-use`、`images`、`location-command`、
`media-playback`、`media-understanding`、`presence`、`talk`、`troubleshooting`、`voicewake`、`index`。

**对应的工具是 `nodes` 与 `computer`**（`group:nodes`，§4）。
`computer` 是 computer-use 类工具；extensions 里有 `cua-computer` 这个 extension。

**companion apps（`apps/` 实查 7 个目录）**：
`android`、`ios`、`linux`、`macos`、`macos-mlx-tts`、`shared`、`swabble`。
其中 `macos-mlx-tts` 说明 macOS 端有基于 MLX 的本地 TTS。
语言占比里 **Swift 5.09% + Kotlin 2.03%** 就是这些 app 的体量
（§1 —— 这也是为什么这个仓库不是纯 TypeScript 项目）。

`docs/platforms/` 下 13 页覆盖 android / chromeos / ios / ios-healthkit / linux / macos /
windows / raspberry-pi 等，另有 `mac/` 子目录。

**配对是设备级的**：新设备 ID 需审批，审批状态存在 device pairing store，
Gateway 随后签发 device token（§2）。
`openclaw devices` 有「为持久的人类友好设备名」而加的 rename 命令
（`#94517`，2026-07-10）。

---

## 17. MCP 与 ACP：双向、多路径

### MCP

**OpenClaw 在 MCP 上是双向的**——既能当 server 被别人调，也能当 client 调别人：

**作为 MCP server（`openclaw mcp serve`）**：
把「渠道支撑的会话」暴露给 MCP 客户端。一个会话会出现的条件是
OpenClaw 已有带已知路由的会话状态（`channel` + 收件人/目标元数据 + 可选 `accountId` / `threadId`）。

暴露的能力：列出近期路由会话、读近期 transcript 历史、
**等待新的入站事件**、通过同一路由回复、看桥接期间到达的审批请求。

标准 MCP 工具集是：`conversations_list`、`messages_read`、`events_poll`、`events_wait`、
`messages_send`，加审批类工具。

**两种客户端模式**：generic MCP client（只有标准工具）、
Claude Code（标准工具 + Claude 专属渠道适配器，`--claude-channel-mode on`，默认 `auto`）。

> **文档里一句诚实的话值得引**："Today, `auto` behaves the same as `on`.
> There is no client capability detection yet." ——
> 这是**把「还没做」写进文档**而不是含糊过去，本文乐于记录这种写法。

**作为 MCP client registry**：支持**保存的 MCP server 定义**，
四种传输（**stdio**、**SSE/HTTP**、**streamable HTTP**、带 **OAuth workflow**），
有 Control UI 管理面，还有 **MCP Apps** 一节。
配置的 MCP servers 以插件拥有的工具形式暴露在 **`bundle-mcp`** 这个插件 id 下（§4、§6）。

文档有专门的 `### Security and trust boundary` 一节，以及 `## Choose the right MCP path`——
后者存在的原因是 `VISION.md` 的一条纪律："The project goal is pragmatic MCP support
without duplicating existing agent, tool, ACPX, plugin, or ClawHub paths."
"What We Will Not Merge" 里也明确列了
"MCP work that duplicates existing MCP, ACPX, plugin, or ClawHub paths"。

### ACP / ACPX

**ACP（Agent Client Protocol）是把外部 agent 当 harness 驱动的路径**（§11）。
`docs/tools/acp-agents.md` 有 `## Supported harness targets`、
`## ACP versus sub-agents`、`## How ACP runs Claude Code` 等章节——
**它能把 Claude Code 当被驱动的 agent 跑**。

**ACP 有持久的渠道绑定**（`## Persistent channel bindings`）与
**bound sessions**（当前会话绑定、per-agent runtime 默认值），
权限模型独立于 OpenClaw host exec（§5 的三套权限体系之一）。
extensions 里对应的是 `acpx`（默认启用）。

CHANGELOG 里 `ACP` 被 **58 个版本条目**提到（最早 `2026.1.20`），
`MCP` 被 **44 个**提到（最早 `2026.2.21`）——**ACP 比 MCP 早两个月进来，且被改得更频繁**。

---

## 18. 插件系统：155 个 extensions / 20 类契约 / ClawHub

**插件是 OpenClaw 的主要扩展面，且官方明确希望 core 变瘦、插件变多。**
`VISION.md`："Core stays lean; optional capabilities should usually ship as plugins.
We are generally slimming down core while expanding what plugins can do."

**它给出的理由是一个很清楚的成本模型，值得原样记下：**

> "Two layers, two bars. The core carries a per-call tax: each core tool, prompt line,
> and config key reaches every operator on every model request, so additions there face
> the strictest scrutiny. Plugins, skills, channels, and apps carry no such tax,
> and we want that surface to keep growing."

**并且它把「什么时候该定契约」也写成了纪律**：
"Recurring demand defines interfaces. Once several independent PRs or requests wire in
the same kind of capability, the right response is a contract, not a queue of merges."

**两种插件风格：**

| 风格 | 说明 | 何时用 |
|---|---|---|
| **Code plugin** | 跑 OpenClaw 插件代码 | 需要运行时 hook、provider、渠道、工具等**进程内扩展点** |
| **Bundle-style plugin** | 打包稳定的外部表面（skills、MCP servers、相关配置） | **优先选这个**——接口更小更稳，安全边界更好 |

**155 个 extensions 实查**（`find extensions -maxdepth 1 -mindepth 1 -type d`），
其中 **151 个有 `openclaw.plugin.json` 清单**，4 个没有。
**82 个 `enabledByDefault: true`**，69 个不是默认开。

**清单里出现的契约种类（脚本从 151 个清单的 `contracts` 键统计，20 类）：**

| 契约 | 插件数 |
|---|---|
| `tools` | 27 |
| `mediaUnderstandingProviders` | 18 |
| `speechProviders` | 16 |
| `videoGenerationProviders` | 15 |
| `webSearchProviders` | 15 |
| `imageGenerationProviders` | 11 |
| `usageProviders` | 10 |
| `memoryEmbeddingProviders` | 8 |
| `musicGenerationProviders` | 5 |
| `realtimeTranscriptionProviders` | 5 |
| `transcriptSourceProviders` | 4 |
| `migrationProviders` | 3 |
| `realtimeVoiceProviders` | 3 |
| `embeddingProviders` / `workerProviders` | 2 / 2 |
| `documentExtractors`、`webFetchProviders`、`webContentExtractors`、`agentToolResultMiddleware`、`gatewayMethodDispatch` | 各 1 |

**清单顶层键的分布也能说明扩展面有多宽**（出现次数 / 151）：
`id` 151、`activation` 151、`configSchema` 151、`enabledByDefault` 85、
`contracts` 82、`name` 78、`description` 77、`setup` 69、
**`providers` 57**、`providerAuthChoices` 57、`modelCatalog` 47、`icon` 45、`uiHints` 38、
`providerRequest` 31、**`channels` 27**、`providerEndpoints` 23、`commandAliases` 18、
`mediaUnderstandingProviderMetadata` 17、`skills` 15、`modelPricing` 14、
`providerCatalogEntry` 14、`configContracts` 12、`toolMetadata` 8、
`modelIdNormalization` 7、`providerAuthAliases` 7、`catalog` 7、`syntheticAuthRefs` 6、
`nonSecretAuthMarkers` 6、`channelConfigs` 5、`autoEnableWhenConfiguredProviders` 5、
`cliBackends` 2、`qaRunners` 2、`legacyPluginIds` 2、`secretProviderIntegrations` 2、
`kind` 2、`version` 2、`requiresPlugins` 1、`dashboard` 1、`enabledByDefaultOnPlatforms` 1

**插件文档规模**：`docs/plugins/` 下 **57 个页面 + `reference/` 子目录 146 个页面**——
是整个 docs 里最大的一块（205 个 md，§1）。
SDK 页按表面切分得很细：`sdk-overview`、`sdk-agent-harness`、`sdk-channel-inbound`、
`sdk-channel-ingress`、`sdk-channel-message`、`sdk-channel-outbound`、`sdk-channel-plugins`、
`sdk-channel-turn`、`sdk-entrypoints`、`sdk-provider-plugins`、`sdk-runtime`、`sdk-setup`、
`sdk-subpaths`、`sdk-testing`、`sdk-migration`。

**插件工具的注册方式**：`api.registerTool(...)` + 清单的 `contracts.tools`。

**分发路径**：官方偏好 **npm 包分发 + 本地 extension 加载（供开发）**。
`VISION.md` 明确说 **"If you build a plugin, host and maintain it in your own repository.
The bar for adding optional plugins to core is intentionally high."**

### ClawHub

**ClawHub（clawhub.ai）是插件与 skill 的发现/发布平台**，
承载「发现、官方发布者身份、provenance、安全审查」。

**发布是 owner-scoped 的**：每次发布都指向一个 publisher，服务端决定登录用户能否发到那里。
owner 是 ClawHub 的 publisher handle（如 `@alice`、`@openclaw`）；
每个用户有个人 owner，组织 owner 可以有多个成员，角色分 `owner` / `admin` / `publisher`。
Skill 从 skill 文件夹发布（`clawhub skill publish <path>`），
公开页面是 `https://clawhub.ai/<owner>/<slug>`。

CHANGELOG 里 `ClawHub` 被 **35 个版本条目**提到（最早 `2026.1.8`）。
`docs/tools/skills.md` 有 `## Installing from ClawHub` 与 `## Security` 两节，
`docs/clawhub/` 下有 `cli.md` 与 `publishing.md`。


---

## 19. 安全模型：把「不做多租户」写进文档

**这一章值得单独存在，因为 OpenClaw 的安全文档做了一件同类产品很少做的事：
把「我们不保证什么」写得比「我们保证什么」更详细。**
`SECURITY.md` 有 **36,228 字节**，其中大量篇幅在划边界而不是宣传防护。

### 核心声明：不是多租户边界

**原文（`### Operator Trust Model`）**：
"OpenClaw does **not** model one gateway as a multi-tenant, adversarial user boundary."

具体展开的几条，都是「这不是漏洞，是设定」：

- **已认证的 Gateway 调用方 = 该实例的受信 operator**
- 本地 loopback 的 Control UI 与 WS 会话（用共享密钥 `token`/`password` 认证的）
  **属于同一个受信桶**；本地自动配对的设备会话**保留完整的 localhost operator 能力**，
  **不构成 `operator.write` 与 `operator.admin` 之间的安全边界**
- HTTP 兼容端点（`POST /v1/chat/completions`、`POST /v1/responses`）
  与直接工具端点（`POST /tools/invoke`）**同属这个受信桶**——
  **在那里传 Gateway bearer auth 等价于 operator 访问**
- **共享密钥调用方拿到全套默认 operator scope**
  （`operator.admin`、`operator.read`、`operator.write`、`operator.approvals`、`operator.pairing`），
  且在 chat-turn 端点与 `/tools/invoke` 上**被当作 owner sender**（可用 owner-only 工具策略）
- **更窄的 `x-openclaw-scopes` 头在共享密钥路径上被忽略**；
  只有**身份型 HTTP 模式**（trusted proxy auth，或私有 ingress 上的 `gateway.auth.mode="none"`）
  才尊重逐请求声明的 operator scope
- **会话标识（`sessionKey`、session ID、label）是路由控制，不是逐用户授权边界**
- **"If one operator can view data from another operator on the same gateway,
  that is expected in this trust model."**

> **这段的价值在于它消除了一整类误判。** 如果你以为「给不同用户不同 sessionKey
> 就隔离了」，你会在这个模型下建出一个想象中的边界。文档直接把它否掉了。

**推荐部署形态**：一台机器/VPS 一个用户、该用户一个 gateway、gateway 里一个或多个 agent。
多用户就**一人一个 VPS（或主机/OS 用户边界）**。
技术上能在一台机器跑多个 gateway，但**不是推荐默认**。

### 7 个 operator scope

`docs/gateway/operator-scopes.md` 实查（脚本数 `operator.*`）：
`operator.read`、`operator.write`、`operator.admin`、`operator.pairing`、
`operator.approvals`、`operator.questions`、`operator.talk`
（外加一个更细的 `operator.talk.secrets`）。

**但文档有一节标题就叫 `## Method scope is only the first gate`**——
scope 只是第一道门，后面还有设备配对审批、node 配对审批、共享密钥认证等层。

### One-User Trust Model

`### One-User Trust Model` 这一节把「个人助理」这个定位的安全含义讲透了：

- **多人能给同一个启用了工具的 agent 发消息（如共享 Slack workspace）时，
  他们都能在该 agent 已授权的范围内驱使它**
- 非 owner 身份**只影响 owner-only 的工具/命令**；
  非 owner 仍能用非 owner-only 的工具（举例 `canvas`）**属于既定边界内**
- **会话或记忆的 scoping 减少上下文串味，但不建立逐用户的宿主授权边界**
- 混合信任或对抗性用户，要**按 OS 用户/主机/gateway 隔离**，每个边界用独立凭据
- 公司共享 agent 可以是有效设置，但**要专机/VM/容器 + 专用账号**，
  且文档警告：**如果那台宿主或浏览器 profile 登着个人账号
  （Apple/Google/个人密码管理器），你已经把边界拍平了**

**默认执行姿态也照实写了**：
`agents.defaults.sandbox.mode` **默认 `off`**，
`tools.exec.host` **默认 `auto`**（会话有活跃沙箱运行时就沙箱，否则 gateway），
**隐式 exec 调用同理**。文档明确说 "Exec behavior is host-first by default"，
需要隔离就自己开 `non-main`/`all` 并保持严格 tool policy。

> **这就是「更安全」与「更好用」张力的一个真实样本**：
> 默认 host-first 让它开箱可用，代价是默认没有沙箱。
> 文档没有粉饰这个取舍，而是把它标成 "expected in OpenClaw's one-user trusted-operator model"。

### 插件是可信计算基的一部分

`### Trusted Plugins` 明确：
**"Installing or enabling a plugin grants it the same trust level as local code
running on that gateway host."**
插件读 env/文件、跑宿主命令**都在这个信任边界之内**。
安全报告必须展示**边界绕过**（未认证的插件加载、allowlist/policy 绕过、沙箱/路径安全绕过），
**而不只是「一个受信安装的插件干了坏事」**。

这与 §6 的「原生插件与 Gateway 同进程、共享其信任边界」是同一件事的两种说法。

### 其他安全面

- **Workspace Memory Trust Boundary**、**Temp Folder Boundary**、
  **Gateway and Node Trust Concept**、**Agent and Model Assumptions** 各有专节
- **Trigger authorization 与 Context visibility 是分开的两件事**：
  前者是「谁能触发 agent」（`dmPolicy`、`groupPolicy`、allowlist、mention gate），
  后者是「给模型看什么补充上下文」（回复正文、引用文本、线程历史、转发元数据）
- **多租户托管**：`docs/gateway/multi-tenant-hosting.md` 有
  `## Why each tenant needs a cell`、`## Trust boundary`、`## Isolation ladder`、
  `## Current scope`——即多租户是靠**每租户一个 cell**做的，不是靠 gateway 内部隔离
- **安全扫描分层（`## Security Scanning`，原文说 "No single scanner is treated as the boundary"）**：
  pre-commit `detect-private-key`、**CodeQL**（覆盖 core TypeScript / GitHub Actions /
  Android / macOS / 高风险运行时边界）、**OpenGrep**（Semgrep 兼容的高精度层，
  规则包在 `security/opengrep/`，PR 跑改动路径扫描）、
  以及 E2E 与 live 验证（`pnpm test:e2e`、`pnpm test:live`、`pnpm test:docker:all`）
- `docs/security/` 下有 `THREAT-MODEL-ATLAS.md`、`CONTRIBUTING-THREAT-MODEL.md`、
  `formal-verification.md`、`incident-response.md`、`network-proxy.md`

**隐私默认**：`VISION.md` 声明 "OpenClaw sends no usage analytics, tracking identifiers,
or attribution tags unless the operator turned that on themselves."
**这条我们无法从外部验证**（见文末未验证块）。

---

## 20. 可观测性：trajectory / OTel / usage

### Trajectory

**运行时 trajectory 事件与会话一起存在 per-agent 的 SQLite 数据库里。**
导出时才**物化成一个脱敏的 JSONL 支持包**——
文档特意说明 **"the live runtime capture is not a session-adjacent JSONL sidecar"**。

**这是一个已经迁移过的形态**：旧版本的 `.trajectory.jsonl` 与 `.trajectory-path.json`
文件可能还在，**会话维护把这些文件当清理目标**，而活跃捕获写数据库行。
关掉：`export OPENCLAW_TRAJECTORY=0`（启动前）。
关掉后 `/export-trajectory` 仍能导出 transcript 分支，
但**运行时独有的数据（编译后的上下文、provider 产物、prompt 元数据）会缺失**。

文档另有 `## Privacy and limits`、`## Bundle files`、`## Tune flush timeout` 等节。

### OpenTelemetry

`docs/gateway/opentelemetry.md` 覆盖：`## Signals exported`、
**`## Which processes export`**、**`## Exporter health`**、
`## Continue an upstream WebSocket trace`、`## Privacy and content capture`、
`## Sampling and flushing`、**`### Model-call observation units`**、
**`### Claude Code CLI model-call fidelity`**、`## Exported metrics`。

extensions 里对应两个：**`diagnostics-otel`** 与 **`diagnostics-prometheus`**
（另有 `docs/gateway/prometheus.md`）。
`packages/` 里没有独立的 telemetry 包——它在 extension 层。

> **`### Claude Code CLI model-call fidelity` 这一节的存在说明**：
> 当 OpenClaw 以 `claude-cli` 为后端跑（§11）时，模型调用的可观测性保真度是**打折的**，
> 且它把这个折扣写进了文档。具体折多少本文未核验。

### Usage / 成本

`docs/concepts/usage-tracking.md` 有 `## Anthropic and OpenAI cost history`、
`## Default usage footer mode`、`### Three distinct session states`、`### Precedence`、
`### Resetting vs. turning off`、`## Custom /usage full footer`。
`docs/reference/api-usage-costs.md`、`token-use.md`、`credits.md`、`prompt-caching.md` 是配套页。

清单契约里有 **`usageProviders`（10 个插件）** 与 **`modelPricing`（14 个插件）**（§18）——
即用量与定价是**按 provider 插件各自声明**的，不是中心化一张表。

### 成熟度记分卡（这一项少见）

**OpenClaw 自带一个公开的成熟度记分卡**（`docs/maturity/scorecard.md`），
从 `taxonomy.yaml`（710KB）+ QA 证据生成：

- 覆盖 **50 个 surface、281 个 capability area**（页面自述）
- 总分 **68%（Alpha）**，拆成 **Coverage Experimental 6% / Quality Alpha 64% /
  Completeness Beta 71%**
- 五档分带：**Experimental 0-50% / Alpha 50-70% / Beta 70-80% / Stable 80-95% /
  Clawesome 95-100%**（最高档名字 2026-06-23 改过，commit "docs: rename top maturity tier"）
- 单个 surface 举例：**CLI** 是 M4 Stable（7 areas），
  但它的 **Coverage 只有 14%（Experimental）**，Quality 83%、Completeness 90%

**页面自己解释了为什么 Coverage 这么低**：
"Coverage is deliberately evidence-led: an area does not become 'ready' just because
the implementation exists. It is not an input to the maturity score, but OpenClaw aims
to keep end-to-end coverage above 90% for mature Stable-or-better features over time."

> **一个产品公开承认自己整体 68%、覆盖率 6%，这种自评是罕见的。**
> 但要注意两点：**这是自评不是第三方审计**，
> 且 **Coverage 的定义（确定性 QA 证据）是它自己定的**——
> 6% 不等于「94% 的功能没测」，而是「94% 的能力面没有它所定义的那种端到端证据」。
> 这个数字的可比性仅限于它自己的历史。

---

## 21. 发版通道：4 条通道 + stable 停在 21 天前

**版本号是日历式的 `YYYY.M.N`**，不是 semver。
`N` 不是 patch 号而是**该月内的序号**——所以 `2026.6.34` 是 6 月线的第 34 个版本，
它可以在 8 月发布（见下）。

**4 条更新通道**（`docs/install/development-channels.md` 实查）：

| 通道 | npm dist-tag | 语义 |
|---|---|---|
| **stable** | `latest` | 推荐给大多数用户 |
| **extended-stable** | `extended-stable` | **净新增的「trailing 支持月」包通道**。仅限包安装、仅前台安装。存了选择后只收**只读的更新提示**（当 `update.checkOnStart` 开时），**永不自动应用** |
| **beta** | `beta` | `beta` 缺失或比当前 stable 旧时**回退到 `latest`** |
| **dev** | git `main`（发布时 npm `dev`） | `main` 是实验与活跃开发用；**文档明确写「不要用它跑生产 gateway」** |

**晋级流程**：stable 构建通常**先发到 `beta`**，在那里验过再**晋级到 `latest`
而不 bump 版本号**；维护者也可以直接发到 `latest`。
**dist-tag 是 npm 安装的事实源。**

**extended-stable 的行为是 fail-closed 的**：它解析公开 npm 的 `extended-stable` selector、
校验精确选中的包、安装那个精确版本，**失败就失败，不回退到 `latest`/`beta`/`dev`**。
git 安装**不支持** extended-stable（会让你改用包安装）。

### 本快照最反直觉的一件事

**npm 的四个 dist-tag 实查（2026-08-08）：**

| dist-tag | 版本 | 发布日期 |
|---|---|---|
| `latest`（= stable） | **`2026.7.1-2`** | **2026-07-18** |
| `beta` | `2026.7.2-beta.7` | 2026-08-02 |
| `extended-stable` | `2026.6.34` | **2026-08-04** |
| `alpha` | `2026.5.19-alpha.1` | 2026-05-20（**已 80 天未动**） |

同时仓库 HEAD 的 `package.json` 是 **`2026.8.1`**（bump 于 2026-08-07），
**npm 上完全没有 `2026.8.x`**，而且 **`2026.7.2` 的正式版也从未发布**——
只有 7 个 `2026.7.2-beta.N`。

三条可核验的结论：

1. **`latest` 落后仓库 HEAD 21 天**（2026-07-18 → 2026-08-08），跨了一个版本线
2. **最近一次发布不是 `latest`，是 `extended-stable`**（8 月 4 日发了 `2026.6.34`）——
   **版本号更低、发布时间更晚**，因为它在 6 月线上继续打补丁
3. **`beta` 领先 `latest` 一个版本线**，且 beta 自己也已 6 天未动（8 月 2 日 → 8 月 8 日）

> **对使用者的实际含义**：`npm install -g openclaw@latest` 在本快照日拿到的是
> **7 月 18 日的代码**。想要接近仓库状态得走 `beta` 或 git 安装（`dev` 通道）。
> **本文因此把「被调研版本」写成两个**（仓库 `2026.8.1` / npm `2026.7.1-2`）——
> 这两个数字回答的是不同问题。
>
> **我没有核验的部分**：`2026.7.2` 正式版为何未发、
> `latest` 是否会在本文发布后很快追上。**这可能只是一次正常的发布节奏波动**
> （文档说的「先 beta 验过再晋级」本身就允许 stable 滞后），
> 也可能是 7 月线出了阻塞问题。**我没有找到公开说明，所以只记录现象不推断原因。**

### 发版节奏（npm registry 实查）

| 项 | 值 |
|---|---|
| npm 总版本数 | **244** |
| 其中正式版（`YYYY.M.N`） | **75** |
| 其中预发布 | **169**（占 69%） |
| 首个版本 | `0.0.1`（**2026-01-29**） |
| npm 包创建 | 2026-01-29 |
| registry 最后修改 | 2026-08-04 |

**按月发版量：**

| 月份 | 版本数 |
|---|---|
| 2026-01 | 9 |
| 2026-02 | 32 |
| 2026-03 | 26 |
| 2026-04 | **62** |
| 2026-05 | **72** |
| 2026-06 | 26 |
| 2026-07 | 14 |
| 2026-08 | 3（截至 8 日） |

**4-5 月是峰值（两个月 134 个版本，约每天 2.2 个），此后明显放缓。**
7 月 14 个、8 月前 8 天只有 3 个。
**这个减速与 stable 滞后是同一时期的现象**，但两者是否同因本文未核验。

**各版本线首个正式版发布日**：

| 版本线 | 首个正式版 | 日期 |
|---|---|---|
| 2026.1 | `2026.1.29` | 2026-01-30（**与改名 openclaw 同日**） |
| 2026.2 | `2026.2.1` | 2026-02-02 |
| 2026.3 | `2026.3.1` | 2026-03-02 |
| 2026.4 | `2026.4.1` | 2026-04-01 |
| 2026.5 | `2026.5.2` | 2026-05-03 |
| 2026.6 | `2026.6.1` | 2026-06-03 |
| 2026.7 | `2026.7.1` | 2026-07-13（**比前几个月晚了 10 天**） |

**注意 npm 首版是 `0.0.1`（2026-01-29）而不是 warelay/clawdbot 时期的版本**——
说明 `openclaw` 这个 npm 包是改名后新建的（旧名有各自的包，见文首 danger 框）。
**git 仓库的历史（2025-11-24 起）比 npm 包的历史（2026-01-29 起）长两个月。**

**GitHub Releases 的日期与 npm 不一致**，这点要小心：
`v2026.6.34` 的 GitHub release published_at 是 **2026-08-08**，而 npm 发布是 **2026-08-04**；
`v2026.7.1-2` 的 GitHub 是 **2026-08-04**，npm 是 **2026-07-18**。
**引用「发布日期」时必须说清是哪个平台的**——本文的版本日期一律以 **npm registry** 为准。

**git tag 有 344 个**，其中除了 `vYYYY.M.N` 还有大量
`release-publish/<sha>-<date>` 形式的发布流水 tag（如 `release-publish/10a390ed7fa8-20260802`），
**这类 tag 不对应用户可见版本**。

---

## 22. 治理与生态：写下来的「不做什么」

### 版权与发包主体

| 项 | 值 |
|---|---|
| `LICENSE` copyright | **OpenClaw Foundation**（2026） |
| `package.json` author | **OpenClaw Foundation (https://openclaw.org)** |
| 仓库 | `openclaw/openclaw`（组织） |
| 官网 | openclaw.ai；文档 docs.openclaw.ai；基金会 openclaw.org；ClawHub clawhub.ai |
| npm 包 | `openclaw`（+ 3 个公开的 `@openclaw/*`） |
| Contributors | **372**（GitHub API 分页实查） |

文档归属的变更有明确 commit：
`docs: attribute published packages and docs home to the OpenClaw Foundation`（**2026-07-22**，`#112633`）、
`docs(wizard): attribute OpenClaw to the OpenClaw Foundation`（2026-07-21，`#112536`），
iOS 标识符迁移到 `openclawfoundation`（2026-06-15）。

**创始人加入 OpenAI（2026-02-14）与项目转入独立基金会的叙述来自新闻报道，本文标为二手**；
**仓库内可核验的一手事实是上面这些归属变更**（时间上晚于报道，2026-05 到 2026-07 陆续落地）。

### 贡献规则（`VISION.md` 实查）

- **一个 PR = 一个 issue/主题**，不要捆绑无关改动
- **超过约 5,000 改动行的 PR 只在例外情况下 review**
- **不要一次开一大批小 PR**，每个 PR 都有 review 成本
- 很小的相关修复**鼓励合成一个聚焦的 PR**

### 「不会合并的东西」清单

**这份清单比功能列表更能说明它的取舍，值得完整记录**
（`## What We Will Not Merge (For Now)`）：

1. 能放在 ClawHub 上的**新 core skill**
2. 全量文档翻译集（推迟；计划改用 AI 生成翻译）
3. **不明确属于 model-provider 类别的商业服务集成**
4. 对已支持渠道的**包装式渠道**（除非有明确的能力或安全缺口）
5. **重复已有 MCP / ACPX / 插件 / ClawHub 路径的 MCP 工作**（除非有明确产品或安全缺口）
6. **把 agent 层级框架（manager-of-managers / 嵌套 planner 树）作为默认架构**
7. **重复已有 agent 与 tool 基础设施的重型编排层**

结尾一句是 "This list is a roadmap guardrail, not a law of physics.
Strong user demand and strong technical rationale can change it."

> **第 6、7 条是值得注意的立场**：在 multi-agent 编排被普遍当作卖点的时期，
> 它明确把「嵌套 planner 树」和「重型编排层」列为默认架构的**否决项**。
> 它自己有 `sessions_spawn` / `subagents` / `swarm`（§4），
> 但**刻意不把层级编排作为默认**。这个取舍的代价与收益本文没有实测依据评价。

### 为什么是 TypeScript

`### Why TypeScript?` 给的理由是：
"OpenClaw is primarily an orchestration system: prompts, tools, protocols, and
integrations. TypeScript was chosen to keep OpenClaw hackable by default.
It is widely known, fast to iterate in, and easy to read, modify, and extend."

**「保持可 hack」是明确写出来的选择理由**——
对比 opencode 把 TUI 从 Go 重写为 TypeScript、Codex 用 Rust 重写核心，
三家在这个问题上给的理由各不相同。

### 终端优先是刻意的

`### Setup`："OpenClaw is currently terminal-first by design.
This keeps setup explicit: users see docs, auth, permissions, and security posture up front."
长期想要更容易的 onboarding，**但明确不要「隐藏关键安全决策的便利包装」**。

### 配置兼容性纪律

已在 §10 引过，这里补上它的完整含义：
**运行时只读当前配置 schema，不保留长期别名或静默接受旧/改名/畸形 key 的兼容分支**；
**任何让已有配置失效的改动必须同时带一个 doctor migration**，
`openclaw doctor --fix` 要能识别旧形态、解释、必要时备份、重写为规范格式。
core 拥有的配置与 auth 状态在 core doctor 代码里修，插件拥有的配置由该插件的 doctor 契约修。

> **这条纪律解释了文首 danger 框第 1 条的现象**：
> 旧 CLI 入口消失得那么快（3 天窗口），
> 旧状态目录兼容被删过两次——**它是「不留长期兼容层」这条纪律的一致结果，不是疏忽。**

### 开发者体验的规模

| 项 | 值 |
|---|---|
| `package.json` scripts | **516** |
| `.github/workflows/` | **82** |
| `scripts/` 条目 | **571** |
| `src/` 内联测试文件 | **5,298** |
| `test/` 目录测试 | **579** |
| lint 配置 | `.oxlintrc.json`（14,088 字节）+ `.oxfmtrc.jsonc` —— 用 **oxlint/oxfmt** 而非 ESLint/Prettier |
| pre-commit | `.pre-commit-config.yaml` |
| 包管理 | **pnpm 11.15.1**（带 sha512 校验），`pnpm-workspace.yaml` |
| 容器 | `Dockerfile`（21,579 字节）+ `docker-compose.yml` |
| 部署配置 | `fly.toml`、`render.yaml`、`deploy/` |

**每个源文件几乎都配一个同名 `.test.ts`** 是这个仓库最一致的风格
（`src/` 下 7,869 个非测试文件对 5,298 个测试文件）。
`qa/` 目录另有 `scenarios/`、`maturity-scores.yaml`、`frontier-harness-plan.md`。

---

## 参考资料

**一手来源（本文事实层的主要依据）：**

- **本地 clone 的源码**：`openclaw/openclaw` @ `bf0aadbc`（2026-08-08），
  版本 `2026.8.1`。本文所有「脚本计数」类断言都来自这里
- 关键单一事实源文件：
  - `src/agents/tool-catalog.ts`（工具目录，§4）
  - `src/config/bundled-channel-config-metadata.generated.ts`（内置渠道，§3）
  - `src/cli/command-catalog.ts`（CLI 命令，§12）
  - `src/config/paths.ts`、`src/compat/legacy-names.ts`（遗留兼容面，§1）
  - `extensions/*/openclaw.plugin.json`（151 份插件清单，§18）
- 仓库内文档源文件：`docs/`（767 个 `.md`/`.mdx`）、`VISION.md`、`SECURITY.md`、
  `AGENTS.md`、`CHANGELOG.md`、`CONTRIBUTING.md`
- GitHub REST API：`/repos/openclaw/openclaw`、`/languages`、`/releases`、`/contributors`
  （Star 数 / 语言占比 / release 时间线 / 贡献者数）
- npm registry：[`openclaw`](https://www.npmjs.com/package/openclaw)
  （dist-tag / 244 个版本时间线），另查了 `clawdbot`、`moltbot` 两个旧包
- 官方站点：[openclaw.ai](https://openclaw.ai)、[docs.openclaw.ai](https://docs.openclaw.ai)、
  [clawhub.ai](https://clawhub.ai)

**二手来源（仅用于改名与基金会化的历史沿革，正文已标注）：**

- 关于「创始人 2026-02-14 加入 OpenAI、项目转入独立基金会」的报道
- 关于「2026-01-27 那次改名源于商标请求」的报道
- **这两条本文都未能从仓库内核验原因**，只核验了结果（commit 与归属变更）

**同系列：**

- [Claude Code 深入研究（2026-08 快照）](./ref-claude-code.md)
- [OpenAI Codex 深入研究（2026-08 快照）](./ref-codex.md)
- [opencode 深入研究（2026-08 快照）](./ref-opencode.md)

---

::: tip 本文没有验证的部分（照实列出）
本篇的**代码结构类事实**来自本地源码实查（比本系列前三篇强），
但**行为类事实仍是厂商口径**。以下是本文明确**未能核验**的：

**没跑起来，所以完全未验证的：**

- **我们没有安装和运行过 OpenClaw。** 所有行为描述——
  沙箱是否真的隔离、四种后端的能力矩阵（§6）、
  failover 的 10 次重试与 30 秒通知（§11）、
  队列四模式的实际时序（§14）、压缩的工具块配对保护（§15）——
  **全部来自仓库内文档，属厂商声明**
- **性能与 token 数字**：skills 的「97 字符 ≈ 24 token/skill」（§9）是官方公式，
  我们没有实测过渲染后的实际开销
- **`OPENCLAW_TRAJECTORY=0` 之后到底缺哪些数据**（§20）

**源码里看得到、但意图或状态不明的：**

- **`2026.7.2` 正式版为何从未发布、`latest` 为何滞后 21 天**（§21）——
  只记录现象，**没有找到公开说明**，也无法排除「这只是正常发布波动」
- **4-5 月峰值（134 个版本）之后减速的原因**（§21），
  以及它与 stable 滞后是否同因
- **1,708,978 行 `src/` 代码里有多少是活跃路径**——
  我们只数了行数，没有做可达性分析
- **834 个 `OPENCLAW_*` 环境变量里，30 个之外的那些实际有多少在生效**（§10）
- **`crestodian` 这个 CLI 命令当前的实际用途**（§12）——
  只知道它来自被改名的 system agent
- **`swabble`（`apps/` 下的一个目录）是什么**（§16）

**属于二手、本文只能标注不能核验的：**

- **两次改名的原因**（商标请求 / 主动商标检索，§1）——仓库里只有 commit message
- **基金会化的组织细节**（与 OpenAI 的赞助关系、治理结构，§22）——
  仓库内只能核验版权与归属变更这个结果
- **「不发送任何用量分析、追踪标识或归因标签，除非运营方自己开启」**（§19）——
  这类隐私声明**无法从外部验证**，需要抓包或审计才能确认
- **成熟度记分卡的 68% / Coverage 6%**（§20）是**自评**，
  且 Coverage 的定义由它自己给出，**不可与其他产品横比**

**方法论上的一处自我修正**（留作记录）：
§7 数 Hook 事件时，第一版正则漏掉带连字符的事件名，得到 14；正确值是 **16**。
**脚本计数不会像目测那样错得离谱，但会错在字符类这种细节上**——
所以本文对每个计数都给出了判据，方便你复核而不是采信。

这些地方本文用「我没有核验」明确标注，而不是含糊过去。
:::
