---
Status: rejected
Date: 2026-11-16
Source: sid-code 对比 claude-code 同机监控：性能问题与可优化点·结论与交接（2026-11-10）
---
# checkpoint 不按「是否二进制」一刀切跳过

## 决定了什么

否决方案文档 P3 方向 2 的一条候选表述：「bash 快照……或**跳过二进制**」。
最终采用的是**按大小**判定（`checkpoint.maxFileSizeMb`，默认 5MB），不区分文本与二进制。

## 放弃了什么（以及为什么不选）

- **N13 刚修好的正确性会整体回退**：`p1-binary-snapshot.test.ts` 锁的是「PNG 字节级往返」——
  修之前 lossy 的 `text()` 读取把 13 字节 PNG 头回滚成 23 字节 U+FFFD 垃圾。
  跳过所有二进制等于把那 6 条用例的语义推翻，而这次改动是性能修复，不该顺带削减正确性。
- **判据不可解释**：用户看到「这个 200KB 的图标没有回退记录」，理由却是「它是二进制」，
  而同样大小的 `.min.js` 却能回退——在 `maxFileSizeMb` 同一阈值下线，理由是「超过 5MB」，
  用户能自己核对（`ls -l`），也能自己调配置。
- **真正撑爆索引的是大小，不是类型**：P3 的证据里 41.64MB 来自单个 79MB 编译产物。
  一个 200MB 的纯文本日志同样会撑爆索引；一个 10KB 的 PNG 完全无害。

## 拿什么证明它生效了

- `p1-binary-snapshot.test.ts` 6 条 N13 用例在改动后仍全绿（小二进制照常做字节级快照）。
- 新增负向对照用例：`maxFileSizeMb=0` 关闭上限时 2KB 二进制照常进 `files`、
  `skippedFiles` 为 `undefined`（证明「跳过」只由大小触发，不是隐式按类型）。
- 跨阈值用例：上限 0.001MB 时 2KB 二进制不进 `files`、登记 `skippedFiles`，
  且分片内容里搜不到其字节（`readShard("s1")` 不含 `BBBB`）。

详见 `implemented/bug-fix/2026-11-16-checkpoint-index-sharding.md` 的基准与门禁数据。
