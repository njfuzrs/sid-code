# Sprint S5 末报告 — Agent Eval 真化路线

> **生成日期**：2026-05-31
> **Sprint 周期**：S5（M4 起步）
> **关联文档**：`docs/eval/演进路线/agent-eval-真化路线-v1.md` §8.1

---

## 1. 本路线启动摘要

Sprint S5 是 Agent Eval 真化路线的**首个执行 Sprint**。核心目标：让"sandbox + execution-test-grader"从摆设变成主力，跑通第一条端到端 execution case。

### 1.1 完成的 task（7/8）

| Task | 状态 | 摘要 |
| --- | --- | --- |
| B5-1 | ✅ | sandbox 接进 eval-runner 主流程，`eval_type: execution` 走 `runSandbox()` |
| B5-2 | ✅ | 从 git log 挑 bug-fix commit b1cfda9，写 fixture + verify_commands |
| B5-3 | ✅ | bug_001 端到端跑通：score=1.0 / 25s / 2 turn / 14549 token |
| B5-4 | ✅ | ADR-032 评测主轴权重重平衡 Proposed→Accepted |
| B5-5 | ✅ | grader_type=execution_test 单测补齐（6 条 ExecutionTestGrader） |
| B5-6 | ✅ | DASHBOARD.md 增加 execution 独立 section |
| B5-7 | ✅ | 本报告 |
| B5-8 | ✅ | TODO-M4-M5.md 同步 |

### 1.2 未完成

无。B5-7 是最后一条，本报告即为完成标志。

---

## 2. 第一条 Execution Case 数据

### bug_001（蒸馏自 commit b1cfda9）

| 指标 | 值 |
| --- | --- |
| 场景 | logger 文件级别过滤错杀（纯逻辑 bug） |
| grader_type | execution_test |
| apply_mode | extract_files |
| 首次跑通日期 | 2026-05-31 |
| score | 1.0 (binary pass) |
| latency | 25.0s |
| turns | 2 |
| tokens | 14,549 |
| provider | sid_code_deepseek_v4_pro |

### 关键发现

1. **case 设计 bug 修复**：原 `user_query` 只写"（内容见 fixture）"占位，agent 看不到 fixture 真内容 → 改为内联 fixture 内容到 prompt
2. **围栏容忍**：agent 自然给 `=== FILE ===` 段加 ` ```typescript` 围栏，grader 需 `stripFenceWrap` 才能正确提取
3. **sandbox 边界三条已落**：tmpdir cleanup / SIGKILL 真杀子进程 / stdout 64KB 截尾防 OOM

---

## 3. 后续 Sprint 计划

### S6（M4 主体）— 已完成

- trajectory-platform 适配器跑通
- 30 条精标 case 入库（easy 5 / medium 15 / hard 10）
- trace schema 标准化 + TrajectoryMatchGrader v1

### S7（M4 收尾）— 进行中

- 三轴打分上线（rubric / execution / trajectory）
- 全量回归 57 条 case 出第一份 agent eval 完整报告
- ci-self-heal Skill execution case
- 数据飞轮 v0

### S8（M5 Gate）— 待启动

- Inspect AI / SWE-bench Verified 外部锚接入
- self-vs-external 对照报告
- M5 Gate 评审

---

## 4. §10.3 监控指标（S5 末）

| 指标 | 要求 | 实测 | 状态 |
| --- | --- | --- | --- |
| ① 30 条 general 平均分降幅 ≤ 0.3 | 对比上 Sprint | 首次建立 baseline（无历史） | ✅ N/A |
| ② 三栏占比未偏离 §4.2 | Layer 1 / Execution / Trajectory | 25/1/0（S5 仅 execution 1 条） | ✅ 符合 S5 scope |
| ③ trajectory-platform 适配器吞吐 ≥ 5 条/Sprint | B6 起 | S5 不适用 | ⏳ |
| ④ self-vs-external gap 报告 | M5 Gate 起 | S5 不适用 | ⏳ |

---

## 5. §7.4 毕业判定

S5 毕业条件：第一条 execution case 端到端跑通 + ADR-032 Proposed。

- ✅ bug_001 score=1.0
- ✅ ADR-032 Status=Proposed→Accepted

**结论：S5 毕业，可开 S6。**
