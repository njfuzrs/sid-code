---
title: promptfoo 深入研究（2026-08 快照）
description: 22 章逐节成册，按目录跳章查阅——把 promptfoo 的产品形态、架构与实现细节交叉核验到版本号级别：66 类断言、155 个红队插件（其中 117 个需托管推理）、37 种攻击策略、89 个 provider 前缀、9 种配置文件扩展名、14 个 MCP 工具、31 个模型扫描器。这是一份手册，不是读完就走的文章。
date: "2026-08-09"
series: 深入研究
audience: engineer
highlight: 22 章逐节可查 · 核验至 v0.122.0 / HEAD 49c0f6d7 · 截至 2026-08-09 快照
tags: [promptfoo, LLM 评估, 红队, 深入研究, 断言, 参考]
outline: [2, 3]
---

# promptfoo 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-09
- **被调研版本**：
  - npm `promptfoo` **latest = 0.122.0**（2026-08-04 发布）
  - 源码核验至本地 clone 的 `main`，**HEAD = commit `49c0f6d7`（2026-08-08）**，
    仓库内 `package.json` 版本号同为 `0.122.0`
- **证据形态**：**本地源码实查 + 仓库内文档源文件 + GitHub REST API / npm registry 实查**。
  代码结构类断言直接来自本地 clone，凡属源码结论本文都给出 `路径:行号`；
  文档类事实取自仓库内 `site/docs/**/*.md` **源文件**，不是渲染后的网页。
  因此文中有几处是「官方文档这么写，源码实际这样」的对照（§5.4、§16.2）。
  **行为类断言以源码与文档为据——我们没有把它跑起来做端到端实测**，
  唯一例外是 §6 与 §7 的计数：那是用 `bun` 直接 import 源码里的常量数组、
  在运行时求值数出来的，命令在文中给了。
- **一手性说明**：计数类事实全部由脚本数出，不是目测——常量数组走 `bun` 运行时求值，
  文档表格走 `re.findall`。Star 数 / 语言占比 / 版本时间线取自 GitHub REST API
  与 npm registry 实查（原始 JSON 落盘到 `/tmp/pf/` 后只打印摘要，从不整份进上下文）。
- **一条证据边界**：本地 clone **不是 shallow**（`git rev-parse --is-shallow-repository`
  返回 `false`，9332 个提交完整），所以本文的「何时引入」类断言**可以**用 git 历史佐证，
  且都与 `CHANGELOG.md` 交叉核对过（§22）。
- **时效边界**：**这是 2026-08-09 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://www.promptfoo.dev/docs/intro/)为准。
  尤其注意：**红队插件清单与托管推理边界是本文最容易过期的一层**（§7 说明了原因）。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 三条广为流传但需要修正的说法
读 promptfoo 的第三方介绍时，这三条几乎必然会遇到：

1. **「promptfoo 100% 本地运行，你的 prompt 不出本机」**——
   这句话**在 eval 场景成立，在红队场景不成立**，而且差距很大。
   它是官方 README 的原话（`README.md:77`：*"Private: LLM evals run 100% locally"*），
   注意主语限定在 **evals**。红队侧的实测数字是：
   **155 个插件里 117 个（75.5%）在没有 promptfoo 托管推理时会被前端禁用**，
   其中 **91 个在代码里根本没有本地实现**（`REMOTE_ONLY_PLUGIN_IDS`），
   连默认插件集 39 个里也有 29 个需要托管。
   官方文档对此**有专页如实披露**（`site/docs/red-team/troubleshooting/data-handling.md`），
   并不隐瞒——**过期/失真的是二手介绍里把 eval 的隐私口径套到红队上**。见 §7.3。
2. **「promptfoo 是个 prompt 测试工具」**——这是 2023 年的定位。
   截至本快照它有**四条独立产品线**：eval（原初）、red team（2024-05 起）、
   model scan（2025-06 起）、code scan（2025-11 起）。
   后两条与 prompt 没有关系：`scan-model` 扫的是 `.pkl` / `.safetensors` 模型文件，
   `code scan` 扫的是你仓库里的代码。见 §1、§18、§19。
3. **「装上就能用」**——0.122.0 起**要求 Node.js ≥ 22.22.0**。
   `drop Node.js 20 support` 是 2026-08-01 的破坏性变更
   （commit `26b725bd9`，进 0.122.0 的 `⚠ BREAKING CHANGES`），
   此前的约束是 `^20.20.0 || >=22.22.0`。Node 20 用户升级会直接装不上。
   另外 `promptfoo scan-model` 需要额外 `pip install modelaudit`——
   它是 spawn 出去的独立 Python 包，不随 npm 包一起装。见 §2、§18。

这三条都是「引用二手介绍而不回一手源」的代价。本文标注的现状同样会漂移——
引用前先看一眼日期。
:::

---

## 1. 产品概述：一个名字下的四条产品线

promptfoo 是一个**开源**（MIT）的 LLM 评估与安全测试工具，由 promptfoo, Inc. 开发，
作者 Ian Webster。npm 包名 `promptfoo`，CLI 有两个入口名：`promptfoo` 与短别名 `pf`
（`package.json` 的 `bin` 字段）。

它最容易被误解的一点是**产品边界**：叫 promptfoo，但只有第一条产品线跟 prompt 有关。

| 产品线 | 命令入口 | 扫什么 | 首次出现 |
|---|---|---|---|
| **Eval** | `promptfoo eval` | prompt / provider / RAG / agent 的输出质量 | 0.1.0（2023-05-03） |
| **Red team** | `promptfoo redteam *` | 活着的 LLM 应用的安全边界 | 0.60.0（2024-05-25） |
| **Model scan** | `promptfoo scan-model` | 模型**文件**（`.pkl`/`.h5`/`.safetensors`…） | 0.115.1（2025-06-17） |
| **Code scan** | `promptfoo code-scans run` | 你仓库里的**源代码** | 0.119.4（2025-11-06） |

「首次出现」取自 `CHANGELOG.md` 里包含对应关键词的**最早**版本条目，
用脚本从 424 个版本条目里反向扫出来的，不是目测（§22 给了脚本）。
注意这个口径的边界：它标的是「changelog 里第一次提到这个词」，
**不等于**「功能在这个版本已完整可用」——早期条目常常只是一个 PR 的落地。

**仓库与规模（GitHub REST API 实查，2026-08-09）：**

| 项 | 值 |
|---|---|
| 仓库 | `promptfoo/promptfoo`，创建于 2023-04-28 |
| Stars / Forks | **24,070** / 2,167 |
| Open issues | **494** |
| 许可 | MIT |
| 语言占比 | TypeScript **97.10%**、CSS 1.73%、JS 0.76%、Python 0.19%、Go 0.03% |

那 0.19% 的 Python 与 0.03% 的 Go **不是实现语言的一部分**，是 provider 侧的语言桥
（`src/python/wrapper.py`、`src/golang/wrapper.go`、`src/ruby/wrapper.rb`），
用来让你把 Python / Go / Ruby 脚本当 provider 或断言使用。见 §12。

**代码量（本地 clone 实查）：**

- `src/` 下 TypeScript **239,244 行 / 906 个 `.ts` 文件**（**不含** `src/app`）
- `src/app/`（Web UI）另有 **685 个** `.ts`/`.tsx`（其中 `.ts` 158 个）
- `test/` 下 **824 个** `*.test.ts`
- `examples/` **229 个**示例目录
- `site/docs/` **371 个** Markdown 页（`.md` + `.mdx`）

> 这几个数的口径值得说明，因为很容易数错——我们自己就先错了一版：
> `find src -name '*.ts' | wc -l` 得到 **1,064**，那是**含 `src/app`** 的；
> 排除 `src/app` 才是 906。同理 `ls examples | wc -l` 得到 231，
> 其中 2 个是文件（`AGENTS.md` 等）而非示例目录，实际目录 229 个。
> **凡「N 个文件」的断言都要连口径一起给，否则读者复现不出同一个数。**

## 2. 安装与运行形态

**分发形态（npm registry 实查 0.122.0）：**

| 项 | 值 |
|---|---|
| unpacked 体积 | **29,264,883 字节**（29.26 MB / 27.91 MiB）/ 629 个文件 |
| 运行时依赖 | **80 个** |
| engines | `node >= 22.22.0` |

**⚠ Node 20 已被弃用。** 这是 0.122.0 的破坏性变更，值得单独说明，
因为它是升级时最容易撞上的一堵墙：

```
2026-08-01  commit 26b725bd9  chore!: drop Node.js 20 support (#10260)
            engines.node:  "^20.20.0 || >=22.22.0"  →  ">=22.22.0"
```

`CHANGELOG.md:11` 把它记在 0.122.0 的 `### ⚠ BREAKING CHANGES` 下，
README 也同步写了 `Requires Node.js >=22.22.0`（`README.md:27`）。
这条是照实记录，不是缺陷——它有 changelog、有 BREAKING 标注、有 README 同步，
披露链路是完整的。

**五种运行方式：**

| 方式 | 命令 | 说明 |
|---|---|---|
| npx（推荐试用） | `npx promptfoo@latest init` | 不落地安装 |
| 全局安装 | `npm i -g promptfoo` | 长期使用 |
| Node 库 | `import promptfoo from 'promptfoo'` | 见 §17 |
| Docker | 见 `Dockerfile` | 基于 `node:24.19.0-alpine` |
| Helm | `helm/chart/` | 自托管 Web UI |

Docker 镜像里有一处值得注意的工程细节：Python 版本**刻意不固定**
（`Dockerfile:13` 的 `ARG PYTHON_VERSION=` 默认空）。
注释说明了理由——`py3-pip`/`py3-setuptools` 依赖 Alpine 基础镜像自带的那个 python3 小版本，
写死任何一个小版本都会在基础镜像前进时让 `apk add` 无法满足依赖
（Alpine 从 3.12 到 3.14 那次就打断过一次发布构建）。自托管者可以用
`--build-arg PYTHON_VERSION=3.14` 自己固定。

## 3. 发版节奏：一个正在放缓的曲线

npm registry 上 **419 个版本**，首发 `0.1.0`（2023-05-03）到 `0.122.0`（2026-08-04），
跨度 1,189 天，**平均 2.84 天一个版本**。

但均值掩盖了趋势。按年拆开（`/tmp/pf/npm.json` 落盘后脚本统计）：

| 年份 | 版本数 | 备注 |
|---|---|---|
| 2023（5 月起） | 84 | |
| 2024 | **167** | 峰值 |
| 2025 | 130 | |
| 2026（1–8 月） | **38** | |

2026 年逐月更明显：1 月 11 个，之后 5、5、5、4、4、3，8 月至采集日 1 个。

**这个放缓怎么解读，本文不下结论**——它可以是「趋于稳定」，
也可以是「开发重心转向闭源的 Cloud / Enterprise 侧」，
两种解释都与公开数据相容，而我们无法从外部区分。
能确证的只有节奏本身，以及一个相关事实：`0.122.0` 之前的 122 条 minor 线里，
**版本号从未进过 1.x**——三年多始终是 `0.x`。

**这一节存在的意义不是节奏本身，而是它对本文的影响**：
按 2026 年月均 4–5 个版本算，本文的插件清单与配置字段大约能维持数周有效。
比 opencode 那种「12 天 10 个版本」的项目要抗过期，但仍然会过期。

## 4. 配置系统

### 4.1 配置文件与发现顺序

配置文件名固定为 `promptfooconfig.<ext>`，**支持 9 种扩展名**，
按 `src/util/config/extensions.ts` 的顺序尝试，取第一个命中：

```
yaml  yml  json  cjs  cts  js  mjs  mts  ts
```

源文件注释点明了顺序依据是「使用频率」，且 `Order matters: loaders try each in
sequence and stop at the first match`。**这意味着同目录下同时存在
`promptfooconfig.yaml` 与 `promptfooconfig.ts` 时，`.ts` 那份永远不会被读到**——
不报错、不告警，静默忽略。

找不到配置时的报错做得比较细（`src/util/config/load.ts:876`）：
会打印搜索过的目录与完整扩展名列表，并给出 `init` 与 `-c` 两条出路。

### 4.2 顶层字段

`TestSuiteConfigSchema` 有 **17 个**顶层键（`src/types/index.ts`，脚本从 Zod schema 数出）：

| 键 | 用途 |
|---|---|
| `providers` / `targets` | 被测对象（`targets` 是红队侧的别名） |
| `prompts` | prompt 来源，支持 11 种处理器（§11） |
| `tests` | 测试用例 |
| `defaultTest` | 所有用例共享的默认断言与配置 |
| `scenarios` | 场景组合 |
| `assert`（在 test 内） | 断言，见 §5 |
| `redteam` | 红队配置，见 §6 |
| `derivedMetrics` | 从已有指标算派生指标 |
| `extensions` | 生命周期钩子，见 §4.3 |
| `tracing` | OTLP 追踪，见 §16 |
| `nunjucksFilters` | 自定义模板过滤器 |
| `env` | 环境变量覆盖 |
| `sharing` | 分享开关，见 §20 |
| `outputPath` / `writeLatestResults` | 输出 |
| `description` / `tags` / `metadata` | 元信息 |

`UnifiedConfigSchema` 在此基础上再加 4 个：`evaluateOptions`、`commandLineOptions`，
以及重新声明的 `providers` / `targets`。

### 4.3 扩展钩子：4 个生命周期点

`extensions` 字段挂的是四个钩子（`site/docs/configuration/reference.md:583` 起）：

| 钩子 | 时机 |
|---|---|
| `beforeAll` | 整个 suite 开始前 |
| `beforeEach` | 每个 test 前 |
| `afterEach` | 每个 test 后 |
| `afterAll` | 整个 suite 结束后 |

钩子可以用 JS/TS/Python 写。有一个**已知的作用域缺陷官方自己写进了警告**
（`src/util/config/load.ts:589`）：多配置 + extensions 同时使用时，
**所有 extensions 会跨所有 config 运行**，不遵守它原本所属的 `promptfooconfig`。
这是照实记录的已知限制，源码注释里请用户去开 issue。

### 4.4 环境变量：252 个

`src/envars.ts`（600 行）用一个 TypeScript 类型枚举了**252 个**环境变量键，
其中 **91 个**是 `PROMPTFOO_*` 前缀，其余 161 个是各家 provider 的凭据变量。
按前缀分布（脚本统计前 12）：

```
PROMPTFOO 91   AWS 13   AZURE 12   OPENAI 9   REPLICATE 9   ANTHROPIC 5
COHERE 5   OPENCLAW 5   MISTRAL 4   SHAREPOINT 4   WATSONX 4   NODE 3
```

把 env 变量收进一个集中的类型定义，好处是 `getEnvString('PROMPTFOO_XXX')`
拼错会在编译期报错——这是个值得抄的做法。

## 5. 断言系统：66 个基础类型

断言是 promptfoo 的核心抽象，也是它相对同类工具最厚的一层。

### 5.1 计数口径先说清

这一节的数字很容易被引用错，所以先把口径摆出来。**「66 个」指的是基础断言类型**，
来自 `src/types/index.ts:595` 的 `BaseAssertionTypesSchema` 这个 Zod enum：

```bash
# 脚本从 enum 字面量里数，不是目测
python3 -c "
import re
t=open('src/types/index.ts').read()
m=re.search(r'BaseAssertionTypesSchema = z\.enum\(\[(.*?)\]\)', t, re.S)
print(len(re.findall(r\"'([^']+)'\", m.group(1))))"
# → 66
```

在此之上还有三层，加起来才是「可写在 `type:` 里的合法值」全集
（`AssertionTypeSchema`，`src/types/index.ts:681`）：

| 层 | 数量 | 说明 |
|---|---|---|
| 基础类型 | **66** | `BaseAssertionTypesSchema` |
| `not-` 前缀镜像 | **66** | 运行时 `slice(4)` 取基类型再取反（`src/assertions/index.ts:365`） |
| 特殊类型 | **3** | `select-best` / `max-score` / `human`（后者只能从 Web UI 加） |
| 红队专用 | 不定 | `promptfoo:redteam:*`，走单独分派（`src/assertions/index.ts:642`） |

**`not-` 是全量镜像，没有白名单**——`NotPrefixedAssertionTypesSchema` 直接对
整个基础 enum 做 transform。文档措辞是保守的 `not-` prefixes are supported for
**most** base assertion types（`reference.md:142`），而代码里是 most 还是 all
取决于取反对某个类型是否有语义，schema 层面不拦。

**分派表与 enum 严格一一对应**：`ASSERTION_HANDLERS`
（`src/assertions/index.ts:226`）是 `Record<BaseAssertionTypes, handler>`，
脚本数出来也正好 **66** 个键，且与 enum 的 66 项完全一致——
类型系统保证了漏一个就编译不过。这是个值得注意的设计：
**新增断言类型时，忘记注册 handler 是编译错误，不是运行时错误。**

### 5.2 按执行方式分两类

官方文档把断言分成 deterministic 与 model-assisted 两组
（`site/docs/configuration/expected-outputs/index.md`）：

| 组 | 数量 | 是否需要 LLM | 例子 |
|---|---|---|---|
| **Deterministic** | 43 | 否 | `equals` `regex` `is-json` `latency` `cost` `javascript` |
| **Model-assisted** | 16 | **是** | `llm-rubric` `g-eval` `factuality` `similar` `context-*` |

这两个数字是从索引页那两张表用 `re.findall(r'^\|\s*\[([a-z...]+)\]', ...)` 数的，
合计 59（含 `select-best` / `max-score` 两个特殊类型）。

**注意 `similar` 落在 model-assisted 里**：它算余弦相似度，
但需要 embedding provider，所以仍然要网络调用与凭据。
纯本地零依赖的其实是 43 个 deterministic 里的大部分。

### 5.3 值得单独点出的几类

**代码类断言（3 种语言）**：`javascript` / `python` / `ruby`。
这三个在 `src/assertions/index.ts:563` 有个专门的
`SCRIPT_RESULT_ASSERTIONS` 白名单——只有这三种允许脚本返回值直接充当断言结果，
其余类型如果收到脚本返回值会被判为配置错误。

**Agent / trajectory 类（6 种，2026 年新增）**：

| 断言 | 判什么 | 需要 LLM |
|---|---|---|
| `trajectory:tool-used` | 是否调用了某工具 | 否 |
| `trajectory:tool-args-match` | 工具参数是否匹配 | 否 |
| `trajectory:tool-sequence` | 工具调用顺序 | 否 |
| `trajectory:step-count` | 步数上下界 | 否 |
| `trajectory:goal-success` | 目标是否达成 | **是** |
| `skill-used` | 是否用了某个 skill | 否 |

`trajectory:*` 首见于 0.121.3（2026-03-24），`skill-used` 首见 0.120.27（2026-03-06）。
实现在 `src/assertions/trajectory.ts`（668 行）与 `src/assertions/skill.ts`（205 行）。
**这一组是「评 agent 而不只是评单次输出」的入口**——
5 个里 4 个是确定性的，不用 LLM 判，这对稳定性有意义。

**Trace 类（3 种）**：`trace-span-count` / `trace-span-duration` / `trace-error-spans`，
依赖 §16 的 OTLP 追踪数据。

### 5.4 一处文档与代码的实测差异

拿 `ASSERTION_HANDLERS` 的 66 个键与文档索引表的 59 项做集合差，
**有 9 个断言类型在代码里存在、但不在索引表里**：

```
agent-rubric  finish-reason  model-graded-factuality  search-rubric
similar:cosine  similar:dot  similar:euclidean  tool-call-f1  word-count
```

逐个回查 `site/docs/` 全站后，**其中 8 个在细节页有文档**
（`agent-rubric` 有独立页、`finish-reason`/`tool-call-f1`/`word-count` 在
`deterministic.md`、`similar:*` 在 `similar.md`、`search-rubric` 有独立页）——
**只是没进那张汇总表**。

**唯一全站零文档的是 `model-graded-factuality`**：
`grep -rl model-graded-factuality site/docs` 返回 0 个文件，
而它在代码里是 `factuality` 的别名（`src/assertions/index.ts:289`
把它和 `factuality` 都指向 `handleFactuality`）。
**这是个无害的历史别名，不是功能缺失**——照实记录，不上升为缺陷。

## 6. 红队系统：155 个插件

`promptfoo redteam` 是它 2024-05 之后增长最快的一条线，也是本文数字最密的一节。

### 6.1 计数方法（这一节的数字都用它数）

红队的插件常量里**大量使用展开运算符**，正则数会漏。
实测教训：用 `re.findall` 数 `ADDITIONAL_PLUGINS` 得到 100，
而运行时求值是 **113**——差的 13 项全在 `...SPREAD` 里。
所以这一节全部走 `bun` 直接 import 常量做运行时求值：

```ts
// /tmp/pf/count.ts
import {
  ALL_PLUGINS, DEFAULT_PLUGINS,
} from './src/redteam/constants/plugins.ts';
console.log(ALL_PLUGINS.length, DEFAULT_PLUGINS.size);
```

**这是本文所有计数的通用原则**：能在运行时求值的就不要用正则数。

### 6.2 插件规模

| 集合 | 数量 | 含义 |
|---|---|---|
| `ALL_PLUGINS` | **155** | 全部可用插件 |
| `DEFAULT_PLUGINS` | **39** | 不指定 `plugins` 时跑的默认集 |
| `FOUNDATION_PLUGINS` | 44 | 基础模型场景推荐集 |
| `ADDITIONAL_PLUGINS` | 113 | 默认集之外的 |
| `HARM_PLUGINS` | 26 | 有害内容类 |
| `COLLECTIONS` | 16 | 可在配置里当单个 id 写的集合别名 |

16 个 collection 是这些：`default` `foundation` `harmful` `pii` `bias` `medical`
`pharmacy` `insurance` `financial` `ecommerce` `telecom` `teen-safety` `realestate`
`guardrails-eval` `coding-agent:core` `coding-agent:all`。

**行业垂直插件是它区别于通用红队工具的地方**：medical 9 个、financial 12 个、
telecom 12 个、realestate 8 个、insurance 4 个、ecommerce 4 个、pharmacy 3 个、
teen-safety 4 个。合计 56 个插件是行业专用的。

**`coding-agent:*` 13 个插件（2026-04 起）值得单独看**，
因为它测的正是本站关心的对象——coding agent 自己的安全边界：

| 插件 | 测什么 |
|---|---|
| `repo-prompt-injection` | 仓库里的不可信文本能否操纵 agent |
| `terminal-output-injection` | 编译/测试/hook 输出能否变成指令通道 |
| `secret-env-read` | 启动器环境变量是否被读出 |
| `sandbox-read-escape` / `sandbox-write-escape` | 越界读 / 越界写 |
| `verifier-sabotage` | 是否改弱测试/校验/lockfile 来让 QA 通过 |
| `secret-file-read` | 受保护文件内容是否流向可见 sink |
| `network-egress-bypass` | 绕过网络出口限制 |
| `procfs-credential-read` | 从 procfs 读凭据 |
| `delayed-ci-exfil` | 延迟到 CI 阶段的外泄 |
| `generated-vulnerability` | 生成的代码本身带漏洞 |
| `automation-poisoning` | 污染自动化流程 |
| `steganographic-exfil` | 隐写式外泄 |

官方文档对这组的说明点出了一个正确的评测观念
（`site/docs/red-team/coding-agents.md`）：coding-agent 评测同时测两件事——
模型是否做了安全的工程决策，以及 **harness 是否守住了它声称的边界**，
好的评测应该能告诉你是哪一层失效了。

### 6.3 攻击策略：37 种

| 集合 | 数量 | 内容 |
|---|---|---|
| `ALL_STRATEGIES` | **37** | 全部 |
| `DEFAULT_STRATEGIES` | **3** | `basic` `jailbreak:meta` `jailbreak:composite` |
| `ADDITIONAL_STRATEGIES` | 33 | 其余 |
| `MULTI_TURN_STRATEGIES` | 6 | `crescendo` `goat` `jailbreak:hydra` `jailbreak:goblin` `custom` `mischievous-user` |
| `AGENTIC_STRATEGIES` | 10 | 需要 agent 式多轮探索的 |
| `MULTI_MODAL_STRATEGIES` | 3 | `audio` `image` `video` |

策略大致分三档，理解这个分层比记住 37 个名字有用：

1. **编码/混淆类**（确定性变换，本地即可）：`base64` `hex` `rot13` `leetspeak`
   `morse` `piglatin` `camelcase` `emoji` `homoglyph`。
   有个 collection `other-encodings` 一次带上 `camelcase` `morse` `piglatin` `emoji`。
2. **单轮模板类**：`jailbreak-templates` `prompt-injection`（两者都已标记 deprecated，
   见 `src/redteam/constants/strategies.ts:96` 与 `:100` 的注释）、`citation`
   `math-prompt` `authoritative-markup-injection`。
3. **多轮 / agentic 类**（最贵也最有效）：`crescendo`（逐步升级）、
   `goat`、`jailbreak:hydra`、`jailbreak:tree`（树搜索）、`mischievous-user`。
   多轮默认 `DEFAULT_MULTI_TURN_MAX_TURNS = 5`。

**两个已弃用策略仍在 `ALL_STRATEGIES` 里**：`multilingual`（改用顶层 language 配置）
与 `prompt-injection`（改用 `jailbreak-templates`）。
源码注释标了弃用但没有移除，所以照旧配置不会报错——这是兼容性选择，不是遗漏。

### 6.4 合规框架映射

`src/redteam/constants/frameworks.ts`（1,081 行）把插件映射到 **10 个**合规框架
（`FRAMEWORK_COMPLIANCE_IDS`）。运行时求值各映射表的条目数：

| 框架 | 映射条目 |
|---|---|
| NIST AI RMF | **21** |
| MITRE ATLAS | 16 |
| EU AI Act | 14 |
| OWASP LLM Top 10 | 10 |
| OWASP API Top 10 | 10 |
| OWASP Agentic Top 10 | 10 |
| GDPR | 7 |
| ISO 42001 | 7 |
| DoD AI Ethics | 5 |

另有 `ALIASED_PLUGINS` **121** 项——把框架条目号（如 `owasp:llm:01`）
当插件 id 写时的别名解析表。

**这一层是卖给合规团队的**，技术上它只是一个多对多映射表；
但它解释了为什么这个项目的 red team 侧文档有 143 页——
每个框架都要一页把「我们的插件如何覆盖你的合规条目」讲清楚。

## 7. 托管推理边界：本文最该先读的一节

这一节是本文唯一「不查就会用错」的内容。

### 7.1 三条数据路径

官方把红队测试拆成三个操作，各自的数据边界不同
（`site/docs/red-team/troubleshooting/data-handling.md`）：

| 操作 | 在哪跑 | 数据去哪 |
|---|---|---|
| **目标评测**（Target evaluation） | **始终本地** | 只到你配置的 LLM provider |
| **测试生成**（Test generation） | 本地或远程 | 取决于配置 |
| **结果评分**（Result grading） | 本地或远程 | 取决于配置 |

**「目标评测始终本地」这条是真的**，且是理解全局的关键：
被测应用的流量不经过 promptfoo。
会经过的是**攻击用例的生成**与**结果的评判**。

### 7.2 实测数字

用运行时求值算插件与托管推理的关系：

```ts
// UI_DISABLED_WHEN_REMOTE_UNAVAILABLE = 前端在远程不可用时置灰的插件
// = UNALIGNED harm(22) + BIAS(4) + REMOTE_ONLY_PLUGIN_IDS 展开后的并集
const hosted = new Set([...UI_DISABLED].filter(x => ALL.has(x)));
// → 117 / 155 = 75.5%
```

| 口径 | 数量 | 占比 |
|---|---|---|
| `ALL_PLUGINS` | 155 | 100% |
| **代码里无本地实现**（`REMOTE_ONLY_PLUGIN_IDS` ∩ ALL） | **91** | 58.7% |
| **远程不可用时前端置灰** | **117** | **75.5%** |
| 自带 provider 可跑 | 38 | 24.5% |
| **默认插件集里需托管的** | **29 / 39** | 74.4% |

两个数字（91 与 117）的差别是口径不同：91 个是
`createRemotePlugin()` 造出来的、**根本没有本地代码路径**的插件
（`src/redteam/plugins/index.ts:694`）；117 个还额外包含 22 个 unaligned harm 插件
与 4 个 bias 插件——它们有本地代码，但那段代码干的事就是调
`PromptfooHarmfulCompletionProvider`，指向 `api.promptfoo.app/api/v1/task/harmful`
（`src/redteam/remoteGeneration.ts:202`）。**有本地实现但仍需托管服务。**

### 7.3 关掉远程会发生什么

设 `PROMPTFOO_DISABLE_REMOTE_GENERATION=true` 后，
这 117 个插件的行为是**记一条 error 日志然后返回空数组**：

```ts
// src/redteam/plugins/index.ts:656（remote plugin）
if (neverGenerateRemote()) {
  logger.error(
    getRemoteGenerationExplicitlyDisabledError(`${key} plugin`));
  return [];
}
```

**返回 `[]` 意味着这个插件贡献 0 个测试用例，而不是让整次运行失败。**
这是值得点破的一点：**「没有生成用例」与「生成了用例但没发现漏洞」
在最终报告上都表现为该项无发现。** 错误信息本身写得很好——
会列出当前生效的是哪个开关、怎么取消、以及可以用
`PROMPTFOO_REMOTE_GENERATION_URL` 指向自托管端点
（`src/redteam/remoteGeneration.ts:147`）。但那是日志层，不是报告层。

官方文档对质量差异也说得直白，值得原样引用
（`site/docs/red-team/configuration.md:818`）：

> You can force 100% local generation by setting
> `PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION`. Note that the quality of local
> generation depends greatly on the model that you configure,
> **and is generally low for most models**.

### 7.4 三个域名

| 域名 | 用途 |
|---|---|
| `api.promptfoo.app` | 测试生成 / 评分 / 分享 / Cloud |
| `api.promptfoo.dev` | 有害插件的 consent 记录、版本检查、反馈 |
| `a.promptfoo.app` | 遥测（PostHog 自托管实例） |

这三个都在 `src/constants.ts:11`、`:43`、`:44` 硬编码。
企业若要完全隔离，官方给的路径是 Enterprise On-Prem（§21），
而不是把社区版配到不出网——文档明确写了
`PROMPTFOO_DISABLE_REMOTE_GENERATION` **不是网络隔离保证**
（"It is not a network isolation guarantee"）。

### 7.5 这一节该怎么评价

**照实说两面：**

- **值得肯定的一面**：这些边界官方**有专页、有列表、有开关、有错误提示**，
  披露是完整的。`data-handling.md` 甚至逐条列了「默认会发送什么」
  （purpose 字段、插件配置、target URL 与 auth header、你的邮箱），
  以及「不会发送什么」（本地环境变量里的 API key、模型权重、文件系统内容）。
  文档里 🌐 标记还是**从同一份代码常量生成**的（`<PluginTable showRemoteStatus />`），
  所以不会出现「文档说能本地跑、代码里其实不能」的漂移——这一点我们核对过。
- **需要用户自己算的一面**：文档给的是**分类描述**
  （"Harmful content plugins"、"Bias plugins"、"Domain-specific plugins"），
  **没有给出比例**。「75.5%」「默认集 29/39」这两个数字要自己去数常量才有。
  对于「能不能在内网离线用这个工具做红队」这个决策，比例比分类更关键。

**本文的增量就在这里**：把分类描述换算成了可决策的比例。

## 8. Provider 系统：89 个前缀

### 8.1 分派机制

Provider 用 `provider:model` 形式的字符串标识，靠一张**有序的工厂表**分派
（`src/providers/registry.ts:138` 的 `providerMap`）。每个工厂是一对
`{ test, create }`：`test` 拿到 provider 路径返回 bool，
`loadApiProvider` 顺序遍历、**第一个 `test` 返真的工厂负责创建**
（`src/providers/index.ts:200`）。

`providerMap` 里有 **76 个** `test` 谓词 + 4 个由
`createScriptBasedProviderFactory()` 生成的（`exec` / `golang` / `python` / `ruby`）。
把所有 `startsWith('xxx:')` 与 `=== 'xxx'` 的前缀取并集，**共 89 个前缀**：

```
a2a abliteration ai21 aimlapi alibaba alicloud aliyun anthropic
atlascloud azure azureopenai bam bedrock bedrock-agent browser
cerebras cloudera cloudflare-ai cloudflare-gateway cohere cometapi
dashscope databricks deepseek docker echo elevenlabs envoy f5 fal
file fireworks github google groq helicone hf http https huggingface
hyperbolic jfrog litellm llama llamaapi localai mcp meta minimax
mistral mlflow-gateway modelslab moonshot n8n novita nscale nvidia
ollama openai openclaw opencode openinterpreter openrouter orcarouter
package palm perplexity portkey promptfoo quiverai qwak replicate
sagemaker sequence slack snowflake togetherai transformers
transformers.js truefoundry vercel vertex voyage watsonx webhook
websocket ws wss xai
```

注意其中有**别名组**：`alibaba`/`alicloud`/`aliyun`/`dashscope` 是同一家，
`azure`/`azureopenai` 同一家，`huggingface`/`hf` 同一家，
`websocket`/`ws`/`wss` 同一个实现，`http`/`https` 同一个。
所以「89 个前缀」**不等于 89 家厂商**。文档侧的口径又不一样：
`site/docs/providers/` 下有 91 个 `.md`，去掉 `index.md` 是 **90 个 provider 页**
（另有 1 个 `_category_.json` 不是文档）。
**三个数字（89 前缀 / 90 文档页 / 厂商数）互不相等，引用时要说清用的是哪个。**

### 8.2 懒加载的三个 family

有三组 provider 走 `ProviderFamily` 懒加载（`src/providers/registry.ts:1743`）：
AWS、Google、redteam。它们的 `canHandle` 是**加载闸门而非分派器**——
返真才 `await import()` 那个模块并把它的工厂插到表前面，分派仍走各工厂自己的 `test`。

`registryTypes.ts` 的注释把这个双层设计的意图写得很清楚：
`canHandle` 与内部 `test` **刻意重复**，好让 `canHandle` 保持廉价（一次字符串前缀判断），
而 `test` 可以任意精细。另有一个热路径优化：无 family 命中时
**直接返回模块级的 `providerMap` 而不是拷一份新数组**（`:1774`），
返回类型是 `readonly` 所以调用方无法改它。

**这是本文读到的最干净的一处工程实现**，值得单列：
懒加载、热路径零拷贝、以及把动态 import 失败包装成带 providerPath 与
family 边界的错误（`:1789` 注释解释了不包装的话用户只会看到一个
指向内部文件的 `ERR_MODULE_NOT_FOUND`）。

### 8.3 值得注意的几类 provider

**Coding agent 类**（这一组是 2025-12 之后加的，与本站主题重合）：

| provider | 对象 |
|---|---|
| `anthropic:claude-agent-sdk` / `anthropic:claude-code` | Claude Agent SDK / Claude Code |
| `openai:codex-sdk` / `openai:codex-app-server` | Codex 两种接入形态 |
| `opencode:*` | opencode SDK |
| `openclaw:*` | OpenClaw |
| `openai:agents` | OpenAI Agents |
| `bedrock-agent:*` | Bedrock Agents |
| `a2a:*` | A2A 协议（首见 0.120.4 / 2025-12-11） |
| `mcp:*` | 直接把 MCP server 当被测目标 |

**基础设施类**：`http`（3,264 行，最重的单个 provider）、`websocket`、`browser`
（浏览器自动化）、`slack`、`docker`、`sequence`（串联多个 provider）、
`simulated-user`（模拟多轮用户）、`echo`（回显，测试用）、`manual-input`（人工输入）。

**网关类**：`helicone` `portkey` `litellm` `openrouter` `cloudflare-gateway`
`vercel` `mlflow-gateway` `envoy` `f5` `orcarouter` `truefoundry` `aimlapi` `cometapi`。
数量之多说明一件事：**这个工具的用户里有相当比例是在网关后面跑模型的**。

### 8.4 默认并发是 4

`DEFAULT_MAX_CONCURRENCY = 4`（`src/constants.ts:8`），红队侧
`REDTEAM_DEFAULTS.MAX_CONCURRENCY = 4`、`NUM_TESTS = 10`
（`src/redteam/constants/plugins.ts:12`）。
CLI 用 `-j, --max-concurrency` 覆盖；`maxConcurrency: 1` 是官方推荐的串行方式
（`src/types/index.ts:266` 的注释里，旧的串行选项已弃用并指向它）。

红队默认评判模型是 `openai:chat:gpt-5.5-2026-04-23`
（`REDTEAM_MODEL`，`src/redteam/constants/plugins.ts:17`）。
**这是一个会随版本漂移的硬编码常量**，引用时务必带版本号。

## 9. CLI 命令面

顶层命令约 **24 个**（`src/main.ts:88` 起注册），按用途分组：

| 组 | 命令 |
|---|---|
| **评估** | `eval`、`eval setup`、`validate config`、`validate target`、`retry`、`optimize` |
| **红队** | `redteam init`/`generate`/`run`/`report`/`setup`/`discover`/`plugins`/`eval` |
| **扫描** | `scan-model`、`code-scans run` |
| **数据** | `list evals`/`prompts`/`datasets`、`show eval`/`prompt`/`dataset`、`export eval`/`logs`、`import`、`delete eval` |
| **生成** | `generate dataset`、`generate assertions`、`generate redteam` |
| **服务** | `view`（Web UI）、`mcp`（MCP server，§15） |
| **账户/配置** | `auth login`/`logout`/`whoami`/`teams`、`config get`/`set`/`unset`/`email` |
| **运维** | `cache clear`、`logs list`、`debug`、`feedback`、`init`、`share` |

`promptfoo eval` 有 **42 个** option（脚本从 `src/commands/eval.ts` 的
`.option(` 调用数出）。其中过滤类占了 11 个，是这个命令里最值得知道的一组：

| option | 作用 |
|---|---|
| `-n, --filter-first-n <n>` | 只跑前 n 个 |
| `--filter-pattern <p>` | 按描述正则筛 |
| `--filter-range <start:end>` | 按区间筛 |
| `--filter-prompts <p>` | 按 prompt 筛 |
| `--filter-providers, --filter-targets` | 按 provider 筛 |
| `--filter-sample <n>` / `--filter-sample-seed <n>` | 随机抽样（带种子，可复现） |
| `--filter-failing <path or id>` | **只重跑上次失败的** |
| `--filter-failing-only` / `--filter-errors-only` | 区分「断言失败」与「执行报错」 |
| `--filter-metadata <k=v>` | 按 metadata 筛 |

`--filter-failing` + `--retry-errors` + `--resume [evalId]` 这三个组合起来
是长跑 eval 的实用组合：**中断可续、失败可只重跑失败的那批**。
`--filter-sample-seed` 带种子这点做得对——随机抽样如果不可复现，
就没法拿两次运行做对比。

## 10. 测试用例与数据集

`tests` 字段接受多种形态（`site/docs/configuration/test-cases.md`）：
内联数组、CSV / JSONL 文件路径、Google Sheets URL、HuggingFace 数据集、
SharePoint、以及生成器函数。

**外部数据源集成**（`src/integrations/` 与相关文件）：

| 源 | 实现 |
|---|---|
| Google Sheets | `src/googleSheets.ts` |
| HuggingFace datasets | `src/integrations/huggingfaceDatasets.ts` |
| Microsoft SharePoint | `src/microsoftSharepoint.ts` |
| Langfuse | `src/integrations/langfuse.ts`（拉 prompt） |
| Portkey / Helicone | 同上，网关侧的 prompt 管理 |

**红队侧另有 10 个数据集插件**（`DATASET_PLUGINS`，
`src/redteam/constants/strategies.ts:100` 附近）——它们不生成用例，
而是从公开的对抗数据集里取：`beavertails` `cyberseceval` `donotanswer`
`harmbench` `toxic-chat` `aegis` `pliny` `unsafebench` `vlguard` `xstest`。

**`scenarios`** 是另一种组合方式：把 vars 的多组取值与多组断言做笛卡尔积，
适合「同一个 prompt 在 5 种语言 × 3 种语气下的表现」这类矩阵。

## 11. Prompt 处理：11 种来源格式

`src/prompts/processors/` 下 **11 个**处理器：

| 处理器 | 输入 |
|---|---|
| `string.ts` / `text.ts` | 内联字符串 / `.txt` |
| `json.ts` / `jsonl.ts` / `yaml.ts` | 结构化文件 |
| `csv.ts` | CSV（每行一个 prompt） |
| `markdown.ts` | `.md` |
| `jinja.ts` | Jinja2 模板 |
| `javascript.ts` / `python.ts` | 函数式 prompt（动态生成） |
| `executable.ts` | 任意可执行文件 |

模板引擎是 **Nunjucks**（`src/util/templates.ts:1`），
所以 `{{ var }}` `{% if %}` `{% for %}` 都可用，
并可通过 `nunjucksFilters` 注册自定义过滤器。

有一处实现细节值得记：模板变量检测**优先走 nunjucks 自己的 parser**
（`nunjucks.parser.parse`），拿不到 parser 时才退回保守的字符串检测
（`src/util/templates.ts:49`、`:56` 两处 fallback 日志）。
**用目标语言自己的 parser 而不是正则去判断，是这类问题的正解**——
正则判模板变量必然在嵌套与转义上出错。

## 12. 多语言扩展：Python / Go / Ruby

三种语言可以充当 provider、prompt 生成器或断言：

| 语言 | 桥实现 | 入口约定 |
|---|---|---|
| **Python** | `src/python/wrapper.py` + `pythonUtils.ts` | `call_api(prompt, options, context)` |
| **Go** | `src/golang/wrapper.go` + `go.mod` | 编译后调用 |
| **Ruby** | `src/ruby/wrapper.rb` + `rubyUtils.ts` | 类似 Python |

Python 侧有一个**持久化 worker 池**（`src/python/persistent_wrapper.py`
+ `workerPool.ts` + `worker.ts`），避免每次调用都付一遍解释器启动开销。
Go 与 Ruby 没有对应的池化实现——这是三者的能力差异，照实记录。

`src/providers/packageParser.ts` 还支持 `package:` 前缀，
从 npm 包里加载 provider。

## 13. 数据存储

**本地存储是 SQLite**，路径 `~/.promptfoo/promptfoo.db`
（`src/database/index.ts:123`），ORM 是 Drizzle。

**15 张表**（`src/database/tables.ts` 的 `sqliteTable()` 调用）：

| 表 | 用途 |
|---|---|
| `evals` / `evalResults` | 评估运行与逐条结果 |
| `prompts` / `evalsToPrompts` | prompt 及关联 |
| `datasets` / `evalsToDatasets` | 数据集及关联 |
| `tags` / `evalsToTags` | 标签 |
| `configs` | 配置快照 |
| `blobAssets` / `blobReferences` | 二进制资产（图/音/视频） |
| `traces` / `spans` | OTLP 追踪（§16） |
| `modelAudits` | 模型扫描结果（§18） |
| `llmOutputs` | 历史遗留表 |

`drizzle/` 下 **25 个** migration SQL（`ls drizzle/*.sql`，
该目录另有 `meta/` 与两个 `.md` 不是迁移）——三年多演进的痕迹。

**缓存是另一套**：`cache-manager` + `keyv` + `keyv-file`，
默认落盘 `~/.promptfoo/cache`（`src/cache.ts`，969 行）。
缓存键的构成官方明确声明为**实现细节、可能在版本间变化**
（`site/docs/configuration/caching.md`），
且敏感请求体与 header **尽可能哈希后再入键**而不是直接嵌入。
键形态大致是 `openai:gpt-5:<request-digest>` 与 `fetch:v3:<request-digest>`。

`--no-cache` 关缓存，`promptfoo cache clear` 清缓存。

## 14. Web UI

`promptfoo view` 起一个本地服务器（`src/server/`），前端在 `src/app/`。

**技术栈（`src/app/package.json` 实查）：**

| 项 | 版本 |
|---|---|
| React | ^19.2.4 |
| Vite | ^8.0.16 |
| 状态 | zustand ^5.0.12 |
| 路由 | react-router-dom ^7.18.0 |
| 图表 | recharts ^3.8.0 |
| 组件 | **Radix UI**（17 个 `@radix-ui/react-*` 包） |
| 虚拟滚动 | @tanstack/react-virtual ^3.13.22 |
| CSS | lightningcss ^1.32.0 |

**注意没有 MUI**。这值得一提，因为网上不少 promptfoo 的界面截图与讨论
来自它用 Material UI 的时期；当前依赖里 `@mui/*` 一个都没有，
换成了 Radix UI（无样式基元）+ lightningcss。
截至本快照 `src/app/` 有 685 个 `.ts`/`.tsx` 文件。

**服务端路由**（`src/server/routes/`，10 个）：
`eval` `configs` `providers` `redteam` `traces` `modelAudit` `blobs` `media`
`user` `version`。

::: warning 自托管的边界：官方自己划了，且划得比多数项目诚实
`promptfoo view` / 自托管镜像起的是一个 Express 服务器，
**社区版没有认证层**。这不是我们的推断，是官方文档的原话
（`site/docs/usage/self-hosting.md:37` 起的 `:::warning` 块）：

> **Self-hosting is not recommended for production use cases.**
> - Uses a local SQLite database that requires manual persistence management…
> - No multi-team support or role-based access control.
> - No support for horizontal scalability…（多副本会报 "Job not found"）
> - **No built-in authentication or SSO capabilities**

**值得肯定的是它把「多副本会坏，且坏成什么样」都写出来了**——
评估任务存在各 server 的内存里、多个 pod 无法共享 SQLite，
所以 K8s 上开超过一个 replica 会出 "Job not found"。
这种具体到报错文案的自曝，比一句「建议单实例部署」有用得多。

代码侧我们额外核到两点：`httpServer.listen(port)` 没有指定 host
（`src/server/server.ts:552`），按 Node 默认即监听所有网络接口；
中间件只有一个 CSRF 保护（`src/server/middleware/csrfProtection.ts`，
把 `localhost`/`127.0.0.1`/`::1`/`local.promptfoo.app` 视作同源，
额外来源用 `PROMPTFOO_CSRF_ALLOWED_ORIGINS` 放行）。
**CSRF 防的是跨站请求伪造，不是未授权访问**——两者不能互相替代。
所以结论仍是：需要多人访问就走 Enterprise（§21），或自己在前面加一层认证。
:::

## 15. MCP：两个方向都通

promptfoo 与 MCP 的关系有两个方向，容易混淆：

| 方向 | 形态 | 说明 |
|---|---|---|
| **promptfoo 作为 MCP server** | `promptfoo mcp` | 让 Claude Code / Cursor 等调用 promptfoo 的能力 |
| **MCP server 作为被测目标** | `mcp:*` provider | 直接红队一个 MCP server |

### 15.1 作为 MCP server：14 个工具

`src/commands/mcp/server.ts` 注册了 **12 个** `register*Tool(server)` 调用
再加 `registerLogTools(server)` 里的 2 个（`list_logs` / `read_logs`），
**共 14 个工具**：

| 组 | 工具 |
|---|---|
| 评估 | `list_evaluations` `get_evaluation_details` `run_evaluation` `share_evaluation` |
| 生成 | `generate_dataset` `generate_test_cases` `compare_providers` |
| 红队 | `redteam_run` `redteam_generate` |
| 配置/调试 | `validate_promptfoo_config` `test_provider` `run_assertion` |
| 日志 | `list_logs` `read_logs` |

**官方文档只列了 12 个**（`site/docs/integrations/mcp-server.md` 的
Available Tools 一节），缺 `list_logs` 与 `read_logs`。
这两个在代码里确实注册了（`src/commands/mcp/tools/logs.ts:43`、`:134`）。
差异极小、也无害——记在这里只是因为本文承诺「核到版本号级别」，
而这是可脚本验证的一处 delta。

`run_assertion` 这个工具值得单独点出：它让你**单独测一条断言规则**，
不用跑整个 eval。调试 `llm-rubric` 的评分标准时这是最短路径。

### 15.2 MCP server 作为被测目标

`MCP_PLUGINS` 是 6 个：`mcp` `pii` `bfla` `bola` `sql-injection` `rbac`
（`src/redteam/constants/plugins.ts:156`）。
专门的文档在 `site/docs/red-team/mcp-security-testing.md`。
`src/redteam/mcpToolCall.ts` 与 `mcpTargetProvider.ts` 是实现。

**这一组测的是 MCP server 的授权边界**——
bfla（越权访问功能）、bola（越权访问对象）、rbac 都是 API 安全的经典项，
搬到 MCP 上依然成立，因为 MCP tool 本质就是暴露的 API。

## 16. 追踪：内建 OTLP 接收器

### 16.1 形态

promptfoo **自己就是一个 OpenTelemetry 接收器**
（`src/tracing/otlpReceiver.ts`），默认监听标准 OTLP HTTP 端口 **4318**。
你的 provider 用任何语言的 OTel SDK 打点，promptfoo 收下来存进
`traces` / `spans` 两张表，然后在 Web UI 里按测试用例关联展示。

**「不需要外部 collector」是这个设计的卖点**：
调试期不用先搭一套 Jaeger/Tempo。需要转发时也支持
（配 `url: http://localhost:4318/v1/traces` 指向下游）。

配置要**两处都开**（`site/docs/tracing.md:118`、`:299`）：

```yaml
tracing:
  enabled: true # 发送 OTLP 遥测
  otlp:
    http:
      enabled: true # 启动内建接收器
      # port: 4318  # 默认 4318
```

两层开关分别控制「发不发」与「收不收」，只开一个不生效。

### 16.2 内建埋点覆盖 15 类 provider

按 GenAI Semantic Conventions 打 span，文档表格里 15 行标了 ✓，
其中 2 行是 `(inherited)`——OpenAI 兼容层（DeepSeek / Perplexity 等）
与 Cloudflare AI 是继承来的，不是单独实现。

**有一处行为值得知道，官方写进了文档但很容易漏读**
（`site/docs/tracing.md:278`）：

> **Cache hits emit no turn span.** 缓存命中仍会发出父级
> `chat <model>` span，但没有真实 LLM 往返，因此 `gen_ai.turn` span 数为零。

这直接影响 §5 的三个 trace 断言：
**用 `trace-span-count` 数轮次时，缓存命中会让计数偏低。**
官方给的规避是跑 `--no-cache`，或把 min/max 断言限定在非缓存响应上。
这是本文认为最实用的一条冷知识——它会静默地让断言结果失真。

### 16.3 接收器侧有脱敏策略

`OTLPReceiverTracePolicy`（`src/tracing/otlpReceiver.ts:166`）支持
`redactAttributePatterns`，把匹配的 span 属性打码后再落库。
这是必要的——span 属性里很容易带上完整的 prompt 与响应。

## 17. Node SDK

`import promptfoo from 'promptfoo'` 后可用的主要导出（`src/index.ts:63`）：

```ts
export {
  assertions, cache, evaluate, guardrails,
  loadApiProvider, loadApiProviders, redteam,
};
```

`evaluate(testSuite, options)` 是主入口。另外导出了完整的类型
（`export * from './types/index'`）与几个具名错误类：
`EvalRunError`、`ConfigResolutionError`、`ServerError`、
`PromptSuggestionsRejectedError`、`EmailValidationError`。

**具名错误类是好实践**——调用方可以 `instanceof` 分流，
而不是去 match 错误消息字符串。

包还单独导出了 `promptfoo/contracts` 子路径
（`package.json` 的 `exports`），带独立的 `.d.ts` / `.d.cts`，
给只需要类型而不想拉运行时的场景用。

## 18. 模型扫描：`scan-model`

### 18.1 它其实是个 Python 包

**这是最容易误解的一处**：`promptfoo scan-model` 自己不做扫描，
它 `spawn('modelaudit', args)`（`src/commands/modelScan.ts:234`），
调用的是一个**独立的 Python 包**：

```bash
pip install modelaudit                       # 必须单独装
pip install modelaudit[tensorflow,h5,pytorch]  # 按需装框架依赖
pip install modelaudit[all]
```

装不上时的报错处理做得到位（`src/commands/modelScan.ts:360`）：
会提示 `Make sure modelaudit is installed and available in your PATH.`
并给出 `pip install modelaudit`。

**退出码语义值得记**：`modelaudit` 用 exit code 1 表示
「扫描完成且发现了问题」，而不是「执行失败」。
promptfoo 侧有个 `treatExitOneAsIssues` 开关来区分这两种含义
（`src/commands/modelScan.ts:353`）。CI 里直接判 `$?` 会把
「发现漏洞」和「工具崩了」当成一回事。

### 18.2 31 个扫描器

`site/docs/model-audit/scanners.md` 里 37 个二级标题，
其中 **31 个**是具名扫描器（脚本按标题含 "Scanner" 数出）：

| 类别 | 扫描器 |
|---|---|
| **序列化格式** | Pickle、PyTorch Zip、PyTorch Binary、Joblib、Skops、NumPy |
| **框架格式** | TensorFlow SavedModel、TF Lite、TensorRT、Keras H5、Keras ZIP、ONNX、OpenVINO、ExecuTorch、Flax/JAX、JAX Checkpoint、PaddlePaddle、XGBoost、PMML |
| **安全格式** | SafeTensors、GGUF/GGML |
| **容器/归档** | ZIP、TAR、7-Zip、OCI Layer、Manifest |
| **内容类** | Text、Jinja2 Template、Metadata、Weight Distribution |

**Pickle 扫描器是这类工具存在的根本理由**：
`.pkl` 反序列化等价于任意代码执行，而 PyTorch 生态大量依赖它。
`Weight Distribution Scanner` 是另一个思路——通过权重分布异常
来发现可能的后门植入，这个不依赖文件格式。

另有 6 个非格式扫描能力：License 合规检查、网络通信检测、
密钥检测、JIT/Script 检测、HuggingFace URL 支持、自动格式识别。

## 19. 代码扫描：`code-scans run`

这是四条产品线里最新的一条（0.119.4 / 2025-11-06 首见，
SARIF 输出 2026-05-09 补上）。

**它扫的是你仓库里的源代码**，目标是 LLM 相关的漏洞类别——
prompt injection、PII 暴露、过度授权（excessive agency）。
官方对它的定位说得明确（`site/docs/code-scanning/index.md`）：
不只看 diff 表面，而是**追踪数据流深入代码库**，
理解用户输入怎么到达 prompt、输出怎么被使用、LLM 有哪些能力可用。

**⚠ 这条产品线完全依赖 promptfoo Cloud。** 认证是必需的，
四种方式按序检查（`site/docs/code-scanning/cli.md:153`）：
`--api-key` → `PROMPTFOO_API_KEY` → `promptfoo auth login` → GitHub OIDC。
**没有本地模式**——`--api-key` 是它唯一的鉴权入口，
所以这一条与 §7 的托管边界讨论同理：它是个 SaaS 功能，
开源仓库里的 `src/codeScan/` 是客户端。

三种接入形态：

| 形态 | 说明 |
|---|---|
| **GitHub Action** | 推荐。findings 作为 review comment，可发到 GitHub Code Scanning / Security 页 |
| **VS Code 扩展** | **Enterprise 专属**，实时诊断 + quick fix |
| **CLI** | 本地或任意 CI |

`code-scan-action/` 是仓库里独立的一个 Action 包，
有自己的 `package.json` / `CHANGELOG.md`（当前 `code-scan-action-0.1.8` tag）。
Action 的输入里有个细节：`min-severity` 与 `minimum-severity` 是别名，
后者**没有默认值**、只在前者未设时生效，两者都未设时默认 `medium`
（`code-scan-action/action.yml`）。

严重度四档：Critical / High / Medium / Low。

## 20. 分享与遥测

### 20.1 分享

`promptfoo share` 把 eval 结果上传后给一个 URL。
行为按登录状态分四种（`site/docs/usage/sharing.md:52`）：

| 状态 | 行为 |
|---|---|
| Cloud 用户 | 自动生成**私有**分享 URL |
| Enterprise 用户 | 团队可访问，带 RBAC |
| 自托管 | 用你配置的端点 |
| 未配置 | 显示配置指引 |

关闭方式三种：`sharing: false`（配置）、`--no-share`（CLI）、
`PROMPTFOO_DISABLE_SHARING=true`（环境变量）。

代码侧默认目标是 `api.promptfoo.app`（`src/constants.ts:11`），
登录 Cloud 后走 `cloudConfig.getApiHost()`（`src/share.ts:100`）。
认证头只在 Cloud 启用时附加（`src/share.ts:468`）。

**有一处值得肯定的凭据隔离设计**（`src/redteam/remoteGeneration.ts:44` 注释）：
认证是在 fetch 层集中注入的，且**只在请求 URL 的 origin 与配置的
Cloud host 匹配时**才注入。这样把 `PROMPTFOO_REMOTE_GENERATION_URL`
指向自己的端点时，Cloud 凭据不会跟着漏出去。
这个坑很多工具踩过——「统一加 header」实现成全局拦截器就会漏。

### 20.2 遥测

PostHog（`posthog-node`），端点 `a.promptfoo.app`（自托管 PostHog 实例）。
关闭：`PROMPTFOO_DISABLE_TELEMETRY=1`。

**采集什么**（`site/docs/red-team/troubleshooting/data-handling.md` 的 Telemetry 节）：
运行的命令、用到的插件与策略类型（不含内容）、断言类型；
另有包版本、CI 状态、promptfoo user id、邮箱、Cloud 登录状态与认证方式。
**声明不采集**：prompt 内容、模型响应、生成的测试用例、provider API key、完整配置文件。

**这些是厂商口径，我们无法从外部验证**（见文末未验证块）。
能从代码确证的只有：`getEnvBool('PROMPTFOO_DISABLE_TELEMETRY')` 为真时
`getPostHogClient()` 直接返回 null（`src/telemetry.ts:19`），
开关本身是真的生效的。

有一处实现细节顺带记：PostHog client 设了 `flushInterval: 0`
禁用自动定时刷新，改为每次 capture 后显式 flush。
理由写在注释里（`src/telemetry.ts:31`）——
PostHog 内部的 `setInterval` 会让 Node 事件循环永不退出，
导致 `import promptfoo` 的进程挂住（对应 issue #5893）。
**库作者容易忽略的一类 bug**：引入的依赖悄悄持有了定时器。

## 21. 商业形态：三档

`site/docs/enterprise/index.md` 给了一张三档对比表。摘关键差异：

| 能力 | Community | Enterprise (SaaS) | Enterprise On-Prem |
|---|---|---|---|
| 部署 | CLI 工具 | 托管 SaaS | 自托管 |
| 专用 runner | ❌ | ❌ | ✅ |
| **网络隔离** | ❌ | ❌ | **✅** |
| 红队 / 修复建议 / 分享 / API | ⚠️ 受限 | ✅ | ✅ |
| 团队管理 / RBAC | ❌ | ✅ | ✅ |
| SIEM / issue tracker 集成 | ❌ | ✅ | ✅ |

**注意 SaaS 版的「网络隔离」也是 ❌**——只有 On-Prem 有。
这与 §7 的结论一致：要完全不出网，路径是 On-Prem，
它提供「所有插件的自托管推理」与 air-gapped 运行。

Enterprise 侧文档 10 页：audit logging、authentication、findings、guardrails、
red teams、remediation reports、service accounts、teams、webhooks。
**这一层没有源码可查**（不在开源仓库里），所以本文对它的描述
全部是官方文档口径，未经核验。

## 22. 版本里程碑（带日期的事实层）

方法：从 `CHANGELOG.md` 的 424 个版本条目里，
按关键词反向扫出**最早提及**的版本，再与 git 历史交叉核对。

```python
# 关键词 → 最早提及它的版本条目
secs = re.split(r'^## ', open('CHANGELOG.md').read(), flags=re.M)[1:]
# 倒序取最后一个命中（文件是新→旧排列）
```

**⚠ 口径边界**：这标的是「changelog 里第一次出现这个词」，
**不是「功能在该版本已完整可用」**。早期条目常常只是一个 PR 落地。

| 日期 | 版本 | 里程碑 |
|---|---|---|
| 2023-05-03 | 0.1.0 | 首发 |
| 2024-01-02 | 0.34.0 | `optimize` 相关首见 |
| 2024-05-25 | 0.60.0 | **red team 首见**（第二条产品线） |
| 2024-11-18 | 0.97.0 | guardrails 首见 |
| 2025-04-22 | 0.111.1 | MCP 首见 |
| 2025-06-17 | 0.115.1 | **model audit / `scan-model` 首见**（第三条） |
| 2025-06-25 | 0.115.4 | tracing / OTLP 首见 |
| 2025-11-06 | 0.119.4 | **code scan 首见**（第四条） |
| 2025-12-11 | 0.120.4 | A2A provider 首见 |
| 2026-03-06 | 0.120.27 | skill 相关首见 |
| 2026-03-24 | 0.121.3 | **trajectory 断言首见**（agent 评测） |
| 2026-04-10 | 0.121.4 | **coding-agent 插件首见** |
| 2026-05-09 | — | code scan 支持 SARIF 输出（commit `4da26e95e`） |
| 2026-06-02 | — | `src/tracing/` 目录建立（commit `d27868b7f`） |
| 2026-08-01 | — | **drop Node.js 20**（commit `26b725bd9`） |
| 2026-08-04 | **0.122.0** | 本快照的 npm latest，含上条 BREAKING |
| 2026-08-08 | `49c0f6d7` | 本快照的源码 HEAD |

**两个观察，都只摆事实不下结论：**

1. **四条产品线的间隔在缩短**：eval → red team 隔了约 25 个月，
   red team → model scan 约 13 个月，model scan → code scan 约 5 个月。
2. **2026 年的新增集中在 agent 方向**：`skill-used`、`trajectory:*`、
   `coding-agent:*` 13 个插件，都在 2026-03 到 2026-04 这两个月里。
   而**同期发版频率是下降的**（§3）——版本更少，但每个版本装的东西更集中。

**版本号始终是 `0.x`**：122 条 minor 线，三年多没有进 1.0。
我们没有找到官方对此的公开说明，仅作为事实记录。

---

## 参考资料

**一手来源（本文事实层的主要依据）：**

- **本地源码 clone**：`promptfoo/promptfoo` `main` 分支，
  HEAD = `49c0f6d7`（2026-08-08），非 shallow，9,332 个提交。
  凡属源码结论本文都给出 `路径:行号`。
- **仓库内文档源文件**：`site/docs/**/*.md`（371 页），不是渲染后的网页
- **`CHANGELOG.md`**：742,926 字节 / 424 个版本条目
- **GitHub REST API**：`/repos/promptfoo/promptfoo`、`/languages`
  （Stars / forks / issues / 语言占比）
- **npm registry**：[`promptfoo`](https://www.npmjs.com/package/promptfoo)
  （419 个版本的时间线、包体积、依赖数、engines）
- 官方文档站：[promptfoo.dev/docs](https://www.promptfoo.dev/docs/intro/)

**同系列：**

- [LiteLLM 深入研究（2026-08 快照）](./ref-litellm.md)——
  **与本篇关系最近的一篇**：LiteLLM 是 promptfoo 的 provider 之一
  （`litellm:` 前缀，§8.1），两篇合起来能看清「网关层」与「评测层」的分工；
  那篇也记录了一个同类问题——五个数据源给出五个不同的 provider 数，
  与本文 §8.1 的「89 前缀 / 90 文档页 / 厂商数互不相等」是同一种计数陷阱。
- [Claude Code 深入研究（2026-08 快照）](./ref-claude-code.md)——
  promptfoo 可以把它当被测目标（`anthropic:claude-code` provider，§8.3），
  §6.2 的 13 个 `coding-agent:*` 插件测的就是这类 agent 的安全边界
- [OpenAI Codex 深入研究（2026-08 快照）](./ref-codex.md)
- [opencode 深入研究（2026-08 快照）](./ref-opencode.md)
- [Gemini CLI 深入研究（2026-08 快照）](./ref-gemini-cli.md)

---

::: tip 本文没有验证的部分（照实列出）
这一篇的证据形态是**本地源码 + 公开信息交叉核验**，
但**我们没有把 promptfoo 跑起来做端到端实测**。以下几处是明确**未能核验**的：

**未运行验证的行为类断言：**

- **§7 的托管推理行为**：117 个插件在 `PROMPTFOO_DISABLE_REMOTE_GENERATION=true`
  下返回空数组——这是**读代码得出**的（`src/redteam/plugins/index.ts:656`），
  我们没有实际跑一次红队来观察最终报告里这些项如何呈现。
  「报告层是否有提示」这个问题**我们没有答案**。
- **§16.2 缓存命中导致 turn span 缺失**：官方文档写明的行为，我们未复现。
- **§18 `modelaudit` 的 31 个扫描器**：数的是**文档标题**，
  不是 Python 包里的实现——`modelaudit` 不在这个仓库里，我们没有查它的源码。
  它的实际扫描能力与文档是否一致，未核验。
- **§4.1 配置扩展名优先级**：从 `src/util/config/default.ts:48` 的
  `break` 语义推出「同目录下 `.ts` 会被 `.yaml` 遮蔽」，未实测。

**无法从外部验证的厂商口径：**

- **§20.2 遥测采集边界**（「不采集 prompt 内容 / 模型响应 / API key」）——
  只能记为厂商声明。我们能确证的只是**关闭开关确实生效**。
- **§7.4 托管端点的数据处理**（`api.promptfoo.app` 收到数据后如何留存）
- **§21 Enterprise 的全部能力**——不在开源仓库里，无源码可查，
  包括「On-Prem 提供所有插件的自托管推理」与「air-gapped 运行」这两条关键声明。
- **§19 code scan 的实际检出能力**——服务端是闭源的，
  「追踪数据流深入代码库」这个描述我们无法核验。

**未能查明的事实：**

- **§3 发版放缓的原因**——数据是真的，解释我们给不出。
- **§22 三年多未进 1.0 的原因**——未找到官方说明。
- **`0.115.x` 之前的完整功能演进**——CHANGELOG 早期条目粒度较粗，
  「首次提及」与「功能可用」的差距在早期版本上更大。
- **实际性能与成本**——本文没有任何一个数字来自我们跑出来的运行结果。

这些地方本文用「未核验」明确标注，而不是含糊过去。
:::
