---
Status: implemented
Date: 2026-08-25
---
# patch 缺尾换行被 GNU patch 整份拒收，吃掉一条真实修复（+ baseline 产物接进发布链）

## 决定了什么

跑满 10 题（`smoke-2`）之后发现的**两个仪器问题**，各吃掉一条真实修复。
本 Note 记的是修复本身，跑分数字在方案文档 §附录 ZZZ。

### 1. `normalizePatch()`：patch 末尾必须恰好一个换行

`record.ts` 原来写 `diff.trimEnd()`，把 diff 末尾的换行一起剥了。
容器里的 **GNU patch 2.7.6** 因此拒收整份补丁：

```
patch unexpectedly ends in middle of line
patch: **** malformed patch at line 34        (exit=2)
```

归一化逻辑放 `runner.ts`（有导出、有单测），`record.ts` 只调用 ——
`record.ts` 是顶层脚本，逻辑留在那里就没法测。

**空 diff 必须保持空字符串**：给空串补换行会让 `patchBytes` 从 0 变 1，
`deriveOutcome` 就把一个 `no_patch` 误判成「有 patch」。这条有单测，
且串到 `deriveOutcome` 上确认不变量真守住了。

### 2. agent 输出落盘（`<iid>.agent.log`）

`agent_out` 一直被捕获却从没写出去。排查那两条 `no_patch` 时，
除了「67 秒就 exit 1」之外**一条线索都没有**。
ZZ.5 第 4 条那条判据（「看起来像能力差的先当环境故障查」）要能执行，
前提是看得到 agent 说了什么。

### 3. `linux-x64-baseline` 接进 `release.sh` 的 TARGETS

`exec-swebench.sh` 的 `artifact_for()` 查找路径 ②
（`dist/release/<ver>/sid-code-<ver>-linux-x64-baseline.tar.gz`）
在此之前**指向一个没有任何东西会产出的文件** —— 每次跑评测都得手编一个扔 `/tmp`，
而 `/tmp` 会被清掉。加了这条 target 后它由发布流程正常产出。

连带修一处：`RG_VENDOR_FILE` 要剥 `-baseline` 后缀（`${PLATFORM%-baseline}`）。
rg 的 vendor 文件按平台命名、没有 baseline 变体；不剥的话会去找不存在的
`rg-linux-x64-baseline`，然后走 warn 分支 —— 产物**静默不含内嵌 rg**，
症状要到运行时才出现（回退系统 rg，容器里通常没装）。

### 4. `logs/` 进 .gitignore

官方 harness 的判分日志，实测 10 题 + 10 条 gold 就 **7.4MB**，全是第三方仓库测试输出。
是「不入库」不是「可以删」—— 排查判分失败时它是**唯一**线索源
（`malformed patch` 只出现在 `run_instance.log` 里，`report.json` 的
`failure_reasons` 是空的）。

### 5. 全角标点门禁的「bash 实测」那条，改成先探测平台再分流断言

本 PR 新加的 `tests/scripts/shell-fullwidth-var.test.ts` 最后一条断言了
「裸 `$VAR` 紧跟全角标点在 `set -u` 下**一定**失败」。**这个前提是错的**，
它让 PR #116 的 CI 在 ubuntu 上红、macOS 上绿（`expect(bare.status).not.toBe(0)`
实际收到 0）。

真相是这个行为**由 libc 决定**，既不是 bash 版本、也不是 locale：

| 平台 | bash | 裸写法 + `set -u` |
| --- | --- | --- |
| macOS | 3.2 与 5.3 **都一样** | 全角字节被吞进变量名 → exit 1 |
| Linux glibc | 5.1 | 变量名解析到 `$code` 就停 → 正常输出、exit 0 |

Linux 侧在 `LC_ALL` 取 unset / `C` / `C.UTF-8` / `en_US.UTF-8` **四种下全部 exit 0**，
所以它不是「CI 里 locale 没设」，**改 env 修不了**。

改法是先用**不带 `set -u`** 的探针看当前平台怎么切变量名边界
（吞了 → `$code，` 整体成为未定义变量名 → 展开为空、输出里没有 `7`），再按平台分流断言。
**全仓扫描那条门禁保持全平台生效** —— 维护者在 macOS 上开发、`release.sh` 也在
macOS 上跑，一处违规就够让它中途退出，不能因为 Linux 上碰巧无害就放过。

连带修掉同一条里第二个环境依赖：原本断言 `stderr` 含 `"unbound variable"`，
而 bash 的诊断文案跟着 `LC_MESSAGES` 走 —— 中文 locale 下是「未绑定的变量」，
在维护者本机直接失败。改为只断言「报错且点到了变量名」，不断言英文原文。

## 放弃了什么（以及为什么不选）

**放弃「给 CI 统一设 `LANG=C.UTF-8` 把两个平台对齐」。**
这是看到「macOS 绿 / ubuntu 红」时最自然的猜测，但实测直接否掉了它：
Linux 上四种 locale 全部 exit 0，差异根本不在 locale 层。
真按这个思路改，会得到一条「设了 env 但依然红」的提交，
以及一个从此与真实原因脱节的 CI 配置。

**放弃直接删掉这条 bash 实测、只留静态扫描。**
删了最省事，CI 立刻绿。但这条是整份门禁里**唯一**证明
「这不是理论问题、真的会炸」的证据 —— 静态扫描只能证明「仓库里没有这种写法」，
证明不了「这种写法有害」。下一个人完全可以质疑门禁本身是不是过度谨慎，
那时需要的就是这条能跑的实测。

**放弃 `if (process.platform === "darwin")` 这种按平台名硬编码分流。**
判据应当是**行为**而不是平台名：真正决定结果的是 libc 怎么切变量名边界，
而 platform 名与 libc 只是相关、不是等价（musl、FreeBSD、将来的 CI 镜像都可能打破它）。
探针只多花一次 `spawnSync`，换来的是「换了环境自动跟着走」而不是「换了环境静默判错」。

**放弃「提取 patch 时排除 agent 自建的调试脚本」。**
`smoke-2` 那两条 `grader_error`（django-15128 / matplotlib-20488）的 patch 里
只有 agent 建的 `repro/` 目录，一行源码都没改。看着像该在提取时过滤掉。

不做，理由是**归因方向**：提取时排除等于替 agent 打扫，会掩盖它的行为特征。
「agent 卡在复现阶段、只留下调试脚本」是一个**该被看见的信号**，
滤掉之后那两条会变成干净的 `no_patch`，而 `no_patch` 读起来像「没想出办法」——
和「想了、试了、卡在复现」是两件不同的事。如果要约束，该由 prompt 约束
（「不要在仓库里留调试文件」），那是在源头改行为而不是在报告里粉饰。
已作为待办留给下一棒（方案文档 §ZZZ.5 第 3 条）。

**放弃用「跑一遍 patch 命令」做单测判据。**
单测断言的是**字节形态**（`endsWith("\n")`），不是真跑 `patch`。
因为 macOS 宿主自带 **BSD patch，它容忍缺尾换行** —— 实测 bare / withnl
两个版本在宿主上都 `exit=0`。跑命令的单测在 mac 上会**假绿**，
而判分发生在容器里。这正是「本地跑通了」在这件事上完全没有说服力的原因。

**放弃把 `linux-x64-baseline` 做成 Makefile target 或临时脚本。**
它需要在**每次发布**时存在（评测按 `package.json` 的版本号去 `dist/release/<ver>/` 找），
挂在 Makefile 上等于要求人记得在发布后补一次。

## 拿什么证明它生效了

### `normalizePatch`：端到端变异自证，变量只有一个字节

同一份 `extract.raw`，只重跑 `record.ts`（agent 不重跑），再交官方 harness 判分：

|  | 修复前（`smoke-3`） | 修复后（`smoke-4`） |
| --- | --- | --- |
| `error_ids` | `['django__django-13964']` | `[]` |
| `resolved_ids` | `[]` | `['django__django-13964']` |
| patch 字节数 | 1931B | 1932B |

那条 patch 改的是 `django/db/models/base.py`（真实源码，不是调试脚本）——
**一个被工具链 bug 吃掉的真实修复**，补上换行就 solved。

容器内直接对照（`docker exec` 跑 GNU patch 2.7.6）：

```
--- dj-bare:  exit=2   patch unexpectedly ends in middle of line
                       patch: **** malformed patch at line 54
--- dj-fixed: exit=0   两个文件都打上
```

宿主同一份 patch 两个版本都 `exit=0`（BSD patch 2 个版本均容忍）——
**这就是为什么本地测不出来**。

### 单测

`tests/eval/swe-bench-runner.test.ts` **82 例 / 215 expect** 全绿，
其中 `normalizePatch` 5 例含关键的变异自证一条：
`normalizePatch("")` 必须返回 `""` 而非 `"\n"`，
并串到 `deriveOutcome` 上确认仍判 `no_patch`。

`\ No newline at end of file` 标记不被吃掉也有断言 —— 它是 diff 语义的一部分。

### baseline target

- `bun build --compile --target=bun-linux-x64-baseline` 实测 `exit=0`，产物 104.7M。
- **体积代价是负的**：baseline 104.7M vs 常规 105.6M（少 0.9M，bun 1.3.14）。
  原先注释里写的「只多约 4MB」是错的，已按实测改掉 ——
  否则下一个人会拿体积当理由把它删掉。
- 下游三处确认不受影响：上传是 `for f in "$VERSION_DIR"/*` 通配（自动带上新 tarball）、
  `install-template.sh` 只按 `uname` 拼 `linux-x64` / `linux-arm64`（永远拼不出 `-baseline`）、
  `SELF_PLATFORM` 冒烟只匹配本机平台。
- `bash -n scripts/release.sh` 通过；`tests/build/` + `tests/release-flow-contract.test.ts`
  **114 例全绿**。

### 全角标点门禁：两个平台的分支都实际走过一遍

macOS 侧（本机，bash 3.2 与 homebrew 5.3）：

```
$ bash -c 'code=7; echo "[$code，]"'      →  [??]      （吞了，探针判 swallows=true）
$ bash -c 'set -euo pipefail; code=7; echo "exit=$code，不可信"'
   → exit 1, stderr: bash: 行 1: code<乱码>: 未绑定的变量
```

Linux 侧（glibc bash 5.1，容器内逐条复算测试的三个断言输入）：

```
sniff.stdout=[[7，]]     → includes('7')=true  => swallowsFullwidth=FALSE（走 else 分支）
bare.status=0                                  （else 分支要求 === 0）✓
braced.status=0  braced.stdout=[exit=7，不可信] （跨平台恒定那半）✓
```

`bun test ./tests/scripts/shell-fullwidth-var.test.ts` 在 macOS 上
**7 pass / 0 fail**（修改前是 6 pass / 1 fail，失败的正是这条）。

⚠️ 一条自我限制要写明：Linux 分支是在容器里**逐条复算断言输入**验证的，
不是在容器里真跑 `bun test`（那个镜像没有 bun）。所以「Linux 上这条测试通过」
这个结论的最终证据是 CI 本身 —— 见本 PR 修复后的那次 run。

### 一条口径澄清（不是 bug，是报告没写明）

`smoke-2` 那两条 `no_patch`（django-13964 / matplotlib-26466）**复跑就过**
（1 分钟 exit 1 → 13 分钟 1931B；6 分钟 → 6 分钟 1417B）。
所以 `link_ok: FAIL` 反映的是**偶发失败**，不是能力边界。
`link_ok` 到底该报「一次跑完」还是「重试后」的成功率 —— 现在是前者，
但报告没写明，读的人会以为是后者。已留给下一棒（§ZZZ.5 第 2 条）。
