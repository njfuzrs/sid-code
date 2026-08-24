---
Status: implemented
Date: 2026-08-24
---
# SWE-bench preflight 五项断言落地，且「不可执行」单独成档不折叠成「通过」

## 决定了什么

阶段 A 第 1 步（`接入计划.md §4.1`）落地为 `evals/external-benchmarks/swe-bench/preflight.ts`
+ `tests/eval/swe-bench-preflight.test.ts`（44 例）。**它是独立可上线的** —— runner 还没写，
但它自己就是一个「环境到不到位」的检查器，且失败即停。

**核心决定是判定分三档而不是两档**：

| 判定 | 条件 | 退出码 |
| --- | --- | --- |
| `PASS` | 五项全 pass | 0 |
| `FAIL` | 任一项 fail | 2 |
| **`INCOMPLETE`** | 无 fail 但有 skip（前置缺失，断言没跑成） | **3** |

第三档是本 PR 最重要的那个决定。①②③④ 需要 docker daemon / 已装 `swebench` /
第 2 步产出的 `base_commit`，本机全都不满足。**两档设计下这些会静默变成绿灯** ——
那正是被否决的路径 A 那个 `return Score(value=0)` 的同型换了位置：一份「五项全绿因为
四项都没真跑」的 preflight 比没有 preflight 更坏，因为它看起来在保护你。

**每一项的判据都刻意选了严格的那个**，配套的宽松判据全部记进注释以防被改回去：

| 项 | 判据 | 明确**不**用的判据 |
| --- | --- | --- |
| ① 运行期网络隔离 | `network inspect -f '{{.Internal}}'` == `true` | 「network 存在」—— 存在但非 internal 照样出网 |
| ② 构建期/运行期分离 | 运行期 `Internal=true` **且** 构建期 `Internal=false`；同名直接 fail | 只查一头 |
| ③ 镜像内无 fix commit | `HEAD==base_commit` **且** `git status --porcelain` 为空 | 只查 HEAD |
| ④ 镜像可构建性 | `--gold --namespace ''` exit 0，**并落 `elapsed_ms`** | 只要布尔值 |
| ⑤ flag 真被接受 | 跑编译产物逐个探，**外加一个合成 flag 必须被拒绝** | grep 源码 / `--help` 里列着 / node 跑 parseArgs |

⑤ 那个合成 flag（`--sid-preflight-canary-nonexistent`）是探针的变异自证：若哪天二进制把
未知选项改成静默忽略，「必需 flag 全通过」就毫无信息量 —— 此时报 fail 并说明探针失效。

顺带**纠正 D3 的一处前提**（见下方证据②），并把 `run-external-baseline.ts` 那条
「路径 B 的 preflight 由接实跑那个 PR 落地」的过期注释改成指向本文件，同时**刻意不调用它**。

## 放弃了什么（以及为什么不选）

**放弃两档判定（pass/fail），这是主要的否决项。** 两档下 skip 只能并进 pass 或并进 fail：
并进 pass 就是上面那个假绿灯；并进 fail 则会让「本机没装 docker」和「网络没隔离」
长得一模一样，人第一次跑就看到一片红，接下来必然去找绕过它的办法 —— 一个被绕过的门禁
等于不存在。三档是唯一能同时满足「不撒谎」和「可用」的分法。

**放弃「本机不具备条件就不做这一项」。** ①②③ 在本机（macOS arm64、colima 停着）
本来一个都跑不了。但 preflight 的价值恰恰在阶段 A 第一天就能跑 —— 所以做法是让每项
**在能跑时真跑、不能跑时如实报 skip**，而不是等环境齐了再写。实测这个决定当场就有回报：
起了 colima 之后 ①②③ 立刻可验，还捞出了下面那个量错卷的前提错误。

**放弃「断言已知不可用的 flag 必须被拒绝」。** 想过把 `--no-session-persistence` 报错
写成断言，否决理由是：哪天那个 bug 修好了，这条断言会变红并逼人改测试 —— 本仓管这个叫
false gate。改为登记进 `KNOWN_UNUSABLE_FLAGS` 只作提示、不参与判定。

**放弃把「daemon 容量不达标」做成第六项断言。** 五项是 §4.1 定死的口径，不该由实现悄悄扩；
而且 Linux 上 daemon 直接用宿主盘、容量本来就够，硬拦会在那类机器上误报。
改为在 ④ 的 detail 里**只报不判**（`probeDaemonCapacity`），把官方最低要求一起打出来。

**放弃在 `run-external-baseline.ts` 里直接调用 preflight。** 那个脚本还是骨架
（`runExecTrack` 硬编码 `pass: 0`）。在一个产不出真数字的链路上跑防作弊断言，
只会让它看起来已经接上了 —— 只加了一条「preflight.ts 存在」的文件断言。

**放弃在本 PR 里做第 2 步的数据现取。** ③ 需要 `base_commit`，很容易顺手把取数一起做掉，
但那是第 2 步、属于 PR4；本 PR 的边界是「preflight 可独立上线」。缺参数时 ③ 报 skip
并在 reason 里点明它由第 2 步产出。

## 拿什么证明它生效了

**① 44 例单测全绿，且每组都配了反向用例**（只断言 happy path 无法区分「逻辑对」与「函数恒返 ok」）：

```
$ bun test ./tests/eval/swe-bench-preflight.test.ts
 44 pass / 0 fail / 89 expect() calls   [19.00ms]
```

**② 真跑三种环境形态，判定确实会翻转**（不是靠假 Runner 推的）：

```
$ bun run .../preflight.ts                                   # 缺网络参数
判定: FAIL          EXIT=2      ← ① ② 报 fail（配置错误，不是环境限制）

$ ... --run-network a --build-network b --proxy http://p      # 参数齐、colima 停着
判定: INCOMPLETE    EXIT=3      ← ①②③④ 全 skip，⑤ pass。**没有冒充通过**

$ colima start && docker network create --internal sid-pf-run
$ docker network create sid-pf-build
$ ... --run-network sid-pf-run --build-network sid-pf-build --proxy http://p
  ✅ 1.  run_internal: true
  ✅ 2.  run_internal: true / build_internal: false
判定: INCOMPLETE    EXIT=3      ← ③④ 仍 skip
```

⚠️ 第二条那个 EXIT=3 的前提是 **docker 停着**。docker 起着时同一条命令是 **EXIT=2**（FAIL）——
因为 network `a`/`b` 不存在，`inspect` 失败，那是真 fail 而不是「没能力检查」。
两者的区别正是这套三档想表达的东西：**「问不到」与「问了但答案不对」不是一回事。**

**③ ①②③ 的变异自证是在真 docker 上做的**，不只是单测里的替身：

- 把两个 network **对调**（运行期给非 internal 的那个）→ ① ② 双双转 ❌，
  reason 是「network 存在但 Internal=false —— 非 internal 的 network 照样能出网，等于没隔离」。
- ③ 造了三个 alpine fixture 镜像（`/testbed` 里一个 git 仓库）实跑：
  - `:clean`（HEAD==base、树干净）→ ✅
  - `:fixcommit`（多一个 "upstream fix" 提交）→ ❌「HEAD=87f4616… ≠ base_commit=3817905… 答案可能已经在镜像里」
  - `:dirty`（HEAD 不动，只改工作树）→ ❌「HEAD 对得上但 /testbed 工作树不干净」
    —— **这一条正是「只查 HEAD」会漏掉的形态，现在被真镜像证明抓得到**。
  三个 fixture 镜像与两个 network 已 `docker rmi` / `network rm` 清理，验证过无残留。

**④ ⑤ 在本机真编译产物上是 pass，且探针不是空转的**（这一项本机能真跑，不是 skip）：

```
✅ 5. required_flags: -p, --max-turns 1, --settings <path>, --permission-mode acceptEdits
      known_unusable: --no-session-persistence (已拒绝), --user-query (已拒绝),
                      --workdir (已拒绝), --headless (已拒绝), --trace-out (已拒绝)
```

后四个正是路径 A 脚手架 `sid_code_solver.py:97-108` 凭空写的那四个 flag ——
**preflight 现在会当场拦住它们**，这就是「做成断言比在文档里记一条注意事项可靠」的落地。
另实测 `--help <flag>` 探测在 `SID_CONFIG_DIR` 下写 **0 个文件**，所以逐 flag 探测是安全的。

**⑤ 一处实测纠正（方案文档里的「现状」有错，已改）**：D3 写「磁盘够 —— 实测 602GB 可用」，
但那 602GB 是 **macOS 宿主盘**，镜像其实落在 docker VM 里。实测 colima VM：

```
$ docker run --rm alpine df -h /     →  97.9G 总 / 83.1G 可用
$ docker info                        →  4 cpus / 7.7 GiB mem
官方 README WARNING                  →  ≥120GB 磁盘 / 16GB RAM / 8 核
```

**三项全部不达标。** 不改 D3 的结论（10 题不是全量 500 题），但把「磁盘够」从已验证前提
降级为待验证 —— 真正的判据是 ④ 那次单实例构建能不能成，不是任何一个盘的剩余空间数字。
`接入计划.md §5` 已补这个框，④ 的 detail 现在直接打 daemon 侧容量 + 官方最低要求。
这条正是本仓那个教训的又一例：**引用「现状」要回源核，不要照抄文档**。

**⑥ 回归与构建**：

```
$ bun run affected-tests:run     # 判定为 ./tests/eval/（evals/ 与 tests/eval/ 的映射）
$ make build                     # 构建 + 产物自检
$ bun run evals/scripts/run-external-baseline.ts --track exec --validate  # 3 项前置 ✅
```

**待验证（不能现在声称）**：④ 从未真跑过 —— arm64 单实例镜像构建耗时**至今没有数字**，
它需要先装 `swebench`。③ 只在自造 fixture 上验过，没在真 SWE-bench 镜像上验过
（`__` 会被 harness 改写成 `_1776_`，image key 不是能 pull 的那个名字）。
这两项由 PR4 补，本 Note 不把它们记成已完成。

见 [[2026-08-24-swe-bench-阶段a-二值smoke方案]]、[[2026-08-24-swe-bench-接入路径a-inspect-否决]]。
