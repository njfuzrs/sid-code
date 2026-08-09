---
title: Gemini CLI 深入研究（2026-08 快照）
description: 20 章逐节成册，按目录跳章查阅——把 Gemini CLI 的产品形态、架构与实现细节交叉核验到版本号级别：7 包 monorepo、5 层策略优先级、11 类 Hook 事件、5 种沙箱后端（含 567 行 C# 原生实现）、27 个内置工具名、4 个内置子代理、Conseca 上下文感知安全层。这是一份手册，不是读完就走的文章。
date: "2026-08-09"
series: 热点开源项目研究
audience: engineer
highlight: 20 章逐节可查 · 核验至 v0.54.4 / nightly 0.56.0 · 截至 2026-08-09 快照
tags: [Gemini CLI, Google, 深入研究, 权限, 沙箱, Hook, MCP, 参考]
outline: [2, 3]
---

# Gemini CLI 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-09
- **被调研版本**：
  - npm `@google/gemini-cli` **latest = 0.54.4**（2026-08-07 发布）
  - **preview = 0.55.0-preview.2**、**nightly = 0.56.0-nightly.20260808.gcf22ac7e8**
  - 源码核验至本地 clone 的 `main`，HEAD = commit `cf22ac7e`（2026-08-07），
    仓库内 `package.json` 版本号为 `0.56.0-nightly.20260806.g761f604c1`
- **证据形态**：**本地源码实查 + 仓库内文档源文件 + GitHub REST API / npm registry 实查**。
  代码结构类断言直接来自本地 clone 的源码，凡属源码结论本文都给出 `包/路径:行号`；
  文档类事实取自仓库内 `docs/**/*.md` **源文件**，不是渲染后的网页。
  因此文中有若干处是「官方文档这么写，源码实际这样」的对照（§3.3、§6.2、§7.5、§13.2）。
  **行为类断言以源码与文档为据——我们没有把它跑起来做端到端实测。**
  唯一的例外是 §6.2 与 §7.5 两处：那是把源码用 esbuild 单独打包出来跑函数、
  以及用脚本按源码常量重算优先级公式，两处都给了可复现的命令。
  每一章都尽量把这个区别标清了，§19 汇总了所有未核验项。
- **一手性说明**：计数类事实全部由脚本从源码 / 原始表格 `re.findall` 数出，不是目测；
  Star 数 / 语言占比 / 版本时间线取自 GitHub REST API 与 npm registry 实查
  （原始 JSON 落盘到 `/tmp/gemini/` 后只打印摘要，从不整份进上下文）。
- **⚠ 一条必须先声明的证据边界**：本地这份 clone 是 **shallow**（`git rev-parse
  --is-shallow-repository` 返回 `true`，`.git/shallow` 存在），
  `git log` 只有 974 个提交、最早停在 2026-03-19。
  **因此本文任何「首次引入 / 何时改动」的时间断言都不以 git 历史为据**，
  一律走 npm registry 的版本时间线与仓库内 changelog。
  §17 的版本表就是这么来的。
- **时效边界**：这个项目发版极快——npm 上 **698 个版本**，2025-06-25 首发，
  到 2026-08-08 为止 14 个月里月均约 50 个版本（含 nightly / preview 通道）。
  **这是 2026-08-09 的快照，不是最新状态。** 任何与当前行为不一致的地方，
  以[官方文档](https://geminicli.com)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 四条容易搞错的事（前两条会让你配错权限）
1. **官方文档里那张策略优先级的示例表，四行里有三行是错的。**
   `docs/reference/policy-engine.md:163-166` 写「Workspace 的 `priority: 10` 变成 `2.010`、
   User 的 `priority: 100` 变成 `3.100`、Admin 的 `priority: 20` 变成 `4.020`」。
   而源码里的 tier 基数是 Default 1 / **Extension 2** / Workspace 3 / User 4 / Admin 5
   （`packages/core/src/policy/config.ts:67-71`），按文档自己给的公式
   `tier + priority/1000` 算，实际应为 `3.010` / `4.100` / `5.020`。
   **文档那三行整体少了 1**——看起来是 Extension 这一层插进来之后忘了改示例
   （同一份文档上方的 tier 表格已经列了 Extension=2，是对的；
   而正文第 137 行还写着「organized into **three** tiers」，实际是五层）。
   照着示例去算「我这条规则能不能盖住那条」会得出错误结论。实测复算见 §7.5。
2. **项目级（Workspace）策略目录整层是死的，而且不是「有 bug」，是被一个硬编码常量关掉的。**
   `packages/cli/src/config/policy.ts:42` 写着 `export let disableWorkspacePolicies = true;`，
   注释自称 "Temporary flag"。全仓库调用它的 setter 只出现在**测试文件**里
   （`policy.test.ts`、`workspace-policy-cli.test.ts`），
   **没有任何 settings 键、CLI 参数或环境变量能改它**（`settingsSchema.ts` 里搜不到这个名字）。
   于是 `resolveWorkspacePolicyState()` 第 108 行的 `if (trustedFolder &&
   !disableWorkspacePolicies)` 恒为 false，`.gemini/policies/*.toml` 一个字节都不会被读。
   官方文档诚实地标了这件事（"currently non-functional"，指向 issue #18186），
   但**没说它无法通过配置打开**——这是差别所在。见 §7.6。
3. **到处流传的那张「Gemini CLI 由 3 个组件构成」架构图，其对应的官方文档页已经不存在了。**
   `docs/architecture` 那一页在当前仓库里**已被删除**（`find` 全仓无 `architecture*` 文件），
   但它仍被大量镜像站与二手分析当作现状引用，内容停留在
   「packages/cli + packages/core + packages/core/src/tools/」三块。
   实际是 **7 个 workspace 包**，且 `packages/cli` 里有 **401 个 UI 文件 / 83,762 行**——
   UI 层本身就比那张图里的「整个 CLI 包」复杂一个量级。见 §2。
4. **`invoke_agent` 这个工具在官方工具参考表里查不到。** 源码的
   `ALL_BUILTIN_TOOL_NAMES` 有 27 项，而 `docs/reference/tools.md` 的表格里只有 26 个，
   差的那个正是子代理的统一入口 `invoke_agent`
   （`packages/core/src/tools/tool-names.ts:192`）。它只在
   `docs/reference/policy-engine.md:464` 被顺带提了一句。
   更反过来的一组是：`list_background_processes` 与 `read_background_output`
   **在注册表里活着但两处名单都没有**，导致它们连自家的名字合法性校验都过不了。见 §6.2。

前几篇 ref 的教训是「引用二手分析要付代价」。这一篇的教训更钻一层：
**一份写得相当细致的官方文档，照样会在最需要精确的地方（优先级算术、工具清单）失准**——
文档是人写的，常量是代码里的。
:::

---

## 1. 产品概述与身份辨析

### 1.1 一句话定位

Gemini CLI 是 Google 官方的开源终端 AI agent，仓库自述为
"An open-source AI agent that brings the power of Gemini directly into your terminal."
（GitHub repo `description` 字段实查）。许可 **Apache-2.0**，主仓
[`google-gemini/gemini-cli`](https://github.com/google-gemini/gemini-cli)，
官网 `https://geminicli.com`。

### 1.2 包名与安装入口

| 项 | 值 | 来源 |
| --- | --- | --- |
| npm 包名 | `@google/gemini-cli` | npm registry 实查 |
| 可执行名 | `gemini` | `package.json` 的 `bin` |
| 入口文件 | `bundle/gemini.js` | 同上 |
| Node 要求 | `>=20`（仓库内根 `package.json` 写 `>=20.0.0`） | 两处实查 |
| latest | **0.54.4**（2026-08-07） | `dist-tags.latest` |
| preview | **0.55.0-preview.2**（2026-08-07） | `dist-tags.preview` |
| nightly | **0.56.0-nightly.20260808.gcf22ac7e8** | `dist-tags.nightly` |

**三条并行的发布通道**（latest / preview / nightly）是这个项目最显著的工程特征之一，
详见 §17。

### 1.3 仓库规模（GitHub REST API 实查，2026-08-09）

| 指标 | 值 |
| --- | --- |
| Stars | **106,423** |
| Forks | **14,405** |
| Open issues | **864** |
| Watchers | 577 |
| 仓库创建 | **2025-04-17** |
| 最后 push | 2026-08-08 |
| 默认分支 | `main` |
| topics | `ai`、`ai-agents`、`cli`、`gemini`、`gemini-api`、`mcp-client`、`mcp-server` |

语言占比（`/languages` 端点，字节数）：

| 语言 | 字节 | 占比 |
| --- | --- | --- |
| TypeScript | 20,324,278 | **96.91%** |
| JavaScript | 356,649 | 1.70% |
| Python | 221,907 | 1.06% |
| Shell | 31,159 | 0.15% |
| **C#** | 24,798 | **0.12%** |
| Dockerfile | 6,489 | 0.03% |
| HTML | 5,474 | 0.03% |
| Makefile | 1,336 | 0.01% |

那 0.12% 的 C# 不是杂项脚本，**是 Windows 沙箱的实现本体**
（`packages/core/src/sandbox/windows/GeminiSandbox.cs`，567 行，用 Restricted Token +
Job Object 做隔离）。见 §8.4。

### 1.4 `open_issues_count` 的读法

864 这个数字要注意口径：GitHub 的 `open_issues_count` **把 open PR 也算进去**。
本文不据此推断「积压了 864 个 bug」，只当作「活跃度量级」。

---

## 2. 仓库结构：7 包 monorepo

`package.json` 的 `workspaces` 是 `["packages/*"]`，实际有 7 个包。
下表的行数由脚本统计（`find … -name '*.ts' -o -name '*.tsx'`，**排除** `.test.` /
`.spec.` 文件），不是目测：

| 包 | npm 名 | 非测试文件 | 非测试行数 | 测试文件 | private |
| --- | --- | --- | --- | --- | --- |
| `cli` | `@google/gemini-cli` | 562 | **120,355** | 463 | — |
| `core` | `@google/gemini-cli-core` | 472 | **131,615** | 408 | — |
| `a2a-server` | `@google/gemini-cli-a2a-server` | 21 | 5,160 | 15 | — |
| `test-utils` | `@google/gemini-cli-test-utils` | 10 | 3,192 | 0 | **是** |
| `vscode-ide-companion` | `gemini-cli-vscode-ide-companion` | 5 | 1,177 | 3 | — |
| `sdk` | `@google/gemini-cli-sdk` | 8 | 1,078 | 5 | — |
| `devtools` | `@google/gemini-cli-devtools` | 3 | 442 | 0 | — |

非测试代码合计约 **26.3 万行**，测试文件全仓 **894 个**
（`find packages -name '*.test.ts' -o -name '*.test.tsx'`）。
另有独立的 `integration-tests/` 目录 **114 个条目**（含 `.responses` 录制文件）。

**注意 `vscode-ide-companion` 的包名没有 `@google/` 前缀**——它是 VS Code
扩展市场的发布物，命名规则不同。

### 2.1 `packages/core` 的子系统分布

按目录统计（脚本数，排除测试）：

| 目录 | 文件 | 行数 | 职责 |
| --- | --- | --- | --- |
| `tools/` | 48 | **20,368** | 工具实现与注册表（§6） |
| `utils/` | 101 | 18,481 | 通用工具函数（含 shell 解析、路径校验） |
| `telemetry/` | 30 | 12,547 | OTel 埋点（§16） |
| `agents/` | 39 | 12,410 | 子代理与 A2A（§10） |
| `services/` | 26 | 10,810 | 会话录制、沙箱管理、循环检测等 |
| `context/` | 49 | 8,519 | 上下文管线（§11） |
| `config/` | 14 | 7,303 | 配置与存储路径（§12） |
| `core/` | 17 | 6,523 | 主循环、Chat、ContentGenerator（§4） |
| `policy/` | 9 | **3,716** | 策略引擎（§7） |
| `hooks/` | 10 | 3,785 | Hook 系统（§9） |
| `sandbox/` | 14 | 3,188 | 5 种沙箱后端（§8） |
| `code_assist/` | 14 | 3,598 | Code Assist API 接入 |
| `scheduler/` | 8 | 3,115 | 工具调度与确认 |
| `mcp/` | 13 | 2,336 | MCP OAuth / 凭据（§14） |
| `prompts/` | 6 | 2,315 | 提示词与注册表 |
| `agent/` | 7 | 2,082 | agent 运行时 |
| `ide/` | 8 | 2,056 | IDE 检测与连接（§15） |
| `safety/` | 9 | 1,387 | Conseca 与安全检查器（§7.7） |
| `routing/` | 10 | 1,317 | 模型路由（§5.3） |
| `voice/` | 7 | 858 | 语音输入（Whisper / Gemini Live） |
| `availability/` | 6 | 807 | 可用性探测 |
| `confirmation-bus/` | 3 | 501 | 确认消息总线 |
| `skills/` | 2 | 405 | Skills 加载（§13.3） |
| `billing/` | 2 | 195 | 计费事件 |

### 2.2 `packages/cli` 的分布

| 目录 | 文件 | 行数 |
| --- | --- | --- |
| `ui/` | **401** | **83,762** |
| `config/` | 25 | 11,286 |
| `utils/` | 45 | 8,988 |
| `commands/` | 35 | 4,658 |
| `acp/` | 16 | 3,799 |
| `services/` | 14 | 2,125 |

**UI 层占了 CLI 包的 70%**（83,762 / 120,355）。这是那张流传的三组件架构图
（文首 danger 块第 3 条）最失真的地方：它把整个 `packages/cli` 概括为
「输入处理 / 历史管理 / 显示渲染 / 主题」四个要点。

### 2.3 渲染底座

`packages/cli/package.json` 的依赖里写着：

```
"ink": "npm:@jrichman/ink@6.6.9",
"react": "19.2.4",
```

即 **ink 被 alias 到 `@jrichman/ink` 这个 fork**，而非上游 `ink`。
配套还有 `ink-gradient` 3.0.0、`ink-spinner` 5.0.0。
主题实现只有 3 个内置目录/文件（`packages/cli/src/ui/themes/builtin/`：
`dark`、`light`、`no-color.ts`），语义色走 `semantic-tokens.ts`。

---

## 3. 分发形态：120MB、零依赖、自带 5 份 ripgrep

### 3.1 发布包的三个数字

npm registry 对 `0.54.4` 的 `dist` 字段实查：

| 项 | 值 |
| --- | --- |
| `unpackedSize` | **120,810,924 字节（约 120.8 MB）** |
| `fileCount` | **464** |
| `dependencies` | **0** |

**零运行时依赖 + 120MB**，意味着它是完全 bundle 的产物：
所有依赖被打进 `bundle/`（本地构建产物实测 **30MB / 38 个文件**）。
仓库内根 `package.json` 的 `bin` 直接指向 `bundle/gemini.js`。

### 3.2 体积从哪里来：vendor 进仓的 ripgrep

`packages/core/vendor/ripgrep/` 实测 **20MB**，装着 5 个平台的预编译二进制：

| 文件 | 大小 |
| --- | --- |
| `rg-darwin-arm64` | 3.2M |
| `rg-darwin-x64` | 3.9M |
| `rg-linux-arm64` | 3.6M |
| `rg-linux-x64` | 4.9M |
| `rg-win32-x64.exe` | 4.5M |

**5 个平台全部塞进同一个 npm 包**（而不是按平台拆 optionalDependencies），
所以任何平台的用户都要下载另外 4 个平台的 rg。
`packages/core/src/tools/ripGrep.ts:50-69` 负责在运行时按 SEA / dev / dist
三种布局逐个路径找这个二进制。

### 3.3 体积的历史拐点（npm registry 实查）

| 版本 | unpackedSize | fileCount | deps |
| --- | --- | --- | --- |
| `0.1.0` | 10.3 MB | 12 | 0 |
| `0.20.0` | **9.6 MB** | **1,939** | **36** |
| `0.40.0` | 92.3 MB | 449 | 0 |
| `0.50.0` | 97.9 MB | 445 | 0 |
| `0.54.0` | 97.8 MB | 448 | 0 |
| `0.54.4` | **120.8 MB** | 464 | 0 |

两个可读的转折：

1. **`0.20.0` 那一代还是「传统 npm 包」**——1,939 个文件、36 个运行时依赖、不到 10MB。
   到 `0.40.0` 变成 449 个文件、0 依赖、92MB：**中间发生过一次打包方式的整体切换**
   （从「发布源码 + 依赖树」改为「发布 bundle + vendor 二进制」）。
   ⚠ 具体在哪个版本切的、为什么切，**本文没有核验**——需要逐版本二分 registry
   或读那段时间的 changelog，不在本次范围内。
2. **`0.54.0` → `0.54.4` 一个补丁号涨了 23MB。** 只凭 registry 元数据看不出原因，
   同样列为未核验（§19）。

::: tip 这一节为什么值得单列
「零依赖」通常被当作安全优势（无依赖链攻击面）。这里要摆的是代价那一面：
**依赖没有消失，只是从 `node_modules` 移进了不可审计的 bundle**，
外加 5 份跨平台二进制。`npm audit` 对这种形态基本失效。
这是一个取舍，不是一个优点或缺点。
:::

---

## 4. 主循环与事件模型

### 4.1 核心文件与规模

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `core/geminiChat.ts` | **1,722** | Chat 会话状态与请求发起 |
| `core/client.ts` | 1,299 | 客户端编排 |
| `core/turn.ts` | 542 | 单轮的事件流定义 |
| `core/contentGenerator.ts` | 422 | 内容生成器抽象与鉴权分派 |
| `scheduler/scheduler.ts` | 970 | 工具调用调度 |

### 4.2 `GeminiEventType`：18 类流式事件

`packages/core/src/core/turn.ts:55-74` 定义了主循环对上层吐出的事件类型，
脚本从枚举块提取共 **18 个**：

| 事件 | 值 |
| --- | --- |
| `Content` | `content` |
| `ToolCallRequest` | `tool_call_request` |
| `ToolCallResponse` | `tool_call_response` |
| `ToolCallConfirmation` | `tool_call_confirmation` |
| `UserCancelled` | `user_cancelled` |
| `Error` | `error` |
| `ChatCompressed` | `chat_compressed` |
| `Thought` | `thought` |
| `MaxSessionTurns` | `max_session_turns` |
| `Finished` | `finished` |
| `LoopDetected` | `loop_detected` |
| `Citation` | `citation` |
| `Retry` | `retry` |
| `ContextWindowWillOverflow` | `context_window_will_overflow` |
| `InvalidStream` | `invalid_stream` |
| `ModelInfo` | `model_info` |
| `AgentExecutionStopped` | `agent_execution_stopped` |
| `AgentExecutionBlocked` | `agent_execution_blocked` |

值得注意的是 `ContextWindowWillOverflow` 与 `InvalidStream` 这两个：
前者是**溢出前**的预警事件（而不是溢出后报错），
后者对应「流式返回结构非法」这一类可重试故障（配套 `Retry`）。
`Citation` 说明引用来源是一等公民事件，而不是拼进正文的文本。

### 4.3 循环检测：三层判据

`packages/core/src/services/loopDetectionService.ts` 顶部的常量把策略写得很直白：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `TOOL_CALL_LOOP_THRESHOLD` | **5** | 同一工具调用重复 5 次判定为循环 |
| `CONTENT_LOOP_THRESHOLD` | **10** | 内容块重复 10 次 |
| `CONTENT_CHUNK_SIZE` | 50 | 内容分块粒度 |
| `MAX_HISTORY_LENGTH` | 5000 | 检测窗口上限 |
| `LLM_CHECK_AFTER_TURNS` | **30** | 第 30 轮之后才启用 LLM 判定 |
| `DEFAULT_LLM_CHECK_INTERVAL` | 10 | LLM 复查间隔（默认） |
| `MIN_LLM_CHECK_INTERVAL` | 5 | 间隔下限 |
| `MAX_LLM_CHECK_INTERVAL` | 15 | 间隔上限 |
| `LLM_CONFIDENCE_THRESHOLD` | **0.9** | LLM 判定「确实在循环」的置信度门槛 |
| `LLM_LOOP_CHECK_HISTORY_COUNT` | 20 | 喂给判定模型的历史条数 |

第三层用了一个**专门的模型别名** `loop-detection-double-check`
（同文件 `DOUBLE_CHECK_MODEL_ALIAS`），即循环检测的二次确认走独立模型配置，
而不是复用主模型。同文件还带一段 `LOOP_DETECTION_SYSTEM_PROMPT` 与
`LOOP_DETECTION_SCHEMA`（结构化输出）。

**这套设计的取舍**：前两层是廉价的确定性计数（阈值 5 / 10），
第三层是昂贵的 LLM 判定且**只在 30 轮后**启动、置信度要 0.9 才算数。
换句话说，它接受「短任务里的循环靠计数兜住，长任务才付 LLM 的钱」。

---

## 5. 模型、鉴权与路由

### 5.1 六种鉴权方式

`packages/core/src/core/contentGenerator.ts:63-70` 的 `AuthType` 枚举：

| 枚举 | 值 | 说明 |
| --- | --- | --- |
| `LOGIN_WITH_GOOGLE` | `oauth-personal` | Google 账号 OAuth（Code Assist） |
| `USE_GEMINI` | `gemini-api-key` | Gemini API key |
| `USE_VERTEX_AI` | `vertex-ai` | Vertex AI |
| `LEGACY_CLOUD_SHELL` | `cloud-shell` | Cloud Shell（名字里已标 legacy） |
| `COMPUTE_ADC` | `compute-default-credentials` | GCE 默认凭据 |
| `GATEWAY` | `gateway` | **自定义网关** |

`GATEWAY` 这一项值得单独指出：它由 `GOOGLE_GEMINI_BASE_URL` 环境变量触发
（同文件 `getAuthTypeFromEnv()` 第 87 行），且第 344 行有
`config.authType === AuthType.GATEWAY && config.apiKey === ''` 的分支——
**即允许空 key 的网关模式**。这是企业自建代理的接入点。

::: warning 这个函数的自述注释也和代码不一致
`getAuthTypeFromEnv()` 上方的 JSDoc 写「Checks in order: 1. `GOOGLE_GENAI_USE_GCA`
2. `GOOGLE_GENAI_USE_VERTEXAI` 3. `GEMINI_API_KEY`」——**三条**。
而函数体实际有 **5 个分支**，注释里漏掉了夹在第 2、3 条之间的
`GOOGLE_GEMINI_BASE_URL → GATEWAY`，以及末尾的
`CLOUD_SHELL` / `GEMINI_CLI_USE_COMPUTE_ADC → COMPUTE_ADC`。
**漏掉的那条恰好改变了优先级**：设了 `GOOGLE_GEMINI_BASE_URL` 时，
即使同时设了 `GEMINI_API_KEY`，走的也是 `GATEWAY` 而不是 `USE_GEMINI`。
这是 文首 danger 块第 1 条那类问题的第三个实例（源码内注释也会腐烂）。
:::

### 5.2 模型常量与别名

`packages/core/src/config/models.ts` 的常量（实查行号）：

| 常量 | 值 | 行 |
| --- | --- | --- |
| `DEFAULT_GEMINI_MODEL` | `gemini-2.5-pro` | 61 |
| `PREVIEW_GEMINI_MODEL` | `gemini-3-pro-preview` | 54 |
| `PREVIEW_GEMINI_3_1_MODEL` | `gemini-3.1-pro-preview` | 55 |
| `PREVIEW_GEMINI_3_1_CUSTOM_TOOLS_MODEL` | `gemini-3.1-pro-preview-customtools` | 56 |
| `DEFAULT_GEMINI_3_5_FLASH_MODEL` | `gemini-3.5-flash` | 69 |
| `SECONDARY_GEMINI_3_5_FLASH_MODEL` | `gemini-3-flash` | 73 |
| `DEFAULT_GEMINI_FLASH_LITE_MODEL` | `gemini-3.1-flash-lite` | 81 |
| `PREVIEW_GEMINI_FLASH_LITE_MODEL` | **`'none'`** | 83 |
| `GEMMA_4_31B_IT_MODEL` | `gemma-4-31b-it` | 85 |
| `GEMMA_4_26B_A4B_IT_MODEL` | `gemma-4-26b-a4b-it` | 86 |
| `DEFAULT_GEMINI_EMBEDDING_MODEL` | `gemini-embedding-001` | 115 |
| `DEFAULT_THINKING_MODE` | **8192** | 118 |

四个用户可用别名（`auto` / `pro` / `flash` / `flash-lite`，行 110-113），
另有两个已标 `@deprecated` 的旧别名 `auto-gemini-3` / `auto-gemini-2.5`。

两处细节：

- **`PREVIEW_GEMINI_FLASH_LITE_MODEL = 'none'`** —— 字符串字面量 `'none'`，
  是占位而非模型名。它仍被放进了 `VALID_GEMINI_MODELS` 集合（第 92 行）。
- **`PREVIEW_GEMINI_FLASH_MODEL` 用的是 `export let` 而不是 `const`**
  （第 60 行），源码注释解释是等 3.5 flash 的实验清理完再改回 const。
- `DEFAULT_THINKING_MODE = 8192` 的注释写明理由：
  "Cap the thinking at 8192 to prevent run-away thinking loops."

### 5.3 路由：7 个策略串成一条链

`packages/core/src/routing/strategies/` 有 8 个文件，
`modelRouterService.ts:43-63` 按固定顺序把它们压进一个 `CompositeStrategy`：

| 顺序 | 策略 | 作用 |
| --- | --- | --- |
| 1 | `FallbackStrategy` | 降级态优先 |
| 2 | `OverrideStrategy` | 用户显式指定 |
| 3 | `ApprovalModeStrategy` | 按审批模式（如 plan）选模型 |
| 4 | `GemmaClassifierStrategy` | **本地 Gemma** 分类（条件启用） |
| 5 | `ClassifierStrategy` | 远端分类 |
| 6 | `NumericalClassifierStrategy` | 数值分类 |
| 终 | `DefaultStrategy` | 兜底（terminal strategy） |

**「本地模型」在这里的角色是路由决策，不是干活。**
`docs/core/local-model-routing.md` 明确说：配好后用本地 Gemma
**做路由决策**而不把决策发给托管模型，理由是省钱。
实现是 `packages/core/src/core/localLiteRtLmClient.ts`（102 行），
走 LiteRT-LM 起的本地 HTTP 端点，且**复用 `@google/genai` SDK**——
所以源码里有这么一行注释：本地服务不需要 key，但 SDK 强制要求填，
于是写死 `apiKey: 'no-api-key-needed'`。

⚠ **不要把这一条读成「Gemini CLI 支持接任意本地模型干活」。**
文档路径是 `local-model-**routing**`，标了 experimental，
且推荐走 `gemini gemma setup` 自动装。**主模型仍是 Gemini 族**
（`VALID_GEMINI_MODELS` 里除两个 Gemma 外全是 gemini-*）。

---

## 6. 内置工具系统

### 6.1 27 个内置工具名

`packages/core/src/tools/tool-names.ts` 的 `ALL_BUILTIN_TOOL_NAMES` 数组，
脚本解析并把常量名解引用成实际字符串，共 **27 项**。
注意**工具名与类名/显示名三者不同**，下表给的是模型看到的那个名字：

| 工具名（wire name） | 常量 | 文档 Kind |
| --- | --- | --- |
| `read_file` | `READ_FILE_TOOL_NAME` | `Read` |
| `write_file` | `WRITE_FILE_TOOL_NAME` | `Edit` |
| **`replace`** | `EDIT_TOOL_NAME` | `Edit` |
| `list_directory` | `LS_TOOL_NAME` | `Read` |
| `glob` | `GLOB_TOOL_NAME` | `Search` |
| **`grep_search`** | `GREP_TOOL_NAME` | `Search` |
| `read_many_files` | `READ_MANY_FILES_TOOL_NAME` | `Read` |
| `run_shell_command` | `SHELL_TOOL_NAME` | `Execute` |
| **`google_web_search`** | `WEB_SEARCH_TOOL_NAME` | `Search` |
| `web_fetch` | `WEB_FETCH_TOOL_NAME` | `Fetch` |
| `write_todos` | `WRITE_TODOS_TOOL_NAME` | `Other` |
| `ask_user` | `ASK_USER_TOOL_NAME` | `Communicate` |
| `activate_skill` | `ACTIVATE_SKILL_TOOL_NAME` | `Other` |
| `get_internal_docs` | `GET_INTERNAL_DOCS_TOOL_NAME` | `Think` |
| `enter_plan_mode` | `ENTER_PLAN_MODE_TOOL_NAME` | `Plan` |
| `exit_plan_mode` | `EXIT_PLAN_MODE_TOOL_NAME` | `Plan` |
| `update_topic` | `UPDATE_TOPIC_TOOL_NAME` | `Think` |
| `complete_task` | `COMPLETE_TASK_TOOL_NAME` | `Other` |
| **`invoke_agent`** | `AGENT_TOOL_NAME` | **文档表格里没有** |
| `read_mcp_resource` | `READ_MCP_RESOURCE_TOOL_NAME` | `Read` |
| `list_mcp_resources` | `LIST_MCP_RESOURCES_TOOL_NAME` | `Search` |
| `tracker_create_task` | `TRACKER_CREATE_TASK_TOOL_NAME` | `Other`/`Think` |
| `tracker_update_task` | `TRACKER_UPDATE_TASK_TOOL_NAME` | 同上 |
| `tracker_get_task` | `TRACKER_GET_TASK_TOOL_NAME` | 同上 |
| `tracker_list_tasks` | `TRACKER_LIST_TASKS_TOOL_NAME` | 同上 |
| `tracker_add_dependency` | `TRACKER_ADD_DEPENDENCY_TOOL_NAME` | 同上 |
| `tracker_visualize` | `TRACKER_VISUALIZE_TOOL_NAME` | 同上 |

**三个名字与直觉不符，写策略规则时最容易错**：
编辑工具叫 `replace`（不是 `edit`）、
grep 叫 `grep_search`（旧名 `search_file_content` 保留为 legacy alias，
见 `TOOL_LEGACY_ALIASES`）、web 搜索叫 `google_web_search`（不是 `web_search`）。

`Kind` 枚举本身有 13 个值（`tools/tools.ts:1104-1118`）：
`read`、`edit`、`delete`、`move`、`search`、`execute`、`think`、`agent`、
`fetch`、`communicate`、`plan`、`switch_mode`、`other`。
其中 `MUTATOR_KINDS` = {edit, delete, move, execute} 是有副作用的那组。

### 6.2 名单与注册表不一致：两个「幽灵工具」

这是本文用脚本 + 实跑双重确认的一处缺陷。

**先看注册表**：`packages/core/src/config/config.ts` 的
`createToolRegistry()` 里 `registry.registerTool(new X(...))` 的调用，
脚本提取出 **27 个类**，其中包括：

```
packages/core/src/config/config.ts:4009  new ListBackgroundProcessesTool(...)
packages/core/src/config/config.ts:4014  new ReadBackgroundOutputTool(...)
```

它们的 wire name 在 `packages/core/src/tools/shellBackgroundTools.ts` 里：

```
:75   static readonly Name = 'list_background_processes';
:253  static readonly Name = 'read_background_output';
```

**再看两处名单**：这两个名字
**既不在 `ALL_BUILTIN_TOOL_NAMES`，也不在 `docs/reference/tools.md` 的表格里**
（`grep` 两处皆无）。

**后果不只是「文档漏了」**。`isValidToolName()`
（`tools/tool-names.ts:303`）是拿 `ALL_BUILTIN_TOOL_NAMES` 做白名单的，
而它被 `packages/core/src/agents/agentLoader.ts:103` 用在一个 **Zod `.refine()`**
里校验自定义子代理的 `tools:` 字段——那是**硬校验，不是警告**，
不合法直接报 `Invalid tool name`。

把源码单独打包出来实跑（`npx esbuild … --bundle --platform=node` 后 `node` 执行）：

```
ALL_BUILTIN count = 27
list_background_processes    false      ← 注册表里活着，校验说非法
read_background_output       false      ← 同上
read_many_files              true
read_file                    true
invoke_agent                 true
complete_task                true
get_internal_docs            true
```

**即：你没法在自定义子代理的 `tools:` 列表里写这两个后台 shell 工具**，
尽管主 agent 用得到它们。

另一条路径（`policy/toml-loader.ts:278`）只把 `isValidToolName` 用于
「是否要给出拼写建议」，**不合法只是不提示，不拦规则**——
所以策略 TOML 里写这两个名字是可以生效的。**两条路径的严格度不同，
这个区别很容易看反。**

### 6.3 `read_many_files` 不在主注册表里

同一批脚本还带出一个反向的例子：`read_many_files`
**在名单里、在文档里，但不在 `createToolRegistry()` 的注册列表里**
（`grep -n "ReadManyFiles" packages/core/src/config/config.ts` 无结果）。

它的实例化只出现在两处：

```
packages/cli/src/ui/hooks/atCommandProcessor.ts:519
packages/cli/src/acp/acpSession.ts:1012
```

这与文档的说法是自洽的——`docs/reference/tools.md:84` 说它
"Often triggered by the `@` symbol in your prompt"。
即它是 **`@` 语法的实现，走 CLI 侧直接调用**，
而不是一个交给模型自主决策的工具。

⚠ **本文未核验**：`read_many_files` 是否在别处（如某个 agent profile
或运行时补注册）被加入模型可见的工具列表。上面只能证明它不在
`createToolRegistry()` 这一条路径里。

### 6.4 工具注册是条件式的

`createToolRegistry()` 里几乎每个注册都包着 `maybeRegister(...)`，
另有若干显式开关（实查 `config.ts:3960-4045`）：

| 条件 | 影响的工具 |
| --- | --- |
| `getUseRipgrep()` + `canUseRipgrep()` | 成功注册 `RipGrepTool`，**失败降级注册 `GrepTool`** |
| `getUseWriteTodos()` | `write_todos` |
| `isPlanEnabled()` | `enter_plan_mode` / `exit_plan_mode` |
| `isTrackerEnabled()` | 6 个 `tracker_*`（对应 `experimental.taskTracker`） |

ripgrep 那条降级路径还带遥测：失败时调
`logRipgrepFallback(this, new RipgrepFallbackEvent(errorString))`——
**「用户实际用的是 rg 还是 JS 版 grep」是可观测的**，
这在对比搜索性能时是有用的一手信号。

`get_internal_docs` 与 `complete_task` 也不在主注册表里，各自绑定在专用位置：

```
packages/core/src/agents/cli-help-agent.ts:72    new GetInternalDocsTool(...)
packages/core/src/agents/local-executor.ts:272   new CompleteTaskTool(...)
```

即 `get_internal_docs` 是 `cli_help` 子代理**独占**的工具，
`complete_task` 是子代理执行器给出的「交卷」工具——
和文档「This tool is not available to the user」一致。

---

## 7. 策略引擎（本文最该先读的一节）

Gemini CLI 的权限系统不是「一串 allow/deny 字符串」，而是一个**带优先级算术的
TOML 规则引擎 + 可插拔安全检查器**。`packages/core/src/policy/` 共 9 个非测试文件
3,716 行，配套测试 `policy-engine.test.ts` 单文件 **120,407 字节**——
测试体量是实现的 4 倍，说明这块的回归成本被认真对待。

### 7.1 三种判定

`packages/core/src/policy/types.ts:10-14`：

| 判定 | 值 | 行为 |
| --- | --- | --- |
| `ALLOW` | `allow` | 直接执行 |
| `DENY` | `deny` | 阻止执行 |
| `ASK_USER` | `ask_user` | 弹确认；**非交互模式下等价于 deny** |

`deny` 有一个容易被忽略的副作用，文档 `policy-engine.md:110-114` 说得明确：
**没有 `argsPattern` 的全局 deny 规则会把该工具从模型的可见列表里整个摘掉**
（"completely excluded from the model's memory"）——既更安全也省 context。
官方因此把 `deny` 规则定为替代已废弃的 `tools.exclude` 设置的推荐做法。

### 7.2 四种审批模式

`types.ts:47-52` 的 `ApprovalMode`，以及第 57-63 行按「宽松度」排序的常量：

```
MODES_BY_PERMISSIVENESS = [PLAN, DEFAULT, AUTO_EDIT, YOLO]
```

| 模式 | 值 | 含义 |
| --- | --- | --- |
| `PLAN` | `plan` | 只读研究模式（最严） |
| `DEFAULT` | `default` | 写工具需确认 |
| `AUTO_EDIT` | `autoEdit` | 部分写操作自动放行 |
| `YOLO` | `yolo` | 全部自动放行（最松） |

这个顺序不是文档措辞，是代码里的数组——它驱动了「持久化授权向更宽松模式传递」
这条规则：在 `plan` 里选「永久允许」会把 4 个模式全带上，
而在 `yolo` 里选只作用于 `yolo`。

### 7.3 五层 tier

`packages/core/src/policy/config.ts:67-71`：

| Tier | 基数 | 位置 |
| --- | --- | --- |
| Default | **1** | 随 CLI 出厂（`policy/policies/*.toml`） |
| Extension | **2** | 扩展提供 |
| Workspace | **3** | `$WORKSPACE/.gemini/policies/*.toml` —— **实际不生效，见 §7.6** |
| User | **4** | `~/.gemini/policies/*.toml` |
| Admin | **5** | 系统目录（OS 相关）或 `--admin-policy` |

最终优先级 = `tier + priority/1000`（`toml-loader.ts:300-307`），
TOML 里的 `priority` 取值 **0–999**，超过 999 会被拒（第 61 行的错误信息写明
"Priorities >= 1000 would jump to the next tier"）。

### 7.4 出厂默认策略：38 条规则

`packages/core/src/policy/policies/` 下 9 个 TOML，脚本数 `[[rule]]` 共 **38 条**：

| 文件 | 规则数 | 作用 |
| --- | --- | --- |
| `plan.toml` | **21** | Plan 模式的白名单（最大的一份） |
| `write.toml` | 9 | 写工具默认 `ask_user` + autoEdit 覆盖 + 无头 deny |
| `yolo.toml` | 3 | yolo 放行 + 两条例外 |
| `discovered.toml` | 2 | 发现式工具 |
| `agents.toml` | 1 | 子代理委派 |
| `non-interactive.toml` | 1 | 无头模式 |
| `read-only.toml` | 1 | 18 个只读工具一次性放行 |
| `conseca.toml` | 0 | 只挂 safety_checker，无 rule |
| `sandbox-default.toml` | 0 | 同上 |

**`read-only.toml` 那一条规则里列了 18 个工具名**（脚本数），
包括两个「不是工具的工具」：`codebase_investigator` 与 `cli_help`——
即子代理名在策略里**当作虚拟工具名参与匹配**（文档 `policy-engine.md:459-470`
证实这是设计，`invoke_agent` 的 `agent_name` 会被当作 toolName 别名）。

**`yolo.toml` 的两条例外值得单记**（这是「yolo 也不是全放行」的实据）：

```toml
# ask_user 在 yolo 下仍然要问
toolName = "ask_user"      decision = "ask_user"  priority = 999  modes = ["yolo"]
# plan 模式切换在 yolo 下被禁
toolName = ["enter_plan_mode", "exit_plan_mode"]
decision = "deny"          priority = 999         modes = ["yolo"]
# 其余全放行
toolName = "*"             decision = "allow"     priority = 998  modes = ["yolo"]
allowRedirection = true
```

注意 998 / 999 的用法：**放行是 998，两条例外是 999**，
靠 1 分之差压住通配放行。这是 tier 内细粒度排序的实际用法示例。

`write.toml` 的最后一条是**无头模式收口**：`interactive = false` 时，
5 个写工具（`replace` / `run_shell_command` / `write_file` / `activate_skill` /
`web_fetch`）直接 `deny`——对应 §7.1 那句「非交互下 ask_user 等价 deny」，
这里是把它显式写成规则而不是依赖隐式行为。

### 7.5 优先级示例算错了（实测复算）

文首 danger 块第 1 条的详细版。`docs/reference/policy-engine.md:163-166` 的四个示例：

按源码常量重算（脚本从 `policy/config.ts` 提取 tier 基数，套文档自己给的公式）：

| 示例 | 文档写 | 实际 | 结论 |
| --- | --- | --- | --- |
| Default `priority: 50` | `1.050` | `1.050` | **OK** |
| Workspace `priority: 10` | `2.010` | **`3.010`** | **MISMATCH** |
| User `priority: 100` | `3.100` | **`4.100`** | **MISMATCH** |
| Admin `priority: 20` | `4.020` | **`5.020`** | **MISMATCH** |

复现命令（不需要装依赖，只解析源码常量）：

```bash
python3 -c "
import re
t=open('packages/core/src/policy/config.ts').read()
tiers={n.replace('_POLICY_TIER','').title():int(v)
       for n,v in re.findall(r'export const (\w+_POLICY_TIER)\s*=\s*(\d+)', t)}
print(tiers)
for tier,p in [('Default',50),('Workspace',10),('User',100),('Admin',20)]:
    print(tier, p, '->', f'{tiers[tier]+p/1000:.3f}')
"
# => {'Default': 1, 'Extension': 2, 'Workspace': 3, 'User': 4, 'Admin': 5}
```

**归因**：同一份文档第 137 行还写着 "organized into **three** tiers"，
而它下方的表格已经是五行（含 Extension=2）。
第 235 行又写 "system-wide policies (**Tier 4**)"，而 Admin 实际是 5。
**看起来是 Extension 这一层后来插进 2 的位置，表格更新了、示例和散落的行内数字没跟上。**

**而出厂 TOML 自己的注释是对的**：`policy/policies/read-only.toml` 开头那段
把五层基数逐条列全（1/2/3/4/5），还额外列了 settings 派生规则的 4.x 小数位
（4.95 = UI 里选的 Always Allow、4.9 = MCP 排除名单、4.4 = `--exclude-tools`、
4.3 = `--allowed-tools`、4.2 = `trust=true` 的 MCP、4.1 = MCP 允许名单）。
**这批数字在公开文档里查不到，只在 TOML 注释里**——
要判断「我的 `--allowed-tools` 能不能盖住某条 user 规则」，得看这里。

对应源码常量在 `policy/config.ts:76-83`，与注释一致：

```
MCP_EXCLUDED_PRIORITY          = USER_POLICY_TIER + 0.9
EXCLUDE_TOOLS_FLAG_PRIORITY    = USER_POLICY_TIER + 0.4
CONFIRMATION_REQUIRED_PRIORITY = USER_POLICY_TIER + 0.35
ALLOWED_TOOLS_FLAG_PRIORITY    = USER_POLICY_TIER + 0.3
CORE_TOOLS_FLAG_PRIORITY       = USER_POLICY_TIER + 0.25
TRUSTED_MCP_SERVER_PRIORITY    = USER_POLICY_TIER + 0.2
ALLOWED_MCP_SERVER_PRIORITY    = USER_POLICY_TIER + 0.1
```

⚠ 有一个**例外**要注意：`ALWAYS_ALLOW_PRIORITY` 并不在 user tier，
而是 `WORKSPACE_POLICY_TIER + 0.95`（`config.ts:85-86`，即 **3.95**），
尽管 TOML 注释把它归在「user tier 4.x」那一段里写作 4.95。
**注释与常量在这一条上不一致**——常量是 3.95。
这条的实际影响本文未追到底（§19）。

### 7.6 Workspace tier 是被硬编码关掉的

`packages/cli/src/config/policy.ts` 顶部两个模块级变量：

```ts
:28  export let autoAcceptWorkspacePolicies = true;
:42  export let disableWorkspacePolicies = true;   // 注释自称 "Temporary flag"
```

`resolveWorkspacePolicyState()` 的第一个判断（第 108 行）：

```ts
if (trustedFolder && !disableWorkspacePolicies) {
```

`disableWorkspacePolicies` 恒为 `true` ⇒ 整个分支永不进入 ⇒
`workspacePoliciesDir` 始终返回 `undefined` ⇒ `.gemini/policies/*.toml` 不被读取。

**「有没有开关能打开它」的核验结果**：
`setDisableWorkspacePolicies()` 这个 setter 全仓只被两个**测试文件**调用
（`policy.test.ts:51/78/203`、`workspace-policy-cli.test.ts:52`），
`settingsSchema.ts` 与 `docs/` 里都搜不到这个名字。
**结论：没有用户可及的开关。**

**但基础设施是完整的**，这是它区别于「压根没做」的地方：

- `getPolicyTier()` 认得 workspace 目录并返回 3（`policy/config.ts:157-162`）
- `Config.loadWorkspacePolicies()` 能热加载（`core/config/config.ts:2753`）
- 有完整的完整性校验流程（`PolicyIntegrityManager` + `IntegrityStatus`）
  与交互确认弹窗（`PolicyUpdateDialog.tsx:58` 会调 `loadWorkspacePolicies`）
- 甚至有「非交互模式下自动接受并 warn 到 stderr」的分支

即**整条链路都建好了，只被入口处一个常量掐住**。
官方文档标了 "currently non-functional" 并指向
[issue #18186](https://github.com/google-gemini/gemini-cli/issues/18186)，
但没说明它无法配置打开。

**实践含义**：想给团队下发统一的项目级策略，
当前只能走 **User tier（`~/.gemini/policies/`，每人各配）** 或
**Admin tier（系统目录，需管理员权限）**，
**不能靠提交进仓库的 `.gemini/policies/` 生效**。

### 7.7 Shell 命令的安全边界

`run_shell_command` 的策略匹配有两个专用简写（文档 `policy-engine.md:372-396`）：
`commandPrefix`（前缀匹配）与 `commandRegex`（正则）。

真正值得看的是**它防的是什么**。`policy/shell-safety.test.ts`（19,594 字节）
的用例名直接构成一份攻击面清单：

| 用例 | 期望 |
| --- | --- |
| `git log` 前缀匹配 `git logout` | **不匹配**（严格词边界） |
| `git log && rm -rf /` | 不因前缀 `git log` 而整条放行 |
| `git log; rm -rf /` / `\|\|` / `&&&` | 同上（分号 / OR / 解析失败均拦） |
| `$(rm -rf /)` 命令替换 | 拦 |
| 反引号 `` `rm -rf /` `` | 拦 |
| `<(rm -rf /)` / `>(rm -rf /)` 进程替换 | 拦 |
| `git log \| rm -rf /` 管道 | 拦 |
| `--arg=$(rm -rf /)` 参数注入 | 拦 |
| `git log && echo $(git log)` | **放行**（内层也在白名单内） |
| `> /tmp/test` 重定向 | 默认拦，`allowRedirection = true` 才放 |
| PowerShell `@(...)` | 拦 |

实现侧：`packages/core/src/utils/shell-utils.ts` 有
`splitCommands()`（797）、`getCommandRoots()`（826）、
`stripShellWrapper()`（842）、`detectCommandSubstitution()`（1083）、
`hasRedirection()`（751）等；替换检测**按 shell 分派**——
PowerShell 走 `detectPowerShellSubstitution()`，其余走
`detectBashSubstitution()`，后者是逐字符状态机，**正确处理单双引号与反斜杠转义**
（单引号内的 `$(` 不算替换）。

依赖上，`packages/core` 装了 **`tree-sitter-bash` 0.25.0 + `web-tree-sitter` 0.25.10**，
且 `shell-utils.ts:166` 有 `initializeShellParsers()`——
即 shell 解析用的是**真正的语法树解析器**，不是纯正则。

⚠ 未核验：本文没有实跑这些用例，也没有独立构造绕过尝试。
上表是**从测试用例名读出的设计意图**，不是我们验证过的实际行为。

### 7.8 可插拔安全检查器与 Conseca

除 allow/deny/ask 之外还有一层 **safety checker**
（`types.ts:88-105`），分两类：

| 类型 | 值 | 内置实现 |
| --- | --- | --- |
| in-process | `allowed-path` | `AllowedPathChecker`（`safety/built-in.ts:26`） |
| in-process | `conseca` | `ConsecaSafetyChecker`（`safety/conseca/conseca.ts:28`） |
| external | — | 外部进程检查器（`ExternalCheckerConfig`） |

`allowed-path` 已在出厂 `write.toml` 里被用上：`autoEdit` 模式下放行
`replace` / `write_file` 的那两条规则**各挂了一个 `allowed-path` 检查器**，
`required_context = ["environment"]`。即「自动编辑」不是无条件的，
仍要过路径校验。

**Conseca 是这套里最特殊的一层**：`security.enableConseca`，**默认 `false`**
（`settingsSchema.ts:2007-2015`，`requiresRestart: true`）。
文档描述为 "uses an LLM to dynamically generate and enforce security policies
for tool use based on your prompt"。实现是三个文件：
`policy-generator.ts`（按用户 prompt 生成策略）、
`policy-enforcer.ts`（执行）、`conseca.ts`（单例编排）。
它有专属遥测：`logConsecaPolicyGeneration` 与 `logConsecaVerdict`
（对应事件 `gemini_cli.conseca.verdict`）。

⚠ **这一层的效果本文完全未核验**——它默认关闭，我们也没开起来跑。
能证实的只有「代码在、有埋点、默认 false」。

---

## 8. 沙箱：5 种后端，3 个平台各有原生实现

`packages/core/src/sandbox/` 共 14 个文件 3,188 行，按平台分三个子目录。
这是 Gemini CLI 相对同类产品最「重」的一块。

### 8.1 五种方法（`docs/cli/sandbox.md`）

| # | 方法 | 平台 | 说明 |
| --- | --- | --- | --- |
| 1 | **macOS Seatbelt**（`sandbox-exec`） | macOS | 内置轻量，6 个预置 profile |
| 2 | **容器**（Docker / Podman） | 跨平台 | 默认镜像 `ghcr.io/google/gemini-cli:latest` |
| 3 | **Windows Native Sandbox** | Windows | Restricted Token + Job Object，见 §8.4 |
| 4 | **gVisor / runsc** | Linux | 最强隔离；**不自动探测，必须显式指定** |
| 5 | **LXC / LXD** | Linux | 标注 experimental；完整系统容器（带 systemd） |

启用优先级（文档 `sandbox.md:71-79`）：
CLI 参数 `-s`/`--sandbox` > 环境变量 `GEMINI_SANDBOX` > `settings.json` 的
`tools.sandbox`。环境变量取值可为
`true|docker|podman|sandbox-exec|runsc|lxc`。

### 8.2 macOS：6 个 Seatbelt profile

由 `SEATBELT_PROFILE` 环境变量选择，默认 `permissive-open`：

| profile | 写限制 | 网络 |
| --- | --- | --- |
| `permissive-open`（默认） | 限制写 | 直连 |
| `permissive-proxied` | 限制写 | 走代理 |
| `restrictive-open` | 严格 | 直连 |
| `restrictive-proxied` | 严格 | 走代理 |
| `strict-open` | 读+写都限制 | 直连 |
| `strict-proxied` | 读+写都限制 | 走代理 |

实现在 `sandbox/macos/`：`MacOsSandboxManager.ts` + `seatbeltArgsBuilder.ts`
+ `baseProfile.ts`，且 args builder 有独立测试。

### 8.3 Linux：bwrap

`sandbox/linux/` 只有两个实现文件：`LinuxSandboxManager.ts` 与
**`bwrapArgsBuilder.ts`**——即 Linux 侧的进程级隔离走 **bubblewrap**，
与文档里 Docker/Podman/runsc/LXC 那套「容器方案」是**并列的另一条路**。

### 8.4 Windows：567 行 C#

`packages/core/src/sandbox/windows/` 是全仓最特殊的目录：

| 文件 | 说明 |
| --- | --- |
| `GeminiSandbox.cs` | **567 行 C#**，用 P/Invoke 调 Win32 API |
| `WindowsSandboxManager.ts` | TS 侧管理器 |
| `commandSafety.ts` | Windows 专用命令安全 |
| `windowsSandboxDenialUtils.ts` | 拒绝信息处理 |

C# 那份的自述注释：
"uses Restricted Tokens and Job Objects to isolate processes.
It also supports internal commands for safe file I/O within the sandbox."
源码里能看到的 Win32 常量包括
`JobObjectExtendedLimitInformation`、`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、
`JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION`、`TokenIntegrityLevel`、
`SE_GROUP_INTEGRITY`、`DISABLE_MAX_PRIVILEGE`、`LABEL_SECURITY_INFORMATION`。

**这个方案有一个持久化副作用，文档写得很坦白**（`sandbox.md:181-198`）：
它用 `icacls` 给要写的文件/目录打 **Low Mandatory Level**，
而**这个完整性级别变更是持久的**——沙箱会话结束后，
被创建/修改过的文件仍保留 "Low" 完整性级别。恢复要手动跑：

```powershell
icacls "C:\path\to\dir" /setintegritylevel Medium
```

沙箱管理器会自动跳过系统目录（如 `C:\Windows`）。

**这一条是本章最该记住的**：它不是 bug，是这种隔离手段的固有代价，
且**痕迹留在宿主文件系统上**。

### 8.5 沙箱与策略的交叉

`policy/sandboxPolicyManager.ts`（7,416 字节）说明沙箱不是独立开关，
而是参与策略判定的一等公民；`types.ts` 里 `PolicyRule` 也带
`SandboxManager` 与 `SandboxPermissions` 的引用。
出厂策略里 `sandbox-default.toml` 存在但 **0 条 rule**——只挂配置不挂规则。

⚠ 未核验：五种沙箱本文一个都没实际启动过。
上述全部来自源码结构与官方文档，**隔离强度、逃逸面均未验证**。

---

## 9. Hook 系统：11 类事件

### 9.1 事件清单（源码与文档完全一致）

`packages/core/src/hooks/types.ts:43-54` 的 `HookEventName` 枚举，
脚本提取 **11 个**；`docs/hooks/reference.md` 的 `### \`Xxx\`` 小节
脚本提取也是 **11 个**，两边**集合差为空**：

| 事件 | 分组 | 触发点 |
| --- | --- | --- |
| `BeforeTool` | 工具 | 工具执行前 |
| `AfterTool` | 工具 | 工具执行后 |
| `BeforeToolSelection` | 模型 | 模型选工具前 |
| `BeforeModel` | 模型 | 请求模型前 |
| `AfterModel` | 模型 | 模型返回后 |
| `BeforeAgent` | Agent | agent 启动前 |
| `AfterAgent` | Agent | agent 结束后 |
| `SessionStart` | 生命周期 | 会话开始 |
| `SessionEnd` | 生命周期 | 会话结束 |
| `PreCompress` | 生命周期 | 压缩上下文前 |
| `Notification` | 生命周期 | 通知 |

::: tip 这是本文唯一一处「文档与源码严丝合缝」的对照
其他几处对照（文首 danger 块、§5.1、§6.2、§7.5）都发现了偏差，
Hook 这块 11 对 11 精确吻合。摆出来是为了避免留下
「这个项目文档普遍不可信」的错误印象——**它是分块的，
Hook 参考页的维护质量明显高于策略参考页。**
:::

### 9.2 两种实现类型

`types.ts:65-68` 的 `HookType`：

| 类型 | 值 | 说明 |
| --- | --- | --- |
| `Command` | `command` | 执行外部命令 |
| `Runtime` | `runtime` | 进程内运行时 hook |

**`runtime` 类型是个值得注意的存在**——多数同类产品的 hook 只有
「spawn 一个子进程」这一种形态，这里另有一条不出进程的路径。

### 9.3 四个配置来源与信任

`types.ts:24-28` 定义来源为 `runtime` / `project` / `user` / `system` /
`extensions`；`policy/types.ts:17-29` 另有一个 `HookSource` 类型
（`project` / `user` / `system` / `extension`，4 个），
带 `getHookSource()` 做运行时校验，**非法或缺失时默认回落到 `'project'`**
（`policy/types.ts:44`）。

⚠ **两处枚举不完全一致**：hooks 侧有 5 个值且用复数 `extensions`，
policy 侧有 4 个值且用单数 `extension`。
本文未核验这个差异是否会导致 extension 来源的 hook 在策略侧被误判为 `project`
（默认回落值）——这是一个值得追的点，列入 §19。

另有 `hooks/trustedHooks.ts`（3,529 字节）处理 hook 的信任问题，
文档 `hooks/index.md:146` 有专门的 "Security and risks" 一节。

### 9.4 输出协议

`types.ts:131-135` 里 hook 的返回决策字符串有 5 个：
`ask` / `block` / `deny` / `approve` / `allow`——
**`block` 与 `deny`、`approve` 与 `allow` 是两组同义词**
（第 212 行 `'block'`/`'deny'` 并列、216-219 行 `'ask'`），
即协议对措辞是宽容的。另有 `additionalContext`（第 266-269 行）
让 hook 往上下文注入内容，以及 `tailToolCallRequest`（第 311 行）。

### 9.5 实现文件

| 文件 | 字节 | 职责 |
| --- | --- | --- |
| `types.ts` | 18,133 | 协议定义 |
| `hookRunner.ts` | 16,741 | 执行 |
| `hookEventHandler.ts` | 15,521 | 事件分派 |
| `hookTranslator.ts` | 15,403 | **协议翻译** |
| `hookSystem.ts` | 12,690 | 编排 |
| `hookAggregator.ts` | 10,395 | 多 hook 结果聚合 |
| `hookRegistry.ts` | 9,543 | 注册 |
| `hookPlanner.ts` | 3,738 | 计划 |
| `trustedHooks.ts` | 3,529 | 信任 |

`hookTranslator.ts` 那 15KB 值得留意——存在一个专门的「翻译」层，
通常意味着要兼容不止一种 hook 协议方言。
文档 `hooks/reference.md:301` 有 "Stable Model API" 一节，
暗示 hook 能看到的模型数据结构有稳定性承诺。
⚠ 具体翻译的是哪几种方言，本文未核验。

---

## 10. 子代理系统

`packages/core/src/agents/` 共 39 个非测试文件 12,410 行——
比策略引擎（3,716）和 Hook（3,785）加起来还多，是 core 里第四大的子系统。

### 10.1 四个内置子代理

`packages/core/src/agents/registry.ts:285-312` 的注册顺序：

| 名字 | 注册行 | 用途 | 默认 |
| --- | --- | --- | --- |
| `codebase_investigator` | 285 | 代码库分析、逆向、依赖梳理 | 启用 |
| `cli_help` | 286 | 回答关于 Gemini CLI 自身的问题 | 启用 |
| `generalist` | 287 | 通用子代理，**继承主 agent 的工具与配置** | 启用 |
| `browser_agent` | 312（条件） | 浏览器自动化，走无障碍树 | **需显式开启** |

前三个是无条件 `registerLocalAgent()`，`browser_agent`
包在一个条件分支里（第 312 行）。浏览器能力的依赖是
**`puppeteer-core` 24.0.0**（`packages/core/package.json:82`）。

**`cli_help` 是唯一持有 `get_internal_docs` 的角色**
（`agents/cli-help-agent.ts:72`，见 §6.4）——
即「问 CLI 自己的问题」被做成了一个带专属工具的独立子代理，
而不是把文档塞进主 system prompt。

**`generalist` 的定位值得单记**：文档 `subagents.md:88-107` 说它
"uses the inherited tool access and configurations from the main agent"，
目的是**用隔离的对话窗口跑重活，只把最终结果带回主上下文**。
即它不是「能力更弱的助手」，而是**上下文隔离器**。

### 10.2 加载来源与优先级

`registry.ts` 里四类来源各有独立的注册循环与错误收集：

| 来源 | 行 |
| --- | --- |
| project | 218 |
| user | 249 |
| extension | 265 |
| built-in（local） | 285-312 |

每一类都是「逐个 try / catch，失败只记 error 不中断」的形态
（如第 220 行 `Error registering project agent "${agent.name}"`），
即**一个坏的 agent 定义不会让整个注册表崩掉**。
另有 `acknowledgedAgents.ts` 与 `acknowledgeAgent()`（第 139 行）——
新 agent 需要被「确认」过才注册，这是一道信任闸。

### 10.3 三条硬性隔离

文档 `subagents.md:384-395` 明确：

1. **独立历史**：子代理的对话不进主 agent 上下文
2. **工具隔离**：只有显式授予的工具
3. **递归保护**：**子代理不能调用其他子代理**——
   即使给了 `*` 通配，它也**看不见**别的 agent

第 3 条是个硬约束，`invoke_agent` 的 fan-out 只有一层。

### 10.4 策略侧的两个入口

出厂 `agents.toml` 只有一条规则：

```toml
name = "Allow invoke_agent"
toolName = "invoke_agent"
decision = "allow"
priority = 50
modes = ["default", "autoEdit", "yolo"]
```

注释给的理由是「子代理自己会处理破坏性操作的确认，所以调用它本身放行」。
注意 `modes` **不含 `plan`**——Plan 模式下调子代理不走这条放行
（Plan 的白名单在 `plan.toml` 里另有 21 条，且 `PLAN_MODE_TOOLS`
里显式列了 `'codebase_investigator'` 与 `'cli_help'` 两个字符串字面量，
见 `tool-names.ts` 的 `PLAN_MODE_TOOLS`）。

而 §7.4 提到的另一个入口是：**子代理名可直接当 `toolName` 写规则**
（`policy-engine.md:459-470`），如
`toolName = "codebase_investigator"` + `decision = "deny"`。
反向还有 `subagent` 字段（`policy/types.ts` 的 `PolicyRule.subagent`），
用来限定「**谁在调**这个工具」而不是「调的是哪个 agent」。
**这两个字段方向相反，很容易配反。**

文档同时承诺了向后兼容：「针对历史上 1:1 子代理工具名写的规则会继续透明匹配」。

### 10.5 远端子代理（A2A）

`packages/core/src/agents/` 里有一整套 A2A（Agent2Agent）客户端：
`a2a-client-manager.ts`、`remote-invocation.ts`、
`remote-session-invocation.ts`、`remote-subagent-protocol.ts`、
`a2a-errors.ts`，依赖 **`@a2a-js/sdk` 0.3.11**。
另有独立包 `@google/gemini-cli-a2a-server`（21 文件 5,160 行）做服务端。

`docs/core/remote-agents.md`（457 行）给出 4 种鉴权方式：

| 方式 | 键 |
| --- | --- |
| API key | `apiKey` |
| HTTP 认证 | `http` |
| Google ADC | `google-credentials` |
| OAuth 2.0 | `oauth` |

出厂策略对远端的态度与本地不同——文档 `policy-engine.md:490-493` 写：
「**Agent delegation 默认 `ask_user`** 以便远端 agent 能弹确认，
而本地子代理的动作是静默执行、逐个单独检查的」。
⚠ 这句与 `agents.toml` 里那条 `invoke_agent → allow` 看起来存在张力
（`invoke_agent` 是本地远端统一入口）。
本文未追清「远端调用具体由哪条规则收口」，列入 §19。

`registry.ts:449-543` 的 `registerRemoteAgent()` 有一处值得注意的设计：
agent card 拉取失败（404 / 401 / 403 / 网络错误）或需要鉴权时，
**仍然注册这个 agent**，只记错误——注释写明
"Still register the agent — the user can fix config and retry."

---

## 11. 上下文管线

`packages/core/src/context/` 49 个非测试文件 8,519 行，是个独立的管线系统，
不是散落的截断函数。

### 11.1 8 个处理器

`context/processors/`：

| 处理器 | 作用 |
| --- | --- |
| `historyTruncationProcessor.ts` | 历史截断 |
| `nodeTruncationProcessor.ts` | 单节点截断 |
| `nodeDistillationProcessor.ts` | 节点蒸馏 |
| `rollingSummaryProcessor.ts` | 滚动摘要 |
| `toolMaskingProcessor.ts` | 工具输出遮蔽 |
| `blobDegradationProcessor.ts` | **二进制/大对象降级** |
| `stateSnapshotProcessor.ts` | 状态快照 |
| `stateSnapshotAsyncProcessor.ts` | 异步状态快照 |

配套 `context/pipeline/`（`orchestrator.ts`、`contextWorkingBuffer.ts`、
`inbox.ts`、`environment.ts`）与 `context/graph/`（8 个文件，
把上下文建模成图：`toGraph.ts` / `fromGraph.ts` / `nodeIdService.ts` /
`behaviorRegistry.ts` / `render.ts`）。

**「上下文是图，不是数组」** 是这套设计的核心假设——
有 `nodeIdService` 说明每个上下文节点有稳定标识，
这是「只重写某一节点而不动其余」的前提。

### 11.2 `generalist` profile 的具体数值

`context/profiles.ts:8-27` 是少见的把阈值全摊开写的配置，全文如下量级：

| 项 | 值 |
| --- | --- |
| `historyWindow.maxTokens` | **150,000** |
| `historyWindow.retainedTokens` | **80,000** |
| `messageLimits.normalMaxTokens` | 3,000 |
| `messageLimits.retainedMaxTokens` | 30,000 |
| `messageLimits.normalizationHeadRatio` | 0.15 |
| `tools.distillation.maxOutputTokens` | 10,000 |
| `tools.distillation.summarizationThresholdTokens` | 20,000 |
| `tools.outputMasking.protectionThresholdTokens` | 50,000 |
| `tools.outputMasking.minPrunableThresholdTokens` | 30,000 |
| `tools.outputMasking.protectLatestTurn` | `true` |

读法：历史窗口到 15 万 token 触发处理、保留 8 万；
单条消息常态上限 3 千 token，被「保留」的消息放宽到 3 万；
工具输出超 2 万 token 走摘要、蒸馏后上限 1 万；
遮蔽层在 5 万 token 以上启动且**最新一轮受保护不被裁**。

`normalizationHeadRatio: 0.15` 意味着截断时保留头部 15%——
即「开头的指令比中段更重要」这个假设被写进了常量。

### 11.3 压缩阈值

`context/chatCompressionService.ts:41`：

```ts
const DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5;
```

即**上下文用到模型窗口的 50% 就触发压缩**（第 274 行使用），
比常见的 0.7~0.8 激进不少。配套有 `contextCompressionService.ts`、
`toolDistillationService.ts`、`toolOutputMaskingService.ts`、
`memoryContextManager.ts`、`agentHistoryProvider.ts`。

压缩本身可被 hook 拦（`PreCompress`，§9.1），
也会向上层发 `ChatCompressed` 事件（§4.2）。

### 11.4 JIT 上下文

`packages/core/src/tools/jit-context.ts`（86 行）实现「按需注入项目上下文」：
`JIT_CONTEXT_PREFIX`（第 45 行）与 `JIT_CONTEXT_SUFFIX = '\n--- End Project
Context ---'`（第 47 行），通过 `appendJitContext()` / `appendJitContextToParts()`
挂到请求上。

对应的行为文档在 `docs/cli/gemini-md.md:30-36`：
**当工具访问某个文件或目录时，CLI 自动扫描该目录及其祖先直到「受信根」
里的 `GEMINI.md`**——即第三层上下文（前两层是全局与项目级）是**惰性的、
由工具访问触发的**。

CLI 底栏会显示已加载的上下文文件数量（同文档第 37-38 行）。

⚠ 注意本文的 shallow clone 里，能看到的最早提交（2026-03-19）恰好就是
"feat(core): cap JIT context upward traversal at git root (#23074)"——
说明「向上遍历到 git root 为止」这个边界是后加的。
**但由于 clone 是 shallow，本文无法确认 JIT 上下文最初是哪个版本引入的**（§19）。

---

## 12. 配置系统

### 12.1 七层优先级

`docs/reference/configuration.md:7-21`，从低到高：

| # | 层 |
| --- | --- |
| 1 | 硬编码默认值 |
| 2 | **System defaults 文件**（可被其他文件覆盖） |
| 3 | User settings（`~/.gemini/settings.json`） |
| 4 | Project settings（`$PROJECT/.gemini/settings.json`） |
| 5 | **System settings 文件**（覆盖所有其他文件） |
| 6 | 环境变量（含 `.env`） |
| 7 | 命令行参数 |

**注意第 2 层与第 5 层是两个不同的系统级文件**：
`system-defaults.json`（垫底，可被项目覆盖）与 `settings.json`（压顶，覆盖一切）。
管理员因此有两种下发方式：给建议值还是给硬约束。
两者路径分平台，且各有环境变量可覆盖
（如 `GEMINI_CLI_SYSTEM_DEFAULTS_PATH`）。

| 平台 | system defaults 路径 |
| --- | --- |
| Linux | `/etc/gemini-cli/system-defaults.json` |
| Windows | `C:\ProgramData\gemini-cli\system-defaults.json` |
| macOS | `/Library/Application Support/GeminiCli/system-defaults.json` |

仓库提供 JSON Schema：`schemas/settings.schema.json`，
可直接给编辑器做补全与校验。

### 12.2 settings 规模（脚本统计）

`packages/cli/src/config/settingsSchema.ts` 共 **3,617 行**。
脚本从其中提取：

| 维度 | 数量 |
| --- | --- |
| `label:` 字段 | **301** |
| 带 `category:` 标注 | 264 |

类型分布（`type:` 字段计数）：

| 类型 | 数量 |
| --- | --- |
| boolean | 135 |
| string | 131 |
| object | 101 |
| array | 51 |
| number | 25 |
| enum | 15 |

分类分布（`category:` 计数，共 14 类）：

| 分类 | 数量 |
| --- | --- |
| Advanced | 49 |
| UI | 44 |
| **Experimental** | **39** |
| General | 29 |
| Security | 18 |
| Tools | 17 |
| Model | 16 |
| Context | 15 |
| Context Management | 15 |
| Admin | 10 |
| MCP | 4 |
| IDE | 3 |
| Extensions | 3 |
| Privacy | 2 |

**Experimental 有 39 项**，占带分类项的 15%——
这是一个「大量能力尚在灰度」的直接量化信号。
`docs/cli/settings.md` 也有独立的 `### Experimental` 一节。

⚠ 口径说明：301 个 `label` **不等于 301 个用户可写的配置键**——
嵌套对象自身也带 label。这里只作规模量级，不作「配置项数」的精确断言。

### 12.3 落盘路径

`GEMINI_DIR = '.gemini'`（`packages/core/src/utils/paths.ts:13`）。
`packages/core/src/config/storage.ts` 的静态方法给出全局与项目两套路径：

| 方法 | 位置 |
| --- | --- |
| `getGlobalGeminiDir()` | `~/.gemini`（**取不到 home 时回落到 `os.tmpdir()`**，第 57 行） |
| `getGlobalAgentsDir()` | 全局 agents |
| `getUserCommandsDir()` | 用户自定义命令 |
| `getUserSkillsDir()` | 用户 skills |
| `getUserAgentSkillsDir()` | `~/.agents/skills` 别名 |
| `getUserPoliciesDir()` | 用户策略 |
| `getSystemPoliciesDir()` | 系统策略 |
| `getGlobalBinDir()` | 全局 bin |
| `getProjectTempDir()` | 项目临时目录 |

项目临时目录下的子目录（同文件）：
`memory`（286）、`checkpoints`（314）、`logs`（318）、
`plans`（323）、`tracker`（330）、`tasks`（357）、`chats`（365）。
其中 `plans` / `tracker` / `tasks` 三个**有按 sessionId 再分一层的分支**，
即这些数据可以是会话隔离的。

会话历史另放全局：`~/.gemini/history/<shortId>`（第 244-278 行），
且有一段从旧 hash 目录迁移到新 shortId 目录的逻辑（`storageMigration.ts`）。

### 12.4 环境变量与 CLI 参数

**文档侧**（`docs/reference/configuration.md` 的环境变量段，脚本提取
全大写反引号标识符）共 **50 个**，但这个数字混入了示例里的非本产品变量
（如 `DATABASE_URL`、`PASSWORD`、`SECRET`——那些出自「环境变量脱敏」一节的示例）。
**真正 `GEMINI_*` / `GOOGLE_*` 前缀的约 30 个**，包括：

`GEMINI_API_KEY`、`GEMINI_MODEL`、`GEMINI_SANDBOX`、`GEMINI_CLI_HOME`、
`GEMINI_SYSTEM_MD`、`GEMINI_WRITE_SYSTEM_MD`、`GEMINI_CLI_SURFACE`、
`GEMINI_CLI_IDE_PID`、`GEMINI_CLI_TRUST_WORKSPACE`、
`GEMINI_CLI_TRUSTED_FOLDERS_PATH`、
`GEMINI_TELEMETRY_*`（9 个：`ENABLED`/`TARGET`/`OTLP_ENDPOINT`/
`OTLP_PROTOCOL`/`OUTFILE`/`LOG_PROMPTS`/`TRACES_ENABLED`/`USE_COLLECTOR` 等）、
`GOOGLE_API_KEY`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、
`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_GEMINI_BASE_URL`、
`GOOGLE_VERTEX_BASE_URL`、`GOOGLE_GENAI_API_VERSION`、
`CODE_ASSIST_ENDPOINT`、`SEATBELT_PROFILE`、`OTLP_GOOGLE_CLOUD_PROJECT`。

另有在文档里没出现、但 §5.1 提到的三个：
`GOOGLE_GENAI_USE_GCA`、`GOOGLE_GENAI_USE_VERTEXAI`、
`GEMINI_CLI_USE_COMPUTE_ADC`。

**CLI 参数侧有一处文档缺口**（脚本对比 yargs 源码与两份文档）：

`packages/cli/src/config/config.ts` 的 `.option()` 调用共 **30 个**（去重后），
`docs/reference/configuration.md` 的参数段只列了 22 个，
`docs/cli/cli-reference.md` 列了 30 个。**两份文档并集覆盖 23/30**，
以下 **7 个参数在两份文档里都查不到**：

| 未文档化参数 | 猜测用途（**未核验**） |
| --- | --- |
| `--policy` | 指定策略文件 |
| `--admin-policy` | 指定 admin 策略（§7.3 提到过） |
| `--session-id` | 指定会话 ID |
| `--session-file` | 指定会话文件 |
| `--raw-output` | 原始输出 |
| `--accept-raw-output-risk` | 配合上一条的风险确认 |
| `--fake-responses-non-strict` | 测试用（配合 `--fake-responses`） |

反向地，文档里出现但不在 `.option()` 里的有 10 个
（`--help`、`--version`、`--all`、`--scope`、`--transport`、`--env`、
`--include-tools`、`--ref`、`--auto-update`、
`--experimental-zed-integration`）——
**其中多数是子命令的参数**（`gemini mcp add --transport`、
`gemini extensions install --ref` 之类），yargs 在别处注册，
不是文档写错。`--help` / `--version` 由 yargs 自动提供。

⚠ 本文未核验那 7 个未文档化参数的实际语义，只能证明「源码有、文档无」。

### 12.5 `GEMINI.md` 的三层上下文

`docs/cli/gemini-md.md` 定义三层（第三层见 §11.4）：

1. 全局（`~/.gemini/GEMINI.md`）
2. 项目/祖先目录
3. **JIT：工具访问触发的按需加载**

配套 `docs/reference/memport.md` 讲 import 机制，
`docs/cli/gemini-ignore.md` 讲 `.geminiignore`。
系统提示词可整体替换：`GEMINI_SYSTEM_MD` / `GEMINI_WRITE_SYSTEM_MD`
（`docs/cli/system-prompt.md`）。

---

## 13. 命令、Skills 与扩展

### 13.1 斜杠命令

`packages/cli/src/ui/commands/` 有 **47 个命令文件**（脚本数 `.ts` + `.tsx`，
排除测试与 `types.ts`）；`docs/reference/commands.md` 的 `### /xxx` 小节 **38 个**。
**差的 10 个见本节末尾** —— 那是「源码有、参考页未单列」的部分。

命令清单（按文档小节）：
`/about`、`/agents`、`/auth`、`/bug`、`/chat`、`/clear`、`/commands`、
`/compress`、`/copy`、`/directory`（`/dir`）、`/docs`、`/editor`、
`/extensions`、`/help`（`/?`）、`/hooks`、`/ide`、`/init`、`/mcp`、
`/memory`、`/model`、`/permissions`、`/plan`、`/policies`、`/privacy`、
`/quit`（`/exit`）、`/restore`、`/rewind`、`/resume`、`/settings`、
`/shells`（`/bashes`）、`/setup-github`、`/skills`、`/stats`、
`/terminal-setup`、`/theme`、`/tools`、`/upgrade`、`/vim`。

**源码有、参考页没有 `###` 小节的 10 个**（脚本按文件名推导命令名后做集合差）：

| 推导命令名 | 源码文件 |
| --- | --- |
| `/bug-memory` | `bugMemoryCommand.ts` |
| `/corgi` | `corgiCommand.ts`（彩蛋） |
| `/export-session` | `exportSessionCommand.ts` |
| `/footer` | `footerCommand.tsx` |
| `/gemma-status` | `gemmaStatusCommand.ts` |
| `/oncall` | `oncallCommand.tsx` |
| `/profile` | `profileCommand.ts` |
| `/shortcuts` | `shortcutsCommand.ts` |
| `/tasks` | `tasksCommand.ts` |
| `/voice` | `voiceCommand.ts` |

⚠ **口径两处必须说清**：
（1）上表的命令名是**从文件名推导的**（`fooBarCommand.ts` → `/foo-bar`），
不是从每个文件里的 `name:` 字段读的——**实际注册名可能不同**，本文未逐个核对；
（2）反向差只有 1 个：`/shells`（`/bashes`）**在文档里有小节但没有同名文件**
（`shellsCommand.ts` 不存在），说明它在别处注册。

`/oncall`、`/profile`、`/footer` 这三个看起来是内部/调试向的，
`/gemma-status` 对应 §5.3 的本地 Gemma 路由。

**`/policies` 与 `/permissions` 是两个命令**——前者查 TOML 规则，
后者是权限 UI。配 §7 一起看。

自定义命令：`docs/cli/custom-commands.md`，放 `~/.gemini/commands/`
（`getUserCommandsDir()`，§12.3）。

### 13.2 键盘快捷键

`docs/reference/keyboard-shortcuts.md` 有 **160 行表格行**（脚本数，
已排除 `|---|` 分隔行但仍含各表表头，故实际快捷键条目略少于 160），分 9 个小节，
其中 5 节是 **Vi 模式**（模式切换 / NORMAL 导航 / NORMAL 编辑 /
查找替换 yank paste / 限制）。快捷键可自定义（"Customizing Keybindings"）。

### 13.3 Skills

`packages/core/src/skills/` 只有 `skillLoader.ts` + `skillManager.ts`
（405 行），**内置 skill 有 2 个**：

| skill | 内容 |
| --- | --- |
| `skill-creator` | `SKILL.md` + 3 个 `.cjs` 脚本（`init_skill` / `validate_skill` / `package_skill`） |
| `antigravity-support` | 仅 `SKILL.md` |

**四层发现优先级**（`docs/cli/skills.md:35-48`，低→高）：

| # | 来源 | 路径 |
| --- | --- | --- |
| 1 | 内置 | 随 CLI |
| 2 | 扩展 | 扩展包内 |
| 3 | 用户 | `~/.gemini/skills/` 或 `~/.agents/skills/` |
| 4 | 工作区 | `.gemini/skills/` 或 `.agents/skills/` |

**注意这里与策略引擎的层级方向相反**：skills 是**工作区最高**（第 4 层压顶），
而策略里工作区低于 user（且整层被禁，§7.6）。
同层内 `.agents/skills/` 优先于 `.gemini/skills/`。

`.agents/skills/` 这个别名是刻意的跨工具兼容路径——
文档措辞是 "remains compatible across different AI tools"。

`activate_skill` 是出厂默认 `ask_user` 的（`write.toml`，§7.4）——
**即加载一个 skill 被当作写操作对待**，因为它会往上下文注入内容。

### 13.4 扩展

`docs/extensions/reference.md`（361 行）定义 `gemini-extension.json`，
一个扩展可以携带：

| 能力 | 文档小节 |
| --- | --- |
| 自定义命令 | 229 |
| Hooks | 240 |
| Agent skills | 246 |
| 子代理 | 252 |
| **策略引擎规则** | 261 |
| 主题 | 301 |

即扩展是**贯穿全部子系统的分发单元**，且它在策略里有专属 tier（2，§7.3）。
有冲突解决（第 346 行）与变量替换（第 352 行）机制。
`packages/core/src/config/extensions/integrity.ts` 做完整性校验。

管理命令：`gemini extensions install / uninstall / disable / enable /
update / link`，以及从模板创建。

### 13.5 企业管控

`docs/admin/enterprise-controls.md`（176 行）。
关键区别写在第 11-16 行：**System settings 是「方便的覆盖」，
有足够权限的用户仍能改；Admin Controls 才是本地不可覆盖的**。

三项控制及其默认值：

| 控制 | 默认 | 效果 |
| --- | --- | --- |
| **Strict Mode** | **启用** | 用户**无法进入 yolo 模式** |
| Extensions | **禁用** | 用户不能用/装扩展 |
| MCP | **禁用** | 用户不能用 MCP server |
| MCP Servers 白名单（preview） | 空 | 只允许组织指定的 server |

**默认值方向值得注意**：Strict Mode 默认「开」（即默认禁 yolo），
而 Extensions 与 MCP 默认「关」（即默认不允许）。
这是企业侧「默认收紧」的姿态。管控面板在 `https://goo.gle/manage-gemini-cli`。

文档第 170 行另有 "Unmanaged Capabilities" 一节——
**它自己列出了哪些能力管不住**。⚠ 本文未逐条核验该清单。

---

## 14. MCP 集成

### 14.1 客户端与服务端双向

仓库 topics 同时挂了 `mcp-client` 与 `mcp-server`——
它既作为 MCP 客户端连别人，也能被别人当 server 连（走 ACP，§15.2）。
依赖是 **`@modelcontextprotocol/sdk` 1.23.0**（core 与 cli 两个包都装）。

### 14.2 三种传输

`packages/core/src/tools/mcp-client.ts` 引入的 transport 类（实查 import）：

| Transport | 行 |
| --- | --- |
| `StdioClientTransport` | 19 |
| `SSEClientTransport` | 16 |
| `StreamableHTTPClientTransport` | 21 |

另有 `mcp-compliance-transport.ts`——一个专门处理协议合规性的包装层。

### 14.3 鉴权：一整个子目录

`packages/core/src/mcp/`（13 文件 2,336 行）几乎全是鉴权：

| 文件 | 作用 |
| --- | --- |
| `mcp-oauth-provider.ts` | MCP OAuth |
| `oauth-provider.ts` / `oauth-utils.ts` | 通用 OAuth |
| `oauth-token-storage.ts` | token 落盘 |
| `google-auth-provider.ts` | Google 凭据 |
| `sa-impersonation-provider.ts` | **服务账号模拟** |
| `stored-token-provider.ts` | 已存 token |
| `token-storage/` | 存储后端子目录 |

凭据存储另有 `services/keychainService.ts` 与 `services/fileKeychain.ts`
（系统钥匙串 + 文件回落），且带遥测
`gemini_cli.keychain.availability`（§16.2）——
**「钥匙串能不能用」是被上报的**，说明文件回落的发生率被关注。

### 14.4 策略侧的 MCP 匹配

这是 §7 的延伸，但有一个**会静默失效的陷阱**，文档
`policy-engine.md:409-417` 用 WARNING 标出：

> **MCP server 名字里不要用下划线。**
> 策略解析器把 FQN（`mcp_server_tool`）按 `mcp_` 前缀**之后的第一个下划线**切分。
> 如果 server 名含下划线，解析器会误判 server 身份，
> **导致通配规则与安全策略静默失败**（"fail silently"）。

正确做法是用 `mcpName` 字段而不是手写 FQN：

```toml
# 推荐：mcpName + 简单工具名
[[rule]]
mcpName = "my-jira-server"
toolName = "search"        # 不是 mcp_my-jira-server_search
decision = "allow"
priority = 200

# 整个 server 全禁
[[rule]]
mcpName = "untrusted-server"
decision = "deny"
priority = 500
denyMessage = "This server is not trusted by the admin."

# 所有 MCP server 的所有工具都要问
[[rule]]
toolName = "*"
mcpName = "*"
decision = "ask_user"
priority = 10
```

源码侧 `MCP_TOOL_PREFIX = 'mcp_'`（`tools/mcp-tool.ts:37`），
`policy-engine.ts:66-78` 的 `matchesWildcard()` 处理三种形态：
`*`（全匹配）、`mcp_*`（任意 MCP 工具，判据是 `serverName !== undefined`）、
`mcp_<server>_*`（指定 server，三重校验：有 serverName、名字相等、
工具名确实以该前缀开头）。**不认识的通配形态回落到精确相等**（第 81 行）。

§7.5 提到的四个 MCP 相关派生优先级（4.9 排除 / 4.2 trust / 4.1 允许名单）
在这里生效。企业侧还有 admin 的 server 白名单（§13.5）。

### 14.5 MCP 资源

`read_mcp_resource` / `list_mcp_resources` 两个内置工具（§6.1）
把 MCP 的 resource 概念也接了进来——不只是 tools。
两者都在出厂 `read-only.toml` 的 18 个放行名单里。
另有 `prompts/mcp-prompts.ts` 处理 MCP prompts。

---

## 15. IDE 集成与 ACP

### 15.1 24 种 IDE 识别

`packages/core/src/ide/detect-ide.ts:7` 的 `IDE_DEFINITIONS` 常量，
脚本提取 **24 个条目**：

| 类别 | 条目 |
| --- | --- |
| VS Code 系 | `vscode`（VS Code）、**`vscodefork`（显示名就叫 "IDE"）**、`cursor`、`positron`、`trae`、`antigravity` |
| JetBrains 系 | `jetbrains`（通用）、`intellijidea`、`webstorm`、`pycharm`、`goland`、`androidstudio`、`clion`、`rustrover`、`datagrip`、`phpstorm` |
| 云 IDE | `cloudshell`、`codespaces`、`firebasestudio`、`replit`、`devin` |
| 其他 | `zed`、`xcode`、`sublimetext` |

**`vscodefork` 的 displayName 是 `'IDE'`** ——
即遇到未知的 VS Code 派生版时，退化成中性显示名而不是猜品牌。
`antigravity` 也在列（与 §13.3 那个内置 skill `antigravity-support` 呼应）。

### 15.2 两条集成路径

| 路径 | 载体 | 说明 |
| --- | --- | --- |
| **VS Code companion 扩展** | `packages/vscode-ide-companion`（5 文件 1,177 行） | 有独立 spec 文档 `ide-companion-spec.md` |
| **ACP（Agent Client Protocol）** | `packages/cli/src/acp/`（16 文件 3,799 行） | 依赖 `@agentclientprotocol/sdk` 0.16.1 |

ACP 是**让 Gemini CLI 作为 agent 被 IDE 调用**的协议，
`--acp` 参数进入该模式（另有 `--experimental-acp` 旧名，两个都在 yargs 里）。
Gemini CLI 已登记在 **ACP Agent Registry**，JetBrains 与 Zed 走这条路。

ACP 能力分四组（`docs/cli/acp-mode.md:73-101`）：
核心方法、会话控制、**文件系统代理**（file system proxy）、以及 MCP 扩展。
「文件系统代理」意味着文件读写可以走 IDE 而不是直接落盘——
这是编辑器里未保存缓冲区能被看到的前提。

`packages/cli/src/acp/` 有 3,799 行，比 VS Code 扩展本体（1,177 行）大 3 倍，
说明重心在通用协议而非单一编辑器插件。

### 15.3 沙箱下的 IDE 集成

`docs/cli/sandbox.md:267-296` 有 "Tool sandboxing" 与
`ide-integration/index.md:210` 有 "Using with sandboxing"——
两者交叉时有专门说明。`ide/process-utils.ts` 与
`GEMINI_CLI_IDE_PID` 环境变量用于跨进程认亲。

---

## 16. 遥测与可观测性

`packages/core/src/telemetry/` 30 个非测试文件 **12,547 行**——
比策略引擎 + Hook + 沙箱三者相加还多。

### 16.1 OTel 原生

依赖里有 **18 个 `@opentelemetry/*` 包**（core 的 `package.json` 实查），
含 traces / metrics / logs 三类的 OTLP gRPC 与 HTTP 两种 exporter，
以及 `@google-cloud/opentelemetry-cloud-monitoring-exporter` 与
`-cloud-trace-exporter` 两个 GCP 直连 exporter。

语义约定走 GenAI 那套（`telemetry/constants.ts:12-28`）：
`gen_ai.operation.name`、`gen_ai.agent.name`、`gen_ai.input.messages`、
`gen_ai.output.messages`、`gen_ai.request.model`、`gen_ai.response.model`、
`gen_ai.tool.name`、`gen_ai.tool.call_id`、`gen_ai.tool.description`、
`gen_ai.tool.definitions`、`gen_ai.usage.input_tokens`、
`gen_ai.usage.output_tokens`、`gen_ai.system_instructions`、
`gen_ai.agent.description`、`gen_ai.prompt.name`、`gen_ai.conversation.id`
共 **16 个属性名**（脚本对 `'gen_ai.*'` 字面量去重后计数）。

`GeminiCliOperation` 枚举（同文件第 31-38 行）6 个操作：
`tool_call`、`llm_call`、`user_prompt`、`system_prompt`、
`agent_call`、`schedule_tool_calls`。

### 16.2 62 个指标 / 事件名

`docs/cli/telemetry.md`（**1,277 行**，全仓最长的文档）里
`gemini_cli.*` 命名的指标与事件，脚本去重后 **62 个**。分类摘要：

| 组 | 示例 |
| --- | --- |
| API | `api_request`、`api_response`、`api_error`、`api.request.count`、`api.request.latency` |
| 工具 | `tool_call`、`tool.call.count`、`tool.call.latency`、`tool.queue.depth`、`tool.execution.breakdown`、`tool_output_masking`、`tool_output_truncated` |
| Agent | `agent.start`、`agent.finish`、`agent.turns`、`agent.duration`、`agent.run.count`、`agent.recovery_attempt` |
| 上下文 | `chat_compression`、`token.usage` |
| 路由 | `model_routing`、`model_routing.latency`、`model_routing.failure.count`、`flash_fallback` |
| 会话 | `session.count`、`conversation_finished`、`startup.duration`、`startup_stats` |
| 韧性 | `chat.content_retry`、`chat.content_retry_failure`、`chat.invalid_chunk`、`malformed_json_response` |
| 安全 | **`conseca.verdict`**、`hook_call` |
| 资源 | `cpu.usage`、`memory.usage` |
| 交互 | `slash_command`、`rewind`、`ide_connection`、`ui.flicker.count` |
| 扩展 | `extension_install` / `_uninstall` / `_enable` / `_disable` |
| 其他 | `keychain.availability`、`ripgrep_fallback`、`web_fetch_fallback_attempt`、`edit_strategy`、`edit_correction`、`file_operation`、`lines.changed`、`onboarding.start` / `.success`、`plan.execution.count` |

**埋点接线情况**：`telemetry/loggers.ts` 有 **47 个 `export function log*`**
（脚本 `grep -c`），从 `logCliConfiguration` 到 `logBrowserAgentCleanup`。
即上面那批名字不是「定义了没用」——**有 47 个对应的调用入口**。

⚠ 未核验：本文没有统计这 47 个 logger 各自的**生产调用点数量**，
也没跑起来看实际产出。「定义齐全」不等于「全部接线」。

### 16.3 几个值得单看的指标

- **`ui.flicker.count`** —— 把「终端闪屏」当指标上报。
  TUI 重绘质量被量化，这在 CLI 产品里少见。
- **`tool.queue.depth`** —— 工具调用有队列且深度被观测（配 §4 的 scheduler）。
- **`edit_strategy` / `edit_correction`** —— 编辑策略与「自动纠错」被分开计数，
  说明 `replace` 的失败-重试有专门的可观测性。
- **`ripgrep_fallback`** —— 见 §6.4，降级路径可观测。
- **`web_fetch_fallback_attempt`** —— `web_fetch` 也有降级路径。

其他基础设施：`activity-monitor.ts` / `activity-detector.ts`（活跃度）、
`event-loop-monitor.ts`（事件循环阻塞）、`memory-monitor.ts` +
`heap-snapshot.ts`（堆快照）、`high-water-mark-tracker.ts`（峰值）、
`rate-limiter.ts`（上报限流）、`sanitize.ts`（脱敏）、
`startupProfiler.ts`（启动剖析）、`clearcut-logger/`（Google 内部通道）。

配置侧：`GEMINI_TELEMETRY_*` 系列 9 个环境变量（§12.4），
target 可选 GCP 或本地文件（`file-exporters.ts`），
`docs/cli/telemetry.md` 分 Google Cloud / Local 两套流程写。
另有 `docs/reference/configuration.md:3053` 的 "Usage statistics" 一节讲隐私口径。

---

## 17. 版本时间线与发版节奏

本节全部数据来自 **npm registry 实查**（`registry.npmjs.org/@google/gemini-cli`
落盘后脚本统计），**不使用 git 历史**——原因见文首的 shallow clone 声明。

### 17.1 三通道并行

698 个版本按后缀分类：

| 通道 | 数量 | 占比 |
| --- | --- | --- |
| **stable**（无后缀） | **191** | 27.4% |
| **nightly** | **244** | 34.9% |
| **preview** | **236** | 33.8% |
| 其他预发（`-rc.*` 等） | 27 | 3.9% |

`-rc.*` 那 27 个集中在 2025-06 的最早期（如 `0.1.3-rc.0`、`0.1.4-rc.4`），
之后被 nightly/preview 双轨取代。

### 17.2 节奏

| 指标 | 值 |
| --- | --- |
| 首个版本 | **0.1.0，2025-06-25** |
| 最新（快照时） | **0.54.4，2026-08-07** |
| 跨度 | **409 天** |
| 总版本数 | 698 |
| 平均 | **0.59 天/版本**（含全部通道） |
| stable 平均 | **2.14 天/版本** |
| minor 系列数 | 54（0.1 → 0.54） |

**即稳定版平均 2.1 天一个，全通道算下来一天不止一个。**

按月分布（`time` 字段前 7 位聚合）：

| 月份 | 版本数 | | 月份 | 版本数 |
| --- | --- | --- | --- | --- |
| 2025-06 | 23 | | 2026-01 | 44 |
| 2025-07 | 34 | | 2026-02 | 67 |
| 2025-08 | 30 | | 2026-03 | 54 |
| 2025-09 | **88** | | 2026-04 | 43 |
| 2025-10 | 72 | | 2026-05 | 36 |
| 2025-11 | 70 | | 2026-06 | **29** |
| 2025-12 | 64 | | 2026-07 | 34 |
| | | | 2026-08（截至 08） | 10 |

**峰值在 2025-09（88 个），此后逐步回落到 30-40/月。**
可读为「早期高频迭代 → 逐渐稳定」，但也可能只是 nightly 策略变化。
⚠ 本文未核验回落的原因。

### 17.3 快照时四个 dist-tag 的错位

```
latest       = 0.54.4                                  (2026-08-07)
preview      = 0.55.0-preview.2                        (2026-08-07)
nightly      = 0.56.0-nightly.20260808.gcf22ac7e8      (2026-08-08)
staging-tmp  = 0.56.0-nightly.20260808.gcf22ac7e8      (同上)
false        = 0.42.0-nightly.20260512.g11a9edc80      (2026-05-12)
```

两处值得记：

1. **三通道恰好差一个 minor**（54 / 55 / 56），即 preview 是下一个 minor 的预览，
   nightly 是再下一个的日构建。这是个规整的三级流水线。
2. **有一个叫 `false` 的 dist-tag**，指向 2026-05-12 的一个 nightly。
   这几乎肯定是某次发布脚本把布尔值当 tag 名传进去了
   （`npm publish --tag $SOMEVAR` 里 `$SOMEVAR` 求值成 `false`），
   之后被遗留在 registry 上。`staging-tmp` 也是内部流程的残留。
   **这类痕迹是「高频自动化发布」的副产品**，无害但能说明流水线形态。

### 17.4 版本号与 commit 的绑定

nightly 版本号形如 `0.56.0-nightly.20260808.gcf22ac7e8`——
**日期 + `g` + commit 短哈希**都编进了版本号。
本地 clone 的 HEAD 正是 `cf22ac7e`，与快照时的 nightly tag 对得上。
仓库内 `package.json` 写的是前一天的
`0.56.0-nightly.20260806.g761f604c1`，说明版本号由发布流水线改写而非手工维护。

changelog 也是机器生成的：`docs/changelogs/latest.md` 的
"What's Changed" 全是 `by @gemini-cli-robot in #28xxx` 形式的条目，
而 `gemini-cli-robot` 在本地 clone 的贡献者统计里排第一（73 个提交）。

---

## 18. 会话、检查点与回溯

这一组能力互相独立但常被混淆，本节把四者摆在一起对照。

| 能力 | 命令 | 落盘位置 | 粒度 |
| --- | --- | --- | --- |
| **会话恢复** | `/resume`、`--resume` | `~/.gemini/history/<shortId>` | 整个会话 |
| **检查点** | `/restore` | `<projectTemp>/checkpoints` | 工具执行前的快照 |
| **回溯** | `/rewind` | — | 对话轮次 |
| **对话保存** | `/chat save/resume` | `<projectTemp>/chats` | 命名快照 |

### 18.1 检查点靠 Git

`docs/cli/checkpointing.md`（95 行）：checkpointing **默认关闭**，
需 `--checkpointing` 或设置开启。机制是**在项目里维护一个影子 Git 仓库**，
在执行修改文件的工具前自动 commit。`services/gitService.ts` +
依赖 **`simple-git` 3.28.0** 实现。

### 18.2 回溯

`docs/cli/rewind.md`（51 行）——`/rewind` 交互式选择回退点。
有专属遥测 `gemini_cli.rewind`（§16.2）。
文档第 40 行的 "Key considerations" 是使用前该读的部分。
⚠ 本文未核验 rewind 与 checkpointing 是否共享底层快照。

### 18.3 会话录制

`services/chatRecordingService.ts` **1,102 行** + `chatRecordingTypes.ts`。
另有 `--record-responses` / `--fake-responses` 两个 CLI 参数
（§12.4）——**API 响应可录制回放**，
这就是 `integration-tests/` 里那批 `.responses` 文件的来源
（如 `browser-agent.screenshot.responses`）。
**即集成测试跑的是录制的真实响应，不是手写 mock。**

### 18.4 Git worktree 支持

`docs/cli/git-worktrees.md`（107 行）+ `services/worktreeService.ts` +
CLI 参数 `--worktree`（`-w`）。即「让 agent 在独立 worktree 里改代码」
是内置能力，不用用户自己 `git worktree add`。

### 18.5 Auto Memory

`docs/cli/auto-memory.md`（164 行）——自动把事实写进记忆。
本地 clone 能看到的最早提交里有一条
"feat(core): add experimental memory manager agent to replace save_memory tool
(#22726)"（2026-03-19），说明**记忆机制正从「工具」改造为「agent」**。
`services/memoryService.ts` + `memoryPatchUtils.ts` +
`context/memoryContextManager.ts` 三处分工。
注意 §6.1 的 27 个工具名里**已经没有 `save_memory`**——那次替换完成了。

`/memory` 命令仍在（文档有小节），`GEMINI.md` 走 §12.5 那条路。

---

## 19. 未能核验与存疑的部分

类型 IV 的硬性要求：把「没验证的」列清。**本文的证据形态是
「本地源码实查 + 仓库内文档源文件 + registry/API 实查」，
不是端到端实测**——下面按性质分组。

### 19.1 整类未核验：全部运行时行为

**我们没有把 Gemini CLI 跑起来。** 因此以下全部未验证：

- **5 种沙箱**（§8）一个都没启动过。隔离强度、逃逸面、
  Windows 那个 `icacls` 持久化副作用的实际表现，全部只有源码与文档依据。
- **Conseca 安全层**（§7.8）默认关闭，我们也没开。
  「LLM 动态生成策略」的实际效果完全未知。
- **Shell 安全边界**（§7.7）那张表是**从测试用例名读出的设计意图**，
  我们没跑那些用例，也没独立构造绕过尝试。
- **上下文管线**（§11）的 8 个处理器与那批阈值，没有实测触发。
- **循环检测**（§4.3）的三层判据没有实际触发过。
- **遥测**（§16）的 62 个指标没有实际产出验证；
  47 个 logger 的生产调用点数量也没统计。

### 19.2 两处做过实测的例外（及其口径）

诚实起见也要说清哪两处是真跑过的：

1. **§6.2 的 `isValidToolName()`** —— 用 `npx esbuild` 把
   `tool-names.ts` 单独打包成 CJS 后 `node` 执行，
   实际调用函数得到 `false` / `true`。这是真实函数返回值。
   ⚠ 但它只证明**那个函数**的行为，
   不证明「自定义子代理写这两个名字一定会报错」这条端到端路径
   （后者是从 `agentLoader.ts:103` 的 Zod `.refine()` 推的）。
2. **§7.5 的优先级复算** —— 用脚本从源码提取 tier 常量后按文档给的公式重算。
   这是**算术核验**，不是运行时核验：它证明「文档示例与源码常量不符」，
   不证明「引擎实际按这个公式跑」（后者依据是 `toml-loader.ts:300-307` 的代码）。

### 19.3 具体存疑项（逐条）

| # | 存疑 | 章节 |
| --- | --- | --- |
| 1 | 打包方式从「源码+依赖」切到「bundle+vendor」发生在哪个版本、为什么 | §3.3 |
| 2 | `0.54.0`→`0.54.4` 一个补丁号涨 23MB 的原因 | §3.3 |
| 3 | `read_many_files` 是否在别处被加入模型可见工具列表 | §6.3 |
| 4 | `ALWAYS_ALLOW_PRIORITY` 常量（3.95）与 TOML 注释（4.95）不一致的实际影响 | §7.5 |
| 5 | hooks 侧 `HookSource`（5 值、复数 `extensions`）与 policy 侧（4 值、单数 `extension`）的差异，是否导致扩展来源 hook 被误判为 `project` | §9.3 |
| 6 | `hookTranslator.ts` 那 15KB 翻译的是哪几种协议方言 | §9.5 |
| 7 | `agents.toml` 的 `invoke_agent → allow` 与文档「agent delegation 默认 ask_user」的张力，远端调用究竟由哪条规则收口 | §10.5 |
| 8 | JIT 上下文最初由哪个版本引入（shallow clone 无法回溯） | §11.4 |
| 9 | 7 个未文档化 CLI 参数的实际语义 | §12.4 |
| 10 | §13.1 那 10 个命令的**实际注册名**（本文是按文件名推导的） | §13.1 |
| 11 | `/shells` 在何处注册（无同名文件） | §13.1 |
| 12 | 企业管控文档自列的 "Unmanaged Capabilities" 清单未逐条核验 | §13.5 |
| 13 | `/rewind` 与 checkpointing 是否共享底层快照 | §18.2 |
| 14 | 2025-09 发版峰值（88 个）之后回落的原因 | §17.2 |

### 19.4 口径类说明（不是存疑，是数字的读法）

- **`open_issues_count` = 864 含 open PR**，不等于 864 个 bug（§1.4）。
- **settings 的 301 个 `label` 不等于 301 个用户可写配置键**——
  嵌套对象自身也带 label（§12.2）。
- **环境变量「50 个」混入了脱敏示例里的非本产品变量**
  （`PASSWORD` / `SECRET` 之类），真正 `GEMINI_*`/`GOOGLE_*` 前缀约 30 个（§12.4）。
- **键盘快捷键「160 行」已排除 `|---|` 分隔行但仍含各表表头**，
  实际条目略少于 160（§13.2）。
- **LOC 统计一律排除 `.test.` / `.spec.` 文件**，且只算 `packages/*/src/`
  下的 `.ts`/`.tsx`——不含 `integration-tests/`、`scripts/`、
  `evals/`、`sea/`、`third_party/`（§2）。

### 19.5 会最快过期的部分

按漂移速度排序，引用前优先复查：

1. **§17 的版本表** —— stable 2.1 天一个的节奏下，这张表一周就旧。
2. **§7.6 的 workspace 策略** —— 那个常量叫 "Temporary flag"，
   issue #18186 一修，整节作废。**这是本文最可能先过期的一节，
   也是过期了反而是好事的一节。**
3. **§7.5 与文首 danger 块的文档偏差** —— 这些是可修的文档 bug。
   修掉之后这几节就只剩史料价值。
4. **§5.2 的模型常量** —— `gemini-3.1-pro-preview` / `gemini-3.5-flash`
   这批 preview 名字变动最频繁；`PREVIEW_GEMINI_FLASH_LITE_MODEL = 'none'`
   这种占位显然是临时状态。
5. **§12.2 的 39 项 Experimental** —— 定义上就是要变的。

---

## 20. 附录：本文的核验方法

为了让你能复现或反驳本文的任何一条。

**计数类事实**：全部用 Python `re.findall` 从源码或原始 Markdown 数出，不目测。
例如 27 个工具名是先用 glob 扫 `packages/core/src/tools/**/*.ts`
建立「常量名 → 字符串字面量」的映射表，再解析
`ALL_BUILTIN_TOOL_NAMES` 数组把常量名解引用——
**因为那个数组里存的是常量引用而不是字面量，直接 grep 字符串会数不到。**
（第一版脚本就是这么错的：把 `GLOB_TOOL_NAME` 当成了工具名本身，
于是「源码有、文档无」的差集里冒出 21 个假阳性。发现 diff 结果不对称后重写了解引用逻辑。）

**源码类事实**：给出 `包/路径:行号`。跨文件对比（如 §6.2 的名单 vs 注册表、
§9.1 的 Hook 事件 vs 文档小节）都是脚本对两侧做集合差，
并且**两个方向都打印**——只看单向差会漏掉 §6.3 那种反向缺口。

**两处实跑**：见 §19.2，给了可复现的命令与完整输出。
`npx esbuild --bundle` 那条是为了绕开 TS 的 ESM 路径问题，
不需要先 `npm run build` 整个仓库。

**外部数据**：GitHub REST API 与 npm registry 全部 `curl -o` 落盘到
`/tmp/gemini/` 再用脚本只打印摘要——**原始 JSON 从不整份进上下文**
（`npm.json` 单文件就有 698 个版本的元数据）。
这是 `docs/reference/产品深入研究-通用提示词.md` §1 那条 32MB 铁律。

**文档源文件优先于渲染页**：读 `docs/**/*.md` 源文件而不是 geminicli.com。
这带来两个渲染页上拿不到的东西：一是 `policy/policies/*.toml`
**注释里那批 4.x 派生优先级**（§7.5，公开文档查不到）；
二是能看出 `docs/architecture` 这一页**已从仓库删除**（文首 danger 块第 3 条）——
只看还在线的镜像页是发现不了的。

**一处刻意的自我纠正**：§13.1 第一版写「44 个命令文件 / 文档 41 个小节」，
脚本复核实为 **47 / 38**（第一版漏了 `.tsx` 文件，且把文档小节数记错）。
§13.2 第一版写 175 行表格行，排除分隔行后是 160。
**这三个数字都改了**——数字必须能被读者当场加出来，
而不是「大概是这个量级」。

**关于 git 历史的自我约束**：本地 clone 是 shallow（974 提交、最早 2026-03-19），
因此本文**不用 git 做任何时间断言**。§18.5 与 §11.4 里两处引用了
「本地能看到的最早提交」，都明确标注了这个限制，
且只用来说明「某个改动存在」，不用来说明「何时首次引入」。
所有时间线走 npm registry（§17）。
