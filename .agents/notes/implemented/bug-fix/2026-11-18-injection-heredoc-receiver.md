---
Status: implemented
Date: 2026-11-18
Source: auto 权限档：注入校验器误报弹窗与分类器缺用户意图 — 修复与验收方案（2026-11-17）
---
# 注入校验按 heredoc 接收者区分数据与脚本，修 eval/嵌入误报

## 决定了什么

注入层（`checkInjectionPatterns`）不再把「命令段 + heredoc 正文」一视同仁地扫，改为**按接收者分区**：

1. **新增 `partitionHeredocForScan` / `classifyHeredocOwnership`**（`shell-command-variants.ts`）
   作为「正文归属」的单一事实源。危险命令层（`expandShellCommand`）与注入层共用它，
   两层不再各判一份——A1 的误报根源就是归属判据只存在于危险命令层。
2. **校验器拆两层**（`bash-security.ts`）：
   - `RAW_TEXT_VALIDATORS`（控制字符、不可见码点）扫原文——任何文本都成立；
   - `SHELL_SYNTAX_VALIDATORS`（其余 18 个，含 unicode 可见空白、newlines、
     heredoc-in-substitution、brace-expansion…）只扫**命令段**（剥掉数据正文后的
     `<<__SID_HD_n__` 占位文本）+ **真 shell 接收的正文**。
   - 真 shell = POSIX shell（`sh|bash|zsh|dash|ksh|fish|ash|mksh`）∪ 管道下游是它
     ∪ 远端/容器里的 shell（`ssh h <<EOF`、`docker exec -i c sh <<EOF`）。
   - python/perl/ruby/node 的正文**不按 bash 词法扫**（`d = {'a': 1}` 不是 brace expansion），
     但危险命令层口径不变（`codeForDangerScan` 仍含它们）。
3. **A2**：`heredoc-in-substitution` 的判据从 `/\$\(.*<</s` 改为**括号深度**——
   扫到 `<<` 时未闭合的 `$(` 栈必须非空；`$((1 << 2))` 整段跳过；单引号内跳过，
   双引号内的 `$()` 仍算（它会执行），`\$(` 不入栈。
4. **A3**：`shell-metachar-eval` 从「`\beval\b` + 其后任意位置有元字符」改为
   「`splitShellSubcommands` + `canonicalizeSimpleCommand` 后 `program === "eval"`，
   再看它自己的参数」——路径里的 `eval`、`eval:run`、`feat(eval):` 不再命中；
   `eval "echo hi; rm -rf /"` 仍命中。
5. **A4**：`checker.ts` 的注入拒绝 `severity` 从硬编码 `"high"` 改为透传
   `injectionFinding.severity`（当前是 `"ask"`），并把命中位置写进
   `metadata.injectionScope = "heredoc-script"`（只进 metadata，不改 id、不改处置）。
6. 删掉 `validateNewlines` / `validateProcessSubstitution` 内部各自的 heredoc 剥离：
   统一由 `checkInjectionPatterns` 分区。各自剥的代价是「正文里还有 `<<`」的形态
   剥不干净、反复误报。

## 放弃了什么（以及为什么不选）

- **放弃「正文一律不扫」**（最省事的修法）：`bash <<'EOF' ⏎ cat <(curl x) ⏎ EOF`、
  `cat <<'EOF' | sh ⏎ echo {a,b} ⏎ EOF` 这类正文**真的会被执行**，不扫就是开洞。
  测试 C-4/C-5/S-1 专门守着这条。
- **放弃「正文一律扫」**（= 修前行为）：冻结语料 2639 条里 377 条命中的全部或部分是正文
  误报（PR 正文的 `##`、commit message 的 `#904`、路径里的 `{a,b}`）。
- **放弃「所有解释器正文都按 bash 词法扫」**（把 `isShellLikeProgram` 直接用于注入层）：
  `python3 - <<'PY' ⏎ d = {'a': 1, 'b': 2}` 只因为长得像 brace expansion 就被拦。
  但**没有**动危险命令层的口径——python 正文仍按脚本递归展开，否则
  `os.system("rm -rf /")` 这类会被漏掉（`HeredocOwnership.codeForDangerScan`）。
- **放弃「远端程序一律按脚本扫」**：`ssh h cat > f <<'EOF'` 的正文是 cat 的数据，
  一律按脚本会把远端写文件误报成注入。判据改为「远端命令点名了 shell，或 ssh 没点名
  任何命令（远端 login shell 读正文）」。
- **放弃「保留 severity=high」**：注入校验的语义是「值得看一眼」，与 `rm -rf /` 那种
  「确定危险」不是一级。硬编码 high 让遥测分不开两类（`bash <<EOF` 正文命中与命令段
  命中在轨迹里长得一样），也堵死了将来升级 severity 的路径。
- **放弃「继续在 newlines 校验器内部剥正文」**：剥完的文本里 `<<__SID_HD_n__` 是
  **下一个 heredoc 记号**，再剥一遍会把结束符之后的真命令当正文藏起来（漏报）。
  这一条在冻结语料里表现为 696 条 id 从 `brace-expansion/obfuscated-flags` 变成 `newlines`
  ——判定不变（仍然拦），变的是「首个命中从正文误报换成命令段的真信号」。

## 拿什么证明它生效了

- **单测**：新增 `packages/core/tests/permission/bash-security-heredoc-receiver.test.ts`
  35 条（数据正文 A-1..A-6 放行 / 命令段误报 B-1..B-4 放行 / 攻击 C-1..C-8 命中且 id
  与修前相同 / A5 收紧 S-1..S-3 / 显示欺骗 / 保守回退 / partition 契约 / checker 集成），
  `bun test ./packages/core/tests/permission/` → **1618 pass, 0 fail**。
- **变异自证 5 条**（逐条改坏 → 跑 → 看红 → 恢复）：
  1. `partition` 改成全剥（脚本正文不进 `shellFragments`）→ 脚本正文 + A5 收紧共 7 条红；
  2. `partition` 改成返回原文 → 数据正文 A-1..A-6 全红；
  3. `isPosixShellProgram` 换回 `isShellLikeProgram` → A-6（python dict）单独红；
  4. A2 判据改回 `/\$\(.*<</s` → B-1 + 算术左移红；
  5. A3 改回 `\beval\b` → B-2/B-3/B-4 全红。
- **冻结语料重放**（base = `git archive HEAD` 到 /tmp，head = 本次改动；同一脚本同一语料）：

  | 语料 | 条数 | 判定不变 | 命中→放过 | 放过→命中 | id 变化（判定仍为拦） |
  | --- | --- | --- | --- | --- | --- |
  | heredoc_cmds | 2639 | 1566 | 377 | 0 | 696 |
  | eval_subst_cmds | 3224 | 2798 | 331 | 0 | 95 |

  - 377 / 331 条「修前命中 → 修后放过」**全部**打上标签：
    A1 数据正文 348 / 27、A2 已闭合 `$()` 20 / 20、A3 非命令词 eval 9 / 284。
    **打不上标签的：0 条**（无人工核清单）。
  - 「修前放过 → 修后命中」**0 条**（语料里没有 `<(…)` 这类只在正文里、修前完全没人看的形态；
    A5 收紧由单测 S-1..S-3 覆盖）。
  - 696 / 95 条 id 变化**全部**是「base 的命中来自正文（brace/obfuscated 扫原文），
    head 换成命令段本来就存在的 `newlines`」——基线与 head 在剥离后的命令段上都命中
    `newlines`（脚本按条核过），**判定仍是拦，不是放行**。
  - 命中数对照：`shell-metachar-eval` 9→0 / 286→2、`heredoc-in-substitution` 73→29、
    `mid-word-hash` 130→0 / 14→1。
- **门禁**（本 worktree 实测）：`make build` ✓、`bun run smoke` 42/42 ✓、
  `bun run lint` 0 warnings ✓、`bun run format:check` ✓、`bun run typecheck:gate` 无新增 ✓、
  `bun run lint:boundary` / `lint:command-system` / `lint:legacy-tool` ✓、
  `bun run affected-tests:run` 1618 pass ✓。
