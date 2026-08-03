---
title: Hook 事件
description: 全部 Hook 事件的名称、触发时机与载荷字段。
---

# Hook 事件

全部 Hook 事件的名称、触发时机与载荷字段。

<!--
  本页由脚本生成，请勿手工编辑
  AUTO-GEN:START 与 AUTO-GEN:END 标记之间的内容由
  scripts/docs-gen-reference.ts 从源码生成（数据源：HookEventName 枚举），
  手改会在下次生成时被覆盖，且 pre-commit 会先拦住。
  需要补充说明请写在标记之外——那部分内容会被保留。
  （此提示写给维护者，HTML 注释不会渲染给终端用户。）
-->

<!-- AUTO-GEN:START 由 scripts/docs-gen-reference.ts 生成，勿手工编辑 -->

> 共 **32** 类 Hook 事件（从 `HookEventName` 枚举导出），
> 其中 **17** 类当前有真实触发点。
>
> **第一列就是你写进 `settings.json` 的键名。** 两种写法运行时等价
> （`pre_tool_use` 与 `PreToolUse` 都认，内部会归一化），本表优先给 snake_case——
> 与[配置 Hook](/extend/hooks) 的示例保持一致，少一处需要读者自己换算的地方。
>
> 「会触发」列标 ✗ 的事件枚举已定义但**当前无调用点，配了不会被调用**——
> 这是实现现状，不是文档遗漏。它与「名字合不合法」是两个独立维度：
> 这些名字都能通过配置校验，只是不会有东西来触发它们。

| 配置里写 | 会触发 | 枚举名（源码内部） | 触发时机 |
|---|---|---|---|
| `pre_tool_use` | ✓ | `PreToolUse` | 工具执行前、权限检查之前触发。可 block（返回 deny 则工具不执行）。 |
| `post_tool_use` | ✓ | `PostToolUse` | 工具执行成功返回结果后触发。不可 block，仅可注入附加上下文。 |
| `post_tool_use_failure` | ✓ | `PostToolUseFailure` | 工具执行抛异常后触发。不可 block，fire-and-forget 不等待结果。 |
| `user_prompt_submit` | ✓ | `UserPromptSubmit` | 用户输入提交后、入上下文前触发。可 block（原 prompt 不入上下文）。 |
| `AfterAgent` | ✓ | — | 模型 end_turn 且无待执行工具后触发。不可 block，仅可请求清除上下文。 |
| `BeforeModel` | ✓ | — | 每轮 LLM 请求发出前触发。可 block（阻止本次请求并结束循环）。 |
| `AfterModel` | ✓ | — | 每轮 LLM 响应收全后触发。可 block（丢弃响应并结束循环）。 |
| `session_start` | ✓ | `SessionStart` | 会话启动或 resume 时触发。不可 block（block 降级为告警）。 |
| `session_end` | ✓ | `SessionEnd` | 会话退出前触发（exit / error / abort）。不可 block，超时即放弃。 |
| `pre_compact` | ✓ | `PreCompact` | 上下文压缩执行前触发。可 block（跳过本次压缩）。 |
| `post_compact` | ✓ | `PostCompact` | 上下文压缩完成后触发。不可 block，异常也不影响压缩结果。 |
| `subagent_start` | ✓ | `SubagentStart` | 子代理任务启动前触发。不可 block（block 降级为告警）。 |
| `subagent_stop` | ✓ | `SubagentStop` | 子代理任务结束后触发（finally）。不可 block，fire-and-forget。 |
| `notification` | ✗ | `Notification` | （枚举已定义，等接线） |
| `stop` | ✓ | `Stop` | 助手回答收尾、准备停止时触发。可 block（注入错误并重试修复）。 |
| `stop_failure` | ✗ | `StopFailure` | （枚举已定义，等接线） |
| `setup` | ✗ | `Setup` | （枚举已定义，等接线） |
| `permission_request` | ✓ | `PermissionRequest` | 权限需用户确认时、三路竞速中触发。可 block（返回 deny 则拒绝该工具）。 |
| `permission_denied` | ✗ | `PermissionDenied` | （枚举已定义，等接线） |
| `config_change` | ✗ | `ConfigChange` | （枚举已定义，等接线） |
| `file_changed` | ✗ | `FileChanged` | （枚举已定义，等接线） |
| `cwd_changed` | ✗ | `CwdChanged` | （枚举已定义，等接线） |
| `task_created` | ✗ | `TaskCreated` | （枚举已定义，等接线） |
| `task_completed` | ✗ | `TaskCompleted` | （枚举已定义，等接线） |
| `BeforePermissionCheck` | ✗ | — | （枚举已定义，等接线） |
| `AfterPermissionCheck` | ✗ | — | （枚举已定义，等接线） |
| `BeforeHookExecution` | ✗ | — | （枚举已定义，等接线） |
| `AfterHookExecution` | ✗ | — | （枚举已定义，等接线） |
| `instructions_loaded` | ✓ | `InstructionsLoaded` | G11：指令加载到上下文（CLAUDE.md / rules 加载后触发） |
| `teammate_idle` | ✓ | `TeammateIdle` | G11：团队代理空闲（可 block，用于团队协作场景） |
| `elicitation` | ✗ | `Elicitation` | （枚举已定义，等接线） |
| `elicitation_result` | ✗ | `ElicitationResult` | （枚举已定义，等接线） |

<!-- AUTO-GEN:END -->
