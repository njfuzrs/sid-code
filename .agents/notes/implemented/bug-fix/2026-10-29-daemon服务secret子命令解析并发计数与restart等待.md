---
Status: implemented
Date: 2026-10-29
---
# daemon 六处缺陷：服务模式 webhook secret、子命令解析、并发计数、restart 等待、版本与提示词漂移

## 决定了什么

- D1：`install` 把当前环境的 `SID_CODE_WEBHOOK_SECRET` 写进 `state/daemon-webhook-secret`（0600），daemon 在环境变量缺省时读它（`daemon/webhook-secret.ts`）。`install --webhook` 时环境变量和文件都没有，直接拒绝安装。安装时设了 `SID_CONFIG_DIR` 就写进 plist 的 `EnvironmentVariables` / systemd 的 `Environment=`，服务进程与安装时看同一个配置根。
- D2：子命令只看 `args[0]`。不认识的原样返回，走「未知子命令」；选项写在子命令前面或带多余位置参数，直接报错。
- D3：`Daemon` 实现 `ConcurrencyGate`，传给 webhook server / `DaemonWorker`，两个触发源共用 `running`。webhook job 结束时会抽干调度队列。
- D4：`restart` 发完 SIGTERM 后轮询 `isDaemonRunning()`，最多等 10s，超时报错，不再继续 start。
- D5：`durable-projects.ts` 头注释改成「写盘之前登记」；`/health` 版本改成 `getVersion()`，与 `daemon.lock` 同源。
- D6：`/loop` 提示词里的 `delaySeconds` 改为 `delay_seconds`。

## 放弃了什么（以及为什么不选）

- secret 明文写进 plist / unit：这两个目录下的文件通常是 644，等于把 secret 给本机所有用户看。
- systemd 用 `EnvironmentFile=`：launchd 没有等价机制，两个平台要走两套逻辑。0600 文件这一套两边通用。
- D3 改成「每个源各自上限」，同时改帮助文本：用户按 `--max-concurrent` 规划的是机器资源和模型配额，按源分开计数对他们没有意义。
- D2 遇到未知子命令仍兼容成 start：默默起一个常驻进程，正是这次要修的伤害。

## 拿什么证明它生效了

- 新增测试：`packages/core/tests/daemon/daemon-scheduled-defects.test.ts`、`packages/core/tests/daemon/daemon-restart-wait.test.ts`、`packages/cli/tests/command/{daemon-args,loop-wakeup-param-names}.test.ts`。
- 变异自证：逐条恢复成旧行为，包括 secret 文件不读、不写 SID_CONFIG_DIR、`--webhook` 不拒装、未知子命令当 start、`createDaemonServer(config)` 不传闸门、release 不减计数、不轮询、写死版本、`delaySeconds`。每条都有对应断言变红，恢复后全绿。第一版测试漏掉了「daemon 没把自己传给 server」这一条，变异照样全绿，所以补了一条从 `maybeStartWebhook` 走端到端的 429 用例。
- 没有在真机上 `launchctl load` 或 `systemctl enable` 验证服务拉起，只断言了生成的服务文件内容和 secret 文件权限。
