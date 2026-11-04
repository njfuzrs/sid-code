---
Status: rejected
Date: 2026-11-04
---
# 不凭 harness bench 的「0 调用」把 `todo_write` 降级或改成 deferred

## 决定了什么

`todo_write` 维持首轮装载（`tool/todo-write.ts` 不声明 `shouldDefer`），描述不瘦身到影响用法的程度。描述精简归 Q5 基础前缀减重统一做，要过双模型 A/B，不在这里单独动。

来源：P1 维度 18 里，19 对样本两边的 todo / plan 调用都是 0，sid 每次请求为 3 个规划工具携带约 6.2K 字符（`todo_write` 描述 3,801 字符、schema 4,745 字符）。表面看是「付了钱没人用」。

## 放弃了什么（以及为什么不选）

- **改成 deferred / 降级**：0 调用的原因是**题目太短**，不是工具没用。`todo_write` 是长任务遗漏防护整条链路的入口：todo 回注、收尾门禁（`todo_gate_retry`）、压缩后回注都以清单存在为前提。降级省下的是缓存前缀里的约 4.7K 字符，赌上的是长任务返工。
- **证据已经反转**：F3（deepseek-v4-flash 基线，2026-10-29）里 L 类长任务用上了清单：压缩后回注 62 次（`NoProgressNagInjected{afterCompact:true}`），L2f / L3f 触发了收尾门禁。真正的问题是门禁可以被一键标完成（D-02：L3f 声称读完 29 个文件，实际只读 17 / 10 个），方向是**加强**清单和实际调用的对账，不是拿掉清单。
- **plan 两个工具一起降**：维度 18 的第 1 条（无头 bypass 下把 `enter_plan_mode` / `exit_plan_mode` 改成 deferred）是另一件事，理由是无头模式没有审批人，和 `todo_write` 不同，不在本否决范围内。

**重新评估的触发条件**：有带判分的长任务题（8 条以上子要求、跨 5 个以上文件），双模型 A/B 显示去掉首轮装载后交付完整度不降。

## 拿什么证明它生效了

否决，没有代码改动。依据可复查：

- docs-research `bench_result/reports/D-18-规划与任务跟踪.md` §6 第 2 条，以及第 60 行的字符数。
- `bench_fix/04-F3-deepseek基线.md` §8.1（门禁与压缩后回注的触发次数）、§8.5 D-02。
- 本仓：`grep -n shouldDefer packages/core/src/tool/todo-write.ts` 无输出，确认仍首轮装载。
