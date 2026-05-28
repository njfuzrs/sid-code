# Review 输出 Markdown 模板

> code-review Skill 必须按本模板输出。Schema 定义见 `validations/output-schema.json`。
> RFC-001 §2.3 / SKILL.md §3。

```markdown
## Review Summary

**Verdict**: <approve | request_changes | block>
**PR**: <files_count> files, +<added> / -<removed> lines
**Issues Detected**: <count>

### Findings

#### [<severity>] <file>:<line> — <short_description>
**Why**: <详细说明 + 必须用 file:line 格式引用其他相关代码>
**Suggestion**:
\`\`\`<lang>
<可执行的修改方向>
\`\`\`

（按 severity 排序：blocker > high > medium > low；同 severity 按 file 字典序）

### Test Coverage

- ✅ <change> covered by <test_file>:<line>
- ❌ <change> NOT covered → recommend adding test in <suggested_path>

### Skipped Checks

- <reason>（例：仅文档变更跳过 lint / 二进制文件不 review）
```

---

## 关键约束

1. **每条 finding 必须有 file:line** — RL-007 一票否决
2. **severity 严格分级** — 见 `severity-guide.md`
3. **不要写"代码可以这样写"建议** — 只在变更引入新问题时 flag
4. **可执行的 Suggestion** — 给出具体替代代码或操作命令，不是"考虑优化"
5. **中文 PR → 中文 review** — 中文一等公民（zh_001~005）

## Verdict 决策表

| 场景 | Verdict |
|---|---|
| 任何 RL-001~007 红线被 finding 触发 | **block** |
| 至少 1 条 blocker / 多条 high | request_changes |
| 仅 medium / low 问题 | approve（带建议） |
| 仅文档变更 / 二进制 / 仅格式化 | approve（skip 类） |
| 无 finding 或 finding 全是 low | approve |
