---
Status: implemented
Date: 2026-11-06
---
# LocalCommandResult 加回 error 分支：命令失败在无头下退非 0

对应《20261106-无头模式斜杠命令放行-现状缺陷与分档方案》§六 **T2**（缺陷 D2），
也是 **T3（A 档 22 个命令放行）的硬前置**。

## 决定了什么

1. `packages/core/src/command-contract/types.ts` 的 `LocalCommandResult` 加回
   `{ type: "error"; message: string }` 分支。**`message` 是完整展示文本，含「错误: 」前缀**。
2. `packages/cli/src/command/result.ts` 的 `errorText()` 改为返回该分支（不再返回
   `{ type: "text", value: "错误: …" }`）。**17 个调用方命令一行没动**——它们本来就只传消息文本。
3. `packages/cli/src/command/executor.ts`：
   - `mapLocalResult` 增加 `case "error"` → `CommandExecutionResult.error`（message 原样透传）；
   - 新增私有 `commandError(message)`，把引擎自身 8 处 `type: "error"` 的文本统一补上
     「错误: 」前缀（前缀原来由 TUI 单侧加，收进 message 后 TUI 与无头逐字一致）。
4. `packages/cli/src/app.ts` 的 TUI `case "error"` 改为直接展示 `result.message`，**不再二次加前缀**
   （否则「错误: 错误: …」）。
5. `packages/cli/src/command/plugin-cli.ts` 改按 `result.type === "error"` 判失败，
   不再 `startsWith("错误: ")` parse 文本——**这条不改会是静默 bug**：`errorText()` 换成
   error 类型后，原来那段 `result.type === "text" ? result.value : ""` 会取到空串，
   `isError` 恒为 false，`sid-code plugin` 的所有失败都退 0。

净效果：`-p "/<命令> 参数错"` 之类失败从「打印错误文案 + 退出码 0」变成「退出码 1」，
CI 可以用退出码区分成功与失败，不必 parse stdout。

## 放弃了什么（以及为什么不选）

- **`message` 不带前缀、由 TUI 侧继续统一加**：这是改动面最小的方案（TUI 一行不改、
  引擎 8 处不用动），但它把「前缀归谁加」这条隐式约定留在原地——`plugin-cli.ts` 靠
  `startsWith("错误: ")` 反解析结果类型就是这条约定在漏的直接证据。前缀收进 message 后，
  契约只有一条：**`error.message` 就是用户该看到的完整文本**，消费方一律透传。
- **只改 `errorText()` 不动引擎自身的 error**：会让同一份 TUI 里两种 error 文本并存
  （命令侧带前缀、引擎侧不带），而这 8 处（未知命令、门控拒绝、fork 失败…）在无头下
  同样走 `fatal_error` 输出到 stderr，两侧文本会不一致。
- **顺手把 `statusline.ts` 等 6 处手写 `{ type: "text", value: "错误: …" }` 一起改成
  `errorText()`**：它们（`vim` / `think` / `effort` / `model` / `statusline`）全部是
  **B 档命令，无头下根本不放行**，改了没有可观测收益，却要动 `validateModelName` /
  `buildInvalidTypeError` 等辅助函数的返回类型。留给 T5（B 档补注入）一并做。
- **给 `error` 分支加 `panel` 等可选字段**：失败结果不需要面板路由，加了会让
  `routeCommandResult` 多一条无意义分支。保持一个只有 `message` 的最小形状。
- **改 `mapExecutionResult`（无头侧）**：它本来就有 `case "error"` → `fatal_error`，
  本次一行没动。无头退出码非 0 的通路是现成的，缺的只是上游从来不产出 error。

## 拿什么证明它生效了

- **新增门禁** `packages/cli/tests/command/local-result-error-branch.test.ts`（9 用例）：
  `errorText()` 形状与文本；executor 映射（含 `confirm.onConfirm` 递归路径）；
  无头 → `kind: "error"`；反向对照（成功的 text 仍是 `output`，不误判）；
  两条静态反漂移断言（`app.ts` 不得二次拼前缀、`plugin-cli.ts` 不得 parse 文本前缀）。
- **变异自证三轮**（仓库铁律，每轮恢复后再跑一遍确认回绿）：
  1. `errorText()` 改回 `{ type: "text", ... }` → 新门禁 **4 pass / 5 fail**（形状、映射、
     无头三组变红）；
  2. `app.ts` 的 error 分支改回 `` `错误: ${result.message}` `` → 静态断言 **1 fail**；
  3. `plugin-cli.ts` 改回 `startsWith("错误: ")` → 静态断言 **1 fail**。
- **选测** `bun test ./packages/cli/ ./packages/core/tests/command-contract/`：
  **2857 pass / 9 skip / 0 fail**（282 文件，284s）。
  过程中因契约变更红了 7 处，均属「测试前提随契约更新」而非实现 bug：
  `trace-prune-index` / `language-dialog` / `memory-set-global-flag` 三处断言 `.value`
  改为断言 `.message`（并加断言 `type === "error"`）；`command-system-batch2`
  的 jsx 抛异常用例与 `fork-answer-is-conversation` 的 Esc 中断用例更新期望文本
  （补「错误: 」前缀）。
- **八道门禁**：`lint` / `lint:boundary` / `lint:command-system` / `lint:legacy-tool` /
  `format:check` / `typecheck:gate` / `docs:gen-reference --check` 全绿；
  `make build` 成功（含产物自检 5 项）。
- ⚠️ **worktree 的类型门禁假阳性（已排除，不是本次改动引入）**：软链 `node_modules`
  下 `typecheck:gate` 报「新增 6 项」，全部是 `import("<root>/…")` vs
  `import("/Users/…/sid-code/…")` 的**同一类型双身份**冲突，且集中在
  `packages/core/tests/skill/*`（不 import 本次改动模块）。按 CLAUDE.md 处置：
  worktree 内 `unlink node_modules` 后 `bun install` 换真实安装，复跑得
  **「当前 62 处 / 基线 64 处，无新增，✓ 通过」**。裸 `tsc --noEmit` 的 84 项输出里
  也没有任何一项指向本次改动的 6 个文件。
- **未做**：真实 `-p` 端到端验退出码。方案文档 §7.1 已写明「`/compact` 在 T6 前被拒，
  不能拿它验 T2」，需要 T3 放行 A 档命令后才能端到端验（`sc-dev -p "/doctor"; echo $?`），
  本次以单测覆盖映射链 + executor 入口，端到端留给 T3 的 PR 一并贴。
