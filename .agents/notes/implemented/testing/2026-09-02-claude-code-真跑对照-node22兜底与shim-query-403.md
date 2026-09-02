---
Status: implemented
Date: 2026-09-02
Class: testing
---
# claude-code 真跑对照：清掉最后两个「不报错的错」—— node<22 装不出 `claude`、shim 把带 query 的端点判 403

## 决定了什么

第十二棒（7b）留下的落点是「可跑，未跑」。本棒把**剩下的全部前置清零**，
两处改动 + 一处环境开关，**实付 $0**（模型只调了 2 次占位 smoke，$0.04 量级）：

| 对象 | 改了什么 | 为什么非改不可 |
| --- | --- | --- |
| `harbor/claude_code_agent.py` | `install()` 加 **node ≥22 兜底**（官方 tarball，钉 `22.20.0`）+ 把 `claude` **软链进 `/usr/local/bin`** | 不补则 bullseye 那 2 题**必装不上**，且形态是 `rc=0` 假绿 |
| `~/.local/share/sid-harbor-gateway/gateway.py` | 白名单判据改用 `_route_key()`（**只取 path，丢 query**），200 计数键一并归一化 | 不补则 **cc 一次模型调用都成不了**，10 题全买回零样本 |
| `swebench` colima profile | `colima start swebench --vz-rosetta` | 第十二棒已论证；本棒实测执行并复核 **镜像 52 个逐行未丢** |

⇒ **①‴ 现在没有已知前置了。** 真跑那一步（会真花钱）留给下一棒。

### 两个缺陷都属于本仓「不报错的错」那一类

1. **node 12 装不出 `claude`，但退出码是 0**。上游 `@anthropic-ai/claude-code@2.1.252`
   声明 `engines: {"node": ">=22.0.0"}`；10 个镜像 **10/10 `node=NONE`**，node 全由 apt 决定：
   bullseye = **v12.22.12**、bookworm/noble/trixie = v18.19–18.20 ⇒ **apt 一个都不够**。
   node 12 解析 `install.cjs` 直接 `SyntaxError: Unexpected token '.'`（可选链），
   而我探针里 `npm ... | tail` 的退出码是 **`tail` 的** ⇒ 打出 `RC=0`。
   **唯一没骗人的判据是 `claude` 到底在不在**（`CLAUDE_NOT_RUNNABLE`）。

2. **shim 把 `POST /v1/messages?beta=true` 判 403**。`self.path` 是原始
   request-target、**带 query**，而白名单是精确匹配的 `("POST", "/v1/messages")`
   ⇒ 永不命中。claude-code 打的正是带 `?beta=true` 的那个端点。
   难归因在于 **cc 侧完全不提 403 也不提端点**，只渲染成
   `is_error:true / num_turns:1 / terminal_reason:api_error` ——
   与「网络不通」「额度耗尽」逐字节同形。**只有 shim 的 `/__stats` 里那个
   `403_POST_/v1/messages?beta=true` 计数键指出了真因**（再次印证：判据用网关计数器，
   不是「再试一次看看」）。

## 放弃了什么（以及为什么不选）

- ⛔ **不用 NodeSource 脚本装 node**。它是 `curl | bash` 装 apt 源，bullseye 上还要
  gpg + apt-transport-https，失败面更大且不确定；官方 tarball 是确定性的
  （钉版本、31MB、实测 ~20s、零 apt 交互）。
- ⛔ **shim 不改成前缀匹配**。原注释那条理由依旧成立：前缀匹配下
  `/v1/messages/../../admin` 也会过。只切 `?` 之后的部分，**路径本身照旧全等比较**。
- ⛔ **上游 URL 仍用带 query 的原 path**。`?beta=true` 是 cc 要的语义，
  丢掉它等于偷偷改了被测对象的行为 —— ①‴ 的底线是**不改对照 agent**。
- ⛔ **不让 cc 直连 `code.ppchat.vip`**（用户本棒提过这个选项）。那个 key/端点
  **正是 shim 现在转发的上游**，直连拿到的是同一个模型，但会丢掉两样东西：
  ① `/__stats` 这个唯一能指出真因的仪器（上面第 2 条就是它抓到的）；
  ② 真 key 会进 10 个跑任意 benchmark 代码的容器（shim 收窄端点就是为了防这个，B8）。
  ⇒ 修 shim 是**根治**，直连是绕过。
- ⛔ **不给 `-n` 提档**。§5.2.5 那条 9150MiB/15950MiB 仍然有效，Rosetta 不改变它。

## 拿什么证明它生效了

**闸的三态（同一道闸、同一条命令、只换被测对象）**：

| 场景 | 判据 | 结果 |
| --- | --- | --- |
| bullseye 修复前 | `gate-claude-code-install.sh qemu-startup` | ⛔ **红**：`exit 127: claude: command not found`（npm 明明 `added 2 packages`） |
| bullseye 修复后 | 同一条命令 | ✅ **绿** `completed=1 errored=0`（1m54s） |
| bookworm 回归 | `... log-summary-date-ranges` | ✅ **仍绿** `completed=1 errored=0` |
| 变异自证 | `... --mutate`（钉 `99.99.99-does-not-exist`） | ✅ **仍红在 npm ETARGET 上**（不是红在别处） |

四个 job 的 `cost_usd` 全为 `None`（`--install-only` 不调模型）⇒ 这一组实付 **$0**。

**shim 修复的 6 条单测（含 2 条加固反证，缺一不可）**：

```
/v1/messages              -> /v1/messages              allowed=True   ← 回归
/v1/messages?beta=true    -> /v1/messages              allowed=True   ← 本次修的
/v1/messages/count_tokens -> /v1/messages/count_tokens  allowed=True
/v1/messages/../../admin  -> /v1/messages/../../admin   allowed=False  ← ⛔ 路径穿越仍拒
/v1/chat/completions      -> /v1/chat/completions       allowed=False  ← 族不匹配仍拒
/admin?x=/v1/messages     -> /admin                     allowed=False  ← ⛔ query 塞白名单仍拒
RESULT= PASS
```

**端到端（这条才是真判据）**：cc 在容器内经 shim 完成**第一次真实模型调用** ——
`is_error=False` / `num_turns=1` / `terminal_reason=completed` / `result='OK'`，
shim 计数器 `200_/v1/messages` 由 1 → **2**（不再出现 `403_...?beta=true`）。

**AVX 闸（第十二棒新增，本棒实测其两态）**：Rosetta 开启后容器内 `avx=8` ⇒ 绿；
同一判据在原生 arm64 容器上 `avx=0` ⇒ 红（变异仍红）。

**本仓门禁**：`bun run affected-tests:run` **696 pass / 0 fail**；
`make build` 通过、产物自检 4 项全绿。

### ⚠️ 三条不许从本棒推出的结论

1. ⛔ **不许说「①‴ 跑完了」** —— 本棒模型零调用（除 2 次 smoke），
   **cc 侧至今 0 个有效评测样本**，任何 reward 比较都没有分母。
2. ⛔ **不许把 `claude --version` 当能跑的判据** —— 它走快路径不进 JIT。
   本棒验 `-p` 时还额外踩到：少了 `IS_SANDBOX=1`（harbor `claude_code.py:1833` 会设）
   会在 2s 时死在 root 权限检查上，**而那个 2s 与 AVX 崩溃的 2.3s 几乎同形**。
   ⇒ 探针必须**连 env 一起**等于真实流量，不只是命令形态等于。
3. ⛔ **不许把 `-n 6` 提档** —— 见上，OOMKill 会伪装成能力失败。
