---
title: LangChain 深入研究（2026-08 快照）
description: 15 章逐节成册，按目录跳章查阅——把 LangChain 的包拓扑、API 契约与升级边界交叉核验到版本号级别：一个仓库 21 个包各自独立版本号、`libs/langchain/` 装的包叫 langchain-classic 而 `langchain` 在 langchain_v1/、核心 API 面四个口径差 10 倍、114 处 @deprecated 有 113 处瞄准 2.0.0、langchain 钉住 langgraph<1.3.0 而 langgraph 已到 1.2.10。这是一份手册，不是读完就走的文章。
date: "2026-08-09"
series: 热点开源项目研究
audience: engineer
highlight: 15 章逐节可查 · 核验至 langchain 1.3.14 / langchain-core 1.5.3 · 截至 2026-08-09 快照
tags: [LangChain, 框架, 深入研究, 包拓扑, 弃用迁移, Agent, 参考]
outline: [2, 3]
---

# LangChain 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-09
- **被调研版本**：这个问题**本身就没有单一答案**（这正是 §2 的主题）。本文核验的是
  本地检出 `langchain-ai/langchain` @ `d048fbe1`（2026-08-08，master 分支）里的
  **21 个包**，其中主要几个是：`langchain` **1.3.14**、`langchain-core` **1.5.3**、
  `langchain-classic` **1.0.8**。
  凡写「实查」的计数都数的是这个检出，不是任何一个 PyPI 发布包。
- **证据形态**：三类混合，逐条标注——
  ① **本地源码实查**（AST / 脚本计数，可复现）；
  ② **发布物元数据**（PyPI JSON API + npm registry + GitHub REST API）；
  ③ **仓库内文档**（`AGENTS.md`、各包 `README.md`、官方 `packages.yml`）。
  **没有任何性能数字**——本文不涉及运行时基准，因为我们没有跑过。
- **一手性说明**：包版本与依赖约束取自**本地检出的 `pyproject.toml` 实读**；
  API 面计数走 **Python `ast` 模块解析**，不是 grep 目测；
  Star 数、发版时间线、下载量取自 GitHub REST API / PyPI JSON API / 官方
  `packages.yml`（它自带 `downloads_updated_at` 时间戳，见 §11）。
  **没有使用任何渲染后的文档网页作为事实来源。**
- **时效边界**：这个仓库 2026-06 单月 **278 个提交**，`langchain-core` 2026-04
  单月发了 **15 个版本**。**这是 2026-08-09 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://docs.langchain.com/oss/python/langchain/overview)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 四条看起来显然、但在 2026-08 已经不成立的说法
读 LangChain 的第三方资料（乃至它自己官方的 `packages.yml`）时，这几条几乎必然会遇到：

1. **「`libs/langchain/` 目录里装的是 `langchain` 包」**——**不是了**。
   那个目录发布的包叫 **`langchain-classic`**，import 路径是 `langchain_classic`；
   而 PyPI 上的 `langchain` 包来自 **`libs/langchain_v1/`** 这个目录。
   官方 `AGENTS.md` 自己的目录树注释写得很清楚：
   `langchain/ # langchain-classic (legacy, no new features)`。
   **照目录名推断包名会全盘错位**，见 §1、§2。
2. **「LangChain 就是 chains 那一套（`LLMChain`、`load_qa_chain`）」**——
   在**现在的 `langchain` 包里一个都没有**。实查 `libs/langchain_v1/langchain/`
   只有 **35 个 py 文件 / 15,208 行**，7 个子模块，`grep "class .*Chain"` 命中 **0**。
   那 140 个 chains 文件全在 `langchain_classic` 里（1,321 个 py 文件 / 70,585 行）。
   **v1 不是 0.3 的升级版，是一次减法**，见 §6。
3. **「`langchain` 是纯开源、不依赖商业服务」**——**依赖**。
   `langchain-core` 的 9 个运行时依赖里第一个就是 `langsmith>=0.3.45,<1.0.0`
   （LangSmith 是 LangChain 的商业可观测性平台）。而且它不是可选 extra：
   `langchain_core/tracers/langchain.py`、`schemas.py`、`context.py` 等
   **5 个文件顶层无条件 `from langsmith import ...`**。见 §12。
4. **「官方 `packages.yml` 是包清单的事实源，照它抄就行」**——它自己会漂移。
   该文件（自称 "Source of truth for all LangChain packages and repos"）里
   `langchain-prompty` 仍标注 `path: libs/partners/prompty`，而这个目录
   已在 **2026-02-06（commit `f058e45dfb`「chore(infra): delete prompty」）** 被删除。
   远端 master 的 `libs/partners/` API 实查确认只有 15 个目录，没有 prompty。见 §11。

这四条都是「照名字/照文档推断，而不回源码实查」的代价。
本文标注的现状同样会漂移——引用前先看一眼日期。
:::

---

## 1. 定位与身份辨析：这个名字下面有几个东西

「LangChain」这个词在 2026-08 至少指四层不同的东西，混着说必然出错：

| 层 | 具体所指 | 形态 | 实查依据 |
|---|---|---|---|
| **公司 / 平台** | LangChain（README 自称 "The agent engineering platform"） | 商业实体 | 仓库 `description` 字段即此句 |
| **本仓 21 个包** | `langchain`、`langchain-core`、`langchain-classic`、15 个 partner… | PyPI 包，**各自独立版本号** | `libs/**/pyproject.toml` = 21 个 |
| **单个 `langchain` 包** | `libs/langchain_v1/` 发布的那一个，v1.3.14 | 35 个 py 文件 | AST 实查 |
| **生态（含仓外）** | `langgraph`、`deepagents`、`langchain-community`、149 个 repo | 独立仓库 | 官方 `packages.yml` |

**仓库元信息（GitHub REST API，2026-08-09 实查）**：

| 项 | 值 |
|---|---|
| 仓库 | `langchain-ai/langchain`，默认分支 `master` |
| 创建 | 2022-10-17 |
| Stars / Forks | **143,731** / 23,942 |
| Open issues | **430** |
| 语言占比 | Python **99.3%**、Makefile 0.5%、Shell 0.1% |
| License | MIT（21 个包全部一致） |
| 提交总数 | **16,554**（本地检出 `git rev-list --count HEAD`） |
| 仓库体积 | GitHub 报 588,331 KB；本地检出（含 `.git`）**641MB** |

**根目录实查只有 5 个文件 + 1 个目录**：`AGENTS.md`、`CITATION.cff`、`CLAUDE.md`、
`LICENSE`、`README.md`、`libs/`。⚠ **`AGENTS.md` 与 `CLAUDE.md` 字节数完全相同（18,831）**，
是同一份内容的两个副本（仓库有 `check_agents_sync.yml` 工作流保证同步），不是两份文档。

**根目录没有 `docs/`。** 文档在独立仓 `langchain-ai/docs`，见 §13。

### 1.1 官方在框架之上又叠了一层：deepagents

README 顶部第一个 `[!TIP]` 推荐的不是 LangChain 本体，而是 **Deep Agents**：

> Just getting started? Check out **Deep Agents** — a higher-level package built on
> LangChain for agents that have built-in capabilites for common usage patterns
> such as planning, subagents, file system usage, and more.

实查（GitHub API + PyPI，2026-08-09）：

| 项 | 值 |
|---|---|
| 仓库 | `langchain-ai/deepagents`，创建 **2025-07-27** |
| Stars | **27,521**（比 langchainjs 的 18,022 还高） |
| PyPI 最新 | **0.7.5**（2026-08-06），共 **117 个版本**，首发 2025-07-29 |
| 依赖 | `langchain>=1.3.14,<2.0.0`、`langchain-core>=1.5.0,<2.0.0`、`langchain-anthropic>=1.5.4,<2.0.0`、`langchain-google-genai>=4.3.1,<5.0.0` |

**两个事实值得注意**：① `deepagents` 的 langchain 下界 `>=1.3.14` **正好等于**本快照的
langchain 版本，说明它跟得极紧；② 它**硬依赖两个具体的 provider 包**
（anthropic + google-genai，非 extra），这与 LangChain 本体「provider 无关」的定位相反。

而且它反过来影响了本仓：`libs/standard-tests/` 里有 **86 个测试**
验的是 `deepagents.backends.protocol.SandboxBackendProtocol`——
**契约定义在 deepagents 仓，一致性测试却发布在 langchain 仓**。见 §8。

---

## 2. 包拓扑与版本矩阵：一个仓库，21 个版本号

「LangChain 是什么版本」这个问题**没有答案**。`libs/` 下实查 **21 个 `pyproject.toml`**，
每个都是独立发布、独立版本号的包。

### 2.1 全部 21 个包（本地检出实读，2026-08-09）

**核心 6 个（非 partner）：**

| 目录 | **发布包名** | 版本 | import 路径 | 内部依赖 |
|---|---|---|---|---|
| `libs/core` | `langchain-core` | **1.5.3** | `langchain_core` | `langchain-protocol>=0.0.17` |
| `libs/langchain_v1` | **`langchain`** | **1.3.14** | `langchain` | `langchain-core>=1.5.3,<2.0.0`、`langgraph>=1.2.5,<1.3.0` |
| `libs/langchain` | **`langchain-classic`** | **1.0.8** | `langchain_classic` | `langchain-core>=1.4.7,<2`、`langchain-text-splitters>=1.1.2,<2` |
| `libs/text-splitters` | `langchain-text-splitters` | 1.1.2 | `langchain_text_splitters` | `langchain-core>=1.4.7,<2` |
| `libs/standard-tests` | `langchain-tests` | 1.1.9 | `langchain_tests` | `langchain-core>=1.4.7,<2` |
| `libs/model-profiles` | `langchain-model-profiles` | **0.0.6** | `langchain_model_profiles` | 无 langchain 依赖 |

⚠ **前三行是本文最重要的一张表**。目录名与包名的错位有三处：

- `libs/langchain/` → 包名 `langchain-classic`、import `langchain_classic`
- `libs/langchain_v1/` → 包名 `langchain`（**没有 v1 后缀**）、import `langchain`
- 而 `langchain` 这个包的版本号是 **1.3.14**，不是 1.0.x——「v1」指的是**代次**，不是版本号

**15 个 partner 包（`libs/partners/`）：**

| 包名 | 版本 | `langchain-core` 下界 | 备注 |
|---|---|---|---|
| `langchain-anthropic` | **1.5.4** | `>=1.5.2` | 有 `middleware/` 子模块 |
| `langchain-openai` | **1.4.2** | `>=1.5.3` | 下界最高（与 core 当前版持平） |
| `langchain-fireworks` | 1.5.2 | `>=1.5.1` | |
| `langchain-perplexity` | 1.4.0 | `>=1.4.7` | |
| `langchain-xai` | 1.3.0 | `>=1.5.0` | **另依赖** `langchain-openai>=1.1.7` |
| `langchain-huggingface` | 1.2.2 | `>=1.4.7` | |
| `langchain-groq` | 1.1.3 | `>=1.4.7` | |
| `langchain-mistralai` | 1.1.6 | `>=1.4.7` | |
| `langchain-chroma` | 1.1.0 | `>=1.4.7` | |
| `langchain-deepseek` | 1.1.0 | `>=1.4.7` | **另依赖** `langchain-openai>=1.1.0` |
| `langchain-exa` | 1.1.0 | `>=1.4.7` | |
| `langchain-ollama` | 1.1.0 | `>=1.4.7` | |
| `langchain-qdrant` | 1.1.0 | `>=1.4.7` | |
| `langchain-nomic` | 1.0.1 | `>=1.4.7` | |
| `langchain-openrouter` | **0.2.7** | `>=1.4.7` | 唯一还在 0.x 的 partner |

**`langchain-core` 下界分布（15 个 partner 全量统计）**：`>=1.4.7` 占 **11 个**，
另有 `>=1.5.0`/`>=1.5.1`/`>=1.5.2`/`>=1.5.3` 各 1 个。
**上界 15 个全部是 `<2.0.0`**——没有一个 partner 钉到 minor。

**21 个包的 `requires-python` 完全统一**：`>=3.10.0,<4.0.0`（实查 21/21 一致）。

### 2.2 口径提醒：数包不能用 `ls | wc -l`

实查 `ls libs/partners | wc -l` 返回 **17**，而真实 partner 包是 **15**——
多出的两个是 `Makefile` 和 `README.md`。两个正确口径互相印证：

```bash
find libs/partners -maxdepth 1 -mindepth 1 -type d | wc -l   # 15
find libs/partners -maxdepth 2 -name pyproject.toml | wc -l  # 15
```

同理 `libs/` 下「有几个包」的正确口径是数 `pyproject.toml`（21），
不是数目录（那会把 `Makefile`、`README.md` 算进去）。

---

## 3. 依赖约束图与升级边界

这一章是框架研究相对产品研究**多出来的那一层**：单个包的版本号谁都查得到，
而「这些约束放在一起是否自相矛盾、哪个上界快撞了」需要把它们摆在一处才看得见。

### 3.1 一个已经贴到上界的约束

```
langchain 1.3.14  →  langgraph>=1.2.5,<1.3.0     ← 钉到了 minor
langgraph 实际最新 =  1.2.10                      ← PyPI 实查
```

**`langgraph` 现在是 1.2.10，一旦发 1.3.0 就直接出 `langchain` 的约束范围。**
PyPI 实查确认目前**没有任何 1.3.x 版本**（连 alpha 都没有），1.2.x 系列已发到第 10 个补丁
（1.2.0 于 2026-05-12，1.2.10 于 2026-07-28）。这类「窄区间 + 已接近上界」的观察
在产品研究里没有对应物——它决定的是读者**能不能升级**。

⚠ 注意这是 **21 个包里唯一一个钉到 minor 的 langchain 内部依赖**。
其余全部是 `<2.0.0` 这样的宽上界。为什么单独给 langgraph 这个待遇，
官方文档没有解释，本文**无法核验其动机**。

### 3.2 双向依赖与传递链

```
langchain-core 1.5.3    →  langchain-protocol>=0.0.17   （core 依赖一个 0.0.x 的包）
langchain 1.3.14        →  langchain-core>=1.5.3,<2.0.0 + langgraph>=1.2.5,<1.3.0
langgraph（仓外）        →  langchain-core               （反向也成立）
deepagents 0.7.5（仓外） →  langchain>=1.3.14 + langchain-core>=1.5.0
                          + langchain-anthropic>=1.5.4 + langchain-google-genai>=4.3.1
```

⚠ **`langchain-core` 1.5.3（一个 143k star 项目的核心包）依赖 `langchain-protocol>=0.0.17`
——一个版本号还是 `0.0.x` 的包。** PyPI 实查：`langchain-protocol` 最新 **0.0.18**，
共 **11 个版本**，首发 **2026-04-16**（首个公开版本就是 0.0.8），
summary 是 "Python bindings for the LangChain agent streaming protocol"，
源码在**第三个仓库** `langchain-ai/agent-protocol`（647 stars，创建 2024-11-12）的
`streaming/` 子目录下。

它不是可选依赖，core 里 **9 处 import**，其中
`language_models/chat_models.py:16` 是顶层无条件 `from langchain_protocol.protocol import MessageFinishData`。
另有一个文件名就叫 `_compat_bridge.py`，其注释明确写着它在桥接两套 shape：
「one in `langchain_protocol.protocol` (the wire/event shape)」。

**含义**：core 的流式协议层已经外置到一个独立演进、语义化版本还在 0.0.x 的包里。
按 semver 惯例 0.0.x 不承诺任何兼容性，而 core 用的是 `>=0.0.17` 的**开放上界**。

### 3.3 partner 的传递依赖

15 个 partner 里有 **2 个**不直接对接自家 provider，而是走 `langchain-openai`：

| Partner | 依赖链 |
|---|---|
| `langchain-deepseek` 1.1.0 | `langchain-openai>=1.1.0,<2.0.0` + `langchain-core>=1.4.7` |
| `langchain-xai` 1.3.0 | `langchain-openai>=1.1.7,<2.0.0` + `langchain-core>=1.5.0` |

这两家的 API 兼容 OpenAI 协议，所以适配层复用了 `langchain-openai`。
**代价是升级路径被串联**：`langchain-openai` 出问题，这两个包一起受影响。

---

## 4. 仓库结构与规模

### 4.1 代码规模（本地检出实查）

| 口径 | 数字 |
|---|---|
| `libs/` 下 `.py` 文件（含 tests） | **2,534** |
| `libs/` 下 `.py` 文件（排除 tests） | **1,738** |
| `langchain_core` py 文件 / 行数 | **181** / **69,642** |
| `langchain_classic` py 文件 / 行数 | **1,321** / **70,585** |
| `langchain`（v1）py 文件 / 行数 | **35** / **15,208** |
| `langchain_tests` py 文件 / 行数（含 tests 目录） | 36 / **9,820** |

**这张表本身就是 §6 那个「减法」结论的量化形态**：
新的 `langchain` 包只有 15,208 行，而 legacy 的 `langchain_classic` 有 70,585 行——
**后者是前者的 4.6 倍**，而 core 与 classic 的行数几乎持平（69,642 vs 70,585）。

### 4.2 官方自述的分层（`AGENTS.md` 原文口径）

`AGENTS.md` 里给出四层，措辞值得原样引用：

- **Core layer**（`langchain-core`）："Base abstractions, interfaces, and protocols.
  **Users should not need to know about this layer directly.**"
- **Implementation layer**（`langchain`）："Concrete implementations and high-level public utilities"
- **Integration layer**（`partners/`）："**this monorepo is not exhaustive of all
  LangChain integrations**; some are maintained in separate repos, such as
  `langchain-ai/langchain-google` and `langchain-ai/langchain-aws`"
- **Testing layer**（`standard-tests/`）："Standardized integration tests for partner integrations"

⚠ 第一条与实践有张力：core 的 34 个公共抽象基类（§5）正是第三方实现者
**必须**直接打交道的东西。这句话面向的是终端用户，不是集成开发者。

### 4.3 CI 规模

`.github/workflows/` 实查 **27 个工作流文件**。其中几个反映了本文其他章节的机制：

| 工作流 | 对应机制 |
|---|---|
| `_release.yml` | 逐包独立发布（§14） |
| `_refresh_model_profiles.yml` + `refresh_model_profiles.yml` | 模型 profile 自动刷新（§10） |
| `check_versions.yml`、`check_release_deps.yml` | 版本与依赖一致性门禁（§3） |
| `check_agents_sync.yml` | 保证 `AGENTS.md` = `CLAUDE.md`（§1） |
| `check_extras_sync.yml` | extras 声明同步 |
| `_test_pydantic.yml`、`_test_vcr.yml` | pydantic 多版本 / VCR 录制回放 |
| `codspeed.yml` | 性能基准（本文未核验其结果） |

**提交节奏（本地 git 实查，按月）**：2026-03 **233**、2026-04 **201**、2026-05 **241**、
2026-06 **278**、2026-07 **145**、2026-08（截至 08-08）**60**。

---

## 5. 核心抽象：API 契约面（口径必须自证）

**这一章的每个数字都必须连口径一起读。** 「langchain-core 的 API 面有多大」
这个问题，四个都算合理的口径给出的答案差了 **10 倍以上**。

### 5.1 四个口径，四个数字

| 口径 | 数字 | 能不能用 |
|---|---|---|
| 顶层 `langchain_core/__init__.py` 的 `__all__` | **0** | ❌ 该文件只有 20 行，**根本没有 `__all__`**，只做了两次 warning surfacing |
| 全仓所有 `.py` 里 `__all__` 加总 | **321**（去重 **314**，来自 28 个文件） | ❌ 把 `_api`、`_security` 等内部模块混了进来 |
| **19 个子包各自 `__init__.py` 的 `__all__` 加总** | **293** | ✅ 最接近「用户能 import 到什么」 |
| AST 数模块级公共 `class` / `def` | **304** / **278** | ⚠ 数的是实现规模，不是公共 API |

**顶层 `__init__.py` 只有 20 行**这件事本身是设计信息——它的全部内容是一句 docstring、
两个 warning surfacing 调用、一个 `__version__` 赋值。所有导出都下沉到子模块，
所以「`from langchain_core import X`」这种用法基本不成立。

### 5.2 293 是怎么分布的（19 个子包逐个）

| 子包 | `__all__` | 子包 | `__all__` |
|---|---|---|---|
| `messages` | **57** | `load` | 6 |
| `callbacks` | **34** | `example_selectors` | 5 |
| `runnables` | **29** | `vectorstores` | 4 |
| `utils` | 26 | `documents` | 3 |
| `prompts` | 21 | `embeddings` | 3 |
| `language_models` | 19 | | |
| `tools` | 19 | *（内部，不计入公共 API）* | |
| `output_parsers` | 17 | `_api` | 11 |
| `_api` / `_security` 见右 | | `_security` | 10 |
| `indexing` | 8 | | |
| `tracers` | 8 | | |
| `outputs` | 7 | | |
| `document_loaders` | 6 | | |

另有 **16 个顶层单文件模块**不在上表：`agents`、`caches`、`chat_history`、`chat_loaders`、
`chat_sessions`、`cross_encoders`、`env`、`exceptions`、`globals`、`prompt_values`、
`rate_limiters`、`retrievers`、`stores`、`structured_query`、`sys_info`、`version`。

⚠ **293 这个数含 `_api`（11）与 `_security`（10）两个私有子包。**
严格按「公共 API」口径应扣掉 21，得 **272**。本文后续引用时统一说明是哪个数——
**这正是「写 N 个 API 之前必须先说清 N 是怎么数的」的实例。**

### 5.3 抽象基类：34 个公共（正则会漏 2 个）

数 ABC 时正则与 AST 又不一致，差异可以精确解释：

| 口径 | 数字 | 差异原因 |
|---|---|---|
| `grep -E "^class \w+\(.*ABC.*\):"` | **34** | 假设 class 签名在一行内 |
| AST 遍历 `bases` 含 `ABC` | **36** | 多捕获 `BaseLanguageModel`、`BasePromptTemplate` |

两个多出来的都是**多行 class 签名**（正则的 `^class ... :` 匹配不到）。
另外 AST 的 36 里有 **2 个私有类**（`_TracerCore`、`_VectorStoreExampleSelector`），
扣掉得 **34 个公共抽象基类**——与正则的 34 数值巧合相同，但**成分不同**
（正则集合里含那 2 个私有类、缺那 2 个多行签名）。

**34 个公共抽象基类全清单**（AST 口径，排除私有）：

`AsyncBaseTracer`、`AsyncRunManager`、`BaseBlobParser`、`BaseCache`、`BaseChatLoader`、
`BaseChatMessageHistory`、`BaseChatModel`、`BaseChatPromptTemplate`、`BaseCrossEncoder`、
`BaseDocumentCompressor`、`BaseDocumentTransformer`、`BaseExampleSelector`、`BaseLLM`、
`BaseLLMOutputParser`、`BaseLanguageModel`、`BaseLoader`、`BaseMessagePromptTemplate`、
`BasePromptTemplate`、`BaseRateLimiter`、`BaseRetriever`、`BaseStore`、
`BaseStringMessagePromptTemplate`、`BaseToolkit`、`BaseTracer`、`BlobLoader`、`Embeddings`、
`FilterDirective`、`PromptValue`、`RecordManager`、`Runnable`、`Serializable`、
`StringPromptTemplate`、`VectorStore`、`Visitor`

### 5.4 两个关键契约的实际形状

**`Runnable`**（`runnables/base.py`，**6,714 行**）：

| 项 | 值 |
|---|---|
| 公共方法/属性（去 `@overload` 后） | **39** |
| 其中 `@property` | 5 |
| **抽象方法** | **仅 1 个：`invoke`** |

**只有 `invoke` 是抽象的**——`ainvoke`、`batch`、`stream`、`astream_events` 等 38 个
全部有默认实现。这是「实现一个方法就得到全套调用形态」的设计，
代价是默认实现的语义（如 `batch` 是否并发）由基类决定，子类不覆写就继承那个决定。

⚠ 注意原始 AST 计数是 **49**，去掉 `@overload` 重载声明后才是 39
（`batch_as_completed`、`astream_events`、`stream_events` 等各有 3 个重载签名）。
**不排除 `@overload` 会把同一个方法数三次。**

**`BaseChatModel`**（`language_models/chat_models.py`）：

| 项 | 值 |
|---|---|
| 抽象方法 | **2 个：`_generate`、`_llm_type`** |
| 公共方法数 | 20 |

第三方接一个 chat model 的最小契约是这 2 个下划线命名的抽象方法。

⚠ **这不是命名失误，官方文档为此专门写了一条例外。** `langchain-ai/docs` 仓的
`src/oss/versioning.mdx`（2026-08-09 抓取）在「Internal APIs」一节里写：

> **Exception:** Certain methods are prefixed with `_`, but do not contain an
> implementation. These methods are *meant* to be overridden by sub-classes that
> provide the implementation. Such methods are generally part of the
> **Public API** of LangChain.

所以「下划线 = 内部、可随时改」这个 Python 通用惯例在这个框架里**有条件失效**：
判据不是名字，而是「有没有实现体」。对第三方实现者来说这条例外必须知道，
否则会以为 `_generate` 是内部 API 而不敢覆写。

### 5.5 消息与内容块：多模态契约

`messages` 子包是最大的一个（`__all__` **57 项**）。内容块定义在 `messages/content.py`
（**1,488 行**，16 个顶层类）：

| 内容块类 | 用途 |
|---|---|
`TextContentBlock` | 文本
`ReasoningContentBlock` | 推理 / thinking
`ImageContentBlock` / `VideoContentBlock` / `AudioContentBlock` | 多模态
`FileContentBlock` / `PlainTextContentBlock` | 文件
`ToolCall` / `ToolCallChunk` / `InvalidToolCall` | 工具调用
`ServerToolCall` / `ServerToolCallChunk` / `ServerToolResult` | **服务端工具**（provider 侧执行）
`Citation` / `NonStandardAnnotation` | 引用与注解
`NonStandardContentBlock` | **逃逸舱**：装不进上述类型的内容

实查 `type: Literal["..."]` 共 **18 个判别值**：`audio`、`citation`、`file`、`image`、
`invalid_tool_call`、`non_standard`、`non_standard_annotation`、`reasoning`、
`server_tool_call`、`server_tool_call_chunk`、`server_tool_result`、`text`、
`text-plain`、`text/plain`、`tool_call`、`tool_call_chunk`、`video`。

⚠ **`text-plain` 与 `text/plain` 两个值同时存在**（连字符版与斜杠版）。
本文未能核验这是刻意的双写兼容还是历史遗留。

**provider 差异吸收在 `messages/block_translators/`，实查 9 个文件**：
`anthropic.py`、`bedrock.py`、`bedrock_converse.py`、`google_genai.py`、
`google_vertexai.py`、`groq.py`、`openai.py`、`langchain_v0.py`、`__init__.py`。

⚠ **其中一个叫 `langchain_v0.py`**——**LangChain 把自己的旧格式当成一个需要翻译的
"provider" 来处理**。这是 §9 那套弃用机制的另一种形态：不是删掉旧格式，
而是给它写一个翻译器。

---

## 6. `langchain` 与 `langchain-classic`：一次减法，不是一次升级

这一章解释文首 `::: danger` 第 2 条。**新的 `langchain` 包不是旧包的演进版，
是把绝大部分东西留在原地、另起了一个小包。**

### 6.1 两个包的规模对比（本地检出实查）

| | `langchain` 1.3.14（`libs/langchain_v1/`） | `langchain-classic` 1.0.8（`libs/langchain/`） |
|---|---|---|
| import 路径 | `langchain` | `langchain_classic` |
| py 文件数 | **35** | **1,321**（37.7×） |
| 代码行数 | **15,208** | **70,585**（4.6×） |
| 顶层子模块 | **7 个** | 30+ 个 |
| `chains/` 目录 | **不存在** | **140 个 py 文件** |
| PyPI 版本数 | **508**（首发 2022-10-25） | **10**（首发 2025-10-07） |
| 官方定位 | "Actively maintained"（`AGENTS.md`） | "legacy, **no new features**"（`AGENTS.md`） |
| README 自述 | — | "Legacy chains, `langchain-community` re-exports, indexing API, deprecated functionality" |

⚠ **PyPI 版本数那一行透露了包名的历史**：`langchain` 有 508 个版本、首发
2022-10-25，说明它**继承了原来那个包的 PyPI 名字与全部历史**；
而 `langchain-classic` 只有 10 个版本、首发 2025-10-07，是**新建的包名**。
**旧代码留在原地但换了个新包名发布，新代码占用了旧包名。**

### 6.2 新 `langchain` 包的全部 7 个子模块（AST 实查导出）

| 子模块 | `__all__` | 导出内容 |
|---|---|---|
| `agents` | 2 | `create_agent`、`AgentState` |
| `agents.middleware` | **43** | 见 §7 |
| `messages` | 31 | 从 `langchain_core.messages` 精选再导出 |
| `tools` | 8 | `BaseTool`、`tool`、`ToolRuntime`、`InjectedState`、`InjectedStore` 等 |
| `chat_models` | 2 | `BaseChatModel`、`init_chat_model` |
| `embeddings` | 2 | `Embeddings`、`init_embeddings` |
| `rate_limiters` | 2 | `BaseRateLimiter`、`InMemoryRateLimiter` |
| **顶层 `__init__.py`** | **0** | 只有一句 docstring + `__version__ = "1.3.14"` |

**加总 90 项导出**（含 middleware 的 43）。对比 `langchain_classic` 顶层 `__all__` 的
**46 项**——注意这两个数不可比：classic 的 46 是**顶层一个文件**的导出，
而它内部还有 30 多个子模块各自的导出。

**顶层 `__init__.py` 只写了一个 `__version__`** 这一点值得单独说：
它意味着 `from langchain import X` 这种写法在新包里基本不成立，
一切都要走 `from langchain.agents import create_agent` 这样的子模块路径。
（core 也是同样风格，见 §5.1。）

### 6.3 `langchain_classic` 保留了一套 import 拦截

`langchain_classic/__init__.py` 里有一个 `__getattr__` 钩子 + `_warn_on_import()` 函数，
对旧的根级 import 逐个发 warning：

```python
def __getattr__(name: str) -> Any:
    if name == "MRKLChain":
        from langchain_classic.agents import MRKLChain
        _warn_on_import(name, replacement="langchain_classic.agents.MRKLChain")
```

⚠ **一个容易被忽略的细节**：`_warn_on_import()` 开头有一条豁免——

```python
if is_interactive_env():
    # No warnings for interactive environments.
    return
```

**在 Jupyter / IPython 里这些弃用警告全部静默。** 注释给的理由是避免污染
自动补全的输出。代价是：**交互式环境里的用户看不到自己在用弃用 API**，
而交互式环境恰恰是这个框架最常见的使用场景之一。

---

## 7. 主执行模型：middleware 是 v1 的核心扩展点

新 `langchain` 包只有一个 `create_agent` 入口（`agents/factory.py`，**2,062 行**），
它的可定制性全部集中在 **middleware** 这一个机制上。

### 7.1 `create_agent` 的 15 个参数（AST 实查）

`model`、`tools`、`system_prompt`、`middleware`、`response_format`、`state_schema`、
`context_schema`、`checkpointer`、`store`、`interrupt_before`、`interrupt_after`、
`debug`、`name`、`cache`、`transformers`

（该函数有 3 个 `@overload` 声明 + 1 个实现，共 4 处同名定义；15 是参数数，不是重载数。）

⚠ 其中 `checkpointer`、`store`、`interrupt_before`、`interrupt_after`、`cache`
**都是 LangGraph 的概念**——这是 §3.1 那个 `langgraph>=1.2.5,<1.3.0` 硬约束的由来：
`create_agent` 编译出的就是一张 LangGraph 图。

### 7.2 `AgentMiddleware` 契约：7 个同步钩子 × 各带一个 async 孪生

`AgentMiddleware`（`agents/middleware/types.py`）AST 实查共 **13 个方法**：

| 同步钩子 | async 版 | 时机 |
|---|---|---|
| `before_agent` | `abefore_agent` | 整轮开始前 |
| `before_model` | `abefore_model` | 每次调模型前 |
| `wrap_model_call` | `awrap_model_call` | **包裹**模型调用（可重试 / 短路 / 改请求响应） |
| `after_model` | `aafter_model` | 每次调模型后 |
| `wrap_tool_call` | `awrap_tool_call` | **包裹**工具调用 |
| `after_agent` | `aafter_agent` | 整轮结束后 |
| `name`（property） | — | 中间件名，默认取类名 |

**`wrap_*` 与 `before/after_*` 的区别在契约上写得很明确**：`wrap_model_call`
拿到的是 `(request, handler)`，docstring 说明它「can call the handler multiple times
for retry logic, skip calling it to short-circuit, or modify the request/response」，
且「Multiple middleware compose with first in list as outermost layer」——
是洋葱式组合，不是事件回调。

⚠ **一个实现约束**：`wrap_model_call` 的 sync 版若未实现而以 async 方式调用，
会抛 `NotImplementedError`，错误信息列出三条出路（子类实现 sync 版 / 用装饰器 /
改用 `astream()`）。**sync 与 async 不自动互相兜底**，实现者要显式选一边或都写。

### 7.3 官方内置中间件：16 个（AST 口径）

「继承 `AgentMiddleware` 的具体类」这个口径实查得 **16 个**：

| 中间件 | 文件 | 作用域 |
|---|---|---|
| `SummarizationMiddleware` | `summarization.py` | 上下文压缩 |
| `ContextEditingMiddleware` | `context_editing.py` | 上下文编辑（含 `ClearToolUsesEdit`） |
| `HumanInTheLoopMiddleware` | `human_in_the_loop.py` | HITL 中断 |
| `PIIMiddleware` | `pii.py` | PII 检测/脱敏 |
| `ModelCallLimitMiddleware` | `model_call_limit.py` | 模型调用次数上限 |
| `ToolCallLimitMiddleware` | `tool_call_limit.py` | 工具调用次数上限 |
| `ModelFallbackMiddleware` | `model_fallback.py` | 模型降级 |
| `ModelRetryMiddleware` | `model_retry.py` | 模型重试 |
| `ToolRetryMiddleware` | `tool_retry.py` | 工具重试 |
| `ToolErrorMiddleware` | `tool_error.py` | 工具错误处理 |
| `TodoListMiddleware` | `todo.py` | 待办清单 |
| `ShellToolMiddleware` | `shell_tool.py` | shell 工具（含 3 种执行策略，见下） |
| `FilesystemFileSearchMiddleware` | `file_search.py` | 文件搜索 |
| `LLMToolSelectorMiddleware` | `tool_selection.py` | 用 LLM 选工具 |
| `LLMToolEmulator` | `tool_emulator.py` | 用 LLM 模拟工具 |
| `ProviderToolSearchMiddleware` | `provider_tool_search.py` | provider 侧工具搜索 |

⚠ **`__all__` 是 43 项而具体中间件只有 16 个**——差额是类型、配置对象与装饰器：
`AgentMiddleware`（基类）、`AgentState`/`InputAgentState`/`OutputAgentState`、
`ModelRequest`/`ModelResponse`/`ExtendedModelResponse`/`ModelCallResult`、
`ToolCallRequest`、`Runtime`、`InterruptOnConfig`、`TriggerClause`、`RedactionRule`、
`PIIMatch`/`PIIDetectionError`、`ClearToolUsesEdit`，以及 **8 个装饰器式钩子**
（`before_agent`、`before_model`、`after_model`、`after_agent`、`wrap_model_call`、
`wrap_tool_call`、`dynamic_prompt`、`hook_config`）。
**「43 个 middleware」是错的说法**，正确表述是「middleware 模块导出 43 个符号，
其中 16 个是可直接用的中间件」。

**三种 shell 执行策略**（从 `__all__` 实查）：`HostExecutionPolicy`、
`DockerExecutionPolicy`、`CodexSandboxExecutionPolicy`。
⚠ 最后一个的名字里带 `Codex`——指的是 OpenAI Codex 的沙箱。
本文未核验它具体依赖 Codex 的哪个组件。

### 7.4 partner 也能发中间件

`langchain-anthropic` 1.5.4 自带 `middleware/` 子模块，实查 `__all__` **7 项**：

`AnthropicPromptCachingMiddleware`、`ClaudeBashToolMiddleware`、
`FilesystemClaudeMemoryMiddleware`、`FilesystemClaudeTextEditorMiddleware`、
`StateClaudeMemoryMiddleware`、`StateClaudeTextEditorMiddleware`、
`StateFileSearchMiddleware`

**这说明 middleware 是设计给外部实现的扩展点**，不只是内置功能的组织方式——
它是 15 个 partner 里唯一带 middleware 的一个（实查 `ls libs/partners/*/*/middleware`
只命中 anthropic），所以也可以说这个扩展点目前只有一家 partner 在用。

---

## 8. 一致性测试套件：契约的可执行形态

`libs/standard-tests/` 发布为 `langchain-tests` 1.1.9，是框架**用来约束第三方实现**的包。
产品研究里没有这一类证据。

### 8.1 结构与规模（AST 实查）

| 项 | 值 |
|---|---|
| py 文件数（含自身 tests） | **36** |
| `langchain_tests/` 代码行数 | **9,820** |
| 分档 | `unit_tests/`（不联网）与 `integration_tests/`（联网） |
| `test_*` 方法总数 | **238** |

**逐套件的测试方法数**（这是「契约有多严」的直接度量）：

| 套件 | 档位 | `test_*` 数 |
|---|---|---|
| `SandboxIntegrationTests` | integration | **86** |
| `ChatModelIntegrationTests` | integration | **41** |
| `VectorStoreIntegrationTests` | integration | 24 |
| `BaseStoreSyncTests` / `BaseStoreAsyncTests` | integration | 11 / 11 |
| `DocumentIndexerTestSuite` / `AsyncDocumentIndexTestSuite` | integration | 11 / 11 |
| `ChatModelUnitTests` | unit | 9 |
| `SyncCacheTestSuite` / `AsyncCacheTestSuite` | integration | 7 / 7 |
| `ToolsUnitTests` | unit | 5 |
| `EmbeddingsIntegrationTests` | integration | 4 |
| `RetrieversIntegrationTests` | integration | 4 |
| `ToolsIntegrationTests` | integration | 4 |
| `EmbeddingsUnitTests` | unit | 2 |
| `BaseStandardTests`（基类） | — | 1 |

**分档合计**：unit **16**、integration **221**、基类 1。

### 8.2 最大的一套测的不是本仓的东西

**`SandboxIntegrationTests` 以 86 个测试成为最大套件，占全部 238 个的 36%**，
而它验的契约**不在这个仓库里**。文件头 docstring 原文：

> Integration tests for the deepagents sandbox backend abstraction.
> Implementers should subclass this test suite and provide a fixture that returns a
> clean `SandboxBackendProtocol` instance.

示例代码里 `from deepagents.backends.protocol import SandboxBackendProtocol`。

**三层错位值得记下来**：契约（`SandboxBackendProtocol`）定义在 `deepagents` 仓 →
一致性测试发布在 `langchain` 仓的 `langchain-tests` 包 →
而 `langchain-tests` 的依赖里只有 `langchain-core>=1.4.7`，
**没有声明 `deepagents`**。所以这 86 个测试在没装 deepagents 的环境里跑不起来
（文件里用了 `# ruff: noqa: E402` 与延迟 import 来绕过静态检查）。

⚠ 顺带修正一个通用印象：**「框架没有沙箱」这个判断在 LangChain 上不成立**。
它有沙箱抽象、有三种执行策略（§7.3）、有 86 个一致性测试——
只是这些东西分散在三个包/仓里。

### 8.3 `langchain-tests` 的发布节奏比核心慢

PyPI 实查：`langchain-tests` 最新 **1.1.9（2026-05-21）**，共 39 个版本。
**距本快照已 2 个半月没发新版**，而同期 `langchain-core` 发了 1.5.0 / 1.5.1 / 1.5.2 / 1.5.3
四个版本。含义是：**第三方拿 PyPI 上的 `langchain-tests` 跑一致性测试，
测的是 2026-05 的契约，不是当前 core 的契约。**（本地检出里是同一个 1.1.9。）

---

## 9. 弃用与迁移：升级会不会崩

**这是框架读者的头号问题，也是产品研究里完全没有对应物的一章。**

### 9.1 `@deprecated` 用量：三个数字对应三个句子

| 口径 | 数字 | 对应的句子 |
|---|---|---|
| `grep -rl "@deprecated"`（**文件数**） | **80** | 「80 个文件里有弃用标记」 |
| `grep -rho "@deprecated"`（**出现次数**） | **137** | 「全仓共 137 处弃用标记」 |
| 出现次数，**排除 `/tests/`** | **114** | 「生产代码里 114 处」 |

⚠ **这三个数都对，但不能互相冒充。** `-l` 是文件数，不是使用点数——
把 80 写成「使用点 80 处」是低估 41%。本文后续统一用 **114**（生产代码口径）。

**按包分布（114 处，排除 tests）**：

| 包 | 处数 | 占比 |
|---|---|---|
| `langchain-classic` | **94** | 82% |
| `langchain-core` | **15** | 13% |
| partner 三处合计 | 3 | 3% |
| `langchain-text-splitters` | 1 | <1% |
| `langchain-tests` | 1 | <1% |

**82% 的弃用集中在 legacy 包里**——这与 §6 的结论一致：
新 `langchain` 包（35 个文件）里**一处 `@deprecated` 都没有**。

### 9.2 移除目标版本：113/118 瞄准 2.0.0

`removal=` 参数实查（排除 tests，共 **118** 处带 removal）：

| `removal=` | 处数 |
|---|---|
| `"2.0.0"` | **113** |
| `"2.0"` | 2 |
| `"0.0.305"` | 2 |
| `"0.5.0"` | 1 |

**含义很直接：绝大多数弃用 API 的生命周期绑定在同一个事件上——2.0 发布。**
这与官方 `release-policy.mdx` 的口径一致（2026-08-09 抓取原文）：

> With LangChain 1.0's semantic versioning approach, deprecated features will
> continue to work throughout the entire 1.x release series. Breaking changes,
> including the removal of deprecated features, will only occur in major version
> releases (e.g., 2.0).

⚠ **两个异常值需要指出**：`removal="0.0.305"` 与 `removal="0.5.0"` 这三处的
目标版本**早已被跨过**（当前 1.x），但代码还在。官方文档给了对应的兜底说法：

> In some situations, we may allow deprecated features to remain in the code base
> even longer if they are not causing maintenance issues.

所以 `removal=` **是意图声明，不是承诺**——读者不能拿它当排期表用。
另外 `"2.0.0"` 与 `"2.0"` 两种写法并存（113 vs 2），说明这个字段没有格式校验。

### 9.3 弃用起始版本：跨越 0.1 到 1.3

`since=` 实查（排除 tests，共 **90** 处带 since，top 值）：

| `since=` | 处数 | 时期 |
|---|---|---|
| `"0.2.13"` | **25** | 0.2 时代 |
| `"0.3.1"` | **18** | 0.3 时代 |
| `"1.3.3"` | 6 | **当前 1.x** |
| `"1.2.21"` | 6 | 1.x |
| `"0.1.17"` / `"0.1.14"` | 4 / 4 | 最早期 |
| `"0.2.7"` / `"0.2.12"` | 3 / 3 | |
| `"1.1.2"` / `"1.0.6"` / `"1.0.5"` / `"1.0.4"` | 各 2 | 1.x |

⚠ **`since` 有 90 处而 `@deprecated` 有 114 处，`removal` 有 118 处**——
三个数字互不相等，说明**这三个参数不是一一对应的**：
有的弃用没标起始版本，而 `removal` 比 `@deprecated` 多 4 处
（`warn_deprecated()` 等函数调用也带 `removal` 参数，不只装饰器用）。
**引用这些数字时必须说明数的是哪一个，不能合并成「114 个弃用」了事。**

⚠ 另一个口径陷阱：不排除 tests 时 `since="2.0.0"` 会冒出 **24 处**，
排除后是 **0**——那 24 处全是测试里的 fixture 参数。
**弃用统计必须排除测试目录**，否则会得出「已经在为 2.0 标弃用了」这种错误结论。

### 9.4 弃用机制的实现（`_api/deprecation.py`，637 行）

公共 API 实查 6 项：

| 符号 | 作用 |
|---|---|
| `deprecated` | 装饰器 |
| `warn_deprecated` | 运行时发警告（非装饰器路径） |
| `LangChainDeprecationWarning` | 继承 `DeprecationWarning` |
| `LangChainPendingDeprecationWarning` | 继承 `PendingDeprecationWarning` |
| `suppress_langchain_deprecation_warning` | 上下文管理器，静默 |
| `surface_langchain_deprecation_warnings` | **在 import 时把警告改成默认可见** |
| `rename_parameter` | 参数改名的兼容装饰器 |

**`surface_langchain_deprecation_warnings()` 在 `langchain_core/__init__.py` 里被调用**
（那个 20 行文件的两行实质内容之一，另一行是 beta 版）。
它存在的原因是 Python 默认**隐藏** `DeprecationWarning`——
框架主动把自己的弃用警告改回可见。

⚠ **对照 §6.3 的豁免看**：core 主动让警告可见，而 `langchain_classic` 的
`_warn_on_import` 在 Jupyter 里主动静默。**两个相反方向的决定并存于同一个生态。**

另有 `_api/beta_decorator.py` 里的 `LangChainBetaWarning`（同样继承 `DeprecationWarning`），
对应官方 versioning 文档里的 beta / alpha 分级。

### 9.5 官方支持窗口（`release-policy.mdx` 原文口径，2026-08-09 抓取）

| 版本 | 状态 | 支持期 |
|---|---|---|
| **LangChain 1.0**（LTS） | ACTIVE | 到 2.0 发布为止；2.0 发布后进入 MAINTENANCE **至少 1 年** |
| **LangChain 0.3** | MAINTENANCE | **到 2026 年 12 月**（仅安全补丁与关键 bug 修复） |
| 更早版本 | 社区支持 | — |

**0.3 的 EOL 是 2026-12，距本快照约 4 个月。** PyPI 实查佐证：
`langchain` 0.3.x 共 **35 个版本**，最后一个是 **0.3.30（2026-05-07）**；
`langchain-core` 0.3.x 最后一个是 **0.3.86（同日 2026-05-07）**。
**两个包在同一天停止了 0.3 线的发布**，此后三个月没有新的 0.3 补丁——
虽然官方口径说支持到 2026-12，但实际发布活动已停。
⚠ 本文无法核验这是「没有需要修的东西」还是「实质已停止维护」。

---

## 10. 模型能力元数据：编译进包体的 552 个 profile

`ChatModel` 有一个 `.profile` 属性（`language_models/chat_models.py:415`），
用于程序化读取「这个模型支持不支持结构化输出、多大上下文窗口、能不能读 PDF」。
这份数据不是运行时查询得来的，是**构建时写死进包体**的。

### 10.1 数据管线：三个环节

| 环节 | 载体 | 说明 |
|---|---|---|
| **上游数据源** | [models.dev](https://github.com/sst/models.dev)（第三方开源项目） | `libs/model-profiles/README.md` 原文："built on top of... models.dev" |
| **CLI 工具** | `langchain-model-profiles` 0.0.6（`libs/model-profiles/`） | `_summary.py`（493 行）+ `cli.py`（452 行），共 945 行 |
| **落地文件** | 各 partner 包内的 `data/_profiles.py` + `data/profile_augmentations.toml` | 编译进发行物，不是运行时下载 |

⚠ **`langchain-model-profiles` 包本身声明 "in development, API subject to change"**
（README 的 `[!WARNING]` 块），版本号 **0.0.6**，PyPI 只有 6 个版本、
最后一次更新是 **2026-06-11**——是 21 个包里最不成熟的一个。

**它不修改上游数据，只做增量覆盖**：`profile_augmentations.toml` 用
`[overrides]` / `[overrides."<model-id>"]` 两级结构，在 models.dev 的原始数据之上
打补丁。实查 `langchain-anthropic` 的该文件，`claude-sonnet-4-6` 一条覆盖了
`reasoning_effort_levels = ["low", "medium", "high", "max"]`——**这正是本文
frontmatter 声明的调研环境所用的那个模型**。

### 10.2 覆盖率：10/15 个 partner 有数据，openrouter 一家占 61%

AST 精确计数各 partner 的 `_profiles.py`（顶层 dict 键数 = 模型数）：

| Partner | 模型数 |
|---|---|
| **openrouter** | **339** |
| huggingface | 60 |
| openai | 54 |
| mistralai | 33 |
| fireworks | 19 |
| groq | 15 |
| anthropic | 14 |
| xai | 10 |
| deepseek | 4 |
| perplexity | 4 |
| **合计** | **552** |

**15 个 partner 里只有这 10 个有 `_profiles.py`**——`chroma`（向量库，无模型概念）、
`exa`（搜索）、`nomic`、`ollama`、`qdrant` 没有，符合预期（它们不是 chat model 适配器）。

`openrouter` 一家（339）占总数的 **61%**——因为 OpenRouter 本身是个聚合网关，
它的「一个 provider」背后是几十家上游模型。**这个数字统计的是「LangChain 能读到
capability 元数据的模型」，不是「LangChain 能调用的模型」**——只要 API 兼容
OpenAI 协议，不需要 profile 数据也能调用，只是拿不到 `.profile` 里的能力位。

### 10.3 自动刷新机制横向复用到仓外

`.github/workflows/_refresh_model_profiles.yml` 是一个**可复用工作流**，
注释里给出了 `langchain-google` 仓调用它的示例——这说明 profile 刷新机制
被设计成横向复用给仓外的 provider 仓库，不止服务本仓的 partner。

---

## 11. 集成生态：`packages.yml` 里的 176 个包

`langchain-ai/docs` 仓的 `packages.yml`（1,030 行）自称
"Source of truth for all LangChain packages and repos"，是集成生态唯一的
结构化事实源。实查（2026-08-09 抓取该文件，`downloads_updated_at` 统一为
**`2026-08-04T16:48:50`**，说明是官方脚本周期性批量刷新，非实时）：

### 11.1 总体规模

| 项 | 值 |
|---|---|
| 总 package 条目 | **176** |
| 涉及独立 repo | **149 个** |
| 本仓（`langchain-ai/langchain`）贡献的条目 | **22** |
| 声明 `js` 对应包 | 42 个 |
| 显式标 `js: "n/a"`（无 JS 对应） | 32 个 |
| 未填 `js` 字段（未声明，不代表没有） | 102 个 |
| `integration: false`（不进集成列表，是基础设施包） | 9 |
| `highlight: true`（官方重点推荐） | 31 |

### 11.2 下载量 top 14（pepy 月度，`packages_yml_get_downloads.py` 自动填）

| 包 | 月下载量 |
|---|---|
| `langchain` | **295,000,000** |
| `langchain-core` | 165,000,000 |
| `langchain-openai` | 62,000,000 |
| `langchain-text-splitters` | 47,000,000 |
| `langchain-community` | 44,000,000（**独立仓**，见 §11.4） |
| `langchain-google-vertexai` | 34,000,000 |
| `langchain-anthropic` | 22,000,000 |
| `langchain-classic` | 21,000,000 |
| `langchain-google-genai` | 17,000,000 |
| `langchain-aws` | 13,000,000 |
| `langchain-google-community` | 11,000,000 |
| `langchain-mcp-adapters` | 8,000,000 |
| `langchain-litellm` | 4,000,000 |
| `langchain-ollama` | 3,000,000 |

⚠ **`langchain-classic`（21M）的下载量已经反超了半数本仓 partner 包**，
虽然官方定位是「legacy, no new features」（§6）——大量存量代码显然还在用它。

**一个直接对比**：`langchain`（295M）与 `langchain-core`（165M）的下载比是 1.8:1，
说明大多数用户是通过高层包间接拉取 core，符合分层设计的预期。

### 11.3 本仓 22 个条目 vs 实际 21 个包

`packages.yml` 里 `repo: langchain-ai/langchain` 的条目有 **22 个**，比本地检出的
21 个 `pyproject.toml` **多 1 个**——多出的正是文首 `::: danger` 块提到的
**`langchain-prompty`**（标注 `path: libs/partners/prompty`，已在 2026-02-06 删除）。

**这是本仓自己的事实源里唯一一处未清理的漂移记录**，其余 21 条与本地检出完全对应。

### 11.4 独立仓库承接了大流量 partner

按 `repo` 字段分布，除本仓（22 条）外，规模最大的几个独立仓：

| 仓库 | 条目数 |
|---|---|
| `langchain-ai/langchain-azure` | 3 |
| `langchain-ai/langchain-google` | 3 |
| `langchain-ai/langchain-ibm` | 2 |
| `oracle/langchain-oracle` | 2 |
| `langchain-ai/langchain-community` | 1（但下载量 4400 万，见上表） |

**独立 repo 总数 149**，绝大多数只贡献 1 个包——说明生态的长尾由大量
第三方维护者各自的独立小仓组成，`langchain-ai` 官方仓库只挑了几个大流量
provider（Azure、Google、IBM）单独开仓维护，其余全靠社区。

---

## 12. 与商业产品的边界：LangSmith 不是可选项

### 12.1 `langchain-core` 硬依赖 LangSmith SDK

`libs/core/pyproject.toml` 的 9 个运行时依赖，第一个就是：

```
langsmith>=0.3.45,<1.0.0
```

不是 extra，是核心依赖。实查 `langchain_core` 内 **73 处**提及 `langsmith`，
其中 **9 处**是顶层无条件 `from langsmith import ...` / `import langsmith`，
分布在 5 个文件：`document_loaders/langsmith.py`、`tracers/evaluation.py`、
`tracers/context.py`、`tracers/langchain.py`、`tracers/schemas.py`。

**`langsmith` 包本身**（PyPI 实查）：最新 **0.10.17**（2026-08-07），共 **519 个版本**，
MIT 协议，summary 是 "Client library to connect to the LangSmith Observability
and Evaluation Platform"——**它是开源 SDK，连接的是闭源商业平台**。

### 12.2 边界怎么划：SDK 开源，平台闭源

| 层 | 开源状态 |
|---|---|
| `langchain` / `langchain-core` / 21 个包 | 开源（MIT） |
| `langsmith`（Python SDK） | 开源（MIT），PyPI 可装 |
| **LangSmith 平台**（可观测性/评测后端） | **闭源**，SaaS |
| **LangSmith Deployment**（Agent 托管部署） | 闭源，SaaS |

README 明确把 LangSmith 列为生态一部分（"For developing, debugging, and deploying
AI agents... see LangSmith"），且 core 把它的 tracer SDK 编进了硬依赖——
**这意味着装 `pip install langchain` 就会连带装 `langsmith` 这个 SDK**，
即使你完全不用 LangSmith 平台。这是一种「基础设施预置」而非强制使用：
不配置 API key 就不会有任何数据发送出去，但依赖本身无法用 extra 摘除。

⚠ 本文未能核验「不配置 LangSmith 时 tracer 相关代码路径是否有可观测的性能/体积
开销」，这需要运行时实测，超出本文的证据形态。

---

## 13. 文档形态与搬迁史

### 13.1 文档不在本仓,搬到了独立仓

根目录 `contents` API 实查确认**没有 `docs/` 目录**。文档在
**`langchain-ai/docs`**（GitHub API 实查）：

| 项 | 值 |
|---|---|
| 创建日期 | **2025-05-15** |
| 语言 | MDX |
| Stars | 392 |
| Forks | **2,579**（fork 数远超 star 数，说明大量贡献者克隆用于提 PR） |
| Open issues | 388 |
| 仓库体积 | 896,397 KB |

**这个仓库同时服务 LangChain、LangGraph、Deep Agents 三个产品的文档**
（`src/oss/` 下平级有 `langchain/`、`langgraph/`、`deepagents/` 三个目录），
不是每个项目各自一个文档仓。

### 13.2 `packages.yml` 本身就住在文档仓,不在代码仓

值得注意的是 §11 那份「包清单事实源」`packages.yml`**不在** `langchain-ai/langchain`,
而在 `langchain-ai/docs` 仓根目录。**代码仓不知道自己有多少个下游包,
这份知识只存在于文档仓。**

### 13.3 姊妹仓 LangGraph 的文档目录是个彻底的空壳

对比检查 `langchain-ai/langgraph`(本地检出 `d56666f7`)的 `docs/` 目录:

```
docs/
├── redirects.json       ← 294 条重定向规则
├── generate_redirects.py
├── llms.txt             ← 35 行,开头即写"has moved to docs.langchain.com"
└── .gitignore
```

**`.md` / `.mdx` 文件实查为 0 个。** `llms.txt` 第一段原文:

> LangGraph documentation has moved to docs.langchain.com.

**这比 LangChain 本仓的情况更彻底**——LangChain 是「根目录没有 `docs/`」,
LangGraph 是「`docs/` 目录还在,但只剩迁移路标」。294 条重定向本身是可读的
硬事实,能反推出搬迁前的文档规模大致是几百个页面级别。

⚠ **这是本系列方法论文档里强调过的一个模式的两个变体**:框架仓库里,
任何看起来眼熟的目录名都可能只是搬迁后的空壳,必须实查内容而非只看目录是否存在。

---

## 14. 发版节奏:逐包独立、周期不同

### 14.1 核心包的发布频率(PyPI 时间线实查)

| 包 | 总版本数 | 首发 | 近 4 个月发布数 |
|---|---|---|---|
| `langchain-core` | **297** | 2023-11-20 | 04月15 / 05月6 / 06月8 / 07月5 |
| `langchain` | **508** | 2022-10-25 | 04月3 / 05月8 / 06月9 / 07月3 |
| `langchain-classic` | 10 | 2025-10-07 | 03月2 / 04月1 / 05月3 / 06月1 |
| `langchain-openai` | **135** | 2024-01-05 | 05月1 / 06月4 / 07月4 / 08月1(截至08-07) |
| `langchain-protocol` | 11 | **2026-04-16** | 04月7 / 05月2 / 06月2 |
| `langchain-tests` | 39 | 2024-11-05 | 距今最后一次 2026-05-21 |
| `langchain-model-profiles` | 6 | 2025-10-31 | 距今最后一次 2026-06-11 |

**`langchain-core` 2026-04 单月发了 15 个版本**——平均 2 天一个。
`langchain-protocol` 首发仅 4 个月(2026-04-16),前 7 个版本全部挤在
首发当月——一个新拆出来的包早期迭代密度可以很高。

### 14.2 版本号里程碑:0.3 → 1.0 用了 5 个月

PyPI 时间线精确定位大版本切换点:

| 包 | 0.3 系列最后版本 | 1.0.0 首发 |
|---|---|---|
| `langchain` | 0.3.30(2026-05-07) | **2025-10-17** |
| `langchain-core` | 0.3.86(2026-05-07) | **2025-10-17** |

⚠ **两个包在同一天(2026-05-07)发出各自 0.3 系列的最后一个版本**——
这与 §9.5 的官方支持窗口("0.3 MAINTENANCE 到 2026-12")对得上:
0.3 线在 1.0 发布后又活了约 7 个月才停止发布补丁,现在处于"仍在支持期,
但已数月无新版"的状态。

**1.x 内部里程碑(`langchain-core`)**:1.0.0(2025-10-17)→ 1.1.0(2025-11-21)→
1.2.0(2025-12-12)→ 1.3.0(2026-04-17,间隔 4 个月,是 1.x 里最长的一次)→
1.4.0(2026-05-11)→ 1.5.0(2026-07-21)。

### 14.3 发布流程:每个 partner 独立走 CI 工作流

`AGENTS.md` 的 Release process 一节给出具体操作:版本号改 3 处
(`_version.py`、`pyproject.toml`、`uv.lock`)→ PR 合并 → 手动
`gh workflow run` 触发 `_release.yml`(workflow ID `63880841`)→
该工作流自动完成 build → TestPyPI → PyPI → GitHub Release 全链路,
**不允许人工创建 tag 或 release**。

**patch vs minor 的判断依据是仓内先例**,原文举例:新增 `session_id` 字段算
patch(0.2.1→0.2.2),新增 `parallel_tool_calls` 算 minor 级别的 additive feature
——**没有强制的自动化规则,靠维护者对照历史 PR 判断**。

---

## 15. 本文没有验证的部分

按证据形态逐条列出,不含糊过去:

1. **性能与运行时行为**。本文没有跑过任何 benchmark、没有实测过
   `create_agent` 编译出的图的执行开销、没有验证 LangSmith 依赖(§12)
   是否有可观测的启动或运行时代价。所有此类数字如果需要,应参照
   `codspeed.yml`(§4.3)的官方跑分,本文未抓取其结果。
2. **`.profile` 数据的准确性**。§10 只核实了「数据存在、结构如何、
   来自 models.dev」,没有逐条核对 552 个模型 profile 里任何一条
   (如 `context_window`、`structured_output` 位)是否与厂商官方文档一致。
3. **`CodexSandboxExecutionPolicy` 的具体实现**(§7.3)。只确认了这个
   类名存在于 `__all__`,没有深入其实现细节与它跟 OpenAI Codex 沙箱的
   实际耦合方式。
4. **`langchain-protocol` 与 `agent-protocol` 仓的关系**(§3.2)。
   确认了依赖声明与 import 路径,但未深入 `agent-protocol` 仓本身的
   设计文档或 RFC(如果存在)。
5. **`langsmith` 依赖是否会在未来版本变为可选**。这是根据现状(2026-08-09)
   的推测空间,官方文档未对此表态,本文也未发现相关 issue/讨论作为佐证。
6. **JS/TS 侧(`langchainjs`)的深度细节**。§1、§2 提到的版本号对照
   (如 `@langchain/core` 1.2.5 vs Python `langchain-core` 1.5.3)
   只是宏观数字核对,没有像 Python 侧那样做 AST 级的 API 面分析——
   那需要独立一篇用 TS 的等价工具链重做一遍 §5、§7、§9 的分析。
7. **`packages.yml` 里 176 个包的下载量数字本身**。这是官方脚本
   `packages_yml_get_downloads.py` 从 pepy.tech 拉取的,本文只是转述,
   没有独立复现这次抓取。
8. **`checkpoint-conformance` 套件的详细内容**。§8 聚焦的是本仓
   `standard-tests` 里的 sandbox 套件;LangGraph 仓另有一个独立的
   `checkpoint-conformance` 包(90 个测试函数,笔者在核实 langgraph 仓时
   顺带发现),专门验证 checkpoint 后端实现是否合规,本文未展开分析
   ——这本身够写一节,但已超出「LangChain 深入研究」这篇的范围边界,
   更适合放进未来可能的 LangGraph 篇。

---

## 参考资料

**一手源(本文实查的)**

- 源码:`langchain-ai/langchain`,本地检出 `master` 分支
  `d048fbe170573b6e7056b5ef5f78d8451e54abaf`(2026-08-08)
- 姊妹仓交叉核对:`langchain-ai/langgraph` 本地检出 `d56666f7`(2026-08-08),
  用于核实 §13.3 的文档搬迁与 §3.1 的依赖约束
- GitHub REST API:仓库元数据、语言占比、`contents` 端点(2026-08-09)
- PyPI JSON API:`langchain`、`langchain-core`、`langchain-classic`、
  `langchain-protocol`、`langchain-tests`、`langchain-model-profiles`、
  `langchain-openai`、`langgraph`、`langsmith`、`deepagents` 等包的
  完整发布时间线
- npm registry:`langchain`、`@langchain/core`、`@langchain/anthropic`
  (JS 侧版本对照,§1、§2)
- 官方 `packages.yml`(`langchain-ai/docs` 仓,1,030 行,2026-08-09 抓取)
- 官方版本策略源文件:`src/oss/versioning.mdx`、`src/oss/release-policy.mdx`
  (`langchain-ai/docs` 仓,2026-08-09 抓取,非渲染页)
- 全部计数脚本使用 Python `ast` 模块解析,而非正则或目测

**仓库内文档(引用的关键文件)**

- `AGENTS.md` / `CLAUDE.md`(18,831 字节,内容相同)——monorepo 结构、
  发布流程、稳定接口原则的官方口径
- 各包 `README.md`(`langchain`、`langchain-classic`、`langchain-core`、
  `model-profiles` 等)
- `.github/workflows/`(27 个文件)——`_release.yml`、
  `_refresh_model_profiles.yml`、`check_versions.yml` 等

**本站相关**

- 同系列产品研究方法论:`docs/reference/产品深入研究-通用提示词.md`
  §4(框架专属调整)即为本文调研过程中同步校准的方法论
- 系列内其他篇:[Claude Code](/blog/ref-claude-code)、[Codex](/blog/ref-codex)、
  [opencode](/blog/ref-opencode)、[LiteLLM](/blog/ref-litellm)、
  [LangGraph](/blog/ref-langgraph)(同为框架、双向依赖见 §3)、
  [Langfuse](/blog/ref-langfuse)(LangSmith 的开源对标,见 §12 的边界划分)

---

::: info 最后一句
这份手册记录的是 2026-08-09 这一天 LangChain 的样子:
**一个仓库、21 个各自独立版本号的包,新代码占用旧包名、旧代码换了新包名,
核心包硬依赖一个商业可观测性 SDK,而它自己最关键的一条内部约束
(`langchain<1.3.0` 依赖的 `langgraph`)距离撞线只剩一个 minor 版本。**
两周后这句话的某些数字会变——所以请连日期一起引用。
:::
