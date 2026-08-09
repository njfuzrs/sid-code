---
title: LangGraph 深入研究（2026-08 快照）
description: 19 章逐节成册，按目录跳章查阅——把 LangGraph 这个「框架」核验到包名与版本号级别：一个仓库 8 个包 8 组版本号、langgraph 1.2.10 撞在 langchain 钉的 <1.3.0 上界、create_react_agent 已弃用搬去 langchain、docs/ 只剩 294 条重定向的空壳、checkpoint 契约不是 ABC 而是 16 个 NotImplementedError、msgpack 反序列化默认宽松、8 条已公开安全公告。这是一份手册，不是读完就走的文章。
date: "2026-08-09"
series: 热点开源项目研究
audience: engineer
highlight: 19 章逐节可查 · 核验至 langgraph 1.2.10 / 本地检出 d56666f7 · 截至 2026-08-09 快照
tags: [LangGraph, Agent 框架, 深入研究, Pregel, Checkpoint, 状态持久化, 参考]
outline: [2, 3]
---

# LangGraph 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-09
- **被调研版本**：**没有单一版本号**——这正是本文第一个要讲清的事（§1、§2）。
  锚点是 PyPI 上的 `langgraph` **1.2.10**（2026-07-28 发布）与本地检出
  `langchain-ai/langgraph` 的 `master` @ **`d56666f7`**（2026-08-08 提交）。
  同仓另有 7 个包各自独立的版本号，从 `langgraph-checkpoint` **4.2.0**
  到 `langgraph-checkpoint-conformance` **0.0.2**，全表见 §2。
- **证据形态**：两类混合，逐条标注——
  ① **本地源码实查**（AST / 脚本计数，可复现；本文所有「N 个」都注明了口径）；
  ② **发布物与元信息实测**（PyPI JSON API、npm registry、GitHub REST API、
  GitHub Security Advisories API，全部落盘后脚本摘要）。
  **没有任何性能数字**——我们没有跑基准，也不转述厂商基准。
- **一手性说明**：包版本与依赖约束取自本地检出的 `pyproject.toml` 实查；
  发布时间线、许可证取自 PyPI / npm registry JSON；
  Star 数与语言占比取自 GitHub REST API；
  安全公告取自 `/repos/langchain-ai/langgraph/security-advisories` 端点。
  **文档类事实无法取自本仓**——它的 `docs/` 已经没有文档了（§17）。
- **时效边界**：`langgraph` 2026 年至本快照发了 **37 个版本**，
  而闭源的 `langgraph-api` 同期发了 **225 个**（§18）。
  **这是 2026-08-09 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://docs.langchain.com/oss/python/langgraph/overview)为准。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 四条广为流传、但在本快照下已经不成立的说法
读 LangGraph 的第三方教程、博客乃至 AI 生成的代码时，这四条几乎必然会遇到：

1. **「用 `from langgraph.prebuilt import create_react_agent` 建 agent」**——
   **这个函数在 v1.0.0 起已标记弃用**，警告类别 `LangGraphDeprecatedSinceV10`，
   官方给的替换是 `from langchain.agents import create_agent`（**搬到了另一个仓库的另一个包**）。
   `langgraph.prebuilt` 的 8 个导出里有 2 个带 `@deprecated`，
   另有 7 个已弃用符号不在 `__all__` 里。见 §10.3。
2. **「文档在 `langgraph/docs/` 下」**——**2026-01-09 起不在了**
   （commit `b4630d845`「chore: delete docs (#6488)」，删了 **681 个文件、122,269 行**）。
   现在 `docs/` 下 `.md` / `.mdx` **共 0 个**，只剩 `redirects.json`（**294 条重定向**）、
   `llms.txt`（35 行，内容就是「文档搬到 docs.langchain.com 了」）和一个生成脚本。见 §17。
3. **「JS/TS 实现和 Python 在同一个 monorepo，`libs/sdk-js/` 就是」**——
   `libs/sdk-js/` 目录**只有一个 432 字节的 README**，正文是「This package has moved to
   `langchain-ai/langgraphjs`」。而且两边版本号完全不对齐：
   Python `langgraph` 是 **1.2.10**，npm `@langchain/langgraph` 是 **1.4.9**。见 §15。
4. **「递归上限默认 25」**——**2026-01-12 起是 10000，2026-03-30 起是 10007**
   （`DEFAULT_RECURSION_LIMIT`，`libs/langgraph/langgraph/_internal/_config.py:32`）。
   从 25 跳到 10000 是 commit `a5827c5c6`（#6676），
   再改成质数 10007 是 `2fb367e90`（#7355，标题写明是为了「避免与默认哨兵值冲突」）。
   **这是 400 倍的变化，抄旧教程里「记得调大 recursion_limit」那段已经没有必要。**

另有一条不算「过期说法」而是**框架自己的文档漂移**：`Pregel` 类的 docstring
（`libs/langgraph/langgraph/pregel/main.py:506`）仍在推荐 `Context` 通道
并给出 `client = Context(httpx.Client)` 的示例，而这个通道
**在 2025-05-24 就被删了**（commit `889b40e7a`，随 0.5.0 发布）。见 §7.3。
:::

---

## 1. 定位与身份辨析：这个名字下面有几个包

LangGraph 是 LangChain（LangChain, Inc.）开发的 agent 编排框架，
仓库 `langchain-ai/langgraph` 自述为 **"Low-level orchestration framework for building stateful agents."**
（`README.md` 第 12 行），GitHub 仓库简介则是更短的 **"Build resilient agents."**

**它最容易被误解的一点是：「LangGraph 是什么版本」这个问题没有答案。**
`pip install langgraph` 装到的是一个包，但你实际依赖的是一张表——
本仓有 8 个各自独立发版的 Python 包，加上 2 个**不在本仓、许可证也不同**的运行时包。

| | **框架本体**（本文主体） | **Server 运行时** |
| --- | --- | --- |
| 装什么 | `pip install langgraph` | `pip install "langgraph-cli[inmem]"` 间接拉入 |
| 包名 | `langgraph` 等 8 个（§2） | `langgraph-api`、`langgraph-runtime-inmem` |
| 许可证 | **MIT** | **Elastic-2.0** |
| 源码在本仓 | 是 | **否**——PyPI 上有 wheel/sdist，仓库不公开 |
| 怎么用 | 进程内 `import langgraph`，编译一张图 | 起 HTTP 服务，按 REST API 请求它 |
| 本文覆盖 | §4–§13、§16 | 只从**依赖与边界**角度写（§14），不逐章拆 |

⚠ **这条边界是本文最先要立的**，因为它决定了后面每一章的证据强度：
框架本体的一切结论都有源码可查，而 Server 侧只能从包元信息与 CLI 的引用方式反推。
仓库自带的威胁模型文档也把这条线画在同一处（§16.2）。

**判据上它是「框架」不是「产品」**：读者不是「装了就用」，而是 `import` 它、
继承它的基类、被它的类型签名约束。所以本文的证据形态是包拓扑、API 契约、
弃用周期，而不是功能清单与配置项——后者只在 §13（CLI）那一章出现，
因为 CLI 确实是个产品面。

### 1.1 与 LangChain 的关系：双向依赖，且方向在变

两个仓库互相依赖，且方向不对称：

```
langgraph 1.2.10   → langchain-core>=1.4.7,<2      （框架依赖 core）
langchain 1.3.14   → langgraph>=1.2.5,<1.3.0       （反向也成立，且钉到了 minor）
```

前者取自本地 `libs/langgraph/pyproject.toml`，后者取自 PyPI 上 `langchain` 1.3.14 的
`requires_dist`（与 `langchain` 仓库 `libs/langchain_v1/pyproject.toml:28` 一致）。

**更值得注意的是「东西正在从 langgraph 搬到 langchain」**：§10 那 31 个弃用点里，
有 9 个的替换目标是 `langchain.agents` / `langchain.agents.interrupt`，
包括 `create_react_agent`、`AgentState`、`HumanInterrupt` 这些被教程引用最多的符号。
**这不是同仓重命名，是跨仓迁移**——升级时你得同时管两个仓库的版本约束。

### 1.2 「几个包」的三种口径

数「LangGraph 有几个包」同样有口径问题，三个数都对但对应不同句子：

| 口径 | 数字 | 含义 |
| --- | --- | --- |
| `libs/` 下的目录数 | **9** | 含 `sdk-js` 这个只有 README 的空壳 |
| 有 `pyproject.toml` 的目录数 | **8** | 真正能发布的 Python 包 |
| 加上不在本仓的运行时包 | **8 + 2** | 跑 Server 时实际装进环境的 |

本文后续凡说「8 个包」，指第二个口径。
计数命令是 `find libs -maxdepth 1 -mindepth 1 -type d | wc -l`（得 9）
与逐目录检查 `pyproject.toml` 存在性（得 8）——
`ls libs | wc -l` 这种写法在本仓恰好也返回 9，但那是巧合，它数的是「条目」不是「目录」。

---

## 2. 包拓扑与版本矩阵

本节全部数字来自两处实查：本地 `libs/*/pyproject.toml`（2026-08-09，检出 `d56666f7`）
与 PyPI JSON API（同日抓取后落盘）。

### 2.1 本仓 8 个包

| 包名 | pyproject 里的版本 | PyPI latest | PyPI 最后发布 | 累计版本数 | 许可 | requires-python |
| --- | --- | --- | --- | --- | --- | --- |
| `langgraph` | 1.2.10 | **1.2.10** | 2026-07-28 | 275 | MIT | >=3.10 |
| `langgraph-checkpoint` | 4.2.0 | **4.2.0** | 2026-08-07 | 60 | MIT | >=3.10 |
| `langgraph-checkpoint-postgres` | 3.1.2 | **3.1.2** | 2026-08-07 | 50 | MIT | >=3.10 |
| `langgraph-checkpoint-sqlite` | 3.1.1 | **3.1.1** | 2026-07-30 | 24 | MIT | >=3.10 |
| `langgraph-prebuilt` | 1.1.0 | **1.1.0** | 2026-05-12 | 44 | MIT | >=3.10 |
| `langgraph-cli` | **`dynamic`** | **0.4.31** | 2026-07-10 | 140 | MIT | >=3.10 |
| `langgraph-sdk` | **`dynamic`** | **0.4.2** | 2026-06-01 | 100 | MIT | >=3.10 |
| `langgraph-checkpoint-conformance` | 0.0.2 | **0.0.2** | 2026-04-08 | 2 | MIT | >=3.10 |

**三个必须点破的地方：**

1. **`cli` 与 `sdk-py` 的 `pyproject.toml` 里读不到版本号**——它们写的是
   `dynamic = ["version"]`，`[tool.hatch.version]` 指向 `langgraph_cli/__init__.py`
   与 `langgraph_sdk/__init__.py` 的 `__version__` 字面量（实查分别是 `0.4.31` 与 `0.4.2`，
   与 PyPI 一致）。**只读 pyproject 会漏掉这两个包**，必须走 PyPI 或读 `__init__.py`。
2. **`langgraph-checkpoint` 是 4.2.0，比 `langgraph` 的 1.2.10 高出三个大版本。**
   这不是笔误：它从 2024-08-02 的 1.0.0 起独立演进，2026-01-12 就到了 4.0.0（§18.2）。
   **「LangGraph 1.x」这个说法只覆盖 8 个包里的 1 个。**
3. **`conformance` 只有 2 个发布**（2026-02-17 首发、2026-04-08 至今），版本号还在 `0.0.x`。
   它是本仓最年轻的包，也是最能说明设计意图的一个（§9）。

### 2.2 两个不在本仓、许可证不同的运行时包

| 包名 | PyPI latest | 最新预发布 | 累计版本数 | 首发 | 许可 | requires-python |
| --- | --- | --- | --- | --- | --- | --- |
| `langgraph-api` | **0.12.1** | 0.13.0rc3（2026-08-08） | **491** | 2024-11-21 | **Elastic-2.0** | >=3.11 |
| `langgraph-runtime-inmem` | **0.32.1** | 0.33.0rc3（2026-08-08） | **171** | 2025-04-09 | **Elastic-2.0** | >=3.11 |

它们通过 `langgraph-cli` 的 `inmem` extra 进来（`libs/cli/pyproject.toml`）：

```toml
[project.optional-dependencies]
inmem = [
    "langgraph-api>=0.5.35,<1.0.0 ; python_version >= '3.11'",
    "langgraph-runtime-inmem>=0.7 ; python_version >= '3.11'",
]
```

**三个含义要分清：**

- **许可证在这里换轨**。本仓 8 个包全是 MIT；这两个是 Elastic-2.0。
  跑 `langgraph dev` 起本地服务时，装进环境的东西已经不全是 MIT 了。
- **`python_version >= '3.11'` 这个 marker 意味着 Python 3.10 用户装 `[inmem]` 会静默拿不到 Server**。
  框架本体声明支持 >=3.10，Server 侧要求 >=3.11——**声明的下界和可用的下界不是一回事。**
- **`langgraph-api` 有 491 个版本，比框架本体的 275 个还多**，而且 2026 年发了 225 个（§18.3）。
  发版节奏差 6 倍这件事本身就说明这两层的稳定性预期完全不同。

另有一个 MIT 的协议包 `langchain-protocol`（PyPI **0.0.18**，11 个版本，首发 2026-04-16），
被 `langgraph-sdk` 与 `langgraph-api` 双向引用，同名的 npm 包 `@langchain/protocol`
也被 JS 侧的 `@langchain/langgraph` 依赖（§15.2）。**它是跨语言、跨开源边界的公共协议层**，
但它的版本号还在 `0.0.x`。

### 2.3 命名空间包：8 个发行包共用一个 `langgraph.` 前缀

这是本仓一个容易忽略但影响很实际的结构事实：**`langgraph` 这个 import 名不属于任何一个包。**

实查 `libs/langgraph/langgraph/` 目录，**没有 `__init__.py`**——
只有 9 个 `.py` 文件（`types.py`、`errors.py`、`runtime.py`、`warnings.py`、`constants.py`、
`config.py`、`callbacks.py`、`typing.py`、`version.py`）、一个 `py.typed`，以及 8 个子目录。
6 个发行包各自往这个命名空间里注入自己的子树，谁都不拥有根：

| 发行包 | 注入的路径 |
| --- | --- |
| `langgraph` | `langgraph/{channels,func,graph,managed,pregel,stream,utils,_internal}/` + 根下 9 个模块 |
| `langgraph-checkpoint` | `langgraph/checkpoint/{base,memory,serde}/`、`langgraph/store/{base,memory}/`、`langgraph/cache/{base,memory,redis}/` |
| `langgraph-checkpoint-postgres` | `langgraph/checkpoint/postgres/`、`langgraph/store/postgres/` |
| `langgraph-checkpoint-sqlite` | `langgraph/checkpoint/sqlite/`、`langgraph/store/sqlite/`、`langgraph/cache/sqlite/` |
| `langgraph-prebuilt` | `langgraph/prebuilt/` |
| `langgraph-checkpoint-conformance` | `langgraph/checkpoint/conformance/` |

另外两个包用独立顶层名，不参与这个命名空间：`langgraph_sdk`（`sdk-py`）与
`langgraph_cli`（`cli`）——**下划线不是笔误，它们的 import 名确实和其他包不同一个体系。**

**这个设计的代价要认**：`import langgraph.checkpoint.postgres` 能不能成功，
取决于你装了哪几个 wheel，而**报错时的 `ModuleNotFoundError` 不会告诉你缺哪个包**。
好处是扩展点天然开放——第三方实现一个 checkpointer 可以直接占 `langgraph.checkpoint.myredis`
这样的位置，和官方实现平级（§8、§9）。

---

## 3. 依赖约束图与升级边界

**这一节是框架研究里产品研究没有对应物的一章。** 单个包的版本号谁都查得到，
而「这 8 个包之间的约束是否自相矛盾、哪个上界快撞了」需要把它们放在一起看。

### 3.1 全量约束表（本地 `pyproject.toml` 实查）

| 包 | 对同族包的约束 | 对外部包的约束 |
| --- | --- | --- |
| `langgraph` | `langgraph-checkpoint>=4.1.0,<5.0.0`<br>`langgraph-sdk>=0.4.2,<0.5.0`<br>`langgraph-prebuilt>=1.1.0,<1.2.0` | `langchain-core>=1.4.7,<2`<br>`xxhash>=3.5.0`、`pydantic>=2.7.4` |
| `langgraph-checkpoint` | —（**不依赖任何同族包**） | `langchain-core>=0.2.38`、`ormsgpack>=1.12.0` |
| `langgraph-checkpoint-postgres` | `langgraph-checkpoint>=4.1.0,<5.0.0` | `orjson>=3.11.5`、`psycopg>=3.2.0`、`psycopg-pool>=3.2.0` |
| `langgraph-checkpoint-sqlite` | `langgraph-checkpoint>=4.1.0,<5.0.0` | `aiosqlite>=0.20`、`sqlite-vec>=0.1.6` |
| `langgraph-prebuilt` | `langgraph-checkpoint>=2.1.0,<5.0.0` | `langchain-core>=1.3.1` |
| `langgraph-checkpoint-conformance` | `langgraph-checkpoint>=2.0.0` | — |
| `langgraph-cli` | `langgraph-sdk>=0.1.0`（仅 py>=3.11） | `click>=8.1.7`、`httpx>=0.24.0`、`pathspec`、`python-dotenv`、`tomli`（py<3.11） |
| `langgraph-sdk` | —（**不依赖任何同族包**） | `httpx>=0.25.2`、`orjson>=3.11.5`、`langchain-protocol>=0.0.15`、`langchain-core>=1.4.0,<2`、`websockets>=14,<17` |

### 3.2 三个已经贴到边上的上界

**① `langchain` 钉死了 `langgraph<1.3.0`，而 langgraph 已经是 1.2.10。**

```
langchain 1.3.14 → langgraph>=1.2.5,<1.3.0
langgraph 当前      1.2.10          ← 距上界只剩 minor 号一步
```

**langgraph 一发 1.3.0，当前的 langchain 就装不上它了**，必须等 langchain 同步放宽。
而且 `1.2.0a1` 早在 2026-04-29 就有了预发布（§18.2），
说明 minor 迭代周期是几个月量级——这个上界撞上是可预期的，不是理论风险。

**② `langgraph → langgraph-prebuilt>=1.1.0,<1.2.0` 是全表最窄的一段区间。**
`prebuilt` 当前正好是 **1.1.0**——**踩在下界上**。
这一段等于把两个包锁成同步发版：prebuilt 一进 1.2.0 就出界。
考虑到 §10.3 里 prebuilt 的主要导出正在被搬去 langchain，
这个窄区间更像是「这个包正在被掏空、暂时冻结」的信号，而不是稳定的兼容承诺。

**③ `langgraph → langchain-core>=1.4.7,<2`，core 当前 1.5.3。** 这一段还宽裕，
但注意同族里 **`langgraph-checkpoint` 的下界是 `langchain-core>=0.2.38`**——
比 langgraph 本体低了整整一个大版本。这不是矛盾（下界宽不冲突），
但它意味着**单独装 `langgraph-checkpoint` 时 pip 完全可能给你解出一个古老的 core**，
只有和 `langgraph` 一起装才会被抬到 1.4.7。

### 3.3 一处真实的约束自相矛盾：conformance 的下界

`langgraph-checkpoint-conformance` 0.0.2 声明：

```toml
dependencies = ["langgraph-checkpoint>=2.0.0"]
```

但它的测试套件实查引用了 4 个方法——`aprune`（10 处）、`acopy_thread`（10 处）、
`aget_delta_channel_history`（10 处）、`adelete_for_runs`（9 处）——
而这些方法是 **2026-02-17 的 commit `9b9de5bd1`（"chore: conformance testing"）
才加进 `BaseCheckpointSaver` 的，当时 `libs/checkpoint/pyproject.toml` 里的版本已经是 4.0.0**
（`aget_delta_channel_history` 更晚，2026-05-04 的 `0a53c385b`）。

**也就是说：按声明它能装 `langgraph-checkpoint` 2.0.0，但装上去会在 import 期就崩。**
声明下界比真实下界低了两个大版本。这不影响正常用法（用它的人几乎必然装着新版 checkpoint），
但它是「约束表里的数字不等于真实可用范围」的一个干净样本——
**依赖约束是人写的，不是从代码推出来的，所以它会和代码漂移。**

### 3.4 依赖方向图

`CLAUDE.md`（也就是 `AGENTS.md`，两个文件实测只差一行代码块语言标记）里画了一张依赖图，
实查与 `pyproject.toml` 基本一致，但**它把 `sdk-js` 列为本仓的一个 library**——
而那个目录早已是空壳（§15.1）。仓库自带的说明文档也会过期。

按实查重画（箭头指向依赖方）：

```
langchain-core ──┬── langgraph-checkpoint ──┬── langgraph-checkpoint-postgres
                 │                          ├── langgraph-checkpoint-sqlite
                 │                          ├── langgraph-checkpoint-conformance
                 │                          ├── langgraph-prebuilt ──┐
                 │                          └── langgraph ←──────────┘
                 ├── langgraph-prebuilt
                 ├── langgraph
                 └── langgraph-sdk ──┬── langgraph 
                                     └── langgraph-cli
                                            └─[extra: inmem]→ langgraph-api (Elastic-2.0)
                                                            → langgraph-runtime-inmem (Elastic-2.0)
langchain-protocol ── langgraph-sdk
```

**`langgraph` 依赖 `langgraph-sdk` 这条边值得单独说**：核心执行引擎依赖一个「SDK 客户端」包，
方向看起来是反的。实查原因在 §12.4——`RemoteGraph` 让远端图伪装成本地图，
它需要 SDK 去发 HTTP 请求，而 `RemoteGraph` 就住在 `langgraph` 包里。

---

## 4. 仓库结构与规模

GitHub REST API 实查（2026-08-09）：

| 项 | `langchain-ai/langgraph` |
| --- | --- |
| 创建 | **2023-08-09**（首个提交同日，commit message 就叫 "First commit"） |
| 最后 push | 2026-08-08 |
| Star | **39,236** |
| Fork | 6,592 |
| Open issues | **671** |
| 仓库体积 | 525,825 KB |
| 许可 | MIT |
| 语言占比 | Python **99.6%**、Makefile 0.2%、TypeScript 0.1%、JavaScript 0.1% |
| 提交总数 | **7,039**（本地 `git rev-list --count HEAD`） |

对照同组织的另外三个仓库（同日同端点）：

| 仓库 | 创建 | Star | Open issues | 主语言 |
| --- | --- | --- | --- | --- |
| `langchain-ai/langchain` | 2022-10-17 | 143,729 | 435 | Python 99.3% |
| `langchain-ai/langgraph` | 2023-08-09 | **39,236** | **671** | Python 99.6% |
| `langchain-ai/langgraphjs` | 2024-01-09 | 3,187 | 101 | TypeScript 98.2% |
| `langchain-ai/docs` | 2025-05-15 | 392 | 388 | MDX 92.9% |

⚠ **`langgraph` 的 open issues（671）比 star 数 3.6 倍于它的 `langchain`（435）还多。**
这是个值得记下但**不该过度解读**的观察：issue 数受关闭策略、模板、机器人影响很大
（本仓 `.github/workflows/` 里就有 `reopen_on_assignment.yml`、`require_issue_link.yml`、
`tag-external-issues.yml` 三个和 issue 生命周期相关的 workflow），
**不能当成质量指标**。能确证的只有绝对数，归因无法核验。

### 4.1 代码规模：两个口径

「LangGraph 有多少代码」同样要说清口径。本地 AST + 行数实查（`d56666f7`）：

| 包 | 生产代码 py 文件 | 生产代码行数 | 含 tests/bench 文件 | 含 tests/bench 行数 |
| --- | --- | --- | --- | --- |
| `langgraph` | 78 | **27,872** | 148 | 92,689 |
| `sdk-py` | 63 | 20,803 | 127 | 34,324 |
| `cli` | 46 | 9,997 | 66 | 17,197 |
| `checkpoint` | 17 | 5,894 | 25 | 9,733 |
| `checkpoint-postgres` | 9 | 5,046 | 18 | 8,197 |
| `checkpoint-sqlite` | 8 | 3,941 | 17 | 7,522 |
| `prebuilt` | 7 | 3,676 | 25 | 12,612 |
| `checkpoint-conformance` | 17 | 3,364 | 18 | 3,385 |
| `sdk-js` | **0** | **0** | 0 | 0 |
| **合计** | **245** | **80,593** | **444** | **185,659** |

**测试量比生产代码大**：185,659 − 80,593 = 105,066 行在 tests/bench 里，占 **56.6%**。
AST 口径数 `test_` 函数得 **2,618 个**（`grep -rho 'def test_'` 得 2,619，
差的 1 个是字符串或注释里的字面量——**两个口径都对，但只能引用你能解释差异的那个**，
本文用 AST 的 2,618）。

按包看测试密度差异很大：`langgraph` 本体 1,266 个、`sdk-py` 516 个、`cli` 303 个、
`prebuilt` 167 个、`checkpoint` 115 个。**`prebuilt` 只有 3,676 行生产代码却有 12,612 行测试
（3.4 倍）**，这在一个正被弃用掏空的包上有点反直觉。

### 4.2 `langgraph` 包内部：Pregel 占了一半

生产代码 27,872 行里，`pregel/` 一个目录占 **14,873 行（53.4%）**。最大的文件：

| 文件 | 行数 | 干什么 |
| --- | --- | --- |
| `pregel/main.py` | **4,364** | `Pregel` 类本体（§6） |
| `pregel/_loop.py` | 1,988 | 超步循环（`PregelLoop` / `SyncPregelLoop` / `AsyncPregelLoop`） |
| `graph/state.py` | 1,964 | `StateGraph` 与 `CompiledStateGraph`（§5.2） |
| `pregel/_algo.py` | 1,460 | 任务规划（Plan 阶段的算法） |
| `pregel/remote.py` | 1,308 | `RemoteGraph`（§12.4） |
| `stream/transformers.py` | 1,039 | 流式投影（§11.2） |
| `types.py` | **984** | 公共类型，`__all__` 有 32 项（§5.1） |
| `pregel/_runner.py` | 941 | Execution 阶段的执行器 |
| `pregel/_retry.py` | 854 | 重试与超时（§6.4） |

⚠ 注意 `types.py` 是 984 行但**文件大小 33,243 字节**——docstring 占了大部分。
这个包的公共类型文件里，注释比声明多。

---

## 5. 核心抽象：API 契约面

### 5.1 「有多少个公共 API」：四个口径差 5 倍

这是框架研究里最容易被数错的一件事。**同一个问题，四个合理口径给出四个数：**

| 口径 | 数字 | 能不能用 |
| --- | --- | --- |
| 顶层 `langgraph/__init__.py` 的 `__all__` | **不存在** | ❌ 该文件根本没有（§2.3 命名空间包） |
| `langgraph` 包内各 `__init__.py` 的 `__all__` 加总 | **39** | ⚠ 只覆盖 1 个发行包，且漏掉根下 9 个模块 |
| `langgraph` 包内**所有** `.py` 的 `__all__` 加总 | **159**（去重 **130**） | ⚠ 混进了内部模块的导出 |
| **6 个发行包的 `__init__.py` `__all__` 加总** | **81** | ✅ 最接近「跨包能 import 到什么」 |
| AST 数模块级公共 class / def（排除 `_internal`、tests） | **202 / 210** | ⚠ 数的是实现规模，不是公共 API |

**所以「LangGraph 有 N 个公共 API」这句话必须带口径。** 本文按第四个口径（81）——分布是：

| 发行包 | `__init__.py` 导出数 | 具体位置 |
| --- | --- | --- |
| `langgraph` | 39 | `stream/`(16)、`channels/`(11)、`graph/`(6)、`func/`(2)、`managed/`(2)、`pregel/`(2) |
| `checkpoint` | 14 | `store/base/`(14) |
| `checkpoint-conformance` | 11 | `conformance/`(2) + `conformance/spec/`(9) |
| `prebuilt` | 8 | `prebuilt/`(8) |
| `checkpoint-postgres` | 7 | `checkpoint/postgres/`(4) + `store/postgres/`(3) |
| `checkpoint-sqlite` | 2 | `store/sqlite/`(2) |

⚠ **这个口径也有已知缺口，必须点破**：它漏掉了 `langgraph/types.py`（`__all__` 32 项）、
`errors.py`（14 项）、`constants.py`（7 项）、`runtime.py`（6 项）、`typing.py`（6 项）、
`callbacks.py`（7 项）、`warnings.py`（4 项）这些**根下的平铺模块**——
用户是从 `langgraph.types import Command` 这样直接 import 的，
而根目录没有 `__init__.py` 去汇总它们。
把这 7 个模块的 `__all__` 加进来（32+14+7+6+6+7+4 = 76）会得到另一个数。
**没有哪个口径是「正确」的，只有说清了口径的才是可引用的。**

### 5.2 用户实际写代码碰到的三层入口

抛开计数，实查下来读者真正会 import 的是三组东西：

| 层 | 入口 | 从哪 import | 公共方法数 |
| --- | --- | --- | --- |
| **图构建（声明式）** | `StateGraph` | `langgraph.graph` | **10**（去重后，§5.3） |
| **图构建（函数式）** | `@entrypoint` / `@task` | `langgraph.func` | 2 个装饰器 |
| **运行时** | `Pregel`（`CompiledStateGraph` 的基类） | 通常不直接 import，由 `.compile()` 返回 | **34**（去重后，§6.2） |

`langgraph.graph` 的 `__all__` 是 6 项：`START`、`END`、`StateGraph`、`add_messages`、
`MessagesState`、`MessageGraph`——**其中 `MessageGraph` 已弃用**（§10.2）。
所以这个「6 项入口」实际可用的是 5 项。

### 5.3 `StateGraph`：10 个方法，14 个定义

AST 实查 `StateGraph` 的公共方法**定义数是 14，去重名字是 10**——
差的 4 个是 `add_node` 的 `@overload` 签名（一个方法 5 个重载）。
**这是框架计数的一个通用陷阱：`@overload` 会让「方法数」虚高。**

去重后的 10 个：

| 方法 | 作用 |
| --- | --- |
| `add_node` | 加节点（5 个 overload：函数 / 名字+函数 / 带 config 等） |
| `add_edge` | 加固定边 |
| `add_conditional_edges` | 加条件边（路由函数决定去哪） |
| `add_sequence` | 一次加一串顺序节点 |
| `set_entry_point` / `set_conditional_entry_point` | 设入口（等价于从 `START` 连边） |
| `set_finish_point` | 设出口（等价于连到 `END`） |
| `set_node_defaults` | 批量设节点默认参数 |
| `validate` | 结构校验 |
| `compile` | **编译成 `CompiledStateGraph`（即 `Pregel` 子类）** |

`CompiledStateGraph` 自己只有 5 个公共方法（`get_input_jsonschema`、`get_output_jsonschema`、
`attach_node`、`attach_edge`、`attach_branch`），其余全部继承自 `Pregel`。
**`StateGraph` 是个 builder，编译后的东西才是执行器**——这条继承关系
（`CompiledStateGraph` → `Pregel` → `PregelProtocol` → `Runnable`）是理解这个框架类型系统的骨架。

### 5.4 五个抽象基类（正则与 AST 口径一致）

AST 实查全仓（排除 tests）继承 `ABC` 的类**恰好 5 个**，
`grep -rE "^class \w+\(.*ABC.*\):"` 同样得 5——**两个口径这次没有分歧**
（框架研究方法论里提到的「多行 class 签名让正则漏数」在本仓不成立，
因为这 5 个的签名都在一行内）：

| 抽象基类 | 位置 | `@abstractmethod` 数 | 有默认实现 |
| --- | --- | --- | --- |
| `BaseChannel` | `langgraph/channels/base.py:19` | **5** | 5 |
| `BaseStore` | `checkpoint/langgraph/store/base/__init__.py:708` | **2** | 10 |
| `BaseCache` | `checkpoint/langgraph/cache/base/__init__.py:15` | **6** | 0 |
| `ManagedValue` | `langgraph/managed/base.py:18` | — | — |
| `StreamTransformer` | `langgraph/stream/_types.py:44` | — | — |

**注意 `BaseCheckpointSaver` 不在这张表里**——它不是 ABC。这件事很重要，见 §8.1。

`BaseChannel` 的契约切分很干净：抽象的 5 个是 `ValueType`、`UpdateType`、
`from_checkpoint`、`get`、`update`；有默认实现的 5 个是 `copy`、`checkpoint`、
`is_available`、`consume`、`finish`。**必须实现的是「值语义 + 反序列化 + 读 + 写」，
生命周期钩子给了默认值。**

`BaseCache` 反过来——**6 个方法全是抽象的，没有一个有默认实现**
（`get`/`aget`/`set`/`aset`/`clear`/`aclear`，同步异步各 3 个）。
**这是全仓最严格的契约**：实现一个 cache 后端必须把 6 个方法全写完，
连「同步版本自动代理到异步」这种便利都没给。

---

## 6. 执行模型：Pregel 与超步

### 6.1 三阶段循环（源码 docstring 实录）

`Pregel` 类的 docstring（`libs/langgraph/langgraph/pregel/main.py:454` 起）
自己写明了模型来源：**Actor 模型 + Pregel 算法 / Bulk Synchronous Parallel**。
每个 step（超步）分三阶段：

| 阶段 | 做什么（docstring 原意） |
| --- | --- |
| **Plan** | 决定这一步跑哪些 actor。第一步选订阅了 input 通道的；后续步选订阅了「上一步被更新过的通道」的 |
| **Execution** | 并行跑所有选中的 actor，直到全部完成 / 一个失败 / 超时。**这一阶段里通道更新对 actor 不可见** |
| **Update** | 把 actor 写出的值更新进通道 |

重复直到没有 actor 被选中，或达到步数上限。
**「Execution 阶段通道更新互不可见」是这个模型的核心保证**——
它让并行节点之间不会看到对方的半成品状态，代价是每一步都要走一次全局同步屏障。

实现分布在三个文件：`_algo.py`（1,460 行）管 Plan、`_runner.py`（941 行）管 Execution、
`_loop.py`（1,988 行）里的 `PregelLoop.tick()`（`_loop.py:599`）串起整个循环。
`SyncPregelLoop`（`:1469`）与 `AsyncPregelLoop`（`:1722`）分别实现成
`AbstractContextManager` 与 `AbstractAsyncContextManager`。

### 6.2 `Pregel` 的 34 个方法

AST 实查：**公共方法定义 48 个，去重名字 34 个**——14 个差额全是 `@overload`
（`stream`/`astream` 各 3 个、`stream_events`/`astream_events` 各 3 个、
`invoke`/`ainvoke` 各 4 个）。按功能分组（去重后）：

| 组 | 方法 |
| --- | --- |
| **执行**（4 组同步/异步对） | `invoke`/`ainvoke`、`stream`/`astream`、`stream_events`/`astream_events` |
| **状态读写** | `get_state`/`aget_state`、`get_state_history`/`aget_state_history`、`update_state`/`aupdate_state`、`bulk_update_state`/`abulk_update_state` |
| **schema 内省** | `InputType`、`OutputType`、`get_input_schema`、`get_input_jsonschema`、`get_output_schema`、`get_output_jsonschema`、`get_context_jsonschema`、`config_schema`（弃用）、`get_config_jsonschema`（弃用） |
| **图结构** | `get_graph`/`aget_graph`、`get_subgraphs`/`aget_subgraphs`、`validate`、`copy`、`with_config` |
| **流通道** | `stream_channels_list`、`stream_channels_asis` |
| **缓存** | `clear_cache`/`aclear_cache` |

**`PregelProtocol`（`pregel/protocol.py`）是这里的契约**：
AST 实查 `@abstractmethod` **定义 23 个、去重 15 个**（同样是 overload 造成的差额）。
15 个必须实现的方法是 `with_config`、`get_graph`/`aget_graph`、`get_state`/`aget_state`、
`get_state_history`/`aget_state_history`、`update_state`/`aupdate_state`、
`bulk_update_state`/`abulk_update_state`、`stream`/`astream`、`invoke`/`ainvoke`。

实现这个 protocol 的只有两个类，而它们的差别是本框架一个关键设计（§12.4）：

```
PregelProtocol (Runnable 的子类)
├── Pregel                    ← 本地执行
│   └── CompiledStateGraph    ← StateGraph.compile() 的产物
└── RemoteGraph               ← 远端执行，走 HTTP
```

### 6.3 `version="v1"` / `"v2"` / `"v3"`：三套返回类型并存

实查 `invoke`/`stream` 的签名，`version` 参数的**实现默认值都是 `"v1"`**，
而 `stream_events` 的默认是 `"v2"`：

| 方法 | 支持的 version | 实现默认 | v1 返回 | v2 返回 |
| --- | --- | --- | --- | --- |
| `invoke`/`ainvoke` | v1, v2 | **v1** | `dict[str, Any] \| Any` | `GraphOutput[OutputT]` 或 `list[StreamPart]` |
| `stream`/`astream` | v1, v2 | **v1** | `Iterator[dict \| Any]` | `Iterator[StreamPart[StateT, OutputT]]` |
| `stream_events`/`astream_events` | v1, v2, **v3** | **v2** | `Iterator[StreamEvent]` | v3 返回 `GraphRunStream` |

**三件事要点破：**

1. **默认还是 v1**，也就是「返回裸 dict」。v2 的 `GraphOutput` 是个 frozen dataclass，
   有 `.value` 和 `.interrupts` 两个字段——**类型明确了，但要显式传 `version="v2"` 才拿得到。**
2. **`GraphOutput` 为了兼容 v1 的用法保留了 `__getitem__` 和 `__contains__`，
   而这两个入口都在 v1.1 起发弃用警告**（`LangGraphDeprecatedSinceV11`，
   `types.py:382` 与 `:399`）。也就是说：**你从 v1 迁到 v2 之后，
   如果还按 dict 用它，会继续收到警告，得改成 `.value`。**
   这是本仓 V11 那一档**仅有的 2 个弃用点**（§10.1）。
3. **`stream_events(version="v3")` 的 docstring 明确标了实验性**
   （"The `version="v3"` API is experimental and may change"，`main.py:3659`），
   且需要在 `compile(transformers=[...])` 时配好投影器才有意义（§11.2）。

### 6.4 重试、超时与递归上限

`RetryPolicy`（`types.py:416`，`NamedTuple`）的默认值，实查逐字段：

| 字段 | 默认 |
| --- | --- |
| `initial_interval` | 0.5 秒 |
| `backoff_factor` | 2.0 |
| `max_interval` | 128.0 秒 |
| `max_attempts` | **3**（含首次） |
| `jitter` | **True** |
| `retry_on` | `default_retry_on` |

docstring 标注 `RetryPolicy` 是 **0.2.24 加入**的（源码里用 `!!! version-added` 标记，
这个标记在本仓被广泛使用，是查「某个特性哪个版本起有」的可靠途径）。

**递归上限**（`_internal/_config.py:32`）：

```python
DEFAULT_RECURSION_LIMIT = int(getenv("LANGGRAPH_DEFAULT_RECURSION_LIMIT", "10007"))
```

变更史（git 实查）：

| 日期 | 值 | commit |
| --- | --- | --- |
| ~2025-03-12 前 | 25（env 名还是 `LG_DEFAULT_RECURSION_LIMIT`） | `4c902d21a` 那次只改了 env 名 |
| 2026-01-12 | **25 → 10000** | `a5827c5c6`「fix: change default recursion limit (#6676)」 |
| 2026-03-30 | **10000 → 10007** | `2fb367e90`「fix(langgraph): avoid recursion limit default sentinel collision (#7355)」 |

**10007 是质数，选它的理由写在 commit 标题里：避免和默认哨兵值撞。**
这是个很实际的实现细节——`_config.py:185` 那段逻辑靠
`config["recursion_limit"] != DEFAULT_RECURSION_LIMIT` 判断「用户有没有显式设过」，
默认值一旦和某个常见值相同就会误判。

同文件还有 `DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT`（默认 5000，
env `LANGGRAPH_DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT`），和 §8.4 的增量通道历史有关。

### 6.5 错误类型：13 个类，一条 `GraphBubbleUp` 分支

`langgraph/errors.py` 的 `__all__` 有 14 项（13 个类 + `ErrorCode` 枚举）。
继承结构里有个刻意的设计：

```
Exception
├── GraphBubbleUp          ← 「这不是错误，是控制流」
│   ├── GraphDrained
│   ├── GraphInterrupt     ← interrupt() 抛的
│   │   └── NodeInterrupt   （已弃用，§10.2）
│   └── ParentCommand
├── InvalidUpdateError
├── EmptyInputError
├── TaskNotFound
├── NodeCancelledError
└── NodeTimeoutError
RecursionError
└── GraphRecursionError
```

**`GraphBubbleUp` 这一支是「用异常做控制流」**：HITL 的 interrupt、
子图向父图发命令（`ParentCommand`）、图正常排空（`GraphDrained`）都走异常通道。
读这个框架的 traceback 时，看到 `GraphBubbleUp` 后代不代表出错了。

`ErrorCode` 枚举给错误配了稳定标识符（如 `GRAPH_RECURSION_LIMIT`、
`INVALID_CONCURRENT_GRAPH_UPDATE`），这类「错误码 + 文档链接」的做法
让报错可以稳定地指向排障页——即使文档站换了域名（§17），错误码本身不变。

---

## 7. 通道：状态怎么合并

### 7.1 10 个内置通道（AST 实查 `BaseChannel` 后代）

`langgraph.channels` 的 `__all__` 有 11 项（`BaseChannel` + 10 个实现），
AST 顺着继承链数 `BaseChannel` 的后代**恰好 10 个**，两个口径一致：

| 通道 | 文件:行 | 语义 |
| --- | --- | --- |
| `LastValue` | `last_value.py:20` | **默认通道**。存最后写入的值；一个超步内被写两次会报错 |
| `LastValueAfterFinish` | `last_value.py:81` | 同上，但只在 `finish()` 后才对外可见 |
| `Topic` | `topic.py:23` | PubSub 主题，可配置去重 / 跨步累积。多值传递用它 |
| `BinaryOperatorAggregate` | `binop.py:65` | 用二元算子归约（`operator.add` 之类）。`Annotated[list, add]` 背后就是它 |
| `EphemeralValue` | `ephemeral_value.py:15` | 只活一个超步，下一步就清空 |
| `UntrackedValue` | `untracked_value.py:15` | 不进 checkpoint，不参与版本追踪 |
| `AnyValue` | `any_value.py:15` | 存任意一个写入值，不校验冲突 |
| `NamedBarrierValue` | `named_barrier_value.py:13` | 等一组具名写入者全部到齐才可用（屏障） |
| `NamedBarrierValueAfterFinish` | `named_barrier_value.py:84` | 同上 + `finish` 语义 |
| `DeltaChannel` | `delta.py:25` | 增量通道，只存变化量（§8.4） |

整个 `channels/` 目录只有 **1,143 行**，最大的是 `delta.py`（202 行）。
**这是全框架最小、也最稳定的一层**——10 个通道覆盖了「最后写入 / 累积 / 归约 / 屏障 / 临时 / 不追踪」
这几种合并语义，而这些语义是 BSP 模型的直接推论，不太会变。

### 7.2 `AfterFinish` 与 `Untracked`：两个容易漏的语义

三对通道的差别值得单独记：

- **`LastValue` vs `LastValueAfterFinish`**：后者要等 `finish()`。
  在有 interrupt 的图里，这个差别决定了「被中断时这个键读不读得到」。
- **`UntrackedValue` vs `EphemeralValue`**：前者是**不进 checkpoint**（持久化视角），
  后者是**下一步就没了**（生命周期视角）。两者正交，容易混。
- **`NamedBarrierValue`**：它让「等 3 个并行节点都写完再继续」成为通道语义而不是图结构问题。

### 7.3 一处 docstring 漂移：`Context` 通道已不存在

`Pregel` 的 docstring 在 `main.py:506` 写着：

> `Context`: exposes the value of a context manager, managing its lifecycle.
> Useful for accessing external resources that require setup and/or teardown. e.g.
> `client = Context(httpx.Client)`

实查 `langgraph/channels/` 下**没有 `Context` 类**，`channels/__init__.py` 的 `__all__` 里也没有。
git 实查它被删于 **2025-05-24 的 commit `889b40e7a`**
（"Remove Context channel / managed value, Remove SharedValue"），
`git tag --contains` 显示该提交最早进入 **0.5.0**。

**也就是说：这段 docstring 已经错了约 15 个月，且它在最核心类的类级文档里。**
照它写 `Context(httpx.Client)` 会直接 `ImportError`。
替代做法在当前版本是 `Runtime` / context schema（`langgraph/runtime.py`，`__all__` 6 项），
但 docstring 没有跟着更新。

⚠ **这条对读者的实际影响比看起来大**：类级 docstring 是 IDE 悬浮提示、
`help(Pregel)`、以及**训练数据**的来源。这也是本文 `::: danger` 块里
「AI 生成的代码会带上这些说法」不是虚指的原因之一。

### 7.4 `ManagedValue`：只剩 2 个实现

`langgraph.managed` 的 `__all__` 只有 2 项，AST 数 `ManagedValue` 的后代也是 2 个：
`IsLastStepManager` 与 `RemainingStepsManager`（都在 `managed/is_last_step.py`）。

这两个对应 state schema 里的 `is_last_step` / `remaining_steps` 特殊键——
**它们是「由运行时注入、不由用户写」的值**。
上面那个删除提交同时也删掉了 `SharedValue`，
所以这个扩展点现在实际上是**收缩过的**：抽象基类还在（§5.4 列了它），
但官方实现只剩两个跟步数有关的。

---

## 8. 持久化：checkpoint 契约

### 8.1 `BaseCheckpointSaver` 不是 ABC——这是一个刻意的设计

**这是本文调研中最值得单独讲的一处契约设计。** §5.4 那张 ABC 表里没有它，
因为它的基类只是 `Generic[V]`：

```python
class BaseCheckpointSaver(Generic[V]):   # checkpoint/base/__init__.py:176
```

AST 实查它的方法构成：

| 类别 | 数量 | 具体 |
| --- | --- | --- |
| `@abstractmethod` | **0** | 一个都没有 |
| 只 `raise NotImplementedError` 的桩 | **16** | `get_tuple`/`list`/`put`/`put_writes`/`delete_thread`/`delete_for_runs`/`copy_thread`/`prune` × 同步 + `a` 前缀异步 |
| 有默认实现 | **7** | `config_specs`、`get`/`aget`、`get_delta_channel_history`/`aget_delta_channel_history`、`get_next_version`、`with_allowlist` |

**用 `NotImplementedError` 桩而不是 `@abstractmethod`，语义差别是实打实的：**

| | `@abstractmethod` | `NotImplementedError` 桩 |
| --- | --- | --- |
| 少实现一个方法 | **实例化时就 `TypeError`** | 实例化成功，**调到那个方法才炸** |
| 能不能只实现一半 | 不能 | **能**——这正是它想要的 |
| 第三方实现的自由度 | 低 | 高 |

**为什么要这样？** 因为这 16 个方法里有 8 个是**可选能力**：
一个只支持内存、不支持 `prune`（清理旧 checkpoint）或 `copy_thread`（复制线程）的
后端应该仍然是个合法的 checkpointer。用 `@abstractmethod` 会强迫每个实现者
写 8 个 `raise NotImplementedError` 样板；用桩则让「不实现 = 不支持这个能力」
成为默认表达。

**而「哪些是必须的、哪些是可选的」这个信息，就落在 conformance 包里**（§9）——
契约的强制部分不在类型系统里，在测试套件里。这是个完整的设计选择，不是遗漏。

### 8.2 官方后端：3 个包，8 个 saver 类

AST 顺继承链实查 `BaseCheckpointSaver` 的全部后代：

| 类 | 包 | 文件:行 |
| --- | --- | --- |
| `InMemorySaver` | `checkpoint` | `checkpoint/memory/__init__.py:33` |
| `SqliteSaver` | `checkpoint-sqlite` | `checkpoint/sqlite/__init__.py:45` |
| `AsyncSqliteSaver` | `checkpoint-sqlite` | `checkpoint/sqlite/aio.py:38` |
| `BasePostgresSaver` | `checkpoint-postgres` | `checkpoint/postgres/base.py:344`（中间类） |
| ├ `PostgresSaver` | `checkpoint-postgres` | `checkpoint/postgres/__init__.py:40` |
| ├ `AsyncPostgresSaver` | `checkpoint-postgres` | `checkpoint/postgres/aio.py:40` |
| ├ `ShallowPostgresSaver` | `checkpoint-postgres` | `checkpoint/postgres/shallow.py:169` |
| └ `AsyncShallowPostgresSaver` | `checkpoint-postgres` | `checkpoint/postgres/shallow.py:529` |

**「Shallow」这一对只有 Postgres 有**：它只保留最新 checkpoint 而不留历史，
适合不需要时间旅行、只要断点续跑的场景。**SQLite 侧没有对应物**——
这是一处真实的后端能力不对等，选后端时要知道。

同理，三类扩展点的实现数也不齐：

| 扩展点 | 官方实现 | 缺口 |
| --- | --- | --- |
| `BaseCheckpointSaver` | 8 个类 / 3 个后端（memory、sqlite、postgres） | 无 Redis / MySQL 官方实现 |
| `BaseStore`（长期记忆） | `InMemoryStore`、`SqliteStore`+`AsyncSqliteStore`、`PostgresStore`+`AsyncPostgresStore` | 同上 |
| `BaseCache`（节点级缓存） | `InMemoryCache`、`SqliteCache`、**`RedisCache`** | **Redis 只在 cache 有，checkpoint/store 都没有** |

`RedisCache` 住在 `checkpoint` 包里（`cache/redis/__init__.py:10`），
**而 `redis` 不在 `langgraph-checkpoint` 的 `dependencies` 里**——
它的 import 是延迟的，装了 redis 才能用。这类「代码在但依赖不在」的可选后端
在依赖表里查不出来，只能读源码。

### 8.3 序列化：3 个 serializer，一个 Protocol

`SerializerProtocol`（`checkpoint/serde/base.py:29`）是 `typing.Protocol`，
只有 2 个方法：`dumps_typed`、`loads_typed`。**这是全仓最小的契约面。**
实现 3 个：

| 实现 | 行数 | 说明 |
| --- | --- | --- |
| `JsonPlusSerializer` | `jsonplus.py`（883 行） | 默认。底层 `ormsgpack`，带类型标签与允许列表（§16.1） |
| `EncryptedSerializer` | `encrypted.py`（80 行） | 包一层加密。**Beta** |
| `SerializerCompat` | `base.py:29` | 兼容旧格式 |

`serde/` 全目录 1,244 行，其中 `jsonplus.py` 占 883 行（71%）——
**序列化的复杂度几乎全在「怎么安全地把 Python 对象还原回来」这件事上**，见 §16.1。

### 8.4 增量通道历史：2026-05 才加的能力

`get_delta_channel_history` / `aget_delta_channel_history` 是 `BaseCheckpointSaver`
上**有默认实现**的方法之一（不是桩），git 实查它加入于
**2026-05-04 的 commit `0a53c385b`**（"feat: public get_writes_history saver API + delta cadence rework"）。

配套的东西散在几处，串起来才看得懂这个特性：

- 通道侧：`DeltaChannel`（`channels/delta.py`，202 行，通道里最大的）
- 配置侧：`DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT`（默认 5000，`_internal/_config.py:33`）
- conformance 侧：`DELTA_CHANNEL_HISTORY` 是**可选能力**之一，8 个测试（§9.2）
- 运维侧：`examples/delta-channel-dump/`（2026-06-17 加入）——
  一个**从 Postgres 里 dump 出来做 deltaChannel 回滚**的恢复脚本

⚠ **最后那一条值得注意**：官方在 examples 里放一个「回滚恢复脚本」，
通常意味着这个特性上线后遇到过需要人工介入的情况。
**这是推测，无法从公开信息核验**——能确证的只有脚本存在及其自述用途
（commit `8109` 的标题原文：`add delta-channel-dump recovery script as examples to dump from Postgres for deltaChannel rollback`）。

---

## 9. Conformance 套件：把契约写进测试而不是类型

**这一章是本仓最有辨识度的设计，也是 §8.1 那个「不用 ABC」决定的另一半。**

`langgraph-checkpoint-conformance` 是本仓最年轻的包（2026-02-17 首发，至今仅 2 个发布，
版本号 0.0.2），17 个生产代码文件 / 3,364 行，**89 个测试函数**
（`grep -c 'def test_'` 逐文件加总；含 `tests/` 下自测则是 91）。

### 9.1 用法：注册一个 checkpointer，跑一份报告

README 给的用法（原文摘录）：

```python
from langgraph.checkpoint.conformance import checkpointer_test, validate

@checkpointer_test(name="MyCheckpointer")
async def my_checkpointer():
    saver = MyCheckpointer(...)
    yield saver
    # cleanup runs after yield

report = await validate(my_checkpointer)
report.print_report()
assert report.passed_all_base()
```

**`passed_all_base()` 这个方法名就是设计的全部**：它不检查「全部通过」，
只检查「基础能力全部通过」。

### 9.2 能力分级：5 个必须 + 4 个可选

`conformance/capabilities.py` 把 9 个能力显式分成两组：

| 组 | 能力 | 对应的 saver 方法 | 测试数 |
| --- | --- | --- | --- |
| **BASE**（必须） | `PUT` | `aput` | 17 |
| | `PUT_WRITES` | `aput_writes` | 10 |
| | `GET_TUPLE` | `aget_tuple` | 10 |
| | `LIST` | `alist` | 16 |
| | `DELETE_THREAD` | `adelete_thread` | 5 |
| **EXTENDED**（可选） | `DELETE_FOR_RUNS` | `adelete_for_runs` | 7 |
| | `COPY_THREAD` | `acopy_thread` | 8 |
| | `PRUNE` | `aprune` | 8 |
| | `DELTA_CHANNEL_HISTORY` | `aget_delta_channel_history` | 8 |

合计 **89**（58 个 base + 31 个 extended）。

### 9.3 能力检测靠「方法是不是被覆盖了」

最有意思的实现细节在 `capabilities.py` 的 `_is_overridden`：

```python
def _is_overridden(inner_type: type, method: str) -> bool:
    base = getattr(BaseCheckpointSaver, method, None)
    impl = getattr(inner_type, method, None)
    if base is None or impl is None:
        return impl is not None
    return impl is not base
```

**它比较的是函数对象身份**——你的类上这个方法是不是还等于基类那个
（也就是那个 `raise NotImplementedError` 的桩）。
不等于就算「实现了这个能力」，等于就算「不支持」。

**这个机制和 §8.1 的设计严丝合缝**：正因为基类用的是可调用的桩而不是
`@abstractmethod`，才能用「函数身份是否变了」来做能力探测。
如果用了 ABC，未实现的方法根本不存在于类上，这套探测就得换写法。

**代价也要认**：这个探测是**语法层的，不是语义层的**。
一个实现如果覆盖了 `aprune` 但里面只写 `pass`，能力探测会认为它支持 prune，
然后靠那 8 个测试去发现它其实不干活。**所以能力表只是入场券，报告才是结论。**

### 9.4 它约束了谁：一个「反向兼容性」工具

**这个包的存在改变了第三方 checkpointer 的处境。** 在它之前，
「我的 Redis checkpointer 兼容 LangGraph 吗」只能靠读源码 + 跑自己的图试；
有了它，兼容性成了一个可以在 CI 里跑出报告的属性。

三点值得记：

- **它自己不在 `libs/langgraph` 的依赖里**——是给外部实现者用的工具包，
  官方三个后端也用它（`checkpoint-postgres` 73 个测试、`checkpoint-sqlite` 89 个，
  部分覆盖到这套 spec）。
- **它的依赖声明有 bug**（§3.3）：写 `>=2.0.0` 但实际需要 4.x。
- **版本号还在 0.0.x**，意味着这套 spec 自己也还没稳定。
  拿它当「长期兼容性承诺」为时过早——**它现在是一份可执行的意图声明，不是标准。**

---

## 10. 弃用与迁移：框架读者最该先查的一章

**产品读者怕「这个版本行为变了」；框架读者怕「升个版本我的代码跑不了了」。**
所以这一章对框架来说不是附录，是主章。

### 10.1 三级弃用警告，且移除目标不一致

`langgraph/warnings.py`（整个文件只有 79 行）定义了一套仿 Pydantic 的弃用体系
——docstring 里明说了灵感来源：「Inspired by the Pydantic `PydanticDeprecationWarning` class,
which sets a great standard for deprecation warnings with clear versioning information」。

```
DeprecationWarning
└── LangGraphDeprecationWarning        ← 带 since / expected_removal 两个字段
    ├── LangGraphDeprecatedSinceV05    since=(0,5)  expected_removal=(2,0)
    ├── LangGraphDeprecatedSinceV10    since=(1,0)  expected_removal=(2,0)
    └── LangGraphDeprecatedSinceV11    since=(1,1)  expected_removal=(3,0)
```

**注意 V11 那一档的移除目标是 3.0，不是 2.0。** 基类的默认规则是
`expected_removal = (since[0] + 1, 0)`（下一个大版本），
V05 和 V10 都显式覆写成 `(2, 0)`——**也就是说 0.5 那批和 1.0 那批会在同一个大版本一起清掉**，
而 1.1 那批（只有 2 个，§6.3）多给了一个大版本的宽限。

警告文案由基类的 `__str__` 统一拼装：

```
{message}. Deprecated in LangGraph V{since}. to be removed in V{expected_removal}.
```

**这套设计的好处很实际**：`warnings.filterwarnings` 可以按类别精确过滤
——想临时压掉 1.0 那批噪音但保留 1.1 的新警告是做得到的。
源码里自己就这么用（`pregel/main.py:990`：
`warnings.filterwarnings("ignore", category=LangGraphDeprecatedSinceV10)`）。

### 10.2 31 个弃用点的分布（AST 实查）

**计数口径必须说清**，因为这里三种数法差很多：

| 口径 | 数字 |
| --- | --- |
| `grep -rl '@deprecated'` 文件数 | 7 |
| `grep -rho '@deprecated'` 出现次数 | 14 |
| **AST 数带 `LangGraphDeprecatedSince*` 的 `warn()`/`@deprecated` 调用点** | **31** |

三个数都对：14 是装饰器数，31 是**装饰器 + 运行时 `warn()` 调用**的总和
（很多弃用参数是在函数体里判断后 `warn()`，没有装饰器可数）。本文用 31。

按 since 版本分布：

| since | 弃用点数 | 主要内容 |
| --- | --- | --- |
| **V05**（0.5，2025-06） | **6** | `retry`→`retry_policy`（3 处）、`input`→`input_schema`（2 处）、`output`→`output_schema` |
| **V10**（1.0，2025-10） | **23** | 见下 |
| **V11**（1.1，2026-03） | **2** | `GraphOutput` 的 dict 式访问（§6.3） |

V10 那 23 个可以再分成两类，**这个划分比总数更有信息量**：

| 类 | 数量 | 例子 |
| --- | --- | --- |
| **同包内改名** | 14 | `config_schema`→`context_schema`（4 处）、`checkpoint_during`→`durability`（2 处）、`config_type`→`context_schema`、`interrupt_id`→`id`、`NodeInterrupt`→`interrupt()`、`MessageGraph`→`StateGraph`、`langgraph.pregel.types`→`langgraph.types` |
| **跨仓搬去 langchain** | **9** | `create_react_agent`、`AgentState`、`AgentStatePydantic`、`AgentStateWithStructuredResponse`(+Pydantic 版)、`HumanInterrupt`、`HumanInterruptConfig`、`ActionRequest`、`ValidationNode` |

**`config_schema` → `context_schema` 这条改名出现 4 次**（`pregel/main.py:789`、`:955`、`:983`、
`graph/state.py:225`、`func/__init__.py` 等），是全仓最高频的一条。
它反映的是 1.0 那次把「运行配置」和「静态上下文」拆开的设计调整——
`Runtime` / context schema（`langgraph/runtime.py`）是那次拆分的产物。

### 10.3 `langgraph.prebuilt` 正在被掏空

**这是本快照下最影响读者的一条。** AST 实查 `libs/prebuilt`：

- `__all__` 有 **8** 项：`create_react_agent`、`ToolNode`、`ToolCallTransformer`、
  `tools_condition`、`ValidationNode`、`InjectedState`、`InjectedStore`、`ToolRuntime`
- 带 `@deprecated` 的符号共 **9** 个
- **交集 2 个**：`create_react_agent`、`ValidationNode`
- 只带 `@deprecated`、不在 `__all__` 里的 **7** 个：
  `AgentState`、`AgentStatePydantic`、`AgentStateWithStructuredResponse`、
  `AgentStateWithStructuredResponsePydantic`、`HumanInterrupt`、
  `HumanInterruptConfig`、`ActionRequest`

⚠ **上面 `::: danger` 块里我先写的是「8 个导出里有 2 个带 @deprecated」**——
这是精确说法。有些读者会看到「prebuilt 大部分都弃用了」这类描述，
按 `__all__` 口径**那是不准的**：8 个里弃用 2 个，剩下 6 个
（`ToolNode`、`ToolCallTransformer`、`tools_condition`、`InjectedState`、`InjectedStore`、`ToolRuntime`）
**没有弃用标记，仍是正常 API**。

但**「被掏空」这个判断仍然成立，理由是那 2 个的分量**：
`create_react_agent` 是这个包的门面函数，也是整个 LangGraph 生态被引用最多的入口之一。
它的替换是跨仓的 `from langchain.agents import create_agent`。
配套的 5 个 `AgentState*` 类型、3 个 HITL 类型也全部指向 `langchain.agents`。

**剩下没弃用的那 6 个是什么？** 是工具执行的底层件——
`ToolNode`（把 LLM 的 tool_call 派发到注册的工具）、
`InjectedState`/`InjectedStore`/`ToolRuntime`（往工具参数里注入运行时的三种注解）、
`tools_condition`（路由函数）、`ToolCallTransformer`（流式投影器）。
**方向很清楚：高层 agent 组装搬去 langchain，低层工具派发留在 langgraph。**

### 10.4 升级时该怎么查

综合上面几节，本快照下的可操作建议（**这是从证据推出的操作，不是官方指引**）：

1. **先跑一遍开着 `DeprecationWarning` 的测试**。
   `python -W error::DeprecationWarning` 会把这 31 个点里被你碰到的那些变成硬错误。
2. **按类别分批处理**：`LangGraphDeprecatedSinceV05` 与 `V10` 都在 2.0 会消失，
   `V11` 还能拖到 3.0。
3. **跨仓那 9 个要一起改两个包的依赖**（§1.1），不能只升 langgraph。
4. **注意 `langgraph<1.3.0` 这个来自 langchain 的上界**（§3.2），
   它可能让你「想升 langgraph 却被 langchain 挡住」。

---

## 11. 流式输出：7 种 stream_mode 与 v3 投影层

### 11.1 7 种 stream_mode（`types.py:120` 实录）

```python
StreamMode = Literal[
    "values", "updates", "checkpoints", "tasks", "debug", "messages", "custom"
]
```

| 模式 | 发什么（docstring 原意） |
| --- | --- |
| `values` | 每步后发完整 state（含 interrupts）。函数式 API 下只在结束时发一次 |
| `updates` | 只发节点名 + 该节点返回的增量。同一步多个节点各发一条 |
| `custom` | 节点内用 `StreamWriter` 主动写的数据 |
| `messages` | LLM 消息**逐 token** + 元信息，发 2-tuple `(token, metadata)` |
| `checkpoints` | 每建一个 checkpoint 发一条，格式同 `get_state()` |
| `tasks` | 任务开始/结束事件，含结果与错误 |
| `debug` | **= `checkpoints` + `tasks`** |

⚠ **`debug` 不是第 7 种独立模式，它是前两种的合集**——
所以「支持 7 种流式模式」这句话严格说是 6 种语义 + 1 个组合别名。

`StreamWriter` 的类型是 `Callable[[Any], None]`，docstring 说明它
「总是会在节点请求它作为关键字参数时被注入，但不用 `stream_mode="custom"` 时是 no-op」——
**这个「注入但空转」的设计让节点代码不必知道调用方选了什么模式。**

### 11.2 v3：11 个 transformer 组成的投影层

`langgraph.stream` 的 `__all__` 有 **16 项**，是 `langgraph` 包里导出最多的子模块。
`stream/__init__.py` 的模块 docstring 说明了它的用法：

> Compile a graph with `transformers=[...]` and call `graph.stream_events(version="v3")` …
> to drive a transformer pipeline that projects the graph's raw events into ergonomic
> per-channel streams.

AST 顺继承链数 `StreamTransformer`（`stream/_types.py:44`，一个 ABC）的后代**11 个**：

| Transformer | 位置 |
| --- | --- |
| `ValuesTransformer` | `stream/transformers.py:28` |
| `CustomTransformer` | `:85` |
| `UpdatesTransformer` | `:120` |
| `MessagesTransformer` | `:155` |
| `_TasksLifecycleBase`（中间类） | `:373` |
| ├ `LifecycleTransformer` | `:608` |
| └ `SubgraphTransformer` | `:670` |
| `CheckpointsTransformer` | `:927` |
| `DebugTransformer` | `:966` |
| `TasksTransformer` | `:1002` |
| `ToolCallTransformer` | **`prebuilt/_tool_call_transformer.py:44`** |

**最后一个住在另一个包里**——`prebuilt` 提供了一个 transformer，
这是 `prebuilt` 里没被弃用的 6 个导出之一（§10.3）。
**这说明投影层是个真的扩展点**：不同包可以往里加投影器，用户也可以。

`transformers.py` 一个文件 1,039 行，是 `langgraph` 包第 6 大文件。
`stream/` 全目录含 `run_stream.py`（689 行）、`_mux.py`（523 行，多路复用）、
`stream_channel.py`（341 行）。

⚠ **v3 明确标了实验性**（§6.3），且 docstring 里还有一条自曝的限制
（`main.py:3669` 附近）：`stream_events(version="v3")` 的某些行为
「is not fully …」——原文提到 v1/v2 经由 `on_llm_end` 拿到的东西
在 v3 下要换路径。**这是从 v2 迁 v3 的一个已知不对等，官方自己写在 docstring 里了。**

---

## 12. 图组合：子图、Send、Command 与远端图

### 12.1 `types.py` 的 32 个导出

`langgraph/types.py`（984 行）的 `__all__` 是全仓单文件最多的 32 项。
按用途分组，这张表基本就是「写 LangGraph 代码会用到的类型」全集：

| 组 | 导出 |
| --- | --- |
| 控制流原语 | `Send`、`Command`、`interrupt`、`Interrupt`、`Overwrite` |
| 策略 | `RetryPolicy`、`TimeoutPolicy`、`CachePolicy`、`Durability` |
| 流式 | `StreamMode`、`StreamWriter`、`StreamPart` + 7 个具体 `*StreamPart` |
| 快照与任务 | `StateSnapshot`、`PregelTask`、`PregelExecutableTask`、`StateUpdate`、`GraphOutput` |
| 载荷 | `TaskPayload`、`TaskResultPayload`、`CheckpointTask`、`CheckpointPayload`、`DebugPayload` |
| 杂 | `All`（`Literal["*"]`）、`Checkpointer`、`ensure_valid_checkpointer` |

### 12.2 `Durability`：三档持久化时机

```python
Durability = Literal["sync", "async", "exit"]
```

| 值 | 语义（docstring 原文意） |
| --- | --- |
| `sync` | 下一步开始前**同步**落盘 |
| `async` | 下一步执行的**同时异步**落盘 |
| `exit` | **只在图退出时**落盘 |

**这是一个显式的「持久性 vs 速度」旋钮**，而且它取代了旧的布尔参数
`checkpoint_during`（V10 弃用，2 处，§10.2）——
**从布尔换成三档枚举，是因为「要不要每步落盘」这个问题的答案不是二元的。**

### 12.3 `Checkpointer` 类型：`None | bool | BaseCheckpointSaver`

```python
Checkpointer = None | bool | BaseCheckpointSaver
```

docstring 说明这是**给子图用的**三态语义：

- `True` → 这个子图启用持久化
- `False` → **即使父图有 checkpointer 也禁用**
- `None` → 继承父图的

**这个三态是子图组合的关键**：它让「父图要持久化但某个子图不要」变得可表达。
用单纯的 `BaseCheckpointSaver | None` 是表达不了「显式禁用」的。

### 12.4 `RemoteGraph`：让远端图冒充本地图

`pregel/remote.py`（1,308 行，`langgraph` 包第 5 大文件）里的
`RemoteGraph`（`:118`）直接实现 `PregelProtocol`——
**和本地的 `Pregel` 是平级的兄弟，不是包装器。**

```
PregelProtocol
├── Pregel        → 本地跑超步
└── RemoteGraph   → 走 HTTP 打到 LangGraph Server
```

**含义：** 一个子图可以是远端的，而父图不需要知道。
`add_node("sub", RemoteGraph(...))` 和 `add_node("sub", local_graph)` 在类型上等价，
因为二者都满足那 15 个 `@abstractmethod`（§6.2）。

**这也解释了 §3.4 那条「看起来方向反了」的依赖**：
`langgraph` → `langgraph-sdk` 是因为 `RemoteGraph` 要用 SDK 发请求。

配套文件 `pregel/_remote_run_stream.py`（374 行）处理远端流式。
仓库自带的威胁模型把这条路径列为 T4（§16.2）：
从远端 API 拿到的 dict 会被 splat 进 `Interrupt`/`Command` 对象而**没有入站校验**。

### 12.5 函数式 API：2 个装饰器

`langgraph.func` 的 `__all__` 只有 2 项：`task`、`entrypoint`。
`func/__init__.py` 620 行，其中 `entrypoint` 是个类（`:262`），`task` 是带 3 个 overload 的函数。

**两套 API 编译到同一个引擎**——这一点仓库的威胁模型文档说得最清楚
（`.github/THREAT_MODEL.md` 的架构图注释原文）：

> StateGraph builder API and functional API `@entrypoint`/`@task` both
> compile to the same Pregel execution engine

所以选哪套是风格问题，不是能力问题。**但弃用点不对等**：
`func/__init__.py` 里有 4 个弃用点（V05 两个 `retry`→`retry_policy` 与 `input`→`input_schema`，
V10 一个 `config_schema`→`context_schema`），说明这套 API 同样经历了 1.0 那次改名。

---

## 13. CLI：唯一的「产品面」

`langgraph-cli` 是 8 个包里唯一符合「产品」形态的——它有命令、有配置文件、有遥测。
本节按产品套路写。

### 13.1 14 个命令/命令组（AST 实查装饰器）

AST 扫全部 `@*.command()` / `@*.group()` 装饰器得 **14 个**，
其中 1 个是根 group、2 个是子 group，**实际可执行命令 11 个**：

| 命令 | 定义位置 | 说明 |
| --- | --- | --- |
| `langgraph`（根 group） | `cli.py:232` | `NestedHelpGroup` |
| `langgraph up` | `cli.py:278` | 🚀 起 API server（Docker） |
| `langgraph build` | `cli.py:419` | 📦 构建镜像 |
| `langgraph dockerfile` | `cli.py:550` | 🐳 生成 Dockerfile |
| `langgraph dev` | `cli.py:763` | 🏃 开发模式（热重载，用 `[inmem]` 那两个 Elastic 包） |
| `langgraph validate` | `cli.py:873` | ✅ 校验 `langgraph.json` |
| `langgraph new` | `cli.py:920` | 🌱 从模板建项目 |
| `langgraph deploy`（group） | `deploy.py:1558` | **[Beta]** 部署到 LangSmith Deployment |
| `langgraph deploy`（默认命令） | `deploy.py:1571` | 同上 |
| `langgraph deploy list` | `deploy.py:1783` | [Beta] 列部署 |
| `langgraph deploy revisions`（group） | `deploy.py:1809` | [Beta] 管修订 |
| `langgraph deploy revisions list` | `deploy.py:1830` | [Beta] |
| `langgraph deploy delete` | `deploy.py:1871` | [Beta] |
| `langgraph deploy logs` | `deploy.py:1962` | [Beta] 拉部署日志 |

**`deploy` 整个子树共 7 项，全部标 `[Beta]`，且全部指向 LangSmith Deployment**
（LangChain 的托管平台）。`deploy.py` 一个文件就有 ~2,000 行——
**CLI 里近一半的命令是给托管服务用的**，这是开源 CLI 与商业平台的接缝所在。

### 13.2 `langgraph.json`：88 个配置字段

AST 数 `langgraph_cli/schemas.py`（788 行）里所有 TypedDict 的注解字段，
**合计 88 个**，分布在 19 个 TypedDict 里。顶层 `Config` 有 **21** 个字段：

| 字段组 | 字段 |
| --- | --- |
| 运行时版本 | `python_version`、`node_version`、`api_version`、`_INTERNAL_docker_tag` |
| 镜像 | `base_image`、`image_distro`（`debian`/`wolfi`/`bookworm`）、`dockerfile_lines`、`keep_pkg_tools` |
| 依赖 | `pip_config_file`、`pip_installer`、`source`、`dependencies` |
| 图 | `graphs`、`env` |
| 子配置 | `store`、`checkpointer`、`auth`、`encryption`、`http`、`webhooks`、`ui` |

字段最多的子配置是 `HttpConfig`（**16** 个，其中 10 个是 `disable_*` 开关：
`disable_assistants`/`threads`/`runs`/`store`/`mcp`/`a2a`/`meta`/`ui`/`webhooks`），
其次 `CorsConfig`（7）、`WebhookUrlPolicy`（5）、`ThreadTTLConfig`（4）、`AuthConfig`（4）。

⚠ **`SerdeConfig` 那 3 个字段直接对应 §16.1 的安全开关**：
`allowed_json_modules`、`allowed_msgpack_modules`、`pickle_fallback`。
**也就是说反序列化的安全策略是可以从 `langgraph.json` 配的**——
这是 Server 部署下收紧默认值的正规入口。

### 13.3 遥测：默认开启，打到 Supabase

`langgraph_cli/analytics.py`（实查全文）：每个命令都套了 `@log_command` 装饰器，
它在后台线程 POST 到硬编码的 Supabase 端点：

```python
SUPABASE_URL = "https://kzrlppojinpcyyaipxnb.supabase.co"     # constants.py:6
# → f"{supabase_url}/rest/v1/logs"
```

上报字段（`LogData` TypedDict）：`os`、`os_version`、`python_version`、
`cli_version`、`cli_command`、`params`。

**关闭方式只有一个**：环境变量 `LANGGRAPH_CLI_NO_ANALYTICS=1`
（`analytics.py:89`，值必须**恰好等于 `"1"`**——`true`/`yes` 都不认）。

**参数做了匿名化处理**，这一点值得如实写清：`get_anonymized_params` 对
`config`、`port`、`postgres_uri`、`debugger_port` 这些**只上报「是否非默认」的布尔值**，
不报具体值；只有 `recreate`/`pull`/`watch`/`wait`/`verbose` 这几个布尔 flag 上报真值。
另有一个 `LANGGRAPH_CLI_ANALYTICS_SOURCE` 环境变量，在 `deploy` 命令下会把来源标记带上。

**三条要点破：**

1. **默认开启，opt-out 而非 opt-in。** 装了 CLI 跑任何命令就会有一次外发请求。
2. **失败静默**：`except urllib.error.URLError: pass`——离线环境不会报错，
   也不会有任何提示。
3. **匿名 key 硬编码在源码里**（`SUPABASE_PUBLIC_API_KEY`，一个 JWT 字面量）。
   这是 Supabase anon key 的常规用法，不是泄露；但它意味着**端点是公开可写的**，
   任何人都能往那张 `logs` 表灌数据。这对使用者无风险，对数据质量有影响——
   **这条是从代码推的，我们没有尝试写入验证。**

### 13.4 一处仓库自述与实现的错位

`langgraph_cli/config.py` 里 AST 只找到 3 个 NamedTuple（`_ParsedApiVersion`、
`_ApiVersionRange`、`LocalDeps`）——配置的 schema 全在 `schemas.py`。
而 `cli/schemas/` 目录下还有生成好的 `schema.json` 与 `schema.v0.json`
（两个版本并存，从 §16.1 那个安全提交的 diff 里可以看到它们是一起改的）。

**`langgraph validate` 校验的是 JSON schema**，所以配置字段的真实来源是
`schemas.py` 的 TypedDict → 生成 `schema.json` → CLI 读它校验。
这条链意味着**改了 TypedDict 不重新生成 schema.json 就会让校验与实现漂移**——
与本文所在项目自己的「改了源码要重新生成参考页」是同一类问题。

---

## 14. 开源与闭源的边界

### 14.1 边界在哪（三条证据）

本仓 8 个包全 MIT。边界外有两个 Elastic-2.0 包（§2.2）。
**判定「不在本仓」的三条证据，逐条列出以便复核：**

1. **仓库里没有对应目录**：`libs/` 下 9 个目录里没有 `api` 或 `runtime-inmem`。
2. **GitHub 搜索 `langgraph-api org:langchain-ai` 只返回 1 个仓库**，
   而且是 **`langchain-ai/langgraphjs-api`**（JS 侧的，37 star，2025-01-11 创建）
   ——Python 侧的 `langgraph-api` 没有公开仓库。
3. **PyPI 元信息里 `project_urls` 为空**（本仓 8 个包都有指向 GitHub 的 `Source` URL），
   `home_page` 也是 `None`。**它不告诉你源码在哪。**

⚠ **注意：sdist 是有的**（`langgraph_api-0.12.1.tar.gz`，759,839 字节）。
「闭源」在这里的准确含义是**没有公开的开发仓库、没有 issue 追踪、没有 commit 历史**，
不是「拿不到代码」。**我们没有下载并解包这个 sdist**，所以无法确认里面是完整源码还是编译产物。

### 14.2 仓库自己怎么划这条线

**最有力的证据来自本仓的威胁模型文档**（`.github/THREAT_MODEL.md`），
它的 "Out of Scope" 一节原文写着：

> - `libs/sdk-js` — Moved to external `langchain-ai/langgraphjs` repository; no source in this repo
> - `libs/checkpoint-conformance` — Conformance test suite only; not shipped code
> - **LangGraph Server / `langgraph-api` — Closed-source server runtime; not in this repo**

**「Closed-source server runtime」是官方文档的原话。** 这条不需要我们推断。

同一节还把 `langchain-core`（"Upstream dependency; separate threat model"）、
用户应用代码、LLM provider 行为、LangSmith 平台都划在外面。

### 14.3 这条边界对使用者意味着什么

| 你在做什么 | 碰到边界了吗 |
| --- | --- |
| `import langgraph`，进程内跑图 | **没有**。全 MIT，全可查 |
| 自己实现 checkpointer / store / cache | **没有**。扩展点全在 MIT 侧（§8、§9） |
| `langgraph dev` 本地起服务 | **碰到了**。装进环境的有两个 Elastic-2.0 包 |
| 用 `RemoteGraph` 连一个 Server | **碰到了**。协议在 MIT 侧（`langgraph-sdk`），服务端实现在闭源侧 |
| `langgraph deploy` 到 LangSmith | **碰到了**，且是商业平台（§13.1，全部 Beta） |

**关键结论：框架本体与 Server 运行时的分界，恰好是「进程内 vs 跨进程」这条线。**
只要你不需要一个长期运行的、多线程/多用户的 HTTP 服务，
你可以完全待在 MIT 侧——包括持久化（Postgres/SQLite checkpointer 都是 MIT）。

**这套「开源框架 + 闭源运行时 + 商业托管」的三层结构，代价是很实际的：**
Server 侧的行为无法审计、无法自己打补丁，且它的发版节奏（2026 年 225 个版本，§18.3）
远快于框架本体（37 个）——**你依赖的最不透明的那一层，也是变得最快的那一层。**

---

## 15. 跨语言：Python 与 JS 不是一份代码

### 15.1 `libs/sdk-js/` 是个空壳

实查：目录下**只有一个 432 字节的 `README.md`**，0 个 `.py`、0 个 `.ts`。
README 正文：

> This package has moved to [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs/tree/main/libs/sdk).

GitHub 语言统计交叉印证：`langchain-ai/langgraph` 是 **Python 99.6%**，
TypeScript 只占 **0.1%**（那 0.1% 是 `docs/_scripts/` 之类的辅助脚本，
不是 SDK）。**本仓已经没有 JS/TS 实现。**

而仓库的 `CLAUDE.md` / `AGENTS.md`（两者实测只差一行代码块语言标记）里
仍把 `sdk-js` 列为一个 library 并在依赖图里画上 `sdk-js (standalone)`——
**仓库给 AI 助手看的说明文档本身就带着这个过期条目。**

### 15.2 版本号完全不对齐（npm registry 实查）

| Python 包 | 版本 | JS 对应包 | 版本 | 差距 |
| --- | --- | --- | --- | --- |
| `langgraph` | **1.2.10** | `@langchain/langgraph` | **1.4.9** | JS 领先 2 个 minor |
| `langgraph-checkpoint` | **4.2.0** | `@langchain/langgraph-checkpoint` | **1.1.3** | **Python 领先 3 个 major** |
| `langgraph-checkpoint-postgres` | **3.1.2** | `@langchain/langgraph-checkpoint-postgres` | **1.0.4** | Python 领先 2 个 major |
| `langgraph-checkpoint-sqlite` | **3.1.1** | `@langchain/langgraph-checkpoint-sqlite` | **1.0.3** | Python 领先 2 个 major |
| `langgraph-sdk` | **0.4.2** | `@langchain/langgraph-sdk` | **1.9.28** | **JS 领先，且已过 1.0** |
| `langgraph-cli` | **0.4.31** | `@langchain/langgraph-cli` | **1.4.4** | JS 领先，且已过 1.0 |

**方向还不一致**：核心包与 SDK 是 JS 领先，checkpoint 系是 Python 领先 2–3 个 major。

**所以「LangGraph 1.x」这个说法在跨语言语境下彻底失效。**
如果你在写跨语言的技术选型文档，**必须逐包逐语言标版本号，没有捷径。**

npm 侧的发布数据（registry 实查）：

| npm 包 | 累计版本数 | 首发 | 最后发布 |
| --- | --- | --- | --- |
| `@langchain/langgraph` | **234** | 2024-01-18 | 2026-08-03 |
| `@langchain/langgraph-sdk` | **211** | 2024-05-22 | 2026-07-21 |
| `@langchain/langgraph-cli` | 117 | 2025-01-16 | 2026-08-03 |
| `@langchain/langgraph-checkpoint` | 32 | 2024-08-22 | 2026-06-25 |
| `@langchain/langgraph-checkpoint-postgres` | 13 | 2024-10-08 | 2026-06-25 |
| `@langchain/langgraph-checkpoint-sqlite` | 13 | 2024-08-22 | 2026-06-10 |

### 15.3 依赖形态也不同：JS 用 peerDependencies

一处实质差异：**JS 侧把 `@langchain/core` 放在 `peerDependencies`**，
Python 侧是普通 `dependencies`。

```
@langchain/langgraph 1.4.9
  dependencies:      @langchain/protocol ^0.0.18, @langchain/langgraph-sdk ~1.9.28,
                     @langchain/langgraph-checkpoint ^1.1.3
  peerDependencies:  zod ^3.25.32 || ^4.2.0, @langchain/core ^1.1.48
```

**含义：JS 用户必须自己装 `@langchain/core` 和 `zod`**，版本冲突由包管理器报给用户；
Python 用户由 pip 自动解出 `langchain-core`。这不是谁更好，是两个生态的惯例差异——
但它意味着**两边的「升级会不会炸」的失败模式不一样**。

另一处：`@langchain/langgraph-sdk` 的 peer 里有
`react ^18 || ^19`、`react-dom`、`svelte ^4 || ^5`、`vue ^3`——
**JS SDK 带前端框架绑定**，Python SDK 没有对应物。这是 JS 侧独有的能力面。

`@langchain/protocol`（`^0.0.18`）与 Python 的 `langchain-protocol`（0.0.18）**版本一致**——
这是全表唯一对齐的一处，也印证了 §2.2 说的「它是跨语言公共协议层」。

---

## 16. 安全：8 条已公开公告与一份自带威胁模型

### 16.1 反序列化：默认宽松，收紧要靠环境变量

**这是本框架最需要部署者知情的一件事。** `checkpoint/serde/_msgpack.py` 的模块 docstring
自己写得毫不含糊（原文）：

> Set `LANGGRAPH_STRICT_MSGPACK=true` to restrict checkpoint deserialization
> to the types listed in `SAFE_MSGPACK_TYPES`. **Without this, any Python
> callable stored in checkpoint data will be imported and executed on load.**

默认值实查（`_msgpack.py:12`）：

```python
STRICT_MSGPACK_ENABLED = os.getenv("LANGGRAPH_STRICT_MSGPACK", "false").lower() in (
    "1", "true", "yes",
)
```

**默认 `"false"`。** `JsonPlusSerializer.__init__` 里的分支（`jsonplus.py:107`）
把这个默认翻译成 `allowed_msgpack_modules = True`，注释原文：
`# Permissive (default): all types allowed with a warning.`

`JsonPlusSerializer` 的类 docstring 也带了 `!!! warning` 块，明说
「should not be used on untrusted python objects. If an attacker can write directly
to your checkpoint database, they may be able to trigger code execution」。

**允许列表规模（AST 实查）**：`SAFE_MSGPACK_TYPES` **49 条**，
`SAFE_MSGPACK_METHODS` **1 条**（只允许 `datetime.datetime.fromisoformat`）。
49 条按顶层模块分布：`langchain_core` 16、`langgraph` 9、`ipaddress` 6、`pathlib` 6、
`datetime` 5、`builtins` 2、`collections`/`decimal`/`re`/`uuid`/`zoneinfo` 各 1。

**这个数字在增长（git 逐提交实查）：**

| 日期 | commit | `SAFE_MSGPACK_TYPES` 条数 |
| --- | --- | --- |
| 2026-02-26 | `50df7d423`（"Merge commit from fork"） | **32**（文件首次出现） |
| 2026-04-15 | `7fa49bd55`（"docs: document LANGGRAPH_STRICT_MSGPACK…"） | 48 |
| 2026-04-29 | `a48a04559` | **49** |

⚠ **`50df7d423` 那个提交名 "Merge commit from fork" 是 GitHub 处理安全公告私有修复分支时的默认标题**，
提交者是 Eugene Yurtsev。它一次改了 26 个文件，新增
`test_encrypted.py`（437 行）、`test_jsonplus.py`（+366 行）、
`_internal/_serde.py`（253 行）、`test_serde_allowlist.py`（159 行）。
**时间（2026-02-26）与 CVE-2026-28277（公告发布 2026-03-05）吻合**——
这是「安全修复先私有合并、再公开公告」的标准流程，
**但两者的关联是我们从时间与内容推断的，公告页面本身我们没有逐字核验其 commit 引用。**

**权衡要说清**：默认宽松显然不是疏忽——它是为了让**已有的 checkpoint 能继续读出来**。
一个 agent 的 state 里可能存着任意用户自定义的 Pydantic 模型、dataclass、
自定义消息类型，允许列表默认只有 49 条的话，绝大多数真实应用一升级就读不出旧数据。
**代价就是：安全默认值让位给了兼容性，而把风险转移给了「你有没有读到那行文档」。**
生产部署应当显式设 `LANGGRAPH_STRICT_MSGPACK=true` 或从 `langgraph.json` 的
`SerdeConfig` 配允许列表（§13.2），并接受随之而来的迁移成本。

### 16.2 自带威胁模型：479 行，11 条威胁

`.github/THREAT_MODEL.md`（2026-03-31 移入 `.github/`，commit `13528ef3a`）
是一份 479 行的结构化威胁模型，**这在一个开源框架仓库里是不常见的**。
章节结构：Scope / Assumptions / System Overview（含 ASCII 架构图）/ Components /
Data Classification / Trust Boundaries / Data Flows / **Threats** /
Input Source Coverage / Out-of-Scope Threats / Investigated and Dismissed / Revision History。

它自己标注了 **"automatically generated"** 和一段 disclaimer：
「It is experimental, subject to change, and not an authoritative security reference —
findings should be validated before acting on them.」

11 条威胁（T1–T11）按严重度：**High 3 条、Medium 5 条、Low 2 条、Info 1 条**。
High 的三条全在反序列化：

| ID | 威胁 | 严重度 | 文档标注的验证状态 |
| --- | --- | --- | --- |
| **T1** | strict 模式关闭（**默认**）时 msgpack 反序列化导致任意代码执行 | High | Verified |
| **T2** | `pickle_fallback=True` 时经 `pickle.loads` 任意代码执行 | High | Verified |
| **T3** | `allowed_json_modules=True` 时经 JSON `lc:2` 构造器任意模块导入 | High | Verified |
| T4 | 远端 API 响应未校验就 splat 进 `Interrupt`/`Command` | Medium | Likely |
| T9 | SDK 跟随服务端控制的 `Location` 重定向导致 API key 泄露 | Medium | Verified |
| T10 | `EncryptedSerializer` 静默接受**未加密**数据，可绕过加密 | Medium | Verified |
| T11 | checkpoint 无界保留含 PII 的会话历史 | Medium | — |
| T5 | `langgraph.json` 值里的单引号导致 Dockerfile ENV 注入 | Low | Likely |
| T6 | `langgraph new` 模板解压的 ZIP slip | Low | **Unverified** |
| T8 | `EncryptedSerializer` 用 `assert` 检查 cipher 名（`python -O` 会剥掉） | Low | Verified |
| T7 | AES key 熵受限于环境变量的可打印字符编码 | Info | — |

**T1 把「默认配置」直接写进了威胁标题**（原文：`when strict mode is OFF (default)`）
——官方文档承认默认配置下存在 High 威胁。这种自曝程度值得记下。

⚠ **这份文档自己就有一处漂移，可以当作「生成式文档的可靠性」样本**：
它的头部写 `Commit: 0ba22143`，而 `git cat-file -t 0ba22143` 在本仓
返回 **`Not a valid object name`**——**这个 commit 不在本仓历史里**
（可能来自私有分支或已被 rebase 掉）。
它的 Input Source Coverage 一节还写 `SAFE_MSGPACK_TYPES` — **47 entries**，
而实查该文档声明的生成日期（2026-03-28）时 main 上是 **48 条**，当前 HEAD 是 **49 条**。
**三个数都不一致。** 这不影响它作为「trust boundary 在哪」的参考价值，
但它确实印证了自己 disclaimer 里那句 "may be incomplete or contain inaccuracies"。

### 16.3 8 条已公开安全公告（GitHub Advisories API 实查）

| 公告 | CVE | 严重度 | 公开日期 | 受影响包与范围 | 类型 |
| --- | --- | --- | --- | --- | --- |
| GHSA-7p73-8jqx-23r8 | CVE-2025-64104 | **High** (7.3) | 2025-10-29 | `langgraph-checkpoint-sqlite` ≤2.0.10 | SQL 注入（CWE-89），`SqliteStore` filter key |
| GHSA-wwqv-p2pp-99h5 | CVE-2025-64439 | **High** (7.4) | 2025-11-05 | `langgraph-checkpoint` <3.0 | **RCE**（CWE-502），`JsonPlusSerializer` 的 "json" 模式 |
| GHSA-9rwj-6rc7-p77c | CVE-2025-67644 | **High** (7.3) | 2025-12-09 | `langgraph-checkpoint-sqlite` <3.0.1 | SQL 注入（CWE-89），`list()` 的 metadata filter key |
| GHSA-mhr3-j7m5-c7c9 | CVE-2026-27794 | Medium (6.6) | 2026-02-23 | `langgraph-checkpoint` <4.0.0 | **RCE**（CWE-502），`BaseCache` 反序列化。标注 **ZDI-CAN-28385** |
| GHSA-g48c-2wqr-h844 | CVE-2026-28277 | Medium (6.8) | 2026-03-05 | `langgraph` ≤1.0.9 | msgpack 反序列化（§16.1） |
| GHSA-fjqc-hq36-qh5p | CVE-2026-48775 | Medium (6.8) | 2026-05-22 | `langgraph-checkpoint` ≤4.1.0 | JSON 反序列化（CWE-502 + CWE-913） |
| GHSA-w39p-vh2g-g8g5 | CVE-2026-48776 | Medium (4.2) | 2026-05-22 | `langgraph-sdk` ≤0.3.14 | URL 路径构造（CWE-22 + CWE-863） |
| GHSA-47pj-3jcm-6whg | CVE-2026-71433 | Medium (5.3) | 2026-07-30 | `langgraph-checkpoint-postgres` **和** `-sqlite` <3.1.1 | 命名空间前缀匹配跨段（CWE-200 + CWE-863） |

**几条观察，尽量只摆事实：**

1. **8 条里 7 条在持久化层**（checkpoint 及其两个后端），**只有 1 条在 SDK**，
   **0 条在核心执行引擎**（`langgraph` 包只中了 1 条，而那条也是反序列化）。
   **风险集中在「数据出入进程边界」的地方**，符合直觉，但用数据说出来更有说服力。
2. **5 条是反序列化或注入类**（CWE-502 ×3、CWE-89 ×2）。
   反序列化那 3 条对应 3 个不同的入口：msgpack、JSON `lc:2`、`BaseCache`
   ——**同一类问题被分三次修，说明这个面的攻击入口不止一个。**
3. **CVE-2026-27794 带 `ZDI-CAN-28385` 编号**，说明它来自 Zero Day Initiative
   的漏洞收购/披露流程，是外部安全研究者提交的，不是内部发现。
4. **最后一条（CVE-2026-71433）同时影响两个后端**——
   「命名空间前缀匹配跨越 segment 边界」意味着 `store` 的命名空间隔离
   在两个 SQL 后端上都实现错了同一处。**这类跨后端同源 bug 正是 §9 那个
   conformance 套件想防的**（虽然这条本身是 store 而非 checkpointer）。
5. **公告的 `first_patched_version` 字段全部为 `null`**——
   API 没给出修复版本，只给了受影响范围。**所以「升到哪个版本才安全」
   要靠受影响上界推断**（如 `<3.1.1` → 3.1.1 起修好），
   这个推断我们没有逐条向官方公告页交叉核验。

### 16.4 一个可操作的最小加固清单

从上面几节直接推出（**这是我们的整理，不是官方 checklist**）：

| 措施 | 怎么做 | 对应威胁 |
| --- | --- | --- |
| 收紧 msgpack | `LANGGRAPH_STRICT_MSGPACK=true`，或配 `allowed_msgpack_modules` | T1 |
| 不开 pickle | 保持 `pickle_fallback=False`（**默认已是**） | T2 |
| 不开 JSON 全放行 | 不传 `allowed_json_modules=True` | T3 |
| 升级持久化包 | checkpoint ≥4.2.0、postgres ≥3.1.2、sqlite ≥3.1.1 | §16.3 那 7 条 |
| 升级 SDK | `langgraph-sdk` ≥0.4.x（受影响是 ≤0.3.14） | CVE-2026-48776 |
| checkpoint 库当敏感资产管 | 数据库访问控制 + TTL/prune 策略 | T11 |
| 关 CLI 遥测（如需） | `LANGGRAPH_CLI_NO_ANALYTICS=1` | §13.3（非安全威胁，隐私项） |

⚠ **`pickle_fallback` 的默认值我们实查确认是 `False`**（`jsonplus.py:100`），
所以 T2 只在显式开启时成立——威胁模型把它列为 High 是因为后果严重，不是因为默认危险。

---

## 17. 文档搬迁：`docs/` 已是空壳

### 17.1 一次提交删掉 681 个文件

git 实查 commit **`b4630d845`**（**2026-01-09**，标题 `chore: delete docs (#6488)`）：

| 项 | 数字 |
| --- | --- |
| 改动文件数 | **681** |
| 删除行数合计 | **122,269** |
| 顺带删掉的 CI workflow | `codespell.yml`、`link_check.yml`（都是给文档用的） |

现在 `docs/` 下**只剩 4 个文件**：

| 文件 | 内容 |
| --- | --- |
| `redirects.json` | **294 条**路径 → URL 映射 |
| `generate_redirects.py` | 把上面那份 JSON 生成成一堆 meta-refresh HTML |
| `llms.txt` | **35 行**，第 3 行就是 "LangGraph documentation has moved to docs.langchain.com." |
| `.gitignore` | — |

`.md` / `.mdx` 文件数：**0**。

**`generate_redirects.py` 的实现细节值得一提**：它生成的是
`<meta http-equiv="refresh" content="0; url=...">` 的静态 HTML，
脚本自己的 docstring 解释了理由——「SEO-friendly and treated similarly to 301 redirects by Google」。
还配了一个兜底 `DEFAULT_REDIRECT = "https://docs.langchain.com/oss/python/langgraph/overview"`。
配套的 CI workflow 是 `deploy-redirects.yml`。

### 17.2 294 条重定向的去向分布

对 `redirects.json` 脚本统计：

**源路径首段分布**（老 URL 结构的化石）：

| 首段 | 条数 |
| --- | --- |
| `how-tos/` | **84** |
| `cloud/` | **67** |
| `concepts/` | 44 |
| `tutorials/` | 44 |
| `reference/` | 20 |
| `agents/` | 15 |
| `troubleshooting/` | 9 |
| 其余（`examples`/`guides`/`prebuilt`/`adopters`…） | 11 |

**目标域名分布**：

| 目标 | 条数 |
| --- | --- |
| `docs.langchain.com` | **272** |
| `reference.langchain.com` | **22** |

**目标路径段**：`oss/python/*` **171** 条、`langsmith/*` **100** 条。
含 `/python/` 的 192 条，含 `/javascript/` 的**只有 1 条**。

**三条能从这张表读出来的事：**

1. **文档拆成了两个站**：概念/教程去 `docs.langchain.com`，
   API 参考去 `reference.langchain.com`。引用时要分清。
2. **`cloud/` 那 67 条几乎全部指向 `langsmith/*`**（100 条 langsmith 目标里的大部分）
   ——**原来 LangGraph 文档里的「Cloud」章节，现在是 LangSmith 产品文档的一部分。**
   这是 §14 那条开源/商业边界在文档层的投影。
3. **`/javascript/` 只有 1 条**，印证 §15：本仓的重定向表基本只管 Python。

`redirects.json` 最后一次更新是 **2026-02-18**（commit `c4f586116`），
再往前还有 `d298b489b`（"fix: rollback doc redirects"）与
`57a877279`（"Revert the revert…"）这样的来回——**重定向表本身经历过反复。**

### 17.3 对研究者的实际影响

**这是「框架研究不能照产品套路做」的一个干净样本**（也是本文调研的第一个障碍）：

| 产品研究的常规做法 | 在本仓的结果 |
| --- | --- |
| `curl` 仓库里的 `.mdx` 源文件 | ❌ 0 个 md/mdx |
| 读 `docs/` 目录结构猜章节 | ❌ 只有一份重定向表 |
| 从 CHANGELOG 拿版本里程碑 | ⚠ 本仓根目录**没有 CHANGELOG.md**，只有 `libs/sdk-py/CHANGELOG.md` 一个 |
| 从 GitHub Releases 拿时间线 | ✅ 可行（§18） |
| 从 PyPI / npm registry 拿版本 | ✅ 可行，且是本文主要数据源 |
| 读源码 + AST 计数 | ✅ 可行，且是唯一可靠的 API 面来源 |

**所以本文的证据结构是被迫的，也是这类框架的通例**：
文档已经不在被研究的仓库里，而在一个独立的、单独维护的文档仓库
（`langchain-ai/docs`，MDX 92.9%，2025-05-15 创建，896MB）。
**「先去仓库找 docs/」这个习惯在 2026 年的 LangChain 生态里已经不成立。**

⚠ **本文没有抓取 `langchain-ai/docs` 的内容。** 那是一个 896MB 的仓库，
且它是三个产品（LangChain / LangGraph / LangSmith）的合并文档站——
把它纳进来会让「哪句话在讲哪个版本的哪个包」这个问题变得无法收敛。
**这是刻意的取舍：本文的事实层全部来自代码与发布物元信息，不来自文档叙述。**
代价是本文对「官方推荐怎么用」这类问题回答不了，只能回答「代码里是什么」。

---

## 18. 版本里程碑与发版节奏

**本节是带日期的事实层，不冒充分析。** 数据源：PyPI JSON API 与 GitHub Releases API，
2026-08-09 抓取后落盘统计。

### 18.1 `langgraph` 主线里程碑（每个 minor 首次出现的日期）

| 版本 | 首次发布 | 备注 |
| --- | --- | --- |
| **0.0.8** | 2024-01-08 | PyPI 上最早的发布（仓库首个 commit 是 2023-08-09） |
| 0.1.1 | 2024-06-22 | |
| 0.2.0 | 2024-08-07 | `RetryPolicy` 在 0.2.24 加入（源码 `version-added` 标注） |
| 0.3.0 | 2025-02-26 | |
| 0.4.0 | 2025-04-29 | |
| **0.5.0rc0** | 2025-06-16 | 这一版删了 `Context` 通道与 `SharedValue`（§7.3） |
| 0.6.0a1 | 2025-07-22 | `context` 参数在 0.6.0 加入 |
| **1.0.0a1** | 2025-08-27 | 1.0 预发布启动；正式 1.0 那批弃用有 23 个点（§10.2） |
| **1.1.0** | 2026-03-10 | |
| 1.2.0a1 | 2026-04-29 | |
| **1.2.10** | 2026-07-28 | **本快照的版本** |

累计 **275 个发布**。

### 18.2 同族包的 major 跃迁

| 包 | 里程碑 |
| --- | --- |
| `langgraph-checkpoint` | 1.0.0 (2024-08-02) → 2.0.0 (2024-10-01) → **3.0.0 (2025-10-20)** → **4.0.0 (2026-01-12)** → 4.2.0 (2026-08-07) |
| `langgraph-prebuilt` | 0.1.0 (2025-02-27) → 0.2.0 (2025-05-22) → 0.5.0rc0 (2025-06-17) → 0.7.0a1 (2025-08-27) → **1.0.0 (2025-10-17)** → 1.1.0a1 (2026-05-01) |
| `langgraph-sdk` | 0.1.0 (2024-05-02) → 0.2.0 (2025-07-22) → 0.3.0 (2025-12-12) → **0.4.0 (2026-05-28)** |
| `langgraph-cli` | 0.1.0 (2024-05-02) → 0.2.1 (2025-04-10) → 0.3.1 (2025-06-09) → **0.4.0 (2025-08-26)** |

⚠ **`checkpoint` 的 3.0.0 与 4.0.0 值得对照 §16.3 看**：
CVE-2025-64439（RCE，影响 `<3.0`）公开于 2025-11-05，而 3.0.0 发布于 2025-10-20；
CVE-2026-27794（RCE，影响 `<4.0.0`）公开于 2026-02-23，而 4.0.0 发布于 2026-01-12。
**两次 major 跃迁都在对应公告公开前 2–6 周完成**——
这与「先修复发版、再公开公告」的标准流程一致，**但因果关系是推断，不是核验过的事实。**
另外 `prebuilt` 与 `langgraph` 的 0.5 / 0.6 / 1.0 节奏基本同步（相差 1–3 天），
说明这两个包是协同发版的（与 §3.2 那个窄区间约束互相印证）。

### 18.3 发版节奏：框架 vs 闭源运行时

2026 年 1 月至本快照（8 月 9 日）的发布数：

| 包 | 2026 年发布数 | 最近 6 个有发布的月份 |
| --- | --- | --- |
| **`langgraph-api`**（闭源） | **225** | 03:34 04:15 05:10 06:35 07:39 08:11 |
| `langgraph` | **37** | 02:4 03:5 04:10 05:8 06:5 07:3 |
| `langgraph-cli` | 19 | 01:1 03:6 04:5 05:3 06:3 07:1 |
| `langgraph-sdk` | 17 | 01:2 02:6 03:3 04:1 05:3 06:2 |
| `langgraph-checkpoint` | 14 | 11:1 01:1 02:4 04:4 05:4 08:1 |
| `langgraph-prebuilt` | 11 | 10:5 11:3 01:2 02:1 04:5 05:3 |

**`langgraph-api` 一个包的发布数超过其余 5 个之和（98）的两倍。**
7 月一个月 39 个版本（约每 0.8 天一个）。它同时还有 `0.13.0rc3` 这样的预发布链
（本快照日 2026-08-08 还在发 rc）。

**这个对比说明的事**：框架本体的发版是「特性 + 修复」节奏（月均 4–5 个），
Server 运行时是「持续交付」节奏。**如果你自建部署，你要么锁死一个 api 版本
（放弃修复），要么跟一条几乎每天变的线（而它不开源，你看不到变了什么）。**

### 18.4 GitHub Releases 的 tag 命名

Releases API 实查（最近 100 条）显示 tag 命名不统一，**这会坑掉自动化脚本**：

```
1.2.10                        ← langgraph 本体：裸版本号
cli==0.4.31                   ← 其他包：pkg==version
checkpoint==4.2.0
checkpointpostgres==3.1.2     ← 注意：没有连字符！
checkpointsqlite==3.1.1
```

**`checkpointpostgres` 而不是 `checkpoint-postgres`**——
包名是 `langgraph-checkpoint-postgres`，tag 里既去掉了 `langgraph-` 前缀又去掉了中间的连字符。
按包名拼 tag 去拉 release notes 会 404。

---

## 19. 附录：本文数字的口径速查

**这一节的存在是因为本文几乎每个数字都有多个合理口径。** 引用时请连口径一起引。

| 结论 | 数字 | 口径 | 命令/方法 |
| --- | --- | --- | --- |
| 本仓包数 | **8** | 有 `pyproject.toml` 的 `libs/` 子目录 | 逐目录检查文件存在性（`libs/` 目录数是 9，含 `sdk-js` 空壳） |
| 公共 API 面 | **81** | 6 个发行包 `__init__.py` 的 `__all__` 加总 | AST；**不含根下 7 个平铺模块的 76 项**（§5.1 列了另外 4 个口径：39 / 159 / 130 / 202+210） |
| 抽象基类 | **5** | 继承 `ABC` 的类，排除 tests | AST 与正则口径一致 |
| `Pregel` 公共方法 | **34** | 去重方法名（**定义数 48**，差额是 `@overload`） | AST |
| `PregelProtocol` 抽象方法 | **15** | 去重（**定义数 23**） | AST |
| `StateGraph` 公共方法 | **10** | 去重（**定义数 14**，`add_node` 有 5 个 overload） | AST |
| 内置通道 | **10** | `BaseChannel` 后代，不含基类本身 | AST 顺继承链 |
| `BaseCheckpointSaver` 待实现方法 | **16** | 只 `raise NotImplementedError` 的方法（**`@abstractmethod` 是 0 个**） | AST 检查函数体 |
| checkpointer 实现类 | **8** | `BaseCheckpointSaver` 全部后代（含 1 个中间类 `BasePostgresSaver`） | AST 顺继承链；**后端数是 3**（memory/sqlite/postgres） |
| conformance 测试 | **89** | `spec/test_*.py` 里的 `def test_`（含包自测则 91） | 逐文件 `grep -c` |
| conformance 能力 | **5 + 4** | `BASE_CAPABILITIES` / `EXTENDED_CAPABILITIES` frozenset 大小 | 读 `capabilities.py` |
| stream transformer | **11** | `StreamTransformer` 后代（含 1 个中间类、1 个在 `prebuilt` 包） | AST 顺继承链 |
| stream_mode | **7** | `StreamMode` Literal 的成员数（**其中 `debug` 是另两种的合集**） | 读 `types.py:120` |
| 弃用点 | **31** | 带 `LangGraphDeprecatedSince*` 的 `warn()`/`@deprecated` 调用点 | AST；`@deprecated` 装饰器单独数是 **14**，文件数是 **7** |
| `prebuilt` 弃用比例 | **8 个导出里 2 个** | `__all__` ∩ 带 `@deprecated` 的符号 | AST；另有 **7** 个已弃用符号不在 `__all__` 里 |
| CLI 命令 | **11** | `@*.command()` 装饰器（**含 group 共 14 个**，其中 3 个是 group） | AST |
| `langgraph.json` 字段 | **88** | `schemas.py` 全部 TypedDict 的注解字段加总（顶层 `Config` 是 **21**） | AST |
| `SAFE_MSGPACK_TYPES` | **49** | frozenset 元素数（**仓库威胁模型写 47，2026-03-28 时是 48**） | AST literal_eval |
| 生产代码行数 | **80,593** | 排除 `*/tests/*` 与 `*/bench/*` 的 `.py` 行数 | 全仓含测试是 **185,659** |
| 测试函数 | **2,618** | AST 数 `test_` 前缀函数（`grep -rho` 得 2,619，差 1 个字面量） | AST |
| 安全公告 | **8** | `/security-advisories` 端点返回条数 | GitHub API |
| 重定向 | **294** | `docs/redirects.json` 的键数 | `json.load` + `len` |

### 19.1 我们没有验证的部分

按框架研究的纪律，逐条列出**本文中证据强度较弱或未核验的地方**：

1. **没有跑过任何代码。** 本文所有 API 面结论来自静态 AST 分析，
   没有实际 `pip install` 并 import 验证。**运行时行为（如命名空间包在真实环境下的解析）未实测。**
2. **没有下载 `langgraph-api` 的 sdist。** §14.1 那条「闭源」的判定基于
   「无公开仓库 + PyPI 无 Source URL + 官方威胁模型自述」，**没有解包检查内容**。
3. **没有抓取 `langchain-ai/docs` 的文档内容**（§17.3 说明了理由）。
   所以本文回答不了「官方推荐的用法是什么」，只回答「代码里是什么」。
4. **安全公告的修复版本是推断的**，因为 API 的 `first_patched_version` 全为 `null`（§16.3）。
   我们也没有逐条打开公告页面核验其正文与 commit 引用。
5. **§16.1 那个 "Merge commit from fork" 与 CVE-2026-28277 的关联是时间+内容推断**，
   不是官方确认的对应关系。
6. **§8.4 那句「放恢复脚本通常意味着遇到过问题」是推测**，已就地标注。
   能确证的只有脚本存在与其 commit 标题的自述用途。
7. **没有任何性能数字。** 既没自己跑基准，也没转述任何厂商基准。
   仓库里有 `bench/` 目录与 `bench.yml`/`baseline.yml` 两个 CI workflow，
   **我们没有运行它们，也没有读取其历史结果。**
8. **JS 侧只查了 npm registry 元信息**，没有克隆 `langgraph-api` 或 `langgraphjs` 读源码。
   §15 的所有结论都是包元信息层面的，**不涉及两边实现语义是否一致**——
   而版本号差 2–3 个 major 这件事强烈暗示语义已经分叉，**但那需要另一篇文章去核验。**

### 19.2 这份快照会怎么过期

按 §18.3 的节奏推算，**下面这些数字在几周内就会变**：
所有版本号、发布计数、Star/issue 数、`SAFE_MSGPACK_TYPES` 条数、安全公告条数。

**而下面这些结构性结论预计更稳**（它们是设计选择，不是状态）：
命名空间包共享一个 `langgraph.` 前缀（§2.3）、
`BaseCheckpointSaver` 用 `NotImplementedError` 桩而非 ABC 并把强制契约放进 conformance（§8.1、§9）、
`RemoteGraph` 与 `Pregel` 平级实现同一 protocol（§12.4）、
BSP 三阶段超步模型（§6.1）、
开源框架与闭源运行时的边界落在「进程内 vs 跨进程」这条线上（§14.3）。

**如果你在本文日期之后读到它**，最省事的复核路径是这三条：
① `pip index versions langgraph` 看主线走到哪了；
② `curl -s https://api.github.com/repos/langchain-ai/langgraph/security-advisories | jq length` 看公告涨了几条；
③ 把 §19 那张表里的命令重跑一遍——**它们都是可复现的，这正是那张表存在的理由。**

::: tip 这份快照的定位
2026-08-09 的 LangGraph 是这样：8 个 MIT 包 + 2 个 Elastic-2.0 闭源运行时包，
`langgraph` 1.2.10 顶在 langchain 钉的 `<1.3.0` 上，
最出名的入口 `create_react_agent` 已经弃用并搬去了另一个仓库，
文档三个月前就搬走了只剩 294 条重定向，
持久化层背着 7 条已公开公告而反序列化仍默认宽松，
而它同时把 checkpoint 契约的强制部分从类型系统挪进了一个可执行的 conformance 套件。

**这些事实里没有一条是"好"或"坏"——它们是一个正在快速重构的框架在某一天的截面。**
过期之后它不会变成假话，只会变成史料。
:::
