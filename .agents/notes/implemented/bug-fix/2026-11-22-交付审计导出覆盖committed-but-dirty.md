---
Status: implemented
Date: 2026-11-22
Source: workflow 并行编排缺陷与规范沉淀（2026-11-19）
---
# 交付审计的导出判据与 verdict 解耦：committed-but-dirty 的未提交改动也要导出

## 决定了什么

`scripts/workflow-delivery-audit.ts`（`bun run workflow:audit`）的 `--export-dir` 与退出码，
判据从 **`verdict === "uncommitted"`** 改成 **`dirty > 0`**，并给 committed 段补上导出命令：

- `--export-dir` 遍历 `audits.filter(x => x.dirty !== null && x.dirty > 0)`，
  于是 `verdict=committed` 但仍有未提交改动的单元也会被 `git add -A` + `git diff --binary HEAD` 导出。
- committed-but-dirty 的导出输出会额外说明「仅含 N 处未提交改动；M 个提交需另行 merge/cherry-pick」，
  避免主控把导出的 patch 当成全部产出。
- `renderReport` 的 committed 段：`dirty > 0` 的单元在 `format-patch` 之后追加
  `git -C <wt> add -A` + `git diff --binary HEAD > /tmp/<unit>.dirty.patch` 三行。
- 退出码 `bad` 判据同步改成 `dirty > 0 || verdict === "unknown"`，于是 committed-but-dirty 退 1。
- `verdict` 本身**不变**（仍是 commits > 0 → committed）。改的只是「导出/失败」这一层，
  因为「这个单元交付状态是什么」和「还有没有东西要救」是两个问题，后者不该被前者掩盖。

## 放弃了什么（以及为什么不选）

- **没新增第四态 `committed-dirty`**：多一个状态就多一处调用方要分支处理，而
  「已提交」与「还有未提交改动」是 orders 正交的两件事，用 `dirty > 0` 直接判即可，
  不必塞进 verdict 的闭集。verdict 继续只回答「产出落在哪」。
- **没让 committed-but-dirty 的退出码保持 0**：`--export-dir` 导出之后数据是安全的，
  但脚本化调用（`if ! bun run workflow:audit; then`）在 exit 0 时整条不会走到人工处理分支，
  而 committed-but-dirty 恰恰需要人先 merge 提交、再 apply 导出的 patch，是有序的两步。
- **没把 `--export-dir` 改成默认开启**：导出要 `git add -A`，会改 worktree 的 index 状态，
  只读审计与救援动作必须分开（与 2026-11-19 的原始取舍一致）。
- **没动 `format-patch` 那行**：`format-patch <base>..HEAD` 只含已提交内容，这是 git 的定义，
  不是可以绕过的实现细节；正确做法是承认它带不走 dirty，另给一条导出命令。
- **没做成 CI 门禁**：这是批量编排过程中的自查工具，主仓平时没有 `wf_*` worktree，
  挂进 CI 只会恒绿。

## 拿什么证明它生效了

- `bun test ./tests/scripts/workflow-delivery-audit.test.ts` → **17 pass / 0 fail / 56 expect**（新增 2 条）：
  - `committed-but-dirty：committed 段必须给出 dirty 部分的导出命令` —— 断言输出含
    `/tmp/wf_cd.dirty.patch` 与「不在上面的 patch 里」；
  - `committed-but-dirty → 退 1，--export-dir 也导出未提交那部分` —— 断言 exit 1、
    patch 含 `dirty.txt`、**不含**已提交的 `c.txt`（证明 patch 只含未提交部分）。
- 变异自证 2 处（一起注入 → 跑测试 → 恢复 → 重跑）：
  1. 导出过滤改回 `verdict === "uncommitted"`：e2e 用例变红（patch 文件不存在）。
  2. 删掉 `renderReport` 里的 dirty 导出命令块：单测用例变红。
  注入后 **15 pass / 2 fail**，恢复后 **17 pass / 0 fail**，`grep -c _MUT` 为 0。
- 真机：`bun run scripts/workflow-delivery-audit.ts --repo <主仓> --base origin/main`
  对当前 `.sid-code/worktrees/fix-delivery-audit-dirty-export` 跑，输出 `committed` 且
  dirty=0，exit 0 —— 没有新告警噪音。
