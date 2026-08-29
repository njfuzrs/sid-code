---
Status: implemented
Date: 2026-08-29
---
# Harbor A11：真实 benchmark 上 A11 被自己的数据否决，同批数据挖出三个 harness 缺陷

## 决定了什么

第五棒的第一优先是 `02-Harbor接入方案设计.md` §14.7 那件事：把 §13.1 的静态前缀测量
搬到真实 benchmark 上。**照做了**，`terminal-bench-sample@2.0` 全 10 题 × 2 个 agent
各跑完一个完整 run（sid-code 4h10m、mini-swe-agent 约 5h30m，`-n 1` 串行）。

落地全部在 `evals/external-benchmarks/harbor/`（**`packages/` 零改动**）：

1. **A11 结案：否决。** §14.7 定的判据是「静态前缀/总输入 在真实题上仍 >50% 则 A11 成立」，
   实测 10 题**中位数 2.4%**（41 轮那些题 0.9%–2.9%）。差 20 倍，不是差一点。
   → **「砍工具定义 / 按需加载工具」这个改动不做**：它的全部论证依据就是那个占比。

2. **纠正 §13.1 的静态前缀口径**（这是该线索被高估的直接原因）。13.1 用的是
   `cache_write_tokens` —— 那是**整个 session 的 cache 写入累加**，不是首调用的前缀。
   同一道 hello-world 连跑三次：**首调用总 prompt 恒 22,950**，而 `cache_creation`
   摆动 3,442 / 8,491 / 4,360（**2.5 倍**），因为 read/write 切分由服务端缓存热不热决定。
   → 口径钉死为**首调用总 prompt**（`input_tokens + cache_read + cache_creation`）。

3. **改写 §13.2 那条口径铁律**（详见「放弃了什么」第 1 条）。

4. **新增 `analyze-prefix.py`**：读 Harbor 产物 + trial 内 sid-code 轨迹，出那两个比值，
   机械执行分桶规则，运行时打印 `FIELD_SOURCES`（每个数字指到源字段）。
   刻意**不重算 sid-code 已有指标** —— digest 的输入是宿主 `~/.sid-code/`，
   而 trial 轨迹是 10 份互不相干的 session，重算会造第二个事实源。

5. **同题跨 agent 对照**：两边都判了分的 7 题上 **sid 赢 0、mswea 赢 5、2 题都 0**。
   混淆变量已拆开（mswea 不受 40 步限制，实测用到 127 步）：按它解出时用的步数分类，
   **4 题它在 40 步内就解出**（两题只用 10 步），只有 1 题超过 40 ——
   **上限只能解释 5 题里的 1 题**。

6. **三个带 file:line 判据的 harness 缺陷**（本棒**不修**，是第六棒的第一优先）：
   - 🔴 **被 watchdog 杀掉的轮次吃掉轮数预算**。7/7 个 `error_max_turns` 样本满足
     `num_turns + WatchdogKill = 41`。两个计数器各数各的：
     `query/loop.ts:751-752` 在**发请求前**就 `state.turnCount++`，
     而 `sdk/query-engine.ts:120-123` 只在 `assistant_message` 时 `++`。
     被杀轮次**占预算但在 `num_turns` 里隐身** → `regex-log` 实际只有 34 次交互机会，
     却被报成「打满 40」。**「打满上限」与「上限够不够」之间插了一层网络故障。**
   - 🟠 **watchdog 与内层 retry 预算互相架空**。315s watchdog 在内层 retry 只用掉
     4–5/11 个 attempt 时就杀掉整个调用，外层 `TimeoutRetry` 从 attempt 1 重开 →
     11 次预算永远用不完，每周期固定烧 315s。7 周期 ≈ 37 分钟零产出。
   - 🟡 **超时 trial 报 `cost_usd: null` 而非已花部分**。轨迹里有 3 次成功调用、
     75,732 tok（≈$0.0807）没进任何账。本次低报 1.1%，**但幅度与超时比例成正比**，
     且 `null` 会被下游求和当成 0。兜底源 `AfterModelRaw.usage` 完好，可修。

7. **顺手关掉 O3**：cwd = `/app`（轨迹 `SessionStart.cwd` 直读，10/10 一致）。

## 放弃了什么（以及为什么不选）

1. **放弃了 §13.2 那条口径铁律的原判据**（「`reward=0` 且 `sid_is_error=False` → 排除」），
   尽管 §14.7 明确要求"机械执行"。**因为我机械执行了，然后它给出了错的答案。**
   它把 `configure-git-webserver` 排除掉了 —— 而那题的 verifier **跑得好好的**
   （`1 failed in 22.79s`），真实情况是 sid-code 只写了一篇「怎么配置」的说明文字、
   **一步没执行**，然后 `subtype=success` 收工。
   排除它 = 分母 9、mean 从 0.100 变 0.111，**白送一分，送的恰好是最该扣分的地方**。
   根因：`sid_is_error` 是 **agent 的自述**，拿它推断 **verifier 的状态**是跨主语推断。
   那个条件同时覆盖两件语义相反的事（判分未发生 / 判分发生了但 agent 报喜）。
   → 换成**正面证据**：verifier 输出有没有 pytest 收尾行 `\d+ (?:failed|passed|error)`。
     有 → 一律计分；没有 → 排除。14.2 的 `command not found` 判据保留但加
     `and not verifier_ran` 前提（那些关键词可能只是某个测试里的噪声）。

2. **不改任何产品代码。** 三个缺陷都只落成文档判据。理由与前几棒一致（评测棒不改代码，
   避免"拿一批数据顺手改产品"），**但要点破债在累积**：第四、第五棒连着两棒
   `packages/` 零改动。**如果第六棒还不动代码，这套接入就开始像"防线全在、调用全 0"了。**

3. **不动 `--max-turns 40`。** 尽管 7/10 撞上限，看着像"把它调大就行"。
   不动的理由是缺陷①：**被报出来的"打满 40"里混着被网络故障偷走的轮次**，
   在计数器口径修好之前，调大这个数是在一个失真的读数上做决策。
   而且 4 题上 mswea 在 40 步内就解出 —— **调大上限治不了"走的路比对照长得多"。**

4. **放弃用 `cache_creation` 当静态前缀**（见上）。它**不会报错**，
   只会让结论每跑一次摆动 2.5 倍。

5. **放弃在上游饱和期停跑**（事后看这是个错）。网关计数器 `upstream_error: 90`
   期间硬跑，约 1.5 小时墙钟白烧在 315s 空转上。已写成第 3 条环境约束交给下一棒，
   **但本棒自己没享受到它**。

## 拿什么证明它生效了

- **A11 的判据是 §14.7 自己定的**（>50%），实测中位数 2.4% ——
  复算命令：`python3 analyze-prefix.py runs/a11-sid`，输出含 `pfx% mean/median` 与逐题明细。
- **口径纠正有三次独立观测**：a10-smoke-sid / -r2 / -r3 三个 run 的首调用总 prompt
  **全部 22,950**，而 `cache_creation` 3,442 / 8,491 / 4,360。
- **缺陷① 有不变式**：`num_turns + WatchdogKill = 41`，**7/7 成立**，
  且两侧计数器位置回源码核对过（两个 file:line 均已在 README 记录）。
- **缺陷② 有逐周期表**：内层 attempt 最高值 4–5 / max 11、每周期 `elapsed_ms ≈ 315,500`、
  `chunk_count: 0`，取自轨迹 `RetryTelemetry` / `TimeoutFired`。
- **缺陷③ 可复算**：3 条 `AfterModelRaw.usage` 按 sonnet 标准价 = $0.0807，
  而 `result.json` 的 `cost_usd` 是 `null`。
- **分桶规则改写后的验证**：本次 10 题**全部**有 pytest 收尾行 → 10/10 计入。
  且旧规则会排除的那一题，我**逐条读了它的 verifier 输出与 agent 最终答复**才判定它该计分。

**必须承认弱的三处**（已写进文档 §15.9）：
① mswea 的 0.714 是 **7 题**均值、sid 的 0.100 是 **10 题**均值，**分母不等** ——
这组数能支持「同题上 sid 明显更弱」，**不能**支持那个比值本身；
② `turns` 跨 agent 口径不同（`sid_num_turns` vs `total_steps`），「10 步 vs 34 轮」
不是精确倍数（同量级判断不受影响）；
③ **单次运行、10 个样本**，且是在上游掉流 90 次的那一轮里 —— 方向可信，具体分数不该当精确值用。
