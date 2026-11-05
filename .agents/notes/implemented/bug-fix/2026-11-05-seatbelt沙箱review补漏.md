---
Status: implemented
Date: 2026-11-05
---
# Seatbelt 沙箱 review 补漏：凭据边界、包管理器缓存、子代理埋点

承接 PR #601（`fix/seatbelt-sandbox`，读放开 + 写白名单 + 网络三档）。
那份 PR 把「开启即全挂」修好了，但 review 时用真跑 profile 的方式核出几处边界没兜住，
本 Note 记录这一轮补漏的决定与证据。

## 决定了什么

- **写白名单补包管理器缓存**（`~/.npm`、`~/.bun`、`~/.yarn`、`~/.pnpm-store`、
  `~/Library/pnpm`，`packages/core/src/permission/sandbox.ts` 的
  `PACKAGE_MANAGER_CACHE_DIRS`）。**这同时修正了 PR #601 Note 里的一条错误前提**：
  它说「`.npmrc` 进 deny 会让 `npm install` 直接不可用，所以刻意保留」，
  但实测即使不 deny `.npmrc`，`npm install` 写 `~/.npm/_cacache` 也会
  `operation not permitted` —— 缓存目录不在写白名单这件事本身就让包管理器不可用。
- **读 deny 补两处凭据面**：`~/Library/Keychains`（`SENSITIVE_HOME_DIRS`）与
  `~/.git-credentials`（`SENSITIVE_HOME_FILES`）。前者在「读放开 + `(allow mach-lookup)`
  全开」的组合下是真实缺口：实测沙箱内 `security list-keychains` 成功、keychain 数据库可读；
  后者在应用层（`permission/path-validator.ts`、`permission/checker.ts`）早已是敏感文件，
  沙箱层漏了 —— 而应用层那条是「bash 命令文本」正则，`base64` / 解释器读取都能绕。
- **子代理路径透传 `tool_meta`**：`query/tool-hook-lifecycle.ts` 的 `runPostToolHooks`
  加 `toolMeta` 参数，`query/run-tool-use.ts` 传 `result.meta`。原来这条路径成功/失败
  两条通道都不传，子代理 bash 的 `sandboxed` 全部丢失（子代理复用主 registry 的
  BashTool 实例，它确实跑在沙箱里），指标分母包含子代理、分子不含。
- **`buildCommand` 加 `[ -r ]` 预判**（`packages/core/src/tool/bash.ts`）：
  `{ [ -r <快照> ] && source <快照> 2>/dev/null; } || true && eval ...`。
  这是方案 §3.3 的可选加固，消掉「快照丢失时 sh 吞命令」这颗与沙箱无关的雷。
  副作用是 A6c 的旧判据（`source` 不存在的文件看谁吞命令）失去区分度，改为直接探测
  `ZSH_VERSION`；新增 A6d 用 **sh 内层**锁加固。
- **`sandbox-exec` 统一 `/usr/bin/sandbox-exec` 绝对路径**（探针与包裹）：
  探针的语义是「这台机器上真能跑」，PATH 里放个伪造的 `sandbox-exec` 就能让它误判 OK。
- **可测性：`SandboxManager` 加 `homeDir` 构造参数**（生产不传 = `homedir()`）。
  原因见下方「放弃了什么」。
- **告警分档**：内置探针路径（敏感目录/凭据文件/缓存目录/临时目录）不存在属于正常状态
  （多数用户没有 `.azure`/`.kube`），降 debug；工作区与用户配的 `allowedWritePaths`
  不存在是「配了没生效」，保留 warn。
- **非 darwin 不再 realpath `/private/tmp`、`/private/var/folders`**：它们不存在，
  解析只会刷误导性 warn，还让 `write_paths_count` 的口径跨平台不可比。
- **`write_paths_count` 语义写明**「含内置项、不是用户配置项计数」；
  **A12/A13 恢复全局 cwd**（`bun test` 同进程跑多文件，不恢复会污染下游）。

## 放弃了什么（以及为什么不选）

- **`~/Library/Caches` 整体放行**：写面太大（所有应用的缓存都在下面）。只放包管理器
  自己的缓存目录；其它工具的自定义缓存目录交给 `sandboxAllowedWritePaths`。
- **靠改 `process.env.HOME` 测敏感路径**：Bun 的 `homedir()` 不跟随运行时 env 变化
  （实测 profile 里仍是真实 HOME），改 env 会得到一条「看着在测、实际没测」的假绿用例。
  改为构造参数注入，生产路径行为不变。
- **探针失败改 fail-closed**：沿用 PR #601 的决定（降级 + 告警 + 轨迹），企业 policy
  场景要 fail-closed 应作为后续显式开关，不在本轮偷偷改语义。
- **全量 `bun test`**：按 CLAUDE.md 用 `affected-tests:run` + 相关测试集，
  全量由 CI 在合并前跑。

## 拿什么证明它生效了

修复前实测（本机 macOS 27.0.1，用 PR #601 后的 profile）：

```
echo x > ~/.npm/.probe        → operation not permitted（文件未创建）
echo x > ~/.bun/.probe        → operation not permitted
security list-keychains       → exit 0（沙箱内成功，返回 login.keychain-db）
profile 里 grep Keychains     → 0 命中
profile 里 grep git-credentials → 0 命中
```

自动化（本机全绿）：

- `packages/core/tests/permission/sandbox-exec-real.test.ts` 18 条：
  新增 A2c（包管理器缓存可写 + Keychains/.git-credentials 被 deny + 同 HOME 普通文件可读）、
  A6d（sh 内层 + 快照丢失仍执行）；A6c 改为 `ZSH_VERSION` 探测。
- `packages/core/tests/agent/subagent-hook-cc-align.test.ts` 26 条：
  新增 2b 四条（进程内成功/失败、spawn、无 meta 时不凭空造键）。
- `packages/core/tests/trace/collector-pending-events.test.ts` 6 条：
  排队补发、不重复、上限 200，以及 `sandbox_init` 模块级 pending 的延迟接线
  （顺带把 `__resetSandboxInitForTest` 用上，消除死导出）。

**变异自证 5/5 全部被捕获**（脚本 `/tmp/sbx-mutation-check.py`，逐条改坏 → 跑用例 → 恢复）：

| 变异 | 捕获它的用例 |
| --- | --- |
| M1 删 `Library/Keychains` deny | A2c 红 |
| M2 删 `.git-credentials` deny | A2c 红 |
| M3 删 `.npm` 写白名单 | A2c 红 |
| M4 `buildCommand` 去掉 `[ -r ]` | A6d 红 |
| M5 子代理不传 `toolMeta` | 2b 红 |

> **M4 第一次逃逸**：A6d 在 `initSnapshot()` 完成前设 `snapshotFilePath`，被异步完成
> 回写覆盖成 `undefined`，于是走「无快照」分支变假绿。改成先 `await snapshotReady`
> 再设字段后才捕获 —— 这条记下来，是因为「测试过了」和「测试真的在测」差一次变异。

门禁（本机）：`typecheck:gate`（62 处 / 基线 64，无新增）、`lint`、
`format:check`、`lint:boundary`、`lint:command-system`、`lint:legacy-tool`、
`docs:gen-reference --check`、`affected-tests:run` **5539 pass / 0 fail**、`make build` ✓。
