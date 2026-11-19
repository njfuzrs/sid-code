---
Status: implemented
Date: 2026-11-19
Source: 缓存断裂归因失效与命中口径-缺陷复核与修复方案（2026-11-19）
---
# 轨迹兜底命中率在无 flow 累计时留 undefined，不再给漏了未命中的近似值

## 决定了什么

`packages/core/src/trace/collector.ts` 的 SessionEnd 派生指标里，`total_cumulative_prompt_tokens`
为 0（无 flow 累计）但有 `cacheRead + cacheCreate > 0` 时，`session_cache_hit_rate` 从
`cacheRead / (cacheRead + cacheCreate)` 改为 **`undefined`**，分支结构保留并写明这是刻意的决定。

命中率的分母必须是「命中 + 写入 + 全价输入」的总输入基数（与主路径及 usage-aggregator 的跨会话口径
一致）。原兜底公式的分母只有「命中 + 写入」，**系统性高估**：cacheRead=400 / cacheCreate=100 /
全价=500 的会话，旧式 400/500 = 80%，真实 400/1000 = 40%。

## 放弃了什么（以及为什么不选）

- **否决「退到 `total_tokens_sent` 当分母」**：它是 stock 字段（末轮快照），不是 flow 累计，
  两者相减得不到历史未命中量，只是把错误从「漏一项」换成「拿错口径」。
- **否决「保留旧公式但加注释说明会高估」**：该值会进轨迹、进聚合、进发布曲线，
  方向恒定偏乐观——给一个偏差的近似值比不给更糟，与 `output_tokens_per_sec` / TTFT
  的「宁缺毋滥」同一原则。
- **否决「删掉整个 else-if」**：分支本身是「有缓存数据但无 flow 累计」这个已识别形态的落点，
  显式置 undefined 是刻意的决定，删掉会让下一个人以为这里是遗漏。

## 拿什么证明它生效了

- 新增用例：`cacheRead>0 / cacheCreate>0 / total_cumulative_prompt_tokens=0` 的 metadata →
  断言 `session_cache_hit_rate === undefined`。
- 变异自证：把公式恢复成 `cacheRead/(cacheRead+cacheCreate)` → 该断言红（Received: 0.8）；
  恢复后 117 pass / 0 fail。
- 既有断言未空转：把主路径 `Math.min(1, cacheRead/cacheableBase)` 改成定值 0.1 →
  既有 `toBeCloseTo(0.6)` 断言红（Received: 0.1），恢复后绿。
- 读侧确认：全仓 grep `session_cache_hit_rate` 共 8 处命中 —— 写入侧 2 处（本次改动）、
  类型声明 2 处（`?: number` 天然可空）、唯一真实消费方 `builder.ts:1225` 用
  `...(x !== undefined ? {k:x} : {})` 选择性展开（undefined 直接不落键，不产 null/NaN/0）、
  测试 1 处、CHANGELOG 1 处。**没有任何读侧读轨迹里的这个字段**：
  `cache-telemetry.ts` 落的是缓存中断记录（本就不含命中率）、`usage-ledger-entry.ts`
  的命中量取自 `SessionState.getNormalizedCacheUsage()`。结论：undefined 安全。

## 没做的

- `2026-07-16` 之前轨迹的读侧排查：`grep -rn "2026-07-16"` 全仓零命中，且无任何读侧读该字段，
  故不存在受影响的历史读侧。定级（是否需回填）留给维护者。
