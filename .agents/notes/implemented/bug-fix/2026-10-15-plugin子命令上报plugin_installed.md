---
Status: implemented
Date: 2026-10-15
---
# `sid-code plugin install|update` 自己绑 Analytics Sink 并在退出前刷出

## 决定了什么

`packages/cli/src/command/plugin-cli.ts`：`install` / `update` 两个子命令在执行前调
`initAnalyticsSink`（与 TUI 同一套：隐私级别门控、内置 `sid-backend`、本地 JSONL），
执行后 `shutdownBackends()` 刷出，整组 3s 硬上限。其余只读子命令不初始化、不外发。

根因（生产只读核对，2026-10-13 那 3 次下载）：nginx 日志显示安装来自 `Bun/1.4.2`
直连 `index` + `artifacts`，同时段 events 里没有任何「安装会话」——安装由一个直接调
`PluginCommand.execute` 的进程完成（当时的驱动脚本，现在等价于 `sid-code plugin` 快速路径）。
快速路径不启动 App，没人调 `attachAnalyticsSink`，`logPluginInstalled` 只进
`analytics/index.ts` 的内存队列，进程退出即丢。随后 3 个 `-p` 会话走完整 App，
所以 `tool_invoked` 正常上报。

文档里的两个候选都不是根因：
- 自动更新路径（`auto-update.ts`）也走 `installResolved`，同样会发事件；且它只升级不新装。
- `-p` 进程退出前 `gracefulShutdown` 会刷 flush 钩子；问题在于根本没有 Sink，不是没刷。

## 放弃了什么（以及为什么不选）

- **在 `logPluginInstalled` / `installResolved` 里直接 `fetch` 上报**：绕开隐私级别、
  凭据、磁盘重试那一整套，等于第二条上报通道，口径与 TUI 不一致。
- **在 bootstrap 给所有快速路径统一绑 Sink**：`--version` / `mcp list` 等也会去读配置、
  拉 feature flag，冷启动变慢且多出网络请求，换来的只是几个本来不发事件的命令。
- **改成落本地磁盘、下次启动再补发**：下次启动可能永远不来（CI 一次性机器），
  而且事件时间会错位。

## 拿什么证明它生效了

- 新增 `packages/cli/tests/command/plugin-cli-events.test.ts`：真子进程 + 127.0.0.1 假后端，
  4 pass（install 上报且带设备凭据 / update 上报 `install_action=update` /
  `SID_CODE_DISABLE_TELEMETRY=1` 零外发 / `list` 零外发）。
- 变异自证：去掉 attach → install、update 两条红；保留 attach 只去掉 flush → 同样两条红。
  说明两步缺一不可，进程内单测（`market.test.ts` 自带假 Sink）对这个缺陷是盲的。
- `make build` 后用产物 `./sid-code plugin install demo@company` 对假后端跑：
  exit 0、254ms，假后端收到 `plugin_installed {demo, company, 1.0.0, install}`。
- 待生产验证：发版后重装一个市场插件，events 表 `plugin_installed` 应从 0 变 1。
