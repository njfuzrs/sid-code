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
