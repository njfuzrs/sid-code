# sid-code — 长在企业研发环境里的 coding agent

## 北极星：长期宗旨与方向（最高纲领，长期不变）

**一句话宗旨：别人给你一个 agent；sid-code 给你一个你能改、能量、能审、数据不出门的 agent 底座——然后用你自己的轨迹数据，让它每个版本都更快、更省、更少返工。**

### 四大特性（能演示）

1. **企业级** —— 长在企业研发环境里：内部网关（含计费取价口径）、内网 GitLab、企业 SSO、MCP、团队默认配置分发、企业 policy、缺陷系统闭环。用户收益是「装上就接得上你公司已有的那套东西，不用先改造企业来适配工具」。
2. **可定制** —— harness 整套可改，模型任你换。三层：**配置层**（多 provider 三族协议、降级链、权限规则、团队默认值，改一行配置）/ **扩展层**（Hook、Skill、子代理、MCP、插件多种源，写一个文件）/ **源码层**（工具、上下文工程、主循环全部开源可改，提一个 PR）。
3. **数据主权** —— 代码、对话、轨迹、评测、成本账本全部本地，不进任何人的训练集，数据在自己手上，才谈得上用它做优化。
4. **可观测** —— 每一轮的耗时、成本、决策都留有轨迹，发布前能跑评测知道有没有退步。**它不是技术细节，是四大方向的载体**：没有轨迹就画不出那四条曲线。

### 四大方向（能复算 · 按 release 出一条曲线）

每个方向都是**一个主口径（那条曲线）+ 一组辅助口径（曲线动了要能归因到哪一层）**。
只有主口径进 release 曲线，辅助口径是排查时的分解项——但**辅助口径缺失时主口径动了也说不清为什么**，
所以两者都列。三档标注按事实分：**✅ 轨迹里已有**（可直接复算）/ **⚠️ 有采集但口径要小心** / **❌ 尚未采集**（想用先补埋点，别拿它当结论）。

四条**跨方向通用铁律**（都是踩出来的）：

1. **一律看 p95/p99，均值会骗人**。慢尾巴才是用户流失点。
2. **每个指标必须能指到源字段**。说不出取数源的数字就是自我感觉，见自检第 2 问。
3. **分母比分子重要**。「命中率」「成功率」「触发率」的分母口径一变，曲线就整体平移——分母必须和指标一起写死。
4. **区分 stock 与 flow**。末次快照值（如 `total_tokens_sent`）除以累加值（如 `total_cost_usd`）得到的是错数，
   要用累积字段（`total_cumulative_prompt_tokens`）。

#### 更快 —— 延迟类

| 层 | 指标 | 状态 / 取数源 |
| --- | --- | --- |
| **主口径** | **TTFT** p50/p95/p99 + **端到端耗时**（用户回车 → 最终答复） | ✅ `StreamPhase(first_content).ttft_ms` 是**唯一干净源** |
| 归因：卡在哪一段 | **TTFB**（首字节，拆「网关握手」vs「模型 prefill」） | ⚠️ `headers_received.ttfb_ms`：协议层同口径，**语义受网关缓冲策略影响，跨路由不可比**——必须按 model 分组看（`latencyByModel`） |
| | **纯生成耗时** gen p50/p95/p99（单次 fetch，不含重试） | ✅ `RetryTelemetry(stream_completed).elapsedMs` |
| | **整轮 API 耗时**（含握手 + 生成 + 重试） | ⚠️ `AfterModelRaw.elapsed_ms`，**别与 TTFB 混**，渲染必须标「整轮」 |
| | **工具执行耗时** —— 回答「慢在模型还是慢在工具」 | ✅ `PostToolUse.duration_ms` / `total_tool_duration_ms` |
| 体感 | **tokens/sec**（输出流速，比 TTFT 更贴「生成快慢」体感） | ✅ `output_tokens_per_sec` |
| | **TTFT 按缓存命中分桶** —— 缓存到底让首字快了多少的唯一对照口径 | ✅ `ttftByCache.hit/miss` |
| 缺口 | **TPOT / ITL**（token 间隔，决定打字流畅感）、**Goodput**（满足 SLO 的有效吞吐） | ❌ 全仓零命中；goodput 还需先定义 SLO |

**TTFT 的口径铁律**（这条有 P0 bug 教训）：必须是**首个任意内容 chunk**（含 thinking / tool_use），
且**每次 fetch 单独计、不跨重试累计**。只在可视文本上计 → 对 thinking 模型和纯工具调用轮系统性虚高数十秒。

**TTFB 的口径铁律：禁止跨网关路由汇总**（实测教训，上表那格原写「两族已同口径」是错的）。
同一底层模型走不同网关路由，`ttfb` 的**语义不同**：一路是「模型开始出字」，另一路是
「网关接单了」。实测 51 会话 / 1372 对：`deepseek-v4-pro` 的 `ttft − ttfb` gap 占比 p50 = **86.77%**
（ttfb 484ms → ttft 3983ms），而 `origin-deepseek-v4-pro`（**同底层模型、同属 provider `openai`**）
只有 **5.02%**——差 17 倍。按 provider 汇总出的 `ttfb p50 = 2665ms` 是个假数，
它既不描述前者也不描述后者，却会让人下「首字节很快」的结论。

- 判据：`(ttft − ttfb) / ttft` 的中位数就是**路由缓冲指纹**，**> 50% 即该路由在抢先回 header**。
- 因果方向别搞反：gap 大**恰恰发生在网关响应最快的时候**（gap>50% 的样本 ttfb p50 仅 483ms），
  所以这个差值**不是**框架开销，是「网关缓冲 + 模型 prefill」。别拿它做「框架 overhead 拆解」。
- 落地：单一事实源在 `packages/core/src/trace/latency-by-model.ts`，`digest.ts` 与
  `provider-health.ts` 共用。该模块**刻意不提供跨 model 汇总的 TTFB API**——提供了就会有人用。

#### 更省 —— token / 成本 / 缓存 / 上下文

| 层 | 指标 | 状态 / 取数源 |
| --- | --- | --- |
| **主口径** | **单位任务的 token 与成本** | ✅ 账本 `usage-ledger.jsonl` + `metadata.total_cost_usd` |
| 缓存 | **cache 命中率** = cache_read ÷ 总 input | ✅ 目标 >70%（Anthropic 族显式缓存）；**OpenAI 族隐式缓存结构性上限 60–70%**，别拿同一阈值考核两族 |
| | **cache_read / cache_creation 拆分**、**cache break 次数与归因** | ✅ 归因要分清「本地前缀断裂」vs「服务端 TTL / 路由抖动」——只有前者是我们的 bug |
| 上下文（agent 特有） | **上下文占用率** used ÷ window（有效区 <50–65%）、**峰值与趋势** | ✅ `context_usage_peak_ratio` / `_peak_tokens` / `_trend` |
| | **turns per task** —— **会话长度是成本最大杠杆**：2× 轮数 ≈ 3–4× 成本 | ✅ `metadata.total_steps`（后段每轮更贵，第 N 轮 input ≈ N × 第 1 轮） |
| | **compaction 次数**（压缩丢信息 → 重读文件 → 重复付费） | ✅ `metadata.compactions` |
| 成本结构 | **reasoning / thinking token 单独计** | ✅ `total_reasoning_tokens`（OpenAI 族 >0；Anthropic 族恒 0，靠 `has_thinking` 区分） |
| | **side-call 成本**（标题 / 摘要 / recall 等辅助调用） | ✅ 影子调用绕过主埋点，是最易漏计的一块 |
| | **retry 白烧占比** + 白建连接数 | ✅ `retryWastedRatio`（>20% 判病态）/ `extraConnections` |
| 缺口 | **output ÷ input 比**（输出单价是输入的 3–8×，成本主要由输出主导） | ❌ 数据齐全，从未做除法 |
| | **cost per successful task**（= 成本 ÷ 成功率）、**tasks-per-dollar** | ❌ 2026 公认唯一真正重要的成本指标；**需先定义「任务成功」信号**才能算 |

#### 更准（内部口径叫「更少返工 / 一次做对」）

**「更准」不是「模型更聪明」**（那不由我们控制），准确主语是 harness：
**同一个模型，在 sid-code 里返工更少、一次做对的比例更高。** 四层从过程到结果：

| 层 | 指标 | 状态 / 取数源 |
| --- | --- | --- |
| ① 过程病态率 | retry 浪费比 / 白建连接、backtrack、步数比、**空转**（最长「重复调用且返回值不变」段） | ✅ `retryWastedRatio` / `extraConnections` / `maxUnchangedObservationRun`（≥3 判病态） |
| ② 工具层 | 工具调用成功 / 失败率 | ✅ `PostToolUse.is_error` |
| | **tool selection accuracy**（选对工具的比例，<90% 说明工具太多或描述差）、**tool retry rate**（同一步失败重试率） | ❌ 均未派生 |
| ③ eval 通过率 | 回归套件通过率，每次发布都跑 | ✅ `evals/` |
| ④ 编辑一次成功率 | 首次 edit 即成功的比例 | ⚠️ 只有连续失败信号（`edit-failure-tracker`），**成功率本身未派生** |
| 结果 / 归因 | 人工介入率 / 返工率、**exit status 分布**（end_turn / 中断 / 错误） | ✅ `metadata.exit_status` |
| | 子代理成败与串并行判定 —— 消灭「全部 SUCCESS」类误判 | ✅ `SubAgentSummary`（`concurrency: serial/parallel/mixed`） |

**hallucination rate（<5%）刻意不追**：在 coding agent 上没有可复算的 grounded 分母，
追它只会得到一个自己定义、自己达标的数字。它的位置由 ② 与 ③ 顶上。

#### 更安全

**难点在度量**：安全是「坏事没发生」，负面事件天然稀疏，
**用事故数当指标则分母恒 0、曲线恒平，分不清是防线起作用还是运气好**。所以一律换成正面信号：

| 指标 | 状态 / 取数源 |
| --- | --- |
| **防线触发率** —— 分母限定在「审计核查类任务」，全量任务的分母会把信号稀释掉 | ✅ `scripts/defense-trigger-rate.ts`（实测审计类任务 0% 触发，即「防线全在、调用全 0」） |
| **HITL 介入率**（分工具 / 分规则）与确认耗时 —— 它同时是「更安全 ↔ 更快」这个 trade-off 的计价器 | ❌ trace 层无权限决策埋点 |
| **权限规则匹配正确率**（该拦的拦住、不该拦的别拦） | ❌ 同上，当前只能靠单测 / e2e 断言，出不了曲线 |
| **policy e2e 拦截验证**、fail-closed 路径触发计数 | ⚠️ 有 e2e 断言，无长期趋势 |

**新增防线时的验收判据**：不是「build 过 + 单测过」，而是**「真实会话里被触发过」**——
防线自己成了它当初要消灭的死功能，这事已经发生过一次。

### 主指标：四条方向必然互斥，需要一个仲裁者

对立关系是明确的：**更安全 ↔ 更快/更省**（HITL 确认拖慢速度；动态内容伤 cache 命中=伤省）；**更准 ↔ 更省**（多验证一步更准但更贵）。四个指标不可能同时拉满，**没有仲裁者时四条会互相欺骗**。

### 每次会话自检（防止方向漂移）

1. 这次改动在朝哪个北极星方向走？还是跑偏了？服务的是哪一条特性？
2. 朝向感能量出来吗？拿什么轨迹数据/信号证明「真的在进步」而非自我感觉？**它经过三问核验了吗？**
3. 它牺牲了哪个方向来成全另一个？这个 trade-off 是否可接受、是否点破？
4. 我引用的「现状」是回源码/轨迹核过的，还是照抄文档的？
5. 本次有没有碰到**不属于本次任务**的文件？碰之前读过内容、问过我了吗？
   —— 见 §0「⛔ 铁律：不删与本次任务无关的文件和代码」，这条是有过真实数据丢失事故的。

## 与 CONTRIBUTING.md 的分工：流程在那边，别在这里重复写

@CONTRIBUTING.md

**上面这个 `@` 引用会把 `CONTRIBUTING.md` 全文注入上下文**，所以下面这些内容
**本文件刻意不重复**：

- **分支与工作流**：GitHub Flow、不直推 `main`、分支命名、squash merge、什么时候要先开 issue
- **五道 CI 门禁的完整列表**与两个 git hook 门禁
- 测试落盘隔离的四个踩坑细节

两份文件的受众不同、内容互补，**规则完全一致**：

| | `CLAUDE.md`（本文件） | `CONTRIBUTING.md` |
| --- | --- | --- |
| 受众 | agent（CC / sid-code 自己） | 人类贡献者 + agent（经上面的 `@` 引用） |
| 内容 | 北极星方向、踩坑教训、铁律、为什么这么设计 | 环境准备、分支/PR 流程、门禁清单、风格约定 |

## 全局约束（每次会话必读）

- **语言**：所有回复、代码注释、文档均用中文。
- **联网工具**：遇到不熟悉的 API / 库 / 报错信息时，主动用 tavily-mcp / context7-mcp 查最新文档，不要凭记忆猜。
- **构建验证**：task 完成后跑 `bun run affected-tests:run`（覆盖本次 diff 的最小测试集）以及跑 `make build` 验证构建成功，**不可跳过，必须执行**。
  - **全量 `bun test` 只在三种情况下跑**：① CI（合并前必跑，见下）；② 用户显式要求；③ `affected-tests` 自己判定为仓库级改动（此时它输出的就是全量命令）。
  - 先看判定再跑：`bun run affected-tests` 只打印命令不执行，`:run` 才执行。实测选测耗时 **0.19s–14.5s**，全量 **127.5s**。
  - ⚠️ **这一步拿「更安全」换「更快」，补偿是 CI 在合并前跑全量**（`ci.yml` 的 `test` job 用裸 `bun test`）。只做本地选测而不走 PR，等于把风险从本地挪到 main 上——所以**选测与 PR 化必须成对**，直推 main 时不许用选测。
  - 判定逻辑与逃逸阀在 `scripts/affected-tests.ts`（映射依据是 `packages/core/` 的 `src/` ↔ `tests/` 目录名重名命中 33/36）。改它必须过 `tests/scripts/affected-tests.test.ts`——那里有 5 条变异自证，专防「选了个空集然后全绿」。
  - 日常开发只用 `make build`（不动版本号）。**不要**用 `make build-bump`，它会把版本号 +1。
  - CI（`.github/workflows/ci.yml`）除这两条外还有一个独立的 `lint` job：`bun run lint`（oxlint）与 `bun run lint:boundary`（包边界扫描）。动了跨包导入就跑一次后者，否则 PR 会在 CI 才红。
- **改了参考页数据源要重新生成官网参考页**：动过 `packages/cli/src/help.ts`、`packages/cli/src/cli.ts`、`packages/core/src/tool/`、`packages/cli/src/command/`、`packages/core/src/config/`、`packages/core/src/hook/` 之后，跑一次 `bun run docs:gen-reference`，并把 `website/ref/` 与 `website/public/llms.txt` 的改动一并提交。
  - `website/ref/` 下 6 页（CLI 参数 / 工具 / 斜杠命令 / Hook 事件 / settings 字段 / 环境变量）是**从源码生成**的，源码改了不重新生成就是文档骗人——用户照着文档写一个不存在的参数比没有文档更糟。
  - pre-commit 会跑 `--check` 拦住这种漂移（未装 hook 先跑 `bun run install-hooks`）

**铁律：不删与本次任务无关的文件和代码（多任务并行前提）**

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

教训一句话：**归因错误 + 立即执行不可逆操作 = 数据永久丢失。
先读再判断，不可逆操作先问，工作区脏不是理由。**

## 开发 / 发布 / 更新三线流程

### 本地环境：双版本并存

| 命令 | 指向 | 版本 | 用途 |
| --- | --- | --- | --- |
| `sid-code` / `sc` | `~/.local/bin/sid-code` → 线上下载版 | 稳定版 | 验证线上版本 |
| `sid-code-dev` / `sc-dev` | `~/bin/sid-code-dev` → 本地构建产物（仓库根） | 开发版 | 日常开发调试 |

两条命令是**不同的二进制名**，不靠 PATH 优先级区分。

### 日常开发

```bash
git pull          # 拉最新源码
make build        # 构建二进制（版本号不变，日常就用这个）
sc-dev            # 启动开发版（注意是 sc-dev，不是 sc）
```

### 发布上线

**⚠️ 铁律：先提交功能代码，再发布。禁止先发布后提交。**
发布产物必须能对应到一个确切 git commit。先发布后提交会开一个「已发布但未提交」的窗口——期间任何源码改动都会让线上二进制与 commit 对不上，出线上问题无法定位到确切代码版本。

这条铁律现在由脚本**机械化执行**，不再只靠人记：

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

**上传凭据**：SSH 信息读自 `scripts/deploy.env`（不入库，见 `deploy.env.example` 模板）。
配了 `DEPLOY_SSH_PASSWORD` 后用 sshpass 免交互上传，无需每次输密码。首次配置：
`cp scripts/deploy.env.example scripts/deploy.env` 后填入真实值。

#### Changelog + Tag

release.sh 在 bump 后重建 changelog；构建与冒烟全部通过后自动提交 `bump vX.Y.Z`，再把 annotated tag `vX.Y.Z` 打在**这个提交**上（`generate-changelog.ts` 会过滤 `^bump v\d` 提交，所以它不会污染 changelog）。每次运行完整重建，确定性且幂等。两份产物各有唯一职责：

| 产物 | 职责 | 内容来源 |
| --- | --- | --- |
| `CHANGELOG.md` | 文本事实源，给 diff / `curl` / 脚本 | git 历史（**全量原始提交**，按 feat/fix/docs/… 6 组） |
| `website/.vitepress/data/changelog.json` | 官网 `/changelog` 页的数据源，由 `theme/Changelog.vue` 渲染 | `changelog/curated/*.json`（**用户视角文案**，4 组受控词） |

**两个受众，两条渲染路径**：commit message 的读者是未来的自己，changelog 的读者是用户，靠正则做不了这个转换（实测 276 条提交里 24% 是用户完全不关心的文档/杂项）。所以官网正文来自**人工过目过的** curated 文案：

```bash
bun run changelog:curate            # 为下一个版本起草（spawn sid-code 自己读 diff 改写）
bun run changelog:curate 0.1.601    # 指定版本 / 补跑
bun run changelog:check             # 不调 LLM，只校验已入库的全部文案
```

产出 `changelog/curated/v<version>.json` → **读一遍**（脚本会把条目打印到终端）→ 需要就直接改 JSON → commit。发版前 release.sh 会检查该文件是否存在，缺了会交互确认一次（放在构建**之前**，此刻补还来得及）。

⚠ **五条禁令**，破了就是数据错乱、内容失真或每次 commit 都红：

- `release.sh` / `generate-changelog.ts` **绝不调 LLM**，只读已入库的 curated 文件 —— 发布路径必须确定性 + 离线 + 幂等，把一次 LLM 调用塞进发布链会同时破掉这三条。
- curated 文件**必须人工过目**才提交。校验器只拦形态（词表、长度、URL、字段自洽），拦不住「把内部重构写成用户特性」「漏掉一个真实的破坏性变更」—— 这两类只有人能拦。
- `CHANGELOG.md` **必须保持全量原始提交**（含 hash、docs/其他 分组）。curated 漏了东西时它是唯一的回溯途径。
- `website-deploy.sh` **不得**重跑 `generate-changelog.ts` —— 会把 HEAD 上尚未发版的提交归到已发布的版本号名下。只有 `release.sh` 有资格生成这份数据。
- changelog 产物**不纳入** `docs-gen-reference --check` 那类反漂移门禁 —— `website/ref/` 能立门禁是因为源是源码；changelog 的源是 git 历史，每提交一次就变。

### 三个构建目标职责

| 命令 | 版本号 | 用途 |
| --- | --- | --- |
| `make build` | 不变 | **日常开发（99% 的场合）**：改完 / 拉完代码重建二进制 |
| `make build-bump` | +1 | 少见：想本地自测一个带新版本号的二进制 |
| `./scripts/release.sh --upload` | +1 | 正式发布：构建 4 平台制品并上传到服务器 |

**选哪个：默认 `make build`。** 只要你不是在专门测「版本号本身」，就用它。
`make rebuild` 保留为 `make build` 的别名（历史文档里到处是它），敲了也不会出错，
但新写的文档 / 命令一律用 `make build`。

三条由「版本号内联进二进制」派生的规则（`bun build --compile` 编译时把 `package.json` 写进产物，git pull 更新源码不会改它）：

- **源码更新后必须重新编译**，否则跑的还是旧代码。
- **版本号只 bump 一次**：直接 `./scripts/release.sh --upload`，别先跑 `make build-bump`（它也 bump，会让版本号 +2）。已 bump 过用 `--no-bump --upload` 复用。
- **`build-bump` / `release.sh` 之后补一次 `make build`**：发布制品是跨平台编译产物，仓库根的开发版二进制不会跟着更新，内联版本号还停在旧值 —— 不补则 `sc-dev` 显示的版本比线上低一位，容易误判。

## 收尾自检

除了「北极星」那节的五问，收尾前再问自己：

1. 这次改动解决的是用户提的问题，还是我顺手扩大/缩小了范围？
2. 我拿什么证明它真的生效了？（跑了什么命令、看到什么输出，
   而不是「机理上讲得通」）

关于第 2 点有一条实测教训：**目标指标改善 + 测试全绿 + 机理讲得通，
三者同时成立时结论仍然可能是错的**。收尾必须回到端到端的真实指标上验证，
不要只看你专门优化的那个代理指标——代理指标会奖励「把浪费重新贴个标签」。

### 在 worktree 里跑门禁：`exit 0` 不等于可交付

worktree 默认**没有自己的 `node_modules`**，`@sid-code/core` 会向上解析到主仓 checkout ——
那里没有你本次新增的导出。症状是 `make build` 打出
`<你的新函数名> will always be undefined`，而**构建仍然 exit 0**。
只看退出码就交付，等于交了一个新函数在编译产物里是 `undefined` 的版本。

- **新建模块 / 新增导出的改动，必须显式 grep 这条 warning**，不能只看 exit code。
- 进 worktree 后先跑一次 `bun install`（实测：装完后 3 个失败转绿、warning 归零）。
  `website/` 是独立包，动了它还要在 `website/` 里再装一次，否则 pre-push 的
  `website:build` 会以 127（command not found）拒绝推送。
- 跑过 `bun install` 后，pre-commit 里硬编码的 `./node_modules/.bin/oxlint` 也就能正常工作，
  不必再 `--no-verify`。

### 判定「这个失败与我无关」必须举证，且别叫它「既存失败」

实测教训：三个并行执行分身都把 worktree 里的失败报成「既存失败」，复核后发现
**这些测试在干净 main 上是绿的**（`plan-mode-write-plan-file` 等 4 个文件 95 pass / 0 fail）。
「既存失败」意味着"主干本来就坏"，会让人跳过本该排查的东西；真实成因是环境。

宣称一个失败与本次改动无关时，**三条证据缺一不可**：

1. 该测试不 import 本次改动的任何模块；
2. 在**父仓 main** 上单跑能通过（不是在你的 worktree 里跑）；
3. 能指出具体的环境成因。

已知两类 worktree 环境产物：上面那条 `node_modules` 向上解析；以及 **worktree 路径含
`.claude/`**，命中 `packages/core/src/permission/checker.ts` 的敏感路径拦截，
在 plan-mode 判定**之前**就返回（结论仍是 DENY，只是 reason 不同）。

顺带两条同源的判读经验：

- **超时类失败先看数字对不对得上**。`runSandbox` 在 CI macOS 上失败于 5002ms —— 那是
  bun **默认的 5s 单测超时**，不是 sandbox 自己的 60s 上限。写文件 + spawn 子进程的测试
  在慢 runner 上会踩线，是 flake；重跑即绿，不要当回归去改代码。
- **防漂移哨兵红了，要补清单而不是删断言**。`ABORT_REASONS 覆盖所有 abort 调用点`
  就是为了拦「新 reason 只登记进 `errors.ts`、忘了同步哨兵期望值」而存在的。
  它红 = 它在正常工作。
