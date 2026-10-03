# render-port —— CLI 唯一允许 import 的渲染入口（B9 / T0.2）

CLI（`packages/cli/src` 与 `packages/cli/tests`）**只经这里**拿渲染底座的东西，
直接写 `@sid-code/tui-renderer/*` 会被 `bun run lint:boundary` 拦下。
这样换底座（B9：旧底座 → `packages/tui`）只动这个目录，不动 100 个组件。

当前只有 legacy 实现：每个模块都是对 `@sid-code/tui-renderer` 的纯 re-export，行为零变化。

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

`SURFACE.md` 是 `bun run tui:surface` 生成的，列出 CLI 用到的全部符号 / props / 环境变量 /
stdout 直写。新增一个导出前先想清楚：新底座也必须提供它。

## 实例能力面：`getRenderInstance` 而不是注册表

CLI 拿渲染实例只走 `getRenderInstance(stdout)`，返回类型是端口自有的 `RenderInstance`，
只列真实调用点用到的方法。旧底座的 `instances` Map 不再导出：Map 暴露的是「旧底座 Ink 类的全部
公开方法」，新底座不可能也不应该照抄。

CI 没有 `tsc`，而 CLI 的调用都是 `?.forceRedraw()` 这种可选链 —— 新底座少实现一个方法时
**不会报错，只会静默变成 no-op**。所以方法名同时列在 `RENDER_INSTANCE_METHODS`，
`tests/render-port/render-instance.test.tsx`（契约 X7）运行时逐个核对，并反查接口与清单一致。

