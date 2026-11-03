---
Status: implemented
Date: 2026-11-02
---
# Dependabot 5 个依赖 PR 合并成一次升级，不逐个合

## 决定了什么

把当时 open 的 5 个 `dependencies` PR 的版本变更合并成一笔改动，一次 CI 落地：

- `@anthropic-ai/sdk`：根 `^0.120.0` → `^0.137.0`，`packages/eval-framework` `^0.128.0` → `^0.137.0`（#536 / #535）。
- react 三件套：`react` 19.2.8 → 19.3.1（根 `^19.3.1`、`packages/tui` 精确 `19.3.1`）、`react-devtools-core` 7.0.1 → 8.0.0、`@types/react` `^19.2.18` → `^19.3.0`（#505）。
- `@types/*`：`@types/node` `^26.2.0` → `^26.6.6`、`@types/ws` 8.18.1 → 8.18.2、`@types/bun` 1.4.0 → 1.4.4（#506；根 `package.json` 写的是 `"latest"`，需单独 `bun update @types/bun` 才会重新解析这个 tag）。
- oxlint 原子升级：`oxlint` 与 4 个 `@oxlint/binding-*` 一起 1.78.0 → 1.90.0（#507）。
- 一处代码适配：oxlint 1.90 的 correctness 规则 `no-irregular-whitespace` 命中
  `packages/cli/src/command/commands/terminal-setup/terminal-setup.ts:44`——注释里 `/* */`
  之间原本插了一个 U+200B 来避免块注释被 `*/` 提前闭合。改写为「剥离 // 行注释与块注释后」
  这种不含 `*/` 字面量的措辞，零宽字符消失、语义不变。

`bun.lock` 由 `bun install` + `bun update @types/bun` 重新生成，不是手工编辑。

## 放弃了什么（以及为什么不选）

- **逐个 rebase / 合并这 5 个 PR**：必需检查是 strict，合掉一个其余全部 BEHIND，每个都要重跑
  一轮全量 CI（本仓全量实测 526s）。#535 更是结构性红：Dependabot 只改了
  `packages/eval-framework/package.json`、没重生成根 `bun.lock`，CI 第一步
  `bun install --frozen-lockfile` 就报 `lockfile had changes, but lockfile is frozen`，
  **没有任何后续事件会让它自己变绿**。`.github/dependabot.yml` 里已写明这种情况的正确处置是
  「本地重生成 lock 推上去，或关掉它把版本变更并进主包那批」，本次选后者。
- **顺手把 SDK 升到 npm 最新的 1.3.0**：`.github/dependabot.yml` 两条通道都对
  `@anthropic-ai/sdk` 的 `semver-major` 加了 ignore，理由见
  `2026-11-02-dependabot-508-sdk1与ts7暂缓.md`——1.0 的请求参数里去掉了 `temperature`，
  而 `packages/eval-framework/core/judge.ts` 靠 `temperature: 0` 保证判分确定性，要单独迁移 + 校准。
  同理不使用 `bun update --latest`（它会把 SDK 一起顶到 1.3.0，与 ignore 策略冲突）。
- **跳过 react-devtools-core 8 这个 major 单独处理**：它只服务 DEV 调试通道
  （`packages/tui/src/devtools.ts`），且 8.0.0 的 `dist/backend.js` 仍导出
  `initialize` / `connectToDevTools`，现有调用点不用改；`packages/tui/tests/compile-smoke.test.ts`
  本来就盯这条分支的打包形态。
- **改 `.github/dependabot.yml` 把 5 个 group 并成一个**：react 组、types 组、oxlint 组都是
  「必须同版本原子升级」的语义分组，合并会换来「一个 major 拖着整组没法合」的新问题。
  本次只处理存量 PR，不动未来策略。

## 拿什么证明它生效了

在主工作区（基于 main `9ec3dee5`）逐条跑：

- `bun run lint`：`Found 0 warnings and 0 errors`（修复前 1 error，即上面那处 U+200B）。
- `bun run format:check`：`All matched files use the correct format`。
- `bun run lint:boundary` / `bun run lint:command-system`：均 exit 0（四道门禁通过）。
- `bun run typecheck:gate`：`当前 64 处错误 / 基线 64 处`，无新增。
- `bun test`（`affected-tests` 判定 full：跨 3 个包）：**18691 pass / 9 skip / 0 fail**，
  1315 文件，526.40s。
- `make build`：exit 0，产物自检通过（内置 skill 内联、内嵌 ripgrep 平台匹配、review 子命令可加载）。
- `bun.lock` 落地版本逐条核验：`@anthropic-ai/sdk@0.137.0`、`react@19.3.1`、
  `react-devtools-core@8.0.0`、`@types/react@19.3.0`、`@types/node@26.6.6`、`@types/ws@8.18.2`、
  `@types/bun@1.4.4`、`oxlint@1.90.0`（binding 同步 1.90.0）。
