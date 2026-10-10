---
Status: implemented
Date: 2026-10-09
---
# 新增 scripts/pr-merge-chain.sh：一批就绪 PR 按顺序 update → 等 CI → 自动合入

## 决定了什么

新增 `scripts/pr-merge-chain.sh`（`bun run pr:merge-chain <PR号...>` / `--all`），
对每个 PR 依次：挂 auto-merge（默认 `--merge`，已挂 squash 的改掉）→ `BEHIND` 时
`gh pr update-branch` → 轮询到 `MERGED` → 才处理下一个。检查失败 / 冲突 / draft /
已关闭 / 超时（默认 40 分钟）立即停止，后面的 PR 不动。`--dry-run` 只报告。

合并判定仍交给 GitHub auto-merge + ruleset `protect-main`，脚本自己不判「能不能合」，
所以没有绕过 `all-checks-passed` 的路径。

## 放弃了什么（以及为什么不选）

- **一次性给所有 PR 都 update-branch**：strict 必需检查下，前一个合入后其余立刻又 BEHIND，
  白跑 N-1 轮 CI（2026-10-09 合 #214–#220 时实测每个约 10 分钟）。
- **merge queue**：个人账户仓库不可用（CONTRIBUTING.md，422 Invalid rule）。
- **并到 `pr-batch.sh` 当子命令**：那个脚本管 worktree 并行开发编排（1000+ 行），
  合并是另一个关注点，且本脚本要能对任意来源的 PR（含 dependabot）使用。
- **失败后跳过继续合后面的**：后面的 PR 可能依赖前面的，跳过会让 main 停在没想过的组合上。
- **脚本内直接 `gh pr merge`（非 auto）**：等于脚本自己判定可合，绕开 ruleset 的判断。

## 拿什么证明它生效了

- `bun test ./tests/scripts/pr-merge-chain.test.ts`：9 pass / 0 fail。用假 gh（`GH_BIN`）
  复现 BEHIND→BLOCKED→MERGED 序列，断言写操作顺序严格串行、CI 失败后对下一个 PR 零写操作、
  squash 被改为 merge、dry-run 零写操作、超时退出码 4。
- 对真实仓库 `bash scripts/pr-merge-chain.sh --all --dry-run`：正确列出 #132 并报
  「已有 4 个检查失败，会停在这里」，无任何写操作。
- 流程本身在 2026-10-09 用同逻辑的临时脚本串行合入 #215/#218/#219/#220，全程无人值守。
