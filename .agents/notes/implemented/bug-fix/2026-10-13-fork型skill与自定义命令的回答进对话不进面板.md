---
Status: implemented
Date: 2026-10-13
---
# fork 型 skill / 自定义命令：回车即回显，回答进对话不进输出面板

## 决定了什么

#223（命令多行输出进面板）与 d91fbc15（短回执进状态栏）之后，app.ts 把所有 `message`
结果都交给 `routeCommandResult`：≥3 行进面板，否则进状态栏，消息流不留痕。
而 fork 执行的 prompt 命令也以 `message` 返回——它的内容是**模型的回答**，不是命令报告。
未写 `context` 的磁盘 skill 缺省就是 fork（`resolveSkillExecutionContext`），
带 `allowed-tools` 的自定义命令也走 fork（`custom.ts`），所以 `/interview` `/project-qa`
这类与模型交互的命令，回答全被塞进了 Esc 一关就没的面板，下一轮模型也看不到。

修法：给结果加一个 `conversational` 标记，由**产出方**声明，而不是让展示层猜。

- 三个 fork 出口打标记：`command/executor.ts` executeFork、`command/skill-command.ts`
  executeFork、`command/custom.ts` executeFork。
- 契约 / 适配层透传：`LocalCommandResult.text`、`CommandExecutionResult.message`、
  `CommandResult`、`adapter.ts` 两向转换；executor 的 `mapLocalResult` 里标记压过 `outputPanel`。
- app.ts 新增 `presentConversationalResult`：按一轮对话落，user 消息带
  `command-expansion` 标记（屏幕只显示触发命令，与 inline 展开同一套渲染），assistant 消息是回答；
  两条都进 ctxMgr 与会话存档，然后 `syncDisplay`。新体系与旧体系回退两条 `message` 分支都接上。
  消息形状抽成纯函数 `ui/command-result-route.ts` 的 `buildCommandAnswerMessages`。

inline 型（`submit_prompt`）本来就进对话，不受影响；内置命令的面板 / 状态栏语义不变。

**第二个问题：回车后整屏空白，等子代理跑完才出现 `/interview`。** inline 路径在 `tuiAgentLoop`
里乐观上屏，fork 路径完全在 `executor.executeSlashCommand` 的 await 里跑完，期间既没回显、
也没 `isLoading`（无 spinner、Esc 无效、输入不排队）。对照 cc：`executeForkedSlashCommand`
开跑前先 `setToolJSX` 出进度 UI（`showSpinner: true`），跑完才返回两条消息。

- 契约加 `CommandContext.beginForkedRun?: () => { signal, end }`（AppContext 同名，adapter 双向透传）。
  三个 fork 出口在 `executeCustom` 之前调它、把 `signal` 传给子代理、`finally` 里调 `end`；
  返回后 `signal.aborted` → `error「已取消 /xxx」`，不把半截回答当对话落。
- app.ts 实现：新建 `abortController`（`onInterrupt` 就能中断它）、`busy = true`、
  立即追加乐观 `command` 历史项 + `isLoading: true`。`end` 复位加载态，并在**下一个宏任务**
  `syncDisplay` 收口——同步做会在回答落盘前先把回显撤掉、下一帧再加回来（闪一下）。

## 放弃了什么（以及为什么不选）

- **按 `cmd.type === "prompt"` 在 app.ts 判定**：app.ts 拿到的只有结果，不知道命令类型；
  而且自定义命令经 legacy 适配后是 `local` 型，按类型判会漏掉 `/project-qa`。
- **把 skill 缺省 context 改成 inline**：能顺带修好未声明 context 的 skill，但改变执行语义
  （工具集、上下文、hooks 作用域都变），且修不了带 allowed-tools 的自定义命令。不是同一个问题。
- **照搬 cc 的子代理进度 UI（逐条工具调用的 progress 卡片）**：sid-code 已有子代理进度侧信道
  （`liveAgentProgressSink`），但它挂在 `sub_agent` 工具卡片上，fork 命令没有对应的 tool_use。
  先做回显 + spinner 解决「像没执行」；逐步进度另开任务，别把两件事绑一个 PR。
- **在 executor 外层（app.ts onSlashCommand）对所有命令先回显**：大多数命令是毫秒级本地命令，
  它们的结果按 #223 / d91fbc15 就不该进消息流，先回显再撤会闪。只有真正要跑模型的 fork 出口
  知道「接下来要等很久」，所以由它发起。
- **只写显示层侧表（appendCommandOutput）不进 ctxMgr**：回答能上屏，但下一轮模型看不到
  自己刚问的题，`/interview` 这种多轮追问直接断掉；resume 后也会消失。

## 拿什么证明它生效了

- `bun test ./packages/cli/tests/command/fork-answer-is-conversation.test.ts`：13 pass。
  覆盖三个 fork 出口、begin→信号→end 时序（含抛错、Esc 中断）、适配层透传、outputPanel 压不过标记、普通 local 多行报告仍进面板、
  落成的消息在历史区渲染为「触发命令 + 回答」且不泄漏展开提示词。
- 变异自证：删掉 executor.ts executeFork 的 `conversational: true` → 1 fail；
  让 executor 不调 `beginForkedRun` → 3 fail。恢复后 13 pass。
- `bun run affected-tests:run`：13012 pass / 0 fail；`make build` rc=0、无 `will always be undefined`；
  lint / format:check / lint:boundary 全绿。
- 尚未做：在真实 TUI 里用 `sc-dev` 跑 `/interview` 走一遍（需要真实模型调用）。
