---
Status: implemented
Date: 2026-10-21
---
# MCP 官网文档按源码事实校准，并修掉导致写错的 4 处注释漂移

## 决定了什么

`website/extend/mcp.md` 有 8 处与源码事实不符，全部按源码校准；同时修正 4 处**上游成因**——代码注释与实现相反，文档是照抄它们写出来的。行为零变更。

**硬错误 3 处（文档与代码结论相反）**

1. **`env` 展开**：文档称「`env` 的值不做 `${VAR}` 展开，只有 command/args/url/headers 会展开」，还引了 `env-expansion.ts` 作依据。实际同一文件 `packages/core/src/mcp/env-expansion.ts:60` 明确展开 `env`，`:39-41` 的注释专门解释了为什么（把 `MY_API_KEY` 改名喂成 server 要的 `API_KEY`；不展开会让字面量覆盖继承来的真值）。文档连带的两条建议（「key 展开不了只能写死」「推荐删 env 块改 shell export」）一并改写。
2. **Resources 工具延迟加载**：文档称 `ListMcpResources` / `ReadMcpResource`「和 Tools 一样走延迟加载」。实际延迟判定在 `packages/core/src/tool/registry.ts:497-501` 只认 `tool.shouldDefer` 或 `mcp__` 前缀；两个工具定义在 `packages/core/src/tool/mcp-resources.ts:31,83`，两条都不满足，**常驻首轮**。且 `tool_search` 只搜延迟池（`registry.ts:605`），它们反而搜不到。文档 `:452-456` 自己贴的实测输出「可用的 MCP 相关工具只有两个：ListMcpResources、ReadMcpResource」就是反证——内部自相矛盾。
3. **`/mcp` 面板审批入口**：文档给了三条批准途径，第三条「或 `/mcp` 面板」不存在。`packages/cli/src/ui/components/McpDialog.tsx:401-415` 的 server 菜单只有查看工具 / 重新连接 / 启用 / 禁用 / OAuth 授权；待审批快照的 UI 消费方是**启动审批框**（`packages/cli/src/ui/components/DialogSwitch.tsx:238` → `app.ts:11117`）。

**不完整 3 处**

4. 传输方式「三种」→ **五种**：`stdio` / `http`（Streamable HTTP）/ `http-json`（旧单 JSON，兼容保留）/ `sse` / `ws`，枚举见 `packages/core/src/config/settings/types.ts:82`，五个分支都有真实实现（`packages/core/src/mcp/manager.ts:727-755`）。
5. 「不写 `transport` 按 url 推断」限定到 `.mcp.json` / `mcp.local.json`（`packages/core/src/mcp/project-files.ts:57-64`）；`settings.json` 里 `transport` 是必填（`config/settings/types.ts:88`），缺了会在启动横幅报「无效值」（`config/config.ts:1860` → `app.ts:7532`），不会被推断。
6. 审批指纹覆盖范围：文档只列 5 个字段。实际是**排除法**——`packages/core/src/mcp/approval.ts:114` 只排除 `enabled`，其余全部字段（含 `transport` / `timeout` / `retries` / `includeTools` / `excludeTools` / `auth` / `oauth`）都进 SHA-256。

**新增 2 节（原文档完全没写）**

- 工具返回值的上限：`DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25000`（`packages/core/src/mcp/mcp-output-limit.ts:21`）+ 超过 10 万字符落盘完整结果（`packages/core/src/mcp/manager.ts:62,204-212`）。
- server `instructions` 注入：截断到 2048 字（`packages/core/src/mcp/manager.ts:76`），首次连上时以 `<system-reminder>` 围栏增量注入到用户消息（`packages/core/src/query/loop.ts:2056-2068`）。

**注释漂移 4 处（本次一并修，是文档写错的上游）**

- `packages/core/src/config/config.ts`：「供 `/mcp` 面板展示与审批」→ 启动审批框，并写明面板看不到未加载项。
- `packages/core/src/mcp/config.ts`：去重优先级注释写成 `user > local > project > dynamic`，与同文件 `SCOPE_PRIORITY`（`dynamic: -1` 最高）相反。
- `packages/core/src/mcp/transport.ts`：文件头「支持 stdio、HTTP 和 SSE 三种」→ 五种。
- `packages/core/src/mcp/approval.ts`：「`/mcp` 面板读它」「下次启动即加载」→ 启动审批框 + D17 起当场热连。

## 放弃了什么（以及为什么不选）

1. **不新开 issue、不写缺陷文档**。复核结论是**没有代码行为缺陷**，全部是文档与注释漂移；第 3 条（面板缺审批入口）也被判为「文档承诺了不存在的功能」而非代码 bug——要不要在面板里加审批是产品决策。按仓库约定「文档、拼写、路径漂移直接提 PR」即可。
2. **不给 `/mcp` 面板补审批入口**。最小正确改动是删掉文档里的错误承诺；把 approval 快照接进 McpDialog 是新功能，超出「文档校准」范围，也不该顺手塞进这个 PR。这条已记为后续候选。
3. **不调 `MAX_INSTRUCTIONS_LENGTH` / `DEFAULT_MAX_MCP_OUTPUT_TOKENS` 的取值**。文档缺的是「有没有上限」，不是「上限设得对不对」；调参是上下文预算 vs 信息完整性的另一个权衡，需要单独论证。
4. **不加「文档与代码事实」自动门禁**。这类断言是自然语言（「env 是否展开」「哪些工具延迟」），机械门禁只能覆盖少数可枚举点，覆盖不到语义断言；恒绿的假门禁比没有门禁更危险。补偿是把「改文档前先回源码核」这个动作留在这里，靠 review 守。

## 拿什么证明它生效了

```
bun run docs:gen-reference  → 6 页参考文档 + llms.txt 已生成（frontmatter description 改过，摘要同步）
bun run lint                → Found 0 warnings and 0 errors（2601 文件）
bun run format:check        → All matched files use the correct format
bun run lint:boundary       → 绕过端口直连底座 0 处
bun run lint:command-system → ✓ 三道门禁通过
bun run typecheck:gate      → 当前 66 处错误 / 基线 66 处，✓ 无新增类型错误
bun run affected-tests:run  → 1250 pass / 1 skip / 0 fail（83 文件，26.41s）
make build                  → 自检通过：关键修复已内联进二进制
```

事实核对方式：每条改动都回源码取证并记了 `file:line`（见上）。三处硬错误各有独立反证——#1 有 `env-expansion.ts` 自述展开理由的注释；#2 有文档自身 `:452-456` 的实测输出；#3 有 `McpDialog.tsx` 完整菜单分支 + 待审批快照的真实消费方。

**未做到的**：没有真跑 `sc-dev mcp add/list` 做端到端复核。本次未改任何 CLI 输出示例（那些文案已逐字核对过源码字面量），但「文档示例输出 == 真实运行输出」这一层仍只有源码级证据，没有运行级证据。
