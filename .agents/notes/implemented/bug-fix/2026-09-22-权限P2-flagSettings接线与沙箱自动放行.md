---
Status: implemented
Date: 2026-09-22
---
# 权限 P2：`--settings` 的 permissions 接进 checker；沙箱自动放行不再等于免确认、也不再打穿 plan/deny-write

## 决定了什么

修掉《20260920-权限系统写入门文档时核出的十项活缺陷》里剩下的两条 P2
（P2-2 已随 P0-1 于 2026-09-21 完成，本次不涉及）。

**P2-1 — `flagSettings` 死接线（`checker.ts initRules`）**

`RuleLoader.setFlagRules` 的实现、单测、优先级常量（`RULE_SOURCE_PRIORITY.flagSettings = 6`，
比 `userSettings` / `cliArg` 都高）全都在，唯独**零生产调用方**，于是
`sid-code --settings '{"permissions":{"deny":["Bash(*)"]}}'` 这类一次性收紧
checker 完全看不到——企业用 CLI 注入权限规则的通道是断的。

根因是两条加载链不汇合：`--settings` 走 `setFlagSettings()` 进的是 config/settings
合并器的**内存源**（给 `loadConfig` 用：模型、开关），而 `RuleLoader` 只读磁盘上的
user/project/local/policy 文件。`initRules` 从内存源取 `permissions` 喂给
`setFlagRules`，两链合一。用动态 import 取 `getSettingsForSource`——
`settings.ts → permission/sensitive.ts` 已有依赖，顶层 import 会成环
（同文件 `loadPolicyFile` 里 `await import("fs")` 是同一处理法）。

⚠️ 同时改掉了那行**把死接线记成资产的注释**：`initRules` 的文档注释早就写了
「cliArg 与 flagSettings 从 config 接线」，而只有 cliArg 真接了。

**P2-3 — 沙箱 Step 7 自动放行 bash（`checker.ts` + `sandbox.ts` + `cli.ts` + `config.ts`）**

分两层，第二层是本轮实测新发现、原文档没记的：

1. **默认值翻转**：`defaultSandboxConfig().autoAllowBashIfSandboxed` 由 `true` 改 `false`。
   原设计「开了沙箱就别弹窗」的前提是 Seatbelt 兜得住，而 profile 里
   `(allow file-write* (subpath "<cwd>"))` 放开了整个工作区——写 `.git/hooks/` 在 OS 层
   完全合法。**保护依赖被保护对象存在，而那个对象不存在。**

2. **自动放行不得越过模式硬约束**（新发现）。文档只记了「跳过确认」，实测发现它把
   `plan` 与 `deny-write` 这两个**代码级只读**模式也打穿了：
   `plan` + `rm -rf src` 修前 `allowed=true dr=other 沙箱保护下自动放行`，
   无沙箱时是 `allowed=false dr=mode 计划模式下只允许只读操作`。
   这比少弹一次窗严重得多——用户切到 plan 就是为了让 agent 不能改东西。
   处理判据直接沿用 Step 5.5 工具级 allow 那条（P0-3 已确立）：
   **谁声称安全都不能越过模式硬约束。**

3. **回退通道**：新增 `config.sandboxAutoAllowBash`，`cli.ts` 构造 `SandboxConfig` 时接上。
   不接这一条，翻转后的默认值就成了写死的行为，`SandboxConfig` 里那个字段变成
   生产不可达的死旋钮（`cli.ts` 此前只覆盖 `enabled`）——那等于用一个死缺陷换另一个。

## 放弃了什么（以及为什么不选）

- **只翻默认值，不加模式护栏**（即只按文档写的范围修）。否决：那样
  `enableSandbox + sandboxAutoAllowBash` 都打开时，plan/deny-write 仍被打穿。
  默认值管的是「装上就有的行为」，护栏管的是「显式开了之后的上限」，两者不互相替代。
- **只加模式护栏，不翻默认值**。否决：非 plan 模式下任意非危险 bash 仍然零确认通过，
  而这正是 P2-3 的原始诉求。
- **拿掉整个 Step 7**。否决：它是有正当用途的 opt-in（沙箱 + 本人确实想少弹窗），
  删掉是把一个可配置行为变成不可配置，超出缺陷范围。
- **不加 `sandboxAutoAllowBash`，让用户直接改 `SandboxConfig`**。否决：`cli.ts` 是唯一
  构造点且只覆盖 `enabled`，没有这条 config 字段，用户**无法**从 settings.json 回到旧行为。
- **`initRules` 顶层 import `settings.ts`**。否决：`settings.ts` 已 import
  `permission/sensitive.ts`，成环。
- **静默 catch flagSettings 取数失败**。否决：静默会让这条接线退回成
  「看起来接上了、实际又空转」——正是 P2-1 本身的形态。改为 `log.warn` 留痕。

## 拿什么证明它生效了

回归钉在 `packages/core/tests/permission/p2-wiring-and-sandbox.test.ts`（11 pass / 24 断言）。
断言刻意**不用 `if (平台)` 包住**——本仓有过「环境分支让断言一条都不跑却全绿」的前科。

**变异自证三轮**（判据是「红的是哪几条」，不只看 rc）：

| 变异 | 结果 |
| --- | --- |
| 注掉 `setFlagRules` 那一行 | 3 fail / 8 pass（恰好是 P2-1 的 deny / allow / 源归属三条） |
| `autoAllowBashIfSandboxed` 改回 `true` | 3 fail / 8 pass（默认值 + shouldAutoAllowBash + 与无沙箱基线一致） |
| 去掉 Step 7 的 plan/deny-write 护栏 | 2 fail / 9 pass（plan、deny-write 两条） |

变异全部还原，`grep -rn MUTATION packages/ scripts/` 零命中。

**端到端实跑**（`bun -e` 调被测模块自己的导出，`SID_CONFIG_DIR` 指向 tmpdir）：

P2-1，修后：
```
无 flagSettings | bash ls              allowed=false ask=true  dr=-     工具 "bash" 需要用户确认
flag deny Bash(*) | bash ls            allowed=false ask=false dr=rule  规则拒绝: bash (匹配 Bash(*))
flag deny Bash(*) | read 文件          allowed=true                     （不误伤其它工具）
flag allow Bash(whoami) | whoami       allowed=true         dr=rule
```

P2-3，三种配置对照（darwin，`isEnabled()=true`）：
```
                              修前(默认)   修后(默认)   修后(opt-in 开)
default | rm -rf src          allowed=true  ask=true     allowed=true
plan    | rm -rf src          allowed=true  dr=mode      dr=mode      ← 新发现的那半
deny-write | npm publish      allowed=true  dr=mode      dr=mode
default | redir hooks         dangerousCmd  dangerousCmd dangerousCmd  ← P1-4 防线未后移
default | curl|sh             dangerousCmd  dangerousCmd dangerousCmd
```
修后默认配置的每一行**与完全不装沙箱的基线逐字段相同**（这是测试里的判据写法，
比写死 `ask=true` 更抗管线别处变化）。

**门禁**：`bun test ./packages/core/tests/permission/` 534 pass / 0 fail；
`bun run affected-tests:run`、`make build`、`bun run lint`、`bun run format:check`、
`bun run lint:boundary` 见 PR 正文。
`bun run docs:gen-reference` 已重跑（`sandboxAutoAllowBash` 进 `website/ref/settings.md`）。

**已知未覆盖**：Seatbelt profile 本身仍放开整个 cwd 写权限——本次修的是
「不拿沙箱当免确认的理由」，没有收紧 profile。收紧 profile 是独立议题
（会影响正常构建写产物），不在本次范围。
