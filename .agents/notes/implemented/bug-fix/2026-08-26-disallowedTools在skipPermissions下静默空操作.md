---
Status: implemented
Date: 2026-08-26
---
# `disallowedTools` 在 `--dangerously-skip-permissions` 下是静默空操作（外加两个评测仪器缺陷）

## 决定了什么

三个缺陷，都来自 smoke-9（SWE-bench Verified 10 题，8/10）的执行报告。**P0 那个的修法与方案文档里写的不同** ——
文档说「PYCFG 里 `disallowedTools` 改值即可」，实测那是空操作，所以改成了产品侧修复。

> 同一份报告里的第四个缺陷（轮次用尽被记成 `exit_status: user_interrupt`）单独一个 PR ——
> 它影响所有真实用户会话的归因，不只是评测，与本 PR 的上线/回滚时机无关。
> 见 `2026-08-26-轮次用尽被误记成user_interrupt.md`。

### ① P0：`disallowedTools` 遇上 `skipPermissions` 完全失效（产品缺陷，不只是评测配置）

`disallowedTools` 原先**唯一**落点是权限层 `checker.ts` Step 3（`:764`）。而 `check()` 在入口就对
`this.config.skipPermissions` 早退（`checker.ts:1023`，`return { allowed: true }`）—— 早退发生在 Step 3 **之前**。
于是这两个配置一起用时被禁工具照常可调、照常执行，**且不打任何日志**。

直接调 `PermissionChecker.check()` 实测：

```
disallowedTools=["web_search"], skipPermissions=true  → { allowed: true }                    ← 禁不掉
disallowedTools=["web_search"], skipPermissions=false → { allowed: false, "工具已被禁用" }
```

修法是在 `tool/registry.ts` 加**工具集裁剪**端：新增 `removeByNames()`，由 `cli.ts` 在启动阶段按
`config.disallowedTools` 调用；同时把名单记进 `registry.disallowedNames`，让 `register()` 也拒收。
权限层那条判据**刻意保留不动**（CLAUDE.md 规则可能在会话中途合并进新的 `disallowedTools`，
那时工具已注册完，权限层是那条路径的兜底 —— 两层都在才 fail-closed）。

现场：SWE-bench 容器无外网（只放行网关）却从没关掉 web 工具。smoke-9 的 django-13964
**40 轮全部用完、零编辑**，80 步里 7 步（8.8%）打在 `web_search` / `web_fetch` 上 ——
模型在反复找 Django 上游 ticket 的修复 diff，连试了 32335/32340/32360/32365/32369 五个编号。
它不知道自己没网。

⚠️ 顺带记一条比"省轮数"更硬的理由：**查上游 fix diff 等于看答案**。现在查不到只是因为容器无外网，
那是运气不是设计 —— allowlist 代理哪天放宽一点它就变成数据泄漏，而泄漏时没有任何东西会红。

⚠️ 还有一条本轮最该记住的观察：smoke-8 里**同一条题反而是 solved**，因为那时 113 次权限拒绝把它逼回了
只读代码库这条正确路径。**权限一放开，浪费也放开了** —— 一个约束在被解除之前，可能正意外地承担着
另一个约束的职责。

### ② P1：judge 判分默认联网，卡死 25 分钟零输出

`HF_HUB_OFFLINE=1` 原先只加在取题面那一处（`run_one` 的 fetch-instance.py），判分那条 `$SWEBENCH eval` 没有。
于是 harness 去打 HuggingFace 拿 dataset，而 dataset 本地早就缓存好了。实测 25 分钟零输出、零 eval 容器，
`lsof` 显示停在 `TCP …->104.244.43.229:https (SYN_SENT)`；加上变量后 8 分钟跑完。

用 `${HF_HUB_OFFLINE:-1}` 而非硬编码 1：留一个逃生舱给"确实要更新 dataset"的场合，否则下一个人会直接删掉这两行。
顺带把 `| tail -30` 改成 `| tee "$out_dir/grade.log" | tail -30` —— 上面那个故障之所以难归因，
正是 `tail` 在 buffer 满之前一个字都不出来，"卡在网络"看起来像"判分很慢"。

### ③ P2：未加引号 heredoc 里的反引号被宿主求值

`build_agent_script` 用 `cat <<SCRIPT`（未加引号），于是整个脚本体都在宿主 bash 里做一次展开 ——
包括那段 Python 配置里的中文注释。每题固定刷 5 行 `xxx: 未找到命令`。
改成 `cat <<'SCRIPT'`，两个宿主变量（`MAX_TURNS` / `PERMISSION_FLAG`）改走 `printf` 注入。

## 放弃了什么（以及为什么不选）

**P0 修法：把权限层判据挪到 `skipPermissions` 早退之前。** 否决 —— 模型仍看得见工具、仍会调用，
每次换回一条拒绝，**一轮一轮地烧**；而且会把 `permission_denials` 从 0 顶起来，
正好污染验收表第一行那个指标。判据必须是「工具不可用」（schema 都不进上下文），不是「调了会被拒」。

**P0 修法：容器里改用 `--tools` 白名单**（`retainBuiltInByNames` 已实现，不动产品代码今天就能跑）。
否决 —— 白名单要枚举全部想留的工具，本身变成一个新的必控变量，正是 `exec-swebench.sh` 文件头
对 allow 白名单的同一条反对理由；而且产品 bug 留在原地，下一个配 `disallowedTools` 的用户还会中招。
（这一条向用户确认过，选的是改产品。）

**P0 修法：只做一次性 `delete`，不让 `register()` 认名单。** 否决 —— 裁剪时机（cli.ts 启动阶段）
早于 MCP 工具注册（异步回填 + `onToolsRefresh` 运行中重新注册），被禁的 MCP 工具会在裁剪之后
**若无其事地回来**，且零日志。所以名单留在 registry 上、注册端成为唯一咽喉。

**P2 修法：把那三处反引号改成单引号**（方案文档原本这么写）。否决 —— 那修的是症状。
`exec-swebench.sh` 900+ 行里绝大部分是注释，写注释的人不会先检查自己在不在一个未加引号的 heredoc 里，
几乎必然复发。改成加引号（修病因）+ 一条机械门禁。

**`prompt-v1.txt` 只加一句「无外网」就算修完 P0。** 否决 —— 提示词是软约束，
而这里同时要防数据泄漏。那句话加了（作为省轮数的辅助），但硬约束由裁剪承担。
⚠️ 加了那句话之后，`prompt-v1.txt` 就成了一个**没被记录的必控变量** ——
所以顺带给 `run-meta.json` 补了 `prompt_template_sha256`，否则事后无法区分
「smoke-9 与 smoke-10 用的是同一份题面模板」。

## 拿什么证明它生效了

**① P0 —— 真实编译产物的 A/B，走的正是 smoke-10 会走的那条路径**（`--dangerously-skip-permissions`
+ settings.json 里的 `disallowedTools`）。起一个假网关记录 `tools[]` 里的名字：

```
禁用后 发给模型的工具数: 40   web_search 在? False   web_fetch 在? False
对照（未禁用）:      42       web_search 在? True    web_fetch 在? True
```

⚠️ 一个**差点被骗过去的细节**：`--dump-tools` 里这两个工具**仍然在**。它不是没生效 ——
`--dump-tools`（`cli.ts:1870`）刻意早于所有裁剪就 `exit(0)`，为的是让 `ref/tools.md`
不随本机配置漂移。用它验会得出完全相反的错误结论；必须验真正发给模型的那份。

**② judge 离线** —— 未真实跑判分（本次不跑评测，按安排留给下一棒）。
已验的是 `bash -n` 语法通过、`${HF_HUB_OFFLINE:-1}` 形态正确。

**③ heredoc 门禁 —— 拿它扫修复前的代码，报出的正是方案文档点名的那三行**：

```
修复前违规数: 3
  行1008（<<SCRIPT）: # 模板值 100 会让整轮在 exceeded 处静默 `yield done; return`，
  行1013（<<SCRIPT）: # ⚠️ 顺带修了产品侧一个矛盾：校验器原来判 `<= 0` 为错，
  行1014（<<SCRIPT）: # 而运行时 `quota.ts` 判 `<= 0` 为不限、文档写的是 `≥0` ——
修复后违规数: 0
```

门禁自身也有变异自证（含一条 `bash -c` 实测：未加引号时 `` `echo INJECTED` `` 真的被执行，
且 `` `costLimit -le 0` `` 那段被**静默吞掉**）。
⚠️ 门禁第一版**自己先误报了 3 条**：`scripts/install-template.sh` 有 `# <<< sid-code <<<`
标记注释，裸 `<<-?` 把 `<<< sid` 当成 heredoc 起始，此后整个文件被当 heredoc 体。
加了 `(?<![<])<<(?!<)` 与跳过注释行，并把这个误报形态钉成一条断言。

**④ 生成的容器脚本逐项验过**：`stderr` 行数 0（修复前每题 5 行）、末行
`--max-turns 40 --dangerously-skip-permissions` 正确、`$SID_CONFIG_DIR` 保持字面量、
把 PYCFG 抽出来真跑一遍确认 settings.json **20 个顶层键齐全**且
`disallowedTools=["web_search","web_fetch"]` / `costLimit=0.0` / `effortLevel=max`。

**⑤ 全仓门禁**：`bun run affected-tests:run` → 4741 pass / 0 fail；`lint` / `format` /
`docs:gen-reference --check` 全过；`bunx tsc --noEmit` 的 5 条 error 在 `git stash` 后同样存在（预先存在，与本次无关）。
⚠️ 期间 `shell-fullwidth-var.test.ts` **拦下了我自己新写的一行**（`$grade_log（`）——
那个坑第四次复发，已按 `${grade_log}` 改掉。机械门禁比"在原地写注释提醒"有效，这条又被证了一次。

## 未做（留给下一棒）

- **不跑 smoke-10**（按安排，评测作为后续任务）。P0 的验收判据已写进 `exec-swebench.sh` 注释：
  逐题 `web_search` / `web_fetch` 调用数**全 0**；不为 0 说明裁剪没生效，别去改提示词凑数。
- `git_dirty` 恒为 true 的问题没动（多任务并行仓库里它永久生效）。要做严格外比得在干净 checkout
  或 worktree 里跑 —— 而不是去放宽那个判据。
