# Holdout 泄露审计清单(F-H5 / 评测系统报告 §Holdout 隔离)

> **目的**: 跟踪 holdout 题面泄露的修复进度。每条修复需有 fix-id + status + 责任人 + 完成日期。
> **更新频率**: 每个 sprint 末刷新,合入 sprint 报告。
> **配套**:
> - 自动检测: `scripts/eval/check-holdout-leak.sh`(pre-push hook 调用)
> - token 提取: `scripts/eval/extract-holdout-tokens.ts`
> - 双重防御: ADR-038(待落盘)/ F-H3(yaml_to_sample.py)/ F-H4(baseline-sync.ts)

## 已完成

| ID | 标题 | 修复 commit | 完成日期 | 责任人 |
| --- | --- | --- | --- | --- |
| F-H1 | `evals/CASES.md` 移除 holdout 题面 | (见 git log) | 2026-05-29 | zhourusheng |
| F-H2 | 删除根目录 `chat_session_id.json` + .gitignore | (见 git log) | 2026-05-29 | zhourusheng |
| F-H3 | `yaml_to_sample.py` 默认拒绝 holdout | (本次 PR) | 2026-05-30 | zhourusheng |
| F-H4 | `baseline-sync.ts` 加 allowHoldout 双重防御 | (本次 PR) | 2026-05-30 | zhourusheng |
| F-H5 | pre-push 检测 + holdout-leak-audit.md | (本次 PR) | 2026-05-30 | zhourusheng |

## 待办

| ID | 标题 | 计划 sprint | 责任人 | 状态 |
| --- | --- | --- | --- | --- |
| F-H6 | DASHBOARD.md holdout 行隐藏类别+具体名 | M4 | tbd | pending |
| F-H7 | sprint 报告/m3-gate-status-table holdout 分数私有化 | M4 | tbd | pending |
| F-H8 | (见报告 §Holdout 隔离 P1/P2 表) | M5 | tbd | pending |

## 历史违反案例

| 日期 | 类型 | 影响 | 备注 |
| --- | --- | --- | --- |
| 2026-05-28 之前 | `evals/CASES.md` 含 holdout 全部题面 | M3 holdout 评估"题面已知" | F-H1 已修 |
| 2026-05-28 之前 | `chat_session_id.json` 入库 | 跨 session 信息潜在泄露 | F-H2 已修 |
| 2026-05-28 之前 | `yaml_to_sample.py` search_dirs 含 "holdout" | inspect 路径无授权读 holdout | F-H3 已修 |
| 2026-05-28 之前 | `baseline-sync.ts` 无 holdout 守卫 | holdout 跑分可能写入公开 yaml | F-H4 已修 |

## 防御层级

| 层级 | 机制 | 文件 | 检测时机 |
| --- | --- | --- | --- |
| L1 物理隔离 | `evals/holdout/` 目录 | - | 文件系统层 |
| L2 题面隔离 | gen-cases-md.ts 跳过 holdout | `evals/gen-cases-md.ts` | regen 时 |
| L3 加载守卫 | yaml_to_sample.py allow_holdout | `evals/inspect/lib/yaml_to_sample.py` | inspect 加载时 |
| L4 写入守卫 | baseline-sync.ts allowHoldout | `evals/baseline-sync.ts` | sync 时 |
| L5 pre-push 检测 | check-holdout-leak.sh | `scripts/eval/check-holdout-leak.sh` | git push 时 |

任一层级失效都不能让 holdout 题面泄露 —— 5 层独立守卫互为冗余。

## 复审周期

每个 sprint 末由 sprint owner 检查:
- [ ] `scripts/eval/check-holdout-leak.sh` 在 pre-push hook 中被调用
- [ ] 本 sprint 新增 case 是否触及 `evals/holdout/`
- [ ] M3 评估日是否需要更新 F-H7(sprint 报告分数私有化)
