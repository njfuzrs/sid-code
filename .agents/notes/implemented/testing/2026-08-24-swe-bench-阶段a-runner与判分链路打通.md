---
Status: implemented
Date: 2026-08-24
---
# SWE-bench 阶段 A 主体：数据现取 → prompt 契约 → runner → patch 硬检查 → 官方判分

## 决定了什么

`接入计划.md §6.3` 第 2–7 步落地为一组文件（PR4）。这几步**必须合成一个 PR**：
拆开任何一刀都留下「跑不出结果」的半成品，不可独立上线。

| 步 | 产物 | 职责 |
| --- | --- | --- |
| 2 数据现取 | `fetch-instance.py` | 题面/`base_commit` 从 dataset 现取，白名单字段，id 不存在即硬失败 |
| 3 prompt 契约 | `prompt-v1.txt` | 只给题面原文 + 禁改测试文件一句，带版本号入库，写死不再改 |
| 4 gold 自检 | `exec-swebench.sh gold` | 把「环境错」与「能力差」分开 |
| 5 runner | `exec-swebench.sh run` + `runner.ts` | 容器编排（搬运）+ subset/prompt/patch 判定（有单测） |
| 6 patch 提取 | `record.ts` | 工作树 diff + `patch_touches_tests` 硬检查 |
| 7 判分 | `exec-swebench.sh grade` + `grade.ts` | 调官方 harness，映射六类结果 |

外加一个方案里没有的文件：**`pull-image.sh`**（断点续传拉镜像），
理由见下面「拿什么证明它生效了」第 3 条 —— 没有它这条链路一题都跑不起来。

**分层原则：判断放 TS（有单测），搬运放 shell。**
`docker cp` / `docker exec` 包进 TS 只会让出错时多一层壳要剥；
而「哪些路径算测试文件」「ungraded 怎么算」是判断，必须有单测守着。

**三条核心不变量**（每条都有单测 + 变异自证，即「把逻辑改成错的写法，断言必须因此变红」）：

1. **`ungraded` 不许折叠成 0。** report 读不回来时 `findReport` 返回 `null` 而不是 `{}`，
   `buildAcceptance` 会把 `graded_ok` 判假并在 `unaccounted` 里写明「判分没发生」。
   返回 `{}` 会让下游以为「判分发生了，只是全没解出」—— 那就是假 0%。
2. **验收 schema 里没有百分比字段**，且渲染层也拦 `数字+%`。
   约束落在类型与渲染两层，不落在「大家别算百分比」这句话上。
3. **「agent 失败」与「没有 patch」是两件事。** 提取脚本与 agent 脚本分两次 exec，
   超时但已产出 patch 仍记 `patch_produced`。

## 放弃了什么（以及为什么不选）

**放弃 `--namespace ''` 本地重建镜像（原 D3 的手段）。**
不是改主意，是**那个选项在 swebench 5.0.2 里已被删除**：

```
Error: No such option: --namespace (Possible options: --instance)
```

方案文档 §5 与官方旧 README 都写着它，照抄会在第一条实例就挂。
5.0.2 的替代 `--task-repo` 需要一个逐实例 Dockerfile 的外部仓库，
官方没给默认值、本仓没有那份 task repo，且它内部走 `git clone github.com/...` ——
**本网络 github 不可达**。所以本地重建这条路当前是不通的，不是不想走。

**放弃配 daemon `registry-mirrors` 拉官方镜像。**
实测它会**静默挂死**：`docker pull` 挂 20+ 分钟、零字节、stdout 一行不输出。
唯一线索在 daemon 日志：`Host doesn't match cfgHost=registry-1.docker.io host=docker.1ms.run`
—— docker 的 auth 不接受镜像站的 realm 重定向，**但它不报错**。
改为把镜像站当普通 registry 直接引用（`docker.1ms.run/swebench/...`）。

**放弃「给 docker pull 加重试」这个更省事的方案。**
改对 registry 引用后仍会 `short read: expected 414927911 bytes but got 10141808: unexpected EOF`。
根因是镜像站限速（起初 7.2MB/s，几分钟后掉到 3.8KB/s；同一时刻单跑 curl 一样慢，
所以不是 docker 的问题也不是网络故障）+ **docker pull 不做断点续传**，
单个 415MB 层断流就整层重来。在限速下「一次拉完」是小概率事件，重试解决不了。
改为 curl `-C -` 逐层续传 + 校验 sha256 + 拼 OCI layout + `docker load`。

**放弃 sb-cli / Modal（原判断，仍然成立）。** 二者都要把 predictions
（含我们 agent 产出的完整 patch）或二进制/轨迹送出去，破「数据主权」这条北极星特性。

**放弃在 `verified-subset.yaml` 里存题面。** 除了「题面属于外部数据」，
更实际的理由是**入库副本会漂移**：dataset 换 revision 时题面可能改，
我们喂 agent 的那份不会跟着改，于是它与官方判分依据的那份不是同一个东西，
**而这件事不会报错**。

**放弃用通用 YAML 库解析 subset。** 那个文件是脚本生成的、形状由
`render_yaml` 定死；引通用解析器反而让「形状变了但还能解析出半个结果」成为可能。

## 拿什么证明它生效了

1. **单测 64 例 / 176 个 expect，全绿**（`tests/eval/swe-bench-runner.test.ts`），
   其中 5 条是**变异自证**：先证明错误写法确实会得到错误结果，再证明正确实现不会。
   没有这一步的断言说不清它拦的是真行为还是恒真表达式。
   加上 preflight 的 50 例，`tests/eval/` 下 SWE-bench 相关共 114 例。

2. **数据阻塞已消除，且是靠实测消除的。**
   `verified-subset.yaml` 从手挑改为 `select-subset.py` 生成（`TODO_S8_FILL` 从 11 处降到 0）。
   校验实测抓出：手挑 10 条里 **3 条 id 在 dataset 里根本不存在**，
   候选池 5 条里**也有 3 条不存在**（所以那个兜底同样不成立），
   存活 7 条里 `psf__requests-2317` 的 F2P 实际是 8 条、违反 yaml 自己的「≤5」标准。
   现在 10 条全部 `fetch-instance.py --validate` 通过，
   且负向对照（喂一个已知不存在的 id）确实 exit 1。

3. **镜像来源已实测打通到「能续传」这一步。**
   `pull-image.sh` 对 `pytest-dev__pytest-7982`：210MB 层已完整校验通过，
   415MB 层在限速下持续续传（1.5MB → 2.8MB → 11MB，断了不重来）。
   这条是从「零字节挂死 20 分钟」和「29.5 分钟后 EOF 整层作废」两次失败里换来的。

4. **环境三项容量已达标**：colima `swebench` profile = 8 核 / 16GiB / 160GiB
   （官方 README WARNING 要求 ≥8 核 / 16GB / 120GB）。
   ⚠️ 量的是 **daemon 侧**，不是宿主机 —— 原方案「实测 602GB 可用」量错了卷。

5. **防作弊设施在真实容器里验过行为，不只是拓扑。**
   `net-setup.sh --check` exit 0；从 internal 网内实测：名单内域名 HTTP 401
   （**到达了，鉴权拒绝 = 正确**），`github.com` / `pypi.org` 均 `000`（被拦）。
   §5.1 的依据：实测 25% 的 rollout 会试图用 `git log` 找答案 ——
   不做这个，分数不可信。

## 尚未证明的（不隐藏）

**§6 那五个验收字段还没有一次真实的取值**（`link_ok` / `graded_ok` / `gold_ok` /
`solved_count` / `patch_touches_tests`）。原因是第 3 条那个镜像还没拉完 ——
在限速下单条镜像是**小时量级**。

这意味着 PR4 交付的是**链路与判定逻辑（有单测覆盖）**，
而不是「10 题跑出了一个数」。按 §7 的回滚口径，
下一步是先把 1 条走通（`gold` → `run` → `grade`），再扩到 10 条。

⚠️ **这份 Note 刻意不把「单测全绿」写成「链路已验证」。**
那正是本仓反复踩的那个坑：`preflight.ts` 的 ④ 曾经因为
`swebench eval` **报错时仍然 exit 0** 而差点被判 pass。
判据必须是「真跑出了那五个字段」，不是「代码写完且测试绿」。
