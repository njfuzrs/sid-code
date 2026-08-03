---
title: 权限与人工确认
description: 八种权限模式怎么选、allow/deny/ask 规则怎么写，以及哪些操作任何模式都拦不住。
---

# 权限与人工确认

读完这页你能做到四件事：

- 按场景选对权限模式，不再被每一步打断，也不至于让它乱改代码
- 写出精确的 `allow` / `deny` / `ask` 规则（含 bash 通配、路径前缀、MCP、子代理）
- 知道 `--dangerously-skip-permissions` 的风险边界，以及它**依然拦不住什么**
- 看懂 `→ 需确认(危险命令: …)` 这类日志，判断是规则拦的还是安全层拦的

完整字段类型与默认值不在这页，去[settings.json 字段](/ref/settings)查；
工具名的确切拼写去[内置工具](/ref/tools)。这页只讲怎么选、怎么写。

## 快速上手

三种最常用的调法，按侵入性从小到大：

```bash
# 1. 只放行本次要用的命令（最推荐，一次性）
sid-code --allow-tool "Bash(npm *)" --allow-tool "Bash(git status)"

# 2. 换个档位：文件修改自动接受，跑命令仍然问
sid-code --permission-mode acceptEdits

# 3. 全部不问（只在信得过的仓库用）
sid-code --dangerously-skip-permissions
```

会话里临时加规则，不用重启：

```text
/allow Bash(npm *)                      仅本次会话生效
/allow Bash(npm *) -p                   写进 ~/.sid-code/settings.json，跨会话保留
/deny Bash(curl *) -p --scope project   写进项目级配置，团队共享
```

想固化成配置，写 `~/.sid-code/settings.json`：

```json
{
  "permissions": {
    "allow": ["Bash(ls *)", "Bash(npm *)", "Read(/src/**)"],
    "deny": ["Read(./.env)", "Bash(curl *)"],
    "ask": ["Bash(git push *)"]
  }
}
```

启动时会打印一行确认它被读到了（真实输出）：

```text
● [CONFIG] 权限规则: 2条 allow, 2条 deny, 1条 ask
```

**这行没出现就是配置没生效**，先检查文件路径和 JSON 语法，别急着怀疑规则写错。

## 八种权限模式

`--permission-mode <mode>`，或 settings 里的 `permissionMode` 字段。
第二列是状态栏显示的名字：

| mode | 状态栏显示 | 行为 | 什么时候用 |
| --- | --- | --- | --- |
| `default` | Manual（手动） | 除只读操作外逐个问 | 第一次进一个陌生仓库 |
| `acceptEdits` | 自动接受编辑 | 文件读写自动放行；bash 仍要问（工作目录内的 `mkdir`/`mv` 一类文件系统命令除外） | **日常最顺手的档位** |
| `plan` | 计划模式 | 代码级强制只读，先出方案再动手 | 复杂改动，想先看它打算怎么干 |
| `auto` | 自动模式 | 交给风险分类判断，低风险放行、高风险问 | 熟悉的仓库里想少点打扰 |
| `always-allow` | 全部允许 | 跳过规则与模式确认，安全层仍生效 | 一次性批量任务，你会盯着看 |
| `deny-write` | 禁止写入 | 只读；写操作直接拒绝，不给确认机会 | 只让它分析、绝不许改 |
| `dontAsk` | 静默拒绝 | 该问的一律当拒绝，不弹窗 | 无头脚本里不想挂住 |
| `dangerously-skip-permissions` | 跳过权限(危险) | 等价 `-y` / `--yes` 的最宽档 | 容器 / 一次性沙箱 |

<kbd>Shift+Tab</kbd> 在会话里循环切换，实测顺序：

```text
default → acceptEdits → auto → default → …           # 常规
default → acceptEdits → auto → always-allow → default # 启动时开了 -y/--yes
```

<!--
  ⚠ **plan 不在这个循环里**，别再把它写回去（原先写的是
  `default → acceptEdits → plan → auto → always-allow`）。
  src/permission/mode.ts 的纯函数 getNextPermissionMode 顺序里确实有 plan，
  但键盘入口 app.ts:4301-4305 在外面套了一层跳过循环，只跳 plan（和被企业策略禁用的模式）；
  且 app.ts:4285-4288 在 plan 态直接拒绝按键、提示走 exit_plan_mode。
  原因：plan 是独立状态机，键盘只改这个字符串会造出一个假的 plan 态。
  照错顺序按键的人会以为自己按漏了一档。
  另注：tests/permission/mode.test.ts 复刻的跳过逻辑同时跳 plan 和 auto，
  与 app.ts 现状不一致（auto 已接线），是个已知的测试漂移。
-->

**plan 不在这个循环里**——它是独立状态机，进出要用 `/plan` 或让它自己
`exit_plan_mode`；已经在 plan 态时按 <kbd>Shift+Tab</kbd> 会提示你走那条路。
`deny-write` / `dontAsk` 也不在循环里，只能用参数或配置指定。

`always-allow` 只在**启动时就开了** `-y` / `--yes` 时才进循环（这是启动瞬间的快照，
不随会话中途切换漂移）。企业策略禁用 bypass 时（`disableBypassPermissionsMode`）
它也会被跳过，`auto` 直接回到 `default`。

::: tip plan 模式的读写边界
plan 模式下 `read` / `grep` 放行，`edit` / `write` / `bash` 一律拒绝，
提示是「计划模式下只允许只读操作」。唯一例外是它往 `~/.sid-code/plans/` 写计划文件——
这条在代码里比只读检查更早放行，否则它连计划都存不下来。
:::

## 规则语法

格式是 `工具名` 或 `工具名(模式)`。裸工具名匹配该工具的全部调用，带括号则再匹配参数。
下表每一行都逐条实测过：

| 规则 | 匹配什么 | 说明 |
| --- | --- | --- |
| `Bash(*)` | 所有 bash 命令 | `*` 跨 `/`，含带路径的命令 |
| `Bash(npm *)` | `npm run build` ✅，`npx foo` ❌ | 尾部 ` *` 是「这个命令加任意参数」 |
| `Bash(git status)` | 只有这一条命令 | 无通配符即精确匹配 |
| `Bash(prefix:git )` | `git` 开头的命令 | 兼容语法，等价于 `Bash(git *)` 的前缀语义 |
| `Read(/src/**)` | `<项目根>/src` 下任意深度 | **单前导 `/` = 项目根相对**，不是文件系统根 |
| `Read(./.env)` | 当前目录的 `.env` | `./` 或裸路径 = cwd 相对 |
| `Edit(~/notes/**)` | 主目录下 | `~/` = 主目录 |
| `Read(//etc/**)` | 文件系统 `/etc` 下 | **双斜杠才是文件系统绝对路径** |
| `Agent(explore)` | `explore` 类型的子代理 | 裸 `Agent` 匹配全部子代理 |
| `WebFetch(domain:github.com)` | 抓取 github.com | 也支持 `domain:*.example.com` |
| `mcp__myserver` | 该 server 的所有工具 | 服务器级匹配 |
| `mcp__*` | 所有 MCP 工具 | 工具名位置也支持通配 |

::: warning 最容易写错的一条
路径规则里 `/src/**` 指的是**项目根下的 src**，不是磁盘根目录的 `/src`。
要写文件系统绝对路径得用两个斜杠：`//etc/**`。
这四种前缀（`//`、`~/`、`/`、`./`）会先归一成绝对路径再比对，写混了规则会静默不匹配——
不报错，只是不生效。
:::

### 三类规则的优先级

`deny` > `ask` > `allow`，且**同类里带参数的规则优先于裸工具名**。实测：

```text
allow: ["Bash(git *)"] + deny: ["Bash(git push *)"]
  git push --force  →  规则拒绝: bash (匹配 Bash(git push *))

allow: ["Bash(*)"] + ask: ["Bash(rm *)"]
  rm x  →  规则要求确认: bash (匹配 Bash(rm *))
```

所以「放行一大类、单独挖掉危险子集」是可行写法：`allow: ["Bash(git *)"]`
配 `deny: ["Bash(git push *)", "Bash(git reset --hard *)"]`。

### deny 规则会提前告诉模型

`deny` 不只是拦调用，还会作为一段约束注入系统提示词，让模型**一开始就不去试**：

```text
● [PROMPT] 附件: 权限约束（deny 规则）(0.0K tok, priority=38)
```

实测配了 `deny: ["Read(./.env)"]` 后让它读 `.env`，它的回答直接引用了规则：

```text
- `Read(./.env)` 被禁止（匹配即拒绝）
这是安全策略的一部分…我无法绕过该限制，也不会尝试变通手段
（如通过 bash、cat、子代理等方式间接读取）。
```

这比「调用了再被拦」省一轮 token，也省掉一次无效工具调用。

## 配置层级

五层，后面的覆盖前面的：

| 优先级 | 来源 | 文件 | 典型用途 |
| --- | --- | --- | --- |
| 1（最低） | 用户级 | `~/.sid-code/settings.json` | 你自己的习惯 |
| 2 | 项目级 | `<项目>/.sid-code/settings.json` | 团队共享，提交 git |
| 3 | 本地级 | `<项目>/.sid-code/settings.local.json` | 你在这个项目里的私货，gitignore |
| 4 | CLI 参数 | `--settings` / `--allow-tool` / `--deny-tool` | 一次性 |
| 5（最高） | 企业策略 | `/etc/sid-code/policy.json` | 公司管控，用户改不掉 |

`allow` / `deny` / `ask` 三个数组在各层之间是**合并**而不是覆盖——
项目级加的 deny 不会把用户级的 deny 冲掉。

## 运行时查看与管理

配置写多了会忘记当前到底生效了哪些规则。两个命令补这块缺口：

### `/permissions`：看当前生效的全部规则

无参数运行打开交互式权限管理面板，能看到所有来源的规则并增删；带参数则输出文本视图：

```text
/permissions
```

输出按**来源分组**展示（用户级 / 项目级 / 本地级 / 会话级），每条标 `✓` allow / `✗` deny / `?` ask：

```text
权限模式: acceptEdits

[user] (3 条)
  ✓ allow: Bash(npm *)
  ✓ allow: Bash(git status)
  ✗ deny: Read(./.env)

[project] (2 条)
  ✗ deny: Bash(curl *)
  ? ask: Bash(git push *)
```

比手翻 `settings.json` 多两个能力：

- **阴影检测**：如果某条规则被更高优先级的同类规则完全覆盖（永远匹配不到），会标出来提醒你——配得越多越容易出现，删掉就行
- **拒绝追踪**：显示本次会话连续拒绝次数和累计拒绝次数，判断是不是卡在权限上反复撞墙

### `/add-dir`：运行时加目录到白名单

默认情况下 sid-code 只能访问启动时的工作目录（及 `allowedDirectories` 配置的目录）。临时需要让它读项目外的目录（比如另一份参考代码），不想改配置重启：

```text
/add-dir /Users/me/reference-project
```

实测输出：

```text
✓ 已将目录加入当前会话可访问白名单: /Users/me/reference-project
（用户级运行时授权，仅本会话生效，不写入配置文件）
```

三个要点：

- **仅当前会话生效**，不落盘、不扩大项目配置白名单——关掉会话即失效
- 与 `allowedDirectories` 配置项的区别：后者写进 `settings.json` 跨会话永久生效；`/add-dir` 是一次性的
- 管理当前白名单：

```text
/add-dir --list          查看当前会话加了哪些目录
/add-dir --remove <目录>  从本会话白名单移除
```

::: tip 这是用户主动授权，不是安全漏洞
`/add-dir` 是**你在终端里亲手输入的**，属于显式人工授权——与「项目配置自动扩大目录白名单」那种静默扩大攻击面的行为性质不同。后者是被安全层禁止的。
:::

## macOS Seatbelt 沙箱：操作系统级隔离

上面讲的规则层、危险命令层、敏感文件层都是**应用内的软约束**——它们拦的是「模型想让 sid-code 做什么」。
但 bash 工具真正执行命令时，命令本身能碰什么文件、能不能联网，应用层是管不到的。
macOS 上 sid-code 还有一道**操作系统级**的硬隔离：[Seatbelt 沙箱](https://developer.apple.com/library/archive/technotes/tn2067/)（`src/permission/sandbox.ts`）。

### 它和前面几层是什么关系

| 层 | 拦什么 | 谁执行 |
| --- | --- | --- |
| 权限规则（allow/deny/ask） | 模型想调哪个工具 | sid-code 应用层 |
| 危险命令拦截 | 命令文本本身危险（`rm -rf /`） | sid-code 应用层 |
| 敏感文件保护 | 命令碰 `.env`/`*.pem` 等 | sid-code 应用层 |
| **Seatbelt 沙箱** | **命令执行时能碰哪些文件/网络** | **macOS 内核** |

前三层是「调不调用」的决策，沙箱是「调用之后、命令真正执行时」的操作系统兜底。即使前三层全放行了，
沙箱仍能在内核级挡住命令越界读写。**它只在 macOS 上生效**（`process.platform === "darwin"`，
`sandbox.ts:57`），其他平台降级为无沙箱。

### 沙箱 profile 长什么样

沙箱用 macOS 自带的 `sandbox-exec` 生成一份 Seatbelt profile（`sandbox.ts:81-140`），
把每条 bash 命令包进 `sandbox-exec -p '<profile>' /bin/sh -c '<command>'`。profile 默认
`(deny default)`（默认全拒）后逐项放行，允许/禁止的路径：

| 类别 | profile 规则 | 说明 |
| --- | --- | --- |
| 工作目录 | 允许读写 `cwd` 子树 | 这是你让它改的代码所在 |
| 系统工具链 | 只读 `/usr/lib` `/usr/bin` `/usr/local` `/Library/Developer` `/Applications/Xcode.app` | 跑编译/解释器需要 |
| 临时目录 | 读写 `/tmp` `/private/tmp` | 命令临时文件 |
| 家目录工具 | 只读 `~/.bun` `~/.nvm` `~/.npm` `~/.cargo` | 运行包管理器需要 |
| **敏感目录** | **显式 deny** `~/.ssh` `~/.gnupg` `~/.sid-code` | SSH 密钥、GPG、sid-code 自身配置与轨迹 |
| 网络 | 默认只放行 `localhost`（`allowedHosts`） | 防 bash 命令外发数据 |

`~/.ssh`、`~/.gnupg`、`~/.sid-code` 是**显式 deny** 的——即使权限规则放行了 bash，命令也
碰不到这三处。这层防御不依赖应用层判断，是内核强制的。

### 怎么开

settings.json 的 `enableSandbox` 字段（`src/config/config.ts:451`，CLI 消费在 `src/cli.ts:1808`）：

```json
{
  "enableSandbox": true,
  "sandbox": {
    "autoAllowBashIfSandboxed": true,
    "allowedWritePaths": [],
    "allowedReadPaths": [],
    "allowedHosts": ["localhost"]
  }
}
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enableSandbox` | `false` | 总开关，开=bash 命令进沙箱 |
| `autoAllowBashIfSandboxed` | `true` | 沙箱启用时自动放行 bash（减少弹窗——反正内核已兜底） |
| `allowedWritePaths` | `[]` | 额外允许写入的目录 |
| `allowedReadPaths` | `[]` | 额外允许读取的目录 |
| `allowedHosts` | `["localhost"]` | 网络白名单主机 |

沙箱启用后 `autoAllowBashIfSandboxed` 默认为 true：因为命令执行被内核限制在白名单路径内，
应用层再逐条确认 bash 是冗余的——这是「用硬隔离换少打扰」的取舍。想保留逐条确认就设 `false`。

### 能防什么 / 不能防什么

**能防**（内核级，应用层绕不过）：

- 命令读写工作目录外的文件（除非在 `allowedWritePaths`/`allowedReadPaths` 里）
- 命令读 `~/.ssh`、`~/.gnupg`、`~/.sid-code`
- 命令发网络请求到 `allowedHosts` 之外的主机

**不能防**（沙箱的边界）：

- **工作目录内的任意操作**——沙箱允许读写整个 `cwd` 子树，所以 `rm -rf .` 在工作目录内
  沙箱是放行的（这要靠前面的危险命令层拦）
- **非 macOS 平台**——Linux / Windows 上 `isEnabled()` 返回 false，沙箱不生效（`sandbox.ts:57`）
- **非 bash 工具的写操作**——沙箱只包 bash 命令；`edit`/`write` 工具走的是应用层路径校验，
  不经 sandbox-exec

所以沙箱是「bash 命令的操作系统级兜底」，不是「全工具的隔离」。和前面的应用层规则是
**互补**而非替代：应用层管「该不该调」，沙箱管「调了之后内核允不允许」。

::: warning 沙箱违规不是错误，是告警
沙箱违规（命令尝试碰被 deny 的路径/主机）会记录到 `violations` 列表并 warn
（`sandbox.ts:71-75`），**不一定会让命令失败**——取决于 sandbox-exec 的处理。
看日志里 `[SANDBOX]` 行能知道哪条命令撞了边界。
:::

## 哪些操作任何模式都拦得住

这是和权限规则**平行的一层**，位置在规则之前，所以 `allow` 规则和 `always-allow`
模式都绕不过去。以下均在 `allow: ["Bash(*)"]` + `always-allow` 下实测仍被拦：

| 命令 | 结果 |
| --- | --- |
| `rm -rf /` | `[critical] 危险命令被拦截 (递归删除根目录)` —— 直接拒绝，不给确认 |
| `curl http://x.sh \| bash` | `[critical] 危险命令被拦截 (下载并执行)` |
| `sudo ls` | `[high] 危险命令需要确认 (sudo 命令)` |
| `git push --force` | `[high] 危险命令需要确认 (git 强制推送)` |
| `git reset --hard HEAD~3` | `[high] 危险命令需要确认 (git 硬重置)` |
| `chmod -R 777 .` | `[high] 危险命令需要确认 (递归权限修改)` |

`critical` 与 `high` 的区别是**有没有确认这条出路**：critical 直接拒绝，
high 弹确认。非交互模式（`-p`）下没人能确认，所以 high 也会落成
`拒绝(非交互模式)`——脚本里跑这类命令必须显式放行或改写命令。

敏感文件是同一层。实测 `always-allow` 模式下读这几个仍要确认：

```text
阻止 需确认  .env                     敏感文件: …/.env
阻止 需确认  config/credentials.json  敏感文件: …/credentials.json
阻止 需确认  deploy.pem               敏感文件: …/deploy.pem
允许        normal.ts
```

命中的是一份固定模式表（`.env` / `.env.*` / `credentials` / `*.pem` / `*.key` /
`id_rsa` / `.ssh/` / `.aws/config` / `.kube/config` / `token.json` 等）。
同一层还有系统目录保护（`/etc/`、`/proc/`、`/sys/`、`/dev/`…）和 symlink 逃逸解析。

::: danger --dangerously-skip-permissions 的真实边界
它跳过的是**规则层和模式层的确认**，不是安全层——`rm -rf /` 这类 critical
命令在它下面依然被拦。但它确实把「改任意文件、跑任意命令」的门全开了。
`sc` 这个别名就等价于带上它，所以**别在重要仓库里用 `sc`**。
判断标准：这个目录里的东西全丢了你能不能接受。不能，就别用。
:::

## 常见问题

### 它一直问，怎么少问一点

按这个顺序试，从最安全的开始：

1. <kbd>Shift+Tab</kbd> 切到 `acceptEdits`——文件改动不问了，命令还问。多数人到这一步就够
2. 把你反复批准的那几条命令写进 `allow`：`/allow Bash(npm *) -p`
3. 还嫌烦再考虑 `auto` 模式，让风险分类替你判断
4. `--dangerously-skip-permissions` 是最后手段，且只在一次性 / 沙箱环境

### 规则写了但没生效

三个检查点，按顺序：

```bash
# 1. 启动时那行有没有出现，条数对不对
sid-code 2>&1 | grep "权限规则"
# → ● [CONFIG] 权限规则: 2条 allow, 2条 deny, 1条 ask

# 2. 路径规则的前缀写对了吗（/src/** 是项目根相对，//src/** 才是文件系统根）

# 3. 有没有被更高优先级的层覆盖（企业策略 > CLI > 本地 > 项目 > 用户）
```

最常见的是第 2 条。`Read(/Users/me/proj/src/**)` 这种写法会被当成
「项目根下的 `Users/me/proj/src`」，永远匹配不上——要么改用 `//` 开头，要么写 `/src/**`。

### 非交互模式（`-p`）下工具全被拒了

`-p` 没有人能点确认，所以任何落到「需确认」的请求都会变成
`拒绝(非交互模式)`。脚本里要么用 `--allow-tool` 精确放行，
要么 `--permission-mode acceptEdits`，要么 `--dangerously-skip-permissions`（沙箱里）。

### 想知道某次到底是谁拦的

看日志里 `[PERMISSION]` 那行，括号里写了判定来源：

```text
bash(ls -la)  → 允许(工具级checkPermissions)
bash(sudo ls) → 需确认(危险命令: sudo 命令)
bash(sudo ls) → 拒绝(非交互模式)
write(...)    → 允许(acceptEdits模式)
```

`危险命令` 是安全层，`规则拒绝` 是你写的规则，`模式` 是权限档位。
三者对应三种不同的改法，别搞混。

### allow 规则会穿透 plan 模式

一个需要知道的实现细节：`allow` 规则的判定**早于** plan 模式的只读检查。
配了 `allow: ["Bash(*)"]` 之后进 plan 模式，bash 仍然能跑。
要让 plan 模式的只读保证真的成立，就不要给写类工具配宽泛的 allow 规则。

## 相关

- [settings.json 字段](/ref/settings) —— `permissions` 段的完整字段类型与默认值
- [内置工具](/ref/tools) —— 规则里工具名的确切拼写
- [交互模式与键位](/use/interactive) —— <kbd>Shift+Tab</kbd> 及其他快捷键
- [Plan Mode 与 Todo](/use/plan-mode) —— plan 模式的完整用法
- [企业 policy 与安全边界](/team/policy) —— 用 `/etc/sid-code/policy.json` 做团队管控
