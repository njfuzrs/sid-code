---
Status: implemented
Date: 2026-11-02
---
# Dependabot #508：其余 17 项照升，Anthropic SDK 1.x 与 TypeScript 7 暂缓并加 ignore

## 决定了什么

- #508 里的 19 项升级保留 17 项。`@anthropic-ai/sdk` 留在 0.x（根 `^0.120.0`、eval-framework `^0.128.0`），`typescript` 留在 5.9.3。
- `.github/dependabot.yml` 的两条 bun 通道都对这两个包加了 `version-update:semver-major` ignore，下个月不会再提同样的 PR。
- 照升带来的两处代码适配：
  - `signal-exit` 4 去掉了 default export，`packages/tui/src/ink.tsx` 改成 `import {onExit as signalExit}`，签名与 v3 一致。这是 CI 上 413 条失败的主因（TUI 夹具全部报 `Missing 'default' export`）。
  - oxfmt 0.75 的排版规则变了，`tests/website/gen-reference.test.ts` 按新规则重排。
- `@alcalzone/ansi-tokenize` 0.3.1 修了上游 bug #82：OSC 8 超链接的结束码不再泄漏到后面的字符。`packages/tui/tests/fixtures/text-vectors.json` 只改这一条用例，链接后 " after" 这 6 个字符的 `styles` 从一个空 ansi 码变成 `[]`。生成脚本已删除，这次是用当前实现的输出替换这一条，其余用例不动。属于契约有意变更，不是凑绿。

## 放弃了什么（以及为什么不选）

- **SDK 随这次一起升到 1.x**：1.0 换到新 API 版本 2026-10-21，请求参数里已经没有 `temperature`。`packages/eval-framework/core/judge.ts` 靠 `temperature: 0` 保证判分确定性，删掉它跨次判分会有方差，要重新校准 judge，不该混在常规升级里。
- **TS 7 随这次一起升**：新增 3 处测试类型错误，`scripts/tsc-baseline.json` 也必须人工 `--init` 重建（脚本刻意留给人做）。放进来会把 review 面撑大，单独开 PR 迁移。
- **ansi-tokenize 钉回 0.3.0**：等于为了保住冻结基线而放弃上游的 bug 修复，旧行为本身就是泄漏。

## 拿什么证明它生效了

在主仓分支 `fix/deps-rest-508`（基于 main 8a6b4860 合入 dependabot 分支）上：

- 修复前跑 `bun test`：17197 pass / 417 fail。
- 修完 signal-exit 后：18709 pass / 1 fail，剩 T6 OSC 8 那一条。
- 回退 SDK/TS、更新向量后：18710 pass / 0 fail。
- `lint` / `format:check` / `lint:boundary` / `lint:command-system` / `typecheck:gate` 全部 exit 0，类型检查「当前 66 处 / 基线 66 处」。
- 对照：把 TS 7.0.2 换回 5.9.3 后，新增类型错误从 4 处降到 1 处，剩下的就是 SDK 1.x 删掉 `temperature` 带来的那处，据此把两个问题分开归因。
