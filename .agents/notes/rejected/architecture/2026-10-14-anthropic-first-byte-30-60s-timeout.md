---
Status: rejected
Date: 2026-10-14
---
# 否决：给 Anthropic 请求加 30–60s 首字节超时

## 决定了什么

不加。事故 20261014-110202 排查初期把子代理失败判为「网关连接问题」，并提议 Anthropic 首字节 30–60s 超时。
真因是休眠杀 socket（见 `implemented/architecture/2026-10-14-subagent-retry-decouple-deadline.md`），与首字节慢无关；
「卡死」已由漏斗单次尝试上限（子代理 180s、扣休眠）兜住，G1 哨兵测试锁定。

## 放弃了什么（以及为什么不选）

放弃的就是这个方案本身。本机全部轨迹 n=2387 个 Claude 请求的 TTFB：p50 19.5s / p95 107s / p99 178s / max 255s，
**超过 60s 的有 429 个（18%）**。30–60s 的阈值会把近五分之一的健康请求判死并重试——每次重试都重付 prefill，
同时伤「更快」（重来一遍更慢）和「更省」（白烧 input token）。而且慢首字节在 thinking 模型 + 长上下文下是常态，不是故障。

## 拿什么证明它生效了

否决的有效性体现为「不再有人重提」：后续若有人想加首字节超时，先用 `latencyByModel` 按 model 重算 TTFB 分布
（**禁止跨网关路由汇总**，见 CLAUDE.md TTFB 铁律），阈值低于 p99 即重蹈本结论。
