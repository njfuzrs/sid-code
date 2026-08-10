# Inspect AI Spike — 评估结论

> 时间: 2026-05-21
> 范围: 2 条 case (case_001 / case_002 P0 代码理解)
> 模型: anthropic/claude-sonnet-4-6 (经 LiteLLM 代理 http://127.0.0.1:4000)

## TL;DR

Inspect AI 接入**技术可行**，**学习曲线低于预期**(实际 ~2h 完成 spike)，
但 **暂不推荐立即全面迁移** —— 现有 sid-code TS/Bun 工具链已经稳定，迁移到 Python 的 ROI 需要更明确的驱动场景（agent eval / 横向对比 codex 等）。

**建议**: Inspect AI 留作**横向对比工具**（claude-code / codex CLI 跑分用），不替换主 baseline 流程。

---

## 验证清单(Plan Step 2.3 五问回答)

### 1. `inspect view` 能否清晰展示 message history + tool calls?

**✅ 能**。`inspect view start --log-dir evals/inspect/logs --port 7575` 启动后浏览器访问 7575 端口，返回标准 Inspect View UI（含 sample drill-down / agent message history / score 维度展开）。

### 2. 把 sid-code-live adapter 接成 solver 复杂度多大?

**中等**。本次 spike 只用了 `generate()` 默认 solver(直接调 Anthropic 模型)。要接 sid-code-live adapter 需要写一个 custom solver:

```python
@solver
def sid_code_solver():
    async def solve(state, generate):
        # spawn `sid-code` CLI 子进程, 把 state.input.text 当 user_query
        # 解析 trace, 把 messages 写回 state
        return state
    return solve
```

Inspect 文档示例丰富（`inspect_evals` 仓库 200+ 实例），预计 4-6h 接通。

### 3. 复用现有 LLM judge prompt(`evals/_judge/`)是否顺畅?

**顺畅**。Inspect 的 `model_graded_qa()` / `model_graded_fact()` 接受任意 prompt 模板字符串。本次 spike 用的是 `must_include_any_scorer` 自定义 scorer(命中关键词)，直接用 Python 函数调用现有 judge prompt 字符串无障碍。

### 4. 与现有 `_scores/wNN/` 时序如何协同?

**需要桥接层**。Inspect 输出 `.eval` 二进制日志（实为 zip 压缩的 JSON），不是 yaml。两种集成方式:

- **A**: 写转换脚本 `eval_to_score_yaml.py`，把 `.eval` 转成 `_scores/wNN/case_NNN.yaml` 格式 → DASHBOARD.md 自动消费
- **B**: 直接修改 `eval:dashboard` 让它同时读 `.eval` + `_scores/`(增加 inspect_ai Python 依赖到 dashboard)

A 方案更轻，推荐。

### 5. 学习成本评估(实际花时间)

- inspect-ai 安装: 5 min(注意要装 `anthropic` extra: `pip install anthropic`)
- yaml → Sample 转换: 15 min
- 自定义 scorer: 20 min
- 第一次成功跑完 2 case: 60 min(走过的坑见下)
- **合计约 2h**(plan 估计 2-4h, 命中)

---

## 走过的坑

### 坑 1: LiteLLM 代理对 haiku-4-5 模型说"无可用渠道"

我先用了 `claude-haiku-4-5`，跑完后所有 `.eval` 文件 status=started 卡死。
直接 curl `http://127.0.0.1:4000/v1/messages` 测代理，回应 `当前分组 code 下对于模型 claude-haiku-4-5 计费模式 [按量计费,按次计费] 无可用渠道`。

**根因**: LiteLLM 配置里没注册 haiku-4-5 渠道。
**解法**: 改用 `claude-sonnet-4-6`(代理已注册)，立即跑通。

**提示给后续维护者**: 不要假设代理支持所有 Claude 模型，先 curl ping 一下。

### 坑 2: inspect CLI 在 Bash 后台任务里 stdout 0 字节

`inspect eval ...` 直接跑会启动 textual TUI，霸占 stdout。
被 Claude Code 的 Bash 工具后台化执行时，TUI 被屏蔽，输出 0 字节，且实际还在跑。

**解法**: 写 Python 脚本调用 `eval()` API + `display="plain"` 参数，避开 TUI:

```python
from inspect_ai import eval as inspect_eval
inspect_eval(my_task(), model="...", display="plain")
```

### 坑 3: anthropic SDK 是 inspect-ai 的可选依赖

`pip install inspect-ai` 不会自动装 anthropic SDK。需要单独 `pip install anthropic`。

---

## spike 跑分结果(不是评估目标，仅记录)

```
Task: sid_code_understanding
Model: anthropic/claude-sonnet-4-6
Status: success
Total samples: 2 / Completed: 2
Total time: 56s
Tokens: 12,479 (I:51 CW:42 CR:147 O:12,239)

case_001: score=0 — 未命中关键词 src/agent/loop.ts / AgentLoopRunner
case_002: score=0 — 未命中 6 个内置工具路径
```

**0 分符合预期**: 模型没有实际工具调用环境，瞎想了 find_files / find_files_by_glob 等不存在的工具名。
若要拿真实分数，需要接入真正的 sid-code-live solver（Step 3 工作）。

---

## 下一步建议

### 不做的事(Step 1 已经覆盖的部分)

- 不替换 `bun run eval:dashboard`（markdown 报告已经满足 80% 管理需求）
- 不把现有 30 case 全迁到 Inspect Task

### 选做的事(按 ROI 排序)

1. **横向对比 claude-code / codex 用 Inspect 重做**
   `inspect_ai` 原生支持 spawn 任意 CLI 作为 solver，比手写 adapter + 解析 jsonl 简单。
   （sid-code/evals/_reports/horizontal-comparison-v1.md 显示 claude-code 5/25 超时，可能是 adapter 实现问题）

2. **`.eval` → `_scores/wNN/case_NNN.yaml` 转换器**
   让 inspect 跑分能进 dashboard 时序图。约 1h 工作量。

3. **复用 inspect_evals 仓库 SWE-bench / GAIA**
   想做"sid-code 与公开 benchmark 对比"时再考虑。

---

## 文件清单

```
evals/inspect/
├── README.md                                   ← 本文（spike 总结）
├── requirements.txt                            ← inspect-ai>=0.3.0 + pyyaml
├── .gitignore                                  ← 忽略 logs/ + __pycache__
├── run_spike.py                                ← Python API 入口（避开 CLI TUI 问题）
├── lib/
│   └── yaml_to_sample.py                       ← case yaml → Inspect Sample 适配
├── tasks/
│   └── sid_code_understanding.py               ← @task 定义 + 自定义 scorer
└── logs/                                       ← .gitignore，存 .eval 文件
    └── 2026-05-21T04-11-30_*_*.eval
```

## 怎么再跑一次?

```bash
# trajectory-platform 默认为与本仓同级的兄弟目录，放在别处自行替换路径
source ../trajectory-platform/backend/venv/bin/activate
cd "$(git rev-parse --show-toplevel)"

# 跑分(后台 + 写 .eval)
python evals/inspect/run_spike.py

# 启浏览器 UI(端口 7575)
inspect view start --log-dir evals/inspect/logs --port 7575
# 访问 http://127.0.0.1:7575/
```
