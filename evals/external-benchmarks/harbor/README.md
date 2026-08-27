# Harbor 评测底座接入

在 [Harbor](https://github.com/laude-institute/harbor) 的任务容器里跑 sid-code，
从而用**同一个底座**跑几十个 benchmark，并与 Harbor 内置的 33 个 agent
（claude-code / codex / mini-swe-agent / aider …）做**同题、同模型、同容器、同 verifier**的对照。

> **状态：已建成，未验证有用。**
> 真正的验收判据不是「agent 能跑通」，而是**「至少有一次真实的 harness 优化决策，
> 是由 Harbor 上的对照数据驱动的」**（见文末「验收清单」的 A11）。
> 在那之前请如实这样描述它 —— 本仓有过「防线全在、调用全 0」的先例。

---

## 它服务哪条北极星

`CLAUDE.md` 对**「更准」**的定义是「**同一个模型**，在 sid-code 里返工更少、一次做对的比例更高」，
并明确「准确的主语是 harness，不是模型」。这个定义要成立就需要**控制模型、只换 harness**
的对照实验 —— 而换 scaffold 的分数摆动（15–25pp）远大于换模型（2–15pp），
所以这是唯一可归因的实验形态。手工搭对照要自己守住五个必控变量；
在 Harbor 里容器 / verifier / 超时 / 提示模板天然同源，**变量控制从「靠纪律」变成「靠底座」**。

**它牺牲了什么**（自检第 3 问，必须点破）：**数据主权的一部分**。
评测题目与容器镜像从官方 registry / 公网拉。轨迹仍然全部落在我们自己的挂载目录里，
但「题目来源在外部」是事实。换来的是「几十个 benchmark + 33 个对照 agent」。

⚠️ **它不替代 `../swe-bench/` 那条自建链路**，两者职责不同：

| | 自建链路 | Harbor |
| --- | --- | --- |
| 定位 | **深度**（能取任意内部字段） | **广度 + 可比性**（有对照 agent） |
| 回答 | 「sid-code 自己哪一层在拖后腿」 | 「sid-code 相对别家 harness 是什么水平」 |

> ⛔ **两条链路的分数永不互比。** 子集不同、提示模板不同、超时不同、判分实现不同 ——
> 跨底座比分数是纯噪声。两条各出自己的曲线，不做加权、不做平均、不做「哪个更准」的裁决。

---

## 环境准备（一次性）

```bash
# 1) Harbor 本体。⚠️ 必须带版本上界，理由见 pyproject.toml 里那段注释
uv tool install 'harbor>=0.22.0,<0.23'
harbor --version                      # 应显示 0.22.x

# 2) 关遥测。Harbor 的遥测**默认是开的**（发往 PostHog），必须显式关
export HARBOR_TELEMETRY=0

# 3) 让 harbor 能 import 到我们的 agent
export PYTHONPATH="$(git rev-parse --show-toplevel)/evals/external-benchmarks/harbor"

# 4) 编一个当前 commit 的 linux 二进制（binary 安装模式的输入）
#    arm64 容器用 bun-linux-arm64；x64 容器用 bun-linux-x64-baseline
scripts/build-branch-artifact.sh --target bun-linux-arm64
```

**数据主权：遥测与上传的实际情况**（已回源码核对，不是照抄文档）：

| 项 | 事实 |
| --- | --- |
| 遥测开关 | `HARBOR_TELEMETRY` ∈ `{0,false,no,off,disabled}` → 三个 capture 函数全部早退 |
| 遥测默认 | **默认开**（PostHog `us.i.posthog.com`）→ **必须显式关**，所以它出现在下面每条命令的前缀里 |
| Hub 上传 | **严格 opt-in**：`--upload` 默认 off，且 `--public` / `--share-org` / `--share-user` / `--org` 缺 `--upload` 时一律**硬报错退出**，不会「顺便也上传了」 |

> `HARBOR_TELEMETRY=0` 与长任务的 `caffeinate` 一律写进**命令本身**，不写进「注意事项」——
> 写在注意事项里没人看。

---

## 四步递进：每一步都有「过不了就停」的判据

**不要跳步。** 每一步排除的都是下一步的一个变量。

### 第 0 步：Harbor 自身可用（不涉及我们的代码）

```bash
HARBOR_TELEMETRY=0 harbor run -t hello-world/hello-world -a nop --jobs-dir runs
```

判据：trial 跑完、`runs/` 下有 `results.json`。
过不了 = Harbor / Docker 环境问题，与本接入无关，**先修环境**。
`nop` 是 Harbor 内置的空 agent，用它先排除「是我们的 agent 有问题」这个变量。

### 第 1 步：我们的 agent 能装上、能跑起来

```bash
HARBOR_TELEMETRY=0 harbor run -t hello-world/hello-world \
  -a sid_code_agent:SidCodeAgent \
  -m <provider>/<model> \
  --allow-agent-host host.docker.internal \
  --jobs-dir runs
```

判据**四条，缺一不可**：

1. `results.json` 里 `AgentInfo.version` 是**真实版本号**，不是 `"unknown"`（证明版本探测通了）；
2. `runs/.../agent/sid-code.jsonl` 里有 sid-code 的 NDJSON 输出；
3. `runs/.../agent/sid-code-build.json` 存在，且 `commit` 与本地 HEAD 一致、
   `commit_source` 是 `artifact-bytes`（不是 `host-head-fallback`）；
4. `cost_usd` **非 null 且非 0**。

> ⚠️ **第 4 条最容易假过**：cost 为 0 时 trial 照样成功、reward 照样有值。
> **必须显式看这个数** —— 「字段在、有值、但值是废的」是本仓反复踩过的形态。
> 先在本地确认一次源头：
> `sc-dev -p --output-format stream-json "say hi" | tail -3`，看 result 事件里
> `total_cost_usd` 真的非 0（schema 声明了 number ≠ 运行时非 0）。

### 第 2 步：真实 benchmark 的最小样本

```bash
HARBOR_TELEMETRY=0 harbor run -d terminal-bench-sample@2.0 \
  -a sid_code_agent:SidCodeAgent -m <provider>/<model> \
  -n 2 -k 1 --allow-agent-host host.docker.internal --jobs-dir runs
```

**为什么是 `terminal-bench-sample@2.0`（10 题）而不是 `terminal-bench@2.0`（89 题）**：
89 题一轮起步就是几小时。在还没验证过链路的阶段第一次就上 89 题，
等于把一个 5 分钟能发现的配置错误拖成半天。

判据：**至少有一题 reward > 0**。全 0 时**先怀疑链路，不要先怀疑 sid-code** ——
最危险的失效是 verifier 恒返 0，它把「链路坏了」伪装成「没解出来」，
而这两者**在数据上不可区分**。交叉验证见下面「R1 双向对照」。

### 第 3 步：对照实验（这才是接 Harbor 的真正目的）

```bash
for AGENT in sid_code_agent:SidCodeAgent claude-code mini-swe-agent; do
  HARBOR_TELEMETRY=0 caffeinate -dimsu harbor run \
    -d terminal-bench-sample@2.0 -a "$AGENT" \
    -m <同一个 provider/model> -k 1 \
    --job-name "cmp-$(echo "$AGENT" | tr ':' '-')" \
    --allow-agent-host host.docker.internal --jobs-dir runs
done
```

判据：三份 `results.json`，同题、同模型、同容器、同 verifier。
**这是「更准」那条曲线的第一个数据点。**

---

## 会「绿着坏掉」的六处：每条都不报错

这一节是这份 README 里**最该读的部分**。下面每条的共同形态是
**不报错、测试全绿、数字看起来正常，但结论是错的**。

### R1 🔴 verifier 恒返 0 / 恒返 1

**必须做双向对照**，单向拦不住：

```bash
HARBOR_TELEMETRY=0 harbor run -t <task> -a oracle --jobs-dir runs   # 应该拿满分
HARBOR_TELEMETRY=0 harbor run -t <task> -a nop    --jobs-dir runs   # 应该拿 0 分
```

- **oracle 也 0 分** → verifier / 环境坏了，与 sid-code 无关。
- **nop 拿到分** → 任务初态就是通的，那么**所有 agent 都会「满分」**。oracle 对照防不住这个。
- 还要看 `runs/.../verifier/test-stdout.txt`：有没有测试真的跑起来。

> ⚠️ oracle 的构造需要 `task_dir` / `trial_paths` 两个由 Harbor factory 注入的参数，
> **只能通过 `-a oracle` 走 factory 调用**，不能当普通自定义 agent 用。
> 知道这点是为了别在它报参数错误时以为是自己配错了。

### R2 🔴 双层超时互相掩蔽：修了一层只是换了个杀手

sid-code 的 `--max-turns` 与 Harbor 的 agent 阶段超时（task.toml 的 `timeout_sec`，
可用 `--agent-timeout-multiplier` 放大）**同时存在**，而 Harbor 侧的杀是**外部 kill**，
sid-code 内部看不到。

**判据**：`metadata.sid_subtype` 缺失 **且** `sid_cost_source == "missing"`
→ 判定为「被外部 kill」。它与 `--max-turns` 耗尽（`sid_subtype == "error_max_turns"`）
是**两类不同的样本，不能混算**。

⚠️ **别急着放宽 Harbor 超时**：被截断的分布不能论证自己的上限。
要放宽必须**同批抬 `--max-turns`**，否则只是把杀手从 Harbor 换成 sid-code 自己。

### R3 🟠 宿主休眠污染耗时

一次 89 题的 job 是小时级，宿主一定会尝试休眠 —— 实测有过 717s 休眠让耗时超上限、
而超时闸门显示「未触发」的样本。
**对策**：长时评测一律 `caffeinate -dimsu harbor run ...`（已写进第 3 步的命令里）。

### R4 🟠 `-k > 1` 时并发与预算的乘法

`-k 3` × `-n 4` = 同时 12 个容器 + 12 路 LLM 调用打向同一个网关 → 限流 → 重试 →
**成本翻倍而分数不变**。

**判据**：`results.json` 的 `exception_stats` 里 `ApiRateLimitError` 计数 **> 0**
→ **这一轮的成本数字已被污染，不能进曲线。**
**首轮一律 `-k 1` 探路**，确认链路稳定后才上 `-k 3`（`-k 1` 出不了 pass@k，
`-k 3` 是能算 pass@1 与 pass@3 的最小值）。
另一道闸在 agent 侧：`--ak max_budget_usd=<N>`，超限以 `subtype: error_max_budget_usd` 干净终止。

### R5 🟠 提示模板不一致 → 跨 agent 对照静默失效

`--prompt-template-path` 是**按 agent 传的**。给 sid-code 传了我们自己的模板、
给 claude-code 用默认模板，则**对照实验的第一必控变量就破了**，而两边都跑得很成功。

**对策：对照实验一律不传模板**，全部用 Harbor 默认。
这也是本目录**刻意不放 `prompt-template.j2`** 的原因 —— `../swe-bench/prompt-v1.txt`
是为 SWE-bench 调的，拿到 Terminal-Bench 未必合适，而**一致性比「我们的模板更好」更重要**。
放一个没人该用的文件 = 引诱下一个人破掉这条。

### R6 🟡 Harbor 升级导致的静默漂移

已实测的漂移（v0.16.1 → v0.22.0）：`--agent-import-path` 被 deprecate 且 hidden、
`allow_internet` 字段整个消失、`registry.json` 从 task 级变 dataset 级。

**形态**：`uv tool upgrade` 顺手升级 → agent 挂在**半夜的评测里**，
报错还是「no such option」，完全不指向「你需要适配新版本」。
**对策**：`pyproject.toml` 已 pin `>=0.22.0,<0.23`。
**升级 Harbor 是一次独立改动**，升完必须重跑上面的第 1 步冒烟。

---

## 门禁边界：这份 Python 代码被覆盖到什么程度（不要高估）

仓库的五道门禁（`bun test` / `make build` / `bun run lint` / `format:check` /
`lint:boundary`）**一道都不认 `.py`**。补上的是 `tests/eval/harbor-agent-contract.test.ts`，
它分两层，**必须知道哪层在 CI 上真的生效**：

| 层 | 依赖 | CI 上 | 拦什么 |
| --- | --- | --- | --- |
| **L1 静态** | 只要 `python3`（stdlib `ast` 解析，**不 import**） | ✅ **真的在跑** | 语法坏了 / 四成员缺失 / **装饰器顺序反了** / 输出格式被改回 `json` / `MODEL_CONNECTION` 被加回 / `dangerously-skip-permissions` 出现 |
| **L2 导入** | 要装 `harbor` | ⚠️ **skip** | 真 `import` + `issubclass` + `capabilities` 全 False |

拆两层的理由：只做 L2 的话，CI 上**永远 skip** → 门禁形同不存在，而 PR 页面一片绿。
L1 拦得住的恰好是那批**不报错的**失效形态。

⚠️ **它替代不了真实运行验证。** L1 只拦「语法坏了 / 签名漂移 / 关键开关被改」，
上面那四步冒烟才是真验收。

---

## 已知的开放问题（推理出来的，**尚未实测**）

### A1：`no-network` 任务能否被 `--allow-agent-host` 放通

`--allow-agent-host` 的语义是「merged into the agent phase **allowlist**」，
而 `no-network` 与 `allowlist` 是**互斥的两个模式**（allowed_hosts 只在 allowlist 模式下允许非空）。
所以很可能 merge 不进去。**这条必须实测，不能推理。**

若确认不通：**该类任务从 dataset 排除，且排除的数量必须显式 log 出来。**
静默跳过 = 分母悄悄变小 = 分数虚高。（同时这说明 `no-network` 任务对**任何**
需要外部 LLM API 的 agent 都不可跑，不只是我们。）

### 网关侧还剩一个风险：挡住了 key 泄露，没挡住被薅额度

本设计把真实凭据留在宿主网关（容器里的 `settings.json` 只有占位 token），
所以 **key 不会进容器**。但容器里跑的是 benchmark 的任意代码，**它能访问这个网关**。
→ 网关侧需要 per-trial 预算上限与限流。这条必须说破，不能因为「key 安全了」就以为风险清零。

### Linux 宿主上 `host.docker.internal` 不存在

它是 Docker Desktop 的特性。Linux / CI 上要显式覆盖：

```bash
export SID_HARBOR_GATEWAY_URL=http://172.17.0.1:4000
HARBOR_TELEMETRY=0 harbor run ... --allow-agent-host 172.17.0.1
```

不改的形态是容器里连不上网关 → 认证失败，而报错指向模型而不是指向这一行。

---

## 环境变量清单

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HARBOR_TELEMETRY` | *（Harbor 侧默认开）* | 设 `0` 关闭 Harbor 遥测。**每条命令都要带** |
| `SID_HARBOR_GATEWAY_URL` | `http://host.docker.internal:4000` | 容器内 `baseURL` 指向的宿主网关 |
| `SID_HARBOR_BINARY_ARM64` / `_X64` | 空 | 显式点名要上传的 linux 二进制。**不设则按当前 HEAD 自动发现** |
| `SID_HARBOR_MODEL_ALIAS` | `harbor-gateway` | 容器内渠道别名（`availableModels[].name` 与顶层 `model`） |
| `SID_HARBOR_PROVIDER` | 从 `-m provider/model` 推 | 覆盖 provider（闭集：`anthropic`/`openai`/`ollama`/`replay`） |
| `SID_HARBOR_MAX_TURNS` | 40 | 等价 `--ak max_turns=` |
| `SID_HARBOR_MAX_BUDGET_USD` | 空 | 等价 `--ak max_budget_usd=`，per-trial 成本上限 |

**二进制来源是三级优先级，且第三级报错而不回落**：
① `SID_HARBOR_BINARY_*` 显式点名 → ② `dist/branch-builds/*-<当前 commit12>/sid-code`
自动发现 → ③ **报错并打印构建命令**。
不静默回落是刻意的：回落会让人以为跑的是他点名的那个包，
而**一次评测跑出的分数说不出「这是哪个 commit」就没有意义**。

---

## 磁盘与产物

- `runs/` 是 Harbor 的 jobs_dir（含容器日志），**已 gitignore**。它是产物不是资产。
- `--delete`（**默认就是删**）删的是**容器不是镜像** —— 镜像仍然累积。
  别为了「留着看看」改成 `--no-delete` 然后忘记，那会在几十个 trial 后填满磁盘。
- 跑完第 2 步后量一次 `docker system df`。**若 10 题只占几 GB 就不用扩容** ——
  SWE-bench 镜像大（每题一套预装 conda testbed）是它的特殊性，
  Terminal-Bench 的体积分布完全不同。**不要为一个还没测量的问题付成本。**
- 深度指标（TTFT / 缓存命中 / retry 白烧 / compaction）**不在 Harbor 侧算**。
  `metadata.sid_session_id` 是接缝：拿它回 sid-code 自己的轨迹里取，
  走既有的 `scripts/trace-digest.ts`。在这里重算等于造第二个事实源。

---

## 验收清单

| # | 项 | 判据 | 状态 |
| --- | --- | --- | --- |
| A0 | 遥测与 Hub 上传已确认关闭 | 见上「数据主权」表 | ✅ 已回源码核对 |
| A1 | `no-network` × `--allow-agent-host` | 实跑一个 `no-network` 任务 | ⬜ **待实测** |
| A2 | `provider/model` ↔ 渠道别名映射正确 | 看轨迹里**实际发出的 wire model**（不是看命令行参数 —— 配错 base_url 会 404 静默 fallback） | ⬜ 待实测 |
| A3 | 装饰器顺序正确 | L1 门禁已机械化 | ✅ |
| A6 | `.py` 有门禁且经变异自证 | L1 + 三条变异自证 | ✅ |
| A7 | `cost_usd` 非 0 且非 null | 第 1 步判据 4 | ⬜ 待实测 |
| A8 | build.json 的 commit 与 HEAD 一致 | 第 1 步判据 3 | ⬜ 待实测 |
| A9 | oracle 满分 / nop 零分 | R1 双向对照 | ⬜ 待实测 |
| A10 | 三 agent 对照产出三份 results.json | 第 3 步 | ⬜ 待实测 |
| **A11** | **Harbor 数据驱动了一次真实的 harness 决策** | 一份 Agent Note：「因为看到 X 数据，所以改了 Y」 | ⬜ **唯一的最终判据** |

A1–A10 需要 Docker + 装好 harbor + 网关就位，**不在接入 PR 内打勾**。
A11 无法在短期内打勾，但它是这个接入唯一的最终判据 ——
在它之前，状态如实是「已建成，未验证有用」。

---

## 设计决策的事实源

完整的「决定了什么 / 放弃了什么（以及为什么不选）/ 拿什么证明它生效了」在
`.agents/notes/proposed/testing/2026-08-27-harbor-接入设计.md`。

**改这份接入之前先读那份 Note 的第二段** —— 那里记了八件被否决的事及其理由
（source/local/published 安装模式、`MODEL_CONNECTION` 注入、`--output-format json`、
pytest、prompt 模板、在 Harbor 侧重算指标、迁移 `grade.ts`、首版 resume/handoff/ATIF）。
否决论证不落盘的代价是：下一个人明天重新提议同一件事，而你要把整套论证重做一遍。
