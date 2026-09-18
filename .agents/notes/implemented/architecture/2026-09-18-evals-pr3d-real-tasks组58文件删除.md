---
Status: implemented
Date: 2026-09-18
---
# PR3d：删除 `real-tasks/` 58 文件（27 yaml + 31 setup 脚本）

## 决定了什么

四组旧题集的最后一组。本 PR 只删 `evals/real-tasks/`（27 yaml + 31 setup 脚本），并把默认扫描面收成空集。⛔ 不动污染扫描（PR4）与 `holdout-sids.txt`。

**删（一律 `git rm`，`evals/` 入库 197 → 139，−58）：**

| 物 | 数 |
| --- | --- |
| `evals/real-tasks/` yaml | 27 |
| 同目录 `scripts/setup_T*.sh` | 31 |

⚠️ 差值账记 **58**，不是 27。31 个 setup 脚本同样进 diff。yaml 的 `setup_script:` 自引用随 case 一起删，不用单独改。

**引用切完再删。** `CASE_ROOTS`（list / baseline / tally / cross-baseline）改成空数组；runner 默认扫描面仍走 `discover*`，目录不存在返回 `[]`（不静默换分母）。`isTrajectoryBucket` 仍识别历史桶名，因为单测夹具用字符串测分类、不读磁盘（13 号 §5.2.1 假阳性）。

**C 类断引用本 PR 没有自己那条。** `_diagnoses/` 6 处（5 条 gold diagnosis + `SCHEMA.md`）已在 PR3a/3b/3c 改完；`case_cr_006` 实测引四组路径 0 处，按清单不改。本 PR 核过 `_diagnoses/` 对 `evals/real-tasks` 命中 **0**。

## 放弃了什么（以及为什么不选）

1. **放弃把 27 条 case 的 rubric 措辞继续留在仓内当活题。** 本就是 TODO 占位（PR1 已写明）；setup 脚本 31/31 的 `REPO_URL` 是假值（30 条 TODO 占位 + 1 条 example.com）。补偿：bundle 落 `~/Backups/sid-code-evals-legacy/`（B.2 已从 clone 数出 222），校验用 `shasum -a 256`。题面可从 bundle 取回。

2. **放弃在本 PR 下线 `check-real-tasks-pollution.ts` 与 `pre-commit.sh` 的 `STAGED_REAL_TASKS` 段。** 那是 PR4，依赖 `agent-traj-bench` 侧先有同等扫描。本 PR 后这道扫描的作用域变空集、**仍返回通过**（实测 `[pollution-scan] no real-tasks yaml to scan, ok`，rc=0），是**已知的中间态**。⛔ 不许说「污染扫描已迁移」。

3. **放弃把 `_diagnoses/` 的 `path:` 整段删掉。** 价值在推理链。本 PR 没有自己那条要改；前三批已按「保推理链、换 bundle 指向」处理。

4. **放弃删 runner / yaml-loader 的 `discover*` / `isTrajectoryBucket`。** 分类函数测的是字符串；discover 在目录不存在时返回 `[]`。先于测试改查找列表会让 tmpdir 夹具找不到 yaml。污染扫描（PR4）仍认 `evals/real-tasks/` 这个路径名。

## 拿什么证明它生效了

```
① 数量（evals/ 分母，⛔ 不许改期望值）
$ git ls-files evals | wc -l                                          → 139   （197 − 58）
$ git ls-files evals/real-tasks | wc -l                               → 0
$ git diff --cached --name-only --diff-filter=D | wc -l               → 58
$ git ls-files evals/_judge/gold-cases | wc -l                        → 10
$ grep -rl "lifecycle:" evals/ --include="*.yaml" | wc -l             → 0
$ 树两侧闭合：目录合计 137 + 顶层 README/CLAUDE 2 = 139

② 默认扫描面是空集，不是静默换分母
$ bun run eval:list                                                   → 「识别到 0 条 case」
$ CASE_ROOTS 四处（list / baseline / tally / cross-baseline）         → []

③ 永封未被破坏
$ sh scripts/eval/check-holdout-real-tasks-sealed.sh                  → 退出 0
$ shasum -a 256 evals/holdout/real-tasks/holdout-sids.txt
  → 11f400c32b2ce262bf24a4b972ce66bb97c5f4f61268247610d6c6a4200d7bcc
  （与 PR3c 逐字一致；git diff 该文件 0 字节）

④ 已知中间态（PR4 未做）
$ bun run scripts/eval/check-real-tasks-pollution.ts
  → [pollution-scan] no real-tasks yaml to scan, ok    rc=0
  ⛔ 这不是「污染扫描已迁移」，是作用域为空集仍返回通过。

⑤ 门禁（实跑）
$ bun test ./packages/eval-framework/ ./tests/eval/ --test-name-pattern '^(?!.*\[slow\])'
  → 825 pass / 0 fail / 2001 expect（21.89s）
$ make build                                                          → 自检通过
$ bun run format:check / lint / lint:boundary / docs:gen-reference --check / verify:agent-note
  → 全绿（Note 111 份形态合规）
$ bun test ./tests/eval/evals-claude-md-citations.test.ts             → 23 pass / 0 fail
```

⛔ **本次没有证明的事**：污染扫描未下线（PR4）；`_legacy` 死引用未改（PR5）。
四组 yaml 现已全部删除，但 ⛔ 不许说「评测集已经清理完成」—— PR4 依赖外部仓。
