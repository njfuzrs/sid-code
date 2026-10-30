---
Status: implemented
Date: 2026-10-29
---
# SDK 缺陷 9–14：合并轮带全部 uuid、队列按位置插入、清洗只剔坏 block、权限白名单取自枚举、中断判定收成一处

## 决定了什么

- **缺陷 9**（`sdk/command-queue.ts`、`schemas.ts`、`query-engine.ts`、`headless-runner.ts`）：`dequeueBatch` 合并 ≥2 条 prompt 时，新增 `mergedUuids` 按入队顺序带上全部 uuid；回显的 `user` 消息新增可选字段 `merged_uuids`。`uuid` 仍取最后一条（既有契约不变）。单条输入不带这个字段，输出与改动前逐字节相同。
- **缺陷 10**（`command-queue.ts`）：`enqueue` 从「push + 全量 sort + WeakMap 序号」改成按位置插入（插到最后一个优先级 ≤ 它的命令之后）。不再有旁路序号，也就没有 `?? 0` 让重新入队的合并对象插到同优先级队首这一格。
- **缺陷 11**（`query-engine.ts`、`cli/src/app.ts` runHeadlessSDK）：删掉零调用者的 `wasAborted()` 和 `this.aborted`。编排层的判据从 `/abort/i` 裸子串换成 `isAbortError(err)`，判原始 err。宿主 interrupt 走 `abort("user-cancel")` 时 Promise 以裸字符串 reject，包成 Error 后旧判据判不出；模型文案里带 "aborted" 时又会误判成中断。
- **缺陷 12**（`session-recovery.ts` 第 6 层）：只剔坏 block，不再丢整条消息；被剥空的消息才整条删。main 上已有第 7 层 `stripDanglingToolResultsFilter`（N11），所以审计文档写的「出口有孤儿 → 400」**在当前 main 上已不复现**（回源码实测出口 intact=true）。但仍有残余缺陷：一个坏 tool_use 会连坐同条里好的 tool_use 和正文，好工具的调用与结果一起被删。本次修的是这个残余。
- **缺陷 13**（`permission/mode.ts`、`session-recovery.ts`）：`mode.ts` 新增 `PERMISSION_MODE_VALUES` 运行时清单，配一个穷尽性类型检查（类型加了值、清单没加 → 类型错误）。恢复管道的白名单改从它派生，4 个被误清洗的真模式（`auto`/`deny-write`/`dontAsk`/`dangerously-skip-permissions`）恢复保留，幽灵值 `bypassPermissions` 被清掉。
- **缺陷 14**（`session-recovery.ts`）：删掉恒为空集的 `TERMINAL_TOOL_NAMES` 和它守护的不可达分支，以及两条只为它往全局 Set 里 add 的单测。文档担心的「正常结束的会话被判成 interrupted_turn」不成立：sid-code 主循环在工具结果之后总会再请求一次模型，以 tool_result 结尾的历史本来就是没说完的轮。

## 放弃了什么（以及为什么不选）

- **缺陷 9 把 `uuid` 改成数组或改成取第一个**：会破坏已按 `uuid` 对齐的宿主。新增可选字段是纯加法。
- **缺陷 9 关掉批量合并**：合并省 token 是有意的优化（cc 同设计），缺的只是对应关系，补字段就够。
- **缺陷 10 用 `?? Infinity` 修补**：仍保留 WeakMap 隐式契约；按位置插入更简单，而且是 O(n) 不是 O(n log n)。
- **缺陷 11 给 schema 加一个 `error_aborted` subtype**：这是协议扩展，会影响外部宿主的穷尽匹配，超出本次范围。宿主在 stream-json 里区分「我按了中断」和「CLI 崩了」的问题仍然存在，留给后续单独决策。
- **缺陷 13 直接 import `config/schema.ts` 的 `PERMISSION_MODES`**：那份含 CC 别名 `manual`（归一层才映射成 default），不是 PermissionMode 本身；而且 sdk → config 会拉进 agent-definition 等大依赖。改成在 `mode.ts`（类型的家）放清单，并用测试钉住两份清单只差 `manual`。
- **缺陷 14 保留 Set 但加注释**：全局可变 Set 任何人都能 add，单测就这么干过。真有终结性工具时，应按工具定义的属性判。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/sdk/ ./packages/core/tests/session/ ./packages/core/tests/permission/` → 全绿（具体数字见 PR 正文）。
- 变异自证（逐个把源码改回旧行为，看对应断言是否变红，然后恢复）：
  - 9：删掉 `mergedUuids` → command-queue 与 e2e 两条 `缺陷 9` 用例红；
  - 10：插入条件 `>` 改 `>=`（同优先级插到前面）→ FIFO / 重入队等 9 条红；
  - 11：app.ts 改回 `/abort/i` → `abort-classification.test.ts` 红；
  - 12：第 6 层改回整条丢弃 → 两条 `缺陷 12` 用例红；
  - 13：白名单改回手抄的 5 个值 → 两条 `缺陷 13` 用例红。
- 缺陷 12 的现状探针（修复前、当前 main）：审计文档场景 A 输出 `2 条 [user:text, assistant:text] intact=true`，即无 400，但好工具 ok1 及其结果、中间的 user 消息全部丢失。修复后同场景保留 4 条，ok1 的 use/result 都在。
