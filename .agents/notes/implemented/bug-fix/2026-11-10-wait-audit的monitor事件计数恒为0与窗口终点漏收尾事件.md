---
Status: implemented
Date: 2026-11-10
---
# wait-audit 的 monitor_events：认带属性的 `<event>`，按 task_id 把收尾事件计入窗口

## 决定了什么

`scripts/wait-audit.ts` 三处改动（方案 20261109「monitor 实测暴露的退出泄漏与审计口径缺陷」FIX-2 = D2 + D3）：

1. **D2 正则**：`countMonitorEvents` 原先写死 `b.includes("<event>")` / `/<event>…<\/event>/`，
   而真实渲染是 `<event untrusted="true">`（`packages/core/src/task/notification.ts` 的 `formatNotification`），
   于是所有真实轨迹 `monitor_ev` 恒为 0，手写的无属性夹具却全绿。改为 `/<event(?:\s[^>]*)?>/`，两种形式都认，
   `<events>` 这类同前缀标签不误认。
2. **D3 窗口终点**：`inferRegistryWindow` 在窗口内存在 monitor 等待源时，把终点从「最后一个 `WaitReleased`」
   延到**这些 monitor 自己**（按 `WaitRegistered.data.id` ↔ `TaskLifecycle.data.task_id` 关联）最后一次
   `TaskLifecycle{phase:delivered, task_type:local_monitor}`。shell / schedule_wakeup 窗口语义不变。
3. **D3 的第二半（方案没写到）**：只延终点仍然少一条。实测 b177b927：`delivered` 14:40:04.447，而 tick-5 所在
   raw 行是 14:40:04.**449** —— raw 记录的是「带着通知发出的下一轮请求」，天然晚于 `delivered` 事件本身。
   所以对**窗口内注册的 monitor** 的通知只卡起点、不卡终点（task_id 已把归属限定住，后续请求重放历史由去重兜住）；
   其他 task_id 的通知仍按窗口卡。
4. 顺带采纳 D2 风险段的建议：没读 raw 时 `monitor_events = null`，人类可读输出显示 `monitor_ev=n/a`，
   不再输出会被读成「没有事件」的 0。`verify-monitor.ts` 的 `parseWaitAuditOutput` 早已按 `n/a` → null 处理，无需改。

## 放弃了什么（以及为什么不选）

- **按方案伪代码只延终点到 `delivered`**：真实轨迹复算得 4 而不是 5（见上第 3 条），照抄伪代码等于修一半。
- **把终点再加一个固定宽限（如 +1s）**：能凑出 5，但宽限值没有源字段依据，会把窗口内的 `window_requests` /
  `window_input_tokens` 一起拉大，污染别的指标的分母。按 task_id 归属只影响 monitor_events 一个字段。
- **取窗口内所有 `local_monitor` 的最后一次 delivered（不按 id）**：同一会话后起的另一个 monitor 会把窗口
  拉长到不相干的位置（77ece4e5 就有第二个 monitor `m2uy8n7sp`）。单测「不相干 monitor 不延伸窗口」锁住这条。
- **D5（改读 events.jsonl 里独立的 MonitorEvent）**：根治「依赖文本解析」，但要改产品代码，归 FIX-4，排在本 FIX 之后。

## 拿什么证明它生效了

真实轨迹复算（方案 D2/D3 验收 A）：

```text
$ bun scripts/wait-audit.ts 20261109-223949-b177b927 --with-raw
... [2026-11-09T14:39:56.424Z → 2026-11-09T14:40:04.447Z] ... monitor_ev=5 violations=0   # 修复前 0
$ bun scripts/wait-audit.ts 20261109-223954-77ece4e5 --with-raw
... monitor_ev=2 violations=0                                                              # 修复前 0
$ bun scripts/wait-audit.ts 20261109-223949-b177b927
... monitor_ev=n/a ...
```

端到端 `bun scripts/verify-monitor.ts --case D2D3-audit`（`make build` 后）连续 2 次 PASS：
会话 `20261110-134222-1b96ae48` / `20261110-134238-c21260d9`，均 `monitor_ev=5 violations=0`。

单测 `tests/scripts/wait-audit.test.ts`：夹具改为真实格式 `<event untrusted="true">`；新增两种形式都计数、
**直接用 `formatNotification` 渲染的通知必须被计数**（防夹具再次与生产格式漂移）、未读 raw 为 null、
D3 三条（终点延到 delivered 且收尾事件计入 / 不相干 monitor 不延伸 / shell 窗口不变）。21 pass。

变异自证（改坏 → 看报了什么 → 恢复）：

| 变异 | 单测 | 真实轨迹 b177b927 | 端到端 D2D3-audit |
| --- | --- | --- | --- |
| D2：改回 `b.includes("<event>")` | 4 fail | `monitor_ev=0` | FAIL（0 ≠ 5） |
| D3：终点只取 WaitReleased + 通知按时刻卡终点 | 1 fail | `monitor_ev=4` | FAIL（0 ≠ 5） |
| D3：去掉 task_id 关联 | 2 fail | — | — |
| 恢复 | 21 pass | `monitor_ev=5` | PASS ×2 |

D3 变异在端到端上是 0 而不是方案预期的 4（已回轨迹核实，会话 20261110-134222-1b96ae48）：WaitRegistered 05:42:28.238 →
WaitReleased 05:42:30.787 → delivered 05:42:33.390，raw 里带 tick-1..5 的那一行是 05:42:33.393——5 条事件**全部**
在 WaitReleased 之后的下一轮才落盘，按旧口径一条都进不了窗口。与 b177b927 同一成因，只是更极端；
这也说明 D3 不是「少一条」的边角问题，是取决于模型请求时序的结构性漏数。

已知限制：`monitor_events` 仍依赖解析 raw.jsonl 文本，通知格式再变还会漂（D5 才是根治）；
「直接用 formatNotification 渲染」那条单测是目前对这种漂移的唯一拦截。
