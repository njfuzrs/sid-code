---
Status: implemented
Date: 2026-10-20
---
# essential-traffic 期间会话在切回 default 后被启动补传

## 决定了什么

启动补传（`backfill.ts`）原先只认「缺 `.uploaded` 标记」，从不问会话产生那一刻的隐私级别。
用户在 `essential-traffic`（`SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`）期间产生的会话没有
`.uploaded` 标记，切回 `default` 后第一次启动就会被整批补传——隐私门控只拦「当下上传」
（`init-helpers.ts` 不构造 UploadManager），没拦「补传扫描器」发现的目标集合。

修复分两半：

1. **采集侧落盘**（`collector.ts`）：SessionStart 时把当时的隐私级别写进 `events.jsonl`
   的 SessionStart 事件（`privacy_level` 字段，仅本地归因），并对 `essential-traffic`
   会话在目录里落 `.privacy-restricted` 标记文件。隐私级别是进程环境、会话结束后无从
   回溯，**必须在产生时落盘**，事后推断不出来。
2. **补传侧过滤**（`backfill.ts`）：`scanPendingUploads` 新增一格统计 `privacyRestricted`
   （对齐既有 `beforeWatermark` 的样式），命中 `.privacy-restricted` 标记即跳过、绝不进
   pending。`uploader.ts` 的 `backfillPendingSessions` 把 `includeHistory` 透传到
   `runBackfill` → `scanPendingUploads`：用户显式 `--upload-traces --include-history` 时
   豁免该过滤，并在执行前打印 restricted 会话数（`cli.ts`，对齐「执行前说清楚放出去
   什么」的现有约定）。`getUploadBacklog` 的分类合计同步把新格算进 `unaccounted` 自检。
3. **上传剥离**（`uploader.ts`）：`privacy_level` 加进 `LOCAL_ONLY_EVENT_DATA_FIELDS`——
   它只供本地归因，服务端对 SessionStart 未知字段的校验口径不明，上传时剥掉不冒暴露面。

这是补传水位（P0-3，`upload-watermark.ts`）在「隐私轴」上的补全：水位锚点是「上传目标
首次配置的时刻」，本缺陷锚点是「会话产生那一刻的隐私级别」，两者时间轴不同，水位修不了。

## 放弃了什么（以及为什么不选）

- **方案 B：期间会话照常登记 `.uploaded`** —— 否决。`.uploaded` 语义是「数据已在平台」
  （`markUploadedKeepLocal` 供 wrapper/评测识别「已同步到云端」），给没传的会话写它会让
  平台/评测侧把没传的当传了。
- **方案 C：只改官网文档承诺** —— 否决。承诺本身是对的（stricter 级别期间的数据不应事后
  放量外发），降级等于承认隐私级别对轨迹只防「进行时」不防「追溯」。
- **`privacy_level` 直接上传** —— 否决。它只供本地归因，服务端字段校验口径不明，
  归并进 `LOCAL_ONLY` 剥离清单（与 `error_head`/`input_summary` 同一先例），上传时剥掉。

## 拿什么证明它生效了

- 变异自证 1：改坏 `backfill.ts` 过滤条件（去掉 `!includeHistory`），
  `--include-history 显式豁免` 测试转红；恢复后转绿。
- 变异自证 2：`git stash` 撤掉 `collector.ts` 的写盘改动后，两个新 collector 测试
  （default 不写 marker / essential-traffic 写 marker）双双转红；`git stash pop` 后转绿。
- `bun test packages/core/tests/trace/backfill.test.ts` 34 pass / 0 fail；
  `bun test packages/core/tests/trace/collector.test.ts` 106 pass / 0 fail。
- `bun run affected-tests:run`（cli 包 + core/tests/trace）3516 pass / 0 fail；
  `make build` 构建 + 产物自检通过。
- `bun run lint` / `format:check` / `lint:boundary` / `lint:command-system` 全过；
  `docs:gen-reference` 无产物变更（我改的 cli.ts 那段不影响参考页）。
- `typecheck:gate` 红的 `packages/tui/src/ink.tsx signal-exit` 在**父仓 main** 上同样红，
  且报错文件不 import 本次改动的模块——存量问题，与本次无关。

## 遗留（向前修复的固有边界）

修复**向前生效**：本版本之前产生的「期间会话」没有 `.privacy-restricted` 标记，无法区分，
切回 default 后仍会被补传——这是既成事实，版本说明里需提一句。
