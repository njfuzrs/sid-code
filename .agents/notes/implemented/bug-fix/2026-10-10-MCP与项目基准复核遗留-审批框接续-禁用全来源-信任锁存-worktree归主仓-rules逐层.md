---
Status: implemented
Date: 2026-10-10
---
# #220 复核遗留：审批框接续、禁用覆盖全来源、信任锁存继承、私有状态按主仓、rules 逐层合并

接在 `2026-10-10-MCP加载与禁用死接线-项目基准按CC四种对齐.md` 之后。#220 合入后复核时发现几项：
主路径已经接通，但在最常见的场景里实际不生效。

## 决定了什么

- **只有 `.mcp.json` 时启动审批框批准后不连接**：`cli.ts` 原来只在有生效 server 或 IDE 自动连接时才建 MCPManager，
  而 pending 的 server 不算生效。新增 `shouldCreateMcpManager`，有 pending（且企业策略允许 MCP）时也建 manager。
  manager 确实不存在时（策略禁用），批准会落盘，并提示「重启会话后连接」。
- **审批框被信任框 / @import 框挤掉**：首屏一次只能挂一个对话框。原来 `handleDialogClose` 一律把对话框置 null，
  于是审批框不再弹出。新增 `ui/startup/dialog-queue.ts` 维护首屏队列（onboarding → trust → @import → mcp-approval）。
  关闭一个对话框后取队列里的下一个，并且只往后走：Esc「暂不决定」的项不会被反复弹出。
  用户自己打开的对话框关闭后，不会把首屏队列再拉起来。onboarding 完成后也接着走这个队列。
- **插件 / `--mcp-config` 来源的禁用重启后失效**：开关原来只在 `loadConfig` 里套用，那时这两个来源还没合并进来。
  现在 `cli.ts` 合并完所有来源后再套一次 `applyServerToggles`。
- **配置里写死的 `enabled:false` 启用后重启又变回禁用**：`mcp-state.json` 增加 `enabledMcpServers`，与 `disabledMcpServers` 互斥，
  用来覆盖配置源里的 `false`。
- **私有状态按主仓归一（文档原本的要求）**：B2 拆成两个入口。
  - `getProjectIdentityRoot` 改用 `resolveMemoryProjectRoot`（`--git-common-dir`，即主仓根），用作 ~/.sid-code 下的分区键：
    信任、MCP 审批、禁用、local 作用域。
  - 新增 `getCheckoutRoot`（`--show-toplevel`），用于定位工作树里的文件：settings.local.json、规则作用域的项目根。
  - 迁移兼容：审批旧键现在是数组（启动 cwd + #220 的工作树根）；mcp-state.json / mcp.local.json 在主仓键下不存在时，回退读工作树键；
    写入一律写主仓键。
- **P10 信任继承改为锁存（用户拍板：对齐 CC，继承时不比 hash）**：原来继承到的祖先记录也要比 configHash，
  而祖先当时的 hash 不可能等于当前仓库的配置，所以继承从来没生效过（门禁测试用的是空配置，测不出来）。
  现在 `findRecord` 返回 `inherited`：祖先记录直接放行；本项目自己的记录仍然比 hash；本项目记录优先于祖先记录。
  家目录不参与继承。
- **P3 同层顺序**：原来是「全部 CLAUDE.md → 全部 rules → 全部 local」，外层的 local 会覆盖内层的 CLAUDE.md。
  现在按父链逐层合并：每层内部 CLAUDE.md → rules → local；子目录 CLAUDE.md 归入 projectRoot 那一层。
  `.claude/CLAUDE.md` 按它所在的层归属（`chainLayerDir`）。
- **P1b 属主**：仓库根目录的属主不是当前用户时，settings.local.json 退回启动目录（root 用户不做这个判断）。
- **小项**：`.mcp.json` 的祖先遍历复用 `getAncestorChain`（原来另写了一份，cwd 为根时两份结果不一样）；
  `sameDir` / `isForeignWorkspace` 的 realpath 结果加进程内缓存；`mcp list/get` 对禁用项标「⊘ 已禁用」，
  对 `.mcp.json` 来源的 server 标出来源文件。
- **官网**：mcp / memory / configure / permissions / hooks / skills / subagents / extend index / migrate 九页同步更新，
  另外 `docs-gen-reference.ts` 模板里 settings.local.json 的位置也改了。configure 页新增「各类配置从哪个目录找」汇总表。

## 放弃了什么（以及为什么不选）

- **信任继承保留 hash 门，或者只在首次见到仓库时继承**：用户选择对齐 CC 的锁存语义。
  代价已经写进注释和 hooks 文档：在 ~/Code 这类父目录信任一次后，其下新 clone 的仓库里的危险配置会直接生效。
- **settings.local.json 也按主仓存**：否决。它是工作树里的文件，按主仓存等于跨 checkout 改别人的工作区。
- **只靠 Esc 后回头重新扫描首屏队列**：否决。Esc 的语义是本会话不再问，回头扫描会导致反复弹出。

## 拿什么证明它生效了

- 新增 `core/tests/config/project-bases-followups.test.ts`（13 条）和 `cli/tests/ui/startup/dialog-queue.test.ts`（5 条）。
  变异自证：worktree 归主仓 / 信任锁存 / P3 逐层 / manager 条件，撤掉任意一项，对应用例都会变红。
- affected-tests 5355 pass / 1 fail。失败的是 `evals/.../analyze-permission-switch.py` 在 Python 3.9 下的 f-string 语法问题，
  本 PR 没有改动 evals，main 上同样失败。
- `make build` 自检通过，lint / lint:boundary / format:check / docs:gen-reference --check 全部通过。
- 用构建产物在 gemini 子目录跑 `mcp list`：祖先目录里的 tavily 和 ~/.mcp.json 里的 mastergo-magic-mcp 都被列为待审批。
- 没做的：没有在 TUI 里实机点一遍审批框接续和批准后当场连接（只做了组件层和纯函数层测试）。
