---
title: 定时与无人值守
description: 会话内 /loop、跨会话 durable 定时任务、daemon 常驻守护、GitHub webhook 触发——整条无人值守链路。
---

# 定时与无人值守

sid-code 的定时体系由两个正交的问题组成，三种都已实现：

| 问题 | 选项 | 说明 |
| --- | --- | --- |
| 任务活多久 | 会话级（`/loop`、`schedule_wakeup`、`cron_create` 默认） | 只活在当前会话进程的内存里，会话关了就没了 |
| | durable（`cron_create(durable:true)`） | 写进 `<项目>/.sid-code/scheduled_tasks.json`，跨会话存活 |
| 没人开会话时谁来触发 | daemon（`sid-code daemon start` / `install`） | 常驻进程，驱动本机所有项目的 durable 任务，也接 GitHub webhook |

durable 是**数据**，daemon 是**驱动者**，两者是组合关系：durable 任务会话开着时由会话触发，
会话关了由 daemon 触发；两者都不在，任务只是躺在盘上，到点不会执行。
**云端 Routines 不做**——没有云端基建，只做本地这条链路。

读完这页你能做到：知道三种模式什么时候用哪个、durable 任务怎么跨会话不死、
daemon 怎么装成系统服务、GitHub PR 怎么自动触发 code review。

## 快速上手：会话内定时

最简单的是 `/loop`，只在当前会话里有效，关了会话就没了：

```text
/loop 每 5 分钟检查一次 CI 有没有过
```

`/loop` 是用户入口（`packages/cli/src/command/commands/loop/loop.ts`），它会把你的意图翻译成
底层操作——固定间隔转成 cron 表达式建任务，或者引导模型用 `schedule_wakeup` 自适应轮询。

::: tip `/loop` 和 `/goal` 不一样
`/loop` 是"按固定间隔重复跑同一件事"，`/goal` 是"干到达标为止"。两者都涉及多次执行，
但终止条件不同：`/loop` 靠你取消或任务完成，`/goal` 靠评估模型按证据判定。见
[Plan Mode 与 Todo](/use/plan-mode) 的 `/goal` 章节。
:::

## 跨会话：durable 定时任务

会话内的任务会随会话结束消失。要让定时任务**跨会话存活**，用 `durable: true`：

```text
帮我建一个每天 9 点跑的定时任务：检查依赖有没有新版本，durable
```

模型会调 `cron_create` 工具（`packages/core/src/tool/cron-create.ts`），参数：

| 参数 | 作用 |
| --- | --- |
| `cron` | 5 字段 cron 表达式（分 时 日 月 周），**本地时间**，最小粒度 1 分钟 |
| `prompt` | 触发时跑的指令 |
| `recurring` | `true`（默认）= 循环触发；`false` = 触发一次后自删。会话级循环任务 **7 天后自动过期**，durable 循环任务**不过期**，只能手动删除 |
| `durable` | `false`（默认）= 会话级，只活在内存；`true` = 写盘，跨会话存活 |
| `allowed_tools` | 无头执行时预授权的工具白名单（可选，仅 durable 任务有意义；缺省 = 只读）。磁盘上存为 `allowedTools` |

durable 任务写盘到 `<项目>/.sid-code/scheduled_tasks.json`，同时在
`~/.sid-code/state/durable-projects.json` 登记这个项目，让 daemon 能发现它
（都在 `Scheduler.addDurableTask` 里，`packages/core/src/cron/scheduler.ts`）。写盘失败工具会如实报错，
不会回「已创建」。成功时工具结果里会写明**到点由谁触发**：

```text
已创建一次性任务，已写入 /path/to/proj/.sid-code/scheduled_tasks.json，ID: 56af2fde
cron: 12 14 03 10 *
预授权工具: bash, read
触发方: 同项目的另一个会话。它关闭后需运行 `sid-code daemon start`（或 `sid-code daemon install`）才会继续执行
```

触发方有四种：本机守护进程 / 当前会话 / 同项目的另一个会话 / 暂无（到点不会执行）。

::: warning durable 任务只认本机创建的
任务文件在项目目录里，可能随 `git pull` 进来，也可能被项目里任何脚本改写。所以创建时会把任务内容
（prompt、cron、工作目录、`allowedTools`）的指纹记进 `~/.sid-code/state/durable-task-grants.json`，
驱动者触发前比对：**不是本机建的、或建完被改过的任务一律不执行**，只在日志里告警一次
（`packages/core/src/cron/durable-grants.ts`）。确认无误的话，在该项目里 `cron_delete` 后重新创建。
:::

### cron 表达式格式

5 字段：分 时 日 月 周。支持的语法（`packages/core/src/cron/parser.ts`）：

- `*` 任意值；`N` 具体值；`a-b` 范围；`a,b,c` 列表；`*/N` 步进
- 周字段 0–6（0=周日），7 也接受
- 日和周是**"或"语义**——任一匹配即触发（`parser.ts`）
- 确定性抖动：基于 taskId 哈希，最多偏移周期的 10%（上限 15 分钟），避免一堆任务整点同时触发

### 一次性提醒 vs 固定重复 vs 自适应轮询

三种形态，对应不同工具：

| 形态 | 怎么做 | 例子 |
| --- | --- | --- |
| 一次性提醒 | `cron_create(recurring:false)`，cron 定到具体时刻，触发后自删 | "3 点提醒我看部署" |
| 固定间隔重复 | `cron_create(recurring:true)`，循环 cron，7 天后过期 | "每 5 分钟查一次 CI" |
| 自适应轮询 | `schedule_wakeup(delaySeconds)`，模型自选下次延迟 [60,3600]s，目标达成后停止 | "等 CI 过了告诉我" |

`schedule_wakeup`（`packages/core/src/tool/schedule-wakeup.ts`）用绝对触发时刻 `fireAt`，
一次性。模型每轮检查后自己决定下次多久再来——CI 还没过就 5 分钟后，快了就 1 分钟后，
过了就不再安排。**不会无限轮询**——目标达成即停。

### `/cron` 斜杠命令：管理面板

查看和删除定时任务用 `/cron`（别名 `/schedule`，`packages/cli/src/command/advanced.ts`）：

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
会话关了就需要 daemon。`-p` 无头会话（包括 daemon 自己 fork 出来的子进程）不会驱动
durable 任务——它没有把提示词送进主循环的能力，抢到驱动权只会把任务认领掉却执行不了。

### 启动与子命令

```bash
sid-code daemon start     # 前台启动
sid-code daemon status    # 看 pid / 启动时间 / 版本
sid-code daemon stop      # 发 SIGTERM 优雅停机
sid-code daemon restart   # stop + 1s 等待 + start
sid-code daemon logs      # 看 ~/.sid-code/logs/daemon.log
```

`start` / `restart` 的选项（`packages/cli/src/command/daemon-args.ts`）：

| 选项 | 作用 |
| --- | --- |
| `--interval <ms>` | 调度检查间隔，默认 60000 |
| `--max-concurrent <n>` | 同时跑的无头 job 上限，默认 3 |
| `--allowed-tools <a,b>` | 全局兜底工具白名单：durable 任务没声明 `allowed_tools` 时用它，**webhook job 一律用它** |
| `--webhook` | 显式开 webhook 源（不传时：设了 `SID_CODE_WEBHOOK_SECRET` 就开） |

### daemon 启动后做什么

| 步骤 | 说明 | 证据 |
| --- | --- | --- |
| 抢单例锁 | `~/.sid-code/state/daemon.lock`，同机器只跑一个 daemon | `packages/core/src/daemon/daemon.ts`、`packages/core/src/daemon/lock.ts` |
| 注册会话 | `/ps` 能看到 daemon 在跑 | `daemon.ts` |
| 启动调度器 | `daemonMode: true`，**每 60 秒**检查一次到点任务 | `daemon.ts`，默认 `checkIntervalMs = 60_000` |
| 可选 webhook | 配了 `SID_CODE_WEBHOOK_SECRET` 才监听；`--webhook` 显式开但没 secret 时不启动（所有请求都会 401） | `daemon.ts` 的 `maybeStartWebhook` |
| 保活心跳 | 每 60s 空转 timer | `daemon.ts` |
| 信号处理 | SIGINT/SIGTERM 优雅停机 | `daemon.ts` |

### 跨项目发现 durable 任务

daemon 不只看当前项目，而是读 `~/.sid-code/state/durable-projects.json` 注册表，
**跨所有项目**加载 durable 任务，并且**每一轮检查都重读**注册表和各项目的任务文件——
daemon 运行期间新建 / 删除的任务，下一轮就生效，不用重启 daemon。
注册表会自愈——项目目录或任务文件不在了就自动剔除（`durable-projects.ts` 的 `listDurableProjects`）。

### 会话与 daemon 谁来驱动

**谁能写**和**谁来触发**是分开的：

- **写**：任何会话都能创建 / 删除 durable 任务，不管它是不是驱动者。写盘是
  「文件互斥 → 读最新磁盘 → 改 → 原子写」（`packages/core/src/cron/durable-store.ts`），
  多个会话和 daemon 同时写也不会互相吞任务
- **触发**：同一项目只有一个驱动者。daemon 在场时是 daemon；否则是抢到**项目级调度锁**
  （`<项目>/.sid-code/scheduled_tasks.lock`，`packages/core/src/cron/lock.ts`）的那个交互会话。
  驱动者身份**每轮重新判定**：daemon 起来，会话下一轮让出；daemon 停了，会话下一轮接回
- **认领**：触发前先在磁盘上认领（比对 `lastFiredAt`，一次性任务认领即删除）。
  交接窗口里两边都认为任务到期，也只有一方能触发

两把锁不同层级：项目级锁防同项目多会话重复触发，daemon 单例锁防同机器跑多个 daemon。
两把锁都按 PID 探活，持有者死了的残留锁会被自动回收。

### catch-up：只补最近一次

daemon 睡了几天醒来，错过的任务怎么补？**只补最近一次**，不补全部历史
（`packages/core/src/cron/parser.ts` 注释明确："日任务睡 6 天醒来只补 1 次——丢弃更早的所有错过时刻"）：

- `recurring` durable 任务：`computeLatestMissedRun(lastFiredAt, now)` 取最后一个触发点补一次（`scheduler.ts`）
- 一次性 `fireAt` 任务：错过即触发（`scheduler.ts`）
- 一次性 cron 任务：唯一触发时刻已过则补一次后自删（`scheduler.ts`）

这是刻意的——补全部历史会产生一大堆过期任务堆积，且语义不明（6 天前的"检查依赖"现在跑还有意义吗）。

### 装成系统服务

不想每次开机手动 `daemon start`，装成系统服务（`packages/core/src/daemon/service.ts`）：

```bash
sid-code daemon install     # macOS=launchd / Linux=systemd
sid-code daemon uninstall
```

- macOS：装一个 LaunchAgent（`service.ts`）
- Linux：装一个 systemd user service（`service.ts`）

装完开机自启，彻底无人值守。

## GitHub webhook 触发

daemon 还能接 GitHub webhook，PR 来了自动触发 code review。

### 配置

```bash
export SID_CODE_WEBHOOK_SECRET=your-hmac-secret
sid-code daemon start
```

webhook server（`packages/core/src/daemon/server.ts`）默认监听 `127.0.0.1:3847`：

- `POST /webhook/github` —— 解析 PR event，验签 `x-hub-signature-256`（HMAC-SHA256，`server.ts`）
- `GET /health` —— 健康检查

::: warning 不配 secret 不监听
没有 `SID_CODE_WEBHOOK_SECRET` 且未显式开启时，daemon **不会**启动 webhook server
（`daemon.ts` 的 `maybeStartWebhook`）。这是安全默认——别让一个没鉴权的端口
能触发任意任务执行。
:::

### 触发后做什么

签名不对（含缺失）返回 401，签名对但 body 不是 JSON 返回 400，非 `pull_request` 事件忽略，
`opened` / `synchronize` / `reopened` 之外的 action 忽略，并发满了返回 429，接受返回 202。

PR 事件进来后（`packages/core/src/daemon/worker.ts` 的 `handlePR`）：

1. 克隆 PR 分支到 `~/.sid-code/state/daemon-workspaces/` 下的临时目录（`--filter=blob:none`：
   完整提交历史、按需取文件。不能用浅克隆，否则下一步找不到 merge-base）
2. fetch base 分支，取 `git diff origin/<base>...HEAD`（只含 PR 自己的改动）
3. fork `sid-code -p` 跑 code review（无头模式），跑完删掉临时目录

执行的子进程由 `headless-executor`（`packages/core/src/daemon/headless-executor.ts`）fork，
默认只读权限（没有白名单时 `--permission-mode plan`，有则 `--allowed-tools`），
超时机制是 SIGTERM → 5s 宽限 → SIGKILL。

::: tip 不接 GitHub 也能本地验证
```bash
export SID_CODE_WEBHOOK_SECRET=local-test
sid-code daemon start &
SIG=$(openssl dgst -sha256 -hmac "$SID_CODE_WEBHOOK_SECRET" -r pr.json | cut -d' ' -f1)
curl -X POST http://127.0.0.1:3847/webhook/github \
  -H "x-github-event: pull_request" -H "x-hub-signature-256: sha256=$SIG" --data-binary @pr.json
```
`pr.json` 里的 `repository.owner.login` / `repository.name` / `pull_request.head.ref` 要指向一个
**真实可克隆**的仓库和分支，否则克隆失败，job 记为 error，不会 fork 子进程。
:::

::: danger webhook 等于交出本机执行权
webhook 触发的任务在本机跑真实命令。配置前确认：
- 端口只监听 `127.0.0.1`（默认），不要暴露到公网；要走公网用反向代理 + HTTPS + 鉴权
- secret 用强随机串
- `--allowed-tools` 不传（只读），除非你真的需要它改文件——webhook 的 PR 内容来自外部，
  放开写工具等于让 PR 作者能在你机器上改文件
:::

## 执行细节

### 无头执行器

定时任务和 webhook 触发的任务都跑在无头模式（`packages/core/src/daemon/headless-executor.ts`）：

- fork `sid-code -p --output-format json` 子进程，prompt 经 **stdin** 传入（webhook 的 prompt
  里嵌了整个 PR diff，走 argv 会撞上系统参数长度上限）
- 无头模式下日志一律走 stderr，stdout 只有结果 JSON，落盘的 job 输出就是模型的最终答复
- 注入环境变量 `SID_DAEMON_JOB`（jobId）和 `SID_DAEMON_SOURCE`（`"schedule"` 或 `"webhook"`），任务内部能据此判断自己是不是被 daemon 触发的
- 结果落盘到 `StorageAdapter` 留审计（`headless-executor.ts`）

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

1. **有没有进程在驱动**——创建时工具结果的「触发方」一行写了答案。会话开着时会话驱动（`-p` 会话不算），关了要靠 daemon。`sid-code daemon status` 看 daemon 在不在
2. **是不是被当成未授权任务跳过了**——`sid-code daemon logs` 里有「跳过未授权的 durable 任务」就是这个。任务文件被手改过、或是从别处同步来的，删掉重建
3. **cron 表达式对不对**——`/cron` 列出来看一眼，本地时间、5 字段、最小粒度 1 分钟

### daemon 启动报"已有守护进程在运行"

报这句时持有锁的进程一定还活着——上次被 `kill -9` 或崩溃留下的锁会被按 PID 探活自动回收，
不用手删 `~/.sid-code/state/daemon.lock`。`sid-code daemon status` 看 pid，确认是旧实例就
`sid-code daemon stop`。

### 定时任务跑了一次就不跑了

看 `recurring` 是不是 `false`——一次性任务触发后自删。
会话级循环任务 7 天后也会过期自删（`types.ts` 的 `maxAgeDays`），这是刻意的防堆积；
durable 循环任务不过期。

### 会话里建的 durable 任务，换台机器还在吗

不在。durable 任务写在项目目录下的 `<项目>/.sid-code/scheduled_tasks.json`，
`.sid-code/` 惯例被 gitignore，默认不入库。就算你把文件同步到另一台机器，那边也不会执行它——
本机授权（`~/.sid-code/state/durable-task-grants.json`）是机器级的，换机器要重新建。
注册表 `~/.sid-code/state/durable-projects.json` 同样是机器级的，记录"这台机器上有哪些项目有 durable 任务"。

### webhook 触发的 review 能改文件吗

默认不能——没有白名单时 `headless-executor` 用 `--permission-mode plan`（只读）。
webhook job 用的是 daemon 启动时的全局 `--allowed-tools`（`sid-code daemon start --allowed-tools read,grep`）；
`cron_create` 的 `allowed_tools` 只作用于那一个 durable 定时任务，管不到 webhook。
放开写工具等于让 PR 作者能在你机器上改文件，大多数场景只读 review 就够。

## 相关

- [Plan Mode 与 Todo](/use/plan-mode) —— `/goal` 是"干到达标"，`/loop` 是"按间隔重复"，两者区别
- [无头模式与脚本化](/extend/headless) —— daemon 触发的任务跑在 `-p` 无头模式
- [Dynamic Workflows](/extend/workflows) —— 无头任务里也能用 Workflow 编排
- [权限与人工确认](/use/permissions) —— `allowedTools` / `--permission-mode` 规则语法
- [环境变量](/ref/env) —— `SID_CODE_WEBHOOK_SECRET` 等完整列表
- [内置工具](/ref/tools) —— `cron_create` / `cron_list` / `cron_delete` / `schedule_wakeup` 工具定义
