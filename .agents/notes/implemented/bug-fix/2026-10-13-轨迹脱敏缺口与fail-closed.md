---
Status: implemented
Date: 2026-10-13
---
# 轨迹脱敏补齐漏网形态，脱敏失败改为字段级 fail-closed

## 决定了什么

数据主权整改 PR-B（P1-1 至 P1-10），规则表在 `packages/core/src/permission/sensitive.ts`：

- 私钥：从「只遮 BEGIN 行」改为整块遮（类型前缀任意，含 ENCRYPTED / OPENSSH）；没有 END 行时遮到正文结束；兼容 `JSON.stringify` 文本里的字面 `\n`；占位为 `<PEM <类型> PRIVATE KEY:<N>B>`。type 名沿用「SSH 私钥」，避免按 type 聚合的告警断口径。
- `sk-`：新增显式前缀 `sk-(proj|svcacct|admin)-` 规则，通用 `sk-` 规则补左边界 `(?<![A-Za-z0-9_-])`；新增 `github_pat_`。
- `*_API_KEY=` / `*_TOKEN=` / `*_SECRET=` 与 `x-api-key:` 文本头：只遮值、保留键名；值须像字面量（不含 `. ( ) { } $ / \` 等表达式字符、≥16 位、非占位、无已知前缀时须字母数字混合）。
- 去重逻辑修正：旧实现漏判「前一段跨进已选区间」的重叠，PEM 正文撞上短规则时会产生交叉替换乱码。
- 旁路落盘：`warn.log`（`debug/logger.ts`）与 `protocol-violations/*.json`（`llm/protocol-sentinel.ts`）写盘前脱敏。
- `maskJsonSafe`（`trace/writer.ts`）改 fail-closed：单字段出错只替换该字段为 `[REDACTION_FAILED]`；词法路径整体失败走 parse/逐字段/stringify 兜底；再失败整条换占位。每级降级都告警，绝不回落原文。
- 上传侧可选项 `trace.upload.redact_home_dir`（默认关）：上传字节与 OTLP 根 span 的 `sidcode.cwd` 把家目录前缀换成 `~`，保留相对结构，覆盖 JSON 转义的 Windows 形态（`trace/redact-home.ts`）。
- bash 权限：`env`（含 `-0`）、`printenv` 的转储形态加 medium 级「转储环境变量」需确认；`env FOO=1 cmd` 不拦。

## 放弃了什么（以及为什么不选）

- **放宽 `sk-` 通用规则字符类（加 `-_`）**：实测误伤 `task-qemu-alpine-ssh-key-setup`、`disk-usage-monitor-service_v2`、`fix/task-panel-dismiss-manual-exit`，会改写评测分歧分析依赖的 command / file_path。新前缀类密钥一律走显式前缀。
- **PII 正则（邮箱 / 手机号 / 身份证）**：对代码里的数字常量、测试数据、git 作者邮箱误伤高，本 PR 不做；只做路径类标识的结构化处理（P1-6 的结论维持方案「放弃了什么」）。
- **路径 hash**：两臂不可比、`distill-skill-rules.ts` 的来源仓库推断失效；只替换家目录前缀。
- **家目录替换默认开 / 作用于本地落盘**：会改变平台按项目 / 用户的聚合口径，需先与平台侧对齐；本地轨迹要能直接复制路径打开文件。
- **整文件占位的 fail-closed**：会让这条会话对评测整条作废；改为字段级。
- **工具输出进上下文时改写凭证**：维持 tool-executor 只检测不改写的既有取舍（模型需要看真实内容完成任务），P1-9 只在命令入口加确认。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/trace/redaction-gaps-pr-b.test.ts`：覆盖完整 / 截断 / 字面 `\n` PEM、`sk-proj-` / `sk-svcacct-` / `github_pat_`、赋值与 `x-api-key:` 正例、8 条误伤反例原样、AWS 示例 key 维持现状、warn.log 与 protocol-violations 落盘无原值、fail-closed、家目录替换（含上传字节与默认关）、env/printenv 需确认。
- 变异自证（同文件内）：恢复「出错回落原文」→ 断言能看到明文；§8.4 合成样例门禁上，加命中 `tool_use_id` 的规则、放宽 `sk-` 字符类、去掉脱敏，三种变异分别报「白名单字段变化 / 误伤 / 漏网」。
- §8.4 本机层（不进 CI）：本机 93 个会话、186 个文件、55596 行，新旧规则各跑一遍——parse 失败 0、白名单字段变化 0、tool_use 序列变化 0；新增命中 SSH 私钥 6 / OpenAI Project Key 6 / GitHub Fine-grained Token 3，逐条抽看全部是本次开发会话里粘贴的合成测试凭证，无误伤。
- `bun run affected-tests:run`：7995 pass / 0 fail；`make build` 自检通过且无 `will always be undefined`；lint / format:check / lint:boundary / typecheck:gate（87/87）/ docs:gen-reference 均通过。
