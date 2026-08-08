---
title: CC Switch 深入研究（2026-08 快照）
description: 26 章逐节成册，按目录跳章查阅——把 CC Switch 的产品形态、架构与实现细节交叉核验到版本号级别：名字是「配置切换器」而实体是 16.9 万行 Rust 的本地 API 网关、8 个被管理的工具与两种写入模式、25 条代理路由、7 个协议转换器、448 条预设背后的 86 家厂商、rquickjs 用量脚本沙箱。这是一份手册，不是读完就走的文章。
date: "2026-08-09"
series: 深入研究
audience: engineer
highlight: 26 章逐节可查 · 核验至 v3.19.2 / commit 413c09e0 · 截至 2026-08-09 快照
tags: [cc-switch, Tauri, Rust, 深入研究, 代理, 供应商管理, 参考]
outline: [2, 3]
---

# CC Switch 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-09
- **被调研版本**：CC Switch **v3.19.2**（2026-08-06 发布 GitHub Release）。
  源码快照取 `main` 分支 commit **`413c09e0`**（`git describe` = `v3.19.2-1-g413c09e0`，
  即 tag 之后还有一个提交），提交时间 2026-08-06 16:19:04 +0800。
  `package.json` / `Cargo.toml` / `tauri.conf.json` 三处版本号一致，均为 3.19.2。
- **证据形态**：**本地完整源码 + 仓库内文档 + GitHub API 实查**的交叉核验。
  这一篇能读到完整源码（MIT 开源），所以「有几个 Tauri 命令」「有几条代理路由」
  「有几条预设」这类数字是**从代码里数出来的**，不是从 README 抄的——
  两者对不上的地方本文会点出来（见 §8）。
  但它**仍不是我们自己的实测数据**：下载量、性能提升幅度、
  「省了多少钱」这类数字全部是官方口径或第三方计数，我们没有跑过。
- **一手性说明**：Tauri 命令数取自 `src-tauri/src/lib.rs` 的 `generate_handler!` 宏
  与全仓 `#[tauri::command]` 标注的双向对账；代理路由取自
  `src-tauri/src/proxy/server.rs` 的 `build_router()`；预设取自 `src/config/*ProviderPresets.ts`；
  表结构与迁移版本取自 `src-tauri/src/database/`；Star 数 / 语言占比 / release 时间线
  取自 GitHub REST API 实查。**所有计数都是脚本数的，不是目测**（开篇「关于本文的计数方法」记了一次目测会错在哪）。
- **时效边界**：这是**单一时点的快照**。CC Switch 的预设列表与合作伙伴清单变动很快
  （448 条预设里有 249 条带 `isPartner` 标记，商务关系随时增删），
  定价与额度类信息漂移最快。**这是 2026-08-09 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方仓库](https://github.com/farion1231/cc-switch)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 三条会让你判断失准的现状（都在本快照实测确认）
1. **它的名字和定位会让你严重低估它的体量。** 叫 "CC Switch"、README 自称
   "Manager"，听起来是个改配置文件的小工具。实际是
   **16.9 万行 Rust + 8.5 万行 TypeScript**，GitHub 语言占比 **Rust 64.8% / TypeScript 34.1%**，
   仓库 `language` 字段是 **Rust**。其中 `src-tauri/src/proxy/` 一个目录就
   **6.1 万行**——那是一个功能完整的**本地 API 网关**：25 条路由、7 个协议转换器、
   熔断器、故障转移、SSE 流式改写、prompt cache 断点注入。
   按「配置切换器」去理解它，会漏掉一多半代码。见 §3、§10、§11。
2. **它不是 Electron 应用，尽管仓库最早三周确实是。** 项目 2025-08-04 起步时是 Electron，
   **2025-08-23 引入 `src-tauri/` 并在同一天清理掉 Electron 依赖**（commit `12fa80e0`），
   2025-08-27 的 **v3.0.0** 是分水岭版本。也就是说「Electron 时代」只存在了
   **约 3 周、且在 v3.0.0 之前**。任何提到 CC Switch 用 Electron 的资料都早于 2025-08-27。见 §2。
3. **GitHub API 的 `watchers_count` 不是关注者数，别照抄。** 实查返回
   `stargazers_count: 125695` 与 `watchers_count: 125695`——**两个字段值相同**，
   因为 GitHub v3 API 的 `watchers_count` 是 star 数的别名。
   真正的关注者数在 `subscribers_count`，实测是 **229**。
   把 `watchers_count` 当「有 12.5 万人关注」写进分析，是个纯粹的 API 语义误读。

第 1、2 条是「照名字和旧资料推断，而不回源码核验」的代价；
第 3 条是数据源本身的坑。本文标注的现状同样会漂移——引用前先看一眼日期。
:::

---

## 关于本文的计数方法（先看这节，它解释了后面所有数字）

本文正文里每个「N 个」都是脚本数的。这不是洁癖，是因为**目测在这个仓库上会错**，
而且错的方向不好预测。举一个本次调研真实发生的例子：

数「有多少个 Tauri 命令」时，第一次用的是最直觉的办法：

```bash
grep -rn "#\[tauri::command\]" --include='*.rs' src-tauri/src | wc -l
# → 275
```

而 `lib.rs` 里 `generate_handler!` 宏注册了 **294** 条。两个数差 19，
差在哪必须查清楚——否则不管写 275 还是 294 都是在赌。写脚本做双向对账：

```python
# 允许属性带参数：#[tauri::command(rename_all = "snake_case")]
for m in re.finditer(r'#\[tauri::command[^\]]*\][\s\S]{0,200}?fn\s+(\w+)', t):
    names.add(m.group(1))
```

结果：**标注函数 294 个，注册项 294 条，两侧差集都为空。**
那个 275 是 `grep` 的字面量 `#[tauri::command]` **漏掉了带参数形式**的结果。

**结论：294 是对的，275 是工具误差。** 本文正文用 294。

这条方法论在本系列是复发的教训：写 opencode 那篇时目测填了 4 处数字、错了 3 处
（LSP 38→34、格式化器 29→26、环境变量 28+19→25+18）。
所以下面每个数字要么给了取数脚本，要么给了取数路径。
**如果某处我没能数准，会在 §26 的未验证块里点名，而不是含糊过去。**

---

## 1. 产品概述

CC Switch 是一个**跨平台桌面应用**，用来管理多个 AI 编程 CLI 工具的供应商配置。
它解决的原始问题很具体：Claude Code 读 `~/.claude/settings.json`（JSON）、
Codex 读 `~/.codex/config.toml`（TOML）+ `auth.json`、Gemini CLI 读 `~/.gemini/.env`、
Hermes 读 `~/.hermes/config.yaml`（YAML）、OpenClaw 读 `~/.openclaw/openclaw.json`（JSON5）——
**换一个 API 供应商意味着手工编辑五种不同格式的文件**。

但如果只按这个定位读它的代码，会漏掉一多半。**它同时是一个本地 API 网关**（§10-§14）：
可以接管某个工具的流量、在本机做协议转换（让 Claude Code 用 GPT 模型）、
在上游故障时自动切换供应商、统计每一次请求的 token 与成本。

**关键数据（截至 2026-08-09，GitHub REST API 与本地仓库实查）：**

| 项 | 值 | 取数处 |
|---|---|---|
| 最新版本 | **v3.19.2**（2026-08-06） | GitHub Releases |
| 源码快照 | `413c09e0`（`v3.19.2-1-g413c09e0`） | `git describe --tags` |
| GitHub Stars | **125,695** | `stargazers_count` |
| Forks | **8,556** | `forks_count` |
| Open Issues | **2,108** | `open_issues_count` |
| 关注者（真实） | **229** | `subscribers_count`（**不是** `watchers_count`，见文首 danger 3） |
| 许可证 | **MIT** | `license.spdx_id` |
| 仓库创建 | **2025-08-04** | `created_at` |
| 语言占比 | **Rust 64.8% / TypeScript 34.1%** / HTML 1.0% / JS 0.1% / CSS 0.1% | `/languages` |
| 提交数 | **2,256** | `git rev-list --count HEAD` |
| 贡献者 | **214** | `git shortlog -sn \| wc -l` |
| Rust 代码 | **218 文件 / 169,241 行** | `find src-tauri/src -name '*.rs'` |
| TS/TSX 代码 | **324 文件 / 85,582 行** | `find src -name '*.ts' -o -name '*.tsx'` |
| CHANGELOG | **406,692 字节 / 38 个版本条目** | `CHANGELOG.md` |
| 官网 | ccswitch.io | `homepage` |

**产品形态只有一个：桌面 GUI。** 这一点与本系列其他几篇（Claude Code / Codex /
opencode / Reasonix）区别很大——它们都是 CLI 优先、多入口；
CC Switch **没有 CLI、没有 Web 版、没有 SDK**，
唯一的非 GUI 交互面是 `ccswitch://` deep link（§20）与本地代理的 HTTP 端口（§10）。

**被管理的 8 个工具**（`AppType` 枚举，`src-tauri/src/app_config.rs:370`）：
Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes。
详见 §4。

**贡献者分布是高度集中的**（`git shortlog -sn`）：`Jason` 1,727 提交 + `farion1231` 100
+ `Jason Young` 18 —— 这三个身份合计占 2,256 提交的 **82%**，且从
`Cargo.toml` 的 `authors = ["Jason Young"]` 看是同一人的不同 git 配置。
214 个贡献者里第二名 `Dex Miller` 是 45 提交。
**这是一个单人主导 + 长尾外部贡献的项目**，不是团队项目。

> **官网唯一性声明值得注意。** README 用一级标题写着
> "🌐 The Only Official Website: **ccswitch.io**"，
> 且 GitHub `homepage` 字段与之一致。一个工具需要在 README 顶部
> 强调「唯一官网」，通常意味着**存在仿冒站点**——这类工具会接触用户的 API Key，
> 仿冒的动机很强。本文无法核验仿冒站的存在与数量，仅记录这个声明本身。

---

## 2. 版本历史：Electron → Tauri 的重写

这一节是文首 danger 第 2 条的证据。

**时间线（`git log` 实查）：**

| 日期 | 事件 | 证据 |
|---|---|---|
| 2025-08-04 | `initial commit`（`e0a9c1ab`），Electron 起步 | 首个提交 |
| 2025-08-05 | `修复 Electron 应用窗口不显示的问题`（`35cb750d`） | 提交标题 |
| 2025-08-23 | **`src-tauri/Cargo.toml` 首次加入**（`1b0ab269` `feat: initialize Tauri project structure`） | `git log --diff-filter=A` |
| 2025-08-23 | **`refactor: 清理 Electron 遗留代码并优化项目结构`（`12fa80e0`）** | 同日移除 Electron |
| 2025-08-27 | **v3.0.0 发布**，changelog 标题 `Complete migration from Electron to Tauri 2.0` | `CHANGELOG.md` |

**Electron 时代只有约 3 周**（2025-08-04 → 2025-08-23），
且完全在 v3.0.0 之前。仓库里现在**没有任何 Electron 依赖**。

v3.0.0 的 changelog 声明了迁移收益：

- 「**bundle 体积减少 90%**（~150MB → ~15MB）」
- 「启动性能显著提升」
- 「Rust 后端带来更强的安全性」

> **这三条都是官方口径，本文未独立核验。** 体积那条方向上可信（Electron 打包
> Chromium、Tauri 用系统 WebView，量级差异是这个技术选择的固有结果），
> 但「90%」「150MB→15MB」这两个具体数字我们没有复现——
> 需要把 v2.x 的 Electron 产物和 v3.x 的 Tauri 产物都构建出来量，
> 本次调研没做。见 §26。

**一个命名遗留的细节**：迁移期间有一个提交叫
`refactor: rename global API from electronAPI to api and update references`（`d7801356`）,
说明前端曾经通过 `window.electronAPI` 调后端。现在的调用面是 Tauri IPC（§3）。

**为什么 3.x 从 3.0.0 开始而不是 1.0.0**：v2.x 是 Electron 时代的版本线，
GitHub Releases 里最老的一页能查到 `v2.0.3`（2025-08-22）。
**大版本号 3 就是「Tauri 重写」这件事的标记。**

---

## 3. 代码规模与分层架构

**整体是 Tauri 2 的标准双层结构**：TypeScript/React 渲染进程 + Rust 后端，
中间是 Tauri IPC。

```
┌──────────────────────────────────────────────────────────┐
│  前端 src/  (324 文件 / 85,582 行 TS+TSX)                │
│  React 18 · Vite 7 · TailwindCSS 3.4 · TanStack Query v5 │
│  components/ (160 tsx) · hooks/ (24) · lib/api/ (26)     │
└───────────────────────┬──────────────────────────────────┘
                        │ Tauri IPC — 294 个命令（§3.2）
┌───────────────────────▼──────────────────────────────────┐
│  后端 src-tauri/src/  (218 文件 / 169,241 行 Rust)        │
│  commands/ (35 文件)   ← IPC 命令层                      │
│  services/ (40 文件 / 45,838 行)  ← 业务层               │
│  database/dao/ (13 文件)  ← 数据访问层                   │
│  proxy/ (61,198 行)  ← 本地 API 网关（§10-§14）          │
│  session_manager/ (5,112 行)  ← 会话浏览（§19）          │
│  mcp/ (2,431 行) · deeplink/ · services/webdav_sync 等   │
└──────────────────────────────────────────────────────────┘
```

**Rust 侧行数 Top 10**（`find src-tauri/src -name '*.rs' -exec wc -l {} +`）：

| 文件 | 行数 | 职责 |
|---|---:|---|
| `services/proxy.rs` | 7,342 | 代理服务编排 |
| `commands/misc.rs` | 6,397 | 杂项 IPC（工具探测、终端打开等） |
| `proxy/forwarder.rs` | 5,023 | 请求转发核心 |
| `services/skill.rs` | 4,728 | Skills 管理（§18） |
| `services/provider/mod.rs` | 4,722 | 供应商 CRUD 与切换（§9） |
| `proxy/providers/transform_codex_chat.rs` | 4,558 | Responses ↔ Chat 转换 |
| `codex_config.rs` | 4,462 | Codex 配置读写 |
| `services/usage_stats.rs` | 4,359 | 用量统计（§15） |
| `proxy/handlers.rs` | 3,348 | 路由处理器 |
| `database/schema.rs` | 3,239 | 表结构与迁移（§6） |

**代理层的体量是这个项目最反直觉的地方。** `src-tauri/src/proxy/` 有 **61,198 行**，
占 Rust 侧 **36%**；其中 `proxy/providers/`（协议适配与转换）单独就是
**31 个文件 / 36,178 行**。作为对比，「改配置文件」这件事的核心
（`services/provider/mod.rs` + 各 `*_config.rs`）加起来不到 2 万行。

### 3.1 前端技术栈

从 `package.json` 实查（版本号是 semver range，不是锁定版本）：

- **框架**：React 18.2 · TypeScript 5.3 · Vite 7.3
- **样式**：TailwindCSS 3.4 · shadcn/ui（`components.json` 在仓库根）
- **状态/数据**：TanStack Query v5.90（`@tanstack/react-query`）· `@tanstack/react-virtual`（长列表虚拟化）
- **表单**：react-hook-form 7.65 + `@hookform/resolvers` + **zod 4.1**
- **编辑器**：CodeMirror 6（`@codemirror/lang-{json,javascript,markdown}` + lint + one-dark 主题）
- **交互**：`@dnd-kit`（拖拽排序）· framer-motion · cmdk（命令面板）· sonner（toast）
- **图表**：recharts 3.5（用量趋势，§15）
- **搜索**：flexsearch 0.8（会话搜索，§19）
- **i18n**：i18next 25.5 + react-i18next 16
- **配置解析**：smol-toml（前端也要解 TOML，因为 Codex 用 TOML）
- **Radix UI**：12 个 primitive 包

**测试**：vitest 2.0 + `@testing-library/react` + **MSW 2.11**（HTTP mock）+ jsdom。
前端测试文件 **92 个**（`tests/` 下）。

### 3.2 IPC 命令面：294 个

这是前后端唯一的通信面。取数与对账过程见开篇「关于本文的计数方法」。

```bash
# lib.rs 的 generate_handler! 注册项
python3 -c "..."   # → entries: 294  unique: 294
# 全仓 #[tauri::command] 标注函数（允许带参数形式）
                   # → annotated fns (unique): 294
# 两侧差集
# in handler but not annotated: []
# annotated but not in handler: 0
```

**294 个命令、两侧完全对齐、零悬空零遗漏。** 这个数字本身说明了 IPC 面的粒度有多细——
对比 §3 的分层图，35 个 `commands/*.rs` 文件平均每个暴露 8 个命令。

前端侧的封装在 `src/lib/api/`（**26 个文件**），按域切分：
`providers.ts` `proxy.ts` `mcp.ts` `skills.ts` `sessions.ts` `usage.ts`
`subscription.ts` `deeplink.ts` `workspace.ts` `omo.ts` `hermes.ts` `openclaw.ts` 等。

### 3.3 Rust 依赖里能读出的架构决定

`src-tauri/Cargo.toml` 里几个依赖直接暴露了功能边界：

| 依赖 | 版本 | 说明什么 |
|---|---|---|
| `tauri` | 2.8.2 | 带 `tray-icon` / `protocol-asset` / `image-png` feature |
| **`axum`** | 0.7 | 本地代理是 axum HTTP server（§10） |
| **`hyper` / `hyper-util` / `hyper-rustls`** | 1.0 / 0.1 / 0.27 | 手写 HTTP/1.1 accept 循环，为了保留 header 大小写（§10.2） |
| **`rusqlite`** | 0.31（`bundled`+`backup`+`hooks`） | SQLite 内嵌，含在线备份 API（§7） |
| **`rquickjs`** | 0.8 | **内嵌 QuickJS**——用量查询脚本沙箱（§22） |
| `toml` / `toml_edit` | 0.8 / 0.22 | Codex 的 TOML 保序编辑 |
| `serde_yaml` | 0.9 | Hermes 的 YAML |
| **`json5` / `json-five`** | 0.4 / 0.3.1 | OpenClaw 的 JSON5（含注释保留的 round-trip） |
| `rust_decimal` | 1.33 | **成本用十进制而非浮点**（§15） |
| `zip` / `flate2` / `brotli` / `zstd` | — | Skills 打包 + HTTP 内容编码 |
| `sha2` / `hmac` | 0.10 / 0.12 | 同步清单校验 + S3 签名 |
| `auto-launch` | 0.5 | 开机自启 |
| `winreg`（Windows） | 0.52 | 读注册表环境变量（§23.3） |
| `arboard` | 3.6 | 剪贴板 |

**`rust-version = "1.85.0"`、`edition = "2021"`。**
release profile 显式优化体积：`opt-level = "s"`、`lto = "thin"`、`codegen-units = 1`、
`strip = "symbols"`，注释写明是为了压 AppImage 体积。

> **一个刻意的例外**：`panic = "unwind"`，注释写着
> 「使用 unwind 以便 panic hook 能捕获 backtrace（abort 会直接终止无法捕获）」。
> 仓库里确实有 `panic_hook.rs`。**为可观测性放弃了 `panic = "abort"` 的体积收益**——
> 这是个有意识的 trade-off，不是漏配。

### 3.4 测试规模

| 侧 | 数量 | 取数 |
|---|---:|---|
| Rust 测试函数 | **2,401** | `grep -rn "#\[test\]\|#\[tokio::test\]" src-tauri/src` |
| 前端测试文件 | **92** | `find tests -name '*.test.ts*'` |

`Cargo.toml` 有一个 `test-hooks` feature（默认关闭），README 的开发指南里
提到 `cargo test --features test-hooks`——说明部分测试需要显式开启的注入点。
`dev-dependencies` 里有 `serial_test`，意味着**存在必须串行跑的测试**
（合理：这个项目大量操作真实文件路径与全局锁）。

**本文未跑过它的测试套件**，上面只是静态计数。见 §26。

---

## 4. 八个被管理的工具：两种写入模式

`AppType` 枚举定义在 `src-tauri/src/app_config.rs:370`：

```rust
pub enum AppType {
    Claude, ClaudeDesktop, Codex, Gemini,
    GrokBuild, OpenCode, OpenClaw, Hermes,
}
```

**这个枚举是整个项目的主轴**：数据库主键是 `(id, app_type)`、
预设文件按 app 分家、MCP 同步按 app 分派、代理路由按 app 分命名空间。

### 4.1 Switch 模式 vs Additive 模式

这是本节最重要的一个区分，源码里有明确注释
（`app_config.rs:400`，`is_additive_mode()`）：

```rust
/// - Switch mode (false): Only the current provider is written to live config
/// - Additive mode (true): All providers are written to live config
pub fn is_additive_mode(&self) -> bool {
    matches!(self, AppType::OpenCode | AppType::OpenClaw | AppType::Hermes)
}
```

| 模式 | 工具 | 语义 |
|---|---|---|
| **Switch**（切换式） | Claude、Claude Desktop、Codex、Gemini、Grok Build | live 配置里**只有当前那一个**供应商；切换 = 覆写 |
| **Additive**（累加式） | **OpenCode、OpenClaw、Hermes** | **所有**供应商都写进 live 配置；切换 = 改哪个生效 |

**为什么分两种**：后三个工具的配置格式本身支持「多 provider 并存 + 选一个用」
（如 `opencode.json` 的 `provider` 对象），所以没必要每次切换都重写；
前五个工具的配置是「一组扁平的环境变量 / 字段」，只能容纳一个供应商。

**这个差异会泄漏到用户可见行为上**：Additive 模式下你在 live 配置文件里
能看到全部供应商（含未启用的），Switch 模式下只能看到当前那个。

### 4.2 各工具的能力不是齐平的

不是 8 个工具都支持全部功能。从代码里能数出几处明确的缺口：

| 能力 | 支持的 app | 不支持 | 证据 |
|---|---|---|---|
| **Prompts** | Claude、Codex、Gemini、GrokBuild、OpenCode、OpenClaw、Hermes（7） | **Claude Desktop** | `prompt_files.rs:14` 显式返回 `app.prompts_unsupported` 错误 |
| **通用配置片段** | Claude、Codex、Gemini、OpenCode、OpenClaw、Hermes（6） | **Claude Desktop、GrokBuild** | `CommonConfigSnippets::get()` 两者 `=> None` |
| **MCP 同步** | Claude、Codex、Gemini、GrokBuild、OpenCode、Hermes（6） | **Claude Desktop、OpenClaw** | `mcp/mod.rs` 只有 6 个子模块（§16） |
| **Session Manager** | 7 个（claude/codex/gemini/grokbuild/hermes/openclaw/opencode） | **Claude Desktop** | `session_manager/providers/` 下 7 个文件（§19） |
| **代理接管** | Claude、Codex、Gemini、GrokBuild（+ Claude Desktop 独立网关） | OpenCode、OpenClaw、Hermes | `switch()` 里的 `matches!` 白名单（§9） |

**Claude Desktop 是能力最少的那个**——它在 5 项里缺 4 项。
这跟它的形态有关：Claude Desktop 是 GUI 应用，配置面比 CLI 窄，
且 CC Switch 给它走的是一条独立的「3P 本地 gateway」路径（§10.1 的
`/claude-desktop/v1/messages` 路由）。

### 4.3 别名兼容

`FromStr` 实现（`app_config.rs`）接受的别名值得记一下，因为 deep link（§20）
与配置文件都会走它：

| 规范值 | 接受的别名 |
|---|---|
| `claude-desktop` | `claude_desktop`、`claudedesktop` |
| `grokbuild` | `grok-build`、`grok_build`、**`grok`** |

其余 5 个只接受自身小写。`serde` 侧另有 `alias` 标注
（`claudeDesktop` camelCase 也能反序列化）——**这是为了兼容历史配置文件里的写法**。
输入先 `trim().to_lowercase()`，所以大小写不敏感。

---

## 5. 供应商预设：448 条条目、86 家厂商

这是本文一处**需要小心措辞**的地方，README 与源码给出的数字差一个数量级，
但两个数字都不算错——它们数的不是一回事。

### 5.1 两个数字，两种口径

README 反复写「**50+ presets**」。而按文件里的 `name:` 字段数：

```python
for nm, body in re.findall(r'export const (\w+)\s*:\s*[\w<>\[\]]+\s*=\s*\[(.*?)\n\];', t, re.S):
    names = re.findall(r'^\s{4}name:\s*"([^"]+)"', body, re.M)
```

| 预设文件 | 条目数 | `isPartner` | `primePartner` | `isOfficial` |
|---|---:|---:|---:|---:|
| `claudeProviderPresets.ts` | 72 | 36 | 2 | 1 |
| `claudeDesktopProviderPresets.ts` | 69 | 36 | 2 | 0 |
| `codexProviderPresets.ts` | 67 | 35 | 2 | 2 |
| `hermesProviderPresets.ts` | 61 | 34 | 2 | 1 |
| `openclawProviderPresets.ts` | 60 | 34 | 2 | 0 |
| `opencodeProviderPresets.ts` | 60 | 30 | 2 | 0 |
| `grokBuildProviderPresets.ts` | 37 | 28 | 0 | 0 |
| `geminiProviderPresets.ts` | 22 | 16 | 0 | 0 |
| **合计** | **448** | **249** | **12** | **4** |

（另有 `universalProviderPresets.ts` 2 条，性质不同，见 §5.4，未计入 448。）

**448 是「条目数」，不是「厂商数」。** 同一家供应商在 8 个工具里各有一条预设，
所以要看去重后的：

```
total entries: 448
unique names across all files: 86
names in >=4 tool files: 63
names in exactly 1 file: 16
```

**86 家厂商、其中 63 家覆盖了 4 个以上工具。** 出现在全部 8 个文件里的有
AICodeMirror、Qiniu、CherryIN、OpenRouter、SSSAiCode、Code0、A6API、APINebula 等。

**所以 README 的「50+」在厂商口径下是成立的**（86 > 50，且「50+」是个下界表述），
只是它没说清是哪个口径。**本文正文一律用「448 条预设 / 86 家厂商」这个双数字表述**，
因为单说任何一个都会让人误判工作量或选择面。

### 5.2 分类体系：8 个 category

`ProviderCategory`（`src/types.ts:1`）：

| 值 | 中文注释（源码原文） |
|---|---|
| `official` | 官方 |
| `cn_official` | 开源官方（原"国产官方"） |
| `cloud_provider` | 云服务商（AWS Bedrock 等） |
| `aggregator` | 聚合网站 |
| `third_party` | 第三方供应商 |
| `custom` | 自定义 |
| `omo` | Oh My OpenCode |
| `omo-slim` | Oh My OpenCode Slim |

后两个是 OpenCode 专属的配置方案（§5.5），不是「供应商」意义上的分类——
它们在切换逻辑里走独立路径（`switch()` 里 `category == "omo"` 直接分流）。

`cn_official` 的注释保留了改名痕迹（"原国产官方"），是个无害的历史遗留。

### 5.3 预设的 apiFormat 与 providerType

`apiFormat` 决定代理层要不要做协议转换（§12）。全仓分布：

| `apiFormat` | 条目数 | 含义 |
|---|---:|---|
| `anthropic` | 63 | Anthropic Messages，直接透传 |
| `openai_responses` | 25 | OpenAI Responses API，需转换 |
| `openai_chat` | 22 | OpenAI Chat Completions，需转换 |
| `gemini_native` | 2 | Gemini generateContent，需转换 |

（未标注 `apiFormat` 的预设走各自 app 的默认协议。）

`providerType` 标记需要特殊认证或特殊处理的供应商：

| `providerType` | 条目数 | 说明 |
|---|---:|---|
| `xai_oauth` | 3 | xAI OAuth（§21） |
| `github_copilot` | 2 | Copilot OAuth device flow（§21、§13） |
| `codex_oauth` | 2 | ChatGPT Plus/Pro 反代（§21） |
| `newapi` | 1 | NewAPI 网关 |
| `custom_gateway` | 1 | 自定义网关 |

### 5.4 Universal Provider：一份配置写三个工具

`universalProviderPresets.ts` 只有 2 条预设，但机制独立：
**一份配置同步到 Claude、Codex、Gemini 三个 app**（源码注释原文：
「统一供应商是跨应用共享的配置，修改后会自动同步到 Claude、Codex、Gemini 三个应用。
适用于 NewAPI 等支持多种协议的 API 网关。」）

它的默认模型配置（`NEWAPI_DEFAULT_MODELS`）能看出这份快照的时代坐标：

```
claude: { model: "claude-sonnet-5", haikuModel: "claude-haiku-4-5-20251001",
          sonnetModel: "claude-sonnet-5", opusModel: "claude-opus-5" }
codex:  { model: "gpt-5.6-sol", reasoningEffort: "high" }
gemini: { model: "gemini-3.6-flash" }
```

数据库侧有独立的 `universal_providers` DAO（`database/dao/universal_providers.rs`）
与 `sync_universal_to_apps()` 命令。

### 5.5 OMO：Oh My OpenCode 的两档

`omo` / `omo-slim` 是 OpenCode 的两套配置方案，**互斥**——
`switch_normal()` 里明确写着「OMO ↔ OMO Slim are mutually exclusive;
activating one removes the other's config file」。

后端实现是 `services/omo.rs`（**1,740 行**），值得注意的是它的写入策略：
配置文件是 **JSON5**（`omo.jsonc` / `omo.json`），用 `json-five` 做
**round-trip 解析**以保留用户的注释与格式。写回前有三道校验：

```rust
"OMO config changed on disk. Please reload and try again."          // 冲突检测
"Refusing to write invalid OMO config after round-trip serialization" // 序列化自检
"Refusing to write OMO config: serialized output does not match the intended state" // 结果比对
```

**「拒绝写入」而不是「尽力写入」**——对一个会改用户手写配置文件的功能，
这个方向是对的。

### 5.6 预设排序：官方 → 尊享合作伙伴 → 赞助商 → 其余

这一点值得单独写，因为它涉及**商业排序**（§25 会再谈利益披露）。

`sortPresetEntries()`（`src/components/providers/forms/ProviderPresetSelector.tsx:85`）
的默认模式是 `PresetSortMode.Original`，源码注释写得很直白：

```
// 置顶优先级：官方分类 > 尊享合作伙伴（Kimi）> 其余赞助商 > 非赞助商。
// 前三组用分区拼接而非排序，保持各自在预设文件里的相对顺序
// （赞助商的文件顺序与 README 赞助商表对齐）；非赞助商按显示名排序。
```

```rust
return [...official, ...prime, ...partner, ...rest];
```

**默认视图下，付费合作伙伴排在非合作伙伴之前**，且只有 `rest` 这一组按字母排序。
用户可以切到 `PresetSortMode.NameAsc` 得到纯字母序（`useState` 初值是 `Original`，
所以字母序需要手动切）。

**这是明示的、代码与注释都不掩饰的**，且 UI 上有徽章披露（§25）。
本文把它记在这里是因为：**一个「帮你挑供应商」的工具，其默认排序有商业倾向，
是用户应当知道的事实**——不论它是否披露。

---

## 6. 配置格式：五种格式、七个 live 文件

CC Switch 的核心难点在这里：**8 个工具用 5 种配置格式**。

| App | live 配置路径 | 格式 | 代码 |
|---|---|---|---|
| **Claude Code** | `~/.claude/settings.json`（兼容旧 `claude.json`） | JSON | `config.rs:187` |
| | `~/.claude.json`（MCP） | JSON | `config.rs:46` |
| **Codex** | `~/.codex/auth.json` + `~/.codex/config.toml` | JSON + **TOML** | `codex_config.rs:178,185` |
| **Gemini CLI** | `~/.gemini/.env` + `~/.gemini/settings.json` | **dotenv** + JSON | `gemini_config.rs:18,343` |
| **Grok Build** | `grok_config.rs` 派生目录 | — | `grok_config.rs` |
| **OpenCode** | `~/.config/opencode/opencode.json`（`get_opencode_dir()`） | JSON | `opencode_config.rs:59` |
| **OpenClaw** | `~/.openclaw/openclaw.json` | **JSON5** | `openclaw_config.rs:46` |
| **Hermes** | `~/.hermes/config.yaml`（Win: `%LOCALAPPDATA%\hermes`） | **YAML** | `hermes_config.rs:101` |

**每种格式都有对应的 Rust 依赖**（§3.3）：`serde_json` / `toml_edit`（保序）/
`serde_yaml` / `json5`+`json-five`（保注释）。前端也装了 `smol-toml`，
因为编辑器要在 UI 里解析 Codex 的 TOML。

### 6.1 Codex 的两文件回滚

Codex 的配置分在两个文件里（凭据在 `auth.json`、其余在 `config.toml`），
所以写入不是单个原子操作。`codex_config.rs:222` 的注释说明了处理方式：

> 原子写 Codex 的 `auth.json` 与 `config.toml`，在第二步失败时回滚第一步

```
// 第一步：写 auth.json
// 第二步：写 config.toml（失败则回滚 auth.json）
```

**这是「两个原子写」拼成的一个补偿事务**，不是真正的两文件原子性——
如果回滚本身失败，仍会留下不一致状态。对桌面应用来说这个取舍是合理的
（真要原子就得引入 WAL 或临时目录 rename，成本不匹配）。
本文记下它的**实际保证边界**：单文件原子、跨文件尽力补偿。

### 6.2 Prompts 文件名按 app 分派

`prompt_files.rs` 把「记忆/指令文件」映射到各工具的约定文件名：

| App | 文件名 |
|---|---|
| Claude | `CLAUDE.md` |
| Codex | `AGENTS.md` |
| Gemini | `GEMINI.md` |
| GrokBuild / OpenCode / OpenClaw | `AGENTS.md` |
| **Hermes** | **`SOUL.md`** |
| Claude Desktop | **不支持**（返回错误） |

`AGENTS.md` 被 4 个工具共用，反映了这个文件名在 2026 年已是跨工具的事实标准。
Hermes 用 `SOUL.md` 是个例外，且仓库里有专门的测试
（`hermes_prompt_file_uses_soul_md`）锁住它。

### 6.3 原子写的真实保证：rename 有、fsync 没有

README 的「Design Principles」写着「**Atomic Writes**: Temp file + rename pattern
prevents config corruption」。实测 `config.rs:327` 的 `atomic_write()`，
这个描述准确，但**保证的边界需要说清**：

**做了的**：
- 临时文件名带 pid + 纳秒时间戳 + 原子计数器，`create_new(true)` 独占创建，**冲突重试 16 次**
- 写失败时清理临时文件
- **Unix**：`rename` 前用 `set_permissions` 复制目标文件的原权限位——
  避免覆写后权限变宽（对存 API Key 的文件是必要的）
- **Windows**：优先用 `ReplaceFileW`，`NotFound` 时回退 `fs::rename`，**最多重试 3 次**
  （处理杀软/编辑器持有文件句柄的场景，有对应测试
  `atomic_write_preserves_destination_when_windows_replace_fails`）

**没做的**：**全链路没有 `fsync` / `sync_all` / `sync_data`。**
实查全仓 20 处 `sync_all|sync_data|fsync` 匹配，全部是 SQLite journal 的注释
或不相关的 `sync_all_unlocked()` 业务函数，**配置写入路径一处都没有**。

**这意味着**：`rename` 保证的是「不会读到半写文件」（崩溃时要么旧内容要么新内容），
**但不保证「断电后新内容一定在盘上」**——rename 与数据块的落盘顺序由文件系统决定。
对这个场景（用户可重新点一次切换）这个取舍是合理的，
**但「prevents config corruption」应理解为「防半写」，不是「防断电丢更新」**。

---

## 7. 数据库：SQLite 单文件、16 张表、schema v16

**SSOT 是 `~/.cc-switch/cc-switch.db`**（`database/mod.rs:101`）。
README 的 Design Principles 称之为 SSOT（Single Source of Truth），
与 live 配置文件是「主副本 / 派生副本」关系。

### 7.1 表结构

`create_tables_on_conn()` 建 **16 张表**（脚本从函数体内数，不含迁移里的临时表）：

| 表 | 用途 |
|---|---|
| `providers` | 供应商主表，主键 `(id, app_type)` |
| `provider_endpoints` | 备用端点（测速用），外键级联删除 |
| `mcp_servers` | MCP 服务器（§16） |
| `prompts` | Prompts（§17） |
| `skills` / `skill_repos` | Skills 与仓库源（§18） |
| `settings` | `key TEXT PRIMARY KEY, value TEXT` 键值表 |
| `proxy_config` | 代理配置，主键 `app_type`，**CHECK 约束限定 4 个值** |
| `provider_health` | 健康状态 |
| `proxy_request_logs` | 逐请求明细（§15） |
| `usage_daily_rollups` | 按日聚合（§15） |
| `model_pricing` | 模型定价（§15） |
| `stream_check_logs` | 连通性检查日志（§14.3） |
| `proxy_live_backup` | 代理接管前的 live 配置备份（§11.3） |
| `session_log_sync` | 会话日志同步游标（§19） |
| `profiles` | 项目 Profile（§24） |

另有 **10 个索引**（`grep -c "CREATE INDEX IF NOT EXISTS"`）。

`proxy_config` 的 CHECK 约束很说明问题：

```sql
app_type TEXT PRIMARY KEY CHECK (app_type IN ('claude','codex','gemini','grokbuild'))
```

**数据库层面就限定了只有 4 个 app 能被代理接管**——与 §4.2 的能力矩阵一致，
不是 UI 层的软限制。

### 7.2 迁移：v16、16 个 arm、迁移前自动备份

```rust
pub(crate) const SCHEMA_VERSION: i32 = 16;   // database/mod.rs:56
```

迁移用 SQLite 的 `user_version` 追踪，`while version < SCHEMA_VERSION` 逐级推进，
**match arm 覆盖 0..15 共 16 个**（脚本数）。两处防护值得记：

**向前兼容拒绝**（`schema.rs:421`）：

```rust
if version > SCHEMA_VERSION {
    "数据库版本过新（{version}），当前应用仅支持 {SCHEMA_VERSION}，请升级应用后再尝试。"
}
```

**降级安装不会静默改坏新版数据库**——这对开了云同步（§23）的用户是必要的：
两台机器版本不一致时，旧版本会拒绝而不是破坏。

**迁移前自动备份**（`database/mod.rs:132`）：

```rust
if version > 0 && version < SCHEMA_VERSION {
    log::info!("Creating pre-migration database backup (v{version} → v{SCHEMA_VERSION})");
```

只在「已存在的库且需要升级」时备份，全新库跳过。

### 7.3 并发与 PRAGMA

```rust
pub struct Database { pub(crate) conn: Mutex<Connection> }
```

**单连接 + `Mutex`**，注释说明了原因：「rusqlite::Connection 本身不是 Sync 的」。
配套一个 `lock_conn!` 宏，把 `PoisonError` 转成 `AppError` 而**不是 unwrap panic**
（注释原文：「安全地获取 Mutex 锁，避免 unwrap panic」）。

**这是个明确的架构取舍**：所有数据库操作全局串行。对桌面单用户应用够用，
且省掉了连接池的复杂度。代价是重写入场景（如 §15 的会话用量导入）会阻塞读——
代码里确实为此做了批处理优化（`session_usage_codex.rs:1128` 注释：
「批间释放锁让读侧插队」）。

**PRAGMA 设置**：
- `foreign_keys = ON`（三处，含备份恢复后重置）
- `auto_vacuum = INCREMENTAL`，**只在新建库时设**（注释：新库在建表前配置好，
  之后无需 rebuild），另有 `PRAGMA incremental_vacuum` 的主动调用

**没有设 `journal_mode = WAL`。** 在单连接 + 全局 Mutex 的模型下 WAL 的
并发收益用不上，所以这不是漏配；但它意味着写入走的是默认的 rollback journal。

### 7.4 变更钩子驱动自动同步

```rust
conn.update_hook(Some(|action, _database, table, _row_id| match action {
    SQLITE_INSERT | SQLITE_UPDATE | SQLITE_DELETE => {
        crate::services::webdav_auto_sync::notify_db_changed(table);
        crate::services::s3_auto_sync::notify_db_changed(table);
    }
```

**用 SQLite 的 update_hook 触发云同步**（§23），而不是在每个业务写入点手动埋点。
这个设计的好处很实际：**新加一个 DAO 写入方法不会忘记通知同步层**——
把「容易漏」的横切关注点收敛到了一个必经之处。

---

## 8. README 与源码对不上的地方

开篇「关于本文的计数方法」说过要点出文档与代码的差异。逐条列出本次核到的：

| README 说法 | 源码实测 | 判定 |
|---|---|---|
| 「**50+ provider presets**」（多处） | **448 条条目 / 86 家去重厂商** | **口径不同，不算错**。厂商口径下 86 > 50 成立；但读者容易理解成「只有 50 个选择」，实际选择面大得多。见 §5.1 |
| 「**Tauri 2.8**」（Tech Stack） | `Cargo.toml`: `tauri = "2.8.2"` | 一致 |
| 「**Vite**」（未标版本） | `package.json`: `vite ^7.3.0` | 一致（README 未给版本，无冲突） |
| 「**TailwindCSS 3.4**」 | `tailwindcss ^3.4.17` | 一致 |
| 「**TanStack Query v5**」 | `@tanstack/react-query ^5.90.3` | 一致 |
| 「Backend: Tauri 2.8 · Rust · serde · tokio · thiserror · tauri-plugin-*」 | 真实依赖还包括 **axum / hyper / rusqlite / rquickjs / rust_decimal** 等 | **严重不完整**。Tech Stack 一节完全没提本地代理用的 axum+hyper、SQLite、内嵌 JS 引擎——而这些是代码量最大的部分。见 §3.3 |
| 「Backups: `~/.cc-switch/backups/`（auto-rotated, keeps **10** most recent）」 | `services/config.rs:10`: `const MAX_BACKUPS: usize = 10` | 一致 |
| 「Skill Backups … keeps **20** most recent」 | 未在本次核验中定位到该常量 | **未核验**，见 §26 |
| 「**Atomic Writes**: Temp file + rename prevents config corruption」 | temp+rename 确实有，**但全链路无 fsync** | **需要限定**：防半写成立，防断电丢更新不成立。见 §6.3 |
| 「**Concurrency Safe**: Mutex-protected database connection」 | `Mutex<Connection>` 确认 | 一致（§7.3） |
| 「Database: `~/.cc-switch/cc-switch.db`」 | `database/mod.rs:101` 确认 | 一致 |
| 「i18n (zh/zh-TW/en/ja)」 | 4 个 locale 文件确认 | 一致，但 key 数有 1 处不齐（§24.2） |

**总结：README 的功能描述可靠，技术栈描述明显滞后于代码。**
Tech Stack 一节读起来像是「一个用 Tauri 写的 React 应用」，
而实际上它还是一个 axum HTTP 网关 + SQLite 应用 + 内嵌 QuickJS 沙箱。
**如果你要判断这个项目的技术深度，别看 Tech Stack 那一节，去看 `Cargo.toml`。**

---

## 9. 供应商切换机制：三条路径

`ProviderService::switch()`（`services/provider/mod.rs:2966`）是整个应用最核心的函数。
它不是「写个文件」那么简单——按当前状态分三条路径。

### 9.1 路径分流

```rust
pub fn switch(state, app_type, id) -> Result<SwitchResult, AppError> {
    // 1. OMO / OMO Slim（OpenCode 专属）→ switch_normal
    // 2. ClaudeDesktop → switch_normal
    // 3. 其余：先取 per-app 切换锁，再判断是否被代理接管
    //    - 接管中  → hot_switch_provider_inner（热切换，不碰 live）
    //    - 未接管  → switch_normal（全量写 live）
}
```

**per-app 切换锁**（只对 Claude / Codex / Gemini / GrokBuild 加）：

```rust
let _switch_guard = if matches!(app_type, Claude | Codex | Gemini | GrokBuild) {
    Some(block_on(state.proxy_service.lock_switch_for_app(app_type.as_str())))
} else { None };
```

源码注释解释了为什么需要：

> Provider switches and takeover toggles both mutate live config and the
> restore backup. Serialize them per app, then decide from the locked
> current state so a just-started takeover cannot be overwritten by a
> normal live write.

**这是一个真实竞态的修复**：切换供应商与开启代理接管都会改 live 配置，
不串行化的话「刚开始的接管」会被「普通切换」覆盖掉。

### 9.2 接管检测：两个独立信号

```rust
let is_app_taken_over = block_on(state.db.get_live_backup(app_type.as_str())).ok().flatten().is_some();
let live_taken_over = state.proxy_service.detect_takeover_in_live_config_for_app(&app_type);
let should_hot_switch = is_app_taken_over || live_taken_over;
```

**两个信号取或**，注释说明了原因：

> Backup or live placeholders mean the live file is owned by proxy
> takeover, even if the proxy server is temporarily stopped or is in the
> activation window before enabled=true is committed.

- 信号一：`proxy_live_backup` 表里有该 app 的原始配置备份
- 信号二：live 配置文件里**存在占位符**

第二个信号的实现很干净（`is_claude_live_taken_over`）：检查 `env` 下
`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY`
四个键里有没有等于占位符常量的：

```rust
const PROXY_TOKEN_PLACEHOLDER: &str = "PROXY_MANAGED";
```

**这是本项目一个值得称许的设计**：代理接管时，**真实凭据不写进 live 配置文件**，
只写 `PROXY_MANAGED` 这个占位符 + 本机代理地址。
真实 Key 留在 SQLite 里，由代理层在转发时注入。

**安全含义**：接管模式下，即使别人读到你的 `~/.claude/settings.json`，
拿到的也只是 `PROXY_MANAGED` 和 `http://127.0.0.1:15721`，**不是 API Key**。
这比「把 Key 明文写进 live 配置」的常规做法要好。

### 9.3 一道保护用户账号的硬拦截

```rust
if should_hot_switch && _provider.category == Some("official")
   && !official_provider_supports_proxy_takeover(&app_type, _provider) {
    return Err(AppError::localized(
        "switch.official_blocked_by_proxy",
        "代理接管模式下不能切换到官方供应商，使用代理访问官方 API 可能导致账号被封禁。\
         请先关闭代理接管，或选择第三方供应商。", ...));
}
```

**接管模式下禁止切到官方供应商**，理由写在错误文案里：走代理访问官方 API
可能触发风控封号。这是一条**产品层面的风险判断被写成了代码里的硬约束**，
而不是留给用户自己踩。（有白名单函数 `official_provider_supports_proxy_takeover`
放行特定组合，如 §21 的 Codex OAuth 反代本来就要走代理。）

### 9.4 回填（backfill）：双向同步

README 的 Design Principles 里有一条「**Dual-way Sync**: Write to live files on switch,
backfill from live when editing active provider」。

代码里的实现（`services/provider/mod.rs:3090` 附近）：切换时，
**先把当前 live 配置回填进即将被切走的那个供应商**，再写入新供应商的配置。

```rust
// no backfill needed (backfill is for exclusive mode apps like Claude/Codex/Gemini)
// Only backfill when switching to a different provider
```

**为什么必须有这一步**：用户可能直接编辑了 live 文件（装了个插件、加了个 hook、
改了偏好设置）。如果切换只是「用数据库覆盖 live」，这些手工修改会被静默丢弃。
回填保证了它们被保存回原供应商的配置里。

**只有 Switch 模式（exclusive mode）的 app 需要回填**——Additive 模式下
所有供应商都在 live 里，不存在「被切走时丢失」的问题（§4.1）。

`backfill_completed` 是个显式标志，失败时会 push 一条 `backfill_failed:{id}` 到结果里，
且只在回填成功后才清理数据库副本（注释：「Only clean up after a successful backfill」）。
**失败不静默**。

---

## 10. 本地代理：axum HTTP 网关

这一章开始是本项目代码量最大的部分（`proxy/` 6.1 万行，占 Rust 侧 36%）。

**默认监听**（`proxy/types.rs:45`）：

```rust
listen_address: "127.0.0.1".to_string(),
listen_port: 15721,   // 注释：使用较少占用的高位端口
```

**默认只绑 loopback**，这是安全的默认值。但**可配置为非 loopback**——
`SECURITY.md` 明确把这点写进了威胁模型：

> It does, however, run a **local HTTP proxy** whose listen address and port are
> user-configurable and **may be bound to a non-loopback interface**. Requests
> arriving at that listener are untrusted input and are in scope.

**如果你把它绑到 `0.0.0.0`，就是在局域网上开了一个持有你全部 API Key 的
无认证转发端点。** 代码里没有对入站请求的鉴权层（本文未找到任何 listener 侧
的 token 校验）——它假定监听面是可信的。绑非 loopback 前务必想清楚这一点。

### 10.1 25 条路由

`build_router()`（`proxy/server.rs:291`）注册 **25 条**（`grep -cE '^\s+\.route\('`）：

| 分组 | 路由 |
|---|---|
| **健康** | `GET /health`、`GET /status` |
| **Claude（Anthropic Messages）** | `POST /v1/messages`、`POST /claude/v1/messages` |
| **Claude Desktop 独立网关** | `GET /claude-desktop/v1/models`、`POST /claude-desktop/v1/messages` |
| **OpenAI Chat Completions** | `POST /chat/completions`、`/v1/chat/completions`、**`/v1/v1/chat/completions`**、`/codex/v1/chat/completions` |
| **OpenAI Models** | `GET /models`、`GET /v1/models` |
| **OpenAI Responses** | `POST /responses`、`/v1/responses`、**`/v1/v1/responses`**、`/codex/v1/responses` |
| **Grok Build** | `POST /grokbuild/v1/responses`、`/grokbuild/v1/responses/compact` |
| **Responses Compact** | `/responses/compact`、`/v1/responses/compact`、`/v1/v1/responses/compact`、`/codex/v1/responses/compact` |
| **Gemini** | `ANY /v1beta/*path`、`ANY /gemini/v1beta/*path`、`ANY /gemini/v1/*path` |

**三处细节值得记：**

**① `/v1/v1/...` 不是笔误。** 这是为「用户在配置里填了带 `/v1` 后缀的 base_url，
客户端再拼一个 `/v1`」这种情况兜底。是对现实中配置错误的容错。

**② Gemini 用 `any(..)` 而非 `post(..)`**，注释解释得很好：

> 用 `any(..)` 覆盖所有 HTTP 方法：除了 POST `:generateContent` /
> `:streamGenerateContent` / `:countTokens` 之外，Gemini SDK / CLI 还会发
> GET `/models`、GET `/models/<id>` 等只读端点。如果只挂 POST，这些 GET
> 请求会在路由层 404，**绕过本地代理的统计、整流和故障转移**。

**「只挂 POST 会让 GET 请求绕过统计」——这是一个真实的可观测性缺口的修复记录。**

**③ 请求体上限 200MB**：`DefaultBodyLimit::max(200 * 1024 * 1024)`
（注释：避免 413 Payload Too Large）。多模态请求会很大，但 200MB 也意味着
单个请求能占掉不少内存。

### 10.2 手写 hyper accept 循环，为了 header 大小写

`proxy/server.rs` 文件头注释：

> Uses a manual hyper HTTP/1.1 accept loop with `preserve_header_case(true)` so
> that the original header-name casing from the CLI client is captured in a
> `HeaderCaseMap` extension. This map is later forwarded to the upstream via
> the hyper-based HTTP client, producing wire-level header casing **identical to
> a direct (non-proxied) CLI request**.

**这是一个反指纹识别的措施。** HTTP header 名按标准是大小写不敏感的，
但**上游可以用 header 大小写模式做客户端指纹**。如果代理把
`anthropic-version` 规范化成 `Anthropic-Version`（或反之），
上游就能看出「这个请求经过了代理」。

为了避免这一点，它放弃了 axum 的标准 `serve()`，手写 accept 循环
保留原始大小写并原样转发。**这个细节的存在说明作者认真考虑过
「上游能否识别出这是代理流量」这个问题。**

### 10.3 ProxyState：跨请求共享的状态

```rust
pub struct ProxyState {
    pub db: Arc<Database>,
    pub config: Arc<RwLock<ProxyConfig>>,
    pub status: Arc<RwLock<ProxyStatus>>,
    pub current_providers: Arc<RwLock<HashMap<String, (String, String)>>>,
    pub provider_router: Arc<ProviderRouter>,        // 持有熔断器状态
    pub gemini_shadow: Arc<GeminiShadowStore>,       // thoughtSignature / tool call 回放
    pub codex_chat_history: Arc<CodexChatHistoryStore>,  // previous_response_id 还原
    pub app_handle: Option<tauri::AppHandle>,
    pub failover_manager: Arc<FailoverSwitchManager>,
}
```

两个 shadow store 值得注意，它们是**协议转换的必要状态**（§12）：

- `GeminiShadowStore`：Gemini 的 `thoughtSignature` 与 tool call 需要跨请求回放
- `CodexChatHistoryStore`：Responses 协议的 `previous_response_id` 指向的
  tool call 在转成 Chat 格式时需要还原历史

**协议转换不是无状态的纯函数**——这是把 A 协议桥到 B 协议时最容易踩的坑，
因为两个协议对「会话历史怎么表达」的假设不同。

### 10.4 热更新

```rust
pub async fn apply_runtime_config(&self, config: &ProxyConfig)  // 不重启改配置
pub async fn update_circuit_breaker_configs(...)                // 全局熔断参数
pub async fn update_circuit_breaker_config_for_app(...)         // 单 app 熔断参数
```

配置改动不需要重启代理服务，熔断器参数也能热更新到已创建的实例上。

---

## 11. 代理接管：live 配置的所有权转移

「接管」（takeover）是理解代理模式的关键概念。

### 11.1 接管时发生什么

以 Claude 为例，接管后 `~/.claude/settings.json` 的 `env` 变成：

```json
{
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:15721",
  "ANTHROPIC_AUTH_TOKEN": "PROXY_MANAGED"
}
```

**真实凭据不在这里**（§9.2）。原始配置被完整存进 `proxy_live_backup` 表：

```sql
CREATE TABLE IF NOT EXISTS proxy_live_backup (
    app_type TEXT PRIMARY KEY, original_config TEXT NOT NULL, backed_up_at TEXT NOT NULL
)
```

**每个 app 一行**，关闭接管时用它还原。

### 11.2 接管状态的判定与自愈

§9.2 讲了双信号判定。还有一个**自愈路径**（`services/proxy.rs:1923`）：

> 当 Live 备份缺失时，尝试用 SSOT（当前供应商）写回 Live，以解除占位符接管。

**场景**：live 里有占位符（说明曾被接管），但 `proxy_live_backup` 里没有备份
（数据库被重置 / 同步覆盖 / 异常退出）。这时如果不处理，
用户的 CLI 会永远指向一个可能没在跑的本机端口，且无法自行恢复。
自愈逻辑用数据库里的当前供应商重建 live 配置。

**这是「配置被改坏后能不能自己走出来」的一个正面例子**——
接管这类修改外部文件的功能，最怕的就是留下用户无法自行修复的中间态。

### 11.3 per-app 独立接管

`proxy_config` 表主键是 `app_type`，且有 CHECK 约束限定
`('claude','codex','gemini','grokbuild')`。每个 app 独立开关：

```rust
pub struct AppProxyConfig {
    pub app_type: String,
    pub enabled: bool,                        // 该 app 代理启用
    pub auto_failover_enabled: bool,          // 该 app 故障转移
    pub max_retries: u32,
    pub streaming_first_byte_timeout: u32,    // 流式首字超时（秒）
    pub streaming_idle_timeout: u32,          // 流式静默超时（秒）
    pub non_streaming_timeout: u32,
    pub circuit_failure_threshold: u32,
    pub circuit_success_threshold: u32,
    pub circuit_timeout_seconds: u32,
    pub circuit_error_rate_threshold: f64,
    pub circuit_min_requests: u32,
}
```

**可以只接管 Codex 而不动 Claude。** 这个粒度是对的——
用户往往只想给某一个工具换供应商。

> **流式超时分了三个参数**（首字 / 静默 / 非流式总时长），
> 这说明作者踩过「用一个超时值管所有场景」的坑：
> 首字节慢（模型思考）与流中断（网络问题）是两种完全不同的故障，
> 共用一个阈值必然导致误杀。**这与 sid-code 自己踩过的
> 「硬编码 60s 心跳杀死网关慢首字节」是同一类问题的同一种解法。**

---

## 12. 协议转换：7 个 transform 模块

这是「让 Claude Code 用 GPT 模型」这类跨协议路由的实现层。
`proxy/providers/` 下 **31 个文件 / 36,178 行**，其中 **7 个 `transform_*`**
与 **5 个 `streaming*`**（脚本按文件名前缀数）。

### 12.1 适配器抽象

`ProviderAdapter` trait（`proxy/providers/adapter.rs`）：

```rust
pub trait ProviderAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    fn extract_base_url(&self, provider: &Provider) -> Result<String, ProxyError>;
    fn extract_auth(&self, provider: &Provider) -> Option<AuthInfo>;
    fn build_url(&self, base_url: &str, endpoint: &str) -> String;
    fn get_auth_headers(&self, auth: &AuthInfo)
        -> Result<Vec<(http::HeaderName, http::HeaderValue)>, ProxyError>;
    fn needs_transform(&self, _provider: &Provider) -> bool { false }
    fn transform_request(&self, body: Value, _provider: &Provider) -> Result<Value, ProxyError>;
    fn transform_response(&self, body: Value) -> Result<Value, ProxyError>;
}
```

三个实现：`ClaudeAdapter` / `CodexAdapter` / `GeminiAdapter`。

**`get_auth_headers` 返回 `Vec<(name, value)>` 而不是直接改 headers**，
注释说明了原因：

> The forwarder inserts these at the position of the original auth header
> so that header order is preserved.

**连 header 顺序都保留**——与 §10.2 的大小写保留是同一动机（反指纹）。

另一处细节：

> Returns `ProxyError::AuthError` when the credential contains characters
> that cannot be encoded as an HTTP header value (e.g. control chars,
> CR/LF), which would otherwise **panic inside `HeaderValue::from_str`**.

**这是一个 CRLF 注入 + panic 防护。** 用户粘贴的 API Key 里如果带了换行
（复制时很常见），`HeaderValue::from_str` 会 panic；
不处理的话一个格式错误的 Key 能让后端崩掉。转成 `AuthError` 是对的。

### 12.2 转换矩阵

| 转换 | 模块 | 场景 |
|---|---|---|
| Anthropic ↔ OpenAI Chat | `transform_codex_chat.rs`（4,558 行，全仓第 6 大文件） | Claude Code 用 Chat 协议网关 |
| Anthropic ↔ OpenAI Responses | `transform_responses.rs`、`transform_codex_anthropic.rs` | Claude Code 用 GPT / Codex |
| Responses namespace 展平 | `transform_codex_responses_namespace.rs` | 部分网关不认命名空间 |
| xAI Responses 消毒 | `transform_codex_responses_xai_sanitize.rs` | xAI 的 Responses 变体 |
| Gemini native | `transform_gemini.rs`、`gemini_schema.rs` | Gemini generateContent |
| 通用 | `transform.rs` | 共用工具 |

流式侧对应 5 个：`streaming.rs`、`streaming_codex_anthropic.rs`、
`streaming_codex_chat.rs`、`streaming_gemini.rs`、`streaming_responses.rs`。

**SSE 流式转换是这里最难的部分**：两个协议的事件序列结构不同
（Anthropic 的 `content_block_start/delta/stop` vs OpenAI 的 `choices[].delta`），
且要处理工具调用的增量拼接。仓库里为此单列了 `proxy/sse.rs`
与 `codex_responses_sse.rs`。

### 12.3 官方文档承认的能力边界

`docs/guides/claude-codex-routing-guide-zh.md` 里对这条链路的描述很坦率，
并且给出了四步机制：

1. 接管后 `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 写成本机地址
   （默认 `http://127.0.0.1:15721`），「认证项只留占位符，真实凭据不进 live 配置」
2. 供应商 `API 格式` 设为 OpenAI Responses
3. 路由把 `/v1/messages` 转成 Responses 请求发给上游
4. 上游返回后转回 Messages 形态

文档明确说了转换覆盖范围：「工具调用、图片、PDF、思考配置都在转换范围内」。

**这份 guide 还标了版本下界**：「适用版本：CC Switch 3.17.0 及以上
（更早版本已具备本文两种接入方式，但 gpt-5.6 预设与客户端身份修复自 3.17.0 落地，
低版本请求 `gpt-5.6-luna` 这类新模型会误报 404）」。
**文档带版本下界与失败症状**，这个质量在开源项目里不常见。

---

## 13. 请求改写：整流器与优化器

代理不只是转发，还会**主动改写请求体**。这一节列出所有改写点——
因为「我的请求被中间层动过」是使用本地代理时最需要知道的事。

### 13.1 整流器（Rectifier）：错误驱动的自动修复

`RectifierConfig`（`proxy/types.rs:194`），**5 个开关，默认全开**：

| 开关 | 作用 | 触发的上游错误 |
|---|---|---|
| `enabled` | 总开关 | — |
| `request_thinking_signature` | 移除有问题的 thinking 签名后重试 | `Invalid 'signature' in 'thinking' block` |
| `request_thinking_budget` | 调整 budget 参数后重试 | `budget_tokens` 相关约束 |
| `request_media_fallback` | 图片块替换为 `[Unsupported Image]` | 上游拒绝图片输入 |
| `request_media_heuristic` | 按内置纯文本模型注册表**预先**剥离图片 | （预防性，非错误驱动） |

对应模块：`thinking_rectifier.rs`（722 行）、`thinking_budget_rectifier.rs`（365 行）、
`media_sanitizer.rs`（**1,308 行**）。

`thinking_budget_rectifier.rs` 里有两个硬编码上界：

```rust
const MAX_THINKING_BUDGET: u64 = 32000;
const MAX_TOKENS_VALUE: u64 = 64000;
```

**这两个常量会过期**——模型的 budget 上限随版本变化。本文记录它们在
v3.19.2 的值，不代表当前模型的真实上限。

`media_sanitizer.rs` 的能力模型分三态（`model_capabilities.rs`）：

```rust
pub(crate) enum ImageInputCapability { Supported, Unknown, ... }
```

注释说明了 `Unknown` 为什么必须与 `Supported` 分开：

> `Unknown` is intentionally distinct from `Supported`: callers may choose
> different execution policies without duplicating the model-name registry.
> The Codex catalog treats unknown models as image-capable (**fail open**), while
> the media rectifier leaves their request bodies **untouched**.

**同一个 `Unknown` 在两个消费方走不同策略**，且都不是「猜一个」——
catalog 侧 fail open，改写侧不动。这是对「不知道」这个状态的正确处理。

### 13.2 Cache 断点注入

`cache_injector.rs`（437 行）自动注入 `cache_control` 标记以启用 prompt caching。

**Anthropic 的断点上限是 4 个**，注入器的预算管理：

```rust
let existing = count_existing(body);
if existing > 4 {
    // Existing markers are caller-owned. Do not silently delete or reorder them
    log::warn!("[OPT] cache: existing breakpoint count {existing} exceeds the supported total of 4; preserving caller input");
}
let mut budget = 4_usize.saturating_sub(existing);
if budget == 0 { log::info!("[OPT] cache: no-op(existing={existing})"); return; }
```

**已有断点是调用方的，不静默删除或重排**——把非法总数透给上游去报错，
而不是自作聪明地改。这个原则是对的：静默改写用户显式指定的东西，
会让问题变得无法诊断。

注入位置按优先级 4 处：

1. `tools` 数组末尾
2. `system` 末尾（字符串形式的 `system` 会先转成数组）
3. **最后一条可缓存消息的最后一个非 thinking block**
4. **更早的第二个 user 锚点**（仅当 `messages.len() >= 4`）

第 3、4 处的注释解释了为什么这么选，含信息量很高：

> (c) 最后一条可缓存消息的最后一个非 thinking block。工具循环通常以
> user/tool_result 结束；**只标 assistant 会让最新稳定前缀无法命中缓存。**

> (d) A second, older user anchor helps long tool-result turns where
> the stable prefix falls outside **Anthropic's 20-block lookback** from
> the newest breakpoint.

**「Anthropic 的 20-block lookback」是一个不在官方文档显著位置的实现细节**，
作者显然是实测或踩坑得来的。这也是本系列 `prompt-cache` 那篇讨论过的同类问题：
断点位置决定缓存命中率，而「放最后一个」在工具循环里往往是错的。

### 13.3 Thinking 优化器

`thinking_optimizer.rs`（338 行）三路径分发：

```
- skip:     haiku 模型直接跳过
- adaptive: current adaptive-thinking Claude models use adaptive thinking
- legacy:   其他模型注入 enabled thinking + budget_tokens
```

### 13.4 Copilot 优化器：省 premium interaction 额度

`copilot_optimizer.rs`（**1,539 行**）解决一个很具体的计费问题
（文件头注释指明是 Issue #1813，参考实现 `caozhiyuan/copilot-api`）：

> Copilot 使用 `x-initiator` 请求头区分「用户发起」和「agent 续写」：
> - `user`：计为一次 premium interaction（**扣额度**）
> - `agent`：视为上一次交互的延续（**不额外扣费**）

分类算法（只看最后一条消息）：

```
1. 无消息 → "user"（安全默认）
2. 最后消息 role=user：
   - content 有非 tool_result block → "user"
   - content 全是 tool_result → "agent"
   - 匹配 compact 模式 → "agent"
3. 最后消息 role 非 user → "user"（安全默认）
```

还识别两种特殊请求：**warmup 探针**（有 `anthropic-beta` + 无 tools + 非 compact）
可降级到小模型；**子代理请求**（扫首条用户消息里的 `__SUBAGENT_MARKER__`）
标 `x-interaction-type=conversation-subagent` 不计 premium。

**两处「安全默认」都倒向 `user`（扣费）**——这个方向选得对：
猜错成 `agent` 是在少报用量（可能违反 Copilot 条款），猜错成 `user` 只是多扣自己的额度。

> **这个功能的合规性值得使用者自己判断。** 它做的是「按 Copilot 自己的
> header 语义正确标注请求类型」，参考的是 Copilot 官方 header 契约，
> 而不是伪造计数。但它的**效果**是减少 premium interaction 消耗，
> 是否符合你的 Copilot 订阅条款，本文不做判断，也未核验 Copilot 条款原文。

### 13.5 其它改写点

| 模块 | 行数 | 作用 |
|---|---:|---|
| `model_mapper.rs` | 428 | 按 provider 配置替换模型名（haiku/sonnet/opus/fable 四档映射） |
| `body_filter.rs` | 339 | **过滤 `_` 前缀私有参数**，防内部信息泄露到上游 |
| `json_canonical.rs` | 190 | 键排序 + SHA256，用于 cache 敏感请求体的稳定化 |
| `content_encoding.rs` | — | gzip / brotli / zstd 处理 |
| `tool_media.rs` | — | 工具输出里的媒体剥离 |

`body_filter.rs` 的规则有一处细致处理：

> JSON Schema 的 properties / patternProperties / definitions / $defs 名称
> 是用户定义的字段名，**不按私有参数过滤**

**递归过滤 `_` 前缀字段时，不能误伤 JSON Schema 里用户自定义的字段名**——
工具定义里完全可以有个叫 `_internal` 的参数。这个例外说明作者被这个 bug 咬过。

---

## 14. 故障转移与熔断

### 14.1 供应商选择：队列而非轮询

`ProviderRouter::select_providers()`（`proxy/provider_router.rs:37`）：

```rust
/// - 故障转移关闭时：仅返回当前供应商
/// - 故障转移开启时：仅使用故障转移队列，按队列顺序依次尝试（P1 → P2 → ...）
```

**开启后「只用队列」，不含当前供应商**（除非它也在队列里）。
队列顺序由 `get_failover_queue()` 给出，注释说明「使用 DAO 返回的排序结果，
确保和前端展示一致」——**用户在 UI 里看到的顺序就是实际尝试顺序**。

读配置失败时的降级：

```rust
Err(e) => { log::error!("[{app_type}] 读取 proxy_config 失败: {e}，默认禁用故障转移"); false }
```

**读不到配置就关掉故障转移**，不是默认开启。保守方向正确
（故障转移会把请求发到用户可能没预期的供应商）。

### 14.2 熔断器：三态 + 双判据

`CircuitBreaker`（`proxy/circuit_breaker.rs`）标准三态：
`Closed` / `Open` / `HalfOpen`。

**默认参数**：

```rust
failure_threshold: 4,        // 连续失败 4 次 → Open
success_threshold: 2,        // 半开态成功 2 次 → Closed
timeout_seconds: 60,         // Open 后 60s → HalfOpen
error_rate_threshold: 0.6,   // 错误率 > 60% → Open
min_requests: 10,            // 算错误率前至少 10 个请求
```

**双判据**：连续失败计数 **或** 错误率（带最小样本数保护）。
只用错误率会在样本少时误判，只用连续计数会漏掉「间歇性失败」——两者取或是标准做法。

状态转换在 `is_available()` 里**惰性触发**：

```rust
CircuitState::Open => {
    if opened_at.elapsed().as_secs() >= config.timeout_seconds {
        drop(config); // 释放读锁再转换状态
        self.transition_to_half_open().await;
        return true;
    }
    false
}
```

**`drop(config)` 那一行是为了避免读锁升级死锁**——先释放 `RwLock` 读锁
再去拿写锁做状态转换。这是 `RwLock` 使用中的经典陷阱，处理正确。

计数器用 `AtomicU32`，状态用 `RwLock`——**热路径（计数）无锁，冷路径（状态转换）加锁**。

### 14.3 故障转移后的切换去重

`FailoverSwitchManager`（`proxy/failover_switch.rs`）解决一个并发问题：
多个请求同时触发故障转移时，不应该重复执行切换。

```rust
pending_switches: Arc<RwLock<HashSet<String>>>,  // key = "app_type:provider_id"

/// - Ok(true)  - 切换成功执行
/// - Ok(false) - 切换已在进行中，跳过
```

切换成功后会**更新托盘菜单 + 发前端事件**，注释说明动机：
「负责处理故障转移成功后的供应商切换，确保 UI 能够直观反映当前使用的供应商」。

**故障转移不是静默的**——用户能在托盘和界面上看到「现在用的是备用供应商」。
这一点重要：静默降级会让用户困惑于「为什么回答质量变了」。

### 14.4 连通性检查：刻意不验证鉴权

`services/stream_check.rs`（525 行）的设计取舍写得很清楚：

> 仅探测供应商 `base_url` 是否可达，**不发送真实大模型请求**：
> - 收到任意 HTTP 响应（200/4xx/5xx）即判定"可达"（端口通、网关存活）；
> - 仅 DNS / 连接被拒 / TLS / 超时等网络级错误判定"不可达"；
> - 延迟 = 收到响应头的耗时（TTFB，真实往返）。
>
> ## 设计取舍：可达 ≠ 配置正确
>
> 本检查刻意不验证鉴权或模型，因此不会被第三方供应商的鉴权拦截 / 模型校验
> 误判为"不可用"。**代价是它无法告诉你鉴权对不对、模型存不存在。**

**「刻意不验证」+ 明写代价**，这是本仓库注释质量的代表。
另有 `services/speedtest.rs`（187 行）做端点测速（默认 8s 超时，2–30s 可调）。

---

## 15. 用量与成本统计

### 15.1 两层存储：明细 + 日聚合

| 表 | 粒度 | 保留 |
|---|---|---|
| `proxy_request_logs` | **逐请求** | `retain_days` 之后被 prune |
| `usage_daily_rollups` | **按日 × app × provider × model** | 长期 |

`proxy_request_logs` 的字段很全：input/output/cache_read/cache_creation 四类 token、
四类成本、`latency_ms`、**`first_token_ms`**（TTFT）、`duration_ms`、`status_code`、
`error_message`、`session_id`、`is_streaming`、`cost_multiplier`、`data_source`。

**它记了 TTFT。** 对一个供应商管理工具来说这是必要的——
「哪个中转站首字更快」正是用户切换供应商的核心依据。

### 15.2 成本用 Decimal 而不是 f64

```rust
//! 使用高精度 Decimal 类型避免浮点数精度问题
use rust_decimal::Decimal;
```

且**数据库里成本列是 `TEXT`**（`input_cost_usd TEXT NOT NULL DEFAULT '0'`），
不是 REAL——**避免 SQLite 侧的浮点round-trip 误差**。
对累加大量小额费用的场景，这个选择是对的。

`cost_multiplier` 的语义有明确注释：「倍率只作用于最终总价」，
不是分项各乘一次。

### 15.3 input token 语义分歧：一个真实的坑

这是本章最值得记的一处。不同厂商对「input_tokens 是否包含 cache_read」的定义**不一致**：

```rust
/// Codex/OpenAI Responses 与 Gemini 的输入 token 字段【包含】 cache read 部分；
/// Claude/Anthropic 的 input_tokens 已经是 fresh input。
pub fn calculate_for_app(app_type: &str, ...)
```

**如果不区分，跨供应商的成本对比会系统性错**：
对 Codex/Gemini 按 Claude 的语义算，会把 cache_read 的 token 按 fresh input 价格
重复计一次（cache read 通常便宜 10 倍）。

数据库为此存了一列 `input_token_semantics INTEGER`，
并且 `usage_daily_rollups` 也带这一列——**聚合后仍能区分语义**。

`usage_daily_rollups` 的建表注释解释了为什么还要存 `request_model` / `pricing_model`：

> `request_model` 保留路由接管的「客户端别名 → 真实模型」映射维度，
> `pricing_model` 保留写入时的计价基准（request 计价模式下与 model 分叉），
> 否则明细被 prune 后**接管计费不可审计**；历史行迁移时填 ''（未知）。

**「否则明细被 prune 后接管计费不可审计」——这是把可审计性当成 schema 设计约束**，
而不是事后补。

### 15.4 定价来源：内置 + models.dev 同步

`services/model_pricing.rs` 维护 `model_pricing` 表 + 一个
`model-pricing.json` 文件副本（`MODEL_PRICING_FILE_VERSION: u32 = 1`）。

支持从 **models.dev** 自动同步（命令 `get_models_dev_sync_config` /
`save_models_dev_sync_config` / `record_models_dev_sync_result`），
前端有 `ModelsDevAutoSyncPanel.tsx`（668 行）。

`commands/usage.rs:198` 有一处注释：
「批量更新模型定价（models.dev 自动同步仅触发一次历史成本回填）」——
**改价后会回填历史成本，但只回填一次**。

`schema.rs:2537` 留了一条审计记录：
「2026-07-31 models.dev 审计核价：DeepSeek V4 发布后 chat/reasoner 降为 V4 Flash」。
**迁移脚本里带人工核价的日期与理由**，这是个好习惯。

### 15.5 会话日志导入：不只统计代理流量

`session_log_sync` 表 + `services/session_usage.rs` / `session_usage_codex.rs`
把 **CLI 自己写的会话日志**导入用量库——
所以即使没开代理，也能统计到用量（`data_source` 列区分来源，默认 `'proxy'`）。

`session_usage_codex.rs` 里有几条性能注释值得记（它们是实测数字）：

> 批间释放锁让读侧插队——兼顾吞吐（避免逐行 autocommit 的每行 fsync）

> journal 建立/fsync/删除）是全量重导的最大耗时项

以及 `database/backup.rs:246`：

> 目标是磁盘上的暂存库，等于每行一次 fsync——**2.6 万行实测 119 秒**。

**「2.6 万行实测 119 秒」是作者自己的实测数据**，本文原样引用，未复现。

---

## 16. MCP 管理：6 个 app 的双向同步

`src-tauri/src/mcp/`，**2,431 行 / 8 个文件**：

| 文件 | 行数 | app |
|---|---:|---|
| `codex.rs` | **847** | Codex（含 TOML 转换） |
| `hermes.rs` | 575 | Hermes |
| `opencode.rs` | 356 | OpenCode（含 local/remote 格式转换） |
| `grokbuild.rs` | 251 | Grok Build |
| `claude.rs` | 149 | Claude |
| `gemini.rs` | 144 | Gemini |
| `validation.rs` | 69 | 配置校验 |
| `mod.rs` | 40 | 导出 |

**6 个 app 支持 MCP 同步**（Claude Desktop、OpenClaw 不支持，§4.2）。
`codex.rs` 是 `claude.rs` 的 5.7 倍——因为 Codex 用 TOML，
JSON→TOML 的结构映射（尤其是嵌套表与数组）比 JSON→JSON 复杂得多。

每个 app 模块提供统一四件套：`import_from_*` / `sync_enabled_to_*` /
`sync_single_server_to_*` / `remove_server_from_*`。

### 16.1 校验：三种传输 + 缺省即 stdio

`validation.rs` 的 `validate_server_spec()`：

```rust
// 支持三种：stdio/http/sse；若缺省 type 则按 stdio 处理（与社区常见 .mcp.json 一致）
let is_stdio = t_opt.map(|t| t == "stdio").unwrap_or(true);
```

**缺省 `type` 视为 stdio**，注释说明是「与社区常见 `.mcp.json` 一致」——
兼容现实中的写法而不是死守规范。stdio 类型必须有非空 `command`。

### 16.2 单 server 物化 vs 全量同步

`services/mcp.rs` 有 `sync_all_enabled()`，也有 `sync_single_server_to_*`。
`services/mcp.rs:278` 有一个 `#[deprecated(since = "3.7.0", note = "Use sync_all_enabled instead")]`
——**旧 API 保留但标注废弃**，没有直接删掉。

`services/provider/mod.rs:95` 有一条注释解释了排序讲究：

> sync_all_enabled：后者按 AppType::all() 顺序逐应用短路，排在 Codex …

（此处注释在源码中被截断于本次读取范围，本文不推测其完整含义。）

---

## 17. Prompts：跨应用同步与回填保护

`prompts` 表 + `prompt.rs` / `prompt_files.rs` / `services/prompt.rs`。
文件名映射见 §6.2。

**核心语义是「互斥激活 + 原子写 live」**（`services/profile.rs` 的注释里点明：
`PromptService::enable_prompt`（互斥激活 + 原子写 live））。
即同一个 app 同时只有一个 prompt 生效，切换时原子替换。

README 提到「backfill protection」——与供应商回填（§9.4）同理：
用户可能直接编辑了 `CLAUDE.md`，激活另一个 prompt 前要先把改动存回去。

前端是 `src/components/prompts/` + CodeMirror 的 Markdown 模式。

---

## 18. Skills：SSOT + symlink，以及一处扎实的解压加固

`services/skill.rs` **4,728 行**，是 Rust 侧第 4 大文件。

### 18.1 SSOT 与两个候选根目录

```
//! v3.10.0+ 统一管理架构：
//! - SSOT（单一事实源）：`~/.cc-switch/skills/`
//! - 安装时下载到 SSOT，按需同步到各应用目录
//! - 数据库存储安装记录和启用状态
```

代码里有两个候选 SSOT：

- `~/.cc-switch/skills/`（CC Switch 管理目录）
- **`~/.agents/skills/`（Agent Skills 统一标准目录）**

`get_ssot_dir()` 按设置返回其一。**`~/.agents/skills/` 的存在说明
「跨工具共享 skills」已经出现了目录约定**，CC Switch 选择兼容它而不是自立门户。

### 18.2 同步策略：symlink 优先，失败回退 copy

```rust
/// 自动选择：优先 symlink，失败时回退到 copy
/// - Auto: 优先尝试 symlink，失败时回落到 copy
/// - Symlink: 仅使用 symlink
```

平台分支：Unix 用 `std::os::unix::fs::symlink`，
Windows 用 `std::os::windows::fs::symlink_dir`。

**Windows 上创建 symlink 通常需要管理员权限或开发者模式**，
所以 `Auto` 的回退不是理论上的谨慎——在 Windows 上大概率会真的走 copy 分支。

### 18.3 解压加固：本仓库安全代码质量最高的一处

Skills 可以从 GitHub 仓库或 ZIP 安装，而**归档字节完全由第三方控制**
（仓库可经 deeplink 添加，§20）。这段注释把威胁模型写得很清楚：

> 归档字节由第三方完全控制（仓库可经 deeplink 添加，且 branch 可把下载落点
> 改写到攻击者自传的 release asset），没有上限时一个几 MB 的压缩炸弹就能塞满磁盘。

**五个硬上限**：

```rust
const MAX_ARCHIVE_ENTRIES: usize = 10_000;
const MAX_ARCHIVE_TOTAL_BYTES: u64 = 512 * 1024 * 1024;   // 解压总量
const MAX_SYMLINK_TARGET_BYTES: u64 = 4 * 1024;
const DIRECTORY_BUDGET_COST: u64 = 4096;
const MAX_ARCHIVE_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024; // 压缩体
```

每个上限都附了理由，其中三条尤其有价值：

**① symlink 目标大小上限，防的是一个具体的库行为**：

> 必须有这个上限：zip 2.4.2 的 `make_reader` **不按声明的 uncompressed_size
> 截断读取**，所以一个打了 symlink 标志、deflate 流却能膨胀到数 GB 的条目，
> 会被 `read_to_string` 整个读进内存。

**这是对依赖库具体版本行为的实测认知**，不是照抄通用建议。

**② 空目录也要计费**：

> 物化一个目录按一个目录块计费。空目录不写内容字节，但照样吃 inode 和磁盘块，
> 不计费就等于允许无限量地造目录。

**③ 下载上限必须独立于解压预算**：

> 解压预算只有在 ZipArchive 建起来之后才生效，而那时整个响应体
> 已经在内存里了，所以下载这一步需要自己的上限。

**Zip Slip 防护里有一处很细的认知**（`skill.rs:3643` 附近的测试注释）：

> - 两级 `../../`：净深度为负，`enclosed_name()` 自己就会拒绝；
> - 一级 `../`：净深度非负，`enclosed_name()` **放行**且原样保留 `..`，

所以代码不能只依赖 `zip` crate 的 `enclosed_name()`，
额外做了 `Component::ParentDir` 扫描：

```rust
.any(|c| matches!(c, Component::ParentDir))
```

**「库的安全函数在这个边界上不够」是必须实测才能发现的**。
配套测试 `extract_repo_archive_rejects_path_traversal_entries` 用
`repo-main/../../escaped.txt` 与 `repo-main/../escaped-one-level.txt` 两种条目锁死行为。

还有 **branch 名校验**（`skill.rs:2294`）：

> `a/.../b` 这类变形。除 `git check-ref-format` 的规则外还额外禁掉 `#` 与 `%`：

因为 branch 名会拼进下载 URL，`../../../releases/download/v1/evil`
这类 branch 能把下载落点改到攻击者控制的 asset。测试用例覆盖了
`../x`、`a/../../b` 等变形。

> **本文对这一节的判断**：Skills 安装是这个应用**攻击面最大**的功能
> （第三方内容 + 解压 + 写文件系统 + 可经 deeplink 触发），
> 而它同时是防护写得最扎实、注释最讲得清、测试覆盖最密的一处。
> 这个匹配关系是对的——**加固强度应当与攻击面对齐**。

### 18.4 技能搜索

`skill.rs:3363` 有一个外部端点：`https://skills.sh/api/search`。
**这是一个第三方服务依赖**（非本项目域名，非 ccswitch.io）。
本文未核验 `skills.sh` 的运营方与数据处理方式。见 §26。

---

## 19. Session Manager：7 个来源的会话浏览

`src-tauri/src/session_manager/`，**5,112 行**。

`providers/` 下 **7 个 app 各一个解析器**：
`claude.rs` `codex.rs` `gemini.rs` `grokbuild.rs` `hermes.rs` `openclaw.rs` `opencode.rs`
（Claude Desktop 无，§4.2）。

**统一数据模型**：

```rust
pub struct SessionMeta {
    pub provider_id: String, pub session_id: String,
    pub title: Option<String>, pub summary: Option<String>,
    pub project_dir: Option<String>,
    pub created_at: Option<i64>, pub last_active_at: Option<i64>,
    pub source_path: Option<String>,
    pub resume_command: Option<String>,   // ← 关键
}
pub struct SessionMessage { pub role: String, pub content: String, pub ts: Option<i64> }
```

**`resume_command` 是这个功能的落点**：不只是「看历史」，
而是给出能恢复该会话的命令。配合 `session_manager/terminal.rs` +
`commands/misc.rs` 的 `open_provider_terminal`（`misc.rs:3333`）直接开终端。

**7 个工具的会话日志格式各不相同**（JSONL / SQLite / 自定义），
每个解析器都要单独适配——`codex_state_db.rs` 与 `codex_history_migration.rs`
的存在说明 Codex 用的是 SQLite 状态库。

前端 `SessionManagerPage.tsx`（1,753 行）+ `useSessionSearch.ts`，
搜索用 **flexsearch**（`package.json` 依赖），长列表用 `@tanstack/react-virtual`。

**删除是有回执的**：

```rust
pub struct DeleteSessionRequest { provider_id, session_id, source_path }
pub struct DeleteSessionOutcome { provider_id, ... }
```

要求传 `source_path`——**删除会话要指明删的是哪个文件**，
不靠 id 反查，减少误删。

---

## 20. Deep Link：`ccswitch://` 协议

注册在 `tauri.conf.json`：

```json
"deep-link": { "desktop": { "schemes": ["ccswitch"] } }
```

**URL 形态**：`ccswitch://v1/import?resource={type}&...`

`parse_deeplink_url()`（`deeplink/parser.rs`）的校验是**逐段白名单**：

| 段 | 要求 | 不符则 |
|---|---|---|
| scheme | 必须 `ccswitch` | `Invalid scheme` |
| host（版本） | 必须 `v1` | `Unsupported protocol version` |
| path | 必须 `/import` | `Invalid path` |
| `resource` 参数 | `provider` / `prompt` / `mcp` / `skill` 四者之一 | 分派失败 |

四种资源各有独立解析器（`provider.rs` / `prompt.rs` / `mcp.rs` / `skill.rs`）。
`deeplink/tests.rs` 有 **33 个测试**。

**这是外部输入进入应用的主要通道之一**，`SECURITY.md` 把它列在范围内：

> **Still in scope:** any complete, demonstrable chain in which an *untrusted*
> source — a `ccswitch://` deep link, a remote sync payload, remote data, an
> inbound proxy request, or an XSS — reaches a high-privilege IPC command.

**风险要说清**：一个 `ccswitch://` 链接可以让用户「一键导入」一个供应商配置
（含 base_url 与 Key）、一个 MCP server（含要执行的 `command`）、
或一个 skill 仓库地址。**MCP server 的 `command` 字段是要被 CLI 执行的**——
恶意 deeplink 诱导用户导入一个 MCP server，等于诱导用户在自己机器上装一个会被执行的命令。

代码侧的对策是：**导入需要用户在 UI 里确认**
（`DeepLinkImportDialog.tsx`，779 行，展示要导入的内容）。
仓库里还有 `deplink.html`（104KB，标题 "CC Switch 深链接测试"）作为测试页。

**本文未核验的**：确认对话框是否完整展示 MCP `command` 的全部内容
（截断展示会削弱确认的意义）。见 §26。

---

## 21. OAuth：三条认证链路

除了 API Key，有三个供应商走 OAuth。命令统一在 `commands/auth.rs`（398 行）：

```rust
const AUTH_PROVIDER_GITHUB_COPILOT: &str = "github_copilot";
const AUTH_PROVIDER_CODEX_OAUTH: &str = "codex_oauth";
const AUTH_PROVIDER_XAI_OAUTH: &str = "xai_oauth";
```

| 链路 | 实现 | 端点 | 预设数 |
|---|---|---|---:|
| **GitHub Copilot** | `copilot_auth.rs` + `commands/copilot.rs`（221 行） | GitHub **device flow**（`GitHubDeviceCodeResponse`） | 2 |
| **Codex OAuth**（ChatGPT Plus/Pro） | `codex_oauth_auth.rs` + `commands/codex_oauth.rs`（91 行） | `https://auth.openai.com/oauth/token` | 2 |
| **xAI OAuth** | `xai_oauth_auth.rs` + `commands/xai_oauth.rs`（135 行） | `https://auth.x.ai/oauth` | 3 |

**Copilot 支持多账号**（`commands/copilot.rs` 注释：「支持多账号管理」，
有 `GitHubAccount` 类型与账号列表）。

**Codex OAuth 的性质要说清**：它是**用 ChatGPT 订阅额度反代 Codex 服务**
（`CHATGPT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex"`）。
这条路径走的是 ChatGPT 的内部 backend API，不是公开的 OpenAI API。
`§9.3` 那条「接管模式禁止切官方供应商」的白名单函数
`official_provider_supports_proxy_takeover` 正是为这类场景放行的。

> **这条链路的账号风险由使用者承担。** 它需要 CC Switch 携带
> 「官方客户端身份」访问 ChatGPT 的内部端点
> （`docs/guides/claude-codex-routing-guide-zh.md` 原文：
> 「方式二还会带上 OAuth token 与**官方客户端身份**访问 ChatGPT 的 Codex 服务」）。
> 本文不评估它是否违反 OpenAI 的服务条款，也未核验条款原文——
> 但「模拟官方客户端身份访问内部 API」这个行为模式本身，
> 与 §9.3 里应用自己警告的「使用代理访问官方 API 可能导致账号被封禁」是同一类风险。
> **应用在一处警告了这个风险，同时在另一处提供了触发它的功能。**

### 21.1 订阅额度查询

`services/subscription.rs`（1,379 行）读取**CLI 已有的 OAuth 凭据**查额度：

```
//! 读取 CLI 工具的已有 OAuth 凭据，查询官方订阅额度。
//! 第一层：仅读取凭据，不实现登录/刷新。
```

**「仅读取，不实现登录/刷新」是一条明确的边界**。查询函数：
`query_claude_quota` / `query_codex_quota` / `query_gemini_quota` / `query_grok_quota`
（后者在 `subscription_grok.rs`）。

`services/coding_plan.rs`（2,237 行）查国产 Token Plan：
**Kimi For Coding**（`api.kimi.com/coding/v1/usages`）、
**智谱 GLM**、**MiniMax**（`api.minimaxi.com` / `api.minimax.io`）。

`services/balance.rs`（454 行）查账户余额，按 base_url 识别 5 家：
`api.deepseek.com`、`api.stepfun.{ai,com}`、`api.siliconflow.{cn,com}`、
`openrouter.ai`、`api.novita.ai`。

**这三个服务的错误通道语义是统一约定的**（`balance.rs` 文件头）：

> - `Err(String)` = **瞬时**传输失败（网络不可达/超时/读体中断）。前端 invoke reject，
>   react-query 触发 retry 并保留上一次成功的 data（天然 keep-last-good）。
> - `Ok(success:false)` = **确定性**失败（空 key/未知供应商/鉴权/非 2xx/响应体非法 JSON），
>   立即透出错误文案。判定按 reqwest 错误种类在折叠点完成，**不依赖错误文案匹配**。

**「不依赖错误文案匹配」是关键**——按错误字符串判断故障类型是脆弱的
（文案会随库版本变化）。这里按 `reqwest` 的错误种类判定，
并且把「该重试」与「别重试」映射到两种不同的返回形态，让前端的
react-query 自然地做对事。**这是一处设计得很干净的错误分层。**

---

## 22. 用量脚本沙箱：内嵌 QuickJS

这是本项目最不寻常的一个设计：**为了查询「我在某个中转站还剩多少额度」，
它内嵌了一个 JavaScript 引擎。**

**为什么需要**：每家中转站的余额 API 都不一样（路径、鉴权方式、响应结构）。
硬编码 5 家（§21.1 的 `balance.rs`）能覆盖头部，但长尾覆盖不了。
解法是**让预设自带一段 JS**：构造请求 + 从响应里提取字段。

`usage_script.rs` 用 `rquickjs 0.8` 执行这段脚本。**脚本来源不可信**，
注释写得很直接：

> 用量脚本允许的最长执行时间（秒）。脚本来自不可信来源（**deeplink、同步导入**），
> 必须限制其 CPU / 内存 / 栈占用，防止一个恶意/ buggy 脚本挂死整个后端。

### 22.1 沙箱的四道限制

```rust
const USAGE_SCRIPT_TIMEOUT_SECS: u64 = 5;
const USAGE_SCRIPT_MEMORY_LIMIT_BYTES: usize = 16 * 1024 * 1024;   // 16 MiB
runtime.set_max_stack_size(256 * 1024);                             // 256 KiB
// + 时间片中断器：每轮解释器循环检查超时，超时抛不可捕获异常
```

注释点明「内存和栈限制必须在 eval 前设置」——这是 QuickJS 的 API 约束。
中断器基于 `Instant` deadline，**抛的是不可捕获异常**（脚本里 `try/catch` 挡不住）。

**Runtime 生命周期管理很讲究**：脚本分两段执行（先构造 request 配置，
拿到 HTTP 响应后再跑 extractor），每段都在**独立作用域**里创建和 drop Runtime：

```rust
// 3. 在独立作用域中提取 request 配置（确保 Runtime/Context 在 await 前释放）
...
}; // Runtime 和 Context 在这里被 drop
// 7. 在独立作用域中执行 extractor（确保 Runtime/Context 在函数结束前释放）
```

**目的是不让非 `Send` 的 QuickJS 句柄跨越 `await`**——
否则整个 async 函数会失去 `Send`，没法在 tokio 上跑。这是个正确且必要的处理。

### 22.2 SSRF 防护：两层校验

脚本能发 HTTP 请求，所以必须防它打内网。两个函数：

**`validate_base_url()`（`usage_script.rs:447`）**：
- 非空 + 可解析
- **强制 HTTPS**，例外是 loopback（`is_loopback_host`）
- 主机名非空

**`validate_request_url()`（`:502`）**：HTTPS 强制 + **同源检查**
（脚本不能把请求发到与 `base_url` 不同的源）。

**但这里有一个需要如实指出的缺口**：

```rust
fn should_validate_base_url(base_url: &str, is_custom_template: bool) -> bool {
    !base_url.is_empty() && !is_custom_template
}
```

**自定义模板模式（`is_custom_template == true`）会跳过 base_url 校验**，
`validate_request_url` 也接受 `is_custom_template` 参数走宽松路径。
注释解释了原因：「自定义模板模式下，用户可能不使用模板变量，
而是直接在脚本中写完整 URL」。

**这个取舍的实际后果**：用户手写的自定义脚本可以请求任意 URL（含内网地址、
非 HTTPS）。对「用户自己写的脚本」这是合理的（用户有权访问自己的内网服务）；
**但如果一个自定义模板脚本能经 deeplink 或云同步进入系统，
SSRF 防护就被绕过了**。本文未能核验 deeplink 导入的供应商能否携带
`is_custom_template` 标记 —— 这决定了它是「用户自主选择」还是「可被诱导的攻击面」。见 §26。

### 22.3 敏感信息不进脚本源码

```rust
// 1. 替换模板变量，避免泄露敏感信息
let script_with_vars = build_script_with_vars(script_code, api_key, base_url, access_token, user_id);
```

模板变量替换而非字符串拼接——**避免 Key 出现在错误信息或日志里的脚本源码中**。

前端对应的是 `UsageScriptModal.tsx`（**1,627 行**，前端第 7 大文件），
用 CodeMirror 的 JS 模式 + lint 提供编辑器。

---

## 23. 云同步：三种通道，一个必须知道的事实

### 23.1 三种同步方式

| 方式 | 实现 | 说明 |
|---|---|---|
| **自定义配置目录** | `app_store.rs` 的 `get_app_config_dir_override()` | 把 `~/.cc-switch/` 指到 Dropbox / OneDrive / iCloud / NAS 目录，借第三方客户端同步 |
| **WebDAV** | `services/webdav.rs` + `webdav_sync.rs`（335 行） | 自建 WebDAV 服务器 |
| **S3** | `services/s3.rs` + `s3_sync.rs`（319 行） | S3 兼容对象存储（`hmac` 做签名） |

后两种是 **v2 manifest 协议**，产物集固定为 **`db.sql` + `skills.zip`**。

**上传顺序有讲究**：

```rust
// Upload order: artifacts first, manifest last (best-effort consistency)
```

**先传产物、最后传清单**——这样清单存在就意味着产物齐全，
中断时不会留下「清单指向不存在的产物」的坏状态。下载侧有
`verify_artifact`（sha256）+ `validate_manifest_compat` + `validate_artifact_size_limit`。

**同步范围是精确划分的**：

```rust
const SYNC_SKIP_TABLES: &[&str] = &[
    "proxy_request_logs", "stream_check_logs", "provider_health", "proxy_live_backup", ...
];
const SYNC_PRESERVE_TABLES: &[&str] = &[
    "proxy_request_logs", "stream_check_logs", "proxy_live_backup", "usage_daily_rollups",
];
```

**用量明细与本机状态不上云**（体积大 + 设备相关），导入时本地数据会被保留而非被覆盖。
`provider_health` 的注释：「ephemeral tables that can safely rebuild at runtime」。

### 23.2 同步的数据里有明文 API Key

这一条本文认为必须明确写出来，因为**它没有被 README 或 SECURITY.md 披露**。

**事实链**（全部实测）：

1. `providers` 表的 `settings_config` 列存供应商配置，**其中包含 API Key**
   （非接管模式下 Key 就在这里；接管模式下 live 文件是占位符，
   真实 Key 仍在数据库，见 §9.2）
2. `providers` **不在** `SYNC_SKIP_TABLES` 也不在 `SYNC_PRESERVE_TABLES` 里
   → **它会被导出进 `db.sql` 并上传**
3. `db.sql` 是 **SQL 文本**（`export_sql_string_for_sync` → `dump_sql`），不是加密容器
4. **仓库里没有任何静态加密实现**：`grep -rn 'encrypt|aes|cipher'`
   在 `webdav*.rs` / `s3*.rs` 里 **0 命中**；`Cargo.toml` 里只有
   `rustls`（传输层 TLS）、`sha2`/`hmac`（完整性校验与 S3 签名），
   **没有 aes / chacha / age / argon 这类静态加密或密钥派生库**

**结论：云同步是「TLS 传输 + 明文存储」。** 你的全部 API Key 以明文
SQL 形式存在于 WebDAV 服务器 / S3 桶 / Dropbox 文件夹里。

**这不一定是缺陷**——对自建 WebDAV 或私有 S3 桶，
依赖存储侧的访问控制是常见且可接受的设计。而且要做端到端加密就得引入
密码管理与密钥派生，对桌面工具是不小的复杂度。

**但它需要被披露，而现在没有**：README 只写
「Sync provider data across devices via Dropbox, OneDrive, iCloud, or WebDAV servers」，
`SECURITY.md` 通篇不含 "encrypt" / "plaintext" 字样，
i18n 里也搜不到关于同步内容敏感性的提示文案（唯一命中「敏感」的是
`commonConfig.guidePurpose`，讲的是通用配置片段**不含**敏感信息，是另一回事）。

**给使用者的实际建议**：把同步目标当作「存放明文凭据的地方」来对待——
不要用共享的对象存储桶、不要同步到公司统一网盘的共享目录、
S3 桶务必关闭公共读。

### 23.3 SQL 导入的 authorizer：本仓库论证最完整的一处安全代码

同步的下行方向要执行远端来的 `db.sql`，所以**输入不可信**。
`database/backup.rs` 的 `import_authorizer()` 注释是本次调研见到的
论证最完整的一段，值得完整记录：

**威胁**：

> 头部校验（`validate_cc_switch_sql_export`）只比较一个注释前缀，任何人都能在
> 合法前缀后面接着写别的语句。`ATTACH DATABASE '/path/x.db'` 的副作用发生在
> `validate_basic_state` 之前，导入即使最终失败，文件也已经被创建；而 `settings`
> 表不在 `SYNC_SKIP_TABLES` / `SYNC_PRESERVE_TABLES` 之列，WebDAV/S3 同步会走
> 同一条 `import_sql_string_inner`，所以这条路径的输入不可信。

**为什么用 SQLite authorizer 而不是关键字扫描**：

> 字符串扫描会被 `/*x*/ATTACH`、大小写、换行绕过，还漏掉 `VACUUM INTO`。
> authorizer 在 prepare 阶段按**解析结果**回调，绕不过语法层。

**为什么是黑名单而不是白名单**（这段推理尤其清楚）：

> 这段 SQL 跑在 `NamedTempFile` 建的一次性库上，而那个库的全部内容本来就由
> 这份 SQL 决定。因此 `DELETE` / `DROP` / `UPDATE` 给不了攻击者任何新东西——
> **唯一有意义的边界是那个临时文件本身**。按 dump_sql 的产物做严格白名单只会
> 带来误伤风险（用户库里出现一种没预料到的对象就恢复不了备份），却不多挡任何攻击。

**越界动作是实测的**：

> - `ATTACH DATABASE 'x'`、`VACUUM INTO 'x'`、裸 `VACUUM` **三者都**报
>   `AuthAction::Attach`，所以拒 `Attach` 一条即可覆盖
> - 文件后端的虚拟表模块（`csvfile`、`zipfile` 等）能读写任意路径 → 拒 vtable
> - `Unknown` 是 rusqlite 对未识别动作码的兜底 → 未知即拒，将来 SQLite 新增的
>   跨文件语句会默认落进这里，**不依赖有人记得回来补名单**

拒绝时还记日志，理由是「SQLite 只会回一句 "not authorized"，
不记日志就无从知道是哪条语句被拦」。

**这段代码把「威胁 → 为什么这个方案 → 为什么不是另一个方案 → 证据来源 →
未来如何默认安全」全写清了。** 它和 §18.3 的解压加固是同一水准，
也说明这个项目在**外部输入的入口处**是认真的。

### 23.4 自动同步触发

§7.4 说过用 SQLite `update_hook` 通知。对应
`services/webdav_auto_sync.rs` 与 `s3_auto_sync.rs` 的 `notify_db_changed(table)`。
前端 `WebdavSyncSection.tsx` 是前端第 4 大文件（**1,867 行**）。

---

## 24. 桌面集成与平台差异

### 24.1 窗口与托盘

`tauri.conf.json`：

```json
{ "label": "main", "title": "", "titleBarStyle": "Overlay",
  "width": 1000, "height": 650, "minWidth": 900, "minHeight": 600,
  "visible": false, "center": true }
```

**`visible: false`** 配合 `silent_startup` 设置——支持「开机静默启动到托盘」。
`title` 为空 + `Overlay` 标题栏是 macOS 的沉浸式外观。

**托盘**（`tray.rs`）是核心交互面之一：README 的
「System Tray Quick Switch — Switch providers instantly from the tray menu」。
故障转移成功后会更新托盘菜单（§14.3）。

**`minimumSystemVersion: "12.0"`**（macOS Monterey 及以上）。

### 24.2 i18n：4 个语言，2,654 个 key

| locale | key 数 |
|---|---:|
| `en.json` | 2,654 |
| `zh.json` | 2,654 |
| `ja.json` | 2,654 |
| **`zh-TW.json`** | **2,655** |

**zh-TW 多一个 key**，脚本比对差集：

```
tw - en: ['settings.oneClickInstall']
en - tw: []
```

**`settings.oneClickInstall` 只存在于 zh-TW**——一个多余的孤儿 key（大概是
删除某功能时漏删，或从别处复制过来）。**不影响功能**（i18next 找不到 key 会回退），
但说明没有 CI 校验 locale 一致性。zh / ja / en 三者 key 集完全相同。

### 24.3 环境变量冲突检测

`services/env_checker.rs` 解决一个高频支持问题：**用户 shell 里有
`ANTHROPIC_API_KEY` 时，CLI 会优先用环境变量而忽略配置文件**，
表现为「我在 CC Switch 里切了供应商但没生效」。

检测两个来源：

- **系统环境变量**（Windows 走 `winreg` 读注册表）
- **shell 配置文件**（Unix only：`check_shell_configs`）

关键字支持精确与前缀两种匹配：

```rust
enum EnvKeyword { Exact(&'static str), Prefix(&'static str) }
```

覆盖的变量（实查）：`ANTHROPIC*`、`OPENAI*`、`GEMINI*`、`GOOGLE_GEMINI*`、
`XAI_API_KEY`(+`_BACKUP`)、`GROK_HOME`、`GROK_BIN_DIR`、`GROK_DEFAULT_MODEL`(+`_BACKUP`)。

**这是把「最常见的支持工单」做成了产品功能**——比在 FAQ 里写一段说明有效得多。

### 24.4 平台构建矩阵

`.github/workflows/`（6 个）：`ci.yml`（PR 触发）、`release.yml`（push 触发）、
`claude.yml`、`labeler.yml`、`stale.yml`（定时关闭陈旧 issue）、
`sync-r2.yml`（手动，同步 release 到 R2）。

`release.yml` 的产物矩阵（实查）：

| 平台 | target / 产物 |
|---|---|
| macOS | `universal-apple-darwin`（失败时回退 `aarch64` / `x86_64` 分别构建） |
| Windows x64 | 默认 target，MSI + exe |
| Windows ARM64 | `aarch64-pc-windows-msvc --bundles msi` |
| Linux | AppImage + deb + **rpm** |

另有 `flatpak/` 目录（Flatpak 打包）与 `wix/per-user-main.wxs`
（**per-user 安装**的 MSI 模板，不需要管理员权限）。

**自动更新**（`tauri.conf.json` 的 `updater`）：

```json
"endpoints": [
  "https://dl.ccswitch.io/latest.json",
  "https://github.com/farion1231/cc-switch/releases/latest/download/latest.json"
]
```

**双端点**：自有 CDN 优先，GitHub Releases 兜底。带 minisign 公钥
（`createUpdaterArtifacts: true`）——**更新包有签名校验**，这是必要的：
自动更新通道如果不验签，等于给了 CDN 或中间人一个 RCE。

### 24.5 Windows 的历史遗留处理

`config.rs:203` 的 `get_app_config_dir()` 里有一段 Windows 专属兼容：

```rust
// 兼容 v3.10.3：当用户环境存在 `HOME` 且与真实用户目录不同，
// v3.10.3 可能在 `HOME/.cc-switch/` 下创建/使用了数据库。
// 这里仅在"默认位置没有数据库"时回退到旧位置，避免再次出现"供应商消失"问题，
// 同时也避免新安装因为 `HOME` 被设置而写入非预期路径。
```

**「避免再次出现供应商消失问题」——这是一个真实事故的修复记录。**
条件写得很精确：只在默认位置**没有**数据库时才回退，
所以新安装不会因为设了 `HOME` 就跑到奇怪的位置。

### 24.6 Profiles：项目级配置切换

`profiles` 表 + `commands/profile.rs` + `services/profile.rs`。
`show_profile_switcher` 默认为 true（`default_show_profile_switcher`），
在主界面顶部显示切换器。前端 `src/components/profiles/`。

### 24.7 Workspace：OpenClaw 的文件白名单

`commands/workspace.rs` 管理 OpenClaw 的工作区文件，**用白名单而不是路径校验**：

```rust
const ALLOWED_FILES: &[&str] = &[
    "AGENTS.md", "SOUL.md", "USER.md", "IDENTITY.md",
    "TOOLS.md", "MEMORY.md", "HEARTBEAT.md", "BOOTSTRAP.md", "BOOT.md",
];
fn validate_filename(filename: &str) -> Result<(), String> {
    if !ALLOWED_FILES.contains(&filename) { return Err(...) }
```

**枚举白名单是这里最稳的做法**——比任何 `../` 过滤都可靠，
因为可写文件名是有限且已知的。注释也写明了 `(whitelist for security)`。

---

## 25. 商业模式与利益披露

这一章不讨论代码，但对**判断这个工具的建议是否中立**是必需的。

### 25.1 赞助商规模

README 里有 **27 处 "Thanks to ... for sponsoring"**（`grep -c`），
即 27 家赞助商，每家一段推广文案 + 带追踪参数的注册链接。
部分节选（前 10 家，按 README 顺序）：
PackyCode、ZetaAPI、APINEBULA、AICodeMirror、PatewayAI、RunAPI、
Shengsuanyun、AIGoCode、AICoding、SubRouter。

**README 里带追踪参数的链接有 36 处**
（`aff=` / `invitecode=` / `track_id=` / `/go/u` 四类参数）。

推广文案的风格值得一看（ZetaAPI 那段原文节选）：

> pricing as low as **35% of official rates** … If any model is verified to be
> inconsistent with its stated quality, ZetaAPI backs it with a **10x compensation
> guarantee** … use the promo code **CC-SWITCH** during your first recharge

**这是标准的联盟营销文案，写在项目 README 的第 21 行**（`## ❤️Sponsor` 一节），
位置在「Why CC Switch?」（第 198 行）之前——**赞助商区块出现在产品介绍之前**。

### 25.2 预设里的联盟链接

不止 README。预设文件里的 `websiteUrl` / `apiKeyUrl` 也带追踪参数：

| 预设文件 | URL 总数 | 带追踪参数 |
|---|---:|---:|
| `codexProviderPresets.ts` | 129 | 23 |
| `opencodeProviderPresets.ts` | 116 | 22 |
| `claudeProviderPresets.ts` | 131 | 21 |
| `claudeDesktopProviderPresets.ts` | 127 | 21 |
| `openclawProviderPresets.ts` | 118 | 21 |
| `hermesProviderPresets.ts` | 116 | 19 |
| `grokBuildProviderPresets.ts` | 73 | 18 |
| `geminiProviderPresets.ts` | 42 | 7 |
| **合计** | **952** | **152** |

**448 条预设里有 249 条带 `isPartner: true`**（约 56%），
其中 **12 条 `primePartner`**（源码注释：「置顶合作伙伴（顶级）：徽章显示为心形」）。

### 25.3 披露情况：做得比多数同类好

**关键问题不是「有没有联盟关系」，而是「用户看不看得见」。** 实查结论：

**披露到位的地方**：

- `ProviderCard.tsx:440` 会读 `provider.meta?.isPartner` 渲染徽章
- i18n 里有对应文案（`官方合作伙伴` / partner promotion 相关 key）
- `primePartner` 显示为**心形徽章**，与普通 partner 徽章视觉可区分
- 预设选择器把合作伙伴文案（`partnerPromotionKey`）展示在表单里
- README 的赞助商区块标题就是 `## ❤️Sponsor`，没有伪装成「推荐」

**需要用户自己注意的地方**：

- **默认排序有商业倾向**（§5.6）：`official → primePartner → partner → rest`，
  只有非合作伙伴那一组按字母排序。默认视图下付费方排在前面。
- 切到字母序需要**手动操作**（`useState` 初值是 `PresetSortMode.Original`）。
- 源码注释坦白了排序与商业的绑定：
  「赞助商的文件顺序**与 README 赞助商表对齐**」。

**本文的判断**：这是一个**明示的**联盟营销模式，不是隐藏的。
徽章披露 + 注释直白 + 赞助区块独立成节，
在同类工具里属于披露较充分的一档。

**但使用者应当据此调整预期**：这个工具的**预设列表不是中立的供应商目录**，
它的默认排序反映商业关系。**「排在前面」不代表「更好」或「更便宜」，
只代表付了赞助费。** 选供应商时用它的测速（§14.4）、
余额查询（§21.1）、用量统计（§15）这些**客观数据**去判断，
而不是用默认顺序。

**这不影响代码质量的评价**——§18.3、§23.3 那种水准的安全代码
和联盟营销可以并存，两者是独立的事实。

---

## 26. 版本时间线与发版节奏

### 26.1 发版节奏

**38 个版本条目**（CHANGELOG，`3.0.0` 起）+ GitHub Releases 一页 50 个
（最老到 `v2.0.3` / 2025-08-22）。

**按月分布**（GitHub Releases 实查，最近一页 50 个）：

| 月份 | 发版数 | | 月份 | 发版数 |
|---|---:|---|---|---:|
| 2025-08 | 2 | | 2026-02 | 2 |
| 2025-09 | 6 | | 2026-03 | 4 |
| 2025-10 | 3 | | 2026-04 | 3 |
| 2025-11 | 6 | | 2026-05 | 2 |
| 2025-12 | 6 | | 2026-06 | 4 |
| 2026-01 | 6 | | 2026-07 | 5 |
| | | | 2026-08 | 1 |

**一年 50 个版本，节奏稳定在每月 2–6 个**。这比 opencode
（12 天 10 个版本）慢得多，但对桌面应用是健康的——
它有自动更新通道（§24.4），发版太频繁会打扰用户。

### 26.2 最近版本

| 版本 | 日期 |
|---|---|
| **v3.19.2** | 2026-08-06（本快照） |
| v3.19.1 | 2026-07-31 |
| v3.19.0 | 2026-07-30 |
| v3.18.0 | 2026-07-21 |
| v3.17.0 | 2026-07-13 |
| v3.16.5 | 2026-07-01 |

**CHANGELOG 的小节分类很规范**：
`Added` / `Changed` / `Fixed` / `Security` / `Performance` / `Docs` / `Internal`
/ `Upgrade notes`。**带独立的 `Security` 与 `Upgrade notes` 小节**——
后者对有自动更新的应用是必要的。

### 26.3 几个能定位功能引入时间的版本

从 CHANGELOG 与源码注释交叉出来的（**部分是从注释里的版本标记推的**，
不是逐版本读 changelog 得出，可靠性低于本文其它事实）：

| 版本 | 日期 | 标记 |
|---|---|---|
| **3.0.0** | 2025-08-27 | Electron → Tauri 2.0 重写（§2） |
| 3.7.0 | 2025-11-19 | MCP 统一结构（`services/mcp.rs` 注释「v3.7.0 统一结构」） |
| **3.10.0** | 2026-01-21 | Skills 统一管理架构 / SSOT（`services/skill.rs` 注释「v3.10.0+」） |
| 3.10.3 | 2026-01-30 | 后被 Windows 兼容代码专门处理的问题版本（§24.5） |
| 3.17.0 | 2026-07-13 | gpt-5.6 预设 + 客户端身份修复（routing guide 标的版本下界） |

### 26.4 文档规模

`docs/` 下 **235 个文件**：

| 目录 | 文件数 | 说明 |
|---|---:|---|
| `release-notes/` | 80 | 按版本 × 语言（en/zh/ja） |
| `user-manual/` | 106 | **三语 × 5 章**（getting-started / providers / extensions / proxy / faq）+ 40 个截图 |
| `guides/` | 22 | 7 个专题 × 三语（含跨协议路由、Codex 官方认证保留等） |
| `images/` | 14 | guide 配图 |

**用户手册是三语完整对齐的**（en/ja/zh 各 25 个章节文件），
这个投入在开源桌面工具里不常见。

### 26.5 安全政策的成熟度

`SECURITY.md`（13,199 字节，中英对照）值得单独评价，因为它的**范围划定质量
高于绝大多数同规模开源项目**：

- **威胁模型明确**：本地桌面应用、无云后端、无多用户模型、**代理监听面在范围内**
- **渲染进程被划为可信**，但注释强调这是「**范围划定决策，由下列事实支撑，
  而非从中必然推出**」，并列出 3 条可核验的事实 +
  **失效条件**（`Invalidation triggers`）——一旦任一事实不成立，决策必须重评
- **`In scope` 的判据是数据路径**，不是 sink：

  > The data path matters more than the sink. We assess severity by
  > **who controls the input**, not by which API the value eventually reaches.

- **`Out of scope` 写了反向例外**，堵住了最常见的推诿：

  > Having the same filesystem permissions as the user does not make it the
  > user's decision — that is a **confused-deputy attack** and is **in scope**.

  以及针对 §20 我提出的疑问，它直接给了答案：

  > Not excluded: the same integrations when they **arrive through import or a
  > deep link**. There the required security property is *informed consent*, and
  > the following are **in scope**: the command, arguments, environment or script
  > body being **hidden, truncated or misrepresented in the confirmation UI**

  **「确认 UI 里截断展示命令」被明确列为在范围内的漏洞。**
  这正是 §20 我担心的那点——政策已经覆盖了它（本文仍未核验实现是否达标，见文末未验证块）。

- **响应时限量化**：确认 48h / 初评 7d / 关键问题修复 14d
- **CVE 部分不越权**：明确「是否符合 GitHub 的 CVE 资格由 GitHub 作为 CNA 决定，
  不由本项目决定」

**我针对 v3.18.0 的三条可自检事实做了复核**（政策自称已核实至 v3.18.0，
我在 v3.19.2 快照上复核）：

| 声明 | 实测 | 结论 |
|---|---|---|
| 不加载远端可执行内容 | `<iframe` / `<webview` 在 `src/` **0 命中** | ✅ |
| 无 `eval` / `new Function` | `src/` 下 **0 命中**（含测试） | ✅ |
| 无危险 HTML 注入 | `dangerouslySetInnerHTML` **仅 1 处**（`ProviderIcon.tsx:79`） | ✅ 见下 |

那唯一一处 `dangerouslySetInnerHTML` 的输入来自
`@/icons/extracted` 的 `getIcon(icon)`——**编译期打进包里的图标表**，
且前置 `hasIcon(icon)` 检查，`icon` 只作为查表键使用，**不是用户内容直接注入**。
CSP 侧 `script-src 'self'`（`tauri.conf.json`）。**这三条自检声明成立。**

---

## 参考资料

**一手来源（本文事实层的主要依据）：**

- **源码**：`github.com/farion1231/cc-switch`，`main` 分支 commit `413c09e0`
  （本地完整仓库，MIT）。所有计数、常量、注释引用均出自此快照。
- 仓库内文档：`README.md`、`CHANGELOG.md`（406KB）、`SECURITY.md`、
  `CONTRIBUTING.md`、`docs/user-manual/`（三语 × 5 章）、`docs/guides/`（7 专题 × 三语）
- 构建配置：`src-tauri/Cargo.toml`、`src-tauri/tauri.conf.json`、`package.json`、
  `.github/workflows/`
- GitHub REST API 实查：`/repos/farion1231/cc-switch`（Star / fork / issues /
  `subscribers_count` / license / topics）、`/languages`、`/releases?per_page=100`、`/tags`
- `git log` / `git shortlog` / `git describe`（提交数、贡献者分布、Electron→Tauri 时间线）

**官方渠道：**

- 官网：[ccswitch.io](https://ccswitch.io)（README 声明为唯一官网）
- 更新端点：`https://dl.ccswitch.io/latest.json`、GitHub Releases 的 `latest.json`

**第三方依赖（本文提及但未核验其运营方）：**

- `skills.sh/api/search`（Skills 搜索，§18.4）
- models.dev（模型定价同步，§15.4）

**同系列：**

- [Claude Code 深入研究（2026-08 快照）](./ref-claude-code.md)
- [OpenAI Codex 深入研究（2026-08 快照）](./ref-codex.md)
- [opencode 深入研究（2026-08 快照）](./ref-opencode.md)
- [Reasonix 深入研究（2026-08 快照）](./ref-reasonix.md)

---

::: tip 本文没有验证的部分（照实列出）
这一篇能读到完整源码，所以「有几个」这类计数是可靠的（开篇给了方法）。
但**读代码不等于跑过它**，以下几处是本文明确**未能核验**的：

**性能与用量数字（全部是官方口径或代码注释里的实测值，我们没复现）**：

- v3.0.0 声称的「**bundle 体积减少 90%**（150MB → 15MB）」与「启动性能显著提升」（§2）
- `database/backup.rs` 注释里的「**2.6 万行实测 119 秒**」（§15.5）
- GitHub Releases 一页 50 个版本的资产下载量合计 **1,558 万次**——
  这是 API 的 `download_count` 累加值，**不是独立用户数**，
  且只覆盖最近 50 个 release，本文正文因此未引用它做任何推论
- 各中转站的价格、额度、「35% of official rates」这类赞助商口径（§25.1）

**没跑起来 / 没编译的部分**：

- **本文没有构建过这个项目，也没跑过它的测试套件。**
  §3.4 的「2,401 个 Rust 测试函数 / 92 个前端测试文件」是**静态计数**，
  不代表它们当前全部通过。`test-hooks` feature 下的测试更没跑过。
- 代理层的实际行为（协议转换是否真的等价、SSE 转换在边界情况下是否丢事件、
  熔断器在真实故障下的表现）——**全部只读了代码，没有实测**
- §10.2 声称的「wire 层 header 大小写与直连一致」，没有抓包验证
- 8 个工具的切换是否真的都生效（尤其 Additive 模式的三个）

**代码里没读透的部分**：

- **§22.2 的 SSRF 缺口边界**：`is_custom_template == true` 会跳过 base_url 校验，
  但**一个经 deeplink / 云同步导入的供应商能否携带该标记**，本文未追到定论。
  这决定了它是「用户自主选择」还是「可被诱导的攻击面」——**这是本文最重要的一处未验证项**。
- **§20 的 deeplink 确认 UI 是否完整展示 MCP `command`**：
  `SECURITY.md` 已把「确认 UI 里截断/隐藏/歪曲展示命令」明确列为在范围内的漏洞（§26.5），
  但 `DeepLinkImportDialog.tsx`（779 行）的实现是否达标，本文未逐行核验
- §16.2 引用的 `services/provider/mod.rs:95` 那条注释在本次读取范围内被截断，
  未取得完整语义，本文因此没有解释它
- README 声称的「Skill Backups 保留 20 份」未定位到对应常量（§8）；
  数据库备份的 `MAX_BACKUPS: usize = 10` 已核实
- `grok_config.rs` 的实际配置路径没读（§6 表格里该行留空）
- `claude_plugin.rs`（Claude 插件联动）、`auto_launch.rs`、`tray.rs` 只看了文件头
- 16 个迁移 arm 的**具体内容**没逐个读，只确认了数量与边界防护

**外部事实**：

- **`skills.sh` 与 models.dev 的运营方、数据处理方式、可用性**（§18.4、§15.4）
- README 强调「唯一官网」暗示的**仿冒站点**是否存在、有多少（§1）
- §13.4 的 Copilot 优化器、§21 的 Codex OAuth 反代**是否违反相应服务条款**——
  本文未核验 GitHub Copilot 与 OpenAI 的条款原文，不做判断
- 27 家赞助商的真实服务质量（§25.1）

**判断性内容的性质**：§18.3、§23.3 我称之为「质量高」，
§25.3 的披露评价、§23.2 的「需要披露而现在没有」，
都是**本文基于代码与文档做的评价，不是事实陈述**。
它们可以被合理反驳，尤其是威胁模型判断这类事情本身存在专业分歧。

一句话：**本文的计数与代码引用可靠，行为与性能类结论请自己实测。**
:::
