# sid-code — 从"个人 Coding CLI"演进为"研发智能基座"

## 北极星：长期宗旨与方向（最高纲领，每次会话必读）

**一句话宗旨：以可度量的轨迹数据为底座，做更快、更省、更安全、深度融合企业级开发环境的 coding agent。**

这四个方向是**长期北极星，不是短期验收标准**。每一个都很难，甚至现在有未达成、未接线的部分——这不是缺陷，恰恰是它值得当方向的理由。

四个方向 + 一个底座（现状标注为 **2026-08-05** 快照，实时数据以 `bun scripts/trace-digest.ts` 为准）：

- **更快**：降低首字延迟（TTFT）与端到端耗时。现状：**TTFT 已有纯净埋点并可查**——`src/llm/stream-lifecycle.ts` 在 lifecycle 层按 `StreamPhase("first_content")` 计算，谓词覆盖 thinking + text、每次 fetch 独立计基准（不受重试与「仅可视文本才触发」双重污染）；两个消费方 `/trace`（`src/trace/digest.ts`）与 `/trace --health`（`src/telemetry/provider-health.ts`）都已迁移到这个纯净源，提供 p50/p95/p99。实测本地 1032 个样本：**TTFT p50 ≈ 4.7s、p95 ≈ 23.0s**。**缺的不再是"能不能测"，而是端到端耗时（用户回车→最终答复）仍无独立埋点，以及没有 release-over-release 趋势。**
- **更省**：降低单位任务 token / 成本。现状：Prompt cache（deepseek 受控 0→83.2%、anthropic 族 99.5%）已验证有闭环；cost 采集覆盖面仍是短板——影子调用已接埋点，但实测 **47/70 会话没有 `session.traj`**（`SessionStart` 70 : `SessionEnd` 8），有效 cost 覆盖约 24%，「省了多少」在多数会话上仍测不准。
- **更安全**：从静态防护延伸到 HITL / 权限规则 / 企业 policy。现状：静态防护层（path-validator / bash-security / 危险命令拦截）对标 CC 极高甚至超越；但权限规则层仍有未修 P0（Bash `*` 不跨 `/`、Read/Edit 路径前缀未实现等）。
- **深度融合企业级**：团队记忆、企业 policy、企业系统接入。现状：网关计费 / 飞书 / MCP / vibe-bugfix 已跑通几个企业系统；企业 policy 层仍是未接线的脚手架，团队记忆刚从「半黑洞」修出。
- **底座 · 可度量 / 数据飞轮**：events.jsonl（1481+ 会话，23 类事件）、trace-digest、eval-session、四环防线触发率脚本。**这不是隐含前提，是宗旨的一部分。** 度量的作用不是「验收目标达没达成」，而是「确认每一步是不是在朝北极星走」——「这次改动让 cost 采得更全 / cache 命中又涨几个点 / 又一个权限 P0 接线了」这种朝向感必须能量出来。**"建好未接线"曾是底座最大的债，2026-08-08 复核后这两条已不成立**（保留原文作漂移记录）：~~`src/analytics/` 1113 行事件管道只挂了 1 个埋点（`logEvent` 全仓仅 `app.ts` 一处），OTel span/metric 的 exporter 白名单硬编码只允许 `console`/`jsonl`（企业要的 OTLP 出口不通）~~ —— 实测 analytics 的 12 个 `log*` 埋点函数全部接线、5 条漏斗共 **25 个生产调用点**（`logEvent` 直接调用只有一处是刻意的：业务侧必须走 `analytics/events.ts` 门面才能强制脱敏，见 `tool-executor.ts:26`）；OTLP 出口在 `telemetry/index.ts` `createExporter`、`config/config.ts:627`、`config/schema.ts:821` 三处白名单里都已接通。清单见 `docs/bugfixes/todo/20260805-可观测性缺陷清单-埋点接线与OTLP出口.md`，复核记录见 `docs/bugfixes/todo/20260805-可观测性接线率门禁-设计与验收.md` §10。
  **这条更新本身是个教训**：上面「更快」那条已经栽过一次同样的跟头（把 2026-07 已修的 TTFT 当缺口继续上报）。**照抄文档里的"现状"而不回源码核验，就会把已修的问题当债写进最高纲领，再被下游文档反复引用放大。**

> **「更快」这条的更新是一次方法论教训，值得记住。** 上一版这里写「几乎无 latency 基线」，实际 TTFT 早在 2026-07-14 那轮就治理完毕（见 `docs/bugfixes/done/AI Agent 核心可观测性指标体系 & sid-code 覆盖缺口分析/`）。**沿用文档里的"现状"描述而不回源码核验，会把已修的问题当成缺口继续上报。** 本文的现状标注同样会漂移——引用前先跑一次 `bun scripts/trace-digest.ts`，或去 `docs/bugfixes/done/` 查是否已闭环。

**方向内部有张力，落地时要正视而非回避：** 更安全（更多 HITL / 权限校验）天然拖慢速度、增加动态内容，而动态内容又伤 cache 命中率=伤省。真实工程演进就是在这几个约束间找平衡，不是四个指标同时拉满。遇到「弹权限确认 vs 少打扰」这类摇摆时，回到这里，明确本次改动在为哪个方向让路。

**每次会话自检（防止方向漂移）：**
1. 这次改动在朝哪个北极星方向走？还是跑偏了？
2. 朝向感能量出来吗？拿什么轨迹数据/信号证明「真的在进步」而非自我感觉？
3. 它牺牲了哪个方向来成全另一个？这个 trade-off 是否可接受、是否点破？
4. 本次有没有碰到**不属于本次任务**的文件？碰之前读过内容、问过我了吗？
   —— 见 §0「⛔ 铁律：不删与本次任务无关的文件和代码」，这条是有过真实数据丢失事故的。

> 目标层面谈方向，执行层面摆数据——两者不矛盾，是分工。方向定死不动摇，剩下的事是把每个词拆成一串能量出进展的台阶，一级一级踩。

## 本文件的定位：agent 约定的唯一事实源

**本仓的 agent 约定只有这一份 `CLAUDE.md`，不要再新建 `AGENTS.md`。**

2026-08-12 前本仓根同时有 `AGENTS.md`（199 行）与 `CLAUDE.md`（253 行），两份讲同一批
硬约束、内容已开始分叉。现已合并进本文件，`AGENTS.md` 删除。理由是实测出来的，不是偏好：

- **Claude Code 不加载 `AGENTS.md`**（实测 v2.1.227：隔离目录里放 `AGENTS.md` + `CLAUDE.md`，
  无头会话只注入 `CLAUDE.md`；二进制里 `AGENTS.md` 只出现在 codex 配置**导入器**里，
  加载器中不存在 `join(dir, "AGENTS.md")`）。本项目由 Claude Code 与 sid-code 自己开发，
  **两者都只读 `CLAUDE.md`** —— 约定写进 `AGENTS.md` 等于写进两个主力 agent 都看不见的地方。
- 一份内容、一个入口，零漂移是结构性保证而非纪律要求。

需要给外部 agent（codex / opencode 等）留入口时，**加一个 `AGENTS.md` 指针文件**
（`本仓约定见 @CLAUDE.md`），**不要把内容搬过去**。CC 侧实测 `@` 引用会递归展开
（`CLAUDE.md → @AGENTS.md → @VISION.md` 三层都进了上下文），所以指针方向反过来也能工作，
但主从关系必须是「`CLAUDE.md` 为主」。

### 与 CONTRIBUTING.md 的分工：流程在那边，别在这里重复写

@CONTRIBUTING.md

**上面这个 `@` 引用会把 `CONTRIBUTING.md` 全文注入上下文**，所以下面这些内容
**本文件刻意不重复**（重复就会漂移，而漂移的约定比没有约定更糟）：

- **分支与工作流**：GitHub Flow、不直推 `main`、分支命名、squash merge、什么时候要先开 issue
- **五道 CI 门禁的完整列表**与两个 git hook 门禁
- 测试落盘隔离的四个踩坑细节

两份文件的受众不同、内容互补，**规则完全一致**：

| | `CLAUDE.md`（本文件） | `CONTRIBUTING.md` |
| --- | --- | --- |
| 受众 | agent（CC / sid-code 自己） | 人类贡献者 + agent（经上面的 `@` 引用） |
| 内容 | 北极星方向、踩坑教训、铁律、为什么这么设计 | 环境准备、分支/PR 流程、门禁清单、风格约定 |

**改流程类规则时改 `CONTRIBUTING.md`，本文件只在需要解释「为什么」时补一句。**
反过来，北极星与事故教训留在本文件，不要往 `CONTRIBUTING.md` 搬。

## 0. 全局约束（每次会话必读）

- **语言**：所有回复、代码注释、文档均用中文
- **联网工具**：遇到不熟悉的 API / 库 / 报错信息时，主动用 tavily-mcp / context7-mcp 查最新文档，不要凭记忆猜
- **构建验证**：task 完成后跑 `bun test`（全量单测，以实际输出为准）以及跑 `make build` 验证构建成功，**不可跳过，必须执行**
  —— 日常开发只用 `make build`（不动版本号）。**不要**用 `make build-bump`，它会把版本号 +1。
  CI（`.github/workflows/ci.yml`）除这两条外还有一个独立的 `lint` job：`bun run lint`（oxlint）
  与 `bun run lint:boundary`（包边界扫描）。动了跨包导入就跑一次后者，否则 PR 会在 CI 才红。
- **改了参考页数据源要重新生成官网参考页**：动过 `packages/cli/src/help.ts`、`packages/cli/src/cli.ts`、`packages/core/src/tool/`、`packages/cli/src/command/`、`packages/core/src/config/`、`packages/core/src/hook/` 之后，跑一次
  `bun run docs:gen-reference`，并把 `website/ref/` 与 `website/public/llms.txt` 的改动一并提交。
  `website/ref/` 下 6 页（CLI 参数 / 工具 / 斜杠命令 / Hook 事件 / settings 字段 / 环境变量）是**从源码生成**的，
  源码改了不重新生成就是文档骗人——用户照着文档写一个不存在的参数比没有文档更糟。
  pre-commit 会跑 `--check` 拦住这种漂移（未装 hook 先跑 `bun run install-hooks`）。
  设计与验收见 `docs/reference/官网与文档站设计方案.md` §4.5。

### 文档位置：本仓只有 `website/` 与 `evals/`

本仓没有 `docs/` 目录，**不要重建它**。本仓的文档只有两处：面向用户的 `website/`，
以及 `evals/` 下的评测资产。开发过程文档（方案 / 复盘 / ADR / 调研）不放在本仓，
写到你本地的文档库里。

三条配套事实：

1. 源码与测试注释里有约 130 处 `docs/xxx.md` 形式的路径引用，指向仓外的文档库。
   **它们是历史线索，不是断链** —— 不要因为「文件不存在」把这些注释删掉。
2. `docs:lint` / `docs:index` / `docs:frontmatter` / `docs:check` 四个 script 不存在，
   对应的 workflow 与 ci.yml job 也没有。别照着旧文档去跑它们。
3. **`docs:gen-reference` 系列不受影响**，它生成的是 `website/ref/`（用户参考页）。
   §0 上面那条「改了参考页数据源要重新生成」仍然有效，两件事不要混。

### 测试约定：有落盘副作用的函数，测试必须显式隔离

**判据：只要一个函数除返回值外还有「写 `~/.sid-code/`」这种进程外副作用，
调它的测试就必须把落盘目标重定向到 tmpdir。**

两种隔离手段任选（都是每次调用重新读 env，`beforeAll` 里设即生效）：

- 专用重定向变量，如 `SID_CODE_CACHE_BREAKS`（`src/telemetry/cache-telemetry.ts:41`）
- `SID_CONFIG_DIR` —— 改写整个配置根目录（`src/config/paths.ts:27`）

另有一道**兜底**：`tests/preload-isolate-sid-home.ts`（`bunfig.toml` 的 `[test].preload`）
在进程启动时把 `SID_CONFIG_DIR` 默认指向临时目录。因为很多落盘组件是在调用链深处被
**无参构造**的（如 `PermissionChecker` 里 `new AuditLogger()`，`src/permission/checker.ts:360`），
测试作者根本看不见它——这类污染靠"记得隔离"防不住，得让隔离成为默认值。
兜底不替代显式隔离：要断言落盘内容的测试仍应自己设专用变量。

⚠️ **P1-2 测试分包后，这道兜底有第二个失效面**：根 `bunfig.toml` 的 preload 只在
以**仓库根为 cwd** 跑 `bun test` 时生效。测试已迁进 `packages/<pkg>/tests/`，一旦有人
`cd packages/core && bun test`，读不到根 bunfig → 兜底消失 → 直接写用户真实 `~/.sid-code/`。
修法是每个含 `tests/` 的包各放一份 `bunfig.toml` 指回根预载文件；**新增包时必须一起加**。
门禁见 `tests/build/test-isolation-preload-wiring.test.ts`（静态检查接线，因为缺 preload
的唯一症状是数据静静写进家目录，没有任何断言会失败）。

四个易错点（都是实测踩到的）：

- **必须存/恢复原值，不要无条件 `delete`**。`bun test` 同一批多文件跑在**同一个进程**，
  直接删会把 preload 的兜底一起抹掉。实测 `bun test packages/core/tests/permission` 单跑泄漏 0 行，
  而 `packages/core/tests/{migrations,permission}` 同批跑泄漏 84 行——就是 migrations 里无条件删掉了它。
- **落盘走 `import().then()` 的要先让微任务跑干**再恢复 env（`await new Promise(r => setTimeout(r, 0))`），
  否则同步恢复会与待处理的写赛跑，让最后几条漏写到真实路径。
- **不要硬编码 `join(homedir(), ".sid-code", ...)` 算期望路径**，用 `getSidHome()` 派生。
  硬编码等于"真的往用户家目录写，再断言它写成功了"——隔离一生效立刻失配。
  已修：`packages/core/tests/trace/crash-marker.test.ts`、`packages/core/tests/trace/pid-manager.test.ts`。
- **spawn 子进程的 e2e 测试要显式传 `SID_CONFIG_DIR`**，子进程不继承进程内的 env 改动。
  更隐蔽的是 `debugLogFile` 默认值是**字面量** `"~/.sid-code/debug.log"`
  （`src/config/config.ts:757`、`app-config.ts:134`），不走 `getSidHome()`，
  `SID_CONFIG_DIR` 管不到——`packages/cli/tests/cli/flag-e2e.test.ts` 曾因此每跑一次就**截断**用户真实的
  `debug.log`（缩小 56 字节，是破坏不只是污染），得在测试配置里显式写 `debug_log_file`。
  这个测试还顺带暴露：它原本读用户真实 `settings.json`，只在"本机恰好配好模型"时才通过。

**2026-08-03 真实污染（本条约定的来源）**：`recordCacheBreak()` 除推内存环形缓冲外还落盘遥测
（`src/api/cache-detection.ts:428`），两个测试没设隔离，把 `~/.sid-code/cache-breaks.jsonl`
灌进 6 万余行假数据（`ts=1700000000` 等测试字面量），`/cache --history` 的读取窗口里
**一条真记录都看不到**。三个条件让它成为静默故障：落盘 fire-and-forget 吞异常、
测试只断言内存缓冲、10MB 才轮转所以污染静静堆积。

**光跑 `bun test` 看绿是验证不了这件事的**——污染时它也全绿。验证手法是
「记录文件行数 → 跑测试 → 再记录 → 必须一致」。防复发门禁见
`packages/core/tests/telemetry/no-real-path-writes.test.ts`
（静态扫描**全部** 5 个测试根：4 个包内 `tests/` + 仓库级根 `tests/`）。

### ⛔ 铁律：不删与本次任务无关的文件和代码（多任务并行前提）

**这个仓库里随时可能有多个任务并行执行**——人在写文档、另一个 agent 在改代码、测试在跑。
因此 `git status` 里的「意外文件」**默认属于别人的在途工作，不是你的脏数据**。

禁止的操作（除非用户明确要求删除这个具体目标）：

- `rm` / `rm -f` 任何不是你本次亲手创建的文件
- `git checkout -- <dir>` / `git checkout -- <file>`、`git restore`、`git reset --hard`、`git clean`
  —— 这类命令会**静默且不可逆地**丢弃未提交改动，没有回收站、没有 reflog 可救
- 以「清理测试产物」「回到干净状态」为由批量还原目录

必须遵守的判断顺序：

1. **动手前先读**。要删/还原任何文件，先 `Read` 或 `head` 看一眼内容。
   人写的文档和生成产物一眼可辨——省这一步就是在赌。
2. **git status 快照是证据**。会话开始时的 git status 里已存在的改动，**一定不是**你或测试
   造成的，是用户的在途工作，绝对不许动。
3. **区分「测试写脏」与「别人在写」**。测试确实会写产物（如 `website/ref/`、`llms.txt`），
   但产物路径是确定且可枚举的；出现在预期之外路径的新文件，按「别人的工作」处理。
4. **不确定就问，或者干脆不动**。留着一个多余文件的代价是零；删错一个文件的代价是
   用户几小时的工作凭空消失。工作区不干净**不影响**你交付任务。

**2026-07-28 真实事故（本条铁律的来源）**：误判用户并行写的 `website/` 文档为「测试脏产物」，
`rm` 两个新页 + `git checkout -- website/`，**2 个未 add 的新页面 + 约 300 行已追踪改动永久丢失**，
所有恢复途径查证全空。两个被忽略的信号：① `config.ts` 在**会话初始** git status 快照里就是 `M`，
不可能是测试产物；② 动手前**从未读过**文件内容。完整复盘见
`docs/bugfixes/done/20260728-误删并行任务文件-数据永久丢失复盘.md`。

教训一句话：**归因错误 + 立即执行不可逆操作 = 数据永久丢失。
先读再判断，不可逆操作先问，工作区脏不是理由。**

## 1. 开发 / 发布 / 更新三线流程

### 本地环境：双版本并存

| 命令                      | 指向                                          | 版本   | 用途         |
| ------------------------- | --------------------------------------------- | ------ | ------------ |
| `sid-code` / `sc`         | `~/.local/bin/sid-code` → 线上下载版          | 稳定版 | 验证线上版本 |
| `sid-code-dev` / `sc-dev` | `~/bin/sid-code-dev` → 本地构建产物（仓库根） | 开发版 | 日常开发调试 |


两条命令是**不同的二进制名**，不靠 PATH 优先级区分。

> **⚠️ 调试铁律：改了代码要验证，必须跑 `sc-dev`（开发版），不要跑 `sc`。**
> `sc` / `sid-code` 现在指向**线上稳定版**，跑它验证不到你本地的任何改动——历史上 `sc` 曾经是开发版，肌肉记忆很容易搞错，导致「代码改了、命令跑错、验证不生效」白忙一场。判断口诀：**验证本地改动 → `sc-dev`；对照线上行为 → `sc`。** 拿不准时先 `which sid-code-dev sid-code` 确认指向。

### 日常开发

```bash
git pull          # 拉最新源码
make build        # 构建二进制（版本号不变，日常就用这个）
sc-dev            # 启动开发版（注意是 sc-dev，不是 sc）
```

> **一句话记法：本地开发只有 `make build`。** 它不动版本号，跑多少次都一样。
> 带 `-bump` 后缀的目标才会改版本号，而版本号只在发布时才该变——发布走 `release.sh`，
> 它自己会 bump，**不需要**你先手动 bump。

### 发布上线

**⚠️ 铁律：先提交功能代码，再发布。禁止先发布后提交。**
发布产物必须能对应到一个确切 git commit。先发布后提交会开一个「已发布但未提交」的窗口——期间任何源码改动都会让线上二进制与 commit 对不上，出线上问题无法定位到确切代码版本。

这条铁律现在由脚本**机械化执行**，不再只靠人记（2026-08-01）：

- `release.sh` 开头有**工作区洁净门禁**，脏就直接拒绝发布（确认无碍加 `--allow-dirty`）。
- bump 提交与 tag 都由 `release.sh` 自己完成，且 tag 打在 bump 提交上、当场校验对齐。以前是「tag 打在 bump 前的 HEAD、bump 提交人工补做」，导致 tag 指向的 commit 里版本号比 tag 低一位（实测 v0.1.591…v0.1.596 **六个 tag 全部错位**，`git checkout <tag>` 重建不出对应二进制）。

标准顺序（脚本接管了原来的第 4/5 步，现在只有 4 步）：

```bash
# 1. 验证构建（全量单测由 release.sh 门禁负责，此处不重复跑）
make build

# 2. 提交功能代码（工作区必须干净，否则 release.sh 会拒绝）
git add <改动文件>
git commit -m "feat: ..."

# 3. 发布：门禁(bun test) → bump → changelog → 4 平台构建 → 冒烟+自检
#    → 自动提交 `bump vX.Y.Z` → 打 tag（对齐校验）→ 原子上传 → push tag
./scripts/release.sh --upload

# 4. 推送 + 发布官网（/changelog 是站点构建期快照，release.sh 只生成数据不发站点）
git push
./scripts/website-deploy.sh
```

> **中途失败直接重跑，不需要 `--no-bump`。** 脚本装了 EXIT trap：非正常退出会把 `package.json` 与 changelog 产物回滚到运行前状态（只回滚运行前本就 clean 的文件，不会吃掉你自己的改动），所以失败不再消耗版本号。已创建的本地 tag 刻意不删（创建幂等），重跑复用。
>
> `--no-bump` 现在只用于一个场景：你显式跑过 `make build-bump` 已经 bump 过，不想再 +1。
>
> **Changelog + Tag**：release.sh 在 bump 后重建 changelog；构建与冒烟全部通过后自动提交 `bump vX.Y.Z`，再把 annotated tag `vX.Y.Z` 打在**这个提交**上（`generate-changelog.ts` 会过滤 `^bump v\d` 提交，所以它不会污染 changelog）。每次运行完整重建，确定性且幂等。两份产物各有唯一职责：
>
> | 产物 | 职责 | 内容来源 |
> | --- | --- | --- |
> | `CHANGELOG.md` | 文本事实源，给 diff / `curl` / 脚本 | git 历史（**全量原始提交**，按 feat/fix/docs/… 6 组） |
> | `website/.vitepress/data/changelog.json` | 官网 `/changelog` 页的数据源，由 `theme/Changelog.vue` 渲染 | `changelog/curated/*.json`（**用户视角文案**，4 组受控词） |
>
> **两个受众，两条渲染路径**（2026-08-06 curated 改造）：commit message 的读者是未来的自己，changelog 的读者是用户，靠正则做不了这个转换（实测 276 条提交里 24% 是用户完全不关心的文档/杂项）。所以官网正文来自**人工过目过的** curated 文案：
>
> ```bash
> bun run changelog:curate            # 为下一个版本起草（spawn sid-code 自己读 diff 改写）
> bun run changelog:curate 0.1.601    # 指定版本 / 补跑
> bun run changelog:check             # 不调 LLM，只校验已入库的全部文案
> ```
>
> 产出 `changelog/curated/v<version>.json` → **读一遍**（脚本会把条目打印到终端）→ 需要就直接改 JSON → commit。发版前 release.sh 会检查该文件是否存在，缺了会交互确认一次（放在构建**之前**，此刻补还来得及）。
>
> ⚠ **四条禁令**，破了就是数据错乱、内容失真或每次 commit 都红：
> - `release.sh` / `generate-changelog.ts` **绝不调 LLM**，只读已入库的 curated 文件 —— 发布路径必须确定性 + 离线 + 幂等，把一次 LLM 调用塞进发布链会同时破掉这三条。
> - curated 文件**必须人工过目**才提交。校验器只拦形态（词表、长度、URL、字段自洽），拦不住「把内部重构写成用户特性」「漏掉一个真实的破坏性变更」—— 这两类只有人能拦。
> - `CHANGELOG.md` **必须保持全量原始提交**（含 hash、docs/其他 分组）。curated 漏了东西时它是唯一的回溯途径。
> - `website-deploy.sh` **不得**重跑 `generate-changelog.ts` —— 会把 HEAD 上尚未发版的提交归到已发布的版本号名下。只有 `release.sh` 有资格生成这份数据。
> - changelog 产物**不纳入** `docs-gen-reference --check` 那类反漂移门禁 —— `website/ref/` 能立门禁是因为源是源码；changelog 的源是 git 历史，每提交一次就变。
>
> **用户看更新日志的唯一入口是官网 `http://<host>/changelog`**（2026-07-28 起）。它和文档站同站同配色，自带只搜版本变更的独立搜索框，且**不进全站搜索索引**（否则几百条变更描述会把正常查询冲成噪音）。实现见 `website/.vitepress/config.ts` 的 `search.options._render`。

**上传凭据**：SSH 信息读自 `scripts/deploy.env`（不入库，见 `deploy.env.example` 模板）。
配了 `DEPLOY_SSH_PASSWORD` 后用 sshpass 免交互上传，无需每次输密码。首次配置：
`cp scripts/deploy.env.example scripts/deploy.env` 后填入真实值。

### 用户更新（或自己验证线上版）

```bash
sid-code update    # 下载服务器最新版
sc                 # 启动线上稳定版（sc / sid-code 就是线上版）
```

### 三个构建目标职责

| 命令                            | 版本号 | 用途                                                  |
| ------------------------------- | ------ | ----------------------------------------------------- |
| `make build`                    | 不变   | **日常开发（99% 的场合）**：改完 / 拉完代码重建二进制 |
| `make build-bump`               | +1     | 少见：想本地自测一个带新版本号的二进制                |
| `./scripts/release.sh --upload` | +1     | 正式发布：构建 4 平台制品并上传到服务器               |

**选哪个：默认 `make build`。** 只要你不是在专门测「版本号本身」，就用它。
`make rebuild` 保留为 `make build` 的别名（历史文档里到处是它），敲了也不会出错，
但新写的文档 / 命令一律用 `make build`。

> **命名为什么是这样**（2026-07-31 调整，别改回去）：`build` 是所有项目里「编译一下」的通用词，
> 人和模型都会条件反射地敲它。旧设计把 `build` 绑成「bump 版本号 + 编译」、把日常不 bump 的构建
> 叫 `rebuild`，语义正好反了 —— 结果本地开发反复误敲 `make build`，静默把版本号 +1，后面再跑
> `release.sh` 就一次跳两个版本。现在最容易被敲到的词绑到最安全的行为上：**敲错只是白编译一次。**

三条由「版本号内联进二进制」派生的规则（`bun build --compile` 编译时把 `package.json` 写进产物，git pull 更新源码不会改它）：

- **源码更新后必须重新编译**，否则跑的还是旧代码。
- **版本号只 bump 一次**：直接 `./scripts/release.sh --upload`，别先跑 `make build-bump`（它也 bump，会让版本号 +2）。已 bump 过用 `--no-bump --upload` 复用。
- **`build-bump` / `release.sh` 之后补一次 `make build`**：发布制品是跨平台编译产物，仓库根的开发版二进制不会跟着更新，内联版本号还停在旧值 —— 不补则 `sc-dev` 显示的版本比线上低一位，容易误判。

## 2. 技术栈与入口

TypeScript + Bun + Ink（vendor 进 `packages/tui-renderer/src/`），编译成单文件二进制分发。
代码按 workspace 分包：`packages/{core,cli,shared,tui-renderer,eval-framework}`。

- CLI 入口：`packages/cli/src/cli.ts`；无头入口：`packages/cli/src/entrypoints/bootstrap.ts`
- 真实主循环：`packages/core/src/query/loop.ts` 的 `queryLoop`（核心是 agentic while-loop）
- 配置目录：`~/.sid-code/`；Hook 环境变量前缀：`SID_CODE_`

**不要在文档或记忆里维护静态目录树**——它必然漂移。需要时用 `ls packages/*/src/` 自查。

> ⚠️ 分包是 2026-08-11 才完成的（`git mv` 分 4 包）。历史文档、注释、记忆里大量
> `src/xxx.ts` 形式的路径**已经失效**，真实位置在 `packages/{core,cli,…}/src/` 下。
> 照着旧路径 `Read` 会直接报文件不存在 —— 用 `find packages -name "<文件名>" -not -path "*/node_modules/*"` 定位。

## 3. 语言与工具使用

- **所有回复、代码注释、文档、提交信息用中文。**
- 遇到不熟悉的 API / 库 / 报错，**主动查最新文档**（联网检索或 context7 之类的文档源），
  不要凭记忆猜。凭记忆写出来的 API 调用是这里最常见的返工来源。
- **计数必须写脚本数，禁止目测**。「大概有 30 个」这种估算实测错误率极高。
  写个 `grep | wc -l` 再报数字，并且检查你的口径是不是在数你以为的东西
  （`grep -l` 数的是文件数不是命中数）。

## 4. 注释的写法

注释解释**为什么**，不解释代码在做什么。

仓库里有大量注释记录了「这里踩过什么坑、为什么不能改回去」，例如 `Makefile` 里
`BUILD_DEFINES` 那段解释了不定死 `NODE_ENV=production` 会让发布产物跑 React
development build、进而刷用户的屏。**这类注释是资产**：

- 遇到时**读它**，它通常正好在回答你「这里为什么写得这么奇怪」的疑问；
- **不要因为「看着啰嗦 / 不专业」删掉**；
- 措辞不准可以改准确，**来源事实与踩坑记录不许抹掉**。

## 5. 编辑文件时的操作纪律

- **`old_string` 必须在文件里唯一匹配**，不唯一就多带 2-3 行上下文。
- **改动超过 30 行、或同一文件要改 3 处以上：直接整块覆盖**，不要连续做多次小 edit
  ——多次编辑之间文件状态会漂移，后面的匹配容易失配。
- **编辑连续失败 2 次就停下来重新读整个文件**（或失败区域 ±20 行），
  不要反复微调匹配串瞎猜。文件可能被格式化工具、其他 agent、hook 改过。
- **不要用 `sed -i` / `awk` / `echo >>` 绕过编辑失败**。这类 workaround 让人看不到 diff，
  也容易引入新错误。正确做法是定位失配原因再重试。

## 6. 提交信息

用 Conventional Commits，因为 `CHANGELOG.md` 是从 git 历史机械生成的
（`scripts/generate-changelog.ts` 按 type 分组）：

```
feat(cache): 新增 XXX
fix(tool): 修复 YYY 在 ZZZ 下不生效
```

识别的 type：`feat` / `fix` / `refactor` / `perf` / `docs` / `style` / `test` / `build` / `ci` / `chore`。
描述用中文。

**只在被明确要求时才提交**。不确定先问。

## 7. 碰到 `packages/tui-renderer/src/` 之前

`packages/tui-renderer/src/`（终端渲染底座）**不是本项目原创**，且含有**我们未获授权**的
第三方增量修改。改动它之前先读 [NOTICE](./NOTICE) 第 1 节与
[`packages/tui-renderer/src/README.md`](./packages/tui-renderer/src/README.md)。

其中一条明确禁令：**不要以「清理痕迹 / 统一措辞 / 看着不专业」为由删除代码里的
来源标注与「照搬 claude-code」之类的注释**。删了不降低风险，只把过失变成故意，
并且让任何想核实的人无从核实。

## 8. 改 TUI 之前

改 `packages/cli/src/ui/` 下的任何东西之前，先读 `packages/cli/src/ui/CLAUDE.md`——
那里有具体的样式与交互铁律。配色走 `getSemanticColors()`，改配色前先打印它确认
取到的是当前主题的值。

## 9. 收尾自检

除了「北极星」那节的四问，收尾前再问自己：

1. 这次改动解决的是用户提的问题，还是我顺手扩大/缩小了范围？
2. 我拿什么证明它真的生效了？（跑了什么命令、看到什么输出，
   而不是「机理上讲得通」）

关于第 2 点有一条实测教训：**目标指标改善 + 测试全绿 + 机理讲得通，
三者同时成立时结论仍然可能是错的**。收尾必须回到端到端的真实指标上验证，
不要只看你专门优化的那个代理指标——代理指标会奖励「把浪费重新贴个标签」。
