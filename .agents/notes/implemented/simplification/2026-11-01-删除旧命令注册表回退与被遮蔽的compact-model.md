---
Status: implemented
Date: 2026-11-01
---
# 删除旧命令 Registry 的回退路径、无人读取的 customCommands 和被遮蔽的旧 compact/model，新增同名门禁 G4

## 决定了什么

App 的斜杠命令只保留 `UnifiedCommandRegistry` 这一条路径（#514）：

- `AppOptions.unifiedRegistry` 改为必填。删除 `AppOptions.commandRegistry`、`App.commandRegistry`，以及补全列表的旧 Registry 回退、命令执行的旧回退分支（内含第二个 `case "quit"` / `case "clear"`）、`refreshSkillCommands`、信任批准后往旧 Registry 重注册自定义命令的代码。
- `cli.ts` 不再构建旧 Registry，也不再往里注册自定义命令、Skill 命令（磁盘 / 插件 / MCP 三处）和插件命令。新体系通过 `onSkillsChanged → invalidateSkillCommands`、`loadPlugins` 拿到同样的来源。
- 删除 `customCommands` 字段（cli `AppContext`、core `CommandContext`、adapter 两个方向的转抄）和 `getCustomCommandsSummary()`。全仓没有读取方，注释里说的「供 /help 显示」与事实不符。
- `plugin/refresh.ts` 去掉 `commandRegistry` 分支，删除 `plugin/merge.ts`（`mergePluginCommands`，已经没有调用方）。注释里提到的「bridge/headless 仍用旧 Registry」的调用方并不存在：唯一调用方 `/reload-plugins` 总会同时传 `unifiedRegistry`。
- 删除 `builtins.ts` 里的 `ModelCommand` / `CompactCommand`（新版在 `commands/`，旧版被 `migratedNames` 遮蔽），以及只测旧版的 `model.test.ts` 和 `compact-noop-report.test.ts` 中测旧版的 describe。G2 基线 36 → 34，G1 基线 30 → 29。
- `command-system-gate.ts` 新增 G4：旧体系命令名和新体系命令名的交集必须为空。两边都从真实注册表取名：旧体系实例化 `registerBuiltins` 后读 `name()`，新体系读 `BUILTIN_COMMANDS[].name`。

旧 Registry 类（`registry.ts`）本身保留：`loaders.ts` 的 `loadBuiltinCommands` 还要靠它把剩余 34 条旧命令桥接进新体系，等逐条迁完再删。

## 放弃了什么（以及为什么不选）

- **保留旧回退作为「保险」**：生产环境 `cli.ts` 总会创建 `unifiedRegistry`，回退只有测试能走到，却仍要人对它做修复。`627d3bda` 修 /compact 谎报成功时就同时改了一遍死实现。
- **补全加载失败时回退到旧 Registry**：旧 Registry 只装着启动时的快照，回退过去拿到的本来就是陈旧列表。改为记 warn 并返回空列表，只影响补全，执行路径每次都会重新 `getCommands`。
- **G4 按类名推导命令名**：36 条里有 4 条会推错（`MCPEnhancedCommand` 实际是 `mcp`、`AddDirCommand` 是 `add-dir` 等），交集会静默漏判。
- **顺手让 /help 展示自定义命令**：这是新功能，应另开 issue，并从 `unifiedRegistry` 取数。

## 拿什么证明它生效了

- `bun run lint:command-system`：G1 29 / G2 34 / G3a 0 / G3b 0 / G4 0，「四道门禁通过」。`--update-baseline` 已收紧。
- G4 变异自证：把 `CostCommand` 的 `name()` 改成 `"compact"`，门禁报 `✗ G4 … compact`；把新体系 `btw` 改名为 `mcp`，门禁报 `✗ G4 … mcp`，说明取的是真实 `name()`。两处恢复后都通过。
- `tests/scripts/command-system-gate.test.ts` 新增 4 条 G4 用例：纯函数、两边非空、真实取名（含 `mcp` / `add-dir`）、当前交集为空且旧 compact/model 已删。27 pass。
- 契约有意变更，同步修正测试前提：`clear-rotates-session-wiring` 中 `case "clear"` 2 → 1，`trace-upload-exit-path-wiring` 中 `setUploadBudgetMs` 4 → 3。两处的被删项都是旧执行回退里的 case。
- `typecheck:gate` 66/66，没有新增错误（测试里 6 处 `new App` 改为注入 `UnifiedCommandRegistry`）；`make build` 通过；`lint`、`format:check`、`lint:boundary`、`docs:gen-reference --check` 都通过。
- `affected-tests:run`：上面两处修正前为 4639 pass / 4 fail。剩下的 2 条 `rules-paths-scope-nonempty` 失败来自 worktree 路径里的 `.sid-code` 段（`rules.ts:413` 的 `ruleOwnerDir` 取最后一个 `.sid-code`），父仓 main 上单跑 0 fail，`rules.ts` 本次没有改动。
