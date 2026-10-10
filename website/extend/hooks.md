---
title: Hook 指南
description: 用三个可直接粘的真实场景讲清 Hook 怎么写、怎么调、怎么排错。
---

# Hook 指南

Hook 是「在固定时机自动跑一段你自己的命令」。三类典型用途：**拦住不该做的事**、
**改完自动做点什么**、**每轮对话自动补上下文**。

这页给三个完整可用的场景。全部事件的名称、是否会触发与触发时机在
[Hook 事件](/ref/hooks)，字段类型在[settings.json 字段](/ref/settings)——
这页只讲怎么写出一个能跑起来的 hook。

::: tip 格式与 Claude Code 一致
推荐写法与 CC 相同——`matcher` 分组包裹一个 `hooks` 数组；sid-code 早期的平铺写法也永久兼容：

```json
{ "matcher": "Edit|Write", "hooks": [{ "type": "command", "command": "..." }] }   // ✓ 推荐（与 CC 一致）
{ "type": "command", "matcher": "edit|write", "command": "..." }                 // ✓ 兼容
```

事件名两种写法等价（`PreToolUse` 与 `pre_tool_use`），工具名 CC 名与内部名都认（`Bash` 与 `bash`）。
从 CC 搬过来的 hooks 段不用改，见[从 Claude Code 迁移](/team/migrate)。

配置有问题的条目会被跳过并在启动时打一行带来源文件与原因的提示，
`sid-code hooks list` 可以随时看实际注册了哪些。
:::

## 最小可用示例

`~/.sid-code/settings.json`：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "echo \"[hook] 改了 $SID_CODE_TOOL_NAME\" >> /tmp/sid-hook.log" }
        ]
      }
    ]
  }
}
```

跑一个会改文件的任务，然后看日志。实测输出：

```text
[hook] 改了 edit
```

`matcher` 有三档（与 CC 一致）：只含字母、数字、`_` 和 `|` 时是**精确匹配**（`Edit|Write` 匹配这两个工具）；
含其他字符时按正则（如 `mcp__github__.*`）；不写或写 `*` 就是该事件全部触发。
工具名写 CC 名（`Edit`）或内部名（`edit`）都能匹配上。环境变量 `SID_CODE_TOOL_NAME` 里是内部名。

生命周期事件（`SessionStart` 等）的 `matcher` 匹配的是触发来源，同样可以用 `|` 列多个：`"startup|resume"`。

`if` 字段用权限规则语法做更细的过滤（如 `"if": "Bash(git *)"`），只在 `PreToolUse` / `PostToolUse` / `PostToolUseFailure` / `PermissionRequest` 上有效。配在别的事件上永远不会触发，加载时会打 warn。

## 场景一：拦住不该跑的命令

用 `PreToolUse` + **退出码 2**。这是唯一的阻断信号：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "if echo \"$SID_CODE_TOOL_INPUT\" | grep -q 'git push'; then echo '本仓库禁止直接 git push，请走 PR' >&2; exit 2; fi"
          }
        ]
      }
    ]
  }
}
```

实测（把条件放宽成拦所有 bash 后跑「用 bash 跑一下 ls」）：

```text
⚠ [HOOK] [PreToolUse] 1 成功, 1 失败, 耗时 12ms
● [HOOK] 工具 bash 被 PreToolUse hook 阻止:
  [hook] 拦截 bash: {"command":"ls","description":"列出当前目录内容"}
```

**关键点：stderr 会回传给模型，模型会据此改做法。** 同一次实测里它的反应是：

```text
bash 的 `ls` 被 hook 拦截了。根据工具使用原则，列目录本来就该用专用的 `ls` 工具，我来用它：
```

所以拦截理由要写得像给人看的说明，而不是 `exit 2` 了事——写清楚「为什么不行、该怎么做」，
模型才能自己绕对。

### 退出码约定

| 退出码 | 含义 | stderr 去哪 |
| --- | --- | --- |
| `0` | 放行 | stdout 是 JSON 时按字段解析；`SessionStart` / `UserPromptSubmit` 的纯文本 stdout 进上下文，其余事件只作提示展示 |
| `2` | **阻断** | stderr 作为拒绝理由回传给模型（`PostToolUse` / `PostToolUseFailure` 上不阻断，但 stderr 同样回灌给模型） |
| 其他 | 放行，但记一条告警 | stderr 前面加「警告:」展示 |

只有 `2` 是阻断。写成 `exit 1` 是常见错误——那会被当成「hook 自己出错了」，工具照样执行。

想输出结构化 JSON（`decision` / `hookSpecificOutput` 等）就写到 **stdout**。stderr 里的内容只当文本，即使恰好是 JSON 也不会被解析。`exit 2` 一律阻断，stdout 的 JSON 写了 `"decision": "allow"` 也翻不过来。

## 场景二：改完文件自动做点什么

`PostToolUse` 在工具**成功**返回后触发，**不能阻断**，适合格式化、打日志、发通知。
工具执行了但失败（返回错误或抛异常）走的是 `PostToolUseFailure`，权限拒绝走 `PermissionDenied`——与 CC 一致：

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "f=$(echo \"$SID_CODE_TOOL_INPUT\" | jq -r .file_path); case \"$f\" in *.ts|*.tsx) npx prettier --write \"$f\" ;; esac"
          }
        ]
      }
    ]
  }
}
```

`SID_CODE_TOOL_INPUT` 是完整的工具入参 JSON，用 `jq` 取字段。实测这个变量的真实内容：

```json
{"file_path":"/private/tmp/sidhook/a.ts","new_string":"return 42","old_string":"return 1","replace_all":false}
```

::: tip 别在这里跑重活
`PostToolUse` 每次文件修改都会触发，一次任务里可能几十次。
跑全量 lint 或全量测试会显著拖慢会话。要跑重活加 `"async": true`
让它后台执行，或者挪到 `Stop` 事件（一轮结束才跑一次）。
:::

## 场景三：会话开始时补上仓库现状

让模型一开始就知道当前分支、有多少未提交改动，不用它自己跑 `git status`。
`SessionStart` 与 `UserPromptSubmit` 的 exit 0 **纯文本 stdout 会作为上下文给模型**（与 CC 一致）：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "echo \"[仓库现状] 分支=$(git branch --show-current), 未提交=$(git status --porcelain | wc -l | tr -d ' ') 个文件\""
          }
        ]
      }
    ]
  }
}
```

注入的内容以独立的 `<system-reminder>` 交给模型，不会拼进用户原文。
想每轮都刷新就挂在 `UserPromptSubmit` 上；也可以输出 JSON，写在 `hookSpecificOutput.additionalContext` 里，效果相同。

`SessionStart` 会在第一轮之前**同步等待**，缺省超时 30 秒（CC 是 600 秒，见下方差异表）——别在这里跑慢命令。

与 CC 一致，`SessionStart` 在 `/clear` 之后（`source` 为 `clear`）和上下文压缩之后（`source` 为 `compact`）**会再触发一次**，
输出在下一条消息前重新注入——清空或压缩会把启动时注入的内容一起丢掉。只想在启动时跑，就把 `matcher` 写成 `"startup|resume"`。

::: warning 其他事件的纯文本 stdout 不进上下文
除这两个事件外，exit 0 的纯文本 stdout 只作为提示信息展示给你看，模型看不到。
要给模型看，用 JSON 的 `hookSpecificOutput.additionalContext`（`PostToolUse` 等支持），
或者在 `PostToolUse` 上 `exit 2` 把 stderr 回灌给模型。
:::

## 可用的环境变量

hook 命令能直接读这些（另外完整的事件载荷 JSON 会从 **stdin** 传进来）：

| 变量 | 内容 | 哪些事件有 |
| --- | --- | --- |
| `SID_CODE_HOOK_EVENT` | 事件名 | 全部 |
| `SID_CODE_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` | 会话启动时的项目根，`bash cd` 之后也不变 | 全部 |
| `SID_CODE_CWD` | 当前工作目录（随 `bash cd` 变化） | 全部 |
| `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA` | 插件根目录 / 插件数据目录 | 插件来源的 hook |
| `SID_CODE_SESSION_ID` | 会话 ID | 全部 |
| `SID_CODE_TOOL_NAME` | 工具名 | 工具类事件 |
| `SID_CODE_TOOL_INPUT` | 工具入参 JSON | 工具类事件 |
| `SID_CODE_TOOL_OUTPUT` | 工具返回 JSON | `PostToolUse` / `PostToolUseFailure` |
| `SID_CODE_TOOL_IS_ERROR` | 是否失败（`PostToolUse` 上恒为 `false`） | 载荷里带 `is_error` 的工具类事件 |
| `SID_CODE_TOOL_USE_ID` | 本次工具调用的 ID | 工具类事件 |
| `SID_CODE_USER_INPUT` | 用户原始输入 | `UserPromptSubmit` |
| `SID_CODE_MODEL` | 模型名 | 模型类事件 |
| `SID_CODE_STOP_REASON` | 停止原因 | `AfterModel` |
| `SID_CODE_AGENT_ID` | 子代理 ID | 子代理类事件 |
| `SID_CODE_AGENT_TYPE` | 子代理类型 | 子代理类事件 |

完整的事件载荷（含 `session_id`、`transcript_path`、`cwd`、`permission_mode`、`hook_event_name` 等 CC 通用字段）从 stdin 以 JSON 传入。

命令串会原样交给 `sh -c`，sid-code 不做任何字符串替换，`$SID_CODE_PROJECT_DIR` / `${CLAUDE_PROJECT_DIR}` 这类变量由 shell 从环境变量展开。所以按 shell 的正常规则写：要展开就用双引号（`"$SID_CODE_PROJECT_DIR"`），单引号里不会展开。目录名里有 `$(...)`、反引号、空格也安全，hook 拿到的就是原始路径。

## 除了跑命令，还有四种 hook 类型

`type` 字段可选值不止 `command`：

| type | 干什么 | 适合 |
| --- | --- | --- |
| `command` | 跑 shell 命令 | 绝大多数场景 |
| `url`（也认 CC 的 `http`） | POST 到一个 HTTP 端点 | 发通知、上报到内部系统 |
| `prompt` | 用 LLM 做一次判断 | 「这个改动符合规范吗」这类没法用 grep 表达的校验 |
| `agent` | 起一个多轮 agent 做验证 | 需要读文件、跑命令才能判断的复杂校验 |

`prompt` 和 `agent` 会真的调模型，**要花钱也要花时间**，别挂在高频事件上。

其他常用字段：`timeout`（**秒**。缺省值与 CC 相同：`command` / `url` 600、`prompt` 30、`agent` 60；`UserPromptSubmit` 与 `SessionStart` 上的 `command` / `url` 是 30。写 `5000` 是 83 分钟，不是 5 秒）、`async`（后台跑不阻塞，**不受 `timeout` 限制**；`asyncRewake` 仍受限。**代价是放弃决策权**：挂在 `PreToolUse` 这类可拦截事件上，exit 2 / deny 都赶不上本轮决策，加载时会打 warn）、`env`（额外环境变量，只对 `command` 生效）、
`sequential`（`true` 时该事件这一批 hook 按顺序串行，默认并行）、`name`（给 hook 起名，便于 `/hooks` 面板管理）。

`url` 类型的请求经 SSRF 防护：内网与云元数据地址（`10.*`、`192.168.*`、`169.254.*` 等）会被拦，本机 `127.0.0.1` / `localhost` 放行。
`headers` 里的 `$VAR` 只会替换 `allowedEnvVars` 里列出的变量，其余替换成空串：

```json
{ "type": "url", "url": "https://hooks.example.com/audit",
  "headers": { "Authorization": "Bearer $AUDIT_TOKEN" }, "allowedEnvVars": ["AUDIT_TOKEN"] }
```

## 管理与调试

会话里管 hook，不用重启：

```text
/hooks                    打开管理面板
/hooks list               列出全部 hook 及启用状态
/hooks disable <name>     临时禁用（仅本次会话）
/hooks disable <name> -p  写进配置，跨会话保留
/hooks enable-all
```

调试三步：

```bash
# 1. 确认 hook 注册上了（被跳过的条目会列出原因）
sid-code hooks list --json

# 2. 确认 hook 被触发（--debug 下会打印 [HOOK] 行）
sid-code --debug -p "改一下 a.ts" 2>&1 | grep "\[HOOK\]"

# 3. 单独跑一遍命令本身，排除 shell 语法问题
echo '{}' | sh -c '你的 command'
```

## 常见问题

### 配了但完全没反应

按顺序查这四个：

1. **没注册上**——跑 `sid-code hooks list`。被跳过的条目会单独列出并给出原因，
   最常见的是「未信任工作区，已跳过」：项目级 hooks 只在信任过的工作区加载，
   `-p` 下用 `--trust-workspace` 本会话放行（SDK 宿主 spawn 时把这个参数加进命令行）
2. **配错了文件**——sid-code 读 `~/.sid-code/settings.json`、`<项目>/.sid-code/settings.json`、
   `<项目>/.sid-code/settings.local.json`，**不读** CC 的 `~/.claude/settings.json` 与 `.claude/settings.json`
3. **`matcher` 没匹配上**——先把 `matcher` 整个删掉试，能触发就是它的问题。
   纯字母数字加竖线（`Edit|Write`）是**精确匹配**而非正则；CC 名与内部名都认
4. **事件本身还没接线**——[Hook 事件](/ref/hooks)的「会触发」列标 ✗ 的那些，
   枚举已定义但当前没有触发点，配了也不会调。这是实现现状，不是你配错了

### hook 跑了但模型不知道

见场景三：只有 `SessionStart` / `UserPromptSubmit` 的纯文本 stdout 进上下文，其余事件要用 `hookSpecificOutput.additionalContext` 的 JSON 形式。

### 想拦但没拦住

只有 `exit 2`（或 stdout JSON 的 `decision:"block"`）是阻断信号。而且不是所有事件都可阻断——
`PostToolUse`、`SessionStart`、`SubagentStop` 这些标了「不可 block」的，
返回什么都不会拦住流程（`SessionStart` 的 block 会降级成告警）。
可阻断的事件在[Hook 事件](/ref/hooks)里逐个标了。

### 会话变慢了

大概率是高频事件上挂了重活。`PreToolUse` / `PostToolUse` 一次任务能触发几十次，
每次都同步等着。加 `"async": true`，或者把命令挪到 `Stop`（一轮一次）。

### 团队统一下发 hook

写进项目级 `<项目>/.sid-code/settings.json` 提交 git（成员信任该工作区后加载），或用企业策略
`/etc/sid-code/policy.json` 强制下发（用户改不掉）。见[团队默认配置分发](/team/defaults)。

## 与 Claude Code 的差异

除下表外，格式、事件名、工具名、退出码与 JSON 输出语义都与 CC 一致。下表是**刻意**的不同：

| 项 | Claude Code | sid-code | 理由 |
| --- | --- | --- | --- |
| 配置文件位置 | `~/.claude/` 与 `.claude/` | `~/.sid-code/` 与 `.sid-code/` | 不读 CC 的配置文件，CC 配置走[迁移](/team/migrate) |
| 平铺写法 | 不支持 | 兼容读取 | 存量 sid-code 用户 |
| `url` 类型名 | `http` | `http` 与 `url` 都认 | 存量兼容 |
| `-p` / SDK 下的项目级 hooks | 视为已信任 | 未信任不加载，`--trust-workspace` 本会话放行 | 更安全：项目级 hooks 随仓库分发，等于执行仓库里的任意命令 |
| `--dangerously-skip-permissions` | — | 跳过信任门，项目级 hooks 加载 | 该模式本就允许任意命令 |
| `SessionStart` 缺省超时 | 600 秒 | 30 秒 | 第一轮之前同步等待，挂住的 hook 会让启动看起来卡死 |
| 导出的 `CLAUDE_*` 变量 | 全套 | 仅 `CLAUDE_PROJECT_DIR` / `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DATA`（skill 来源另有 `CLAUDE_SKILL_DIR`）；父进程里的其他 `CLAUDE_*`（如 `CLAUDE_ENV_FILE`）不透传 | 不导出 sid-code 里没有对应语义的变量 |
| stdin `tool_name` | CC 名 | CC 名，另带 `sid_tool_name`；sid 独有工具与 MCP 工具发内部名 | 内部轨迹口径不变 |
| `PreModelSwitch` | 可拒绝切换 | 仅通知 | 切换路径是同步的 |
| `TaskCreated` | exit 2 回滚创建 | 仅通知 | 任务已落盘后才触发 |
| `ConfigChange` 的 block | 拒绝变更生效 | 回退内存中的设置，磁盘文件不改；`policy_settings` 不可 block（与 CC 同） | 不替用户改写他刚保存的文件 |
| `shell` 字段 | `bash` / `powershell` | 只认 `bash` / `sh`，`powershell` 告警后按 `sh` 执行 | 目前只支持 POSIX shell |
| `CLAUDE_SKILL_DIR` | skill 内可用 | skill 来源的 hook 额外导出 | 与 skill 正文的 `${CLAUDE_SKILL_DIR}` 同语义 |
| `Notification` 的 matcher | `permission_prompt` / `idle_prompt` 等 | 目前只发 `permission_prompt` | sid-code 没有空闲提醒 |
| 独有事件 | — | `AfterAgent` / `BeforeModel` / `AfterModel` | 主循环可观测与拦截 |
| 独有 stdin 字段 | — | `timestamp`、`device_id` / `user_id` / `org_id` / `team_id`、`harness_context`、`SubagentStop` 的 `usage` / `turns` / `model` | 企业身份与可观测 |
| `mcp_tool` 类型 | 支持 | 识别但不执行 | 单独立项 |
| `FileChanged` / `Setup` / `WorktreeCreate` / `WorktreeRemove` / `MessageDisplay` | 支持 | 本轮未接线 | 没有对应场景或另行立项 |

`BeforePermissionCheck` / `AfterPermissionCheck` / `BeforeHookExecution` / `AfterHookExecution` 是 trace 内部事件，
写进用户配置会被跳过并告警。

## 相关

- [Hook 事件](/ref/hooks) —— 全部事件的名称、是否会触发、触发时机
- [settings.json 字段](/ref/settings) —— `hooks` 段的完整字段类型
- [扩展方式总览](/extend/) —— 该用 CLAUDE.md / Skill / Hook / MCP 里的哪个
- [权限与人工确认](/use/permissions) —— 静态规则拦命令，比写 hook 更省事
- [团队默认配置分发](/team/defaults) —— 把 hook 发给整个团队
