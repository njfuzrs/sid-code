---
Status: implemented
Date: 2026-09-22
---
# 权限 P1：敏感读旁路、记忆串味、acceptEdits rm、hooks 重定向

## 决定了什么

修文档 `20260920-权限系统写入门文档时核出的十项活缺陷.md` 的四条 P1（P2 本轮不动）：

1. **P1-1**：敏感文件硬 deny 覆盖读旁路。bash 危险正则从「`cat` + 特定文件名」改成「读类命令 × 敏感路径」（`head ~/.ssh/id_rsa` / `cat .env` / `rg ~/.ssh/id_rsa`）。grep / read_many 的 `path` 指向敏感文件时走同一道 PathValidator；全树搜索由工具层 `isPathHidden ∪ isSensitivePath` 过滤。`Read(.env)` 规则同时挡住 grep / read_many。
2. **P1-2**：会话记忆 key 与 `extractMatchValue` 合流。写工具（write/edit/notebook_edit）与 read_many、空资源（无 path 的 grep、无 url 的 web_fetch）禁止写入 sessionMemory——命中后整段阶段一都不跑，空钥匙会把 hooks / 外域 URL 一并放行。web_fetch 用完整 URL；grep 必须同时有 path 和 pattern。
3. **P1-3**：`rm`/`rmdir`/`mv` 从 acceptEdits 自动放行白名单拿掉，并加第二道闸防名单回潮。`mkdir`/`touch`/`cp`/`sed` 保留。路径比较走 `resolveRealPath`，否则 macOS `/var` → `/private/var` 会把 cwd 内 mkdir 误判为区外。
4. **P1-4**：safetyCheck 名单抽成 `safety-protected-paths.ts` 单一事实源；bash 重定向检测复用它。`echo x > .git/hooks/pre-commit` 在 always-allow 下需确认。

## 放弃了什么（以及为什么不选）

- **给写工具做「路径 + 操作类型」记忆**：文档更严的做法是不给写工具做 always 会话记忆。同路径不同内容的损害不可逆，操作类型也分不开「改注释」和「写 hook」。always-persist 仍只落盘 Bash 精确命令（既有行为）。
- **把 grep/read_many 整段从 READ_ONLY_TOOLS 拿掉**：会让无 path 的工作区搜索在 default 模式全部弹确认，拿「更安全」伤「更快」。敏感文件硬 deny + 结果过滤已经堵住旁路。
- **对 `rm` 要求「必须有明确子路径」仍留在白名单**：`.` / `..` / cwd 形态太多，漏一种就复活。直接拿掉比继续打补丁便宜。
- **顺手修 P2-1 setFlagRules / P2-3 沙箱自动放行**：用户明确只要 P1。沙箱自动放行仍会放行非 hooks 的 bash；hooks 重定向已在 Step 2 被 P1-4 拦住，P2-3 不再是这条洞的充分条件。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/permission/p1-sensitive-bypass.test.ts` → **29 pass / 0 fail**（含 yesMode/auto 不把 hooks 重定向当普通 ask 放行）
- `bun test ./packages/core/tests/permission/` + grep/read-many/subagent/mcp-serve → **562 pass / 0 fail**
- `bun run affected-tests:run` → **3517 pass / 0 fail**（cli + core agent/permission/tool）
- `make build` 成功，无 `will always be undefined`
- `bun run lint` / `format:check` / `lint:boundary` / `docs:gen-reference --check` 全绿
- 附录 A 同形复现钉在 `p1-sensitive-bypass.test.ts`：`head ~/.ssh/id_rsa` / `grep path=.env` 不再 allow；notebook 记忆不再串到 hooks；`acceptEdits + rm -rf .` 不再 allowed；`always-allow bash echo > .git/hooks/pre-commit` 需确认且 `decisionReason=dangerousCommand`
