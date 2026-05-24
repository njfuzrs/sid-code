# evals/_legacy/

冻结目录 — **仅供历史数据回查 / 紧急回滚**。请勿主动调用。

## 为什么在这里

2026-05-23 起评测主入口切换到自研 `evals/eval-runner.ts`，原因详见
`docs/eval/10-eval-architecture-analysis.md §5.4`：

1. promptfoo 黑盒并发/重试不可控，遇 LLM 中转商 429 会跑空 5h+
2. 评分公式重复维护（同一公式分布在 yaml 字符串 + eval-judge.ts）
3. wrapper 双套同步成本高（已发生过修一处漏一处的事故）

## 当前状态

- `promptfoo/` — 旧 promptfoo 配置 + yaml-to-tests 转换脚本 + 评分 prompt 字符串
  - `providers/` 子目录已删除：所有 wrapper 统一到 `evals/providers/`，
    eval-runner 通过 `spawn` 直接调用，不再经过 promptfoo
  - 保留 `promptfooconfig.yaml` / `lib/yaml-to-tests.ts` / `README.md` 仅为
    可追溯历史报告（`evals/_reports/promptfoo-*.json`）的生成上下文

## 严禁

- ❌ 不要再跑 `bunx promptfoo eval`
- ❌ 不要再改 `_legacy/promptfoo/` 下任何文件
- ❌ 不要把 `_reports/promptfoo-*.json` 当"最新分数"——以
  `_reports/eval-latest.json` + `_runs/<provider>.jsonl` 为准

## 真要回滚怎么办

如果 `eval-runner.ts` 完全不可用（极端情况），回滚步骤：

1. `git mv evals/_legacy/promptfoo evals/promptfoo`
2. 在 `evals/_legacy/promptfoo/providers/`（已删）下重建 wrapper —— 直接
   `cp evals/providers/*.ts evals/promptfoo/providers/`，然后改 argv 解析
   方式（promptfoo 用 `process.argv[2/3/4]` + sideband 文件，不是 `--prompt`
   命名参数）
3. 恢复 `package.json` 的 `eval:horizontal-*` 脚本（git 历史里有）

但更推荐：直接修 `eval-runner.ts`。
