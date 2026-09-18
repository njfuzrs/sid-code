---
Status: implemented
Date: 2026-09-18
---
# PR4：下线空跑的 real-tasks 污染扫描（B6-10）

## 决定了什么

`evals/real-tasks/` 已随 PR3d 删除。本仓 `check-real-tasks-pollution.ts` 对空集仍返回 0（「no real-tasks yaml to scan, ok」），是已知中间态，不是防线在工作。

本 PR 只在 **agent-traj-bench 已有同等扫描且被触发过** 之后，才下线 sid-code 侧：

- `git rm` `scripts/eval/check-real-tasks-pollution.ts` + `tests/eval/check-real-tasks-pollution.test.ts`
- 删 `scripts/git-hooks/pre-commit.sh` 的 `STAGED_REAL_TASKS` 段
- `install-git-hooks.sh` 摘要去掉 B6-10；`security-scan.ts` 注释改指新仓 gate12

新仓落点：`scripts/check-contamination.py`，CI **gate12**，扫 `tasks/`（被测 agent 面对的题）。5 个字段与 B6-10 逐字一致。空集 exit 2，不许当通过。分支 `feat/contamination-scan`，commit `933e9db`，PR https://github.com/njfuzrs/agent-traj-bench/pull/8 。

## 放弃了什么（以及为什么不选）

三个已否决选项，清单 4.3 写死，不重新提：

1. **改指 `evals/internal/`** —— 现在没有这个目录。
2. **改指 agent-traj-bench 的入库路径** —— pre-commit 是 sid-code 的 hook，管不到另一个仓的提交。
3. **先下线、回头补那边** —— 把一道真实防线换成一句 TODO。本仓「防线全在、调用全 0」同型。PR3d 后的空集通过比这个好，所以一直挂到 4.1 完成。

`scan-trajectory-secrets.ts` 与 `scanContamination` **留下**。它扫的是仓外 `trajectory-platform/bench/tasks/*/task.yaml`，不是 `evals/real-tasks/`，不是本 PR 的对象。

## 拿什么证明它生效了

🔴 **判据不是「这边下线了」。** 是「新仓那边真有同等扫描且被触发过」。

```
① 新仓生产路径（agent-traj-bench，cwd = 该仓根）
$ python3 scripts/check-contamination.py
  → [contamination-scan] ✅ scanned 429 file(s), 0 hits    rc=0

② 反向自证（塞一个字段 → 红 → 复原 → 绿）—— 生产文件，不是 tmpdir fixture
$ printf '\n<!-- tool_result_content: probe -->\n' >> tasks/T0002/instruction.md
$ python3 scripts/check-contamination.py
  → ❌ 1 hit in tasks/T0002/instruction.md
     tool_result_content@line:11                                 rc=1
$ git checkout -- tasks/T0002/instruction.md
$ python3 scripts/check-contamination.py
  → ✅ 429 files, 0 hits                                         rc=0

③ 新仓单测
$ pytest scripts/tests/test_contamination.py -q
  → 8 passed
  含：空集 exit 2、五字段各抓一次、ci.yml 真接线 gate12 与 test_contamination.py

④ 本仓下线后作用域消失（⛔ 不是再跑一次看它绿）
$ ls scripts/eval/check-real-tasks-pollution.ts tests/eval/check-real-tasks-pollution.test.ts 2>/dev/null
  → 无输出
$ grep -n "STAGED_REAL_TASKS" scripts/git-hooks/pre-commit.sh
  → 无输出
```

⛔ 不许说「污染扫描已迁移」—— 迁移完成的条件是 ①② 都发生过。① 是绿、② 是红过一次。只做 ① 等于「防线全在、调用全 0」。
