---
Status: implemented
Date: 2026-09-18
---
# PR3a：删除 `general/` 与 holdout 题面 yaml，并整条下线 smoke / pass-at-k / 题面泄露检测链

## 决定了什么

同一个关注点、一个 PR：`general/` 是母集，holdout 13 条来自它，两条 CI 链路只依赖它。holdout 题面删完后「防题面泄露」的对象不存在，中间态是一道**报绿的空门禁**，必须同批下线。

**删（一律 `git rm`，`evals/` 入库 445 → 398，−47）：**

| 物 | 数 |
| --- | --- |
| `evals/general/` | 28 yaml |
| holdout 题面 yaml（根级 5 + `holdout/architecture/` 8） | 13 |
| `_meta/{smoke-cases,critical-cases,holdout-leak-audit}` | 3 |
| `_meta/pass-at-k.test.ts` | 1 |
| `evals/verify-judge-stability.ts` | 1 |
| `evals/scripts/migrate-cost-formula.ts` | 1 |
| 仓外连带（不进 398 那个分母）：`run-smoke.ts` / `pass-at-k.ts` / `check-holdout-leak.sh` / `extract-holdout-tokens.ts` / `eval-pr-smoke.yml` | 5 |

**留下（⛔ 不是漏删）：**

- `evals/holdout/{architecture,real-tasks}/README.md` —— 切分方法论，新集要复用，改成退役说明
- `evals/holdout/real-tasks/holdout-sids.txt` —— **一字节未动**（sha256 `11f400c32…`），永封校验是另一条链
- `evals/_judge/gold-cases` 10 条 —— `case_001` 两份 md5 不同，独立副本

**引用切完再删。** runner / yaml-loader / list / baseline / tally 的扫描面改为 `architecture/` + `real-tasks/`。`isBehaviorBucket` 等分类函数仍识别历史桶名，因为单测夹具用字符串测分类、tmpdir 仍按 `general/p0-core` 建夹具（13 号 §5.2.1 假阳性）。

smoke 5 条锚点选取标准（P0 + 已 GA + 跑分稳定）：`case_001/002/003/006/007`，原文在 git 历史 `evals/_meta/smoke-cases.yaml` 头部注释。

## 放弃了什么（以及为什么不选）

1. **放弃把 `pass-at-k.ts` 的 `:185` `else` 改成显式报错（裁决一选项 A）。**
   它只有两个输入源：`critical-cases.yaml`（本 PR 删）+ `_runs/*.jsonl`（PR2 已删）。
   缺 yaml 时 `loadCriticalCases()` 返回 `[]`，`:185` 的 `else` **对所有 samples ≥ 2 的 case 做计算** —— 报告长得一模一样，分母从「5 条精选」悄悄变成「所有跑过 ≥2 次的」。这是 fail-quiet，和 `run-smoke.ts` 的 fail-loud **不是同一种病**，不许「同理一并处置」。
   选 A 只是把「静默换分母」换成「启动即报错」，留下一个**没有输入的计算器**。选 B：脚本 + 测试同批删。
   ⚠️ 第二处 fail-quiet 一并消失：`:66` 读不到 `_runs/{provider}.jsonl` 时 warn 后继续执行。
   🟢 放弃的是 **Pass@1 / Pass@3 / Pass^3 稳定性口径**（同 case 跑 N 次过几次）。新集要衡量稳定性得重建。补偿：算法只有 `computePassAtK` 一个纯函数，git 里可取回；那 5 组 fake sample 就是行为规格。

2. **放弃把 `PUBLIC_FILES` 改成 fail-closed 来「修好」泄露门禁（原选项 A）。**
   那只修下游「没东西可扫」，修不了上游 `extract-holdout-tokens.ts` 的 token 源被抽空。改完 `while read token` 依然零次执行、**门禁依然 rc=0**。一个看起来负责、实际无效的修复，比不修更糟。
   判据：「没有保护对象的防线不叫防线」。整条链（检测脚本 + token 提取 + `pre-push.sh` 接线）下线。
   ⚠️ **新集若重建 holdout，须连这条检测一起重建**（`agent-traj-bench` 侧尚无同等机制）。
   ⚠️ `_meta/holdout-leak-audit.md` 记下了 **F-H1：旧公开面那份自动生成页移除 holdout 题面** 这段历史，原文在 git。

3. **放弃保留 `run-smoke.ts` 等 secret 配好再红。** 5 条 smoke case 全在 `general/p0-core/`。workflow 当前因缺 `DEEPSEEK_API_KEY` 被 skip —— 这正是最坏形态：某天有人配好 secret 突然红，那时没人记得是这次删除造成的。

4. **放弃在本 PR 动 `architecture/` / `capability/` / `real-tasks/` case 本体。** 那是 PR3b/c/d。

## 拿什么证明它生效了

**判据不是「门禁跑绿」。** 题面泄露链在 token 源被抽空后实测 **rc=0 且零输出**（空跑）。必须证明链已消失，而不是再跑一次看它绿。

```
① 数量（evals/ 分母，⛔ 不许改期望值）
$ git ls-files evals | wc -l                                          → 398   （445 − 47）
$ git ls-files evals/general | wc -l                                  → 0
$ git ls-files evals/holdout | grep -c '\.yaml$'                      → 0
$ git ls-files evals/_judge/gold-cases | wc -l                        → 10
$ git ls-files evals | grep -c '\.ts$'                                → 25
$ git ls-files scripts/eval | wc -l                                   → 33
$ grep -rl "lifecycle:" evals/ --include="*.yaml" | wc -l             → 140  （arch 113 + real-tasks 27）

② 泄露检测链已消失（⛔ 不是再跑一次看它绿）
$ ls scripts/eval/check-holdout-leak.sh scripts/eval/extract-holdout-tokens.ts 2>/dev/null
  → 无输出
$ grep -n "check-holdout-leak" scripts/git-hooks/pre-push.sh
  → 无输出
$ grep -rn "CASES.md" scripts/eval/ 2>/dev/null
  → 无输出

③ smoke / pass-at-k 无悬空引用（⛔ 不许用「workflow 当前被 skip」当验收）
$ grep -rn "smoke-cases\|critical-cases" scripts/ .github/ --include="*.ts" --include="*.yml"
  → 无输出
$ ls .github/workflows/eval-pr-smoke.yml scripts/eval/run-smoke.ts scripts/eval/pass-at-k.ts 2>/dev/null
  → 无输出

④ 永封未被破坏
$ sh scripts/eval/check-holdout-real-tasks-sealed.sh                  → 退出 0
$ shasum -a 256 evals/holdout/real-tasks/holdout-sids.txt
  → 11f400c32b2ce262bf24a4b972ce66bb97c5f4f61268247610d6c6a4200d7bcc
```
