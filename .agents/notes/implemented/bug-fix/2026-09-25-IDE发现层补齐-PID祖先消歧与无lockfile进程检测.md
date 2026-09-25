---
Status: implemented
Date: 2026-09-25
---
# IDE 发现层补齐：多窗口 PID 祖先消歧，与 lockfile 全无时的进程检测

## 决定了什么

方案文档「15-CC IDE 集成对标」里的 P0 三项（diff 死接线、通知名前缀、diff RPC 协议）
与 P1 的端口探活 / NFC 归一化 / WSL 寻址 / ide_connected 通知，都已在 main 上
（`76b05e9d`、`ddb49d76` 及随附提交）。本次只补那份文档里还没落地的两块发现层缺口：

1. **多个 IDE 窗口打开同一工作区时的消歧。** 此前 `detectIDEs` 匹配到多于一个就直接
   返回 null，交给手动选择。现在在受支持 IDE 的内置终端里（`TERM_PROGRAM` 命中
   vscode/cursor/windsurf），用 lockfile 的 PID 是否落在本进程祖先链上过滤，
   只留「启动我们的那个窗口」。
2. **lockfile 一个都没有时的提示。** `/ide status` 与 `/ide connect` 此前一律说
   「未发现可用 IDE」。现在先用 `ps` 看机器上有没有 vscode/cursor/windsurf 在跑，
   有就点名并指向 `/ide install`，没有或查询失败才退回通用文案。

顺带修了一处判据：`isProcessRunning` 把 `EPERM` 当「进程死了」。它的用途是决定
**删不删 lockfile**，没权限给一个进程发信号不等于它死了，判死会清掉一个活着的 IDE。
这条与 Claude Code 的同名函数故意相反（CC 用它做锁接管，判 false 才是保守的）。

## 放弃了什么（以及为什么不选）

- **在所有终端里都做祖先消歧。** 外部终端里我们的祖先是 shell/tmux，lockfile 的 PID
  不可能落在里面，过滤恒为空，自动连接整体失灵。所以只在 IDE 内置终端里过滤，
  外部终端保持「多匹配 → 手动选择」的原行为。
- **把「查询失败」和「链是空的」都表示成空 Set。** 生产路径会在查询成功后把直接父进程
  补进集合，失败时若也补，就把「没查到」伪装成「链上只有父进程」，消歧据此滤掉所有
  别的窗口。所以查询结果是 `{ ok: true, pids } | { ok: false }` 两态，失败时一个都不滤。
  上一轮的测试把 `ancestorPids: new Set()` 当成「查不到」，而实现把它当成「查询成功且链为空」，
  用例名与断言对不上实现 —— 本次拆成 `ancestorLookup: { ok: false }`（保留全部）
  与空集（全部滤掉）两条对照用例。
- **识别 JetBrains。** 进程检测只列扩展安装路径覆盖得到的三种。识别出一个我们既没有
  扩展也装不上的 IDE，只能给出一条兑现不了的「去装扩展」提示。
- **端口探活、NFC、WSL、ide_connected、diff 接线。** 核对后确认已在 main 上且有测试
  （`packages/core/tests/ide/robustness.test.ts`、`diff-wiring.test.ts`），不重复做。
- **diffTool 配置开关、URI handler、Tab 徽章。** 方案文档自己标为 P2，且依赖自研 IDE 扩展，
  本次不做。

## 拿什么证明它生效了

```text
bun run affected-tests
  → 判定：selective，bun test ./packages/cli/ ./packages/core/tests/ide/
bun test ./packages/cli/ ./packages/core/tests/ide/ --test-name-pattern '^(?!.*\[slow\])'
  → 1624 pass / 0 fail（146 files，25.44s）
make build
  → 自检通过；grep "will always be undefined" 命中 0
bun run lint / bun run lint:boundary
  → oxlint 无输出；越界依赖 0 处
bun run format:check
  → All matched files use the correct format
```

首次选测曾 46 fail / 42 error，全部是 `Cannot find module '@sid-code/tui-renderer/...'`：
worktree 没有 `.vendor-src/`。`bun run vendor:fetch` 之后同一命令 0 fail，
与本次改动无关。
