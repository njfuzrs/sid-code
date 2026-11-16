---
Status: implemented
Date: 2026-11-16
Source: 权限模式对齐claude-code-缺陷修复与验收方案（2026-11-12）
---
# acceptEdits 剥离安全前缀：三个包装器 + 四个展示性环境变量，且只剥一层

## 决定了什么

M9：`acceptEdits` 模式下，`timeout 30 mkdir -p build`、`nohup mkdir x`、`LANG=C sed -n 1p f`
这类命令此前会落到 Step 14 要求确认——模型顺手加一个 `timeout` 就多一次无意义的往返。
现在 `packages/core/src/permission/checker.ts` 的 `canAutoAllowFsCommandInAcceptEdits` 会先剥掉
**最小前缀集**再做原有三道校验：

- 进程包装器只认 `timeout <时长>`、`nice [-n N]`、`nohup` 三种，**至多剥一个**，参数格式不认识就不剥
  （`timeout --forever mkdir x`、`nice -10 mkdir x` 仍落回 ask）；
- 环境变量前缀只认 `LANG` / `LC_ALL` / `NO_COLOR` / `TERM`，值必须匹配 `[A-Za-z0-9_.-]+`
  （`LANG='a b'`、`FOO=$(curl evil)`、`FOO=bar` 都不剥）；
- 剥离顺序固定为「环境变量（可多个）→ 一个包装器」；
- 剥完的 baseCmd 仍须在 `ACCEPT_EDITS_FS_COMMANDS` 里，破坏性命令的第二道闸（`rm`/`rmdir`/`mv`）
  **在剥离之后**判，路径校验照常；
- `touch` 例外：带任何前缀都不自动放行；
- `sudo` / `env` / `command` / `xargs` / `sh -c` **永不剥**。

新增 G1 回归 `packages/core/tests/permission/m9-accept-edits-prefix-strip.test.ts`（16 个用例，覆盖方案 §6.7 的 8 条矩阵 + 6 条边界）。

## 放弃了什么（以及为什么不选）

**不复用 `expandShellCommand`**（`shell-command-variants.ts`）。它是为「拦」设计的：递归展开
`sh -c` / `eval` / 命令替换，剥 `sudo` / `xargs`。放行侧沿用它等于把「拦」的宽口径借给「放」——
`env mkdir x`、`xargs mkdir` 会被直接自动放行。10-24 的 Note 已经否决过一次这条路，
这次按方案 §4.7 的约束另写一个独立的最小剥离函数。

**不做递归剥离**。`timeout 5 timeout 5 mkdir x` 只剥一层，剥完 baseCmd 仍是 `timeout`，
落回 ask。递归剥离的收益接近零（谁会套两层），但放行面会随嵌套深度线性扩大。

**不放宽包装器的参数形态**。`timeout -s KILL 5 mkdir x`、`timeout --forever`、`nice -10`（老式调整量）
都按「格式不认识就不剥」处理。它们都是合法的、语义清晰的命令，但要逐条论证 `-s`/`-k` 的取值、
`--forever` 的语义边界，收益不抵论证成本；落回 ask 是安全方向上的退化，用户多按一次而已。

**不把 `touch` 纳入前缀剥离**，即使 `touch` 本身在 fs 白名单里。对齐 CC `permission-modes.md:281`：
`touch` 是白名单里唯一**创建**文件的命令，前缀让「它到底要 touch 什么」从命令名字面上看不全，
CCA 的取舍是宁可多问一次。

## 拿什么证明它生效了

**G1（方案 §6.7 矩阵，16 例全绿）**

```bash
bun test ./packages/core/tests/permission/m9-accept-edits-prefix-strip.test.ts
# 16 pass / 0 fail / 35 expect() calls
```

矩阵逐条：`timeout 30 mkdir -p build` → `allowed=true step=11`；`nice -n 10 cp a b` /
`nohup mkdir x` / `LANG=C sed -n 1p f` → 放行；`timeout 5 rm -rf .` / `nohup mv a b` / `sudo mkdir x` /
`env mkdir x` / `xargs mkdir` / `sh -c 'mkdir x'` / `timeout 5 touch x` / `LANG=C touch x` /
`FOO=$(curl evil) mkdir x` / `LANG='a b' mkdir x` / `timeout 5 timeout 5 mkdir x` /
`timeout 5 mkdir ../outside` → 均不放行。

一处偏离方案原文、已核实：`LANG=C sed -n 1p f` 的 `allowed=true` 来自 **Step 5.5 只读早退**
（`step=5.5`），不是 Step 11。方案 §6.7 对这条只要求 `allowed=true`，照方案断；
「剥离在 acceptEdits 分支对 sed 也生效」由单加的 `LANG=C sed -i 1d f`（写形态，不被判只读）
断言 `step=11` 证明。测试里所有用例都显式带 `input.cwd = workspace`：Step 5.5 按
`input.cwd > getCwd()` 取基准，不带的话它会用进程 cwd 去解析路径，与 workspace 不是同一目录。

**变异自证（四组，全部实测，不修饰）**

| 变异 | 改动 | 结果 |
| --- | --- | --- |
| 1 | 剥离白名单换成「剥任意 `KEY=VALUE`（含引号/命令替换）+ 任意包装器 + 任意参数」 | 用例 4（`sudo`/`env`/`xargs`/`sh -c`）、6（`FOO=$(...)`/`LANG='a b'`）变红，另带「参数格式不认识」组；13 pass / 3 fail |
| 2a | **仅**删除剥离后的第二道闸 | **16 pass / 0 fail —— 零红**。等价变异：`rm`/`mv` 本就不在 `ACCEPT_EDITS_FS_COMMANDS` 里，白名单是另一层拦截 |
| 2b | 删第二道闸 **+** 把 `mv` 加回 fs 白名单（模拟名单回潮） | 用例 3（`timeout 5 rm -rf .` / `nohup mv a b`）变红；15 pass / 1 fail |
| 2c | 保留第二道闸 + `mv` 仍在白名单 | 16 pass / 0 fail → 闸是唯一拦截点，且必须在剥离之后判 |

方案原文写「去掉剥离后的第二道闸 → 3 红」，实测**单独去掉不会红**（2a）。原因是 rm/mv 不在白名单，
第二道闸是「防名单回潮」的哨兵而非当前唯一拦截点。2b/2c 组合起来才证明它在剥离之后仍然生效。
这个偏差记在这里，避免下一个人照着方案原文复现变异时误判「闸没生效」。

**门禁（worktree 内全跑）**

```bash
bun run format:check          # All matched files use the correct format.
bun run lint                  # 0 warnings / 0 errors
bun run typecheck:gate        # 62/62，无新增
bun run affected-tests:run    # 1582 pass / 0 fail（permission 目录 65 文件）
make build                    # 成功，编译产物自检通过
bun run smoke                 # 37 例：37 通过，0 失败
bun run docs:gen-reference --check  # 参考页与源码一致
bun run lint:boundary / lint:command-system / lint:legacy-tool  # 全部通过
```

**一个 worktree 专属的坑（这次踩到并已处置）**：worktree 的 `node_modules` 是软链到主仓的，
于是 `node_modules/@sid-code/core` 解析到**主仓**的 `packages/core`——我第一次跑探针时读到的
还是未修改的代码（`timeout 30 mkdir -p build` 判 false）。处置：删掉 worktree 里本次生成的
`node_modules` 软链后 `bun install`（`readlink -f node_modules/@sid-code/core` 现在指向 worktree
自己的 `packages/core`）。测试文件因为位于 `packages/core/tests/` 下、不受这条软链影响，
所以「测试全绿但探针全红」这个矛盾本身就是该软链的指纹。
