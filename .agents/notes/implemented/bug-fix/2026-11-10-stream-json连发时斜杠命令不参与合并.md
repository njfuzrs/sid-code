---
Status: implemented
Date: 2026-11-10
---
# stream-json 连发时，斜杠命令不参与批量合并

## 决定了什么

在 `CommandQueue.canBatchWith` 里对合并的**两侧**都排除「trim 后以 `/` 开头」的输入，
新增模块级纯函数 `mustStandalone`（`packages/core/src/sdk/command-queue.ts`）。
命中时该条命令独占一轮，不进入 `\n\n` 拼接。

改动面三个文件：

- `packages/core/src/sdk/command-queue.ts`：新增 `mustStandalone`，`canBatchWith` 两侧引用。
- `packages/core/tests/sdk/command-queue.test.ts`：7 条单测。
- `packages/core/tests/sdk/stream-json-e2e.test.ts`：2 条 e2e（两种顺序各一）。

缺陷链路（回源码核过）：stream-json 输入路径下，stdin 的每条 `type:"user"` 消息都以
`mode:"prompt"` / `priority:"next"` 入队，且 **`workload` 与 `isMeta` 都不设**
（`packages/core/src/sdk/headless-runner.ts:261-266`）。于是 `canBatchWith` 的三项判据
（`prompt` 对 `prompt`、`undefined === undefined` 两次）恒真，任意两条连续 prompt 都会被
拼成一条再交给一次 `submitMessage`。之后 `App.submitHeadlessInput` 用 `parseSlashCommand`
只看整串的**第一段**（trim + `split(/\s+/)`）：

- 命令在前：整串被解析成命令，后面的普通提问成了它的参数被吞掉；
- 命令在后：第一段不是命令，整串（含命令文本）当普通提问发给模型，命令不执行。

所以判据必须落在合并的两侧；只判 `next` 会漏掉第一种形态。

`/tmp/x` 这类真实路径一并排除：它同样要经过分发器区分「未知命令 / 路径 passthrough」，
合并会绕过那次判定。

## 放弃了什么（以及为什么不选）

1. **只判 `next` 不判 `head`**：漏掉「head 是命令、后续提问被并进来」这一半，
   正是「命令在前吞提问」的形态。`dequeueBatch` 的循环是
   `while (canBatchWith(head, this.peek()))`，`head` 是批次首条，不会随循环更新。
2. **在 pump 层给斜杠命令设不同的 `workload`**：pump 不知道「什么是命令」，要引入
   `parseSlashCommand` 就会让 `core/sdk` 依赖 `cli` 的命令解析，破坏包边界；
   而且 `workload` 的语义是「工作负载标签」，拿它当「能否合并」的开关是语义错位。
3. **在 pump 层入队前直接分流斜杠命令**：同样需要 core 依赖 cli 的命令注册表；
   且 `dequeueBatch` 的生产调用点只有一处（`headless-runner.ts:295`），改队列是最小面。
4. **让 `resolveHeadlessSlash` 按 `\n\n` 拆开拼接串再逐条分发**：分发层要知道队列的私有
   拼接约定；且合并后 `mergedUuids` 已无法还原成两条独立输入的对应关系，
   「一输入一响应」的对齐会丢。
5. **整体关掉批量合并**：合并本身是省 token 的设计（连续同 workload 的多条 prompt 合一次
   模型调用），不该为一个边界缺陷整体牺牲；且会改变所有非命令场景的行为，回滚面更大。

## 拿什么证明它生效了

- 新增 7 条单测（命令在前 / 命令在后 / 命令夹中间 / 前导空白 / 两条连续命令 /
  `/tmp` 路径 / 独占不破坏其后正常合并）+ 2 条 e2e（两种顺序，断言引擎收到两次独立
  `submitMessage` 且出两条 `result`）。
- **变异自证**：把 `mustStandalone` 临时改成 `return false`，两个文件跑出
  **9 条 fail**（7 单测 + 2 e2e）、其余 33 pass；恢复后 **42 pass / 0 fail**（113 expect）。
  说明新断言确实守在被测行为上，不是恒绿。
- `bun run affected-tests:run` → **205 pass / 0 fail**（16 files，判定 selective：
  `./packages/core/tests/sdk/`）。
- `make build` → 成功，产物自检 5 项全过（git-status 锚点、止损阀、内置 skill、
  内嵌 ripgrep、review 子命令 Skill）。
- `bun run lint` / `format:check` / `lint:boundary` / `lint:command-system` /
  `lint:legacy-tool` / `typecheck:gate` → 六项全部 OK。

影响面边界：Bridge 虽然同样经过 `submitHeadlessInput`，但由 `BridgeRunner` 直接调用
（`app.ts:9217-9218`），不经过 `CommandQueue`；`-p` 文本/JSON 是单轮、无后续 stdin。
受影响的只有 `--input-format stream-json` 这一条输入路径。
