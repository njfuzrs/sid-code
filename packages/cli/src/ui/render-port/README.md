# render-port —— CLI 唯一允许 import 的渲染入口（B9）

CLI（`packages/cli/src` 与 `packages/cli/tests`）**只经这里**拿渲染底座的东西，
直接写 `@sid-code/tui/*` 会被 `bun run lint:boundary` 拦下。底座以后再换、再改，只动这个目录，不动 100 个组件。

## 结构

```
render-port/
  <模块>.ts        ← 端口面：静态 re-export `next/<模块>.ts`；runtime.ts 另定义 RenderInstance 接口与方法清单
  next/<模块>.ts   ← 对底座 @sid-code/tui（packages/tui，MIT ink fork）的适配：改名、补形状、收窄端口面
```

- 渲染底座只有一套：`packages/tui`。旧底座 `tui-renderer`、legacy 分支与 `SID_TUI_RENDERER` 开关在 B9 / T9.1 删除，
  防回退断言是 `tests/build/no-legacy-renderer.test.ts`。`next/` 这个名字是双底座时期留下的，T9.1 刻意没改名。
- **少实现就该红，不做 no-op**：CLI 有大量 `?.` 可选链，空实现会把「底座少了一块」藏起来。
  `next/runtime.ts` 的 `getRenderInstance` 直接返回底座 Ink 实例、不包 adapter，方法缺失时契约 X7 红。
- 行为基线：旧底座删除前冻结的输出在 `tests/render-port/term-bench/baseline/`、`tests/render-port/fixtures/legacy-frozen/`、
  `packages/tui/tests/fixtures/*-vectors.json`。生成它们的旧底座已不在仓库，**不能重生成**；有意改行为时手改并在 PR 里说明。

## 为什么拆成按依赖闭包分组的多个模块，而不是一个 index.ts

实测（`Bun.build` metafile）：`root.ts` 的依赖闭包是 85 个底座文件，`stringWidth.ts` 只有 2 个。
一个大 barrel 会让「只想要 `Text`」的测试把整套引擎（reconciler / ink / terminal）一起加载，
改变模块求值顺序与测试耗时 —— 这一步要求的是**纯机械、零行为变化**。

| 模块 | 内容 | 底座闭包（文件数） |
| --- | --- | ---: |
| `components.ts` | Box / Text / Static / Ansi / RawAnsi / AlternateScreen | 24 + AlternateScreen 18 |
| `hooks.ts` | useStdout / useStdin / useInput / useApp / … 与三个 Context | 29 |
| `measure.ts` | measureElement / getBoundingBox / ResizeObserver | 3 |
| `text.ts` | stringWidth、colorize 三函数、styled-chars 五函数 | 4 |
| `termio.ts` | OSC 工具、BEL、supportsHyperlinks | 5 |
| `runtime.ts` | render / `getRenderInstance` + `RenderInstance` 实例能力面 / drainStdin / 探查抑制 —— **整套引擎** | 86 |
| `testing.ts` | 测试用 render / renderSync / `enableFrameThrottle` / `forgetRenderInstance` | — |
| `types.ts` | 仅类型 | 0（编译后消失） |

`cli.ts` 会话选择器与 `/copy` 等命令对 `runtime.ts` / `termio.ts` 用的是**动态 import**，
保持原来的懒加载时机，别改成静态。

## 端口面清单

`SURFACE.md` 是 T0.1 起由脚本从源码扫出的端口面盘点（符号 / props / 环境变量 / stdout 直写），
扫描脚本扫的是旧底座，T9.1 随旧底座删除，**这份清单从此是 T9.1 时的冻结快照**。新增导出时在端口模块里加，
不必改它；它回答的是「底座要提供哪些东西」，具体实现以端口模块为准。

## 实例能力面：`getRenderInstance` 而不是注册表

CLI 拿渲染实例只走 `getRenderInstance(stdout)`，返回类型是端口自有的 `RenderInstance`，
只列真实调用点用到的方法。底座的 `instances` Map 不导出：Map 暴露的是「Ink 类的全部公开方法」，
端口面不该跟着它变。

CI 没有 `tsc`，而 CLI 的调用都是 `?.forceRedraw()` 这种可选链 —— 新底座少实现一个方法时
**不会报错，只会静默变成 no-op**。所以方法名同时列在 `RENDER_INSTANCE_METHODS`，
`tests/render-port/render-instance.test.tsx`（契约 X7）运行时逐个核对，并反查接口与清单一致。

