---
Status: implemented
Date: 2026-11-16
Source: sid-code 对比 claude-code 同机监控：性能问题与可优化点·结论与交接（2026-11-10）
---
# checkpoint 索引改成分片落盘：一次快照只写自己那一片，不再整份重写

## 决定了什么

修掉 P3 的两处根因（`packages/core/src/checkpoint/manager.ts`）：

1. **单文件上限**：新增 `checkpoint.maxFileSizeMb`（默认 5MB，`0` = 关闭）。
   超过上限的文件**不进快照**，登记到 `Snapshot.skippedFiles`，并在日志里点明
   「这些文件无法 /undo 回退」。`/restore` 的确认信息会把它们列出来
   （`packages/cli/src/command/commands/restore/restore.ts`）。
   这一层挡的是「一次 `ls -la` 把 79MB 编译产物收进索引」——有了它，42MB 索引不会再生。
2. **索引分片**：`index.json` 只存头（`version: 2` / sessionId / createdAt / nextId），
   每个快照单独落在 `snapshots/<id>.json`。一次快照写 1 个新分片 + 80 字节的头，
   历史分片不动 ⇒ 写放大从 O(N²) 降到 O(N)。
3. **增量大小统计**：`serializedSize()` 从 `JSON.stringify(整个索引)` 改成
   `totalSnapshotBytes + headBytes`（写盘时算一次、缓存）。`markSnapshotDirty` 只
   stringify **那一个快照**，结果存在 `pendingJson` 里，落盘直接复用。
4. **迁移**：init 检测到旧格式（内联 `snapshots` 或更旧的 `files` 结构）时，
   自动改写成 v2 分片；`nextId` 自愈为 `max(头里的, 最大分片序号 + 1)`，
   防「写完分片、还没写头」时中断导致 id 复用覆盖旧分片。

`Snapshot.files` 的内存形态没变（仍是全量内容在内存里），所以 undo / restore /
evict 的读路径零改动，`getSnapshotDetail` 保持同步。

## 放弃了什么（以及为什么不选）

- **按类型跳过所有二进制**（方案文档给的另一条候选）：N13 刚把 PNG 的字节级往返
  修对（`p1-binary-snapshot.test.ts` 锁着），按类型跳过会把它整体推翻。
  大二进制本质是「大小」问题，一条阈值能同时覆盖大文本与大二进制，
  不需要按类型分叉。否决理由写进 `rejected/architecture/2026-11-16-checkpoint-skip-all-binary.md`。
- **append log（`snapshots.jsonl` 追加行）**：写放大最小，但删除 / 截断 / 淘汰要靠
  日志压实，正确性风险高；而文件系统天然提供 unlink，分片方案不需要自己实现压实。
  见 `rejected/architecture/2026-11-16-checkpoint-append-log.md`。
- **内容按哈希存索引外 blob（内容寻址 + 引用计数）**：去重收益只在「同一大文件反复
  进快照」时才成立，而那正是 `maxFileSizeMb` 已经挡掉的场景；多出来的引用计数与
  垃圾回收是纯新增复杂度。
- **只在 `evictBySize` 里缓存 size、仍写单文件索引**：省掉一次 stringify，但写盘仍是
  整份 42MB —— 验收里「单次快照个位数 ms」要求的是不写整份，缓存解决不了。

## 拿什么证明它生效了

**基准**（`/tmp/bench-p3.ts`，同一份 39.7MB / 24 快照的旧索引，每次快照只改一个 10 字节
小文件；`maxTotalSizeMb=9999` 避免淘汰干扰）：

| | 旧（main） | 新（本 PR） |
| --- | --- | --- |
| `serializedSize()` | 7.75 ms | **0.01 ms** |
| 单次快照耗时（5 次中位 / min–max） | **39.52 ms**（28.42–54.91） | **0.35 ms**（0.24–3.07） |
| `index.json` | 41,611,484 字节（整份） | **80 字节**（头） |
| 每次快照落盘 | 整份 41.6MB | 新增分片（数百字节）+ 头 |
| 历史分片是否被重写 | —（整份重写） | **否**（mtime 逐次比对未变） |
| 迁移的一次性成本 | — | init 46 ms（39.7MB → 24 个分片） |

**测试**：新增 `packages/core/tests/checkpoint/p3-index-sharding.test.ts` 13 条，
既有 checkpoint 套件 98 条，共 111 条全绿。三条变异自证（改坏 → 对应断言变红 → 恢复，
恢复后 md5 与备份一致）：

1. `saveIndex` 改成重写全部分片 ⇒「写放大门禁」红（历史分片 mtime 变了）。
2. 去掉超限判断 ⇒「大文件不进快照」「全部超限不建空快照」两条红。
3. 去掉 `unlinkSync(shardPath)` ⇒ undo / restore / 淘汰三条「重启不复活」红。

**门禁**：`affected-tests:run` 4415 pass / `make build` ✓ / `smoke` 37 例全过 /
`lint` + `format:check` + `lint:boundary` + `lint:command-system` + `lint:legacy-tool` ✓ /
`typecheck:gate` 62 处基线、无新增 / `docs:gen-reference` 已重新生成 `website/ref/settings.md`。

**验收对照（方案文档 §五 第 2 项）**：

- 「重放 s2 命令不再收进二进制」：该判据在 P4 修复后已失效（文档自己注明）。
  本次改为更直接的机器判据 —— 超限文件**不进 `files`、进 `skippedFiles`**，且分片
  内容里搜不到大文件字节（测试里断言 `readShard("s1")` 不含 `BBBB`）。
- 「42MB 索引的单次快照耗时降到个位数 ms」：**0.35ms**（旧 39.52ms）。
- 「进程写盘对照」：41.6MB/次 → 数百字节/次；历史分片 mtime 不变是写放大消失的机器判据。
