---
title: 轨迹采集与可观测
description: 每次会话落盘了什么、能回答什么问题、怎么用一条命令做事后诊断、怎么聚合到团队。
---

# 轨迹采集与可观测

每次会话结束，sid-code 都在本地留了一份完整档案：每次 API 的原始请求响应、
每个工具调用、每个决策节点、每一分钱。**默认就开着**，不需要配置。

这页讲这些数据在哪、怎么读、以及怎么汇总到团队维度。

::: tip 为什么这件事是地基
轨迹是"更快、更省"这两个方向唯一的度量来源。没有它，"这次改动省了多少 token"
就只能靠感觉。比如 deepseek 前缀断裂修复后缓存命中率 0 → 46.6% → 83.2%（见[博客](/blog/sc-21-provider#_8-7-一个真实的从-0-到-83-的修复)），
全部是从这些文件里算出来的。
:::

## 快速上手

会话里想立刻看当前这一轮的调用结构，不用翻文件：

```text
/telemetry
```

它会即时显示当前会话的 **Span 树 + Metric 汇总**（内存数据）。前提是开了 `telemetry.enabled`（默认关，
开法见下文[开启完整遥测](#开启完整遥测与-perfetto-导出)），没开时它只提示「遥测未启用」。

想知道刚才（或更早）那次会话到底发生了什么，用一条命令读落盘轨迹：

```bash
bun scripts/trace-digest.ts <session-id>
```

session id 在会话摘要里（形如 `20261002-213607-09e2f678`），或者直接取最新一个：

```bash
ls -1t ~/.sid-code/trajectories/sessions | head -1
```

真实输出（节选，一个撞了轮次上限的会话）：

```text
━━━ session 20261002-213607-09e2f678  [max_turns] ━━━
  模型 glm-5.2   API 5 次   步骤 9   耗时 44.3s   成本 $0.1112   tok 252742↑/908↓

用户意图:
  1. 分析 /tmp/b26e2e/calc.ts，给出语言与顶层函数个数。

L0 事实层 (1) — 机器可验证,带出处,不含判断:
  [中] exit_status_max_turns: exit_status = "max_turns"（轮次预算耗尽，非用户中断）
        ⊢ 出处: .../session.traj @metadata.exit_status = max_turns
        → 看: 工具序列（看它这些轮次花在哪 —— 撞顶本身不说明题难）

L1 假设层 (0) — 待验证,先消解证伪条件再采信:
  (无)

工具序列 (4 次调用):
  · read file_path=/tmp/b26e2e/calc.ts
  · StructuredOutput {language,functionCount}
  · read file_path=/tmp/b26e2e/calc.ts
  · StructuredOutput {language,functionCount}

崩溃归因 (messages.json):
  {"abnormal":true,"reason":"exit","exit_status":"max_turns","api_calls":5,"last_tool":"StructuredOutput",...}

Provider 健康:
  openai       请求:5 成功率:100% 整轮均耗:4.9s TTFT(首内容)P50=5.3s 生成P50=1.2s
               └ TTFT 命中:3.1s(n=3) 未命中:5.3s(n=2)  提速 2.2s
               └ glm-5.2 n=5 TTFT P50=5.3s TTFB P50=5.3s 缓冲 1%
```

值得注意的是这个工具的输出结构：**L0 事实层带出处、L1 假设层带证伪条件**。
它不直接告诉你"结论是 X"，而是给出可验证的事实 + 待验证的假设 + 推翻假设的条件。
用法是三步：先信 L0（每条都能顺着出处回到源字段复核）；L1 里的每条假设，先按它给的证伪条件去查，
推翻不了才采信；最后用工具序列和归因核对。

上面这例 L0 只给了一条事实「撞了轮次上限」，并且直接提示别把它读成"题太难"——
看工具序列就清楚：`read` → `StructuredOutput` 这对动作做了两遍，轮次花在了重复提交上，
`messages.json` 的归因（`exit_status=max_turns`、`last_tool=StructuredOutput`）与之一致。
这里没有假设要验证，所以 L1 是空的；有异常终止时，假设和它的证伪条件会出现在那一层。

`TTFT(首内容)P50=5.3s` 这行是延迟优化的直接依据。TTFT 计的是**首个任意内容 chunk**（含 thinking / tool_use），
不是首字节（TTFB）——首字节受网关缓冲策略影响，跨路由不可比。

## 落盘了什么

一次会话一个目录：`~/.sid-code/trajectories/sessions/<session-id>/`。
目录名是 `<日期>-<时间>-<随机后缀>`。真实的一个目录：

```text
-rw-r--r--  104B  audit_range.json
-rw-r--r--   11K  events.jsonl
-rw-r--r--  8.6K  messages.json
-rw-r--r--  408B  metadata.json
-rw-r--r--  339B  raw_preview.jsonl
-rw-r--r--  115K  raw.jsonl
-rw-r--r--  514B  session-summary.json
-rw-r--r--   71K  session.traj
-rw-r--r--  3.6K  warn.log
```

| 文件 | 内容 | 什么时候看它 |
| --- | --- | --- |
| `metadata.json` | 一行式总账：模型、起止时间、步骤数、API 次数、token、成本、退出状态、用过的工具、改过的文件 | 想快速知道"这次花了多少、干了什么" |
| `session-summary.json` | 结构化摘要：轮数、异常计数与分类、真实错误数、top 工具、是否用了子代理 | 批量筛"哪些会话不正常" |
| `session.traj` | 完整 TAO 步骤 + history + metadata | 回溯全过程、做 SFT 训练数据 |
| `raw.jsonl` | **逐次 API 的 request / response / usage / stop_reason** | 排查协议或参数问题——这是唯一能看到真实报文的地方 |
| `events.jsonl` | 事件流，每行一个事件 | 分析决策链、统计防线触发 |
| `messages.json` | 崩溃验尸快照，含 attribution 归因 | 会话异常终止后查死因 |
| `warn.log` | 本次会话的告警 | 有静默失效的配置时 |

`raw.jsonl` 通常是最大的那个文件（这例 115K），因为它存全量报文。

`events.jsonl` 的事件类型分布（某个简单会话的实际统计）：

```text
StreamPhase: 16      BeforeModel: 3       GatewayPricingSync: 3
HttpConnected: 3     RetryTelemetry: 3    AfterModelRaw: 3
AfterModel: 3        PreToolUse: 2        PostToolUse: 2
LoopTransition: 2    SessionEnd: 2        SessionStart: 1
UserPromptSubmit: 1
```

这些名字与 [Hook 事件](/ref/hooks)同源——**你能挂 hook 的地方，基本就是轨迹能看到的地方**。
所以「hook 没触发」这类问题可以直接在 `events.jsonl` 里对证。

### 本地保留多少

默认**不限数量**，和会话共用一套保留策略（`sessionRetention`，见[会话](/use/sessions)）：

| 规则 | 默认 | 说明 |
| --- | --- | --- |
| 按时间 | 365 天 | `sessionRetention.maxAge`，超期的轨迹目录在启动期清理 |
| 按体积 | 10GB | `sessionRetention.maxTotalSize`，`trajectories/sessions/` 合计超了才从最旧的删 |
| 保护窗口 | 1 天 | `sessionRetention.minRetention`，窗口内更新过的目录不删 |
| 按数量 | 不限 | `trace.maxSessionsRetained`，想限再写 |

清理有两个偏向：**优先删已上传的**（数据已在远端），未上传的即使更旧也尽量留
（看 `.uploaded` 标记）；**正在被别的 sid-code 进程写的会话不删**，宁可暂时超限。
`sessionRetention.enabled: false` 时轨迹也不按时间和体积删。

参考量级：实测本机 100 个会话目录合计约 37MB（单个 p50 24KB、p95 1.3MB），
一天几十个会话一年也是 GB 级，碰不到 10GB。成本、缓存命中这类长期指标读的是
`usage-ledger.jsonl` 与 `session-index.jsonl`，不随轨迹目录清理消失。

## 关掉与打开

采集默认启用，轨迹写在本机 `~/.sid-code/trajectories/`。关掉：

```bash
sid-code --no-trace
```

**上传默认不发生，必须手动打开**——`trace.upload` 里同时有 `url` 和 `token` 才会上传，
缺任何一个就只在本地存（`packages/core/src/query/init-helpers.ts` 的 `initTraceCollector`）。
代码里不硬编码任何上传地址，官网安装拿到的[团队默认模板](/team/defaults)也只带
`"trace": { "enabled": true }`，不含上传配置。

::: warning 2026-10 之前装过的用户请自查一次
旧版团队模板曾带着一段指向 `www.sid-code.cc/traj` 的 `trace.upload`，
经官网安装或启动补全写进了 `~/.sid-code/settings.json`。新版启动时会自动移除这一段
（只认旧模板那一对 url + token，你自己配的上传不受影响），并在终端打一行提示。
想确认现状：

```bash
grep -A4 '"upload"' ~/.sid-code/settings.json   # 没有输出 = 不上传
```
:::

## 上传到你自己的轨迹平台

### 三种打开方式

按「持久 → 临时」排，优先级从低到高（后者覆盖前者）：

| 方式 | 写法 | 适合 |
| --- | --- | --- |
| 用户配置 | `~/.sid-code/settings.json` 的 `trace.upload` | 自己的开发机、长期开着 |
| 环境变量 | `SID_CODE_TRACE=1` + `SID_CODE_TRACE_UPLOAD_TOKEN`（+ 可选 `SID_CODE_TRACE_UPLOAD_URL`） | CI、容器、临时一台机器 |
| 命令行 | `--trace-upload-url <url> --trace-upload-token <tok>` | 单次会话 |

**上传地址缺省取 `backend.url`**：已经配了企业后端地址的，只需要再配 token，
不用把同一个地址抄第二遍。显式写了 `trace.upload.url` 仍以它为准；它和 `backend.url`
不一致时启动会告警一次（轨迹和控制面数据会落到两个后端）。token 始终单独配置，
上传端点用的是共享 `X-Upload-Token`，不是设备凭据。

环境变量那行：不设 `SID_CODE_TRACE=1` 时整组被忽略，仍按 settings.json 走；
设了 `SID_CODE_TRACE=1` 但没给 TOKEN，会把 settings.json 里的上传配置**覆盖成空**
（环境变量那层整块替换 `trace`，不是按字段合并）。

**项目级 `.sid-code/settings.json` 里写 `trace` 不生效**：项目配置只放行界面与行为类字段，
不放行任何外发地址——否则克隆一个仓库就可能把你的轨迹改道到别人的服务器。

### 配置示例

```json
{
  "trace": {
    "enabled": true,
    "upload": {
      "url": "https://your-platform.example.com/traj",
      "token": "${TRAJ_UPLOAD_TOKEN}",
      "auto_upload": true,
      "delete_after_upload": false,
      "compress": true,
      "user_id": "zhangsan",
      "tool_source": "sid-code"
    }
  }
}
```

`url` 要**含路径前缀**（如 `/traj`），上传器会在后面拼 `/api/v1/upload/session-file`。
上传到企业后端时可以整行不写，地址会取 `backend.url`。

::: warning token 别写明文，也别全员共用一个
用 `${TRAJ_UPLOAD_TOKEN}` 占位符，值放环境变量。更要紧的是**别把上传配置塞进分发给别人的
[团队默认配置](/team/defaults)**：那份文件全团队都能 `curl` 到，一旦挂到公网安装链路，
每个装了的人都会把轨迹传给你，而且没有任何报错提醒他们。团队要集中收轨迹，
让每个人在自己的 settings.json 里填，最好一人一个 token。
:::

### 开关与字段

下表各项彼此**独立**，别混为一谈：

| 字段 | 控制什么 | 默认 |
| --- | --- | --- |
| `trace.enabled` | 是否采集（关了就什么都不落盘，也就无从上传） | `true` |
| `trace.upload.url` + `token` | 是否具备上传能力（两个都有才算配置；`url` 缺省取 `backend.url`） | 未配置 |
| `trace.upload.auto_upload` | `true`：会话结束自动传 + 启动时补传历史未传会话；`false`：只在本地留，等你手动 `--upload-traces` | `true` |
| `trace.upload.delete_after_upload` | 传完删本地数据文件（保留 metadata 快照） | `false` |
| `trace.upload.compress` | gzip 压缩后上传 | `true` |
| `trace.upload.user_id` / `device_id` | 团队聚合的分组键，多人传到同一平台时区分来源 | `device_id` 缺省用本机持久 id |
| `trace.upload.tool_source` | 来源标识 | `"sid-code"` |
| `trace.upload.max_retries` | 单文件总尝试次数 | `5` |

另有三道**强制关闭**，都覆盖上面的配置：

- `--trace-upload-disabled`：本次会话不上传（采集照常）。
- `--no-trace`：连采集一起关。
- `SID_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（或 `analytics.privacy_level: "essential-traffic"`）：
  隐私级别最严档，轨迹上传与其它非必要外发一起禁用，只在本地留存。

### 上传的实际形态

`POST <url>/api/v1/upload/session-file`，`multipart/form-data`：

- 鉴权头 `X-Upload-Token`，完整性头 `X-Content-SHA256`
- 默认 gzip level 6 压缩，`Content-Type: application/gzip`
- 表单字段：`file` / `session_id` / `file_type` / `tool_source`，可选 `user_id` / `device_id`
- 30 秒超时；失败最多尝试 5 次，间隔指数退避 2s→4s→8s→16s（最后一次失败后不再等待）
- 服务端返回非空 `sha256` 时会做二次校验，不一致算失败重试
- `auto_upload: true` 时另有两个后台动作：每 60 秒探一次 `<url>/api/v1/health`，
  每 5 分钟扫一次重试队列；启动时补传最多 20 个缺 `.uploaded` 标记的历史会话

失败的进持久化重试队列。手动补传（`auto_upload: false` 时这是唯一的上传入口）：

```bash
sid-code --upload-traces
```

## 能回答什么问题


按你实际想知道的事分：

| 问题 | 看哪里 |
| --- | --- |
| 这次花了多少钱、缓存命中多少 | `/cost` 或会话摘要（[成本与用量](/use/cost)） |
| 首字延迟多少、哪个 provider 慢 | `trace-digest` 的 Provider 健康段（TTFT P50） |
| 会话为什么异常终止 | `messages.json` 的 attribution + `raw.jsonl` 末行 |
| 模型为什么发了个不合法请求 | `raw.jsonl` 的 request 体 |
| 工具调用序列对不对 | `trace-digest` 的工具序列段 |
| 哪些会话不正常，批量筛 | 各会话的 `session-summary.json` 的 `abnormal` / `anomaly_kinds` |

批量筛异常会话可以直接扫：

```bash
for d in ~/.sid-code/trajectories/sessions/*/; do
  python3 -c "
import json,sys
s=json.load(open('$d/session-summary.json'))
if s.get('abnormal') or s.get('real_errors',0)>0:
    print(s['session_id'], s['exit_status'], 'errors=%d'%s['real_errors'], s.get('anomaly_kinds'))
" 2>/dev/null
done
```

跨会话聚合成本同理——遍历 `metadata.json` 的 `total_cost_usd` 求和。
这也是[按天统计花费的正确做法](/team/quota#周期是进程内的-重启即清零)：
`budgetRules` 的周期计数是进程内的，跨会话统计只能靠轨迹。

## `/telemetry`：会话内即时查看

上面讲的 `trace-digest` 和轨迹文件是**事后**看的——会话已经结束，从磁盘读。
`/telemetry` 是**即时**看的——会话进行中就能看当前这一轮的调用结构，数据在内存里。

```text
/telemetry
```

别名 `/tele`。它显示当前会话的 **Span 树 + Metric 汇总**（`packages/cli/src/command/builtins.ts`）：

- **总览**：LLM 调用轮数、Token 消耗（输入/输出）、费用、缓存节省、TTFT 平均、工具调用次数
- **调用时间线**：构建 Span 树递归渲染（扁平 span 列表按 `parentSpanId` 建父子关系，
  `builtins.ts`），每行显示 kind 中文标签、时长、模型名、TTFT、Token、费用（chat）
  或工具名、时长（tool）
- **其他指标**：按 name 分组的 metric（sum/count/max/last）

它**不接受参数**——参数名以下划线开头表示未使用（`builtins.ts`）。遥测未启用时
提示你去开，无数据时提示无数据。

### `/telemetry` 与轨迹落盘的关系

两者**同源双汇**：同一套 Hook 事件驱动，一份走 telemetry bus（内存，`TelemetryBus`），
一份走 trace collector（磁盘）。区别：

| 维度 | `/telemetry` | 轨迹落盘 |
| --- | --- | --- |
| 数据位置 | 内存 | `~/.sid-code/trajectories/sessions/<id>/` |
| 时效 | 会话进行中即时看 | 会话结束后看 |
| 持久 | 会话结束即消失（内存） | 默认保留 100 个会话目录 |
| 用途 | 看当前调用结构是否正常 | 事后诊断、跨会话统计 |

想看当前会话"哪一步慢、花了多少"用 `/telemetry`；想回溯昨天那次会话用 `trace-digest` 读落盘。

### 命令对比

四个容易混的命令，各有各的数据源和定位：

| 命令 | 数据源 | 回答什么 |
| --- | --- | --- |
| `/telemetry` | 内存当前会话 Span/Metric | 当前调用结构、哪步慢 |
| `/trace` | 磁盘历史会话轨迹 | 排查某个历史会话（见上文） |
| `/cost` | 会话状态 | 这次花了多少、缓存命中多少（见[成本与用量](/use/cost)） |
| `/cache` | `usage-ledger.jsonl` | 跨会话缓存命中率趋势与退化监测（见[成本与用量](/use/cost)） |

### 开启完整遥测与 Perfetto 导出

`/telemetry` 与下面所有导出器都依赖 `telemetry.enabled`（**默认 `false`**）。在 `~/.sid-code/settings.json` 配：

```json
{
  "telemetry": {
    "enabled": true,
    "exporters": [{ "type": "jsonl" }]
  }
}
```

字段（`packages/core/src/config/config.ts`、`schema.ts`）：

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| `telemetry.enabled` | 是否启用完整遥测 | `false` |
| `telemetry.exporters` | 导出器列表，元素写 `{ "type": "…" }`（字符串简写 `"jsonl"` 也接受）：`console`（调试）/ `jsonl`（落盘 `~/.sid-code/telemetry/`，50MB 轮转保留 5 个）/ `otlp`（发往你的 OTel 后端，见[导出到 OTel 后端](#导出到-otel-后端-otlp)） | `[]` |
| `telemetry.batchSize` | 批量导出大小 | `512` |
| `telemetry.flushIntervalMs` | 刷新间隔 | `5000`ms |
| `telemetry.maxQueueSize` | 最大队列 | `2048` |

### 导出到 OTel 后端（OTLP）

想把 span 和 metric 送进团队已有的观测栈（Jaeger、OpenTelemetry Collector，或任何接 OTLP/HTTP 的后端），
加一个 `otlp` 导出器：

```json
{
  "telemetry": {
    "enabled": true,
    "exporters": [{ "type": "jsonl" }, { "type": "otlp" }]
  }
}
```

协议是 **OTLP/HTTP + JSON**（`packages/core/src/telemetry/exporters/otlp.ts`，零依赖），端点与认证读 OTel 标准环境变量：

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | 基础端点，自动追加 `/v1/traces`、`/v1/metrics` | `http://localhost:4318` |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `_METRICS_ENDPOINT` | 单信号端点，**原样使用不追加路径** | — |
| `OTEL_EXPORTER_OTLP_HEADERS` | 认证头，`k1=v1,k2=v2` | — |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | 单次请求超时（ms） | `10000` |
| `OTEL_SERVICE_NAME` | `service.name` 资源属性 | `sid-code` |
| `OTEL_RESOURCE_ATTRIBUTES` | 额外资源属性，`k1=v1,k2=v2` | — |

也可以写在导出器的 `options` 里（`endpoint` / `tracesEndpoint` / `metricsEndpoint` / `headers` / `timeoutMs` /
`serviceName`），显式配置优先于环境变量。导出是批量异步的，失败只记一条 `[TELEMETRY] … 导出失败 (otlp)`，不影响会话。

**只支持 HTTP + JSON**。后端只收 gRPC 或 protobuf 时，在中间放一个 OpenTelemetry Collector 做转换（见下文第 5 步）。

#### 本机跑通一遍（不用 docker）

已验证组合：Jaeger v2.21.0、otelcol-contrib 0.162.0（macOS arm64；Linux 换 `linux-amd64` 包）。

**1. 起 Jaeger**（单二进制，内存存储，UI 在 16686，OTLP 收 4317 gRPC / 4318 HTTP）：

```bash
mkdir -p ~/tools/jaeger && cd ~/tools/jaeger
gh release download v2.21.0 -R jaegertracing/jaeger \
  -p 'jaeger-2.21.0-darwin-arm64.tar.gz' -p 'jaeger-2.21.0-darwin-arm64.sha256sum.txt'
tar xzf jaeger-2.21.0-darwin-arm64.tar.gz
shasum -a 256 -c jaeger-2.21.0-darwin-arm64.sha256sum.txt
./jaeger-2.21.0-darwin-arm64/jaeger      # 前台运行，另开一个终端继续
```

**2. 打开导出器**：按上面的 JSON 在 `~/.sid-code/settings.json` 里加 `otlp`。

**3. 跑一次会话**：

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_SERVICE_NAME=sid-code-demo \
no_proxy=127.0.0.1,localhost \
sid-code -p "用 bash 跑 sleep 1 && echo hi，一句话回答"
```

`no_proxy` 别省：开了系统代理时，发往 127.0.0.1 的请求会被代理截走，表现为导出超时。

**4. 看瀑布图**：浏览器打开 <http://127.0.0.1:16686>：

1. 顶栏 **Search** → 左侧 **Service** 选 `sid-code-demo` → 左下 **Find Traces**
2. 右侧每行是一次会话（标题 `invoke_agent sid-code`），点进去就是瀑布图：左列 span 树，右列时间轴
3. 点任意 span 展开 **Tags**，看 `gen_ai.*` 属性；右上角可切 **GenAI View**

终端里那条 `指标导出失败 (otlp): OTLP HTTP 404` 是**正常的**：Jaeger 只收 traces，不收 metrics。
Jaeger 默认内存存储，进程一停数据就没了。

**5.（可选）中间加一层 Collector**：metrics 也要收、或后端要 gRPC 时用。`config.yaml`：

```yaml
receivers:
  otlp:
    protocols:
      http: { endpoint: 127.0.0.1:4320 }
processors:
  batch: {}
exporters:
  otlp/jaeger: { endpoint: 127.0.0.1:4317, tls: { insecure: true } }
  file/metrics: { path: ./metrics.jsonl }
service:
  pipelines:
    traces:  { receivers: [otlp], processors: [batch], exporters: [otlp/jaeger] }
    metrics: { receivers: [otlp], processors: [batch], exporters: [file/metrics] }
```

```bash
mkdir -p ~/tools/otelcol && cd ~/tools/otelcol
gh release download v0.162.0 -R open-telemetry/opentelemetry-collector-releases \
  -p 'otelcol-contrib_0.162.0_darwin_arm64.tar.gz'
tar xzf otelcol-contrib_0.162.0_darwin_arm64.tar.gz
./otelcol-contrib --config=config.yaml
```

把第 3 步的端点换成 `http://127.0.0.1:4320`：traces 经 Collector 转 gRPC 进 Jaeger，metrics 落进 `metrics.jsonl`。
要看 metrics 曲线，就把 `file/metrics` 换成 Prometheus 等后端的 exporter。

#### 导出了什么（OTel GenAI 语义约定）

属性与命名对齐 [OTel GenAI 语义约定](https://github.com/open-telemetry/semantic-conventions-genai)。这套约定目前还是 **Development** 状态，
上游改名时我们跟着改。项目自有字段放在 `sidcode.*` 下。

**Span**（一次会话一棵树）：

| Span | kind | 关键属性 |
| --- | --- | --- |
| `invoke_agent sid-code`（根；子代理为 `invoke_agent <类型>`） | INTERNAL | `gen_ai.agent.name`、`gen_ai.conversation.id`、`gen_ai.request.model` |
| `chat <model>` | CLIENT | `gen_ai.provider.name`、`gen_ai.usage.input_tokens`（**含**缓存命中与写入）、`output_tokens`、`cache_read.input_tokens`、`cache_write.input_tokens`、`reasoning.output_tokens`、`gen_ai.response.finish_reasons`、`sidcode.cost.usd` |
| `execute_tool <tool>` | INTERNAL | `gen_ai.tool.name`、`gen_ai.tool.call.id`；失败时 status=ERROR 并带 `exception.*` |

工具 span 的时长就是工具真实耗时，瀑布图上能直接看出慢在模型还是慢在工具。

**Metric**：

| Metric | 类型 | 单位 |
| --- | --- | --- |
| `gen_ai.client.inference.usage.{input,output,cache_read.input,cache_write.input,reasoning.output}_tokens` | Counter | `{token}` |
| `gen_ai.client.operation.time_to_first_chunk` | Histogram（规范推荐桶） | `s` |
| `sidcode.cost.usd` / `sidcode.cost.cache_savings_usd` | Counter | `USD` |
| `sidcode.agent.turns` | Histogram | `{turn}` |

prompt 与工具输出原文**默认不导出**。内容级 tracing 是独立开关（`SID_CODE_CONTENT_TRACING=1` 等四道闸门，见
`packages/core/src/telemetry/content-tracing.ts`），企业要求「不落原文」时保持默认即可。

### 导出 Perfetto trace

想把会话的调用时间线用可视化工具打开，设环境变量 `SID_CODE_PERFETTO_TRACE`（`packages/core/src/telemetry/perfetto.ts`）：

```bash
export SID_CODE_PERFETTO_TRACE=1          # 启用，落盘到默认文件名
# 或指定路径：
export SID_CODE_PERFETTO_TRACE=/tmp/my-trace.json
```

会话结束时（`TelemetryBus.shutdown()`，`bus.ts`）自动落盘一个 Perfetto
Trace Event 格式的 JSON（`{ traceEvents: [{ name, cat, ph: "X", ts, dur, pid, tid, args }] }`）。
每种 span kind 映射到不同 tid（invoke_agent/chat/execute_tool/blocked_on_user/hook_execution），
在时间轴上分层显示。

打开方式：

- Chrome：地址栏 `chrome://tracing`
- 或在线工具：<https://ui.perfetto.dev>

这对分析"哪一步耗时、子代理在哪一段排队、工具调用有没有重叠"非常直观。

## 采集边界（如实说）

**1. 辅助调用的用量已经不再丢了，但曾经会丢。**
标题生成 / 记忆召回这些影子调用的用量，此前只在 `SessionEnd` 同步一次——
会话崩溃或被杀就永久丢失，即便 provider 已经计费。现在改成
`setSideStatsObserver` 在每次影子调用后立即同步并落盘
（`packages/core/src/trace/collector.ts`）。
所以现在崩溃的会话也能拿到影子调用花费。

**2. 但 `enabled: false` 时什么都没有。** 关了采集就没有事后诊断的可能。
出问题再想查已经晚了——这是默认开启的原因。

**3. 上传是会话粒度、事后的，不是实时流。** 没有实时 dashboard，
"现在全团队有几个人在跑任务"这类问题回答不了。

**4. 平台侧能看什么不在本文档范围。** 这页只讲客户端采集与上传了什么；
平台的指标口径与看板由平台侧决定。

**5. 采集的全是"生成侧"的量。** token、耗时、工具序列、成本——
这些都描述 agent 产出了什么，没有一个字段描述"这些产出被验证掉了多少"。
所以这套轨迹能回答"跑了多少、花了多少"，回答不了"这次是否真的提效"。
为什么这两个问题不能混，以及缺的那类指标长什么样，见
[AI 提效的熵账本](/blog/entropy-accounting)。

## 常见问题

### 轨迹会不会包含代码内容

会。`raw.jsonl` 存完整 API 报文，里面有你发给模型的文件内容和模型的回复。
所以上传前要确认平台的权限边界。敏感项目建议按项目关掉上传：
`--trace-upload-disabled`，或直接 `--no-trace` 连采集一起关。

### 磁盘会不会一直涨

不会。LRU 上限 100 个会话目录。单会话典型体积在几百 KB 量级
（上面那例全部文件加起来约 210K），所以稳态占用大致几十 MB。
想更省就开 `delete_after_upload: true`，上传成功后本地只留 metadata 快照。

### 上传一直失败怎么查

先看健康检查端点通不通（上传器自己也会探这个）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://your-platform.example.com/traj/api/v1/health
```

然后跑 `sid-code --upload-traces` 看重试队列的报错。
常见原因是 `url` 漏了路径前缀，或者 token 没被展开（写成了字面量 `${TRAJ_UPLOAD_TOKEN}`
但环境变量没设）。

### session id 怎么和会话对上

会话结束的摘要里就有（`Session ID: 20260728-004217-cc55cf0d`）。
交互模式下也能用 `--list-sessions` 查历史会话，恢复用 `--resume`，
见[会话管理](/use/sessions)。

## 相关

- [成本与用量](/use/cost) —— 单会话的成本口径与降本手段
- [配额与成本控制](/team/quota) —— 花费护栏；为什么跨会话统计要靠轨迹
- [会话管理](/use/sessions) —— session id、恢复、历史
- [Hook 事件参考](/ref/hooks) —— 与 `events.jsonl` 同源的事件清单
- [排查问题](/use/troubleshooting) —— 出问题时的通用排查路径
- [settings.json 字段参考](/ref/settings) —— `trace` 段全部字段
