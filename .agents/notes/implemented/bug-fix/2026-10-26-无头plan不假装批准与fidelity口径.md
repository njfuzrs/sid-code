---
Status: implemented
Date: 2026-10-26
---
# 无头 plan 会话不再假装批准；fidelity 分母口径改为白名单 + 被拒单列

## 决定了什么

修的是两个独立缺陷（同一 PR，都在 plan 生命周期内）：

**一、无头会话的 plan 批准语义（默认不批准）**

以 `--permission-mode plan` 启动的无头会话，从前是这样闭环失败的：`handlePlanApproval`
在无 TUI 回调时 `decision = "approve"` → `deactivatePlanMode` 恢复成
`prePlanMode || "default"`（这条入口没有「进入之前的模式」，于是落到 default）→
`-p` 下 default 的 ask 全部被 `isNonInteractive()` 落成 deny。净效果是
**harness 先自动批准、紧接着拒绝每一个写类调用**：一次真实无头实跑里，
计划第 1 步 `edit math.js` 直接被拒，模型只好把改动写成文字交付，整个执行阶段报废。

- 默认路径改为 `PlanModeManager.endWithoutApproval()`：不批准，走新的
  `reason="no_approver"` / `outcome="plan_only"`，计划文件留在磁盘上作为交付物，
  注入 `buildHeadlessPlanOnlyMessage` 告知模型「没有人批准，不要执行，把计划作为输出」。
  退出前**先落一条 `PlanFidelity` 快照**——`exitPlan` 会清空步数与路径，
  顺序颠倒会让这次规划从数据里消失。
- 新增 `--plan-exec-mode <mode>`（`config.planExecMode`）：调用方显式声明时才批准，
  并在 `deactivatePlanMode(override)` 里切到该模式。取值与 `PERMISSION_MODES` 同源，
  但**排除 plan**（批准后又回 plan，无头下就是死循环）。
- 新增 `HEADLESS_LOCAL_LEDGER_TOOLS`（`todo_write` / `task_create` / `task_update`）：
  在「无头 + 已走到 ask」这一条路径上放行。顺带修掉 `acceptEdits` 无头会话里
  `todo_write` 同样被拒的那一面（acceptEdits 只放行 `FILE_TOOLS`，它继续下落到
  `isNonInteractive()`）。

**二、fidelity 指标口径（分母 + 匹配规则）**

一次无头实跑的 5 次调用全部被判为偏离（`matchedRatio=0`），其中 `edit math.js`
正是计划第 1 步本身。四件事叠加：

- `FIDELITY_TRACKED_TOOLS` 白名单：只有会产生计划步骤的工具进分母
  （edit/write/notebook_edit/bash/read/grep/glob/ls/read_many/sub_agent）。
  记账与检索类（`todo_write` / `task_*` / `save_memory` / `tool_search`）不再算偏离。
- 计划文件自身的 write/edit 在 app 层按 `planManager.isPlanFile` 排除——**必须先排除再扩词**：
  edit 的参数含 `old_string`/`new_string`（计划正文本身），扩词后「编辑计划文件」
  极易被误锚定成某一步（实测会命中 step2），不先排除就是从漏报直接跳到误报。
- 被权限拒绝的调用：进 `actualToolCallCount`，**不进 `offPlanCount`**，单列 `deniedCount`。
  结构化标记走新字段 `ToolResultBlock.permissionDenied`（不按 content 文案判定）。
- `edit` 动作词补「新增/增加/添加」（证据会话里计划写的是「**新增 sub 函数**」）。
- 缩进续行**并入父步骤描述**（不新增步骤）：续行里的路径/命令 token 从此参与锚定。
- 两个版本号各管一维：`PLAN_STEP_PARSER_VERSION` 2→3（步数口径），
  新增 `FIDELITY_INDICATOR_VERSION = 1`（匹配规则 + 分母规则）。二者都随
  `PlanFidelity` 事件落盘，digest 按需展示。

## 放弃了什么（以及为什么不选）

- **选项 A 单独（只规划不执行，不加 `--plan-exec-mode`）**：最诚实、配置面最小，
  但砍掉了无头场景唯一的执行入口，`plan_recovery` capability eval
  （`evals/bench-runner/adapters/sid-code-live.ts`）读的「计划文件更新次数」在执行阶段
  恒为 0，等于让该评测失去被测量。
- **选项 C（维持自动批准，只让批准消息感知权限）**：改动最小，但批准仍是纯形式——
  无头 plan 会话的「执行阶段」实际不可执行，plan 模式在无头场景退化为只读分析。
  等于把「harness 自相矛盾」降级成「harness 说话不好听」，问题还在。
- **把 `todo_write` 加进 `READ_ONLY_TOOLS`**：那个集合被三处共用（主链 Step 10、
  plan 模式 `checkPlanMode`、deny-write Step 13）。加进去会同时放宽 plan 与 deny-write
  两条语义，副作用面远超「无头会话」。改成只在「无头 + 已走到 ask」生效的独立集合，
  并补了 plan / deny-write 两条对照断言锁住「没顺手放宽其它模式」。
- **只特判 `todo_write` 的偏离**：`recordActualToolCall` 对所有工具一视同仁，
  `task_create` / `task_update` / `save_memory` / `tool_search` 同样会被记成偏离。
  特判一个，下一种记账工具出现就要再改一次，且漏改是静默的（曲线只是多几个 off-plan）。
- **动作词表继续开放集扩词**：动词无穷，扩一次就可能引入一类误报，方向与 P2-3
  「宁可漏记也不虚报」相反。只补有实测证据的三个词，并配反例测试
  （「计划外 edit」与 `read /etc/hosts` 必须仍判偏离）。
- **「强锚定单独成立候选」（去掉语义门槛）**：另一条路，`math.js` 的锚定本来就成功，
  只是被语义门槛挡掉。但它并非无风险——语义门槛同时承担「工具类别相容」的职责，
  去掉之后若步骤描述含通用路径段（`src`、`cli.ts`），探索性 `read` 会被算成写类步骤，
  退回 P2-3 之前的误报形态。要走这条必须同时配「工具类别相容 + 更高锚定阈值」，
  这次没有把握把阈值调对，所以选低风险的扩词 + 反例。
- **续行算新步骤**：那会把一步拆成两步，等于悄悄改了**分母**——既有测试契约
  （「嵌套子项不计 step」）也要改。选「并入」是因为分母不变、只让匹配多一分依据，
  符合「分母比分子重要」。
- **用 content 的「权限拒绝:」前缀判定被拒调用**：那是给人看的文案，
  产品侧改一次措辞，所有按字符串判定的消费方就静默归零，而报告照样显示「0 次」——
  `analytics/events.ts` 已为同一形态留过教训。改为结构化字段。
- **`--plan-exec-mode` 不含 `plan`**：批准后切回 plan 会让下一轮重新规划、重新审批，
  无头场景下是死循环。

## 拿什么证明它生效了

- 新增单测：`packages/core/tests/plan/fidelity-caliber.test.ts`（16 项）、
  `packages/core/tests/plan/headless-plan-only.test.ts`（13 项），
  含证据会话的三步计划 + 五次调用的合成夹具。
- **变异自证四处**（改坏 → 断言红 → 恢复 → 全绿）：
  1. 注释掉 `recordActualToolCall` 的 `FIDELITY_TRACKED_TOOLS` 判断 →
     「记账/检索类工具不记录」1 fail；
  2. `edit` 动作词去掉「新增/增加/添加」→「edit math.js 命中 step1」1 fail；
  3. 续行并入改成不并入 →「续行里的路径参与锚定」1 fail；
  4. 注释掉 `HEADLESS_LOCAL_LEDGER_TOOLS` 放行分支 →
     「todo_write 无头放行」+「acceptEdits + 无头放行」2 fail。
  四次恢复后 `grep -rn "MUTATION-" packages/` 为空。
- 既有契约变更（有意，非为凑绿改断言）：
  `checker.test.ts` 里「todo_write 无头被拒符合设计」改为放行（并新增 plan / deny-write /
  edit 三条对照锁住未放宽面）；`plan-lifecycle-defects.test.ts` 的
  `PLAN_STEP_PARSER_VERSION` 断言 2→3；5 处测试因 `recordActualToolCall` 返回可空而补 `!`。
- 门禁实跑：`bun run affected-tests:run` → **9802 pass / 0 fail（709 文件）**；
  `make build` → 产物自检全过；`bun run typecheck:gate` → 66/66 无新增；
  `lint` / `format:check` / `lint:boundary` / `lint:command-system` 全过；
  `bun run docs:gen-reference` 已重新生成（`help.ts` / `cli.ts` / `config/` 是数据源）。
- **未做的验证**：真实模型的无头端到端实跑（`sid-code-dev --permission-mode plan -p ...`）
  本轮未执行——它需要可用的 API key 与网络。上面覆盖的是状态机、消息、权限链与口径计算；
  「没人批准时模型是否真的停止执行」这一步依赖模型行为，需要真实会话复核。
