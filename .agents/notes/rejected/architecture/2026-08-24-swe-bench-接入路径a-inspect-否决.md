---
Status: rejected
Date: 2026-08-24
---
# SWE-bench 接入否决路径 A（Inspect AI），改走路径 B（官方 `swebench eval`）

## 决定了什么

SWE-bench Verified 的接入路径定为 **B：官方 `swebench eval`** —— sid-code 在容器里产出
`git diff` → 写成三字段 jsonl（`instance_id` / `model_patch` / `model_name_or_path`）→
丢给官方 harness 判分并读回 `report.json`。**我们不写 scorer、不判对错。**

**路径 A（Inspect AI）否决**，随之落地的改动：

- `evals/external-benchmarks/swe-bench/接入计划.md` §1 从「路径 A：Inspect AI」改写为路径 B，
  §1.2 把 SWE-bench Pro 从「M5 Gate 后视情况切换」改为**否决**，§7 风险表去掉「切 Pro」这条缓解措施、
  并明确「路径 A 不再是回滚目标」。
- 删除 3 个路径 A 脚手架文件：`sid_code_solver.py` / `runner.ts` / `requirements.txt`。
- `evals/inspect/` **保留**（spike 实证载体），README 顶部加否决框。
- `evals/external-benchmarks/README.md`「集成路径」一节的「当前决策：默认路径 A」被裁决取代。
- `evals/scripts/run-external-baseline.ts` 摘掉两条断言已删文件存在的 preflight
  （否则该脚本 `--track exec` 恒 `exit 1`）。

**作用域只有 SWE-bench。** 不是「本仓一律不用 Inspect」—— MT-Bench / HumanEval 的路径未裁决。

## 放弃了什么（以及为什么不选）

**放弃路径 A（Inspect AI + `inspect_evals.swe_bench`）。**

上一版把 A 列为默认，写的理由是「业界事实标准 + 已过 spike 验证 + 可复用现有脚手架」。
**第三条是 A 的唯一实质优势，而它实测为 0** —— 三个文件不是半成品，是带类型标注的伪代码：

| 实测点 | 事实 |
| --- | --- |
| `sid_code_solver.py:200` | 判分**硬编码 `return Score(value=0)`**，注释写「等 S8 实施者接 scorer」 |
| `sid_code_solver.py:159-160` | `git clone` / `checkout base_commit` 是**注释状态** —— 容器里根本没有待修代码库 |
| `sid_code_solver.py:97-108` | 调 sid-code 用的 `--user-query` / `--workdir` / `--headless` / `--trace-out` **四个 flag 在 `packages/cli/src/cli.ts` 里全不存在**（真实写法是 `-p --max-turns N -- "<题面>"`） |

A 剩下的那条优势「sandbox 与 scorer 由上游维护」也大半不成立：Inspect 的 sandbox 同样要配
docker、同样跑 x86_64 镜像、arm64 问题一模一样；而 B 的判分本来就只是**调一个命令行工具**，
不存在「自己写 scorer」的成本。换来的代价是多两层 Python 框架（`inspect_ai` + `inspect_evals`）
外加一个**仓外 venv**（`接入计划.md` 原 §1.1 指向 `~/Code/person/trajectory-platform/backend/venv`）——
仓外依赖正是 P1-5 已经修掉过一次的那类问题（`eval-framework` 从 `file:../` 改 workspace），
不该在新链路上重新引入。

**两者是两套架构，不能各取一半**：A 把结果交给一个运行中的 Python 对象（`TaskState`），
B 落一个 jsonl 再调命令行工具。「交答案」与「判对错」的接口不兼容。

**⚠️ 一处「理由变了、结论没变」，特意写下来防止有人据此重开此项。**
原文给 B 的理由之一是「与 Harbor 适配阶段共用防作弊 preflight / patch 提取 / 不自己判定这三块」。
该理由**已不成立** —— 同一轮裁决把对照实验改成不走 Harbor、Harbor 适配降为长期项。
**但结论不变**，它现在靠的是上面那三条实测 + 依赖链更短 + 与业界 harness 同形。
发现原理由失效**不构成重开 D1 的依据**。

**同时放弃 SWE-bench Pro**（三条理由任一独立成立）：public 731 题约 30% 是坏的
（OpenAI 2026-07-08 官方审计并 retract 推荐）；数据是 **GPL copyleft**（抗污染设计），
harness 才是 MIT；commercial 276 题来自 18 家初创的私有仓，**天然不可复现** ——
别人拿不到同一份数据，我们的数字无法被外部核验，与「外部锚点」的定义直接矛盾。
**正是第三条让「先去核实 commercial split 可获取性」这件事失去意义：核实成功也不能用。**
所以那条待办是**取消**，不是延期。

**保留 `evals/inspect/`（没删）。** 它有 `run_spike.py` + `tasks/` + `lib/` + `logs/`，
是「已过 spike 验证」那句话的唯一实证载体。删掉它，`接入计划.md` 那句引用变成死链，
而未来想核验「当年 spike 到底验到什么程度」的人就没有落点。
按 `CLAUDE.md` 的铁律，这类溯源线索是资产。

## 拿什么证明它生效了

**① 三个待删文件的「零外部引用」这一格是错的，实测发现并已修**（这是本次唯一一处推翻方案的地方）：

```
$ grep -rn "sid_code_solver\|swe-bench/runner\|swe-bench/requirements" . | grep -v node_modules
evals/scripts/run-external-baseline.ts:71:    name: "swe-bench/sid_code_solver.py 存在",
evals/scripts/run-external-baseline.ts:80:    name: "swe-bench/requirements.txt 存在",
evals/scripts/run-external-baseline.ts:177:  console.log(`[external/exec] 调用 swe-bench/runner.ts ...`)
```

删文件前该脚本 `--validate` 是绿的（实测 `EXIT=0`，四项 ✅）；只删文件不改它，
preflight 会因「缺文件」**恒 `exit 1`** —— 拦住的不是「环境没到位」而是「决策已变」。
改后复跑：

```
$ bun run evals/scripts/run-external-baseline.ts --track exec --validate
  ✅ swe-bench/verified-subset.yaml 存在 + 10 条 instance
  ✅ _reports/external/ 目录可写
[external] --validate 模式,前置就位 ✅   → exit 0
```

**② `packages/eval-framework/` 零耦合已复核**（方案这一格是对的）：
`grep -rn eval-framework evals/external-benchmarks/` 零命中；反向 grep `swe-bench|inspect`
在 `packages/eval-framework/` 零命中。`runner.ts` 删除前的全部 import 只有 `node:fs` / `node:path`。
**那 35 处 eval-framework 引用一行未改。**

**③ 4000 端口的「LiteLLM」记述已实测推翻并纠正**：

```
$ lsof -nP -iTCP:4000 -sTCP:LISTEN
claude-tr 53727 zhourusheng ... TCP 127.0.0.1:4000 (LISTEN)
```

监听者是 `claude-trace`，不是 LiteLLM。已在 `evals/inspect/README.md` 标注：
那段 LiteLLM 报错是 2026-05-21 当时的环境事实，照它 debug 今天的 4000 端口会走错方向。

**④ 门禁**：`bun run affected-tests:run` 与 `make build` 见 PR 正文（本次改动为文档 +
一个骨架脚本的注释/日志，不含行为变更）。`bun run verify:agent-note` 通过。

**⑤ 一处未做的事，明写**：`evals/scripts/run-external-baseline.ts` 与
`self-vs-external-report.ts` 的报告落点都指向**仓库根** `_reports/external`，
而资产目录是 `evals/_reports/`（根 `_reports/` 不入 git）。两个脚本当前都是骨架
（`runExecTrack` 硬编码 `pass: 0`），**改落点属于接实跑那个 PR 的范围**，
本次只在 `evals/_reports/external/README.md` 的「已知漂移」表里登记，没有偷偷改逻辑。
