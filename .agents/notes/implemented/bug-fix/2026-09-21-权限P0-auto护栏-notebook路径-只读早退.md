---
Status: implemented
Date: 2026-09-21
---
# 权限 P0：auto 护栏、notebook 路径、bash 只读早退

## 决定了什么

修文档 `20260920-权限系统写入门文档时核出的十项活缺陷.md` 的三条 P0（P1/P2 本轮不动）：

1. **P0-1**：`isSafetyConfirmation` / `classifierMayApprove` 收成共享函数。yesMode、hook allow、auto 三处共用。auto 分类器在 `dangerousCommand` 与 `classifierApprovable:false` 的 safetyCheck（hooks / commands / settings）上直接丢弃结果；`.git/` 等可审批项仍允许分类器放行。
2. **P0-2**：`FILE_TOOLS` / `WRITE_TOOLS` / `FILE_PATH_TOOLS` 加上 `notebook_edit`。路径抽取兼容 `notebook_path`（checker 一处 `extractFilePath`，rules 的 `extractMatchValue` 同步）。always-allow 写 `.git/hooks/*.ipynb` 走 safetyCheck。
3. **P0-3**：从 `READ_ONLY_COMMANDS` 拿掉解释器与构建器（python/node/make/gcc/java…）。版本查询仍走 `--version` 快速路径。Step 5.5 的 `allow` 不再跳过 plan / deny-write。

## 放弃了什么（以及为什么不选）

- **只在 auto 分支复制 yesMode 的 if**：文档横向观察第 4 条就是「复制粘贴契约会漏抄」。三处收成函数，下一次加模式不会再漏。
- **auto 对全部 safetyCheck 一律不放行**：会废掉 `classifierApprovable: true`（`.git/`、`.bashrc`）。字段存在的理由就是分这两档。
- **Step 5.5 allow 改成 passthrough**：会让 `ls` / `git status` 在 default 模式重新弹确认，拿「更安全」伤「更快」。只拦住 plan / deny-write 这两道模式硬约束。
- **顺手修 P1/P2**：用户明确只要 P0。grep/read_many 敏感读、sessionMemory key、acceptEdits 的 rm、hooks 重定向、setFlagRules、沙箱自动放行都不动。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/permission/p0-safety-bypass.test.ts` → **22 pass / 0 fail**
- `bun test ./packages/core/tests/permission/ ./packages/core/tests/tool/bash-redirect-extraction.test.ts ./packages/core/tests/tool/git-config-readonly.test.ts` → **623 pass / 0 fail**
- `bun run affected-tests:run` → **1537 pass / 0 fail**（86 files；首次 3 fail 是 worktree 缺 `tui-renderer/src`，`make build` 拉 vendor 后归零，与本次 diff 无关）
- `make build` 成功，无 `will always be undefined`
- `bun run lint` / `lint:boundary` / `format:check` 全绿
- 附录 A 同形复现（临时目录作 workspace）：
  ```
  isReadOnly python3 foo.py = false
  P0-1 auto write hooks          allowed=false ask=true dr=safetyCheck
  P0-1 auto cat ssh              allowed=false ask=true dr=dangerousCommand
  P0-1 auto sudo ls              allowed=false ask=true dr=dangerousCommand
  P0-1 auto write git config     allowed=true  dr=mode
  P0-2 al write hooks            allowed=false dr=safetyCheck
  P0-2 al notebook hooks         allowed=false ask=true dr=safetyCheck
  P0-3 plan python WITH tool     allowed=false dr=mode
  P0-3 deny-write python WITH    allowed=false dr=mode
  ```
