---
Status: implemented
Date: 2026-10-17
---
# strict 工具按端点限额并在容量 400 时降级重发；`-p` 不再被未关闭的 stdin 撑住

## 决定了什么

**D11（strict 容量）**：新增 `packages/core/src/llm/strict-tool-budget.ts`，`anthropic.ts` 流式与非流式两条路径共用。

- 发请求前把 strict 工具数收到「该端点已知上限」以内，默认 20。超出的工具去掉 `strict` 字段，schema 照发，工具顺序不变（顺序变了会击穿工具区缓存）。
- 谁先保住 strict 由工具自报 `strictPriority` 决定：`ask_user_question` 100（漏字段出过事故），`edit` / `write` / `notebook_edit` 50。provider 里不写工具名清单。
- 两类容量 400 当作可学习错误处理：`Too many strict tools (N)... is M` 按 M 重发；`compiled grammar is too large` 按减半重发。学到的上限按「真名模型 × 归一化 baseURL」只存进程内存、只收紧，单请求最多重发 3 次。只在拿到响应头之前重发，不会重放已经发出的流内容。
- `dialect/tool-schema.ts` 里「发 40 个 strict 也没报错」那条旁证已被实测推翻，改成指向本模块。

**D12（`-p` 挂起）**：

- `piped-stdin.ts` 的 `finish()` 里调用 `stdin.pause()`，释放已 `resume()` 的句柄。
- **真正挂住的路径在 `app.ts` 的 `runHeadlessSDK`**：`--output-format stream-json` 而输入不是 stream-json 时，它把 `process.stdin` 再交给 `StructuredIO` 当 NDJSON 命令通道，泵要等 EOF 才收尾。修法：只有 `--input-format stream-json` 时才传 `process.stdin`，否则传一个已结束的空流。

## 放弃了什么（以及为什么不选）

- **只修 `piped-stdin.ts`（方案 §8.5 的范围）**：不够。实测 text / json 输出在 `runHeadless` 末尾本来就会 `process.exit`，所以不挂；挂的是 stream-json 输出，它挂在 `StructuredIO` 泵上，与 `pause()` 无关。只修方案里写的那一处，测试照样能全绿，因为没有覆盖到这条路径。
- **`-p` 出结果后无条件 `process.exit`**：两条路径末尾本来就有 `runShutdownSequence` + `process.exit`，问题是 SDK 路径根本走不到末尾，再加一层没有意义。
- **把学到的 strict 上限落盘**：上游上限会变（网关换路由、官方调额），落盘会把一次偶发的语法体积错误永久固化成小上限。
- **用 strict 工具 schema 的字节数预估语法体积**：编译后的语法大小与 schema 字节数没有已知映射，阈值只能靠猜；减半重发 + 按端点记忆不依赖猜测。
- **不发 strict（全局关）**：会丢掉防 required 字段漏发的协议级保证，代价比按优先级降掉一部分大。

## 拿什么证明它生效了

- 本地复现（假上游、隔离 `SID_CONFIG_DIR`，`sleep 15 | bun bootstrap.ts -p ping`）：未修时 text 3s / json 4s 退出，**stream-json 15s**（等满 stdin）；修后三者都在数秒内退出。
- `packages/cli/tests/cli/print-stdin-held-open-exit.test.ts`：子进程 e2e，测试自己持有 stdin 写端且不关闭，量子进程的 exit 事件，三种输出格式各一例。**变异**：`runHeadlessSDK` 改回传 `process.stdin` → 只有 stream-json 那一例在 30s 处变红。
- `piped-stdin.test.ts` 新增「收尾后流处于暂停态」。**变异**：删掉 `pause()` → 只有这一条变红。
- `packages/core/tests/llm/strict-tool-budget.test.ts` 20 例：纯函数 + provider 流式 / 非流式接线 + 真实 `Registry.definitions()` 透传 `strictPriority`。**变异 1**：发前收口改为不限 → 5 例接线测试变红。**变异 2**：容量错误不降级 → 3 例重发测试变红。
- 未验证：真网关端到端（`sc-dev` 对 `claude-sonnet-5` 跑一轮带全部内置工具的请求）。依据是 2026-10-17 的网关矩阵（24 strict 6/6 400、20 strict 5/6 200），合入后需补跑一次确认。
- **补记（2026-10-18 复审 T1）**：上面三条子进程 e2e 删掉 `pause()` 都不会红（text / json 靠 `process.exit`，stream-json 靠 `Readable.from([])`），「收尾后流处于暂停态」是单测，没测「进程真的能退」。新增 `packages/cli/tests/utils/piped-stdin-release.test.ts`：子进程只调 `readPipedStdin`、不调 `process.exit`，父进程持有 stdin 写端不关。**变异**：删 `pause()` → 该条在 4s 处红（`Expected: true / Received: false`），恢复后 1 pass。

