---
Status: implemented
Date: 2026-09-17
---
# 轨迹上传静默失效：真根因不是「上传超时」，而是 SessionEnd 在主流路径上从未跑到

## 决定了什么

**把「上传」从退出关键路径上摘下来，改由启动补传兜底；同时修掉三个让它彻底不可能成功的独立缺陷。**

改动分五处：

1. **补上 SIGHUP**（`app.ts`）。修复前全仓检索 0 命中 —— 关终端 / SSH 断连时进程被默认处置直接终止，
   SessionEnd 一次都不触发。退出码按 128+signum 惯例给 129，不与 SIGTERM 的 143 混用。
2. **退出路径声明上传预算**（`collector.ts` 的 `setUploadBudgetMs` + 四条退出路径各调一次）。
   原实现硬等 10s，而信号路径 1.2s 后就 `process.exit()` —— fetch 必然被杀在半路。
   现在信号 / `/quit` / 正常退出一律传 0（不发请求，交给补传），**headless / 评测路径保持 10s 不变**
   （那是修复前唯一一直上传成功的路径，不能被这次修复弄坏）。
3. **新增启动补传**（`backfill.ts` + collector 在 SessionStart 触发）。判据只看磁盘现状：
   目录在、`session.traj` 非空、`.uploaded` 缺 → 补传。刻意不依赖重试队列（理由见下）。
4. **队列停止静默丢数据**（`uploader.ts`）。`processRetryQueue()` 从 `void` 改为返回九类计数，
   `--upload-traces` 打印实际统计。
5. **两个死配置复活**：`queueScanIntervalMs` → 新增 `startQueueScan()`；
   `maxQueueRetries` 替换硬编码 `attempts >= 50`。

## 原始 bug 报告说错了什么（这部分比修复本身重要）

报告的结论是「上传要 10s，SessionEnd 只有 1.2s 预算，所以 fetch 被杀在半路」。
**方向对，机制错**，而且错得会把修复引向"放宽超时"这条歧路。实测（52 个本机会话）：

| 判据 | 数字 | 说明 |
|---|---|---|
| `events.jsonl` 里有 `SessionEnd` 事件 | **13 / 52** | 其余 39 个 SessionEnd **一次都没触发** |
| 那 13 个的 `reason` | 全是 `error` | 只有崩溃兜底路径进过 SessionEnd |
| 有 `messages.json`（handleSessionEnd 在上传**之前**写） | **0 / 52** | 连上传前的落盘都没走到 |
| 残留 `heartbeat.txt`（SessionEnd 末尾会删） | **52 / 52** | 独立佐证：收尾从未完成 |

也就是说上传不是"来不及"，而是**根本没被执行到**。两个实测数字进一步否掉了"预算不足"这个解释：
traj stringify+落盘最大 **7.5ms**（6MB traj）、`buildDigest` 最大 **18ms** —— 落盘全程约 30ms，
1.2s 预算对它绰绰有余。真正缺的是**触发**（SIGHUP 无人处理）而不是**时间**。

⚠️ 最值得记住的一条：**告警系统当时已经看见了症状，却把它标成了背景噪音。**
warn.log 里写着「发现 51 个未正常收尾的历史会话（进程已退出但残留 heartbeat，非 hang）」。
「非 hang」是对的，但它同时也是「51 个会话的轨迹没上传」。一句正确的现象描述，
省掉了后果，就等于把唯一的线索作废。所以本次新增的积压告警刻意说的是**后果**
（「N 个会话的轨迹仍未上云」）而不是现象。

## 修复过程中暴露出的三个新缺陷（都不在原报告里）

修好一处让下一处显形，这三个都是靠**跑真实二进制 + 隔离假服务端**抓到的，静态读代码看不出来：

**① `--upload-traces` 从来没有真正上传过任何东西（P0，比原报告的缺陷 2 更严重）。**
`cli.ts` 传 `maxRetries: traceUpload.maxRetries`，用户没配 `max_retries` 时是 undefined；
而重试循环是 `for (attempt = 0; attempt < this.opts.maxRetries; ...)` ——
`0 < undefined` 恒为 false，**循环体一次都不执行，一个 HTTP 请求都不会发出**，
文件直接判 failed 塞进队列。实测隔离验证：0 个请求到达服务端，整个命令 11ms 返回。
这解释了报告里那个「队列 1267 条清空到 0、云端一条没增」的现象里，
**除了"目录已被 LRU 删掉"之外的另一半**。
修法是把**所有**默认值收口到 `...options` 展开**之后**，而不是只补 outputDir 一个。
这是本仓同型缺陷的第三次复现（前两次：`outputDir`、`maxQueueRetries`）。

**② 空壳清理会留下「幽灵目录」。** `cleanupIfBlankSession()` 删完目录 return 后，
side-call 观察者仍可能触发 `forceRebuildTraj()`，而落盘走 `Bun.write()` ——
**它会自动创建缺失的父目录**。于是盘上重新出现一个只含 `session.traj`、无 `events.jsonl` 的目录
（实测 inode 从 102766900 变 102766946，可证是删后重建）。启动清理还会放它过
（`IGNORABLE_FILES` 只含 events/warn/heartbeat，见到 traj 就判"有数据"）。
修法：`sessionDisposed` 闸 + 摘除观察者；补传侧再加一道幽灵判据（双保险）。

**③ 已收到内容的会话被当空壳删掉（数据直接消失，比"没上传"严重一个量级）。**
`handleSessionEnd` 把中断轮的 `response.content` 置为 `[]`，而 `isBlankSession()`
的例外分支正是用 `content.length === 0` 判「从未收到内容」——
**判据与它想表达的语义相互矛盾，那条"收到过内容就保留"的例外永远无法成立**。
实测：一个 events.jsonl 里已有 `first_content`、raw.jsonl 已有记录的会话，
被 SIGHUP 中断后整个目录被删。修法：新增三态 `stream_received_content`，
从流观测器快照抢救证据。

## 放弃了什么（以及为什么不选）

**① 放弃「放宽信号路径超时到 12-15s」**（原报告方向 B）。
代价是 Ctrl-C 后干等十几秒，且**仍然挡不住 `kill -9`**。这是用体验换一个补传本来就能保证的东西。

**② 放弃「靠重试队列做补传」。** 队列条目指向的会话目录会被 LRU（默认 100）轮转删掉，
剩一堆指向空地址的门票（实测 1267 条全部如此）。「目录在、标记缺」只依赖磁盘现状，是自洽的。

**③ 放弃把补传触发点放在 `init-helpers`。** 那里只有**进程** session id，
resume 时与轨迹目录名（`resumed_from`）不是同一个值，用它做"别碰当前会话"的护栏会空转 ——
于是补传可能把正在被续写的目录传上去**并盖 `.uploaded` 章**，章一写，真正的终态永不补传。
正确触发点是 collector 的 SessionStart（`traceSessionId` 已做 resume 归一）。

**④ 放弃 `stream_received_content !== false` 这种写法**，改用 `=== true`。
前者会把「拿不到快照」（undefined）也判成保留，于是「敲句 hi 随即 Ctrl-C」这类噪音会话
（实测全天 18 条）从此永不清理 —— 那是把「缺证据」当成「证据表明有内容」。
现在的性质是**单调的**：老代码保留的仍保留，只把老代码误删的救回来。
（这条是被既有测试 `★启动即中断…判空壳清理` red 出来的，不是自己想到的。）

## 拿什么证明它生效了

**端到端（真实二进制 + 隔离 HOME + 本地假平台，非单元测试）：**

- 有内容的会话 SIGHUP 中断 → 目录存活，8 个文件齐全（修复前：整目录被删，数据丢失）
- 该会话 SIGHUP 时**不**带 `.uploaded`（信号路径不等上传，符合设计）
- 下次启动 → 平台收到上传请求，`.uploaded` 写入 `{session_id, confirmed_at, kept_local: true}`
- 无内容的启动即中断会话 → 仍被清理，且**不留幽灵目录**（`sessions/` 目录数正确）
- `--upload-traces` 输出：`队列 3 条：上传 0 … 因目录已清理丢弃 3` + 明确点出「本地已无副本」
  —— 「传了 0」与「传了 3」在输出上可区分（修复前两者都只打印「处理完成」）
- 修 ① 后重跑：`成功 1`、服务端实收 2 个 POST（修复前 0 个请求）

**幂等性**：连跑两次补传，第二次 `新增请求数 0`、全部计入 `alreadyUploaded`。
**失败不留假标记**：服务端 500 时 `.uploaded` 不写、条目进队列。

**真实数据扫描**（只读）：52 个会话 → 51 待补传、1 个正确判活跳过。

**测试**：新增 4 个文件 71 个用例（backfill 31 / queue 20 / ghost 3 / 退出路径门禁 17）；
`bun run affected-tests:run` **2861 pass / 0 fail**；`make build` 自检通过。

⚠️ 一处诚实的边界：`debug.log` 在后续会话里不再被写入（既有 logger 行为，非本次改动），
所以补传的 info 日志在多会话隔离测试里看不到。功能本身由 `.uploaded` 标记 + 服务端实收请求佐证。

## 附：本次真正起作用的排查手法

四个新缺陷（含最严重的 ①）**全部**是靠"跑真实二进制 + 隔离 HOME + 本地假服务端 + 数文件"抓到的。
静态读代码只能确认原报告已经写明的那三条。两个具体经验：

- **数产物比读日志可靠**。`messages.json` 0/52 是"handleSessionEnd 没跑到"的铁证，
  因为 `writeMessagesSnapshot` 是无条件调用的；而日志在信号路径上根本来不及打。
- **inode 会说话**。目录"还在"和"被删了又重建"在 `ls` 下一模一样，`stat -f %i` 一比就分明。
