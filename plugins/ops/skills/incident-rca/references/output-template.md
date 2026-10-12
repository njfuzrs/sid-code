# incident-rca 输出模板

> SKILL.md §2 输出契约的可视化参考。每次 RCA 报告必须严格按以下结构。

```markdown
## Incident RCA Report

**Severity**: <P0 | P1 | P2>
**Status**: <ongoing | mitigated | resolved | unknown>
**Time Window**: <YYYY-MM-DDTHH:MM:SSZ ~ YYYY-MM-DDTHH:MM:SSZ>
**Confidence**: <high | medium | low>

### Timeline
- <ISO 时间> — <事件描述,优先用日志原文 / 排除推测>
- <ISO 时间> — <事件描述>

### Top Hypotheses
1. **[priority=1]** <根因假设短标题(< 12 字)>
   - **Evidence**:
     - <log 引用,行号 / 时间戳>
     - <metric 偏离,具体数值 + 时间戳>
     - <关联 commit hash / ADR 编号 / SKILL.md 改动>
   - **Likelihood**: <high | medium | low>
   - **Why**: <推理链,≤ 3 句>
   - **Repro Step**(可选): <最小复现路径>

2. **[priority=2]** ...

3. **[priority=3]** ...   <!-- 最多 3 条;不要为凑数硬塞 -->

### Suggested Actions
- **Hotfix**(立即,< 5 分钟可执行): <具体步骤>
- **Mitigation**(短期降级,< 30 分钟): <具体步骤>
- **Long-term Fix**(根治,需 PR / ADR): <具体步骤>

### Monitoring Gaps
- <识别的可观测性盲区:某 log / metric / trace 缺失或埋点不足>

### Skipped Checks
- <reason,例如 "trace 数据未提供" / "metric 时间窗太短">
```

## 字段说明

| 字段 | 必填 | 备注 |
| --- | --- | --- |
| Severity | ✅ | P0/P1/P2 三档,unknown 可用于 §7.2 兜底场景 |
| Status | ✅ | ongoing/mitigated/resolved 是事实状态;unknown 仅当用户没说 |
| Time Window | ✅ | ISO 时间戳;窗口外推测必须在 Monitoring Gaps 提示扩大 |
| Confidence | ✅ | 整体报告 confidence,不是单条假设的 |
| Timeline | ✅ | 按 ISO 时间正序,优先引用日志原文 |
| Top Hypotheses | ✅ | ≤ 3 条;每条必须 Evidence + Likelihood + Why |
| Suggested Actions | ✅ | 三档分清(hotfix / mitigation / long-term);时间窗有量化要求 |
| Monitoring Gaps | 推荐 | 任何"我看不到"的维度都应列出 |
| Skipped Checks | 推荐 | 缺什么数据就列什么,RL-007 守护 |

## 反例(must_not_include 守护)

- "猜测可能是 xxx"(无证据时不能高 likelihood)
- "建议重启"(allowed-tools 不含 network/exec)
- "已修复"(RCA Skill 不直接执行修复)
- "已重启"(同上)
- "无法诊断"(应走 §7.2 模板,明确缺什么)

## 与其他 Skill 模板的区别

| 模板 | 输入 | 输出主体 |
| --- | --- | --- |
| code-review/output-template.md | PR diff | Issues 列表 |
| ci-self-heal/output-template.md | CI log | Failure Class + Hypothesis + Fix |
| security-audit/output-template.md | PR diff | Verdict + 漏洞列表 + CVE |
| **本模板** | log / metric / trace / commit | **Top Hypotheses + 三档 Action + Monitoring Gaps** |

故障已发生 ≠ PR 阶段,所以 Suggested Actions 必须有"立即可执行的 hotfix",不是只给 Long-term Fix。
