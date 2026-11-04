---
Status: implemented
Date: 2026-11-04
---
# 流迭代器放弃时释放源头，lifecycle 超时改为可中断并取消本次请求

## 决定了什么

来源：会话 `20261103-213816-f5beebde` 复盘 F1 + F5（方案《20261104-会话 f5beebde 复盘-流迭代器泄漏与额度误判等六项-落地方案》§1、§2）。

**一句话：把「迭代结束」和「资源释放」之间那条从未被保证的链路补上，并让三层超时从「只能报告」变成「能执行」。**

1. **新增唯一原语 `llm/race-iterate.ts` 的 `raceIterate()`**，四处手抄的「手动迭代 + `Promise.race(abortPromise)`」全部改用它：`fallback.ts`（漏斗消费 provider）、`query/stream-processor.ts`（主循环消费漏斗）、`anthropic.ts`（消费 lifecycle）、`stream-lifecycle.ts`（消费源头）。它与手抄版只差一件事，但那一件事是全部：**消费方 `break` / `throw` 离开时对源迭代器调 `return()`**。因为它自己也是 async generator，`return()` 会一层层传到底 —— 改造前这条链在第一步（漏斗 throw）就断了。
2. **`streamLifecycleImpl` 的 `fireTimeout` 改为 reject 一个只 reject 的中断源**（`timeoutInterrupt`），参与迭代 race。改造前它只置 `snapshot.timedOut = true`，而这个标志只在两次迭代之间检查 —— 源头 `reader.read()` 不 settle 时循环出不来。
3. **超时改为「抛 `StreamLifecycleTimeoutError`」而不是「`break`」。** 这是一个**契约变更**，改了 6 个既有测试文件里所有「确认超时触发」用例的前提（见「拿什么证明」）。
4. **`StreamLifecycleOptions` 新增 `cancelSource`**，三条协议路径各自建 per-request `AbortController` 并合并进 fetch signal（openai Chat / Responses 的 `fetchSignals`，anthropic 的 `sdkSignal`）。与 T7「不把外部 signal 交给 lifecycle」不冲突：外部 signal 仍由消费循环处理，lifecycle 只取消自己判定超时的那一次请求。abort reason 用新常量 `STREAM_LIFECYCLE_ABORT_REASON = "stream-lifecycle-timeout"`，已登记 `ABORT_REASONS`。
5. `readSSEEvents` 的 `finally` 改成**先 `reader.cancel()` 再 `releaseLock()`**（后者在 cancel 之后仍合法，反之会抛 TypeError）。
6. **stall 告警在 `timedOut` 之后立即 `clearInterval`**（语义修正：死流的心跳间隔没有信息量，本会话 warn.log 4265 行里 4084 行是它）。
7. **活跃 lifecycle 计数进心跳**：`getActiveStreamLifecycleCount()` 进 `heartbeat.txt` 的 `active_stream_lifecycles`，会话空闲时应为 0。这条是让同类泄漏以后**不靠 warn 刷屏才能发现**的那一半。
8. F5（计费恒等式少 11 条）不单独修：`recordBilledRequest` 本来就在 `finally` 里，① 修好后 `finally` 会执行，`BilledRequest` 自然写出。`flushInFlightBilledRequests` 保留为进程被杀时的兜底。

### 实施前按要求核实的一件事：改造前 `break` 之后下游拿到的是什么

方案的 §1.4 ② 要求先核实再动手。结论是**比方案假定的更糟**：lifecycle `break` 后生成器正常 return，消费方（openai / anthropic 的 `for await`）认为流正常结束；漏斗那侧只做空响应校验 ——

- **有内容**：`fallback.ts` 走到 `this.availability.markHealthy(params.model)` + `return`，一次**超时被当成成功**，还顺手把模型标记为健康；
- **没内容**：抛 `StreamValidationError("响应为空", "empty_response")`，超时被当成一次空响应。

两条路都**没有任何一层知道「这是一次超时」**，重试预算与归因全落空。所以这里不是「换个错误类型更好看」，是修掉一个把超时伪装成成功的路径。

## 放弃了什么（以及为什么不选）

- **只在 lifecycle 里给 stall interval 加「超过 N 分钟自动停」**：止住刷屏，但被放弃的生成器、HTTP 读、sleep observer 引用照样泄漏，`BilledRequest` 照样缺。治标。
- **只修 lifecycle 一层，不动另外三处 race 循环**：形态 B 的源头在 `fallback.ts`。lifecycle 自己做得再对，没人 `return()` 它，`finally` 也跑不到。**这是本方案最关键的一条否决**：四处是同一个缺口的四个面，只修一面等于没修。
- **用 `FinalizationRegistry` 在生成器被 GC 时清定时器**：定时器闭包持有生成器状态，生成器永远不会被回收；GC 时机也不确定，「最终会清」不是可以写断言的性质。
- **把 lifecycle 的超时改成直接 abort 外部 signal**：外部 signal 是用户 ESC 的语义载体，由它承载内部超时会再次撞上 `stream-timeout-misclassified-as-cancel`。所以用独立的 per-request controller。
- **`raceIterate` 的 `finally` 里 `await it.return()`**：源头停在永不 settle 的 await 上时 `return()` 自身也不会 resolve（已实测：`return while awaiting resolved? false`），await 它等于把挂起从「泄漏」挪到「消费方的退出路径」。取消 I/O 交给 `cancelSource`。
  - 对应地，**测试也钉住了这个取舍**：`race-iterate.test.ts` 有一条断言 `state.finalized === 0`，明确写下「源头卡死时 finally 跑不到，这是 JS 生成器物理限制，不是泄漏」。
- **给 `StreamLifecycleSnapshot` 加 `timeoutThresholdMs` 字段**：实施时考虑过（迭代间隙的检查点需要阈值），最终用一个局部 `timeoutError` 变量承载。理由是快照是对外只读接口，加字段要连带审所有消费方，而这条信息只在本函数内用一次。
- **`raceIterate` 无条件调 `return()`（方案草案的写法）**：实现时加了 `sourceExhausted` 判据，正常结束不调。理由是对「`return()` 带 I/O 副作用」的自定义迭代器（例如 cancel 底层流），无条件调等于把「正常完成」当成「放弃」，语义就错了。
- **额度 403 归类（F2）不在本 PR 做**：它同改 `openai.ts` 的 Responses / Chat 路径，与本 PR 并行必然冲突，按方案排在 PR2。

## 拿什么证明它生效了

### 单测（新增 16 条 + 6 个既有文件的前提修正）

```
bun test ./packages/core/tests/llm/race-iterate.test.ts \
        ./packages/core/tests/llm/stream-lifecycle-abandon.test.ts \
        ./packages/core/tests/llm/stream-lifecycle.test.ts \
        ./packages/core/tests/llm/errors.test.ts
# 91 pass / 0 fail
```

新增 `race-iterate.test.ts`（7 条）：正常消费 / break / throw / 中断 reject / 源头 finally 永不 settle 不阻塞消费方 / 无 interrupts / 源自身抛错。
新增 `stream-lifecycle-abandon.test.ts`（9 条），其中最关键的一条是**形态 B 的完整链条**：

> 源（yield 内容 → yield error → 永不产出）→ lifecycle → provider 生成器（内部 `for await`）→ 漏斗（`raceIterate` + 收到 error 时 throw）。

断言口径刻意不是「没报错」，而是：`providerFinalized === 1`、`sourceFinalized === 1`、`stream_completed` **恰好一次**、放弃后 300ms 内 **stall 计数不再增长**、`onTimeout` **一次都没被调用**、`cancelSource` 恰好一次。

**F5 的计费断言落在同一条用例里**（设计文档 §2.3 要求的验收项）：provider 模拟器的 `finally` 里调一次真实的 `recordBilledRequest`，用真实的 billing observer 断言 `BilledRequest` 恰好写出 1 条、且 `usage` 等于流内 `error` 事件带的值。这是刻意的 —— 「provider 的 finally 执行了」和「计费那一行执行了」不是同一件事：前者由 `providerFinalized` 覆盖，后者必须由 sink 观测覆盖，否则 F5 只是「机理上讲得通」。

### 变异自证（看它报了什么，不只看退出码）

1. **把 `raceIterate` 的 `iterator.return?.()` 注释掉** → 6 条用例变红：
   ```
   (fail) 消费方 break：源的 finally 执行，return() 恰好一次
   (fail) 消费方 throw：源的 finally 执行，错误原样传播给调用方
   (fail) 中断源 reject：以该错误结束
   (fail) 源头 finally 永不 settle 时，消费方不被挂住
   (fail) 形态 B：漏斗在 error 事件上 throw → provider 与 lifecycle 的 finally 都执行
   (fail) 形态 B：消费方主动 break
   ```
   全部报 `Expected: 1 / Received: 0`（returned / finalized），正是缺陷本身。
2. **把 `timeoutInterrupt` 从 `interrupts` 里拿掉** → 形态 A 的 3 条用例全部 **5000ms 超时失败**（`this test timed out after 5000ms`），即回到「超时打不断 `await`」的原始形态。
3. 两处变异均已恢复，恢复后 91 pass / 0 fail。

### 契约变更同步修正的既有用例

分布在 **6 个测试文件**：`stream-lifecycle.test.ts`、`stream-lifecycle-retry-boundary.test.ts`、
`stream-interrupt-recovery.test.ts`、`provider-conformance.test.ts`、
`stream-guard-content-progress.test.ts`、`responses-stream-timeout-wiring.test.ts`。
它们原本都依赖「超时后流正常结束」，契约改成抛错后是预期红。处理方式是统一加一层捕获
（`stream-lifecycle.test.ts` 收敛成 `drainExpectingTimeout`）并**新增**「确实以
`StreamLifecycleTimeoutError` 结束」的断言 —— 原有的「哪一层触发 / 只触发一次 / 遥测项 /
快照字段」一条没删。文件头写明了这是契约变更，不是放宽断言。

（不写「N 条用例」而写「N 个文件」：同一个用例里可能有多处捕获点，按文件计数不会随
断言粒度调整而漂移。）

### 一条实测核实过的链路细节（不写出来就会变成「机理上讲得通」）

`StreamLifecycleTimeoutError` 从 lifecycle 抛出后，**两条到达形态都存在**：

- **provider 路径**（openai Chat / Responses / anthropic）：错误被 provider 自己的 `catch`
  接住，转成 `error` 事件（`message: "流式空闲超时 240s"`，无 `statusCode` / `type`）。
  于是它走 `normalizeStreamEvent` 而不是 `normalizeThrown`，**`presetReason` 分支不生效**，
  归因靠 `error-lexicon.ts` 的「超时」词条。
- **非 provider 路径**（compact / auto-compact 等直接包 lifecycle 的消费方）：错误以
  thrown 形态到达 `normalizeThrown`，走本 PR 新加的 `presetReason: "timeout"` 分支。

实测两条路现在都归到同一个结论：

```
A 事件形态: { family: "transient", reason: "timeout", recognized: true } presetReason=undefined origin=network
B 抛出形态: { family: "transient", reason: "timeout", recognized: true } presetReason=timeout   origin=network
```

**刻意没有改 provider 的 catch 契约**（让它透传异常）。理由：那会把「所有 provider 异常
统一转 error 事件」这条既有契约撕开一个口子，影响 `stream-handler` / classifier / side-call
等一批直连 provider 的调用方，而收益只是把一条链路的归因从词表换成结构化 —— 归族结果本来就相同。
记在这里，是因为下一个人看到 `normalizeThrown` 的分支时不该误以为它覆盖了 provider 路径。

### 契约变更的隐性波及面：compact 三条路径

`createStreamLifecycle` 除了三条 provider 路径，还被 `query/compact/context-collapse.ts`、
`query/compact/partial-compact.ts`、`query/auto-compact.ts` 直接使用。它们的消费形态都是
`for await (const event of lifecycle.guard(stream))`：超时从「静默 break、返回截断摘要当成功」
变成抛错。**这是有意的行为改善**（截断摘要当成功本身就是缺陷），但需要确认上层接得住：

- `query/compact/context-collapse.ts:256-272` 的 catch 接住它并
  `recordSideCall({ timedOut: /timeout|超时|timed out/i.test(err.message) })`。
  新错误的 message 是「流式空闲超时 240s」，含「超时」→ `timedOut` 判定仍成立，遥测口径不变。
- `partial-compact.ts` / `auto-compact.ts` 的 side-call 包装（`withSideCallDeadline`）只把
  `fn` 的 rejection 原样上抛，由各自的 catch 处理；错误类型变化不改变它们的控制流。

结论：没有回归。记下来是因为 PR 正文只提了 provider 路径 —— 契约变更的「读取方清单」
不写全，下一个人改阈值或改错误类型时会漏掉这三处。

### 门禁

| 门禁 | 结果 |
| --- | --- |
| `bun run format` / `format:check` | ✅ 2804 文件 |
| `bun run lint` | ✅ 0 warnings 0 errors |
| `bun run lint:boundary` | ✅ 跨包相对路径 0 处、渲染端口 0 处 |
| `bun run lint:command-system` | ✅ 四道门禁通过 |
| `bun run lint:legacy-tool` | ✅ 58 / 基线 58 |
| `bun run typecheck:gate` | ✅ 64 / 基线 64（无新增） |
| `bun run affected-tests:run` | ✅ 4346 pass / 0 fail / 303 files |

`typecheck:gate` 有一条可复现的环境陷阱值得记下来：**在 worktree 里第一次跑会报 6 项
`packages/core/tests/skill/*` 的「新增类型错误」**，形态是
`Type 'import("<root>/packages/core/src/...")' is not assignable to type 'import("/Users/.../sid-code/packages/core/src/...")'`
—— 同一个模块出现两个路径身份。根因是 worktree 的 `node_modules` 软链到主仓，
`@sid-code/core` 解析到主仓源码。处置（记忆 `worktree-typecheck-gate-false-positives-symlink`）：
把 `node_modules` **mv** 到 /tmp（可还原，不删），在 worktree 里重新 `bun install`；
之后 typecheck 立刻回到 64/64，测试也才真正跑在 worktree 的代码上。

⚠️ 这一条比「误报」严重：**修环境之前跑的测试可能是跑在主仓旧代码上的假绿**。
本 PR 的所有测试结果都是在环境修正之后重跑的。

