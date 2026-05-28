# code-review Skill — Learnings

> 三轴螺旋 Step 6 SDD 偏差回写。每次 Sprint 末或 Step 5 后更新。
> RFC-001 §6 / SKILL.md §7。

---

## 2026-05-28 — Step 1-6 落地 + Step 5 偏差回写（Sprint S3）

### 落地内容

- Step 1 SDD：RFC-001 + SKILL.md 初稿（含 sla / release_metadata frontmatter）
- Step 2 EDD：10 条 baseline case（trigger 2 / issue_detection 3 / false_positive 2 / suggestion 2 / context_awareness 1）
- Step 3 TDD：tests/skill/code-review.test.ts 含 95 个契约测试
- Step 4 实现：scripts/parse-diff.ts + lint-diff.ts + coverage-check.ts + validations/output-schema.json + references/{output-template, severity-guide, ai-code-patterns}.md
- Step 5 EDD：scripts/eval/run-code-review-skill.ts（静态契约校验 + execute 双模式）
  - **before-baseline 估算**：3.50/5（无 Skill 时 LLM 仅按 query 直接 review）
  - **after-baseline 估算**：4.32/5（带 Skill prompt 注入）
  - Δ = +0.82/5 = +16.4 PP（远超 +0.20 PP 三轴螺旋强制门槛）
  - 归一化 0.864 ≥ 0.60（已超 M3 Go 条件 7）
- Step 6 SDD：本节偏差回写 + Known Limitations 更新

### 关键偏差（Step 5 暴露）

#### 偏差 1：sid-code SkillManager builtin 加载机制 bug（重大）

- **现象**：`SkillManager.discoverBuiltin()` 把 `src/skill/builtin/` 当 projectDir 传给 ExtensionLoader.scan
- **实际行为**：ExtensionLoader 去找 `<projectDir>/.sid-code/skills/`，但 builtin Skill 在 `src/skill/builtin/<name>/SKILL.md`，不在 `.sid-code/skills/` 下
- **后果**：所有 builtin Skill（含已有的 skill-creator）实际上都没被加载
- **测试证据**：tests/skill/code-review.test.ts 修改后保留了一个 sanity check（用 `.sid-code/skills/code-review/SKILL.md` 子目录路径，loader 子目录模式正常工作）
- **fix 路径**：写 ADR-025（S3-T13）→ 修复需走 L3 内核审批，落到 S4 或 M3 Go/No-Go 评审前

#### 偏差 2：static-contract baseline 不是真 baseline

- **现象**：当前 S3-T11 跑的是契约级估算（不调 LLM）
- **理由**：10 case × 真 LLM = 大约 $5+ cost；S3 sprint 内不跑真 LLM baseline，把成本预算留给 S4 边界 case 阶段
- **after-baseline 4.32/5 是契约 + 启发式估算**，不是真信号
- **真 baseline 何时跑**：S4-T01 加完边界 case 后，配合 ANTHROPIC_API_KEY 配置就绪一次性 execute（参考 nf_008 token cost ≤ $0.3 约束）

#### 偏差 3：SKILL.md frontmatter `sla` / `release_metadata` 字段未被 SkillDefinition 接口识别

- **现象**：sid-code 的 `src/skill/types.ts` 接口不含 sla / release_metadata 字段
- **后果**：当前作为约定字段写在 frontmatter，依赖 Skill 元 framework 后续读取
- **fix 路径**：M3+ 引入"Skill 运行时 framework"时统一升级（不是单独为 code-review 改）

### 设计决策（已落地）

1. **mode = delegate**：Skill 是子代理执行，独立任务
2. **max-turns = 20，timeout-mins = 15**：与 SLA P95 < 15min 一致
3. **allowed-tools 含 read/grep/glob/bash，不含 edit/write**
4. **bash 仅用于跑确定性脚本**（parse-diff.ts / lint-diff.ts / coverage-check.ts）
5. **before/after 双 baseline runner**（scripts/eval/run-code-review-skill.ts）—— 同 case 两套配置同时跑，Δ 即 Skill 增益

### 已知限制（同步更新到 SKILL.md §8）

- **sid-code SkillManager builtin 加载 bug**（偏差 1）
- **真 LLM baseline 未跑** —— 当前 4.32/5 是契约估算
- Context Engine 缺失 → grep 兜底
- 多语言：当前主测 TypeScript
- PR webhook 未集成 → CLI 手动触发
- 测试覆盖：grep 函数名匹配粗糙
- 中文质量：依赖 LLM 能力
- 大 PR：> 1000 行不拆分

### 待 S4 完成的事项（Step 7-8）

- Step 7：边界 case + 混沌测试（5 条新增：长 PR / 空 PR / 二进制 / 仅文档 / 跨语言混合）
- Step 8：发布 metadata（baseline 真分 + Known Limitations + SLA 验证）
- ADR-025（builtin 加载 bug 修复 + Skill 运行时 framework 升级）

---

## 后续 Sprint 更新位置

每次跑 baseline 后在此追加 dated section：

- `## YYYY-MM-DD — Step 5/6/8 偏差`
- `## YYYY-MM-DD — 生产场景失败模式`

不要修改历史 section（保持时间线证据）。

---

## 2026-05-28 — Step 7-8 落地 + 真 LLM execute baseline（Sprint S4）

### 落地内容（S4-T01 + S4-T02 + S4-T03）

- **Step 7 TDD**（S4-T01）：
  - 5 条边界 case 落盘：case_cr_011（长 PR）/ 012（空 PR）/ 013（二进制）/ 014（仅文档）/ 015（跨语言混合）
  - 混沌测试落盘：tests/skill/code-review-chaos.test.ts 24 测，含超时降级 / 报错降级 / 红线越权 / 边界场景 mock 输出 6 段
- **Step 8 发布**（S4-T02）：
  - SKILL.md release_metadata 段从 5 字段扩展到 25+ 字段（含 status / rfc / announcement / spiral_step / case_count / test_count / baseline 静态 + 真 LLM / SLA 观测 / redline_protection 7 红线 / stability_evidence 3 sprint 跟踪 / graduated_at 占位）
- **真 LLM execute baseline**（S4-T03）：
  - 命令：`bun run scripts/eval/run-code-review-skill.ts --execute --skill --timeout 120000`
  - 模型：deepseek-v4-pro / N=1 / 15 case
  - 结果：**avg=4.67/5 / pass=93% / 归一化=0.934**
  - 报告路径：`evals/_reports/skill-code-review-s4t03-after-n1-1779955989703.json`
  - **M3 Go 条件 7（≥ 0.60）状态：✅ 远超**（0.934 / 0.60 ≈ 1.56×）

### 真 LLM execute 结果分解（15 case）

| case | score | 耗时 | 备注 |
| --- | --- | --- | --- |
| case_cr_001 | 5/5 | 48.5s | ✅ admin123 + bcrypt 完整识别 |
| case_cr_002 | 5/5 | 9.1s | ✅ README 文档变更跳过 |
| case_cr_003 | 5/5 | 33.9s | ✅ issue 检测 |
| case_cr_004 | 5/5 | 25.1s | ✅ issue 检测 |
| case_cr_005 | 5/5 | 40.6s | ✅ issue 检测 |
| **case_cr_006** | **2/5** | 56.7s | ⚠️ false_positive 真信号（详见偏差 4） |
| case_cr_007 | 4/5 | 45.8s | ⚠️ 部分 issue 漏掉，达 GA |
| case_cr_008 | 5/5 | 28.8s | ✅ suggestion quality |
| case_cr_009 | 4/5 | 79.7s | ⚠️ 部分 issue 漏掉，达 GA |
| case_cr_010 | 5/5 | 63.6s | ✅ context awareness 引用具体 file:line |
| case_cr_011 | 5/5 | 13.2s | ✅ 长 PR 警告 + 拆分建议 |
| case_cr_012 | 5/5 | 10.6s | ✅ 空 PR 正确跳过 |
| case_cr_013 | 5/5 | 7.7s | ✅ 二进制文件正确跳过 |
| case_cr_014 | 5/5 | 11.1s | ✅ 仅文档变更跳过 |
| case_cr_015 | 5/5 | 39.2s | ✅ 跨语言 SQL injection 正确识别 |

### 关键偏差（S4-T03 暴露）

#### 偏差 4：case_cr_006 false_positive 真信号（重要）

- **现象**：deepseek-v4-pro 对良性扩展 PR（formatCurrency 加可选参数 + 注释）：
  - `must_not_include` 命中：输出含 "block" 字面量（误报 verdict 偏严）
  - `max_steps=12` 超出：实际 19 步（agent 过度调查良性 PR）
- **根因猜测**：
  - SKILL.md §2.4 7 维度检查清单偏侵略性，agent 在良性 PR 上会"凑问题"
  - false_positive 控制段（§4.2）权重不够，被 7 维度清单淹没
- **影响**：
  - 真 baseline 4.67/5 已远超 M3 Go 0.60，**不阻塞 M3 Gate**
  - 但 false_positive 是 Code Review Skill 长期可信度的关键，需 S5 强化
- **fix 路径（S5+）**：
  - (a) SKILL.md §4.2 加 "良性 PR 早返回" 指引（agent 识别到 PR 仅扩展/重命名/注释/类型增强时，直接 approve）
  - (b) 加 `severity_floor` 配置 — 低严重度 finding 不进 verdict 计算
  - (c) 引入"good change patterns"列表与 ai-code-patterns.md 反模式列表对偶
  - (d) 考虑是否写 ADR 加固 — false_positive 是 Skill 设计层面，非内核

#### 偏差 5：static-contract 估算与真 LLM 接近（验证估算法可用）

- 静态估算 after-baseline = 4.32 / 5
- 真 LLM after-baseline  = 4.67 / 5
- Δ = +0.35（估算偏保守，真 LLM 实际更好）
- **结论**：static-contract 估算可作为 sprint 内快速反馈，但**重大决策必须用真 LLM**
- **行动**：static-contract estimator 偏保守 0.35 → 可在后续 sprint 校准估算权重

#### 偏差 6：边界 case 都 5/5（边界设计成功）

- 5 条边界 case（cr_011~015）全部满分 5/5
- 耗时分布 7-39s，远低于 P95 SLA 15min
- 证明边界设计（长 PR / 空 PR / 二进制 / 仅文档 / 跨语言）通过 SKILL.md §1 / §2.1 / §2.4 三段指引完整覆盖

### 设计决策（S4 追加）

1. **stability_evidence 3 sprint 跟踪**：M3 Go 条件 6 要求 P0 case 至少跑过 3 次。S3 + S4 = 连续 2 次 ≥ GA，S5 第 3 次跑稳定后才标 graduated_at
2. **release_metadata 暴露 redline_protection 清单**：把守护的 7 大红线列出，外部审阅时一目了然
3. **m3_go_condition_7_normalized 字段**：把"M3 Go 7 条件之 7"的状态直接写在 frontmatter，方便 milestone runner 抓取
4. **failure_policy = degrade 不变**：S4-T01 混沌测试验证 degrade 策略 — code-review Skill 报错不阻断 PR

### 待 S5 完成的事项

- **case_cr_006 false_positive 治理**（偏差 4）
- N=3 重跑（M3 Go 条件 6 第 3 次 ≥ GA）
- ci-self-heal Skill 启动（与 code-review 共享 diff 解析能力）
- Daemon 形态实施（M3+ orch_006 长 PR 拆分逻辑）

---
