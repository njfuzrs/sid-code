# sid-code — 从"个人 Coding CLI"演进为"研发智能基座"

## 0. 全局约束（每次会话必读）

- **语言**：所有回复、代码注释、文档均用中文
- **联网工具**：遇到不熟悉的 API / 库 / 报错信息时，主动用 tavily-mcp / context7-mcp 查最新文档，不要凭记忆猜
- **调试日志**：排查复杂 bug 时主动在关键路径加详细日志（console.log / debug 模块）；修复确认后清理
- **禁止创建文档**：除非用户明确要求，不要创建任何 README / SUMMARY / 总结 / 说明等文档文件
- **构建验证**：task 完成后跑 `bun test`（全量单测，以实际输出为准）以及跑 `make build` 验证构建成功，**不可跳过，必须执行**

## 0.1 战略定位（2026-05 起，长期不变）

sid-code **不是**"又一个 Coding CLI"——从 2026-05 起向"对外可交付的研发智能基座"（档位 B）演进，路线按 Sprint S0–S4 / 里程碑 M0–M3 推进。这是后续全部 task 的根背景。

- **完整战略**：`docs/eval/演进路线/智能研发基座-final.md`
- **档位选择**：B（对外可交付）；**不追求** C（跨行业平台，那是 Port/Backstage 赛道，护城河在企业销售关系而非技术）
- **产品范式**：C — 通用 Runtime + Skills（**禁止**做"N 个独立 Agent"或"单体大 Agent"）
- **核心叙事**：**"为 AI 代码兜底"**（Code Review / Security / Governance / Incident），不是"用 AI 加速编程"——前者新增需求，后者已红海
- **PR-to-Prod 主轴 5 个 Skill**：code-review → ci-self-heal → incident-rca → security-audit → code-governance
- **技术栈**：TypeScript + Bun + Ink；核心架构 Agentic While-Loop（用户输入 → LLM 流式响应 → stop_reason=tool_use 时执行工具并继续循环，end_turn 时结束）

### 五层洋葱架构（任何改动前先确认改的是哪一层）

```text
第 5 层 用户触点  CLI / SDK / Daemon / MCP Server / IDE Plugin（五形态共存，同一内核）
第 4 层 Skill 集  变现层：写 Markdown 而非代码；agentskills.io 标准
第 3 层 Context   护城河：代码图谱 / LST / 调用链 / Memory / ADR（必建，无供应商）
第 2 层 工具+集成 商品化：内置工具 + MCP；混合（核心自建 + 长尾用开源）
第 1 层 Runtime   商品化：Agent loop / Permission / Hook；海外 Buy / 国内 Build 双模
```
