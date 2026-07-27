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
就只能靠感觉。缓存命中率从 0 提到 83% 这类结论，全部是从这些文件里算出来的。
:::

## 快速上手

想知道刚才那次会话到底发生了什么，一条命令：

```bash
bun scripts/trace-digest.ts <session-id>
```

session id 在会话摘要里（形如 `20260728-004217-cc55cf0d`），或者直接取最新一个：

```bash
ls -1t ~/.sid-code/trajectories/sessions | head -1
```

真实输出（节选）：

```text
━━━ session 20260728-004217-cc55cf0d  [error] ━━━
  模型 ali-deepseek-v4-pro   API 3 次   步骤 5   耗时 16.5s   成本 $0.0276   tok 77855↑/458↓
  cwd /private/tmp/lspdemo

用户意图:
  1. 分析 /tmp/lspdemo/calc.ts，给出语言与顶层函数个数。

L0 事实层 (1) — 机器可验证,带出处,不含判断:
  [高] exit_status_error: exit_status = "error"
        ⊢ 出处: .../session.traj @metadata.exit_status = error
        → 看: messages.json (验尸快照,看 attribution) + raw.jsonl 末行

L1 假设层 (1) — 待验证,先消解证伪条件再采信:
  [高] hypothesis_runtime_abend: 假设:会话因运行时异常而非正常 end_turn 终止。
        ⚖ 证伪条件: 若 messages.json.attribution 显示是用户主动中断 / 配额耗尽等
          可预期原因,则推翻"运行时异常终止"。

工具序列 (2 次调用):
  · read file_path=/tmp/lspdemo/calc.ts
  · StructuredOutput {functionCount,language}

Provider 健康:
  openai       请求:3 成功率:100% 整轮均耗:5.4s TTFT(首字节)P50=1.9s 生成P50=3.1s
```

值得注意的是这个工具的输出结构：**L0 事实层带出处、L1 假设层带证伪条件**。
它不会直接告诉你"结论是 X"，而是给出可验证的事实 + 待验证的假设 + 推翻假设的条件。
上面这例就很典型：`exit_status = error` 是事实，但假设层同时给了证伪路径——
实际查 `messages.json` 会看到 `abnormal: false` / `exit=end_turn`，
说明这个 `error` 状态与真实的异常终止并不等价。

`TTFT(首字节)P50=1.9s` 这行是延迟优化的直接依据。

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

`events.jsonl` 的事件类型分布（同一会话的实际统计）：

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

默认保留最近 **100** 个会话目录，超了按修改时间 LRU 清理（`src/trace/collector.ts:180-181`）。
清理有个偏向：**优先删已上传的**（数据已在远端），未上传的即使更旧也尽量留
（`collector.ts:194-198`），避免丢掉还没采集走的数据。

## 关掉与打开

采集默认启用。关掉：

```bash
sid-code --no-trace
```

上传默认**不发生**——`trace.upload` 段没配 `url` / `token` 就只在本地存。
这是刻意的：代码里不硬编码任何上传地址（`src/cli.ts:505-507`）。

## 上传到轨迹平台

配置写在 `~/.sid-code/settings.json`：

```json
{
  "trace": {
    "enabled": true,
    "upload": {
      "url": "http://your-platform.example.com/traj",
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

`url` 要**含路径前缀**（如 `/traj`），上传器会在后面拼 `/api/v1/upload/session-file`
（`src/trace/uploader.ts:255-256`）。

::: warning token 别写明文
用 `${TRAJ_UPLOAD_TOKEN}` 占位符。这份配置如果通过[团队默认配置](/team/defaults)
分发，就是一个全团队都能 `curl` 到的文件。
:::

三个开关是**独立**的，别混为一谈（`src/cli.ts:505-511`）：

| 开关 | 控制什么 | 默认 |
| --- | --- | --- |
| `trace.enabled` | 是否采集（关了就什么都不落盘） | `true` |
| `trace.upload.url` + `token` | 是否上传（有配置才传） | 未配置 |
| `trace.upload.auto_upload` | 会话结束自动传，还是等手动 | `true` |
| `trace.upload.delete_after_upload` | 传完删本地 | `false`（本地留全量副本） |

`--trace-upload-disabled` 是最高优先级的强制关闭，覆盖配置文件。
临时排查隐私敏感项目时用它。

### 上传的实际形态

`POST <url>/api/v1/upload/session-file`，`multipart/form-data`
（`src/trace/uploader.ts:246-266`）：

- 鉴权头 `X-Upload-Token`，完整性头 `X-Content-SHA256`
- 默认 gzip level 6 压缩，`Content-Type: application/gzip`
- 表单字段：`file` / `session_id` / `file_type` / `tool_source`，可选 `user_id` / `device_id`
- 30 秒超时；失败按指数退避重试 5 次（2s→4s→8s→16s→32s）
- 服务端返回非空 `sha256` 时会做二次校验，不一致算失败重试

失败的进持久化重试队列。补传：

```bash
sid-code --upload-traces
```

`user_id` / `device_id` 是团队聚合的分组键——多人上传到同一平台时靠它们区分来源。

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

## 采集边界（如实说）

**1. 辅助调用的用量已经不再丢了，但曾经会丢。**
标题生成 / 记忆召回这些影子调用的用量，此前只在 `SessionEnd` 同步一次——
会话崩溃或被杀就永久丢失，即便 provider 已经计费。现在改成
`setSideStatsObserver` 在每次影子调用后立即同步并落盘
（`src/trace/collector.ts:186-191`、`collector.ts:1740-1750`）。
所以现在崩溃的会话也能拿到影子调用花费。

**2. 但 `enabled: false` 时什么都没有。** 关了采集就没有事后诊断的可能。
出问题再想查已经晚了——这是默认开启的原因。

**3. 上传是会话粒度、事后的，不是实时流。** 没有实时 dashboard，
"现在全团队有几个人在跑任务"这类问题回答不了。

**4. 平台侧能看什么不在本文档范围。** 这页只讲客户端采集与上传了什么；
平台的指标口径与看板由平台侧决定。

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
