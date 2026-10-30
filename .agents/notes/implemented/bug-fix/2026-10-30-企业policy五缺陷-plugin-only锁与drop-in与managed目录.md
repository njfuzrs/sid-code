---
Status: implemented
Date: 2026-10-30
---
# 企业 policy 五缺陷：plugin-only 锁接到 hooks/MCP、drop-in 进执行层、managed 目录跟平台走且系统级最后合并

## 决定了什么

- **D1**：`strictPluginOnlyCustomization` 锁 `hooks` 时，`HookRegistry.getHooksForEvent` 在执行期只保留 Managed / Plugin / Runtime 来源。锁 `mcp-servers` 时，`MCPManager.passesPolicy` 只放行 `plugin:` 作用域 server 和带 `BUILTIN_MCP_SERVER` Symbol 标记的内置集成（IDE）。
- **D2**：新增 `config/managed-policy-file.ts` 的 `readManagedPolicyDocument()`，合并主文件和 `managed-settings.d/*.json`（语义 = `mergeSettingsRead`）。`ManagedFileLoader` 和 `RuleLoader.loadPolicyFile` 都改走它。主文件 JSON 坏掉时，`ManagedFileLoader` 维持原口径整体返回 null。
- **D3**：`managedExtensionDirs` 的系统级目录改为 `join(managedSettingsSystemDir(), type)`。macOS 额外扫旧的 `/etc/sid-code/<type>`，命中时打弃用告警。
- **D4**：目录顺序改为「用户级 → (macOS 旧 /etc) → 系统级」。ExtensionLoader 后合并的覆盖先合并的，所以同名以系统级为准。
- **D5**：commands（`cli/src/command/custom.ts`）和 agents（`core/src/agent/custom.ts`）默认注入 `managedDirs`，与 skills 同口径。
- 官网 `website/team/policy.md` 删掉了四处「目前只…」的限制说明，改写成现在的行为。

## 放弃了什么（以及为什么不选）

- **D1 在加载期（`collectHookLayers` / `config.ts` MCP 合并）判锁**：不选。这两处都在 `loadConfig` 里执行，早于 `cli.ts` 的 `applyLoadedPolicy` 注入锁，判定读到的是空集，等于没修。MCP 合并层还覆盖不到 `--mcp-config`、运行时 addServer、审批后连接这几条路径（与 D13 把 mcpPolicy 下移到 manager 的理由相同）。执行期判定也能自然覆盖策略轮询中途改锁的情况。
- **用 `scope: "dynamic"` 识别 IDE server**：不选。scope 是普通 JSON 字段，用户在 settings 里写一个就能冒充内置集成，绕过锁。改用 Symbol 键，JSON 产生不出来。测试里有一条「伪造 scope 无效」的断言。
- **D1 把 `allowManagedHooksOnly` 合并进 plugin-only**：不选。两者语义不同：前者连插件 hook 也拒，后者放行企业插件。保留为独立开关、取并集，官网写清楚两者的差别。
- **D4 改为 first-exists-wins（系统级存在就忽略用户级）**：不选。用户级目录承担「没部署系统级时个人试用」和「系统级只发了一部分、用户补别的」两种用途，first-exists 会让后一种静默失效。「系统级最后合并」已经满足「用户盖不过企业」这个安全诉求，而且不丢功能。
- **drop-in 测试用环境变量重定向目录**：不选。环境变量本机用户能设，等于给用户一个改策略来源的口子。改用进程内的 `__setManagedSettingsDropInDirForTest`。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/config/enterprise-policy-d1-d5.test.ts`：11 pass / 0 fail。
- 变异自证（逐个把实现改坏再跑同一文件，看报了什么）：
  - D1-hooks 判定改 `if (false)` → 2 fail（锁 hooks、锁全部）
  - D1-mcp 判定短路 → 2 fail（锁 mcp-servers、锁全部）
  - D2 `ManagedFileLoader` 不读合并文档 → 1 fail（只有 drop-in 的用例）
  - D2 合并函数不 merge drop-in → 3 fail（loader、合并语义、RuleLoader）
  - D3/D4 去掉系统级目录 → 1 fail
  - D5 agents 不注入 managedDirs → 1 fail
- 没在真机部署系统级策略文件实测（需要 root 写 `/Library/Application Support/SidCode`）。D2 的端到端用户级回退 + drop-in 路径由单测覆盖，`sc-dev` 实机验证见 PR 正文。
