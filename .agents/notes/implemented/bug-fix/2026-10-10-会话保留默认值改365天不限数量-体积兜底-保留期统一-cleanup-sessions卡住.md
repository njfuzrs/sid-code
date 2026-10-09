---
Status: implemented
Date: 2026-10-10
---
# 会话保留：默认 365 天、不限数量、10GB 体积兜底；三处保留期统一；`--cleanup-sessions` 在终端里挂住

## 决定了什么

来源：`docs-research/sid-code/_template/todo-list.md`，「会话存储与清理」和「`--cleanup-sessions` 不退出」两条。

- **默认值**（单一事实源 `packages/core/src/session/retention.ts`）：`maxAge` 从 30d 改成 **365d**，
  `maxCount` 从 50 改成 **不限**，新增 `maxTotalSize`，默认 **10GB**（会话 jsonl + 同 id 轨迹目录合计），
  `minRetention` 仍是 1d。
  - 50 是**把示例值当成了默认值**：它和 Gemini CLI 文档的示例 `"maxAge":"30d","maxCount":50` 一字不差，
    而 Gemini 配置参考里 `maxCount` 默认是 `undefined`。一天几十个会话时，50 个配额只够留一两天；
    删会话又会连带删轨迹，北极星曲线的数据源也跟着被截短。
  - 横向对照（2026-10 联网核查）：Claude Code 有 `cleanupPeriodDays`，默认 30 天、无数量上限，
    正被集中投诉（anthropics/claude-code#62476、#64999）；Codex CLI、opencode、Cursor CLI 都**不自动清理**会话。
- **体积兜底**（`identifySessionsToDelete` 新增可选的 `opts.sizeOf`）：总量把受保护会话也算进去，
  但只从「未受保护、已过 minRetention、没被时间/数量规则删掉」的会话里**按最旧优先**删。口径与 D12 一致：
  保护优先于配额。体积配置写错时跳过体积清理，绝不当成 0 字节上限。
- **三处保留期统一**：`startup-housekeeping.ts` 原来轨迹目录与 Session Memory 笔记都写死 30 天，只认 `cleanupPeriodDays`；
  现在改走同一个 `resolveRetentionSettings`。`cleanupPeriodDays` 降级为 `maxAge` 的别名（两者都写时 `maxAge` 优先）。
  `enabled:false` 时三处都不按时间删。
- **不静默删除**：启动期自动清理真删了东西时，经 `App.notifyStatus` 推一条状态栏提示，附上调整位置。
  TUI 还没就绪时先排队，回填 `statusNotifier` 时再补推。原来只在 `--debug` 下记一行日志。
- **`--cleanup-sessions` 挂住**：根因是 bootstrap 在交互终端下启动 early-input（`setRawMode(true)` + `resume()`），
  一次性命令只 `return`，事件循环永不为空。管道 / 非 TTY 下 early-input 不启动，所以只在真实 pty 里复现。
  修法是新增 `exitOneShot()`（恢复终端 → 等 stdout 排空 → `process.exit`），`list/browse/delete/cleanup-sessions`
  与 `upload-traces` 五个分支统一用它收尾。`--cleanup-sessions` 还会打印完整生效配置，`enabled=false` 时直接说明不删。
- 同步了 `disk-usage.ts` 的保留策略登记表、`website/use/sessions.md` 与生成的 `website/ref/settings.md`。

## 放弃了什么（以及为什么不选）

- **默认完全不清理**（Codex / opencode 的做法）：Codex#34061 就是这样把磁盘撑到 755 GiB。
  所以保留体积兜底；时间默认给 365 天而不是无限，算是给「永远不打开」的旧轨迹留一个出口。
- **继续用 maxCount 防膨胀、只把 50 调大**：数量与体积相关性很差（一个子代理密集的会话轨迹就能上 GB），
  拿数量近似体积，误伤的恰好是最近、最想留的那批。真正要防的是盘满，所以直接按体积判。
- **删除改成移进废纸篓**：跨平台语义不一致（Linux 无统一 Trash），且移走不释放空间，会让体积兜底失效。
  现在默认已经很宽松，加上状态栏提示，这一项的收益不抵复杂度。
- **TraceCollector 的 LRU（`trace.maxSessionsRetained` 默认 100）一并放开**：它只清原始轨迹、长期指标在
  `session-index.jsonl`，且已有 P0-2 的论证，本次不动。⚠ 这意味着一天超过 100 个会话的用户，
  轨迹仍会先于会话被 LRU 回收，这是已知的残留边界。

## 拿什么证明它生效了

- 单测 `packages/core/tests/session/retention.test.ts`：钉住默认值，含反向门禁「不得回到 30d / 50」；
  别名优先级、`maxCount` 非正数不解读成全删。还有对照用例：一天 80 个、跨 2 天共 160 个会话，
  新默认删 0 个，旧默认删 80 个；体积兜底最旧优先、不越过保护，写错时不全删。
- `startup-housekeeping-orphans.test.ts`：Session Memory 跟随 `maxAge`（40 天前的笔记默认保留、设 7d 时被删），
  `enabled:false` 时 2000 天前的也保留。
- 真实 pty 复现（`script -q /dev/null ./sid-code --cleanup-sessions`，临时 `SID_CONFIG_DIR` + 本机会话副本）：
  修复前的 v0.1.607 在 15s 超时时被 SIGKILL，修复后 exit=0、约 440ms；`maxAge/maxCount`、`enabled:false`、
  `cleanupPeriodDays` 三种写法的生效配置都在输出里如实反映。
- 上线后看：`~/.sid-code/trajectories/sessions` 里最旧目录的年龄应超过 30 天
  （即 `/trace --list` 能看到一个月前的会话），而不是一直停在 30 天。
