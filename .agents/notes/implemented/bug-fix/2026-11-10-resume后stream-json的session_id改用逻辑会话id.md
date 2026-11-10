---
Status: implemented
Date: 2026-11-10
---
# resume 后 stream-json 的 `session_id` 改用逻辑会话 id

## 决定了什么

`runHeadlessSDK` 构造 `SDKQueryEngine` 时传 `sessionId: this.sessionState.sessionId`（本进程新 id）。引擎用这一个字段填 `system/init`、每条 `user` / `assistant`、以及全部 `result` 分支的 `session_id`，宿主再拿这个 id 去 `--resume`。

resume（`-c` / `--resume`）时，SessionStore 续写的是**被恢复会话**的 JSONL、轨迹也落在 `sessions/<被恢复 id>/`，所以交出的进程 id 在磁盘上根本不存在。2026-11-10 构建产物探针（修复前，v0.1.614 dev）：

- 首次 `-p --output-format stream-json` → `result.session_id=S1`，`sessions/<slug>/S1.jsonl` 存在；
- `-c -p` → `system/init` 与 `result` 都是 S2，磁盘上仍只有 S1；
- `--resume S2` → exit 1「未找到会话」；`--resume S1` → exit 0，但那一轮又交出第三个新 id，同样不可用。

改为 `this.getLogicalSessionId()`（`resumedSessionId ?? 新 id`）。这与 #666 对 `--output-format json` 的修法同源，当时明确把 stream-json 留在「另一条路径，未核实」。

时序上可行：`runHeadless` 先 `await this.init()`（resume 在 init 里完成、`resumedSessionId` 已赋值），`runHeadlessSDK` 在其后才被调用，构造引擎时逻辑 id 已就绪。

守护：`X4-resume-id` 加一步 stream-json 的 `-c -p`，断言 `result.session_id` 在隔离配置目录里有对应会话文件（磁盘事实）、等于被恢复会话，且 `system/init` / `user` / `assistant` 与它同源。运行器的 print 步骤新增 `outputFormat` 字段（缺省 `json`，既有用例行为不变）。

## 放弃了什么（以及为什么不选）

- **改成 getter / provider 式延迟取值（`() => string`）**：不加。`/clear` 是唯一会在进程内 rotate 身份的命令，而 `headless-dispatch.ts` 对它在无头下直接回「需要交互界面（clear），无头模式下无法完成」，所以构造时快照不会过期。为一条不可达的路径引入函数形态的配置字段，是把「可能有用」当理由。
- **同时新增 `process_session_id` 字段交出进程 id**：不加，与 #666 同一判断——没有消费者要它，加字段就是无调用方的契约。
- **只在用例里造会话夹具、绕开真实 resume**：不做。X4 的价值正是「跑真二进制、按磁盘事实断言」；手造 JSONL 夹具会把判据变成「我说的格式对不对」，而不是「产品真的写在哪」。
- **顺手修 `scripts/prune-branch-builds.sh` 的空档位 exit 1**：不塞进本 PR。它由本轮全量选测在本机 checkout 上暴露（`show()` 里 `printf | grep -v '^$'` 在空输入上返回 1，被 `set -e` 放大成脚本退出码 1），与本次改动无 import 关系，按关注点应单独开 PR。

## 拿什么证明它生效了

- `bun run smoke -- X4-resume-id`：PASS（1.0s）。
- `bun run smoke:mutate -- X4-resume-id`：**2 条变异 2 killed**。
  - 第一条（json 输出回到进程 id）→ 「`-c -p` 交出的 trajectory_path 不存在」；
  - 第二条（构造引擎时改回 `this.sessionState.sessionId`）→ 「stream-json 的 result.session_id=… 在磁盘上没有会话文件（拿它 --resume 会报「未找到会话」exit 1）」。
- 手工探针（修复前）：`--resume <stream-json 交出的 id>` exit 1「未找到会话」，`--resume <首次 id>` exit 0。
- `bun run lint` / `bun run format:check` / `bun run typecheck:gate`：全绿（62 处存量错误 / 基线 64，无新增）。
- `make build`：成功，自检通过。
- `bun run affected-tests:run`：5066 pass / 9 skip / **2 fail**，失败是 `tests/eval/artifact-identity.test.ts` 的 `prune-branch-builds` 两例。举证三条：
  1. 该测试 spawn `scripts/prune-branch-builds.sh`，`git diff main -- scripts/prune-branch-builds.sh tests/eval/artifact-identity.test.ts` 为空，不经过本次改动的任何模块；
  2. 在 `git worktree add --detach /tmp/sid-main-check main` 的干净 main 上单跑该文件：57 pass / 0 fail；
  3. 成因：本机 checkout 有 100+ 本地分支/工作树，`synth()` 用真实 commit 造的候选多数被 `refs/heads` 判成 protected，`--keep 2` 后 `PRUNES` 为空，`show()` 的空输入 `grep` 让 `set -e` 退出 1。分支上多一个 commit 会平移 `git log -n 40` 的窗口，故 main 绿、本分支红。CI 是 fresh checkout，不触发。
