---
title: Hook 事件
description: 全部 Hook 事件的配置键名、是否会触发与触发时机。
---

# Hook 事件

全部 Hook 事件的配置键名、是否会触发与触发时机。

<!--
  本页由脚本生成，请勿手工编辑
  AUTO-GEN:START 与 AUTO-GEN:END 标记之间的内容由
  scripts/docs-gen-reference.ts 从源码生成（数据源：HookEventName 枚举），
  手改会在下次生成时被覆盖，且 pre-commit 会先拦住。
  需要补充说明请写在标记之外——那部分内容会被保留。
  （此提示写给维护者，HTML 注释不会渲染给终端用户。）
-->

<!-- AUTO-GEN:START 由 scripts/docs-gen-reference.ts 生成，勿手工编辑 -->

> 共 **37** 类 Hook 事件（从 `HookEventName` 枚举导出），
> 其中 **31** 类当前有真实触发点。
>
> **第一列就是你写进 `settings.json` 的键名。** 两种写法运行时等价
> （`pre_tool_use` 与 `PreToolUse` 都认，内部会归一化），本表第一列给 snake_case，
> 第三列是 PascalCase（与 Claude Code 同名，[Hook 指南](/extend/hooks)的示例用这种）。
> 第一列是 PascalCase、枚举名列为 — 的 7 个事件**没有 snake_case 别名**，
> 配置里只能写这一种（不是漏写）。
>
> 「会触发」列标 ✗ 的事件**配了不会被调用**，分两种，触发时机列写明是哪一种：
> 「内部事件」写进配置会被跳过并在启动时告警；「刻意不做」能通过配置校验，
> 但 sid 没有对应场景，恒不触发（原因见 [Hook 指南](/extend/hooks)的刻意偏离表）。

| 配置里写 | 会触发 | 枚举名（源码内部） | 触发时机 |
|---|---|---|---|
| `pre_tool_use` | ✓ | `PreToolUse` | 工具执行前、权限检查之前触发。可 block（返回 deny 则工具不执行）。 |
| `post_tool_use` | ✓ | `PostToolUse` | 工具执行成功返回结果后触发。不可 block，仅可注入附加上下文。 |
| `post_tool_use_failure` | ✓ | `PostToolUseFailure` | 工具执行了但失败（返回错误或抛异常）后触发；权限拒绝走 PermissionDenied，不触发本事件。不可 block。 |
| `user_prompt_submit` | ✓ | `UserPromptSubmit` | 用户输入提交后、入上下文前触发。可 block（原 prompt 不入上下文）。 |
| `AfterAgent` | ✓ | — | 模型 end_turn 且无待执行工具后触发。不可 block，仅可请求清除上下文。 |
| `BeforeModel` | ✓ | — | 每轮 LLM 请求发出前触发。可 block（阻止本次请求并结束循环）。 |
| `AfterModel` | ✓ | — | 每轮 LLM 响应收全后触发。可 block（丢弃响应并结束循环）。 |
| `session_start` | ✓ | `SessionStart` | 会话启动 / resume / `/clear` 之后 / 压缩之后触发（matcher：source = startup / resume / clear / compact）。stdout 进上下文，不可 block。 |
| `session_end` | ✓ | `SessionEnd` | 会话退出前触发（exit / error / abort）。不可 block，超时即放弃。 |
| `pre_compact` | ✓ | `PreCompact` | 上下文压缩执行前触发。可 block（跳过本次压缩）。 |
| `post_compact` | ✓ | `PostCompact` | 上下文压缩完成后触发。不可 block，异常也不影响压缩结果。 |
| `subagent_start` | ✓ | `SubagentStart` | 子代理任务启动前触发。不可 block（block 降级为告警）。 |
| `subagent_stop` | ✓ | `SubagentStop` | 子代理任务结束后触发（finally）。不可 block，fire-and-forget。 |
| `notification` | ✓ | `Notification` | TUI 等待权限确认时触发（matcher：permission_prompt；sid 没有空闲提醒，不发 idle_prompt）。仅通知。 |
| `stop` | ✓ | `Stop` | 助手回答收尾、准备停止时触发。可 block（注入错误并重试修复）。 |
| `stop_failure` | ✓ | `StopFailure` | 轮次因 API 错误终止时触发（matcher：error_type）。仅通知。 |
| `setup` | ✗ | `Setup` | 刻意不做：sid 没有 `--init` / `--maintenance`，此事件恒不触发。 |
| `permission_request` | ✓ | `PermissionRequest` | 权限需用户确认时触发，与分类器、用户弹窗并行竞争、先到先决。可 block（返回 deny 则拒绝该工具）。 |
| `permission_denied` | ✓ | `PermissionDenied` | 权限拒绝后触发（主循环弹窗被拒 / 超时 / 规则直拒，子代理规则直拒 / 自动拒），仅通知、不可改判。 |
| `config_change` | ✓ | `ConfigChange` | settings 文件被外部修改后触发（matcher：user_settings / project_settings / local_settings / policy_settings）。可 block（回退到变更前的设置，policy_settings 除外）。 |
| `file_changed` | ✗ | `FileChanged` | 刻意不做：sid 没有监视任意文件的机制，此事件恒不触发。 |
| `cwd_changed` | ✓ | `CwdChanged` | bash `cd` 改变工作目录后触发。仅通知。 |
| `task_created` | ✓ | `TaskCreated` | task_create 创建任务成功后触发。仅通知（sid 暂不支持 exit 2 回滚创建）。 |
| `task_completed` | ✓ | `TaskCompleted` | task_update 把任务置为 completed 后触发。仅通知。 |
| `BeforePermissionCheck` | ✗ | — | （内部事件，不支持用户配置；写进配置会被跳过并告警） |
| `AfterPermissionCheck` | ✗ | — | （内部事件，不支持用户配置；写进配置会被跳过并告警） |
| `BeforeHookExecution` | ✗ | — | （内部事件，不支持用户配置；写进配置会被跳过并告警） |
| `AfterHookExecution` | ✗ | — | （内部事件，不支持用户配置；写进配置会被跳过并告警） |
| `instructions_loaded` | ✓ | `InstructionsLoaded` | 指令加载到上下文（CLAUDE.md / rules 加载后触发） |
| `teammate_idle` | ✓ | `TeammateIdle` | 团队代理空闲（可 block，用于团队协作场景） |
| `elicitation` | ✓ | `Elicitation` | MCP server 发来 elicitation 请求、弹给用户之前触发（matcher：server 名）。仅通知。 |
| `elicitation_result` | ✓ | `ElicitationResult` | 用户回复 MCP elicitation 之后触发（matcher：server 名）。仅通知。 |
| `post_tool_batch` | ✓ | `PostToolBatch` | 一批工具（含并行）全部执行完、结果回灌模型之前触发。仅通知。 |
| `pre_model_switch` | ✓ | `PreModelSwitch` | 切换模型之前触发（matcher：trigger = manual / fallback / config）。仅通知（sid 切换路径同步，不支持拒绝）。 |
| `post_model_switch` | ✓ | `PostModelSwitch` | 模型切换之后触发，含降级链自动切换（matcher：trigger = manual / fallback / config）。仅通知。 |
| `user_prompt_expansion` | ✓ | `UserPromptExpansion` | 斜杠命令 / skill 展开成 prompt 之后、提交之前触发（matcher：命令名）。stdout 进上下文。 |
| `directory_added` | ✓ | `DirectoryAdded` | /add-dir 把目录加入会话白名单之后触发。仅通知。 |

<!-- AUTO-GEN:END -->
