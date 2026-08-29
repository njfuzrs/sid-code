---
paths: ["evals/**", "tests/eval/**"]
---

# evals/ — 跑评测前必读：**尺子比结论重要**

本文件约束 `evals/` 下**所有**评测链路：`external-benchmarks/`（swe-bench 自建 / harbor）、
`bench-runner/`、`providers/`、`capability/`、`real-tasks/`，以及 `tests/eval/` 下的配套门禁。

## 0. 为什么会有这份文件（先读这段，它决定你怎么用下面的清单）

**同一个错误在这个目录下犯过三次，跨了两个子目录，每次都"有理有据"。**

| 时间 | 位置 | 形态 |
| --- | --- | --- |
| 2026-08-25 | `external-benchmarks/swe-bench/` | `acceptEdits` 下 113 次权限拒绝，三条实例过半轮次被拒绝烧掉 → **已修**（换 `--dangerously-skip-permissions`） |
| 2026-08-29 | `external-benchmarks/harbor/` | 同一档、同一形态，144 次拒绝，**而它引用的正是上面那个 113 的实测** → 结论却相反 |
| 至今未修 | `providers/` `bench-runner/adapters/` | 对照 agent 默认 `skipPermissions=true`，我们这侧连这个选项都没有 |

第二次那个尤其值得记住：**两边读的是同一份实测数据，得出了相反结论**。
swe-bench 说「113 次证明这档不能用」，harbor 说「113 次证明这档能观察到防线」。
后者把一个**已被判定为"污染能力账"的配置**，重新解释成了一个**特性** ——
并且配了一道门禁把正确做法钉死，**门禁的注释理由读起来完全正当**。

> **所以这份文件的第一层不是坑的清单，是判读纪律（§1）。**
> 坑可以逐条修，判读方式错了会源源不断造出新的坑。

⚠️ **本文件的每条规则都带 `file:line` 出处**。这不是形式：
半年后你要能核验它是否已漂移。**出处失效的规则要么更新出处，要么删掉，不要留着**。

---

## 1. 判读纪律（元规则 —— 违反这些，下面的清单救不了你）

### 1.1 先证明尺子是准的，再用它量东西

评测的第一次结果**永远先怀疑仪器，不是被测对象**。
前七棒 Harbor 接入的真实顺序就是这样：跑出 0.100 → 没去调 agent → 先查仪器 →
挖出「轮数预算被网络故障偷走 / 两层重试预算相乘 / 超时样本成本报 null /
拒绝成因不告诉模型」四个缺陷。**分数低本身不是信息，"为什么这个分数可信"才是。**

### 1.2 同一个数字出现在两处时，核的是**两边的结论是否一致**，不是数字是否一致

这次两边数字完全一致（113），**错的是解释**。
所以判据是：**搜一下这个数字/这个实测还被谁引用了，逐个核结论方向。**

```bash
# 例：某个实测结论被哪些地方引用
grep -rn '113 次' evals/ --include='*.sh' --include='*.py' --include='*.ts' --include='*.md'
```

### 1.3 一道门禁的注释理由正当 ≠ 它守的判据正确

`tests/eval/harbor-agent-contract.test.ts` 曾断言源码里不许出现
`dangerously-skip-permissions`，理由写的是「它会关掉我们想测的那层防线」——
**这句话本身没错，但它守错了对象**：那一档是唯一能让 agent 正常工作的档。

> **判据错了的门禁，和不存在的门禁一样有害** —— 后者只是没保护，前者会**主动阻止修复**。
> 修法是**改判据，不是拆门**。

✅ **已修（2026-08-30，第八棒）**：判据整个换掉了，**门没拆**。现在锁的是四件事 ——
skip 必须是 bool `CliFlag` / `permission_mode` 的 choices 不含 skip 名与
`bypassPermissions` / 两档互斥校验存在 / 权限档观测值落 metadata。
出处：`tests/eval/harbor-agent-contract.test.ts:259`（`权限档是显式的、可观测的`）。

### 1.4 「代码在」≠「生效」——判据是**生产调用点**，不是「有没有实现」

本仓这一类的三种断点，**三者都不报错**：

| # | 断点 | 实例 |
| --- | --- | --- |
| ① | 函数调用点少传参 | S3 时间预算钳制实现了、有测试、**主循环调的是不带该参的三参版本**，生产路径一次没跑过 |
| ② | 跨语言/跨进程边界丢键 | TS 侧加了 `num_turns_without_model_interaction`（发送方+schema+测试齐全），Python 侧**一句不读** → `result.json` 里查不到 |
| ③ | 跨编译边界用旧字节 | TS 改完没重编二进制，容器里跑的还是上一版 |

**查法**：
```bash
# ① 看调用点传了几个参数，不是看函数签名
# ② 看消费侧真的读了这个键（跨语言时尤其）
# ③ 跑完第一件事核 commit，见 §3.1
```

### 1.5 分母比分子重要；一律看 p95/p99

「命中率」「成功率」「拒绝率」的**分母口径一变，曲线整体平移**。
分母必须和指标写在一起。均值会骗人，慢尾巴才是用户流失点。

### 1.6 区分 stock 与 flow：末次快照 ÷ 累加值 = 错数

⛔ `n_input_tokens` **绝不能取 `total_tokens_sent`** —— 那是**末次快照值**，
除以累加的 `total_cost_usd` 得到的是错数。要用累积字段
`total_cumulative_prompt_tokens`（`external-benchmarks/harbor/sid_code_agent.py:862-917`）。

### 1.7 每个数字必须能指到源字段

说不出取数源的数字就是自我感觉。**报结论时同时报 `file:line` 或字段路径。**

### 1.8 主动记录自己的判读错误

本仓最可信的几条结论都带着「我先判错了，后来纠正」。
**只报成功的记录不可信** —— 因为「目标指标改善 + 测试全绿 + 机理讲得通」
三者同时成立时，结论仍然可能是错的。

---

## 2. 🔴 跨链路对齐清单（防的就是 §0 那次）

**规则：下面每一项，任何两条评测链路上不一致就是 bug —— 除非在代码里写明理由。**
「写明理由」指注释里给出实测日期与判据，不是「我觉得这样更好」。

### 2.1 已确认不一致的三处（⛔ 现存缺陷，别照抄任何一边）

| 项 | swe-bench 自建 | harbor | providers/ 横评 |
| --- | --- | --- | --- |
| **权限档** | `--dangerously-skip-permissions` 布尔 flag（`exec-swebench.sh:150`） | ✅ **已对齐**（2026-08-30）：`--dangerously-skip-permissions` 布尔 flag（`sid_code_agent.py:170`） | ⛔ **不对称**：claude-code 默认 `skipPermissions=true`（`providers/claude-code.ts:27`），sid-code-live **无此选项**，不传即 `default` 档（`providers/sid-code-live.ts:30`） |
| **超时** | 1800s（`exec-swebench.sh:100`） | Harbor agent 硬顶 1 小时 | ⛔ **不对称且无注释理由**：sid-code-live 480s（`providers/sid-code-live.ts:28`）vs claude-code 360s（`providers/claude-code.ts:25`） |
| **max_turns** | 40（`exec-swebench.sh:99`） | 40（`sid_code_agent.py:177`） | 不传则不限 |

⚠️ **权限档那条的后果最重**：headless 下 `default` 与 `acceptEdits` 都会把普通 bash
拒掉（实测 `nproc` / `pytest -q` / `git log` / `ls` 四条全 DENY），
于是**「被拒绝烧掉的轮次」被记成「能力不足」**。

✅ **换档后实测（2026-08-30，Harbor 同 10 题）**：`144 deny → 0 deny`（逐题全 0），
配对可比的 6 题 **0.167 → 0.667**（↑3 题 / ↓0 题，n=6）。
⚠️ 引用这个数**必须带 n**，且**不要写成「0.100 → 0.750」** —— 那两个均值的
题目集不是同一批题（本轮 4 题被基础设施故障排除，而它们在基线分母里且全是 0.0）。
判据与自证：`external-benchmarks/harbor/compare-paired.py`。

### 2.2 跨 agent 对照必须核的单变量清单

声称「同题、同模型、同容器，只换 agent」之前，逐条核完这张表：

| # | 项 | 怎么核 |
| --- | --- | --- |
| 1 | 同题 | 同一 run 目录、同一 task id |
| 2 | 同模型 | 双方 metadata 里的 model 字段 |
| 3 | 同容器/镜像 | 同一 registry + 同一 image digest |
| 4 | **双方的权限/确认层** ⚠️ | **这一条以前不在清单里，2026-08-29 才补** |
| 5 | 同提示模板 | 见 §2.3 |
| 6 | 同超时与轮数上限 | 两边都要核，不是只核自己那边 |
| 7 | 同 run（别混两次） | `polyglot-c-py` 在 `a11-mswea` 与 `-r2` 各有一份，混用就是拿两个变量下单变量结论 |

**第 4 条怎么核**：
```bash
# mini-swe-agent 侧：mode=yolo 表示零权限层
jq -r '.info.config.agent | {mode, whitelist_actions, confirm_exit}' \
  <run>/<task>/agent/mini-swe-agent.trajectory.json

# sid-code 侧：数被拒次数（这个文件前六棒没人读过）
grep -c '"decision":"deny"' <run>/<task>/agent/sid-home/logs/permissions-audit.log
```

实测代价：A11 那次「只换 agent」的对照里，我们 144 次被拒、mswea `mode: yolo` **零拒绝** ——
**`0.100 vs 0.714` 测的不是能力差，是「戴手铐的」vs「不戴手铐的」。**

### 2.3 提示模板不一致 → 跨 agent 对照失效

Harbor 侧 `instruction` 透传，模板顺序反了**不会报错，只是模板静默失效**
（`external-benchmarks/harbor/sid_code_agent.py:575`）。
swe-bench 侧用 `prompt-v1.txt`。**跨链路比较前先 diff 这两份提示。**

---

## 3. 🔴 静默失效目录（按「错了代价多大」排序）

**判据：这一节全部是「不报错、日志干净、结果是错的」那一类。**
报错的 bug 会自己找上你；这些不会 —— 它们会**给出一个看起来正常的错误结论**。

### 3.1 ⛔ 跑的不是你以为的那份二进制（跨编译边界）

**规则**：改完 TS **必须重编两架构 linux 二进制**，跑完**第一件事核 commit**。

| | |
| --- | --- |
| **失效形态** | 容器里跑的是上一版字节，结果与修复前**逐字节一样**，而人会读成「修复没效果」 |
| **判据** | `jq -r '.agent_result.metadata \| [.sid_commit, .sid_commit_source] \| @tsv' runs/<run>/*/result.json \| sort -u` —— 期望是**新** commit + `artifact-bytes` |
| **出处** | `external-benchmarks/harbor/sid_code_agent.py:526-530` |

⚠️ **这是「代码在≠生效」的第三种断点**（见 §1.4）。它比另两种更隐蔽：
测试全绿、二进制存在、`sid_commit` 字段也**有值** —— 只是那个值是旧的。

### 3.2 ⛔ 产物身份读不到时**照样吐完整 JSON**，字段填字面量 `"unknown"`

**规则**：判产物身份**按形态判**（40 位十六进制），不能只判真假。

| | |
| --- | --- |
| **失效形态** | `if not commit` 对 `"unknown"` 是 False → 退化路径**永不触发** → 写下 `commit="unknown"` 却自称 `commit_source="artifact-bytes"`。**这层保护恰好在最需要它时失效** |
| **判据** | 门禁断言 `identity.get(...)` 的每个实参都在脚本输出键集合里，且源码里有 `[0-9a-f]{40}` 形态判定 |
| **出处** | `sid_code_agent.py:519-530`；门禁 `tests/eval/harbor-agent-contract.test.ts` |

⚠️ 同型错误已发生两次（`artifact_commit` / `artifact_dirty` 键名错配）。
`artifact_dirty` 那格更隐蔽：**它本来就允许是 null**，「恒 null」看起来像正常缺省值。

### 3.3 ⛔ 上传了错架构的包，报错完全不指向架构

**规则**：判架构**只认产物字节的 ELF `e_machine`**，不认目录名、不认文件名。

| | |
| --- | --- |
| **失效形态** | `build-branch-artifact.sh` 输出目录名 `<branch-slug>-<commit12>` **不含架构**，同一 commit 编 arm64/x64 会互相覆盖。于是「按 commit 匹配」拿到的是「上次编的那个架构」→ 容器里 `exit 127: not found`，而 `build.json` 写着期望的架构 |
| **判据** | `_elf_arch()` 读 ELF：`x86-64 = 62 (0x3E)`、`AArch64 = 183 (0xB7)` |
| **出处** | `sid_code_agent.py:345-362` |

### 3.4 🔴 `-n`（并发）直接决定 verifier 坏掉比例，且**伪装成能力差**

**规则**：慢网络下**必须显式 `-n 1`**。Harbor 默认是 4。

| | |
| --- | --- |
| **失效形态** | verifier 装不上 uv 就坏掉，而坏掉的样本长得和「没解出来」**逐字节相同** → 直接污染分子 |
| **判据** | 四轮 `nop` 对照（nop 不解题，reward 必然全 0，唯一观测量就是 verifier 成没成）：`-n 1` 坏 **1/10**，`-n 3` 坏 **4/10**，`-n 3`+宿主代理 **6/10** |
| **指纹** | 失败散布在三个域名（`github.com` / `releases.astral.sh` / `archive.ubuntu.com`）+ 三种 curl 码（7/18/35）—— **多域名多错误码就是带宽争抢，不是某域名被墙** |
| **出处** | `external-benchmarks/harbor/README.md:253-275` |

⚠️ **用 `nop` agent 排除能力变量**是这里的关键实验设计：它让「verifier 坏没坏」
成为唯一变量。**下次怀疑链路问题时先照这个做单变量对照。**

### 3.5 ⛔ 权限拒绝被记成能力不足（§0 那个，最贵的一条）

**规则**：headless 评测里，**跑前先数一遍被拒次数**。

| | |
| --- | --- |
| **失效形态** | `acceptEdits` / `default` 档下普通 bash 全被拒（`nproc` / `pytest -q` / `git log` / `ls` 实测四条全 DENY），而模型只收到「拒绝 — 非交互模式」这句**不含可行动信息**的话 → 它反复盲试 → 撞满 `--max-turns` → 被记成「能力不够/在绕圈」 |
| **判据** | `grep -c '"decision":"deny"' <run>/<task>/agent/sid-home/logs/permissions-audit.log` |
| **实测** | Harbor A11 10 题共 **144 次**被拒（7 个 `error_max_turns` 样本拒绝率中位数 **56%**）；swe-bench smoke-8 **113 次**，三条实例过半轮次被烧掉 |
| **出处** | `exec-swebench.sh:1255-1280`（已修）、`sid_code_agent.py:170`（**2026-08-30 已修**，第八棒） |

⚠️ **这个文件（`permissions-audit.log`）前六棒没人读过。**
它是唯一能把「能力不足」与「被防线拦住」分开的源。

### 3.6 ⛔ 成本报 null，而 null 在下游被当 0 求和

**规则**：`result` 事件缺失时**必须从 `session.traj` 兜底**，且**口径标记要与权威源区分开**。

| | |
| --- | --- |
| **失效形态** | trial 撞 Harbor 硬顶被 SIGKILL → 没机会打印终止事件 → `cost_usd: null`，而轨迹里明明有 3 次成功调用、75,732 prompt tokens、`total_cost_usd: 0.0538`。**这笔钱没进任何账，且不报错** |
| **放大** | 单题量级小（$7.18 → 真实 ≈$7.26，低报 1.1%），**但低报幅度与超时 trial 比例成正比** —— 跑 500 题时成本口径系统性偏低 |
| **判据** | `sid_cost_source` 必须区分 `session-traj-fallback` ≠ `stream-json-result`。混成同一个标签就等于宣称"补全了"，而它只是"比 null 准" |
| **出处** | `sid_code_agent.py`（`_recover_usage_from_traj`）；`collector.ts` 每轮 AfterModel 累加并节流重写 traj，**不依赖 SessionEnd 干净触发** |

### 3.7 ⛔ `is_error` 在错误路径**根本不发**，`None` 被当成"不是错误"

**规则**：判成败用 **`subtype`**，不是 `is_error`。

| | |
| --- | --- |
| **失效形态** | sid-code 只在**成功**路径发 `is_error: false`；`error_during_execution` 那条事件的键只有 `{duration_ms, errors, num_turns, session_id, subtype, total_cost_usd, type, usage}`。于是 `sid_is_error` 变成 `None` → 下游当"不是错误" → **一个失败的 trial 被记成正常的 0 分**，直接污染分母 |
| **判据** | `subtype` 在错误路径**一定有**（`error_during_execution` / `error_max_turns` / `error_max_budget_usd`）。`is_error` 有就用，没有从 subtype 推 |
| **出处** | `sid_code_agent.py:757`（判据），`:813`（`_derive_is_error` 定义） |

### 3.8 ⛔ 输出格式必须是 `stream-json`，不是 `json`

**规则**：`--output-format stream-json`。

| | |
| --- | --- |
| **失效形态** | 两者是**分叉的两条实现**：只有 stream-json 的 result 事件带 `total_cost_usd` / `num_turns` / `subtype`。用 `json` 则成本与轮数**全部拿不到**，而不报错 |
| **出处** | `sid_code_agent.py:590-594`、README 第 3 条；门禁锁死这一项 |

### 3.9 ⛔ 团队默认模板会补 `costLimit=100`，撞上就**静默结束整轮**

**规则**：显式设 `costLimit=0`（`quota.ts` 是 `costLimit <= 0` 直接 return null）。

| | |
| --- | --- |
| **失效形态** | 跑到一半静默结束，没有报错，读起来像「跑完了」 |
| **出处** | `exec-swebench.sh:103-104` |

### 3.10 ⛔ 双层超时互相掩蔽：修了一层只是换了个杀手

**规则**：改超时前先画出**所有**层，确认哪一层先到。

| | |
| --- | --- |
| **失效形态** | 抬高外层阈值，内层照样杀；两层同值时**分不清是谁杀的** |
| **纪律** | 「多层超时同值只换杀手」「抬阈值治不了」—— 真正该动的是**两层之间要不要交换"还剩多少时间"这个事实** |

### 3.11 🟠 宿主休眠污染耗时并给超时闸门续命

**规则**：长时评测前 `caffeinate -dimsu`。

| | |
| --- | --- |
| **失效形态** | 墙钟包含休眠时间 → 耗时指标虚高、超时闸门被"续命" |
| **出处** | Agent Note `2026-08-27-宿主休眠污染评测耗时并给超时闸门续命.md` |

### 3.12 🟡 `--registry-path` 不带则 ~7% 概率在第 0 秒死掉

**规则**：带 `--registry-path registry.local.json`。

| | |
| --- | --- |
| **失效形态** | 报错是 `Error getting dataset`，**长得像"数据集名字写错"**，实际是 registry 拉取失败 |

### 3.13 🟡 `agent` 全字段绿、实际一步没做

**规则**：`subtype: success` **不等于**做了事。同时核轮数与工具调用数。

| | |
| --- | --- |
| **失效形态** | 实测 `configure-git-webserver`：`subtype=success`、`num_turns=2`、字段全绿，**reward 0.0，一步没做**。这是 `error_max_turns` 之外**唯一不自报错**的失败类型 |
| **判据** | `sid_num_turns` 异常小 + reward 0 → 查轨迹是否真的执行过动作 |

---

## 4. 给评测链路写门禁：五条硬要求

### 4.1 仓库的五道门禁**一道都不认 `.py`**

`bun test` / `make build` / `bun run lint` / `format:check` / `lint:boundary` 全都不看 Python。
于是 `sid_code_agent.py` 的语法错误与签名漂移会**延迟到跑评测时才暴露** ——
而那时已经起了容器、拉了镜像、花了钱（`tests/eval/harbor-agent-contract.test.ts:5-9`）。

**所以 `.py` 的改动必须自带 TS 侧门禁**（用 stdlib `ast` 提事实、判断留在 TS 侧）。

### 4.2 ⛔ 「探测依赖失败就 skip」= 在 CI 上永远 skip = 门禁不存在

真实踩过两次：

| # | 形态 |
| --- | --- |
| ① | 探 `python3 -c "import harbor"`，而 README 教的装法是 `uv tool install`（装进**隔离环境**，系统 python 看不到）→ **本机装了 harbor 也照样 skip**，而它本可以拦住那次真实失败 |
| ② | 修一个「永远 skip」的门禁时，只改了「谁来跑」，**没改「怎么判断能不能跑」** |

> **一个 skip 条件写错的门禁，和一个不存在的门禁，在 CI 上是同一个东西。**

**做法**：分两层 —— L1 只依赖 stdlib（CI 上**真的在跑**），L2 才依赖外部包（可以 skip，
但要在文档里写明这条边界）。**L1 是主力，它拦的恰好是那批不报错的失效形态。**

### 4.3 新增门禁**必做变异自证**，判据是「红的是哪一条」

只断言 happy path 的测试**无法区分「逻辑对」与「checker 恒返 ok」**。

**每条断言配一条反向用例**：把被测条件人为改坏（**在 tmpdir fixture 上，不动真源文件**；
必须动真文件时改完 `shasum -a 256 -c` 核复原），**判定必须翻转**。

⚠️ 判据是**红的是哪一条**，不是「有东西红了」——后者分不清「命中了判据」与「别处坏了」。

**四类必须覆盖的变异**（2026-08-29 实做的一组，可照抄形态）：

| 变异 | 防的是 |
| --- | --- |
| 删掉被测的那一行 | 门禁真的在看这一行 |
| **加一个"下一个"同类项** | **门禁拦的是形态，不只是这一个已知项** ← 最容易漏 |
| 把提取逻辑改坏致抠出空集 | 门禁**绿着失效**（空集上跑 `toContain` 会红，但**红的原因指错地方**） |
| 语法整体坏掉 | checker 自己**非 0 退出**，不是静默返回空事实 |

### 4.4 判据写错的门禁 = 不存在的门禁（还更糟）

实测两次：

- 按裸字符串断 `not.toContain("total_tokens_sent")` → **把源码里那条"不要用它"的警告注释自己判成了违规**。改成按取数形态断（`_num("…")`）。
- 断 `dangerously-skip-permissions` 不许出现 → **守错了对象**（见 §1.3）。

⚠️ **删掉注释来让门禁变绿是最坏的做法** —— 抹掉的是唯一的溯源线索。

### 4.5 白名单而非黑名单：新字段的默认命运是「必须被消费」

跨语言/跨进程边界上，用**白名单 + 显式豁免**：
schema 上每个字段都必须被下游消费，或进豁免名单并写明理由。
**只补一行不加通用断言，下一个新字段还会掉在同一条边界上。**

豁免名单也不许发霉：① 名单里却已被消费的键要清掉；② 名单里的键必须真的还在 schema 上。

---

## 5. 环境：跑之前的固定动作

```bash
caffeinate -dimsu                      # 🔴 长时评测必须（§3.11）
colima start swebench                  # ⚠️ 不是 colima start（profile 名）
curl http://127.0.0.1:4100/__stats     # 🔴 跑前先探上游掉流率
```

**Harbor 命令行的必带项**：

```bash
HARBOR_TELEMETRY=0 \
harbor run -a sid_code_agent:SidCodeAgent \
  -n 1 \
  --registry-path registry.local.json
```

- `-n 1` 🔴 §3.4，默认 4 会让 verifier 坏 4/10
- `--registry-path` 🟡 §3.12
- `HARBOR_TELEMETRY=0` ⚠️ **默认是开的**（发往 PostHog）；Hub 上传是严格 opt-in

**磁盘**：「把容器扩大」与「磁盘扩容」是两件不同的事。
扩容前先用 Harbor 自带的两个杠杆（比扩容更该先用）。

---

## 6. 提交评测相关改动前的自检三问

照本仓根 `CLAUDE.md` 的要求，每次改动都要能回答：

1. **目标指标改善了吗？**
   ⚠️ 只有单测证据时，**答案是"不知道"，不是"应该改善了"**。
   单测证明"接线通了"，**不证明"37 分钟变短了"**。
2. **数字能指到源字段吗？** 每个数字给出 `file:line` 或字段路径 + flow/stock 口径。
3. **放弃了什么？** 候选方案 + 否决理由。没有这一段，下一个人会重新提议同一件事。

⚠️ **三者同时成立时结论仍可能是错的**（§1.8）：
「目标指标改善 + 测试全绿 + 机理讲得通」——那 34 轮线索就是三条全满足，
而根因在完全不同的地方。

---

## 7. 出处索引

| 主题 | 出处 |
| --- | --- |
| 权限档三个坑（`bypassPermissions` 不合法 / `always-allow` 不够 / 必须布尔 flag） | `external-benchmarks/swe-bench/exec-swebench.sh:106-150` |
| 113 次拒绝实测与归因 | `exec-swebench.sh:1255-1280` |
| Harbor 侧权限档（✅ 2026-08-30 已修） | `external-benchmarks/harbor/sid_code_agent.py:170-240` |
| 产物身份 / ELF 架构 / `is_error` / stock-flow | `sid_code_agent.py:345`、`:526-530`、`:757`、`:862-917` |
| `-n` 与 verifier 坏掉率四轮对照 | `external-benchmarks/harbor/README.md:253-275` |
| L1/L2 双层门禁与变异自证 | `tests/eval/harbor-agent-contract.test.ts:1-46` |
| 横评 provider 不对称（⛔ 现存缺陷） | `providers/claude-code.ts:27`、`providers/sid-code-live.ts:28-30` |
| 完整棒次执行记录与交接 | `docs-research/.../Evaluation/02-Harbor接入方案设计.md` §11–§17 |
