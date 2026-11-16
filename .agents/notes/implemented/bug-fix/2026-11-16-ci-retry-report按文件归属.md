---
Status: implemented
Date: 2026-11-16
Source: max-duration 预算用例时序余量不足：macOS 分片 flake 排查（2026-11-16）
---
# ci-retry-report 补「文件归属」：让「某测试文件是否复发」的判据可执行

## 决定了什么

`scripts/ci-retry-report.ts` 的 `RetryHit` 新增 `file?: string`，并把它一路带到输出：

- `parseRetryLines` 跟踪 bun 打的文件分组头行（`path/to/x.test.ts:`），把后续用例归到该文件；
- `formatReport` 增加「按文件」计数段与表格的文件列，认不出时显示 `(未知文件)` 而不是留空；
- `main()` 的 `::warning::` annotation 里，每条重试用例前面带文件名。

起因是复核缺陷文档的收尾判据时发现一个**文实不符**：文档 §6.4 写「按文件看复发，只有
`scripts/ci-retry-report.ts` 输出的 attempt 标记：出现 `max-duration-budget.test.ts` 的
`(attempt 2)` 即复发」，而当时的实现输出里**根本没有文件路径** —— `RetryHit` 只有
`name` / `outcome` / `attempt`，而 bun 的用例行只含 describe > test 名，文件名在另一行。
也就是说这条判据当时只能靠人肉认用例名（`T10b：墙钟总预算 > …`）去猜文件，
与文档自己批评 `ci-flake-stats.ts`「分不出测试文件」是同一个毛病，只是换了一层。

同一轮还补了两处注释（平凡，不改行为）：

- `packages/core/tests/query/max-duration-budget.test.ts` 的 `CALLS_WITH_BUDGET` 写明
  「恒为 2、不随 `toolTurns` 变」，并点出 `toolTurns: 0` 的预算用例不该复用 `drain()`；
- `scripts/pr-auto-update.ts` 跳过红 PR 那段补一句「代价已定案为接受」，把复核得出的
  结论（不开例外，出口是人工 update-branch / rerun）写回代码现场。

## 放弃了什么（以及为什么不选）

- **只改文档（把判据改成「记住这几条用例名」），不改脚本**：用例名会随重命名漂移，
  而且一条 attempt 记录到底属于哪个文件是人肉推断，不是可执行的判据。文档缺的是能力，
  不该用措辞补齐。
- **改造 `ci-flake-stats.ts` 去分文件**：它的数据源是 run / job 列表（GitHub API），
  本来就拿不到「单次 job 内哪条用例被重试」这一层，要分文件得整套换数据源；
  `ci-retry-report` 直接吃 bun 日志，是更自然的落点。
- **在 `max-duration-budget.test.ts` 里包一层 try/catch 改写失败文案**：`drain()` 的
  前提断言已经把「余量不够」与「产品行为坏了」分开了，再加一层只会让两条报错互相盖。
- **给 `file` 做必填**：日志可能缺文件头行（格式变化、日志被截断），必填会逼出一个假的
  空字符串。用可选 + `(未知文件)` 显式标注，既承认「不知道」，也不静默留白。

## 拿什么证明它生效了

```text
bun test ./tests/scripts/ci-retry-report.test.ts
→ 14 pass / 0 fail（原 10 条 + 新增 4 条「按文件归属」用例）

新增用例的样本不是手搓格式：逐字抄自本仓真实 bun 输出（bun 1.4.2），
含本仓真实用例名与真实文件分组头：
  packages/core/tests/query/max-duration-budget.test.ts:
  (pass) T10b：墙钟总预算（--max-duration-ms） > 到点检查发生在轮次自增之前：不白占一格预算 (attempt 2) [507.80ms]
断言报告里出现 `packages/core/tests/query/max-duration-budget.test.ts：1 条`
与含该路径的表格行 —— 即 §6.4 的判据本身。

变异自证（把 FILE_HEADER 改成永不匹配的 `/^NEVER_MATCH_ME$/`）：
→ 12 pass / 2 fail，红的是「文件头行把后续用例归到同一文件」与「报告里能直接看到
   文件路径与按文件计数」两条（证明新用例守的是新能力，不是恒绿）。已恢复。
```

**造数据不等于真实采样**：这些样本证明的是「判据算得对、看得见」，不证明真实 CI 上
没再复发。后者仍需 `(attempt 2)` 实际出现才能观测到 —— 但至少现在它一出现就会被
报告按文件点名，不需要人肉从用例名反推文件。
