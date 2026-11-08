---
Status: implemented
Date: 2026-11-08
---
# 放行命令的失败分支收口到 `errorText()`：补完 D2/D3 的遗留两处

## 决定了什么

方案《20261106-无头模式斜杠命令放行》核验时发现两处**承诺了但没落地**的残留，
本 PR 一并收掉，并加一道静态门禁防回归：

1. **`think` / `effort` / `model` / `statusline` / `vim` 共 11 处手写
   `{ type: "text", value: "错误: …" }` 改为 `errorText(…)`**。
   D2 落地时明确写了「这 6 处手写前缀留给 T5 一并收」（`think`/`effort`/`model` 是 3 个文件、
   共 11 处 `value: "错误: …"`），但 T5 只做了注入与放行，没收拾前缀。后果是真实缺陷：
   T5 已把 `think`/`effort`/`model` 声明为 `headless: true`，而它们的**参数错误**仍返回
   `text` → 无头下 `mapExecutionResult` 翻成 `output` → **退 0**。CI 只能 parse stdout
   才知道「档位名写错了」，正是 D2 要消灭的那类假成功。
   `statusline` / `vim` 当前未放行（无头不可达），但同属 D2 承诺的 6 处，一并收口以免下次
   放行时又留一个洞；文案逐字不变（`errorText` 自己加「错误: 」前缀），只改结果类型。

2. **`/compact` 的三处业务失败改为 `errorText()`**（D3 主体）：
   - 压缩锁被占（`lock_held`）——请求没执行；
   - PreCompact hook 阻止（`hook_blocked`）——用户配置明确拒绝；
   - LLM 摘要失败 / 本地截断兜底 no-op——一字未压动。

   这在 T6 放行 `/compact`（stream-json / Bridge）之后就可观测了：长驻形态下压缩失败原先
   同样退 0。`对话历史太短，无需压缩` **刻意保留 `text`**——没有可压缩的东西不等价于命令失败，
   把它判成非 0 会让脚本把正常 no-op 读成异常（T6 的端到端用例也按退 0 断言）。

3. **门禁**：`local-result-error-branch.test.ts` 新增一条静态断言——扫
   `packages/cli/src/command/commands/` 全部 `.ts`（剥注释后），出现
   `value: "错误: …"` / `value: \`错误: …\`` 即红。它锁的是「`errorText()` 是唯一构造口径」，
   防的是下一次「放行了命令、却忘了把失败分支改成 error」这种静默退 0。

## 放弃了什么（以及为什么不选）

- **只改已放行的 3 个命令（think/effort/model），不动 statusline/vim**：D2 的承诺是「6 处一并收」，
  只改一半会让门禁的静态断言必须写白名单；而 `statusline`/`vim` 的改动是纯类型变化、
  文案逐字不变，没有可观测风险。选「一次收干净 + 断言无白名单」，代价是 TUI 下这两个命令的
  参数错误会按错误样式渲染（`isError`）——这与 T2 已确立的 TUI 口径一致，是有意的变化。
- **把 `对话历史太短` 也改成 `error`**：那会让「无需压缩」这种正常结果变成 CI 可见的失败。
  脚本若想区分「压了」与「没得压」，应看埋点（`context_compact_skipped` 的
  `too_few_messages`）而不是退出码。保留 `text` 并在代码里写清理由。
- **给 `runPartial` / `runLocalTruncationFallback` 保留 `{ type:"text"; value:string }` 返回
  类型、在调用点做类型断言**：那等于把契约退化成注释。改成 `LocalCommandResult` 让类型层
  继续兜住「新增返回分支必须合法」。
- **在 `headless-allowed-commands.test.ts` 里加参数化用例去探每个命令的失败分支**：
  探针要构造 provider / ctxMgr / hookSystem 等一整套依赖，成本远高于收益；静态扫描直接覆盖
  全部 67 个命令的写法，且不依赖各命令的构造细节。

## 拿什么证明它生效了

- `bun test packages/cli/tests/command/local-result-error-branch.test.ts …（7 个文件）`：
  **64 pass / 0 fail**（含新静态断言）。
- 变异自证（新增门禁必做）：把 `think.ts` 的 `errorText(...)` 改回
  `{ type: "text", value: \`错误: …\` }` → 新断言**红**并报出该文件路径
  （`local-result-error-branch.test.ts:153`），恢复后 10 pass / 0 fail。
- `bun test`（无头全部门禁：allowed-commands / dispatch / injector-wiring / cmdctx-session-id /
  core 侧 injector + bridge）：**164 pass / 0 fail**。
- `bun run affected-tests:run`：**3006 pass / 9 skip / 0 fail**（3015 tests / 285 files）。
- `make build` 通过（产物自检全部 ✓）；`bun run typecheck:gate` 62 处 / 基线 64 处、无新增；
  `lint` / `format:check` / `lint:boundary` / `lint:command-system` / `lint:legacy-tool` /
  `docs:gen-reference --check` 全绿。
- 端到端（待 worktree 构建产物 + 隔离 `SID_CONFIG_DIR`，见 PR 正文）：
  `-p "/effort bogus"` 与 `-p "/model nosuch"` 应退非 0 且 stderr 含「错误: 」。
