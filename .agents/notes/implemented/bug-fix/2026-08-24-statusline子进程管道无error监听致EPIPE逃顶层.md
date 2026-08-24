---
Status: implemented
Date: 2026-08-24
---
# statusLine 子进程三个管道都没挂 `'error'` 监听，EPIPE 逃到顶层把整个 CI job 拖红

## 决定了什么

`packages/cli/src/ui/statusline/run-statusline.ts` 新增导出函数 `attachPipeErrorHandlers`，
在 `write()` **之前**给子进程的 `stdin` / `stdout` / `stderr` 三个管道都挂上 `'error'` 监听。
原先只有一个同步 `try/catch` 包着 `write()`+`end()`，**盖不住流在 `end()` 之后
于 finish/destroy 阶段异步发的 `'error'`** —— 而无监听器的 `'error'` 事件在 Node/Bun 里
会升级成 `uncaughtException`。生产里 TUI 有顶层兜底（顶多这一帧回退内置状态栏），
但在 `bun test` 进程里它会被计成失败、让整个 job exit 1。

**写端与读端刻意不同处理**（这是本次最容易被后人"顺手统一"掉的一条）：

| 管道 | 处理 | 为什么 |
| --- | --- | --- |
| `stdin`（写端） | **只丢弃**，不 `finish(null)` | 脚本不读 stdin 就退出（`echo a`）是合法用法，stdout 已拿到，`on("exit")` 会正常 `finish(text)`。当失败处理 = 合法脚本的状态栏无谓回退内置 = **行为回退** |
| `stdout`/`stderr`（读端） | `finish(null)` 回退内置 | 读不到内容这一帧就没有状态栏可显示，回退是唯一正确结果 |

配套三条用例（`packages/cli/tests/ui/run-statusline.test.ts`）+ 测试文件头补记第四种变体，
明确写上「**这条与超时无关，动 `TEST_TIMEOUT_MS` 一点效果都没有**」——
前三次 flake 是超时撞线，这次不是，而只改超时是最容易走上的歧路。

## 放弃了什么（以及为什么不选）

**① 只给 `stdin` 挂监听，不管读端。** 否决：读端同样是裸的（只有 `on("data")`），
同一类竞态在理论上成立。既然在改这个文件的错误处理路径，一并盖住成本几乎为零；
留着等它某天以另一种形态复发，是明知故犯。

**② 把 `stdin` 的 error 也接到 `finish(null)`（三个管道统一处理）。** 否决：写端 EPIPE 是
**预期**情况，不是故障。已用变异实测：把 `stdin` 接到读端处理后，`echo a` 的返回值从
`"a"` 变成 `null` —— 状态栏无谓回退内置，是行为回退。这条已被用例锁住。

**③ 靠 mock `node:child_process.spawn` 来断言监听器数量。** 否决，实测走不通且有害：
`spyOn(childProcess, "spawn")` 拦不到生产模块的 named import（`toHaveBeenCalled` 为 0）；
直接给模块命名空间赋值抛 `TypeError: Attempted to assign to readonly property`；
`mock.module` 是**进程级**的，实测递归进自身产生 31885 次调用，还会污染同进程其它测试文件。
改为把接线抽成导出函数 `attachPipeErrorHandlers`，用真 `EventEmitter` 直接锁形态 —— 零 mock。

**④ 放宽 `TEST_TIMEOUT_MS`（沿用前三次 flake 的修法）。** 否决且已在两处写下警告：
报红用例已拿着 15s 宽超时、实际耗时 10.39ms，差三个数量级。调它不会有任何效果，
只会让下一个人误以为已修 —— 这正是同一文件前两次「只改那一条用例」后复发的模式。

**⑤ 用「连跑 N 轮不复现」当验收。** 否决：缺陷文档已记录本地 400 轮复现不出来
（它需要"子进程已退出 且 `stdin.end()` 收尾正好落在管道断裂之后"这个窗口）。
"跑了很多轮没红"既不能证伪也不能证实。改用下面的确定性复现。

## 拿什么证明它生效了

**① 找到了确定性复现，不再依赖时序运气**（比缺陷文档里的 `emit("error")` 合成复现强一档 ——
那是手动 emit，这里是真的走 syscall 断管）：payload 撑到 2MB 超过管道缓冲（64KB 量级），
配 `echo a`（不读 stdin 就退出）→ 断管必然发生。修前对着**生产函数** `runStatusLine`
跑 30 轮：

```
>>> 逃到顶层: EPIPE send      × 30
✘ 逃逸 30 次                  (exit 1)
```

修后同一脚本、同样 30 轮：`✔ 无逃逸`（exit 0）。

**② 变异自证，两个方向各做一次**（`bun test ./packages/cli/tests/ui/run-statusline.test.ts`）：

| 变异 | 结果 |
| --- | --- |
| 基线（修法在位） | `12 pass / 0 fail` |
| 删掉 `stdin` 的 `'error'` 监听 | **3 fail** —— 含端到端那条以真实 `EPIPE: broken pipe, send / errno: -32` 形态报红，与 CI 上看到的一致 |
| 把 `stdin` 统一接到读端处理（否决项 ②） | **2 fail** —— `expect(out).toBe("a")` 收到 `null`，正是那个行为回退 |

三条用例各自都能红，没有一条是恒绿的摆设。

**③ 全量门禁**：`bun test` = `10804 pass / 1 fail`、`make build` 成功且
**grep 过 `will always be undefined`，零命中**（worktree 新增导出必查的那条，
进 worktree 后已先跑 `bun install`）、`bun run lint` / `format:check` / `lint:boundary` 全过。

那 1 fail 是 `plan-mode-write-plan-file.test.ts`，**已按 CLAUDE.md 要求的三条证据判定为
worktree 环境产物、与本次改动无关**（不是"既存失败"——它在主干上是绿的）：

1. 该文件 grep `statusline|statusLine|run-statusline` **零命中**，不 import 本次改动的任何模块；
2. 在**父仓 main** 上单跑 `6 pass / 0 fail`；
3. 环境成因明确：worktree 路径含 `.claude/`，命中 `permission/checker.ts` 的敏感路径拦截，
   在 plan-mode 判定**之前**就返回 —— 实际报错文本就是
   `非交互模式下自动拒绝: [安全检查] Claude 配置目录`，而用例期望的是「计划模式」。
