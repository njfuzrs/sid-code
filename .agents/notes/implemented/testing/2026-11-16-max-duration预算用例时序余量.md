---
Status: implemented
Date: 2026-11-16
Source: max-duration 预算用例时序余量不足：macOS 分片 flake 排查（2026-11-16）
---
# max-duration 预算用例改为「等到越过 deadline」并把时序前提写成断言

## 决定了什么

`packages/core/tests/query/max-duration-budget.test.ts` 三条带 `--max-duration-ms` 的用例
（`:147` / `:162` / `:174`）原本靠「预算余量 15ms + 每轮 `sleep(25ms)`」构造
「第 1 轮跑完、第 2 轮开始前到点」。这个配比只保证不等式 ②（`O + S > M`），
漏了不等式 ①（`O < M`）——`O` 是从 `budgetExpiringIn()` 求值到第 1 轮前那个 deadline
检查点之间的开销，主要由**进程内首次跑 `queryLoop` 的冷启动**决定（本机实测约 28ms，
大于 15ms）。结果：`-t` 单跑 `:162` 必红（`turns` 收到 0），`:174` 以「总结轮不存在」
的误导形态变红，`:147` 静默走过「第 1 轮前就到点」；2026-11-16 macOS 分片上就是
`:162` 收到 `turns = 0`。

三处改动：

1. **余量 `M` 取 500ms**（`BUDGET_MARGIN_MS`），约 16 倍于本机实测的最大 `O`。
2. **不再固定 sleep**：`slowEachTurn` 改成「等到 `Date.now()` 越过 deadline + 2ms 再返回」。
   不等式 ② 由构造保证（`S` 不再是常数），只剩 `O < M` 需要余量，不用再在 `M` / `S`
   之间配比。
3. **前提断言**：`setup()` 返回的 `drain()` 在设了预算时断言模型恰好被调 2 次
   （第 1 轮 + 强制总结轮），失败信息直接写「冷启动开销 O 吃掉了余量 M=xxx ms，调大余量，
   不要改断言」。三条用例共用同一装配，前提不成立时一次性指向根因，不会再出现
   「turns 收到 0」「总结轮不存在」这类把人引去产品侧的报错。

`Budget` 对象同时带 `maxDurationMs`（从进程启动算的绝对值）、`deadlineWall`（等待用）
与 `marginMs`（报错文本用）。三者必须分开：测试进程已启动几百毫秒，
`maxDurationMs` 远大于余量，拿它当 `M` 报错会让人算错数（原型阶段就踩过，
第一版变异自证打出「余量 M=81ms」）。

## 放弃了什么（以及为什么不选）

- **假时钟（fake timers）**：文件头已写明「不用假时钟，避免『测的是 mock 不是时钟』」。
  这条预算的产品语义就是墙上过了多久，用假时钟等于把被测对象替换掉。否决。
- **先在 CI 上定标 `O` 的 p999，再按 `M = max(O_p999 × 3, 200)` 取值**：要临时改 CI
  跑几轮才拿到样本，20 个样本给不出 p999；而且 `O` 由冷启动主导、跟用例在分片里的位置
  有关，定出来的数换个分片顺序就不准。前提断言让「余量够不够」每次 CI 都被检查，
  比一次性定标可靠。
- **靠 `--retry=1` 兜底当修复**：它治「红」不治「测错」，更治不了 `:147` 静默走错路径
  和本地单跑必红；且 `ci.yml` 自己已点破 retry 会掩盖真回归。保留为兜底，不作为修复依据。
- **删掉 `turns` 断言**：它是 `turnCount` 不自增的唯一守卫（文件头分工表明列）。否决。
- **改产品代码让检查点容忍抖动**：那会把明确的墙钟预算改成模糊预算，与
  `loop.ts`「检查点必须在本轮任何工作之前」的设计冲突。测试缺陷不该由产品代码让步。

## 拿什么证明它生效了

2026-11-16 在 worktree `fix-max-duration-timing`（base `72e8cb5c`）实跑：

```text
bun test ./packages/core/tests/query/max-duration-budget.test.ts --rerun-each=20
→ 120 pass / 0 fail / 30.50s（改前 `-t` 单跑 :162 / :174 必红）

bun test ... -t <三条用例各跑 3 次>
→ 9 次全部 1 pass / 0 fail（覆盖「冷启动开销已被余量吸收」）

变异自证一（BUDGET_MARGIN_MS 改回 15）：
→ 1 fail，报错「前提不成立：模型被调了 1 次，期望 2 次（第 1 轮 + 强制总结轮）。
   第 1 轮开始前就命中了 deadline 检查点 —— 冷启动开销 O 吃掉了余量 M=15ms」
   证明前提断言在起作用，且报错指向根因而不是 turns / 总结轮。

变异自证二（把 loop.ts 的 deadline 检查点挪到 `state.turnCount++` 之后）：
→ `不白占` 用例 0 pass / 1 fail，Expected: 1 / Received: 2
   证明 turns 断言仍在守产品行为，不是恒绿。
   两处变异改动均已恢复（git diff 只剩测试文件 + 本 Note）。

回归门禁：
bun run affected-tests:run → 1290 pass / 0 fail（121 files）
bun test ./packages/core/tests/query/ → 1290 pass / 0 fail
make build → exit 0，产物自检通过，无「will always be undefined」警告
bun run lint / format:check / typecheck:gate / lint:boundary / lint:command-system / lint:legacy-tool
→ 全部 exit 0（typecheck 62 错误 / 基线 62，无新增）
```

代价与观测入口：三条用例各真等约 500ms，文件从约 0.2s 变成约 1.5s。
这是用「更慢」换「更准」——等待时间就是余量本身，压不掉。
`scripts/ci-retry-report.ts` 在本文件上不再出现 `(attempt 2)` 即视为 CI 侧不再复发；
前提断言本身也是入口：它红了就说明余量不够，不需要再排查别的。
