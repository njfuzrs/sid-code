---
Status: implemented
Date: 2026-09-18
---
# PR3c：删除 `capability/` 组（`evals/` 账 70 文件，连带合计 77）

## 决定了什么

执行 `rejected/architecture/2026-09-15-capability评测线停止.md` 那份裁决。本 PR 只删这一组
并切完它的十类连带，⛔ 不动 `real-tasks/`（PR3d）。

**删（一律 `git rm`）：**

| # | 物 | 数 | 进 `evals/` 分母 |
| --- | --- | --- | --- |
| ① | `evals/capability/{context,harness,memory,plan,router}/` case yaml | 54（10/11/10/10/13） | ✅ |
| ② | 同目录其余 tracked 文件（5 README + 5 `.gitkeep`） | 10 | ✅ |
| ⑤ | `evals/bench-runner/capability-{grader,shared}.ts` | 2 | ✅ |
| ⑦ | `evals/_reports/capability-plan-w11{,-after,-baseline}` + `-w12-d3-preview.md` | 4 | ✅ |
| ③ | `scripts/eval/run-{plan,memory,context,router,harness}-capability.ts` | 5 | ✗ |
| ⑥ | `tests/eval/capability-{grader,shared}.test.ts` | 2 | ✗ |

⇒ **`evals/` 入库 267 → 197（−70）**；`git rm` 合计 **77** 个文件。
⚠️ 两个口径都要报，差在 ③⑥ 不在 `evals/` 下。

**改（不删实现，只切引用）：**

- ④ `package.json` 5 个 npm script（eval script **13 → 8**）；`scripts/eval/` 入口 **33 → 28**。
  ⚠️ 上游 3c.3.2 写「35 → 30」，那是 PR3a 之前的基数；PR3a 已 −4，本格按实测账。
- ⑧ `.gitignore` **4 处**（`:97` 注释、`:109` 引用即将删除的文件、`:110/111` 举例、`:113` 规则本体）。
  ⚠️ 上游 10 号只说 2 处。`:109` 那条注释引用已删文件 ⇒ 同 PR 改，否则又是一条追不到出处的规则。
- ⑨ `evals/README.md` capability 段 + 目录树 + 三处计数（`.ts` 25→23、`scripts/eval/` 33→28、
  `tests/eval/` import 11 文件/12 路径 → **9/10**）。
- ⑩ `evals/bench-runner/process-grader.ts:76` 的注释级死引用 —— **结论内联**，不留行号引用。
  ⚠️ 它不是 import、不影响编译，所以删完**没有任何测试会红** ⇒ 属静默类，必须手动切。
- 顺带 5 处同型注释死引用：`evals/CLAUDE.md:8` 的目录枚举、`judge.ts:12`、`baseline-sync.ts`
  三处、`adapters/sid-code-live.ts:252`、`scan-trajectory-secrets.ts` 两处分类文案。
- `_diagnoses/{hrn_001-2026-05-18,plan_004-2026-05-15}.yaml` 的 3 条 `case_path` / `sources`
  改成 bundle 指向，**推理链整段保留**（同 PR3b 改 `meta_001` 的做法）。

## 放弃了什么（以及为什么不选）

1. **放弃保留 `bench-runner/capability-{grader,shared}.ts`。** `bench-runner/` 整体是活目录
   （其余 8 个被 `run-bench` / `run-cross-baseline` / 4 个 skill runner 用），⛔ 不许因此保留这 2 个 ——
   实测它们只被那 5 个 runner + 2 个测试 import，而两者同批删除。**这是本 PR 最容易漏的一条。**

2. **放弃「只删 case、留着 runner 当入口」。** 输入没了的 runner 就是 §0.0.4 否决 `pass-at-k.ts`
   选项 A 的同一形态：把静默换分母变成启动即报错，那不是修好，是留一个必然失败的入口。

3. **放弃删 `packages/core/tests/llm/router-mock-integration.test.ts`。** 它测的是仓内 mock provider
   契约（`ProviderRegistry` + `RetryableError`），**不读那 5 条 yaml**；yaml 只是当年的题面对照。
   只改注释措辞。

4. **放弃删 `baseline-sync.ts` 的 `yamlDir` 分支。** 它是通用单目录 API，不是 capability 专属；
   `buildCapabilityIdIndex` 仍是活代码路径。只改注释，不动实现 —— 与 PR3b 放弃删
   `discoverArchitectureSubDirs` 同理。

5. **放弃删 `scripts/eval/lib/yaml-loader.ts` 的 `CAPABILITY_GRADER_PREFIX`。** 它判的是历史
   `baseline_scores` 里 `capability-*-v1` 这类 grader 版本号字符串，**不读磁盘**；
   `real-tasks/` 的历史 baseline 里仍可能带这种版本号，删了会让它们被误判成 legacy。

6. **放弃在本 PR 动 `real-tasks/`**（PR3d）。

⚠️ **主要放弃项（那条论证线、45 条可跑 case、推翻条件、词汇表保全）全部写在 `rejected/` 那份里**，
本 Note 不重复 —— 一份决策只应有一个当前位置。

## 拿什么证明它生效了

```
① 数量（两个口径都报）
$ git ls-files evals | wc -l                                   → 197   （267 − 70）
$ git ls-files evals/capability | wc -l                        → 0
$ git diff --cached --name-only --diff-filter=D | wc -l        → 77    （含 ③⑥ 两类）
$ git ls-files scripts/eval | wc -l                            → 28    （33 − 5）
$ bun -e "…Object.keys(scripts).filter(k=>k.startsWith('eval:'))" → 8   （13 − 5）
$ git ls-files evals | grep -c '\.ts$'                         → 23    （25 − 2）
$ git ls-files evals/bench-runner | wc -l                      → 8
$ git ls-files evals/_reports | wc -l                          → 20    （24 − 4）

② 3c.3.1 连带清零（⛔ 不许只验 case 目录没了，后 9 类才是本次新增部分）
$ ls scripts/eval/run-*-capability.ts                → 无匹配
$ grep -c "capability" package.json                  → 0
$ ls evals/bench-runner/capability-*                 → 无匹配
$ ls tests/eval/capability-*.test.ts                 → 无匹配
$ grep -n "capability" .gitignore                    → 无输出（含 :97 与 :109）
$ grep -n "capability-grader" evals/bench-runner/process-grader.ts → 无输出

③ 口径①：无指向已删文件的引用
$ git grep -n 'capability-grader\|capability-shared\|run-.*-capability\|eval:.*-capability'
  → 无输出
$ git grep -n 'evals/capability' -- '*.ts' '*.sh' '*.json' '*.yml'
  → 仅 1 处：router-mock-integration.test.ts:4，已改成「原路径…yaml 已随 capability 组删除」的历史叙述
（剩余 capability 字样均为历史叙述 / gold-cases 的 eval_type 快照标签 / harbor 结果 json 字段，
  非文件引用）

④ 永封未被破坏
$ sh scripts/eval/check-holdout-real-tasks-sealed.sh           → 退出 0
$ shasum -a 256 evals/holdout/real-tasks/holdout-sids.txt
  → 11f400c32b2ce262bf24a4b972ce66bb97c5f4f61268247610d6c6a4200d7bcc（与 PR3b 逐字一致）
$ git ls-files evals/_judge/gold-cases | wc -l                 → 10

⑤ 门禁（实跑，见本 PR 的命令输出）
$ bun run affected-tests:run
$ make build
$ bun run format:check / lint / lint:boundary / verify:agent-note
$ bun test ./tests/eval/evals-claude-md-citations.test.ts
```

⚠️ **③ 这条判据是本 PR 唯一能抓住 ⑩ 的东西** —— `process-grader.ts:76` 那行是注释，
删掉 `capability-grader.ts` 后它变成指向不存在文件的行号引用，而**编译、测试、lint 全都不会红**。
本仓 `evals-claude-md-citations.test.ts` 存在的理由就是「行号引用会静默漂移，而漂移不会让任何测试变红」。

⛔ **本次没有证明的事**：① `real-tasks/` 27 条 case 与 31 个 setup 脚本没删（PR3d），
`_diagnoses/` 里指向 real-tasks 的断引用也留给 PR3d；② 没有证明新集覆盖了过程评测能力
（见 `rejected/` 那份的收尾段）；③ 那 45 条 prompt 型 case 只在 bundle 里，本仓已取不到。
