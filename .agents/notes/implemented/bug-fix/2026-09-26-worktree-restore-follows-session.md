---
Status: implemented
Date: 2026-09-26
---
# worktree 自动恢复改为跟随拥有它的会话

## 决定了什么

启动时不再只因为「worktree 目录还在」就把新会话 `chdir` 进去。

`enter_worktree` 落盘的 `activeWorktreeSession` 此前只有显式 `exit_worktree` 会清，
关终端、`/quit`、任务做完都留着它。`restoreWorktreeSession` 只校验目录和 `.git`
pointer 还在不在，于是每次普通启动都被切进一个已经没人用的 worktree，
横幅的 Project / Path / Branch 全部跟着错（它们都从 `process.cwd()` 派生）。

实测个案：会话 `20260925-220507-8628cad7` 于 2026-09-25 22:07 进入
`.claude/worktrees/fix-daemon-webhook-hmac`，22:16:31 正常写了 `session_end`
（`endSession` 走 `writeCritical` 同步落盘），全程没有 `exit_worktree`。
状态文件停在 `.sid-code/session-config.json`，之后每次开 TUI 都显示那个分支。

修法是给状态补上归属，而不是取消自动恢复：

- `PersistedWorktreeSession` 增加可选 `sessionId`。`saveWorktreeState` 优先用
  调用方给的 id，缺省回退 `bootstrap/state.ts` 的全局会话 id。
- 这个全局 id 此前全程没人写（恒为 `""`），所以落盘永远带不上。`cli.ts` 在
  `loadConfig` 之后把它回填进去（`loadConfig` 收尾才生成 `config.sessionId`）。
- 新增纯判定 `shouldAutoEnterWorktree`：没有 `sessionId` 的旧状态无从判断，
  保持原行为；本次就是 resume 拥有者则进入；拥有者会话 jsonl **最后一条**记录
  是 `session_end` 则不进入；活跃会话注册表里它的 pid 还活着则进入。
- 判定接在 `cli.ts` 的会话恢复**之后**。之前 `config.resume` 还可能是序号或
  搜索词，不是会话 id，此刻比较必然对不上，会把正要恢复的现场提前清掉。
  判定为否时切回主仓并 `clearWorktreeState`，worktree 目录与分支不动。

## 放弃了什么（以及为什么不选）

- **按 `savedAt` 超时放弃。** 字段注释写着「用于判断陈旧度」，但没有任何
  调用方读它。时间阈值分不清「崩溃没写 session_end、用户明天想 resume」和
  「会话早就正常结束了」——这两件事的磁盘事实完全不同，不该用同一个时钟猜。
- **在 `restoreWorktreeSession` 内部直接清掉已结束会话的状态。** 该函数比
  resume 目标解析更早跑，那时还不知道本次是不是要恢复拥有者。判定放进去
  会在 `-c` / `--resume` 时先清状态再切 cwd，把要恢复的现场拆掉。
  所以它保持只读，只回答「目录还在不在」。
- **没有 `sessionId` 的存量状态一律清掉。** 旧落盘无从判断归属，一律清是
  无依据的行为变化。保持原样恢复，只对带了 `sessionId` 的新状态启用新判定。
- **进程退出时（SIGINT / SIGTERM / SIGHUP / exit）自动 `exit_worktree`。**
  那会把「崩溃后续得回来」这条恢复路径一起拆掉，而它正是持久化存在的理由。
  归属判定保留了这条路径：崩溃没写 `session_end`，下次启动照常恢复。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/worktree/persistence.test.ts`：15 pass / 0 fail。
  新增用例覆盖：`session_end` 收尾不进入、`session_end` 后有续写仍进入、
  尾部半行损坏不推翻 `session_end`、注册表 pid 存活不放弃、resume 拥有者仍进入、
  resume 别的会话不进入、无 `sessionId` 保持进入、jsonl 不存在不视为已结束、
  `saveWorktreeState` 从全局状态回退带上 id、全局也没有 id 时不写该字段。
- 用真实会话文件复核（`SID_CONFIG_DIR` 未改，读的是 `~/.sid-code`）：
  `shouldAutoEnterWorktree({ sessionId: "20260925-220507-8628cad7" })` 返回
  `false`；同一 id 作为 resume 目标返回 `true`；空 sessionId 返回 `true`。
- `bun run affected-tests` 判定为
  `bun test ./packages/cli/ ./packages/core/tests/worktree/`，实跑
  1647 pass / 0 fail（153 个文件，35.26s）。
- `make build` 成功，产物自检通过，输出中无 `will always be undefined`。
- 本机那份没有 `sessionId` 的存量状态（`fix-daemon-webhook-hmac`，拥有者会话
  已核实写了 `session_end`）已手动清掉 `activeWorktreeSession`，
  worktree 目录与 `fix/daemon-webhook-hmac` 分支未动。
