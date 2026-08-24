# `evals/_reports/external/` —— 外部 benchmark 报告的唯一落点

外部 benchmark（SWE-bench Verified 等）的跑分报告落这里，**与自家 case 报告物理隔离**。

## 为什么要有这个目录（而不是写到 `evals/_reports/` 根下）

隔离铁律要求「报告独立到 external」，但**一个不存在的目录承载不了铁律** ——
目录不存在时，第一次跑的人会顺手把报告写到 `_reports/` 根下，和自家报告混住，
而那正是铁律要防的事。所以这个目录连同本 README 一起先建好。

⚠️ **落点是 `evals/_reports/external/`，不是仓库根的 `_reports/external/`。**
根 `_reports/` 不在 git 追踪范围内（`evals/_reports/` 才是资产目录，见 `.gitignore` 注释），
写到那里等于产物丢失。`evals/scripts/run-external-baseline.ts` 与
`evals/scripts/self-vs-external-report.ts` 当前**都指向根 `_reports/`**，
它们本身还是骨架（预期返回值硬编码为 0），接入实跑时必须把落点改到这里 —— 见下方「已知漂移」。

## 三条隔离铁律

1. ❌ **不写自家 case yaml 的 `baseline_scores`。** 外部锚与自研 case 完全独立，
   外部分数不进自家 baseline 时序。
2. ❌ **不进自家 grader 注册表**（`rubric_5d` / `binary_redline` 等一律不评外部 case）。
   外部 benchmark 用它自己的判分入口（SWE-bench 走官方 `swebench eval`）。
3. ✅ **报告只落本目录**，不与自家 eval 报告同文件、不碰 `evals/_scores/`
   （那是自家 baseline 的地盘）。

## 第四条：污染不可逆

**SWE-bench 的 `patch` / `FAIL_TO_PASS` 任何内容都不可流入自家 case yaml。**

这不是整洁问题。`evals/holdout/real-tasks/` 是**永封集**（永封时间 2026-05-31，
pre-push 有永封校验）—— 一旦外部答案渗进自家 case，**污染是不可逆的，永封集不能重置**。
「顺手把 gold patch 贴进 case 里当参考答案」是最容易发生的那种渗透，不要做。

## 报告口径：不许含百分比字段

SWE-bench Verified 阶段 A 是 **10 题二值 smoke，不是回归哨兵**。
n=10 在 p≈0.7 时 SE=14.5pp、95% CI 半宽 ±28pp，**60% 与 70% 统计上无法区分**。
所以报告模板长这样：

```
link_ok             : 10/10 instance 产出非空 patch        ← 二值
graded_ok           : 10/10 拿到 report.json（无 ungraded） ← 二值
gold_ok             : PASS                                 ← 二值
solved_count        : n/10  ← 绝对数，不换算百分比、不进 release 曲线
patch_touches_tests : n     ← 「禁改测试文件」那道硬检查的计数
```

**`ungraded` 不静默算失败** —— 「判分没跑起来却把结果当 0」会得到一个假 0%，
和路径 A 那个「scorer 硬编码返 0」是同一个陷阱换了位置。

## 已知漂移（接实跑前必须处理）

| 文件 | 问题 |
| --- | --- |
| `evals/scripts/run-external-baseline.ts` | 落点写的是根 `_reports/external`（`:27`）；preflight 仍断言已删除的 3 个 Inspect 文件存在 |
| `evals/scripts/self-vs-external-report.ts` | 同样指向根 `_reports/external`（`:27`）；依赖不存在的 `_reports/templates/` 模板 |

两个脚本都还是骨架（`runExecTrack` 硬编码返回 `pass: 0`），**当前跑出来的数字没有意义**，
所以本次不改它们的逻辑，只在此登记。接实跑那个 PR 一并修。

## 相关文档

- `evals/external-benchmarks/swe-bench/接入计划.md` —— 路径 B 方案（事实源）
- `evals/external-benchmarks/README.md` —— 为什么需要外部锚
- `.agents/notes/proposed/testing/2026-08-24-swe-bench-阶段a-二值smoke方案.md`
