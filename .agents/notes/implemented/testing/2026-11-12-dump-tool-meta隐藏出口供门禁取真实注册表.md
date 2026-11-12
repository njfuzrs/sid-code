---
Status: implemented
Date: 2026-11-12
Source: 内置工具设计对齐 Claude Code：缺陷、修复与验收方案（2026-11-12）
---
# 新增隐藏出口 --dump-tool-meta，让门禁能取到「真实注册表 + 延迟标记」

## 决定了什么

`packages/cli/src/cli.ts` 新增隐藏 flag `--dump-tool-meta`：输出
`[{ name, deferred, strict, strictPriority, hasZodSchema }]`，按名字码点序。
它和 `--dump-tools` **共用同一段注册路径**（内置工具注册完成之后、`--tools` 裁剪与
MCP 连接之前，含 dump 前补注册 `ListMcpResources` / `ReadMcpResource` 那一步），
但输出形状独立。

配套三处：

- `tests/helpers/builtin-tool-meta.ts`：spawn 一次出口，进程内缓存，显式传
  `SID_CONFIG_DIR` 到 tmpdir。下游门禁（zodSchema 覆盖、strict 预算、前缀碰撞）共用同一份结果。
- `tests/tool/builtin-tool-meta.test.ts`：出口自身的门禁，钉住「42 个工具 / 18 个延迟 /
  `hasZodSchema` 只有 `notebook_edit` 为 false」，并覆盖 `strictPriority` 的已有声明值。
- `scripts/docs-gen-reference.ts` 的 `HIDDEN_FLAGS` 与
  `tests/website/gen-reference.test.ts` 的隐藏出口断言一起登记。

三个字段各有唯一权威来源，出口里不内联推导：`strict` 按名关联 `definitions()`
（判定在 `toolToDefinition()`，内置 true、MCP 与 `StructuredOutput` 不发）；
`deferred` 走 `registry.isDeferred()`（同时看 `shouldDefer` 静态声明、`mcp__` 前缀、
运行时名单、激活态与用户豁免名单）；`hasZodSchema` 看实例上有没有 `zodSchema`。
`definitions()` 里按名找不到某个已注册工具时**硬失败**，不返回缺字段的清单——
门禁读到 `undefined` 会当 false，静默失去保护。

## 放弃了什么（以及为什么不选）

**不把 44 处注册抽成 core 里的 `registerBuiltinTools()`。** 方向对，但要搬
`fileReadTracker` / `planManager` / LSP / `sandboxManager` 等会话对象，是跨包重构，
塞进这次改动里回滚成本高。门禁只需要「名字 + 几个元数据位」，spawn 一次就够。
以后真做这个重构时，出口改成直接调用它即可，门禁侧不用动。

**不给 `--dump-tools` 加 `deferred` 字段。** 它的输出形状被 `docs:gen-reference` 与
`tests/website/gen-reference.test.ts` 依赖；加字段会让「改一个门禁字段」变成
「必须重生成参考页」，把两件事绑死。

**不做成运行时 API（如 `/tools --meta`）。** 那会成为用户可见契约，而这里要的是测试与
门禁的内部事实源，不需要对用户承诺稳定性；一旦有人依赖它，未来调整形状就变成破坏性变更。

## 拿什么证明它生效了

出口本身（2026-11-12，本机）：

```
$ SID_CONFIG_DIR=$(mktemp -d) bun run packages/cli/src/entrypoints/bootstrap.ts --dump-tool-meta | jq length
42
$ ... | jq '[.[]|select(.deferred)]|length'
18
$ ... | jq '[.[]|select(.hasZodSchema|not)|.name]'
["notebook_edit"]
```

新增门禁：`bun test ./tests/tool/builtin-tool-meta.test.ts` → **7 pass / 0 fail，223 expect**。

变异自证（把被测代码改坏，确认断言变红并报出正确内容，再恢复）：

- `deferred: toolRegistry.isDeferred(name)` 改成 `false` → 延迟数断言红：
  `Expected: 18 / Received: 0`；
- `hasZodSchema: t.zodSchema !== undefined` 改成 `true` → 名单断言红（期望 3 个差异 vs 实测 1 个）；
- 两处恢复后重跑 7 pass。

参考页：`bun run docs:gen-reference` 只改了 `website/ref/cli.md` 的两处计数
（`共 69 个 flag` → `70`；隐藏出口列表从 2 个变 3 个）。这是**必需漂移**——
方案原文预期「PR-0 不漂移」，但新增 parseArgs flag 必然改变这一页，已在此记录。
`bun run docs:gen-reference --check` → ✓ 与源码一致。

其余门禁：`bun run lint` 0 warning / 0 error；`bun run format:check` 通过；
`bun run lint:boundary` 通过；`bun run typecheck:gate` 无新增（62 处 / 基线 64）；
`make build` 通过（产物自检 5 项全绿）。

`bun run affected-tests:run`：5349 pass / 10 skip / 2 fail。两条失败都在
`tests/build/rules-paths-scope-nonempty.test.ts`，是 worktree 环境假失败，三条举证齐全：
① 该文件只 import `bun:test` / `child_process` / `fs` / `path` / `@sid-code/core/config/rules`，
不 import 本次改动模块；② 父仓 main 单跑 3 pass / 0 fail，worktree 单跑 1 pass / 2 fail
（`hit: null`）；③ 成因是 worktree 的 `.git` 为 gitdir 指针文件，`ruleOwnerDir` 解析到
主仓根而非 worktree 根，`relative(REPO, ownerAbs)` 得到 `../../..`，候选集恒为空。
