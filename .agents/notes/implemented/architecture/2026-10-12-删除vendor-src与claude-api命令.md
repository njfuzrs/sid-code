---
Status: implemented
Date: 2026-10-12
---
# 删除 `.vendor-src/` 机制与 `/claude-api` 命令

## 决定了什么

- 删除 `/claude-api` 斜杠命令（`packages/cli/src/command/commands/claude-api/` 与其测试）。它是 `.vendor-src/` 里最后一样东西（两份 Anthropic API 文档摘录，许可未确认）的唯一使用方，维护者确认这两份文档已不需要。内置斜杠命令 64 → 63，`website/ref/slash-commands.md` 由生成器同步。
- 删除整套 vendor 源码取回机制：`scripts/fetch-vendor-src.ts`、`package.json` 的 `vendor:fetch` / `vendor:check` / `vendor:pack`、`make build` 里的取回步骤、CI 两个 job 的「取回 vendor 源码」步骤、`artifact-identity.ts` 里对该脚本的指纹登记、`.gitignore` 的 `claude-api/reference` 与 `/.vendor-src/` 两条、`vendor-location.test.ts` 的 ⑯ 组、`vendor-embed.d.ts` 的 `*.md` 文本 import 声明（已无使用方）。
- 文档：README 中英文、CONTRIBUTING 删掉「新克隆必须先 `vendor:fetch`」整段；官网 `extend/index.md` 删掉 `/claude-api` 小节；`render-port/SPEC.md`、`docs-gen-reference.ts`、`no-legacy-renderer.test.ts` 里顺带提到的地方改掉。新克隆现在是 `bun install` → `make build` 两步。
- 顺手修 `tests/website/search-scope.test.ts`：`website-deploy.sh` 发布后 dist 里会有 `.gz` 预压缩副本，测试按前缀取文件会拿到 `.gz`，本机全量测试必红一条。改为只认 `.js`。
- 历史 Agent Note 与 changelog 里的提及不改，它们记录的是当时的事实。

## 放弃了什么（以及为什么不选）

- **保留 symlink 机制、只换内容**：没有内容可换了。这套机制当初是为了防「仍追踪这些路径的分支在切换时删掉工作区文件」，本仓 102 个 ref 里已经没有一个追踪 `claude-api/reference`，前提也不在了。
- **把两份文档入库继续用 `/claude-api`**：许可未确认，当初就是因此不入库；维护者也确认不再需要。

## 拿什么证明它生效了

- `rg "vendor-src|vendor:fetch|fetch-vendor-src|claude-api"`（排除历史 Agent Note / changelog / 博客转载）零命中。
- 本机删掉 `.vendor-src/` 后：`make build` 通过并自检通过；`bun test` 15,916 个用例只有 search-scope 1 个失败，修正后单跑 6/6 通过；`docs:gen-reference --check`、`lint`、`format:check`、`lint:boundary` 通过；tsc 错误数与 main 相同（104）。
- ⚠️ 服务器上的 `vendor-bin/tui-renderer/20260904/tui-renderer-src-20260904.tar.gz` 不在本 PR 范围：它仍可公开下载，里面装着旧渲染底座。删除要另外确认。
