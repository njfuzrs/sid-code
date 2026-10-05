---
Status: implemented
Date: 2026-10-05
---
# 新增 tool_invoked / plugin_installed 事件，按企业市场插件统计调用与安装

## 决定了什么

- `analytics/events.ts` 新开「漏斗 10 · 插件」：`TOOL_INVOKED: "tool_invoked"`、`PLUGIN_INSTALLED: "plugin_installed"`，
  门面 `logToolInvoked(toolName, origin)`、`logPluginInstalled(opts)`。字段扁平、**不加 `_PROTECTED_`**：
  只对企业市场插件发，插件名 / 市场名 / 工具名都是管理员上架时登记审核过的目录项，不是用户私有服务名；
  加了前缀会被 HTTP 后端默认 `stripProtected=true` 剥掉，按插件聚合又取不到。
- 新增 `analytics/plugin-attribution.ts`：进程内单例注册表 `setMarketPlugins(entries)`（整表替换）/
  `__resetMarketPluginsForTest()`，以及来源解析 `mcpPluginOrigin(serverName, rawToolName)`、`skillPluginOrigin(skill)`。
  查不到注册表 ⇒ 不发（本地目录、`--plugin-dir`、内置插件、用户自配 MCP）。cli 侧调用 `setMarketPlugins` 在插件市场客户端 PR 接线。
- **发点在工具自身的 execute 里**：`mcp/manager.ts` 的 `MCPToolAdapter.execute` 开头、`skill/meta-tool.ts` 权限通过之后。
  MCP 归因用适配器上本来就有的**原始** `serverName`（配置 key `plugin:<plugin>:<server>`）与原始 `def.name`。
  Skill 归因用 skill 定义的 `loadedFrom === "plugin"` + 定义名 `<plugin>:<skill>`。
- 哨兵门禁加 `PENDING_WIRING` 豁免 `logPluginInstalled`（调用点在插件市场客户端 PR），且豁免**自我失效**：
  一旦该函数出现生产调用点，哨兵变红逼着删豁免。

## 放弃了什么（以及为什么不选）

- **改 stripProtected=false**：会把用户自配 MCP 的私有服务名一起放给非特权后端，已在设计文档否决。
- **发点放在三个执行器的 logToolCall 旁边**（query / agent / sub-agent）：四条执行路径（还有 forked-agent 根本不调 logToolCall）
  都要各接一次，漏一处少计、两层都接重计；而所有路径最终都调 `tool.execute`，工具里发天然单一汇聚点。
  代价：MCP 路径在 hook 阻止 / 校验失败时不计（工具没真正执行，符合「开始执行才算」）。
- **从 `mcp__...` 工具名反推插件名**：`buildMcpToolName` 把 `:` 换成 `_` 并截断，而 `_`/`-` 是合法插件名字符，有歧义。
- **skill 用模型输入名取前缀**：`getSkill` 不区分大小写，输入名不一定等于登记名；且用户自写的 `foo:bar` skill 不应归因到插件 foo。
- **在门禁里给 `logPluginInstalled` 写个假调用点**：会让「有生产调用点」变成谎言；显式豁免 + 自我失效更干净。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/analytics/tool-invoked.test.ts`：15 pass（真实 MCPManager + stdio mock server；
  主循环与子代理执行器各一条，断言 tool_invoked 与 tool_call 一比一）。
- 变异 1：去掉 `logToolInvoked` 的注册表检查 → 3 fail（「本地插件 MCP 不发」「本地插件 skill 不发」「整表替换」）。
- 变异 2：MCP 适配器里重复发一次 → 3 fail（含「主循环 / 子代理同一调用只发一条」）。
- 变异 3：在生产源码里出现 `logPluginInstalled(` → 哨兵「门面每个 emit 函数都有生产调用点」变红（豁免自我失效）。
- `bun run affected-tests:run` 2528 pass / 0 fail；`make build` exit 0、`will always be undefined` 0 处；
  `bun run lint` / `format:check` / `lint:boundary` 全绿。
- 尚未验证：真实企业市场安装 + 后端聚合出调用次数（依赖 cli 侧 `setMarketPlugins` 接线与服务端白名单上线）。
