---
Status: implemented
Date: 2026-08-28
---
# A10 首次跨 agent 对照：同题同模型下 sid-code 花了 19.7× 输入 token，75% 是静态前缀

## 决定了什么

跑完 Harbor 第 3 步（A10），拿到**第一份跨 agent 可比数据**，并据此把 A11
的候选线索从「`--max-turns 40` 偏紧」换成「**静态前缀占成本 75%**」。
没有改任何产品代码 —— 这一棒的交付物是数据与判据，不是 diff。

`hello-world`，同模型 `claude-sonnet-5`、同容器、同 verifier、
**两边都不传提示模板**（`config.json` 的 `prompt_template` 均为 null，R5 必控变量成立）：

| | reward | 总输入 tok | 输出 tok | cost | 轮数 | agent 墙钟 |
| --- | --- | --- | --- | --- | --- | --- |
| **sid-code** | 1.0 | **45,803** | 62 | **$0.0374** | 2 turns | **12.0s** |
| **mini-swe-agent** | 1.0 | **2,328** | 83 | **$0.0049** | 4 steps | 15.3s |

归因：`45,803 = fresh 1,005 + cache_write 11,212 + cache_read 33,586`，
其中 `cache_write` 那 11,212 tok 是**系统提示 + 23 个工具定义**（静态前缀），
按 sonnet 标准价复算占本次成本 **75%**，且它**比 mini-swe-agent 全程总输入还多 4.8 倍**。

**这条比上一棒的 `--max-turns` 线索更够格当 A11，因为它自带对照的两半**：
`--max-turns` 只有「sid-code 会打满」，这条同时有「别家花多少」。

三处落盘（本仓两处 + 仓外方案文档一节）：

1. **`evals/external-benchmarks/harbor/README.md`** —— 新增「A10 首次对照」一节
   （数据 + 两个必补开关 + verifier 随机坏掉的判据）；验收清单里
   A10 🟡、A14 ✅、A11 🟡，**新增 A15**；修正 `SID_HARBOR_GATEWAY_URL` 的 colima 取值。
2. **`~/.local/share/sid-harbor-gateway/gateway.py`** —— 重建网关 shim，
   **落点从 `/tmp` 换到 `~/.local/share/`**，仍不入库（理由见下）。
3. 仓外方案文档 `02-Harbor接入方案设计.md` 新增 §13（执行记录 + 交接给第四棒）。

**新增一条口径铁律（A15）**：`reward=0` 且 `sid_is_error=False` 的样本
**必须单独分桶、不许计入分母** —— 它是「判分未发生」，不是「没解出来」。

## 放弃了什么（以及为什么不选）

- **拿这个 19.7× 直接去砍工具定义 / 做按需加载工具**。否决：`hello-world` 是
  **trivial 题**（2 turns 解完），静态前缀占比会被短任务**系统性放大**。
  同样 11k 前缀摊到 41 turns 的 `regex-log` 上占比会低得多。
  现在就改 = **拿一道 hello-world 的数据改产品**。
  → 先把这个测量搬到真实 benchmark 上（方案 §13.5 有可直接跑的命令）。
  ⚠️ 代价要承认：**A11 因此仍是 🟡**，这一棒没能把它翻绿。

- **把 Cloudflare 502 的分类顺序当缺陷去修**。这一条是**推翻我自己中途结论**得来的，
  必须留下：那批 502 正文含 "overloaded"，而 `errors.ts` 里 `overloaded` 关键词
  排在 502 状态码判据**之前** → 被分类成 `overloaded`（529 语义，
  `MAX_529_CONSECUTIVE=3` 封顶）而不是 `server_error`（11 次预算）。
  实测确证分类结果如此（`bare Error(CF 502) -> overloaded`，
  而 `502 + "bad gateway"` -> `server_error`）。**我一度判定这是缺陷。**
  否决：`errors.ts:545` 的注释明确写着，对这条 Cloudflare 消息
  **`overloaded` 才是正确关键词**（2026-07-13 事故的教训正是别让 404 数字子串抢先命中它）。
  判 529 语义是**刻意的**，因为上游真的过载。
  > 形态：「读到反直觉的分类顺序」→「判定为缺陷」这条路很好走，
  > 正确做法是**先读那段注释**。

- **让 shim 继续放 `/tmp`**。否决：上一棒放 `/tmp`，第三棒接手时**实测已丢失** ——
  那个落点把一次性成本变成了**每一棒的永久成本**。改到 `~/.local/share/`。
  **但仍不入 sid-code 仓库**：它是宿主侧基础设施，入库会引诱人把一个
  开发期 shim 当生产网关用。

- **给 shim 加「token 看起来像真 key 就直接转发」的兜底**。否决（这条是设计支点）：
  加了它 shim 就**静默退化成透传代理**，而调用方拿到 200、测试全绿、没人会发现 ——
  §5.3「key 绝不进容器」当场作废。代码里那处有显式 ⛔ 注释。

- **为了凑够三个对照 agent 而改 claude-code 的安装路径**。否决：它的 `install()`
  **硬编码** `curl https://downloads.claude.ai/.../bootstrap.sh`，
  该域名在本机不可达（实测 75s 超时），npm 路径只在 Alpine 下走而
  `hello-world` 是 Debian。改它 = 改 Harbor 自身代码，
  **那会让「同底座」这个接入前提失效**，比少一个对照 agent 更糟。
  → 如实记成「A10 🟡 两个 agent」，并给第四棒指出**该换不走被墙域名的 agent**
  （aider / codex / opencode）而不是修这个。

- **把 4 次失败的 trial 算进任何分数**。否决：它们全是环境/网络
  （2 次 verifier 下载 uv 失败、1 次 setup 超时、1 次缺 env）。
  但**这些失败本身是要报出来的** —— 静默丢弃 = 分母悄悄变小。

- **在 Harbor 侧硬算 `cache_read / 静态前缀 ≈ 3.0` 这个比值的含义**。否决：
  它与 2 次 API 调用不成整数比，说明缓存读粒度比「轮」细 ——
  要回 sid-code 自己的 digest 核。在 Harbor 侧算就是**造第二个事实源**
  （记忆里同一个错误的第五次）。

## 拿什么证明它生效了

**A10 对照数据（两份 result.json，逐条可指到源字段）**：

```
runs/a10-smoke-sid-r3/hello-world__*/result.json
  verifier_result.rewards.reward = 1.0   （交叉锚点 verifier/reward.txt = 1，两源一致）
  agent_result.cost_usd          = 0.0373772
  agent_result.metadata.sid_num_turns=2 / sid_subtype=success / sid_is_error=False
  agent_result.metadata.sid_cost_source = stream-json-result
runs/a10-smoke-mswea-r3/hello-world__*/result.json
  verifier_result.rewards.reward = 1.0   （verifier/reward.txt = 1；2 passed in 0.00s）
  agent_result.cost_usd          = 0.0048976
  agent/trajectory.json final_metrics = {total_prompt_tokens: 2328,
                                         total_completion_tokens: 83,
                                         total_cost_usd: 0.0048976, total_steps: 4}
```

必控变量逐条核过（**不是「都不传所以应该一样」**）：两份 `agent_info.model_info`
均为 `{name: claude-sonnet-5, provider: anthropic}`；两份 `config.json` 的
`prompt_template` 均为 null；三个 timeout multiplier 两边同值。
墙钟取自各自 `agent_execution` 的 `started_at`/`finished_at` 差值。

**A14 回归 —— 以最有说服力的方式（真实坏样本，不是构造用例）**：
`runs/a10-smoke-sid-r2` 出现 `reward=0.0` 而 `sid_is_error=False`/`sid_subtype=success`。
查 `verifier/test-stdout.txt` 尾部：

```
failed to download https://github.com/astral-sh/uv/releases/download/0.9.7/...
/tests/test.sh: line 11: uvx: command not found
```

**sid-code 真的解对了（jsonl 里有 write 调用 + hello.txt + "Hello, world!"），
是 verifier 自己坏了。** 独立复现该网络故障率：容器内拉同一个 URL **3 次成功 1 次**。
→ 这就是 R1 的读取侧孪生形态，且只看 reward 时与「没解出来」逐字节相同。
A15 这条铁律是从这个真实样本里得出的，不是推理出来的。

**网关 shim 三条行为逐条实测**（curl 打出的状态码，不是「代码里写了」）：

```
占位 token + POST /v1/messages   → 200
真 key     + POST /v1/messages   → 401     （不做兜底）
无 token   + POST /v1/messages   → 401
GET  /api/pricing                → 403
POST /v1/admin                   → 403
GET  /__stats → {"200_/v1/messages":.., "401_bad_token":2, "403_..":.., "upstream_502":..}
```

**上游选择那个坑也是靠这个计数器定位的**（值得留）：`uniapi` 上游在**容器发起的
真实请求**上 `upstream_502` 涨到 6，而我在宿主侧用相同 payload / 相同
`max_tokens=128000` 复现 **全部 200**；换 `ppchat` 上游后一次跑通。
> 形态：**宿主侧复现全绿 ≠ 容器侧那条路健康。** 我第一次按「502 是瞬态」重跑，
> 第二次仍失败（3m08s → 8m44s）才转去查上游差异 ——
> 判据应该是网关计数器，不是「再试一次看看」。

**仓库门禁**（L2 层真的在跑，不是 skip）：

```
SID_HARBOR_PYTHON=~/.local/share/uv/tools/harbor/bin/python \
  bun test ./tests/eval/harbor-agent-contract.test.ts
  → 21 pass / 0 fail / 0 skip
```

**明确没有证明的**（不冒充已验证）：

- **A11 仍是 🟡** —— 19.7× 只在一道 trivial 题上量过。
- **A10 只有 2 个 agent**，claude-code 本机不可解 → 对照样本从 3 缩到 2，
  **结论强度确实下降**。
- **mini-swe-agent 的 per-step usage 全是 `{}`**，只有 `final_metrics` 有总数 →
  它的「轮数 ↔ token」关系拿不到；跨 agent 比 `输入tok/turns` 时分母口径不同
  （sid 的 `num_turns` vs mswea 的 `total_steps`），必须标明而不是直接除。
- **真 key 进了对照 agent 的容器**（Harbor `MODEL_CONNECTION` 既有行为，
  已与用户确认接受）。**那把 key 该轮换。**
