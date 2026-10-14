---
title: 隐私与数据流向
description: sid-code 在本机存了什么、什么会离开这台机器、每条出网受哪个开关控制。
---

# 隐私与数据流向

**sid-code 不向维护者回传任何会话内容。** 离开这台机器的只有三类：

1. 你配置的模型请求，发往你选的 provider 或网关；
2. 下面[出网总表](#出网总表)里列出的几条默认出网，每条都写了怎么关；
3. 你显式配置的轨迹上传、遥测导出与企业后端通道。

这页是隐私问题的唯一事实源，其它页面只写一句结论并链到这里。
内容对应 v0.1.609 及之后的版本。

## 本机存了什么

全部在 `~/.sid-code/` 下（`SID_CONFIG_DIR` 可改）：

| 路径 | 内容 |
| --- | --- |
| `trajectories/sessions/<session-id>/` | 轨迹：完整请求响应（`raw.jsonl`）、工具调用、事件流、成本，详见[轨迹采集](/team/observability#落盘了什么) |
| `sessions/` | 会话历史，供 `--resume` 恢复 |
| `usage-ledger.jsonl`、`session-index.jsonl`、`cache-breaks.jsonl` | 成本账本、会话索引、缓存断裂记录 |
| `debug.log`、`logs/`、`audit.log` | 运行日志与权限审计 |
| `state/` | 迁移状态、项目信任记录、轨迹上传水位 |
| `device-id` | 本机持久随机 ID，只在你配置了上传或企业后端时随请求带出 |
| `settings.json`、`managed-settings.json` | 你的配置与企业托管配置 |
| `plugins/` | 已装插件与市场目录缓存 |

记忆文件的位置见[记忆](/use/memory)。

轨迹和会话共用一套保留策略：默认保留 **365 天**，合计超过 **10GB** 才从最旧的删，不限数量
（`sessionRetention`，见[会话管理](/use/sessions)）。

不想留轨迹：`sid-code --no-trace` 或 `trace.enabled: false`。想清掉已有的，直接删目录：

```bash
rm -rf ~/.sid-code/trajectories/sessions
```

## 出网总表

### 默认就会发生的

| 通道 | 去向 | 带什么 | 怎么关 |
| --- | --- | --- | --- |
| 模型请求 | 你配置的模型端点 | 对话内容、读到的文件、工具结果、你的 API key | 关不掉，这是工作本身；涉密场景换本地模型（见[模型配置](/start/configure)的 ollama 一节） |
| 启动预连接 | 主模型端点的同一主机，一次 `HEAD` | 不带任何内容 | 不单独提供开关：与模型请求同主机，不新增暴露面；取不到主模型地址时不连 |
| 网关定价同步 | 你的网关 `<host>/api/pricing`，`GET` | 不带 API key，不带会话数据 | 不受隐私级别控制，理由同上；关掉只会让成本估算回落内置价格表 |
| 更新检查 | `www.sid-code.cc/releases/sid-code/latest.txt`（beta 通道读 `beta.txt`），24 小时最多一次，仅交互界面 | 一次裸 `GET`，不带会话或设备数据；对方能看到 IP 与时间 | `autoUpdate: "off"`、`SID_CODE_AUTO_UPDATE=off`，或隐私级别 `essential-traffic`（见[自动更新](/use/auto-update)） |
| 外部模型目录 | `models.opencode.ai`、`catalog.stencil.so`、`cdn.jsdelivr.net`、`openrouter.ai` | `GET`，不带用户数据；对方能看到 IP 与「在用 sid-code」 | 隐私级别 `essential-traffic` |
| 官方插件市场 | `www.sid-code.cc/plugins/index.json` 及插件包 | `GET`，**永不带凭据**；交互启动时只在装了市场插件时拉目录，其余只在你运行 `/plugin` 时 | `officialMarketplace: false` 关掉官方市场。**不受隐私级别控制** |
| WebSearch | 配了 SearXNG 就发往它，否则 `duckduckgo.com` | 搜索词。搜索词由模型生成，可能夹带代码片段与路径 | 在[权限规则](/use/permissions)里禁用 WebSearch，或配自建 SearXNG（`search.searxngUrl`） |
| WebFetch | 模型要抓的 URL | URL 本身（含查询参数） | 权限规则禁用或按域名限制 |

### 只有你配置了才会发生的

| 通道 | 前提 | 带什么 | 受哪个隐私级别控制 |
| --- | --- | --- | --- |
| 轨迹上传 | `trace.upload` 同时有 `url` 与 `token` | 三个轨迹文件 + 标识字段，见[上传](#上传) | `essential-traffic` 禁用 |
| 企业事件上报 `/events` | 配了 `backend.url` | 事件元数据（含 `git_head`、仓库哈希） | `no-telemetry` 起禁用 |
| 成本账本 `/usage/ledger` | 配了 `backend.url` | 每次调用的 token 与成本 | `no-telemetry` 起禁用 |
| 远端开关 `/ctl/flags` | 配了 `backend.url` | 拉取，不上传会话数据 | `essential-traffic` 禁用 |
| 企业策略 `/ctl/policy`、预算 `/ctl/budget`、登录 | 配了 `backend.url` | 拉取策略与预算；登录交换设备凭据 | 不受控：属于企业下行管控 |
| 企业插件市场 | 配了 `backend.url` | 目录与插件包；设备凭据只发往与 `backend.url` 同源的地址 | 不受控 |
| OTLP 导出 | `telemetry.enabled` 并配了 OTLP 端点（默认关） | Span 与指标；prompt 原文默认不导出 | `no-telemetry` 起禁用 |
| 告警 webhook | 配了 webhook 地址 | 模型健康摘要（模型名、错误分型、延迟） | `essential-traffic` 禁用 |
| MCP server | 你配置的每个 server | 由 server 决定，模型调用它的工具时把参数发过去 | 不受控 |

IDE 集成与本地调试工具只连本机回环地址。

## 模型侧留存

**你的代码会不会被拿去训练，取决于你配置的 provider 或网关的政策。** sid-code 不控制它，也不替你承诺。
模型请求里就是你要它处理的内容：读到的文件、命令输出、你的提问。

需要内容完全不离开本机时，用本地模型（如 ollama），配法见[模型配置](/start/configure)。

## 三个隐私级别

用环境变量或 `settings.json` 的 `analytics.privacy_level` 设置。环境变量优先，多个信号时取最严的：

```json
{
  "analytics": { "privacy_level": "essential-traffic" }
}
```

| 级别 | 怎么开 | 在上一级基础上额外关掉 |
| --- | --- | --- |
| `default` | 默认 | — |
| `no-telemetry` | `SID_CODE_DISABLE_TELEMETRY=1` | 企业事件上报、成本账本远程上报、OTLP 导出、内容级 tracing |
| `essential-traffic` | `SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | 轨迹上传（含手动 `--upload-traces`）、更新检查、外部模型目录同步、远端开关拉取、告警 webhook |

`essential-traffic` 下**刻意保留**的出网：

- 模型请求、启动预连接、网关定价同步：都只连你自己配置的模型端点，关掉不减少暴露面；
- 企业策略、预算与登录：企业下行管控，关掉等于绕过管理员；
- WebSearch、WebFetch、MCP：模型调用工具时才发生，用[权限规则](/use/permissions)管；
- 插件市场：交互启动时会对已装插件所在的市场拉一次目录（带 ETag），目前不随隐私级别关闭。
  不想要这条，关掉官方市场（`officialMarketplace: false`）或不装市场插件。

切到 `essential-traffic` 期间产生的会话不会登记到上传目标，切回 `default` 后也不会被补传。

## 脱敏

**作用于落盘，不作用于模型上下文。** 模型看到的是工具的原始输出；写进磁盘（以及随后上传）的内容会先过一遍脱敏。

覆盖的文件：轨迹目录里的 `session.traj`、`raw.jsonl`、`events.jsonl`、`errors.jsonl`、`messages.json`、
`session-summary.json`，以及主日志、`warn.log`、协议异常快照 `protocol-violations/`。

识别的类别：

- 云厂商密钥：AWS（Access Key 与 Secret Key）、阿里云、腾讯云；
- 模型 API key：Anthropic、OpenAI（含 `sk-proj-` 等新格式）；
- 代码托管与包管理 token：GitHub（含 fine-grained `github_pat_`）、GitLab、Slack、npm；
- 鉴权写法：`Bearer`、`Basic`、JWT、`x-api-key:` 这类请求头、`*_API_KEY=` / `*_TOKEN=` 这类赋值、密码赋值、数据库连接串里的密码；
- PEM 私钥：整块遮掉，被截断、没有结束行的也遮；
- 信用卡号（过 Luhn 校验）。

赋值类规则只遮字面量值：`API_KEY = process.env.X` 这类表达式和 `your-key-here` 这类占位不会被改写。

**不处理的：** 邮箱、手机号、身份证号等个人信息，以及代码原文。
`raw.jsonl` 默认存完整请求响应，设 `SID_CODE_TRACE_NO_RAW=1` 可以不记原文（只留计数行）。

**出错时：** 某个字段脱敏出错，只把这一个字段换成 `[REDACTION_FAILED]` 并告警，其余照常落盘；不会回落写原文。

## 上传

默认不上传。`trace.upload` 同时有 `url` 和 `token` 才会上传，地址只发往你配置的那一个。

传什么：

- 三个文件：`session.traj`、`raw.jsonl`、`events.jsonl`（已脱敏的落盘字节，默认 gzip）；
- 表单字段：`session_id`、`file_type`、`tool_source`，可选 `user_id`、`device_id`；
- `session.traj` 里带 `working_directory`（绝对路径，通常含用户名）、`device_id`、`user_id`、`org_id`、`team_id`、`git_head`。

想把路径里的家目录换成 `~`，打开 `trace.upload.redact_home_dir: true`（默认关）。
它只改上传的字节和 OTLP 的 `sidcode.cwd`，本地文件不变；相对路径结构保留，不做哈希。

什么时候传：

- 会话结束时（`auto_upload: true`，默认）；
- 启动时补传：**只补配置上传之后产生的会话**，按会话创建时间判断，每次启动最多 20 个。
  每个上传地址单独计算起点，换了地址不会把旧历史发往新地址；
- 运行 `/debug` 时立即上传当前会话快照（只在配了上传时）；
- 手动 `sid-code --upload-traces`。配置上传之前的历史要加 `--include-history`，执行前会列出会话数与时间范围。

## 安装链路

官方安装脚本做两件事：下载二进制，以及在 `~/.sid-code/settings.json` **不存在时**下载
团队默认配置 `team-defaults.json` 写成你的 `settings.json`。已有 `settings.json` 时不覆盖；
想跳过，安装前先放一份自己的 `settings.json`。

这份默认配置不含任何上传设置，会影响数据去向的只有 `availableModels` 里各模型的 `baseURL`（即你的模型请求发往哪里）。
详见[团队默认配置](/team/defaults)。

## 在陌生仓库里运行

克隆来的仓库能影响 sid-code 的范围：

- **运行目录里的 `.env`、`.env.*`、`bunfig.toml` 不会被读取**（发布的二进制在编译时关掉了自动加载）。
  目录里有含 `SID_CODE_*` 或 `*_API_KEY` 的 `.env` 时会提示一行，只列键名。
  从源码运行（`bun <entry>.ts`）不在此保证内；
- 项目级 `.sid-code/settings.json` 不能设置上传地址、模型端点这类外发字段；
- 项目级 hooks、MCP 与非白名单环境变量要先通过[工作区信任](/use/permissions)才生效。

## 企业与团队

**管理员能看到什么：** 只有你配置了上传或企业后端，平台才收得到数据；收到的轨迹是本机脱敏后的版本。

**管理员能锁定什么：** 没有专门的「禁止上传」字段，但可以用系统级托管配置强制隐私级别。
托管配置里的 `env` 在启动时写入进程环境，而环境变量是隐私级别里优先级最高的信号，用户的 `settings.json` 放不开它：

```json
{
  "env": { "SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1" }
}
```

放在系统级路径才算锁定，普通用户改不了：macOS `/Library/Application Support/SidCode/managed-settings.json`，
Linux `/etc/sid-code/managed-settings.json`。`~/.sid-code/managed-settings.json` 用户自己能改，只能算默认值。
其余托管能力见[企业策略](/team/policy)。

## 常见问题

### 会不会把我的代码传出去

会发给你配置的模型端点，这是它工作的方式。除此之外，只有你配置了轨迹上传，代码内容才会随 `raw.jsonl` 发往你配置的平台。
不想让原文进轨迹：`SID_CODE_TRACE_NO_RAW=1`。

### 怎么彻底离线

本地模型 + `SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` + 不装市场插件，并在权限规则里禁用 WebSearch 与 WebFetch。
网关定价同步和预连接只连你的本地模型地址。

### 怎么确认没有上传

```bash
grep -A4 '"upload"' ~/.sid-code/settings.json   # 没有输出 = 没配上传
```

会话里运行 `/debug`，没配上传时显示「上传未配置（仅本地保留）」。
已上传的会话目录里会有 `.uploaded` 标记文件。
