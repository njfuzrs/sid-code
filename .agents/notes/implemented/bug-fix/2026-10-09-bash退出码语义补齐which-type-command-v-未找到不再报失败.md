---
Status: implemented
Date: 2026-10-09
---
# bash 退出码语义补齐 which / type / command -v：「未找到命令」不再报成执行失败

## 决定了什么

`packages/core/src/tool/bash/command-semantics.ts` 的 `COMMAND_SEMANTICS` 新增查找类语义 `LOOKUP_SEMANTIC`：
`which` / `type` / `command -v|-V` 退出码 1 → `isError:false` + 附注「未找到命令」，≥2 仍为错误。

为支持 `command` 按子参数分流，`CommandSemantic` 签名从 `(exitCode)` 扩为 `(exitCode, args)`，
`extractExitCodeCommand` 改为返回最后一个简单命令的 `{command, args}`。其余命令语义不变。

触发证据：轨迹 `20261009-135641-0083c051` 中模型发出
`mdls ... 2>&1; echo "=== exiftool ==="; which exiftool tesseract 2>&1`，
`mdls` 成功（rc=0）、末段 `which` 没找到（rc=1），`;` 串联取末段退出码，
于是整条被包成「命令执行失败（退出码 1）」并置 `isError`。排查结论：模型参数合法、
执行层无截断，问题在语义表缺项。

## 放弃了什么（以及为什么不选）

- **把 `command` 整体归入查找语义**：否决。`command foo` 是绕过别名执行 foo，退出码属于 foo，
  整体归入会把 foo 的真失败吞成成功——比误报更危险（静默）。故只在 `-v/-V` 时走查找语义。
- **把 `ls` 部分路径不存在（rc=1）也降级**：否决。同一轨迹的第一条报错
  `ls -la <存在> <不存在>` 是真实的部分失败，判错误是对的；降级会让「文件不在那」被当成功。
- **按「前段有输出就不算失败」做整条命令的启发式**：否决。`;` 串联里任意一段都可能是真失败，
  按输出有无判定会大面积吞错，且与 claude-code 一致的「取最后一个简单命令」启发式冲突。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/tool/bash-stability.test.ts` → 33 pass / 0 fail。
  新增 7 条：which / type / command -v|-V 未找到不报错；轨迹原命令（`;` 串联末段 which）取 which 语义；
  `command ls /nonexistent` exit 1 仍为错误（变异自证：把 command 整体归入查找语义即红）；
  which exit 2 仍为错误；`ls` 部分不存在仍为错误；集成用例经 `BashTool.execute` 不含「命令执行失败」且含「未找到命令」。
- 本机 zsh 复现退出码：`ls rc=1`、`mdls rc=0`、`which rc=1`，与轨迹一致。
- 真实会话里被触发：待下次模型探测可选工具时在轨迹中确认 `PostToolUse.is_error=false`。
