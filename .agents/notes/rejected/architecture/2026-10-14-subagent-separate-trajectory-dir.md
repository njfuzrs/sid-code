---
Status: rejected
Date: 2026-10-14
---
# 否决：把子代理遥测拆到独立轨迹目录

## 决定了什么

子代理遥测**继续写在父会话** `trajectories/sessions/<parent>/events.jsonl`。可追溯性靠统一关联键解决
（规范 id + `parent_tool_use_id` + `trace-digest --agent` 视图，见 `implemented/feature/2026-10-14-subagent-trace-correlation.md`）。

## 放弃了什么（以及为什么不选）

拆目录看上去能让「一个子代理一份轨迹」更好找，但：

- 成本账本、northstar 指标（单位任务成本、turns per task）、digest、session-index 全部按会话聚合。拆出去后子代理花费从
  「这个任务花了多少」里消失，主口径整体平移且无报错——比找不到轨迹更糟。
- 每个聚合方都要学会「再去子目录里找一遍」，漏一处就是静默少算（同仓「防线全在、调用全 0」的同型风险）。
- 事故里真正的痛点是 id 不统一、缺父链路，不是事件放在哪；按规范 id 过滤一次即可得到单子代理视图。

## 拿什么证明它生效了

`bun scripts/trace-digest.ts <parent> --agent <taskId>` 能从父会话事件中完整抽出一个子代理的 Start / 每条请求 / Stop；
`subagent-canonical-id.test.ts` 断言所有属于该子代理的事件 id 同值。若将来仍有人提议拆目录，先回答「账本与 northstar 怎么不漏算」。
