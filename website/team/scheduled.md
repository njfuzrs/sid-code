---
title: 定时与无人值守
description: 会话内 /loop、跨会话 durable 定时任务、daemon 常驻守护、GitHub webhook 触发——整条无人值守链路。
---

# 定时与无人值守

sid-code 的定时体系有三条路径，对应不同的"离你有多远"：

| 路径 | 谁触发 | 活多久 | 你需要在场吗 |
| --- | --- | --- | --- |
| 会话内 `/loop` | 你在交互会话里下命令 | 只活在这个会话进程里 | 会话关了就停 |
| 跨会话 durable 任务 | 模型用 `cron_create(durable:true)` 创建 | 写盘，跨会话存活 | 不用在场，但要有进程驱动 |
| daemon 常驻 | `sid-code daemon start` | 机器不停就一直在 | 完全无人值守 |

前两条已实现，第三条靠 daemon 守护进程。**云端 Routines 不做**——没有云端基建
（对照 Claude Code 的云端 Routines / Dispatch，sid-code 只做了本地这条）。

读完这页你能做到：知道三种模式什么时候用哪个、durable 任务怎么跨会话不死、
daemon 怎么装成系统服务、GitHub PR 怎么自动触发 code review。

## 快速上手：会话内定时

最简单的是 `/loop`，只在当前会话里有效，关了会话就没了：

```text
/loop 每 5 分钟检查一次 CI 有没有过
```

`/loop` 是用户入口（`src/command/commands/loop/loop.ts`），它会把你的意图翻译成
底层操作——固定间隔转成 cron 表达式建任务，或者引导模型用 `schedule_wakeup` 自适应轮询。

::: tip `/loop` 和 `/goal` 不一样
`/loop` 是"按固定间隔重复跑同一件事"，`/goal` 是"干到达标为止"。两者都涉及多次执行，
但终止条件不同：`/loop` 靠你取消或任务完成，`/goal` 靠独立评估者判定。见
[Plan Mode 与 Todo](/use/plan-mode) 的 `/goal` 章节。
:::

## 跨会话：durable 定时任务

会话内的任务会随会话结束消失。要让定时任务**跨会话存活**，用 `durable: true`：

```text
帮我建一个每天 9 点跑的定时任务：检查依赖有没有新版本，durable
```

模型会调 `cron_create` 工具（`src/tool/cron-create.ts:34-126`），参数：

| 参数 | 作用 |
| --- | --- |
| `cron` | 5 字段 cron 表达式（分 时 日 月 周），**本地时间**，最小粒度 1 分钟 |
| `prompt` | 触发时跑的指令 |
| `recurring` | `true`（默认）= 循环触发，**7 天后自动过期**；`false` = 触发一次后自删 |
| `durable` | `false`（默认）= 会话级，只活在内存；`true` = 写盘，跨会话存活 |
| `allowedTools` | 触发时允许用的工具白名单（可选） |

durable 任务写盘到 `<项目>/.sid-code/scheduled_tasks.json`，同时在
`~/.sid-code/state/durable-projects.json` 登记这个项目（`src/daemon/durable-projects.ts:63-71`）。

### cron 表达式格式

5 字段：分 时 日 月 周。支持的语法（`src/cron/parser.ts:20-64`）：

- `*` 任意值；`N` 具体值；`a-b` 范围；`a,b,c` 列表；`*/N` 步进
- 周字段 0–6（0=周日），7 也接受
- 日和周是**"或"语义**——任一匹配即触发（`parser.ts:134-135`）
- 确定性抖动：基于 taskId 哈希，最多偏移周期的 10%（上限 15 分钟），避免一堆任务整点同时触发

### 一次性提醒 vs 固定重复 vs 自适应轮询

三种形态，对应不同工具：

| 形态 | 怎么做 | 例子 |
| --- | --- | --- |
| 一次性提醒 | `cron_create(recurring:false)`，cron 定到具体时刻，触发后自删 | "3 点提醒我看部署" |
| 固定间隔重复 | `cron_create(recurring:true)`，循环 cron，7 天后过期 | "每 5 分钟查一次 CI" |
| 自适应轮询 | `schedule_wakeup(delaySeconds)`，模型自选下次延迟 [60,3600]s，目标达成后停止 | "等 CI 过了告诉我" |

`schedule_wakeup`（`src/tool/schedule-wakeup.ts:91-108`）用绝对触发时刻 `fireAt`，
一次性。模型每轮检查后自己决定下次多久再来——CI 还没过就 5 分钟后，快了就 1 分钟后，
过了就不再安排。**不会无限轮询**——目标达成即停。

### `/cron` 斜杠命令：管理面板

查看和删除定时任务用 `/cron`（别名 `/schedule`，`src/command/advanced.ts:150`）：

```text
/cron              # 列出所有任务
/cron delete <id>  # 删除某个任务
```

注意区分两套接口：

| 接口 | 谁用 | 干什么 |
| --- | --- | --- |
| `cron_create` / `cron_list` / `cron_delete` 工具 | **模型**调用 | 创建/列出/删除任务 |
| `/cron` 斜杠命令 | **你**输入 | 管理面板（list/delete），不负责创建 |

创建走模型工具（因为要构造 cron 表达式和 prompt），管理走斜杠命令。

## daemon 常驻守护

durable 任务写盘了，但要有进程去"到点触发它"。会话开着时，交互式会话会驱动；
会话关了就需要 daemon。

### 启动与子命令

```bash
sid-code daemon start     # 前台启动
sid-code daemon status    # 看 pid / 启动时间 / 版本
sid-code daemon stop      # 发 SIGTERM 优雅停机
sid-code daemon restart   # stop + 1s 等待 + start
sid-code daemon logs      # 看 ~/.sid-code/logs/daemon.log
```

`sid-code daemon` 子命令定义在 `src/command/daemon.ts`。

### daemon 启动后做什么

| 步骤 | 说明 | 证据 |
| --- | --- | --- |
| 抢单例锁 | `~/.sid-code/state/daemon.lock`，同机器只跑一个 daemon | `src/daemon/daemon.ts:84`、`src/daemon/lock.ts` |
| 注册会话 | `/ps` 能看到 daemon 在跑 | `daemon.ts:94-100` |
| 启动调度器 | `daemonMode: true`，**每 60 秒**检查一次到点任务 | `daemon.ts:105-114`，默认 `checkIntervalMs = 60_000` |
| 可选 webhook | 配了 `SID_CODE_WEBHOOK_SECRET` 才监听 | `daemon.ts:117`、`daemon.ts:204-231` |
| 保活心跳 | 每 60s 空转 timer | `daemon.ts:124-126` |
| 信号处理 | SIGINT/SIGTERM 优雅停机 | `daemon.ts:120` |

### 跨项目发现 durable 任务

daemon 启动时不只看当前项目，而是读 `~/.sid-code/state/durable-projects.json` 注册表，
**跨所有项目**加载 durable 任务（`src/cron/scheduler.ts:292-323` 的 `loadAllDurableProjects`）。
注册表会自愈——失效项目自动剔除（`durable-projects.ts:78-96`）。

### 会话与 daemon 谁来驱动

交互式会话启动时也会尝试驱动 durable 任务，但有协调：

- 会话先抢**项目级调度锁**（`<项目>/.sid-code/scheduled_tasks.lock`，`src/cron/lock.ts`），
  抢到才加载并驱动该项目的 durable 任务
- **若检测到 daemon 在场**（`scheduler.ts:79-93`）：交互式会话主动放弃 durable 驱动，
  全交给 daemon——避免会话和 daemon 重复触发同一任务

两把锁不同层级：项目级锁防同项目多会话重复触发，daemon 单例锁防同机器跑多个 daemon。

### catch-up：只补最近一次

daemon 睡了几天醒来，错过的任务怎么补？**只补最近一次**，不补全部历史
（`src/cron/parser.ts:186-187` 注释明确："日任务睡 6 天醒来只补 1 次——丢弃更早的所有错过时刻"）：

- `recurring` durable 任务：`computeLatestMissedRun(lastFiredAt, now)` 取最后一个触发点补一次（`scheduler.ts:346-351`）
- 一次性 `fireAt` 任务：错过即触发（`scheduler.ts:337-341`）
- 一次性 cron 任务：唯一触发时刻已过则补一次后自删（`scheduler.ts:352-359`）

这是刻意的——补全部历史会产生一大堆过期任务堆积，且语义不明（6 天前的"检查依赖"现在跑还有意义吗）。

### 装成系统服务

不想每次开机手动 `daemon start`，装成系统服务（`src/daemon/service.ts`）：

```bash
sid-code daemon install     # macOS=launchd / Linux=systemd
sid-code daemon uninstall
```

- macOS：装一个 LaunchAgent（`service.ts:96-116`）
- Linux：装一个 systemd user service（`service.ts:163-180`）

装完开机自启，彻底无人值守。

## GitHub webhook 触发

daemon 还能接 GitHub webhook，PR 来了自动触发 code review。

### 配置

```bash
export SID_CODE_WEBHOOK_SECRET=your-hmac-secret
sid-code daemon start
```

webhook server（`src/daemon/server.ts`）默认监听 `127.0.0.1:3847`：

- `POST /webhook/github` —— 解析 PR event，验签 `x-hub-signature-256`（HMAC-SHA256，`server.ts:26-30`）
- `GET /health` —— 健康检查

::: warning 不配 secret 不监听
没有 `SID_CODE_WEBHOOK_SECRET` 且未显式开启时，daemon **不会**启动 webhook server
（`daemon.ts:204-231` 的 `maybeStartWebhook`）。这是安全默认——别让一个没鉴权的端口
能触发任意任务执行。
:::

### 触发后做什么

PR 事件进来后（`src/daemon/worker.ts:32-104` 的 `handlePR`）：

1. git clone PR 分支
2. 取 diff
3. fork `sid-code -p` 跑 code review（无头模式）

执行的子进程由 `headless-executor`（`src/daemon/headless-executor.ts`）fork，
默认只读权限（`--permission-mode plan` 或 `--allowed-tools` 白名单，`headless-executor.ts:140-150`），
超时机制是 SIGTERM → 5s 宽限 → SIGKILL（`headless-executor.ts:173-179`）。

::: danger webhook 等于交出本机执行权
webhook 触发的任务在本机跑真实命令。配置前确认：
- 端口只监听 `127.0.0.1`（默认），不要暴露到公网；要走公网用反向代理 + HTTPS + 鉴权
- secret 用强随机串
- `allowedTools` 收窄到只读，除非你真的需要它改文件
:::

## 执行细节

### 无头执行器

定时任务和 webhook 触发的任务都跑在无头模式（`src/daemon/headless-executor.ts`）：

- fork `sid-code -p --output-format json` 子进程（`headless-executor.ts:136-205`）
- 注入环境变量 `SID_DAEMON_JOB`（jobId）和 `SID_DAEMON_SOURCE`（`"schedule"` 或 `"webhook"`），任务内部能据此判断自己是不是被 daemon 触发的
- 结果落盘到 `StorageAdapter` 留审计（`headless-executor.ts:77-96`）

### 相关环境变量

| 变量 | 作用 |
| --- | --- |
| `SID_CODE_WEBHOOK_SECRET` | webhook HMAC 签名密钥，不配不监听 |
| `SID_DAEMON_JOB` | 子进程环境变量，标识 jobId |
| `SID_DAEMON_SOURCE` | 子进程环境变量，标识触发来源（`schedule` / `webhook`） |
| `SID_CONFIG_DIR` | 配置根目录覆盖（默认 `~/.sid-code`） |

## 常见问题

### durable 任务建了但没触发

三个检查点：

1. **有没有进程在驱动**——会话开着时会话驱动，关了要靠 daemon。`sid-code daemon status` 看 daemon 在不在
2. **项目级锁是不是被别的会话占着**——`<项目>/.sid-code/scheduled_tasks.lock` 存在且持有者还在跑时，别的进程不会重复触发。锁是进程级的，持有者退出自动释放
3. **cron 表达式对不对**——`/cron` 列出来看一眼，本地时间、5 字段、最小粒度 1 分钟

### daemon 启动报"已有 daemon 在跑"

单例锁 `~/.sid-code/state/daemon.lock` 没释放（上次没正常退出）。`sid-code daemon status`
看那个 pid 还活不活：活着就 `stop`，不活了就删掉 lock 文件再 start。

### 定时任务跑了一次就不跑了

看 `recurring` 是不是 `false`——一次性任务触发后自删（`scheduler.ts:213-215`）。
循环任务 7 天后也会过期自删（`types.ts:19`），这是刻意的防堆积。

### 会话里建的 durable 任务，换台机器还在吗

不在。durable 任务写在**当前项目**的 `<项目>/.sid-code/scheduled_tasks.json` 里，
跟着项目走（git 仓库），不跟着机器走。换机器要重新建，或者确保项目目录同步过去。
注册表 `~/.sid-code/state/durable-projects.json` 是机器级的，记录"这台机器上有哪些项目有 durable 任务"。

### webhook 触发的 review 能改文件吗

默认不能——`headless-executor` 默认用 `--permission-mode plan`（只读）。要让它改文件，
得在创建任务时显式放宽 `allowedTools`，并清楚这等于让 webhook 能改你的代码。
大多数场景只读 review 就够。

## 相关

- [Plan Mode 与 Todo](/use/plan-mode) —— `/goal` 是"干到达标"，`/loop` 是"按间隔重复"，两者区别
- [无头模式与脚本化](/extend/headless) —— daemon 触发的任务跑在 `-p` 无头模式
- [Dynamic Workflows](/extend/workflows) —— 无头任务里也能用 Workflow 编排
- [权限与人工确认](/use/permissions) —— `allowedTools` / `--permission-mode` 规则语法
- [环境变量](/ref/env) —— `SID_CODE_WEBHOOK_SECRET` 等完整列表
- [内置工具](/ref/tools) —— `cron_create` / `cron_list` / `cron_delete` / `schedule_wakeup` 工具定义
