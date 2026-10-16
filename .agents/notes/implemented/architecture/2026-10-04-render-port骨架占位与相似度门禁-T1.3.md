---
Status: implemented
Date: 2026-10-04
---
# render-port 接入 `packages/tui` 骨架：未实现能力用时即抛，加相似度门禁（B9 / T1.3）

## 决定了什么

- **端口接入骨架**：`render-port/next/` 接上 `packages/tui`。CLI 的 import 路径一个都没变。
  `RenderInstance` 接口和 `RENDER_INSTANCE_METHODS` 留在端口顶层 `runtime.ts`。
- **骨架内容**：Box / Text / render / useApp / useInput / useStdin / useStdout / renderSync 直接用上游 ink。
  其余都是 `notImplemented*` 占位，**用到时抛错**，错误信息带上负责的任务号。Context 例外，给的是真 Context，
  否则 CLI 侧的 Provider 挂载时就崩。BEL 例外，直接给值 `\x07`。
  `next/runtime.ts` 的 `render` 在首帧前保留一个微任务边界（冻结行为基线要求如此）。
  `getRenderInstance` 直接返回上游 Ink 实例，**刻意不包 adapter**。
- **相似度门禁 `bun run tui:similarity`**（jscpd 5.4.0，MIT，devDependency 钉精确版本）：
  `packages/tui/src` + `render-port/next/` 与仓内其他渲染代码之间的每个重复块，如果 `packages/tui` 那一段
  去掉空白后原样出现在上游 ink 的同名文件里，就判为「继承自上游」并放行；否则算违规，违规数必须为 0。
  上游基线取 T1.1 导入提交里的 git tree `c14ef7b4…`，它和 ink v7.1.1 tag 的 `src/` 是**同一个 tree OID**。
  这样不用联网，以后改 `packages/tui/src` 基线也不会丢；浅克隆时明确报错。N=30。
- `ui/CLAUDE.md` L5.3 补上「NotImplementedError 是预期行为」；`render-port/README.md` 记录结构和理由。

## 放弃了什么（以及为什么不选）

- **未实现的符号导出 undefined / 空函数**：CLI 有大量 `?.` 可选链，空实现会静默变成 no-op。
  同理，不给上游 Ink 包一个「方法存在但会抛错」的 adapter，那会让契约 X7 假绿。
- **jscpd 只数重复块、阈值定 0**：两边都与上游 ink 有同源骨架，在 N=30 时本来就有 39 处，
  阈值定为 0 当场就红；调高 N 去躲又会放过真正的复制。所以改为「对照上游判来源」。
- **N 的校准**：噪声底指和渲染无关的本仓代码（core / cli）与渲染代码之间的重复，在 N=20 时都是 0 处
  （已核对 jscpd 确实扫到了两边）。同源骨架在 N=30/50/70/100 时分别为 39/10/4/3 处。取 30，比噪声底高一档。
- **jscpd 4.x**：能用，但 5.x 是原生二进制、无运行时依赖。⚠️ 两个版本报告里的路径格式不同：
  5.x 相对于扫描根、不带前导 `/`。按 `'/upstream/' in name` 判断会全部漏掉，第一次实测就因此误读成 0 处。
- **CI 里单独加一步**：lint job 是浅克隆，拿不到上游 tree。test job 带 `fetch-depth: 0`，
  `tests/scripts/tui-similarity.test.ts` 的真实仓库用例已经在那里跑，不重复加。

## 拿什么证明它生效了

- 端口测试覆盖：占位符号用到时就抛并带任务号；最小 App 在子进程里启动并 rc=0 退出。
- `tests/scripts/tui-similarity.test.ts`：合成夹具做变异自证，「复制上游没有的函数」→ 红，
  只改缩进 → 仍红；防空转；真实仓库 0 违规，放行 39 处。
  真实仓库变异：把一个上游没有的函数（`wordBreakStyledChars`）复制进 `packages/tui/src` → rc=1 并指出文件，删掉后 rc=0。
- `make build` rc=0、无 undefined 警告；二进制内含 27 处 `NotImplemented(` 与 yoga WASM。
- 全量 `bun test` 13508 pass / 0 fail；`lint` / `format:check` / `lint:boundary` / `tui:surface --check` / `tui:spec` 全绿。
