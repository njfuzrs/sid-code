---
Status: implemented
Date: 2026-10-06
---
# MCP 批次 3：OAuth 回调先校验、iss、日志脱敏、elicitation 不再假 accept（D17–D22 / D26 / D28）

## 决定了什么

- **D20 / D22 回调服务器**（`oauth-callback-server.ts`）：state 校验挪进请求处理，必须在回复浏览器之前完成。state 对不上（包括缺失、重复参数）时回 400 失败页，**不结算、不关服务器**，继续等真回调；超时报错里会带上「期间收到 N 次 state 不匹配」。`sid-code auth login`（`identity/cli-login.ts` 复用同一个回调服务器）仍据此归因为 `state_mismatch`，只是从「立即报」变成了「超时后报」。授权服务器的 error 回调也得带对 state 才会终结流程，否则本机任意进程发一个 `?error=x` 就能打断授权。`code` 与 `state` 不再用 `\x00` 拼进一个字符串传递。
- **D19 RFC 9207**：`waitForCode` 增加 `issuer` 参数，期望值取发现阶段的 `metadata.issuer`。回调带了 `iss` 就必须逐字相等。元数据声明 `authorization_response_iss_parameter_supported` 时，缺 `iss` 也判失败。
- **D18 脱敏**：新增 `redactOAuthUrl()`（state / code / code_challenge / code_verifier / secret / token 打成 `[REDACTED]`）。manager 在没有 UI 回调时走日志分支，这条分支改用脱敏 URL，级别从 info 升到 warn，免得 WARN 级 logger 把它吞掉。cli.ts 直出 stderr 的那条（#147）保持原文，链接仍可点击。
- **D21 状态**：新增 `NEEDS_AUTH`。OAuth server 授权没走完（超时、取消、发现失败）统一包成 `NeedsAuthorizationError`，状态落在 NEEDS_AUTH，不落 FAILED。half-open 探测只探 FAILED，所以不会定时再弹授权。`enabled:false` 的 server 登记进 `disabledConfigs`，`getStatus` 里显示 `disabled`，但不进 `serverConfigs`（重连、探测、closeAll 都遍历它，混进去就得每处加跳过判断）。`/mcp list`、面板、`/doctor` 都补上了「待授权」文案。
- **D26 / D28 elicitation**：交互改走 `ask-user-question-bridge`，和 ask_user_question 工具、降级弹窗共用同一条 TUI 通道。TUI 下弹选择 / 输入对话框，用户的选择如实回传（URL：确认才 accept；表单：逐字段一道题，按 schema 类型还原，必填项缺失或类型不对时 decline）。无头模式没有处理器，返回 `decline`，零 stdout 输出。`ElicitResult.action` 补上 `decline`，与规范三态和 hook 类型对齐。cli.ts 里那条「App 里有 UI 版覆盖」的注释改成符合事实。
- **D17**：`approvePendingServer` 的错误注释改掉了。新增 `approveAndConnectPendingServer` 和斜杠命令 `/mcp approve <name>`，会话内批准后直接 `addServer` 热连接，不用重启。`sid-code mcp approve` 子进程手上没有 manager，仍是落盘后下次启动生效。

## 放弃了什么（以及为什么不选）

- **为 elicitation 新写一个 TUI 对话框组件**：`refactor/tui-render-port` 正在迁移渲染底座，几乎改了所有 UI 文件。新组件要在两套底座上各写一遍，还会和那条分支冲突。复用现成的提问桥，UI 文件一行都不用动；代价是表单交互形态受限于选择题加「其他…」自由输入，多行文本、数组字段这类体验一般。
- **state 不匹配时直接终结流程（保持旧行为）**：会留下一个 DoS 面，本机进程只需发一个请求就能打断合法授权。改成宽容等待，与「缺 code 继续等」的策略统一。
- **iss 不匹配时也继续等**：state 已经证明这是我们发出的那次请求，此时 iss 不对是真实的混淆攻击或配置错误信号，不是伪造噪声，没理由继续等。
- **无头模式 elicitation 回 cancel**：cancel 的语义是「用户放弃」，而这里根本问不了用户，decline 更诚实。验收判据写的也是 decline / cancel 二选一。
- **把 disabled server 放进 serverConfigs 再加状态判断**：重连、探测、listOAuthServers、reconnectPluginServers 都遍历它，每处都得记着跳过，漏一处就会去连一个被禁用的 server。
- **只改 D17 的注释**：功能缺口是真的，热连接需要的配置都在待审批快照里，补一个入口很便宜。

## 拿什么证明它生效了

- 新增 `packages/core/tests/mcp/oauth-elicitation-b3.test.ts`，22 条全过；`oauth-callback-server.test.ts` 里两条旧断言按新语义改写（state 错 → 失败页 + 继续等；error 回调需带 state），`manager.test.ts` 里「disabled 不出现」改为「disabled 出现且状态为 disabled」。
- **变异自证**：去掉 state 校验 → D20/D22 三条变红；去掉 iss 比对 → D19 变红；把日志分支改回 `${url}`、或在 elicitation.ts 加回 `console.log(`，对应源码判据变红。
- 全量 `bun test` 13768 pass / 0 fail（首次 CI 抓到 `cli-login.test.ts` 依赖旧的「state 错立即终结」语义、以及全量跑时 logger 控制台输出混进 stdout 捕获，均已修）；`make build` 自检通过；oxlint、`lint:boundary` 全绿；`docs:gen-reference` 已重新生成（`/mcp` 参数提示多了 `approve`）。
- **没验证的**：没有对真实 OAuth 授权服务器（带 RFC 9207 的 AS）跑端到端，只用了本地 mock 回调；TUI 下真实 MCP server 发起 elicitation 时的对话框只验证到了「走提问桥」这一层，没做 TUI 端到端驱动；`/mcp approve` 热连接只单测了 `approveAndConnectPendingServer`，命令本身没有起会话实跑。
