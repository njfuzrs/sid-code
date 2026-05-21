# Evals Dashboard — sid-code

> 自动生成,请勿手动编辑。生成时间: `2026-05-21T19:53:27.074Z`
> 数据源: `evals/p*-*/` + `evals/_scores/` + `evals/_reports/`
> 触发: 手动 `bun run eval:dashboard` / git pre-push hook 自动刷新

---

## 1. 总览

- **case 总数**: 30 条
- **优先级分布**: P0=12 / P1=10 / P2=8 / holdout=5
- **claude_code** 评分进度: 24/30 已评分 (5 pending)
- **claude_code_opus47** 评分进度: 24/30 已评分 (5 pending)
- **codex** 评分进度: 0/30 已评分 (30 pending)
- **sid_code_live** 评分进度: 24/30 已评分 (5 pending)
- **sid_code_opus47** 评分进度: 23/30 已评分 (5 pending)
- **sid_code_w0** 评分进度: 12/30 已评分 (18 pending)

## 2. Case × Tool 矩阵

图例: ✅ ≥4.5 / 🟢 3.5-4.4 / 🟡 2.5-3.4 / 🟠 1.5-2.4 / 🔴 <1.5 / – pending / ❌ error / ⏱️ timeout

| case_id | pri | category | claude_code | claude_code_opus47 | codex | sid_code_live | sid_code_opus47 | sid_code_w0 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| case_001 | P0 | 代码理解 | 1.4 🔴 | 2.5 🟡 | – | 5 ✅ | 5 ✅ | 5 ✅ |
| case_002 | P0 | 代码理解 | 5 ✅ | 5 ✅ | – | 5 ✅ | 5 ✅ | 5 ✅ |
| case_003 | P0 | 代码理解 | 4.7 ✅ | 5 ✅ | – | ❌ | 3.2 🟡 | 5 ✅ |
| case_004 🔒 | P0 | 代码理解 | – | – | – | – | – | – |
| case_005 | P0 | bug修复 | 5 ✅ | 4.8 ✅ | – | 5 ✅ | 4.8 ✅ | 1 🔴 |
| case_006 | P0 | bug修复 | 4.9 ✅ | 4.8 ✅ | – | 5 ✅ | ❌ | 3 🟡 |
| case_007 | P0 | bug修复 | 3 🟡 | 5 ✅ | – | 5 ✅ | ❌ | 4 🟢 |
| case_008 | P0 | 新功能实现 | 2 🟠 | 5 ✅ | – | 4.9 ✅ | 4.8 ✅ | 3 🟡 |
| case_009 | P0 | 新功能实现 | 4.9 ✅ | 5 ✅ | – | 5 ✅ | 5 ✅ | 3 🟡 |
| case_010 🔒 | P0 | 文档生成 | – | – | – | – | – | – |
| case_011 | P1 | 重构 | 2 🟠 | 5 ✅ | – | 4.7 ✅ | 5 ✅ | – |
| case_012 | P1 | 重构 | 4.6 ✅ | 4.5 ✅ | – | 5 ✅ | 5 ✅ | – |
| case_013 | P1 | 多文件协调 | 4.7 ✅ | 4.5 ✅ | – | 5 ✅ | 5 ✅ | – |
| case_014 🔒 | P1 | 多文件协调 | – | – | – | – | – | – |
| case_015 | P1 | 测试编写 | 5 ✅ | 5 ✅ | – | 5 ✅ | 4.8 ✅ | – |
| case_016 | P1 | 测试编写 | 4.9 ✅ | 4.8 ✅ | – | 4.1 🟢 | 4.5 ✅ | – |
| case_017 | P1 | 依赖管理 | 5 ✅ | 4.8 ✅ | – | 4.6 ✅ | 4.8 ✅ | – |
| case_018 | P1 | MCP工具调用 | 5 ✅ | 5 ✅ | – | 5 ✅ | 5 ✅ | – |
| case_019 | P1 | MCP工具调用 | 4.9 ✅ | 5 ✅ | – | 5 ✅ | 5 ✅ | – |
| case_020 | P2 | 跨语言 | 5 ✅ | 5 ✅ | – | 5 ✅ | 5 ✅ | 4 🟢 |
| case_021 | P2 | 歧义查询 | 2 🟠 | 2.1 🟠 | – | 2.6 🟡 | 1.4 🔴 | 3 🟡 |
| case_022 | P2 | 歧义查询 | ⏱️ | ⏱️ | – | 5 ✅ | 4.8 ✅ | 3 🟡 |
| case_023 🔒 | P2 | 对抗性prompt | – | – | – | – | – | – |
| case_024 | P2 | 超长上下文 | 5 ✅ | 4.8 ✅ | – | 4.9 ✅ | 4.8 ✅ | 4 🟢 |
| case_025 🔒 | P2 | 诚实兜底 | – | – | – | – | – | – |
| case_026 | P0 | 文档生成 | 5 ✅ | 5 ✅ | – | 5 ✅ | 5 ✅ | – |
| case_027 | P0 | bug修复 | 4.9 ✅ | 5 ✅ | – | 5 ✅ | 5 ✅ | – |
| case_028 | P1 | 多文件协调 | 5 ✅ | 5 ✅ | – | 5 ✅ | 5 ✅ | – |
| case_029 | P2 | 对抗性prompt | 3.6 🟢 | 5 ✅ | – | 3.6 🟢 | 5 ✅ | – |
| case_030 | P2 | 诚实兜底 | 5 ✅ | 5 ✅ | – | 5 ✅ | 3.6 🟢 | – |

## 3. 单 case 跨周趋势

> 当前项目无 `_scores/wNN/` 时序数据,跳过。
> 
> 提示: code-graph 项目把每周分数外部化到 `evals/_scores/wNN/case_NNN.yaml` 实现时序追踪,
> 推荐 sid-code 也引入这一模式(详见 plan Step 3 长期归一化)。

## 4. 评分进度 / Pending 列表

### claude_code: 5 条 pending

- **P0** (2): `case_004`, `case_010`
- **P1** (1): `case_014`
- **P2** (2): `case_023`, `case_025`

### claude_code_opus47: 5 条 pending

- **P0** (2): `case_004`, `case_010`
- **P1** (1): `case_014`
- **P2** (2): `case_023`, `case_025`

### codex: 30 条 pending

- **P0** (12): `case_001`, `case_002`, `case_003`, `case_004`, `case_005`, `case_006`, `case_007`, `case_008`, `case_009`, `case_010`, `case_026`, `case_027`
- **P1** (10): `case_011`, `case_012`, `case_013`, `case_014`, `case_015`, `case_016`, `case_017`, `case_018`, `case_019`, `case_028`
- **P2** (8): `case_020`, `case_021`, `case_022`, `case_023`, `case_024`, `case_025`, `case_029`, `case_030`

### sid_code_live: 5 条 pending

- **P0** (2): `case_004`, `case_010`
- **P1** (1): `case_014`
- **P2** (2): `case_023`, `case_025`

### sid_code_opus47: 5 条 pending

- **P0** (2): `case_004`, `case_010`
- **P1** (1): `case_014`
- **P2** (2): `case_023`, `case_025`

### sid_code_w0: 18 条 pending

- **P0** (4): `case_004`, `case_010`, `case_026`, `case_027`
- **P1** (10): `case_011`, `case_012`, `case_013`, `case_014`, `case_015`, `case_016`, `case_017`, `case_018`, `case_019`, `case_028`
- **P2** (4): `case_023`, `case_025`, `case_029`, `case_030`


## 5. 异常 / 高方差 case

- **claude_code <2 分**: `case_001`
- **sid_code_opus47 <2 分**: `case_021`
- **sid_code_w0 <2 分**: `case_005`

## 6. 数据源

- `evals/p0-core/`: 10 条 case
- `evals/holdout/`: 5 条 case
- `evals/p1-common/`: 9 条 case
- `evals/p2-edge/`: 6 条 case
- `evals/_scores/`: (无)

## 7. 跳转入口

- [完整周报目录](_reports/) — 含 baseline / regression / horizontal-comparison
- [所有 case yaml](p0-core/) · [P1](p1-common/) · [P2](p2-edge/) · [holdout](holdout/)
