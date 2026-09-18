---
Status: implemented
Date: 2026-09-18
---
# PR3b：删除 `architecture/` 131 文件（113 yaml + 18 README）

## 决定了什么

`architecture/` 无跨组依赖；holdout 里那 8 条 yaml 已在 PR3a 删完。本 PR 只删这一组，并把扫描面从「architecture + real-tasks」收到「只扫 real-tasks」。

**删（一律 `git rm`，`evals/` 入库 398 → 267，−131）：**

| 物 | 数 |
| --- | --- |
| `evals/architecture/` yaml | 113 |
| 同目录 18 个子目录 README | 18 |

⚠️ 差值账记 **131**，不是 113。18 个 README 同样进 diff。

**引用切完再删。** `CASE_ROOTS` / runner 默认扫描面去掉 architecture。`isArchitectureBucket` 仍识别历史桶名，因为单测夹具用字符串测分类、tmpdir 仍可能建 `architecture/kernel`（13 号 §5.2.1 假阳性；`check-skill-holdout-regression.test.ts` 的夹具也是 tmpdir）。

**C 类断引用本 PR 改自己那条（3b.4）：** `_diagnoses/meta_001-2026-04-30.yaml` 的 `case_path` 换成 bundle 指向，**推理链整段保留**（`expected_fix_type: infra_bug` 等）。`SCHEMA.md` 的字段示例改指仍存在的 `evals/_judge/gold-cases/case_001.yaml`（它是 schema 示例，不是 gold diagnosis）。

⚠️ 3b.5 上游写「399 − 131 = 268」。PR3a 实测是 **398**，本格按实测账：398 − 131 = **267**（与 §5.1 留存侧一致）。⛔ 不改全局期望值 139。

## 放弃了什么（以及为什么不选）

1. **放弃把 113 条 case 的 rubric 措辞继续留在仓内当活题。** 那是「当年怎么定判据」的唯一记录。补偿：bundle 落 `~/Backups/sid-code-evals-legacy/`（`evals-222cases-20260918.bundle`，B.2 已从 clone 数出 222），校验用 `shasum -a 256`（见该目录 `SHA256SUMS`）。题面可从 bundle 取回，不是这次造成的不可重建。

2. **放弃把 `_diagnoses/meta_001` 的 `path:` 整段删掉。** 价值在「当时如何从症状推到 `fix_type`」的推理链，不在它指向哪个文件。只改 `case_path`。

3. **放弃把 `isArchitectureBucket` / baseline-sync 的 architecture 动态发现一起删。** 分类函数测的是字符串，不读磁盘；baseline-sync 的 `discoverArchitectureSubDirs` 在目录不存在时返回 `[]`，tmpdir 夹具仍按旧约定建同名目录。先于测试改查找列表会让夹具找不到 yaml。

4. **放弃在本 PR 动 `capability/` / `real-tasks/`。** 那是 PR3c/3d。

## 拿什么证明它生效了

```
① 数量（evals/ 分母，⛔ 不许改期望值）
$ git ls-files evals | wc -l                                          → 267   （398 − 131）
$ git ls-files evals/architecture | wc -l                             → 0
$ git ls-files evals/_judge/gold-cases | wc -l                        → 10
$ grep -rl "lifecycle:" evals/ --include="*.yaml" | wc -l             → 27   （real-tasks 27）
$ 树两侧闭合：目录合计 265 + 顶层 README/CLAUDE 2 = 267

② 口径①：代码/脚本/json 不再指向仓内 architecture 路径
$ grep -rn "evals/architecture" --include="*.ts" --include="*.sh" --include="*.json" . | grep -v node_modules | grep -v '.vendor-src'
  → 无输出（runner 注释已改成「architecture 组」，不含该路径字面量）

③ 永封未被破坏
$ sh scripts/eval/check-holdout-real-tasks-sealed.sh                  → 退出 0
$ shasum -a 256 evals/holdout/real-tasks/holdout-sids.txt
  → 11f400c32b2ce262bf24a4b972ce66bb97c5f4f61268247610d6c6a4200d7bcc

④ 门禁（实跑）
$ bun test ./packages/eval-framework/ ./tests/eval/ --test-name-pattern '^(?!.*\[slow\])'
  → 897 pass / 0 fail / 2112 expect（22.04s）
$ make build                                                          → 自检通过
$ bun run format:check / lint / lint:boundary / docs:gen-reference --check / verify:agent-note
  → 全绿（Note 107 份形态合规）
$ bun test ./tests/eval/evals-claude-md-citations.test.ts             → 23 pass / 0 fail
  （本 PR 未改 evals/CLAUDE.md 出处行号，门禁未红 —— 与 PR1 同型）
```

⛔ **本次没有证明的事**：`capability/` / `real-tasks/` case 本体没删（PR3c/3d）。
