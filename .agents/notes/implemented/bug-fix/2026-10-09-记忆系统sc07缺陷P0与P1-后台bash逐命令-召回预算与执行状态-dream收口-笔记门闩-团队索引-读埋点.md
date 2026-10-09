---
Status: implemented
Date: 2026-10-09
---
# 记忆系统 sc-07 核出的 P0 + P1：后台 bash 逐命令、召回预算与执行状态、dream 收口、笔记门闩、团队索引、读埋点

来源是缺陷文档 `20260926-记忆系统-顺着sc-07-memory核出的缺陷.md`，本次修其中的 P0（缺陷 1）和全部 P1（缺陷 2/3/4/5/9/10）。P2（6/7/8/11/12/13/14）不在本次范围。

## 决定了什么

- **缺陷 1（P0）**：`memory/extract/permissions.ts` 的 `isReadonlyBash` 不再只看首词，改为以下口径：
  - 整串含 `$(` / 反引号 / `<(` / `>(` 直接拒绝。parser 不展开它们，AST 看不见里面的命令。
  - 任何 `>` 都拒绝。
  - 用 `parseBashCommand` 拆出的**每个**简单命令都必须在 9 词白名单内。
  - `find` 额外拒绝 `-exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls`。
  - 提取、dream、会话笔记三个代理共用这套判定。
- **缺陷 2**：`recentTools` 改为 `{name, failed}[]`，由 `app.ts` 的 `collectRecentToolUses` 从消息里配对 `tool_use` 和 `tool_result.is_error` 得到。选择器提示词新增两条规则：成功在用的工具不推它的用法参考，但仍推坑；失败的工具优先推。
- **缺陷 4**：召回补上三层预算：
  - 单文件不超过 `RECALL_FILE_MAX_BYTES=4096` 真字节，按行截断，并在末尾指回原文件。
  - 单轮最多 5 条（原有）。
  - 两次压缩之间累计不超过 `RECALL_SESSION_MAX_BYTES=60000`，用完连 sideQuery 都不发。
  - 已注入集合和累计字节由 `resetRecallState()` 归零。接在两处 `/clear`、`/compact` 命令、autoCompact、reactive/collapse 五个入口上。
- **缺陷 3**：`loadDir` 归档空文件后，记下该目录，`load` 末尾据此 `writeIndex`。dream 的 `finally` 调 `reconcileMemoryDir`，即对 memoryDir 跑一次 `MemoryStore.load()`，让「写空即删除」在本次 dream 内生效。
- **缺陷 5**：`shouldExtractSessionMemory` 判到当前 token 小于基线时，把基线落到当前值。在判定处收口，而不是在五条压缩路径上逐一重置。
- **缺陷 9**：团队索引改成和私有侧同口径：
  - 新增 `listTeamMemoryFiles`（递归，排除点文件和冲突副本），同步侧 `readEntries` 共用它，保证「进索引」和「参与同步」是同一批文件。
  - `buildTruncatedIndex` 新增 `header` 参数，团队表头的字节也计入预算。
  - 条目按 mtime 降序排列。
  - `getTeamIndexContent` 注入时按文件 mtime 补 `⏳` 年龄标注。
- **缺陷 10**：新增 `memory_read` 事件（分子）和 `classifyMemoryReadPath`（project/global/agent/team，以及是否索引本身）。Read 工具在成功路径上发这个事件。

## 放弃了什么（以及为什么不选）

- **缺陷 1 直接复用主路径 `isReadOnlyCommand`**：它放行 `find -exec` 和进程替换，表也更宽（npm/bun/git 子命令）。无人监督的后台代理需要更严的判定，不能和主路径一样松。主路径自己的 `-exec` 缺口不属于本次记忆主题，没有动。
- **缺陷 3 在 write 工具的 `afterMemoryFileWrite` 里就地归档**：那是所有记忆写入的热路径。而且 edit 中途写出空 body 时也会被立刻搬走，把「写坏了」变成不可见。收口放在 dream 结束这一个点上更窄。
- **缺陷 4 截断按 4KB 字符计**：沿用 `index-budget` 的教训，一律量真 UTF-8 字节。
- **缺陷 5 在各压缩入口重置基线**：有五个入口，漏一个就是同一个 bug。「token 变少」这个信号在五个入口上都有。

## 拿什么证明它生效了

- `packages/core/tests/memory/sc07-memory-p0-p1.test.ts` 共 31 条，覆盖以下内容：
  - 缺陷 1：管道、`;`、`-exec`、`-delete`、`<()`、`$()`、反引号全部 deny，正常管道 allow。
  - 缺陷 3：写空后 reconcile，文件进 `archive/`，清单和索引里都不再有它。
  - 缺陷 5：压缩后 token 增长到阈值时恢复触发。
  - 缺陷 9：子目录文件进索引，210 条截到 200 条，有告警，不超 25KB，带年龄标注。
  - 缺陷 10：四条线的路径分类，以及 read.ts 的接线。
  - 缺陷 4：app.ts 有 5 处 `resetRecallState()` 调用。
- `bun run affected-tests:run` 结果 3297 pass / 0 fail，`make build` 自检通过，lint 和 lint:boundary 均干净。
- 尚未验证：真实会话里 `SID_CODE_MEMORY_RECALL=1` 和 `autoDream` 的端到端触发。两者默认都关。按北极星的判据，「真实会话里被触发过」这一项仍待补，`memory_read` 的曲线要等下一次 release 的轨迹才能看到。
