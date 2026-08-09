---
title: LiteLLM 深入研究（2026-08 快照）
description: 26 章逐节成册，按目录跳章查阅——把 LiteLLM 的产品形态、架构与实现细节交叉核验到版本号级别：Rust 核心已装进每个 wheel（占体积 84%）却默认关闭、五个数据源给出五个不同的 provider 数、9 种缓存后端、51 个回调白名单、49 个 guardrail、925 个环境变量、616 条代理路由。这是一份手册，不是读完就走的文章。
date: "2026-08-09"
series: 热点开源项目研究
audience: engineer
highlight: 26 章逐节可查 · 核验至 v1.95.0 / 本地源码 v1.97.0-dev.2 · 截至 2026-08-09 快照
tags: [LiteLLM, AI Gateway, 深入研究, Router, 可观测性, Guardrails, MCP, 参考]
outline: [2, 3]
---

# LiteLLM 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-09
- **被调研版本**：PyPI 最新稳定版 **1.95.0**（2026-08-02 发布）与 **1.94.2**（2026-08-08）；
  本地源码检出为 `litellm_internal_staging` 分支的 **v1.97.0-dev.2-104-g7b89b3a2**
  （`pyproject.toml` 里的 `version = "1.97.0"`）。
  **正文里凡是「源码实查」的计数，数的是这个 dev 检出，不是 1.95.0 的发布包**——
  两者可能差出一个 minor 的功能量，涉及具体数字的地方我会标明来源。
- **证据形态**：三类混合，逐条标注——
  ① **本地源码实查**（脚本计数，可复现）；
  ② **发布物实测**（PyPI registry + 真实下载 wheel 解包 + `pip download` 实跑）；
  ③ **公开信息**（官方文档源文件 `.md` / 官方博客 / GitHub API）。
  性能数字**全部是厂商口径，我们没有独立复现**，见 §22 与文末。
- **一手性说明**：文档类事实取自 **`BerriAI/litellm-docs` 仓库的 `.md` 源文件**
  （tarball 落盘后脚本摘要），不是渲染后的网页；
  Star 数、语言占比、发版时间线取自 GitHub REST API 与 PyPI JSON API 实查；
  wheel 内容取自真实下载的 `litellm-1.95.0-cp312-cp312-manylinux_2_28_x86_64.whl`。
- **时效边界**：LiteLLM 每周发一个 minor（§24），2026-06 一个月发了 **45 个版本**。
  **这是 2026-08-09 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://docs.litellm.ai/docs/)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 三条广为流传或看起来显然、但需要修正的说法
读 LiteLLM 的第三方分析（乃至它自己的 GitHub 简介）时，这三条几乎必然会遇到：

1. **「LiteLLM 是纯 Python 包」**——**2026-07-03 起不是了**。
   `pyproject.toml` 的 `build-backend` 现在是 **maturin**，
   发布物是**按 CPython ABI 与平台切分的二进制 wheel**。
   实测 `litellm-1.95.0-cp312-cp312-manylinux_2_28_x86_64.whl` 共 26.3MB，
   其中 `litellm/rust_bridge/_native.cpython-312-x86_64-linux-gnu.so` 一个文件
   就占 **22.11MB（84%）**。见 §3、§4。
2. **「Rust core with Python SDK」（GitHub 仓库简介的原话）**——
   这句话描述的是**方向，不是默认行为**。截至本快照，Rust 路径
   **默认关闭**，需要 `LITELLM_RUST=1` 环境变量或在模型上写 `rust: true` 才启用；
   启用后也只覆盖 **3 条路由**（Anthropic `/v1/messages` 的 `anthropic`/`azure_ai`、
   `bedrock` 音频转写、`openai` 的 Responses WebSocket），
   其余一切仍走 Python，且 Rust 侧任何异常都会**静默回退** Python。
   官方文档对此写得很清楚（`docs/proxy/rust_gateway.md` 明确标 Beta、opt-in、off by default），
   **是仓库简介比文档跑得快**。见 §3。
3. **「文档在主仓 `docs/my-website/` 下」**——**2026-04-24 起不在了**
   （commit `c35f3a50ae`「docs: remove docs/my-website, point contributors to litellm-docs」）。
   文档搬到独立仓库 **`BerriAI/litellm-docs`**（2026-04-17 创建，749 个 md/mdx）。
   照旧路径提 PR 或引用 raw 链接会直接 404。见 §23。

另有一条不算「过期说法」但值得先知道：**「支持 100+ providers」这个口径无法被单一数字复现**——
五个数据源给出 149 / 170 / 132 / 122 / 102 五个不同的数，且差异都有合理解释。见 §5。
:::

---

## 1. 产品概述与身份辨析

LiteLLM 是 BerriAI（Berri AI Inc.）开发的**开源 AI 网关**。
它最容易被误解的一点是：**"LiteLLM" 这个名字下面装着两个形态差别很大的产品**，
文档、依赖、部署方式都不同。

| | **Python SDK** | **AI Gateway（Proxy Server）** |
|---|---|---|
| 装什么 | `pip install litellm` | `pip install 'litellm[proxy]'` 或 Docker 镜像 |
| 怎么用 | 进程内 `import litellm` 调 `litellm.completion(...)` | 起一个 HTTP 服务，客户端按 OpenAI 格式请求它 |
| 核心入口 | `litellm/main.py`（8858 行，27 个公开函数） | `litellm/proxy/`（558 个 py 文件，274707 行） |
| 有没有状态 | 无（可选内存/Redis 缓存） | 有：Postgres（70 张表，§15）+ Redis |
| 谁的活 | 统一 100+ provider 的调用格式 | 再加上鉴权、配额、成本归集、审计、guardrail |

**判断你要哪个**：只想「换 provider 不改代码」用 SDK；
要「一个团队/公司共用一批模型额度并且要能算清账」用 Gateway。
本文的多数章节讲的是 Gateway，因为它是复杂度所在。

**核心数据（2026-08-09，GitHub API 与 PyPI 实查）：**

- GitHub Stars：**55,881**；Forks：**10,417**；Open Issues：**4,813**；Watchers：220
- 仓库创建：**2023-07-27**；最近 push：2026-08-08
- 语言占比：**Python 84.74%**、TypeScript 12.46%（Admin UI）、HTML 1.43%、
  **Rust 0.59%**、Go 0.21%、HCL 0.21%（Terraform）
- 许可：**MIT**，但 `enterprise/` 目录单独适用 BerriAI Enterprise License（§20）
- Python 要求：**`>=3.10, <3.15`**
- PyPI 最新稳定版：**1.95.0**（2026-08-02）；总发布数 **1229** 个（含 dev/rc）
- 核心运行时依赖只有 **13 个**（`httpx`、`openai`、`pydantic`、`tiktoken`、
  `tokenizers`、`aiohttp`、`jinja2`、`click`、`jsonschema`、`fastuuid`、
  `python-dotenv`、`importlib-metadata`、`pydantic-settings`）

::: tip 一个容易踩的仓库细节
**默认分支不是 `main`，是 `litellm_internal_staging`。**
GitHub API 的 `default_branch` 字段实测返回 `litellm_internal_staging`，
`main` 分支也存在但落后（本快照时 `main` 的最新提交是 2026-08-07，
`litellm_internal_staging` 是 2026-08-08）。
这意味着**你在 GitHub 网页上默认看到的代码是 staging 而不是发布分支**，
而 `raw.githubusercontent.com/.../main/...` 拿到的又是另一份。
引用源码行号时必须连带说明分支与 commit。
:::

## 2. 仓库结构与规模

以下计数全部来自本地源码（v1.97.0-dev.2 检出）脚本实查，非目测。

**顶层布局：**

| 路径 | 是什么 |
|---|---|
| `litellm/` | SDK + Proxy 本体，**2192 个 py 文件 / 694,230 行** |
| `litellm-rust/` | Rust workspace，3 个 crate（§3） |
| `enterprise/` | 企业版代码，单独许可（§20） |
| `litellm-proxy-extras/` | Proxy 的额外依赖包（uv workspace member） |
| `ui/litellm-dashboard/` | Admin UI（Next.js，对应语言统计里的 TypeScript 12.46%） |
| `tests/` | **2747 个 py 文件 / 1,174,700 行**——测试代码量是 `litellm/` 的 1.7 倍 |
| `schema.prisma` | 数据库 schema，**70 个 model** |
| `model_prices_and_context_window.json` | 定价表，**1.68MB / 2987 个模型条目**（§6） |
| `helm/litellm-helm/` | Helm chart（version 1.1.1、appVersion v1.85.1） |
| `terraform/` | AWS / GCP 部署模块 |
| `litellm-rust/` 之外的 `.rs` | 无 |

**`litellm/` 内部按行数排前十：**

| 子目录 | 文件数 | 行数 | 说明 |
|---|---|---|---|
| `proxy/` | 558 | 274,707 | 网关全部逻辑 |
| `llms/` | 882 | 183,488 | provider 适配层，**132 个子目录** |
| `integrations/` | 195 | 52,702 | 回调 / 可观测性（§11） |
| `litellm_core_utils/` | 70 | 33,779 | 通用工具、token 计数、流处理 |
| `types/` | 191 | 28,342 | 全量类型定义 |
| `responses/` | 15 | 12,884 | Responses API |
| `router_strategy/` | 29 | 9,168 | 路由策略（§8） |
| `caching/` | 19 | 7,365 | 缓存后端（§10） |
| `router_utils/` | 24 | 5,245 | 路由辅助 |
| `a2a_protocol/` | 29 | 4,583 | Agent-to-Agent 协议 |

**两个单体大文件**，改动它们是这个项目的主要工程负担：

- `litellm/router.py`：**11,821 行**，261 个方法（104 个公开）
- `litellm/main.py`：**8,858 行**，106 个顶层函数（27 个公开）

**测试代码量比产品代码多 70%** 这件事值得单独说：`tests/` 下有
`llm_translation/`、`router_unit_tests/`、`proxy_unit_tests/`、`guardrails_tests/`、
`mcp_tests/`、`load_tests/`、`multi_instance_e2e_tests/`、`windows_tests/` 等
数十个分组，另有 `code_coverage_tests/` 与 `documentation_tests/`
（用测试来管住覆盖率与文档漂移）。CI 侧是 **55 个 GitHub Actions workflow**
加一个 **3309 行的 `.circleci/config.yml`**。
对一个要给 132 个 provider 做格式翻译的项目来说，这个比例是结构性的：
**翻译层的正确性只能靠 case 堆出来，没有捷径。**

## 3. Rust 迁移：装进了每个 wheel，但默认关闭

这是本文最该先读的一章，因为**它的现状与 GitHub 仓库简介的字面意思差距最大**。

### 3.1 仓库简介说了什么，代码是什么

GitHub 仓库 description 原文（2026-08-09 实查）：

> The fastest, litest AI Gateway. **Rust core with Python SDK.** Call 100+ LLM APIs...

而 `litellm-rust/README.md` 自己的说法是：

> Python continues to own configuration, retries, routing policy, logging,
> callbacks, spend tracking, and customer plugins until each Rust path has parity
> coverage and production evidence.

官方文档 `docs/proxy/rust_gateway.md` 更直接，标题就带 **`[Beta]`**：

> The Rust core is **opt-in, off by default**, and any Rust path that fails or is
> not yet supported falls back to the existing Python path automatically.

**三份材料里，只有仓库简介那一句会让人以为默认走 Rust。** 这不是文档在含糊，
恰恰相反——文档写得比简介诚实。**是 README/description 这类营销面跑在了实现前面。**

### 3.2 Rust 侧的实际规模

本地源码实查（`litellm-rust/`）：

| Crate | 角色 | `.rs` 文件 | 行数 |
|---|---|---|---|
| `litellm-core` | Rust 版 SDK：按路由的入口、类型、provider transform、auth、HTTP 调用、router | 59 | 6,350 |
| `litellm-ai-gateway` | axum server（`server` feature 后）+ WebSocket host | 48 | 7,609 |
| `litellm-python-bridge` | PyO3 cdylib，把 Rust 暴露给 Python | 3 | 489 |
| **合计** | | **110** | **14,448** |

对比 `litellm/` 的 694,230 行 Python——**Rust 侧目前是 2.1%**。
GitHub 语言统计给的 0.59% 更低，因为它把 `tests/` 与 UI 也算进分母。

依赖方向是无环的：`litellm-core ← litellm-ai-gateway ← litellm-python-bridge`。
文件树刻意与 Python 的 provider 树同形
（`core/src/providers/<provider>/<route>/transformation.rs`），
这样两边可以逐路由对照做 parity 测试。

### 3.3 怎么打开，覆盖哪些路由

有三个互不相同的开关，实测源码位置：

| 开关 | 位置 | 作用范围 |
|---|---|---|
| `LITELLM_RUST=1\|true\|yes\|on` | `litellm/llms/custom_httpx/llm_http_handler.py:2254` | Anthropic `/v1/messages` 路径全局 |
| 模型级 `litellm_params: {rust: true}` | 同上，`litellm_params.get("rust")` | 单个 deployment |
| `LITELLM_USE_RUST_OCR=1\|...` | `litellm/rust_bridge/ocr.py:55` | 只管 OCR，**独立于上面两个** |

覆盖面（官方文档表，2026-08-09）：

| 路由 | 走 Rust 的 provider |
|---|---|
| Anthropic `/v1/messages` | `anthropic`、`azure_ai` |
| 音频转写 | `bedrock` |
| Responses API WebSockets | `openai` |

`rust: true` 的门槛在 `_maybe_rust_anthropic_messages()` 里写得很硬：
`custom_llm_provider` 不在 `("azure_ai", "anthropic")` 里直接返回 `None`；
**带 agentic hook 的请求也直接返回 `None`**（让 hook 还能在 Python 侧跑）。
命中 Rust 的响应会带 **`x-litellm-rust: true`** 头，这是唯一的外部可观测信号。

**回退是无声的。** 源码里那段 `except Exception` 只写 `verbose_logger.debug(...)`
然后 `return None`，注释标明这是 "rollout-safety fallback"。
好处是打开开关不会让原本能成功的请求失败；
**代价是「Rust 路径其实一直在失败」这件事默认只出现在 debug 日志里**——
你要靠统计 `x-litellm-rust` 响应头的出现比例才能发现。

整个 Python 侧引用 `rust_bridge` 的文件**只有 10 个**
（`__init__.py`、`ocr/main.py`、`bedrock` 转写、`llm_http_handler.py`，加 bridge 自身 6 个）。

### 3.4 这次迁移的取舍

官方博客 `litellm-rust-launch`（2026-06-22）把设计讲得很清楚，
核心是**一刀切在 I/O 边界上**：

> We build one Rust core that only transforms data... **It never opens a socket,
> reads a secret, or writes to your database.** The host process does all of that.

这个切法的代价与收益是对称的：

- **收益**：Rust 侧不碰 secret、不碰 DB、不开 socket，
  所以「把它塞进现有 Python 服务器」不需要重写服务器，也不需要 v2 版本号。
  官方明确承诺 `config.yaml`、数据库、client API、provider 全部不变。
- **代价**：**per-request overhead 的大头如果不在翻译层，这个切法就摸不到它。**
  §22 那组厂商数字里，Python 路径的 p99 added latency 是 257.7ms，
  而 Rust **standalone gateway**（Mode 2，整个 host 换成 axum）才是 0.7ms；
  Mode 1（Python host + Rust 翻译）没有单独的公开数字。
  换句话说：**目前默认能用的那个模式（Mode 1），恰好是没有公开性能数据的那个。**

Mode 2 的状态（文档原文）：**「A prebuilt Docker image for the Axum server is
not published yet.」** 要试得自己从 `litellm-rust` workspace 带 `server` feature 编。

### 3.5 时间线（git 实查）

| 日期 | commit | 事件 |
|---|---|---|
| 2026-04-09 | `a6c30b30bf` | 打包从 Poetry 迁到 uv（#25007） |
| 2026-06-23 | `0a17c7c39f` | 加入 `litellm-rust` workspace，首个用例是 Mistral OCR（#31033） |
| 2026-06-25 | `d8ef1da49d` | 首次用 maturin 把 Rust OCR bridge 打进 wheel（#31267） |
| 2026-06-26 | `8622df5a63` | **回退**到 pure-Python `uv_build` 后端「以解除 PyPI 发布阻塞」 |
| 2026-07-03 | `5211c73017` | **恢复** maturin 后端，正式开始发二进制 wheel |
| 2026-07-04 | — | 首个平台特定 wheel 出现在 PyPI（`1.92.0rc1`） |

那次「打进去 → 一天后回退 → 一周后再打进去」的反复，
是这类迁移的典型成本：**发布管道要先扛得住，产品代码才能往前走。**

## 4. 打包与安装：从纯 Python 变成二进制 wheel

§3 是「为什么」，这一章是「你 `pip install` 时实际发生了什么」。

### 4.1 构建后端与 wheel 内容

`pyproject.toml`（源码实查）：

```toml
[build-system]
requires = ["maturin==1.9.4"]
build-backend = "maturin"

[tool.maturin]
manifest-path = "litellm-rust/crates/python-bridge/Cargo.toml"
module-name = "litellm.rust_bridge._native"
python-source = "."
include = ["litellm/proxy/_experimental/out/**"]
exclude = ["litellm/proxy/enterprise", "litellm/proxy/enterprise/**", ...]
```

**实测解包 `litellm-1.95.0-cp312-cp312-manylinux_2_28_x86_64.whl`**
（从 PyPI 真实下载，26.3MB）：

- zip 条目 **3359** 个
- 二进制扩展**只有一个**：`litellm/rust_bridge/_native.cpython-312-x86_64-linux-gnu.so`，
  **22.11MB**
- 也就是说：**wheel 体积的 84% 是那个默认不会被调用的 Rust 扩展**

这不是批评，是事实陈述：把 `.so` 无条件装进去，是「开关一打就能用、
不用换包」的必要代价。但它同时意味着 —— **每个用 LiteLLM SDK 的人，
不管用不用 Rust，都在下载并存储那 22MB。**

`sdist`（17.5MB）里也带全部 Rust 源码：实测 136 个路径匹配
`litellm-rust` 或 `.rs`，所以从源码装会需要 Rust 工具链。

### 4.2 平台矩阵：一个真实的可用性缺口

按 PyPI JSON API 逐版本统计各稳定版的 wheel 平台分布：

| 版本 | 发布日 | 文件数 | manylinux | macOS | musllinux | Windows |
|---|---|---|---|---|---|---|
| 1.92.0 | 2026-07-12 | 9 | 8 | **0** | 0 | 0 |
| 1.92.1 | 2026-07-19 | 9 | 8 | **0** | 0 | 0 |
| 1.93.0 | 2026-07-19 | 11 | 10 | **0** | 0 | 0 |
| 1.94.0 | 2026-07-28 | 16 | 10 | **0** | 0 | 5 |
| 1.93.1 | 2026-07-29 | 16 | 10 | **0** | 0 | 5 |
| 1.94.1 | 2026-07-30 | 16 | 10 | **0** | 0 | 5 |
| **1.95.0** | 2026-08-02 | 16 | 10 | **0** | 0 | 5 |
| **1.94.2** | 2026-08-08 | 36 | 10 | **10** | 10 | 5 |

**实测验证（本机 macOS arm64，Python 3.14）：**

```
$ pip download litellm==1.95.0 --no-deps --only-binary=:all:
ERROR: No matching distribution found for litellm==1.95.0

$ pip download litellm==1.94.2 --no-deps --only-binary=:all:
Saved litellm-1.94.2-cp314-cp314-macosx_11_0_arm64.whl (20.4 MB)   ✅
```

结论要说准：**这不是「macOS 装不上 LiteLLM」**——不加 `--only-binary`
时 pip 会退回 sdist 从源码编（需要 Rust 工具链），
而且 2026-08-08 的 1.94.2 已经补齐了 macOS 与 musllinux。
准确的说法是：**从 1.92 到 1.95.0 这段（2026-07-12 至 2026-08-08，约四周）里，
最新稳定版在 macOS 与 Alpine/musl 上没有预编译 wheel**，
`--only-binary` 场景（很多 CI 与容器构建会这么锁）会直接失败。

顺带一个反直觉的版本号现象：**1.94.2 的发布日（2026-08-08）晚于 1.95.0（2026-08-02）。**
按 §24 的发版规则，PATCH 是给当前 stable 打 hotfix 的，所以老版本线后发新补丁是正常的；
但看 PyPI「最新上传」排序会误以为 1.94.2 才是最新版本。

### 4.3 可选依赖

`[project.optional-dependencies]` 共 **13 组**：
`proxy`、`cli`、`extra_proxy`、`utils`、`caching`、`saml`、`semantic-router`、
`mlflow`、`grpc`、`stt-nvidia-riva`、`google`、`bedrock-realtime`、`proxy-runtime`。

三个入口脚本：

```
litellm       = litellm:run_server                  # 起 proxy 服务
lite          = litellm.proxy.client.cli:cli        # 管理 CLI
litellm-proxy = litellm.proxy.client.cli:cli        # 同上别名
```

**`litellm` 和 `lite` 是两个完全不同的 CLI**，一个起服务一个管服务，见 §19。

## 5. Provider 生态：五个数据源，五个不同的数

README 与仓库简介都写 **"100+ LLM APIs"**。
这个口径**没有一个单一的可复现数字**——不是文案夸大，
而是「一个 provider」在五个地方有五种不同的定义。全部脚本实查：

| 数据源 | 数 | 它实际在数什么 |
|---|---|---|
| `LlmProviders` 枚举（`litellm/types/utils.py`） | **149** | 代码里能被识别的 provider slug，含 `openai_like`、`custom_openai` 这类"形态"而非厂商 |
| `provider_endpoints_support.json` | **170** | 端点支持矩阵的条目，含 `azure_ai/agents`、`azure_ai/doc-intelligence` 这类**子服务**，也含搜索类（`brave`、`duckduckgo`、`exa_ai`） |
| `litellm/llms/` 子目录 | **132** | 有独立适配代码的目录 |
| 定价表 `litellm_provider` 去重 | **122** | 有模型定价数据的 provider |
| README 表格行（带 slug） | **102 行 / 98 个唯一 slug** | 文档里正式列出的 |

**差异不是数据错乱，是分类边界不同**，实查交集验证：

- **枚举有、支持矩阵无：10 个** —— `langfuse`、`humanloop`、`dotprompt`、
  `litellm_agent`、`a2a_agent`、`aiohttp_openai`、`vertex_ai_beta`、
  `sagemaker_nova`、`nano-gpt`、`text-completion-inception`。
  前四个根本不是 LLM provider（是 prompt 管理 / agent 集成），
  说明这个枚举被复用成了「可路由目标」而不是「模型厂商」。
- **支持矩阵有、枚举无：31 个** —— `abliteration`、`aihubmix`、`crusoe`、
  `brave`、`duckduckgo`、`dataforseo`、`e2b`、`exa_ai` 等。
  搜索类走的是 §17 的 search 端点，不是 chat 通路。

**要引用哪个数**取决于你想说什么：
「有多少家模型厂商能调」用定价表的 122 更接近；
「代码里有多少适配分支」用 132；
「文档承诺了什么」用 README 的 98。**"100+" 这个说法在任何一个口径下都成立**，
这大概也是它被选用的原因。

### 5.1 端点支持矩阵

`provider_endpoints_support.json` 是本文见到的最有用的单个文件：
**170 个 provider × 36 个端点维度**的支持矩阵，还带 `_schema` 自述。
按支持该端点的 provider 数排序：

| 端点 | 支持数 | 端点 | 支持数 |
|---|---|---|---|
| `chat_completions` | **133** | `moderations` | 8 |
| `responses` | **123** | `rerank` | 8 |
| `messages`（Anthropic 格式） | **121** | `ocr` | 5 |
| `a2a` | 106 | `count_tokens` | 4 |
| `interactions` | 104 | `rag_ingest` | 4 |
| `embeddings` | 32 | `realtime` | 4 |
| `search` | 16 | `assistants` | 3 |
| `audio_transcriptions` | 15 | `fine_tuning` | 3 |
| `image_generations` | 13 | `files` | 3 |
| `audio_speech` | 12 | `video_generations` | 1 |
| `batches` | 11 | `container` | 1 |

支持端点数的分布很陡：**68 个 provider 正好支持 5 个端点**
（就是上面那组 chat/responses/messages/a2a/interactions），
34 个只支持 1 个，而最全的那一个支持 24 个。
**这意味着「换 provider 不改代码」这句承诺的强度是分端点的**：
chat 通路上它基本成立（133/170），
一旦用到 embeddings（32）、rerank（8）、batches（11），
可换的池子就小了一到两个数量级。

**`messages` 端点有 121 个 provider 支持**这件事值得单独指出：
Anthropic 的 `/v1/messages` 格式在 LiteLLM 里被做成了和 OpenAI 格式
几乎等权的入口，这是为 Claude Code 这类只会说 Anthropic 协议的客户端准备的（§16、§21）。

## 6. 模型定价与能力表

`model_prices_and_context_window.json` 是 LiteLLM 里被外部项目引用最多的资产
（很多与 LiteLLM 无关的工具直接抓它当定价数据源）。实查：

- 文件大小 **1,676,411 字节**，**2987 个模型条目**（去掉 `sample_spec`）
- `sample_spec` 定义了 **28 个字段**，是这份表的事实 schema
- 另有 `model_prices_and_context_window.schema.json`（25,647 字节）做校验

**按 provider 的模型数 Top 10：**

| provider | 模型数 | provider | 模型数 |
|---|---|---|---|
| `fireworks_ai` | 293 | `azure_ai` | 97 |
| `bedrock` | 267 | `openrouter` | 96 |
| `openai` | 219 | `novita` | 85 |
| `azure` | 219 | `gemini` | 75 |
| `bedrock_converse` | 144 | `deepinfra` | 67 |
| `vercel_ai_gateway` | 101 | `mistral` | 58 |

**按 `mode` 分布**（这决定了它能算哪些账）：

| mode | 数 | mode | 数 |
|---|---|---|---|
| `chat` | 2289 | `audio_speech` | 27 |
| `image_generation` | 209 | `rerank` | 25 |
| `embedding` | 124 | `video_generation` | 25 |
| `responses` | 85 | `search` | 18 |
| `audio_transcription` | 62 | `ocr` | 13 |
| `completion` | 36 | `moderation` | 5 |
| `image_edit` | 31 | `vector_store` | 1 |
| `realtime` | 28 | *（缺失）* | 9 |

**缓存定价的覆盖面**（对算 prompt cache 的账很关键）：

- 带 `cache_read_input_token_cost` 字段的模型：**712**
- 标 `supports_prompt_caching: true` 的模型：**626**

两个数不一样，说明**有 86 个模型有缓存读价格但没被标成"支持 prompt caching"**。
这类不一致是这份表的常态——它由 **CI 自动更新**
（`.github/workflows/auto_update_price_and_context_window.yml`），
数据来自各家厂商页面，自动化拿到什么就写什么。

`litellm/cost_calculator.py` **2454 行**负责把这些字段变成钱，
要处理的特例包括 audio token 单独计价、reasoning token 单独计价、
computer use、code interpreter 按 session、file search 按 GB-day、
vector store 按 GB-day 等——**28 个字段里有一半以上不是「输入价 × 输入量」**。

::: warning 这份表出过事故，值得引用者知道
官方博客有一篇 `Incident Report: Invalid model cost map on main`（2026-02-10），
以及一篇 `Wildcard Blocking New Models After Cost Map Reload`（2026-02-23）。
**一个自动更新、被大量下游直接抓取的 JSON，本身就是一个故障面。**
如果你的系统直接引用这个 URL 算账，`litellm.model_cost` 的值可能在你不知情时变。
自托管方案见 `docs/proxy/custom_model_cost_map.md`。
:::

## 7. 请求流：一次 `/v1/chat/completions` 都经过了谁

仓库根的 `ARCHITECTURE.md`（18,872 字节）用 mermaid 画了完整时序，
以下是按源码路径整理的层次。**这一节是后面所有章节的坐标系**——
§9 的路由、§11 的回调、§13 的 guardrail 都挂在这条链的不同位置上。

**Gateway 路径（11 层）：**

| # | 层 | 源码位置 | 干什么 |
|---|---|---|---|
| 1 | HTTP 入口 | `proxy/proxy_server.py` | FastAPI 端点，616 条路由之一（§18） |
| 2 | 鉴权 | `proxy/auth/user_api_key_auth.py` | 虚拟 key → 用户/团队/组织，查 Redis 缓存 |
| 3 | 前置 hook | `proxy/hooks/` | 预算限制、并发限制、限流计数（20 个 py 文件） |
| 4 | Guardrail pre_call | `proxy/guardrails/` | 输入侧拦截（§13） |
| 5 | 路由 | `router.py` `route_request()` | 从 model_group 选一个 deployment（§9） |
| 6 | SDK 入口 | `main.py` `acompletion()` | 与纯 SDK 用户走的是同一个入口 |
| 7 | HTTP 编排 | `llms/custom_httpx/llm_http_handler.py` | **Rust 分叉点在这里**（§3） |
| 8 | 格式翻译 | `llms/{provider}/chat/transformation.py` | `transform_request()` / `transform_response()`（§8） |
| 9 | 成本计算 | `cost_calculator.py` | token × 单价，写进 `_hidden_params["response_cost"]` |
| 10 | 异步日志 | `litellm_logging.py` → `integrations/` | 回调都在这里，**不阻塞响应**（§11） |
| 11 | 落库 | `proxy/db/db_spend_update_writer.py` | Redis 排队 → Postgres 批量写 |

**两个设计点值得单独指出：**

**① Gateway 复用 SDK 的入口，不是绕过它。** 第 6 层是 `litellm.acompletion()`，
和你在自己进程里 `import litellm` 调的是同一个函数。
好处是 provider 适配只写一遍；代价是**SDK 里任何全局状态都会成为 Gateway 的共享状态**——
`litellm.callbacks`、`litellm.cache`、`litellm.model_cost` 都是模块级全局变量。

**② 成本是「塞在响应里带出来」的。** 第 9 层把钱算进 `response._hidden_params`，
第 11 层再从里面掏出来落库，同时作为 **`x-litellm-response-cost` 响应头**返回给客户端。
这个设计让「客户端自己就能知道这次花了多少」成为可能（§21 的 Claude Code 成本追踪靠的就是它），
但也意味着**成本准确性完全依赖 §6 那张 JSON 表**——
表里没有的模型，这里算出来是 0 而不是报错。

**SDK 路径**短得多：`completion()` → `get_llm_provider()`（解析 `model` 字符串定 provider）
→ `BaseLLMHTTPHandler` → transformation → `streaming_handler.py` → `ModelResponse`，
回调异步旁路。**没有第 2/3/4/11 层**——鉴权、配额、审计、落库全部是 Gateway 独有的。

## 8. 翻译层：312 个 `transformation.py`

这是 LiteLLM 的核心资产，也是它 183,488 行 provider 代码的去处。

**组织方式是「provider × 路由」二维展开**，实查：

- `litellm/llms/` 下 **132 个 provider 目录**
- 名为 `transformation.py` 的文件 **312 个**；文件名含 `transformation` 的共 **399 个**
- 每个 provider 目录内再按路由分子目录，例如
  `anthropic/` 下有 `chat/`、`completion/`、`batches/`、`files/`、`count_tokens/`、
  `skills/`、`experimental_pass_through/`；
  `bedrock/` 下有 17 个（`chat/`、`embed/`、`messages/`、`rerank/`、`realtime/`、
  `image_generation/`、`image_edit/`、`audio_transcription/`、`vector_stores/`、
  `claude_platform/`、`passthrough/` 等）

**契约由 `llms/base_llm/` 定义**，其下有 **32 个路由子目录**
（`chat`、`embedding`、`rerank`、`responses`、`realtime`、`ocr`、`videos`、
`sandbox`、`skills`、`evals`、`agents`、`containers`、`vector_store`、`bridges`…）。
`base_llm/chat/transformation.py` 444 行，**6 个抽象方法**决定了「接一个新 provider 要写什么」：

```
get_supported_openai_params()   # 这个 provider 认哪些 OpenAI 参数
map_openai_params()             # OpenAI 参数名 → provider 参数名
validate_environment()          # 需要哪些 env/密钥，缺了当场报错
transform_request()             # OpenAI 格式请求 → provider 请求
transform_response()            # provider 响应 → ModelResponse
get_error_class()               # provider 错误 → LiteLLM 异常（§9.3）
```

**"一个文件一个翻译"这个约定带来的直接好处**是 `ARCHITECTURE.md` 里那张
「去哪找翻译」表能存在——想知道 Bedrock 的 prompt caching 怎么实现的，
路径是确定的 `llms/bedrock/chat/converse_transformation.py`，不需要读调用链。
`CONTRIBUTING.md` 与 `litellm-rust/ADDING_A_PROVIDER.md` 都建立在这个约定上。

**代价是 312 个文件的正确性只能靠测试保证**，这正是 §2 那个
「测试代码 1.17M 行 > 产品代码 694K 行」的来源。
`tests/llm_translation/` 是最大的测试分组之一，
而 `tests/` 下还有 `_openai_record_replay_proxy.py`、`_vcr_conftest_common.py`、
`_ws_vcr.py` 这套 VCR 录制回放设施——**用录下来的真实响应做回归**，
这是这类翻译层唯一可行的验证手段。

::: tip 一个对 Anthropic 协议使用者重要的细节
`/v1/messages` 有**两条**实现路径，不要混：
一条是「把 Anthropic 格式翻成 OpenAI 格式再转给任意 provider」
（§5.1 里 121 个 provider 支持 `messages` 靠的是这条），
另一条是 `experimental_pass_through`——原样透传给真正说 Anthropic 协议的后端
（`llms/anthropic/experimental_pass_through/messages/transformation.py`、
Bedrock 与 Vertex 各有对应实现）。
**§3 的 Rust 路径只覆盖后者的 `anthropic` / `azure_ai` 两个 provider。**
:::

## 9. Router：7 种策略与三类 fallback

`router.py` 是 11,821 行的单体，261 个方法。它解决的是
「同一个 `model_name` 后面挂了 N 个 deployment，这次该发给谁」。

### 9.1 七种路由策略

`routing_strategy` 的 `Literal` 白名单（源码实查，`router.py`）：

| 策略 | 实现文件 | 依据 |
|---|---|---|
| **`simple-shuffle`**（默认，官方推荐生产用） | `simple_shuffle.py` | 按 `rpm` / `tpm` / `weight` 加权随机 |
| `least-busy` | `least_busy.py` | 当前进行中请求数最少 |
| `usage-based-routing` | `lowest_tpm_rpm.py` | 已用 TPM/RPM 最低 |
| `usage-based-routing-v2` | `lowest_tpm_rpm_v2.py` | 同上，Redis 原子计数版 |
| `latency-based-routing` | `lowest_latency.py` | 历史延迟最低 |
| `cost-based-routing` | `lowest_cost.py` | 单位 token 成本最低 |
| `lar1` | `lar1_routing.py` | — |

**官方在文档里明确推荐默认那个**（"We recommend using `simple-shuffle` (default)
for best performance in production"），理由是其余策略都要读写共享状态
（Redis 里的 TPM/RPM 计数、延迟直方图），**在高 QPS 下策略本身就是开销**。
这是个诚实的取舍陈述：**更聪明的路由要用延迟换。**

`router_strategy/` 下还有四个不在上面白名单里的目录，它们是另一层机制：

| 目录 | 行数 | 是什么 |
|---|---|---|
| `complexity_router/` | 2,632 | 按请求复杂度选模型 |
| `adaptive_router/` | 1,629 | 自适应（DB 有 `LiteLLM_AdaptiveRouterState` / `...Session` 两张表） |
| `quality_router/` | 546 | 按质量分选 |
| `auto_router/` | 338 | 语义自动路由（DB 有 `LiteLLM_AutoRouterSession`） |

另有 `budget_limiter.py`（`provider_budget_limiting`）、`tag_based_routing.py`、
`savings_baseline.py`。**这些是「省钱路由」这条产品线**，
官方博客有 5 篇 `autorouter_*` 帖子专门讲它（含 prompt caching 与 cost/quality benchmark）。

### 9.2 三类 fallback

`fallbacks` 不是一个开关而是三个正交的配置项：

| 配置 | 触发条件 |
|---|---|
| `fallbacks` | 一般失败 |
| `context_window_fallbacks` | 上下文超长（`ContextWindowExceededError`） |
| `content_policy_fallbacks` | 内容策略拦截（`ContentPolicyViolationError`） |
| `default_fallbacks` | 兜底，未单独配置的 model_group 共用 |

把「超长」和「被审核拦」拆出来是有道理的：这两类失败**换一个同档模型重试没用**，
得换一个上下文更大的 / 审核更松的。混在一个 `fallbacks` 列表里会白烧一轮请求。

### 9.3 按异常类型分别设阈值

`AllowedFailsPolicy` 有 **6 个字段**（源码实查，`types/router.py`）：

```
BadRequestErrorAllowedFails
AuthenticationErrorAllowedFails
TimeoutErrorAllowedFails
RateLimitErrorAllowedFails
ContentPolicyViolationErrorAllowedFails
InternalServerErrorAllowedFails
```

含义是「每分钟允许多少次该类失败才把这个 deployment 冷却掉」。
这是本文见到的**归因粒度最细的一处设计**：
`AuthenticationError` 该立刻冷却（密钥错了，再试一百次也是错），
`RateLimitError` 则不该（限流是暂时的，冷却掉反而少一个可用节点）。
**把「失败」当成一个整体来计数的系统做不到这个区分。**

`litellm/exceptions.py` 定义了 **31 个类**，其中值得注意的几个非标准项：
`ContextWindowExceededError`、`ContentPolicyViolationError`、`BudgetExceededError`、
`GuardrailRaisedException`、`BlockedPiiEntityError`、`MidStreamFallbackError`、
`RejectedRequestError`、`JSONSchemaValidationError`。
`MidStreamFallbackError` 的存在说明**流式中途失败也被纳入了 fallback 语义**——
这是很多网关不处理的场景。

### 9.4 Router 插件

`router_plugins.json` 是插件登记表，实查**只有 2 条**：
一条是 TEMPLATE 说明，一条是真实插件 `language-detector`
（`jeann2013/language-detector`，要求 `litellm >= 1.94.0`）。

插件机制在 `v1.94.0`（2026-07-28）随 release note
「Router Plugins, MCP Client-Held Credentials & Shared Health Checks」落地。
**截至本快照，这个生态里只有一个第三方插件**——
机制在，生态还没起来，这个要照实说。

## 10. 缓存：9 种后端，语义缓存占 3 席

`LiteLLMCacheType`（源码实查，`types/caching.py`）**9 种**：

| 类型 | 实现文件 | 说明 |
|---|---|---|
| `local` | `in_memory_cache.py` | 进程内，多实例不共享 |
| `redis` | `redis_cache.py` + `redis_cluster_cache.py` | 生产默认 |
| `disk` | `disk_cache.py` | 本地文件 |
| `s3` | `s3_cache.py` | 对象存储 |
| `gcs` | `gcs_cache.py` | 同上，GCP |
| `azure-blob` | `azure_blob_cache.py` | 同上，Azure |
| `redis-semantic` | `redis_semantic_cache.py` | **语义**缓存 |
| `valkey-semantic` | `valkey_semantic_cache.py` | 同上，Valkey |
| `qdrant-semantic` | `qdrant_semantic_cache.py` | 同上，向量库 |

`caching/` 共 19 个文件 7,365 行。两个额外部件值得注意：

- **`dual_cache.py`**：内存 + Redis 两层。热 key 不打 Redis，
  这是把「Redis 往返」从鉴权路径上摘掉的关键（§7 第 2 层每个请求都要查 key）。
- **`evicted_client_closer.py`**：缓存淘汰时关掉对应的 httpx client。
  这个文件的存在有具体来由——官方博客
  `Incident Report: Cache Eviction Closes In-Use httpx Clients`（2026-02-27）：
  **淘汰逻辑把还在用的连接关掉了。** 修法是把关闭动作延后到确实无人使用。

**三种语义缓存并存**（Redis / Valkey / Qdrant）是个信号：
语义缓存要存向量、要算相似度，用什么后端取决于你已有什么基础设施，
所以做成了三个平行实现而不是一个抽象。
`_embedding_router.py` 负责给语义缓存算 embedding——
**注意这意味着语义缓存本身要花钱调 embedding 模型**，
省下的 LLM 调用要减掉这部分。

**缓存的作用域是分层的**：`litellm_settings.cache` 全局开关、
`cache_params` 细配、Router 侧 `cache_responses` / `caching_groups`
（跨 model_group 共享缓存）、请求级 `cache: {"no-cache": true}`，
以及虚拟 key 上的 `allowed_cache_controls`（§14）——
**决定「客户端能不能自己要求绕过缓存」是个权限问题，它被正确地放在了 key 上。**

## 11. 回调与可观测性：51 个白名单，32 个钩子

### 11.1 回调白名单

`litellm/__init__.py` 里的 `_custom_logger_compatible_callbacks_literal`
是个 `Literal` 类型，实查 **51 个**取值。按用途分类：

| 类别 | 名字 |
|---|---|
| **LLM 观测平台**（15） | `langfuse`、`langfuse_otel`、`langsmith`、`braintrust`、`arize`、`arize_phoenix`、`langtrace`、`opik`、`literalai`、`humanloop`、`galileo`、`argilla`、`deepeval`、`mlflow`、`weave_otel` |
| **通用 APM / 指标**（7） | `otel`、`prometheus`、`datadog`、`datadog_metrics`、`datadog_llm_observability`、`newrelic`、`posthog` |
| **计量计费**（7） | `lago`、`openmeter`、`cloudzero`、`focus`、`mavvrik`、`vantage`、`levo` |
| **对象存储 / 队列**（5） | `gcs_bucket`、`gcs_pubsub`、`azure_storage`、`s3_v2`、`aws_sqs` |
| **告警 / 邮件**（4） | `pagerduty`、`resend_email`、`sendgrid_email`、`smtp_email` |
| **Prompt 管理**（4） | `dotprompt`、`bitbucket`、`gitlab`、`generic_api` |
| **安全 / 其他**（5） | `azure_sentinel`、`agentops`、`anthropic_cache_control_hook`、`vector_store_pre_call_hook`、`compression_interception` |
| **限流**（2） | `dynamic_rate_limiter`、`dynamic_rate_limiter_v3` |
| **Agent**（2） | `litellm_agent`、`litellm_agent` 相关 |

`integrations/` 目录实查 **33 个子目录 + 44 个顶层 `.py`**，共 195 文件 52,702 行。
文档侧 `docs/observability/` 有 **49 页**。

**「计量计费」这一类有 7 个**（Lago、OpenMeter、CloudZero、FOCUS、Mavvrik、Vantage、Levo）
是个值得注意的信号：这不是「记日志」而是「把 LLM 花费接进公司的 FinOps 体系」。
其中 `focus` 与 `mavvrik_focus` 对应 **FOCUS**（云成本数据开放标准），
说明它在往「LLM 支出也是一类云支出」这个方向对齐。

### 11.2 钩子面

`integrations/custom_logger.py`（1,046 行）是所有回调的基类，实查 **62 个方法**，
其中 32 个是日志/前后钩子。按生命周期位置：

| 时机 | 钩子 |
|---|---|
| 调用前 | `log_pre_api_call`、`async_log_pre_api_call`、`async_pre_call_hook`、`async_pre_request_hook`、`async_pre_call_check`、`async_pre_call_deployment_hook`、**`async_pre_routing_hook`** |
| 路由时 | **`async_filter_deployments`** |
| 调用后 | `log_post_api_call`、`async_log_success_event`、`async_post_call_success_hook`、`async_post_call_success_deployment_hook` |
| 流式 | `async_log_stream_event`、`async_post_call_streaming_hook`、`async_post_call_streaming_iterator_hook`、`async_post_call_streaming_deployment_hook` |
| 失败 | `log_failure_event`、`async_log_failure_event`、`async_post_call_failure_hook`、`log_failure_fallback_event`、`log_success_fallback_event`、`log_model_group_rate_limit_error` |
| Prompt | `get_chat_completion_prompt`、`async_get_chat_completion_prompt` |
| 审核 | `async_moderation_hook` |
| MCP | `async_post_mcp_tool_call_hook` |
| **Agentic loop** | `async_should_run_agentic_loop`、`async_build_agentic_loop_plan`、`async_run_agentic_loop`、`async_post_agentic_loop_response_hook`、`async_agentic_loop_cleanup_hook`（+ chat_completion 变体） |

三处值得单独说：

**① `async_filter_deployments` 与 `async_pre_routing_hook` 让插件能干预路由**，
这是 §9.4 那个 router plugin 机制的挂载点——
插件不是只能观测，它能改「发给谁」。

**② fallback 有专门的成功/失败钩子**（`log_success_fallback_event` /
`log_failure_fallback_event`）。这意味着「这次请求是靠 fallback 救回来的」
是一个可观测事件，而不是被当成普通成功混进去。
**对一个网关来说，「主路径成功率」和「含 fallback 后的成功率」是两个不同的数**，
分不开就看不见退化。

**③ agentic loop 那 5+ 个钩子**是较新的一层：
网关侧能接管「多轮工具调用循环」本身，而不只是转发单次请求。
实查引用 `agentic_loop` 的文件 14 个，
使用方包括 `compresr`（压缩）、`headroom`、`code_interpreter_interception`、
`websearch_interception`。**注意 §3 的 Rust 路径遇到 agentic hook 会直接退回 Python**——
这两条新特性目前是互斥的。

### 11.3 内置脱敏

`custom_logger.py` 里有一批下划线开头的方法专门做落盘前处理：
`_redact_base64`、`_strip_base64_from_messages`、`_truncate_text`、
`_truncate_field`、`redact_standard_logging_payload_from_model_call_details`、
`truncate_standard_logging_payload_content`。

**把 base64 从日志里剥掉是必须的**——一张图片进 Langfuse 就是几百 KB 的无用负载。
文档侧对应 `docs/observability/scrub_data.md`。
这条也有事故背书：`Incident Report: Guardrail logging exposed secret headers in spend logs`
（2026-03-18）——**guardrail 的日志把 secret header 写进了 spend log。**

## 12. Guardrails：49 个集成，8 个挂载时机

`litellm/proxy/guardrails/guardrail_hooks/` 实查 **49 个子目录 + 7 个顶层 `.py`**，
文档侧 `docs/proxy/guardrails/` **53 页**。这是 LiteLLM 里第三方集成最密的一块。

**8 个挂载时机**（`GuardrailEventHooks`，源码实查）：

| 时机 | 说明 |
|---|---|
| `pre_call` | 请求发给 provider 之前，可拦可改 |
| `during_call` | 与 LLM 调用并行跑（不加延迟，但拦不住已发出的请求） |
| `post_call` | 拿到响应之后 |
| `logging_only` | 只记录不干预 |
| `pre_mcp_call` / `during_mcp_call` / `post_mcp_call` | **MCP 工具调用**的三个对应时机（§16） |
| `realtime_input_transcription` | 实时语音转写的输入侧 |

`pre_call` 与 `during_call` 的区别是这套设计里最实用的一处：
**`during_call` 用延迟换安全性**——它和 LLM 请求同时发出，
所以不给用户增加等待，但等它判完时请求已经出去了。
**要「一定拦住」就得用 `pre_call` 并接受串行延迟。** 这个取舍无法两全，
所以做成了两个选项而不是一个。

**厂商侧（49 个中的代表）**：Aim、Akto、Aporia、Azure Content Safety、
Bedrock Guardrails、Cato Networks、Cisco AI Defense、CrowdStrike AIDR、
DeepKeep、DynamoAI、EnkryptAI、GraySwan、Guardrails AI、HiddenLayer、
IBM、Javelin、Lakera（v1 + v2）、Lasso、Microsoft Purview、Model Armor、
Noma、Onyx、Pangea、PANW Prisma AIRS、Pillar、Presidio、Prompt Security、
PromptGuard、Qohash、Qualifire、RepelloAI、Rubrik、Singulr、Straiker、
Vigil、XecGuard、Zscaler AI Guard。

**自建侧**：`custom_code`（跑你自己的代码）、`custom_guardrail.py`（继承基类）、
`llm_as_a_judge`（用另一个 LLM 判）、`litellm_content_filter`、
`generic_guardrail_api`（HTTP 回调到你自己的服务）、
`semantic_guard`、`tool_permission.py`、`tool_policy`、`block_code_execution`。

**策略模板**：`policy_templates.json` 实查 **16 个**开箱模板，
含地区化的合规组合——`gdpr-eu-pii-protection`（GDPR Art. 32）、
`advanced-au-pii-protection`（澳洲标识符）、
三档 NSFW 过滤（Basic / Australia / All Regions）。
**「合规」在这里被做成了可选的预设组合而不是一个开关**，
因为 PII 的定义本身是按辖区变的。

`tool_permission.py` 与 `tool_policy` 值得单独指出：
它们管的是「模型能调哪些工具」，
这是 agent 场景独有的攻击面（§16 的 MCP 让它更严重）。

## 13. 配置系统：四张表，925 个环境变量

`docs/proxy/config_settings.md` 是文档站最大的单页，**162,083 字节**。
它由四张参考表组成，逐表脚本计数（`re.findall` 数表格行，非目测）：

| 表 | 行数 | 管什么 |
|---|---|---|
| `litellm_settings` | **40** | SDK 层全局：回调、缓存、超时、脱敏、成本折扣 |
| `general_settings` | **122** | 网关层：DB 连接池、鉴权、告警、路由白名单、企业许可 |
| `router_settings` | **55** | 路由层：策略、fallback、冷却、重试、缓存组 |
| **环境变量** | **925 个唯一名**（938 行，13 个重复） | 全部 |

**环境变量的源码侧交叉核验**：扫 `litellm/` 下所有
`os.environ.get` / `os.getenv` / `get_secret_str` / `get_secret` 调用，
得到 **1,143 个唯一变量名 / 2,088 个调用点**。

**文档 925 < 源码 1143**，差 218 个。这个差值不该被读成「文档漏了 218 个」——
源码侧的正则会把 CI 变量（`ACTIONS_ID_TOKEN_REQUEST_TOKEN`）、
第三方 SDK 自己读的变量、以及测试辅助变量都算进去。
准确的说法是：**两个数是不同口径下的下界与上界，真实的「用户可配置项」在两者之间。**
一个 925 项的配置面本身就说明了这类产品的形态：
**它的复杂度不在算法，在「要接的东西太多」。**

`config.yaml` 的顶层结构（文档源文件）：

```yaml
environment_variables: {}
model_list:
  - model_name: string          # 客户端看到的名字（model_group）
    litellm_params: {}          # 真实 provider 参数（含 rust: true，§3）
    model_info: {}              # 覆盖定价、mode、base_model
litellm_settings: {}
general_settings: {}
router_settings: {}
```

**「一个 `model_name` 对多个 deployment」是这个 schema 的核心**：
`model_list` 里可以有多条同名 `model_name` 项，Router 在它们之间选（§9）。
客户端只知道 `gpt-4`，不知道后面是 3 个 Azure 区域加 1 个 OpenAI 直连。

**几个值得知道的配置项**（从 `litellm_settings` 表里挑）：

- `turn_off_message_logging`：不把 prompt/响应发给回调，但保留元数据。
  合规场景的第一个开关。
- `redact_user_api_key_info`：从日志里去掉 key 哈希、user_id、team_id。
  **注意文档明确写了它只对 Langfuse / OTel / Logfire / Arize 生效**——
  这类「部分支持」的开关最容易被误当全局保证。
- `force_ipv4`：强制 IPv4。存在的理由写在文档里：
  「Some users have seen httpx ConnectionError when using ipv6 + Anthropic API」。
- `cost_discount_config` / `cost_margin_config`：**按 provider 加折扣或加价**。
  前者用于「我们有企业折扣，账要按实付算」；
  后者用于**内部分账时加运维成本**（`docs/proxy/provider_margins.md` 写得很直白：
  "add operational overhead costs to bill internal consumers"）。
  **这是把网关当内部计费中台用的直接证据**——它不只是转发，它出账单。

**配置有两个来源且可同时存在**：`config.yaml` 文件与数据库
（`LiteLLM_Config`、`LiteLLM_ConfigOverrides`、`LiteLLM_UISettings` 三张表）。
文档有专门一节 `config.yaml vs database settings` 讲优先级。
DB 侧配置让「在 UI 上改完立刻生效、不重启」成为可能，
代价是**同一个设置有两个事实源**——排查「为什么我改了 yaml 没生效」时要先想到这一层。

`config.yaml` 还能从 **S3 / GCS 对象**加载（`docs/proxy/configs.md` 末节），
以及用 `CONFIG_FILE_PATH` 指定路径（为 Azure 容器部署准备的）。

## 14. 鉴权与多租户：七个角色，五层实体

`litellm/proxy/auth/` 实查 **21 个文件 / 15,453 行**。

### 14.1 实体层级

DB schema（70 张表）里的主体实体，从大到小：

```
Organization  →  Team  →  User  →  VirtualKey
                              ↘  EndUser（终端用户，不是 LiteLLM 的账号）
                    Project（与 Team 平行的另一种分组）
                    Tag（跨维度打标）
```

**`EndUser` 与 `User` 的区别是这套模型里最实用的一处**：
`User` 是「有 LiteLLM 账号的人」（能登 UI、能建 key），
`EndUser` 是「你的应用的用户」（由请求里的 `user` 字段带进来）。
这让「按你自己的客户维度算账和限流」成为可能，
而不需要给每个终端用户建一个 LiteLLM 账号。
对应的聚合表是 `LiteLLM_DailyEndUserSpend`。

**十张日聚合表**（实查）：`LiteLLM_Daily` + `UserSpend` / `OrganizationSpend` /
`EndUserSpend` / `AgentSpend` / `TeamSpend` / `TagSpend` / `ToolSpend` /
`GuardrailMetrics` / `PolicyMetrics` / `GatewayRequests`。
**把「按天预聚合」做成十张独立表而不是一张宽表**，
是因为 `LiteLLM_SpendLogs`（32 字段，每请求一行）在真实流量下会大到不能直接查——
这些表是给 UI 报表用的。文档另有 `docs/proxy/spend_logs_deletion.md`
讲怎么删（原始日志是要过期的）。

### 14.2 七个角色

`LitellmUserRoles`（源码实查，`proxy/_types.py`）**7 个**：

| 角色 | 权限 |
|---|---|
| `PROXY_ADMIN` | 全局管理员 |
| `PROXY_ADMIN_VIEW_ONLY` | 全局只读 |
| `ORG_ADMIN` | 组织级管理员 |
| `INTERNAL_USER` | 普通用户，能建自己的 key |
| `INTERNAL_USER_VIEW_ONLY` | 普通用户只读 |
| `TEAM` | 团队维度的服务账号 |
| `CUSTOMER` | 终端客户 |

**每个角色都有 view-only 变体**这件事说明审计场景是一等公民——
「让安全团队能看全部花销但不能改配置」是个真实需求。

### 14.3 虚拟 Key：50 个字段

`LiteLLM_VerificationToken` 表实查 **50 个字段**。挑几组说明它能表达什么：

| 组 | 字段 |
|---|---|
| 额度 | `max_budget`、`soft_budget_cooldown`、`budget_duration`、`budget_reset_at`、`model_max_budget`、`model_spend`、`budget_limits`、`budget_fallbacks` |
| 限流 | `tpm_limit`、`rpm_limit`、`max_parallel_requests` |
| 范围 | `models`、`aliases`、`allowed_routes`、`allowed_cache_controls`、`permissions`、`policies`、`access_group_ids` |
| 归属 | `user_id`、`team_id`、`organization_id`、`project_id`、**`agent_id`** |
| 轮换 | `auto_rotate`、`rotation_interval`、`rotation_count`、`last_rotation_at`、`key_rotation_at` |
| 覆盖 | `config`、**`router_settings`** |

三处值得单独指出：

**① `model_max_budget` 是「按模型分别设预算」**——
一把 key 可以「GPT-5 每月 100 美元、Claude 每月 500 美元」。
**② `router_settings` 出现在 key 上**意味着单个 key 能覆盖路由行为，
这是很强的能力也是很强的耦合。
**③ `auto_rotate` + `rotation_interval` 是内置密钥轮换**，
文档 `docs/proxy/master_key_rotations.md` 另讲主密钥轮换。

`LiteLLM_BudgetTable` 是独立的预算实体（可挂到 org / project / key / end_user / tag /
team_membership 上），字段含 `soft_budget`——
**软预算只告警不拦**，对应 `docs/proxy/ui_team_soft_budget_alerts.md`。

### 14.4 SSO / JWT / 密钥管理

- **SSO**：`LiteLLM_SSOConfig` + `LiteLLM_SSOIdentityAssertion` 两张表，
  文档含 `admin_ui_sso.md`、`saml_sso.md`、`custom_sso.md`、`cli_sso.md`、
  `identity_provisioning.md`（SCIM，另有 `tests/scim_tests/`）
- **JWT**：`handle_jwt.py` + `LiteLLM_JWTKeyMapping` 表，
  文档 `token_auth.md`、`jwt_auth_arch.md`、`jwt_key_mapping.md`
- **Secret Manager**：`litellm/secret_managers/` 11 个文件——
  AWS Secrets Manager（v1 + v2）、Google KMS、Google Secret Manager、
  HashiCorp Vault、CyberArk、Azure AD token provider、以及 `custom_secret_manager_loader.py`
- **OAuth2**：`oauth2_check.py` + `oauth2_proxy_hook.py`

`SpecialHeaders` 枚举（9 个）说明它支持客户端用**各家原生的鉴权头**来认：
`openai_authorization`、`azure_authorization`、`anthropic_authorization`、
`google_ai_studio_authorization`、`azure_apim_authorization`、
`custom_litellm_api_key`，以及三个 MCP 专用（`mcp_auth`、`mcp_servers`、`mcp_access_groups`）。
**这是「客户端不改代码就能指过来」的关键**——
Claude Code 发的是 `x-api-key`，LiteLLM 认它。

## 15. 限流与预算：v3 与「谁先扣」

`proxy/hooks/` 实查 **20 个 py 文件**，其中限流/预算相关：

| 文件 | 管什么 |
|---|---|
| `parallel_request_limiter.py` / `_v3.py` | 并发请求数（两代并存） |
| `dynamic_rate_limiter.py` / `_v3.py` | 动态限流（按可用容量分配） |
| `max_budget_limiter.py` | 全局预算 |
| `model_max_budget_limiter.py` | 按模型预算 |
| `max_budget_per_session_limiter.py` | 按会话预算 |
| `max_iterations_limiter.py` | **agent 循环轮数上限** |
| `batch_rate_limiter.py` | 批量接口限流 |
| `rate_limiter_utils.py` | 共用逻辑 |

**`_v3` 后缀的两个文件与 v1 并存**是这个项目的常态
（§10 的 `s3_cache` / `s3_v2`、`lowest_tpm_rpm` / `_v2`、`lakera_ai` / `_v2` 同理）。
**保留旧实现是为了不破坏在跑的部署**，代价是同一个能力有两份代码要维护。
判断你在用哪个要看 `general_settings`。

**`max_iterations_limiter.py` 值得单独说**：它限制的是 agentic loop 的轮数（§11.2）。
一个 agent 卡在工具调用循环里能烧掉的钱没有自然上限，
**「按请求数限流」对它无效，因为一次「请求」内部可能有 50 轮**。
这类限流器的出现是网关适配 agent 负载的直接证据。

关于「预算和限流哪个先判」：从 §7 的流程看，两者都在第 3 层（前置 hook），
在路由与 provider 调用之前。这意味着**超预算的请求不会花钱**，
但也意味着这两项检查在每个请求的关键路径上（都要读 Redis）。
`dual_cache.py`（§10）就是为了缓解它。

文档另有 `docs/proxy/rate_limit_tiers.md`（分档限流）、
`io_token_rate_limits.md`（按输入/输出 token 分别限）、
`temporary_budget_increase.md`（临时提额，企业版）、
`budget_reset_and_tz.md`（重置时区——**跨时区团队的账期边界是个真问题**）。

## 16. MCP 网关：72 个文件，19 页文档

MCP（Model Context Protocol）在 LiteLLM 里不是一个小集成，
实查 **`litellm/proxy` 下 MCP 相关 py 文件 72 个 / 39,649 行**，
文档 **19 页**（`mcp.md`、`mcp_oauth.md`、`mcp_obo_auth.md`、`mcp_zero_trust.md`、
`mcp_toolsets.md`、`mcp_cost.md`、`mcp_guardrail.md`、`mcp_semantic_filter.md`、
`mcp_tool_search.md`、`mcp_openapi.md`、`mcp_public_internet.md`、
`mcp_aws_sigv4.md`、`mcp_oauth_passthrough.md`、`mcp_rest_api.md` 等）。

**它做的是「MCP 的网关」而不是「MCP 的客户端」**：
DB 里有 6 张 MCP 表——`LiteLLM_MCPServerTable`、`LiteLLM_MCPToolsetTable`、
`LiteLLM_MCPUserCredentials`、`LiteLLM_MCPUserEnvVars`、
`LiteLLM_MCPServerOAuthClient`，加上 `LiteLLM_SpendLogToolIndex`。
也就是说它**代管一组 MCP server、代管每个用户对这些 server 的凭据、
并且按工具调用记账**（`LiteLLM_DailyToolSpend`、
`SpendLogs` 里的 `mcp_namespaced_tool_name` 字段）。

`mcp_servers.json` 预置了一批公共 server（Zapier、DeepWiki、Jira、Linear 等）。

**安全面被单独做了三个 guardrail**（§12 的 49 个之中）：
`mcp_security`、`mcp_jwt_signer`、`mcp_end_user_permission`，
外加 `hooks/mcp_semantic_filter/`。
**MCP 的攻击面与 LLM 调用不同**：它是「模型能执行动作」而不是「模型能生成文本」，
所以需要独立的权限层。§12 那 3 个 MCP 专用挂载时机
（`pre_mcp_call` / `during_mcp_call` / `post_mcp_call`）就是为它开的。

**这块也是这个项目已知 CVE 的来源之一**：
`CVE-2026-30623`（MCP stdio 传输的命令注入，源自 Anthropic MCP SDK 的
`StdioServerParameters` 会执行传给它的任何 `command`），
LiteLLM 侧在 `v1.83.6-nightly` 修掉。
官方复盘明确写了「不可被未认证用户利用」——
受影响端点都在鉴权后，且修复后还要求 `PROXY_ADMIN` 角色。
**这是个有教育意义的组合：漏洞在上游 SDK，暴露面在你的产品，
缓解手段是权限收紧而不是等上游。**

## 17. 端点面：不只是 chat

LiteLLM 代理的端点数量是它「网关」定位的直接体现。
实查 `litellm/proxy/` 下 FastAPI 装饰器：
**727 个命中 / 616 条唯一 path**（GET 336、POST 306、DELETE 47、PATCH 19、PUT 16、OPTIONS 3）。

按一级前缀 Top 15：

| 前缀 | 条数 | 前缀 | 条数 |
|---|---|---|---|
| `/v1` | 92 | `/model` | 13 |
| `/team` | 26 | `/health` | 13 |
| `/guardrails` | 19 | `/sso` | 12 |
| `/global` | 18 | `/tag` | 12 |
| `/policies` | 15 | `/public` | 11 |
| `/server` | 15 | `/user` | 11 |
| `/key` | 15 | `/organization` | 10 |
| `/config` | 13 | `/spend` | 9 |
| `/openai` | 13 | `/v1beta` | 9 |

**`/v1` 只占 92 条，其余 500+ 条是管理面。** 这个比例是「AI 网关」
和「LLM SDK」的分水岭：绝大部分代码不在转发请求，在管理谁能转发、花了多少、
出了什么问题。

**LLM 能力端点**（按 §5.1 的 36 个维度）覆盖：
chat completions、messages（Anthropic 格式）、responses、embeddings、
rerank、moderations、audio transcriptions / speech、image generations / edits /
variations、video generations、batches、files、fine-tuning、assistants、
realtime、vector stores（含 files）、search、ocr、count_tokens、
containers、sandbox、skills、evals、rag ingest / query、a2a、interactions。

三块比较新的：

- **Search**（`litellm/search/`）：15 个搜索 provider 文档页——
  Tavily、Brave、Exa、Perplexity、SearchAPI、SearXNG、Serper、Firecrawl、
  Google PSE、Linkup、Parallel AI、DataForSEO、You.com、APISerpent、DuckDuckGo。
  **把「搜索」也纳入同一个计费与限流面**，因为 agent 用搜索和用 LLM 一样烧钱。
- **RAG**（`litellm/rag/`，15 文件 3,454 行）：含 `ingestion/` 与 `text_splitters/`
- **A2A**（`litellm/a2a_protocol/`，29 文件 4,583 行）：Agent-to-Agent 协议，
  106 个 provider 在支持矩阵里标了 `a2a`

**Pass-through 端点**是另一类：`proxy/pass_through_endpoints/` 下有
`llm_provider_handlers/`、`managed_id_codec.py`、`managed_id_rewriter.py`、
`passthrough_guardrails.py`、`upstream_usage_headers.py`。
文档 15 页，覆盖 Anthropic、Bedrock、Vertex（含 Live WebSocket 与 Search Datastore）、
Google AI Studio、Azure、OpenAI、Cohere、Mistral、vLLM、AssemblyAI、Langfuse、
**以及 Cursor**。
**透传的意义是「provider 的独有能力不被统一格式截断」**——
你可以直接用 Vertex 的原生 API，同时仍然过 LiteLLM 的鉴权与记账。
`managed_id_rewriter.py` 的存在说明它还要处理跨 provider 的资源 ID 映射
（在透传场景下 provider 返回的 ID 不能直接给客户端）。

## 18. 部署与生产调优

这一节的多数内容来自 `docs/proxy/prod.md`，它是本文读到的**最有信息量的一页官方文档**——
不是因为长，而是因为它解释了「为什么」而不只是给数字。

**部署形态**：

| 方式 | 位置 |
|---|---|
| Docker | 根 `Dockerfile`（多阶段：uv → UI builder → builder → runtime）、`docker/Dockerfile.database`、`docker/Dockerfile.non_root` |
| docker-compose | `docker-compose.yml`（litellm + db + prometheus 三服务） |
| Helm | `helm/litellm-helm`（chart 1.1.1 / appVersion v1.85.1），另有 componentized chart |
| Terraform | `terraform/`，另有独立仓库 `terraform-aws-litellm`、`terraform-google-litellm`、`terraform-provider-litellm` |
| PaaS | Render、Railway（README 里有一键部署按钮） |

**镜像签名**：仓库根有 `cosign.pub`，文档 `docker_image_security.md` 讲怎么验。
这是供应链侧的实际措施（对应 `security.md` 把供应链攻击列为 **P0**，§22）。

**加固形态**：`docker-compose.hardened.yml` 是个值得一读的样本——
`user: "101:101"`、`read_only: true`、`cap_drop: ALL`、
`no-new-privileges:true`、可写目录全走 `tmpfs` 且带 `noexec,nosuid,nodev`，
再串一个 squid 出站代理。**它明确标注是给 QA/加固测试用的，不是默认栈**，
但它同时也是「这个服务能在多严的约束下跑起来」的可执行证明。

### 18.1 内存是高水位，不是当前用量

`prod.md` 里最反直觉的一段（原文转述）：

> 给每个 pod **1 vCPU + 4Gi**，requests 与 limits 都设，且**按 worker 数等比放大**。
> 4Gi 是**下限不是目标**。代理的稳态内存占用**不是并发请求数的函数**：
> Prisma 把查询引擎跑成独立进程，它的常驻内存表现为**高水位**——
> 长到「这个引擎执行过的最大单条语句」那么大，而 glibc 之后**不把这块内存还给操作系统**。
> 于是一个 pod 的内存地板会**棘轮式抬升到它历史最差的那次写入**，并在该 worker 生命周期内保持。

两个直接推论，文档都点明了：

1. **不要用内存做扩容信号**（`targetCPUUtilizationPercentage: 60`，内存目标留空）。
   理由是内存反映的是「历史最大一次写」而不是「现在在干什么」——
   按内存扩会在一次大写后把副本数拉上去且**再也缩不回来**。
2. **最大的语句来自开了 `store_prompts_in_spend_logs` 的 spend 日志**，
   因为那时每行带完整 prompt 与响应而不只是计数。
   **存 prompt 就要在 4Gi 之上再留余量。**

这段解释的价值在于：**「OOM crash loop 而其他指标都正常」这个现象，
如果不知道高水位机制，是查不出来的。**

`60` 而不是更高的阈值也给了理由：`litellm-helm` 的 startup probe
允许 pod 最多 **300 秒**才通过首次就绪检查，
所以 80% 才触发的副本会在饱和发生**几分钟后**才到位。
文档还诚实地说了两个 chart 的默认值更高（litellm-helm 80、componentized gateway 70），
「是为了到处都能装干净，生产请自己调低」。

### 18.2 worker 模型

- **K8s 上**：一个 pod 一个 Uvicorn worker，横向扩 pod 而不是纵向加 worker。
  理由三条：延迟可预测、HPA 读单进程 CPU 才准、滚动重启能无损（K8s 一次只 drain 一个 pod）。
- **单 VM 上**：反过来，`NUM_WORKERS` 设成 vCPU 数，否则核用不上。
- **内存缓慢增长**：用 `--max_requests_before_restart 10000` 定期回收 worker。

**sizing 与连接池都是按 worker 计的**，所以八个 worker 的机器要八倍内存地板、
**每个 worker 只能拿八分之一的连接池**。这条最容易配错。

### 18.3 数据库

`general_settings` 里 122 个配置项有相当一部分是 DB 相关，文档单列了几节：

- 连接池上限与超时、**限制空闲连接**、透传额外 Prisma URL 参数
- **限制 statement 与 lock 时间**（防一条慢查询拖垮整池）
- **关掉服务端预编译语句**（`disable_prepared_statements`）——
  这条通常是为了过 PgBouncer 之类的连接池中间件
- **批量写 spend**（`batch spend writes`）+ Redis 事务缓冲
- **DB 不可用时优雅降级**（`allow_requests_on_db_unavailable`）——
  **网关不该因为记账数据库挂了就拒绝转发请求**，这是个明确的可用性取舍
- **把 error log 挡在数据库外**（默认会写 `LiteLLM_ErrorLogs`）
- 迁移从 Helm PreSync hook 跑、`migrations/` 目录、`db_scripts/`

`docs/proxy/db_read_replica.md`（读副本）与 `db_deadlocks` 相关页说明这层遇过真问题。
官方博客 `Incident Report: Prisma DB Reconnect Blocks the Event Loop and Kills LiteLLM`
（2026-04-29）是其中一次：**Prisma 重连阻塞了事件循环**——
在 asyncio 服务里，一个同步阻塞调用就能让整个进程停止响应。

### 18.4 其他生产项

- **master key** 与 **salt key** 必须设（salt key 用于加密存储的凭据，**设定后不能改**）
- **关掉 `load_dotenv`**（生产不该从 `.env` 读）
- `request_timeout` 必设
- 告警打开（`alerting`，支持 Slack webhook 与 PagerDuty）
- **配置跨 pod 重载调优**（多 pod 时 DB 配置同步的节奏）
- Redis：事务缓冲、`redis_circuit_breaker`（官方博客有专帖）
- `pyroscope_profiling.md`：连续 profiling
- `high_availability_control_plane.md`、`multi_region.md`、`shared_health_check.md`

**健康检查**分三层（`docs/proxy/health.md`）：
probe 端点（给 K8s）、Admin UI 里的模型健康、
**后台健康检查**（周期性真调一次 provider，结果写 `LiteLLM_HealthCheckTable`）。
后者的取舍很明确：**它要花真钱**，所以有 `health_check_interval` 之类的调优项，
且文档专门讲了不同 `mode` 的模型要用不同的探测方式（chat 发一句话、embedding 发一个词）。

## 19. 两个 CLI 与 Admin UI

### 19.1 `litellm`：起服务

`litellm/proxy/proxy_cli.py`（1,423 行）暴露 **47 个 `@click.option`**（源码实查）。
按用途分组：

| 组 | 选项 |
|---|---|
| 监听 | `--host` `--port` `--ssl_keyfile_path` `--ssl_certfile_path` `--ciphers` |
| 进程模型 | `--num_workers` `--run_gunicorn` `--run_hypercorn` `--run_granian` `--granian_threads` `--limit_concurrency` `--keepalive_timeout` |
| **worker 回收** | `--max_requests_before_restart` `--max_requests_before_restart_jitter` `--timeout_worker_healthcheck` |
| 配置 | `--config/-c` `--save` `--setup` `--local` `--reload` `--log_config` |
| 模型直传 | `--model/-m` `--alias` `--api_base` `--api_version` `--add_key` `--headers` |
| 请求默认值 | `--temperature` `--max_tokens` `--request_timeout` `--drop_params` `--add_function_to_prompt` `--max_budget` |
| 数据库 | `--use_prisma_db_push` `--enforce_prisma_migration_check` `--use_v2_migration_resolver` `--iam_token_db_auth` |
| 诊断 | `--test` `--test_async` `--health` `--num_requests` `--debug` `--detailed_debug` `--version/-v` |
| 其他 | `--telemetry` `--use_queue` `--skip_server_startup` |

::: warning 这里我自己先数错了一次，值得留在文里
第一版脚本用的正则是 `"(--[a-z0-9\-]+)"`，**漏了下划线**，
于是把 `--num_workers`、`--detailed_debug`、`--max_requests_before_restart`
这类全部漏掉，数出 **17** 个。加上 `_` 后是 **47** 个。
「所有计数写脚本数」不等于「脚本数出来就对」——**正则的字符类本身就是一次口径选择**。
这一处的正确写法是 `"(--[a-zA-Z0-9\-_]+)"`。
:::

三处值得注意：

- **四种 ASGI 服务器可选**（默认 Uvicorn，另有 Gunicorn / Hypercorn / Granian），
  对应 §18.2 那套 worker 讨论。
- **`--max_requests_before_restart` 与它的 `_jitter` 成对出现**：
  定期回收 worker 治内存高水位（§18.1），
  而 jitter 是为了避免所有 worker 同时重启造成流量断崖。
- `--test` / `--test_async` / `--health` / `--num_requests`
  让它能当一次性诊断工具用，不必真起服务。

### 19.2 `lite` / `litellm-proxy`：管服务

这是**另一个** CLI（同一实现，两个入口名），管的是一个已经跑起来的代理。
源码实查 `main.py` 注册了 **18 个顶层命令/组**：

| 组 | 子命令 |
|---|---|
| `models` | `list` `add` `delete` `get` `info` `update` `import` |
| `keys` | `import`（+ 通用 CRUD） |
| `users` | `list` `get` `create` `delete` |
| `teams` | CRUD |
| `credentials` | CRUD |
| `model-groups` | `list` |
| `config` | `set` `get` `unset` |
| `auth` | `login` `logout` `print-token` `whoami` |
| `encryption` | `migrate` |
| `chat` | 直接发一次对话（测试用） |
| `http` | 发任意 HTTP 请求到代理（逃生舱） |
| `up` / `down` | 起停本地栈 |
| `autoroute` | 自动路由相关 |
| `agent` | agent 相关（含 `binary`） |
| 顶层 | `login` `logout` `whoami` |

**`lite login` 那条值得单独说**：文档 `management_cli.md` 有一节
「Run coding agents through the proxy」——`lite login` 拿到的凭据可以直接给
Claude Code / Codex 这类客户端用（§21）。
**`http` 子命令是个诚实的设计**：616 条路由不可能都包一遍 CLI，
留一个直通口比包一半更好用。

### 19.3 Admin UI

`ui/litellm-dashboard`：实查 **1,598 个 ts/tsx 文件**、`.tsx` 合计约 **238,060 行**
（Next.js 静态导出，构建产物committed 到 `litellm/proxy/_experimental/out/`，
并由 maturin 的 `include` 打进 wheel——§4 那 3359 个 zip 条目里有相当一部分是它）。

DB 侧有 `LiteLLM_UISettings`、`LiteLLM_ConfigOverrides` 支撑「UI 上改了立刻生效」。
文档相关页 20+ 个（`ui.md`、`ui_logs.md`、`ui_logs_sessions.md`、
`ui_spend_log_settings.md`、`ui_search_tools.md`、`ui_project_management.md`、
`model_compare_ui.md`、`custom_root_ui.md`、`pricing_calculator.md` 等）。

**能关**：`disable_admin_ui`。Swagger 也能关（`disable_swagger`、`disable_redoc`），
且企业版可以改 Swagger 的品牌与暴露的路由（§20）。
**默认带一个管理 UI 的网关，把「关掉它」做成一个配置项，是合理的**——
UI 是最大的一块攻击面，而很多部署根本不需要它。

## 20. 开源与企业版的边界

这是选型时最需要先看清的一章，因为**边界不在「功能列表」里，在代码的三个地方**。

### 20.1 许可怎么切的

根 `LICENSE` 文件（26 行）开头就说明了切法：

> * All content that resides under the **"enterprise/" directory** of this repository...
>   is licensed under the license defined in "enterprise/LICENSE".
> * Content **outside** of the above mentioned directories... is available under the **MIT** license.

`enterprise/LICENSE.md` 是 **BerriAI Enterprise License**：
只有在同意并遵守 BerriAI 订阅条款、或持有有效企业许可的前提下，
才能**在生产中使用**该目录下的软件。

**所以「LiteLLM 是 MIT」这句话是对的但不完整**：
主体 MIT，`enterprise/` 目录另计。
GitHub API 的 `license` 字段实测返回 **`NOASSERTION`**，
正是因为这种混合许可无法归入单一 SPDX 标识。

### 20.2 企业版代码在哪

实查三处，它们是三种不同的机制：

| 位置 | 实测 | 机制 |
|---|---|---|
| `enterprise/` 目录 | 149 个 py / 10,782 行 | 单独许可的源码，含 `litellm_enterprise/` 包 |
| `pyproject.toml` 依赖 | `litellm-enterprise==0.1.54` | **作为普通依赖被装进来**（uv workspace member） |
| `[tool.maturin] exclude` | `litellm/proxy/enterprise` | **构建 wheel 时排除**这个路径 |

第二条要读准：`litellm-enterprise` 是 PyPI 上一个**独立发布的包**，
被主包依赖。也就是说**代码装到了你机器上**，能不能用是另一层判定。

### 20.3 运行期怎么判

`CommonProxyErrors` 枚举（源码实查）里有三条与此相关：

```
not_premium_user                 # 出现 34 次
missing_enterprise_package       # 出现 5 次
missing_enterprise_package_docker # 出现 5 次
```

引用 `premium_user` 的 proxy 文件实查 **25 个**。判定链是：
`proxy/auth/litellm_license.py` 校验许可 → 置 `premium_user` 标志 →
各处功能入口检查这个标志，不满足就抛 `not_premium_user`。

**这是「代码开源、许可闸门」模式**：你能读到全部实现，
但生产使用受许可约束，且运行期有主动检查。
与之相对的 `missing_enterprise_package` 是另一种情况——
包根本没装（Docker 镜像有专门文案，说明镜像分版本）。

### 20.4 企业版给什么

`docs/enterprise.md`（29,476 字节）的 "Core Enterprise Features" 分 5 组共 **29 项**（实查计数）：

| 组 | 项数 | 内容 |
|---|---|---|
| **Security & Access Control** | 9 | Admin UI SSO、JWT 鉴权、**带保留策略的审计日志**、RBAC、公私路由控制、IP ACL、Key 轮换、Secret Manager、AI Hub |
| **Governance & Cost Control** | 7 | 多租户架构、Project 管理、Tag 预算、**按虚拟 key 的分模型预算**、临时提额、软预算邮件告警、支出报表 |
| **Observability & Compliance** | 5 | 团队维度日志、**按团队关闭日志**、日志导出到 GCS/Azure Blob、按 key/team 的 guardrail、强制必填参数 |
| **Operations & Branding** | 4 | 自定义 Swagger 品牌、自定义邮件品牌、请求/响应体积上限、团队自管模型 |
| **Projects** | 4 | 按应用/环境/客户分组 key、按项目预算与限流、专属 owner 与看板 |

**边界画在哪里，是有规律的**：

- **核心调用能力全部在 OSS**——132 个 provider、7 种路由策略、
  三类 fallback、9 种缓存、51 个回调、49 个 guardrail 集成，都不要许可。
- **企业版收的是「多人多团队协作时的治理面」**：
  SSO、审计留存、RBAC、多租户、分账、按团队隔离日志。

这个切法的含义要说清楚：**一个人或一个小团队自建，OSS 版本功能是完整的**；
**一旦要给公司多个部门发 key 并且要能审计和分账，就落进企业版**。
`security_encryption_faq.md`、`docs/proxy/multi_tenant_architecture.md` 是这条线的文档。

另外两个企业向能力值得单独指出：

- **审计日志的「保留策略」在企业版**，而 `LiteLLM_AuditLog` 表本身在 OSS schema 里。
  表在、策略在闸门后。
- **`按团队关闭日志`**（disable logging per team）是个反直觉的企业功能——
  它卖的不是「记更多」而是「能不记」，因为某些团队的数据不许出域。

## 21. 与编码 Agent 的集成

这一节对本站读者最相关：LiteLLM 是**目前把「给编码 agent 当网关」这件事文档化得最细的产品**。
`docs/tutorials/` 共 68 页，其中 **17 页以 `claude_` 开头**（实查）。

**能接的客户端**（各有专页）：
Claude Code、Claude Agent SDK、Claude Desktop、Codex、Cursor、GitHub Copilot、
Gemini CLI、OpenClaw、OpenAI Agents SDK、CopilotKit、ScaleKit AgentKit。

### 21.1 为什么接得上：协议层

关键是 §5.1 那个数字——**121 个 provider 支持 `messages` 端点**。
Claude Code 只会说 Anthropic 的 `/v1/messages`，
而 LiteLLM 把这个格式做成了与 OpenAI 格式等权的入口，
所以「让 Claude Code 用 GPT / Gemini / 本地模型」在协议层是通的
（对应文档 `claude_non_anthropic_models.md`）。

鉴权侧靠 §14.4 那个 `SpecialHeaders`：Claude Code 发 `x-api-key`，LiteLLM 认它。
客户端不需要知道自己在跟一个网关说话。

### 21.2 三种成本模式

`claude_*` 那 17 页覆盖了三种截然不同的付费路径，**这是本文见到的最有实用价值的一组区分**：

| 模式 | 谁付钱 | 怎么配 | 文档 |
|---|---|---|---|
| **网关代付** | 网关持有 provider key | 常规 `model_list` | `claude_code_cut_costs.md` |
| **BYOK**（自带 key） | **用户自己付给 Anthropic** | `forward_llm_provider_auth_headers: true` | `claude_code_byok.md` |
| **Max 订阅** | 用户的 Claude Max 月费 | 路由订阅流量过网关 | `claude_code_max_subscription.md` |

**BYOK 那一条的取舍写得很清楚**（文档原文转述）：
用户 `/login` 后 Claude Code 把自己的 Anthropic key 作为 `x-api-key` 发出，
LiteLLM 把它**转发给 Anthropic**（优先于网关配置的 key），
用户自己的 LiteLLM 代理 key 则通过 `ANTHROPIC_CUSTOM_HEADERS` 传。
于是：**钱由用户直接付给 Anthropic，而路由、日志、guardrail 仍然经过网关。**

**Max 订阅那一条更直白**：官方给的理由是
「Claude Code Max 订阅对重度用户比按 token 的 API 定价便宜」，
过网关的收益是「成本归因、预算与限流、guardrail」。
**这实际上是在说「本来不可见的订阅额度消耗，现在能按人按团队摊出来」**——
对内部平台方是刚需，对 Anthropic 的计费模型则是绕了个弯。
这类用法的长期可用性取决于上游条款，本文无法核验其合规边界。

### 21.3 附带能力

- `claude_code_prompt_cache_routing.md`：**按 prompt cache 亲和性路由**——
  同一会话尽量落到同一 deployment，否则 cache 全丢。
  这一条与 §9 的负载均衡是**直接冲突**的：
  cache 亲和要求「粘住」，负载均衡要求「摊开」。
  官方有专门的 autorouter prompt caching benchmark 帖。
- `claude_code_budget_statusline.md`：把预算余量显示在 Claude Code 状态栏——
  靠的是 §7 那个 `x-litellm-response-cost` 响应头。
- `claude_code_okta_sso.md`：用 Okta 管谁能用 Claude Code。
- `claude_code_plugin_marketplace.md` + DB 里的 `LiteLLM_ClaudeCodePluginTable`——
  **网关代管 Claude Code 插件市场**。
- `claude_code_skills.md` + `litellm/skills/`（2 文件 791 行）+ `LiteLLM_SkillsTable`。
- `claude_code_websearch.md` + `integrations/websearch_interception/`——
  **拦截 web search 走自己的搜索 provider**（§17 那 15 个）。
- `claude_code_customer_tracking.md`：按终端客户归集（用 §14.1 的 `EndUser`）。
- `claude_code_autorouter.md`：自动选模型。
- `save_claude_code_costs`（博客，2026-07-04）：「5 ways to cut Claude Code costs」。

::: tip 一个已修的事故，说明这块集成的脆弱处
官方博客 `Incident Report: Invalid beta headers with Claude Code`（2026-02-16）：
**Claude Code 发的 beta header 组合让请求失败。**
仓库里现在有 `anthropic_beta_headers_config.json` 与
`anthropic_beta_headers_manager.py` 专门管这件事，
外加一个 CI workflow `sync_anthropic_beta_headers`（文档同名页）自动跟进上游变化。
**给一个高速迭代的客户端当网关，意味着你要追它的私有 header 语义**——
这是「协议兼容」之外的持续成本。
:::

## 22. 性能口径：三套数字，互相不可比

::: danger 本节全部数字都是厂商自测，我们没有复现
以下三组数据来自 LiteLLM 官方文档与博客。**它们的测量条件互不相同，不能横向拼接**。
本文列出它们的目的是标清口径边界，不是背书。
:::

### 22.1 三组数字

**① 旧的文档口径**（`docs/proxy/perf.md`，全文只有 417 字节）：

> Throughput - 30% Increase：比裸 OpenAI API 高 30% 吞吐
> Latency Added - 0.00325 seconds：比裸调用多 3.25ms

**这一页已经与其他材料矛盾**：3.25ms 的 added latency 与下面那两组里
Python 路径的 7.5ms / 257.7ms 都对不上，且它没有版本号与日期。
**它是本文发现的最需要谨慎引用的一处官方数据。**

**② Rust 迁移公告**（博客 `litellm_rust_launch`，2026-06-22）：

| | 单请求 overhead | 负载下吞吐 | 峰值内存 |
|---|---|---|---|
| Rust gateway | `~0.05ms` | `6,782` req/s | `31.7MB` |
| LiteLLM (Python) | `~7.5ms` | `453` req/s | `358.9MB` |

**③ 跨网关对比**（博客 `rust_ai_gateway_benchmarks`，2026-07-22，
配套开源 harness `BerriAI/ai-gateway-bench`）：

| 网关 | p99 added latency | 峰值内存 | $/100 万请求 | 持续 RPS |
|---|---|---|---|---|
| **LiteLLM Rust** | **0.7ms** | **21.8MB** | **$0.000175** | ~2,814 |
| Portkey | 2.3ms | 90.4MB | $0.001042 | — |
| Bifrost | 4.5ms | 199.1MB | $0.001008 | ~2,744 |
| LiteLLM Python v1 | **257.7ms** | 329.5MB | $0.015354 | — |

Agentic 会话（30 轮 Claude Code / Codex 式循环）新增总耗时：
Rust `0.03s` / `0.016s`，Bifrost `0.13s` / `0.047s`，
Portkey `0.12s` / `0.09s`，Python `0.97s` / `0.24s`。

### 22.2 ②③ 两组的 Python 数字差 34 倍

`7.5ms` 与 `257.7ms` 都标称是「LiteLLM Python 的 per-request / p99 added latency」，
相差 **34 倍**。可能的解释是负载点不同（p99 vs 均值、QPS 不同、
是否开 logging），但**两篇博客都没有给出足以对齐的口径说明**，
所以本文只能指出这个差异存在，无法解释它。

**这正是「厂商自测数据不可拼接」的教科书例子**：
同一家、同一个被测对象、相隔一个月，两个数差 34 倍且都是官方发布。
引用任何一个时必须连带它的出处与日期。

### 22.3 官方自己列的免责条款（值得照抄）

`rust_ai_gateway_benchmarks` 那篇的自我限制写得比多数第三方评测都干净，
以下是原文要点：

- **上游是本地 mock**，所以绝对延迟是「网关自己那一片」，不是真实请求延迟；
  只能当同条件下的相对比较读。
- **所有网关都关掉了 logging callback、spend tracking、持久化**。
  「This isolates forwarding overhead; it is not a full-feature comparison,
  and enabling those would add cost to every gateway, **including ours**.」
- **单主机、每场景一次跑**（overhead 那组 n=5000），**没有重复试验的误差棒**，
  所以只能当数量级差异看。
- **这是厂商自跑的 benchmark**，护栏是可复现性：
  每个画进图的值都是 `results/` 里 commit 的 CSV。
- 对比版本：LiteLLM Rust beta、LiteLLM Python v1、Bifrost `v1.6.4`、Portkey OSS 当时版本。

结论段也没有夸大（原文转述）：**单轮对话里网关 overhead 相比模型延迟是噪声，
这些数字不该改变你的决定**；真正有意义的场景是「高请求率 + 快响应」
（embedding、分类、guardrail）与「多轮 agent 循环」。

**这段自我限定的存在，是这组数据可以被引用的原因**——
它把适用边界写在了数据旁边。

### 22.4 关掉 logging 这条限制有多重要

第二条免责（关掉所有 callback 与 spend tracking）值得单独强调，
因为它恰好排除了 §11、§14、§15 三章的全部内容：
**真实部署里这个网关的价值就是那些 callback 和记账**——
一个不记账、不落 spend log、不跑 guardrail 的 AI 网关几乎没有存在理由。

所以准确的读法是：**这组数字衡量的是「转发」这一层的成本下限，
不是「你实际会部署的那个东西」的成本。**
从 §18.1 那段 Prisma 高水位讨论也能反推——
真实负载下的内存瓶颈来自 spend 落库，而 benchmark 把它关掉了。

### 22.5 迁移路线图（已过期，作为史料保留）

`litellm_rust_launch`（2026-06-22）给了带日期的计划表：

| 计划节点 | 迁什么到 Rust |
|---|---|
| 2026-08-15 | `litellm.ocr()`（先 Mistral，再全部），然后 `/ocr` 路由 |
| 2026-09-01 | 同样的路径走 `/messages`，然后 `/chat/completions` |
| 2026-09-15 | **Router**：负载均衡、fallback、重试、冷却 |
| 2026-12-01 | **整个服务器**：FastAPI 变薄壳，最终纯 Rust（axum） |

**对着 §3 的实测状态看这张表，能读出真实进度**：
截至 2026-08-09（第一个节点前 6 天），
`/messages` 的 Rust 路径**已经存在**（`v1.94.0` 起，早于 9 月的计划）
但只覆盖 2 个 provider 且默认关闭；
`/chat/completions`、Router、整服务器都还没有。
**进度不是「落后」也不是「超前」，而是形态变了**：
从「按路由整条迁完」变成「按 provider 逐个开口子 + 默认回退」。
这个变化本身是合理的工程选择，但它意味着**那张表已经不能用来预测何时「默认走 Rust」**。

## 23. 安全与事故披露

::: warning 这一节按官方已公开的信息整理
以下 CVE 与事故**全部已修复且已由官方公开**，本文只做归集与时间线整理，
不含任何未公开信息，也不提供复现细节。
引用的目的是「这个项目怎么处理安全问题」，不是「它有多少洞」。
:::

### 23.1 漏洞分级与一条不常见的规定

`security.md`（4,271 字节）把漏洞分三档：

| 档 | 定义 | 赏金 |
|---|---|---|
| **P0** | 供应链攻击（污染 CI/CD，让 PyPI 包或 Docker 镜像指向被篡改的产物） | 有 |
| **P1** | 未认证的代理访问（未鉴权用户拿到受保护数据） | 有 |
| **P2** | 认证后的越权 | **无赏金** |

**它有一条不常见的硬性要求**：

> Reports that do not include a **video demonstrating the exploit** will be
> closed without review.

理由写在文档里：**「AI 工具让「听起来像真的」的漏洞报告变得很容易生产，
分诊它们会占掉处理真实问题的时间。」**
没有复现视频的报告直接关闭，补上视频会重开。

这条规定值得记下来，因为它是**一个具体的、被公开写进流程的 AI 副作用**：
安全响应的瓶颈从「发现漏洞」变成了「甄别报告」。

### 23.2 已公开的 CVE

| CVE / 公告 | 问题 | 修复版本 | 公开日 |
|---|---|---|---|
| **CVE-2026-30623** | MCP stdio 传输命令注入（源自 Anthropic MCP SDK 的 `StdioServerParameters`） | `v1.83.6-nightly` / `v1.83.7` | 2026-04-21 |
| **CVE-2026-42208** | 代理 API key 校验路径的 SQL 注入 | `v1.83.7`+ | 2026-04-29 |
| **CVE-2026-48710** / GHSA-4xpc-pv4p-pm3w | Host header 注入导致认证绕过 | `v1.84.0` | 2026-06-01 |

三条的披露方式有共同点，都是**先修进 stable、再发 GitHub Security Advisory、
再写博客解释影响面**，且都明确写了「谁不受影响」：

- MCP 那条：**未认证用户不可利用**（相关端点都在鉴权后），
  修复后还额外要求 `PROXY_ADMIN` 角色。
- Host header 那条：「Very limited deployments are potentially affected,
  and **no LiteLLM Cloud customers were affected**」，
  且云环境在公告发布**前**已经修好并回移到在用的发布线。

**「先修后披、明确说清谁不受影响」是负责任披露的标准形态**，
这里做到了。要注意的是**三条 CVE 都集中在 2026-04 至 06 这三个月**，
同期还有一篇 `security_hardening_april_2026`（2026-04-03，
"Vulnerability Disclosures and Ongoing Hardening"）——
这通常意味着**那段时间有人系统性地审了这个项目**，
而不是「那三个月忽然变得不安全」。

### 23.3 供应链

- **P0 就是供应链**，且是唯一被列在最高档的类别。
- `cosign.pub` 在仓库根，镜像可验签（§18）。
- `.gitguardian.yaml`（3,966 字节）、`osv-scanner.toml`、
  `.semgrep/rules/`、`ci_cd/TEST_KEY_PATTERNS.md`、
  `ci_cd/security_scans_readme.md`、`.github/workflows/codeql.yml`、
  `image-scan.yml`、`guard-fork-dependencies.yml`——**扫描面铺得比较全**。
- `license_cache.json`（72,782 字节）：依赖许可缓存。
- 博客 `Security Update: Suspected Supply Chain Incident`（2026-03-24）与
  `Mistral AI PyPI Supply Chain Attack — LiteLLM Not Impacted`（2026-05-12）——
  **后者是「上游被攻击时主动说明自己没受影响」**，这是个好实践。
- 还有 `Announcing LiteLLM x Microsoft ASSERT`（2026-06-03）与
  独立仓库 `BerriAI/litellm-security-wg`（生态安全工作组）。

### 23.4 事故复盘：10 篇

官方博客有 **10 篇标题以 `Incident Report` 开头**的帖子（按 frontmatter 的 `title` 实查），
全部带日期：

| 日期 | 事故 |
|---|---|
| 2026-02-10 | main 分支上的 model cost map 无效（§6） |
| 2026-02-16 | Claude Code 的 beta header 无效（§21.3） |
| 2026-02-18 | `encoding_format` 参数搞坏 vLLM embeddings |
| 2026-02-21 | `SERVER_ROOT_PATH` 回归破坏 UI 路由 |
| 2026-02-23 | cost map 重载后通配符把新模型挡住了 |
| 2026-02-24 | 多区域 Responses API 的 encrypted content 失败 |
| 2026-02-27 | 缓存淘汰关掉了还在用的 httpx client（§10） |
| 2026-03-18 | **guardrail 日志把 secret header 写进了 spend log**（§11.3） |
| 2026-04-29 | Prisma 重连阻塞事件循环（§18.3） |
| 2026-07-13 | Bedrock 上 Claude Code 的 prompt cache 失效 |

::: warning 这里也是我先数错的一处
第一次数的是**目录名**含 `incident` 的（得到 8 篇），
但 `claude_code_beta_headers` 与 `server_root_path` 两篇的目录名里没有 `incident`，
标题却是 `Incident Report:` 开头。**按 frontmatter 的 `title` 数才是 10 篇。**
和 §19.1 那次一样：**目录名与标题是两个口径，选错了就少数两条。**
:::

**把事故复盘公开发在产品博客上，且写清根因，是这个项目最值得肯定的一处工程习惯。**
它们也是本文很多章节的证据来源——
§10 的 `evicted_client_closer.py`、§18.1 的内存高水位讨论、
§6 那个定价表的风险提示，都能追到具体的某一次事故。

另有两篇不叫 incident 但同类：
`two_week_stability_update`、`stability`——**稳定性作为一个持续话题被公开跟踪**。

## 24. 发版机制与版本里程碑

### 24.1 每周一个 minor 的流水线

`docs/proxy/release_cycle.md` 把节奏写得很具体：

| 星期 | 发什么 |
|---|---|
| **周二** | 第一个 nightly `dev` 构建，开启下一个 minor（如 `1.86.0.dev1`） |
| **周四** | 第二个 nightly（累积，`1.86.0.dev2`） |
| **周六** | 切新 `rc`（`1.86.0rc1`）；**同时把上周的 `rc` 提升为 stable** |
| 次周二 | 下一条线的第一个 nightly，循环重开 |

三个通道的门槛递增：

- `1.x.x.devN`（nightly）：过 CI，**无人工评审**
- `1.x.xrcN`（rc）：过 CI + 人工评审 + 性能测试（文档标注 **pending — 还在实现**）+ **7 天早期测试窗口**
- `1.x.x`（stable）：rc 过了上面全部，再经第二轮人工测试后提升

**「每个周六同时做两件事」**（切本周 rc + 把上周 rc 提为 stable）
意味着 stable 与它的 rc **通常是同一份代码**，除非中途回移了修复。
文档明说：`1.85.0rc1` 变成 `1.85.0`，「identical to that rc unless a fix was backported」。

**版本号语义**（`1.84.0` 起变更）：
- `-stable` / `-nightly` 后缀**取消**，改用纯 PEP 440 / SemVer
- **MINOR = 每周计划发布**（可含新特性与新数据库表）
- **PATCH = 只给当前 stable 打 hotfix**
- MAJOR = 破坏兼容
- Docker 同时发 `1.84.0` 与 `v1.84.0` 两个 tag 指向同一镜像；**PyPI 只用不带 `v` 的形式**

**支持策略要注意**：「新的 stable 一出，旧的就不再支持」。
只有 MAJOR 变更才提供最多 **90 天**的旧镜像支持。
文档里还有一块 2026-05-18 的说明：原有的专业支持模式**正在废弃**，
新模式「在最终确定后再公布」——**截至本快照，企业支持模式处于过渡期**。

### 24.2 实测的发版节奏

PyPI JSON API 实查（含 dev/rc）：

| 月份 | 发布数 |
|---|---|
| 2026-01 | 10 |
| 2026-02 | 11 |
| 2026-03 | 9 |
| 2026-04 | 15 |
| 2026-05 | 23 |
| **2026-06** | **45** |
| 2026-07 | 38 |
| 2026-08（至 08 日） | 6 |

**总发布数 1229 个**（有文件的版本），其中 **185 个**是带 `dev`/`rc` 的非三段版本号。
首个版本 `0.1.0` 发布于 **2023-07-27**（与仓库创建同日）。

**2026-06 的 45 次发布是个异常峰值**，对照 §3.5 的时间线能看出原因：
那个月同时在做 uv/maturin 打包切换、Rust workspace 引入、
以及一次「打进去→回退→再打进去」的反复。**打包管道改动会成倍放大发布次数。**

各 minor 首次出现日期（实查）：

| 版本 | 首发 | 版本 | 首发 |
|---|---|---|---|
| 1.86 | 2026-05-17 | 1.92 | 2026-06-30 |
| 1.87 | 2026-05-20 | 1.93 | 2026-07-08 |
| 1.88 | 2026-05-29 | 1.94 | 2026-07-15 |
| 1.89 | 2026-06-06 | 1.95 | 2026-07-22 |
| 1.90 | 2026-06-21 | 1.96 | 2026-07-30 |
| 1.91 | 2026-06-23 | 1.97 | 2026-08-05 |

节奏与文档描述一致：**每 7～8 天开一条新 minor 线**。

### 24.3 带日期的功能里程碑

从 `litellm-docs` 的 `release_notes/` 实查（**131 个版本目录**，
最早 `v1.55.8-stable`，最新 `v1.96.0rc1`）。近期几条与本文各章相关的：

| 版本 | 日期 | 标题要点 | 相关章 |
|---|---|---|---|
| `v1.91.0` | 2026-07-04 | MCP OAuth v2、**Rust OCR Gateway**、Realtime 性能 | §3、§16 |
| `v1.92.0` | 2026-07-11 | Claude Sonnet 5、生产级 MCP OAuth、新 provider | §16 |
| `v1.93.0` | 2026-07-18 | GPT-5.6、客户端转发的 MCP 凭据 | §16 |
| **`v1.94.0`** | 2026-07-28 | **Router Plugins**、MCP 客户端持有凭据、共享健康检查 | §9.4、§18.4 |
| `v1.94.1` | 2026-07-30 | **团队 key 预算强制执行被回退** | §14 |
| **`v1.95.0`** | 2026-08-01 | Claude Opus 5、MCP Gateway DCR、**Rust `/v1/messages`** | §3.3 |
| `v1.96.0rc1` | 2026-08-03 | MCP Entitlements、Redis 配置同步、Auto-Router | §9.1、§13 |

**`v1.94.1` 那条「预算强制执行被回退」值得单独看**：
它是一个 PATCH 版本，内容是撤回上一个 MINOR 里的行为变更。
按 §24.1 的语义，PATCH 是给 stable 打 hotfix 的——
**这说明「团队 key 预算怎么算」在真实部署里踩到了兼容问题**。
这类回退是判断一个功能是否稳定的最直接信号，比 release note 的正面描述有用。

另外注意 `release_notes/` 里出现的日期与 PyPI 上传日期**不完全一致**
（如 `v1.95.0` 的 release note 日期是 2026-08-01，PyPI 上传是 2026-08-02），
**引用「某功能哪天有的」时要说明用的是哪个口径。**

### 24.4 文档仓库分离（引用者必读）

| 时间 | 事件 |
|---|---|
| 2026-04-17 | `BerriAI/litellm-docs` 仓库创建 |
| **2026-04-24** | 主仓 commit `c35f3a50ae`「docs: remove docs/my-website, point contributors to litellm-docs」 |
| 2026-06 前后 | 又有一次 `adf6eb75a4`「chore(docs): remove docs accidentally committed to litellm repo」(#31691) |

第二条说明**分离之后还发生过误提交回主仓**，所以主仓历史里能搜到文档文件
并不代表它们当时是有效的。

`litellm-docs` 现状实查：**1,766 个文件、749 个 md/mdx**，二级目录分布：

| 目录 | 页数 | 目录 | 页数 |
|---|---|---|---|
| `proxy/` | 201 | `pass_through/` | 15 |
| `providers/` | 178 | `search/` | 15 |
| `tutorials/` | 67 | `troubleshoot/` | 10 |
| `observability/` | 49 | `secret_managers/` | 9 |
| `completion/` | 32 | `adding_provider/` | 6 |
| `projects/` | 30 | 其余 | <6 |

加上 `release_notes/` 131 个与 `blog/` 79 篇。
**`proxy/` 201 页 vs `providers/` 178 页**这个比例再次印证 §17 的观察：
这个产品的复杂度在网关侧，不在 provider 适配侧。

## 25. 对照：网关与「客户端自带 provider 层」

::: warning 这一节的证据强度低于前面各章
本系列前九篇（Claude Code / Codex / opencode / OpenClaw / Reasonix / Kimi Code /
Gemini CLI / hermes-agent / promptfoo）都是**编码 agent 或评测工具**，
**LiteLLM 是唯一的网关**，没有可直接对齐的维度表。
下面第一张表里 Portkey / Bifrost 两列**只有 LiteLLM 自测 benchmark 一个来源**（§22），
**我们没有核验过它们的实现**——那两列请当作「LiteLLM 声称的对手位置」读，不是对标结论。
:::

### 25.1 同类网关（证据薄，仅供定位）

| 维度 | LiteLLM | Portkey | Bifrost |
|---|---|---|---|
| 实现语言 | Python（+ Rust 核心，默认关，§3） | — | Go（据其公开介绍） |
| 许可 | MIT + `enterprise/` 另计（§20） | OSS 版本 | — |
| 本文的证据 | 源码实查 + 发布物实测 | **仅 §22 那组厂商 benchmark** | **同左** |

**能说的只有一条**：LiteLLM 用 Python 写了一个要处理 132 个 provider、
616 条路由、925 个配置项的网关，**于是它的 per-request overhead 成了结构性问题**，
这正是 §3 那次 Rust 迁移的动因。用 Go/Rust 起步的竞品没有这个包袱，
但也没有它这个体量的 provider 覆盖与治理面。**这是同一个取舍的两端，不是优劣。**

### 25.2 与编码 agent 自带的 provider 层

这个对照更有意义，因为本系列前九篇都核验过各家的 provider 层。

| 维度 | LiteLLM（网关） | 编码 agent 自带 provider 层 |
|---|---|---|
| 位置 | 进程外，HTTP 一跳 | 进程内，函数调用 |
| provider 覆盖 | 132 个适配目录 / 2987 个模型条目 | 通常 10～80 个（opencode 75+、Reasonix 44 个预设） |
| 端点广度 | 36 个端点维度（§5.1） | 基本只有 chat / messages（+ 少量 embedding） |
| 谁看得见成本 | 网关（能跨用户跨团队汇总） | 只有本机这一个会话 |
| 谁能设限 | 网关（预算、限流、guardrail） | 客户端自己（自律） |
| 流式韧性 | 有 `MidStreamFallbackError` 语义（§9.3） | 各家自己实现重连/续传 |
| 额外延迟 | 有一跳（§22 那组数字量级） | 无 |

**关键区别是「谁持有 key」**：
agent 自带 provider 层时，key 在开发者机器上；
接网关后 key 在网关上，开发者拿到的是虚拟 key（§14.3，50 个字段的那张表）。
**这个转移是治理能力的全部来源**——预算、审计、guardrail 都建立在它上面。

**所以两者不是替代关系，而是分层**：agent 侧仍然需要自己的 provider 抽象
（因为它要处理流式渲染、工具调用循环、上下文压缩这些网关看不见的事），
而网关解决的是「一个组织里多个 agent 多个人共用一批额度」。
§21 那三种成本模式（网关代付 / BYOK / Max 订阅）本质上是在
**「key 归谁」这条线上给出的三个不同答案**。

### 25.3 LiteLLM 在这个位置上最独特的三点

1. **端点广度做到了 36 个维度**（§5.1、§17），
   把 search（15 个 provider）、rerank、OCR、RAG、A2A、MCP 都纳入同一个
   鉴权 + 记账 + 限流面。**「agent 用搜索和用 LLM 一样烧钱」这个观察被落成了产品结构。**
2. **治理面的粒度**：按异常类型分别设冷却阈值（§9.3 那 6 个字段）、
   按模型分别设预算（`model_max_budget`）、十张日聚合表（§14.1）、
   按 provider 加折扣或加价（§13 的 `cost_discount_config` / `cost_margin_config`）。
   **它不只是转发，它出账单。**
3. **公开事故复盘 10 篇 + 三条 CVE 全部先修后披**（§23）。
   在本系列覆盖的十个产品里，**这是把「我们哪里翻过车」写得最细的一家**。

### 25.4 明显更弱或需要认的代价

1. **Python 的 per-request overhead 是结构性的**，
   Rust 是正在进行的补救而不是已完成的事实（§3、§22.5 那张已偏离的路线图）。
2. **配置面 925 项、路由 616 条、环境变量源码侧 1143 个**（§13、§17）——
   这个体量本身就是运维负担，`prod.md` 那些非直觉的调优项（§18.1）是必读而非可选。
3. **默认分支不是 `main`**（§1）、**四周内最新稳定版没有 macOS wheel**（§4.2）、
   **仓库简介与实现不一致**（§3.1）——
   这三处都不是功能缺陷，但都会让「照文档/照惯例操作」的人踩坑。
4. **企业版闸门在运行期主动检查**（§20.3），
   多团队治理这条线上 OSS 版本会撞到 `not_premium_user`。
5. **一个功能常有两代实现并存**（`_v2` / `_v3` 后缀，§15），
   判断自己在用哪一代需要读配置而不是读文档。

## 26. 未能核验与存疑的部分

::: tip 本文没有验证的部分（照实列出）
类型 IV 的证据形态里有相当一部分是**公开信息**（有出处但我们没跑过）。
以下是本文明确**未能核验**的地方：

**性能类（全部是厂商口径）**
- §22 三组性能数字**没有任何一条是我们复现的**。
  benchmark harness（`BerriAI/ai-gateway-bench`）是开源的，但我们没有跑。
- **`7.5ms` 与 `257.7ms` 相差 34 倍的原因**——两篇官方博客都没给出可对齐的口径。
- **Portkey / Bifrost 两列的真实性能**（§25.1）：唯一来源是竞争方自跑的 benchmark。
- **`docs/proxy/perf.md` 那个 `0.00325s` 是什么时候测的**——该页无版本号无日期。
- **Mode 1（Python host + Rust 翻译）的实际收益**：官方公开的数字都是 Mode 2
  或独立 Rust gateway，Mode 1 没有单独数据（§3.4）。

**运行行为类（读了代码但没跑）**
- **Rust 路径的静默回退在真实流量下的命中率**（§3.3）——
  我们确认了回退逻辑存在，但没有实测「打开 `LITELLM_RUST` 后有多少比例真的走了 Rust」。
- **`x-litellm-rust` 响应头**：源码里有，我们没有起服务验证过实际返回。
- **§18.1 那段 Prisma 内存高水位机制**：这是官方文档的解释，我们没有独立验证
  glibc 不归还内存这一具体归因。
- **9 种缓存后端**里我们只确认了实现文件存在，没有逐个跑通。
- **49 个 guardrail 集成**同上——目录与文档都在，实际可用性未验。
- **agentic loop 那 5 个钩子的实际执行顺序**（§11.2）。

**边界与口径类**
- **环境变量 925（文档）vs 1143（源码正则）之间那 218 个的构成**（§13）——
  只能说这是两个不同口径的上下界，没有逐个分类。
- **企业版 29 项功能中哪些在 OSS 下会真的被 `premium_user` 拦住**（§20）——
  我们数了 34 处 `not_premium_user` 引用，但没有逐功能对照测试。
- **`policy_templates.json` 那 16 个合规模板是否真的满足对应法规**（§12）——
  这是法律判断，不是技术判断，本文不做评价。
- **§21.2 那三种成本模式（尤其 Max 订阅过网关）的上游条款合规性**——
  超出本文能核验的范围。

**版本与时效类**
- 本地源码是 **dev 检出（v1.97.0-dev.2）**，而 PyPI 稳定版是 **1.95.0**。
  **凡标「源码实查」的计数都数的是 dev 检出**，与 1.95.0 发布包可能有差异，
  这个差异我们没有逐项对齐。
- **`release_notes/` 的日期与 PyPI 上传日期不一致**（§24.3），
  我们没有确定哪个是「功能可用日」的权威口径。
- **1.94.2 补齐 macOS wheel 是否意味着该问题已系统性解决**（§4.2）——
  只观察到一个数据点，下一个 stable 会不会又漏，本文无法预测。

这些地方本文用「我没有核验」明确标注，而不是含糊过去。
:::

::: warning 三处我自己先数错、留在文里的地方
1. §19.1 的 CLI 选项数：正则 `--[a-z0-9\-]+` **漏了下划线** → 数出 17，实际 **47**。
2. §23.4 的事故复盘篇数：按**目录名**匹配 `incident` → 数出 8，
   按 frontmatter 的 `title` 数是 **10**。
3. §10 的缓存类型数：**收尾复核时**用 `[A-Z_]+` 提枚举成员名，
   **漏了含数字的 `S3 = "s3"`** → 复核脚本报 8，而正文写的 **9** 才是对的。
   （这次是复核脚本错、正文对，方向反了。）

三处都保留了经过，因为它们指向同一个教训：
**「所有计数写脚本数」只解决了「不靠目测」，没有解决「口径选得对不对」。**
脚本给出的每个数字都隐含一次口径选择——正则的字符类、数目录还是数标题——
而口径错了，脚本一样会自信地给出错的数。
第 3 条尤其值得记：**连复核脚本本身也会错，且它错的时候看起来和正文冲突，
容易反过来把对的正文改错。** 冲突时要回源码看原文，不是信后跑的那个脚本。
:::

---

## 参考资料

**一手源（本文实查的）**

- 源码：`BerriAI/litellm`，分支 `litellm_internal_staging`，
  检出 `v1.97.0-dev.2-104-g7b89b3a29f`（2026-08-08）
- 文档源文件：`BerriAI/litellm-docs`，`main` 分支 tarball（2026-08-09 拉取），
  749 个 md/mdx
- GitHub REST API：仓库元数据、语言占比、分支状态（2026-08-09）
- PyPI JSON API：`https://pypi.org/pypi/litellm/json`，1229 个版本的发布时间与文件清单
- 发布物实测：`litellm-1.95.0-cp312-cp312-manylinux_2_28_x86_64.whl`（26.3MB，解包）、
  `litellm-1.95.0.tar.gz`（17.5MB）、`pip download` 在 macOS arm64 上的实跑结果

**官方文档（引用的关键页）**

- [LiteLLM Docs](https://docs.litellm.ai/docs/)
- `docs/proxy/rust_gateway.md` — Rust AI Gateway（Beta），§3 的主要依据
- `docs/proxy/prod.md` — 生产调优，§18 的主要依据
- `docs/proxy/config_settings.md` — 四张配置参考表（162KB），§13
- `docs/proxy/release_cycle.md` — 发版流程，§24
- `docs/enterprise.md` — 企业版功能清单，§20
- `docs/routing.md` — 路由策略（61KB），§9
- `docs/proxy/guardrails/` — 53 页，§12
- 仓库内 `ARCHITECTURE.md`（18.9KB）、`security.md`、`CONTRIBUTING.md`、
  `litellm-rust/README.md`、`litellm-rust/ADDING_A_PROVIDER.md`

**官方博客（性能与事故，全部厂商口径）**

- `Migrating LiteLLM to Rust`（2026-06-22）— §22.1 ②、§22.5 路线图
- `Benchmarking the LiteLLM Rust AI Gateway`（2026-07-22）— §22.1 ③
- `Achieving Sub-Millisecond Proxy Overhead`（2026-02-02）— Q1 性能目标
- 10 篇 `Incident Report`（2026-02 至 2026-07）— §23.4
- 三条安全公告（CVE-2026-30623 / 42208 / 48710）— §23.2
- `AIGatewayBench` harness：`BerriAI/ai-gateway-bench`

**本站相关**

- 同系列：[Claude Code](/blog/ref-claude-code)、[Codex](/blog/ref-codex)、
  [opencode](/blog/ref-opencode)、[OpenClaw](/blog/ref-openclaw)、
  [Reasonix](/blog/ref-reasonix)、[Kimi Code](/blog/ref-kimi-code)、
  [Gemini CLI](/blog/ref-gemini-cli)、[promptfoo](/blog/ref-promptfoo)
  —— §25.2 的对照维度来自这几篇
- [LangGraph 深入研究（2026-08 快照）](/blog/ref-langgraph)——
  **系列里第一篇「框架」而非「产品」**。它和本篇共享同一个计数难题的另一面：
  LiteLLM 这边是「五个数据源给出五个 provider 数」，
  LangGraph 那边是「同一个『有多少公共 API』问题有五个合理口径，从 39 到 202」。
  另一处可对照的是**发行边界**：LiteLLM 是单包多形态（SDK / Proxy / CLI），
  LangGraph 是一个仓库 8 个独立版本号的包 + 2 个不在仓库里的 Elastic-2.0 运行时包。

---

::: info 最后一句
这份手册的价值在**全**，不在读完带走一个判断。
它记录的是 2026-08-09 这一天 LiteLLM 的样子：
**一个用 Python 写成、正在往 Rust 搬、把 Rust 核心装进了每个 wheel 却默认不用它的 AI 网关。**
两周后这句话可能就不准了——所以请连日期一起引用。
:::
