---
Status: implemented
Date: 2026-11-15
Source: macOS runner 时序敏感度：超出偶发的量化证据与第三档定夺（2026-11-10）
---
# macOS flake 三件套：补测试余量、按平台开 --retry、把失败密度做成可复算的脚本

## 决定了什么

接续 2026-11-11 的 PR #739（四个时序敏感用例已补余量，但留了三处尾巴），本次把方案文档
剩下的待拍板项与复核发现的缺陷一次落完：

**① 补掉 test 侧的两处真缺陷（P2/P3）**

- `packages/core/tests/llm/healthy-slow-stream-no-defense.test.ts`：前提断言从硬编码
  `> 80` 改成 `> CONTENT_PROGRESS_MS`。原写法在阈值 80→120 后**静默失效** —— elapsed
  落在 81~120ms 时断言照样绿，而「总时长远超阈值」这个前提已不成立，于是
  「若某层退回绝对计时必开枪」这条反向验证变成空转。
- 同文件补注释点破两个余量的**不同性质**：间隔余量 12x 才是真正的防护（content-progress
  判的是相邻有效进展的间隔，而 `reasoning_content` 在 `openai.ts` 里算有效进展）；
  总时长余量 5x 只服务反向验证。并写明 idle 阈值跟着涨到 120 是**必要前提**
  （否则 idle 先击发，测的就不是 content-progress 层）及其代价（idle 层验证力下降）。
- `packages/cli/tests/ui/components/McpDialog-disable.test.tsx`：`:131` / `:133` 两处
  `press` 后立即断言的固定等待改成 `waitFor` 轮询。之前只改了 down/enter 中间那一段，
  两头留着固定等待 —— 同文件同类风险没收干净，下一次 flake 只是换个行号。

**② 落地 §六 方案 1：macOS 分片带 `--retry=1`，ubuntu 不带**

`ci.yml` 的 matrix 新增 `retry` 字段，按平台写成数据而非步骤里的 if：
macOS 两片 `--retry=1`、ubuntu 三片空。重试发生在同一 job 内，**不占额外 runner 名额、
不改分片数** —— 这是它相对「加一片」的唯一优势（Free 档 macOS 并发上限 5，3 片 × 2 run = 6 会排队）。

**③ 落地 §七 第 4 项：把失败密度做成可复算的脚本，且补上最大盲区**

`scripts/ci-flake-stats.ts`：默认用 `gh api` 拉最近 N 次 run，同时输出两种口径 ——
`current`（只看当前结论，历史文档口径，便于对账）与 `incl-rescued`（含重跑转绿的 run，
真实事件口径）。后者是重点：**只看当前结论会漏报 67%**（2026-11-15 实测近 100 次 run：
当前 failure 2 个，重跑转绿 4 个 —— 真实失败事件 6 个而非 2 个）。数据获取与计算分离，
`--runs <file>` 可离线复算。

**④ `--retry` 的配套对冲（硬前提，缺了就不许开）**

`scripts/ci-retry-report.ts` 解析 `bun test` 输出里的 `(attempt N)` 标记，把本轮重试了几条
用例打出来，有重试时发 `::warning::` 让它在 checks 页可见。实测确认 bun 自己就会对重试过的
用例打这个标记（转绿 `(pass) … (attempt 2)`、终败 `(fail) … (attempt 2)`），不需要额外埋点。

## 放弃了什么（以及为什么不选）

- **不给 ubuntu 也加 `--retry`。** 没有量化证据支持 ubuntu 需要它（2026-11-15 复核：
  ubuntu 的失败大多是「整片 runner 卡住导致 193 条用例同时 5s 超时」这种一次性事件，
  不是稳定的时序敏感），而 `--retry` 的代价是「掩盖真回归」—— 不为不存在的风险付这个代价。
  哪天 ubuntu 密度上来了，改 matrix 那两行数据即可，不需要动步骤逻辑。
- **不做「CI 层自动 rerun」**（在 workflow 里调 `gh run rerun`）。它要额外 token 权限、
  且 rerun 会重跑整片（6–8 分钟），而 `--retry` 只重跑失败用例（通常几十秒）。
- **不让 `ci-retry-report` 阻断 CI。** 它的职责是报告不是门禁。做成阻断项的唯一结果
  是有人加 `|| true`，然后连报告都不看了（与 northstar 版本快照「只报告不阻断」同一条理由）。
- **不把 `(attempt N)` 解析放到 shell 里 grep。** 有 ANSI 颜色、有用例名含 `(attempt`
  字面量两个坑，写成纯函数才能用测试把边界钉住（实测这两个坑都真的会踩到）。
- **统计脚本不采真实 CI 数据做测试。** 判据依赖「重跑转绿」这种低频样本，等它自然出现
  等于把结论押在不会按时发生的事件上。改成造 fixture：`run_attempt=2 + success +
  firstAttemptShards 有失败` 一条记录就能覆盖该分支。

## 拿什么证明它生效了

**改动的直接验证**

- `bun test ./packages/core/tests/llm/healthy-slow-stream-no-defense.test.ts
  ./packages/cli/tests/ui/components/McpDialog-disable.test.tsx` → 5 pass / 0 fail
- `bun test ./tests/scripts/ci-flake-stats.test.ts ./tests/scripts/ci-retry-report.test.ts`
  → 19 pass / 0 fail
- `bun test ./tests/release-flow-contract.test.ts ./tests/build/slow-test-suite-split.test.ts`
  → 98 pass / 0 fail（含本次同步的三道门禁断言）
- `bun run lint` → 0 warnings / 0 errors；`bun run format:check` → all matched
- `bun run typecheck:gate` → 62 处 / 基线 62 处，无新增
- `bun run lint:boundary` / `lint:command-system` / `lint:legacy-tool` → 全部通过
- `make build` → 编译产物自检通过（5 项 ✓）
- `bun run smoke` → 30 例 / 30 通过

**变异自证（新增断言不是恒绿）**

三个变异各自让对应断言变红，之后已恢复原文件：

| 变异 | 结果 |
| --- | --- |
| 去掉 `(attempt N)` 的行尾锚定 | 9 pass / 1 fail，红在「用例名含 (attempt 2) 不误判」 |
| `incl-rescued` 口径恒不计重跑转绿 | 8 pass / 1 fail，红在「重跑转绿：current 不计、incl-rescued 计入」 |
| 把 `cancelled` 也算进分母 | 8 pass / 1 fail，红在「cancelled 与进行中不进分母」 |

**尚未验证的部分（如实写）**

`--retry=1` 在真实 macOS runner 上的效果要等本 PR 的 CI 跑完才知道；本轮能证明的是
「命令形态正确、退出码语义正确、重试标记可解析」这三件确定性的事。`incl-rescued` 口径的
数字（2026-11-15 实测：6 个真实事件 vs 2 个当前 failure）来自**主仓**的 100 次 run，
不是本 PR 的。
