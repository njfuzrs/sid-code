---
title: Hook 指南
description: 用三个可直接粘的真实场景讲清 Hook 怎么写、怎么调、怎么排错。
---

# Hook 指南

Hook 是「在固定时机自动跑一段你自己的命令」。三类典型用途：**拦住不该做的事**、
**改完自动做点什么**、**每轮对话自动补上下文**。

这页给三个完整可用的场景，每个都实跑验证过。全部 32 类事件的名称与触发时机在
[Hook 事件](/ref/hooks)，字段类型在[settings.json 字段](/ref/settings)——
这页只讲怎么写出一个能跑起来的 hook。

::: danger 先记住这条，否则你的 hook 静默不生效
settings.json 里的 hook 对象必须是**平铺**的——`matcher` / `command` 与 `type` 同级：

```json
{ "type": "command", "matcher": "edit|write", "command": "..." }   // ✓ 生效
{ "matcher": "edit|write", "hooks": [{ "type": "command", "command": "..." }] }   // ✗ 不生效
```

写成嵌套的 `{matcher, hooks:[...]}` 会被**静默丢弃**（加载时不报错、不打日志，
只有跑 `/doctor` 或看 settings 校验才会看到「command 类型的 Hook 必须指定 command 字段」）。
这是最难自查的一种错：配置看着没问题，hook 就是不触发。

事件名两种写法都认：`pre_tool_use` 与 `PreToolUse` 等价（内部会归一化）。
本页统一用 snake_case，与[Hook 事件](/ref/hooks)参考页的「配置里写」列一致。

<!--
  ⚠ 这个框曾经还写着「写 PascalCase 会被配置校验器判为未知事件名」——那条已经不成立。
  当时 src/config/schema.ts 的 VALID_HOOK_EVENTS 是一份手写的 12 条 snake_case 清单，
  而 registry 的 resolveEventName 对 PascalCase 和 snake_case 都认，于是用户按参考页
  （从 HookEventName 枚举生成，全 PascalCase）写完，hook 能正常触发却收到一条
  「未知的事件名」告警。2026-08-03 已把该清单改成从枚举 + LEGACY_EVENT_MAP 派生，
  假告警消除。别再把「PascalCase 不合法」写回来。

  嵌套形状不生效这条**是真的**，实测过：settings.json 走的是
  app.ts:836 → registry.initializeFromLegacy（认平铺），
  而认嵌套的 initializeFromNew 在生产里没有任何调用方。
  注意 agent frontmatter 里的 hooks 用的是嵌套形状，两者不通用，别互相照抄。
-->
:::

## 最小可用示例

`~/.sid-code/settings.json`：

```json
{
  "hooks": {
    "post_tool_use": [
      {
        "type": "command",
        "matcher": "edit|write",
        "command": "echo \"[hook] 改了 $SID_CODE_TOOL_NAME\" >> /tmp/sid-hook.log"
      }
    ]
  }
}
```

跑一个会改文件的任务，然后看日志。实测输出：

```text
[hook] 改了 edit
```

`matcher` 是工具名的正则，`edit|write` 匹配这两个工具。不写 `matcher` 就是该事件全部触发。

## 场景一：拦住不该跑的命令

用 `pre_tool_use` + **退出码 2**。这是唯一的阻断信号：

```json
{
  "hooks": {
    "pre_tool_use": [
      {
        "type": "command",
        "matcher": "bash",
        "command": "if echo \"$SID_CODE_TOOL_INPUT\" | grep -q 'git push'; then echo '本仓库禁止直接 git push，请走 PR' >&2; exit 2; fi"
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
| `0` | 放行 | stdout 作为提示信息展示 |
| `2` | **阻断** | stderr 作为拒绝理由回传给模型 |
| 其他 | 放行，但记一条告警 | stderr 前面加「警告:」展示 |

只有 `2` 是阻断。写成 `exit 1` 是常见错误——那会被当成「hook 自己出错了」，工具照样执行。

## 场景二：改完文件自动做点什么

`post_tool_use` 在工具成功返回后触发，**不能阻断**，适合格式化、打日志、发通知：

```json
{
  "hooks": {
    "post_tool_use": [
      {
        "type": "command",
        "matcher": "edit|write",
        "command": "f=$(echo \"$SID_CODE_TOOL_INPUT\" | jq -r .file_path); case \"$f\" in *.ts|*.tsx) npx prettier --write \"$f\" ;; esac"
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
`post_tool_use` 每次文件修改都会触发，一次任务里可能几十次。
跑全量 lint 或全量测试会显著拖慢会话。要跑重活加 `"async": true`
让它后台执行，或者挪到 `stop` 事件（一轮结束才跑一次）。
:::

## 场景三：每轮自动补上仓库现状

让模型每轮都知道当前分支、有多少未提交改动，不用它自己跑 `git status`。

这里有个坑：**`session_start` 的输出进不了上下文**——它是 fire-and-forget，
返回值被丢弃。要注入上下文得用 `user_prompt_submit`，并且输出**必须是 JSON**：

```json
{
  "hooks": {
    "user_prompt_submit": [
      {
        "type": "command",
        "command": "printf '{\"hookSpecificOutput\":{\"additionalContext\":\"[仓库现状] 分支=%s, 未提交=%s 个文件\"}}' \"$(git branch --show-current)\" \"$(git status --porcelain | wc -l | tr -d ' ')\""
      }
    ]
  }
}
```

实测生效日志：

```text
● [HOOK] 用户输入被 hook 追加上下文
```

追加的内容会拼在用户输入后面，模型直接就能用——实测问它「当前分支？」
它不跑任何命令就答出了 `master`。

::: warning 光 echo 一段文本不会进上下文
只有 `hookSpecificOutput.additionalContext` 这个 JSON 字段会被当作上下文注入。
纯文本 stdout 只会作为提示信息展示给你看，模型看不到。
这是「hook 明明跑了但模型说不知道」最常见的原因。
:::

## 可用的环境变量

hook 命令能直接读这些（另外完整的事件载荷 JSON 会从 **stdin** 传进来）：

| 变量 | 内容 | 哪些事件有 |
| --- | --- | --- |
| `SID_CODE_HOOK_EVENT` | 事件名 | 全部 |
| `SID_CODE_PROJECT_DIR` | 项目目录 | 全部（命令里写 `$SID_CODE_PROJECT_DIR` 会被展开） |
| `SID_CODE_SESSION_ID` | 会话 ID | 全部 |
| `SID_CODE_TOOL_NAME` | 工具名 | 工具类事件 |
| `SID_CODE_TOOL_INPUT` | 工具入参 JSON | 工具类事件 |
| `SID_CODE_TOOL_OUTPUT` | 工具返回 JSON | `post_tool_use` |
| `SID_CODE_TOOL_IS_ERROR` | 是否失败 | `post_tool_use_failure` |
| `SID_CODE_USER_INPUT` | 用户原始输入 | `user_prompt_submit` |
| `SID_CODE_MODEL` | 模型名 | 模型类事件 |
| `SID_CODE_STOP_REASON` | 停止原因 | `after_model` |
| `SID_CODE_AGENT_TYPE` | 子代理类型 | 子代理类事件 |

## 除了跑命令，还有四种 hook 类型

`type` 字段可选值不止 `command`：

| type | 干什么 | 适合 |
| --- | --- | --- |
| `command` | 跑 shell 命令 | 绝大多数场景 |
| `url` | POST 到一个 HTTP 端点 | 发通知、上报到内部系统 |
| `prompt` | 用 LLM 做一次判断 | 「这个改动符合规范吗」这类没法用 grep 表达的校验 |
| `agent` | 起一个多轮 agent 做验证 | 需要读文件、跑命令才能判断的复杂校验 |

`prompt` 和 `agent` 会真的调模型，**要花钱也要花时间**，别挂在高频事件上。

其他常用字段：`timeout`（毫秒）、`async`（后台跑不阻塞）、`env`（额外环境变量）、
`name`（给 hook 起名，便于 `/hooks` 面板管理）。

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
# 1. 先确认配置能过校验——启动时不该有 ✗ 或 ⚠ 提示
sid-code 2>&1 | grep -iE "hooks\.|未知的事件名"

# 2. 确认 hook 被触发（--debug 下会打印 [HOOK] 行）
sid-code --debug -p "改一下 a.ts" 2>&1 | grep "\[HOOK\]"

# 3. 单独跑一遍命令本身，排除 shell 语法问题
echo '{}' | sh -c '你的 command'
```

## 常见问题

### 配了但完全没反应

按顺序查这四个：

<!--
  ⚠ 第 1 条曾是「事件名写成 PascalCase 了」——已删，那不是失效原因（两种写法运行时等价）。
  第 3 条曾写「标了『预留』的 12 个事件」，两处错：个数是 15 不是 12，且判据不该是
  注释里的「预留」二字（注释还有「先占位」这种同义写法，漏标了 6 个）。
  现在参考页的「会触发」列按**实际有没有调用方**生成，这里只需指过去，不再自己数。
-->

1. **写成嵌套格式了**——`matcher` 要和 `command` 平级，不要套 `hooks: [...]`。
   这是最常见的一条，因为 agent frontmatter 里的 hooks 恰好是嵌套形状，容易照抄过来。
   现在加载时会打一条明确告警（`用了嵌套形状…本条已跳过`），看日志能直接确认
2. **`matcher` 没匹配上**——先把 `matcher` 整个删掉试，能触发就是它的问题。
   注意纯字母数字加竖线（`edit|write`）是**精确匹配**而非正则，且大小写敏感：
   工具名都是小写，写 `Edit|Write` 匹配不上
3. **事件本身还没接线**——[Hook 事件](/ref/hooks)的「会触发」列标 ✗ 的那些，
   枚举已定义但当前没有触发点，配了也不会调。这是实现现状，不是你配错了

### hook 跑了但模型不知道

见场景三：要用 `hookSpecificOutput.additionalContext` 的 JSON 形式，纯 stdout 模型看不到。

### 想拦但没拦住

只有 `exit 2` 是阻断信号。而且不是所有事件都可阻断——
`post_tool_use`、`session_start`、`subagent_stop` 这些标了「不可 block」的，
返回什么都不会拦住流程（`session_start` 的 block 会降级成告警）。
可阻断的事件在[Hook 事件](/ref/hooks)里逐个标了。

### 会话变慢了

大概率是高频事件上挂了重活。`pre_tool_use` / `post_tool_use` 一次任务能触发几十次，
每次都同步等着。加 `"async": true`，或者把命令挪到 `stop`（一轮一次）。

### 团队统一下发 hook

写进项目级 `<项目>/.sid-code/settings.json` 提交 git，或用企业策略
`/etc/sid-code/policy.json` 强制下发（用户改不掉）。见[团队默认配置分发](/team/defaults)。

## 相关

- [Hook 事件](/ref/hooks) —— 全部 32 类事件的名称、触发时机、能否 block
- [settings.json 字段](/ref/settings) —— `hooks` 段的完整字段类型
- [扩展方式总览](/extend/) —— 该用 CLAUDE.md / Skill / Hook / MCP 里的哪个
- [权限与人工确认](/use/permissions) —— 静态规则拦命令，比写 hook 更省事
- [团队默认配置分发](/team/defaults) —— 把 hook 发给整个团队
