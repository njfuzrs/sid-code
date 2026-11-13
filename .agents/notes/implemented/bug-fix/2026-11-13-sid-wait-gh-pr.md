---
Status: implemented
Date: 2026-11-13
Source: 收尾阶段重复挂监听-修复与验收方案（2026-11-12）
---
# 把「等 PR 合并 / 等 CI」做成 harness 解释执行的 `sid-wait gh-pr <n>`，退出条件不再靠模型手写

## 决定了什么

新增内置等待原语 `sid-wait gh-pr <n>`，由 bash 与 monitor 两个入口在 spawn **之前**识别并接管，
不启动任何外部进程（`parseSidWaitCommand` → `spawnBuiltinShellTask` / `spawnBuiltinMonitorTask`）。

退出条件由 harness 保证，不再靠模型每次手写循环：

- `merged` → exit 0（`MERGED <sha>`）
- 任一 check run `failure|cancelled|timed_out|action_required` → exit 1（逐条 `CHECK_FAILED <name> (…) job=<id>`）
- `state=closed && !merged` → exit 3
- `mergeable_state=dirty` → exit 4
- gh REST 连续失败 3 次（2^n 退避）→ exit 5

三条实现上的强制约束，每条对应一次真实事故：

1. **每轮都重新取 pull 再取 `head.sha`，用它查 check-runs**（b0aa0f1e：按本地 `git rev-parse HEAD`
   查，PR head 被 auto-update-branch 换掉后一直查旧 commit，30 分钟等到期限）。
2. **出现终态立刻返回，不等「全部检查跑完」**（ca8d7e5c：`case` 只认 MERGED/CLOSED，
   macOS 分片已 FAILURE 还每 20 秒查一次，25 分钟后以「期限到」送达）。
3. **沉默不等于成功**：首轮打一行 `WATCHING`，之后只在状态变化时输出——bash 入口的 `.output`
   不变成噪声，monitor 入口也不会因为「每轮一行」刷屏。

配套的四处接线：

- 等待对象签名由语法直接给出：`extractSidWaitSubjects` 抽出 `gh:pr:<n>`，R1 抽 subject /
  R2 判重复 / R6 判替换 / P1 判覆盖共用同一把尺子，不需要猜。
- 未显式传 `wait_until_seconds` 时默认期限 1800s：不带期限的后台命令会被静默判据当成
  「不会回报」，而等 PR 恰好长时间无输出。
- `read-only-validation` 认它为只读（只发 gh REST GET），否则每等一次 PR 弹一次确认。
- `<waiting-capability>`（中英）的「只要一次通知」改推荐 `sid-wait gh-pr <n>`；
  仍手写 PR 轮询循环时，等待回执里按对象提示一次内置写法（`formatManualLoopHint`）。

## 放弃了什么（以及为什么不选）

**放弃 A：只在提示词里叮嘱「记得检查 CI 失败」。** 两起事故都不是模型不知道，而是每次现写
都可能漏一条退出条件；提示词加一句话无法证明「这次没漏」，而且它的成本是每轮常驻 token。

**放弃 B：做成外部二进制 `sid-wait`。** 要分发、要版本对齐，Windows 还要另一套构建；
而正确性只需要「命令形态固定 + harness 自己执行」，不需要一个可执行文件。代价是它不能
在 `bash -c` 里被别的脚本调用——本仓的用法里没有这个需求。

**放弃 C：让 `monitor` 自己解析 `gh pr checks` 的文本输出。** 文本格式随 gh 版本变，
且 `gh pr checks` 的 pending 行不带 job id；走 REST 的 `pulls` + `commits/<sha>/check-runs`
字段稳定，还能拿到 `job=<id>` 让模型直接 `gh run view --job`。

**放弃 D：拉起一个真实的 gh 进程并在 harness 里解析它的 stdout。** 那等于把「退出条件」
又放回一个我们无法单测的外部程序里；现在 gh 客户端是注入的，30 个用例不联网、不起进程。

**放弃 E：失败时二次确认 head 再退出。** 两次 REST 调用之间的竞态窗口是毫秒级，为此多打
一次 `pulls/<n>` 会让每一条失败路径都变长；终态行里已带 head sha，模型能自己核对结论
落在哪个 commit 上。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/task/sid-wait-gh-pr.test.ts ./packages/core/tests/task/sid-wait-replay.test.ts ./packages/core/tests/tool/sid-wait-entrypoints.test.ts`
  → **30 pass / 0 fail / 117 expect()**。三组分别是：解析与退出条件、ca8d7e5c 的
  check-runs 回放、bash/monitor 两个入口的接管与等待登记。
- **变异自证**（先改坏被测代码，确认对应用例变红，再恢复）：
  - 变异 A「head 变化后用首个 head 查 check-runs」→ `head 变化后必须用新 head 查 check-runs`
    等用例红（19 pass / 1 fail）；
  - 变异 B「把 `failure` 从失败结论集合里去掉」→ 3 个用例红（`任一检查 failure → exit 1`、
    `新 head 上出现失败也立刻退出`、回放用例），19 pass / 3 fail。
  - 用例的 sleep 有轮次上限（`boundedSleep`），所以变异时看到的是断言失败而不是超时挂死。
- 全量门禁：`bun run affected-tests:run` 2938 pass / 0 fail；`make build` 产物自检通过；
  `bun run smoke` 28/28；`bun run lint` 0 warning；`bun run lint:boundary` /
  `lint:command-system` / `lint:legacy-tool` / `typecheck:gate`（62/62，无新增）/
  `docs:gen-reference --check` 全部通过；全量 `bun test` 见 PR 正文。
- 回放 fixture 的来源写在文件里：job 名与结论逐字取自 ca8d7e5c 的 `gh pr checks` 输出，
  check-runs 的 JSON 字段形态按 GitHub REST schema 构造（该会话没有直接调 check-runs 端点，
  没有可逐字回放的原始 JSON——这一点如实写进 fixture，不当成「原样导出」）。
