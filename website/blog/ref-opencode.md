---
title: opencode 深入研究（2026-08 快照）
description: 26 章逐节成册，按目录跳章查阅——把 opencode 的产品形态、架构与实现细节交叉核验到版本号级别：客户端/服务器分离、TUI 从 Go 重写为 TypeScript+Solid、13 类权限键、8 层配置优先级、28 类插件事件、75+ Provider、Zen/Go 两套自营网关。这是一份手册，不是读完就走的文章。
date: "2026-08-08"
series: 热点开源项目研究
audience: engineer
highlight: 26 章逐节可查 · 核验至 v1.18.15 · 截至 2026-08-08 快照
tags: [opencode, 深入研究, 权限, 插件, MCP, 参考]
outline: [2, 3]
---

# opencode 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-08
- **被调研版本**：opencode **v1.18.15**（2026-08-07 发布），npm 包 `opencode-ai@1.18.15`
- **证据形态**：公开信息交叉核验（官方文档源文件 / GitHub API 实查 / npm registry / 社区逆向分析），
  **不是我们自己的实测数据**。章节内的版本号与日期是它的证据，请连带一起读。
- **一手性说明**：本文的文档类事实**优先取自仓库内的 `.mdx` 源文件**
  （`packages/web/src/content/docs/*.mdx`，dev 分支），而不是渲染后的网页——
  渲染页会丢表格结构、把代码块压成一行。仓库结构、Star 数、语言占比、
  发版时间线取自 GitHub REST API 与 npm registry 实查。
- **时效边界**：opencode 发版极快（v1.18.6 到 v1.18.15，**12 天里发了 10 个版本**）。
  **这是 2026-08-08 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://opencode.ai/docs)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 两条广为流传但已经过期的说法
读 opencode 的第三方分析时，这两条几乎必然会遇到，而它们**在 2026-08 都已经不成立**：

1. **「TUI 是 Go 写的，`opencode` 会同时拉起一个 JS 服务端进程和一个 Golang TUI 进程」**——
   这是 2025 年的架构。截至本快照，`packages/tui` 已是 **TypeScript + Solid.js**
   （跑在 `@opentui/*` 之上），GitHub 语言统计里 **Go 占比为 0%**（TypeScript 75.6%）。
   客户端/服务器分离这个设计保留了，但「跨语言双进程」这个特征没了。见 §2、§3。
2. **「仓库是 `sst/opencode`」**——**2026-01-02 起改为 `anomalyco/opencode`**
   （发布方 Anomaly，anoma.ly）。旧地址仍 301 重定向，所以引用旧链接不会立刻报错，
   **但 Homebrew tap 名、GitHub Action 名都跟着变了**（`anomalyco/tap/opencode`、
   `anomalyco/opencode/github@latest`），照旧文档抄这两处会直接失败。见 §1、§21。

这两条是「引用二手分析而不回一手源」的典型代价。本文标注的现状同样会漂移——
引用前先看一眼日期。
:::

---

## 1. 产品概述

opencode 是一个**开源**（MIT）AI 编程代理，由 Anomaly 开发。它的定位口号是
"The open source AI coding agent"，与同类产品最大的形态差异是：
**它不绑定模型供应商**——任何 LLM provider 都是可插拔的，官方自营的网关只是其中一个选项。

**产品形态（6 个入口）：**

| 入口 | 说明 |
|------|------|
| **TUI**（终端界面） | 主入口，`opencode` 直接启动。TypeScript + Solid.js 实现（见 §3） |
| **Desktop App** | **BETA**。macOS（arm64/x64）/ Windows（x64/arm64）/ Linux（deb/rpm/AppImage） |
| **Web** | `opencode web` 起本地服务并开浏览器；可 `--hostname 0.0.0.0` 供局域网访问 |
| **CLI 非交互** | `opencode run "<prompt>"`，供脚本与 CI 使用 |
| **IDE / 编辑器** | 通过 **ACP**（Agent Client Protocol）接入 Zed / JetBrains / Neovim 系；另有 VS Code 扩展线（tag `vscode-v0.0.13`） |
| **GitHub / GitLab** | 评论里 `/opencode` 或 `/oc` 触发，跑在你自己的 Actions runner 里 |

**关键数据（截至 2026-08-08，GitHub API 与 npm registry 实查）：**

- GitHub Stars：**194,776**
- Forks：**24,919**
- Open Issues：**5,002**
- Watchers：748
- 许可证：**MIT**
- 仓库创建：**2025-04-30**；最近 push：2026-08-08
- 语言占比：**TypeScript 75.6%**、MDX 21.0%、CSS 2.9%、其余 <0.2%（**Go 为 0%**）
- 最新版本：**v1.18.15**（2026-08-07）
- monorepo 规模：`packages/` 下 **31 个包**

> **⚠️ 一个数据源的坑：仓库里的 `STATS.md` 已经停更。** 它记录 GitHub + npm
> 累计下载量，最后一行是 **2026-01-29 的 10,190,453 次累计下载**（GitHub 7,815,471 +
> npm 2,374,982）。这个数字放在 2026-08 引用会**严重低估**，但它是仓库里唯一的
> 官方下载量口径。**本文不把它当作当前规模的证据**，只作为「2026-01 时点已破千万」
> 的历史事实引用。

**安装方式：**

```bash
# 安装脚本（官方推荐）
curl -fsSL https://opencode.ai/install | bash

# Node 系包管理器
npm install -g opencode-ai        # 或 bun / pnpm / yarn

# Homebrew（macOS + Linux）
brew install anomalyco/tap/opencode   # 官方 tap，更新最快（推荐）
brew install opencode                 # Homebrew 官方 formula，更新较慢

# Arch Linux
sudo pacman -S opencode           # 稳定版
paru -S opencode-bin              # AUR 最新

# Windows（官方推荐先上 WSL）
choco install opencode
scoop install opencode

# 其它
mise use -g github:anomalyco/opencode
docker run -it --rm ghcr.io/anomalyco/opencode
nix run nixpkgs#opencode
```

> **注意两处与旧文档的差异：** ① Homebrew tap 是 `anomalyco/tap`，不是 `sst/tap`；
> ② README 明确要求 **先卸载 0.1.x 以前的版本**再装新版。
> 另外 Windows 上用 Bun 安装「仍在进行中」（官方原话），别当成已支持。

**安装目录优先级**（install 脚本按序取第一个可用的）：

1. `$OPENCODE_INSTALL_DIR`（自定义）
2. `$XDG_BIN_DIR`（符合 XDG 规范）
3. `$HOME/bin`（存在或可创建时）
4. `$HOME/.opencode/bin`（兜底）

**Desktop App 下载**（`opencode.ai/download` 或 GitHub Releases）：

| 平台 | 制品 |
|------|------|
| macOS（Apple Silicon） | `opencode-desktop-mac-arm64.dmg` |
| macOS（Intel） | `opencode-desktop-mac-x64.dmg` |
| Windows | `opencode-desktop-win-x64.exe` / `-win-arm64.exe` |
| Linux | `.deb` / `.rpm` / `.AppImage`（x86_64 与 arm64 双架构） |

```bash
brew install --cask opencode-desktop                        # macOS
scoop bucket add extras; scoop install extras/opencode-desktop   # Windows
```

> Desktop 明确标注 **BETA**。从 `packages/desktop/package.json` 的依赖看
> （`electron-updater`、`electron-store`、`electron-window-state`、`electron-log`），
> 它是 **Electron** 应用；单个 dmg 约 **150MB**，Linux AppImage 约 **158MB**。
> 顺带一提，组织的容器包里有 `build/tauri-linux`——说明构建体系里存在 Tauri 相关
> 产物线，**但当前 desktop 包的依赖是 Electron**。这两件事我没有进一步核验其关系。

**支持模型：** 通过 [AI SDK](https://ai-sdk.dev/) 与 [Models.dev](https://models.dev/)
支持 **75+ LLM provider**，并支持本地模型。官方文档给出的「配合 opencode 效果好」
的推荐清单（官方注明**不穷尽、也不保证最新**）：

- GPT 5.2
- GPT 5.1 Codex
- Claude Opus 4.5
- Claude Sonnet 4.5
- Minimax M2.1
- Gemini 3 Pro

> **这份推荐清单本身就是过期证据的好例子。** 它列的是 GPT 5.2 / Opus 4.5 一代，
> 而同一份文档站的 Zen 页面（§23）已经在卖 **GPT 5.6 Sol/Terra/Luna、Claude Opus 5、
> Claude Fable 5、Gemini 3.6 Flash**。两个页面的更新节奏不同步，
> 引用「opencode 推荐什么模型」时要注意你引的是哪一页、什么时候的。

**模型 ID 格式**统一为 `provider_id/model_id`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-20250514"
}
```

Zen 网关下是 `opencode/gpt-5.1-codex`，Go 订阅下是 `opencode-go/kimi-k3`，
自定义 provider 下则是 config 里 `provider` 与 `provider.models` 的键名。

**模型加载优先级**（启动时按序取第一个命中的）：

1. `--model` / `-m` 命令行参数
2. config 里的 `model` 字段
3. **上次使用的模型**
4. 按内部优先级挑第一个可用模型

**认证与凭据：** `opencode auth login`（或 TUI 里 `/connect`）写入
`~/.local/share/opencode/auth.json`。启动时也会读环境变量与项目里的 `.env`。

---

## 2. 核心架构：客户端/服务器分离

opencode 最核心的架构决策是：**TUI 只是一个客户端，真正干活的是一个本地 HTTP 服务端。**

```
┌────────────┐   ┌────────────┐   ┌──────────────┐
│    TUI     │   │  Desktop   │   │  Web / IDE   │   ← 客户端（可替换）
└─────┬──────┘   └─────┬──────┘   └──────┬───────┘
      │                │                 │
      └────────────────┴─────────────────┘
                       │  HTTP + SSE（OpenAPI 3.1）
              ┌────────▼─────────┐
              │  opencode server │   ← 工具执行、会话、权限、LSP、MCP 都在这里
              └────────┬─────────┘
                       │
      ┌────────────────┼─────────────────┐
      ▼                ▼                 ▼
  文件系统 / Shell   LSP 服务器      LLM Provider（AI SDK）
```

跑 `opencode` 时它**同时启动服务端与 TUI**，TUI 通过 HTTP 连本地服务端。
这带来几个直接后果：

- **任何客户端都能接**：手机 App、Web UI、脚本，只要会发 HTTP 就行。
  社区据此做出了 Neovim 插件、Discord bot、Obsidian 插件、移动端 UI（§25）。
- **服务端可以独立跑**：`opencode serve` 起一个无 TUI 的服务端，
  再用 `opencode attach http://localhost:4096` 把 TUI 接上去。
- **实际工作始终发生在服务端所在的机器上**——远程接入时这一点决定了文件读写的位置。

**技术栈**（取自各包的 `package.json`，v1.18.15）：

| 层 | 选型 |
|----|------|
| 运行时 | **Bun**（`packageManager: bun@1.3.14`） |
| HTTP | **Hono** 4.10.7 + `hono-openapi` 1.1.2（catalog 版本） |
| 应用框架 | **Effect** 4.0.0-beta.83（`@opencode-ai/core` / `server` / `llm` / `desktop` 都依赖它） |
| 持久化 | **Drizzle ORM** 1.0.0-rc.2 + SQLite（Bun / Node 双实现，见 `#sqlite` imports 分支） |
| LLM 接入 | **AI SDK**（`ai` 6.0.168）+ 各 `@ai-sdk/*` provider 包 |
| TUI | **Solid.js** 1.9.10 + `@opentui/core|keymap|solid` 0.4.5 |
| 桌面 | **Electron**（`electron-updater` / `-store` / `-log` / `-window-state`） |
| SDK 生成 | 由服务端 OpenAPI spec 生成 |
| 校验 | Zod 4.1.8 |

> **Effect 用的是 4.0.0-beta 版本线。** 整个 core / server / llm / desktop / cli
> 都建在一个 beta 依赖上，这是个值得知道的事实——它意味着这些包的内部 API
> 可能随 Effect 的 beta 演进而变。至于团队为什么接受这个代价，我没有找到公开说明。

**monorepo 结构**（`packages/` 下 31 个包，挑出职责明确的）：

| 包 | 职责 |
|----|------|
| `opencode` | 主发布包（npm `opencode-ai` 的实体），聚合所有 `@ai-sdk/*` provider |
| `core` | 核心逻辑：会话、system-context、数据库、Effect layer |
| `server` | HTTP 服务端（依赖 core + protocol + drizzle + effect） |
| `cli` | 命令行入口（依赖 core + server + tui + sdk） |
| `tui` | 终端界面（TypeScript + Solid + OpenTUI） |
| `desktop` | Electron 桌面壳 |
| `app` | 桌面/Web 共用的前端应用（Solid + Kobalte + dnd-kit + Sentry） |
| `web` | 官网与文档站（Astro Starlight，文档 `.mdx` 就在这里） |
| `sdk` / `sdk-next` / `client` | JS/TS SDK 与客户端 |
| `plugin` | 插件与自定义工具的 SDK（`@opencode-ai/plugin`） |
| `llm` | Provider 适配层（含 Bedrock 的 aws4fetch 直连） |
| `protocol` / `schema` | 协议与 schema 定义 |
| `codemode` | "Effect-native confined code execution over schema-described tools"（受限代码执行） |
| `enterprise` | 企业版前端 |
| `slack` | Slack 集成（`@slack/bolt`） |
| `console` / `stats` | 控制台与用量统计 |
| `http-recorder` | HTTP 录制（测试用） |
| `session-ui` / `ui` / `storybook` | 共用 UI 组件与组件文档 |
| `containers` | 构建容器 |

> `codemode` 这个包的描述值得留意——「用 schema 描述工具、在受限环境里执行代码」
> 是一条与「把每个工具都做成一次 tool call」不同的技术路线。
> **它在 `packages/` 里存在，但我没有核验它是否已经接进主流程、以及默认是否启用。**

**Agentic 循环**的基本形态与同类产品一致：system prompt + 工具清单交给模型 →
模型输出 tool_use → 服务端执行（读文件 / 跑命令 / 编辑）→ 结果回灌上下文 →
模型决定继续还是收尾。opencode 的两个特点是：

- **每个 provider 有各自定制的 system prompt**（社区分析里可见 `prompt/gemini.txt`
  这类按 provider 分文件的组织方式）。
- **LSP 诊断通过事件总线回灌**：编辑文件后向 LSP 发 `textDocument/didChange`，
  等诊断，再把诊断喂回模型上下文（见 §15）。

---

## 3. TUI：从 Go 重写为 TypeScript + Solid

这一章单独立出来，因为**它是当前所有第三方 opencode 分析里最集中的过期点**。

**2025 年的形态**：`opencode` 拉起两个进程——Bun 跑 JS 服务端，另一个进程跑
**Go 实现的 TUI**。社区那篇流传很广的架构深潜文章描述的就是这个版本。

**2026-08 的形态**（v1.18.15 实查）：

- `packages/tui/package.json` 的包名是 `@opencode-ai/tui`，`"type": "module"`，
  依赖 **`solid-js`、`@opentui/core`、`@opentui/keymap`、`@opentui/solid`**
- `packages/tui/src/` 下是 `app.tsx`、`index.tsx`、`keymap.tsx`、`runtime.tsx`、
  `component/`、`routes/`、`theme/`、`ui/` —— 全是 TS/TSX
- `packages/cli` 直接依赖 `@opencode-ai/tui` + `@opentui/core` + `solid-js`
- **GitHub 语言统计里 Go 占 0%**（总计 35,279,220 字节：TypeScript 75.6%、
  MDX 21.0%、CSS 2.9%、HTML/JS/Astro/Shell/Nix 合计 <0.5%）

也就是说：**TUI 现在是用 Solid.js 的响应式模型写终端界面**，
跑在 OpenTUI 这个终端渲染层上，与服务端同属一个 TypeScript 代码库。

**这次重写换掉了什么、留下了什么：**

- **留下了**客户端/服务器分离——TUI 仍然通过 HTTP 连服务端（`packages/tui` 依赖 `@opencode-ai/sdk`）
- **换掉了**跨语言双进程：不再需要在 Go 与 TS 之间维护两套类型、两套构建
- **换来了**一个前端框架的组件模型：`ui/dialog`、`ui/toast`、`component/spinner`
  这些导出路径，和写 Web 组件是同一套心智

**代价那一面**：终端 UI 现在跑在 JS 运行时里，且引入了 OpenTUI（0.4.x 版本线）
这个相对年轻的依赖。TUI 配置里能看到不少与终端渲染直接相关的开关——
`mouse`（可关闭鼠标捕获以恢复终端原生选择）、`scroll_acceleration`、
`cursor.style`、`diff_style`——**这类开关的存在说明终端兼容性需要逐项让用户可控**，
但我没有实测不同终端下的表现差异。

**官方推荐的终端**（文档明确列出，说明终端选择会影响体验）：
WezTerm、Alacritty（跨平台）、Ghostty、Kitty（Linux + macOS）。

---

## 4. 内置工具系统

**默认全部启用、且默认不需要批准**（这是 opencode 与同类产品最大的默认值差异，见 §5）。
工具通过 `permission` 字段控制，而不是通过「工具开关」。

| 工具 | 说明 | 受哪个权限键管 |
|------|------|----------------|
| `bash` | 执行 shell 命令 | `bash` |
| `edit` | 精确字符串替换改文件 | `edit` |
| `write` | 新建或覆盖文件 | **`edit`** |
| `apply_patch` | 应用 patch | **`edit`** |
| `read` | 读文件内容，支持按行范围读 | `read` |
| `grep` | 正则搜内容（底层 ripgrep） | `grep` |
| `glob` | 按 glob 找文件，按修改时间排序返回 | `glob` |
| `lsp` | **实验性**：LSP 代码智能查询 | `lsp` |
| `skill` | 载入一个 `SKILL.md` 并把内容放进对话 | `skill` |
| `todowrite` | 任务清单（含 `todoread`） | `todowrite` |
| `webfetch` | 抓取网页内容 | `webfetch` |
| `websearch` | 联网搜索（Exa AI） | `websearch` |
| `question` | **反问用户**：带 header、问题、选项，用户可选或自填 | `question` |

> **三个工具共用一个 `edit` 权限键**（`edit` / `write` / `apply_patch`）。
> 这是刻意的设计——「所有文件修改」是一个权限单元。
> 后果是：**你无法只允许 `edit` 而禁止 `write`**，要区分只能靠 `edit` 的
> 对象语法按路径 glob 划分（见 §5）。

**几个工具的边界条件：**

- **`lsp` 需要显式开实验开关**：`OPENCODE_EXPERIMENTAL_LSP_TOOL=true`
  （或 `OPENCODE_EXPERIMENTAL=true`）。支持 `goToDefinition`、`findReferences`、
  `hover`、`documentSymbol`、`workspaceSymbol`、`goToImplementation`、
  `prepareCallHierarchy`、`incomingCalls`、`outgoingCalls`。
- **`websearch` 不是无条件可用**：只在用 opencode（Zen）provider 时可用，
  或设 `OPENCODE_ENABLE_EXA=1`。它直连 Exa AI 的托管 MCP 服务，**不需要 API key**。
  官方给的分工是：`websearch` 用于**发现**，`webfetch` 用于**取指定 URL**。
- **`todowrite` 对子代理默认关闭**，可手动开。
- **`apply_patch` 有两处容易踩的不一致**（官方文档专门点出）：
  hook 里判断要用 `input.tool === "apply_patch"`（**不是** `"patch"`）；
  它用 `output.args.patchText` 而**不是** `output.args.filePath`，
  路径嵌在 patchText 的标记行里（`*** Add File: src/new.ts`、
  `*** Update File:`、`*** Move to:`、`*** Delete File:`），且相对项目根。

**搜索的忽略规则**：`grep` / `glob` 底层是 **ripgrep**，默认遵守 `.gitignore`。
要把被忽略的路径搜回来，在项目根放 `.ignore`：

```text
!node_modules/
!dist/
!build/
```

**自定义工具优先级**：自定义工具按**工具名**注册，与内置同名时
**自定义的胜出**——也就是说你可以用一个 `.opencode/tools/bash.ts` 把内置 `bash` 换掉。
插件提供的工具同名时同样覆盖内置（§13）。

---

## 5. 权限系统

**opencode 的默认值是「全部允许」**——这与 Claude Code / Codex 的默认收紧路线相反，
是理解 opencode 安全模型的起点。

> 官方文档原话：「If you don't specify anything, opencode starts from
> **permissive defaults**」。

**三种动作**（每条规则解析成其中之一）：

- `"allow"` —— 不需批准直接跑
- `"ask"` —— 弹确认
- `"deny"` —— 直接拦掉

**13 个权限键**（按工具名 + 两个安全护栏）：

| 键 | 匹配对象 |
|----|----------|
| `read` | 文件路径 |
| `edit` | 所有文件修改（`edit` / `write` / `apply_patch`） |
| `glob` | glob 模式 |
| `grep` | 正则模式 |
| `bash` | 解析后的命令（如 `git status --porcelain`） |
| `task` | 子代理类型 |
| `skill` | skill 名 |
| `lsp` | 目前**不支持细粒度** |
| `question` | 反问用户 |
| `webfetch` | URL |
| `websearch` | 查询词 |
| `external_directory` | **护栏**：任何工具触碰项目工作目录之外的路径时触发 |
| `doom_loop` | **护栏**：同一个工具调用带**完全相同的输入重复 3 次**时触发 |

**默认值**（这张表是本章最该记住的东西）：

| 项 | 默认 |
|----|------|
| 绝大多数权限 | `"allow"` |
| `doom_loop` | **`"ask"`** |
| `external_directory` | **`"ask"`** |
| `read` | `"allow"`，但 **`.env` 系列默认 deny** |

```json
{
  "permission": {
    "read": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    }
  }
}
```

> **`doom_loop` 这个护栏值得单独说。** 它不防危险操作，防的是**代理卡在原地打转**——
> 同一个调用、同一个输入、第 3 次。这是把「模型陷入循环」当作一类需要人介入的
> 状态来处理，而不是当作纯粹的效率问题。它默认 `ask` 而不是 `allow`，
> 说明团队认为这个信号强到值得打断用户。

**通配符语义**（刻意做得很简单）：

- `*` 匹配零或多个任意字符
- `?` 匹配恰好一个字符
- 其它字符字面匹配

**规则求值顺序：最后一条命中的规则胜出。** 因此惯用写法是**把兜底 `"*"` 放最前面**，
具体规则放后面：

```json
{
  "permission": {
    "bash": {
      "*": "ask",
      "git *": "allow",
      "npm *": "allow",
      "rm *": "deny",
      "grep *": "allow"
    },
    "edit": {
      "*": "deny",
      "packages/web/src/content/docs/*.mdx": "allow"
    }
  }
}
```

> **「最后命中者胜」是与 Claude Code 相反的取舍。** CC 的规则里 deny 具有
> 一票否决的地位；opencode 这里 deny 只是「一条可能被后面的 allow 覆盖的规则」。
> 代价是**规则顺序变成语义的一部分**——把两段配置拼在一起时，
> 顺序变了行为就变了。好处是「先全禁、再逐项开」这种写法很自然。

**Home 目录展开**：模式开头可用 `~` 或 `$HOME`。注意官方明确的一条边界——
**展开只影响模式怎么写，不会把外部路径变成工作区的一部分**，
所以工作目录之外的路径**仍然要靠 `external_directory` 放行**。

**外部目录的权限继承**：`external_directory` 放行的目录，
**继承与当前工作区相同的默认值**。因为 `read` 默认 `allow`，
放行后读也就默认允许了。要「可读不可写」得显式再加一条：

```json
{
  "permission": {
    "external_directory": { "~/projects/personal/**": "allow" },
    "edit": { "~/projects/personal/**": "deny" }
  }
}
```

**Auto 模式**：`opencode --auto` 或 `opencode run --auto` **自动批准所有
不是显式 deny 的请求**。显式 `"deny"` 仍然生效——auto 只改变那些「本来会问」的请求。
TUI 里通过命令面板的 **Enable / Disable auto-approve permissions** 切换，
开启时提示符旁会显示一个灰色的 `auto` 标记。

**「Ask」弹窗的三个出口**：

- `once` —— 只批准这一次
- `always` —— 批准将来所有匹配**建议模式**的请求（**仅限当前会话**，不落盘）
- `reject` —— 拒绝

建议模式由工具自己给（例如 bash 通常给一个安全的命令前缀 `git status*`）。

> **⚠️ 带参数的命令必须写 `*`，这是最容易踩的一条。**
> `"grep *"` 能放行 `grep pattern file.txt`，而**光写 `"grep"` 会把它拦住**。
> 官方明确点出：`git status` 这种不带参数的形态按默认行为可以工作，
> 但一旦带上参数就需要显式写成 `"git status *"`。
> 换句话说，**模式匹配的是「解析后的完整命令串」，不是命令名**。

**一次性设置全部权限**（简写形态）：

```json
{ "$schema": "https://opencode.ai/config.json", "permission": "allow" }
```

**配置位置与作用域**：全局 / 项目 config 里的 `permission`，
可被 agent 级 `permission` 覆盖——**agent 规则与全局配置是合并关系，agent 规则优先**（见 §6）。
另有环境变量 `OPENCODE_PERMISSION` 传内联 JSON。

一个典型的分层写法：全局禁掉 `git commit` / `git push`，
只在 `build` agent 里把 commit 放宽到 `ask`：

```json
{
  "permission": {
    "bash": { "*": "ask", "git *": "allow", "git commit *": "deny", "git push *": "deny" }
  },
  "agent": {
    "build": {
      "permission": {
        "bash": { "*": "ask", "git *": "allow", "git commit *": "ask", "git push *": "deny" }
      }
    }
  }
}
```

**历史沿革**：`v1.1.1` 起旧的 `tools` 布尔配置**已废弃**并合并进 `permission`，
但为向后兼容仍然支持。旧配置里 `true` 等价于 `{"*": "allow"}`，`false` 等价于 `{"*": "deny"}`。

---

## 6. Agent 系统

opencode 把「代理」分成两类，且**两类都可以自定义**：

- **Primary agent**（主代理）：你直接对话的对象，**Tab 键循环切换**
- **Subagent**（子代理）：主代理可以调起，你也能用 `@名字` 手动召唤

**内置代理（8 个，其中 3 个隐藏）：**

| 名字 | 模式 | 说明 |
|------|------|------|
| **build** | primary | **默认代理**，全部工具启用，常规开发用 |
| **plan** | primary | 受限代理。默认把 `file edits`（write/patch/edit）与 `bash` 全部设为 **`ask`** |
| **general** | subagent | 通用：复杂调研与多步任务。除 `todo` 外全工具可用，**能改文件** |
| **explore** | subagent | 快速**只读**探索代码库，不能改文件 |
| **scout** | subagent | **只读**的外部文档/依赖调研：可把依赖仓库克隆进 opencode 的托管缓存、读库源码、与上游实现对照 |
| `compaction` | primary | **隐藏系统代理**：把长上下文压成摘要，自动触发，UI 里不可选 |
| `title` | primary | **隐藏系统代理**：生成会话短标题 |
| `summary` | primary | **隐藏系统代理**：生成会话摘要 |

> **`plan` 的默认值是 `ask` 而不是 `deny`**，这点与很多人的印象不同——
> 它不是「硬性只读」，而是「每一步都要你点头」。要真正只读得自己配 `deny`
> （官方文档在 agent 配置示例里就是这么写的：`"edit": "deny", "bash": "deny"`）。
>
> `scout` 这个子代理值得注意：**它会把依赖仓库克隆到本地缓存**，
> 这是一条与「只读」直觉相反的副作用——只读指的是不改你的工作区。
> 另外 `OPENCODE_EXPERIMENTAL_SCOUT` 这个实验开关仍存在于环境变量表中，
> 而 scout 已经出现在正式文档的内置代理清单里，**两者的关系我没有核验**。

**子代理会话导航**（这是 opencode 的一个特色交互）：子代理创建的是**子会话**，
在 TUI 里可以进出：

| 操作 | 默认键 |
|------|--------|
| 进入第一个子会话 | `<leader>down` |
| 循环到下一个子会话 | `right` |
| 循环到上一个子会话 | `left` |
| 回到父会话 | `up` |

**两种定义方式。** JSON（在 `opencode.json` 的 `agent` 下）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "agent": {
    "code-reviewer": {
      "description": "Reviews code for best practices and potential issues",
      "mode": "subagent",
      "model": "anthropic/claude-sonnet-4-20250514",
      "prompt": "You are a code reviewer. Focus on security, performance, and maintainability.",
      "permission": { "edit": "deny" }
    }
  }
}
```

或 Markdown（**文件名即代理名**，`review.md` → `review` 代理）：

- 全局：`~/.config/opencode/agents/`
- 项目：`.opencode/agents/`

```markdown
---
description: Reviews code for quality and best practices
mode: subagent
model: anthropic/claude-sonnet-4-20250514
temperature: 0.1
permission:
  edit: deny
  bash: deny
---

You are in code review mode. Focus on:
- Code quality and best practices
- Potential bugs and edge cases
```

**配置项全表：**

| 选项 | 说明 |
|------|------|
| `description` | **必填**。做什么、何时用——主代理靠它决定调不调这个子代理 |
| `mode` | `primary` / `subagent` / `all`（**默认 `all`**） |
| `model` | 覆盖模型，`provider/model` 格式 |
| `prompt` | 自定义 system prompt，支持 `{file:./prompts/x.txt}`（**相对 config 文件位置**） |
| `temperature` | 不设则用模型默认；官方注明**多数模型 0、Qwen 系 0.55** |
| `top_p` | temperature 的替代 |
| `steps` | **最大 agentic 迭代轮数**。到上限后给一个特殊 system prompt 要求它总结工作与剩余任务 |
| `disable` | `true` 关掉这个代理 |
| `hidden` | `true` 把子代理从 `@` 自动补全里藏起来（仅对 `mode: subagent` 生效） |
| `color` | UI 配色，hex 或主题色名（`primary`/`accent`/`success`/…） |
| `permission` | 权限覆盖（见 §5） |
| `tools` | **已废弃**，用 `permission` 代替 |
| 其它任意键 | **直接透传给 provider 作为模型参数**（如 `reasoningEffort`、`textVerbosity`） |

> **`steps` 是个成本控制阀门**，文档写得很直白：「allows users who wish to control
> costs to set a limit on agentic actions」。不设则一直迭代到模型自己停或用户打断。

> **「其它任意键透传给 provider」是个双刃设计**：它让 `reasoningEffort: "high"`
> 这种 provider 特有参数不需要 opencode 逐个适配就能用；
> 代价是**拼错的键不会报错**，只会被静默传给 provider 然后被忽略。

**Task 权限：控制哪个代理能调哪些子代理**（`permission.task`，glob 匹配）：

```json
{
  "agent": {
    "orchestrator": {
      "mode": "primary",
      "permission": {
        "task": { "*": "deny", "orchestrator-*": "allow", "code-reviewer": "ask" }
      }
    }
  }
}
```

设成 `deny` 时，**该子代理会被整个从 Task 工具的描述里删掉**——
模型不会看见它，因此不会尝试调用。这里同样是**最后命中者胜**：
`orchestrator-planner` 同时命中 `*`(deny) 与 `orchestrator-*`(allow)，
后者在后面，所以结果是 allow。

> **一条越权路径要知道**：官方明确说明，**用户始终可以通过 `@` 自动补全直接调用
> 任何子代理，即使 agent 的 task 权限会拒绝它**。
> 也就是说 `permission.task` 约束的是**模型**，不是人。

**脚手架**：`opencode agent create` 交互式生成，或非交互（同时传全 4 个参数）：

```bash
opencode agent create \
  --path .opencode/agent --description "Reviews code" \
  --mode subagent --permissions read,glob,grep
```

注意它的语义是**白名单**：`--permissions` 里没列的一律 deny（官方原话
"Anything you don't allow is denied in the generated agent's frontmatter"）。
可选值：`bash`、`read`、`edit`、`glob`、`grep`、`webfetch`、`task`、`todowrite`、
`websearch`、`lsp`、`skill`。

---

## 7. 配置系统：8 层优先级

opencode 的配置层级是同类产品里最多的一档——**8 层**，从组织远端默认一直到 MDM 强制。

**优先级顺序（后面的覆盖前面的）：**

| # | 层 | 位置 | 谁控制 |
|---|----|------|--------|
| 1 | **Remote config** | `.well-known/opencode` 端点 | 组织（作为基础层） |
| 2 | **Global config** | `~/.config/opencode/opencode.json` | 用户 |
| 3 | **Custom config** | `OPENCODE_CONFIG` 指定路径 | 用户 |
| 4 | **Project config** | 项目根 `opencode.json` | 项目（标准配置里优先级最高） |
| 5 | **`.opencode` 目录** | agents / commands / plugins / tools / skills | 项目 |
| 6 | **Inline config** | `OPENCODE_CONFIG_CONTENT`（内联 JSON） | 运行时 |
| 7 | **Managed 文件** | macOS `/Library/Application Support/opencode/`、Linux `/etc/opencode/`、Windows `%ProgramData%\opencode` | 管理员（需 root） |
| 8 | **macOS managed preferences** | `ai.opencode.managed` 域，MDM 下发 `.mobileconfig` | **最高，用户不可覆盖** |

> **第 1 层与第 8 层是同一件事的两端，值得单独理解。**
> Remote config 是「组织给默认值，用户可以改」——文档举的例子是组织下发一批
> **默认 disabled 的 MCP 服务器**，用户按需 `enabled: true` 打开。
> 而 managed settings 是「组织强制，用户改不动」。
> **一套配置体系同时提供「建议」与「强制」两种组织级入口**，
> 这是面向企业部署的设计；代价是配置来源变成 8 个，
> 排查「这个值到底哪来的」变难。

**MDM 部署细节**（macOS）：读 `ai.opencode.managed` 偏好域，检查两个路径：

1. `/Library/Managed Preferences/<user>/ai.opencode.managed.plist`
2. `/Library/Managed Preferences/ai.opencode.managed.plist`

plist 的键**直接对应 `opencode.json` 的字段**，MDM 元数据键
（`PayloadUUID`、`PayloadType` 等）会被自动剥掉。支持 Jamf Pro、FleetDM、Kandji。

**两份 schema、两个文件**（这是 v1.18 时期的一个重要重构）：

| 文件 | 管什么 | schema |
|------|--------|--------|
| `opencode.json(c)` | 服务端 / 运行时：provider、model、permission、mcp、agent、lsp、formatter | `https://opencode.ai/config.json` |
| `tui.json(c)` | 纯 TUI：theme、keybinds、scroll、cursor、mouse、attention | `https://opencode.ai/tui.json` |

> **`opencode.json` 里的 `theme` / `keybinds` / `tui` 键已废弃**，
> 会在可能时自动迁移到 `tui.json`。这是「把客户端配置从服务端配置里拆出去」的
> 直接结果——TUI 只是一个客户端，它的配置不该和服务端行为混在一个文件里。

**项目配置的查找方式**：从当前目录开始，**向上遍历到最近的 Git 目录**。
项目 `opencode.json` 可以安全地提交进 Git，与全局用同一份 schema。

**其它值得知道的配置项：**

- **`instructions`**：复用已有规则文件，支持 glob 与**远程 URL**（5 秒超时）
  ```json
  { "instructions": ["CONTRIBUTING.md", "docs/guidelines.md", ".cursor/rules/*.md",
                     "packages/*/AGENTS.md",
                     "https://raw.githubusercontent.com/my-org/shared-rules/main/style.md"] }
  ```
- **`small_model`**：给标题生成这类轻活配一个便宜模型。不配时 opencode
  **自动尝试用该 provider 下更便宜的模型**，没有才回落到主模型。
- **provider 级超时**：`timeout`（默认 **300000ms**，设 `false` 关闭）、
  `chunkTimeout`（**流式 chunk 之间**的超时，超时即中止请求）、
  `setCacheKey`（确保指定 provider 始终带 cache key）。
- **`shell`**：指定交互终端与 agent 工具调用用的 shell。不设则自动发现
  （Windows 上 `pwsh`/`cmd.exe`，macOS/Linux 上 `/bin/zsh`/`/bin/bash`）。
- **图片附件归一化**：默认超过 `2000x2000` 像素或 `5242880` base64 字节就缩放。
  `attachment.image.auto_resize` 设 `false` 则改为**直接拒绝**超限图片。
  缩放后仍放不下时：工具结果里的图片被省略，用户提供的图片报错。
- **`experimental.policies`**：目前只能控制**允许用哪些 provider**（见 §22）。
- **`default_agent`**：必须是 primary 代理；指向不存在的或子代理时会回落。

**存储与缓存路径：**

| 路径 | 内容 |
|------|------|
| `~/.local/share/opencode/` | 应用数据根 |
| `~/.local/share/opencode/auth.json` | API key、OAuth token |
| `~/.local/share/opencode/mcp-auth.json` | MCP 的 OAuth 凭据 |
| `~/.local/share/opencode/log/` | 日志，时间戳命名，**保留最近 10 个** |
| `~/.local/share/opencode/project/<slug>/storage/` | 会话与消息数据（Git 仓库内的项目） |
| `~/.local/share/opencode/project/global/storage/` | 非 Git 项目的会话数据 |
| `~/.config/opencode/` | 配置根（`opencode.json`、`tui.json`、`agents/`、`commands/`、`plugins/`、`tools/`、`skills/`、`AGENTS.md`） |
| `~/.cache/opencode/node_modules/` | npm 插件与依赖缓存 |

> **一处历史遗留**：旧版安装的配置可能在
> `~/.local/share/opencode/opencode.jsonc`（而非 `~/.config/opencode/`）。
> 排查「配置不生效」时这是一个要检查的点。

**卸载**：`opencode uninstall`（会先列出将删除什么并要求确认）。
`--keep-config` / `--keep-data` / `--dry-run` / `--force`。

---

## 8. AGENTS.md 与规则系统

opencode 用 **`AGENTS.md`**（不是 `CLAUDE.md`）作为项目指令文件，
但**兼容读取 Claude Code 的约定**。

**`/init` 做什么**：扫描仓库重要文件，**在代码库回答不了时会反问几个针对性问题**，
然后创建或更新 `AGENTS.md`。它聚焦的内容（官方列举）：

- build / lint / test 命令
- 命令顺序与需要重点验证的步骤
- 从文件名看不出来的架构与仓库结构
- 项目特有约定、环境搭建怪癖、运维坑
- **指向已有指令源的引用**（Cursor / Copilot 规则）

已有 `AGENTS.md` 时，`/init` **就地改进而不是盲目覆盖**。

**三类位置：**

| 类型 | 位置 | 用途 |
|------|------|------|
| 项目 | 项目根 `AGENTS.md` | 团队共享，**建议提交进 Git** |
| 全局 | `~/.config/opencode/AGENTS.md` | 个人规则，不进 Git |
| Claude Code 兼容 | `CLAUDE.md`（项目）/ `~/.claude/CLAUDE.md`（全局） | 迁移用，作为**回落** |

**优先级**（每一类里**第一个命中的胜出**）：

1. 从当前目录**向上遍历**找本地文件（`AGENTS.md`、`CLAUDE.md`）
2. 全局 `~/.config/opencode/AGENTS.md`
3. Claude Code 全局 `~/.claude/CLAUDE.md`（未禁用时）

也就是说：**同时存在 `AGENTS.md` 与 `CLAUDE.md` 时只有 `AGENTS.md` 生效**。

**关掉 Claude Code 兼容**（三个粒度）：

```bash
export OPENCODE_DISABLE_CLAUDE_CODE=1         # 全关 .claude 支持
export OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1  # 只关 ~/.claude/CLAUDE.md
export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1  # 只关 .claude/skills
```

> **「兼容竞品的配置文件」是 opencode 一个贯穿性的产品选择**，不只在这一章：
> 规则读 `CLAUDE.md`，skills 读 `.claude/skills/` 与 `.agents/skills/`（§9）。
> 这降低了迁移成本；代价是**同一台机器上两个工具会读同一份指令文件**，
> 而这份文件里可能写着只对其中一个成立的内容。三个独立开关的存在
> 说明这个代价是被预期到的。

**外部文件引用**：opencode **不会自动解析 `AGENTS.md` 里的文件引用**。
要达到类似效果，官方推荐用 `opencode.json` 的 `instructions` 字段（见 §7），
而不是在 `AGENTS.md` 里写 `@path` 之类的语法。

---

## 9. Skills 系统

Skills 是**按需加载的可复用指令**：代理看得见有哪些 skill，需要时才把全文载入。
载入靠的是原生 `skill` 工具（§4）。

**六个搜索位置**（注意后四个是**竞品兼容**）：

| 位置 | 说明 |
|------|------|
| `.opencode/skills/<name>/SKILL.md` | 项目 |
| `~/.config/opencode/skills/<name>/SKILL.md` | 全局 |
| `.claude/skills/<name>/SKILL.md` | 项目，**Claude Code 兼容** |
| `~/.claude/skills/<name>/SKILL.md` | 全局，**Claude Code 兼容** |
| `.agents/skills/<name>/SKILL.md` | 项目，**agent 通用约定** |
| `~/.agents/skills/<name>/SKILL.md` | 全局，**agent 通用约定** |

**发现方式**：项目内路径从当前工作目录**向上遍历到 git worktree 为止**，
沿路命中的 `.opencode/skills/*/SKILL.md`、`.claude/skills/*/SKILL.md`、
`.agents/skills/*/SKILL.md` 全部载入。

**Frontmatter 只认 5 个字段**（其它未知字段**被忽略**，不报错）：

| 字段 | 必填 | 约束 |
|------|------|------|
| `name` | ✅ | 1–64 字符；小写字母数字 + 单个连字符分隔；不能以 `-` 开头结尾；不能有 `--`；**必须与所在目录名一致** |
| `description` | ✅ | **1–1024 字符** |
| `license` | | |
| `compatibility` | | |
| `metadata` | | string→string 映射 |

`name` 的等价正则：`^[a-z0-9]+(-[a-z0-9]+)*$`

**代理怎么看见 skill**：opencode 把清单塞进 `skill` 工具的**描述**里：

```xml
<available_skills>
  <skill>
    <name>git-release</name>
    <description>Create consistent releases and changelogs</description>
  </skill>
</available_skills>
```

模型调 `skill({ name: "git-release" })` 载入全文。

> **这个机制决定了 `description` 的分量：它是模型唯一的选择依据。**
> 1024 字符上限、以及官方那句「keep it specific enough for the agent to choose
> correctly」，说的是同一件事——写太笼统模型就挑错。

**权限：按 skill 名做模式匹配**（见 §5 的通配符语义）：

```json
{
  "permission": {
    "skill": {
      "*": "allow",
      "pr-review": "allow",
      "internal-*": "deny",
      "experimental-*": "ask"
    }
  }
}
```

| 动作 | 行为 |
|------|------|
| `allow` | 立即载入 |
| `deny` | **从代理视野里整个隐藏**，访问被拒 |
| `ask` | 载入前弹确认 |

也可以按 agent 覆盖（agent frontmatter 里写 `permission.skill`），
或**整个关掉 skill 工具**（`tools: { skill: false }`）——
关掉后 `<available_skills>` 段落**完全不出现**。

**排查载入失败的四步**（官方给的顺序）：确认 `SKILL.md` 是**全大写**；
确认 frontmatter 有 `name` 与 `description`；确认 skill 名在所有位置**唯一**；
检查权限——被 `deny` 的 skill 对代理不可见。

---

## 10. 自定义命令

自定义命令就是一段**预置的 prompt 模板**，在 TUI 里用 `/名字` 触发。

**两种定义方式。** Markdown（**文件名即命令名**）：

- 全局：`~/.config/opencode/commands/`
- 项目：`.opencode/commands/`

```markdown title=".opencode/commands/test.md"
---
description: Run tests with coverage
agent: build
model: anthropic/claude-3-5-sonnet-20241022
---

Run the full test suite with coverage report and show any failures.
Focus on the failing tests and suggest fixes.
```

或 JSON（`opencode.json` 的 `command` 下，`template` 是**必填**）。

**模板里的三种插值：**

| 语法 | 作用 |
|------|------|
| `$ARGUMENTS` | 全部参数 |
| `$1` `$2` `$3` … | 位置参数 |
| <code>!\`command\`</code> | **注入 shell 命令输出**（在项目根目录执行） |
| `@path/to/file` | **注入文件内容** |

```markdown title=".opencode/commands/analyze-coverage.md"
---
description: Analyze test coverage
---

Here are the current test results:
!`npm test`

Based on these results, suggest improvements to increase coverage.
```

> **<code>!\`cmd\`</code> 在命令模板里是无条件执行的**——它是模板展开的一部分，
> 发生在 prompt 组装阶段，不是模型发起的 tool call。
> 也就是说 §5 的 `bash` 权限**管不到它**：写进模板的命令由你自己负责。

**配置项：**

| 选项 | 说明 |
|------|------|
| `template` | **必填**（JSON 形态）。要发给模型的 prompt |
| `description` | TUI 里显示的说明 |
| `agent` | 用哪个 agent 执行。**若指向子代理，默认就触发子代理调用** |
| `subtask` | `true` **强制**以子代理方式跑，即使该 agent 是 `primary`——用来避免污染主上下文 |
| `model` | 覆盖模型 |

**自定义命令可以覆盖内置命令**（同名即覆盖）。

---

## 11. 自定义工具

自定义工具用 **TypeScript / JavaScript** 定义，但**工具内部可以调用任何语言写的脚本**——
TS/JS 只用于工具定义本身。

**位置**（文件名即工具名）：

- 项目：`.opencode/tools/`
- 全局：`~/.config/opencode/tools/`

```ts title=".opencode/tools/database-query.ts"
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Query the local database",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args, context) {
    // context 提供 directory / worktree 等上下文
    return runQuery(args.query)
  },
})
```

`args` 用的是 Zod schema（通过 `tool.schema` 暴露）。同名时**自定义工具覆盖内置工具**（§4）。

**依赖管理**：自定义工具与本地插件可以用外部 npm 包——
在 config 目录放一个 `package.json`，opencode **启动时跑 `bun install`**：

```json title=".opencode/package.json"
{ "dependencies": { "shescape": "^2.1.0" } }
```

---

## 12. CLI 命令与参数

`opencode` 不带参数就起 TUI。以下是完整的子命令面。

**`tui`（默认）参数：**

| 参数 | 短 | 说明 |
|------|----|------|
| `--continue` | `-c` | 继续上一个会话 |
| `--session` | `-s` | 按 ID 继续会话 |
| `--fork` | | 继续时**分叉**会话（配合 `-c` / `-s`） |
| `--prompt` | | 预置 prompt |
| `--model` | `-m` | `provider/model` |
| `--agent` | | 指定 agent |
| `--auto` | | **自动批准所有非显式 deny 的权限**（见 §5） |
| `--port` / `--hostname` | | 服务端监听地址 |
| `--mdns` / `--mdns-domain` | | mDNS 服务发现 |
| `--cors` | | 额外允许的浏览器 origin |

**子命令一览：**

| 命令 | 说明 |
|------|------|
| `agent create` / `agent list` | 创建 / 列出 agent（见 §6） |
| `attach [url]` | 把 TUI 接到已在跑的服务端（`serve` / `web` 起的） |
| `auth login` / `list` / `logout` | 凭据管理，写 `~/.local/share/opencode/auth.json` |
| `github install` / `run` | GitHub agent（见 §21） |
| `mcp add` / `list` / `auth` / `logout` / `debug` | MCP 管理（见 §16） |
| `models [provider]` | 列出全部可用模型。`--refresh` 刷 models.dev 缓存，`--verbose` 带成本元数据 |
| `run "<prompt>"` | **非交互模式**（见下） |
| `serve` | 无 TUI 的 HTTP 服务端（见 §17） |
| `web` | 起服务端 + 开浏览器 |
| `session list` / `delete` | 会话管理。`-n` 限制条数，`--format table\|json` |
| `stats` | **token 用量与成本统计**。`--days N`、`--tools N`、`--models` |
| `export` / `import` | 会话导出 / 导入 |
| `acp` | 以 **ACP**（Agent Client Protocol）模式跑，供编辑器接入（见 §20） |
| `plugin` | 插件管理 |
| `pr` | PR 相关 |
| `db` / `db path` | 数据库操作与路径 |
| `debug` | 调试 |
| `uninstall` | 卸载（`--keep-config` / `--keep-data` / `--dry-run` / `--force`） |
| `upgrade [target]` | 升级到最新或指定版本。`--method curl\|npm\|pnpm\|bun\|brew` |

**`run` 的参数**（非交互模式，脚本与 CI 的入口）：

```bash
opencode run "Explain how closures work in JavaScript"
opencode run --format json "list the exported symbols in src/index.ts"

# 接到已在跑的服务端，避免每次都付 MCP 冷启动成本
opencode run --attach http://localhost:4096 "run the test suite"
```

| 参数 | 短 | 说明 |
|------|----|------|
| `--command` | | 要跑的命令，用 message 传参 |
| `--continue` / `--session` / `--fork` | `-c` / `-s` | 会话延续与分叉 |
| `--share` | | 分享会话 |
| `--model` / `--agent` | `-m` | 模型与代理 |
| `--file` | `-f` | **附加文件**到消息 |
| `--format` | | `default`（格式化）或 `json`（原始 JSON 事件流） |
| `--title` | | 会话标题（不给值则用截断的 prompt） |
| `--attach` | | **接到已在跑的服务端**（如 `http://localhost:4096`） |
| `--username` / `--password` | `-u` / `-p` | 服务端 basic auth |
| `--dir` | | 运行目录，或接远端时的远端路径 |
| `--port` | | 本地服务端端口（默认随机） |
| `--variant` | | **模型变体**（provider 特有的 reasoning effort 档） |
| `--thinking` | | 显示 thinking 块 |
| `--auto` | | 自动批准非显式 deny 的权限 |

> **`--attach` 存在的理由官方写得很明确：避免每次 run 都付 MCP 服务器冷启动成本。**
> 这是客户端/服务器架构（§2）在 CI 场景下的直接收益——
> 起一个常驻服务端，之后每次 `run` 都是一个 HTTP 请求。

**全局参数：**

| 参数 | 短 | 说明 |
|------|----|------|
| `--help` | `-h` | 帮助 |
| `--version` | `-v` | 版本号 |
| `--print-logs` | | 日志打到 stderr |
| `--log-level` | | `DEBUG` / `INFO` / `WARN` / `ERROR` |
| `--pure` | | **不加载任何外部插件** |

**环境变量（正式 25 个 + 实验性 18 个）。** 正式的
（下表另附一个 `OPENCODE_INSTALL_DIR`——它由 install 脚本使用，
不在官方 CLI 文档的环境变量表里）：

| 变量 | 类型 | 说明 |
|------|------|------|
| `OPENCODE_CONFIG` / `_DIR` / `_CONTENT` | string | 配置文件路径 / 目录 / 内联 JSON |
| `OPENCODE_TUI_CONFIG` | string | TUI 配置路径 |
| `OPENCODE_PERMISSION` | string | 内联权限 JSON |
| `OPENCODE_AUTO_SHARE` | bool | 自动分享会话 |
| `OPENCODE_SERVER_PASSWORD` / `_USERNAME` | string | `serve`/`web` 的 basic auth |
| `OPENCODE_DISABLE_AUTOUPDATE` | bool | 关自动更新检查 |
| `OPENCODE_DISABLE_AUTOCOMPACT` | bool | **关自动上下文压缩** |
| `OPENCODE_DISABLE_PRUNE` | bool | 关旧数据清理 |
| `OPENCODE_DISABLE_DEFAULT_PLUGINS` | bool | 关默认插件 |
| `OPENCODE_DISABLE_LSP_DOWNLOAD` | bool | 关 LSP 服务器自动下载 |
| `OPENCODE_DISABLE_MODELS_FETCH` | bool | 关远程模型清单拉取 |
| `OPENCODE_MODELS_URL` | string | 自定义模型清单 URL |
| `OPENCODE_DISABLE_CLAUDE_CODE` / `_PROMPT` / `_SKILLS` | bool | 关 Claude Code 兼容（三粒度，见 §8） |
| `OPENCODE_DISABLE_MOUSE` | bool | 关 TUI 鼠标捕获 |
| `OPENCODE_DISABLE_TERMINAL_TITLE` | bool | 关终端标题自动更新 |
| `OPENCODE_ENABLE_EXA` | bool | 开 Exa 联网搜索工具（见 §4） |
| `OPENCODE_ENABLE_EXPERIMENTAL_MODELS` | bool | 开实验模型 |
| `OPENCODE_GIT_BASH_PATH` | string | Windows 上 Git Bash 路径 |
| `OPENCODE_CLIENT` | string | 客户端标识（默认 `cli`） |
| `OPENCODE_FAKE_VCS` | string | 测试用的假 VCS provider |
| `OPENCODE_INSTALL_DIR` | string | 安装目录（install 脚本用） |

**实验性环境变量（18 个）**——这份清单是**最好的路线图信号**，
因为它暴露了「已经写了代码但还不敢默认开」的功能：

| 变量 | 透露的东西 |
|------|-----------|
| `OPENCODE_EXPERIMENTAL` | 总开关（打开它等于打开下面一批） |
| `OPENCODE_EXPERIMENTAL_PLAN_MODE` | **Plan mode 仍在实验开关后面** |
| `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` | **后台子代理任务** |
| `OPENCODE_EXPERIMENTAL_WORKSPACES` | **workspace 支持** |
| `OPENCODE_EXPERIMENTAL_SCOUT` | Scout 子代理（已进正式文档，见 §6） |
| `OPENCODE_EXPERIMENTAL_NATIVE_LLM` | **绕过 AI SDK 的原生 LLM 请求路径** |
| `OPENCODE_EXPERIMENTAL_EVENT_SYSTEM` | 新事件系统 |
| `OPENCODE_EXPERIMENTAL_LSP_TOOL` | LSP 工具（见 §4） |
| `OPENCODE_EXPERIMENTAL_LSP_TY` | Python 的 TY LSP |
| `OPENCODE_EXPERIMENTAL_PARALLEL` | 并行联网搜索 |
| `OPENCODE_EXPERIMENTAL_EXA` | Exa 实验特性 |
| `OPENCODE_EXPERIMENTAL_OXFMT` | oxfmt 格式化器（见 §15） |
| `OPENCODE_EXPERIMENTAL_FILEWATCHER` / `_DISABLE_FILEWATCHER` | 全目录文件监听（**开与关各一个变量**） |
| `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS` | bash 默认超时 |
| `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX` | 最大输出 token |
| `OPENCODE_EXPERIMENTAL_ICON_DISCOVERY` | 图标发现 |
| `OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT` | 关 TUI 选中即复制 |

> **`OPENCODE_EXPERIMENTAL_NATIVE_LLM` 值得单独盯。** opencode 目前的
> provider 无关性建立在 AI SDK 之上（§2），而这个开关意味着存在一条
> **绕过 AI SDK 直接发请求**的路径（`packages/llm` 里已经有 `aws4fetch`
> 直连 Bedrock 的痕迹）。若它将来转正，「provider 抽象由谁提供」这个架构问题
> 会有新答案。**这是我从变量名与依赖推断的方向，不是官方声明的路线。**

---

## 13. 插件系统

opencode 的插件是 **JS/TS 模块**，导出一个或多个插件函数；每个函数收一个 context、
返回一个 hooks 对象。它同时承担了「Hook 系统」的职责——
opencode 没有独立的 Hook 配置层，**hook 就是插件的返回值**。

**两种加载方式。** 本地文件（启动时自动加载）：

- 项目：`.opencode/plugins/`
- 全局：`~/.config/opencode/plugins/`

或 npm 包（config 里声明）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-helicone-session", "opencode-wakatime", "@my-org/custom-plugin"]
}
```

**npm 插件由 Bun 在启动时自动安装**，缓存在 `~/.cache/opencode/node_modules/`。

**加载顺序（所有 hook 按序执行）：**

1. 全局 config（`~/.config/opencode/opencode.json`）
2. 项目 config（`opencode.json`）
3. 全局插件目录（`~/.config/opencode/plugins/`）
4. 项目插件目录（`.opencode/plugins/`）

同名同版本的 npm 包只加载一次；但**同名的本地插件与 npm 插件会各自独立加载两次**。

**插件函数签名：**

```ts
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async ({ project, client, $, directory, worktree }) => {
  return {
    "tool.execute.before": async (input, output) => { /* ... */ },
  }
}
```

| context 字段 | 说明 |
|--------------|------|
| `project` | 当前项目信息 |
| `directory` | 当前工作目录 |
| `worktree` | git worktree 路径 |
| `client` | **opencode SDK 客户端**——插件可以反过来调服务端 API |
| `$` | **Bun 的 shell API**，直接执行命令 |

> **`client` 与 `$` 一起给出来，意味着插件的能力上界很高**：
> 它能调服务端全部 API（创建会话、发 prompt、改配置），也能执行任意 shell 命令。
> **插件没有权限沙箱**——§5 的权限体系管的是模型的工具调用，不是插件代码。
> 这是 `--pure`（不加载任何外部插件）与 `OPENCODE_DISABLE_DEFAULT_PLUGINS`
> 两个开关存在的理由。装第三方插件等于执行第三方代码。

**事件清单（28 个，按域分组）：**

| 域 | 事件 |
|----|------|
| **Tool** | `tool.execute.before`、`tool.execute.after` |
| **Session** | `session.created`、`session.compacted`、`session.deleted`、`session.diff`、`session.error`、`session.idle`、`session.status`、`session.updated` |
| **Message** | `message.updated`、`message.removed`、`message.part.updated`、`message.part.removed` |
| **Permission** | `permission.asked`、`permission.replied` |
| **File** | `file.edited`、`file.watcher.updated` |
| **LSP** | `lsp.client.diagnostics`、`lsp.updated` |
| **TUI** | `tui.prompt.append`、`tui.command.execute`、`tui.toast.show` |
| **Command** | `command.executed` |
| **Todo** | `todo.updated` |
| **Shell** | `shell.env` |
| **Server** | `server.connected` |
| **Installation** | `installation.updated` |

**几个典型用法。** 拦截工具调用（`.env` 保护）：

```js title=".opencode/plugins/env-protection.js"
export const EnvProtection = async () => ({
  "tool.execute.before": async (input, output) => {
    if (input.tool === "read" && output.args.filePath.includes(".env")) {
      throw new Error("Do not read .env files")
    }
  },
})
```

> **拦截的方式是 `throw`**，不是返回一个 decision 对象。
> 这与 Claude Code 的 hook（靠退出码与 JSON 决策字段）是不同的协议形态：
> opencode 的 hook 就是普通 async 函数，**抛异常即阻断**。
> 好处是没有协议需要记；代价是**「阻断」与「插件自己出 bug」在信号上不可区分**。

**改写工具入参**（`output.args` 是可写的）：

```ts
"tool.execute.before": async (input, output) => {
  if (input.tool === "bash") output.args.command = escape(output.args.command)
}
```

**注入环境变量**（对 AI 工具与用户终端**都生效**）：

```js
"shell.env": async (input, output) => {
  output.env.MY_API_KEY = "secret"
  output.env.PROJECT_ROOT = input.cwd
}
```

**插件也能提供工具**（同名时覆盖内置，见 §4）：

```ts
import { type Plugin, tool } from "@opencode-ai/plugin"

export const CustomToolsPlugin: Plugin = async () => ({
  tool: {
    mytool: tool({
      description: "This is a custom tool",
      args: { foo: tool.schema.string() },
      async execute(args, context) {
        return `Hello ${args.foo} from ${context.directory}`
      },
    }),
  },
})
```

**日志**：用 `client.app.log()` 而不是 `console.log`（级别 `debug`/`info`/`warn`/`error`）：

```ts
await client.app.log({
  body: { service: "my-plugin", level: "info", message: "Plugin initialized", extra: { foo: "bar" } },
})
```

**压缩 hook**：插件可以定制会话被压缩时纳入的上下文（见 §14）。

---

## 14. 会话管理与上下文压缩

**存储位置**（见 §7 全表）：

- Git 仓库内的项目：`~/.local/share/opencode/project/<project-slug>/storage/`
- 非 Git 项目：`~/.local/share/opencode/project/global/storage/`

底层是 **SQLite + Drizzle ORM**（`drizzle-orm@1.0.0-rc.2`），
而不是 JSONL 平铺文件——这与 Claude Code 的会话存储形态不同。

**会话操作：**

| 操作 | 入口 |
|------|------|
| 列出 / 切换 | `/sessions`（别名 `/resume`、`/continue`），键位 `<leader>l` |
| 新建 | `/new`（别名 `/clear`），`<leader>n` |
| 继续上一个 | `opencode -c` |
| 按 ID 继续 | `opencode -s <id>` |
| **分叉** | `--fork`（配合 `-c` / `-s`）；TUI 里 `session_fork` |
| 命令行列出 | `opencode session list -n 20 --format json` |
| 删除 | `opencode session delete` |
| 导出 / 导入 | `opencode export` / `opencode import`；TUI 里 `/export`（`<leader>x`） |
| 重命名 | `ctrl+r` |
| 时间线 | `session_timeline`（`<leader>g`） |

**撤销 / 重做**（这是 opencode 一个很实用的差异化功能）：

```
/undo    # 撤销最近一条用户消息、其后所有响应，以及文件改动
/redo    # 重做
```

- **文件改动会一起回滚**
- **内部用 Git 实现**，所以**项目必须是 Git 仓库**
- `/undo` 可以连续执行多次
- 撤销后原始 prompt 会重新显示出来，方便你改了再试
- 键位：`<leader>u` / `<leader>r`

> **`/undo` 把「代理改坏了」从一个需要人工 `git checkout` 的事故降级成一次按键。**
> 代价是它依赖 Git——非 Git 项目里这个安全网不存在。
> 另外它撤销的粒度是**一轮对话**（一条用户消息 + 其后全部响应），
> 不是单个工具调用。

**自动压缩（Auto-compaction）**：由隐藏的 `compaction` 系统代理执行（§6），
上下文长了自动触发，可用 `OPENCODE_DISABLE_AUTOCOMPACT` 关掉。
手动触发是 `/compact`（别名 `/summarize`，键位 `<leader>c`）。

**插件可以定制压缩时纳入什么**（compaction hook，见 §13）。
v1.18.15 的 release note 里有一条相关修复值得记：
「**Repeated compaction now keeps earlier tool-call history in summaries
instead of dropping orphaned results**」——反复压缩曾经会丢掉早期的工具调用历史。

**上下文相关的一条提醒**（官方在 MCP 页面明确写出）：
**MCP 服务器会占用上下文，工具多了很快堆起来**。
官方点名 GitHub MCP server「tend to add a lot of tokens and can easily exceed
the context limit」。

**会话分享**：三种模式（`share` 配置项）：

| 模式 | 行为 |
|------|------|
| `manual`（**默认**） | 不自动分享，`/share` 手动生成链接 |
| `auto` | 所有新会话自动分享 |
| `disabled` | 禁止分享 |

分享链接形态是 `opncd.ai/s/<share-id>`，会**把对话历史同步到官方服务器**，
**任何拿到链接的人都能看**。取消分享用 `/unshare`。
环境变量 `OPENCODE_AUTO_SHARE` 也能开自动分享。

> **GitHub 集成的默认值在这里有个交互要注意**：`opencode github` 的 `share` 参数
> **对公开仓库默认为 true**（§21）。也就是说在公开仓库上跑 GitHub agent，
> 会话默认是被分享出去的。

---

## 15. LSP 与代码格式化

### 15.1 LSP

**默认关闭。** 这是 opencode 一个明确的立场，且官方给了完整的理由。

**内置 LSP 服务器（34 个）：**

| 语言族 | 服务器 | 前置条件 |
|--------|--------|----------|
| TypeScript/JS | `typescript` | 项目里有 `typescript` 依赖 |
| | `deno` | `deno` 命令可用（自动识别 `deno.json`） |
| | `eslint` | 项目里有 `eslint` 依赖 |
| | `oxlint` | 项目里有 `oxlint` 依赖 |
| Python | `pyright` | 装了 `pyright` 依赖 |
| Rust | `rust` | `rust-analyzer` 可用 |
| Go | `gopls` | `go` 命令可用 |
| Java | `jdtls` | **JDK 21+** |
| C/C++ | `clangd` | **为 C/C++ 项目自动安装** |
| C#/F# | `csharp` / `fsharp` / `razor` | `.NET SDK`（razor 还需 VS Code C# 扩展） |
| Ruby | `ruby-lsp`(rubocop) | `ruby` + `gem` |
| PHP | `intelephense` | **自动安装** |
| Swift/ObjC | `sourcekit-lsp` | `swift`（macOS 上需 Xcode） |
| Kotlin | `kotlin-ls` | **自动安装** |
| Dart | `dart` | `dart` 命令 |
| Elixir | `elixir-ls` | `elixir` 命令 |
| Haskell | `hls` | `haskell-language-server-wrapper` |
| Clojure | `clojure-lsp` | `clojure-lsp` 命令 |
| OCaml | `ocaml-lsp` | `ocamllsp` |
| Julia | `julials` | `julia` + `LanguageServer.jl` |
| Zig | `zls` | `zig` 命令 |
| Gleam | `gleam` | `gleam` 命令 |
| Nix | `nixd` | `nixd` 命令 |
| Lua | `lua-ls` | **自动安装** |
| Bash | `bash` | **自动安装** bash-language-server |
| 前端框架 | `vue` / `svelte` / `astro` | **自动安装** |
| 基础设施 | `terraform` | **从 GitHub releases 自动安装** |
| 排版 | `tinymist`（Typst） | **自动安装** |
| 配置 | `yaml-ls` / `prisma` | 自动安装 / `prisma` 命令 |

**开关语义有四档，别混：**

```json
{ "lsp": true }              // 开启全部内置
{ "lsp": {} }                // 保持内置开启，同时做覆盖配置
{ "lsp": false }             // 关闭全部（用来推翻另一层配置的开启）
// 完全省略 lsp 字段        →  全部关闭
```

单个服务器的配置项：`disabled`、`command`（string[]）、`extensions`、
`env`、`initialization`。自定义服务器只需给 `command` + `extensions`。

> **官方明确劝你别默认开 LSP，理由写得很实在**（原文大意）：
> 语言服务器会失同步、吃大量内存、随版本与项目而异、拖慢代理流程。
> **多数项目里更好的做法是让代理直接跑 lint / typecheck 这类 CLI 工具**，
> 把错误喂回代理循环，从而避开上述代价——并把这些命令写进 `AGENTS.md` 或 skill
> 让代理知道该跑什么。
>
> 这是本文里少见的、**厂商主动劝用户不要用自家功能**的地方。
> 它也解释了为什么 §4 里的 `lsp` **工具**还藏在实验开关后面：
> LSP 在 opencode 的定位是「诊断回灌」（编辑后自动取诊断），
> 而不是「给模型一个代码智能查询工具」。

**关自动下载**：`OPENCODE_DISABLE_LSP_DOWNLOAD=true`。
**PHP Intelephense 授权**：把 key 单独放在 `$HOME/intelephense/license.txt`
（Windows 上 `%USERPROFILE%/intelephense/license.txt`），文件里只能有 key。

### 15.2 格式化器

**内置 26 个格式化器**，命中即在**后台**跑（opencode 写完/编辑完文件之后）：

| 格式化器 | 触发条件 |
|----------|----------|
| `prettier` | `package.json` 里有 `prettier` 依赖 |
| `biome` | 有 `biome.json(c)` |
| `oxfmt`（**实验**） | `package.json` 里有 `oxfmt` + 实验开关（`OPENCODE_EXPERIMENTAL_OXFMT`） |
| `gofmt` / `cargofmt` / `rustfmt` | 对应命令可用 |
| `ruff` / `uv` | Python，命令可用（ruff 还需配置） |
| `clang-format` | 有 `.clang-format` |
| `ktlint` / `dart` / `zig` / `gleam` / `dfmt` / `nixfmt` | 命令可用 |
| `rubocop` / `standardrb` / `htmlbeautifier` | Ruby 系 |
| `pint` | `composer.json` 里有 `laravel/pint` |
| `mix` | Elixir |
| `ormolu` | Haskell |
| `ocamlformat` | 需命令 + `.ocamlformat` |
| `cljfmt` | Clojure |
| `shfmt` | Shell |
| `terraform` | `terraform` 命令 |
| `air` | R |

开关语义与 LSP 一致（`true` / `{}` / `false` / 省略）。
**同时有 prettier 与 biome 时，若 `package.json` 里有 prettier 就用 prettier。**

---

## 16. MCP 协议集成

opencode 作为 **MCP 客户端**，支持本地（stdio）与远程（HTTP）两种服务器。
接进来的 MCP 工具**自动与内置工具并列**暴露给模型。

**本地服务器：**

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "my-local-mcp-server": {
      "type": "local",
      "command": ["npx", "-y", "my-mcp-command"],
      "enabled": true,
      "environment": { "MY_ENV_VAR": "my_env_var_value" }
    }
  }
}
```

| 选项 | 必填 | 说明 |
|------|------|------|
| `type` | ✅ | `"local"` |
| `command` | ✅ | 启动命令与参数（数组） |
| `cwd` | | 工作目录，相对路径从 workspace 解析 |
| `environment` | | 环境变量 |
| `enabled` | | 启动时是否启用 |
| `timeout` | | **拉取工具清单**的超时，默认 **5000ms** |

**远程服务器：**

```json
{
  "mcp": {
    "my-remote-mcp": {
      "type": "remote",
      "url": "https://my-mcp-server.com",
      "enabled": true,
      "headers": { "Authorization": "Bearer MY_API_KEY" }
    }
  }
}
```

选项：`type`(✅)、`url`(✅)、`enabled`、`headers`、`oauth`、`timeout`（默认 5000ms）。

**OAuth 自动处理**（这是 opencode MCP 支持里比较完整的一块）：

1. 检测到 **401** 就发起 OAuth 流程
2. 服务器支持时使用 **Dynamic Client Registration（RFC 7591）**
3. token 安全存储在 `~/.local/share/opencode/mcp-auth.json`
4. token 过期自动刷新

对应 CLI：`opencode mcp auth [server]`、`opencode mcp logout`、
`opencode mcp debug`（排查 OAuth 连接问题）、`opencode mcp list`（含连接状态）。

**组织远端默认值的覆盖**：组织可通过 `.well-known/opencode` 下发一批 MCP 服务器
（可以是默认 disabled 的），用户在本地 config 里写 `enabled: true` 逐个打开（见 §7）。

**MCP 工具的权限**用通配符统一管（见 §5）：

```json
{ "permission": { "mymcp_*": "ask" } }
```

> **官方对 MCP 的态度是明确保留的**（原文大意）：MCP 服务器会加上下文，
> 工具一多很快堆起来，**所以建议谨慎选择启用哪些**；并点名 GitHub MCP server
> 容易超上下文限制。这与 §15 劝退 LSP 是同一种取向——
> **把「省上下文」放在「功能齐全」前面**。

---

## 17. 服务端与 SDK

### 17.1 HTTP 服务端

```bash
opencode serve [--port 4096] [--hostname 127.0.0.1] [--cors <origin>]
```

| 参数 | 默认 |
|------|------|
| `--port` | **4096** |
| `--hostname` | **127.0.0.1** |
| `--mdns` | `false` |
| `--mdns-domain` | `opencode.local` |
| `--cors` | `[]`（可重复传多次，值必须是完整 origin） |

**认证**：设 `OPENCODE_SERVER_PASSWORD` 开 HTTP basic auth，
用户名默认 `opencode`（可用 `OPENCODE_SERVER_USERNAME` 改）。
对 `serve` 与 `web` **都生效**。

> ⚠️ **默认没有认证**。`opencode serve` 默认只绑 `127.0.0.1`，所以默认状态是安全的；
> 但一旦为了局域网/远程访问改成 `--hostname 0.0.0.0`（官方在 `attach` 的例子里
> 就是这么演示的），**不设 `OPENCODE_SERVER_PASSWORD` 就等于把一个能读写文件、
> 能跑任意 shell 命令的 API 暴露在网络上**。
> mDNS（`--mdns`）还会主动向局域网广播这个服务的存在。
> 这一条官方文档没有用警示框标出来，但它是本文里安全后果最重的一处默认值。

**OpenAPI 3.1 spec** 在 `http://<hostname>:<port>/doc`，SDK 由它生成。

**API 分组**（`GET`/`POST`/`PATCH`/`DELETE`，仅列分组与代表端点）：

| 分组 | 代表端点 |
|------|----------|
| Global | `/global/health`（健康与版本）、`/global/event`（**SSE 事件流**） |
| Project | `/project`、`/project/current` |
| Path & VCS | `/path`、`/vcs` |
| Instance | `/instance/dispose` |
| Config | `GET`/`PATCH` `/config`、`/config/providers` |
| Provider | `/provider`、`/provider/auth`、`/provider/{id}/oauth/authorize` |
| Session | 会话增删改查、prompt、分享、压缩、revert 等 |
| Files | 文件读写与搜索 |
| TUI | **驱动 TUI**：预填或直接执行 prompt（IDE 插件就是走这条） |

> **`/tui` 端点是 IDE 集成的实现基础**：编辑器插件不必自己实现一套 UI，
> 而是通过 HTTP 让已经跑着的 TUI 去执行。

### 17.2 JS/TS SDK

```bash
npm install @opencode-ai/sdk
```

**两种用法。** 起服务端 + 客户端：

```javascript
import { createOpencode } from "@opencode-ai/sdk"

const opencode = await createOpencode({
  hostname: "127.0.0.1",
  port: 4096,
  config: { model: "anthropic/claude-3-5-sonnet-20241022" },
})
console.log(`Server running at ${opencode.server.url}`)
opencode.server.close()
```

选项：`hostname`（`127.0.0.1`）、`port`（`4096`）、`signal`（AbortSignal）、
`timeout`（启动超时 **5000ms**）、`config`。
**内联 config 会与你的 `opencode.json` 合并**（仍然读取磁盘配置，内联的作为覆盖）。

只要客户端（接已有服务端）：

```javascript
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })
```

选项：`baseUrl`、`fetch`（自定义实现）、`parseAs`、
`responseStyle`（`data` / `fields`，默认 `fields`）、`throwOnError`（默认 `false`）。

**结构化输出**（把模型输出约束成 JSON Schema）：

```typescript
const result = await client.session.prompt({
  path: { id: sessionId },
  body: {
    parts: [{ type: "text", text: "Research Anthropic and provide company info" }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { company: { type: "string" }, founded: { type: "number" } },
      },
    },
  },
})
```

实现方式是**让模型调一个 `StructuredOutput` 工具**返回校验过的 JSON。
类型定义全部由服务端 OpenAPI spec 生成（`packages/sdk/js/src/gen/types.gen.ts`）。

---

## 18. TUI 参考

### 18.1 交互基础

| 用法 | 说明 |
|------|------|
| `@` | **模糊搜索文件**并把内容加入对话；也能触发已配置的 references（`@alias` / `@alias/`） |
| `!` 开头 | **执行 shell 命令**，输出作为 tool result 进对话 |
| `/` 开头 | 斜杠命令 |
| **Tab** | 切换 primary agent（build ↔ plan） |
| 拖拽图片 | 把图片加入 prompt |

### 18.2 内置斜杠命令

| 命令 | 别名 | 键位 | 说明 |
|------|------|------|------|
| `/connect` | | | 添加 provider 与 API key |
| `/init` | | | 生成/更新 `AGENTS.md`（§8） |
| `/models` | | `<leader>m` | 列出可用模型 |
| `/new` | `/clear` | `<leader>n` | 新会话 |
| `/sessions` | `/resume`、`/continue` | `<leader>l` | 列出并切换会话 |
| `/compact` | `/summarize` | `<leader>c` | 压缩当前会话 |
| `/undo` | | `<leader>u` | 撤销（含文件改动，需 Git） |
| `/redo` | | `<leader>r` | 重做 |
| `/share` / `/unshare` | | | 分享 / 取消分享（§14） |
| `/export` | | `<leader>x` | 导出为 Markdown 并用 `$EDITOR` 打开 |
| `/editor` | | `<leader>e` | 用外部编辑器写消息 |
| `/themes` | | `<leader>t` | 主题列表 |
| `/details` | | | 切换工具执行详情 |
| `/thinking` | | | 切换 **thinking 块的显示**（**不改变模型是否推理**） |
| `/help` | | | 帮助 |
| `/exit` | `/quit`、`/q` | `<leader>q` | 退出 |

> **`/thinking` 只管显示、不管能力**，官方专门加了注解。
> 要切换真正的推理能力用 **`ctrl+t`**（循环模型变体 variant）。
> 这两件事被放在两个不同的入口，是容易误解的一处。

### 18.3 键位体系

键位配在 **`tui.json`**（不是 `opencode.json`，见 §7）。
**leader 键默认 `ctrl+x`**，`leader_timeout` 默认 **2000ms**。

值得记的几个非 leader 键位：

| 动作 | 默认键 |
|------|--------|
| 命令面板 | `ctrl+p` |
| 中断会话 | `escape` |
| 切换 agent | `tab` / `shift+tab` |
| **切换模型变体**（reasoning 档） | `ctrl+t` |
| provider 列表 | `ctrl+a` |
| 收藏模型 | `ctrl+f` |
| 最近模型循环 | `f2` / `shift+f2` |
| 重命名会话 | `ctrl+r` |
| 退出 | `ctrl+c` / `ctrl+d` |
| 子会话导航 | `<leader>down` / `left` / `right` / `up`（§6） |

设成 `"none"` 即禁用某个键位。**大量动作默认就是 `none`**
（`session_fork`、`session_share`、`mcp_list`、`prompt_skills`、`workspace_set` 等）——
也就是说这些功能存在但没有默认快捷键，得自己配或走命令面板。

### 18.4 Attention（通知）

`tui.json` 里 `attention.enabled` 开启**桌面通知与提示音**。
桌面 App 则可以在响应就绪或会话出错时自动发系统通知。

### 18.5 主题

内置多套主题（默认 `opencode`），`/themes` 切换。
支持自定义主题 JSON，放 `~/.config/opencode/themes/` 或 `.opencode/themes/`。
主题支持 `system` 跟随终端明暗、以及 ANSI 颜色引用。

---

## 19. Web 与 Desktop

**`opencode web`**：起服务端并打开浏览器。参数与 `serve` 同源
（`--port` / `--hostname` / `--cors` / `--mdns`），同样受
`OPENCODE_SERVER_PASSWORD` 保护。

典型的远程用法（官方示例）：

```bash
# 机器 A：起后端，允许局域网访问
opencode web --port 4096 --hostname 0.0.0.0

# 机器 B：把 TUI 接过去
opencode attach http://10.20.30.40:4096
```

> 见 §17 的安全提醒——`0.0.0.0` + 无密码是危险组合。

**Desktop App（BETA）** 的能力（取自 v1.18.15 release note 与文档）：

- 会话管理 UI、**完整会话转录导出为 JSON**
- 系统通知（响应就绪 / 会话出错）
- **广泛的本地化覆盖**（v1.18.15 新增）
- 自动更新（`electron-updater`）

**桌面版排查手段**（文档专门给了一节，说明 BETA 期问题不少）：
禁用插件、清缓存（`~/.cache/opencode`）、修服务端连接问题、
Linux 的 Wayland/X11 问题、Windows 的 WebView2 运行时、通知不显示、
**重置桌面存储（最后手段）**。

---

## 20. ACP 与编辑器集成

opencode 通过 **ACP（Agent Client Protocol）** 接入编辑器，
而不是为每个编辑器写一个插件。

```bash
opencode acp
```

ACP 是一个基于 **stdio 的 JSON-RPC** 协议，编辑器作为 client、opencode 作为 agent。
支持 ACP 的编辑器（Zed 等）可以直接把 opencode 当作后端。

**IDE 支持现状：**

| 编辑器 | 方式 |
|--------|------|
| Zed | **ACP 原生** |
| Neovim / 其它 | ACP 或社区插件（§25） |
| VS Code | 独立扩展线（仓库 tag `vscode-v0.0.13`） |
| 任意编辑器 | 通过 `/tui` 端点驱动已运行的 TUI（§17） |

> **「用一个协议替代 N 个插件」是 opencode 与 Codex / Claude Code 的路线差异**：
> 后两者都在维护自己的 VS Code / JetBrains 扩展。
> ACP 的代价是**只有支持 ACP 的编辑器能受益**，
> 而 ACP 目前的采纳面远小于 VS Code 扩展生态。
> opencode 两条路都留着——ACP 加一条 VS Code 扩展线。

---

## 21. GitHub 与 GitLab 集成

### 21.1 GitHub

在 issue / PR 评论里提 **`/opencode`** 或 **`/oc`**，opencode 就在
**你自己的 GitHub Actions runner 里**执行。

```bash
opencode github install    # 引导安装 App、创建 workflow、配 secrets
```

手动配置的话，装 [github.com/apps/opencode-agent](https://github.com/apps/opencode-agent)，
然后加 workflow：

```yaml title=".github/workflows/opencode.yml"
name: opencode
on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
jobs:
  opencode:
    if: |
      contains(github.event.comment.body, '/oc') ||
      contains(github.event.comment.body, '/opencode')
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v6
        with:
          fetch-depth: 1
          persist-credentials: false
      - name: Run OpenCode
        uses: anomalyco/opencode/github@latest
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          model: anthropic/claude-sonnet-4-20250514
```

**注意 action 名是 `anomalyco/opencode/github@latest`**——旧文档里的 `sst/...` 会失败。

**配置项：**

| 参数 | 说明 |
|------|------|
| `model` | **必填**，`provider/model` |
| `agent` | 必须是 primary agent；找不到则回落 `default_agent` 或 `"build"` |
| `share` | 是否分享会话。**公开仓库默认 true** |
| `prompt` | 自定义 prompt，覆盖默认行为（`issues` / `schedule` / `workflow_dispatch` 事件**必填**） |
| `token` | 可选 GitHub token。默认用 OpenCode GitHub App 的 installation token，所以提交/评论/PR 显示为 App 发出 |

**支持的 6 类事件：**

| 事件 | 触发 |
|------|------|
| `issue_comment` | issue/PR 评论里提 `/opencode` 或 `/oc` |
| `pull_request_review_comment` | 代码行级评论；opencode 能拿到文件路径、行号、diff 上下文 |
| `issues` | issue 创建/编辑时自动触发（需 `prompt`） |
| `pull_request` | PR 开启/同步/重开时自动触发，适合自动评审 |
| `schedule` | **cron 定时**（需 `prompt`）。输出进日志与 PR（没有 issue 可评论） |
| `workflow_dispatch` | Actions 页手动触发（需 `prompt`） |

> **`schedule` + `workflow_dispatch` 让 opencode 具备了「定时代理任务」能力**——
> 不需要额外的调度设施，借 GitHub Actions 的 cron 即可。
> 代价是这类任务**没有交互出口**（无 issue 可评论），只能把结果写进日志或开 PR。

不装 GitHub App 也行：用 runner 内置的 `GITHUB_TOKEN`，
但要显式授权 `id-token: write`、`contents: write`、`pull-requests: write`、`issues: write`。

### 21.2 GitLab

同样有官方集成（`packages/web/.../gitlab.mdx`），并且 provider 目录里
**GitLab Duo 是可用的 provider 之一**（§23）。

---

## 22. 企业能力

### 22.1 数据处理

opencode 的企业页面明确了几条边界（这些是**官方声明**，我们无法独立验证）：

- **代码不经过 opencode 的服务器**——直接从你的机器发给你配置的 LLM provider
- **例外是 OpenCode Zen**（自营网关，§23）：走 Zen 时请求经过 Zen
- **会话数据本地存储**（`~/.local/share/opencode/`）
- **分享功能是显式的**：只有你 `/share` 或开了 auto share 才上传（§14）

### 22.2 组织控制手段

| 手段 | 说明 | 章节 |
|------|------|------|
| **Remote config** | `.well-known/opencode` 下发组织默认值（可覆盖） | §7 |
| **Managed 文件** | `/etc/opencode/`、`%ProgramData%\opencode` 等，需 root | §7 |
| **macOS MDM** | `.mobileconfig` + `ai.opencode.managed`，**用户不可覆盖** | §7 |
| **Provider 白名单** | `experimental.policies` 限制允许的 provider | 下 |
| **权限体系** | 13 个权限键 + 两个护栏 | §5 |
| **`--pure`** | 禁用全部外部插件 | §12 |

**Provider 策略**（`experimental.policies`，目前**只能管 provider 允许列表**）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "experimental": {
    "policies": { "provider": ["anthropic", "opencode"] }
  }
}
```

> **企业能力的完成度是分层的，值得看清：**
> **配置分发（含 MDM 强制）做得相当完整**——8 层优先级、三平台 managed 目录、
> Jamf/FleetDM/Kandji 部署路径都有文档。
> 但**策略层（policies）目前只有一个 provider 白名单**，且挂在 `experimental` 下面。
> 也就是说「组织能强制下发配置」已经成立，
> 而「组织能表达细粒度的合规策略」还只有雏形。
> 另有 `packages/enterprise` 与 `packages/identity` 两个包存在于仓库中，
> **它们对应的产品形态我没有在公开文档里找到完整说明。**

---

## 23. Provider 生态与两套自营网关

### 23.1 Provider 目录（48 家 + 自营 2 套）

opencode 通过 **Models.dev** + **AI SDK** 支持 75+ provider。
官方文档目录页列出的（**48 家第三方 + Zen + Go**）：

**大厂与云**：Anthropic、OpenAI、Azure OpenAI、Azure Cognitive Services、
Google Vertex AI、Amazon Bedrock、NVIDIA、Snowflake Cortex、SAP AI Core、
DigitalOcean、Cloudflare（AI Gateway / Workers AI）、Modal、Scaleway、
STACKIT、OVHcloud AI Endpoints、Nebius Token Factory、IO.NET、GMI Cloud、Baseten

**推理服务**：Groq、Cerebras、Fireworks AI、Together AI、Deep Infra、
Hugging Face、Venice AI、Cortecs、302.AI

**模型厂直连**：DeepSeek、Moonshot AI（Kimi）、MiniMax、Z.AI（GLM）、xAI

**网关 / 聚合**：OpenRouter、Vercel AI Gateway、LLM Gateway、ZenMux、
Helicone（可观测）、Atomic Chat

**本地**：**Ollama**、**Ollama Cloud**、**LM Studio**、**llama.cpp**

**开发工具侧**：GitHub Copilot、GitLab Duo、FrogBot

**自定义 provider**（任何 OpenAI 兼容端点）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "options": { "baseURL": "https://my-endpoint.com/v1" },
      "models": { "my-model": { "name": "My Model" } }
    }
  }
}
```

> **provider 无关性是 opencode 最硬的差异化**：Claude Code 绑 Anthropic、
> Codex 绑 OpenAI（虽然都有 Bedrock 之类的旁路），
> 而 opencode 把「换模型」做成了一个配置项。
> 代价在 §2 已经提到——这个抽象由 AI SDK 提供，
> 于是 opencode 的 provider 能力上界受 AI SDK 约束，
> 且 provider 特有能力只能靠「任意键透传」（§6）这种弱类型方式表达。

### 23.2 OpenCode Zen（按量付费网关）

Zen 是官方自营的 AI 网关。它的**四条自我设定的目标**（官方原文列举）：

1. **benchmark** 出最适合编码代理的模型/provider 组合
2. 只给**最高质量**选项，**不降级、不偷偷路由到更便宜的 provider**
3. **按成本价卖**，降价直接传导，加价只覆盖支付处理费
4. **无锁定**：Zen 可以配给其它编码代理用，opencode 也随时能换别的 provider

**接入方式**：`opencode.ai/auth` 注册 → 拿 API key → TUI 里 `/connect` 选 Zen。
另有直连端点（`https://opencode.ai/zen/v1/...`，按模型族分 `responses` /
`messages` / `chat/completions` 三种协议），可用对应的 `@ai-sdk/*` 包直接调。
完整模型清单可从 `https://opencode.ai/zen/v1/models` 拉。

**定价（每 100 万 token，截至 2026-08-08）** —— 挑几档代表性的：

| 模型 | Input | Output | Cached Read | Cached Write |
|------|-------|--------|-------------|--------------|
| **8 个 Free 模型** | Free | Free | Free | – |
| DeepSeek V4 Flash | $0.14 | $0.28 | $0.028 | – |
| GPT 5.6 Luna（≤272K） | $0.20 | $1.20 | $0.02 | $0.25 |
| Qwen3.7 Plus | $0.40 | $1.60 | $0.04 | $0.50 |
| MiniMax M3 | $0.30 | $1.20 | $0.06 | – |
| Kimi K2.6 | $0.95 | $4.00 | $0.16 | – |
| GLM 5.2 | $1.40 | $4.40 | $0.26 | – |
| GPT 5.6 Terra（≤272K） | $2.00 | $12.00 | $0.20 | $2.50 |
| Claude Sonnet 5 | $2.00 | $10.00 | $0.20 | $2.50 |
| Grok 4.5（≤200K） | $2.00 | $6.00 | $0.30 | – |
| Kimi K3 | $3.00 | $15.00 | $0.30 | – |
| **Claude Opus 5** | $5.00 | $25.00 | $0.50 | $6.25 |
| GPT 5.6 Sol（≤272K） | $5.00 | $30.00 | $0.50 | $6.25 |
| **Claude Fable 5** | $10.00 | $50.00 | $1.00 | $12.50 |
| GPT 5.5 Pro / 5.4 Pro | $30.00 | **$180.00** | $30.00 | – |

**8 个免费模型**：Big Pickle、DeepSeek V4 Flash Free、MiMo-V2.5 Free、
Laguna S 2.1 Free、Ling-3.0-tiny Free、LongCat-2.0 Free、
North Mini Code Free、Nemotron 3 Ultra Free。

> ⚠️ **免费模型的代价写在隐私条款里，不是白拿。** Zen 声明所有 provider
> 遵守**零留存**、不用你的数据训练——**但上面 8 个免费模型全部是例外**：
> 「During its free period, collected data may be used to improve the model」。
> 其中 North Mini Code Free（Cohere）与 Nemotron 3 Ultra Free（NVIDIA）
> 的条款更明确：**「不要提交个人或机密数据」**，NVIDIA 那条还写明会话会被记录。
> 另外即使是付费模型也有两处 30 天留存：**OpenAI 与 Anthropic 的 API
> 按各自数据政策保留请求 30 天**。
> **「零留存」这个说法要连它的例外清单一起读。**

**长上下文分档计价**是本表一个容易忽略的机制：
GPT 5.6 系列以 **272K token** 为界、Claude Sonnet 4.5 / Gemini 3.1 Pro / Grok 4.5
以 **200K** 为界，超过就跳到约 2 倍的价档。

**计费机制**：余额低于 **$5 自动充值 $20**（金额可改，也可关）。
可为整个 workspace 与每个成员设**月度用量上限**。
⚠️ 官方明确提示一个陷阱：**设了月上限但开着自动充值，实际扣费可能超过月上限**
（余额跌破 $5 就充，与月度限额是两套机制）。

**已弃用模型（18 个，带日期）**：GPT 5.x Codex 系列 5 个（2026-07-23）、
Claude Opus 4.1（2026-08-05）、Claude Sonnet 4（2026-06-15）、
Claude Haiku 3.5（2026-02-16）、Gemini 3 Pro（2026-03-09）、
MiniMax M2.5（2026-08-05）、MiniMax M2.1（2026-03-15）、GLM 5（2026-05-14）、
GLM 4.7 / 4.6（2026-03-15）、Kimi K2.5（2026-08-05）、
Kimi K2 Thinking / K2（2026-03-06）、Qwen3 Coder 480B（2026-02-06）。

> **注意 GLM 5 与 MiniMax M2.5、Kimi K2.5 同时出现在定价表与弃用表里**
> （弃用日期 2026-05-14 / 2026-08-05，都已过或恰好在本快照当日）。
> 这属于文档内部的不一致，**我没有实测这些模型当前是否还能调用**。

**团队功能（Beta 期免费）**：
- 角色：**Admin**（管模型、成员、API key、账单）/ **Member**（只管自己的 key）
- Admin 可为每个成员设**月度消费上限**
- Admin 可**按模型启停**（对被禁模型的请求直接报错）——
  官方给的用例正是「禁掉那些会收集数据的模型」
- **BYOK**：可以用自己的 OpenAI / Anthropic key，同时仍能访问 Zen 里的其它模型；
  用自己的 key 时 token 由 provider 直接计费，不走 Zen

**隐私**：所有模型托管在**美国**。

### 23.3 OpenCode Go（低价订阅）

Go 是面向**开放模型**的订阅制：**首月 $5，之后 $10/月**，
官方说明主要面向**国际用户**、提供稳定的全球访问。**完全可选**。

**用量上限（按美元计，不是按请求数）：**

| 窗口 | 上限 |
|------|------|
| 5 小时 | **$12** 用量 |
| 每周 | **$30** 用量 |
| 每月 | **$60** 用量 |

**模型清单（18 个开放模型）**：Grok 4.5、GLM-5.2、GLM-5.1、GPT 5.6 Luna、
Kimi K3、Kimi K2.7 Code、Kimi K2.6、MiMo-V2.5、MiMo-V2.5-Pro、MiniMax M3、
MiniMax M2.7、Qwen3.8 Max、Qwen3.7 Max、Qwen3.7 Plus、Qwen3.6 Plus、
DeepSeek V4 Pro、DeepSeek V4 Flash、Hy3。

**官方给的请求数估算**（按典型用量模式换算，摘几档）：

| 模型 | 每 5 小时 | 每周 | 每月 |
|------|-----------|------|------|
| DeepSeek V4 Flash | 31,650 | 79,050 | 158,150 |
| MiMo-V2.5 | 30,100 | 75,200 | 150,400 |
| Qwen3.7 Plus | 4,300 | 10,800 | 21,600 |
| GPT 5.6 Luna | 2,050 | 5,100 | 10,250 |
| GLM-5.2 | 880 | 2,150 | 4,300 |
| Grok 4.5 | 120 | 300 | 600 |
| Kimi K3 | 110 | 250 | 490 |

> **这张估算表附带了一份很有价值的实测口径**：官方给出了每个模型
> 「典型请求」的 token 构成，例如 **Grok 4.5 是 1,100 input + 71,500 cached + 220 output**、
> GLM-5.2 是 700 + 52,000 + 150。
> **cached 部分占了绝对多数**（5 万–8.6 万 token），
> 这从侧面印证了编码代理的负载特征：**每次请求都在重发一大坨几乎不变的上下文**，
> 所以 prompt cache 命中率直接决定成本。
> $10/月 换到 $60 用量额度这件事之所以成立，很大程度上建立在这个缓存比例上。
>
> 一条限制要注意：**每个 workspace 只能有一个成员订阅 Go。**

---

## 24. 与 Claude Code / Codex 的对标

这一章只做**机制对照**，不评优劣。三者的定位不同：opencode 是 provider 无关的
开源代理，Claude Code 与 Codex 是各自模型厂的官方代理。

| 维度 | **opencode** | **Claude Code** | **Codex** |
|------|--------------|-----------------|-----------|
| 许可 | **MIT 开源** | 闭源 | Apache 2.0（CLI） |
| 主语言 | TypeScript（Bun） | TypeScript | **Rust**（96%） |
| 模型绑定 | **provider 无关，75+** | Anthropic 系 | OpenAI 系 |
| 架构 | **客户端/服务器（HTTP + OpenAPI）** | 单进程 + IDE 桥 | **App Server 双向协议** |
| 权限默认值 | **默认全允许**（permissive） | 默认询问 / 多模式 | 默认询问 / 多审批模式 |
| 权限求值 | **最后命中者胜** | deny 优先 | profiles + rules |
| 沙箱 | **无内核级沙箱** | OS 沙箱（Seatbelt 等） | **三平台内核沙箱** |
| 指令文件 | `AGENTS.md`（读 `CLAUDE.md` 兜底） | `CLAUDE.md` | `AGENTS.md` |
| Hook 形态 | **插件函数，抛异常即阻断**（28 事件） | 独立 Hook 配置层（20+ 事件） | Hook 配置（11 事件） |
| 子代理 | 5 个内置（3 隐藏系统代理） | 多内置 + Agent Teams | 有 |
| Skills | ✅ 读 `.opencode` / `.claude` / `.agents` 三处 | ✅ 原生 | ✅ |
| MCP | ✅ 客户端（含 OAuth + DCR） | ✅ 客户端 + 服务端 | ✅ |
| 撤销 | **`/undo` 回滚文件（基于 Git）** | Checkpoint | 版本控制集成 |
| 编辑器集成 | **ACP 协议** + VS Code 扩展 | VS Code / JetBrains 官方扩展 | VS Code / JetBrains / Xcode |
| 自营网关 | **Zen（按量）+ Go（订阅）** | 无（直接用 Anthropic） | 无（用 ChatGPT 订阅或 API） |
| 企业强制配置 | **8 层含 macOS MDM** | managed settings | managed configuration |
| LSP | 内置 34 个，**默认关闭且官方劝退** | 无内置 LSP 层 | 无内置 LSP 层 |
| 格式化器 | **内置 26 个，自动跑** | 无内置 | 无内置 |

**opencode 独有的几处机制**（同类产品里没有直接对应物）：

1. **`doom_loop` 权限**——把「同一调用重复 3 次」当作需要人介入的状态（§5）
2. **内置格式化器层**——写完文件自动跑 prettier/gofmt 等 26 个格式化器（§15）
3. **`/undo` 基于 Git 回滚整轮对话含文件改动**（§14）
4. **两套自营网关并存**：按量的 Zen 与订阅的 Go（§23）
5. **`--attach` 复用常驻服务端**以规避 MCP 冷启动（§12）
6. **竞品配置文件兼容**：`CLAUDE.md`、`.claude/skills/`（§8、§9）

**opencode 明显更弱的地方**（照实写）：

1. **没有内核级沙箱。** Claude Code 有 OS 沙箱、Codex 有三平台内核沙箱
   （Seatbelt / Landlock+seccomp / restricted tokens），
   opencode 的隔离手段是**权限规则 + 插件拦截**，都在应用层。
   这意味着一个被放行的 `bash` 命令，其能力边界就是当前用户的能力边界。
2. **默认全允许。** 这是产品取向而非缺陷，但后果要认清：
   开箱状态下模型可以直接改文件、跑命令，唯一的默认护栏是
   `.env` 读取、`external_directory` 与 `doom_loop`。
3. **插件无沙箱**（§13）：插件能拿到 SDK client 与 Bun shell，
   装第三方插件等于执行第三方代码。
4. **服务端认证默认关闭**（§17）：一旦绑到 `0.0.0.0` 而忘了设密码，
   暴露的是一个能读写文件、能执行命令的 API。

> **这四条不是「opencode 不安全」，而是「它把安全边界交给了配置与部署方」。**
> 一个 MIT 许可、provider 无关、能被任意客户端驱动的本地代理，
> 与一个内置内核沙箱的托管式代理，本来就在做不同的取舍：
> 前者的开放性正来自它不替你决定边界。
> 判断哪种更合适，取决于**谁来负责配置**——
> 个人开发者与需要统一管控的组织，在这道题上答案不同。
> 也正因如此，opencode 把 8 层配置与 MDM 强制做得比策略层更早、更完整（§22）。

---

## 25. 生态与社区

**社区聚合入口**：[awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)、
[opencode.cafe](https://opencode.cafe)。

**插件生态**（官方 ecosystem 页收录，挑几类代表）：

| 方向 | 代表插件 |
|------|----------|
| **换认证源** | `opencode-openai-codex-auth`（用 ChatGPT Plus/Pro 订阅替代 API 计费）、`opencode-gemini-auth`、`opencode-antigravity-auth` |
| **上下文优化** | `opencode-dynamic-context-pruning`（剪掉过时的工具输出）、`opencode-morph-plugin`（Morph 的 Fast Apply + WarpGrep + 压缩） |
| **编辑加速** | `opencode-morph-fast-apply`（宣称 10x 编辑速度） |
| **安全** | `opencode-vibeguard`（调用 LLM 前把 secret/PII 替换成占位符，本地还原） |
| **沙箱隔离** | `opencode-daytona`（在 Daytona 沙箱里跑会话）、`opencode-devcontainers`（多分支 devcontainer 隔离） |
| **可观测** | `opencode-helicone-session`、`opencode-wakatime` |
| **能力补齐** | `opencode-pty`（让代理在 PTY 里跑后台进程并交互）、`opencode-websearch-cited`、`opencode-type-inject` |
| **整合包** | `oh-my-opencode`（后台代理 + 预置 LSP/AST/MCP 工具 + 精选代理，Claude Code 兼容） |

> **插件生态的分布本身是一份需求清单**：出现最多的两类是
> **「绕过官方计费用订阅额度」**与**「省上下文 / 加速编辑」**。
> 第三类值得注意——`opencode-daytona`、`opencode-devcontainers`、`opencode-vibeguard`
> 都在补**隔离与脱敏**，也就是 §24 里指出的那块短板。
> **社区在用插件填沙箱的空缺**，这比任何评价都更能说明那个空缺是真实存在的。

---

## 26. 版本里程碑（带日期的事实层）

从 npm registry 实查的**首个 minor 版本发布日期**（不是 changelog 复述，
只作为演进速度的事实层）：

| 版本线 | 首发日期 |
|--------|----------|
| 0.0.x | 2025-05-31 |
| 0.1.x | 2025-06-12 |
| 0.2 / 0.3 | 2025-07-07 / 2025-07-14 |
| 0.4 / 0.5 | 2025-08-08 / 2025-08-14 |
| 0.6 → 0.15 | 2025-09-01 → 2025-10-12（**6 周内 10 个 minor**） |
| **1.0.0** | **2025-10-31** |
| 1.1 | 2026-01-04 |
| 1.2 / 1.3 / 1.4 | 2026-02-14 / 2026-03-22 / 2026-04-08 |
| 1.14 | 2026-04-19 |
| 1.15 / 1.16 / 1.17 | 2026-05-15 / 2026-06-05 / 2026-06-10 |
| **1.18** | **2026-07-14** |

**关键事件：**

- **2025-04-30**：仓库创建
- **2025-10-31**：**1.0.0**（距首个 npm 版本 5 个月）
- **2026-01-02**：**仓库从 `sst/opencode` 改名 `anomalyco/opencode`**（commit `3c41e4e`）
- **2026-01-29**：`STATS.md` 最后一条记录，累计下载 **10,190,453**（此后停更）
- **2026-08-07**：v1.18.15（本快照版本）

> **1.4 → 1.14 之间的版本号跳跃**（2026-04-08 → 2026-04-19）在 npm 上是可见的，
> **我没有找到这次跳号的公开说明**，仅作为事实记录在此。

**当前发版节奏**（GitHub Releases 实查）：

| 版本 | 日期 |
|------|------|
| v1.18.15 | 2026-08-07 |
| v1.18.14 | 2026-08-05 |
| v1.18.13 / v1.18.12 | 2026-08-04 |
| v1.18.11 | 2026-08-01 |
| v1.18.10 | 2026-07-30 |
| v1.18.9 / v1.18.8 | 2026-07-28 |
| v1.18.7 / v1.18.6 | 2026-07-27 |

**12 天 10 个 patch 版本。** 这个节奏是本文所有「现状」标注会快速漂移的原因。

---

## 参考资料

**一手来源（本文事实层的主要依据）：**

- 官方文档源文件：`packages/web/src/content/docs/*.mdx`（[GitHub dev 分支](https://github.com/anomalyco/opencode/tree/dev/packages/web/src/content/docs)）
- 官方文档站：[opencode.ai/docs](https://opencode.ai/docs)
- 仓库：[github.com/anomalyco/opencode](https://github.com/anomalyco/opencode)（Stars / 语言占比 / releases 取自 GitHub REST API）
- npm：[`opencode-ai`](https://www.npmjs.com/package/opencode-ai)（版本时间线取自 registry）
- config schema：[`opencode.ai/config.json`](https://opencode.ai/config.json)、TUI schema：[`opencode.ai/tui.json`](https://opencode.ai/tui.json)
- Zen 模型清单端点：`https://opencode.ai/zen/v1/models`

**二手来源（架构理解的参考，其中的 Go TUI 描述已过期，见文首 danger 框）：**

- [Coding Agents Internals: an OpenCode deep dive](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/)（cefboud）

**同系列：**

- [Claude Code 深入研究（2026-08 快照）](./ref-claude-code.md)
- [OpenAI Codex 深入研究（2026-08 快照）](./ref-codex.md)

---

::: tip 本文没有验证的部分（照实列出）
类型 IV 的证据形态是**公开信息**，不是自家实测。以下几处是本文明确**未能核验**的：

- **所有性能与用量数字**均为官方口径（Zen/Go 的 token 构成估算、请求数估算），
  我们没有独立复现
- **`packages/codemode` 是否已接入主流程、默认是否启用**（§2）
- **`OPENCODE_EXPERIMENTAL_SCOUT` 与已进正式文档的 scout 子代理的关系**（§6）
- **`packages/enterprise` / `packages/identity` 对应的产品形态**（§22）
- **Zen 定价表与弃用表冲突的那几个模型当前是否仍可调用**（§23）
- **1.4 → 1.14 版本号跳跃的原因**（§26）
- **Electron 与仓库里 `build/tauri-linux` 产物线的关系**（§1）
- **不同终端下 TUI 的实际兼容性差异**（§3）
- **官方声明的数据处理边界**（代码不经 opencode 服务器等，§22）——
  这类声明我们无法从外部验证

这些地方本文用「我没有核验」明确标注，而不是含糊过去。
:::
