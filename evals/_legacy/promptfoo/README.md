# Promptfoo — sid-code 横向对比可视化

**状态**: Phase 6.1 Spike(待 1 次本地跑分验证后转 Accepted)
**Date**: 2026-05-21
**决策文档**: [`docs/eval/investigations/eval-viz-framework-selection.md`](../../docs/eval/investigations/eval-viz-framework-selection.md)

---

## 这是什么

用 [Promptfoo](https://www.promptfoo.dev) 跑 **横向对比**(sid-code-live vs claude-code vs codex 并排矩阵),解决主决策文档里诊断出的痛点 #4("横向对比是一次性产物")。

**边界**(很重要,别越界):

| Promptfoo 管 | 不管 |
|---|---|
| 跨工具并排 + 浏览器矩阵 | sid-code 自家纵向 baseline(继续 `bun run eval:baseline`) |
| LLM judge 校准实验 | bench 844 全量(继续 `bun run eval:bench`) |
| 加新对手只改一行 | 趋势可视化(继续 `bun run eval:dashboard`) |

**不替代任何现有跑分流程**。双轨并行:Promptfoo 管"跨 tool 比",dashboard.ts 管"跨周比"。

---

## 目录结构

```
evals/promptfoo/
├── README.md                      # 本文件
├── promptfooconfig.yaml           # 主配置(prompts + providers + tests + judge)
├── providers/
│   ├── sid-code-live.ts           # exec: 包装 bun run src/entrypoints/bootstrap.ts
│   └── claude-code.ts             # exec: 包装 claude -p --output-format json
├── lib/
│   └── yaml-to-tests.ts           # case yaml → promptfoo tests 转换器
├── tests/
│   └── generated-tests.yaml       # 由 yaml-to-tests.ts 产出(gitignore)
└── .gitignore
```

---

## 快速开始

### 0. 前置

```bash
# 必需(promptfoo 用 bunx 跑,不入 package.json deps)
bunx promptfoo@latest --version    # 首次会拉 npm 包,后续走缓存

# Anthropic API key(给 llm-rubric judge 用,与现有 calibration-v3 一致)
export ANTHROPIC_API_KEY=sk-ant-xxx

# claude-code provider 用 claude CLI,需先安装(可选,只对比 sid-code-live 时不需要)
which claude || echo "claude CLI 未安装,跳过 claude-code provider"
```

### 1. 生成 tests

```bash
# 默认转 case_001 / case_002 / case_005(spike 范围)
bun run evals/promptfoo/lib/yaml-to-tests.ts

# 自定义 case 集
bun run evals/promptfoo/lib/yaml-to-tests.ts --cases case_001,case_002,case_005,case_006

# 输出: evals/promptfoo/tests/generated-tests.yaml
```

### 2. 跑 eval

```bash
cd evals/promptfoo
bunx promptfoo eval

# 期望: exit 0,3 case × 2 provider = 6 个结果
# 输出 JSON: ../_reports/promptfoo-latest.json
# 输出 CSV:  ../_reports/promptfoo-latest.csv
```

### 3. 浏览器矩阵

```bash
cd evals/promptfoo
bunx promptfoo view

# 打开 http://localhost:15500/
# 期望: 表格,行=case,列=provider,每格显示 pass/fail + score + diff 视图
```

---

## Spike 验收清单(Phase 6.1)

跑完 Step 2/3 后,按下面 5 条验证:

- [ ] `bunx promptfoo eval` 退出码 0,出 6 个结果(3 × 2)
- [ ] 浏览器矩阵能并排展示 sid-code-live vs claude-code,有 score / pass / diff
- [ ] `provider: exec` 包装后,trace / cost / latency 字段是否完整(看 promptfoo-latest.json)
- [ ] `llm-rubric` 复用 prompt-v3.md 的评分维度,judge 输出 JSON 解析成功
- [ ] 加第三个 provider(例如 codex)只需在 `promptfooconfig.yaml` 里加 1 行,无需改其他文件

5 条都通过 → 在 [决策文档 §8](../../docs/eval/investigations/eval-viz-framework-selection.md#8-验证方法) 打勾,推进到 Phase 6.2。

---

## 与现有评测体系的接口

| 数据流入 | 怎么进 |
|---|---|
| case 题面 | `lib/yaml-to-tests.ts` 读 `evals/p0-core,p1-common,p2-edge/case_*.yaml` |
| judge prompt | rubric 内联了 `evals/_judge/prompt-v3.md` 的评分标准(0.0-1.0 + threshold 0.6) |
| LLM 模型 / API key | 走环境变量(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`),与现有跑分链路一致 |

| 数据流出 | 去哪里 |
|---|---|
| 单次跑分原始结果 | `evals/_reports/promptfoo-latest.json` `.csv` |
| 横向对比报告 v2 | Phase 6.2 接入后,`evals/_reports/horizontal-comparison-v2.md`(待落地) |
| `_scores/wNN/` 时序 | **不直接写入**,由 Phase 6.2 的 `run-horizontal.ts` 桥接(待落地) |
| dashboard.md | Phase 6.2 起 `dashboard.ts` 加 §8 链接 promptfoo eval ID(待落地) |

---

## 已知风险

(对应决策文档 §7)

1. **Promptfoo 被 OpenAI 收购后社区版冻结**:MIT 不可撤销,真出问题迁 Braintrust OSS
2. **`exec: provider` stdin/stdout 协议不匹配**:已用 TS wrapper 处理 JSON 输出(`providers/*.ts`),失败时退回纯 stdout
3. **LLM judge 行为不一致**:spike 阶段需人工对比 5 case 的 calibration ρ,差异 > 0.1 转 ADR-018 重审

---

## 后续

- **Phase 6.2** 主流程接入(待 spike 通过): 把 25 case 全部转 promptfoo,产出 `horizontal-comparison-v2.md`
- **Phase 6.3** CI 集成: `.github/workflows/eval.yml` PR 自动跑 smoke 5 case
- **Phase 6.4** Inspect AI 退役: 见 `evals/inspect/README.md`

---

## 排错备忘

| 症状 | 排查 |
|---|---|
| `bunx promptfoo` 拉包卡住 | 用 `npx promptfoo@latest` 走 npm 镜像,或检查 `~/.bun/install/cache` |
| `exec: bun run providers/...` 报 `ENOENT` | 必须在 `evals/promptfoo/` 目录跑 `bunx promptfoo eval`,相对路径基于 config 所在目录 |
| `llm-rubric` 报 `No API key found` | 检查 `ANTHROPIC_API_KEY` 是否在当前 shell;promptfoo 不读 `~/.sid-code/config.yaml` |
| sid-code-live wrapper 输出 `[ERROR] sid-code-live exit=...` | 看 stderr,可能是 `bun run src/entrypoints/bootstrap.ts -p` 报错;直接手跑这条命令复现 |
| claude-code provider 5/25 超时 | 与现有 `run-cross-baseline.ts` 同症状,根因待 Phase 6.2 用 promptfoo trace 排查 |
