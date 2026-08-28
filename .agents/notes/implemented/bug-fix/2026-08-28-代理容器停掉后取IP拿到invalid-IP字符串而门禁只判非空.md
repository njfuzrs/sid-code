---
Status: implemented
Date: 2026-08-28
---
# 代理容器停掉后 `docker inspect` 返回字符串 `invalid IP`，而门禁只判非空 → 10 条实例全烧且报告像"能力差"

## 决定了什么

`evals/external-benchmarks/swe-bench/exec-swebench.sh` 里取 allowlist 代理 IP 那一处，
判据从「非空」改成「像一个 IPv4 地址」。

原形态（第 726-733 行）：

```bash
proxy_ip="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$RUN_NET\").IPAddress}}" \
  "$PROXY_NAME" 2>/dev/null || true)"
[[ -n "$proxy_ip" ]] || { bad "取不到 allowlist 代理…"; exit 1; }
```

`docker inspect` 对一个**已停止**的容器不报错：它按 Go 模板求值，
`(index …).IPAddress` 在网络已解绑时打印字符串 **`invalid IP`**，且 **exit 0**。
于是 `-n` 为真、门禁放行，`http_proxy=http://invalid IP:8080` 被注进每个 agent 容器。

**这一条实测烧掉了路 B 我方侧的整轮**（A7.18.6 第 4 步，2026-08-28）：

```
→ arch=amd64  产物=sid-code  代理=invalid IP:8080  jobs=1
→ ── astropy__astropy-12907
astropy__astropy-12907: agent_error  patch=0B  wall=11343ms
  unaccounted: agent 非 0 退出：1 | 零 patch 且未命中轮次用尽/LLM 致命错误两个信号
              —— 原因未归因，需人工读 agent.log 与轨迹确认是否为能力问题
```

10 条**逐条**如此，每条 11–17 秒。`agent.log` 里是
`LLM 错误: … 最后一次失败原因 — Connection error.`、`api_calls=0`。

危险的不是它失败，是**失败的形状**：`agent_error` + `零 patch` + unaccounted 明说
"需人工确认**是否为能力问题**"。一份 solved_count=0 的报告会照常生成，
而唯一指向真因的证据是 `代理=` 那一行里的两个字 —— 它混在 12 行门禁输出中间，
颜色还是普通 info。**没有任何一层会说"代理没起来"**。

与记忆里 `metric-exists-but-value-is-junk` 同型：字段在、有值、值是废的。
差别在这条更坏一档 —— 那条毁的是一个指标，这条毁的是整轮评测，
而且**恰好在需要它的那次**（跨 harness 对照的我方侧）。

## 放弃了什么（以及为什么不选）

**① 在 run_one 里检测"agent 一个 API 调用都没发出"然后停整轮。**
否决：这是在下游补，它抓的是症状。同一个坏 IP 还会以别的形态出现
（比如网关恰好可直连时 agent 自由出网 → §5.1 的作弊风险），而那种形态
`api_calls > 0`，这道补丁抓不到。判据必须回到"代理 IP 是不是一个 IP"。

**② 每轮跑之前自动 `net-setup.sh`（幂等，跑一次很便宜）。**
否决：它把"设施没起来"变成"我帮你起来"，于是**代理为什么会停**这件事
永远不被人看见。本次真因是 colima/daemon 在 12 小时前重启过
（`Exited (255) 12 hours ago`），那是需要知道的信息。自动补起等于把它藏掉。
另外自动起会在 `SC_BASE_URL` 与上一轮不同时静默换掉 allowlist，
形态是"两轮的出网白名单不同而报告都正常"。

**③ 判 `proxy_ip != "invalid IP"`（字符串黑名单）。**
否决：这是照着已见过的那一个坏值写判据。docker 的模板求值在别的解绑状态下
会打印什么，我们不知道 —— 白名单式判据（`必须像 IPv4`）覆盖全部未知坏值，
黑名单只覆盖今天这一个。与记忆里「密钥正则的前缀盲区」同型：
按见过的形态写字符类，漏一个就全漏。

## 拿什么证明它生效了

**① 复现坏值本身**（不是推断，是实测）：

```
$ docker inspect -f '{{(index .NetworkSettings.Networks "sid-swebench-run").IPAddress}}' sid-swebench-proxy
invalid IP
exit=0
```

容器状态 `Exited (255) 12 hours ago`。`-n "invalid IP"` 为真 → 旧门禁必放行。

**② 修好后取到真值、且 allowlist 语义完好**：

```
$ SC_BASE_URL=https://code.ppchat.vip ./evals/external-benchmarks/swe-bench/net-setup.sh
✅ 代理在 sid-swebench-run 上的地址: 172.18.0.3:8080
✅ 名单内可达: code.ppchat.vip（HTTP 200）
✅ github.com 被拦（已拦，000）
✅ pypi.org 被拦（已拦，000）
✅ 不设代理时直连不通（internal 网无默认路由）
```

**③ 端到端：同一份产物、同一条题，坏代理 vs 好代理**：

| | 代理 | 结果 |
| --- | --- | --- |
| `routeb-sid80`（作废） | `invalid IP:8080` | `agent_error patch=0B wall=11.3s`、api_calls=0 |
| `routeb-sid80c` | `172.18.0.3:8080` | `patch_produced patch=504B wall=315.7s` |

两轮**只差代理 IP 这一个变量**（同 `SWE_BUILD_REF=abb8233e9cd8`、同模型、同网关、
同 `SWE_MAX_TURNS=80`）。前者的 run 目录保留为
`runs/routeb-sid80-aborted-proxy-down/`（不删，按 CLAUDE.md §0）。

**④ 反漂移门禁 + 变异自证**（`tests/eval/swe-bench-proxy-ip-guard.test.ts`，4 条断言）：

```
$ bun test ./tests/eval/swe-bench-proxy-ip-guard.test.ts
 4 pass / 0 fail

# 变异：把判据改回 `[[ -n "$proxy_ip" ]]`（对着真源文件改，不是改测试替身）
 0 pass / 4 fail
```

四条**全部**翻红（IPv4 正则不在、`-n` 形态被抓、不打印坏值、不点破 `invalid IP`），
改回来后恢复 4 pass。

门禁刻意做成**读脚本文本**而不是跑脚本：真跑要起 docker 并停掉代理容器，
在 CI 上必然 skip，而**恒 skip 的门禁等于没有门禁**
（同「门禁不许依赖可选依赖」那条）。需要防的漂移只有一种
——「有人把它改回 `-n`」——静态判据足以机械回答它。
