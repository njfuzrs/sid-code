# Harbor 评测底座接入

在 [Harbor](https://github.com/laude-institute/harbor) 的任务容器里跑 sid-code，
从而用**同一个底座**跑几十个 benchmark，并与 Harbor 内置的 33 个 agent
（claude-code / codex / mini-swe-agent / aider …）做**同题、同模型、同容器、同 verifier**的对照。

> **状态：链路已跑通到第 2 步（2026-08-27 首次真实评测），仍未验证有用。**
> sid-code 在 Terminal-Bench 上**解出了 2 题**（`regex-log` / `log-summary-date-ranges`，
> reward 1.0），10 题一轮 54 分钟 / $3.80。
> 冒烟第 0/1/2 步的判据全部实测通过（含 oracle/nop 双向对照与 `cost_usd` 非 0）。
> 但真正的验收判据不是「agent 能跑通」，而是**「至少有一次真实的 harness 优化决策，
> 是由 Harbor 上的对照数据驱动的」**（见文末「验收清单」的 A11）。
> 在 A11 之前请如实这样描述它 —— 本仓有过「防线全在、调用全 0」的先例。
>
> ⚠️ **那次首跑当场挖出 6 个缺陷，其中 4 个「不报错」。** 详见下面
> 「首次真实评测挖出的缺陷」一节 —— 它是这份接入到目前为止最有价值的产出，
> 也是「已建成 ≠ 有用」这句话的实证。

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
# 0) Docker compose 插件 + 镜像可拉。⚠️ 这两条在本机实测都不成立过，见下方「宿主环境的两个坑」
docker compose version                # 报 "unknown command" 就先读那一节

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

## 宿主环境的五个坑（2026-08-28 更新，都挡在第 0 步之前）

都**不指向本接入**，但不解决一个 trial 都跑不起来。放在这里是因为
排查它们花掉的时间远多于读这一节。

> ### 先读：宿主网络三条硬约束的**现状**（2026-08-28 复核，全部推翻旧记录）
>
> 旧记录（`02-Harbor接入方案设计.md` §13.5）列了三条「本机硬约束」。
> 开了宿主全局代理 + TUN 之后**逐条实测复核，三条全部不再成立**：
>
> | 旧约束（第三棒记） | 2026-08-28 实测 |
> | --- | --- |
> | Docker Hub 不可达 | ✅ **已通**。给 dockerd 配 proxy 即可，见坑 ② |
> | `downloads.claude.ai` 不可达 → claude-code 装不上 | ✅ **已通**。容器内 `claude-code-releases/bootstrap.sh` 返 200；二进制 278MB @ 0.93MB/s ≈ **300s**，所以 `--agent-setup-timeout-multiplier` 要给足 |
> | `releases/download/` 时通时不通（1/3） | ✅ **单发已稳**（容器内 10/10、5/5）。**但并发下仍会坏**，见坑 ⑤ —— 这条从「随机」变成了「与 `-n` 强相关」 |
>
> ⚠️ **两条判读教训**：
> 1. 旧记录里 claude-code 的域名写成 `downloads.claude.ai/.../bootstrap.sh` 之后
>    我实测 404，一度以为「域名活着但路径没了」。**真实路径是
>    `/claude-code-releases/bootstrap.sh`**（`harbor/agents/installed/claude_code.py:456`）——
>    **拿一个猜的 URL 去测，404 会被误读成「不可达」**。要测就从源码里取那条 URL。
> 2. 「VM 里 curl 通」与「dockerd 能拉」**是两条不同的路**，见坑 ②。
>    只测前者会得出「网络没问题」的错误结论。
>
> **换机器时这三条都要重新确认**，判据就是上表右列那几条命令。

### ① `docker compose` 插件不在 docker CLI 的搜索路径里

症状：`RuntimeError: Docker compose command failed ... unknown flag: --project-name`，
且**整个 job 1 秒就结束**（快得不像在跑）。
根因：Homebrew 把插件装在 `/opt/homebrew/lib/docker/cli-plugins/`，
而 docker CLI 只搜 `~/.docker/cli-plugins/`。`docker-compose` v1 那个独立命令**能用**，
于是 `docker-compose version` 有输出、`docker compose version` 报 unknown ——
只试前者会得出「装好了」的错误结论。

```bash
mkdir -p ~/.docker/cli-plugins
ln -sfn /opt/homebrew/lib/docker/cli-plugins/docker-compose ~/.docker/cli-plugins/docker-compose
docker compose version    # 必须有输出，这才是 Harbor 调的那条
```

### ② colima 里连不上 Docker Hub（但 ghcr.io 是通的）

> ✅ **2026-08-28 已解决，根因已找到。** 下面保留原症状与「宿主搬运」那条绕路，
> 是因为**它在没有宿主代理的机器上仍然是唯一的办法**。有代理的机器直接看
> 「治因：给 dockerd 配 proxy」那一段。

⚠️ **先分清是哪个 registry 不通，别一概而论。** 实测同一个 VM 里：
`registry-1.docker.io` i/o timeout，而 `ghcr.io/v2/` 返回 401（= 连上了）。
Terminal-Bench 的任务镜像在 **ghcr**，所以那批**不需要**下面这套搬运；
只有 `FROM ubuntu:24.04` 这类 Docker Hub 基础镜像要。

先各测一次再决定做什么：

```bash
colima ssh -p <profile> -- curl -s -m 8 -o /dev/null -w '%{http_code}\n' https://ghcr.io/v2/
docker pull ubuntu:24.04     # 这条超时才需要下面的搬运
```

症状：`failed to resolve reference "docker.io/library/ubuntu:24.04": dial tcp ... i/o timeout`
（另一个等价形态是 `net/http: TLS handshake timeout`）。

#### 治因：给 dockerd 配 proxy（**2026-08-28 实测有效**）

根因不是「网络慢」，是两件事叠加：

1. `registry-1.docker.io` 的 DNS 在本网络被**污染**到 `199.59.150.45`（Twitter 段），
   TCP 握手成功但 TLS 无响应 —— 所以 `nc -z` 会报 OPEN，**连通性探测会骗你**；
2. **lima 把宿主代理写进了 `/etc/environment`，但 systemd 服务不读那个文件**，
   于是 VM 里 `curl` 走代理一切正常、`dockerd` 却完全没有代理。
   这就是为什么「VM 里 curl 得通、docker pull 超时」这个矛盾形态会出现 ——
   **它们走的不是同一条路**。

```bash
colima ssh -p <profile> -- sudo tee /etc/systemd/system/docker.service.d/http-proxy.conf <<'EOF'
[Service]
Environment="HTTP_PROXY=http://192.168.5.2:<宿主代理端口>"
Environment="HTTPS_PROXY=http://192.168.5.2:<宿主代理端口>"
Environment="NO_PROXY=localhost,127.0.0.1,192.168.5.0/24,10.0.0.0/8,172.16.0.0/12,*.local,ghcr.io,pkg-containers.githubusercontent.com,*.githubusercontent.com"
EOF
colima ssh -p <profile> -- sudo systemctl daemon-reload
colima ssh -p <profile> -- sudo systemctl restart docker
```

三条**必须照抄**的细节：

- **`ghcr.io` 与 `*.githubusercontent.com` 要进 `NO_PROXY`。** 两条路都通，
  但实测直连 blob **3.3 MB/s** vs 走代理 **2.6 MB/s**，而 terminal-bench 全部镜像
  都在 ghcr 上（单个 260MB+）。只有 `docker.io` 需要代理。
- **`/etc/systemd/system/docker.service.d/` 落在 `/dev/vda1`（ext4），跨 VM 重启保留** ——
  实测过，这不是 `/tmp` 那种「每一棒重建一次」的债。
- 这一层**只作用于 dockerd 自己拉镜像**，**不会**传给容器里的进程。
  容器里的 `curl` 要走代理是另一件事，见下面 ④。

⚠️ **重启 daemon 会影响同一个 daemon 上的其他容器**（自建 SWE-bench 链路的
`sid-swebench-proxy` 就在上面）。重启后记得跑一次
`net-setup.sh --check` 确认那套设施还在。

#### 绕路：宿主搬运（没有宿主代理时用）

**完全不动 daemon**：

```bash
# 宿主能走代理（scutil --proxy 看得到），所以在宿主拉、再 load 进 VM
ALL_PROXY=socks5://127.0.0.1:<代理端口> \
  skopeo copy --override-arch arm64 --override-os linux \
  docker://docker.io/library/ubuntu:24.04 \
  docker-archive:/tmp/ubuntu2404-arm64.tar:ubuntu:24.04
docker load -i /tmp/ubuntu2404-arm64.tar
```

顺带一条判读经验：**第 0 步 `harbor run` 失败时退出码仍是 0**
（失败信息在表格的 `Exceptions` 列里）。所以**不能靠退出码判断**，
必须看 `Trials`/`Exceptions` 两个数 —— 管道里接 `| tail` 更会把它吃掉。

### ③ `host.docker.internal` 在 colima 下也不可解析

README 原先只说「Linux 宿主上不存在」。实测 **colima 同样不存在**
（VM 里跑的是原生 dockerd，不是 Docker Desktop），而 Harbor 起容器时不加 `--add-host`。
可用的是宿主在 VM 内的地址 `192.168.5.2`（= `host-gateway`），实测容器直连可达：

```bash
export SID_HARBOR_GATEWAY_URL=http://192.168.5.2:<网关端口>
harbor run ... --allow-agent-host 192.168.5.2
```

### ④ Harbor 数据集注册中心会**随机在第 0 秒杀掉整个 run**（2026-08-28 新增）

症状：`ValueError: Error getting dataset terminal-bench-sample@2.0`，
**一个 trial 都没起就退出**。它长得像「数据集名字写错了」，实际是网络。

根因：`-d <name>@<version>` 默认走 Harbor 官方的 Supabase 注册中心
（`hlqxxzsirfrgeqasvaps.supabase.co` 的 `get_dataset` RPC）。
**实测 15 次采样 14 通 1 挂（curl 000，约 7%），而 `harbor` 那一层没有任何重试** ——
`registry/client/harbor/harbor.py:128` 把所有异常吞掉换成一句 `Error getting dataset`，
**连原始异常都不透出**，所以从报错完全看不出是网络。

⚠️ **这条比看起来更要紧**：它挡在跑之前，所以只会浪费你的时间；
但它**同类的读取侧形态**（跑到一半某个远端调用挂掉）就会变成 reward 异常。
判据：**报 `Error getting dataset` 时先复跑一次，不要去查数据集名字。**

治法：把 spec 落成本地 `registry.json`，用 `--registry-path` 完全绕开远端。
仓库里已备好 `registry.local.json`（terminal-bench-sample@2.0，10 个任务）：

```bash
harbor run -d terminal-bench-sample@2.0 --registry-path registry.local.json ...
```

两条细节**照抄，别自己推**：

- **文件格式是一个裸的 JSON 数组**（`[{name, version, description, tasks, metrics}]`），
  **不是**带 `datasets` 键的对象。写成对象会得到一个 pydantic
  `Input should be a valid dictionary ... input_value='name'` ——
  它在报「数组元素类型不对」，但读起来像在说字段名有问题。
- **`metrics` 上游确实是空数组**（已核 RPC 原始响应），所以本地文件里的 `[]`
  不是偷懒省掉的。换数据集时要重新从 RPC 取，别照抄这份的 `[]`。

刷新它（换数据集或上游改了版本时）：

```bash
SB=https://hlqxxzsirfrgeqasvaps.supabase.co
KEY=$(grep -oE 'sb_publishable_[A-Za-z0-9_]+' \
  ~/.local/share/uv/tools/harbor/lib/python*/site-packages/harbor/registry/client/harbor/config.py)
curl -s -X POST -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"p_name":"terminal-bench-sample","p_version":"2.0"}' \
  "$SB/rest/v1/rpc/get_dataset" > /tmp/spec.json
# 再按上面那个「裸数组」格式转一次（转换脚本见 git 历史里这一节的提交）
```

⚠️ **本地 registry 只固定「哪些任务、哪个 commit」，不固定镜像。**
任务仓库（`terminal-bench-2-0-sample.git`）和 ghcr 镜像仍要联网拉。
所以它消除的是「第 0 秒随机死」，**不是**让整条链路离线可跑。

### ⑤ 🔴 **`-n`（并发）直接决定 verifier 坏掉的比例** —— 慢网络下必须 `-n 1`

这一条是本机**最大的单一失真源**，而且它伪装成能力差。四轮 `nop` 对照
（同一批 10 个任务，`nop` 不解题所以 reward 必然全 0，
唯一的观测量是「verifier 有没有跑成」）：

| 配置 | verifier 坏掉 |
| --- | --- |
| **`-n 1` 直连** | **1 / 10** |
| `-n 1` 直连 + 本地 registry | **1 / 10**（复现，同上） |
| `-n 3` 直连 | **4 / 10** |
| `-n 3` + 容器走宿主代理 | **6 / 10** ← 最差 |

`-n` 从 1 调到 3，坏掉的从 1 变 4。**Terminal-Bench 的 `tests/test.sh` 每一个都要
现装 uv（`https://astral.sh/uv/0.7.13/install.sh` → GitHub release 17MB）**，
10 个任务下载的是**同一个 tarball**；并发一上去就在抢同一条出口带宽，
失败散布在三个不同域名上（`github.com` / `releases.astral.sh` /
`archive.ubuntu.com`），curl 错误码也各不相同（7 / 18 / 35）——
**这个「多域名 + 多错误码」的形态本身就是带宽争抢的指纹**，不是某个域名被墙。

⚠️ **Harbor 的 `-n` 默认是 4**，比实测安全值大 4 倍。不显式写 `-n 1`
就等于默认踩这个坑。

两条被实测**否决**的治法，别再试（各花了半小时）：

- ❌ **容器走宿主 HTTP 代理**（`--extra-docker-compose` 注入 `*_proxy`）。
  小规模探针上看着很好（6 路 6/6、8 路 8/8），**真跑却是四种配置里最差的 6/10**。
  形态教训：**探针的并发形态与真实 run 不同** —— 真实 run 里同时还有
  镜像拉取、agent 自己的模型调用、多个容器的 apt，探针只测了下载这一条。
  「小规模探针全绿」不能外推到真实 run。
- ❌ **squid 缓存代理**（想让 10 个任务共享一份 uv tarball）。
  下载走的是 **HTTPS**，squid 只能看到 `CONNECT` 隧道、**缓存不了隧道内容**；
  要缓存就得 MITM，那需要往**每一个任务镜像**里塞 CA 证书 ——
  改被测环境去迁就基础设施，不做。

**当前的做法就是 `-n 1`，并接受剩下那 1/10。** 配套判据（已在
「reward=0 的三种可能」一节）：**任何 reward=0 先看
`verifier/test-stdout.txt` 尾部有没有 `command not found`**。

> 真正的治法是一台网络干净的机器，或者在镜像里预装 uv（要改上游任务，
> 会破坏「同题同 verifier」的可比性，所以不做）。
> **在本机上，这一项是已知残余误差，不是已解决问题。**

#### ⚠️ 2026-08-29 补充：`-n 1` **也保不住** —— 出口带宽本身会劣化到 0/3

上面那张表的前提是「出口带宽正常，只是并发在抢」。这天遇到的是**另一种**：
`-n 1`、无并发、单任务独占带宽，**verifier 仍然 3/3 全坏**。
量出来的差别只有一个数 —— 宿主到 GitHub CDN 的吞吐：

| | verifier 全程耗时 | uv 下载吞吐 | 结果 |
| --- | --- | --- | --- |
| 8/28 基线 | **24–56s** | 正常 | **10/10 判分成功** |
| 8/29 劣化 | **103 / 243 / 413s 后放弃** | **70 KB/s** | **0/3**（`curl: (7)` / `(56)`） |
| 8/29 换代理节点后 | — | **1.02–1.10 MB/s** | 同一命令、同一镜像立刻恢复 |

**所以 `-n 1` 不是判据，吞吐才是判据。** 跑前必测（已写进
`run-permission-switch.sh` 的头注释）：

```bash
docker run --rm alpine:3 sh -c 'apk add -q curl; curl -sL -o /dev/null -m 30 \
  -w "%{speed_download}B/s\n" \
  https://github.com/astral-sh/uv/releases/download/0.7.13/uv-x86_64-unknown-linux-gnu.tar.gz'
```

**要 ≥ 500KB/s**（17.8MB / 35s，留出 pytest 的余量）。⚠️ **必须在容器里测，
不是宿主** —— TUN 模式的代理可能覆盖宿主而漏掉 colima VM。
核「代理有没有真的覆盖容器」用出口 IP 对照：
`curl -s https://api.ipify.org` 在宿主与 `docker run --rm alpine:3` 里应该一致。

**这条为什么值 $3.12**：它坏得**不报错**。`reward=0` 与真的没解出来
**逐字节一样**，而 `sid_subtype` 还写着 `success` 给它背书 ——
一整轮「换档没用」的假结论就是这么产生的。
挡住它的是 §14.7 规则 ②（verifier 坏掉的样本不进分母）：复算脚本把 3 题全排除，
分母落到 0/3，于是得到「没有结论」而**不是**「一个假结论」。

---

## 网关：透传代理**不满足**这个设计（2026-08-27 实测）

设计的核心是「**key 绝不进容器**」：容器里的 `settings.json` 只有占位 token
`no-auth-dummy`，真实凭据由宿主网关持有。

⚠️ **一个透传代理不满足这一条。** 本机 `:4000` 上的 `claude-trace-proxy`
把 `Authorization` **原样**转给上游，实测占位 token 被上游拒（`[no]无效的令牌`）。
用它就等于必须把真 key 写进容器 —— 而那正是这个设计要防的事。

网关必须做的是**注入**：收占位 token → 确认它是占位 token → 换成真 key 转发。
三条它该有的行为（都实测过）：

| 请求 | 期望 | 为什么 |
| --- | --- | --- |
| 占位 token + 模型端点 | 200（宿主侧换真 key） | 正常路径 |
| **任何别的 token** | **401** | 不做「有 key 就转发」的兜底 —— 那会让它退化成透传代理，**而调用方不会发现** |
| 非模型端点 | 403 | 容器里跑的是 benchmark 的任意代码，端点收窄是「被薅额度」风险能挡的那一半 |

第二条最容易被写成兜底。写了就等于取消整个设计，而**所有测试照样绿**。

**实测到的两件事**（跑第 2 步时从网关日志读出来的）：

- **`GET /api/pricing` 被 403 挡下。** sid-code 会去网关取计费取价，
  而那个端点不在 allowlist 里。**这不是故障**（取不到会退化到内嵌的模型目录快照），
  但它说明「端点收窄」是有实际作用面的 —— 要放通就显式加进 allowlist，
  别因为「看到 403 就慌」而把 allowlist 整个拆掉。
- **上游会返 429（限流）。** 并发跑多题时必然撞到。⚠️ 这一条会污染耗时口径：
  429 后的重试时间**算进 trial 的 wall-clock**，而它反映的是上游配额而不是 harness 性能。
  跨 agent 对照时要么控住并发（`-n` 调小），要么把耗时口径限定在
  `metadata.sid_duration_api_ms`（sid-code 自己记的），而不是 Harbor 的 trial 总时长。

> 网关计数器（本次 shim 提供了 `GET /__stats`）在排查时非常好用：
> **它是「请求到底有没有出容器」唯一的直接证据**。
> 第 1 步首跑时正是靠它从 6 涨到 37 才确认「架构修复后 sid-code 真的在调模型」——
> 而不是靠猜。企业网关侧建议也暴露一个同类计数。

---

## 四步递进：每一步都有「过不了就停」的判据

**不要跳步。** 每一步排除的都是下一步的一个变量。

### 第 0 步：Harbor 自身可用（不涉及我们的代码）

```bash
HARBOR_TELEMETRY=0 harbor run -t hello-world/hello-world -a nop \
  --jobs-dir runs --verifier-timeout-multiplier 6 -y
```

判据：`Trials = 1` / `Exceptions = 0` / `Reward = 0.0`。
**不能看退出码** —— `harbor run` 失败时退出码仍是 0（实测），信息只在那张表里。
过不了 = Harbor / Docker 环境问题，与本接入无关，**先修环境**（见上面「宿主环境的两个坑」）。
`nop` 是 Harbor 内置的空 agent，用它先排除「是我们的 agent 有问题」这个变量。

⚠️ **`--verifier-timeout-multiplier 6` 不是可选的**：`hello-world` 的 verifier
默认只给 120s，而它要 `apt-get update` + 装 uv（实测拉 19MB，国内网络下必超）。
不加的形态是 `VerifierTimeoutError` —— 长得像链路坏了，其实只是网络慢。

`Reward = 0.0` 是**正确结果**（nop 什么都不做）。顺便核一眼 verifier 真跑了测试
而不是恒返 0：

```bash
cat runs/<job>/<trial>/verifier/ctrf.json | python3 -c \
  "import json,sys; print(json.load(sys.stdin)['results']['summary'])"
# 期望 {'tests': 2, 'passed': 0, 'failed': 2, ...} —— 2 个测试真的跑了、真的 fail
```

### 第 1 步：我们的 agent 能装上、能跑起来

```bash
HARBOR_TELEMETRY=0 \
PYTHONPATH="$(git rev-parse --show-toplevel)/evals/external-benchmarks/harbor" \
SID_HARBOR_GATEWAY_URL=http://192.168.5.2:4100 \
SID_HARBOR_PROVIDER=anthropic \
harbor run -t hello-world/hello-world \
  -a sid_code_agent:SidCodeAgent \
  -m anthropic/claude-sonnet-5 \
  --allow-agent-host 192.168.5.2 \
  --jobs-dir runs --verifier-timeout-multiplier 6 --agent-timeout-multiplier 4 -y
```

⚠️ **`SID_HARBOR_PROVIDER` 在 anthropic 族下必须显式给。** `-m anthropic/claude-sonnet-5`
的 provider 段会被解析出来，但 Harbor 的 provider 命名空间与 sid-code 的闭集
（`anthropic`/`openai`/`ollama`/`replay`）不保证同名 —— 不显式给的形态是
落到默认的 `openai`，于是 baseURL 被拼上 `/v1`、请求发给错的协议族。

判据**四条，缺一不可**（2026-08-27 实测四条全过）：

1. `results.json` 里 `agent_info.version` 是**真实版本号**，不是 `"unknown"`
   （实测 `sid-code v0.1.601 (TypeScript)`）；
2. `runs/.../agent/sid-code.jsonl` 里有 sid-code 的 NDJSON 输出（实测 44KB）；
3. `runs/.../agent/sid-code-build.json` 存在，且 `commit` 与本地 HEAD 一致、
   **`commit_source` 是 `artifact-bytes`**（不是 `host-head-fallback`）；
4. `cost_usd` **非 null 且非 0**（实测 `0.0292507`）。

> ⚠️ **判据 3 曾经假过，而且是被自己的兜底掩盖的。** 首跑时它是
> `host-head-fallback`，但 `commit` 的**值完全正确** —— 因为宿主 HEAD 恰好就是构建
> 那个 commit。换台机器（HEAD 已往前走）读出的就是错 commit，而**没有任何东西会报错**。
> 所以这一条要看 `commit_source` 那个字段，不是看 `commit` 的值像不像。
>
> ⚠️ **`build.json` 里 `version` 恒为 `null`，这不是缺陷。** 基类 `setup()` 的顺序是
> `install()` → 探版本，而 build.json 在 `install()` 里写。版本的事实源是
> `result.json` 的 `agent_info.version`，判据 1 看的也是它。

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

⚠️ **`-n` 是并发数，不是题数。** `-n 2` 跑的仍是全部 10 题（2 个同时跑），
不是「只跑 2 题」。想只跑少数几题用 `-t <task>` 逐个点名。

⚠️ **这一步的第一道判据是架构，不是分数。** Terminal-Bench 的镜像只发 amd64，
而第 1 步的 `ubuntu:24.04` 是多架构的 —— 所以**第 1 步排除不了架构这个变量**
（在 arm64 机器上它恰好能过）。先看 build.json：

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); \
  print(d['arch'], d.get('arch_actual'))" runs/<job>/<trial>/agent/sid-code-build.json
# 两个值必须相同。exit 127 / 'not found' 就是这里不匹配（实测过一次）
```

分数判据：**至少有一题 reward > 0**。全 0 时**先怀疑链路，不要先怀疑 sid-code** ——
最危险的失效是 verifier 恒返 0，它把「链路坏了」伪装成「没解出来」，
而这两者**在数据上不可区分**。交叉验证见下面「R1 双向对照」。

⚠️ **区分「reward=0」与「errored」**：前者是跑完了没解出来（有 `cost_usd`），
后者是根本没跑到判分（`cost_usd` 是 `None`）。两者混在一个分母里就是虚高/虚低。

```bash
python3 -c "
import json,sys; s=json.load(open(sys.argv[1]))['stats']
print({k:v for k,v in s.items() if 'trial' in k})" runs/<job>/result.json
```

**qemu 模拟下的一个已知失效**（实测）：`--environment-build-timeout-multiplier`
默认 1（即 600s），而某些任务（如 `qemu-startup`，在 qemu 里再跑 qemu）
建镜像就会超 → `EnvironmentStartTimeoutError`。
这类**属于环境不属于 harness**，但它会占掉一个分母 ——
要么调大 multiplier，要么排除它，**排除了就必须 log 出来**（R1 的分母铁律）。

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

## 首次真实评测挖出的缺陷（2026-08-27）

这一节是「已建成 ≠ 有用」最直接的实证：**代码在 main 上、CI 全绿、19 条门禁断言全过，
而一个 trial 都跑不起来。** 四个缺陷里 3 个不报错。

| # | 缺陷 | 形态 | 为什么门禁没拦住 | 现在拦它的 |
| --- | --- | --- | --- | --- |
| 1 | `from harbor.agents.capabilities import AgentCapabilities` —— 该模块在 pin 的 0.22.0 里**不存在** | harbor 启动即 `ValueError: Failed to import module` | L1 是 ast 静态解析、**不 import**；L2 会 import 但当时**在装了 harbor 的机器上也 skip**（探测用系统 `python3`，而 `uv tool install` 装在隔离环境里，系统 python 看不到） | L1 新增「import 的模块全部存在于 pin 的版本里」+ 修好 L2 的解释器探测 |
| 2 | `identity.get("artifact_commit")` —— 脚本吐的键是 `commit` | 永远退化到 `host-head-fallback`，而 **`commit` 的值仍然正确**（宿主 HEAD 恰好就是构建 commit） | 没有任何断言核对「读的键名」与「脚本的输出键名」 | L1 真的跑一次 `artifact-identity.ts`，逐个核 `identity.get()` 的实参 |
| 3 | 读不到身份时 `if not commit` 判不出失败 | 脚本 miss 时**照样吐完整 JSON**，字段填字面量 `"unknown"` → 会写下 `commit="unknown"` 却自称 `artifact-bytes`，**`commit_source` 这层保护恰好在最需要它时失效** | 同上 | 改判「40 位十六进制」形态；L1 锁住「miss 也返回值」这个前提 |
| 4 | `identity.get("artifact_dirty")` —— 键是 `dirty` | build.json 那格恒 `null`。**比 #2 更隐蔽**：这格本来就允许 null，「恒 null」看起来像正常缺省值 | 同上 | 同 #2（逐个核，不是只核 commit 那一个） |
| 5 | 二进制自动发现**不校验产物架构** | Terminal-Bench 镜像只发 amd64，而 `dist/branch-builds/` 里是 arm64 包（目录名不含架构，同 commit 互相覆盖）。**静默上传了错架构的包**，build.json 还写下 `arch: "x64"`（那是期望值），容器里 `exit 127: not found` —— 报错**完全不指向架构** | 门禁只看得到源码，看不到「哪个包被挑中了」；且第 1 步用的 `ubuntu:24.04` 是多架构的，**arm64 下恰好能过** | 读 ELF `e_machine` 校验并报死；build.json 加 `arch_actual`（事实）与 `arch`（期望）并存 |

| 6 | `sid_is_error` 只读 `is_error` 字段 | sid-code 在**错误路径**的 result 事件里**根本不发这个字段**（成功路径才发 `is_error: false`）→ `sid_is_error` 恒 `None`，而 `None` 在下游被当成「不是错误」：**一个失败的 trial 被记成正常的 0 分，直接污染分子** | 只有真实的失败样本才暴露它 —— 而在此之前从没有过失败样本 | L2 新增行为断言（7 个用例含实测那条事件的形态）；改从 `subtype` 推，并把 `errors` 原文带进 metadata |

**#5 值得单独说**：它把「第 1 步过了」变成了一个**假信心** ——
第 1 步的镜像是多架构的、恰好命中本机架构，于是那一步无法暴露这个缺陷。
四步递进的设计意图是「每步排除下一步的一个变量」，但**第 1 步排除不了架构这个变量**。
这条现在写进了下面第 2 步的判据里。

**#6 是唯一「只能靠真实失败才能挖出来」的一个**。前 5 个都可以被更好的门禁提前拦住，
而 #6 需要先有一个真实的失败样本 —— 冒烟的 `hello-world` 全是成功路径。
这条正面回答了「为什么门禁再全也不能替代真实运行验证」。

### 第 2 步实测数据（2026-08-27，terminal-bench-sample@2.0，10 题）

`claude-sonnet-5`，`-n 2`，qemu 模拟 amd64。**54 分 19 秒 / $3.80**。

| 结果 | 数 | 题 |
| --- | --- | --- |
| reward 1.0 | **2** | `regex-log`（41 turns / $0.92）、`log-summary-date-ranges`（18 turns / $0.41） |
| reward 0.0 | 5 | `chess-best-move` `configure-git-webserver` `fix-code-vulnerability` `polyglot-c-py` `sqlite-with-gcov` |
| errored | 3 | `qemu-startup` `qemu-alpine-ssh` `build-cython-ext` —— **全部是 `EnvironmentStartTimeoutError`（600s 建镜像超时）**，属环境不属 harness |

⚠️ **分母有两个，必须说清用的是哪个**：Harbor 报的 `Mean = 0.200` 是 **2/10**
（把 3 个 errored 算进分母）；跑完的样本里是 **2/7 = 0.286**。
两个数都对，但**混用就是虚高/虚低**。跨 agent 对照时分母口径必须写死。

### ⚠️ 那 5 个 0 分里只有 2 个是真的「没解出来」

**按 `sid_subtype` 拆开之后，5 个 0 分其实是三类样本**：

| `sid_subtype` | 数 | 含义 | 该怎么记 |
| --- | --- | --- | --- |
| `error_max_turns` | 2 | `fix-code-vulnerability` / `sqlite-with-gcov` 打满 `--max-turns 40`（turns=41）→ **被我们自己的旋钮截断的** | 这是 harness 配置问题，不是模型能力 |
| `error_during_execution` | 1 | `polyglot-c-py`：0 turn / 8 分钟 / `outputTokens=0`，`errors` 里是「LLM 错误：主模型请求失败」→ 根因是**上游 429 限流** | 噪声，该重跑或排除（**排除必须 log**） |
| `success` | 2 | 真的跑完了、没解出来 | 这才是能力信号 |

**这是本次数据里最重要的一条**：`2/7 = 0.286` 这个数字**混了三类完全不同的东西**。
不按 `sid_subtype` 拆开看，「分数低」会被无差别归因到「sid-code 不行」，
而实际上其中一半是**旋钮设置**和**上游限流**。

⚠️ 顺带发现：`regex-log` 也打满了 41 turns，但**仍拿到 1.0**（截断前已把文件写对）。
所以 `error_max_turns` **不等于失败** —— 不能拿 subtype 反推 reward，两者要分别看。

⚠️ **`--max-turns 40` 这个默认值对 Terminal-Bench 偏紧**：10 题里 3 题打满。
它是我们自己设的旋钮（`CLI_FLAGS` 里 `default=40`，为与自建链路对齐），
**没有针对 Terminal-Bench 的实测依据**。跨 agent 对照时它是**必控变量** ——
对照 agent 的轮数上限各不相同，不控住就等于在比「谁的上限更宽」。

**#1 的教训值得单独记**：那段代码是「回源码核对」写出来的 ——
核的是本地 harbor git checkout，而那个 checkout 的 `pyproject.toml` 里
`version = "0.22.0"` **却已经含有 v0.22.0 发布后的提交**（版本号还没 bump）。
`AgentCapabilities` 由 PR #2834（2026-08-24）引入，而 v0.22.0 tag 是 2026-08-21。

> **「回源码核对」核的必须是真正会被装上的那份源码。
> 一个 git checkout 的 version 字段不等于它对应某个 PyPI 版本。**

**#2/#3/#4 是同一个形态的三次**：跨语言边界读字段名，没有任何东西核对两侧。
这就是为什么第 4 条判据（逐个核 `identity.get()` 实参）不是「只查 commit 那一个」——
同型错误已经连着发生三次了。

### 顺带确认的一件事：评测轨迹会被自动上传

容器里的 `settings.json` 由 `install()` 写 5 个键，但 sid-code 启动时
`backfill-team-defaults` 迁移会补上 15 个团队默认键，其中包括：

- `trace.upload.auto_upload: true` + 真实 token → **评测轨迹自动发往 `www.sid-code.cc/traj`**
- `fallbackModel` / `subAgentModels` 指向容器里**根本没配的模型**（`ali-deepseek-v4-*`）

这不是本接入的缺陷（是产品在评测环境下的既有行为），但**必须点破**：
它属于「数据主权」那一栏的事实，不是细节。
`session.traj` 仍然留在挂载目录里（`delete_after_upload: false`），
所以 H2 的 `sid_session_id` 接缝完好 —— 这条已实测。

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
| **L1 静态** | 只要 `python3`（stdlib `ast` 解析，**不 import**） | ✅ **真的在跑** | 语法坏了 / 四成员缺失 / **装饰器顺序反了** / 输出格式被改回 `json` / `MODEL_CONNECTION` 被加回 / **权限档形态**（skip 必须是 `type="bool"`、互斥校验与观测计数在位） |
| **L2 导入** | 要装 `harbor` | ⚠️ **skip** | 真 `import` + `issubclass` + `capabilities` 全 False |

⚠️ **L1 那条权限档断言的判据在 2026-08-29 被整个换掉过**，理由值得留：
原判据是「源码里不许出现 `dangerously-skip-permissions`」，它**忠实地执行了一个错误的
决定** —— 自建 swe-bench 链路早已用 113 次权限拒绝实测出「`acceptEdits` 不可用」，
而 Harbor 侧引用**同一个数字**得出了相反结论，再用这道门禁把错的那侧钉死。
本机 10 题全量实测确认同一形态：**144 次拒绝 / 178 次放行**，其中 77% 是
`acceptEdits` 不放行普通 bash（`nproc` / `which git` / `qemu-img info`）。
**一道门禁的注释理由正当，不代表它守的判据正确；修法是改判据，不是拆门。**

拆两层的理由：只做 L2 的话，CI 上**永远 skip** → 门禁形同不存在，而 PR 页面一片绿。
L1 拦得住的恰好是那批**不报错的**失效形态。

⚠️ **它替代不了真实运行验证。** L1 只拦「语法坏了 / 签名漂移 / 关键开关被改」，
上面那四步冒烟才是真验收。

---

## 已知的开放问题（推理出来的，**尚未实测**）

### A1：`no-network` 任务能否被 `--allow-agent-host` 放通（部分实测）

`--allow-agent-host` 的语义是「merged into the agent phase **allowlist**」，
而 `no-network` 与 `allowlist` 是**互斥的两个模式**（allowed_hosts 只在 allowlist 模式下允许非空）。
所以很可能 merge 不进去。**`no-network` 那一半仍必须实测，不能推理。**

**已实测的一半（2026-08-27）：`PUBLIC` 模式下它被静默忽略。**
`hello-world` 是 `allow_internet = true`（→ PUBLIC），此时 Harbor 会 warn 并**丢弃**
整个 run-specific allowlist（`trial/network_policy.py:28-36`，实测该 warning 复现三次）：

```
UserWarning: Run-specific allowlist host(s) ['192.168.5.2'] are ignored
because the effective network policy is public.
```

判读要点：**PUBLIC 下容器本来就能出网，所以「被忽略」不影响连通** ——
第 1 步照样过。危险的是**反过来推理**：不能因为「第 1 步通了」就以为
`--allow-agent-host` 生效了。它在那一步压根没参与。
真正需要它的是 `allowlist` 模式的任务，而那一档尚未实测。

若确认不通：**该类任务从 dataset 排除，且排除的数量必须显式 log 出来。**
静默跳过 = 分母悄悄变小 = 分数虚高。（同时这说明 `no-network` 任务对**任何**
需要外部 LLM API 的 agent 都不可跑，不只是我们。）

### 网关侧还剩一个风险：挡住了 key 泄露，没挡住被薅额度

本设计把真实凭据留在宿主网关（容器里的 `settings.json` 只有占位 token），
所以 **key 不会进容器**。但容器里跑的是 benchmark 的任意代码，**它能访问这个网关**。
→ 网关侧需要 per-trial 预算上限与限流。这条必须说破，不能因为「key 安全了」就以为风险清零。

### `host.docker.internal` 不只在 Linux 上不存在 —— colima 下也不存在（已实测）

它是 Docker Desktop 的特性。**任何跑原生 dockerd 的环境都没有它**，
包括 Linux 宿主、CI，以及 **colima**（本机实测 `getent hosts host.docker.internal` 无解析）。
而 Harbor 起容器时**不加 `--add-host`**，所以指望它自己出现是不行的。

各环境的宿主地址：

| 环境 | 宿主在容器内的地址 | 实测 |
| --- | --- | --- |
| Docker Desktop | `host.docker.internal` | — |
| colima | `192.168.5.2`（= `host-gateway`） | ✅ 容器直连宿主 shim 可达 |
| Linux (bridge) | `172.17.0.1` | — |

```bash
export SID_HARBOR_GATEWAY_URL=http://192.168.5.2:4100   # colima
HARBOR_TELEMETRY=0 harbor run ... --allow-agent-host 192.168.5.2
```

不改的形态是容器里连不上网关 → 认证失败，而报错指向模型而不是指向这一行。

---

## 环境变量清单

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HARBOR_TELEMETRY` | *（Harbor 侧默认开）* | 设 `0` 关闭 Harbor 遥测。**每条命令都要带** |
| `SID_HARBOR_GATEWAY_URL` | `http://host.docker.internal:4000` | 容器内 `baseURL` 指向的宿主网关。⚠️ colima 下用 `http://192.168.5.2:<port>` —— **不是**容器默认路由 `172.17.0.1`（那是 VM 内的 docker bridge，宿主服务不在那上面；实测容器侧 connection refused） |
| `SID_HARBOR_BINARY_ARM64` / `_X64` | 空 | 显式点名要上传的 linux 二进制。**不设则按当前 HEAD 自动发现** |
| `SID_HARBOR_MODEL_ALIAS` | `harbor-gateway` | 容器内渠道别名（`availableModels[].name` 与顶层 `model`） |
| `SID_HARBOR_PROVIDER` | 从 `-m provider/model` 推 | 覆盖 provider（闭集：`anthropic`/`openai`/`ollama`/`replay`） |
| `SID_HARBOR_MAX_TURNS` | 40 | 等价 `--ak max_turns=` |
| `SID_HARBOR_MAX_BUDGET_USD` | 空 | 等价 `--ak max_budget_usd=`，per-trial 成本上限 |
| `SID_HARBOR_SKIP_PERMISSIONS` | **`true`** | 等价 `--ak skip_permissions=`。默认全放开（见下方「权限档」）。设 `false` 才走确认层 |

### 权限档：默认全放开，且这个代价必须说破

默认传 `--dangerously-skip-permissions`（布尔 flag）。**代价是这一轮评测测不到权限层** ——
skip 同时跳过 safetyCheck 与危险命令检测，它只是一个被记进 metadata 的必控变量，
**不是一条通过了的验证**。可接受的理由：容器无外网（走宿主网关）、跑完即销毁、
里面只有一个 benchmark 仓库。

为什么默认不是 `acceptEdits`：本机 10 题全量实测（源 `logs/permissions-audit.log`）
是 **144 次拒绝 / 178 次放行**，其中 111 次（77%）是 `acceptEdits` 不放行普通 bash
（`nproc` / `which git` / `qemu-img info` / `apt-get install` 全被拒）。
于是「40 轮预算用尽」读起来像能力不足，**真相是非能力原因混进了能力账**。

想专门观察防线（两者互斥，同时传会**拒绝启动**）：

```bash
harbor run ... --ak skip_permissions=false --ak permission_mode=acceptEdits
```

**判据一律看观测值，不看命令行。** 每个 trial 的 metadata 自带两组键：
`sid_permission_mode_requested`（我请求了什么，可能没生效）与
`sid_permission_denials` / `_allows` / `_decisions_total`（checker 实际判了多少次）。
零成本自证：

```bash
jq -r '.agent_result.metadata
       | [.sid_permission_mode_requested, .sid_permission_denials] | @tsv' \
  runs/<run>/*/result.json | sort | uniq -c
```

⚠️ 三个坑全是「请求了但没生效**且不报错**」，此时命令行看起来完全正确：
`bypassPermissions` 不是合法模式名（只 warn）、`always-allow` 绕不过路径验证、
`--permission-mode dangerously-skip-permissions` 碰不到 `config.skipPermissions`
（只有布尔 flag 会设它）。所以**只有审计日志的 deny 条数能证明档位真的生效了**。
日志缺失时落 `sid_permission_audit_missing=True`，与「零拒绝」严格区分 ——
后者是换档成功的判据，让一次采集失败伪装成它是最坏的。

**二进制来源是三级优先级，且第三级报错而不回落**：
① `SID_HARBOR_BINARY_*` 显式点名 → ② `dist/branch-builds/*-<当前 commit12>/sid-code`
自动发现 → ③ **报错并打印构建命令**。
不静默回落是刻意的：回落会让人以为跑的是他点名的那个包，
而**一次评测跑出的分数说不出「这是哪个 commit」就没有意义**。

### ⚠️ 架构：`build-branch-artifact.sh` 的输出目录名**不含架构**

同一个 commit 编 arm64 和 x64 会写进**同一个目录**，后编的覆盖前编的。
所以「按 commit 自动发现」只能拿到「上次编的那个架构」。

这在 Terminal-Bench 上必然踩到：**它的任务镜像只发 amd64**
（arm64 mac 上走 qemu，容器里 `uname -m` = `x86_64`），
而 `hello-world` 用的 `ubuntu:24.04` 是多架构的（本机是 arm64）。
于是「第 1 步过了，第 2 步 `exit 127`」——
**报错长得像二进制没装上，完全不指向架构**。

现在 `_resolve_host_binary` 会读 ELF 头校验实际架构并报死。
要同时跑两种架构的 dataset，把两个包分别存好再显式点名：

```bash
bash scripts/build-branch-artifact.sh --target bun-linux-arm64 --no-tarball
cp dist/branch-builds/*-<commit12>/sid-code /somewhere/sid-code-arm64
bash scripts/build-branch-artifact.sh --target bun-linux-x64-baseline --no-tarball
cp dist/branch-builds/*-<commit12>/sid-code /somewhere/sid-code-x64

export SID_HARBOR_BINARY_ARM64=/somewhere/sid-code-arm64
export SID_HARBOR_BINARY_X64=/somewhere/sid-code-x64
```

判读：`build.json` 里 **`arch` 是容器要求的（期望值），`arch_actual` 是从 ELF
字节读出的（事实）**。两者不一致时 `install()` 已经报死，
但字段留着 —— 只报期望值的字段会在期望与事实分叉时掩盖分叉。

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

### ⚠️ H2 的第一个坑：reward 在 `verifier_result.rewards.reward`

**不是** `verifier_result.reward`（实测那一层是 `None`）。取错的形态是
**每一题都读出 `None`**，而 `None` 在下游很容易被当成「0 分」或被 `or 0` 吃掉 ——
于是**整轮评测的分数全变 0，且不报错**。这正是 R1「verifier 恒返 0」的孪生形态，
只是坏在读取侧而不是判分侧。

```bash
python3 -c "import json,sys; d=json.load(open(sys.argv[1])); \
  print(d['verifier_result']['rewards']['reward'])" runs/<job>/<trial>/result.json
```

交叉验证的锚点是 `runs/<job>/<trial>/verifier/reward.txt`（verifier 自己写的那个数）——
**两个源读出来必须一致**。不一致就是读取路径写错了，不是分数变了。

---

## 验收清单

状态一栏只写**实测过的**。推理出来的一律算 ⬜ ——
「代码里写了」不是「跑过了」，这份接入的五个缺陷全部诞生于这个区别。

| # | 项 | 判据 | 状态（2026-08-27） |
| --- | --- | --- | --- |
| A0 | 遥测与 Hub 上传已确认关闭 | 见上「数据主权」表 | ✅ 已回源码核对 |
| A1 | `no-network` × `--allow-agent-host` | 实跑一个 `no-network` 任务 | 🟡 **一半**：PUBLIC 下实测被静默忽略（见 A1 节）；`no-network` 那档仍待实测 |
| A2 | `provider/model` ↔ 渠道别名映射正确 | 看轨迹里**实际发出的 wire model** | ✅ 容器内 `settings.json` 实测 `name=harbor-gateway` / `modelId=claude-sonnet-5`，`result.json` 的 `model_info` 一致，且**网关计数器涨了**（证明请求真到了那个 baseURL） |
| A3 | 装饰器顺序正确 | L1 门禁已机械化 | ✅ |
| A6 | `.py` 有门禁且经变异自证 | L1 + 变异自证 | ✅ 20 条断言，**L2 层现在真的在跑**（修好了解释器探测，见缺陷 #1） |
| A7 | `cost_usd` 非 0 且非 null | 第 1 步判据 4 | ✅ 实测 `0.0292507`，`sid_cost_source=stream-json-result` |
| A8 | build.json 的 commit 与 HEAD 一致 | 第 1 步判据 3 | ✅ 且 **`commit_source=artifact-bytes`**（首跑时是 fallback，见缺陷 #2） |
| A9 | oracle 满分 / nop 零分 | R1 双向对照 | ✅ 实测 oracle `1.0` / nop `0.0`，且 `ctrf.json` 显示 2 个测试真跑真 fail |
| A12 | 产物架构与容器架构一致 | build.json 的 `arch == arch_actual` | ✅ 实测（新增判据，来自缺陷 #5） |
| A13 | 真实 benchmark 上至少一题 reward > 0 | 第 2 步 | ✅ **2 题**（Terminal-Bench 10 题里，见上「第 2 步实测数据」） |
| A14 | 失败样本可被识别（不被记成 0 分） | `sid_is_error` / `sid_errors` 非 None | ✅ **已在真实 trial 上回归**（2026-08-28）：抓到一个 `reward=0` 而 `sid_is_error=False` 的样本，查下去是 **verifier 自己坏了**（详见下方「A10 首次对照」） |
| A10 | 三 agent 对照产出三份 results.json | 第 3 步 | 🟡 **两个 agent**（2026-08-28）：sid-code ↔ mini-swe-agent 均 reward 1.0、可比。claude-code **本机已解除封锁**（2026-08-28 复核：`downloads.claude.ai` 现可达，见「宿主网络三条硬约束」），未重跑 |
| A15 | `reward=0` 的样本已排除「判分未发生」 | `verifier/test-stdout.txt` 尾部无 `command not found` | 🟡 判据仍然必需。**残余误差已量化**：`-n 1` 时 verifier 坏掉 **1/10**、`-n 3` 时 **4/10**（2026-08-28 四轮 nop 对照，见坑 ⑤）。旧记的「3 次只成功 1 次」是**代理开启前**的数字，已不适用 |
| **A11** | **Harbor 数据驱动了一次真实的 harness 决策** | 一份 Agent Note：「因为看到 X 数据，所以改了 Y」 | 🟡 **有线索、判据不足**：静态前缀占 sid-code 成本 75%、输入 token 19.7× 于 mini-swe-agent —— 但只在一道 trivial 题上量过 |

> ⚠️ **A11 与「挖出 5 个缺陷」不是一回事。** 那 5 个是**接入自身**的缺陷
> （评测跑不起来），修它们不等于用评测数据改进了 harness。
> A11 要的是「Harbor 上的对照数据让我们改了 sid-code 的某个决策」——
> 那需要先有 A10 的对照。**不要把「链路通了」记成 A11。**

---

## A10 首次对照（2026-08-28）：拿到第一份可比数据

同题（`hello-world`）、同模型（`claude-sonnet-5`）、同容器、同 verifier、
**都不传提示模板**（两份 `config.json` 的 `prompt_template` 均为 null，R5 的必控变量成立）：

| | reward | 总输入 tok | 输出 tok | cost | 轮数 | agent 执行墙钟 |
| --- | --- | --- | --- | --- | --- | --- |
| **sid-code** | 1.0 | **45,803** | 62 | **$0.0374** | 2 turns | **12.0s** |
| **mini-swe-agent** | 1.0 | **2,328** | 83 | **$0.0049** | 4 steps | 15.3s |

**同样解对，sid-code 花了 19.7× 输入 token、7.6× 成本**（但快 3.3s ——
是**用 token 换速度**，不是又慢又贵）。归因：

```
45,803 输入 = fresh 1,005 + cache_write 11,212 + cache_read 33,586
                            ~~~~~~~~~~~~~~~~~~
                            系统提示 + 23 个工具定义 = 静态前缀
```

静态前缀 ≈ 11,212 tok，**比 mini-swe-agent 全程总输入还多 4.8 倍**；
按 sonnet 标准价复算，它占 sid-code 本次成本的 **75%**。

> ⛔ **上面这个 11,212 口径错了（2026-08-29 纠正），且整条线索已被真实数据否决。**
> `cache_write_tokens` 是**整个 session 的 cache 写入累加**，不是首调用的前缀。
> 同一道 hello-world 连跑三次：**首调用总 prompt 恒 22,950**，
> 而 `cache_creation` 摆动 3,442 / 8,491 / 4,360（**2.5 倍**）——
> 因为 read/write 的切分由服务端缓存还热不热决定，与前缀大小无关。
>
> **静态前缀只能用首调用的总 prompt**（`input_tokens + cache_read + cache_creation`）。
> 换成这个口径后，真实 benchmark 10 题上它占总输入的**中位数 2.4%**（判据要 >50%），
> 所以「砍工具定义」这个改动**不做**。详见方案文档 §15.1，
> 算法落在同目录 `analyze-prefix.py`。

⚠️ **缓存是在正常工作的**（命中率 73.3%，达标）。所以这**不是缓存缺陷，
是「被缓存的东西本身太大」**。这一条值得单独记住：
**缓存命中率达标可以与「成本高 7.6 倍」同时成立** ——
命中率只说明「重复部分没重复付全价」，说不出「重复部分该不该这么大」。

⚠️ **不要拿这个数去改代码。** `hello-world` 是 trivial 题（2 turns 解完），
短任务会系统性放大静态前缀占比。要在真实 benchmark 上复核（方案文档 §13.5 有命令）。

### 跑对照必须补的两个开关（§12.5 的命令里没有）

- **`--agent-setup-timeout-multiplier 8`** —— mini-swe-agent 要装 uv + 3 个包，
  默认 360s 在慢网络下不够（实测 `AgentSetupTimeoutError`）。**和
  `--verifier-timeout-multiplier` 一样，它不是可选的。**
- **`--ae "ANTHROPIC_API_KEY=..."` + `--ae "ANTHROPIC_BASE_URL=..."`** ——
  mini-swe-agent 的 `MODEL_CONNECTION` 只映射 `MSWEA_API_KEY`，
  但它内部的 litellm 认 `ANTHROPIC_API_KEY`。只设前者会失败，
  而**报错藏在 25k 字符 traceback 的尾部**。

⚠️ **对照 agent 会把真实 key 注入容器**（Harbor 官方 `MODEL_CONNECTION` 的既有行为），
而 sid-code 侧仍只带占位 token。这个不对称是刻意接受的（认证路径不影响解题能力），
**但跑完应轮换那把 key** —— 容器里 benchmark 的任意代码都能读到它。

### ⚠️ 本机 verifier 会随机坏掉，形态是 reward 0

`hello-world` 的 `/tests/test.sh` 要下载 uv（`github.com/astral-sh/uv/releases/...`），
本机实测 **3 次只成功 1 次**。失败时 `uvx: command not found` →
**一个测试都没跑** → reward 0。

抓到过一个 `reward=0` 而 `sid_is_error=False` / `sid_subtype=success` 的样本：
**sid-code 真的解对了，是判分没发生。** 只看 reward 的话，
它和「没解出来」**逐字节相同**。

> **口径铁律（A15，2026-08-29 已改写 —— 旧版判据在下方，别用）**：
> 判据是**正面证据** —— `verifier/test-stdout.txt` 里**有没有 pytest 收尾行**
> （`\d+ (?:failed|passed|error)`）：
>
> - **有收尾行 → 判分发生了**。无论 reward 是几、无论 agent 自述什么，**一律计分**。
> - **没有收尾行 → 判分未发生**，单独分桶、不进分母。
>
> ⛔ **旧版判据是「`reward=0` 且 `sid_is_error=False` → 排除」，它错了。**
> 方向对（reward 0 有两种，别混），但**主语选错**：`sid_is_error` 是 agent 的自述，
> 拿它推断 verifier 的状态是跨主语推断。那个条件同时覆盖两件语义相反的事 ——
> ① verifier 没跑成（该排除）；② **verifier 跑了判 0，而 agent 自我报喜**（该计分）。
> 实测踩到 ②：`configure-git-webserver` 上 sid-code 只写了一篇「怎么配置」的说明文字、
> 一步没执行，然后 `subtype=success` 收工，而 verifier 好好地跑完报了
> `1 failed in 22.79s`。**照旧判据会把它排除，等于给 sid-code 白送一分,
> 送的恰好是它最该被扣分的地方**（方案文档 §15.3 / §15.4）。
>
> `command not found` 那条判据**保留但要加前提**：`and not verifier_ran` ——
> 那些关键词可能只是某一个测试里的噪声，别的测试照样判了分。

⚠️ 顺带一处易踩的误读：`sid_*` 字段在 **`agent_result.metadata`** 下，
不是顶层 `metadata`。查顶层会看到 `{}`，**长得像接缝断了**，实际完好
（两个对照 agent 的顶层 `metadata` 也都是 `{}`，那是 Harbor 的正常形态）。

## A11 真实 benchmark 全量对照（2026-08-28/29）：10 题 × 2 agent

`terminal-bench-sample@2.0` 全 10 题，`-n 1 -k 1`，同模型/同容器/同 verifier、
都不传提示模板。两个 run 各自跑完（sid-code 4h10m、mini-swe-agent 约 5h30m）。

| | 判了分的题 | reward mean | 成本 |
| --- | --- | --- | --- |
| **sid-code** | 10/10 | **0.100** | $7.18 |
| **mini-swe-agent** | 7/10（3 题 agent 侧环境异常，已排除） | **0.714** | $4.92 |

⚠️ **两边分母不等**（mswea 有 3 题是 `AgentSetupTimeoutError` /
`NonZeroAgentExitCodeError`，它自己的环境失败，不是能力差）。
所以这组数**能**支持「同题上 sid 明显更弱」，**不能**支持 `0.100 vs 0.714` 这个比值本身。

同题逐条（两边都判了分的 7 题：**sid 赢 0、mswea 赢 5、2 题都是 0**）：

| task | sid reward | sid turns | mswea reward | mswea steps |
| --- | --- | --- | --- | --- |
| polyglot-c-py | 0.0 | 34 (max_turns) | **1.0** | **10** |
| regex-log | 0.0 | 34 (max_turns) | **1.0** | **10** |
| sqlite-with-gcov | 0.0 | 41 (max_turns) | **1.0** | 34 |
| fix-code-vulnerability | — (AgentTimeout) | — | **1.0** | 38 |
| chess-best-move | 0.0 | 40 (max_turns) | **1.0** | 55 |
| build-cython-ext | 0.0 | 40 (max_turns) | 0.0 | 127 |
| configure-git-webserver | 0.0 | 2 (**success**) | 0.0 | 25 |
| log-summary-date-ranges | **1.0** | 9 | — (环境异常) | — |

**混淆变量已拆开**：mswea 不受 40 步限制（用到 127 步）。按它解出时用了多少步分类 ——
**4 题它在 40 步内就解出**（两题只用 10 步），**只有 1 题（chess）超过 40**。
所以「40 上限」只能解释 5 题里的 1 题，**其余 4 题上限不是借口**。

⚠️ **34 轮不是空转**：`polyglot-c-py` / `regex-log` 各 33 次工具调用里 **32 个不重复**
（最多重复 2 次）。它每一步都在做新动作，只是**走的路比对照长得多** ——
方向不是「加循环检测」，是「为什么要走这么多步」。

⚠️ **`turns` 跨 agent 口径不同**：sid 的 `sid_num_turns` vs mswea 的 `total_steps`，
「10 步 vs 34 轮」**不是精确倍数**；但「40 装不装得下」这个同量级判断不受影响。

### 这批数据挖出的三个 harness 缺陷（都有 file:line 判据，均未修）

**① 🔴 被 watchdog 杀掉的轮次悄悄吃掉轮数预算**

全部 7 个 `error_max_turns` 样本上有一个严丝合缝的不变式：

```
num_turns + WatchdogKill 次数 = 41      （7/7 全部成立）
```

`regex-log` 报 `error_max_turns` 但 `num_turns` 只有 **34**，因为它有 **7 次
WatchdogKill**。根因是两个计数器各数各的：

- `packages/core/src/query/loop.ts:751-752` —— `while` 进来**第一件事**就
  `state.turnCount++`，**在发请求之前**；
- `packages/core/src/sdk/query-engine.ts:120-123` —— `num_turns` 只在
  `event.kind === "assistant_message"` 时 `++`。

于是被杀的轮次**占掉一格 maxTurns 预算、但在 `num_turns` 里完全隐身**。
后果：`regex-log` 实际只拿到 34 次真正的模型交互机会，却被报成「打满 40 轮」——
**「打满上限」与「上限够不够用」之间插了一层网络故障。**

**② 🟠 watchdog 与内层 retry 预算互相架空**

`regex-log` 第一次调用连着失败 7 个完整 watchdog 周期、零内容产出（`chunk_count: 0`）：

| watchdog 周期 | 内层 retry 最高用到 | 内层退避累计 | 被杀于 |
| --- | --- | --- | --- |
| 1 | **5 / 11** | 154s | 315,788ms |
| 2–6 | **4 / 11** | 75–78s | ~315,500ms |

**315s 的 watchdog 在内层 retry 只用掉 4–5/11 个 attempt 时就杀掉整个调用，
外层 `TimeoutRetry` 从 attempt 1 重开 —— 那 11 次预算永远用不完，
而每周期固定烧 315s。** 7 个周期 ≈ 37 分钟零产出（这就是那两题跑 50–60 分钟的来源）。

⚠️ 修它**别只是把 315s 改大** —— 仓库里已有「多层超时同为 300s，单点修复只换杀手」
「抬阈值治不了」两条教训。

**③ 🟡 超时的 trial 报 `cost_usd: null`，不是报已花的部分**

`fix-code-vulnerability` 撞 `AgentTimeoutError`，`result.json` 里 token / cost 全是
`null`（`sid_cost_source: "missing"`），但轨迹里有 **3 次成功调用、75,732 prompt tokens**
（按 sonnet 标准价 ≈ **$0.0807**）。

本次量级小（$7.18 → 真实 ≈ $7.26，低报 1.1%），**但低报幅度与超时 trial 比例成正比**，
而 `cost_usd: null` 会被下游求和**当成 0**。可修：兜底源 `AfterModelRaw.usage` 是完好的。

### 换档对照的六个脚本（2026-08-29/30）：判据都收敛到 `verifier_health.py`

```bash
bash run-permission-switch.sh <job名> [题名...]      # 跑（不给题名=全部 10 题）
python3 progress-permission-switch.py runs/<job>    # 跑动时看进度，每题当场报健康
python3 analyze-permission-switch.py runs/<job> [补跑job...]   # 判据①②③④⑤
python3 compare-paired.py runs/a11-sid runs/<job>   # 判据②：配对对照
python3 analyze-retry-cost.py runs/<job>            # 判据④：重试墙钟
python3 check-comparison-parity.py runs/<job> runs/a11-mswea   # 跨 agent 对照口径
```

**`verifier_health.py` 是三个判据的唯一定义处**，消费者一律 import，不许各写一份
（踩过：进度脚本与复算脚本各写一份 verifier 判据，同一题一个报 ✅ 一个报 ⛔）：

| 函数 | 问的是 | 取数源 |
| --- | --- | --- |
| `verifier_ran` | **verifier** 判分了没有 | `verifier/*stdout*` 的 pytest 结论行 |
| `agent_ran` | **agent** 跑过没有（三态，`None`=采集缺失） | `agent_result` 的 in/out token |
| `llm_fatal` | 是不是**被上游打断**的 | `sid_errors` + 日志里的重试链耗尽 |

#### 分桶规则有五条，后两条是 2026-08-30 实测补的

`reward=0` 有**五种**语义完全不同的来源，混在一起就是「非能力原因记进能力账」：

| 规则 | 排除什么 | 为什么 |
| --- | --- | --- |
| ① | verifier 没判分 | 判分未发生 ≠ 没解出来 |
| ② | `reward` 缺失 | 没有分可算 |
| ③ | — | 逐题表才是结论，别只看均值 |
| ④ | **agent 零 API 调用** | 网关 502 / 上游 403 额度耗尽，压根没碰过题 |
| ⑤ | **上游打断** | 跑了 3-8 轮（共 40）被 429 打空重试链，没机会做完 |

⚠️ 规则 ① **不能**照 §13.2 的字面写（`reward=0` 且 `sid_is_error=False`）——
那会错杀「agent 自我报喜但其实没做完」，而那正是最该扣分的一类失败。
⚠️ 规则 ④ 判据用 **token 不用 turns**（token 来自 Harbor 侧，turns 来自 agent 自述，
取观测方不取自述方），且 `None` 与 `0` 必须分开（用 falsy 会让基线 0.100 变成 0.111）。
⚠️ 规则 ⑤ 判据**不能只看 `subtype`**：`error_during_execution` 也包含 agent 自身崩溃
（真实缺陷，必须计分）。

#### ⛔ 两个均值不能直接并列 —— 用 `compare-paired.py`

复算脚本对两轮各自算出基线 **0.100（分母 10）**、换档后 **0.750（分母 4）**。
并列成「0.100 → 0.750」是**错的**：被规则 ④⑤ 排除的 4 题不在换档后分母里，
却**在基线分母里且全是 0.0** —— 两个均值的题目集不是同一批题。
`compare-paired.py` 强制**整对退出**（任一侧被排除，整对退出）、把「尚未跑」与
「跑了被排除」分开报、未跑完时**拒绝给结论**，并在结论行强制打印 n。

#### 跑前两道闸，第 2 道现在会自动执行

第 1 道（uv 下载速率 ≥500KB/s）见 `run-permission-switch.sh` 头注释。
第 2 道**上游错误率**原来只是一句「curl /__stats 看看」，没有任何东西真的去测 ——
那一轮直接开跑，**10 题里 4 题报废**（实测当时错误率 35%）。现在脚本会自动跑：
20 连、间隔 3s，非 200 占比 **> 20% 直接拒绝启动**。

- ⚠️ **别测「能不能连上」**：单发探针几乎总是 200，要测的是错误率。
- ⚠️ **别指望重试链兜住**：同一轮 `fix-code-vulnerability` 吃了 39 次 429 仍拿 1.0，
  `build-cython-ext` 吃了 30 次就死了 —— 35% 下能不能活是抛硬币，不是阈值。
- 强跑：`SID_HARBOR_SKIP_PREFLIGHT=1`（脚本会警告本轮数据可能混入故障样本）。
- 自证这道闸时用 `SID_HARBOR_PREFLIGHT_N=5 SID_HARBOR_PREFLIGHT_GAP=0`
  （默认 60s，反复自证会把验证本身跑超时）。

#### 补跑：基础设施故障不必重跑全部 10 题

```bash
bash run-permission-switch.sh permswitch-r3 polyglot-c-py regex-log   # ~$1，而非 ~$7
python3 analyze-permission-switch.py runs/permswitch-r2 runs/permswitch-r3
```

多 job 合并时**同题靠后覆盖靠前**，且表里会多出「出处」列。
不标出处就是把两批不同时间、不同上游状态的数据无声混进同一个分母。

---

### 分析脚本：`analyze-prefix.py`

```bash
python3 analyze-prefix.py runs/a11-sid runs/a11-mswea-r2
```

它把 Harbor 产物与 trial 内 sid-code 轨迹汇总成那两个比值，
**每个数字都指到一个源字段**（运行时会打印 `FIELD_SOURCES`），
并机械执行分桶规则。**它不重算 sid-code 已有的任何指标** ——
digest 的输入是宿主 `~/.sid-code/`，而 trial 轨迹是 10 份互不相干的 session。

⚠️ **`colima` 有两个 profile，别启错**：`colima start` 默认起 `default`（空的、19G root），
而镜像和 dockerd 的 proxy drop-in 都在 **`swebench`** profile（157G/45G）。
起错的形态是「零镜像 + proxy 配置消失」，**看起来像整个环境丢了**。正确姿势：

```bash
colima start swebench && docker context use colima-swebench
```

---

### 网关 shim 的落点已从 `/tmp` 改到 `~/.local/share/`

`/tmp` 那个落点保证了「每一棒都要重建一次」（第三棒接手时实测已丢失）。
现在在 `~/.local/share/sid-harbor-gateway/gateway.py`，**仍然不入库**
（宿主侧基础设施；入库会引诱人把开发期 shim 当生产网关用）。

⚠️ **上游选择有坑**：本机两个可用上游里，`uniapi` 在**容器发起的真实请求**上
持续吐 Cloudflare 502（`__stats` 的 `upstream_502` 计数 6 次），
而宿主侧用相同 payload 复现**全部 200**。换到 `ppchat` 上游一次就通。

> **形态：宿主侧复现全绿，不等于容器侧那条路健康。**
> 判据应该是网关计数器（`GET /__stats` 的 `upstream_502`），
> 不是「再试一次看看」——按后者判断会白跑两轮（3m08s + 8m44s）。

---

## 设计决策的事实源

完整的「决定了什么 / 放弃了什么（以及为什么不选）/ 拿什么证明它生效了」在
`.agents/notes/proposed/testing/2026-08-27-harbor-接入设计.md`。

**改这份接入之前先读那份 Note 的第二段** —— 那里记了八件被否决的事及其理由
（source/local/published 安装模式、`MODEL_CONNECTION` 注入、`--output-format json`、
pytest、prompt 模板、在 Harbor 侧重算指标、迁移 `grade.ts`、首版 resume/handoff/ATIF）。
否决论证不落盘的代价是：下一个人明天重新提议同一件事，而你要把整套论证重做一遍。
