# incident-rca 5 维度证据收集顺序

> SKILL.md §3.1 推理流程的可视化参考。**顺序固定**,不允许跳步。

## 维度 1: log_pattern

**目的**: 找异常密度突变 + 关键 keyword,把"故障是什么"先定位到日志层

**操作**:

- 扫日志找 stack trace / exception 类型聚类
- 抽 ERROR/FATAL/PANIC/WARN 出现频率突变点(常常就是故障起点)
- 关键 keyword: `timeout` / `connection refused` / `OOM` / `deadlock` / `NXDOMAIN` / `503` / `429`
- 输出: 时间窗内 N 条最重要的日志原文(保留时间戳)

## 维度 2: metric_anomaly

**目的**: 对照时间窗的 metric 偏离,识别**最早**偏离的指标(常常是根因起点)

**操作**:

- 比较"故障时间窗" vs "故障前 1h"的 metric 分布
- 排序所有 metric 的偏离起点时间(早 → 晚)
- 最早偏离的指标常常是根因(慢于故障的偏离往往是症状)
- 输出: 偏离起点时间 / 数值范围 / 偏离倍数

**反模式**: 只看故障时间窗内最高的指标(那常常是症状) — 必须看**最早偏离**

## 维度 3: trace_correlation

**目的**: 跨服务 / 跨进程串联 trace,识别"哪一跳延迟突增 / 哪一跳错误率突增"

**操作**:

- 把 trace 按"跨进程边界"切段
- 找延迟最高的子段或错误率最高的子段
- 把该子段的服务名 + 错误码 + 时间戳 输出为根因候选
- 用反证法排除:其他子段持平 → 故障不在它们

**注意**: 用户没提供 trace 时,在 Skipped Checks 段说明,不要编造 trace

## 维度 4: rca_hypothesis

**目的**: 基于 1-3 构造 ≤ 3 条假设,按"证据密度 + 修复成本 + 影响半径"排序

**排序标准**(权重从高到低):

| 标准 | 含义 |
| --- | --- |
| 证据密度 | log + metric + trace 三个维度都指向同一根因 |
| 时间相关性 | 故障起点附近有 commit / config change / deploy |
| 影响半径 | 假设若成立能解释 X% 的现象 |
| 修复成本 | 假设若成立修复有多难 |

**铁律**:

- 每条假设必须 ≥ 1 条 Evidence(log/metric/trace/commit)
- 没证据的假设必须标 Likelihood: low + 写在 Skipped Checks 段
- 不允许"凑 3 条"硬填弱假设(2 条 high + 1 条 medium 比 3 条都 medium 好)

## 维度 5: fix_priority

**目的**: 每条假设给 hotfix / mitigation / long-term 三档行动

**三档划分**:

| 档 | 时间窗 | 执行者 | 例子 |
| --- | --- | --- | --- |
| **Hotfix** | < 5 分钟 | SRE 单人 | 切流到备用 endpoint / 临时熔断 |
| **Mitigation** | < 30 分钟 | SRE + 1 名研发 | 临时降级配置 / 补丁部署 |
| **Long-term Fix** | 1+ 天 | 研发团队 + ADR | 索引重建用 CONCURRENTLY / 双 key 验证 |

**铁律**:

- Hotfix 必须能在没有研发参与的情况下由 SRE 执行(降低决策延时)
- Mitigation 不应是"等等看"——必须有具体 mitigation 步骤
- Long-term Fix 必须不只是"加监控",要明确"改什么代码 / 流程"

## 反模式

- 跳维度 (跳 metric_anomaly 直接进 hypothesis) → 假设排序失准
- 把维度 1 的发现直接当结论(不进 维度 4 的排序)→ 容易抓到症状不是根因
- 三档建议合并 (全 hotfix 或全 long-term) → 失去 RCA 报告的核心结构

## 与 ci-self-heal 的差异

| 维度 | ci-self-heal | incident-rca |
| --- | --- | --- |
| 1 | parse-ci-log.ts (确定性) | log_pattern (LLM 推理) |
| 2 | classify-failure.ts (8 类规则) | metric_anomaly (跨指标对照) |
| 3 | diff 关联 (复用 parse-diff) | trace_correlation (跨服务) |
| 4 | hypothesis (≤ 3) | rca_hypothesis (≤ 3, 严格证据排序) |
| 5 | suggested fix | fix_priority (三档) |

ci-self-heal 偏"启发式分类 + 单点 fix";incident-rca 偏"跨维度证据 + 三档行动"。
