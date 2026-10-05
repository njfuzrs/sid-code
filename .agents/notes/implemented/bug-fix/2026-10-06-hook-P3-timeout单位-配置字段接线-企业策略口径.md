---
Status: implemented
Date: 2026-10-06
---
# Hook P3：timeout 统一为秒、env / sequential 接通、企业策略六字段全接线、Project 不再算企业管理

## 决定了什么

一次修九条，是 Hook 缺陷清单（docs-research `20260927-Hook系统-顺着sc-11-hooks核出的缺陷.md`）的最后一批：

- **H10**：`timeout` 五种类型统一按**秒**解释，换算收敛到 `types.ts` 的 `resolveHookTimeoutMs`，runner 五处和企业策略都调它。runtime 原先按毫秒解释，现在改为秒；亚秒级需求另开 `timeoutMs` 字段（单位写在字段名里）。用户配置配不出 runtime hook，所以这次改动不碰用户，仓内唯一一处写了 runtime `timeout` 的测试已改为 `timeoutMs`。`config.ts` 里的「默认 30」注释改正为实际缺省值。
- **H11**：删掉零调用的 `session-hooks.ts`。动手前先核了「隔离要不要 sessionId 维度」：每个 App 一个 HookSystem，声明了 hooks 的子代理另起一个实例，所以隔离靠实例边界。这个结论写进了 `registry.registerSessionHook` 的注释，免得下一个人再写一个管理器。
- **H12**：
  - `maxHookTimeout` 明确为秒；
  - 未写 timeout 的 hook 按实际缺省值参与判定，堵掉原先的 fail-open；
  - runtime hook 豁免，口径与 H28 一致；
  - `blockedCommands` 由子串匹配改为命令词边界匹配，`/re/` 写法为正则；类型注释写明它是防呆，不是安全边界；
  - 四个没接线的字段经 `pickHookPolicy` 接通。字段清单 `ENTERPRISE_HOOK_POLICY_KEYS` 是唯一事实源，测试会把它和 `EnterprisePolicy` 接口逐字段比对。
- **H19**：经核实，去重 key 不含 matcher / if 属于语义：同一内容经两个 matcher 都命中时只跑一次。「过滤先于去重」这个顺序已用测试锁住。顺带修了一处真 bug：prompt / agent 的 key 原先只有 `rt:${name}`，两个未命名、内容不同的 prompt hook 会被误去重。
- **H20**：生命周期事件的 matcher 支持 `a|b`，单值仍然精确匹配，不退化成子串。
- **H21**：`if` 配在没有 tool_input 的事件上时，注册期打 warn（settings 和插件两条路径都打）。顺带修了同源的一处：`firePermissionRequestEvent` 原先不传 `toolName` / `toolInput`，导致 `if` 在 PermissionRequest 上永不命中，而文档里列了这个事件。
- **H22 / H23**：`env` 与 `sequential` 补进 settings schema 和两个转换器。零调用的 `initializeFromNew` / `HookDefinition` / `NewHooksConfig` 这条「新格式」路径整条删掉，用户配置只有 legacy 一个入口。
- **H27**：新增 `ConfigSource.Managed`。`allowManagedHooksOnly` 只放行 Runtime 和 Managed，Project 移出白名单。

## 放弃了什么（以及为什么不选）

- **把 runtime 保留为毫秒、只改文档**：五种类型里四种是秒，留下例外就等于留着下一次分叉。改为秒的代价只有一处测试。
- **给 `initializeFromLegacy` 补 Project / User 来源区分**：项目级和用户级在 config 层已经合并，来源信息到不了这里，补它要改整条 settings 链，超出本次范围。H27 只修白名单语义，并在 push 处留了注释，提醒将来补来源时 Project 不算企业管理。
- **把 matcher / if 并进去重 key**：那样同一条命令被两个 matcher 命中时会跑两次，与「去重」的本意相反。缺陷文档要求先构造用例再决定，构造之后的结论是「当前行为正确」。
- **把四个新字段也加进远程策略白名单 `ALLOWED_REMOTE_KEYS`**：那份白名单与服务端 extra=forbid 闭集对齐，客户端单方面放行没有意义。目前只能从本地 managed-settings 生效，这一点写进了 `PolicySettings` 的注释。
- **`blockedCommands` 做 shell 解析**：等价写法无穷，做得再深也只是防呆，所以选择在文档里写明它的定位。
- **H11 的 sessionId 维度补进 registry**：没有同实例多会话的使用方，补了就是一个没人用的维度。

## 拿什么证明它生效了

- `packages/core/tests/hook/hook-p3-timeout-config-policy.test.ts` 共 24 条，每条正反两面都断言。12 个修复点逐一撤回做变异自证，每次都至少 1 条转红，全部还原后全绿。
- `enterprise-policy-gate.test.ts` 原先断言「Project 被放行」，实际是把 H27 的错误语义锁死了，现已改为断言 Project 被拦、Managed 放行。
- `bun run affected-tests:run`：2826 pass / 0 fail。`make build`、`lint`、`lint:boundary`、`docs:gen-reference --check` 全过。
- ⚠️ **未验证**：四个企业策略新字段还没在真实会话里被触发过。按 CLAUDE.md「新防线的验收判据是真实会话被触发过」，它们目前只能算「接上了」。Managed 源也还没有生产者：开启 `allowManagedHooksOnly` 后，实际只剩内部 runtime hook。
