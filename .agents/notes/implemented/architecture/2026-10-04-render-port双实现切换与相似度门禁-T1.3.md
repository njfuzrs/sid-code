---
Status: implemented
Date: 2026-10-04
---
# render-port 拆成 legacy / next 双实现，加 SID_TUI_RENDERER 开关与相似度门禁（B9 / T1.3）

## 决定了什么

- **端口目录结构**：原 7 个端口模块原样 `git mv` 进 `render-port/legacy/`；顶层同名文件改成切换层，
  按 `select.ts` 的 `RENDERER` 用**字面量动态 import + 顶层 await** 选择 `legacy/` 或 `next/`，解构后再导出。
  CLI 的 import 路径一个都没变。`RenderInstance` 接口和 `RENDER_INSTANCE_METHODS` 留在切换层
  `runtime.ts`，两边实现都引用它。
- **唯一选择点 `select.ts`**：只有这里读 `SID_TUI_RENDERER`。默认 legacy；空白和大小写不敏感；
  拼错就回落 legacy，并在 stderr 打一行告警，不抛错，因为灰度开关残留一个错值不应导致启动失败。
- **next 骨架**：Box / Text / render / useApp / useInput / useStdin / useStdout / renderSync 直接用上游 ink。
  其余都是 `notImplemented*` 占位，**用到时抛错**，错误信息带上负责的任务号。Context 例外，给的是真 Context，
  否则 CLI 侧的 Provider 挂载时就崩。BEL 例外，直接给值 `\x07`。
  `next/runtime.ts` 的 `render` 保留 legacy 首帧前的那一个微任务边界。
  `getRenderInstance` 直接返回上游 Ink 实例，**刻意不包 adapter**。
- **相似度门禁 `bun run tui:similarity`**（jscpd 5.4.0，MIT，devDependency 钉精确版本）：
  新底座（`packages/tui/src` + `render-port/next/`）与旧底座之间的每个重复块，如果新底座那一段
  去掉空白后原样出现在上游 ink 的同名文件里，就判为「继承自上游」并放行；否则算违规，违规数必须为 0。
  上游基线取 T1.1 导入提交里的 git tree `c14ef7b4…`，它和 ink v7.1.1 tag 的 `src/` 是**同一个 tree OID**。
  这样不用联网，以后改 `packages/tui/src` 基线也不会丢；浅克隆时明确报错。N=30。
- `ui/CLAUDE.md` L5.3 补上「加端口能力要两边一起加」和「NotImplementedError 是预期行为」两条；
  `render-port/README.md` 记录结构和理由；`website/ref/env.md` 重新生成，新增 `SID_TUI_RENDERER`。

## 放弃了什么（以及为什么不选）

- **每个端口模块自己读 env**：中途改 env，或者模块加载顺序不同，就会混用两套底座，
  表现是宿主类型未知 / Context 取不到，很难归因到开关上。
- **静态 import 两套再按条件选**：两套引擎都会在启动时求值（legacy 闭包 86 个文件，next 要加载 yoga WASM），
  白白增加启动开销。动态 import 只求值选中的那一套。前提是没有 `require()` 链进端口模块（顶层 await 模块不能被 require）。
  实测全仓 58 个 require 目标的静态闭包都不经过端口。
- **未实现的符号导出 undefined / 空函数**：CLI 有大量 `?.` 可选链，空实现会静默变成 no-op。
  同理，不给上游 Ink 包一个「方法存在但会抛错」的 adapter，那会让契约 X7 在 next 上假绿。
- **jscpd 只数新旧之间的重复块**：旧底座也源自 ink，上游 ↔ 旧底座在 N=30 时本来就有 39 处同源骨架，
  阈值定为 0 当场就红；调高 N 去躲又会放过真正的复制。所以改为「对照上游判来源」。
- **N 的校准**：噪声底指和渲染无关的本仓代码（core / cli）与旧底座之间的重复，在 N=20 时都是 0 处
  （已核对 jscpd 确实扫到了两边）。同源骨架在 N=30/50/70/100 时分别为 39/10/4/3 处。取 30，比噪声底高一档。
- **jscpd 4.x**：能用，但 5.x 是原生二进制、无运行时依赖。⚠️ 两个版本报告里的路径格式不同：
  5.x 相对于扫描根、不带前导 `/`。按 `'/upstream/' in name` 判断会全部漏掉，第一次实测就因此误读成 0 处。
- **CI 里单独加一步**：lint job 是浅克隆，拿不到上游 tree。test job 带 `fetch-depth: 0` + `vendor:fetch`，
  `tests/scripts/tui-similarity.test.ts` 的真实仓库用例已经在那里跑，不重复加。

## 顺带发现（不在本任务修）

- **legacy：先 `unmount()` 再调 `waitUntilExit()` 会永远挂起**。exit promise 在 resolve 之后才创建，
  而 `waitUntilExit` 是惰性创建 promise。CLI（`fullscreen.ts`）是先拿 promise 再卸载，所以没踩到。
  夹具按 CLI 的顺序写。上游 ink 没有这个问题，T7.1 定义 X 组卸载契约时要决定是否把它写成契约。

## 拿什么证明它生效了

- `tests/render-port/next-switch.test.ts` 17 条：解析规则、唯一选择点（只认真实的 env 读取，注释里提到不算）、
  7 个模块两边导出集合一致、占位用时就抛并带任务号；最小 App 在 未设置 / legacy / next / 拼错 四种取值下
  都在子进程里启动并 rc=0 退出。
- `tests/scripts/tui-similarity.test.ts`：合成夹具做变异自证，「从旧底座复制上游没有的函数」→ 红，
  只改缩进 → 仍红；防空转；真实仓库 0 违规，放行 39 处。
  真实仓库变异：把旧底座 `wordBreakStyledChars` 复制进 `packages/tui/src` → rc=1 并指出文件，删掉后 rc=0。
- `make build` rc=0、无 undefined 警告；二进制内含 27 处 `NotImplemented(` 与 yoga WASM，两套都打进去了；
  `SID_TUI_RENDERER=next ./sid-code --version` 正常。
- 全量 `bun test` 13508 pass / 0 fail；`lint` / `format:check` / `lint:boundary` / `tui:surface --check` / `tui:spec` 全绿。
