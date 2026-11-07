---
Status: implemented
Date: 2026-11-07
---
# G2 用例 B2-seatbelt：守住「enableSandbox 下 bash 真的经 Seatbelt 执行」，运行器支持预置假 HOME

## 决定了什么

新增 `tests/smoke/cases/B2-seatbelt`（`platforms: [darwin]`，其他平台 skip，原因写进 step summary）。隔离配置目录的用户级 settings 写 `enableSandbox: true`，回放 3 条 bash：

1. `echo hello`：成功；
2. `cat ~/.ssh/known_hosts`：`is_error=true`，模型请求里出现 `Operation not permitted`，且预置的 known_hosts 内容**不出现**在任何模型请求里；
3. `echo x > ./ok.txt && cat ./ok.txt`：成功，文件内容为 `x\n`。

同时断言 `sandbox_init{enabled, platform=darwin, probe_ok, network=localhost}` 恰好 1 条，3 条 bash 的 `PostToolUse.sandboxed=true` 也恰好 3 条，分母对齐，被拒的那条也算在内。判据取自触发清单 B2 的人工五步实测（2026-11-05，会话 `20261105-203209-465586d3`）。

运行器改了两处：
- 新增 `SmokeCase.home`：往假 HOME 预置文件，拒绝预置 `.sid-code/`，否则 P-3 断言会误报或掩盖真泄漏；
- `RunOutput` 补 `homeDir`。

## 放弃了什么（以及为什么不选）

- **「工作区外写被拒」（人工五步第 3 步）**：不放 G2。第一版用例写了 `echo x > ~/sbx-e2e-should-fail`，实跑红了，原因是写入成功了。假 HOME 在 `tmpdir()`，也就是 `/private/var/folders` 下，而这个路径本身就在写白名单里（`collectWritePaths`）。这不是沙箱缺陷，是用例环境的问题。要测这一步只能写真实 `$HOME`，而 G2 不碰真实家目录。这一步由 G1 `sandbox-exec-real.test.ts` A4 覆盖，它为同一原因把 fakeHome 放在真实 `$HOME` 下，并自行清理。
- **网络档（`curl 1.1.1.1`）**：不测。CI runner 的出网策略不受控，「连不上」可能是网络本身的原因，不一定是沙箱拦的。
- **`write_paths_count`**：不断言。它取决于本机装了哪些包管理器的缓存目录，平台之间不可比。
- **在 ubuntu 上用别的机制模拟**：不做。Seatbelt 是 macOS 机制，ubuntu 上正确的行为就是 skip 并说明原因。

## 拿什么证明它生效了

- `make build && bun run smoke -- B2-seatbelt`：通过，用时 0.4s；全量 smoke 11 例全部通过。
- `bun run smoke:mutate -- B2-seatbelt`：2/2 killed。
  - `bash.ts` 前台命令不经 `wrapCommand`：`sandboxed` 埋点仍然报 true，但 known_hosts 被读出来了。这正是「标着沙箱、实际裸跑」的形态，`sandboxed` 计数断言自己抓不到，要靠 known_hosts 那条断言拦。
  - `sandbox.ts` profile 丢了敏感目录 deny：known_hosts 可读。
- 把 `process.platform` 改成 linux 跑运行器，输出 `skip 仅在 darwin 上运行，当前 linux`。
- 写用例前在隔离目录里探针过一次：profile 的 deny 规则按子进程的假 HOME 展开，known_hosts 被拒，`~/plain.txt` 可读。
