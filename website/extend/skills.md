---
title: Skill
description: 把团队的流程与规范封装成可复用的 skill：3 个内置 skill 干什么、自定义怎么写、为什么写了不生效。
---

# Skill

Skill 是**按需加载的流程说明书**。没调用时通常只在摘要列表里占一行，调用时才加载它的正文；
目录里的脚本、参考文件按正文指示再去读，不会整目录一起展开。

这是它和 CLAUDE.md 的核心区别：CLAUDE.md 每轮都在上下文里，写多少付多少；
Skill 平时只有摘要（当前 3 个内置 Skill 合计约 0.1K token；数字随启用的 Skill 集合变化），用到才付全文的钱。
Skill 多了摘要会按预算截短描述、极端时只留名字；条件激活未触发的、被禁用的、禁止模型调用的 Skill 不进摘要。
想教一整套「修 bug 的标准流程」，写 Skill 而不是塞 CLAUDE.md。

## 快速上手

一个最小可用的自定义 Skill 只要一个文件。在项目里建：

```bash
mkdir -p .sid-code/skills/changelog-entry
cat > .sid-code/skills/changelog-entry/SKILL.md <<'EOF'
---
name: changelog-entry
description: 按本仓库约定把一条改动写成 CHANGELOG 条目：读最近一条提交，产出一行「- 类型: 描述」。
when-to-use: 当用户说「写 changelog」「补一条变更记录」时触发
mode: activate
---

# changelog-entry

1. 跑 `git log -1 --pretty=%s` 拿到最近一条提交标题。
2. 按 `- <类型>: <一句话描述>` 输出一行，类型取 feat/fix/docs/chore 之一。
3. 只输出那一行，不要解释。
EOF
```

然后让它干活：

```bash
sid-code -p "用 changelog-entry skill 生成一条变更记录"
```

一个 Skill 能不能跑起来要过三道互相独立的关：

1. **加载**：项目级 Skill 要先过项目扩展信任（见下方提示框），没过模型根本看不到它；
2. **调用**：调用 `Skill` 工具本身默认放行，`-p` 下不用加 `--allowed-tools Skill`；
   但 skill 声明了敏感属性时还要再过一次 Skill 授权（见下一个提示框）；
3. **执行**：正文让模型调的每个工具（这里的 `git log`）仍各自过权限，Skill 被信任不等于它要跑的命令被预授权。

想禁止模型调用 Skill，见[常见问题](#禁用某个-skill)里三种手段的作用范围——它们不等价。

示例输出（演示用仓库的最近一条提交是 `fix: 修正 add 函数的边界条件`，已开 `trustProjectExtensions`）：

```text
- fix: 修正 add 函数的边界条件
```

::: danger 项目级 Skill 在 `-p` 下默认加载不到
默认设置下，上面那条命令**首次跑会失败**，模型会说「`changelog-entry` 这个 Skill 目前不存在」。
原因不是 Skill 写错了，是**信任门槛**：项目级扩展来自仓库（等于别人的代码），
默认要确认才加载，而 `-p` 无头模式下无法确认 → 直接跳过。

推荐先在交互模式里跑一次：TUI 会弹「项目扩展信任」对话框，信任会按文件内容记住，之后 `-p` 也能加载。
内容变了会再问。详见[下方](#项目级-skill-写了但模型说不存在)。

CI 这类没有交互环境的场景，才在**用户级** `~/.sid-code/settings.json` 里打开全局开关：

```json
{ "trustProjectExtensions": true }
```

它对**所有项目**生效，等于以后打开任何仓库都不再逐文件确认它带的 skill / 命令 / agent，不是只放行当前这个仓库。
项目自己的 `.sid-code/settings.json` 设不了这个字段（安全敏感字段，项目级写了会被忽略）。
:::

::: warning 示例里刻意没写 `allowed-tools`
`allowed-tools`、`shell`、`agent`、`hooks`、`max-turns`、`timeout-mins`、`effort` 属于**敏感属性**：
skill 声明了其中任何一个（非空），默认要先过一次 Skill 授权（`packages/core/src/skill/permission.ts`）。
`permissions` 里写了匹配这个 skill 的规则时以规则为准：`deny` / `ask` / `allow` 分别直接拒绝 / 要求确认 / 免确认。

需要确认时，结果取决于是谁调的：

- 你手动敲 `/<名字>`：交互模式会弹确认框；
- 模型自己调（经 `Skill` 工具）：没有弹窗通道，按拒绝处理；`-p` 下同样拒绝。

`--allowed-tools Skill` 放行不了这一层，要免确认得配 `permissions.allow: ["Skill(<名字>)"]`。
它只放行 Skill 定义本身，skill 跑起来后调的 Bash / Write 等工具仍各自过权限。
示例输出：把上面的示例加回 `allowed-tools: bash, read` 再跑同一条命令，模型回复「changelog-entry skill
没跑起来，这次调用的权限没批」。activate 模式的 skill 跑在当前对话里，用的是主会话的工具，
本来就不需要声明它。
:::

## 3 个内置 Skill

`sid-code` 自带 3 个，开箱可用，无需配置：

| 名称 | 干什么 | 模式 |
| --- | --- | --- |
| `code-review` | 针对 PR diff 出结构化 review：bug / 安全漏洞 / 设计反模式；能定位的问题给出 `file:line` 和修改建议 | delegate |
| `skill-creator` | 帮你写 Skill（写 Skill 的 Skill） | activate |
| `claude-code-migration` | 把 Claude Code 的配置迁到 sid-code：只 copy 不 move，不删源文件，不静默覆盖 | activate |

另有 `/simplify`、`/verify`、`/review`、`/commit`、`/pr`、`/pr-workflow` 这几个编译进二进制的命令式 skill。
其中 fork 类且允许模型调用的（`simplify`、`verify`、`review`）还会以 `skill__<名字>` 工具的形式暴露给模型；
`pr-workflow` 带强副作用，只能手动触发。

在会话里用 `/skills` 打开面板，看内置、编译进二进制和磁盘上的 skill 及各自来源，再按名字手动触发（如 `/code-review`）。
插件和 MCP 提供的 skill 目前不在面板里，用斜杠命令补全或 `-d` 日志确认。
同名 skill 会被更高优先级的来源覆盖（见[加载位置与优先级](#加载位置与优先级)），所以 `/code-review`
调到的未必是内置那份，以 `/skills` 显示的来源为准。

::: tip `/code-review` 与 `/review` 不是同一个入口
两者用同一份审查标准，但取 diff 的方式不同：

- `/code-review`（文件型内置 skill）：需要你给出输入——diff 文件路径、commit range，或直接粘贴 diff；
- `/review`（编译进二进制的命令式 skill）：没给参数时自己取当前变更，依次试暂存区、工作区、当前分支相对主干。

两者都在**独立子代理**里跑，主对话不共享子代理的过程，只收到最终报告。
它专门为「给 AI 生成的代码兜底」设计：AI 写得快，但得有人复核。
:::

## 官方插件市场里的 Skill

专项审计、运维、GitHub 评论处理这几类按需安装，不再随二进制分发。官方市场 `sid-code` 默认已注册
（设置 `officialMarketplace: false` 时不注册）。下表的调用名**安装并启用插件之后**才可用，
插件 skill 一律带 `插件名:` 前缀：

| 插件 | 调用名（安装后） | 干什么 | 原内置名 |
| --- | --- | --- | --- |
| `compliance` | `/compliance:security-audit` | 8 类漏洞检测（注入 / 凭据泄露 / XSS / 认证绕过 / 弱加密 / CVE 依赖 / IaC 配置 / 数据泄露），带 CWE/OWASP 引用 | `security-audit` |
| `compliance` | `/compliance:governance` | 合规治理：license / PII / 合规元数据 / 审计 trail | `code-governance` |
| `ops` | `/ops:ci-heal` | 读 CI 失败日志出诊断：失败分类 + 根因假设 + 可执行 fix | `ci-self-heal` |
| `ops` | `/ops:incident-rca` | 线上故障根因分析：跨 log / metric / trace / commit / ADR 五个维度构造假设，给 hotfix / 缓解 / 长期三档建议 | `incident-rca` |
| `github-pr` | `/github-pr:comments` | 处理 PR 上的 review 评论：逐条分析，需要时修改代码；默认只生成回复草稿，不自动发布评论、不自动推送。会改代码，只能手动触发，模型不会自动调用 | `pr-comments` |

```text
/plugin install compliance@sid-code
```

敲旧命令名（如 `/security-audit`）会提示去哪装、装完叫什么。`bug-fix` 与 `commit-push-pr` 已移除：
前者的流程本来就是默认工作方式，后者等于 `/commit` + `git push` + `/pr`，或直接用 `/pr-workflow`。

::: warning 锁定了插件来源的企业
以下两种情况会锁定插件来源，满足任意一种即可：

- `strictPluginOnlyCustomization` 锁了至少一个面（`true`，或非空数组）；
- 下发了 `strictKnownMarketplaces`（**含空数组**）。

`strictPluginOnlyCustomization` 不配或配成空数组 `[]` 都不锁；`strictKnownMarketplaces: []` 却是锁死，
除内置插件外一律拒绝。两个「空」语义相反，别混用。

锁定后：

- **内置插件始终放行**，不需要镜像；
- 没下发白名单时，只认 `backend.url` 对应的企业市场，官方市场的插件装不了，需要管理员镜像上架到企业市场；
- 下发了白名单时只认名单里的市场：要用官方市场就**同时**写上企业市场和官方市场的 index 地址——只写官方的话，企业市场反而会被拒；
- 本地目录与 `--plugin-dir` 来源一律拒绝。
:::

## activate 与 delegate 的区别

这是写 Skill 时第一个要决定的事，选错影响很大：

| | `mode: activate`（不写时的行为） | `mode: delegate` |
| --- | --- | --- |
| 在哪跑 | 注入**当前对话**，模型接着往下做 | 派**子代理**去跑，只把结果带回来 |
| 上下文 | 共享主对话，能看到之前聊的一切 | 独立上下文，看不到主对话历史 |
| 适合 | 流程要和当前任务咬合（改代码的 SOP、写 changelog） | 独立可交付的活（出一份 review 报告、审计报告） |
| 代价 | 占主对话上下文 | 子代理自己多轮调模型和工具，成本随任务轮次变化；过程不进主对话，只有最终结果回到主对话 |

拿不准就不写（等同 `activate`）——它行为更直观。真正需要"独立产出一份报告"时才用 delegate。

也可以写 `context: inline` / `context: fork`（分别对应 activate / delegate）。从别的工具迁来的 skill
多半用这个写法；两者同时写时以 `context` 为准。

::: warning 不写时按 inline 执行（与 Claude Code 一致）
`mode` 本身没有默认值；`mode` 与 `context` 都不写时，执行上下文按 inline 处理，skill 在**当前对话**里跑（旧版本按 delegate）。
需要隔离执行的 skill 请显式写 `context: fork`。
:::

### `allowed-tools` 是免确认规则，不是工具白名单

与 Claude Code 同一语义：`allowed-tools` 列出的是**这次执行期间不用弹窗确认**的 allow 规则，
认 Claude Code 写法（`Read`、`Bash(git diff*)`、`mcp__server__tool`），括号内的逗号不会被切开。

- 它**不裁剪工具集**，也**不决定是否 fork**；
- inline 时不是永久授权：模型调起的 skill，规则作用于主对话**这一轮剩下的工具调用**，你下一次输入前清空；
  你手动 `/名字` 触发的，只作用于这次命令触发的那一轮；
- fork 时只加在那个子代理上；
- deny 规则、危险命令拦截照常生效，压得住它；
- 项目级与插件来源的 skill / 命令（随仓库分发，不可信）里，`Bash(*)`、`Bash(rm …)`、裸 `Bash` / `Write` / `Edit` 这类自我授权会被剥离并告警。

要**收窄** fork 子代理能用的工具，用 `agent:` 指向一个工具受限的子代理类型（如只读的 `verify`）。
fork 子代理默认拿 `general-purpose` 的完整工具集，`allowed-tools` 里没列的工具照样能用，只是要正常过权限。

权限模式的继承分三种：

- 主会话 `--yes`：子代理同样自动批准普通确认，但危险命令和安全类确认仍然拦；
- 主会话 `--dangerously-skip-permissions`：子代理**不会**原样裸奔——`skipPermissions` 位不传递，
  主会话的 skip 档在子代理侧归一为 `always-allow`：普通确认自动批准，但危险命令与安全类确认仍然拦；
- 其余模式：子代理按「不弹窗、需确认即拒」处理。

### 自定义命令（`.sid-code/commands/*.md`）同一套语义

自定义命令的 frontmatter 认 `allowed-tools`、`context`、`agent`、`model`，口径与 skill 一致：

- 只有 `context: fork` 才 fork；只写 `allowed-tools` **不再**触发 fork（旧版本会）；
- 只写 `model` 不写 `context` 时暂按 fork 执行并告警（inline 单轮换模型尚未支持），写上 `context: fork` 即可消除告警；
- 从 Claude Code 迁来的命令（`allowed-tools: Read, Glob, Bash(ls*)`）原样可用，不需要改成内部工具名。

## SKILL.md 的字段

两种文件布局都支持，与执行模式无关：

- **目录型**：`skills/<名字>/SKILL.md`，旁边可以放脚本、模板等资源文件（推荐）；
- **扁平型**：`skills/<名字>.md`，单文件，适合没有资源文件的小 skill。

都是 YAML frontmatter + Markdown 正文。frontmatter 字段推荐用 **kebab-case**（`when-to-use`）；
camelCase（`whenToUse`）与 Claude Code 的写法（`when_to_use`、`tools`）也认：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 否 | Skill 标识名，通常也是斜杠命令名（`/changelog-entry`）；插件 skill 会带 `插件名:` 前缀，`user-invocable: false` 时不注册命令。不写时取目录名（扁平型取文件名）；`: \ / < > * ? " \|` 会被替成 `-`，最终须是字母数字开头、只含字母数字 `-` `_`，否则跳过 |
| `description` | 是 | **模型据此判断要不要调用**。缺失或为空的 skill 会被跳过。写具体，别写"处理各种任务" |
| `when-to-use` | 否 | 调用场景的补充说明，给模型更明确的信号 |
| `mode` | 否 | `activate` / `delegate`；不写时按 inline 执行 |
| `context` | 否 | `inline` / `fork`，分别等价于 `activate` / `delegate`；和 `mode` 同时写时以 `context` 为准 |
| `allowed-tools` | 否 | 免确认 allow 规则（逗号/空格分隔，认 `Read`、`Bash(git *)` 等写法），**不裁剪工具集**，见上文。属敏感属性，会触发一次 Skill 授权 |
| `agent` | 否 | fork 子代理类型（决定工具集，缺省 `general-purpose`）。属敏感属性 |
| `max-turns` | 否 | fork 执行（`context: fork` / `mode: delegate`）的最大轮次。**不写就不设上限**（对齐 Claude Code）；写了才生效，到达后强制总结收尾。属敏感属性 |
| `timeout-mins` | 否 | **已不再生效**：fork 子代理不设时间上限，写了只会在加载时打一条 warn。属敏感属性（写了仍会触发授权）。要中途停下：交互模式前台按 Esc；`-p` / SDK 由调用方中止。`task_stop` 只对有后台任务 id 的任务有效，停不了前台 skill |
| `model` | 否 | 只对 fork 执行生效：子代理用这个模型跑（比如让审计走更强的模型）；inline 执行不切换主对话的模型 |
| `effort` | 否 | 推理努力程度：`low` / `medium` / `high` / `xhigh` / `max`，其他值忽略。属敏感属性 |
| `hooks` | 否 | skill 生命周期 hooks（格式同 settings 的 hooks）。属敏感属性；MCP 来源的 skill 不支持 |
| `shell` | 否 | 正文里 `` !`命令` `` 内联命令用的 shell。属敏感属性 |
| `disable-model-invocation` | 否 | `true` = 模型不能自动调（不进摘要，按名调也被拒），只能手动 `/名字` 触发 |
| `user-invocable` | 否 | `false` = 不注册斜杠命令，只给模型自动调。和 `disable-model-invocation: true` 同时写，两个入口都没了，这个 skill 等于空转 |
| `paths` | 否 | glob 列表，条件激活：只有工具调用的路径参数（读、写、编辑、glob、grep、ls 等）落在启动目录内且匹配时才激活；Bash 命令里的路径不算。激活前不进摘要，模型按名调用也会被拒 |
| `arguments` | 否 | 命名参数列表，正文里按名字引用 |
| `version` / `argument-hint` | 否 | 版本号 / 斜杠命令补全时显示的参数提示 |

frontmatter 里写 `disabled: true` 的文件直接不加载。

正文里可以用 `${SKILL_DIR}`（或 Claude Code 写法 `${CLAUDE_SKILL_DIR}`）引用 Skill 自己的目录，放脚本、模板文件都靠它定位。
只有本地文件型 skill 能用：MCP 提供的 skill 没有本地目录，这个变量会被替换成「不支持」的提示文本。

## description 决定模型会不会选它

模型看到的只有摘要列表，它靠摘要判断"这次任务该不该调用这个 Skill"。
摘要里优先显示 `when-to-use`，没写才用 `description`，所以两者都要写具体。
写得具体能大幅提高被选中的概率，但**不保证一定调用**：是否调用仍由模型按上下文决定，
而且被禁用、禁止模型调用、条件未激活的 skill 根本不在摘要里。

对比一下官方插件 `ops` 里 `ci-heal`（原内置 `ci-self-heal`）的写法：

```yaml
description: "针对 CI 失败日志输出结构化诊断与修复建议. 识别失败分类(test/lint/build/type/dependency/config/flaky/timeout) / 根因假设 / 可执行 fix, 引用具体 file:line."
when-to-use: "当 CI 失败日志可用且用户说 'CI 挂了' / 'build failed' / 'tests failing' / '帮我看下 CI' 时触发"
```

它把**触发词**直接列进去了（"CI 挂了"、"build failed"）。写成
`description: 处理 CI 相关问题` 的话，模型大概率不会触发它——太含糊，没有判断依据。

这个 Skill 还有一个做法值得抄：**显式写清和其他 Skill 的边界**。
`ci-self-heal` 的 `when-to-use` 里有一句「与 code-review 的关系是: review 看 PR diff,
ci-self-heal 看 CI log, 输入与目标场景明确不重叠」——多个 Skill 场景相近时，
这种说明能避免模型选错。

## 加载位置与优先级

| 位置 | 作用域 | 信任要求 |
| --- | --- | --- |
| 内置（随二进制分发） | 全局 | 无 |
| `~/.sid-code/skills/` | 用户级 | 无 |
| `~/.claude/skills/` | 用户级（Claude Code 兼容读取） | 无 |
| `<项目>/.sid-code/skills/` | 项目级 | **要**：逐文件确认 |
| `<项目>/.claude/skills/` | 项目级（兼容读取） | **要**：逐文件确认 |
| 启动目录下子目录里的 `.sid-code/skills/`（运行中发现） | 项目级 | **要**：与项目级同一套确认 |
| `--add-dir <目录>` 下的 skill | 额外授权目录 | 无（命令行授权即表达意图） |
| 插件提供的 skill | 带 `插件名:` 前缀 | 不逐文件确认；能否加载由插件安装来源和企业插件来源策略决定 |
| 企业 managed 目录 | 全局，优先级最高 | 无需项目级确认；`SID_CODE_DISABLE_POLICY_SKILLS=1` 时整层不加载 |

无论信任要求如何，skill 跑起来后调用的工具都照常过权限检查。
企业开了 `strictPluginOnlyCustomization`（锁了 skills 面）或禁用了 `extensions` 时，
用户级、项目级、运行中发现、`--add-dir` 这几层都不加载，只剩内置、插件与 managed。

`<项目>` 不只是启动目录：从启动目录**逐级往上扫到 git 仓库根**，每一层的 `.sid-code/skills/`、
`.claude/skills/` 都读，同名时离启动目录近的优先；仓库外的上层目录不读。

**运行中发现**：模型读写启动目录下某个子目录里的文件时，会沿路径往上找子目录自带的 `.sid-code/skills/`
并加载（monorepo 子包自带 skill 的场景）。它和项目级 skill 一样要过信任确认：
交互模式下弹确认框，批准后**再操作一次那个目录里的文件**即可在本会话加载；`-p` 或拒绝时不加载。
但它**不参与下面那条同名覆盖链**——同名时直接跳过，见下一段。

**启动时**加载的几层，同名优先级是 **managed > `--add-dir` 目录 > 项目级 > 用户级 > 内置**，
后加载的覆盖先加载的；同一层内 `.sid-code` 覆盖 `.claude`。也就是说仓库里的同名 skill
会盖掉你用户级的那份，而企业下发的 managed 压得住所有人。

**运行中发现是例外：只增不覆盖。** 子包里发现的 skill 与已加载的任何同名 skill
（内置、用户级、项目级、插件都算）撞名时直接跳过，沿用已有的那份——哪怕那份的优先级更低。
反过来说，子包的 skill **盖不过**用户级的同名 skill，想让它生效只能换个名字，
或者先把同名的那份去掉。

## 常见问题

### 项目级 Skill 写了但模型说不存在

默认设置下，`-p` 无头模式**加载不到未确认过的项目级 Skill**——这是设计而非 bug：项目级扩展来自仓库，
默认视作不可信，需要用户确认；而 `-p` 下没法确认，所以直接跳过。

示例对比同一个 Skill、同一条命令：

```text
# trust_project_extensions 未开
`changelog-entry` 这个 Skill 目前不存在。不过我可以直接帮你生成变更记录……

# 开了之后
- fix: 修正 add 函数的边界条件
```

解决方式三选一：

- 在交互模式里跑一次，在弹出的确认框里信任它（按文件内容记住，之后 `-p` 也能加载）；
- 把 Skill 挪到用户级 `~/.sid-code/skills/`（不受信任门槛约束）；
- 在**用户级** `~/.sid-code/settings.json` 设 `"trustProjectExtensions": true`：对所有项目生效，
  只建议在受控的 CI 环境里用，项目级 settings 设不了它。

`--yes`、`--dangerously-skip-permissions`、`--trust-workspace` 管的是工具权限与项目配置（hooks / MCP 等）的信任，
**不会**放行未确认的项目级 Skill，别指望靠它们解决这个问题。

交互模式下的确认框：

- 默认选中的是「不信任」，用 ↑↓ 选到「是，信任并加载」再回车才加载；
- 选「不信任」、直接回车、按 Esc，都是本次不加载、下次启动再问；
- 加载后会记住信任，文件内容变了会再问；
- 会话进行中才出现的新文件（热重载、运行中发现）也会当场弹框，批准后本会话就生效，不用重启。

没有交互终端（如 Bridge / 无 TTY）时没有地方能确认，一律不加载。

### 怎么确认 Skill 到底加载了几个

会话里跑 `/skills` 能看到内置、编译进二进制和磁盘上的 skill 及来源（插件、MCP 的不在面板里）。
面板按磁盘扫描列出，被信任门槛拦下的项目 skill 也可能出现在列表里，它在不在模型手上以下面的日志为准。

也可以开 `-d` 跑一次看日志，形如（数字随你的环境变化）：

```text
● [SKILL] 加载了 3 个 Skill
● [SKILL] 发现 3 个 Skill（3 个已启用）
● [PROMPT] 附件: Skill 摘要列表(0.1K tok, priority=8)
```

数量对不上预期时，常见原因是路径不对、被信任门槛拦了（看有没有弹信任确认或 warn 日志）、
被 `disabledSkills` 禁用，或企业策略锁了 skills 面。一个 Skill 都没加载时这两条数量日志不会出现，
「没看到日志」不能直接推出是哪种原因。

### 禁用某个 Skill

内置、用户级、项目级、插件、MCP 提供的 skill，以及编译进二进制的 `/review` 等都能按名字禁用。
插件 skill 要写带前缀的全名（如 `github-pr:comments`）。三种方式：

- **配置文件**：`~/.sid-code/settings.json`（或项目的 `.sid-code/settings.json`）里列进 `disabledSkills`，
  启动时生效，之后才加载进来的同名 skill（插件、MCP、运行中发现、热重载）也保持禁用：

  ```json
  { "disabledSkills": ["skill-creator"] }
  ```

- **斜杠命令**：`/skills disable <名字> [--scope user|project]`，写进对应 settings；`/skills enable <名字>` 恢复；
- **`/skills` 面板**：选中一行按 Enter 切换启用 / 禁用，写进当前作用域的 settings（面板里没有插件、MCP 的 skill，它们用前两种方式）。

后两种在交互会话里**当场生效**：`/<名字>`、模型经 `Skill` 工具的调用、`skill__<名字>` 工具都立刻不可用，不用重启。
命令拿不到当前会话的运行时（如独立调用）时会提示「重启会话后生效」。

另外两种手段**不是**禁用，作用范围窄得多：

- `permissions.deny: ["Skill"]` / `["Skill(<名字>)"]`：拒绝经 `Skill` 工具调用的 skill（全部或指定一个）；
  拦不住 `skill__review` 这类独立工具名，要拦得另写 `permissions.deny: ["skill__review"]`；
- `--disallowed-tools Skill`：只从模型的工具列表里移除 `Skill` 这一个工具，`skill__<名字>` 工具和你手动 `/名字` 都不受影响。

### 改了 SKILL.md 要重启吗

通常不用。Skill 有热重载监听（启动日志 `[SKILL] Skill 热重载监听已启动`），存盘即生效。
监听范围是用户级（`~/.sid-code/skills`、`~/.claude/skills`）与**启动目录**下的 `.sid-code/skills`、`.claude/skills`；
上层目录（启动目录到 git 根之间）、子目录里运行中发现的、插件、managed 目录不在监听范围内，改了要重启或 `/reload-plugins`（插件）。
监听在部分系统上可能失效（会静默降级），`SID_CODE_DISABLE_SKILL_HOT_RELOAD=1` 可关闭。

### Skill 会自己乱跑吗

会被模型自主调用——这是它的设计意图。不想让模型自动调，加
`disable-model-invocation: true`：它不进模型的摘要，模型按名调用也会被拒，只能你手动 `/名字` 触发。
带副作用的 Skill（会提交、会推送的）建议都加上。

这个字段只关闭模型自动调用，**不是权限闸门**：你手动触发时照常执行，skill 里的提交、推送等操作
仍由权限检查决定要不要确认，不会因为写了它就多一道拦截。

## 相关

- [扩展方式总览](/extend/) — Skill / Hook / 子代理 / MCP 怎么选
- [记忆与 CLAUDE.md](/use/memory) — 什么该写进 CLAUDE.md 而不是 Skill
- [子代理](/extend/subagents) — delegate 模式底层用的就是子代理
- [斜杠命令](/ref/slash-commands) — `/skills` 等命令的完整列表
- [settings.json 字段](/ref/settings) — `disabledSkills` 等字段
