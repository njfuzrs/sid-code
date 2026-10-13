---
Status: implemented
Date: 2026-10-13
---
# allowed-tools 回到权限层：只产生免确认 allow 规则，fork 只由 context: fork 决定

## 决定了什么

触发：轨迹 `20261013-100055-7eeb1160`，自定义命令写了 CC 风格 `allowed-tools: Read, Glob, Bash(ls*) …`，
被当成工具白名单 + 触发 fork；子代理按大小写敏感精确查表只挂上两个 MCP 工具，且未注入 checker，
读文件一律走 B0 fail-closed（`source=other, context=subagent`）。

- **公共解析** `core/tool/allowed-tools-spec.ts`：括号感知切分（对齐 CC `parseToolListFromCLI`），
  `rules` 原样交规则引擎，`toolNames` 经 `toInternalToolName` 归一。skill loader / 自定义命令 / agent `tools:` / `--allowed-tools` 共用。
- **语义**：`allowed-tools` = commandScoped 源的 allow 规则（优先级最低，任何 deny/ask 压得住），不裁剪工具集、不触发 fork。
  inline 只作用于触发它的那一轮（app.ts onUserInput 前设、finally 清）；fork 只加在派生 checker 上。
- **fork 统一入口** `core/agent/forked-command.ts` `runForkedCommand`：`permissionChecker` 必填（null 直接报错返回），
  工具集 = `agent ?? general-purpose` 走 `filterToolsForAgent`；子代理 checker 回到根 checker 派生，
  继承 always-allow / skip-permissions，其余 dontAsk。6 个调用方全部改走它（P3 结构性根除）。
- **缺省上下文**：skill 与自定义命令缺省 inline（只认 `context: fork` / `mode: delegate`）；
  自定义命令只写 `model` 仍 fork 并 warn（D2：主循环无单轮换模型口子）。
- **不可信来源**（项目级 / 插件 / MCP）：剥离 `Bash(*)`、`Bash(rm …)`、裸 `Bash/Write/Edit` 等自我授权。
- **只读护栏迁移**（方案 E）：code-review / security-audit / ci-self-heal / code-governance / incident-rca 等改 `agent: verify`。
  `DEFAULT_SKILL_ALLOWED_TOOLS` / `resolveSkillAllowedTools` 删除。
- **`--allowed-tools` / config.allowedTools**（P7）：Step 12 改走规则引擎匹配（认 CC 名、`Bash(pattern)`）。
- **可观测**（方案 G）：子代理日志打实际工具；未命中名 warn；新增轨迹事件 `CommandAllowedTools{declared, rules, dropped, trusted}`，
  记在 `RuleLoader.setCommandScopedRules`——inline / fork 同一出口，不会漏路径。

## 放弃了什么（以及为什么不选）

- **只做名字归一、保留白名单语义（最小修）**：只修 P2，P1/P3/P4/P5 依旧，且「allowed-tools 在 sid 与 CC 意思不同」的根偏差会继续制造同类问题。
- **项目级来源不过滤危险规则（完全照搬 CC）**：仓库可随代码分发 `.claude/commands/*.md`，项目级 = 不可信，已有防线不因对齐而拆。
- **新增 sid 专有 `disallowed-tools` frontmatter 做只读护栏（D4）**：CC 没有这个字段，迁移来的 skill 不认；`agent:` 是 CC 原生收窄手段。
- **原方案拆 3 个 PR**：按 CONTRIBUTING「同一关注点合到最大」，三者改的是同一个语义偏差的不同出口，且相互依赖（解析器共用），合成一个 PR。
- **inline 单轮换模型**：主循环没有这个口子，强加会动主循环；保留 model→fork + warn。

## 拿什么证明它生效了

- 新增测试：`packages/core/tests/permission/allowed-tools-semantics.test.ts`（T1/T6–T10/T13/T14 + 事件）、
  `packages/cli/tests/command/allowed-tools-fork-semantics.test.ts`（T2–T5/T11/T12）。
- 全量 `bun test`：修完剩余用例后 0 fail（见 PR 正文贴的输出）；`make build` 成功；`typecheck:gate` 无新增。
- ⚠️ 未做：方案 8.2 的真实会话复现（`/project-qa` 三种启动模式各跑一遍）需在合并发版后用 `sc-dev` 跑，
  判据是该会话 `PermissionDecision outcome=deny ∧ source=other ∧ context=subagent` = 0，且出现 `CommandAllowedTools` 事件。
