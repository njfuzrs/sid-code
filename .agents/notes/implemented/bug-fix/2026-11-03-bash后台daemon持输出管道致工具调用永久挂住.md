---
Status: implemented
Date: 2026-11-03
---
# bash 工具收尾改以「进程退出」为主信号，管道 EOF 只给宽限期

## 决定了什么

`packages/core/src/tool/bash.ts` 的前台收尾顺序从「先等两个管道 EOF，再等进程退出」改成
「等进程退出，再给管道一个 400ms 宽限期（`PIPE_DRAIN_GRACE_MS`）读完内核缓冲区尾巴，
仍未 EOF 就 cancel 读端让 pump 收尾」。

- 旧链路是 `await Promise.all([pump(stdout), pump(stderr)])` → `await proc.exited`。
  管道 EOF 要求**所有**持有写端的进程都关闭它；`setsid` 脱离进程组的 daemon
  （`nohup` / `setsid` / `xxx --daemon` 且未重定向 stdio）既不在 `kill(-pgid)` 的射程内，
  又继续持着写端，于是 pump 的 `for(;;) reader.read()` 永远等不到 `done`，
  工具调用永久挂住。超时也救不了：`killForTimeout` 打空之后 `timedOut` 已为 true，
  挂钟兜底再调一次会直接 return。
- 现在 `pump` 与 `proc.exited` 并发推进；进程退出（或被超时/abort 杀掉）就是收尾的发令枪。
  宽限期到仍未 EOF 时 `reader.cancel()`，并按 `PIPE_TRUNCATED_NOTICE` 在结果尾部说明
  「有脱离进程组的后台进程仍持有输出管道，已停止读取其后续输出」。
- 同一处改动顺带修好 Ctrl+B 转后台：`markExited` 原先排在 `await Promise.all([pump...])`
  之后，daemon 持管道时任务会一直显示 running、完成通知永不发。
- 超时分支不需要单独改：`killProcessTree` 杀掉 shell 后 `proc.exited` 自然 resolve，
  走的是同一条宽限期路径。

## 放弃了什么（以及为什么不选）

- **只改超时分支**（超时 kill 之后不等 EOF）。修不全：缺陷场景 C 里命令本身 6ms 就结束了，
  跟超时毫无关系，同样会挂——而且在旧实现下是**无条件永久挂住**，连超时都救不了。
- **用 `ps` / `pgrep` 找出持有管道的进程杀掉**。daemon 是用户有意启动的（就是想让它在后台跑），
  杀掉破坏用户意图；而且跨平台找 fd 持有者很脆。
- **把 stdout 改成写临时文件再读**。能根治 EOF 问题，但改动面大（进度流式上报、
  Ctrl+B 转后台的 `alreadyCaptured` 都要重写），收益与本缺陷不成比例。
- **在 cancel 之后再补一个「等不到就放弃」的兜底 race**。写过一版，删掉了：它会让
  `reader.cancel()` 变成可选，去掉 cancel 测试仍然绿——正好废掉变异自证。
  cancel 按 Web Streams 规范会让 pending `read()` 立刻返回 `done`；若某个运行时上不生效，
  要的是测试立刻变红暴露它，而不是静默降级成「工具返回了、reader 和 fd 一直泄漏」。

trade-off：宽限期之后 daemon 再写的输出会丢失（旧行为本来也拿不到，只是挂死）。
用「更准」上小幅损失可观测输出，换「更安全」不挂死。

## 拿什么证明它生效了

新增回归测试 `packages/core/tests/tool/bash-daemon-pipe-eof.test.ts`，四个场景（编号沿用排查报告 1.3）：

```
$ bun test ./packages/core/tests/tool/bash-daemon-pipe-eof.test.ts
(pass) A 不变性对照：同进程组后台任务被 kill(-pgid) 连带清理，行为不变 [3003.20ms]
(pass) B setsid daemon + 前台长命令：超时后不再等 daemon 关闭写端 [3407.26ms]
(pass) C setsid daemon、shell 立即退出：与超时无关也必须返回（旧实现在此无条件挂住）[424.09ms]
(pass) D 不变性对照：daemon 自己重定向 stdio 时管道正常 EOF，不出截断说明 [3003.80ms]
 4 pass / 0 fail
```

**变异自证**（把 `reader.cancel()` 换成 `void reader;` 后重跑，其余代码不动）：

```
(fail) B ... Expected: < 5000  Received: 6026
(fail) C ... [6095.06ms]
 2 pass / 2 fail
```

A / D 两个不变性对照仍绿——说明红了的是「daemon 持写端」这一条，不是别的行为被带坏。
恢复 cancel 后重跑 4 pass。

另跑既有 bash 测试套件确认无回归：

```
$ bun test ./packages/core/tests/tool/bash-daemon-pipe-eof.test.ts \
    ./packages/core/tests/tool/bash-background-reader.test.ts \
    ./packages/core/tests/tool/bash-stability.test.ts \
    ./packages/core/tests/tool/bash-timeout-diagnostics.test.ts
 47 pass / 0 fail
```

A 场景首次跑曾测到 5330ms（超出当时的 5000ms 预算）。复刻同一命令（`sleep 6 & sleep 60`
+ `detached` + `kill(-pgid)`）两次，管道 EOF 分别是 3002 / 3004ms，说明不是 daemon 拖的；
多出的约 2.3s 是首个 `BashTool` 实例构建 shell 环境快照的一次性开销（预热的 b/ D 场景都是 3.0–3.4s）。
测试里加了 `beforeAll` 预热，避免这笔一次性开销落在墙钟断言上。

⚠️ 未覆盖：Windows 下 daemon 持管道的行为（`taskkill /T` 走父子关系，脱离的 daemon 同样杀不到，
推测同构，手上没有 Windows 机器未测）。测试在 win32 上整体 skip。
