---
Status: implemented
Date: 2026-08-21
---
# changelog curate 的 diff stat 改由脚本预抓，模型与推理档位走 env 可配

## 决定了什么

`bun run changelog:curate` 原先把「读 diff」这件事交给 agent 自己做：提示词第 1 条
要求它对每条提交跑 `git show --stat`。三处改动把这个循环搬到脚本里：

1. **新增 `commitStatBlock()`**（`scripts/lib/changelog-git.ts`）——
   脚本一次性抓完全部提交的 stat，截断到每条前 `STAT_TOP_FILES = 12` 个文件，
   超出折叠成「…及其他 N 个文件」。提示词新增 `{{DIFF_STATS}}` 占位符承接，
   第 1 条规则改成「stat 已给全，不要再逐条 git show」。
2. **`MAX_TURNS` 从 40 降到 12**。40 那个值配的是逐条 `git show` 的流程，
   而 `v0.1.600..HEAD` 有 131 条提交 —— 40 轮根本不够，它会在读完三成提交时被截断。
   现在正常路径是「读提示词 → write 落盘」两三轮。
3. **`--model` / `--effort` 显式下发**，取值来自 `SID_CODE_CURATE_MODEL` 与
   `SID_CODE_CURATE_EFFORT`（后者默认 `low`）。不设模型名时**不传 `--model`**，
   回落到用户自己的配置。

另加一条心跳：`runAgent` 每 15s 往 stderr 打一行「已跑 Ns」。stdout/stderr 是刻意
被 buffer 不透传的（见文件头「不解析 stdout」），于是终端在分钟级的等待里一个字都没有 ——
实测有人因此判断脚本卡死并中断了它。**静默的进度与真的卡住无法区分。**

## 放弃了什么（以及为什么不选）

**① 把 131 条提交分片交子代理并行，再用一次调用合并 —— 否决。**
单版本本来只有**一次** agent 调用，慢的是它内部的 131 轮 bash 往返，不是调用次数。
而「一条一句话、跨分组去重、只挑一个 highlight」是**全局判断**，分片后必须合并，
合并调用又要看到全部局部结果 —— 净效果是多付一次 LLM 调用，换来把一次长上下文调用
拆成两轮。预抓 stat 已经把 131 轮压到 2 轮，并行要抢的那块时间基本不存在。

**② 硬编码一个便宜模型名（如 `deepseek-v4-flash`）—— 否决。**
模型可用性是**机器/账号级事实**，不是仓库级事实。写死等于把「我这台机器有这个模型」
变成仓库约定，别人 clone 下来跑就断，而断的形态是 404 或静默 fallback —— 都不好归因。
所以：env 给了就用，没给就回落到用户配置（贵一些，但一定能跑）。

**③ 只给 `N files changed` 汇总行（19KB，比 97KB 更省）—— 否决。**
curate 的判据是「这次改动对用户有什么影响」，而**改了哪些模块**是唯一能从 stat 层面
看出这件事的信号。只给汇总行就退化成「只能看 commit 标题」，而提示词第 1 条
存在的理由恰恰是「commit message 可能是误导性的」。

**④ 完整 stat（307KB）—— 否决。** 本仓有单条提交动 1777 个文件的历史（`8ae3472e` 分包）。
完整 stat ≈77k token，其中绝大部分被那几条大重构占掉，而它们对用户可见性的贡献为零。

## 拿什么证明它生效了

**预抓本身**（`bun -e` 直调）：131 条提交耗时 **1283ms**、产出 **97.6 KB**（TOP=12）；
`8ae3472e` 那条 1776 文件的提交被折叠成 15 行，末两行是
`…及其他 1764 个文件` / `1776 files changed`。三档实测对比：TOP=8 → 84.1KB、
TOP=12 → 97.5KB、TOP=20 → 114.9KB；完整 stat 307KB。

**提示词组装**：复现替换后 grep `\{\{[A-Z_]+\}\}` **零残留**，总体积 118.1 KB，
且含 `== 5b44f471` 这类 stat 块 ✓。

**真实跑通**（`SID_CODE_CURATE_MODEL=deepseek-v4-flash bun run changelog:curate 0.1.601`）：
**305s、退出码 0、一次通过校验**，采用 30 条 / 丢弃 101 条，覆盖率无 warn。
终端可见「已预抓 131 条 diff stat（98 KB），模型 deepseek-v4-flash / effort low」
与逐次心跳行。改动前同一版本连 `MAX_TURNS=40` 都不够跑完。

**门禁**：`affected-tests:run` 判定 selective 2 个目标 → **800 pass / 0 fail**（6.73s）；
`bun run lint` 无输出；`format:check` 起初红（我新写的两处排版），跑 `bun run format`
后复查全绿；`make build` 编译产物四项自检全过。

**一条 review 到的内容缺陷（校验器拦不住的那类）**：agent 把 `1ab630bb` 那次安全审计
压成一句「修复 MCP 与子代理场景的若干安全缺陷」。回源码核实后它实际含**两条破坏性变更**
（凭证文件 `path-validator.ts:23` 从确认收紧为默认 deny；`web_fetch`/`web_search`
`tool-classifier.ts:71` 移出自动放行名单）+ 一条新防线（WebFetch 隔离提炼，
`webFetchIsolate` 默认 true）。已手工拆成「破坏性变更」组 2 条 + 「改进」1 条 +
「修复」1 条，并改掉与 highlight 重复的那句。这正是「校验器只查形态、内容只有人能拦」
的实例，也是本次唯一需要人工介入的地方。
