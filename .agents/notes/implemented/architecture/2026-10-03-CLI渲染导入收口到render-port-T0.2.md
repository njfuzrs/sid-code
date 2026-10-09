---
Status: implemented
Date: 2026-10-03
---
# CLI 的渲染底座导入全部收口到 ui/render-port/，并由 lint:boundary 强制（B9 / T0.2）

## 决定了什么

- 新建 `packages/cli/src/ui/render-port/`，当前只有 legacy 实现：8 个模块全是对 `@sid-code/tui-renderer/*` 的纯 re-export
  （`components` / `hooks` / `measure` / `text` / `termio` / `runtime` / `testing` / `types`），分组理由写在该目录 `README.md`。
- 一次性 codemod 把 `packages/cli/src` 与 `packages/cli/tests` 里全部底座导入改到端口：120 个文件，含 `cli.ts` / `copy.ts` / `bug.ts` 的动态 `await import()`（保持懒加载，不改成静态）。
  源码用相对路径，测试用 `@sid-code/cli/ui/render-port/*.ts`（测试跨包相对路径本来就被 lint:boundary 禁止）。
  唯一的改名：`Props as TextProps` → 端口直接导出 `TextProps`。
- `scripts/pkg-boundary-scan.ts` 加 `scanRenderPortMode`：CLI src + tests 中，`render-port/` 之外出现 `@sid-code/tui-renderer` 或 `@sid-code/tui` 即违规。接进 `bun run lint:boundary` 的退出码，CI 的 lint job 已经在跑它。
- `ui/CLAUDE.md` L5.3 重写：废掉「遇 cc 做法默认能搬，先去 `src/ink` 找」，改成「只经端口导入、不读旧底座、端口缺能力先在端口里加」。同文件另外 5 处指向 `src/ink` 的引导一并改掉。

## 放弃了什么（以及为什么不选）

- **单个 `index.ts` barrel**：实测 `Bun.build` metafile，`root.ts` 依赖闭包 85 个底座文件，`stringWidth.ts` 只有 2 个。
  一个 barrel 会让只要 `Text` 的组件 / 测试把整套引擎一起加载，改变模块求值顺序。T0.2 要求零行为变化，所以按闭包分组。
  代价是 D-4 设想的「`index.ts` 顶层按 `SID_TUI_RENDERER` 一次判定」要在 T1.x 改成每个分组模块各自判定（或一个共享的 `impl.ts`）。到时再定。
- **现在就写端口自有类型 + `satisfies`**：那是 D-4 的目标形态，但需要先有第二个实现才有意义。`types.ts` 暂时直接 re-export legacy 类型，T1.3 再替换。
- **把 `tui:surface --check` 也接进 CI**：没接。lint:boundary 管的是「有没有绕过端口」（必须拦），SURFACE 签名管的是「端口面有没有变」（变化本身合法，只需要被看见）。
  后者先靠 `tests/scripts/tui-surface.test.ts` 的签名断言在 `bun test` 里红。
- **把 `CLAUDE.md` frontmatter 的 `src/ink/**` 路径删掉**：没动。那是旧路径的匹配规则，删了不影响行为，留给 T9 收尾一起清。

## 拿什么证明它生效了

- `bun run tui:surface`：codemod 前后都是 44 个符号 / 51 种 props / 38 个环境变量 / 101 个源码文件 / 19 个测试文件。
  签名变化只来自 `Props` → `TextProps` 改名（逐项 diff 集合确认，props 集合零差异）。
- `bun run lint:boundary`：`渲染端口（475 文件，端口内 36 条底座导入）绕过端口直连底座：0 处`。
  变异自证：在真实仓库临时加一个直连 import，rc=1，删掉后 rc=0；`tests/build/package-boundary.test.ts` 新增 3 条用例（零违规、防假绿、在 tmpdir 仿真仓库里植入 src / tests / 动态 import 三种违规 + 端口内放行）。
- 全量 `bun test`：13360 pass / 0 fail。`make build` rc=0，`will always be undefined` 0 处。`bun run lint` rc=0，`format:check` 通过，`docs:gen-reference --check` 通过。
- `sc-dev` 真实 PTY 手测（expect 驱动，主屏与 `--alternate-buffer` 各一遍）：输入框出现、`?` 快捷键面板打开 / 关闭正常；alt 模式发出 `?1049h`，主屏没有发。
  **退出这一步在 expect 下卡住**（`/exit` 之后 4s 进程仍存活，3 个 MCP 子进程还挂着），但线上稳定版 `sid-code` v0.1.606 表现完全相同，所以不是本次引入的。属于本任务范围外的已有问题，没修。
