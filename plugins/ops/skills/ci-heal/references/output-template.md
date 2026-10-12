# ci-self-heal Skill — 输出模板

> SKILL.md §2 引用. Skill LLM 必须严格按本模板的字段顺序输出, 不允许调换顺序 / 省略字段名 (字段值可空).

## 标准模板

```markdown
## CI Failure Diagnosis

**Failure Class**: <test_failure | lint_failure | build_failure | type_error | dependency_missing | config_error | flaky | timeout | unknown>

**Confidence**: <high | medium | low>

**Verdict**: <likely_pr_caused | likely_flaky | likely_environment | needs_human>

### Root Cause Hypotheses

1. **[priority=1]** <hypothesis short title>
   - **Evidence**: <stack trace / file:line 引用 / 命令输出>
   - **Why**: <reasoning, 简短解释为什么这个根因合理>
   - **Suggested Fix**: <可执行步骤,含 diff 草稿/命令/配置改动>

2. **[priority=2]** <可选>
   - **Evidence**: ...
   - **Why**: ...
   - **Suggested Fix**: ...

3. **[priority=3]** <可选>
   - **Evidence**: ...
   - **Why**: ...
   - **Suggested Fix**: ...

### Related Files

- <file>:<line> — <为什么相关>
- <file>:<line> — <为什么相关>

### Skipped Checks

- <reason 1>
- <reason 2>
```

## 字段约束

| 字段 | 必填 | 上限 | 说明 |
|---|---|---|---|
| Failure Class | ✓ | 1 行 | 8 类 + unknown |
| Confidence | ✓ | 1 行 | 三档 |
| Verdict | ✓ | 1 行 | 4 档 |
| Root Cause Hypotheses | ✓ | ≤ 3 条 | 每条必有 Evidence/Why/Suggested Fix |
| Related Files | ✓ | ≤ 8 条 | 没有时输出 "(none)" |
| Skipped Checks | ⊘ 可空 | ≤ 5 条 | 没有跳过检查时省略整段或写 "(none)" |

## 总长度上限

- Markdown 1500 字 / 4 KB (token 成本守护)
- 超长时优先压缩 hypothesis 数量 (3 → 2 → 1), 不压缩 Evidence 引用 (RL-007 守护必须保留 file:line)

## redact 处理 (RL-002)

任何疑似凭证 (GitHub Token / API Key / Bearer / Private Key / DB DSN) 必须 redact 为 `<REDACTED:reason>` 后再输出.
detector 由 src/llm/hooks/secret-redact.ts 提供, 不在本 Skill 内重复实现.

## 中文输出 (zh_001~005)

如果 CI log / 用户消息是中文, 报告也用中文. 字段名 (Failure Class / Confidence / Verdict 等) 保留英文便于机器解析.
