# trajectory-platform Holdout 永封名单（B7-3）

> 来源：`/Users/dev/Code/person/trajectory-platform/bench/splits/holdout.txt`
> 永封时间：2026-05-31
> SHA-256：`11f400c32b2ce262bf24a4b972ce66bb97c5f4f61268247610d6c6a4200d7bcc`
> 条数：200
>
> **格式**：每行 12 字符短码 `<sid前8>-<sid第10-12>`，对应 trajectory-platform/data/pulled_sessions/ 中的 full UUID（如 `3b1d0d73-151` ↔ `3b1d0d73-1512-4720-9004-cdc001b7980c`）。
>
> **本文件作用**：
> 1. 永封 trajectory-platform 上游 200 条 holdout sid 名单的不可变副本（任何后续 `git pull` 上游 splits 变化都不能影响本文件）
> 2. 充当 sid → task_id 反查的"答案集"：任何用 sid 派生的 case 进入 `evals/real-tasks/` **必须** grep 本文件确认未命中
> 3. pre-push hook 拦截：本目录下任何 yaml/txt 改动 → push 中止（除非 commit 明确说明"holdout 升级"且经 ADR 审批）
>
> **本文件不能改的内容**（路线 §9.1.2 + §9.1.1 铁律）：
> - 永远不要把 holdout sid 派生 case 落到 `evals/real-tasks/<cat>/`
> - 永远不要在 `evals/CASES.md` / `evals/DASHBOARD.md` 公开页面引用本文件中的 sid
> - 永远不要在 src/ commit 中以"调试"为名读取 holdout sid 对应的 trajectory（默认 `--skip-holdout=true`）

## 落地说明

- 200 sid 在 trajectory-platform/bench/tasks/T*/task.yaml 中**未被任何 task 引用**——是上游独立的 holdout 池，不属于已有 847 task 的任何一条
- 因此本永封是"sid 名单 + 校验和" 形态，非 case yaml 形态
- 升级路径（M5+ 启动外部锚后）：
  1. 上游若把 sid → task 反查表落盘，本目录开始落 `case_<task_id>.yaml`（仍带 `holdout: true`）
  2. M5 Gate 评审通过后，本名单进 `evals/external-benchmarks/holdout-200/` 作为外部锚的报告轨样本来源（§15.1）

## 校验

```bash
# 校验和必须等于
shasum -a 256 evals/holdout/real-tasks/holdout-sids.txt
# → 11f400c32b2ce262bf24a4b972ce66bb97c5f4f61268247610d6c6a4200d7bcc
```

校验和不等 = 文件被改 = 立即 abort 任何 evals/ 操作。
