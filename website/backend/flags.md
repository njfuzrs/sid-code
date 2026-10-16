---
title: Feature Flag
description: 在管理台维护全局 Feature Flag：能用来做什么、不能用来做什么、员工端什么时候拿到、拉取失败或员工本地覆盖时会怎样。
---

# Feature Flag

这页写给**用管理台的管理员**：怎么在「Flag」页新建、改值、停用一个开关，以及员工的 sid-code 什么时候拿到它。

Flag 是**全局一份键值表**。所有客户端拿到的都是同一份，**没有层的概念**：不能只给组织 `acme` 或团队 `platform` 下发，也没有按比例灰度。要按组织、团队、设备区分，用[策略](/backend/policy)或[预算](/backend/budget)。

目前客户端真正读取的 Flag 只有三个，都和遥测有关，见[客户端读取的 Flag](#客户端读取的-flag)。如果你不打算调事件采样或紧急关停某个上报后端，这页可以跳过。

::: warning Flag 只能收紧，不能放宽
下发端点 `GET /api/v1/ctl/flags` **不鉴权**，谁都能读到，传输链路上也没有设备凭据保护。所以 Flag 只能用来施加约束或灰度，**不能用来放宽任何安全限制**。放宽类的需求走[策略](/backend/policy)，那条通道要设备凭据。

为此后端在**写入时**检查 key 和说明：出现下面任一个词就返回 **422**，不会存进库里。

`bypass`、`disable_sandbox`、`disable_hook`、`disable_all_hook`、`disable_permission`、`disable_guardrail`、`disable_policy`、`disable_audit`、`disable_security`、`skip_permission`、`skip_sandbox`、`dangerously`、`unsafe`、`no_sandbox`、`allow_all`、`unrestricted`、`god_mode`

匹配是**子串**匹配，比较前会转小写，并把 `-`、`.`、空格等分隔符当成下划线或去掉。所以 `disable_sandbox_v2`、`disable-sandbox`、`disableSandbox`、`allowBypass` 都会被拦。误伤时改个名字即可。
:::

## 联动：配了之后员工那边会怎样

| 你在管理台做了什么 | sid-code 什么时候知道 | 拉取失败时 | 员工看到什么 |
| --- | --- | --- | --- |
| 新建 / 改值 / 启用一个 Flag | 下次启动时拉一次，之后每 6 小时一次。中间代理可能再缓存最多 5 分钟 | 沿用上一次成功拉到的值（内存里的，或磁盘缓存 `~/.sid-code/feature-flags-cache.json`） | 无提示。只影响下面几个 Flag 对应的行为 |
| 停用 / 删除一个 Flag | 同上。它不再出现在下发结果里 | 同上，客户端继续用旧值直到下一次拉取成功 | 无提示。客户端回落到本地配置或代码里的默认值 |
| 员工设了 `SID_CODE_FLAG_<KEY>` 环境变量 | —— | —— | 以环境变量为准，管理台的值对这台机器无效 |
| 员工开了 `essential-traffic` | 不拉取 | —— | 只用本地配置和默认值 |

几个细节：

- **地址由 `backend.url` 推出**。配了 `https://agent.example.com/traj`，客户端就拉 `https://agent.example.com/traj/api/v1/ctl/flags`。旧的 `analytics.featureFlagEndpoint` 只作兼容（见[配置项](/ref/settings)）。
- **全量替换**。每次拉取成功，客户端清空内存里的远程值再整份重填。下发结果里少了某个 key，客户端就认为它被删了。
- **超时 5 秒，不重试**。非 2xx 响应或网络错误都静默忽略，不打日志给员工看，下一个周期再试。
- **启动时先读磁盘缓存**，再在后台拉远程。所以一次会话刚开始的那段时间，用的可能是上次缓存的值。
- **响应头是 `Cache-Control: public, max-age=300`**。客户端本身不缓存 HTTP 响应，这 5 分钟是给 nginx 等中间层用的，挡住大量客户端同时冷启动。
- **隐私级别**：只有 `essential-traffic` 会关掉 Flag 拉取；`no-telemetry` 照常拉取（见[隐私与数据流向](/use/privacy#三个隐私级别)）。

客户端取值的优先级：

| 顺序 | 来源 |
| --- | --- |
| 1 | 环境变量 `SID_CODE_FLAG_<KEY>` |
| 2 | 远程下发的值（含启动时读入的磁盘缓存） |
| 3 | 本地 `settings.json` 的 `analytics.flags` |
| 4 | 代码里的默认值 |

所以 Flag **不是强制手段**：员工设一个环境变量就能覆盖。

出处：`packages/core/src/analytics/feature-flags.ts`、`query/init-helpers.ts`；`agent-backend: backend/app/modules/flag/router/flags.py`、`service/guard.py`。

### 环境变量覆盖怎么写

变量名是 `SID_CODE_FLAG_` 加上 key 的大写形式。值按下面的顺序解析：

| 写法 | 解析结果 |
| --- | --- |
| `true` / `false` | 布尔值 |
| 能转成数字的，如 `1`、`0.5` | 数字 |
| 合法 JSON，如 `{"tool_call":0.1}` | 对应的 JSON 值 |
| 其他 | 原样当字符串 |

::: tip 布尔值要写 true，不要写 1
`SID_CODE_FLAG_CONTENT_TRACING=1` 解析出来是**数字 `1`**，不是 `true`。客户端判断布尔 Flag 用的是 `=== true`，数字 1 不算，结果是**关**。要开就写 `=true`，要关就写 `=false`。
:::

```bash
# 本机关掉内容级 tracing：写 false，不要写 0
SID_CODE_FLAG_CONTENT_TRACING=false sid-code

# 本机把 tool_call 事件采样到 10%
SID_CODE_FLAG_EVENT_SAMPLING_CONFIG='{"tool_call":0.1}' sid-code
```

## 客户端读取的 Flag

下表是截至 v0.1.610 在 sid-code 源码里 grep 到的全部读取点。管理台可以新建任意 key，但不在这张表里的 key，客户端拿到了也不会用。

| key | 值的形状 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `event_sampling_config` | 对象，事件名 → 0 到 1 的采样率，例如 `{"tool_call":0.2,"context_assembled":0}` | `{}`（全部 100% 上报） | 按事件名采样。`0` 或负数表示不发；`1` 及以上表示全发；中间值按概率发，并在事件里附带 `sample_rate` 字段。没列出的事件名照常全发 |
| `sink_killswitch` | 对象，后端名 → 布尔，例如 `{"sid-backend":true}` | `{}` | 紧急关掉某个上报后端，不用发版。只认 `true`。内置的企业后端叫 `sid-backend`，本地 JSONL 叫 `local`，自配的第三方后端用 `analytics.backends[]` 里的 `name` |
| `content_tracing` | 布尔 | `true` | 内容级 tracing 的远端否决。只有员工本地设了 `SID_CODE_CONTENT_TRACING=1` 且隐私级别是 `default` 时才会读它；下发 `false` 可以统一关掉 |

出处：`packages/core/src/analytics/sampling.ts`、`killswitch.ts`、`telemetry/content-tracing.ts`。

::: warning 采样会让审计页的数字变小
给某个事件配了采样率，[审计](/backend/audit)页上它的条数就是采样后的条数。比如 `policy_enforced` 采样到 0.1，「策略与护栏是不是在拦东西」表里 `policy applied` 也只剩约一成。审计相关的事件不建议采样。
:::

## 在管理台里操作

页面在顶栏「**Flag**」。页面顶部的说明框写着「Flag 只能施加约束，不能放宽安全限制」，和上面的警告是同一件事。

### 新建一个 Flag

1. 点「**新建 Flag**」。
2. 填「**Key**」。必须是 snake_case，小写字母开头，只含小写字母、数字、下划线。
3. 填「**值（JSON）**」。按 JSON 字面量写：`true`、`false`、`40`、`"stable"`、`{"tool_use":0.5}`。**字符串要带双引号**，不带就不是合法 JSON，提交时报错。
4. 按需填「**说明**」。说明也要过禁用词检查。
5. 按需填「**变更原因**」。写进审计，之后查「为什么改成这样」靠它。
6. 确定。

### 改值、停用、启用、删除

列表每行的「操作」列：

| 按钮 | 作用 | 要填什么 |
| --- | --- | --- |
| 改值 | 改值和说明。Key 不能改，要换名字就新建一个再删旧的 | 变更原因（可不填） |
| 停用 | 不再下发，记录保留。客户端下次拉取后回落默认值 | 原因，**必填** |
| 启用 | 重新进入下发 | 原因，**必填** |
| 审计 | 看这一个 Flag 的变更记录 | —— |
| 删除 | 真删。审计记录保留 | 原因，**必填** |

「下发」列显示「下发中」或「不下发」；停用的 Flag 在 Key 旁边还有一个「已停用」标签。「最后修改」列显示时间和操作人。

右上角「**全部审计**」看所有 Flag 的变更记录。

想一次看清某台设备会拿到哪些 Flag，用「设备」页每行的「**生效配置**」抽屉。因为 Flag 是全局的，每台设备看到的这一块都一样。

### 写入规则

| 情况 | 结果 |
| --- | --- |
| Key 不符合 `^[a-z][a-z0-9_]*$`，或超过 128 个字符 | **422** |
| Key 或说明命中禁用词 | **422**，提示里写明命中了哪个词 |
| 同名 Key 已存在 | **409** |
| 改值、停用、启用、删除一个不存在的 Key | **404** |
| 停用、启用、删除时原因为空或只有空白 | **422** |
| 说明或原因超过 512 个字符 | **422** |
| 没有登录管理台 | **401** |

Key 必须是合法标识符，是因为环境变量覆盖用的是 `SID_CODE_FLAG_<KEY>`。Key 里出现 `-` 或 `.`，生成的变量名不是合法的 shell 标识符，这条覆盖路径会静默失效。

## 字段说明

| 字段 | 取值 | 校验规则 | 员工端效果 |
| --- | --- | --- | --- |
| Key | snake_case 字符串 | 1 到 128 字符；`^[a-z][a-z0-9_]*$`；不含禁用词；建好后不能改 | 客户端按这个名字取值；环境变量覆盖名是它的大写形式 |
| 值（JSON） | 布尔、数字、字符串、对象、数组 | 必须是合法 JSON；必填 | 原样下发。`true` 和 `"true"` 是两回事，前者是布尔，后者是字符串 |
| 说明 | 文本 | 最长 512；不含禁用词 | 不下发，只在管理台显示 |
| 变更原因 | 文本 | 最长 512；新建和改值时可不填，停用、启用、删除时必填 | 不下发，只进审计 |

审计记录的「动作」列取值是 `create`、`update`、`disable`、`enable`、`delete`，「变更」列显示旧值 → 新值。

## 能力边界（如实说）

**1. 没有灰度比例，也没有按对象下发。** 一个 Flag 只有一个值，所有客户端拿到的都一样。需要按组织、团队、设备区分，用策略。

**2. 不是强制手段。** 员工设环境变量就能覆盖；开 `essential-traffic` 就不拉取。要强制的东西请放进策略。

**3. 生效慢。** 最迟约 6 小时加 5 分钟。急的话让员工重启 sid-code。

**4. 下发内容谁都能读。** 端点不鉴权，不要把内部地址、口令、人名之类写进值里。

**5. 拉取失败静默。** 员工端没有任何提示，管理台也看不到哪台设备拉到了哪一版。想确认，只能在员工机器上看 `~/.sid-code/feature-flags-cache.json`。

**6. 客户端只读三个 Flag。** 新建一个别的 key 不会让客户端多出任何行为，要先在 sid-code 里加读取点并发版。

## 常见问题

### 改了值，员工那边没变化

先等一个周期，或者让员工重启。还不行，按顺序查：员工有没有设 `SID_CODE_FLAG_<KEY>`；隐私级别是不是 `essential-traffic`；`backend.url` 是否配对，`curl https://agent.example.com/traj/api/v1/ctl/flags` 能不能看到这个 key。

### 环境变量设成 1 了，开关还是关的

`1` 被解析成数字，不是 `true`。改成 `=true`。

### 停用之后员工还在用旧值

客户端只有在下一次拉取成功后才会发现它没了。拉取失败期间，旧值一直留在内存和磁盘缓存里。

### 保存时报 422「命中禁用词」

Key 或说明里有放宽安全类的词。如果这个开关确实是在放宽限制，它不该是 Flag，请改用策略。如果只是误伤，换个说法即可。

## 相关

- [配置项](/ref/settings) —— `analytics.flags` 本地定义、`analytics.featureFlagEndpoint` 兼容项
- [环境变量](/ref/env) —— 隐私级别相关的环境变量
- [策略](/backend/policy) —— 需要放宽、需要按对象区分、需要强制时用它
- [审计](/backend/audit) —— 事件采样会影响那边的数字
- [隐私与数据流向](/use/privacy) —— 哪个隐私级别会关掉 Flag 拉取
