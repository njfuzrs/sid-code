# Severity 分级指南

> code-review Skill 的 finding severity 必须按本指南分级。
> RFC-001 §4.2（false_positive 控制）/ SKILL.md §3 +§4.2。

---

## 4 档分级

| Severity | 触发条件 | Verdict 影响 |
|---|---|---|
| **blocker** | 必须修复才能合并；触发任意红线 / 严重 bug / 安全漏洞 | block |
| **high** | 强烈建议修复；逻辑 bug / 设计问题 / 测试缺失（核心模块） | request_changes |
| **medium** | 建议改进；轻微设计问题 / 测试缺失（次要模块） | approve（带建议） |
| **low** | 可选；style / 注释 / 文档建议 | approve |

---

## blocker 类（一票否决）

仅当满足以下之一时使用：

1. **红线触发**（RL-001~007 任意一条）
   - 删用户代码 / 泄露凭证 / 绕过 Permission / 无限循环 / 跨租户泄露 / 改测试断言 / 编造问题
2. **明确逻辑 bug 会导致功能失败**
   - 数组越界 / null 解引用必现 / 资源泄漏 / 死锁
3. **明确安全漏洞**
   - SQL injection / Command injection / XSS / 路径遍历 / 硬编码密码
4. **AI 编造内容**
   - 编造的 npm 包 / 编造的 API / 编造的文件路径
5. **破坏核心机制**
   - 修改 agentic while-loop 退出条件 / 修改 Permission 检查器逻辑

> ⚠️ blocker 不是"严重 style 问题"——一旦使用就会 block PR，需要谨慎。

---

## high 类

满足以下之一：

1. **可能导致 bug 的边界情况**
   - 缺 null 检查（在可能为 null 的路径） / 异常静默吞掉
2. **设计反模式**
   - 紧耦合 / 跨层访问 / 违反开闭原则
3. **测试缺失（核心模块）**
   - Permission / Agent loop / Provider 等核心改动无测试
4. **性能严重问题**
   - N+1 查询 / 嵌套循环 O(n²) 在生产路径
5. **race condition / 并发问题**

---

## medium 类

满足以下之一：

1. **轻度设计问题**
   - 函数过长 / 嵌套过深 / 命名不清晰
2. **测试缺失（次要模块）**
3. **轻度性能问题**
   - 不必要的临时数组 / 重复计算
4. **错误处理不完善**
   - try/catch 静默吞错（但无明确 bug）

---

## low 类

满足以下之一：

1. **代码风格** — 缩进 / 括号位置（不违反 lint 规则）
2. **注释建议** — 缺少 JSDoc（非 public API）
3. **可读性提示** — 命名可改进（不影响理解）
4. **可选优化** — "如果想..."类建议

> low 类大量出现 = 误报多。Skill 应控制 low 类总数 ≤ 3 条/PR。

---

## 反例（**不要**这样分级）

| 错误用法 | 正确做法 |
|---|---|
| try/catch 防御性编程 → blocker | medium / low（除非吞错带来真 bug） |
| 缩进风格 → blocker | low |
| 函数过长 → high | medium 或 low |
| "可能"有性能问题 → high | 不要报（"可能"问题 → 不报） |
| 注释拼写错误 → blocker | low（甚至不报） |

---

## RL-007 守护

每条 finding 必须有 `file:line` 真实引用。**不能用以下模糊用语**：

- ❌ "可能存在问题"
- ❌ "请确认"
- ❌ "I'm not sure"
- ❌ "建议复查"（无具体行号）

✅ 正确："src/auth/login.ts:13 — 硬编码密码 admin123，pattern: `password === \"admin123\"`"
