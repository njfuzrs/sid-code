---
Status: implemented
Date: 2026-09-21
---
# Logger.flush：CI ubuntu 全量并行时 200ms 睡不够

## 决定了什么

`Logger` 增加 `flush()`：对文件 sink 调 `WriteStream.write("", cb)`，等先前缓冲交给内核。`logger-level-gate.test.ts` 读盘前改调它，不再 `setTimeout(200)`。

PR #71 的 ubuntu job 红在「审计模式下 AUDIT:* 豁免」：同一条测试里 `AUDIT:MODEL` 已落盘，`AUDIT:TOOL` / 裸 `AUDIT` 还在用户态缓冲，断言读到残文件。macOS job 绿。生产路径不读盘，不受影响。

## 放弃了什么（以及为什么不选）

**① 放弃把 timeout 加到 500ms/1s。** 全量并行时睡多久都是猜；慢 runner 再踩线，快 runner 白等。`write` 的 callback 才是「这块已经交给内核」。

**② 放弃只重跑 CI。** 这是仪器竞态，不是偶发网络。重跑绿了下次还会红。

**③ 放弃 `stream.end()` 当 flush。** 关流会让后续 `reconfigure` / 同实例再写踩 destroyed；测试之间共用全局单例。

## 拿什么证明它生效了

```
bun test ./packages/core/tests/debug/logger-level-gate.test.ts
```

CI 判据：ubuntu `test` job 这条不再红。⛔ 本地绿不能代替——本机 5 次全绿时 CI 仍红，因为全量 826 文件并行才把 200ms 睡穿。
