---
Status: implemented
Date: 2026-11-13
---
# Footer tps 列：0.x 吞吐被渲染成 `⇢0/s`，以及换字形后遗漏的用户可见文案

## 决定了什么

#807 合入后 code review 跟进的 5 项修复，**不改 tps 列的设计**（数据源、dropOrder、
`⇢` 字形都不动），只修边界、隐式契约与文案漂移：

1. **`deriveTps` 对 `0 < outputTps < 0.5` 返回 null，不渲染**（`useStatusLineData.ts`）。
   此前只拦 `outputTps <= 0`，`Math.round(0.4)` 得 0 → 渲染成 `⇢0/s`。
   真实触发：首轮只吐几十 token 且思考很久，**会话累计均值**（不是单轮值）会落在
   0.1–0.4 tok/s —— 早期轮次在均值里权重极大。`⇢0/s` 会被读成「生成速度为零」，
   与「无样本」混成同一个读数，而两者对策相反（前者是「很慢、还要等更久」，后者是「还没数据」）。
   这也不是新主张：#807 自己的 Agent Note 就写明「落一个 `⇢0/s` 会被读成生成极慢，比不显示更糟」，
   实现只是漏了取整后的这一档。
2. **Footer tps 段改用 `data.tps.value` 渲染**，不再 `data.tps.text.slice(TPS_MARK.length)`。
   slice 依赖「text 恰好以 TPS_MARK 开头」这个隐式契约，字形一变长就静默错位；
   改后与相邻 cache 段的 `{data.cache.rate}%` 完全同构（`str` 供宽度预算、nodes 两色渲染）。
   属无行为变化的重构，由「`text` 与 `value` 两个断言同时成立」间接守护。
3. **`/cache` 用户可见文案 `⚡ 列` → `↯ 列`**。`cache.ts` 那句 `type: "text"` 会打印给用户，
   #807 换了字形却漏了这处运行时输出——界面上是 `↯78%`，一句话提示还让人去找 `⚡`。
   另 5 处同源注释（`App.tsx` / `state-bridge.ts` / `Footer.tsx` / `BottomRegion.tsx` /
   `useStatusLineData.ts`）一并订正；**保留** `figures.ts` 与 `deriveCacheMetrics` 里
   「替代此前的 ⚡」那两处历史说明——它们讲的就是为什么换，不能删。
4. **补两条测试**：`deriveTps` 的 0.x 边界（纯函数 + 整帧渲染各一条），
   以及 cost-bridge 的「先有值 41 → getter 再返回 undefined → 回落 undefined」。
   后者是 `/clear`（trace 重建、`gen_samples` 归 0）与 trace 中途关闭两条真实路径：
   原来那条「getter 恒返回 undefined」在「完全不推送」时也会通过，区分不出「推了 undefined」
   与「压根没推」。
5. **订正 string-width 版本号**（`figures.ts` 注释 + `ui/CLAUDE.md` L2.3）：都写 `@7`，
   仓库实际装 8.3.0。宽度结论不变（实测 ⚡=2、↯/⇢/⚠=1），但「为什么换字形」的唯一依据
   带着一个错的版本号，后来人复现不出来。

## 放弃了什么（以及为什么不选）

- **0.x 时显示 `<1/s` 或 `Math.max(1, round)`**：前者引入新格式（宽度预算、测试、窄屏丢弃
  都要跟着改），后者高估（0.4 显示 1）。隐藏与「`0` = 无样本」的既有契约一致，改动面最小，
  也不会让一个本就没精度的数字看起来有精度。
- **把 `deriveTps` 的 `text` 字段删掉、只留 `value`**：`str` 还要用它做 `stringWidth` 宽度预算，
  且 `deriveCacheMetrics` 保留同构的 `text`。只改渲染侧，不动数据形状。
- **改强/删掉那条「getter 恒 undefined」用例**：它守的是「不落 0」，与「回退」是两件事。
  补一条新用例，旧的保持原意。
- **顺手修 core 的 tps 分子/分母口径不对称**：`total_tokens_received` 累加无
  `isTruncatedStream` 判据，而分母明确排除截断流（`collector.ts` 两处）。核实后确认是
  **既存**逻辑——#807 只是新增了一个出口去读它——且影响 `/perf`、digest、账本三处口径，
  属独立 PR 单元；且「被截断流是否真的带 usage 走到 AfterModel 累加」还没证实。
  不在本 PR 扩大范围，另开 issue 处理。

## 拿什么证明它生效了

**变异自证（2 组，改坏 → 确认红 → 恢复）**：

| 改坏点 | 变红的断言 |
| --- | --- |
| `deriveTps` 的 `rounded <= 0` 改成 `<= -1` | footer-tps 整帧 1 例 + status-line-data 纯函数 1 例 |
| cost-bridge 的 `outputTps: getOutputTps?.()` 改成「仅非 undefined 时覆盖」 | 「读数回落：先有值 41 → getter 再返回 undefined」1 例 |

恢复后用 `grep -n "rounded <= \|getOutputTps?.() !== undefined"` 确认无变异残留；
4 个相关测试文件复跑 **66 pass / 0 fail**。

**门禁输出**：

- `bun run affected-tests:run` → 3250 tests across 315 files：3241 pass / 9 skip / 0 fail（288.95s）
- `bun run lint` → `Found 0 warnings and 0 errors.`（3147 files）
- `bun run format:check` → `All matched files use the correct format.`
- `bun run typecheck:gate` → 当前 62 处 / 基线 62 处，无新增
- `bun run docs:gen-reference --check` → 参考页与源码一致（本次动了 `packages/cli/src/command/`，
  这条必须跑）
- `make build` → 编译成功 + 产物自检通过；`./sid-code --version` →
  `sid-code v0.1.615 (TypeScript) · dev 本地开发版`
- `bun run verify:agent-note` → 818 份 Agent Note 形态合规
