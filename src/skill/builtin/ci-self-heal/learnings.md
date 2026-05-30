# ci-self-heal Skill — Learnings (Step 6 偏差回写占位)

> 本文件由三轴螺旋 Step 6 (S6-T12) 维护. 当前 Step 4 (S6-T10) 仅占位, 真信号写入留给 Step 5 (S6-T11) after-baseline 跑完后.

---

## Step 4 实施期 (S6-T10) 已知限制

> 这些是实施过程中暴露的, 但未通过真 LLM execute 验证. Step 5 baseline 跑完后, 命中的项搬到 §A "已验证偏差", 不命中的项搬到 §B "假设但未触发".

### 1. 启发式分类边界模糊

`classify-failure.ts` 当前用强/中/弱信号叠加 (上限 0.95) 决定 failure_class, 但:

- **test_failure 与 build_failure 边界**: tsc 编译失败时, error 出现在 `*.test.ts` 中, 当前规则会标 test_failure 但本质是 type_error. 信号叠加可能误判.
- **flaky 与 timeout 边界**: 网络超时既可标 flaky 也可标 timeout. 当前规则按 retry 标记优先 flaky, 但单次 timeout 没有 retry 上下文时会标 timeout 错过 flaky 真因.
- **修正方向**: Step 5 baseline 中如果 ≥ 2 条 case 命中边界场景, 在 references/ci-failure-patterns.md 加 "互斥规则" 段, 由 LLM 在 Step D 用上下文裁决而非启发式硬决.

### 2. fix-suggestion-templates.ts 的"模板僵硬"问题

模板每类 ≤ 3 条建议, 是宽泛"诊断动作" (复现 / 比对 / 缩小范围) 而非具体修复:

- **优点**: RL-001 / RL-006 守护严密 (永远不直接给"修改 src/X.ts 第 N 行"建议)
- **缺点**: 用户可能希望"具体改哪一行", 模板答不了
- **设计取舍**: 当前阶段以"安全 > 可执行"为准. M6+ 引入更激进的 fix PR 自动生成时再放宽.

### 3. parse-diff.ts 跨 Skill 复用风险

ci-self-heal 通过相对路径 `import { ... } from "../code-review/scripts/parse-diff.ts"`:

- **风险**: code-review Skill 改 parse-diff 接口时不通知 ci-self-heal, 编译期才报错
- **守护**: TypeScript 严格模式 + tests/skill/ci-self-heal.test.ts 覆盖该 import 路径
- **修正方向**: M5+ Skill framework 升级时, 共享脚本统一移到 src/skill/shared/ 而非跨 Skill 相对引用

### 4. SLA 1 阶段未实测

frontmatter 写 `p50_ms: 30000 / p95_ms: 120000`, 但:

- Step 5 baseline (S6-T11) 才会真测 N=3
- 当前 sla 字段是 RFC-002 §3 估算值
- **修正方向**: Step 5 真信号回来后, 如 P95 实测 > 120000, 需 ADR 记录调整

---

## §A 已验证偏差 (Step 5 后填充)

待 S6-T11 跑完 N=3 真 LLM baseline 后填.

格式:

```
- **偏差 N**: <一行摘要>
  - **触发 case**: case_csh_NNN
  - **观察**: <log / 输出原文片段>
  - **根因假设**: <为什么会这样>
  - **修正动作**: <改 SKILL.md / scripts / references 哪一段>
```

---

## §B 假设但未触发 (Step 5 后填充)

Step 4 实施期假设的限制, 但 baseline 真测时没出现 → 留作 Step 7 边界 case 候选.

---

## §C 三轴螺旋阶段映射

- Step 1 SDD: SKILL.md 初稿 + RFC-002 (S5-T08) ✓
- Step 2 EDD: 10 baseline case + runner + before-baseline (S5-T10) ✓
- Step 2 EDD: SLA 阈值写入 frontmatter (S5-T11) ✓
- Step 3 TDD: tests/skill/ci-self-heal.test.ts (S5-T12) ✓
- **Step 4 实施: scripts/ + references/ + validations/ + 完整 prompt body (S6-T10)** ← 当前
- Step 5 EDD: after-baseline + 0.20 PP 守护 (S6-T11)
- Step 6 SDD: 本 learnings.md 真信号回写 (S6-T12)
- Step 7 边界: 边界 case + 混沌测试 (S7 初)
- Step 8 发布: release_metadata 完整段 (S7 中)

---

> 修订记录:
> - 2026-05-31: 初稿 (S6-T10 Step 4 实施期占位)
