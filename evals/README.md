# sid-code 评测体系（evals/）

> 本目录是 sid-code 评测主战场。导航总入口见 `docs/eval/07-执行顺序速查.md`。
>
> **W1 不动 sid-code 任何 src/ 文件**（铁律，见 ADR-001）。

## 目录约定

```
evals/
├── README.md                  # 本文
├── _template.yaml             # case 模板（cp 后填字段）
├── _judge/                    # LLM Judge prompt（W1 占位，Phase 3 接入）
├── _reports/                  # 周报 / 月报 / 季度报告落盘（必须存在）
├── raw-outputs/               # transcript 落盘（铁律：每条 case 跑分都要落）
├── p0-core/                   # P0 必过 case（10 条，target 4.0）
├── p1-common/                 # P1 应过 case（9 条，target 3.5）
├── p2-edge/                   # P2 加分 case（6 条，target 3.0）
├── holdout/                   # 5 条永不参与日常调优（methodology §6.3）
└── capability/                # Phase 4 子系统 capability eval
    ├── plan/   memory/   context/   router/   harness/
```

## 关键铁律（违反 = 销毁证据）

来自 `docs/eval/06-风险预案与启动清单.md §9.5`：

1. **Transcript 必落盘** — 任何 eval 跑分都要落 `raw-outputs/`，分数变化无法根因诊断 = 销毁证据
2. **holdout 永不参与日常调优** — `run-eval-baseline.ts --skip-holdout` 默认开
3. **ADR 必须有 rejected alternatives** — 没有 rejected alternatives 的 ADR 等于没写
4. **每周五跑 eval + 写周报** — 雷打不动
5. **bench 版本化锁定** — 每个 Phase 末 git tag

## 常用命令

```bash
bun run eval:list                          # 列出所有 case（验证识别）
bun run eval:baseline -- --skip-holdout    # 跑 baseline（串行，~2 小时）
bun run eval:tally -- --week 1             # 汇总 → _reports/baseline-w<N>.md
bun run eval:new-case -- --priority P0     # 用模板新建 case
```

## case 写作规范

详见 `docs/eval/00-总方案.md §3.3` 与 `_template.yaml` 内联注释。**5 个最容易踩的坑**：

1. ❌ `must_include_any_of` 关键词没 grep 验证 → case_001 教训
2. ❌ 写 `must_call_tools_in_order`（agent 找替代序列就 fail，反 §9.1 反 6.2）
3. ❌ 让 LLM 一次性生成 25 条（反 §9.1 反 1）
4. ❌ holdout case 出现在日常 eval 里（反 §9.1 反 6.4，过拟合）
5. ❌ `expected` 写死唯一答案（反 §9.1 反 3）
