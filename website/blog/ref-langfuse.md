---
title: Langfuse 深入研究（2026-08 快照）
description: 22 章逐节成册，按目录跳章查阅——把 Langfuse 的产品形态、架构与实现细节交叉核验到版本号级别：一个名字下三个不同的「v4」、v3/v4 两条发布线并行维护、v4 用 events 表取代 traces/observations、37 个队列、79 个 MCP 工具、376 个环境变量、企业许可校验只是一次字符串前缀匹配。这是一份手册，不是读完就走的文章。
date: "2026-08-09"
series: 热点开源项目研究
audience: engineer
highlight: 22 章逐节可查 · 核验至服务端 v4.6.0 / 本地源码 4.0.0-rc.3 · 截至 2026-08-09 快照
tags: [Langfuse, LLM 可观测性, 深入研究, OpenTelemetry, 评测, ClickHouse, MCP, 参考]
outline: [2, 3]
---

# Langfuse 深入研究（2026-08 快照）

::: warning 先说清这份东西是什么
**这是一份逐章查阅的手册，不是一篇文章。** 它按章节组织，供你按目录跳到需要的那一节查，
而不是从头读到尾——所以它没有主线，也没有结论。

- **调研日期**：2026-08-09
- **被调研版本**：
  - 服务端最新发布 **v4.6.0**（2026-08-06），`main` 分支 `package.json` 版本号同为 **4.6.0**
  - **本地 clone 停在 `main` 的 `HEAD = 90b98d00`（2026-07-29），`package.json` = `4.0.0-rc.3`**
  - Python SDK：PyPI `langfuse` = **4.14.3**（2026-08-06）
  - JS/TS SDK：npm `@langfuse/*` = **5.10.0**（2026-07-31）
- **一条必须先说的证据边界**：**本地检出比线上落后约 6 个发布**
  （rc.3 → 4.0.0 → 4.1.0 → … → 4.6.0）。凡本文标「源码实查」的计数，
  数的都是 `90b98d00` 这个检出，**不是 v4.6.0 的发布状态**。
  涉及「当前值」的断言我都回 GitHub raw 复核过 `main`，并在文中标明哪个是哪个。
  这条边界不是免责声明——§4.4 就有一处实测到的差异（本地 `docker-compose.yml`
  仍写 `langfuse:3`，而 `main` 与 `v4.6.0` 标签上已是 `:4`）。
- **证据形态**：**本地源码实查 + GitHub REST API / npm registry / PyPI JSON API 实查**。
  凡属源码结论本文都给出 `路径:行号` 或可复现的命令；
  Star 数 / 语言占比 / 版本时间线取自 API 实查（原始 JSON 落盘到 `/tmp/lf/` 后只打印摘要）。
- **一手性说明**：计数类事实全部由脚本数出，不是目测；且**每个数字都标了口径**
  （§2.2 记录了一次我自己先数错的经过）。
  **本文没有把 Langfuse 跑起来做端到端实测**——没有起 ClickHouse、没有发过一条 trace。
  所有行为类断言都是「读代码/读迁移文件得出」，文末 §22 逐条列了哪些因此未能核验。
- **时效边界**：Langfuse 2026-07 一个月发了 **38 个版本**（§4.1）。
  **这是 2026-08-09 的快照，不是最新状态。**
  任何与当前行为不一致的地方，以[官方文档](https://langfuse.com/docs)为准。
  尤其注意：**v4 迁移开关的默认值是本文最容易过期的一层**（§7 说明了原因）。

一份标清日期的快照不会变成假话，只会变成史料——但前提是你知道它的日期。
:::

::: danger 四条广为流传、但截至本快照需要修正的说法
读 Langfuse 的第三方介绍（乃至它自己仓库里的部分文件）时，这几条几乎必然会遇到：

1. **「Langfuse 现在是 v4」**——**这句话没有唯一指代**。截至本快照，
   同一个名字下有**三个互不相干的版本号在同时演进**：
   服务端 **4.6.0**、Python SDK **4.14.3**、JS/TS SDK **5.10.0**。
   更容易踩的是：**Python SDK 的 v4 比服务端的 v4 早了五个月**
   （`4.0.0b1` 于 2026-02-24 上 PyPI，服务端 `v4.0.0` 是 2026-07-29），
   两者的「4」没有任何对齐关系。见 §1.2。
2. **「`npm install langfuse` 装的是 JS SDK」**——**装到的是上一代**。
   不带 scope 的 `langfuse`、`langfuse-core`、`langfuse-langchain`、`langfuse-vercel`
   四个包属于 legacy v3 SDK，latest 停在 **3.38.20（2026-04-01）**；
   现行 SDK 是 `@langfuse/*` 系列（**5.10.0**，2026-07-31）。
   **这四个旧包在 npm 上并没有被标记 `deprecated`**（实测 registry 的
   `versions[latest].deprecated` 为空），所以 `npm i langfuse` 不会有任何警告——
   只有 `langfuse-js` 仓库的 README 里用一个 `[!IMPORTANT]` 块说明了这件事。见 §21。
3. **「Langfuse 是 MIT 开源」**——**主体是，但有三个例外目录**，
   且 GitHub API 报告的 license 字段是 **`NOASSERTION`**（不是 `MIT`）。
   `ee/`、`web/src/ee/`、`worker/src/ee/` 三个目录走 `ee/LICENSE`
   定义的 Langfuse Enterprise License，需要有效商业许可才能使用。见 §3。
4. **「traces 和 observations 是它的两张核心表」**——**v4 起不是了**。
   v4 用 `events_full` / `events_core` 两张 ClickHouse 表取代了
   `traces` / `observations`，且**已经把旧表 DROP 掉**
   （`feat(v4)!: drop superseded Postgres and ClickHouse tables`，2026-07-24）。
   净新部署的默认写入模式是 `events_only`，根本不写旧表。见 §6、§7。

另有一条不算「过期说法」但值得先知道：**v3 并没有停止发布**。
`v3.225.1` 发布于 **2026-08-05**，比 `v4.0.0`（2026-07-29）**更晚**——
两条线在并行维护，看版本号高低判断新旧会错。见 §4.2。
:::

---

## 1. 定位与身份辨析

### 1.1 它是什么

Langfuse 由 Langfuse GmbH 开发（YC W23），GitHub 仓库简介自称
**"Open source AI engineering platform: LLM evals, observability, metrics, prompt management, playground, datasets"**。

**核心数据（2026-08-09，GitHub API 与 registry 实查）：**

- GitHub Stars：**32,746**；Forks：**3,515**；Open Issues：**759**；Watchers：106
- 仓库创建：**2023-05-18**；最近 push：2026-08-08；默认分支 `main`
- 语言占比：**TypeScript 98.34%**、JavaScript 0.98%、Shell 0.27%、CSS 0.14%、
  **Python 0.12%**、MDX 0.07%、Dockerfile 0.05%、PLpgSQL 0.03%
- 仓库体积（API `size` 字段）：**209,936 KB**
- 本地 clone：**8,233 个提交**，非 shallow（`git rev-parse --is-shallow-repository` = `false`），
  所以本文的「何时引入」类断言可以用 git 历史佐证

⚠ **那 0.12% 的 Python 不是 SDK。** Python SDK 在独立仓库
`langfuse/langfuse-python`。主仓里的 Python 是脚本（`scripts/`、迁移辅助等）。
这和 `ref-claude-code` 那篇记的坑是同一个：
**GitHub 的 `language` 字段反映仓库里的字节数，不是产品的实现语言。**

### 1.2 一个名字，三个「v4」

这是研究 Langfuse 时最容易出错的地方，所以放在第一章。

| 事物 | 分发渠道 | 截至本快照的版本 | 该大版本首发 |
| --- | --- | --- | --- |
| **服务端**（web + worker） | Docker 镜像 / 自部署 | **4.6.0**（2026-08-06） | `v4.0.0-rc.0` 2026-07-23；`v4.0.0` 2026-07-29 |
| **Python SDK** | PyPI `langfuse` | **4.14.3**（2026-08-06） | `4.0.0b1` **2026-02-24** |
| **JS/TS SDK** | npm `@langfuse/*` | **5.10.0**（2026-07-31） | v5 重写，**2026-03** 发布 |

三条线**各自独立编号，互不对齐**：

- **Python SDK 的 v4 比服务端的 v4 早五个月**。写「Langfuse v4 引入了 X」时
  必须说清是哪个 v4，否则读者无法判断该升哪个包。
- **JS SDK 已经到 v5，而服务端才 v4**。JS 的大版本号比服务端**高一位**，
  这个错位来自 SDK 侧的一次重写（§21.1），与服务端演进无关。
- 服务端**不发布到 npm**：仓库里 9 个 `package.json` **全部 `private: true`**（§2.1），
  它只通过 Docker 镜像与自部署分发。

**引用任何 Langfuse 版本号时，包名/组件名是必填项。** 这条和
`ref-litellm` 记的「LiteLLM 这个名字下装着 SDK 与 Gateway 两个形态」是同类问题，
但 Langfuse 更严重一层：LiteLLM 两个形态**共享**一个版本号，
Langfuse 三个组件是**三个独立的版本号**。

### 1.3 本文按「面」拆，不二选一

Langfuse 同时是**平台**（你部署它、配置它、在 UI 里用它）和**库**
（你 `import` 它的 SDK，被它的 API 约束）。
按研究方法论的分流判据（读者是「用它」还是「基于它写代码」），这是个中间形态。
本文的处理是**按面拆**：

- **§2–§20 走产品路线**：部署形态、存储、队列、API 面、权限、商业边界。
- **§21 走框架路线**：包拓扑、版本矩阵、升级边界、弃用机制——
  因为 SDK 读者最怕的事不是「行为变了」，而是「升个版本我的代码跑不了了」。

## 2. 仓库拓扑与规模

### 2.1 monorepo 结构：9 个包，全部不发布

pnpm workspace（`pnpm-workspace.yaml`）声明的工作区是 `web`、`worker`、`packages/**`、`ee`。
实测 9 个 `package.json`：

| 包名 | 版本 | 位置 | 说明 |
| --- | --- | --- | --- |
| `langfuse` | 4.0.0-rc.3 | 根 | monorepo 根，仅脚本编排 |
| `web` | 4.0.0-rc.3 | `web/` | Next.js 应用（UI + API + tRPC） |
| `worker` | 4.0.0-rc.3 | `worker/` | 后台任务进程 |
| `@langfuse/shared` | 1.0.0 | `packages/shared/` | 共享层：Prisma、ClickHouse、队列、领域模型 |
| `@langfuse/ee` | 1.0.0 | `ee/` | 企业许可判定（**共 16 行代码**，§18） |
| `@repo/eslint-config` | 0.0.0 | `packages/config-eslint/` | 内部配置 |
| `@repo/typescript-config` | 0.0.0 | `packages/config-typescript/` | 内部配置 |
| `@repo/eslint-plugin` | 0.0.0 | `packages/eslint-plugin/` | 内部 lint 规则 |
| `@repo/in-app-agent-sandbox-runtime` | 0.0.0 | `packages/in-app-agent-sandbox-runtime/` | 沙箱运行时（§14.2） |

**九个全部 `private: true`。** 三个组件版本号一致（`4.0.0-rc.3`），
两个 `@langfuse/*` 停在 `1.0.0`，三个 `@repo/*` 停在 `0.0.0`——
**版本号在这个 monorepo 里只对前三个有意义**，其余是占位。

根 `package.json` 要求 **Node 24**（`engines.node: "24"`，精确值不是范围）。
构建编排用 turbo（`turbo.json`），包管理器强制 pnpm（`preinstall: npx only-allow pnpm`）。

### 2.2 规模：口径与一次数错的经过

| 区域 | 文件数（`.ts`+`.tsx`） | 行数 |
| --- | --- | --- |
| `web/src` | 2,422 | 559,592 |
| `worker/src` | 319 | 110,172 |
| `packages/shared/src` | 528 | 105,764 |
| `ee/src` | 3 | **16** |
| **合计（全仓 ts/tsx）** | **3,351** | — |

测试文件（`*.test.ts(x)` / `*servertest*` / `*clienttest*`）共 **663 个**。

⚠ **一次口径错误，留在这里作样本。** 数 `web/src/features` 时
`ls web/src/features | wc -l` 返回 **76**，而真实目录数是 **75**——
多出的一个是 `README.md`。正确口径是
`find web/src/features -maxdepth 1 -mindepth 1 -type d | wc -l`。

同一个坑在 §13.1 数 MCP 工具时以更隐蔽的形态又出现了一次
（两个口径给出 78 和 79，且**两个都不能直接用**），那一处记录了完整的排查过程。
**「所有计数写脚本数」只解决了「不靠目测」，没有解决「口径选得对不对」。**

功能目录数（已用 `-type d` 口径）：

- `web/src/features`：**75** 个
- `web/src/ee/features`：**8** 个（`admin-api`、`audit-log-viewer`、`billing`、
  `multi-tenant-sso`、`sfdc-sync`、`sso-settings`、`ui-customization`、`verified-domains`）
- `worker/src/features`：**30** 个
- `worker/src/ee`：**5** 个（`cloudSpendAlerts`、`cloudUsageMetering`、
  `dataRetention`、`meteringDataPostgresExport`、`usageThresholds`）

### 2.3 依赖治理：一条值得抄的供应链约定

`pnpm-workspace.yaml` 里有一条不常见的配置：

```yaml
# 5 day delay for new dep upgrades to reduce supply chain attack risk
minimumReleaseAge: 7200
```

**7200 分钟 = 整 5 天**：任何依赖的新版本发布不足 5 天，pnpm 拒绝安装。
这是针对「投毒包发布后数小时内被广泛拉取」这类供应链攻击的机械化防线。
配合 `minimumReleaseAgeExclude` 做逐版本豁免（实测 21 条，注释标明是临时项，
「this list is version-specific」）。

`overrides` 段里有若干条带 CVE 注释的强制降级/升级，例如：

```yaml
# ReDoS only affects the 8.x line (CVE-2026-4926/-4923, >=8.0.0 <8.4.0).
path-to-regexp@8.3.0: 8.4.0
```

以及一条记录了「别名依赖无法被范围键命中」的实战教训：

```yaml
# @mastra/core pins its provider-utils-v6 alias to exactly 4.0.27, which the
# range key can't catch — aliased deps need alias-name overrides.
"@ai-sdk/provider-utils-v6": "npm:@ai-sdk/provider-utils@4.0.33"
```

**描述与评价分离**：这套约定的代价是新依赖上线有 5 天延迟，
且豁免清单需要人工维护（注释自己说是 temporary）。

## 3. 许可边界：MIT 加三个例外目录

根 `LICENSE` 的结构是 open-core：

> - All content that resides under the **"ee/"**, **"web/src/ee/"**, and/or
>   **"worker/src/ee/"** directories of this repository, if these directories exist,
>   is licensed under the license defined in "ee/LICENSE".
> - Content outside of the above mentioned directories … is available under the
>   **"MIT Expat"** license.

`ee/LICENSE` 是 Langfuse Enterprise License，关键条款：

- 使用需要「有效的 Langfuse Enterprise License」或同意其 Terms of Service
- **允许**为开发和测试目的复制修改，无需订阅
- **禁止** copy / merge / publish / distribute / sublicense / sell
- 对该软件的任何修改与补丁，权利归 Langfuse GmbH

**三个 EE 目录的实测规模**：`ee/src` 3 个文件 **16 行**；
`web/src/ee/features` 8 个目录；`worker/src/ee` 5 个目录。
即**绝大部分代码是 MIT**，EE 部分集中在计费、SSO、审计日志查看器、
UI 定制、数据保留、云计量这些「企业外围」。

⚠ **GitHub API 的 license 字段是 `NOASSERTION`，不是 `MIT`。**
这是混合许可的自动识别结果。任何依据 API license 字段做合规判断的工具
（包括 SCA 扫描器）都会在这里得到「未识别」而不是「MIT」——
如果你的合规流程要求依赖必须是已识别的宽松许可，这一条会触发人工审核。

## 4. 发版节奏与双线并行

### 4.1 节奏：两个月内 73 个版本

从 GitHub Releases API 拉了 **200 条** release（最老到 `v3.95.0`，2025-08-07）。
按月统计（含 v3 与 v4 两条线）：

| 月份 | 版本数 |
| --- | --- |
| 2026-01 | 7 |
| 2026-02 | 8 |
| 2026-03 | 8 |
| 2026-04 | 14 |
| 2026-05 | 6 |
| **2026-06** | **35** |
| **2026-07** | **38** |
| 2026-08（至 08-06） | 7 |

**2026-06 起节奏跳了一个量级**（6→35），与 v4 的准备期重合：
v4 的 ClickHouse events 表在 2026-07-23 落地（§6.2），
`v4.0.0-rc.0` 同日发布，`v4.0.0` 六天后（07-29）发布。

### 4.2 v3 与 v4 在并行维护

这是看版本号最容易误判的地方。按发布时间排列最近的几个：

| 发布日 | 标签 | 线 |
| --- | --- | --- |
| 2026-08-06 | `v4.6.0` | v4 |
| 2026-08-06 | `v4.5.0` | v4 |
| **2026-08-05** | **`v3.225.1`** | **v3** |
| 2026-08-04 | `v4.4.0` | v4 |
| 2026-08-03 | `v4.3.1` / `v4.3.0` | v4 |
| **2026-08-03** | **`v3.225.0`** | **v3** |
| 2026-07-31 | `v4.2.0` | v4 |
| 2026-07-30 | `v4.1.0` | v4 |
| **2026-07-30** | **`v3.224.4`** | **v3** |
| 2026-07-29 | **`v4.0.0`** | v4 |

**`v3.225.1`（08-05）比 `v4.0.0`（07-29）晚发布一周。**
v3 线仍在收 patch 与 minor，不是冻结状态。
实际影响：**「最新版本」这个说法在 Langfuse 上需要指定线**，
而 v3/v4 的默认行为在关键配置上是相反的（§7.1）。

四个 rc 全部集中在两天内：`v4.0.0-rc.0` 与 `rc.1` 同在 2026-07-23，
`rc.2` 07-24，`rc.3` 07-27，正式版 07-29。

### 4.3 本地检出与线上的差距

本地 clone 的 `HEAD = 90b98d00`（2026-07-29），`package.json` = `4.0.0-rc.3`。
**注意 rc.3 的标签发布于 07-27，而这个 commit 是 07-29**——
即本地检出是 rc.3 之后、`v4.0.0` 正式版前后的开发态，`package.json` 尚未 bump。
到本快照日（08-09），线上已是 4.6.0，**落后约 6 个发布**。

### 4.4 一处实测到的本地/线上差异

本地 `docker-compose.yml` 的镜像标签：

```yaml
image: docker.io/langfuse/langfuse-worker:3   # 本地检出
image: docker.io/langfuse/langfuse:3
```

**这在本地检出上是真的，但不是当前状态。** 回 GitHub raw 复核：
`main` 与 `v4.6.0` 标签上两处都已是 `:4`，
翻转发生在 `chore(release): flip Docker latest markers to the v4 line`（#15607）。

**这一处值得单独写出来，因为它正是「照抄检出状态当现状」会出的错。**
如果我只读本地 clone 就下结论，会写出「Langfuse 官方 compose 仍指向 v3 镜像」
这种**在快照日已经不成立**的断言。
方法论上的对策只有一条：**涉及「当前默认值」的断言，必须回 `main` 或 tag 复核**，
本地检出只能支撑「某个 commit 上是什么样」。

## 5. 存储层：四个数据存储

Langfuse 自部署需要**四个**外部依赖，不是一个数据库。
从 `docker-compose.yml` 实测 6 个服务：

| 服务 | 镜像（本地检出值） | 角色 |
| --- | --- | --- |
| `langfuse-web` | `langfuse/langfuse:3`（`main` 已为 `:4`） | Next.js：UI + 公开 API + tRPC |
| `langfuse-worker` | `langfuse/langfuse-worker:3`（同上） | 后台队列消费 |
| `postgres` | `postgres:${POSTGRES_VERSION:-17}` | 事务型元数据（67 张表，§5.1） |
| `clickhouse` | `clickhouse/clickhouse-server:25.12` | 事件/观测数据（列存，§6） |
| `redis` | `redis:7` | 队列（BullMQ）+ 缓存 + 限流 |
| `minio` | `cgr.dev/chainguard/minio` | S3 兼容对象存储（事件原文、媒体、导出） |

ClickHouse 被钉到 `25.12`（`build: remove pg 12 from CI and pin CH to 25.12 in docker-compose`）。
MinIO 用的是 Chainguard 镜像，git 历史注明原因是
`fix(docker): replace unmaintained minio image with chainguard/minio`。

另有三份变体 compose：`docker-compose.dev.yml`、`docker-compose.dev-azure.yml`
（Azurite 替代 S3）、`docker-compose.dev-redis-cluster.yml`（6 节点 Redis 集群）。

### 5.1 Postgres：67 张表，428 个迁移

`packages/shared/prisma/schema.prisma`：**1,760 行，67 个 `model`，30 个 `enum`**。
迁移目录 `packages/shared/prisma/migrations/` 下 **428 个 `migration.sql`**，
最早 `20230518191501_init`（与仓库创建同日），
最新三个都在 2026-07-23（`drop_dataset_run_items_table`、
`drop_legacy_tracing_tables`、`add_remote_experiment_auth_headers`）。

Postgres 承载的是**元数据与配置**，不是 trace 数据。按 `@@map` 的真实表名分类：

- 组织与租户：`organizations`、`projects`、`organization_memberships`、
  `project_memberships`、`membership_invitations`、`api_keys`、`users`、`sso_configs`、
  `verified_domains`
- Prompt 管理：`prompts`、`prompt_dependencies`、`prompt_protected_labels`
- 评测：`eval_templates`、`job_configurations`、`job_executions`、`monitors`
- 数据集与标注：`datasets`、`dataset_items`、`dataset_runs`、`annotation_queues`、
  `annotation_queue_items`、`annotation_queue_assignments`、`score_configs`
- 集成：`posthog_integrations`、`mixpanel_integrations`、`blob_storage_integrations`、
  `slack_integrations`、`web_callout_endpoints`
- 自动化：`actions`、`triggers`、`automations`、`automation_executions`
- 模型与计费：`models`、`prices`、`pricing_tiers`、`llm_api_keys`、`llm_schemas`、
  `llm_tools`、`billing_meter_backups`、`cloud_spend_alerts`
- In-App Agent（§14）：`in_app_agent_conversations`、`in_app_agent_events`、
  `in_app_agent_runs`、`in_app_agent_pending_tool_approvals`
- 运维：`audit_logs`、`background_migrations`、`cron_jobs`、`batch_exports`、
  `batch_actions`、`pending_deletions`、`media`、`surveys`

⚠ **`trace_media` / `observation_media` / `dataset_item_media` 仍在 Postgres**，
即媒体的**关联关系**留在 Postgres，媒体本体在 S3。

## 6. v4 的核心变更：events 表取代 traces / observations

### 6.1 ClickHouse 迁移的形态

`packages/shared/clickhouse/migrations/` 下有两个平行目录：
`clustered/` 与 `unclustered/`，**各 46 个 `.up.sql`**（各 92 个文件含 `.down.sql`）。
即每个 schema 变更都要写两份——单机与集群两套 DDL。

从 `unclustered/` 的 `CREATE TABLE` / `DROP TABLE` 语句还原表的历史：

| 表 | 引入 | 状态 |
| --- | --- | --- |
| `traces` | `0001_traces` | **v4 已 DROP** |
| `observations` | `0002_observations` | **v4 已 DROP** |
| `scores` | `0003_scores` | 保留 |
| `event_log` | `0007_add_event_log` | `0044_drop_event_log` 移除 |
| `project_environments` | `0009` | `0045_drop_project_environments` 移除 |
| `blob_storage_file_log` | `0011` | 保留 |
| `dataset_run_items` | 中期引入 | `0046_drop_dataset_run_items` 移除 |
| `dataset_run_items_rmt` | 中期引入 | 保留（`_rmt` = ReplacingMergeTree） |
| `traces_null` / `traces_{7d,30d,all}_amt` | 中期引入 | 全部已 DROP |
| `observations_batch_staging` | `0038` | 保留 |
| **`events_full`** | **`0039_create_events_full`** | **v4 主表** |
| **`events_core`** | **`0040_create_events_core`** | **v4 查询表** |
| `events_core_mv` | `0041_create_events_core_mv` | 物化视图 |

### 6.2 引入时间与破坏性提交

git 历史给出确切日期：

- `0039`–`0041`（events 表 + 物化视图）：
  **2026-07-23**，commit `eaa34c3e7`
  `feat(v4): promote events tables to CH migration and flip v4 env defaults (#14812)`
- 旧表清理：**2026-07-24**，commit `340c3c850`
  `feat(v4)!: drop superseded Postgres and ClickHouse tables (#15369)`
  ——注意 `!` 标记，这是 conventional commits 的破坏性变更标识

即 **events 表落地与旧表删除只隔一天**，都在 `v4.0.0-rc` 期间。

### 6.3 events_full 与 events_core 的分工

两张表的列定义前半部分**完全一致**（project_id / trace_id / span_id /
parent_span_id / start_time / end_time / name / type / environment / version /
release / trace_name / user_id / session_id / tags / level / status_message /
completion_start_time / is_app_root / bookmarked / public / prompt_* / model_*），
差异在尾部：`events_full` 带 I/O 正文，`events_core` 不带。

`events_full` 独有的部分（`0039_create_events_full.up.sql`）：

```sql
-- I/O
input String CODEC(ZSTD(3)),
input_length UInt64 MATERIALIZED lengthUTF8(input),
```

`events_core` 由 `events_core_mv` 物化视图从 `events_full` 派生。
**这是列存的典型分层**：把大字段（LLM 的 input/output 正文，ZSTD(3) 压缩）
与查询常用的窄列分开，列表页扫窄表，详情页才读宽表。

`events_full` 里几个值得注意的列设计：

- **成本按 Map 存 + 物化计算列**：
  `cost_details Map(LowCardinality(String), Decimal(18,12))`，
  再用 `MATERIALIZED arraySum(mapValues(mapFilter(...)))` 派生
  `calculated_input_cost` / `calculated_output_cost` / `calculated_total_cost`，
  匹配规则是**键名里含 `input` / `output` 的大小写不敏感子串匹配**
  （`positionCaseInsensitive(x.1, 'input') > 0`）。
  即成本维度是开放的（任意 usage key），代价是**键名命中靠子串**——
  一个叫 `input_cache_read` 的键会被计入 input 成本。
- `total_cost` 是 `ALIAS cost_details['total']`，与上面三个 `MATERIALIZED` 列口径不同
- **工具调用是一等列**：`tool_definitions Map(String, String)`、
  `tool_calls Array(String)`、`tool_call_names Array(String)`
- 定价分层：`usage_pricing_tier_id` / `usage_pricing_tier_name`（Nullable）
- 时间精度 `DateTime64(6)`（微秒）

## 7. v4 迁移开关：三个 flag 与三种被禁止的组合

这是 v4 最需要读源码的一节，因为**默认值在 v3 与 v4 之间是反的**。

### 7.1 三个 flag 与默认值

`worker/src/env.ts:507` 起（注释引用内部工单 LFE-9778）：

| 环境变量 | 取值 | v4 默认 | v3 默认（注释所述） |
| --- | --- | --- | --- |
| `LANGFUSE_MIGRATION_V4_WRITE_MODE` | `legacy` \| `dual` \| `events_only` | **`events_only`** | `legacy` |
| `LANGFUSE_MIGRATION_V4_NATIVE_OTEL_BEHAVIOUR` | `dual_write` \| `direct` | **`direct`** | `dual_write` |
| `LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN` | `true` \| `false` | **`true`** | `false` |

源码注释原文：

> Defaults reflect the Langfuse v4 target state: net-new deployments write
> straight into the events tables. The v3 line ships these as `legacy` /
> `dual_write` / `false`; local dev and CI pin explicit values via
> `.env.dev*.example`, so these defaults only apply to bare deployments.

⚠ **两处口径提醒**：
① 这三个默认值**只对「裸部署」生效**——本地开发与 CI 在 `.env.dev*.example` 里
显式钉了值，所以你在 dev 环境观察到的行为可能不是默认行为。
② `LANGFUSE_MIGRATION_V4_WRITE_MODE` 在
`packages/shared/src/env.ts:317` 有**第二份声明**，默认值同为 `events_only`，
注释明写「keep this value in sync with worker/src/env.ts and web/src/env.mjs」——
**同一个开关在三处各声明一次，靠注释维持一致**，没有机制保证。

两个背景迁移开关（`worker/src/env.ts:524`）：

- `LANGFUSE_BACKGROUND_MIGRATION_V4_ENABLE_HISTORIC_BACKFILL` 默认 **`true`**
  （注释：对无历史数据的净新部署是 no-op）
- `LANGFUSE_BACKGROUND_MIGRATION_V4_DROP_PID_TID_SORTING_TABLES` 默认 **`false`**
  （注释：保持 opt-in，等运维确认 backfill 成功后再删中间产物）

### 7.2 被显式拒绝的三种组合

`validateV4Flags()`（`worker/src/env.ts:611` 起）在启动时抛错，
三条规则各自带了「为什么会丢数据」的解释：

| 组合 | 报错原因（源码原文摘要） |
| --- | --- |
| `WRITE_MODE=legacy` + `OTEL=direct` | Direct OTel writes target `events_full`, which is **not read** in legacy mode |
| `WRITE_MODE=events_only` + `OTEL=dual_write` | would dual-write to legacy tables the deployment otherwise skips（不一致） |
| `WRITE_MODE=events_only` + `ALLOW_PREVIEW_OPT_IN=false` | Web reads are gated **solely** on the opt-in flag; without it they target the legacy `traces`/`observations` tables that `events_only` mode no longer writes to |

**第三条揭示了一个架构事实**：**写路径与读路径由不同的 flag 控制**。
写走 `WRITE_MODE`，而 **web 端的读只看 `ALLOW_PREVIEW_OPT_IN`**。
两者不一致时的后果是「写进 events 表、却去 legacy 表查」——
即 UI 上什么都看不到。这个校验是把静默故障转成启动期硬失败。

配套的三个 helper（同文件）：

```ts
export const v4WritesToEventsTable = (e) => e.LANGFUSE_MIGRATION_V4_WRITE_MODE !== "legacy";
export const v4WritesToLegacyTables = (e) => e.LANGFUSE_MIGRATION_V4_WRITE_MODE !== "events_only";
export const v4ForceDirectOtelWrite = (e) => e.LANGFUSE_MIGRATION_V4_NATIVE_OTEL_BEHAVIOUR === "direct";
```

注意前两个都是**否定式**：`dual` 模式下两个都为 `true`（双写）。

### 7.3 迁移期的读路径仍然双轨

实测 `packages/shared/src/server/repositories/` 下：

- `FROM traces` 出现 **23 处**
- `FROM events_full` / `FROM events_core` 出现 **17 处**

**旧表的查询代码还在**（因为 `legacy` / `dual` 模式仍受支持），
`repositories/` 里同时存在 `traces.ts` / `observations.ts` 与
`events.ts` / `events-stream.ts` 两套。
⚠ 这两个数字是 `grep` 的**字符串出现次数**，不是「代码路径数」，
也不代表某一路径在默认配置下可达——我没有做可达性分析。

### 7.4 背景迁移：12 个

`worker/src/backgroundMigrations/` 下 **12 个 `.ts`**（该口径含
`backgroundMigrationManager.ts` 与 `IBackgroundMigration.ts` 两个非迁移文件，
故实际迁移实现是 10 个）：

`backfillEventsFullFromObservations`、`backfillEventsFullFromDatasetRunItems`、
`createRootSpansFromTraces`、`rewriteObservationsToPidTidSorting`、
`dropPidTidSortingTables`、`backfillBillingCycleAnchors`、
`backfillSysIdForDatasetItems`、`backfillValidToForDatasetItems`、
`encryptBlobStorageSecrets`、`patchLLMToolAndLLLMSchemaAuditLogs`
（最后一个的文件名里 `LLLM` 是仓库里的拼写，不是本文笔误）。

前三个就是 v4 数据搬迁的实现。发现机制是**按 env 前缀扫描**：
`LANGFUSE_BACKGROUND_MIGRATION_` 前缀让 `BackgroundMigrationManager`
能通过扫 env 键来发现开关，每个开关经 `background_migrations` 表的 `args.envGate` 生效。

## 8. 摄取管线：18 种事件类型

### 8.1 事件类型清单

`packages/shared/src/server/ingestion/types.ts:279` 的 `eventTypes` 共 **18 项**：

| 常量 | wire 值 | 组 |
| --- | --- | --- |
| `TRACE_CREATE` | `trace-create` | trace |
| `SPAN_CREATE` / `SPAN_UPDATE` | `span-create` / `span-update` | 观测（旧式，按类型分） |
| `GENERATION_CREATE` / `GENERATION_UPDATE` | `generation-create` / `generation-update` | 同上 |
| `EVENT_CREATE` | `event-create` | 同上 |
| `AGENT_CREATE` | `agent-create` | 同上 |
| `TOOL_CREATE` | `tool-create` | 同上 |
| `CHAIN_CREATE` | `chain-create` | 同上 |
| `RETRIEVER_CREATE` | `retriever-create` | 同上 |
| `EVALUATOR_CREATE` | `evaluator-create` | 同上 |
| `EMBEDDING_CREATE` | `embedding-create` | 同上 |
| `GUARDRAIL_CREATE` | `guardrail-create` | 同上 |
| **`OBSERVATION_CREATE` / `OBSERVATION_UPDATE`** | `observation-create` / `observation-update` | **通用（类型作为字段）** |
| `SCORE_CREATE` | `score-create` | 评分 |
| `DATASET_RUN_ITEM_CREATE` | `dataset-run-item-create` | 数据集 |
| `SDK_LOG` | `sdk-log` | SDK 自身日志 |

**注意最后引入的那对 `observation-create` / `observation-update`**：
它与前面 11 个按类型分列的事件是**两种表达同一件事的方式**——
旧式把观测类型编码进事件名，新式把类型作为 payload 字段。
两套并存意味着摄取端必须同时接受两种形态。

### 8.2 观测类型：10 种

`packages/shared/src/domain/observations.ts:5` 的 `ObservationType` 共 **10 种**：
`SPAN`、`EVENT`、`GENERATION`、`AGENT`、`TOOL`、`CHAIN`、`RETRIEVER`、
`EVALUATOR`、`EMBEDDING`、`GUARDRAIL`。

同一份清单在该文件里**写了两遍**——一次作为 `as const` 对象（第 5 行），
一次作为 `z.enum([...])` 数组（第 18 行），两处手写维护，
没有从其中一个派生另一个。⚠ 这类重复是漂移隐患（加第 11 种类型要改两处），
但**我没有在仓库里找到检测两处一致性的测试**，
所以「是否有机制保证」这一点未能核验。

观测级别 `ObservationLevel` 4 种：`DEBUG` / `DEFAULT` / `WARNING` / `ERROR`。

### 8.3 评分类型：5 种

`packages/shared/src/domain/scores.ts:46` 的 `ScoreDataTypeArray`：
`NUMERIC`、`CATEGORICAL`、`BOOLEAN`、**`CORRECTION`**、`TEXT`。

`CORRECTION` 是不常见的一种——同文件第 40 行有
`body.dataType !== ScoreDataTypeEnum.CORRECTION` 这样的排除逻辑，
说明它在某些路径上被特殊对待（`web/src/features/corrections` 是独立功能目录）。

### 8.4 写入路径：S3 先落盘，再入队

`processEventBatch.ts`（**525 行**）的设计要点，从源码注释读出：

- **S3 事件上传是阻塞但不致命的**（`// S3 Event Upload is blocking, but non-failing.`）。
  失败时退化为「把整批塞进 Redis 队列」。
- 事件按 `eventBodyId` 分组后上传，注释说明目的是减少 S3 写操作次数。
- 队列 payload 只带 `fileKey`（S3 键），不带正文——
  正文在 S3，队列里是指针。
- 实体 ID 会被 sanitize，因为 `event.id` 会成为 S3 键的单段文件名
  （`<id>.json`），注释明确写了这个耦合。
- 有 S3 限流处理：`isS3SlowDownError` / `markProjectS3Slowdown`。

**这是「先持久化原文、再异步处理」的形态**：S3 是事实源，
ClickHouse 是可重建的派生物。代价是摄取路径依赖对象存储可用性
（虽然做了降级），且一次摄取要碰 S3 + Redis 两个系统。

### 8.5 采样：按项目、按 traceId 哈希

`sampling.ts` 的 `isTraceIdInSample()`：

- 采样配置来自 `LANGFUSE_INGESTION_PROCESSING_SAMPLED_PROJECTS`（项目→采样率的 Map）
- **不在该 Map 里的项目一律不采样**（全量处理）
- 采样单位是 **traceId 的哈希**（`crypto`），不是单条事件——
  保证同一 trace 的所有 span 同进同出，不会出现半棵树
- 取不到 traceId 时默认放行（`isSampled: true`）

三处 fallback 全部**偏向放行**，即采样故障不会丢数据，只会多留数据。

## 9. 队列与后台任务：37 个队列

### 9.1 队列清单

`packages/shared/src/server/queues.ts:370` 的 `QueueName` 枚举共 **37 项**，
`QueueJobs` 共 **34 项**（两者不等——见下）。按职责分组：

**摄取与传播（7）**：`IngestionQueue`、`IngestionSecondaryQueue`、
`OtelIngestionQueue`、`OtelIngestionSecondaryQueue`、`TraceUpsert`、
`EventPropagationQueue`、`EntityChangeQueue`

**评测（5）**：`EvaluationExecution`、`EvaluationExecutionSecondaryQueue`、
`LLMAsJudgeExecution`、`CodeEvalExecution`、`CreateEvalQueue`

**删除与保留（6）**：`TraceDelete`、`ProjectDelete`、`ScoreDelete`、
`DatasetDelete`、`DataRetentionQueue`、`DataRetentionProcessingQueue`

**集成（7）**：`PostHogIntegrationQueue` + `…ProcessingQueue`、
`MixpanelIntegrationQueue` + `…ProcessingQueue`、
`BlobStorageIntegrationQueue` + `…ProcessingQueue`、`WebhookQueue`

**云计费（3，EE）**：`CloudUsageMeteringQueue`、`CloudSpendAlertQueue`、
`CloudFreeTierUsageThresholdQueue`

**导出（3）**：`BatchExport`、`CoreDataS3ExportQueue`、`MeteringDataPostgresExportQueue`

**其他（6）**：`DatasetRunItemUpsert`、`ExperimentCreate`、`BatchActionQueue`、
`DeadLetterRetryQueue`、`NotificationQueue`、`MonitorQueue`

### 9.2 三个 secondary 队列：租户隔离机制

实测 **3 个**队列名里含 `secondary`，源码注释给出了理由：

```ts
EvaluationExecutionSecondaryQueue = "secondary-evaluation-execution-queue",
// Separates high-throughput eval projects from other projects.
OtelIngestionSecondaryQueue = "secondary-otel-ingestion-queue",
// Separates high priority + high throughput projects from other projects.
IngestionSecondaryQueue = "secondary-ingestion-queue",
```

**这是多租户 SaaS 的噪声邻居隔离**：把大流量项目拆到独立队列，
避免一个项目的洪峰堵住所有人。三条注释里有两条提到 "high throughput"，
一条额外提到 "high priority"。

另有分片机制：`shardedQueueRegistry.ts`，
配套 env 如 `LANGFUSE_CODE_EVAL_EXECUTION_QUEUE_SHARD_COUNT`（默认 1）、
`LANGFUSE_TRACE_UPSERT_QUEUE_SHARD_COUNT`。

### 9.3 QueueName 37 vs QueueJobs 34

两个枚举不等长（37 / 34），差 3。
**这是预期的**：secondary 队列复用同一个 job 类型
（`EvaluationExecution` 一个 job 对应 primary + secondary 两个队列），
3 个 secondary 队列正好解释这个差值。

⚠ 这是我的**推断**，不是从源码断言里读出的——
我没有逐一对照 `TQueueJobTypes` 映射表验证每一条。

### 9.4 worker 侧的注册

`worker/src/queues/` 下 **26 个 `.ts`**（`ls *.ts` 口径，含 `workerManager.ts`
与 `shardedQueueRegistry.ts` 两个非队列文件）。
注册走 `WorkerManager.register(...)`——全仓 **44 处**调用
（该口径是 `grep` 出现次数，含测试文件）。
`new Worker`（BullMQ 原生构造）只有 **3 处**，说明注册统一走了 WorkerManager 封装。

### 9.5 两个健康检查阈值：注释里有实战教训

`worker/src/env.ts` 里两个 opt-in 健康检查阈值，注释值得单独摘：

**`LANGFUSE_EVENT_PROPAGATION_STUCK_THRESHOLD_MINUTES`（默认 15）**：

> Probes using this flag MUST set `initialDelaySeconds >= 60s` (one cron cycle):
> the heartbeat is only refreshed when the minute-boundary cron next runs, so a
> just-restarted (or just-re-enabled) container can carry a stale value until
> then. **A shorter delay can crash-loop the very restart this check triggers.**

即「健康检查本身会把它想修复的重启变成 crash loop」——
这是给 k8s liveness probe 写的告警，而且是从事故里学到的形态。

**`LANGFUSE_QUEUE_CONSUMPTION_STUCK_THRESHOLD_MINUTES`（默认 60）**：
注释给出了 60 这个数字的推导——
健康 worker 至少每小时会被默认开启的周期任务唤醒一次
（blob storage 调度每 20 分钟、PostHog/Mixpanel 调度每小时），
所以「整小时完全静默」才判定卡死。
并提醒多副本部署下调度只落到一个副本，需要相应调高阈值。

**这两条是「阈值必须能解释出处」的好样本**：默认值不是拍的，
注释里写清了它由哪个周期任务的间隔推出来。

## 10. OpenTelemetry 接入

### 10.1 OTLP 端点

Langfuse 自己是 OTLP 接收端：

- `web/src/pages/api/public/otel/v1/traces/index.ts`
- `web/src/pages/api/public/otel/v1/metrics/index.ts`
- protobuf 解码：`web/src/pages/api/public/otel/otlp-proto/generated/root.ts`

即**任何 OTel SDK 都能直接把 span 打到 Langfuse**，不必用它的 SDK。
这也是 §21 里 JS SDK 重写成 OTel-based 的背景。

### 10.2 Langfuse 自有 span 属性

`packages/shared/src/server/otel/attributes.ts`（54 行）定义
`LangfuseOtelSpanAttributes` 枚举，分组如下：

- **trace 级**：`langfuse.trace.name`、`user.id`、`session.id`、
  `langfuse.trace.tags`、`langfuse.trace.public`、`langfuse.trace.metadata`、
  `langfuse.trace.input`、`langfuse.trace.output`
- **observation 级**：`langfuse.observation.type` / `.metadata` / `.level` /
  `.status_message` / `.input` / `.output`
- **generation 专属**：`langfuse.observation.completion_start_time`、
  `.model.name`、`.model.parameters`、`.usage_details`、`.cost_details`、
  `.prompt.name`、`.prompt.version`
- **通用**：`langfuse.environment` / `.release` / `.version`
- **内部**：`langfuse.internal.as_root`、`langfuse.internal.is_app_root`
- **实验（§12）**：9 个 `langfuse.experiment.*` 属性

⚠ **注意 `user.id` 与 `session.id` 没有 `langfuse.` 前缀**——
它们用的是 OTel 通用语义约定的键名。
而枚举里另有两个带前缀的**兼容用键**：

```ts
// Compatibility - Map properties that were documented in
// https://langfuse.com/docs/opentelemetry/get-started#property-mapping,
// but have a new assignment
TRACE_COMPAT_USER_ID = "langfuse.user.id",
TRACE_COMPAT_SESSION_ID = "langfuse.session.id",
```

**即 `langfuse.user.id` 曾是文档里的正式键名，后来改成了 `user.id`，
旧键作为兼容保留。** 按旧文档写的 instrumentation 仍然工作，
但你在新文档里查不到这两个键。

### 10.3 观测类型推断：11 级优先级链

`ObservationTypeMapper.ts`（**513 行**）解决的问题是：
一个来自任意框架的 OTel span，怎么判断它是 GENERATION 还是 TOOL 还是 SPAN。
实测 **11 个优先级**（Priority 0–10），按序尝试：

| 优先级 | 依据 | 针对 |
| --- | --- | --- |
| 0 | Python SDK ≤ 3.3.0 覆盖 | 老版自家 SDK |
| 1 | `langfuse.observation.type` 直接映射 | 自家 SDK |
| 2 | `openinference.span.kind` | **OpenInference**（Arize） |
| 3 | `gen_ai.operation.name` | **OTel GenAI 语义约定** |
| 4 | `genkit:metadata:subtype` | **Genkit**（Google） |
| 5 | Vercel AI SDK generation/embedding（需 model 信息） | **Vercel AI SDK** |
| 6 | Vercel AI SDK span 类操作（无 model 信息） | 同上 |
| 7 | `gen_ai.tool.name` / `gen_ai.tool.call.id` | **Pydantic AI** 等 |
| 8 | Flue 的 tool / delegated-task span | **Flue** |
| 9 | span 名称 | **LiveKit** |
| 10 | 基于 model 字段的兜底 | 任意 |

实现是两个 mapper 类：`SimpleAttributeMapper`（单属性查表）与
`CustomAttributeMapper`（自定义判定函数），
注册在 `ObservationTypeMapperRegistry`（第 165 行）。

Priority 7 的注释记了一个具体的框架怪癖：

> unfortunately, Pydantic does not set the `gen_ai.operation.name` attribute on tool calls

**这一章是「支持多少框架」这类主张的硬证据形态**：
不是数文档里列了多少 logo，而是数**代码里有多少条针对具体框架的判定分支**。
11 条里有 8 条是框架专属的。

### 10.4 ChatML 适配器：8 个

`packages/shared/src/utils/chatml/adapters/` 下 **8 个适配器**
（`ls *.ts` 得 9，减去 `index.ts`；`index.ts` 里 8 个 import 与之互相印证）：

`openai`、`gemini`、`aisdk`、`langgraph`、`microsoft-agent`、
`semantic-kernel`、`pydantic-ai`、`generic`

作用是把各家的消息格式归一化成 ChatML 以便 UI 渲染。
`generic` 是兜底。**注意这 8 个与 §10.3 那 11 条优先级是两套独立清单**——
前者管「消息正文怎么显示」，后者管「span 属于哪种观测类型」，
支持的框架集合不完全重合（如 OpenInference 在后者有、前者无）。

## 11. 评测系统

### 11.1 两种评测器

`EvalTemplateType` 枚举只有两项：**`LLM_AS_JUDGE`** 与 **`CODE`**。
代码评测的语言 `EvalTemplateSourceCodeLanguage`：**`PYTHON`** / **`TYPESCRIPT`**。

Postgres 侧的三张表：`eval_templates`（模板）、
`job_configurations`（评测器实例与触发条件）、`job_executions`（执行记录）。

⚠ `JobType` 枚举**只有一个值** `EVAL`，且 schema 里带了一条注释：

> We currently assume in evaluator execution-count queries that _all_ `job_executions`
> are for EVAL job_configs. If we ever extend this, we need to adjust the filter
> condition there. ref.: `getEvaluatorExecutionStatusCounts`.

即「这个枚举将来可能扩展，扩展时有一处查询会错」——
把技术债写在 schema 注释里并指名了会出问题的函数。

### 11.2 23 个内置评测器模板，12 个来自 Ragas

`worker/src/constants/managed-evaluators.json` 共 **23 条**，
其中 **12 条标了 `partner: "ragas"`**，11 条无 partner（Langfuse 自有）：

**Langfuse 自有（11）**：Hallucination、Helpfulness、Relevance、Toxicity、
Correctness、Contextrelevance、Contextcorrectness、Conciseness、
**User Distress**、**User Disagreement**、**Out-of-Scope Request**

**Ragas 合作（12）**：Answer Correctness、Answer Relevance、Answer Critic、
Context Precision、Context Recall、**Faithfulness（v1 与 v2 两条）**、
Goal Accuracy、Simple Criteria、SQL Semantic Equivalence、
Topic Adherence Classification、Topic Adherence Refusal

⚠ **23 是「JSON 数组长度」口径，不是「不同评测器数」**——
`Faithfulness` 出现两次（`version: 1` 与 `version: 2`），
所以按名称去重是 **22 个**。写「23 个内置评测器」时这一条必须说清，
否则读者数名字会数出 22 而对不上。

最后三个 Langfuse 自有项（User Distress / User Disagreement /
Out-of-Scope Request）不是传统的质量指标，而是**面向用户交互信号的检测**。

同步机制（`upsertManagedEvaluators.ts`）：ID 与时间戳**写死在 JSON 里**，
注释说明理由是「to guarantee deterministic results and stable diffs」——
即刻意不用运行时生成的 ID，换取可 diff 的产物。

### 11.3 代码评测的执行边界：三档能力

`web/src/features/evals/server/isCodeEvalEnabled.ts` 的判定：

| 环境 | 是否启用 | 支持语言 |
| --- | --- | --- |
| **Langfuse Cloud** | 启用 | TypeScript + Python |
| 自部署 + `LANGFUSE_CODE_EVAL_DISPATCHER=aws-lambda` | 启用 | TypeScript + Python |
| 自部署 + `…=insecure-local` | 启用 | **仅 TypeScript** |
| 自部署，未设该变量 | **禁用** | 无 |

即**代码评测在自部署上默认关闭**，且要拿到 Python 支持必须自备 AWS Lambda
（`LANGFUSE_CODE_EVAL_AWS_LAMBDA_NODE_FUNCTION_NAME` 默认
`code-based-eval-executor-node`，Python 版同理）。

### 11.4 `insecure-local` 名副其实

`packages/shared/src/server/evals/localCodeEvalDispatcher.ts` 的实现：

```ts
import { stripTypeScriptTypes } from "node:module";
import * as vm from "node:vm";
// …
const context = vm.createContext({ payload, console, setTimeout, /* … */ });
vm.runInContext(source, context, { timeout: this.timeoutMs });
```

**用 `node:vm` 跑用户提供的评测代码。** 默认超时
`LANGFUSE_CODE_EVAL_LOCAL_TIMEOUT_MS` = **2,000ms**。

`node:vm` **不是安全边界**——Node 官方文档明确说它不能用于运行不可信代码
（原型链逃逸是已知且不修的）。注入的上下文里给了 `console`、
定时器族、`URL`、`TextEncoder` 等，没有 `require` / `process` / `fs`，
但这不构成隔离。

**这里要把话说公道：它的 dispatcher `name` 字段就叫 `"insecure-local"`，
env 枚举值也叫 `insecure-local`，而且自部署默认不启用。**
即风险是被显式命名、显式 opt-in 的，不是伪装成安全方案的默认值。
按披露收着写的原则，本文只陈述机制与它自己的命名，不推演攻击路径。
生产环境要跑代码评测，选项是 Cloud 或自备 Lambda。

### 11.5 Monitors

`Monitor` 是独立的 Postgres 表与功能目录（`web/src/features/monitors`），
配套枚举 `MonitorThresholdOperator`、`MonitorView`、`MonitorSeverity`、
`MonitorStatus`，独立队列 `MonitorQueue`（并发默认 10）。
entitlement 侧有 `monitor-count` 限额，**所有 8 个 plan 一律 20**（§17.2），
包括 OSS——这是唯一一个在所有档位上取相同有限值的限额。

## 12. 数据集与实验

Postgres 侧：`datasets`、`dataset_items`、`dataset_runs`（三张表），
外加 `dataset_item_media`。
ClickHouse 侧的 `dataset_run_items` 表**已在 v4 被 DROP**
（`0046_drop_dataset_run_items`），保留的是 `dataset_run_items_rmt`
（ReplacingMergeTree 版本）。

实验（experiments）的表现形态是 **OTel span 属性**而非独立表——
§10.2 那 9 个 `langfuse.experiment.*` 属性：
`id`、`name`、`metadata`、`description`、`dataset.id`、
`item.id`、`item.version`、`item.metadata`、`item.root_observation_id`、
`item.expected_output`。

即**实验是 trace 上的一层标注**，不是另一套存储。
`ExperimentCreate` 队列 + `worker/src/features/experiments/scheduleExperimentEvals.ts`
负责把实验运行与评测串起来。

公开 API 侧 `fern/apis/server/definition/experiments.yml` 只有 **2 个 GET**
（list experiments / list experiment items），
即**实验的创建不走这个 API**（走 SDK 的 span 属性上报）。

## 13. MCP 服务端：79 个工具

### 13.1 计数：两个口径与一次 off-by-one

`web/src/features/mcp/` 共 **114 个文件**，15 个 feature 模块目录。

数「有多少个 MCP 工具」时踩了一次坑，完整记下来：

| 口径 | 数字 | 判定 |
| --- | --- | --- |
| `tools:` 数组按逗号切分 | **227** | ❌ 荒谬。对象字面量里每个逗号都被当成一项 |
| 全树 `defineTool(` 调用点 | **78** | ⚠ 接近但偏低 |
| 各 feature `index.ts` 里 `definition:` 键 | **79** | ✅ 可用 |

**先说第一个为什么荒谬**：`tools: [{definition: x, handler: y}, …]`
按逗号切会把 `definition` 和 `handler` 数成两项，还会把换行/嵌套算进来。
这个数字大到一眼可疑，所以没有害处——**危险的是后两个，78 与 79 只差 1。**

差异来源查明了：`prompts/tools/promptReadToolFactory.ts` 导出
`createPromptReadTool()`，内部**只有一处** `defineTool(`，
但被 `getPrompt.ts` 与 `getPromptUnresolved.ts` **各调用一次**——
一个 `defineTool(` 调用点产出两个工具。

**所以 79 是对的，78 漏了工厂的第二次实例化。**
这正是「脚本跑对了，但数的东西不是你以为的东西」——
`defineTool(` 数的是**代码里写了几次**，`definition:` 数的是**注册了几个**，
后者才是「有多少个工具」的答案。

### 13.2 按模块分布

| 模块 | 工具数 |
| --- | --- |
| dashboardWidgets | 13 |
| datasets | 12 |
| annotationQueues | 10 |
| evals | 9 |
| scores | 8 |
| prompts | 6 |
| observations | 5 |
| models | 4 |
| comments | 3 |
| metrics / experiments / monitors | 各 2 |
| health / media / feedback | 各 1 |
| **合计** | **79** |

注册机制是 import-time 副作用：`bootstrap.ts` 末尾直接调
`bootstrapMcpFeatures()`，注释说明「Auto-bootstrap when this module is imported」。
类型上用 `as const satisfies readonly McpFeatureModule[]`，
并从中派生 `McpToolName` 联合类型——
这个类型后来被 In-App Agent 用来强制「新增 MCP 工具必须显式分类」（§14.3）。

### 13.3 只读标注：42 个

实测 `readOnlyHint: true` **42 处**，`readOnlyHint: false` **0 处**——
即只标只读的，可变工具靠「没有该标注」表达。

42/79 意味着**过半工具（37 个）是可变的**。这个标注不只是元数据：
§14.3 会看到 In-App Agent 用它做权限门控。

### 13.4 无状态设计

`README.md` 里的架构说明：每个请求新建一个 server 实例，
认证上下文捕获在 handler 闭包里，请求结束即丢弃，无 session 存储。
传输是 HTTP（`claude mcp add --transport http`），
认证走 Basic（`pk-lf-…:sk-lf-…` 的 base64），
**组织级 key 不支持**，必须项目级。

README 里还有一条 API 稳定性声明：

> This MCP server is self-describing. Clients should **dynamically inspect**
> available tools and schemas rather than assuming a static interface.
> Tool availability and schemas **may evolve over time**, including the addition,
> removal, or modification of tools and fields.

即**不承诺工具清单稳定**。本文那个 79 的计数因此是快照值，不是契约。

## 14. In-App Agent：产品内的 coding agent

这是 v4 期间新增的功能（`in-app-agent` entitlement，Postgres 侧 4 张表），
也是本仓库里架构文档最完整的一块——
`web/src/features/in-app-agent/README.md` 含 mermaid 流程图、
11 步运行生命周期、以及一份 change rules。

### 14.1 形态

- **AG-UI 协议**作为「live streaming、持久化、回放、渲染」的持久契约
- 运行时是 **Mastra + Bedrock + MCP**
- **仅前台运行**：一个会话同时只能有一个活跃 run，
  新 run 开始前先关掉过期未完成的 run
- 浏览器持有交互状态并提交意图；服务端持有授权、run/message ID、
  请求清洗、MCP 凭据、运行时配置、工具访问、持久化与回放

### 14.2 沙箱：两个 provider，一个契约

两个 provider 共享 `packages/in-app-agent-sandbox-runtime` 定义的运行时契约：

| provider | 形态 | 定位 |
| --- | --- | --- |
| `dangerous-docker` | 本地容器，`docker exec` 调 `http://127.0.0.1:5000` | **仅开发用**（README 原文 "development-only"） |
| `lambda-microvm` | AWS Lambda MicroVM，HTTPS + `X-aws-proxy-auth` | 生产 |

契约方法：`ensureSession` / `syncReadonlyFiles` / `read` / `write` / `edit` /
`bash` / 可选 `suspendSession`。
运行时 HTTP 面只有两个业务端点：`GET /health` 与 `POST /sandbox`
（另有 5 个 `/aws/lambda-microvms/runtime/v1/*` 生命周期钩子）。

沙箱内的权限约定（`packages/in-app-agent-sandbox-runtime/README.md`）：

- 单一非特权用户 `sandbox-server` 运行 HTTP server 与全部工具操作
- 理由是要兼容 Lambda MicroVM 的 `no new privileges`（无法 `sudo` 切换用户）
- **`/workspace/tool_calls` 在每次工具调用前重建**，
  所以一次工具调用里的修改在下一次调用前被丢弃

⚠ 名字叫 `dangerous-docker` 且 README 标 development-only——
与 §11.4 的 `insecure-local` 是同一种命名风格：**把风险写进标识符**。
另注意清理责任是分裂的：worker 的数据保留清理**只拆 `lambda-microvm` 沙箱**，
本地 Docker 沙箱的清理留在 web 进程。

### 14.3 工具授权：RBAC 在前，人工审批在后

这一节的机制值得完整记录，因为它是「agent 权限」的一个具体解法。

**两个请求级输入**：① 临时项目级 API key（标记为 in-app-agent key）；
② 可选的服务端生成的工具覆盖（走 `x-langfuse-in-app-agent-tool-override` 头）。

**MCP registry 的三条规则**（README 原文）：

- 普通项目 API key 可调用所有已启用的 MCP 工具
- **in-app-agent key 只能直接调 `readOnlyHint: true` 的工具**（呼应 §13.3 那 42 个）
- in-app-agent key 要调一个非只读工具，**必须有有效的 tool override，且只能一个**

**两道门的顺序**：

> **RBAC is the first gate.** Before a tool is exposed to the model,
> `server/tools.ts` checks the signed-in user's `projectRole` and `isAdmin`
> against the tool's required `ProjectScope` with `hasProjectAccess()`.
> That means the assistant **never sees** tools the user could not use manually.

即模型**看不到**用户本人无权使用的工具（不是看到了再拒绝）。
人工审批是 RBAC 之上的第二道门，且明确不扩权：

> approval can allow one execution of a tool the user already has access to,
> but it **does not widen** the user's project permissions.

**分类表的强制机制**：`IN_APP_AGENT_LANGFUSE_MCP_TOOL_APPROVALS` 把每个
Langfuse MCP 工具标为 `"auto"` 或 `"approval"`，
键类型是从 MCP 模块派生的 `McpToolName` 联合类型（§13.2），
**且有测试把这张表与 `toolRegistry` 对账**——
所以新增一个 MCP 工具时，不显式分类就编译/测试不通过。

这是「新增能力必须同步登记」这类约定的**机械化**形态：
不靠文档提醒，靠类型 + 测试拦住。

### 14.4 审批状态的持久化

pending approval 行存在 Postgres（`in_app_agent_pending_tool_approvals`），
存工具调用身份 + **参数指纹**（stable argument fingerprint），短 TTL 过期。
恢复审批时由 `server/handler.ts` 对着这一行校验。

存指纹而不是存完整参数，意味着「审批的是这一次调用」——
参数变了指纹不匹配，审批失效。

## 15. 公开 API 面：123 个端点声明

### 15.1 计数与口径

API 用 [Fern](https://buildwithfern.com/) 定义（`fern/apis/`），
三套独立 API：`server`（主）、`organizations`、`client`（浏览器侧）。

从所有 `.yml` 里数 `method:` 声明共 **123 个**：
GET 60、POST 26、DELETE 23、PATCH 8、PUT 6。

⚠ **口径**：数的是 **Fern 定义里的 method 声明**，不是运行时路由数。
另一个口径是 `web/src/pages/api/` 下的文件数（**103 个**，其中
`public/` 下 **83 个**），两者不可直接比较——
一个 Next.js API 文件可以处理多个 HTTP 方法，
而 Fern 定义里也有部分端点是分档/legacy 声明。

按定义文件排前几名：

| 定义文件 | 端点数 |
| --- | --- |
| `annotation-queues.yml` | 10 |
| `organizations.yml`（organizations API） | 8 |
| `organizations.yml`（server API） | 8 |
| `unstable/dashboards.yml` | 8 |
| `projects.yml` | 7 |
| `scim.yml` | 7 |
| `datasets.yml` | 6 |

### 15.2 版本分层：四层并存

实测端点路径上有四种版本形态同时存在：

| 层 | 位置 | 内容 |
| --- | --- | --- |
| 无版本号 | `api/public/*.ts` | `ingestion`、`health`、`ready`、`prompts`、`traces`… |
| `v2` | `api/public/v2/` | `datasets`、`metrics`、`observations`、`prompts`、`scores` |
| `v3` | `api/public/v3/` | **仅 `scores`** |
| `unstable` | `api/public/unstable/` | `dashboards`、`dashboard-widgets`、`evaluators`、`evaluation-rules` |

Fern 侧另有 `definition/legacy/`：`metrics-v1.yml`、`score-v1.yml`、
`observations-v1.yml`（共 5 个端点）。

**`scores` 是唯一跨到 v3 的资源**（无版本 + v2 + v3 三处都有），
这与 §8.3 那 5 种 score 类型（含较新的 `CORRECTION`）演进相关。

`unstable/` 这层是显式的稳定性声明——放在路径里而不是靠文档说明，
调用方一眼能看出自己用的是不承诺兼容的部分。

### 15.3 SCIM 与企业身份

`api/public/scim/` 提供标准 SCIM 2.0 面：
`ServiceProviderConfig`、`Schemas`、`ResourceTypes`、`Users`（list/CRUD）——
共 7 个端点（Fern `scim.yml`：5 GET + 1 POST + 1 DELETE）。
用于企业 IdP 自动同步用户。

### 15.4 认证与限流

API key 有两级 scope（`ApiKeyScope`）：**`ORGANIZATION`** 与 **`PROJECT`**。
MCP 只接受 project 级（§13.4）。

限流资源 `RateLimitResource` 共 **14 种**：
`ingestion`、`media-upload`、`public-api`、`public-api-legacy`、
`public-api-metrics`、`public-api-v2-metrics`、`public-api-daily-metrics-legacy`、
`prompts`、`legacy-ingestion`、`datasets`、`trace-delete`、`score-delete`、
`in-app-agent-run`、`feedback`。

**14 种里有 4 种是 legacy / 分版本的 metrics 变体**
（`public-api-legacy`、`legacy-ingestion`、`public-api-metrics`、
`public-api-v2-metrics`、`public-api-daily-metrics-legacy`——实际是 5 种），
说明限流桶是随 API 版本分裂而增生的。
`prompts` 单独一个桶符合预期（prompt 拉取是最高频的读路径）。

限流配置在 `CloudConfigRateLimit`（组织的 cloudConfig 上），
即**限流值是按组织可配的，不是全局常量**。
⚠ 自部署下这些默认值是多少，我没有核验——
`RateLimitConfig` 的 `points` / `durationInSec` 都是 `nullish`，
默认值不在这个文件里。

## 16. 权限模型：5 个角色，56 个项目 scope

### 16.1 角色

`Role` 枚举 5 项：**`OWNER`**、**`ADMIN`**、**`MEMBER`**、**`VIEWER`**、**`NONE`**。
两级成员关系：`organization_memberships` 与 `project_memberships`
（后者可覆盖前者，`rbac-project-roles` 是付费 entitlement，§17.1）。

### 16.2 Scope 矩阵

`packages/shared/src/features/rbac/projectAccessRights.ts`
定义 **56 个项目 scope**，另有 **9 个组织 scope**。
角色到 scope 的映射（脚本数出）：

| 角色 | 项目 scope 数 | 占比 |
| --- | --- | --- |
| `OWNER` | **56** | 100% |
| `ADMIN` | **55** | 98% |
| `MEMBER` | **42** | 75% |
| `VIEWER` | **18** | 32% |
| `NONE` | **0** | 0% |

**OWNER 与 ADMIN 只差一个 scope。** 这个差值很可能是
`project:delete` 或成员管理类权限，但**我没有逐项 diff 确认是哪一个**——
这里只报数字，不猜是哪条。

Scope 的命名约定是 `资源:动作`，动作有 `read` / `CUD` / `CRUD` /
以及具体动词（`objects:publish`、`objects:bookmark`、`objects:tag`、
`traces:delete`、`project:update`）。
⚠ **`CUD` 与 `CRUD` 两种写法并存**（如 `scores:CUD` 与 `integrations:CRUD`），
即读权限有时并入、有时分开，不是统一约定。

`VIEWER` 拿到 18/56 说明只读视图覆盖了约三分之一的 scope——
剩下的三分之二是写操作与配置。

## 17. 商业边界：8 个 plan，13 个 entitlement

### 17.1 Entitlement 矩阵

`web/src/features/entitlements/constants/entitlements.ts` 定义
**13 个 entitlement**（二元开关）与 **6 个 entitlementLimit**（数值限额）。
`plans.ts` 定义 **8 个 plan**。

13 个 entitlement 与它们在各档的开放情况（✅ = 有）：

| entitlement | oss | sh:pro | sh:ent | hobby | core | pro | team | cloud:ent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `trace-deletion` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `scheduled-blob-exports` | ✅ | ✅ | ✅ | — | — | — | ✅ | ✅ |
| `cloud-billing` | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| `in-app-agent` | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ |
| `cloud-spend-alerts` | — | — | — | — | ✅ | ✅ | ✅ | ✅ |
| `data-retention` | — | — | ✅ | — | — | ✅ | ✅ | ✅ |
| `rbac-project-roles` | — | — | ✅ | — | — | — | ✅ | ✅ |
| `audit-logs` | — | — | ✅ | — | — | — | ✅ | ✅ |
| `prompt-protected-labels` | — | — | ✅ | — | — | — | ✅ | ✅ |
| `admin-api` | — | — | ✅ | — | — | — | ✅ | ✅ |
| `cloud-multi-tenant-sso` | — | — | — | — | — | — | ✅ | ✅ |
| `self-host-ui-customization` | — | — | ✅ | — | — | — | — | — |
| `self-host-allowed-organization-creators` | — | — | ✅ | — | — | — | — | — |

（`sh:` = self-hosted；`cloud:ent` 的清单与 `cloud:team` 相同，见下方注）

**四点值得指出：**

1. **`scheduled-blob-exports` 在 OSS 上是开放的，在 cloud hobby/core/pro 上不开放。**
   即自部署在这一项上比付费云低档更宽松——因为自部署的对象存储是你自己的。
2. **`self-host-ui-customization` 与 `self-host-allowed-organization-creators`
   只在 `self-hosted:enterprise` 存在**，云上任何档位都没有（含 enterprise）。
   这两项对云本身无意义。
3. **`self-hosted:pro` 与 `oss` 的 entitlement 完全相同**（都只有
   `trace-deletion` + `scheduled-blob-exports`）。
   即**自部署 Pro 许可不解锁任何二元 entitlement**——它的价值在别处
   （支持合同、或 §17.2 的限额，但实测限额也相同）。
   ⚠ 这一条只说明「entitlement 表里没有差异」，
   不代表 Pro 许可没有价值——定价页的口径本文未核验。
4. `cloud:enterprise` 的 entitlement 列表与 `cloud:team` 逐项相同。
   差异化只能来自 `cloudConfig` 的手动覆盖或合同，不在这张表里。

### 17.2 限额：只有云低档有限制

6 个 `entitlementLimits`（`false` = 无限）实测结果：

| 限额 | hobby | core | pro | team/ent | oss / sh:* |
| --- | --- | --- | --- | --- | --- |
| `organization-member-count` | **2** | ∞ | ∞ | ∞ | ∞ |
| `data-access-days` | **30** | **90** | ∞ | ∞ | ∞ |
| `annotation-queue-count` | **1** | **3** | ∞ | ∞ | ∞ |
| `monitor-count` | **20** | **20** | **20** | **20** | **20** |
| `model-based-evaluations-count-evaluators` | ∞ | ∞ | ∞ | ∞ | ∞ |
| `prompt-management-count-prompts` | ∞ | ∞ | ∞ | ∞ | ∞ |

**三点观察：**

- **`monitor-count` 在全部 8 个 plan 上都是 20**，包括 OSS。
  这是唯一一个「所有档位都有限且相同」的限额——
  它更像技术性上限（monitor 是周期任务，§11.5），不是商业分层。
- 两个限额（`model-based-evaluations-count-evaluators`、
  `prompt-management-count-prompts`）**在所有 8 个档位上都是 `false`（无限）**——
  即定义了但当前未启用，是预留的收费点。
- hobby 的 `data-access-days: 30` 是最实质的限制：数据只能回看 30 天。

### 17.3 三条产品线的商业形态

- **Langfuse Cloud**：5 档（Hobby / Core / Pro / Team / Enterprise），
  走 Stripe（`mapStripeProductIdToPlan`，按 product id 映射）
- **自部署 OSS**：MIT 部分免费，EE 目录需许可
- **自部署商业**：`self-hosted:pro` / `self-hosted:enterprise`，靠 license key 区分

## 18. 企业许可校验：一次字符串前缀匹配

这是本文最短也最值得单独成章的一节。

### 18.1 两份实现

**第一份**，`ee/src/ee-license-check/index.ts` 全文（**4 行有效代码**，
整个 `ee/src` 只有 **16 行**）：

```ts
import { env } from "../env";

export const isEeAvailable: boolean =
  env.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION !== undefined ||
  env.LANGFUSE_EE_LICENSE_KEY !== undefined;
```

⚠ 这一份**只检查环境变量是否存在**，连前缀都不看。
但它的使用面极小：全仓 `isEeAvailable` 只有 **2 处**引用，
且两处都是 re-export（`ee/src/index.ts` 与定义处本身）——
**即这个导出目前没有生产调用方**。

**第二份**（真正在用的），`packages/shared/src/server/ee/licenseCheck/index.ts`：

```ts
export function isEnterpriseLicenseAvailable(envOverride?: SharedEnv): boolean {
  const e = envOverride ?? env;
  if (e.NEXT_PUBLIC_LANGFUSE_CLOUD_REGION !== undefined) return true;
  const licenseKey = e.LANGFUSE_EE_LICENSE_KEY;
  if (licenseKey && licenseKey.startsWith("langfuse_ee_")) return true;
  return false;
}
```

**第三处**，plan 判定（`web/src/features/entitlements/server/getPlan.ts`）：

```ts
export function getSelfHostedInstancePlanServerSide(): Plan | null {
  const licenseKey = env.LANGFUSE_EE_LICENSE_KEY;
  if (!licenseKey) return null;
  if (licenseKey.startsWith("langfuse_ee_")) return "self-hosted:enterprise";
  if (licenseKey.startsWith("langfuse_pro_")) return "self-hosted:pro";
  return null;
}
```

### 18.2 事实陈述

**校验机制就是 `startsWith("langfuse_ee_")` / `startsWith("langfuse_pro_")`。**
仓库里搜遍 `LANGFUSE_EE_LICENSE_KEY` 的全部 9 处引用，
**没有签名验证、没有公钥、没有许可服务器回调、没有过期时间检查**。

**这是描述，不是评价。** 客观地说这个设计有它的位置：

- 它**不联网**——不需要 license server，离线/气隙部署可用
- 它对**诚实用户**足够：付费客户拿到的 key 就是这个格式，配上即生效
- 它把执行放在**合同层**（`ee/LICENSE` 的法律条款），不是技术层
- open-core 项目普遍如此：代码可读，技术强制本来就不可能

**同时要照实说清代价**：任何人都能让自部署实例进入
`self-hosted:enterprise`，从而拿到 `audit-logs`、`rbac-project-roles`、
`admin-api`、`data-retention`、`prompt-protected-labels` 这 5 项
（§17.1 表里 sh:ent 独有的）。
这属于**许可合规问题，不是安全漏洞**——它不越权访问别人的数据，
只是绕过了本方的商业约定。

⚠ 一处未能核验：**Langfuse Cloud 侧是否另有校验**。
`NEXT_PUBLIC_LANGFUSE_CLOUD_REGION` 一旦存在就直接返回 `true`，
云上的真实 plan 走 `cloudConfig` + Stripe（§17.3），
所以云侧不依赖 license key。自部署商业客户的合规如何跟踪（合同/审计/自觉），
本文无法从代码得知。

### 18.3 一个副作用：EE 用户无法关闭遥测

`web/src/features/telemetry/index.ts:29`：

```ts
// Check if telemetry is not disabled, except for EE
if (env.TELEMETRY_ENABLED === "false" && env.LANGFUSE_EE_LICENSE_KEY === undefined)
  return;
```

**读法**：只有「`TELEMETRY_ENABLED=false` **且** 没有 EE license key」
才跳过遥测。即**设了 license key 的自部署实例，`TELEMETRY_ENABLED=false` 不生效**。

README 的措辞与之一致（"For Langfuse **OSS**, you can opt out by setting
`TELEMETRY_ENABLED=false`"）——限定词 "OSS" 是准确的，
但**这个限定的含义在 README 里没有展开**，读者容易漏掉
「持有商业许可反而不能关遥测」这层。

上报内容（`posthogTelemetry()` 实测字段）：
`langfuseVersion`、`totalProjects`、trace/score/observation/dataset 各类计数、
时间窗、**`eeLicenseKey`（license key 原文）**、`langfuseCloudRegion`、
以及 **`userDomains`**——

```sql
SELECT substring(email FROM position('@' in email) + 1) as domain,
       count(id)::int as "userCount"
FROM users WHERE email ILIKE '%@%' GROUP BY 1 ORDER BY count(id) desc LIMIT 30
```

即**用户邮箱域名 + 各域名用户数，取前 30**。
README 说「telemetry does not include raw traces, prompts, observations,
scores, or dataset contents」——这句话**是真的**（只发计数）。
但**邮箱域名是组织身份信息**，虽不是「trace 内容」，
在企业合规视角下通常也算敏感（它足以识别是哪家公司在用）。
代码里的注释写的是 `// Domains (no PII)`——
**「域名不是 PII」这个判断在 GDPR 语境下是可争议的**（个人邮箱域名如
`gmail.com` 确实不是，但企业域名指向具体法人实体）。

频率：12 小时一次（`JOB_INTERVAL_MINUTES = 720`），
经 Postgres `cron_jobs` 表加锁调度，`NODE_ENV !== "production"` 或 `CI` 下不跑。

## 19. 认证：17 种登录方式

`web/src/server/auth.ts` 实测 **17 个不同的 Provider 构造器**、
**18 处调用点**（Auth0 出现两次，见下）：

**凭据类（2）**：`CredentialsProvider`（邮箱密码）、`EmailProvider`（magic link）

**企业 SSO（15）**：`CustomSSOProvider`、`GoogleProvider`、`OktaProvider`、
`AuthentikProvider`、`OneLoginProvider`、`Auth0Provider`、`GitHubProvider`、
`GitHubEnterpriseProvider`、`GitLabProvider`、`AzureADProvider`、
`CognitoProvider`、`KeycloakProvider`、`JumpCloudProvider`、
`WorkOSProvider`、`WordPressProvider`

**Auth0 那两次调用是两个不同的登录入口**：第二次带
`id: "clickhouse-cloud"` / `name: "ClickHouse Cloud"`，源码注释：

> Langfuse Cloud only: "Sign in with ClickHouse Cloud"
> Uses Auth0Provider with a custom provider ID so the callback URL becomes
> `/api/auth/callback/clickhouse-cloud`. **NOT intended for self-hosted Langfuse.**

即**「用 ClickHouse Cloud 账号登录 Langfuse」是云上独有的入口**，
实现方式是复用 Auth0 provider 换个 id。这是 Langfuse 与 ClickHouse
商业关系的一处代码痕迹（Langfuse 的核心存储就是 ClickHouse）。

多数 provider 支持 `allowDangerousEmailAccountLinking`
（如 `AUTH_AUTH0_ALLOW_ACCOUNT_LINKING`）——
NextAuth 里这个选项名自带 "dangerous"，因为它允许按邮箱自动合并账号，
在 IdP 不校验邮箱所有权时可被用于账号接管。**默认关闭**，需显式设为 `"true"`。

企业侧另有 `multi-tenant-sso`（EE，`cloud-multi-tenant-sso` entitlement）、
`verified-domains`、SCIM（§15.3）。
`next-auth` 被打了补丁（`patches/next-auth@4.24.15.patch`），
且有一条 override 说明它的 nodemailer peer 依赖问题。

## 20. 配置面：376 个环境变量

### 20.1 计数与口径

四份 zod schema 里的环境变量键（正则 `^\s+([A-Z][A-Z0-9_]{2,}):\s*z\.`）：

| 文件 | 键数 | 行数 |
| --- | --- | --- |
| `web/src/env.mjs` | 178 | 973 |
| `packages/shared/src/env.ts` | 138 | 571 |
| `worker/src/env.ts` | 129 | 646 |
| `ee/src/env.ts` | 2 | 9 |
| **求和（含重复）** | **447** | — |
| **去重后（union）** | **376** | — |

**必须报去重值 376，不是 447**：三份 schema 有意重叠
（web ∩ shared = 34、web ∩ worker = 24、worker ∩ shared = 29 等），
因为同一个变量要在多个进程里读。§7.1 那个
`LANGFUSE_MIGRATION_V4_WRITE_MODE` 就是三处各声明一次的例子。

按前缀分类（去重后 376 个里）：

- `LANGFUSE_` 前缀：**200 个**（53%）
- `NEXT_PUBLIC_` 前缀：**11 个**（暴露到浏览器）
- 含 `REDIS`：**27 个**
- `CLICKHOUSE` 前缀：**15 个**

⚠ 这个 376 是**上界还是下界，取决于你怎么算**：
正则只匹配 `KEY: z.` 形态的直接声明，
漏掉了动态构造的键（如按项目分片的变量）与 `.refine()` 里引用的其他键；
另一方面它把三份 schema 去重了。
所以它是「zod 显式声明的、进程可读的配置项数」，不是「文档里列了多少个」。
⚠ **官方文档侧的环境变量数本文未核验**（文档在独立仓库，§21.4），
所以无法像 `ref-litellm` 那样给出「文档 vs 源码」两个口径的对照。

### 20.2 一处配置设计：S3 校验算法可切换

`packages/shared/src/env.ts` 的
`LANGFUSE_S3_DELETE_OBJECTS_CHECKSUM_ALGORITHM`
（`MD5` / `CRC32` / `CRC32C` / `CRC64NVME` / `SHA1` / `SHA256`），注释：

> unset keeps the SDK default (CRC32). Some S3-compatible stores reject CRC32
> with 400 MissingContentMD5 and need "MD5" … e.g. MinIO before
> RELEASE.2025-02-03 (langfuse/langfuse-k8s#356). **MD5 is unavailable on FIPS
> runtimes**; stores that support it also accept e.g. SHA256 as a FIPS-approved
> alternative.

一条注释里同时给了：默认值、触发条件、具体的 MinIO 版本边界、issue 编号、
以及 FIPS 运行时下的替代方案。**这是配置项注释的一个高标准样本**——
读者不需要去翻 issue 就知道该不该设它。

### 20.3 blob 导出与集成

- 对象存储类型（`BlobStorageIntegrationType`）：**S3 / S3_COMPATIBLE / AZURE_BLOB_STORAGE**
  （⚠ **没有 GCS 枚举值**；GCS 可走 S3_COMPATIBLE，但这一点我未核验）
- 导出文件格式（`BlobStorageIntegrationFileType`）：**JSON / CSV / JSONL / PARQUET**
- 导出模式（`BlobStorageExportMode`）：**FULL_HISTORY / FROM_TODAY / FROM_CUSTOM_DATE**
- 批量导出格式（`BatchExportFileFormat`）：**CSV / JSON / JSONL**（3 种，无 PARQUET）

⚠ 两套导出的格式集合不同：定时 blob 导出支持 PARQUET，UI 的批量导出不支持。

分析集成：PostHog、Mixpanel（各有 Queue + ProcessingQueue 一对）。
自动化动作（`ActionType`）：**WEBHOOK / SLACK / GITHUB_DISPATCH**，
schema 注释写「More action types can be added as needed」。

通知（`NotificationChannel` / `NotificationType`）各只有 **1 个值**
（`EMAIL` / `COMMENT_MENTION`），且注释直接写出了扩展计划：

```prisma
enum NotificationChannel {
  EMAIL
  // Extend by adding: IN_APP, SLACK
}
enum NotificationType {
  COMMENT_MENTION
  // Extend by adding: COMMENT_REPLY, COMMENT_NEW, EVAL_COMPLETE, EXPORT_READY
}
```

即**通知系统目前只做了「评论 @ 我发邮件」这一条路径**，框架先行、内容待补。

仪表盘图表类型（`DashboardWidgetChartType`）9 种：
`LINE_TIME_SERIES`、`AREA_TIME_SERIES`、`BAR_TIME_SERIES`、`HORIZONTAL_BAR`、
`VERTICAL_BAR`、`PIE`、`NUMBER`、`HISTOGRAM`、`PIVOT_TABLE`。

## 21. SDK 面（框架视角）

前 20 章讲的是「你部署的那个东西」。这一章换视角：
**你 `import` 的那个东西**，读者关心的是「升级会不会弄坏我的代码」。

### 21.1 JS/TS：v5 重写，包从 4 个变 8 个

**旧世代（legacy v3，不带 scope）**：

| 包 | latest | 首发 | 稳定版数 |
| --- | --- | --- | --- |
| `langfuse` | **3.38.20**（2026-04-01） | 2023-07-02 | 159 |
| `langfuse-langchain` | 3.38.20 | 2023-08-30 | 126 |
| `langfuse-vercel` | 3.38.20 | 2024-08-02 | 55 |
| `langfuse-core` | 3.38.20 | — | — |

**新世代（`@langfuse/*`，scoped）**，全部 **5.10.0（2026-07-31）**：

| 包 | 首发 | 用途 | 环境 |
| --- | --- | --- | --- |
| `@langfuse/core` | 2025-08-28 | 核心 | — |
| `@langfuse/tracing` | 2025-08-28 | 基于 OTel 的埋点方法 | Node 20+ |
| `@langfuse/otel` | 2025-08-28 | OTel 导出助手 | Node 20+ |
| `@langfuse/client` | 2025-08-28 | API 客户端 | Universal JS |
| `@langfuse/openai` | 2025-08-28 | OpenAI SDK 集成 | Universal JS |
| `@langfuse/langchain` | 2025-08-28 | LangChain 集成 | Universal JS |
| `@langfuse/vercel-ai-sdk` | **2026-05-26** | AI SDK **v7** 集成 | Universal JS |
| `@langfuse/browser` | **2026-06-18** | 浏览器侧公钥打分上报 | Browser |

**关键的结构性变化：整个 SDK 建立在 OpenTelemetry 之上。**
`@langfuse/otel` 的 peerDependencies 实测：

```json
"@opentelemetry/api": "^1.9.0",
"@opentelemetry/core": "^2.0.1",
"@opentelemetry/sdk-trace-base": "^2.0.1",
"@opentelemetry/exporter-trace-otlp-http": ">=0.202.0 <1.0.0"
```

即**你的应用必须自己管 OTel 版本**。旧世代（`langfuse@3`）没有 OTel 依赖。
这是「升级弄坏代码」的主要来源：不是 API 改名，而是**多了一层需要你配置的基础设施**。

其他升级边界：

- **Node 要求从 `>=18` 升到 `>=20`**（`@langfuse/tracing`、`@langfuse/otel` 的
  `engines.node`；旧包是 `>=18`）
- `@langfuse/langchain` 的 peer 是 `@langchain/core: >=0.3.8`，
  而旧 `langfuse-langchain` 的 peer 是 `langchain: >=0.0.157 <0.4.0`——
  **peer 的包名都换了**（`langchain` → `@langchain/core`）
- `@langfuse/vercel-ai-sdk` 明确写 "AI SDK **v7**"，
  旧 `langfuse-vercel` 的 peer 是 `ai: >=3.2.44`
- 许可：新旧包都是 MIT

### 21.2 弃用信号缺位

**四个 legacy 包在 npm 上都没有 `deprecated` 标记**
（实测 registry 的 `versions[latest].deprecated` 全为空）。

后果：`npm install langfuse` 装到 3.38.20，**没有任何警告**，
而这个包最后一次发布是 2026-04-01，现行线已经到 5.10.0（2026-07-31）。
唯一的提示在 `langfuse-js` 仓库 README 的 `[!IMPORTANT]` 块里：

> The SDK was rewritten in **v5** and released in **March 2026**. …
> The unscoped npm packages `langfuse`, `langfuse-core`, `langfuse-node`, and
> `langfuse-langchain` belong to the **legacy v3 SDK**. For new integrations use
> the `@langfuse/*` scoped packages below.

⚠ **注意这段 README 提到 `langfuse-node`，但我没有在 npm 上查这个包**——
本文核验的是 `langfuse` / `langfuse-core` / `langfuse-langchain` / `langfuse-vercel` 四个。
另注意 README 说 v5 发布于 2026-03，而 npm 上 `@langfuse/*` 的
**第一个 5.x 稳定版**与之是否对齐，我没有逐版本核对
（registry 显示 `@langfuse/*` 的 4.0.0 首发于 2025-08-28）。

**「v4 → v5」的迁移指南路径本身也说明了版本错位**：
`langfuse.com/docs/observability/sdk/upgrade-path/js-v4-to-v5`——
即 JS SDK 有过 v4，且 v4→v5 是另一次迁移。
JS 线的 4.0.0（2025-08-28）比服务端 v4（2026-07-29）早了 11 个月。

### 21.3 Python：543 个版本，五条大版本线

PyPI `langfuse` 实测：

- latest **4.14.3**（2026-08-06），`requires_python: <4.0,>=3.10`
- **543 个发布**（含 pre-release），首发 2023-07-12
- **6 个 yanked 版本**
- 各大版本线首发日：
  `0.x` 2023-07-12 → `1.0.0` 2023-08-11 → `2.0.0a0` 2023-12-08
  → `3.0.0b1` **2025-05-20** → `4.0.0b1` **2026-02-24**
- 版本数分布：`0.x` 77、`1.x` 121、`2.x` 237、`3.x` 74、`4.x` 34

**`2.x` 占了 237 个版本（44%）**，是持续最久的一条线（2023-12 到 2025-05）。

运行时依赖（`requires_dist`）8 个：
`httpx<1.0,>=0.15.4`、`pydantic<3,>=2`、`backoff>=1.10.0`、`wrapt<3,>=1.14`、
`packaging<27.0,>=23.2`、以及**三个 OTel 包**
（`opentelemetry-api`、`opentelemetry-sdk`、`opentelemetry-exporter-otlp-proto-http`，
均 `<2,>=1.33.1`）。

**Python SDK 同样在 v4 转向了 OTel**——三个 OTel 包是**硬依赖**（不是 peer），
这与 JS 侧把 OTel 作为 peerDependency 的选择不同：
Python 侧 Langfuse 帮你钉版本，JS 侧要你自己管。

发版节奏近 6 个月：2026-03 五个、04 十个、05 六个、06 七个、07 六个、08 一个——
**比服务端平缓得多**（服务端 2026-07 是 38 个）。

### 21.4 SDK 与文档都在独立仓库

| 仓库 | 创建 | Stars | Open issues | 语言 |
| --- | --- | --- | --- | --- |
| `langfuse/langfuse` | 2023-05-18 | **32,746** | 759 | TypeScript |
| `langfuse/langfuse-python` | 2023-07-17 | 448 | 81 | Python |
| `langfuse/langfuse-js` | 2023-07-02 | 155 | 42 | TypeScript |
| `langfuse/langfuse-docs` | 2023-05-22 | 232 | **169** | MDX |
| `langfuse/langfuse-k8s` | 2024-02-02 | 265 | 36 | Go Template |

**主仓里没有产品文档**：全仓只有 **5 个 `.mdx`**，且全是 Storybook /
设计系统说明（`web/storybook/docs/Overview.mdx`、
`ChartingPrinciples.mdx`、`ScoreTag.mdx` 等），不是用户文档。
270 个 `.md` 是 README / AGENTS.md / 迁移说明这类。

**这印证了研究方法论里那条判据**：「开源 + 文档在仓库」这个类别对框架失效——
Langfuse 是开源的，但**文档在 `langfuse-docs`**。
照主仓路径找文档源文件会一无所获。

`langfuse-k8s` 的定位要注意：仓库描述写的是
**"Community-maintained** Kubernetes config and Helm chart"——
即**官方 README 推荐的生产部署方式（Helm）指向一个社区维护的仓库**。
⚠ 「community-maintained」的实际含义（Langfuse 员工是否是主要提交者）本文未核验。

## 22. 未能核验与存疑的部分

::: tip 本文没有验证的部分（照实列出）
本文的证据形态是**本地源码实查 + registry/API 实查**，
但**我们没有把 Langfuse 跑起来**——没起 ClickHouse、没起 Postgres、
没发过一条 trace、没登录过 UI。以下逐条列出未能核验的部分。

**版本边界（最重要的一条）**
- **本地检出 `4.0.0-rc.3`（commit `90b98d00`，2026-07-29）比线上 `v4.6.0`
  落后约 6 个发布。** 凡标「源码实查」的计数数的都是这个检出。
  §4.4 已实测到一处差异（compose 镜像标签），
  **但我没有逐项 diff rc.3 → 4.6.0 的全部变更**——
  本文的任何计数在 4.6.0 上都可能已经变了。
- 涉及「当前默认值」的断言我回 `main` / `v4.6.0` 标签复核过，
  但只复核了我明确怀疑的几处（compose、package.json），不是全面复核。

**行为类（读了代码，没跑过）**
- **§7 的 v4 三个 flag 的实际行为**：三种被拒组合是从
  `validateV4Flags()` 的抛错逻辑读出的，**没有实际起进程验证它真的拒绝启动**。
- **§7.3 的双轨读路径**：`FROM traces` 23 处 / `FROM events_full` 17 处
  是 `grep` 计数，**没有做可达性分析**——不知道默认配置下哪些真的会执行。
- **§8.4 的 S3-先落盘管线**：从注释与代码结构读出，未实测降级路径
  （S3 挂了是否真的退化为「整批塞 Redis」）。
- **§8.5 的采样**：哈希分桶的实际均匀性未验。
- **§10.3 那 11 条优先级链**：读的是注册顺序与判定条件，
  **没有构造 span 实测每条分支**。「支持 N 个框架」这类说法本文只敢说
  「代码里有 N 条针对具体框架的分支」。
- **§11.4 `node:vm` 的实际隔离强度**：本文只陈述它用了 `vm` 且自称 insecure，
  **没有做任何逃逸尝试**，也不推演攻击路径。
- **§14 In-App Agent 的全部运行行为**：那 11 步生命周期、
  两道权限门、审批指纹校验——**全部来自 README 与源码阅读，一步都没跑过**。
  README 是仓库内文档（一手），但它描述的是意图，不等于实测行为。
- **§9 的 37 个队列**：只确认了枚举与注册调用存在，没有观察任何一个队列的实际消费。

**口径与边界类**
- **§9.3 的 QueueName 37 vs QueueJobs 34 差值**：我推断是 3 个 secondary
  队列复用 job 类型，**没有逐条对照 `TQueueJobTypes` 映射表验证**。
- **§16.2 的 OWNER 56 vs ADMIN 55**：差的那一个 scope 是哪个，我没有 diff。
- **§20.1 的 376 个环境变量**：正则只匹配 `KEY: z.` 直接声明，
  漏掉动态构造的键；**官方文档侧的环境变量数完全未核验**
  （文档在独立仓库），所以给不出「文档 vs 源码」的对照。
- **§8.2 观测类型两处重复定义是否有一致性测试**：我没找到，
  但「没找到」不等于「不存在」。
- **§15.4 的限流默认值**：`points` / `durationInSec` 都是 `nullish`，
  实际默认值不在该文件里，我没有追到。
- **§20.3 说 blob 存储枚举没有 GCS**：枚举确实只有三项，
  但「GCS 是否可通过 S3_COMPATIBLE 接入」我没有验证。
- **§21.2 提到的 `langfuse-node` 包**：README 列了它，我没查它的 registry 状态。
- **§21.2 「v5 发布于 2026-03」（README 口径）与 npm 上 `@langfuse/*`
  首个 5.x 稳定版的日期是否对齐**：未逐版本核对。

**无法从外部验证的厂商口径**
- **§18.2 Langfuse Cloud 侧是否另有许可校验**：代码里云侧直接返回 `true`，
  云端实际如何跟踪自部署商业客户的合规，无法从公开代码得知。
- **§18.3 遥测的接收端处理**：README 说不含 trace/prompt 正文，
  代码也确实只发计数——**但发到 PostHog 之后如何存储、保留多久、
  是否与其他数据关联，完全无法外部验证**。这是厂商口径。
- **§21.4 `langfuse-k8s` 的「community-maintained」实际含义**：
  未统计提交者构成。
- **定价、额度、各 plan 的真实商业条款**：本文只读了代码里的 entitlement 表，
  **没有对照官方定价页**。§17.1 那句「self-hosted:pro 不解锁任何 entitlement」
  说的是**代码表里没有差异**，不是「这个许可没有价值」。

**刻意不做的**
- **没有评价这些设计的好坏。** §18 的许可校验、§11.4 的 `node:vm`、
  §18.3 的遥测口径——本文陈述机制与代价，不下「优雅/糟糕」的判断。
  判据是把产品名换成另一家，全文是否依然读得通。
:::

::: warning 两处我自己先数错、留在文里的地方
1. **§2.2 的功能目录数**：`ls | wc -l` 得 **76**，真实目录数 **75**——
   多出的是 `README.md`。正确口径是 `find -type d`。
2. **§13.1 的 MCP 工具数**：三个口径给出 **227 / 78 / 79**。
   227 一眼荒谬（按逗号切对象字面量）所以无害；
   **危险的是 78 与 79 只差 1**——`defineTool(` 调用点数漏了
   `promptReadToolFactory` 被调用两次这件事。**79 才对。**

两处指向同一个教训，与 `ref-litellm` 那篇记的一致：
**「所有计数写脚本数」只解决了「不靠目测」，没有解决「口径选得对不对」。**
脚本给出的每个数字都隐含一次口径选择——数目录还是数目录项、
数「代码写了几次」还是数「运行时注册了几个」——**口径错了，脚本一样会自信地给出错的数。**
第 2 条尤其值得记：**差 1 的错误最危险，因为它看起来像是合理的**；
227 那种离谱的数字反而会立刻被自己抓住。
:::

## 参考资料

**一手来源（本文事实层的主要依据）：**

- **本地源码 clone**：`langfuse/langfuse` `main` 分支，
  **HEAD = `90b98d00`（2026-07-29），`package.json` = `4.0.0-rc.3`**，
  非 shallow（8,233 个提交）。凡属源码结论本文都给出 `路径:行号` 或可复现命令。
  ⚠ **该检出比线上 `v4.6.0` 落后约 6 个发布**，见 §4.3 与 §22。
- **GitHub raw（复核用）**：`main` 与 `v4.6.0` 标签上的
  `docker-compose.yml` / `package.json`（§4.4 那处差异就是这样发现的）
- **GitHub REST API**：`/repos/langfuse/langfuse`、`/languages`、
  `/releases?per_page=100`（拉了 200 条）、`/contents`，
  以及 `langfuse-python` / `langfuse-js` / `langfuse-docs` / `langfuse-k8s` 四个仓库元信息
- **npm registry**：`langfuse`、`langfuse-core`、`langfuse-langchain`、
  `langfuse-vercel` 与 `@langfuse/{core,tracing,otel,client,openai,langchain,browser,vercel-ai-sdk}`
  的版本时间线、依赖、peer、engines、deprecated 状态
- **PyPI JSON API**：`langfuse`（543 个发布的时间线、`requires_dist`、yanked 计数）
- 仓库内一手文档：`README.md`（52,651 字节）、`CONTRIBUTING.md`、
  `LICENSE` / `ee/LICENSE`、`web/src/features/in-app-agent/README.md`、
  `web/src/features/mcp/README.md`、`packages/in-app-agent-sandbox-runtime/README.md`
- 官方文档站（未作为主要事实来源）：[langfuse.com/docs](https://langfuse.com/docs)

**所有原始 JSON 落盘到 `/tmp/lf/` 后只打印摘要，从不整份进上下文。**

**同系列：**

- [LiteLLM 深入研究（2026-08 快照）](./ref-litellm.md)——
  **与本篇关系最近的一篇**：LiteLLM 是 Langfuse 的官方集成之一
  （§1 的集成表里有它），两篇合起来能看清「网关层」与「可观测层」的分工。
  那篇也记录了同类的计数陷阱（五个数据源给出五个不同的 provider 数），
  与本文 §13.1 的「三个口径给出 227/78/79」是同一种病。
  另有一处直接对照：LiteLLM 也是 open-core + 企业版边界，
  可与本文 §17、§18 对读。
- [promptfoo 深入研究（2026-08 快照）](./ref-promptfoo.md)——
  评测侧的对照：promptfoo 是「跑评测的工具」，
  Langfuse 是「存轨迹并在轨迹上挂评测的平台」，
  §11 的 23 个内置评测器可与那篇 §5 的 66 类断言对读；
  两者互为集成（Langfuse README 的集成表里有 promptfoo）。
- [Claude Code 深入研究（2026-08 快照）](./ref-claude-code.md)
- [OpenAI Codex 深入研究（2026-08 快照）](./ref-codex.md)
- [opencode 深入研究（2026-08 快照）](./ref-opencode.md)
- [Gemini CLI 深入研究（2026-08 快照）](./ref-gemini-cli.md)

