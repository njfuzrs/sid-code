---
Status: implemented
Date: 2026-09-25
---
# SDK 与 Headless 缺口补齐（16 号方案复查）

## 决定了什么

按 `16-SDK与Headless模式` 方案逐项回源码复核。一个月后主干已经补上了
flag 声明（`--input-format` / `--include-partial-messages` / `--fallback-model` /
`--session-id` / `--max-budget-usd`）和预算硬停的 `budgetExceeded` 事件，
但四条用户可见的行为仍然是断的，本次把它们接上：

- **B1 管道 stdin**：`cat f | sid-code -p "..."` 此前只拿位置参数。新增
  `readPipedStdin`，仅非 TTY、仅 `--input-format text` 时读取，3 秒超时告警放行，
  与 stream-json 的 StructuredIO 互斥。resume 带会话 id 时允许空 prompt。
- **B2 预算硬停的退出语义**：loop 已经在 `done.budgetExceeded` 上标了来源，
  但 SDK 把它映射成 `result/success`、进程以 0 退出。改为
  `error_max_budget_usd`，text/json 结果体带 `error.reason = max_budget_usd`，
  两条 headless 路径都以退出码 1 收尾。
- **G4 token 增量**：`queryLoop` 的文本走 `setStreamTextCallback`，事件流里
  从来没有 `stream_text`，所以 `--include-partial-messages` 打开了也收不到。
  SDK 引擎在 `includeStreamEvents` 时把回调收进队列，与下一个内核事件竞速吐出。
  竞速必须「先吐已到达的增量、再处理事件」——回调和 done 经常在同一同步段到达，
  先排空再等事件会把每轮最后几个字丢掉。
- **D1 拒绝可见性**：维持非交互 `ask → 自动 deny`（不引入 CC 那种无人可答的挂起），
  但把到会话结束仍未放行的操作汇总出来。json 结果带 `permission_denials`，
  stream-json 的 result 消息同样带（空清单不写字段），text 与 json 都在 stderr
  打一行汇总和预授权提示。决策本身不改。

顺带修了三个会让上述能力在真实入口失效的点：`--output-format` 非法值此前静默
降成 text（G1）；stream-json 不强制 `--verbose`（G2）；`--json-schema` 只收
文件路径（G6）；`--no-session-persistence` 的声明名带 `no-` 前缀，bun 的
parseArgs 在 `allowNegative` 下把它判成未知选项（node 不判，单测看不出来）。

## 放弃了什么（以及为什么不选）

- **不重造第二套预算检查**。方案里的路线 B 是在 loop 头部再加一次
  `getEffectiveTotalCostUSD()` 比较。loop 已经有 quota / budget rule / 远程预算
  三条硬停，且都在 `done.budgetExceeded` 上声明了来源。再加一条会让「成本超限」
  出现两套口径。CLI flag 继续走既有的 `config.costLimit → QuotaManager`。
- **不把非交互的 ask 改成挂起等确认**（方案 3）。headless 没有 TUI 可回退，
  挂起就是 CC 正在头疼的「流水线停在无人应答的提示上」。可见性用结果字段和
  stderr 补，不改拒绝决策。
- **`--input-format stream-json` 不与任意输出格式正交**。方案原文希望输入输出
  互相独立，但 stdin 逐条读进来、回包却走 text/json 单次输出时，对端无法解析。
  保持既有的成对约束（缺 `--output-format stream-json` 直接退出），不放宽。
- **G1 的「非 print 传了 `--output-format`」用告警不用退出**。非法值退出是对的
  （静默降级会让下游解析脚本无声失败），但交互模式传一个只在 print 下生效的
  flag，退出会把已经在用的命令行改成启动失败。告警写 stderr，TUI 照常启动。
  `--max-budget-usd` 同样处理。
- **G5 / G7 不重复实现**。`--fallback-model`、`--session-id`、
  `--no-session-persistence` 主干已接线（fallback 进 `ModelFallback`，
  session-id 校验 UUID，no-session-persistence 把 `sessionStore` 置 null）。
  本次只修了最后一个在 bun 下被判成未知选项的声明名。

## 拿什么证明它生效了

`bun test` 选测，60 + 20 + 134 共 214 个用例 0 fail：

- `packages/core/tests/sdk/`：134 pass。其中新增两条锁住真实故障形态——
  「增量与 done 同一同步段到达时，最后几个字仍先于 result」；
  「driver 提供拒绝清单时 result 带 `permission_denials`，不提供则字段不出现」。
- `packages/cli/tests/cli/flag-e2e.test.ts`：20 pass。覆盖 G1 非法值退出、
  G2 stream-json 缺 verbose 退出、`--no-session-persistence` 不再是未知选项、
  非 print 下 `--output-format` / `--max-budget-usd` 告警但不退出。
- `packages/cli/tests/cli/piped-stdin.test.ts`：TTY 不读、非 TTY 累积、
  空管道不挂起、超时返回已收到的部分并告警。
- `packages/core/tests/permission/denial-summary.test.ts`：按签名拆工具名与资源、
  已放行的签名不再出现、空清单返回空串。

未跑真实模型的端到端（`echo hello | sid-code -p ...` 需要 API key 与网络，
且会把一次真实花费算进验收）。管道拼接、预算映射、增量竞速、拒绝汇总都已抽到
可注入 mock 的函数上，上面几组测试打的是这些函数，不是它们的旁路。
