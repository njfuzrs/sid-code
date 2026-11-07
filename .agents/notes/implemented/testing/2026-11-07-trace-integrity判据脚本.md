---
Status: implemented
Date: 2026-11-07
---
# 新增 trace-integrity 判据脚本：把「树坏了没人知道」变成一条命令

## 决定了什么

新增 `scripts/trace-integrity.ts`（`bun run trace:integrity`），读 `traces.jsonl` 及全部
轮转文件，输出两条判据并按 trace 列出违例：

1. **每个 trace 恰好一个根**：根 = 无 `parentSpanId` + `kind=invoke_agent` +
   name 以 `invoke_agent` 开头（`invoke_agent sid-code` 与 `invoke_agent <模型名>`
   两种历史写法都认，避免按名单一写法漏掉 10-03 前的根）。
2. **没有找不到的父**：`parentSpanId` 在合并后的 spanId 集合里找不到。

无根且已收尾的 trace 按会话 `metadata.json` 的 `end_source` 归类，这是剖析附 B
核心表的复现入口。

**判定规则里三条是刻意的，不是实现细节：**

- **进行中不算违例。** 根与父 span 都只在 `end()` 时入队（`telemetry/bus.ts` 的
  「入队 ≠ 落盘」），正在跑的会话必然缺它们。收尾判定只认 `end_time` / `end_source`
  （与 `trace/builder.ts:1011-1013` 的 S12 同口径），找不到会话目录时按「最后 span
  距今 < 60s」兜底。
- **无根 trace 的悬空父不重复计违例。** 根丢了子 span 的父必然找不到，这是同一个缺陷；
  判据二只报「有根 trace 的悬空父」，无根那部分单列 `fromZeroRootTraces` 说明同源。
- **必须合并轮转文件再判父。** 父在 `traces.1.jsonl`、子在 `traces.jsonl` 是正常形态，
  只看当前文件会把正常父子判成悬空；输出里声明「只在现存轮转文件内查找」，不假装能判全。

默认 `exit 0`（取数工具不阻断），`--strict` 留给将来接 CI。未知参数直接报错，
不静默忽略（`trace-digest` 的 `--health` 漏接教训）。

## 放弃了什么（以及为什么不选）

- **不把它做成运行时检测器**（文档 T4 明确不做）：「找不到的父」要等整个会话写完才判得了，
  在运行中判会把「父还没 end」全报成悬空。检测器侧的读者归 X1H3 方案。
- **不按「根名」筛根**：老数据里 `invoke_agent glm-5.2` 这类根名与 `invoke_agent sid-code`
  并存，按名精确匹配会漏；改用 kind + 无父，name 只做展示与两种写法的兼容校验。
- **不把无根与悬空父合并成一条判据**：它们是同一缺陷的两个可观测面，但 T1（信号退出丢根）
  与 T2（工具 span 事后补建）的验收需要分别出数，所以保留两条判据、只在计数上归因去重。
- **不补历史数据**（给 283 个无根会话补根）：补出来的根没有会话级统计属性，
  只会让历史数据看起来完整；脚本按时间切新旧即可。
- **不做 OTLP 出口验证**：需要本机起 collector 占 4318，属于单独授权项，不影响本脚本。
- **不加 `--fix` 之类的修复动作**：判据脚本只读，修复归 T1/T2/T3 的代码改动。

## 拿什么证明它生效了

- `bun test ./tests/scripts/trace-integrity.test.ts`：**18 pass / 0 fail**（47 expect）。
  覆盖：单根正常、无根已收尾（带 end_source）、无根进行中不算违例、无根无会话按 60s 兜底、
  多根、父在另一个轮转文件、有根悬空父独立违例、无根悬空父不重复计、进行中悬空父排除、
  坏行计数、轮转排序、`--days` 过滤、未知参数报错、报告渲染。
- 真实数据（`~/.sid-code/telemetry`，1327 trace / 116k span，08-08 → 11-07）：
  - 判据一：恰好 1 根 955；0 根已收尾 367（**最新一条是 2026-11-03 16:48，T1 PR #549
    17:00 合并之后为 0**）；进行中 5；多根 0。
  - 判据二：有根 trace 的悬空父 **0**；无根 trace 的悬空父 46,851（同源，不重复计）；
    进行中排除 913。
  - 把 `--days 14` 后违例明细最新一条仍是 11-03 16:48，说明 11-04 起没有新增丢根。
- `bun run affected-tests:run` 与 `make build`（见 PR 正文）。
