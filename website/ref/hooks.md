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

> 共 **32** 类 Hook 事件，从 `HookEventName` 枚举导出。
> 配置写在 `settings.json` 的 `hooks` 段，键名用下表的事件名
> （旧的 snake_case 写法仍兼容）。标「预留」的事件枚举已定义但当前无触发点，
> 配了不会被调用——这是实现现状，不是文档遗漏。

| 事件名 | 触发时机 |
|---|---|
| `PreToolUse` | 工具执行前、权限检查之前触发。可 block（返回 deny 则工具不执行）。 |
| `PostToolUse` | 工具执行成功返回结果后触发。不可 block，仅可注入附加上下文。 |
| `PostToolUseFailure` | 工具执行抛异常后触发。不可 block，fire-and-forget 不等待结果。 |
| `UserPromptSubmit` | 用户输入提交后、入上下文前触发。可 block（原 prompt 不入上下文）。 |
| `AfterAgent` | 模型 end_turn 且无待执行工具后触发。不可 block，仅可请求清除上下文。 |
| `BeforeModel` | 每轮 LLM 请求发出前触发。可 block（阻止本次请求并结束循环）。 |
| `AfterModel` | 每轮 LLM 响应收全后触发。可 block（丢弃响应并结束循环）。 |
| `SessionStart` | 会话启动或 resume 时触发。不可 block（block 降级为告警）。 |
| `SessionEnd` | 会话退出前触发（exit / error / abort）。不可 block，超时即放弃。 |
| `PreCompact` | 上下文压缩执行前触发。可 block（跳过本次压缩）。 |
| `PostCompact` | 上下文压缩完成后触发。不可 block，异常也不影响压缩结果。 |
| `SubagentStart` | 子代理任务启动前触发。不可 block（block 降级为告警）。 |
| `SubagentStop` | 子代理任务结束后触发（finally）。不可 block，fire-and-forget。 |
| `Notification` | 预留：有 fire 方法但无调用点，配了不会被触发。 |
| `Stop` | 助手回答收尾、准备停止时触发。可 block（注入错误并重试修复）。 |
| `StopFailure` | 预留：有 fire 方法但无调用点，配了不会被触发。 |
| `Setup` | 预留：有 fire 方法但无调用点，配了不会被触发。 |
| `PermissionRequest` | 权限需用户确认时、三路竞速中触发。可 block（返回 deny 则拒绝该工具）。 |
| `PermissionDenied` | 预留：有 fire 方法但无调用点，配了不会被触发。 |
| `ConfigChange` | 预留：有 fire 方法但无调用点，配了不会被触发。 |
| `FileChanged` | 预留：有 fire 方法但无调用点，配了不会被触发。 |
| `CwdChanged` | 预留：有 fire 方法但无调用点，配了不会被触发。 |
| `TaskCreated` | 预留：有 fire 方法但无调用点，配了不会被触发。 |
| `TaskCompleted` | 预留：有 fire 方法但无调用点，配了不会被触发。 |
| `BeforePermissionCheck` | 权限检查开始（spec 17 §6.1.3，用于 blocked_on_user span） |
| `AfterPermissionCheck` | 权限检查结束 |
| `BeforeHookExecution` | Hook 执行开始（用于 hook_execution span） |
| `AfterHookExecution` | Hook 执行结束 |
| `InstructionsLoaded` | G11：指令加载到上下文（CLAUDE.md / rules 加载后触发） |
| `TeammateIdle` | G11：团队代理空闲（可 block，用于团队协作场景） |
| `Elicitation` | G11：hook 反向向用户提问的协议（action: accept/decline/cancel），需配套 UI，先占位 |
| `ElicitationResult` | G11：Elicitation 的用户响应结果 |

<!-- AUTO-GEN:END -->
