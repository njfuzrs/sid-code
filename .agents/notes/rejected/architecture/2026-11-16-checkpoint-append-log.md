---
Status: rejected
Date: 2026-11-16
Source: sid-code 对比 claude-code 同机监控：性能问题与可优化点·结论与交接（2026-11-10）
---
# checkpoint 索引不用 append log（`snapshots.jsonl` 追加行）

## 决定了什么

否决「P3 方向 3」里列出的另一个候选：把快照写成 `snapshots.jsonl`，每次快照 append 一行，
索引内存态从日志重建。

## 放弃了什么（以及为什么不选）

append log 的写放大确实最小（一次快照 = 一次 O(1) 追加），但它的代价落在**删除语义**上：

- checkpoint 有三条真实的删除路径：`undo`（移除最后一个快照）、`restoreToSnapshot` /
  `restoreBeforeSnapshot`（截断尾部）、`evictPerFile` / `evictBySize`（从任意位置淘汰）。
  追加日志删不掉历史行，只能写 tombstone 行或重写整个文件做压实。
- 压实本身就是「重写全部」——正是 P3 要消掉的写放大，只是从每次发生退化成偶尔发生。
  而且它多出一层「日志 + 压实」的状态机，正确性风险远高于「文件系统 unlink」。
- 分片方案（本 PR 采用）不需要自己实现删除：每个快照就是一个文件，删除语义 = `unlinkSync`，
  截断 = 删若干个文件，淘汰 = 删对应文件。文件系统已经把这件事做对了。

另一个连带问题：append log 必须能容忍「最后一行写了一半」（进程被杀），
于是读侧要处理截断行；分片方案的等价情形是「某个分片 JSON 解析失败」，
而它可以只在局部跳过那一个分片（已实现并测试），不影响其余历史。

## 拿什么证明它生效了

不是靠论证，是靠分片方案的三条变异自证把「删除路径必须真的删掉落盘数据」钉住了
（`packages/core/tests/checkpoint/p3-index-sharding.test.ts`）：

1. 去掉 `unlinkSync(shardPath)` ⇒ `undo` / `restoreToSnapshot` / per-file 淘汰三条
   「重启不复活」用例变红。
2. `saveIndex` 改成重写全部分片 ⇒「写放大门禁」变红（历史分片 mtime 变了）。
3. 去掉超限判断 ⇒「大文件不进快照」「全部超限不建空快照」变红。

基准数据见 `implemented/bug-fix/2026-11-16-checkpoint-index-sharding.md`：
单次快照 39.52ms → 0.35ms，落盘 41.6MB/次 → 数百字节/次。
