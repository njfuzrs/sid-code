# sid-code — 从"个人 Coding CLI"演进为"研发智能基座"

## 0. 全局约束（每次会话必读）

- **语言**：所有回复、代码注释、文档均用中文
- **联网工具**：遇到不熟悉的 API / 库 / 报错信息时，主动用 tavily-mcp / context7-mcp 查最新文档，不要凭记忆猜
- **调试日志**：排查复杂 bug 时主动在关键路径加详细日志（console.log / debug 模块）；修复确认后清理
- **禁止创建文档**：除非用户明确要求，不要创建任何 README / SUMMARY / 总结 / 说明等文档文件
- **构建验证**：task 完成后跑 `bun test`（全量单测，以实际输出为准）以及跑 `make build` 验证构建成功，**不可跳过，必须执行**
- **禁止省略占位符**：write/edit 工具会**自动检测并拒绝**含三个英文点号省略标记的内容。代码文件中 **NEVER** 用 `// … rest of` 或 `# … rest` 代替已存在的代码；Markdown 文档中如需示意省略，用 Unicode 省略号 `…`（U+2026）或 `[内容省略]` 代替 ASCII 三连点 `...`。被拒绝后不要反复用 edit 修补同一文件——直接 full rewrite。

## 0.1 战略定位（2026-05 起，长期不变）

sid-code 是一个**通用 AI 编程基座**，对标 Claude Code 的 Agentic While-Loop 架构。从 2026-05 起向"对外可交付的研发智能基座"（档位 B）演进，路线按 Sprint S0–S4 / 里程碑 M0–M3 推进。这是后续全部 task 的根背景。

- **完整战略**：`docs/eval/演进路线/智能研发基座-final.md`
- **档位选择**：B（对外可交付）；**不追求** C（跨行业平台，那是 Port/Backstage 赛道，护城河在企业销售关系而非技术）
- **产品范式**：C — 通用 Runtime + Skills（**禁止**做"N 个独立 Agent"或"单体大 Agent"）
- **核心叙事**：**通用 AI 编程基座 + 多垂直场景 Skill 集**。基座层面对标 Claude Code，帮开发者写好代码；Skill 体系让基座能力横向扩展到 Review / CI / Security / Governance / Incident 等质量保障场景，形成"先写好代码，再兜好底"的完整闭环
- **首批重点 Skill**：code-review / ci-self-heal / incident-rca / security-audit / code-governance（覆盖 PR-to-Prod 质量闸门），同一基座未来可扩展到更多垂直场景
- **技术栈**：TypeScript + Bun + Ink；核心架构 Agentic While-Loop（用户输入 → LLM 流式响应 → stop_reason=tool_use 时执行工具并继续循环，end_turn 时结束）

### 五层洋葱架构（任何改动前先确认改的是哪一层）

```text
第 5 层 用户触点  CLI / SDK / Daemon / MCP Server / IDE Plugin（五形态共存，同一内核）
第 4 层 Skill 集  变现层：写 Markdown 而非代码；agentskills.io 标准
第 3 层 Context   护城河：代码图谱 / LST / 调用链 / Memory / ADR（必建，无供应商）
第 2 层 工具+集成 商品化：内置工具 + MCP；混合（核心自建 + 长尾用开源）
第 1 层 Runtime   商品化：Agent loop / Permission / Hook；海外 Buy / 国内 Build 双模
```
