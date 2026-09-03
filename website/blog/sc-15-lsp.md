---
title: 'Agent Runtime（15）· LSP 代码智能：让 agent 看懂符号而不只是文本'
description: '定义跳转、引用查找、实现跳转、诊断回灌。讲清 LSP 在 agent 里的位置：它不是给人用的编辑器功能，是给模型补一层它靠 grep 拿不到的结构信息。'
date: "2026-09-03"
series: Agent Runtime 从零到一
tags: [LSP, 代码智能, 从零到一]
outline: [2, 3]
---

# LSP 代码智能：从零到一

::: info 这是一份快照
本文的数字、常量、行数取自 **2026-09-03** 对 sid-code 源码的一次实读。
代码在动，这些数字会腐坏——引用其中任何一个之前，请按文中给出的命令在你自己的仓库里复跑一次。
:::

> **这份文档写给谁**：没写过 language server、也没接过 LSP，但需要在短期内既能听懂别人在说
> 什么、又能自己动手把它接进一个 coding agent 的人。用途是知识梳理与 agent 开发面试准备。
>
> **它和同主题另外两份文档的关系**：`bugfixes/done/LSP/` 下那两份是**执行文档**——写给已经懂的人，
> 满篇是「G7 是废测」「这个方案 80% 是我上次已否决的东西换了包装」。信息密度极高，
> 但它们**默认你已经知道 JSON-RPC、诊断、capabilities、didOpen 是什么**，所以第一次读会卡住。
>
> 本文补的正是那一层：**先把协议讲通，再把那两份文档里真正值钱的裁决放回它该在的位置上。**
>
> **它不是摘要。** 摘要会把结论抽出来变成一句正确但没用的话
> （比如「LSP 比 grep 精确」——对，但说不出为什么就等于没说）。本文的写法相反：
> **每个结论都从「为什么会有人搞错」讲起**，因为面试里能拉开差距的从来不是结论本身，
> 是你能不能说清它的反面为什么诱人。
>
> **一条阅读约定**：本文所有代码行为都标了事实来源等级——
> 🔬 = 我读过 `sid-code` 源码并核对过常量的；📐 = LSP 3.17 规范规定的；
> 📄 = 二手材料（他人文档 / 调研结论），可靠性低一档。
> 这个标记不是形式主义：混在一起读，你会把「规范这么说」和「我们这么实现」当成同一件事，
> 而这两者在 LSP 上**经常不一致**（§9 有一整节讲这个）。

---

## 怎么读这份文档

按顺序读。这份文档是**一条链**，不是清单——后面每一章都在用前面章节建立的概念。

| 章 | 讲什么 | 读完你能回答 |
| --- | --- | --- |
| **§0** | 名词地图 | 别人说 diagnostic / capabilities / didOpen 时，你知道指什么 |
| **§1** | 为什么 grep 不够用 | 「LSP 比 grep 准」这句话的具体含义是什么 |
| **§2** | 最小心智模型：剥掉抽象，它就是两个进程在管道里传 JSON | 能徒手画出一次 `goToDefinition` 的完整数据流 |
| **§3** | 协议解剖：三类消息 + 生命周期 | 能说清请求 / 响应 / 通知的区别，以及为什么这个区别是后面一半 bug 的根源 |
| **§4** | 文档同步：LSP 最容易错的一块 | 为什么「文件在磁盘上改了」不等于「服务器知道它改了」 |
| **§5** | ★ **两条链路**：主动拉 vs 被动推 | 本文架构核心。拿到一个 LSP 需求，你知道它属于哪条链路 |
| **§7** | 诊断链路：从服务器推送到进模型上下文 | 能说出四道门控，以及每道拦掉了什么 |
| **§8** | 多服务器编排：路由、懒启动、崩溃恢复 | 十种语言十个进程，怎么管 |
| **§9** | ★ **会静默出错的形状与坐标细节** | 这一章是本文最值钱的部分之一 |
| **§10** | codeAction：确定性修复，以及它的真实天花板 | 为什么「让 LSP 自动修」是个陷阱 |
| **§11** | 上下文经济学：LSP 到底省 token 还是费 token | 能算清这笔账，而不是喊口号 |
| **§12** | 十个真实陷阱（多数会「绿着坏掉」） | 这一章是另一个最值钱的部分 |
| **§13** | 五家横向对比：同一个协议，五种取舍 | 调研时不会得出「对方有我们没有 = 我们落后」这种蠢结论 |
| **§14** | 从零到一：六阶段动手路线 | 你能自己写一个能跑的 mini LSP 客户端 |

**如果只有 20 分钟**：读 §2、§5、§9。这三章是这个领域的骨架，其余都是它们的展开。

**如果只有 5 分钟**：读 §5 那张「两条链路」的表，再读 §12 的五句话压缩版。

---

## §0 名词地图：先把词认全

这一节是**查询表，不用背**。往后每章第一次用到某个词时都会重新解释，
这里放一份集中的，是为了你读执行文档时能随时回来查。

按「一次 LSP 交互从头到尾」的顺序排列，不按字母序——因为这些词之间是有位置关系的。

### 0.1 两个角色

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **language server** | 语言服务器 | 一个**独立进程**，懂某一种语言（TS / Python / Go…）。它把你的代码解析成 AST、算出类型、建立符号索引。`typescript-language-server`、`gopls`、`rust-analyzer` 都是 |
| **client** | 客户端 | 需要代码智能的那一方。VSCode 是客户端，Neovim 是客户端，**sid-code 也是客户端** |
| **LSP** | 语言服务器协议 | 这两者之间说话的规矩。它的全部价值在于**解耦**：M 个编辑器 × N 种语言，从 M×N 份适配代码变成 M+N 份 |
| **stdio** | 标准输入输出 | 两个进程之间最常用的通道：客户端 spawn 服务器，往它的 stdin 写、从它的 stdout 读。也有 TCP / socket 形态，但 agent 场景几乎都用 stdio |

> 💡 **先记住这一条，它能防住后面一半的困惑**：
> **language server 是另一个进程，它有自己的内存、自己的一份代码副本。**
> 它看到的不是你磁盘上的文件，是**你告诉它的内容**。
> §4 整章都在讲这一条的后果。

### 0.2 通信层

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **JSON-RPC 2.0** | — | 一种极简的远程调用格式：一个 JSON 对象，带 `method`（调什么）、`params`（参数）、可选的 `id`（用来把响应配回请求） |
| **Content-Length 帧** | 长度前缀帧 | 管道是**字节流**，没有天然的「一条消息」边界。所以每条消息前加一行 `Content-Length: 123`，读方据此知道该切在哪。**这个数字是字节数，不是字符数**（§12 陷阱 1） |
| **request / 请求** | 请求 | **带 `id`**，发出后要等一个响应。`textDocument/definition` 是请求 |
| **response / 响应** | 响应 | 带同一个 `id` 的回复，含 `result` 或 `error` |
| **notification / 通知** | 通知 | **不带 `id`**，发出即忘，**没有响应，也无法知道对方处理了没有**。`textDocument/didOpen` 是通知。这个「无法知道」是 LSP 时序 bug 的头号来源（§5、§12 陷阱 3） |

### 0.3 握手与能力协商

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **initialize** | 初始化请求 | 连接后的第一条消息。客户端在这里说：我的根目录是哪、**我支持什么**（capabilities） |
| **capabilities** | 能力声明 | 双向的：客户端声明「我能处理什么」，服务器声明「我能提供什么」。**这是最容易被忽略的一块**——你不声明支持 hover，有些服务器就干脆不给你 hover（§12 陷阱 4） |
| **initialized** | 初始化完成通知 | 客户端在收到 initialize 响应后发的通知，表示"我准备好了，可以开始推送了" |
| **initializationOptions** | 初始化选项 | 服务器特有的私货配置。比如 Volar 需要知道 TypeScript 装在哪 |
| **shutdown / exit** | 关闭 / 退出 | 优雅关闭的两步：先 `shutdown` 请求（等响应），再 `exit` 通知，然后才 kill 进程 |

### 0.4 文档同步（这一组最容易漏，注意）

| 词 | 中文 | 是什么 | 关键点 |
| --- | --- | --- | --- |
| **textDocument/didOpen** | 打开文档 | 告诉服务器「这个文件现在的内容是这些」，附完整文本 | **必须先 didOpen 才能查询**。没 open 过的文件，服务器没有它的 AST |
| **textDocument/didChange** | 文档变更 | 内容变了。可以传增量（只传改动部分）或全量（传整份） | sid-code 走**全量**：实现简单、不会错位 🔬 |
| **textDocument/didSave** | 文档保存 | 文件存盘了 | 看起来多余（didChange 不是已经说了吗）——但**部分服务器只在 didSave 时做完整诊断**（§12 陷阱 5） |
| **textDocument/didClose** | 关闭文档 | 不再关心这个文件 | 服务器会丢掉它的诊断 |
| **version** | 版本号 | 每次 didChange 递增的整数 | 服务器用它判断「我手上的内容是不是最新的」。发错会导致服务器拒绝或错乱 |
| **URI** | 统一资源标识 | LSP 里文件一律用 `file:///abs/path` 形态，不用裸路径 | 转换要用 `pathToFileURL`，别自己拼字符串（空格、中文、Windows 盘符全是坑） |

### 0.5 查询侧（主动拉）

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **definition** | 定义 | 这个符号在哪定义的 |
| **references** | 引用 | 谁用了这个符号 |
| **hover** | 悬停 | 这个符号的类型签名 + 文档注释 |
| **implementation** | 实现 | 这个接口 / 抽象方法有哪些具体实现 |
| **documentSymbol** | 文档符号 | 这个文件里有哪些类 / 函数 / 变量（带层级） |
| **workspaceSymbol** | 工作区符号 | 全项目按名字搜符号 |
| **callHierarchy** | 调用层级 | 谁调用我（incoming）/ 我调用谁（outgoing） |
| **codeAction** | 代码操作 | 「这里能怎么改」的建议集合，含 quickfix（修错）、refactor（重构） |
| **Location** | 位置 | `{ uri, range }`。查询结果的基本单位 |
| **LocationLink** | 位置链接 | `{ targetUri, targetRange, targetSelectionRange }`。**同一个查询可能返回这两种形状中的任一种**，取决于你的 capabilities 怎么声明（§9） |
| **Range / Position** | 范围 / 位置 | `{ line, character }`，**0-based**。而人和编辑器用 **1-based**。这个 off-by-one 是 LSP 头号新手坑 |

### 0.6 诊断侧（被动推）

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **diagnostic** | 诊断 | 一条错误 / 警告 / 提示。含 message、severity、range、source、code |
| **textDocument/publishDiagnostics** | 发布诊断 | 服务器**主动推**给客户端的通知。**注意方向：服务器 → 客户端，你没请求它就会来** |
| **severity** | 严重度 | 协议里是数字 1–4：1=Error、2=Warning、3=Info、4=Hint |
| **source** | 来源 | 哪个工具报的，如 `typescript`、`eslint` |
| **code** | 错误码 | 如 `2322`、`no-unused-vars`。**有它模型才能按码检索文档**，别在采集时丢掉 🔬 |
| **pull diagnostics** | 拉取式诊断 | LSP 3.17 新增的 `textDocument/diagnostic` 请求，让客户端主动要诊断。sid-code **没用**它，走的是经典 push 形态 🔬 |

### 0.7 工程侧（agent 特有）

| 词 | 中文 | 是什么 |
| --- | --- | --- |
| **懒启动 / lazy start** | — | 不在启动时拉起所有语言服务器，第一次真要用到时才拉。**十个语言服务器全启动会让冷启动变成灾难** |
| **路由表** | — | 扩展名 → 哪个服务器。`.ts` 给 typescript，`.go` 给 gopls |
| **崩溃恢复** | — | 语言服务器会崩（大工程上 rust-analyzer OOM 是常事）。崩了自动重启，但要有次数上限，否则崩溃循环 |
| **ContentModified (-32801)** | 内容已变更错误 | 一个**专门要重试**的错误码：你查询时文件又被改了，服务器说"我算的东西过期了"。重试即可 |
| **诊断注入** | — | 把诊断塞进模型上下文的动作。**这是整条链路的最后一公里，也是最容易断的一环**（§7） |
| **去重 / 限流** | — | 同一个错误别每轮都告诉模型；一次别塞 500 条。没有这两层，LSP 会变成 token 黑洞 |

> 💡 **一个能立刻用上的类比**：把 language server 想成**一个隔着窗口工作的资料员**。
> 你要查什么，写张单子递进去（request），他查完递出来（response）。
> 你手上的文件改了，得**主动复印一份递进去**（didChange）——他看不见你桌上的东西（§4）。
> 他发现资料本身有错，会主动写张纸条推出来（publishDiagnostics），不用你问。
> 而 `Content-Length` 是**递单子时说清「这张单子有几个字」**，否则两张单子会粘在一起。
>
> 这个类比后面还会用到好几次，尤其是 §4 和 §5——**那两章讲的就是「资料员和你手上的版本不一致」
> 以及「递单子和收纸条是两条完全不同的链路」。**

---

## §1 为什么 grep 不够用

大多数人第一次听到「给 agent 接 LSP」，反应是：agent 已经有 grep 了，还有 read，
它读代码不是挺好的吗？

**这个反应不错，因为它逼着我们说清 LSP 到底买到了什么。** 这一节就干这件事。

### 1.1 先承认 grep 很好用

grep（sid-code 里是 ripgrep 封装）有三个真实优势，别急着贬它：

1. **零依赖**：不用装 language server，不用起进程，不用等索引。
2. **对任何语言都一样好用**：Dockerfile、Makefile、YAML、日志、注释——LSP 全不管的东西。
3. **快**：全仓字符串搜索是毫秒级，而 rust-analyzer 首次索引一个大工程要几十秒。

所以 §13 里有一家（Aider）**刻意不接 LSP**，靠"改完跑测试看输出"闭环。那不是懒，是取舍。

### 1.2 grep 的天花板在哪

问题出在一件事上：**grep 匹配的是文本，而代码的含义不在文本里，在结构里。**

拿一个具体例子。假设你要改 `add` 这个函数，得先知道谁在用它：

```ts
// calc.ts
export function add(a: number, b: number): number {
  return a + b;
}

export function total(xs: number[]): number {
  return xs.reduce((s, x) => add(s, x), 0);
}

const bad: string = add(1, 2);
```

`grep add` 会捞到什么？三处 `add`，看着挺对。但把项目放大到真实规模：

| grep 会捞到但你不想要的 | 为什么 |
| --- | --- |
| `// TODO: add validation` | 注释里的英文单词 |
| `paddingLeft` / `address` / `addEventListener` | 子串命中（不加 `-w` 词边界时） |
| 另一个文件里**同名但完全无关**的 `add` | 文本相同，符号不同 |
| `import { add } from './other'` 之后的 `add` | 同名，指向另一个定义 |
| `node_modules/` 里几千处 | 依赖里的同名函数 |

反过来，**grep 会漏掉你想要的**：

| grep 找不到但确实是引用 | 为什么 |
| --- | --- |
| `const { add: plus } = calc; plus(1,2)` | 重命名导入后，引用处叫 `plus` |
| `calc["add"](1,2)` | 动态属性访问 |
| 类继承链上的方法覆盖 | 文本上完全不出现在子类里 |

而 `findReferences` 对上面那段代码给出的是（🔬 实测输出）：

```text
calc.ts:1:17
calc.ts:6:30
calc.ts:9:21
```

三处，一处不多一处不少：第 1 行定义本身、第 6 行 reduce 回调里的调用、第 9 行赋值时的调用。

> 🔑 **第一个要记住的转变**：
> 从「**匹配文本**」转向「**解析符号**」。
> grep 问「哪些字节和 `add` 相同」，LSP 问「**哪些位置引用了同一个符号**」。
>
> 这个区别有一个可操作的判据，面试值得直接背下来：
> **你要找的是「这个符号」还是「这段文字」？** 前者用 LSP，后者用 grep。
> 找配置项、找日志格式、找注释 TODO —— grep 更合适，别硬上 LSP。

### 1.3 但 LSP 真正的杀手能力不是查询

上面讲的都是「查得更准」。这确实值钱，但它是**可替代的**——模型足够强时，
grep 三次加上自己推理，往往也能得到正确答案，只是费 token。

LSP 有一样能力**grep 从原理上做不到**：

> **它会主动告诉你「你刚才改错了」。**

这就是**诊断**（diagnostic）。模型编辑完一个文件，语言服务器在几百毫秒内解析完，
把类型错误推过来，下一轮就进了模型的上下文。整个过程**不需要模型主动查任何东西**，
也不需要跑一遍 `tsc`。

对比一下没有诊断时的修 bug 循环：

| | 无诊断 | 有诊断 |
| --- | --- | --- |
| 发现错误 | 模型改完 → 自己想起来要验证 → 调 bash 跑 `tsc` → 等 20 秒 → 读输出 | 改完，下一轮上下文里自动出现 |
| 代价 | 一整轮 LLM 对话 + 一次全量编译 | 0 轮，几十个 token |
| 会不会漏 | **会**。模型经常忘了验证就宣布完成 | 不会。它是推过来的，不依赖模型记得去查 |

第三行是重点。「模型忘了验证就宣布完成」是 coding agent 最常见的失败形态之一，
而诊断链路把「验证」从**一个模型要记得做的动作**变成了**一个基础设施保证的事实**。

> 🔑 **第二个要记住的转变**：
> LSP 给 agent 的价值分两半，**而大多数人只看到了前一半**：
> - **主动查询**（pull）：查得更准，省推理。价值中等，可被强模型部分替代。
> - **被动诊断**（push）：**不依赖模型主动性的错误反馈**。价值高，且不可替代。
>
> 面试里被问「为什么要给 agent 接 LSP」，只答第一半是普通答案，
> 答出第二半并说清「它把验证从模型的自觉变成了基础设施的保证」，是好答案。

这两半就是 §5 那两条链路。它们在代码里几乎不共享任何路径——
**你可以只做一条**，而且如果只做一条，该做的是第二条。

### 1.4 本章自检

- grep 和 LSP 的分界判据是什么？（一句话）
- 举一个 grep 会漏报引用的具体写法。
- 「LSP 的价值分两半」是哪两半？哪一半不可替代，为什么？

---

## §2 最小心智模型：剥掉抽象，它就是两个进程在管道里传 JSON

LSP 的文档（微软官方那份）有一百多页，读完你会觉得这是个庞然大物。
**它不是。** 这一节把它剥到只剩骨头，之后所有复杂度都是往这根骨头上挂东西。

### 2.1 三句话讲完

1. 你 **spawn 一个子进程**（`typescript-language-server --stdio`）。
2. 你往它的 **stdin 写 JSON**，从它的 **stdout 读 JSON**。
3. JSON 前面加一行 `Content-Length: N`，空行隔开。

就这些。没有 HTTP，没有 gRPC，没有序列化框架。

一次完整的「跳到定义」，原始字节长这样（📐 规范形态，🔬 与 sid-code 实际收发一致）：

```text
客户端 → 服务器（写进 stdin）：
Content-Length: 194

{"jsonrpc":"2.0","id":7,"method":"textDocument/definition","params":{"textDocument":{"uri":"file:///tmp/lspdemo/calc.ts"},"position":{"line":5,"character":29}}}

服务器 → 客户端（从 stdout 读到）：
Content-Length: 158

{"jsonrpc":"2.0","id":7,"result":[{"uri":"file:///tmp/lspdemo/calc.ts","range":{"start":{"line":0,"character":16},"end":{"line":0,"character":19}}}]}
```

把这段读懂，LSP 你已经懂了 60%。剩下 40% 是「有哪些 method」和「时序上什么时候能发什么」。

注意 `id: 7` 出现在两边——这就是 JSON-RPC 把响应配回请求的全部机制。
因为管道是**乱序的**：你可以同时发出 5 个请求，服务器爱按什么顺序回就按什么顺序回。
没有 `id` 你就不知道哪个响应属于哪个请求。

### 2.2 为什么需要 `Content-Length`

这一点值得单独讲，因为它是**第一个会静默出错的地方**。

管道给你的是**字节流**，不是消息流。你 `read()` 一次可能拿到：

- 半条消息（`{"jsonrpc":"2.0","id":7,"meth`）
- 一条半（一条完整的 + 下一条的开头）
- 三条（服务器一次性刷出来的）

所以必须有帧协议。LSP 选了最土也最可靠的一种：**长度前缀**。

🔬 sid-code 的实现（`packages/core/src/lsp/client.ts`）就是一个状态机：

```ts
private handleData(data: string): void {
  this.buffer += data;
  while (true) {
    if (this.contentLength < 0) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;          // 头部还没收完，等下一批
      const match = header.match(/Content-Length:\s*(\d+)/i);
      this.contentLength = parseInt(match[1], 10);
      this.buffer = this.buffer.slice(headerEnd + 4);
    }
    // 按【字节】长度截取消息体
    const bodyBytes = Buffer.from(this.buffer, "utf-8");
    if (bodyBytes.length < this.contentLength) return;   // 体还没收完
    const body = bodyBytes.slice(0, this.contentLength).toString("utf-8");
    this.buffer = bodyBytes.slice(this.contentLength).toString("utf-8");
    this.contentLength = -1;
    this.handleMessage(JSON.parse(body));
  }
}
```

三个细节，每一个都是踩出来的：

| 细节 | 不这么做会怎样 |
| --- | --- |
| `while (true)` 循环 | 一次 `data` 事件里有多条消息时，只处理第一条，其余静默丢失 |
| 两处 `return` 而非 `break` | 数据不完整时必须**保留 buffer 原样等下一批**，不能丢 |
| `Buffer.byteLength` / `Buffer.from` 按**字节**切 | 中文注释、emoji 会让「字符数 ≠ 字节数」，按字符切必然错位。**这是 §12 陷阱 1** |

### 2.3 完整数据流：一次 `goToDefinition` 从头到尾

现在把 agent 那一侧接上。🔬 以下每一步都对应 sid-code 的真实代码路径：

```text
① 模型决定调工具
   { operation: "goToDefinition", file_path: "/abs/calc.ts", line: 6, character: 30 }
                                                   ↑ 注意：1-based（跟编辑器一致）

② LSPTool.execute()                             tool/lsp.ts
   ├─ 参数校验：POSITION_OPS 必须有 line + character
   ├─ waitForLSPReady()      ← 最长等 10s，服务器可能还在初始化
   ├─ getServerForFile()     ← 按扩展名 .ts 路由到 typescript 服务器
   │    未命中 → describeMissingServer() 给出精准安装命令，而不是「未配置」
   ├─ stat 检查 10MB 上限，然后 readFile 拿内容
   └─ manager.openFile()     ← 关键：先 didOpen，服务器才有这文件的 AST

③ 懒启动（如果这是第一次用到这个服务器）      lsp/server-instance.ts
   ├─ spawn("typescript-language-server", ["--stdio"])
   ├─ 发 initialize 请求（附 rootUri + capabilities），等响应，超时 30s
   └─ 发 initialized 通知 → 状态转为 running

④ 坐标转换 + 发请求                            tool/lsp.ts dispatch()
   line: 6 → 5      （1-based → 0-based，这里错了就整体偏一行）
   character: 30 → 29
   sendRequest("textDocument/definition", { textDocument: {uri}, position })

⑤ 服务器算完回 Location[] 或 LocationLink[]     ← 两种形状都要能接（§9）

⑥ 结果后处理                                   tool/lsp.ts + lsp-formatters.ts
   ├─ filterGitignored()  ← 剔掉 node_modules 之类被 .gitignore 忽略的命中
   ├─ normalizeLocations() ← 把两种形状归一
   └─ formatLocations()   ← 截断到 50 条，URI 转相对路径

⑦ 模型看到的最终文本
   calc.ts:1:17            ← 又转回 1-based
```

**这条链路上有 7 处可以静默出错**，而且大多数不会抛异常，只会给出「空结果」或「差一行」。
§9 和 §12 逐个讲。先记住这张图，它是后面所有排查的地图。

### 2.4 一个反直觉的事实：LSP 客户端很薄，服务器很厚

看完上面你可能觉得客户端很复杂。对比一下体量（🔬 实测行数）：

| | 行数 | 干什么 |
| --- | --- | --- |
| sid-code 整个 LSP 客户端层 | **2906 行**（`lsp/` 10 文件 1943 + `tool/lsp*.ts` 963） | 帧协议、进程管理、路由、去重、格式化 |
| `typescript-language-server` + `typescript` | 几十万行 | 真正的语言理解 |

**这个比例是 LSP 的核心价值。** 你花两千行接住协议，白拿几十万行的语言分析能力，
而且**换语言只要换个 command**——加一门语言在 sid-code 里是往一个数组里追加一条配置（§8）。

> 🔑 **第三个要记住的转变**：
> 别把 LSP 当成「一个功能」，把它当成**一个适配层**。
> 你写的所有代码都在做四件事：**帧协议、生命周期、路由、结果整形**。
> 一行语言分析逻辑都不该出现在你的代码里——真出现了，那是设计错了。

### 2.5 本章自检

- 为什么 JSON-RPC 需要 `id`？不要 `id` 会怎样？
- `Content-Length` 数的是字符还是字节？搞错了什么时候才暴露？
- 一次 `goToDefinition` 里，坐标一共转换了几次？分别在哪？

---

## §3 协议解剖：三类消息 + 生命周期

这一章讲两件事：**三类消息的区别**（后面一半 bug 的根源），
和**什么时候能发什么**（另一半的根源）。

### 3.1 三类消息，区别只有一个字段

| 类型 | 有 `id`？ | 有响应？ | 例子 | 失败时你知道吗 |
| --- | --- | --- | --- | --- |
| **请求** request | ✅ | ✅ | `textDocument/definition` | **知道**（超时或 error 响应） |
| **响应** response | ✅（同请求） | — | `{id:7, result:[...]}` | — |
| **通知** notification | ❌ | ❌ | `textDocument/didOpen` | **不知道** |

最后一列是这张表的全部重点。

**通知是 fire-and-forget：你发出去，然后什么都不知道。**
服务器可能没收到、可能收到了但还没处理、可能处理时抛异常了——你一律看不见。

这带来一个后果，它是 LSP 集成里最反复出现的 bug 形态：

> ⚠️ **`didOpen` 是通知，所以「文件已打开」这件事你无法等待。**
>
> 你发完 `didOpen` 立刻发 `textDocument/definition`，服务器**可能还没解析完那个文件**。
> 结果不是报错，是**返回空数组**——和「这个符号真的没有定义」一模一样。

🔬 sid-code 在 `codeAction` 上被这个坑过一次，注释里留了完整记录
（`tool/lsp.ts` 的 codeAction 分支）：

```text
诊断是服务器主动推的（publishDiagnostics），而 openFile 走的是 fire-and-forget 通知
（server-manager.ts didOpen 用 sendNotification，不等响应）。文件此前未打开时，
我们刚发出 didOpen 就 peek，服务器根本还没来得及分析 → 恒空 → 恒回
「无可用的代码修复建议」，而文件里明明有错
```

注意这个 bug 的形态：**没有异常、没有报错、功能「正常」返回一句人话**。
用户看到的是「无可用的代码修复建议」，而文件里有一个大红波浪线。
这是本文反复强调的那类失效——**绿着坏掉**。

修法见 §7.4（用一个「等诊断沉降」的 Promise 把推送变成可等待的）。这里先记住成因。

### 3.2 生命周期：五个阶段，顺序不能乱

📐 规范定义的握手顺序，一步都不能跳：

```text
① spawn 进程
      ↓
② initialize 请求  ─────→  客户端说：rootUri 是哪、我支持什么（capabilities）
      ↓                     服务器答：我支持什么（serverCapabilities）
③ initialized 通知 ─────→  客户端说：我准备好了，可以推送了
      ↓
④ ═══ 正常工作 ═══
      didOpen / didChange / didSave / didClose      （客户端 → 服务器，通知）
      definition / references / hover / ...          （客户端 → 服务器，请求）
      publishDiagnostics                             （服务器 → 客户端，通知）
      workspace/configuration                        （服务器 → 客户端，请求！§3.4）
      ↓
⑤ shutdown 请求（等响应）→ exit 通知 → kill 进程
```

三个「不能乱」的点：

| 规则 | 违反的后果 |
| --- | --- |
| `initialize` **必须是第一条**，且必须等到响应 | 服务器会拒绝或忽略之前的一切 |
| 收到 initialize 响应后**必须发 `initialized`** | 部分服务器在收到它之前不推诊断——你会觉得「诊断功能坏了」 |
| 关闭要 `shutdown` → `exit` → kill 三步 | 直接 kill 会留下临时文件 / 索引锁；gopls 尤其明显 |

🔬 sid-code 的实现（`lsp/server-instance.ts`）：

```ts
await this.client.start(command, args, { env, cwd: workspaceFolder });
// ...
await this.client.sendRequest("initialize", { processId, rootUri, capabilities, ... }, timeout);
this.client.sendNotification("initialized", {});
this._state = "running";
```

关闭是三步（`stop()`），且**每步都容错**——因为进程可能已经自己死了：

```ts
await this.client.sendRequest("shutdown", undefined, 3000).catch(() => {});
this.client.sendNotification("exit");
this.client.stop();   // 摘监听器 → kill → reject 所有 pending
```

注意 `shutdown` 用的是 **3 秒**超时而不是默认 30 秒 🔬。
理由很实际：关闭时用户在等 CLI 退出，一个不响应的服务器不该让人等半分钟。

### 3.3 capabilities：最容易被忽略的一块

握手时客户端要声明「我支持什么」。**新手直觉是这无所谓——反正我只是问问，服务器答就行。**

**错。** 很多服务器会根据你的声明**决定要不要回，以及回什么形状**。

🔬 sid-code 声明的 capabilities（`lsp/server-instance.ts`），每一条都是为了换取一样东西：

```ts
capabilities: {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false },
    publishDiagnostics: { relatedInformation: true },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
    references: {},
    implementation: { linkSupport: true },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    callHierarchy: { dynamicRegistration: false },
    codeAction: {
      codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix","refactor","source"] } },
      isPreferredSupport: true,
    },
  },
  workspace: {
    workspaceFolders: true,
    symbol: { dynamicRegistration: false },
    configuration: true,
  },
}
```

对照表（这张表值得记，面试问「capabilities 有什么用」时就答这个）：

| 声明 | 换到了什么 | 不声明会怎样 |
| --- | --- | --- |
| `synchronization.didSave` | 允许发 didSave | 发了可能被忽略，依赖 didSave 的服务器不刷新诊断 |
| `definition.linkSupport: true` | 允许服务器返回 **LocationLink**（比 Location 多一个"精确选中范围"） | 只回 Location。**但反过来说：声明了它，你就必须能解析两种形状**（§9.1） |
| `documentSymbol.hierarchicalDocumentSymbolSupport` | 拿到**带 children 的符号树** | 只回扁平的 `SymbolInformation[]`，层级信息丢失 |
| `hover.contentFormat` | 拿到 markdown | 可能只给纯文本 |
| `codeAction.codeActionLiteralSupport` | 拿到带 `edit` 的完整 CodeAction | **可能只回 `Command`**（一个要服务器执行的命令名），你拿不到"改哪里改成什么" |
| `codeAction.isPreferredSupport` | 拿到 `isPreferred` 标记 | 分不出哪个修复是首选 |
| `workspace.configuration: true` | 声明「我能应答配置请求」 | 见下一节——**声明了必须真的应答，否则更糟** |

> ⚠️ **一个对称的陷阱**：capabilities 是**承诺**，不是**许愿单**。
> 声明 `linkSupport: true` 之后服务器给你 LocationLink，你的解析代码只认 Location →
> **结果恒为空**。声明 `configuration: true` 之后服务器发配置请求，你不回 →
> **部分服务器卡在初始化里**。
>
> 判据：**每加一条 capabilities，都要问「这让服务器多发什么给我，我处理了吗」。**

### 3.4 一个方向反过来的消息：服务器也会请求客户端

这是很多人第一次实现时会漏掉的一整类消息。**服务器会主动发请求给客户端**（带 `id`，要你回）：

| 服务器发来的请求 | 它想干什么 |
| --- | --- |
| `workspace/configuration` | 「用户给我配了什么设置？」 |
| `client/registerCapability` | 「我要动态注册一个能力」 |
| `window/workDoneProgress/create` | 「我要开一个进度条」 |
| `workspace/semanticTokens/refresh` 等 refresh 类 | 「你缓存的东西过期了，重新问我」 |

**如果你静默丢弃这些请求，服务器会一直等那个 `id` 的响应。**
后果分两档：轻则反复重发（日志刷屏），重则**卡在初始化里不往下走**。

🔬 sid-code 的应答策略（`lsp/client.ts` 的 `handleServerRequest`）：

```ts
switch (msg.method) {
  case "workspace/configuration": {
    // 请求形如 { items: [{section?, scopeUri?}, ...] }，按项数返回等长空配置数组
    const items = Array.isArray(msg.params?.items) ? msg.params.items : [];
    respond(items.length > 0 ? items.map(() => ({})) : [{}]);
    break;
  }
  case "window/workDoneProgress/create":
  case "client/registerCapability":
  case "client/unregisterCapability":
  case "workspace/semanticTokens/refresh":
  case "workspace/inlayHint/refresh":
  case "workspace/diagnostic/refresh":
  case "workspace/codeLens/refresh":
    respond(null);   // 收到了，但我不渲染进度条 / 不缓存语义标记
    break;
  default:
    // 未知请求：显式回 MethodNotFound，而非静默丢弃
    this.writeMessage({ jsonrpc:"2.0", id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` } });
}
```

两个设计决策值得学：

1. **`workspace/configuration` 返回「与请求项数等长的空配置数组」**，不是 `null`、不是 `[{}]`。
   因为服务器可能一次问 3 项配置，它按下标取；数组长度不对会让它索引越界。
2. **未知请求回 `-32601 MethodNotFound`，而不是不回。**
   「明确说我不支持」和「装死」对服务器是完全不同的信号：前者让它继续走，后者让它等。

> 💡 这一节体现了一条通用原则，agent 开发里到处适用：
> **在协议边界上，「明确拒绝」永远优于「静默忽略」。**
> 静默忽略把一个本地问题变成了对方的挂起，而挂起的排查成本高一个数量级。

### 3.5 一个需要重试的错误码：ContentModified

📐 LSP 定义了一批错误码，其中 `-32801 ContentModified` **性质特殊**：

它的意思是「**你问的时候文件又变了，我算的结果已经过期，我不给你了**」。
这不是故障，是竞态——在 agent 场景里尤其常见，因为模型可能一边编辑一边查询。

**它是唯一值得自动重试的 LSP 错误。** 🔬 sid-code 的处理（`lsp/server-instance.ts`）：

```ts
const CONTENT_MODIFIED = -32801;
const RETRY_DELAYS = [500, 1000, 2000];   // 指数退避

for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
  try {
    return await this.client.sendRequest<T>(method, params, timeoutMs);
  } catch (err) {
    if (err.message?.includes(String(CONTENT_MODIFIED)) && attempt < RETRY_DELAYS.length) {
      await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
      continue;
    }
    throw err;     // 其它错误一律不重试
  }
}
```

注意 `throw err` 那行——**只重试这一个码**。这是刻意的：
其它错误（方法不支持、参数错、服务器崩了）重试只会浪费时间并掩盖真实问题。

> 🔑 **这里有一条可迁移的判据**，和 provider 层的重试策略是同一个道理：
> **重试的前提是「这次失败是瞬态的，下次可能成功」。**
> 分不清瞬态和永久就重试，得到的是「慢三倍的同一个失败」。

### 3.6 本章自检

- 通知和请求的区别是什么？这个区别导致了哪一类 bug？
- 为什么 `initialized` 通知不能省？
- 声明 `definition.linkSupport: true` 之后，你的解析代码必须多做什么？
- 服务器发 `workspace/configuration` 给你，你不回会怎样？为什么回 MethodNotFound 比不回好？
- 哪个 LSP 错误码值得重试？为什么其它的不值得？

---

## §4 文档同步：LSP 最容易错的一块

这一章只讲一件事，但它值得一整章：

> **language server 看到的不是你磁盘上的文件，是你告诉它的内容。**

§0 那个「隔着窗口的资料员」类比，讲的就是这个。你桌上的文件改了，
他看不见——你得复印一份递进去。

### 4.1 为什么不能让服务器自己读磁盘

新手的第一反应：文件就在磁盘上，服务器有 `rootUri`，它自己 `readFile` 不就完了？

三个理由，📐 都是协议刻意的设计：

| 理由 | 说明 |
| --- | --- |
| **编辑器里的内容常常还没存盘** | VSCode 里你打了半行代码，磁盘上还是旧的。要的是**内存里那份**的诊断 |
| **服务器需要知道"你在关注哪些文件"** | 一个 monorepo 有 5 万个文件，全解析会 OOM。didOpen 就是"这些是我关心的" |
| **版本号可以做竞态检测** | 服务器算到一半你又改了，它靠 version 知道该丢掉结果（回 ContentModified，§3.5） |

第二条在 agent 场景尤其重要：**agent 会碰的文件比人少得多**（一次任务改三五个文件），
所以「按需 didOpen」这个模型天然适合 agent，比编辑器还合适。

### 4.2 四条同步通知，各自的职责

| 通知 | 何时发 | 附带什么 | 漏了会怎样 |
| --- | --- | --- | --- |
| `didOpen` | 第一次碰这个文件 | **完整文本** + languageId + version=1 | 服务器没这文件的 AST → **所有查询返回空** |
| `didChange` | 内容变了 | 变更内容 + 递增的 version | 服务器基于旧内容算 → **诊断指向早已改掉的行** |
| `didSave` | 存盘了 | 只有 uri | 部分服务器不做完整诊断（§12 陷阱 5） |
| `didClose` | 不再关心 | 只有 uri | 服务器一直留着它的诊断和内存 |

🔬 sid-code 的 `changeFile`（`lsp/server-manager.ts`）把前两条合成了一个入口——
**第一次见到就 didOpen，之后 didChange**：

```ts
const existingVersion = this.openFiles.get(filePath);
if (existingVersion === undefined) {
  this.openFiles.set(filePath, 1);
  instance.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId, version: 1, text: content },
  });
} else {
  const version = existingVersion + 1;
  this.openFiles.set(filePath, version);
  instance.sendNotification("textDocument/didChange", {
    textDocument: { uri, version },
    contentChanges: [{ text: content }],    // 全量同步
  });
}
```

`openFiles: Map<string, number>` 同时是「打开状态」和「版本号」两件事的唯一事实源。
这个合并很关键：分成两个数据结构就会出现「以为打开了其实没有」的不一致。

### 4.3 增量同步 vs 全量同步：为什么选全量

注意上面那行 `contentChanges: [{ text: content }]` ——它传的是**整份文件内容**。

📐 协议支持两种：

| 形态 | 传什么 | 优点 | 缺点 |
| --- | --- | --- | --- |
| **增量** incremental | 只传「第 12 行第 3 列到第 12 行第 8 列，替换成 `foo`」 | 省带宽，大文件快 | **客户端必须自己维护一份与服务器完全一致的文本状态**，算错一个 offset 后面全错位 |
| **全量** full | 整份文件的新内容 | **不可能错位** | 大文件每次传全文 |

🔬 sid-code 选**全量**。这是一个正确的取舍，理由要说清楚：

- 管道是本地的，**传输成本几乎为零**（不是网络请求）。
- agent 的编辑粒度是「改完一个文件」，不是「敲一个字符」——**编辑频率比编辑器低两三个数量级**。
- 增量同步的 bug **会静默错位**：诊断指向错误的行，而你完全看不出是同步错了，
  只会觉得「语言服务器好像不太准」。

> 🔑 **一条可迁移的判断**：
> 增量同步的收益是**性能**，代价是**一类静默错误**。
> 在编辑器里（每秒几十次按键）这个交易划算；在 agent 里（每分钟几次编辑）**不划算**。
>
> 面试里这是个好回答：不是「我们选了简单的做法」，而是
> **「负载特征不同，最优解就不同」**——编辑器和 agent 对 LSP 的负载差三个数量级。

### 4.4 三个动作的正确编排：为什么是三步而不是一步

模型改完一个文件之后，要做的**不是**一件事，是三件。
🔬 sid-code 把它们收敛到一个函数 `syncFileToLSP`（`lsp/manager.ts`）：

```ts
export async function syncFileToLSP(filePath: string): Promise<void> {
  if (!filePath) return;
  try {
    if (!getLSPManager()) return;                 // LSP 未启用，连读盘都不做
    const content = await readFile(filePath, "utf-8");
    clearDiagnosticsForFile(filePath);            // ① 清去重缓存
    await notifyFileChanged(filePath, content);   // ② didChange（或首次 didOpen）
    getLSPManager()?.saveFile(filePath);          // ③ didSave
  } catch (e) {
    getLogger().debug("LSP", `文件变更同步失败（不影响工具执行）: ${e?.message}`);
  }
}
```

逐个讲为什么少不了：

**① `clearDiagnosticsForFile` —— 清跨轮次去重缓存**

这个最不直观，但漏了它会有一个非常难查的 bug。

诊断有跨轮次去重（§7.3）：同一条诊断投递过一次就不再投递，否则每轮刷同样的错误纯属噪音。
但文件被编辑后，**旧诊断的"已投递"记录变成了有害的**：

```text
第 1 轮：模型引入错误 → 诊断「第 9 行类型不匹配」→ 投递 → 记入 delivered
第 2 轮：模型改错了地方，第 9 行仍然类型不匹配 → 服务器重推同一条诊断
        → 命中 delivered → 被去重过滤 → 【模型再也看不到这个错误】
        → 模型以为修好了，宣布完成
```

所以编辑后必须清掉那个文件的 delivered 记录，让重推的诊断能作为「新诊断」再次投递。

反过来的形态同样存在：**修好了但过时错误驻留**。两个方向都被这一步治住。

**② `notifyFileChanged` → didChange** ——不解释，服务器得知道内容变了。

**③ `saveFile` → didSave** ——见 §12 陷阱 5：部分服务器（pylsp、某些 gopls 配置）
**只在 didSave 时做完整诊断**，didChange 只做语法级检查。不补这一步，
你会得到「Python 的类型错误从来不报」这种看起来像「pyright 不行」的现象。

**顺序不能换**：①必须在②之前。如果先 didChange，服务器可能在你清缓存之前就把新诊断推过来了，
那条诊断会命中还没被清掉的 delivered 记录，被误过滤。

> ⚠️ 这个顺序依赖是**时序性的、概率性的**——快的服务器上必现，慢的服务器上偶现。
> 这类 bug 在本地测不出来、在 CI 里偶尔红一次，最后被当成 flaky 忽略掉。
> **写下来，并且在代码注释里写清顺序理由**，是唯一的防线。

### 4.5 这条链路曾经在子代理路径上完全断掉

🔬 一个真实的、值得讲的缺陷（记忆与 Agent Note 双重确认）：

sid-code 的主循环（`query/tool-executor.ts`）编辑后会调 `syncFileToLSP`，一切正常。
但**子代理路径（`agent/tool-executor.ts`）此前完全不通知 LSP**——连 didChange 都不发。

后果分两层，都很隐蔽：

| 层 | 现象 |
| --- | --- |
| 子代理编辑的文件，服务器不知道变了 | 子代理拿不到自己引入的错误 |
| `collectDiagnosticText` 全项目**只有主循环一处调用** | 就算诊断到了，子代理循环也从不注入 |

修法是把编排提取成共享函数（就是上面那个 `syncFileToLSP`），两条路径共用。
🔬 现在的调用点是两处：

```text
packages/core/src/query/tool-executor.ts:1645   ← 主循环
packages/core/src/agent/tool-executor.ts:402    ← 子代理
```

> 🔑 **这是一类反复出现的债，值得单独记住它的形状**：
> **「能力建好了，但只接了主路径，没接子代理路径。」**
>
> sid-code 里同源的至少三例：hook 接线顺序、后台任务通知回注、这次的 LSP 同步。
> 成因是结构性的：**子代理是主循环的复制品，而复制发生在功能加上之前。**
>
> 排查判据（面试里这句话很值钱）：
> **对任何「已实现」的能力，都去 grep 它的调用点，然后问「子代理路径在这个列表里吗」。**
> 光看功能代码存在与否，看不出这个断层。

### 4.6 本章自检

- 为什么不让 language server 自己读磁盘？（至少两个理由）
- 增量同步的收益和代价各是什么？为什么 agent 场景该选全量？
- 编辑完一个文件要发几个通知？为什么清缓存必须在 didChange 之前？
- 「修好了但错误还在」和「没修好但错误消失了」——分别是漏了哪一步？

---

## §5 ★ 两条链路：主动拉 vs 被动推

这一章是本文的**架构核心**。§1.3 已经点过：LSP 给 agent 的价值分两半。
这一章把它们彻底拆开，因为**它们在代码里几乎不共享任何路径**，
而且混在一起想是绝大多数设计错误的源头。

### 5.1 判据：一句话

> **谁发起？**
> 模型发起 = **主动拉**（pull）。服务器发起 = **被动推**（push）。

就这一个问题。它决定了这个能力的全部工程性质：

| | 🔵 主动拉（pull） | 🟠 被动推（push） |
| --- | --- | --- |
| **谁发起** | 模型决定要查 | 服务器算完就推 |
| **协议形态** | 请求 → 响应（有 `id`，可等待） | 通知（无 `id`，不可等待） |
| **代表能力** | definition / references / hover / symbol / callHierarchy / codeAction | **publishDiagnostics** |
| **进模型上下文的路径** | 作为**工具结果**（模型调用后立即拿到） | 作为**每轮注入**（reminder / attachment 通道） |
| **token 计费时机** | 只在模型主动调用时 | **每轮都可能产生**，所以必须去重 + 限流 |
| **失败形态** | 超时 / 报错 —— **可见** | 静默不推 —— **不可见** |
| **模型知道它存在吗** | 知道，它写在工具描述里 | **不知道**，它就是"上下文里突然多了一段" |
| **对模型的要求** | 模型得**记得去用**（工具描述要写好） | 零要求，白送 |
| **sid-code 实现位置** | `tool/lsp.ts` + `tool/lsp-formatters.ts`（963 行） | `lsp/passive-feedback.ts` + `lsp/diagnostic-registry.ts` + 两处注入点 |

最后三行是重点，值得展开。

### 5.2 为什么「模型得记得去用」是 pull 链路的根本弱点

pull 链路有一个无法从工程上解决的问题：**它依赖模型的主动性。**

你把 `lsp` 工具做得再好，如果模型不调它，它就等于不存在。
而模型不调它的理由非常多且都很合理：

- 它有 grep，grep 更熟（训练数据里 grep 出现的次数比 LSP 多几个数量级）
- 它不确定这个项目有没有装 language server
- 工具太多了，它在 20 个工具里选，`lsp` 只是其中一个
- 它觉得自己已经看懂代码了（往往是错的，但它不知道）

🔬 sid-code 对此做的是**在工具描述里明确写对比**（`tool/lsp.ts` 的 `usageGuide`）：

```text
- 优先用它而非 grep 做符号级导航：grep 只匹配文本，lsp 理解语义
```

这句话有用，但**它是概率性的**——它提高调用率，不保证调用。

> 🔑 **这是一条通用结论，不止 LSP**：
> **任何 pull 式能力的实际价值 = 能力质量 × 模型调用率。**
> 而调用率你只能influence，不能保证。
>
> 所以 pull 能力的建设有一个天花板：**你无法通过把它做得更好来提高调用率**——
> 模型看不到你的实现质量，它只看到工具描述。
> 这也是为什么「工具描述」在 agent 开发里的杠杆远高于直觉（§11.3 会再回到这一点）。

### 5.3 为什么 push 链路是「零要求白送」——以及它的代价

push 链路的美妙之处：**模型完全不需要知道它存在。**

模型改完文件，下一轮上下文里就多了一段：

```text
<system-reminder>
LSP 诊断（来自语言服务器的实时反馈，非用户输入）：

## /tmp/lspdemo/calc.ts
  Error (9:7) [typescript] 2322: Type 'number' is not assignable to type 'string'.
  Hint (9:7) [typescript] 6133: 'bad' is declared but its value is never read.

以上是语言服务器对你刚编辑文件的实时分析结果。请关注其中的 Error / Warning，
在后续工作中修复这些问题；若与当前任务无关可暂不处理，但不要无视真实的类型/语法错误。
</system-reminder>
```

它不需要模型记得查、不需要模型选对工具、不需要模型知道装了什么 language server。
**这是「基础设施保证」而非「模型自觉」**，可靠性完全不同量级。

但它有一个对称的代价，同样值得写死：

> ⚠️ **push 链路的每一条诊断都是你替模型做的决定，而且要花它的钱。**
>
> pull 链路里模型花的每个 token 都是它自己选的。push 链路里**你在替它决定看什么**，
> 所以你必须回答：
> - 什么该注入，什么不该？（严重度过滤）
> - 同一条错误注入几次？（跨轮次去重）
> - 一次最多几条？（限流）
> - 什么样的 agent 不该收到诊断？（能力门控）
>
> **这四个问题就是 §7 的四道门控。** 一道都不做的话，诊断会从「白送的价值」变成
> 「每轮几千 token 的噪音」，而且模型会开始无视它——比不注入更糟。

### 5.4 两条链路的完整数据流对照

把两条链路画在一起，能看出它们几乎不重叠：

```text
🔵 PULL（模型主动查）

  模型 ──调 lsp 工具──→ LSPTool.execute()
                            ├─ waitForLSPReady()
                            ├─ 路由 + 大小检查 + openFile
                            ├─ sendRequest("textDocument/definition")  ← 请求，有 id
                            │      ↓ 等响应（30s 超时，ContentModified 重试）
                            ├─ filterGitignored()
                            └─ formatLocations()
                                   ↓
                            工具结果 ──→ 模型（当轮立即看到）

🟠 PUSH（服务器主动推）

  服务器 ──publishDiagnostics 通知──→ client.handleMessage()
                                          ↓  （无 id，没人在等它）
                              passive-feedback.ts 的处理器
                                          ↓  数字 severity → 字符串
                              DiagnosticRegistry.registerPending()
                                          ├──→ pending（待投递，会被消费清空）
                                          └──→ latest（只读快照，永不被消费）★
                                          ↓
                      ┌───────────────────┴───────────────────┐
                      ↓                                       ↓
        主循环每轮：collectDiagnosticText()        子代理每轮：collectDiagnosticText(editedFiles)
              四道门控                                    同样四道门控 + 作用域隔离
                      ↓                                       ↓
              reminderParts 注入                        ctxMgr.addMessage 注入
                      ↓                                       ↓
                    模型（下一轮看到）                      模型（下一轮看到）
```

注意 ★ 那一行：`latest` 是一份**只读快照，永不被消费**。
它的存在理由是让两条链路能交汇一次——而这个交汇点是本文最精巧的一处设计，下一节讲。

### 5.5 两条链路唯一的交汇点，以及必须守住的不变量

只有一个操作同时需要两条链路：**`codeAction`**。

它是 pull 的（模型主动查「这里能怎么修」），但它**必须带上 push 来的诊断**：

📐 LSP 的 `textDocument/codeAction` 请求里有个 `context.diagnostics` 字段。
**多数语言服务器在这个字段为空时返回空 quickfix 列表**——很合理，
它不知道你要修什么，凭什么给你修复建议？

所以 codeAction 需要读诊断。但诊断在 `pending` 里，而 `pending` 是**消费即清空**的
（主循环 collect 一次就清）。于是有两个诱人但都错的做法：

| 错误做法 | 后果 |
| --- | --- |
| **传空 `context.diagnostics: []`** | 服务器恒回空列表 → 用户永远看到「无可用的代码修复建议」。**这是原方案的致命 bug** 📄 |
| **从 `pending` 里读（并因此消费掉）** | codeAction 一调，**主循环那轮的诊断注入就断了**——诊断被 codeAction 偷走了 |

🔬 sid-code 的解法是加一份**独立的只读镜像** `latest`
（`lsp/diagnostic-registry.ts`），注释里把不变量写得很死：

```ts
/**
 * 每个文件的最新诊断全量快照（uri → 诊断数组）。
 *
 * 与 pending/delivered 的"消费即清空"语义完全独立：pending 供 G1 每轮注入消费（collect
 * 后清空），而 latest 是只读镜像，只被 registerPending 覆盖、被 clearForFile/clear 清除，
 * 从不被 collect 消费。存在的唯一目的是给 codeAction 这类 pull 式查询提供 context.diagnostics——
 * 多数语言服务器在 context 无诊断时返回空 quickfix 列表，而我们不能为此去偷 pending
 * （否则 G1 注入链断掉）。LSP publishDiagnostics 语义即"该文档的全量诊断"，故每次覆盖。
 */
private latest = new Map<string, Diagnostic[]>();
```

配套的读接口叫 `peekDiagnosticsForFile`——**名字里的 `peek` 就是不变量**：

```ts
peekDiagnosticsForFile(uri: string): Diagnostic[] {
  const diags = this.latest.get(uri);
  return diags ? [...diags] : [];      // 浅拷贝，防止调用方改动内部快照
}
```

> 🔑 **不变量：peek 绝不消费 pending。**
>
> 这条不变量有一条**专门的测试在守它** 🔬：e2e 测试用真实的
> `typescript-language-server`，验证「codeAction peek 之后，`collectDiagnosticText`
> **仍然能正常消费**」。
>
> 这个断言的写法值得学：它测的不是 codeAction 好不好用（那是功能测试），
> 而是**它有没有破坏另一条链路**。这类「跨链路副作用」的断言极少有人写，
> 而它恰好是最容易被后人无意破坏的东西——因为从 codeAction 那边看，
> 「顺手用 pending 里的数据」看起来完全合理。

### 5.6 一个必然的时序问题：push 的东西怎么等？

上面的设计还剩一个洞，§3.1 已经预告过：

**`didOpen` 是通知，诊断是推送。所以「刚打开文件就查 codeAction」必然 peek 到空。**

不是偶尔空，是**必然空**——服务器还没开始分析。

🔬 解法是给 registry 加一个「等这个文件的诊断首次到达」的 Promise
（`lsp/diagnostic-registry.ts` 的 `waitForDiagnostics`）：

```ts
waitForDiagnostics(uri: string, timeoutMs = 1500): Promise<boolean> {
  if (this.latest.has(uri)) return Promise.resolve(true);   // 已经到过，立即返回
  return new Promise<boolean>((resolve) => {
    // 注册一个 waiter，registerPending 到达时唤醒；超时则 resolve(false)
    const timer = setTimeout(() => done(false), timeoutMs);
    (timer as any).unref?.();     // 别把进程钉在事件循环里
    // ...
  });
}
```

这个函数的**语义边界**是全文最容易读错的一处，注释里写得很清楚，值得整段抄下来理解：

```text
返回 true 只表示"服务器已就该文件表过态"，不表示有诊断——空数组是合法且
常见的表态（文件确实没错）。调用方拿到 true 后仍要 peek 才知道有没有内容。

超时返回 false 时调用方应当照常继续（用空 context 发请求），而不是报错：
有些服务器对干净文件根本不推 publishDiagnostics，等到超时是正常路径，不是故障。
```

两句话拆开看，各自防一个误判：

| 语义 | 如果读错了会怎么写代码 | 后果 |
| --- | --- | --- |
| `true` ≠ 有诊断 | `if (await wait()) { 直接用诊断 }` | 干净文件上拿到空数组当有效数据 |
| `false` ≠ 故障 | `if (!await wait()) return error("诊断获取失败")` | **干净文件上永远报错**，而它其实一切正常 |

第二条尤其重要，它是一个「把正常路径当故障」的经典形态：
**「等不到」有两种成因——「还没算完」和「压根不会来」，而它们长得一模一样。**

🔬 所以调用侧是这么写的（`tool/lsp.ts`）：

```ts
if (registry) {
  onProgress?.({ type: "output", text: "等待诊断沉降…" });
  await registry.waitForDiagnostics(uri, CODE_ACTION_DIAGNOSTIC_WAIT_MS);  // 不看返回值！
}
const allDiags = registry ? registry.peekDiagnosticsForFile(uri) : [];
```

注意**返回值被刻意忽略了**——因为无论 true 还是 false，下一步都是 peek 然后照常继续。
这是对上面那两条语义边界的正确落地：函数返回值在这里只用于「不用等满超时」的优化，
不用于任何决策。

`CODE_ACTION_DIAGNOSTIC_WAIT_MS = 1500` 🔬 这个数字的取舍写在常量注释里：

```text
1.5s 的取值权衡：本地语言服务器分析单文件通常几百毫秒内推出诊断；干净文件可能压根不推，
那时必然等满这个时间，所以不能设太长（它是 codeAction 的固定下限成本）。
```

> 💡 **「等满超时是正常路径」这件事决定了超时值的性质。**
> 一般超时值是「异常路径的上限」，设长一点无所谓（正常时用不到）。
> 但这里干净文件**必然**等满，所以它是**每次 codeAction 的固定成本**。
> 这个区别决定了 1.5s 而不是 10s。
>
> 面试里这是个好例子：**同一个「超时」参数，在不同语义下取值逻辑完全相反。**
> 分不清「异常上限」和「固定成本」，就会把一个 8s 的默认值放在一条必然走满的路径上。

### 5.7 两条链路的建设优先级

如果你从零开始接 LSP，先做哪条？

**先做 push（诊断），后做 pull（查询）。** 三个理由：

| 理由 | 说明 |
| --- | --- |
| **push 不依赖模型主动性** | 建好就有价值，不用赌模型会不会调 |
| **push 的代码量小得多** | 🔬 sid-code：push 侧约 450 行（registry + passive-feedback + 两处注入），pull 侧 963 行（工具 + 格式化） |
| **push 的价值不可替代** | pull 能力强模型能用 grep 部分替代，push 没有替代品（§1.3） |

而**pull 侧的建设顺序**也有讲究，见 §6.5——不是十个操作一起上。

### 5.8 本章自检

- 区分两条链路的那一个问题是什么？
- pull 链路的实际价值等于什么乘什么？为什么这个乘法有天花板？
- push 链路「白送」的代价是什么？（四个问题）
- `latest` 快照存在的唯一理由是什么？它必须守的不变量是什么？
- `waitForDiagnostics` 返回 `false` 意味着故障吗？为什么调用方忽略它的返回值？
- 从零开始该先做哪条链路？三个理由。

---

## §6 十个操作逐个讲

这一章是**参考章**，但不是清单——每个操作都附「它真正的用途」和「什么时候别用它」。
读一遍建立地图，之后当查询表用。

🔬 sid-code 的 `lsp` 工具有 10 个操作。前 9 个与 Claude Code **逐字相同**（源码 grep 核过），
第 10 个（`codeAction`）是 CC 刻意不做的（§10 讲为什么）。

### 6.1 参数分三类

这个分类比操作列表更重要，因为它决定了模型会不会调错：

| 类别 | 操作 | 必填参数 |
| --- | --- | --- |
| **需要光标位置** | `goToDefinition` `findReferences` `hover` `goToImplementation` `prepareCallHierarchy` `incomingCalls` `outgoingCalls` | `file_path` + `line` + `character` |
| **只要文件** | `documentSymbol` | `file_path` |
| **要查询词** | `workspaceSymbol` | `file_path` + `query` |
| **两者皆可** | `codeAction` | `file_path`，`line`/`character` 可选 |

🔬 代码里这个分类是显式的一个 Set：

```ts
const POSITION_OPS = new Set([
  "goToDefinition", "findReferences", "hover", "goToImplementation",
  "prepareCallHierarchy", "incomingCalls", "outgoingCalls",
]);
```

两个值得注意的例外：

- **`workspaceSymbol` 也要 `file_path`**，但它不用来定位符号——**只用来决定问哪个语言服务器**。
  你搜 Go 符号得问 gopls，搜 TS 符号得问 tsserver，而路由表是按扩展名查的。
  所以传项目里任意一个同语言文件即可。这个设计不直观，🔬 所以工具描述里专门写了一句：
  「`file_path` 仅用于定位语言服务器，可传项目内任意文件」。
- **`codeAction` 刻意不进 `POSITION_OPS`**：给位置 = 只查光标那行的修复；不给 = 查整个文件。
  两种都合法，但代价差很多（§10.3）。

### 6.2 导航三件套：definition / references / implementation

这三个共用同一套返回形状（`Location[]` 或 `LocationLink[]`）和同一套后处理管线。

| 操作 | LSP 方法 | 回答什么 | 典型用途 |
| --- | --- | --- | --- |
| `goToDefinition` | `textDocument/definition` | 这个符号在哪定义的 | 顺着调用读到实现 |
| `findReferences` | `textDocument/references` | 谁引用了它 | **改之前先看影响范围**——这是它最值钱的用法 |
| `goToImplementation` | `textDocument/implementation` | 接口 / 抽象方法的具体实现有哪些 | 读到接口卡住时用它 |

🔬 `findReferences` 的一个参数细节：

```ts
context: { includeDeclaration: true }
```

`includeDeclaration` 决定「定义处算不算一个引用」。sid-code 选 `true`，
所以 §1.2 那个例子里返回三条（含第 1 行的定义本身）。

这个选择对 agent 是对的：**模型要的是「这个符号出现在哪些地方」的完整图景**，
定义处当然算。但要知道**它会让计数与直觉不一致**——你说「有 2 处调用」，工具说 3 条。

**definition 与 implementation 的区别**值得说清（面试会问）：

```ts
interface Store { get(k: string): string }        // ← definition 指向这里
class RedisStore implements Store { get(k) {...} } // ← implementation 指向这里
class MemStore  implements Store { get(k) {...} }  // ← 和这里
```

对 `store.get(...)` 这个调用点：
- `goToDefinition` → 接口声明（一处，**往往是你不想要的那处**）
- `goToImplementation` → 两个具体类（多处，通常才是你想读的）

> 💡 **一条实用经验**：读接口密集的代码（Java / Go / 大型 TS 项目）时，
> **`goToDefinition` 经常是无用的**——它带你到一行抽象声明，什么都没告诉你。
> 这种项目里 `goToImplementation` 的价值远高于 definition。

### 6.3 理解两件套：hover / documentSymbol

| 操作 | LSP 方法 | 返回什么 |
| --- | --- | --- |
| `hover` | `textDocument/hover` | 类型签名 + 文档注释，markdown 形态 |
| `documentSymbol` | `textDocument/documentSymbol` | 文件内符号的**层级树** |

🔬 `hover` 的实测输出（就是 markdown 代码块）：

```typescript
function add(a: number, b: number): number
```

**`hover` 是 token 效率最高的 LSP 操作**，值得单独说：
它用几十个 token 换到「这个函数的完整签名」，而等价的做法是
`read` 整个文件（几千 token）或者 grep 出定义行然后自己拼上下文。

🔬 `documentSymbol` 的实测输出（缩进是真层级）：

```text
Function add (1:17)
Constant bad (9:7)
Function total (5:17)
  Function xs.reduce() callback (6:20)
```

它的用途是**代替「读整个文件」来建立文件结构认知**。一个 2000 行的文件，
`documentSymbol` 给你 40 行的符号目录，模型据此决定读哪一段。

这是 §11（上下文经济学）里最划算的一笔交易，值得记住这个模式：
**用「目录」代替「全文」，让模型自己选要读的章节。**

🔬 返回形状有两种，取决于你的 capabilities（§3.3）：

| 形状 | 何时返回 | 特点 |
| --- | --- | --- |
| `DocumentSymbol[]` | 声明了 `hierarchicalDocumentSymbolSupport` | 带 `children`，**有层级** |
| `SymbolInformation[]` | 没声明，或服务器老 | 扁平，只有 `containerName` 字符串 |

**两种都要能解析**（§9.2）。sid-code 的判别方式很朴素但可靠：

```ts
function isDocumentSymbolArray(arr: unknown[]): arr is LSPDocumentSymbol[] {
  return arr.length > 0 && !!arr[0] && "range" in arr[0] && !("location" in arr[0]);
}
```

看有没有 `location` 字段——`SymbolInformation` 有，`DocumentSymbol` 没有（它用 `range`）。

### 6.4 搜索与调用链：workspaceSymbol / callHierarchy 三兄弟

**`workspaceSymbol`（`workspace/symbol`）**——全项目按名字搜符号：

```text
total (Function) — calc.ts:5:1
```

它和 grep 的区别：grep 给你所有文本命中，它只给你**符号定义处**。
找「那个叫 `UserService` 的类在哪」时，它一条就是答案，grep 要在几百条里挑。

⚠️ 但它有个真实缺点：**大工程上第一次调用可能极慢**（服务器要建全局索引）。
rust-analyzer 在大 workspace 上首次 workspaceSymbol 几十秒不奇怪。

**调用层级三兄弟**——这是唯一需要**两步**的操作，值得单独讲：

```text
① prepareCallHierarchy  →  拿到一个 CallHierarchyItem（"你说的是这个函数吧？"）
                            ↓
② incomingCalls（谁调用我） 或 outgoingCalls（我调用谁），参数是①拿到的 item
```

📐 为什么要两步？因为一个位置可能对应多个符号（重载、同名局部变量），
先让服务器确认「你指的是哪个」，再基于那个确定的 item 查调用关系。

🔬 sid-code 把这个两步**在工具内部替模型完成了**：

```ts
case "incomingCalls":
case "outgoingCalls": {
  const items = await manager.sendRequest(filePath, "textDocument/prepareCallHierarchy", {...});
  if (!items || items.length === 0) {
    return { output: "此位置无可用的调用层级项（请确认光标位于函数/方法名上）", isError: false };
  }
  const item = items[0];      // 取第一个
  // 再用 item 查 incoming / outgoing
}
```

三个设计点：

| 点 | 为什么 |
| --- | --- |
| 内部自动 prepare，模型只调一次 | 省一轮 LLM 往返。**模型少一次决策 = 少一次出错机会** |
| 空结果返回 `isError: false` | **这不是错误**，是「光标没落在函数名上」。标成 error 会让模型以为工具坏了 |
| 错误提示写明「请确认光标位于函数/方法名上」 | 这是最常见的成因，直接给出可操作的下一步 |

但 `prepareCallHierarchy` 仍然作为独立操作暴露着——因为模型有时需要先确认位置对不对，
再决定查哪个方向。

🔬 输出形态用箭头区分方向，很直观：

```text
← Function handleRequest (server.ts:42:3)  [2 处调用]     ← incoming（谁调用我）
→ Function validate (utils.ts:10:1)  [1 处调用]           → outgoing（我调用谁）
```

### 6.5 十个操作的建设优先级：不要一起上

如果你从零建 pull 侧，**按这个顺序**，理由在第三列：

| 档 | 操作 | 为什么在这一档 |
| --- | --- | --- |
| **第一档**（必做） | `hover`、`documentSymbol` | **单文件、无需索引、返回小、几乎不会失败**。投入产出比最高，且这两个是 token 效率最高的 |
| **第二档** | `goToDefinition`、`findReferences` | 最常用的导航。要处理两种返回形状 + gitignore 过滤 + 截断，工程量比第一档大 |
| **第三档** | `goToImplementation`、`workspaceSymbol` | 前者对接口密集项目价值高；后者要小心大工程首次极慢 |
| **第四档** | `prepareCallHierarchy` + `incomingCalls` + `outgoingCalls` | 三个操作换一个能力，且**很多服务器支持不完整**（callHierarchy 是较晚加入协议的） |
| **第五档**（可选） | `codeAction` | 见 §10——收益真实但天花板低，且有一堆时序陷阱 |

> 🔑 **这个排序的判据是「返回值大小 × 失败概率 × 依赖的服务器能力」，
> 不是「这个功能听起来多厉害」。**
>
> `callHierarchy` 听起来最酷（能画调用图！），实际排最后：三个操作、两步交互、
> 服务器支持率最低、返回值最大。而 `hover` 听起来最平庸，实际排第一。
>
> 面试里被问「你会先做哪些」，能说出这个排序和判据，比背出十个操作名有价值得多。

### 6.6 本章自检

- `workspaceSymbol` 为什么需要 `file_path`？
- `goToDefinition` 和 `goToImplementation` 在接口密集的代码里哪个更有用？为什么？
- 调用层级为什么要两步？sid-code 怎么处理这两步的？
- 「此位置无可用的调用层级项」为什么不标成 error？
- 十个操作里哪两个该最先做？判据是什么？

---

## §7 诊断链路：从服务器推送到进模型上下文

§5 讲了 push 链路的形状，这一章讲它的**四道门控**——
也就是 §5.3 那四个问题的具体答案。

这一章是全文**工程密度最高**的一章，因为诊断注入是「白送的价值」和「token 黑洞」
之间只隔了四道门。

### 7.1 全链路：六站

```text
① 语言服务器算完，推 publishDiagnostics 通知
        ↓
② client.ts handleMessage → 认出这是通知（无 id）→ 分发给处理器
        ↓
③ passive-feedback.ts：数字 severity → 字符串，抽取 message/range/source/code
        ↓
④ diagnostic-registry.ts registerPending()
        ├─→ pending（待投递队列）
        └─→ latest（只读快照，给 codeAction 用，§5.5）
        ↓
⑤ 每轮：collectDiagnosticText() ← 【四道门控在这里】
        ↓
⑥ 注入模型上下文（主循环走 reminderParts，子代理走 ctxMgr.addMessage）
```

先看第③站的一个细节，🔬 它是「别在采集阶段丢信息」的好例子：

```ts
const diagnostics: Diagnostic[] = p.diagnostics.map((d) => ({
  message: String(d.message ?? ""),
  severity: LSP_SEVERITY_MAP[d.severity] ?? "Info",
  range: d.range ?? { start: {line:0,character:0}, end: {line:0,character:0} },
  source: d.source,
  code: d.code,        // ← 保留错误码
}));
```

`code`（`2322`、`no-unused-vars`）很容易被当成噪音丢掉。🔬 保留它的理由写在格式化处：

```text
code（如 TS2304 / no-unused-vars）在采集阶段已保留，此处一并输出，
帮助模型判断错误类别、按错误码检索文档。
```

**模型可以按错误码检索**——`TS2322` 是个可搜索的标识符，而
"Type 'number' is not assignable to type 'string'" 只是一句话。这是真实收益。

还有第③站的错误隔离设计 🔬：处理器里套了一层 try/catch，
且**每个服务器的处理器独立注册**——一个服务器推来畸形数据，不会影响其它九个。

### 7.2 门控一：严重度过滤

📐 LSP 有四档严重度，数字对应：

| 数字 | 名称 | 含义 | 例子 |
| --- | --- | --- | --- |
| 1 | Error | 编译/类型错误 | `Type 'number' is not assignable to type 'string'` |
| 2 | Warning | 可能有问题 | `Unreachable code detected` |
| 3 | Info | 提示 | 风格建议 |
| 4 | Hint | 弱提示 | `'bad' is declared but its value is never read` |

🔬 sid-code 的规则：**只有含 Error / Warning 的文件才注入**：

```ts
const hasActionable = files.some((f) =>
  f.diagnostics.some((d) => d.severity === "Error" || d.severity === "Warning"),
);
if (!hasActionable) return null;
```

注意这个判断的粒度：**是「文件级」的门槛，不是「诊断级」的过滤**。

这个区别有一个可观测的后果，🔬 官网文档里专门点破了：

```text
注意上表第一行：文件里只有 Hint 时整个文件都不注入。所以上面那段实测里，
Error 和 Hint 是一起出现的——是那条 Error 把文件带进来的。
```

也就是说：一个文件只要有一条 Error，它的 Hint 也会跟着进上下文。
这是刻意的——**同一个文件里的 Hint 往往和那条 Error 相关**
（比如「类型不匹配」+「这个变量没被用过」常常指向同一处写错的代码）。

> 🔑 **这是一个刻意与 Claude Code 不同的取舍，且明确标注了「别往回改」** 🔬：
> CC 注入**全严重度 + 排序**，sid-code 只注入含 Error/Warning 的文件。
>
> 记忆里那句话很直接：「sid-code 严重度过滤本就比 CC 更省 token，**勿往回改**」。
>
> 面试里这是个好例子：**「对齐标杆」不是目标，标杆也会做得比你差。**
> 判据是「这个差异服务哪个目标」——这里服务的是「更省」，代价是可能漏掉纯 Hint 文件里的
> 真问题，而那个代价被判定为可接受（纯 Hint 里几乎没有必须立刻修的东西）。

### 7.3 门控二：两层去重

这是四道门里最关键的一道。没有它，同一个错误会**每轮刷一遍**，
而模型对重复信息的反应是**开始无视它**——比不注入更糟。

🔬 两层，各治一个问题：

| 层 | 治什么 | 实现 |
| --- | --- | --- |
| **批内去重** | 同一批里的重复（多个服务器对同一文件表态，或同一服务器重推） | 按 uri 合并，诊断按内容 key 去重 |
| **跨轮次去重** | **同一条诊断在不同轮次重复投递** | `delivered: Map<uri, Set<key>>` LRU 缓存 |

去重的 key 是**内容级**的，不是位置级 🔬：

```ts
private diagnosticKey(diag: Diagnostic): string {
  return JSON.stringify({
    message: diag.message,
    severity: diag.severity,
    range: diag.range,
    source: diag.source ?? null,
    code: diag.code ?? null,
  });
}
```

**五个字段全参与**。这个选择有讲究：

- 只用 `message` → 同一个错误在两个位置会被误合并成一条
- 只用 `range` → 同一行的两个不同错误会被误合并
- 全字段 → 精确，代价是「同一个错误移动了一行」会被当成新诊断（可接受）

`delivered` 有 LRU 上限 🔬 `MAX_DELIVERED_FILES = 500`——
长会话里碰过的文件会越来越多，没有上限就是内存泄漏。

**跨轮次去重与文件编辑的交互**是 §4.4 讲的那个 bug：编辑后必须 `clearForFile`，
否则重推的诊断会被误过滤，模型永远看不到自己没修好的错误。

### 7.4 门控三：体积限流

🔬 三个常量，都对标 Claude Code：

```ts
const MAX_DIAGNOSTICS_PER_FILE = 10;   // 单文件最多 10 条
const MAX_TOTAL_DIAGNOSTICS = 30;      // 总共最多 30 条
const MAX_DELIVERED_FILES = 500;       // LRU 上限
```

限流前**先按严重度排序** 🔬，这一步是限流有意义的前提：

```ts
const SEVERITY_ORDER = { Error: 0, Warning: 1, Info: 2, Hint: 3 };
const sorted = [...file.diagnostics].sort((a,b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
const limited = sorted.slice(0, Math.min(MAX_DIAGNOSTICS_PER_FILE, remaining));
```

> ⚠️ **顺序不能颠倒：必须先排序再截断。**
> 先截断再排序 = 「随便挑 10 条然后把它们排好序」——
> 一个文件有 3 个 Error 和 50 个 Hint 时，**你可能一个 Error 都没留下**，
> 而输出看起来完全正常（10 条整整齐齐按严重度排列的 Hint）。
>
> 这是本文反复出现的那类失效：**输出形态正确，内容是错的。**

`remaining` 那个写法也值得注意：`MAX_TOTAL_DIAGNOSTICS - totalCount`
让单文件上限和总上限**同时生效**，而不是各管一段。
一个文件占满 30 条之后，后面的文件一条都进不来——这是对的，
因为「第一个文件的 Error」比「第四个文件的 Warning」更可能是模型刚搞坏的东西。

### 7.5 门控四：能力门控（这一道最容易漏想到）

前三道都是「过滤诊断」，第四道过滤的是**接收方**：

> **只在 agent 具备 `edit` / `write` 工具时才注入诊断。**

🔬 实现（`query/loop.ts`）：

```ts
const hasEditCapability = !!(toolRegistry.get("edit") || toolRegistry.get("write"));
const diagnosticText = hasEditCapability ? collectDiagnosticText() : null;
```

理由一句话说清：**诊断是给「能改代码的 agent」看的。**

一个纯只读的探索子代理（explore / summarize）收到「这个文件有类型错误」能干什么？
它不能改。这段文本对它是**纯噪音**，而且会诱导它做无意义的行为
（比如报告一个与它任务无关的错误，或者试图调用它没有的工具）。

🔬 注释里点出这比 CC 更贴合本意：

```text
能力对齐门控：仅当具备 edit/write 工具时才注入诊断——诊断是给"能改代码的 agent"看的。
这比 CC 的"有 Bash 才注入"更贴合本意（本项目靠 edit/write 修诊断、不依赖 bash）；
纯只读会话不会被诊断噪音打扰。
```

CC 的判据是「有 Bash」，理由是「能跑命令就能修」。这个推理在 CC 的语境里成立，
但在 sid-code 里**修诊断靠 edit/write，不靠 bash**——所以照抄 CC 的判据会得到
「有 bash 但没 edit 的 agent 收到了它修不了的诊断」。

> 🔑 **这是「照抄标杆」的一个典型失败形态，值得记住它的形状**：
> **判据抄对了字面，抄错了语义。**
>
> CC 写「有 Bash」，真实意图是「有修复能力」。你的项目里修复能力的载体不是 bash，
> 照抄字面就抄错了。
>
> 判据：**抄一个条件判断时，先把它翻译成「它真正想表达什么」，
> 再问「在我的系统里，表达这件事的是哪个东西」。**

### 7.6 两个注入点的差异：主循环 vs 子代理

🔬 同一个 `collectDiagnosticText`，两处调用，形态刻意不同：

| | 主循环（`query/loop.ts`） | 子代理（`agent/agentic-loop.ts`） |
| --- | --- | --- |
| 调用形态 | `collectDiagnosticText()` 无参 | `collectDiagnosticText(editedFiles)` 传作用域 |
| 消费范围 | **全部** pending，收完清空 | **只有这个子代理编辑过的文件** |
| 注入通道 | `reminderParts` → system-reminder | `ctxMgr.addMessage({role:"user"})` |
| 为什么这样 | 主循环是唯一的，可以全量消费 | **并发子代理会互相偷诊断**，必须隔离 |

第二行那个「互相偷」是一个真实的并发 bug，🔬 注释里写得很清楚：

```text
作用域参数修复"全局单例 collect 串味"：registry 是进程级单例，主循环与并发子代理共用同一
实例。旧的无差别 collectDiagnostics() 谁先调用谁就把所有人的 pending 捞走并清空，
另一方永远看不到自己编辑引入的诊断。
```

**成因是「消费即清空」+「全局单例」+「多个消费者」三者相乘。**
任意去掉一个都不会出这个 bug，所以它在单消费者时代完全不存在，
加了并发子代理之后才浮现——而且**浮现形态是「诊断偶尔不出现」**，
在概率上很像 flaky。

作用域版的清空逻辑也要相应改 🔬：

```ts
if (scope) {
  this.clearPendingForUris(scope);   // 只清作用域内的，其它人的留着
} else {
  this.pending.clear();              // 主循环行为不变
}
```

还有一个防御细节值得学 🔬：

```ts
// 显式传了作用域但没有一个合法 URI → 不误退化为全量消费，直接返回 null。
if (scopeUris.length === 0) return null;
```

**「传了作用域但全部非法」不能退化成「没传作用域」**——那会让一个本该隔离的消费者
突然变成全量消费者，把别人的诊断偷光。这是「空集合的两种含义」问题：
`undefined`（不限制）和 `[]`（限制为空）在语义上完全相反，代码里必须区分。

### 7.7 一个注入文案的坑：别用 markdown 标题开头

🔬 主循环的注入文案里有一段注释，记录了一次真实事故：

```text
显式带围栏（P0-a）：injectReminders 有兜底包裹，但这里自己带上让意图显式化。
尤其重要的是别再用 `#` markdown 标题开头——原文案 `# LSP 诊断…` 与用户
prompt 的 `# Commit:` 形态完全混同，是 2026-07-29 那次"模型分不清谁在说话"
的三处裸注入之一。
```

**成因**：`# LSP 诊断（来自语言服务器的实时反馈）` 这行开头，
在模型看到的纯文本里和用户自己写的 `# Commit: xxx` 长得一模一样。
模型分不清哪段是用户说的、哪段是系统注入的。

**修法**：用 `<system-reminder>` 围栏 + 明说「非用户输入」：

```text
<system-reminder>
LSP 诊断（来自语言服务器的实时反馈，非用户输入）：
...
</system-reminder>
```

⚠️ 有意思的是 🔬 **子代理那一处至今仍在用 `# LSP 诊断（...）` 的形态**
（`agent/agentic-loop.ts`）——它走的是 `ctxMgr.addMessage` 而非 reminder 通道，
没有围栏兜底。这是一处**尚未收敛的不一致**，属于「主路径修了、子代理路径没修」的
同一类债（§4.5）。

> 🔑 **通用教训**：**注入进上下文的任何文本，都要在形态上与用户输入可区分。**
> 这不是洁癖——模型的全部输入就是一段文本流，你不标记，它就只能猜。
> 而它猜错的形态是「把系统提示当成用户要求」或反过来，两者都很难查。

### 7.8 本章自检

- 诊断链路六站，哪一站做四道门控？
- 严重度过滤是「文件级」还是「诊断级」？这个区别的可观测后果是什么？
- 去重的 key 用了几个字段？只用 message 会怎样？
- 为什么必须「先排序再截断」？颠倒了的失效形态是什么？
- 能力门控为什么不照抄 CC 的「有 Bash」？
- 「并发子代理互相偷诊断」的三个必要条件是什么？
- 为什么注入文案不能用 `#` 开头？

---

## §8 多服务器编排：十种语言，十个进程

前面七章讲的都是「一个客户端对一个服务器」。真实情况是**十个**。
这一章讲怎么管，以及为什么这一层的设计决定了「加一门语言」的成本。

### 8.1 核心事实：一门语言 = 一个独立进程

这件事有一个物理后果，值得先说清，因为它常被问：

> **为什么不把 language server 打进二进制？**

🔬 sid-code 的代码注释里给了完整回答：

```text
LSP 服务器是独立进程（Node/Python/Go/Rust 各异构运行时），无法打进单二进制，
故"全内置二进制"物理上不可行。业界（VSCode/Neovim/Zed）均走"按需获取 + 自动配置"。
```

拆开看就明白了：`typescript-language-server` 要 Node，`pyright` 要 Node，
`gopls` 是 Go 二进制，`rust-analyzer` 是 Rust 二进制。把它们全塞进一个文件，
等于把四个语言运行时打包在一起——几百 MB，且每个都要跟着更新。

所以业界一致的分工是：

| 谁负责 | 什么 |
| --- | --- |
| 用户 / 包管理器 | **获取** language server（`npm i -g`、`go install`、`rustup component add`） |
| 客户端（sid-code） | **自动配置**——装了就自动认出来，没装就给精准安装命令 |

### 8.2 内置目录：一个数组，就是「加一门语言」的全部成本

🔬 `lsp/builtin-servers.ts` 是一个数组，10 条，每条长这样：

```ts
{
  name: "go",
  command: "gopls",
  args: [],
  extensionToLanguage: { ".go": "go" },
  installHint: "Go 需 gopls，安装：go install golang.org/x/tools/gopls@latest",
}
```

四个字段各有职责：

| 字段 | 用途 |
| --- | --- |
| `name` | 路由键 + 日志名 + **`lsp.json` 里覆盖它的 key** |
| `command` | PATH 探测的目标 + spawn 的命令 |
| `args` | 多数是 `["--stdio"]`，但 gopls 和 rust-analyzer **不需要**（默认就走 stdio）；bash 是 `["start"]` |
| `extensionToLanguage` | 建路由表 + 决定 didOpen 时传的 `languageId` |
| `installHint` | 未安装时给用户的**可直接复制执行的命令** |

🔬 注释里把「唯一事实源」这件事写死了：

```text
这是唯一登记内置语言的地方：config.ts 据此自动注册可用服务器，lsp.ts 据此
生成缺失引导。新增语言只需在此追加一条 —— 防止路由表 / 引导文案多处漂移。
```

> 🔑 **这是「唯一事实源 + 派生」范式的一个干净例子。**
> 同一份数据派生出三样东西：**运行时路由表、PATH 探测清单、错误提示文案**。
>
> 反面形态是三处各写一份：加一门语言要改三个地方，漏改一处就得到
> 「路由表里有 Ruby，但报错提示说不支持 Ruby」这种自相矛盾的输出。
> 而这种漂移**不会报错**，只会让用户困惑。

十种内置语言 🔬：TypeScript/JavaScript、Vue、Python、Go、Rust、JSON、YAML、HTML、CSS、Shell。

收录原则也写在注释里，值得一读——它是一条**克制**的判据：

```text
只收录"主流、单一权威 language server、社区活跃"的语言，避免为长尾语言
塞入低质量或多方案并存的配置（那类交给用户自行写 lsp.json 覆盖）。
```

「单一权威」这个条件是关键：Python 有 pyright / pylsp / jedi 三家，
sid-code 选了 pyright 并**承认这是个选择**，用户可以用 `"python"` 这个 key 覆盖掉。
如果一门语言没有明显的首选实现，内置它就是替用户做了个可能错的决定。

### 8.3 零配置怎么实现：并行 PATH 探测

🔬 `lsp/config.ts` 的启动流程：

```ts
// 并行探测各 language server 是否在 PATH 中，可用即自动注册
const availability = await Promise.all(
  BUILTIN_LSP_SERVERS.map((s) => isCommandAvailable(s.command)),
);
BUILTIN_LSP_SERVERS.forEach((server, i) => {
  if (!availability[i]) return;      // 没装，跳过
  configs[server.name] = { name, command, args, workspaceFolder, extensionToLanguage, ... };
});
```

`isCommandAvailable` 就是 `which`（Windows 上 `where`），带 5s 超时：

```ts
const which = process.platform === "win32" ? "where" : "which";
execSync(`${which} ${cmd}`, { stdio: "pipe", timeout: 5000 });
```

**`Promise.all` 那个并行不是优化，是必要的** 🔬 注释点明：

```text
探测并行执行，避免逐个 which 串行拖慢启动。
```

10 个 `execSync` 串行，每个几十毫秒，加起来是几百毫秒的冷启动成本。
并行之后是单个 `which` 的耗时。

⚠️ 这里有一个**用户可见的后果**，官网文档专门写了 🔬：

```text
注意最后一句：要重启。language server 是启动时探测 PATH 注册的，装完不重启不生效。
```

这是「启动时探测」这个设计的必然代价。替代方案是每次工具调用都探测一次（太慢）
或者监听 PATH 变化（不可靠）。**接受这个代价并明确告知用户**，比假装它不存在好。

### 8.4 三级配置：内置 → 全局 → 项目

🔬 合并顺序（后覆盖前）：

```text
① 内置目录（builtin-servers.ts）—— command 在 PATH 里就自动注册
② 全局 ~/.sid-code/lsp.json
③ 项目 <workspace>/.sid-code/lsp.json      ← 优先级最高
```

覆盖的粒度是**按 name 整条替换**，不是字段级合并 🔬：

```ts
configs[name] = {
  name, workspaceFolder, startupTimeout: 30000, maxRestarts: 3,
  ...partial,          // 用户写的字段覆盖默认值
};
```

所以想把 Python 从 pyright 换成 pylsp，就用 `"python"` 这个 key 写自己的配置：

```json
{
  "python": {
    "command": "pylsp",
    "extensionToLanguage": { ".py": "python" }
  }
}
```

两个字段必填 🔬，缺了跳过并**警告**（不是静默跳过）：

```ts
if (!partial.command || !partial.extensionToLanguage) {
  log.warn("LSP", `${filePath} 中的 ${name} 缺少 command 或 extensionToLanguage，已跳过`);
  continue;
}
```

⚠️ 注意 JSON 解析失败的处理 🔬：整个文件的配置全丢，只留一条 error 日志：

```ts
} catch (err) {
  log.error("LSP", `解析 ${filePath} 失败: ${err.message}`);
}
```

这是「best-effort 降级」的正确形态——**一个写坏的 `lsp.json` 不该让 CLI 起不来**。
但它也意味着**用户写错 JSON 时唯一的线索在 debug 日志里**。这是个真实的取舍：
更好的做法是在 TUI 上给一次可见提示，属于未收敛的改进点。

### 8.5 路由：扩展名 → 服务器

🔬 `lsp/server-manager.ts` 的路由表就是一个 Map：

```ts
private extensionRoutes = new Map<string, string>();   // ".ts" → "typescript"

for (const ext of Object.keys(config.extensionToLanguage)) {
  this.extensionRoutes.set(ext, name);
}
```

查的时候：

```ts
getServerForFile(filePath: string): LSPServerInstance | undefined {
  const ext = extname(filePath);
  const serverName = this.extensionRoutes.get(ext);
  return serverName ? this.servers.get(serverName) : undefined;
}
```

**冲突策略是「后注册覆盖」**——因为循环里直接 `set`。
配合三级配置的顺序（内置 → 全局 → 项目），这个语义是对的：
项目配置里声明 `.py` 的服务器会覆盖内置的。

但**反向索引**用的是相反的策略 🔬（`builtin-servers.ts`）：

```ts
export const EXTENSION_TO_BUILTIN: ReadonlyMap<string, BuiltinLSPServer> = (() => {
  const map = new Map();
  for (const server of BUILTIN_LSP_SERVERS) {
    for (const ext of Object.keys(server.extensionToLanguage)) {
      if (!map.has(ext)) map.set(ext, server);      // ← 先到先得
    }
  }
  return map;
})();
```

「先到先得」而不是「后覆盖」。这个反向索引的用途是**路由未命中时反查安装引导**，
注释说明得很清楚：

```text
供 lsp.ts 在"路由未命中"时反查：即便该 language server 未安装（未注册进运行时
路由表），也能凭扩展名认出"这是 Vue/Python 文件"，给出精准安装引导，而非笼统的
"未知文件类型"。
```

> 💡 **这两个 Map 的存在体现了一个容易被忽略的设计要求**：
> **「没装」和「不支持」是两件完全不同的事，错误信息必须能区分。**
>
> 只有运行时路由表的话，`.vue` 文件在没装 Volar 时和 `.rb` 文件是同一个结果：
> 「没有对应服务器」。而用户需要的是两条完全不同的下一步：
> 前者「跑这条 npm 命令」，后者「自己写 lsp.json」。

🔬 `describeMissingServer` 就是干这个的，两条分支：

```text
情形 1（内置支持但未安装，如 .vue）：
  未找到处理 .css 文件的 LSP 服务器：/tmp/lspdemo/y.css
  原因：css language server 未安装或不在 PATH 中。
  CSS 需 vscode-css-language-server，安装：npm i -g vscode-langservers-extracted
  安装后重启 sid-code 即自动生效（无需手动配置）。

情形 2（长尾语言，如 .rb）：
  没有为 .rb 文件类型配置 LSP 服务器：/tmp/lspdemo/x.rb
  内置语言目录未覆盖此类型。可在全局配置 ~/.sid-code/lsp.json 或项目 .sid-code/lsp.json
  中添加，格式：
    { "<名称>": { "command": "<language-server 命令>", "args": ["--stdio"],
      "extensionToLanguage": { ".rb": "<语言ID>" } } }
```

**两条都给出了可直接执行的下一步。** 这是错误信息的黄金标准：
不是「说清发生了什么」，而是「说清用户该做什么」。

### 8.6 懒启动：为什么十个服务器不能一起起

🔬 `initialize()` 只建路由表，**不启动任何进程**：

```ts
async initialize(configs): Promise<void> {
  for (const [name, config] of Object.entries(configs)) {
    const instance = new LSPServerInstance(config);    // 只是 new，没 spawn
    this.servers.set(name, instance);
    for (const ext of Object.keys(config.extensionToLanguage)) {
      this.extensionRoutes.set(ext, name);
    }
  }
}
```

真正的 spawn 发生在第一次用到时 🔬（`server-instance.ts`）：

```ts
async ensureStarted(): Promise<void> {
  if (this._state === "running") return;
  if (this.startPromise) return this.startPromise;      // ← 关键：并发去重
  this.startPromise = this.start().finally(() => { this.startPromise = null; });
  return this.startPromise;
}
```

`startPromise` 那行是**并发安全**的核心。没有它的话：

```text
两个并发工具调用同时命中同一个未启动的服务器
    → 都看到 state !== "running"
    → 都调 start()
    → spawn 两个进程，其中一个成为孤儿
```

用「进行中的 Promise」做去重，是这类「幂等启动」的标准写法。
第二个调用者拿到的是同一个 Promise，等同一次启动。

**懒启动省了多少**？粗算：一个语言服务器冷启动 + 索引小工程 = 1–3 秒，
大工程上 rust-analyzer 可以到几十秒。十个全起 = 冷启动直接不可用。
而实际一次任务通常只碰 1–2 种语言。

### 8.7 崩溃恢复：有上限的自动重启

语言服务器会崩。rust-analyzer 在大 workspace 上 OOM、tsserver 在
循环类型上栈溢出，都是真实存在的。

🔬 恢复逻辑（`server-instance.ts`）：

```ts
private handleCrash(): void {
  const maxRestarts = this.config.maxRestarts ?? 3;
  if (this.crashRecoveryCount >= maxRestarts) {
    log.error("LSP", `[${this.name}] 崩溃次数超过上限 (${maxRestarts})，停止重启`);
    this._state = "error";
    return;
  }
  this.crashRecoveryCount++;
  this._state = "stopped";
  this.client = new LSPClient(this.name);          // ← 重建 client，不复用
  this.client.onCrash = () => this.handleCrash();
  void this.start().catch(...);
}
```

三个细节：

| 细节 | 为什么 |
| --- | --- |
| **有上限**（默认 3） | 无上限 = 崩溃循环，把 CPU 烧光且日志刷屏 |
| **重建 `LSPClient` 而非复用** | 旧 client 的 buffer 里可能有半条消息、pendingRequests 里有僵尸条目 |
| 计数**只增不减** | 没有「运行一段时间后重置计数」。刻意的：一个反复崩的服务器，第 4 次崩了就该放弃 |

上限耗尽后进 `error` 态，不再自动恢复。🔬 这个状态是**对用户可见**的：

```ts
get restartsExhausted(): boolean {
  return this.crashRecoveryCount >= (this.config.maxRestarts ?? 3) && this._state === "error";
}
```

### 8.8 健康可观测性：让「静默降级」变成「可见告警」

这一节讲的是一个**非常容易被跳过、但跳过就等于白做**的环节。

LSP 的所有失败都是 best-effort 静默降级的：服务器起不来 → 不报错，
崩溃超限 → 不报错，配置解析失败 → 只有 debug 日志。

**这是对的**（LSP 挂了不该让 agent 停工），但它有一个代价：
**用户不知道自己在用一个残废的 LSP。** 他只会觉得「这个工具好像不太准」。

🔬 解法是一个健康快照 + 一次性告警（`lsp/manager.ts`）：

```ts
export function getLSPHealthWarning(): string | null {
  const health = getLSPHealth();
  if (health.initState === "failed") {
    return "LSP 系统初始化失败，代码智能功能不可用（可用 LSP 工具时也会降级）。";
  }
  const broken = health.servers.filter((s) => s.restartsExhausted || s.state === "error");
  if (broken.length > 0) {
    const detail = broken.map((s) =>
      `${s.name}（崩溃 ${s.crashCount} 次${s.restartsExhausted ? "，已停止重启" : ""}）`).join("、");
    return `LSP 服务器异常：${detail}。相关语言的代码智能功能可能不可用。`;
  }
  return null;      // ← 正常时返回 null，不打扰用户
}
```

消费侧 🔬（`query/loop.ts`），三个设计点都值得学：

```ts
if (!state.lspHealthWarned) {              // ① 一次性
  const lspWarning = getLSPHealthWarning();
  if (lspWarning) {
    state.lspHealthWarned = true;
    yield { kind: "system", level: "warning", text: lspWarning };   // ② 用户可见，不进 LLM 上下文
  }
}
```

| 设计点 | 为什么 |
| --- | --- |
| ① **每轮检查，但只告警一次** | LSP 是后台异步初始化的，首轮可能还 pending。所以要每轮查（直到出结果），但只说一次（否则每轮刷屏） |
| ② **`kind: "system"`——用户可见，不进模型上下文** | 「你的 gopls 崩了」是给人看的运维信息。塞进模型上下文纯属浪费 token，且模型对此无能为力 |
| ③ **正常时返回 `null`** | 「静默即健康」。没有「LSP 一切正常 ✅」这种噪音 |

> 🔑 **这一节对应一条通用铁律，它在这个仓库里有过真实教训**：
> **新增防线时的验收判据不是「代码写了 + 测试过了」，而是「真实会话里被触发过」。**
>
> 一个「健康告警」如果从来没触发过，你无法区分两种情况：
> 「一切健康」还是「告警本身坏了」。这两者在观测上完全一样——
> 都是什么都不显示。
>
> 所以这类防线要配一个**变异自证**：故意把 command 改成不存在的名字，
> 确认告警真的出现。不做这一步，你得到的是一个「防线全在、调用全 0」的死代码，
> 而它在代码审查里看起来完全正常。

### 8.9 一个容易忽略的层：单例与代数计数器

🔬 `lsp/manager.ts` 用模块级变量做单例，且带一个**代数计数器**：

```ts
let instance: LSPServerManager | undefined;
let initState: InitState = "not-started";
let initGeneration = 0;                   // ← 代数计数器

export function initializeLSP(workspaceFolder: string): void {
  // ...
  const currentGen = ++initGeneration;
  void loadLSPConfigs(workspaceFolder)
    .then(async (configs) => {
      if (currentGen !== initGeneration) return;    // ← 过期的初始化，直接丢弃
      // ...
      initState = "success";
    })
    .catch((err) => {
      if (currentGen !== initGeneration) return;    // ← 同样检查
      initState = "failed";
    });
}
```

**代数计数器解决的问题**：初始化是异步的（要并行 `which` 10 个命令）。
如果这期间有人调了 `reinitializeLSP`（插件刷新时会），就有两个在途的初始化 Promise。
没有代数检查的话：

```text
第一次初始化开始（gen=1，慢，还在探测 PATH）
    → reinitializeLSP → 第二次初始化开始（gen=2，快，成功了，initState="success"）
    → 第一次初始化终于失败了 → 它把 initState 改成 "failed"
    → 【一个已经成功的 LSP 系统被一个过期的失败回调标记为失败】
```

`shutdownLSP` 和 `reinitializeLSP` 也都递增代数 🔬——**关闭时让在途初始化失效**，
否则关完之后一个迟到的 Promise 会把 `instance` 重新设起来。

> 💡 **「代数计数器」是异步初始化的标准解法**，值得记住这个名字和形状：
> 每次启动一轮异步流程时递增一个全局计数器并记下当前值，
> 回调里先比对——不等就说明自己已经过期，什么都不做。
>
> 它比「加锁」轻，比「取消 Promise」现实（JS 里 Promise 不可取消）。

### 8.10 本章自检

- 为什么 language server 不能打进单二进制？客户端负责哪一半？
- 内置目录这个数组派生出了哪三样东西？分开写会出什么漂移？
- PATH 探测为什么必须并行？它带来了什么用户可见的代价？
- 运行时路由表和反向索引的冲突策略为什么相反？
- `ensureStarted` 里那个 `startPromise` 防的是什么？
- 崩溃计数为什么只增不减？
- 健康告警为什么用 `kind: "system"` 而不是注入模型上下文？
- 代数计数器解决什么问题？举一个没有它会出错的时序。

---

## §9 ★ 会静默出错的形状与坐标

这一章和 §12 是本文最值钱的两章。区别在于：
**§12 讲的是工程陷阱**（埋点、判据、调研方法），**这一章讲的是协议本身的陷阱**。

这一章所有条目有一个共同点：**它们不抛异常。**
它们的失效形态是「空结果」「差一行」「少一层」——
而这三样东西，都和「正确答案恰好是这个」长得一模一样。

### 9.1 形状陷阱一：Location 还是 LocationLink

📐 `textDocument/definition` 的返回类型，规范原文是：

> `Location | Location[] | LocationLink[] | null`

**四种。** 而它们的字段名不一样：

| 形状 | 字段 |
| --- | --- |
| `Location` | `{ uri, range }` |
| `LocationLink` | `{ targetUri, targetRange, targetSelectionRange?, originSelectionRange? }` |

**决定服务器给你哪种的，是你自己的 capabilities** 🔬（§3.3）：

```ts
definition: { linkSupport: true },      // ← 声明了这个，服务器就可能回 LocationLink
implementation: { linkSupport: true },
```

于是有一个非常经典的自伤形态：

```text
你声明 linkSupport: true（因为 LocationLink 信息更丰富，看起来更好）
    → 服务器改回 LocationLink
    → 你的解析代码只认 item.uri
    → item.uri 是 undefined
    → 结果恒为空数组
    → 用户看到「未找到定义」
    → 你以为是 language server 不行
```

🔬 正确的归一化（`tool/lsp-formatters.ts`）：

```ts
export function normalizeLocations(result: unknown) {
  if (!result) return [];
  const arr = Array.isArray(result) ? result : [result];    // ① 单个也要能接
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    if ("uri" in item && "range" in item) {                // ② Location
      const loc = item as LSPLocation;
      out.push({ uri: loc.uri, line: loc.range.start.line, character: loc.range.start.character });
    } else if ("targetUri" in item) {                      // ③ LocationLink
      const link = item as LSPLocationLink;
      const range = link.targetSelectionRange ?? link.targetRange;   // ④ 优先精确范围
      out.push({ uri: link.targetUri, line: range.start.line, character: range.start.character });
    }
  }
  return out;
}
```

四个点各防一个形态：

| 点 | 防什么 |
| --- | --- |
| ① `Array.isArray(result) ? result : [result]` | 规范允许返回**单个** `Location` 而非数组。只写 `result.map()` 会崩或返回空 |
| ② 用 `"uri" in item` 判别，不用 `item.uri !== undefined` | 更贴近「这是哪种形状」的语义 |
| ③ 显式处理 `targetUri` 分支 | 漏了它就是上面那个「恒为空」 |
| ④ `targetSelectionRange ?? targetRange` | 前者是**符号名本身**的范围，后者是**整个定义体**的范围。想要「跳到函数名」就得优先前者 |

第④点值得展开，因为它是「结果不错但不好」的典型：

```ts
export function add(a: number, b: number): number {   // targetSelectionRange → "add" 三个字
  return a + b;                                       // targetRange → 整个函数（1:1 到 3:1）
}
```

用 `targetRange` 你会指向第 1 行第 1 列（`export` 那个 e），用
`targetSelectionRange` 指向第 1 行第 17 列（`add` 的 a）。
**两个都"对"，但只有后者是用户想跳到的地方。**

### 9.2 形状陷阱二：DocumentSymbol 还是 SymbolInformation

同一个问题的第二个实例，📐 `textDocument/documentSymbol` 返回：

> `DocumentSymbol[] | SymbolInformation[] | null`

| 形状 | 结构 | 层级信息在哪 |
| --- | --- | --- |
| `DocumentSymbol` | `{ name, kind, range, selectionRange, children? }` | **`children` 数组，真树** |
| `SymbolInformation` | `{ name, kind, location, containerName? }` | **`containerName` 字符串**，扁平 |

同样由 capabilities 决定 🔬：`documentSymbol: { hierarchicalDocumentSymbolSupport: true }`。

🔬 判别方式：

```ts
function isDocumentSymbolArray(arr: unknown[]): arr is LSPDocumentSymbol[] {
  return arr.length > 0 && !!arr[0] && "range" in arr[0] && !("location" in arr[0]);
}
```

**两个条件都要**：`DocumentSymbol` 有 `range` 没 `location`，`SymbolInformation` 反过来。
只判一个的话，某些服务器返回的混合形态（两个字段都有）会判错。

⚠️ 注意 `arr.length > 0` 这个前置条件：**空数组两种形状无法区分**。
所以调用侧必须先处理空数组，不能指望判别函数。

### 9.3 坐标陷阱：0-based 还是 1-based（LSP 头号新手坑）

这个坑简单到可笑，但它是最常犯的。

| 谁 | 行/列起点 |
| --- | --- |
| **LSP 协议** 📐 | **0-based**。第一行是 `line: 0` |
| **人、编辑器、编译器报错、`file:line:col` 惯例** | **1-based**。第一行是第 1 行 |

所以一个 agent 的 LSP 工具**至少要转换两次**：

```text
模型输入 line: 6        （1-based，因为模型是从 read 工具的输出里读到行号的，那是 1-based）
    ↓  −1
LSP 请求 line: 5        （0-based）
    ↓  ...服务器算完...
LSP 响应 line: 0        （0-based）
    ↓  +1
输出给模型 "calc.ts:1:17"  （1-based）
```

🔬 sid-code 的两处转换：

```ts
// 入：1-based → 0-based（tool/lsp.ts dispatch）
const position = params.line != null && params.character != null
  ? { line: params.line - 1, character: params.character - 1 }
  : undefined;

// 出：0-based → 1-based（tool/lsp-formatters.ts）
function fmtPos(line: number, character: number): string {
  return `${line + 1}:${character + 1}`;
}
```

**为什么工具接口选 1-based 而不是直接暴露 0-based**？🔬 工具描述里写了：

```text
- 行号/列号均为 1-based（与编辑器显示一致）
```

理由是对的：**模型看到的行号来自 `read` 工具的输出，那是 1-based 的**
（`cat -n` 形态）。如果 LSP 工具要 0-based，模型每次都得自己减一——
而它会忘，而且忘了之后**没有任何报错，只是差一行**。

> ⚠️ **差一行的失效形态是本章最阴的一个，因为它经常「碰巧还是对的」。**
>
> 你查 `add` 函数第 1 行第 17 列，忘了减一，实际查了第 2 行第 18 列。
> 那里是 `  return a + b;` 的某个位置——
> 可能返回空（看起来像「这个符号没有定义」），
> 也可能返回 `b` 这个参数的定义（看起来完全合理，但答错了问题）。
>
> **没有任何一层会告诉你坐标错了。** 这就是为什么这个转换必须收在**一个地方**，
> 且必须有测试。散在各个 case 分支里，第 11 个操作加进来时必然漏一处。

一条实用的自检：**如果你的 LSP 查询「偶尔返回空、偶尔返回奇怪的东西」，先怀疑坐标。**
比怀疑 language server 的概率高得多。

### 9.4 一个协议之外的坐标问题：character 是什么单位

这个更细，但在中文代码库里会真实咬人。

📐 规范里 `character` 的单位默认是 **UTF-16 code unit**，不是字符、不是字节。

```ts
const 中文变量 = 1;   // "中文变量" 四个汉字 = 4 个 UTF-16 code unit（BMP 内）
const emoji = "🎉";   // 🎉 是 1 个字符，但 2 个 UTF-16 code unit（代理对）
```

后果：一行里有 emoji 时，「第 10 个字符」和「第 10 个 code unit」不是同一个位置。

📐 LSP 3.17 允许客户端声明 `positionEncoding` 来改成 UTF-8 或 UTF-32，
但 🔬 sid-code **没有声明**（用默认的 UTF-16）。

JS/TS 的字符串本来就是 UTF-16 的，所以在 sid-code 里这一层恰好天然对齐——
`"abc🎉d".length === 6`，正好是 code unit 数。**这是语言选择带来的运气，不是设计。**

⚠️ 如果你用 Python / Go / Rust 写 LSP 客户端，这里必须显式处理：
Python 的 `len()` 是码点数、Go 的 `len()` 是字节数、Rust 的 `.len()` 是字节数，
**三个都不是 UTF-16 code unit**。

### 9.5 空结果的三种成因，长得一模一样

这是本章的核心洞察。一个 LSP 查询返回空，可能是：

| 成因 | 该怎么办 | 长什么样 |
| --- | --- | --- |
| **① 真的没有**（这个符号确实没被引用） | 接受这个答案 | `[]` |
| **② 文件没 didOpen**（服务器没这文件的 AST） | 先 open | `[]` |
| **③ 坐标错了**（差一行，光标不在符号上） | 修坐标 | `[]` |
| **④ 形状没解析对**（返回了 LocationLink 你只认 Location） | 修解析 | `[]` |
| **⑤ capabilities 没声明**（服务器不给这个能力） | 补声明 | `[]` 或 `null` |
| **⑥ 服务器还在索引**（大工程首次查询） | 等一下再查 | `[]` |

**六种成因，一种输出。**

这就是为什么 LSP 集成的排查特别难，也是为什么本章要单独存在。
一条可操作的排查顺序（按「便宜先查」排）：

```text
1. 坐标对吗？          ← 最常见，且最容易验证：换用 documentSymbol 拿到准确坐标再试
2. 文件 open 了吗？     ← 看 openFiles Map 里有没有它
3. 换个操作试试         ← hover 在同一位置有输出吗？有 → 坐标和 open 都没问题
4. 看原始响应           ← 是 [] 还是 null？是不是 LocationLink 形状？
5. capabilities 声明了吗？
6. 是不是刚启动？       ← 大工程等 10 秒再试
```

第 3 步（**换个操作交叉验证**）是最高效的一步，值得单独强调：
`hover` 是最不容易失败的操作（单文件、不需要索引、几乎所有服务器都支持）。
**同一坐标上 `hover` 有输出 = 坐标对、文件已 open、服务器活着。**
这一步能一次排除掉三个成因。

> 🔑 **通用方法**：一个能力有 N 种成因导致同一种输出时，
> **找一个「更简单但共享大部分前置条件」的能力做交叉验证。**
>
> 这个方法在 provider 层也一样用：一个模型调用失败，先用最简单的
> 「一句话不带工具」的请求试——通了就说明网络、鉴权、路由都没问题，
> 问题在你那些复杂参数里。

### 9.6 结果太多的对称问题：截断

空结果讲完了，讲反面：`findReferences` 在一个常用函数上可能返回**几千条**。

🔬 三层防护：

| 层 | 做法 | 常量 |
| --- | --- | --- |
| ① 过滤 `.gitignore` | `git check-ignore --stdin` 批量检查，剔掉 `node_modules` / `dist` 之类 | — |
| ② 截断 | 最多 50 条 location，超出附摘要 | `MAX_LOCATIONS = 50` |
| ③ URI → 相对路径 | 展示 `calc.ts:1:17` 而非 `file:///Users/.../calc.ts` | — |

第①层的实现有一堆生产细节 🔬（`tool/lsp.ts` 的 `filterGitignored`），
每一条都是踩出来的：

```ts
export async function filterGitignored(paths, cwd, signal?): Promise<Set<string>> {
  if (paths.length === 0) return ignored;
  if (signal?.aborted) return ignored;                    // ① 入口快速退出，不 spawn
  child = spawn("git", ["check-ignore", "--stdin"], { cwd, stdio: ["pipe","pipe","ignore"] });
  const onAbort = () => { if (!child.killed) child.kill(); };
  signal?.addEventListener("abort", onAbort, { once: true });   // ② abort 时 kill
  const STDOUT_CAP = 1_048_576;
  child.stdout.on("data", (c) => { if (stdout.length < STDOUT_CAP) stdout += c.toString(); });  // ③ 1MB 上限
  // ...
  await Promise.race([exitPromise, new Promise(r => setTimeout(() => { timedOut = true; r(); }, 5000))]);  // ④ 5s 超时
  if (timedOut && !child.killed) child.kill();
  // ...
  } catch {
    // git 不可用：不过滤                                   // ⑤ 降级：不过滤，而非报错
  } finally {
    if (child && !child.killed) { try { child.kill(); } catch {} }   // ⑥ 兜底防孤儿
  }
}
```

六个点，其中三个是**防孤儿进程**（②④⑥）——因为 `spawn` 一个子进程后
如果不管它，abort 或超时时它会一直挂着。这类泄漏在长会话里会累积成几百个僵尸 git 进程。

第⑤点是**降级方向的选择**：git 不可用时**不过滤**（返回全部），而不是报错。
这是对的——过滤是优化，不是正确性要求。为了一个优化失败而让整个查询失败是错的取舍。

第③点（1MB stdout 上限）防的是一个极端情况：
你传了几千条路径进去，git 全部判为 ignored 并回显——输出可能很大。

🔬 截断的输出形态是**诚实**的：

```text
（共 1247 处，仅显示前 50 处）
```

> 💡 **这一句很重要，别省。**
> 只给 50 条不说总数，模型会以为「一共就 50 处」，然后基于这个错误认知做决策
> （比如「只有 50 处引用，我可以全改一遍」）。
>
> **告诉它被截断了，它才能选择换策略**（比如改用 grep 统计、或者分模块处理）。
> 这是 §11.4 会再讲的一条：**给模型的信息里，「我给你的不全」本身就是重要信息。**

### 9.7 一个纯工程的保护：文件大小上限

🔬 `MAX_LSP_FILE_SIZE = 10 * 1024 * 1024`（10MB），执行前 `stat` 检查：

```ts
if (st.size > MAX_LSP_FILE_SIZE) {
  return { output: `文件过大 (${(st.size/1024/1024).toFixed(1)}MB)，超过 LSP 处理限制 (10MB)`, isError: true };
}
```

防的是：一个 50MB 的生成文件（打包产物、大 JSON、日志）被 didOpen 进去，
语言服务器试图解析它 → OOM 或卡死几分钟。

⚠️ 这里有一个**测试设计的教训**值得讲，🔬 它记录在评审结论里：

给这个检查写测试时，「无配置 = 无服务器 = 触发 size 检查」这个前提**是错的**：

```text
execute() 里 getServerForFile 未命中会先 return describeMissingServer，
根本走不到 size 检查。
```

也就是说：**路由检查在大小检查之前**。想测大小检查，必须先让路由命中。
而且不能依赖真实的 language server（PATH 里有没有 pyright 因机器而异 → flaky）。

正解是：项目级 `.sid-code/lsp.json` 注册一个 mock 服务器 + 自造扩展名 `.g10x`——
**无 builtin、无 PATH 依赖**，且因为懒启动，size 检查在 spawn 之前就跑了，完全确定性。

> 🔑 **这个教训的通用形态**：
> **写测试前先读代码确认执行顺序，别根据「功能应该怎样」推断。**
>
> 「无配置所以走到大小检查」是一个**听起来完全合理的推断**，
> 而它错了，因为代码里有一个更早的 return。
> 基于错误推断写的测试会「通过」——它测了一条你以为是 A 其实是 B 的路径。

### 9.8 附带一条：什么样的测试不值得写

同一份评审里还有一条裁决，🔬 值得放在这里作为对照：

给 capabilities 声明写测试**被判定为废测**：

```text
G7（capabilities）是废测（change-detector）：断言的就是 server-instance.ts 那个
写死的对象字面量本身，无逻辑可偏离，抓不到缺陷，还要污染共享 mock。已丢弃。
```

**「change-detector test」**（变更检测器测试）是个值得知道的术语：
它断言的是代码的**当前形态**而不是**行为**。
你改一行代码它就红，但它从来抓不到 bug——因为被断言的东西里没有逻辑。

判据很简单：**这段代码有可能「算错」吗？**
- `filterGitignored`：有（spawn、超时、abort、降级） → 值得测
- capabilities 对象字面量：没有（它就是一堆常量） → 不值得测

> 💡 顺带一条同源的裁决：**给「已落地可用的代码」补测最多是 P2/P3，不是 P0。**
> P0 是「线上会挂」。把补测标成 P0 会挤掉真正的 P0。

### 9.9 本章自检

- `textDocument/definition` 有几种返回形状？决定给你哪种的是什么？
- `targetSelectionRange` 和 `targetRange` 的区别？用错了会怎样（注意：不是报错）？
- 一个 LSP 查询返回空，列出至少四种成因。
- 排查空结果时，为什么 `hover` 是最高效的交叉验证手段？
- `character` 的单位是什么？在什么语言里写客户端要特别小心？
- 截断时为什么必须告诉模型总数？
- 「change-detector test」是什么？判断一段代码值不值得测的判据是什么？

---

## §10 codeAction：确定性修复，以及它的真实天花板

这一章讲第 10 个操作。它单独占一章，不是因为它最重要，
而是因为**它是最容易被过度设计的一个**——而那个过度设计的方案在这个仓库里被否决过两次。

面试里这一章的价值很高：**能讲清「为什么不做」的人，比能讲清「怎么做」的人少得多。**

### 10.1 它是什么：语言服务器已经算好了修复方案

📐 `textDocument/codeAction` 问的是：「这个位置能怎么改？」

返回的是一批 `CodeAction`，每条含：

```ts
{
  title: "Add missing import for 'fooBar'",
  kind: "quickfix",
  isPreferred: true,
  edit: {
    changes: {
      "file:///path/to/file.ts": [
        { range: {start:{line:0,character:0}, end:{line:0,character:0}},
          newText: "import { fooBar } from './utils';\n" }
      ]
    }
  }
}
```

**关键在于 `edit` 字段：它是精确的「改哪里 → 改成什么」。**
不是建议，不是提示——是可执行的坐标 + 替换文本。

`kind` 分几类 📐：

| kind | 含义 |
| --- | --- |
| `quickfix` | 修一条诊断（补 import、删未用变量、加缺失的 return） |
| `refactor` | 重构（提取函数、内联变量） |
| `source` | 整文件级操作 |
| `source.organizeImports` | 整理 import |
| `source.fixAll` | 修所有能自动修的 |

对 agent 有价值的主要是 `quickfix`——它对应「模型刚改坏的东西」。

**为什么这有价值**：常见错误的修复是**确定性的**。
「缺 import」的修法只有一种，语言服务器已经知道答案。
让模型自己推理「我该 import 什么、从哪 import、放在第几行」，
是在花 token 重新计算一个已知答案。

### 10.2 一个必须知道的天花板数字：只有约 10% 的诊断有 quickfix

📄 这个数字来自 Replit 的 Code Repair 工作（二手，但方向可信）：

> 训练专用模型修复诊断时发现，**仅约 10% 的诊断有 LSP codeAction fix**。

这个数字决定了 codeAction 的**性质**：它不是「诊断修复方案」，
它是「诊断修复方案里最机械的那一小块」。

剩下 90% 是什么？「类型不匹配」「逻辑写错了」「这个函数不该在这调用」——
**这些没有确定性修法，只能靠推理。**

> 🔑 **正确的定位（这句话面试值得直接用）**：
> **codeAction 覆盖的是「最高频、最机械」的那 10%，而不是「最重要」的那部分。**
> 它的价值是**把这 10% 的 token 成本降到接近零，让模型专注在需要智力的 90% 上**。
>
> 反过来说：**任何把 codeAction 当成「诊断修复主链路」的设计都建立在错误的前提上。**
> 90% 的情况它给不出答案，所以它只能是补充，不能是主路径。

### 10.3 sid-code 的实现：一个刻意很小的子集

🔬 落地的是一个 **pull 式只读**子集。三条边界，每条都是刻意的：

| 边界 | 做法 | 为什么 |
| --- | --- | --- |
| **pull，不 push** | 模型想修某个诊断时**主动查**，不在每轮注入 | 每轮注入 quickfix = 每轮常驻 token 成本 |
| **只读，不自动改** | 展示「改哪里 → 改成什么」，落地仍走 `edit` 工具 | 自动改文件会绕过权限门控 |
| **不承诺可直接 apply** | 如实摊开 range + newText 让模型自己读懂 | sid-code 的 `edit` 是 `old_string`/`new_string` 文本替换，与 LSP 的**坐标式** TextEdit 不同构 |

第三条值得展开，因为它是一个**真实的不同构问题**，不是偷懒：

```text
LSP TextEdit：  「把 3:0 到 3:12 这个范围替换成 'foo'」        ← 坐标式
sid-code edit： 「把文件里的 'const x = 1' 替换成 'const x = 2'」  ← 文本匹配式
```

**没有通用的转换方法**：坐标 → 文本需要读原文按坐标切片，
而切片结果可能不唯一（同一段文本在文件里出现多次，`old_string` 就不唯一了）。

所以 sid-code 的选择是**诚实**：把 range 和 newText 摊开，让模型自己看懂意图后用 edit 落地。
🔬 注释里说得很直白：

```text
关键设计（区别于原方案的失败卖点）：如实展示 edit 的坐标与替换文本，但不承诺"可直接用
edit 工具应用"。诚实地把 range + newText 摊开给模型看，让它读懂意图后自行用 edit 工具
落地——这比谎称"直接 apply"更可用、更不会误导。
```

🔬 实测输出形态：

```text
## 推荐修复（isPreferred，语言服务器标记为首选）
  - "Remove unused declaration for: 'bad'" [quickfix]
      删除 calc.ts:9:1–9:32

说明：以上为语言服务器计算的确定性修复方案。上方"影响范围 → 内容"即修复要做的改动，
用 edit 工具在对应位置落地即可（本工具只读展示、不自动改文件）。
```

几个格式化细节 🔬：

```ts
const MAX_CODE_ACTIONS = 10;          // preferred 全展示，其它最多 10 条
const NEWTEXT_PREVIEW_CAP = 200;      // 单条 newText 预览上限（码点）

// 判定编辑类型：range 起止相同 = 纯插入；newText 为空 = 纯删除；否则替换
const isInsert = startLine === endLine && startCh === endCh;
const isDelete = e.newText === "";
const verb = isDelete ? "删除" : isInsert ? "插入" : "替换";

// 预览 newText：截断 + 转义换行，避免多行内容破坏列表结构
let preview = e.newText.replace(/\n/g, "\\n");
```

「转义换行」那一步不起眼但必要：一个 import 语句的 `newText` 是
`"import { foo } from './x';\n"`，直接输出会让列表结构断掉。

还有两处防御 🔬：

```ts
// 过滤掉既无 edit 又无 command 的空壳 action（部分服务器会返回纯占位）
const actions = result.filter((a) => a && a.title && (a.edit || a.command));

// 纯 command 形态：服务器要求执行命令而非直接给 edit，我们不执行任意命令，仅提示
lines.push(`（此修复需服务器执行命令 \`${action.command.command}\`，无法直接展示 edit）`);
```

第二处是重要的安全边界：**有些 CodeAction 只给一个 `command`**（要客户端回调服务器执行）。
sid-code **不执行任意命令**，只提示。这是对的——执行服务器给的任意命令是一个真实的攻击面。

### 10.4 两个被否决的方案，以及否决的理由

这一节是本章的核心，也是全文「工程判断」密度最高的一段。

同一个想法在这个仓库里**被提过两次、否决过两次**，🔬 两次都有 Agent Note 留档。

**第一次：编辑前后诊断计数 delta**（2026-07-12 否决）

方案：编辑前记 `preErrorCount` → 编辑 → `setTimeout(500)` 等重诊断 →
`postErrorCount` → `delta > 0` 则注入「你引入了新错误」提醒。

听起来很合理。两条硬伤：

| 硬伤 | 说明 |
| --- | --- |
| **会被 churn 抵消而漏报** | 修掉 2 个错误、同时引入 2 个新错误 → `delta = 0` → **静默放过**。而这正是它声称要抓的场景 |
| **`setTimeout(500)` 是个赌博值** | 慢语言服务器上 500ms 内诊断还没来 → 读到的是**编辑前**的诊断 → 结论完全错 |

第一条是关键：**计数是个有损投影**。把「一个集合变成了另一个集合」压缩成一个整数，
必然丢掉「换了哪些成员」这个信息，而那恰好是你要的信息。

🔬 更有说服力的是 Claude Code 源码实证——**CC 刻意不做计数 delta**，它两条管线用的都是别的口径：

| CC 的管线 | 口径 |
| --- | --- |
| ① IDE/MCP tracker（`DiagnosticTrackingService`） | baseline 的**集合成员差集**（filter 不在 baseline 里的条目），**不算** `count_after - count_before` |
| ② 自 spawn LSP（`LSPDiagnosticRegistry`） | **内容级跨轮去重**，编辑后 fire-and-forget `didChange`/`didSave`（不 await、不轮询）+ 清缓存，靠下一轮 attachment 自然覆盖 |

**集合差集 vs 计数差**是这里的核心区别，值得记住：
前者知道「新增了哪几条」，后者只知道「多了几条」。churn 场景下前者正确，后者归零。

🔬 Note 里还留了一句面向未来的指路，这个写法值得学：

```text
将来若接 IDE（VSCode / JetBrains over MCP），值得抄的是管线①的 baseline 集合差集，
不是这份方案的计数 delta。别再走计数弯路。
```

**这句话的价值在于它防的是「同一个弯路被重走」。** 只写「否决」的话，
下一个人明天会重新提议同一件事；写清「什么条件下该做什么」，才是可复用的结论。

**第二次：codeAction 自动修复闭环**（2026-07-13 否决大部分）

🔬 评审结论很直接：

```text
方案 80% 是我上次已否决的"codeAction 联动"换宏大包装，带 3 个未验证代码假设。
```

被砍掉的四项，每一项的理由都不同，值得逐条看：

| 被砍项 | 理由 |
| --- | --- |
| §3.5 编辑后 `setTimeout(500)` 主动请求 | **是 CC 的反面**（CC 是 fire-and-forget，无 setTimeout / 无 await / 无轮询）。且是第一次否决的同一个赌博值 |
| §3.6 每轮注入 quickfix | **「零 token」是虚假卖点**——每轮常驻就是每轮付费 |
| 「edit 工具直接应用 TextEdit」 | **不同构**（§10.3）。而且 CC 自己全库没有 `applyWorkspaceEdit` |
| §6 全部演进（auto-apply / fixAll / organizeImports） | **绕过权限门控改文件，违反不变量** |

第二条「虚假卖点」值得单独说，因为它是一类很常见的论证错误：

> 方案说「codeAction 修复零 token 成本，因为不用 LLM 推理」。
> **这句话只在「按需查询」时成立。** 改成每轮注入之后，
> 它变成「每轮几百 token 常驻」——比让模型自己推理一次**更贵**，
> 因为推理是一次性的，常驻是乘以轮数的。
>
> 🔑 判据：**任何声称「零成本」的方案，先问「这个成本是一次性的还是每轮的」。**

还有一条 🔬，是关于**方案与现状漂移**的：

```text
方案 §3.5 代码已对不上现状（notifyLSPFileChange 委托给 syncFileToLSP，无 manager 变量；
setPendingQuickfix 等 3 函数凭空发明）。
```

**方案里引用的三个函数根本不存在**。这对应 CLAUDE.md 自检第 4 问
（「我引用的现状是回源码核过的，还是照抄文档的」）——
一份基于不存在的代码写的方案，就算思路对，实施步骤也全是错的。

### 10.5 为什么 CC 有完整 LSP 却刻意不做 codeAction

这是本章最值得记住的一条判断。

🔬 逐条 grep 核过的结论（不是印象）：

| 核查项 | 结果 |
| --- | --- |
| `codeAction` / `quickfix` 在 `claude-code/src` | **全零命中** |
| CC 的 LSPTool 操作枚举 | 与 sid-code 前 9 个**逐字相同**，**无第 10 个** |
| CC 实际发出的 LSP 方法 | 无 `textDocument/codeAction` |
| 全库 `applyWorkspaceEdit` | 不存在 |

结论 🔬：

```text
CC 有完整 LSP 却刻意不接 codeAction，所以这是标杆划的边界，不是我们的能力差距。
```

> 🔑 **这句话的方法论价值高于它的事实价值。**
>
> 调研竞品时最常犯的错是**把「对方没有」直接读成「我们领先」**，
> 或者反过来**把「对方有」读成「我们落后」**。两者都跳过了唯一重要的问题：
>
> **「对方是做不到，还是不想做？」**
>
> 区分方法很具体：**看它有没有前置能力。**
> CC 有完整的 LSP 客户端、有 LSPTool、有诊断管线——
> 加一个 codeAction 操作对它是几十行的工作量。它没做，**只能是不想做**。
>
> 那它为什么不想做？因为它的哲学是**极简**：诊断 → 模型推理 → 编辑，
> 这条闭环已经能修所有错误（包括那 90% codeAction 修不了的），
> 加 codeAction 只是在 10% 的情况下省一点 token，换来一个新操作、一堆时序陷阱。
>
> **这是一个合理的取舍，不是缺陷。** 而 sid-code 选择做，也是合理的——
> 它的定位是「可定制 + 数据主权」，多一个只读操作的边际成本可以接受。
> **两个不同的选择，各自服务不同的目标。**

### 10.6 本章自检

- codeAction 覆盖多少比例的诊断？这个数字决定了它的什么性质？
- LSP TextEdit 和 sid-code 的 `edit` 工具为什么不同构？
- 「计数 delta」的两条硬伤是什么？CC 用什么口径代替它？
- 「集合差集」和「计数差」的区别在什么场景下会显现？
- 「零 token 成本」这个卖点在什么条件下变成虚假的？
- 怎么区分「对方做不到」和「对方不想做」？

---

## §11 上下文经济学：LSP 到底省 token 还是费 token

这一章算账。因为「LSP 让 agent 更准」是个正确但空洞的说法——
**准的代价是什么，值不值，得能算。**

### 11.1 先建立框架：三笔账，方向不同

| 账 | 方向 | 说明 |
| --- | --- | --- |
| **A. 查询替代读文件** | ✅ **省** | 用 `hover` 换 `read` 整个文件 |
| **B. 诊断注入** | ⚖️ **换** | 花 token 买「不依赖模型主动性的错误反馈」 |
| **C. 工具描述常驻** | ❌ **费** | `lsp` 工具的 schema + usageGuide **每轮都在上下文里** |

**大多数讨论只算 A，这就是为什么结论总是过于乐观。** 三笔一起算才有意义。

### 11.2 账 A：查询替代读文件（省，且省得多）

具体估算。假设模型想知道 `add` 函数的签名：

| 做法 | token 量级 | 说明 |
| --- | --- | --- |
| `read calc.ts` 整个文件 | 一个 500 行文件 ≈ **5000+ tokens** | 而且大部分与问题无关 |
| `grep -n "function add"` | 命中行 + 上下文 ≈ **200 tokens** | 拿到定义行，但没有类型信息 |
| `lsp hover` | **≈ 30 tokens** | `function add(a: number, b: number): number` |

`documentSymbol` 的账更漂亮：

| 做法 | token |
| --- | --- |
| `read` 一个 2000 行文件 | ≈ **20000 tokens** |
| `documentSymbol` | 40 个符号 ≈ **400 tokens** |

**50 倍差距**。而且 `documentSymbol` 给的是**结构化的目录**，
模型据此可以只 read 它真正需要的那 50 行。

> 🔑 **这里的模式值得单独命名：「目录代替全文」。**
> 让模型先看目录（便宜、结构化），再自己选章节（精准、小量）。
>
> 这个模式在 agent 开发里到处适用，不止 LSP：
> `ls` 之于 `read` 全目录、`git log --oneline` 之于 `git log -p`、
> 数据库 schema 之于 `SELECT *`。
> **凡是「先给索引，让它自己选」的地方，都是这笔账。**

⚠️ 但账 A 有个前提：**模型得真的用它**（§5.2 那个乘法）。
不用的话这笔账是 0，而账 C 照付。

### 11.3 账 C：常驻成本（最容易被忘的一笔）

`lsp` 工具的定义**每轮都在上下文里**。它包括：

- JSON Schema（10 个 operation 的枚举 + 5 个参数 + 每个的 description）
- `description()` 的文本
- `usageGuide()` 的 8 条要点

🔬 粗估这三样加起来约 **400–600 tokens**。

这是**每轮**都付的。一个 30 轮的会话，光是「有这个工具」就花掉一万多 token
（考虑 prompt cache 命中的话实际便宜得多，但它占的**上下文窗口**是实打实的）。

> ⚠️ **这笔账有一个反直觉的后果**：
> **给 agent 加一个它不用的工具，是纯亏损。**
>
> 所以「工具越多越好」是错的。这也解释了为什么 `tool selection accuracy`
> 这个指标（选对工具的比例）低于 90% 时，结论是「**工具太多或描述差**」——
> 而两者都指向同一个动作：**删工具或改描述**，不是加工具。

顺带一个相关的设计点 🔬：sid-code 的 `lsp` 工具**有启用门控**：

```ts
isEnabled(): boolean {
  const state = getLSPInitState();
  return state === "success" || state === "pending";
}
```

没装任何 language server 的项目里，`initState` 会是 `success` 但零服务器——
⚠️ 注意这里：**零服务器时 `initState` 也是 `success`** 🔬：

```ts
if (Object.keys(configs).length === 0) {
  initState = "success";     // 无配置也算成功
  return;
}
```

所以严格说，`isEnabled` 在「一个 language server 都没装」的机器上**仍然返回 true**，
工具照常常驻上下文，调用时才返回「未找到对应服务器」。

这是一个**真实的、未收敛的成本泄漏**：在没装任何 language server 的环境里，
每轮白付 400–600 token。修法是让 `isEnabled` 也检查服务器数量非零。
（我核对了源码，这确实是当前行为，不是我看漏。）

### 11.4 账 B：诊断注入（一笔「换」，不是「省」）

诊断注入是**净增加** token 的。它买到的是 §1.3 那个不可替代的东西。

单次成本粗估 🔬（按限流上限算）：

```text
最多 30 条诊断 × 每条约 25 tokens（severity + 位置 + source + code + message）
  + 围栏和说明文案约 80 tokens
  ≈ 最多 830 tokens/次
```

但**实际远小于上限**，因为四道门控（§7）：

| 门控 | 削减效果 |
| --- | --- |
| 严重度过滤 | 纯 Hint / Info 的文件整个不注入 |
| 跨轮次去重 | 同一条只付一次，不是每轮 |
| 体积限流 | 上限 30 条 |
| 能力门控 | 只读子代理完全不付 |

**跨轮次去重是省得最多的一道**。没有它的话，一个持续存在的错误
在 20 轮会话里会被注入 20 次——同一条信息付 20 次钱，而且后 19 次是负价值
（模型会开始无视诊断段落）。

> 💡 **一个值得记住的判断**：
> **诊断注入的成本主要由「去重是否正确」决定，不由「诊断本身多长」决定。**
> 优化方向不是压缩诊断文本，是确保去重不漏。

### 11.5 三笔账合起来：什么情况下 LSP 是净赚的

把三笔放一起：

```text
净收益 = A（查询替代读文件 × 调用率）
       + B（错误反馈的价值 − 注入成本）
       − C（工具定义常驻 × 轮数）
```

据此可以推出几个**条件性结论**，这比一句「LSP 有用」有价值得多：

| 场景 | 净收益 | 为什么 |
| --- | --- | --- |
| **长会话、大代码库、装了 language server** | ✅ 明显正 | A 项大（大文件多）、B 项大（编辑多）、C 项被摊薄 |
| **短会话（3–5 轮）改一个小文件** | ⚖️ 接近零 | A 项小（文件本来就小）、C 项占比高 |
| **没装 language server 的项目** | ❌ 负 | A=0、B=0，C 照付（§11.3 那个泄漏） |
| **纯只读探索子代理** | ⚖️ 只有 A | 能力门控挡掉了 B；C 仍付 |
| **非编程任务**（写文档、跑脚本） | ❌ 负 | 三笔里只有 C |

> 🔑 **这张表是这一章的产出。** 面试里被问「LSP 值不值得接」，
> 答「值得，因为它更准」是普通答案；
> 答「**取决于会话长度、代码库规模和是否装了 language server，我可以拆成三笔账**」
> 并给出这张表，是好答案。

### 11.6 一个尚未量化的缺口：诚实标注

上面所有数字都是**量级估算**，不是实测。诚实地说清这一点：

| 量 | 状态 |
| --- | --- |
| 工具定义 token 数 | ❌ 估算（可实测：把 schema 过一遍 tokenizer） |
| 诊断注入的实际 token 分布 | ❌ 未采集（需要在注入点埋一个 token 计数） |
| `lsp` 工具的**实际调用率** | ❌ 未采集。**这是最该补的一个**——§5.2 那个乘法里的乘数，现在是未知 |
| 用 LSP 与不用 LSP 的返工率对比 | ❌ 未采集（需要 A/B） |

第三行是关键缺口。**「pull 链路的价值 = 能力质量 × 调用率」里，
调用率现在是个未知数**——也就是说，我们不知道 pull 侧那 963 行代码
实际产生了多少价值。

> ⚠️ 这正是 CLAUDE.md 自检第 2 问要防的东西：
> **「朝向感能量出来吗？拿什么轨迹数据证明它真的在进步，而非自我感觉？」**
>
> 对 LSP 这一块，当前的诚实答案是：**push 侧能证明**（诊断注入有日志、
> 有 `log.info("QUERY_LOOP", "G1：注入 LSP 诊断反馈")`），
> **pull 侧不能**——没有「lsp 工具被调用了几次」的聚合口径。
>
> 想补的话最小动作是：在 trace 里按 `tool_name` 聚合调用次数，
> 然后看 `lsp` 在所有工具里的占比。这个数字会直接决定
> 「pull 侧该不该继续投入」。

### 11.7 本章自检

- LSP 的三笔账各是什么方向？为什么只算第一笔会过于乐观？
- 「目录代替全文」这个模式，除了 `documentSymbol` 还能举两个例子吗？
- 为什么「给 agent 加一个它不用的工具」是纯亏损？
- 诊断注入的成本主要由什么决定？优化方向该指向哪？
- 在什么场景下接 LSP 是净亏的？（至少两个）
- 「pull 链路的价值」这个乘法里，现在哪个因子是未知的？怎么补？

---

## §12 十个真实陷阱

这一章和 §9 是本文最值钱的两章。§9 讲协议本身的陷阱，这一章讲**工程陷阱**——
它们不在 LSP 规范里，而在「把 LSP 接进一个 agent」这件事里。

**多数陷阱会「绿着坏掉」**：代码在、测试过、日志正常，功能就是不生效。
每条都给形态 / 为什么难发现 / 判据三段，判据尽量给成可执行的检查。

### 陷阱 1 · `Content-Length` 按字符切而不是按字节切

**形态**

```ts
// ❌ 错：JS 的 string.length 是 UTF-16 code unit 数，不是字节数
const contentLength = json.length;
const payload = `Content-Length: ${contentLength}\r\n\r\n${json}`;

// ❌ 同样错：读的时候按字符切
const body = this.buffer.slice(0, this.contentLength);
```

**为什么难发现**

**纯 ASCII 的项目里它完全正常。** 你的测试用 `{"method":"initialize"}` 这种消息，
字符数 = 字节数，一切完美。

然后接入一个有中文注释的项目，或者一条诊断消息里带了 emoji——
**帧就开始错位**。而错位的表现不是「解析失败」，是**后续所有消息全乱**：
你会看到「JSON 解析失败」的日志，但它指向的是一条被切坏的消息，
真正的原因在上一条消息的长度算错了。

**判据**

```ts
// ✅ 写：Buffer.byteLength
const contentLength = Buffer.byteLength(json, "utf-8");

// ✅ 读：转 Buffer 再按字节切
const bodyBytes = Buffer.from(this.buffer, "utf-8");
if (bodyBytes.length < this.contentLength) return;
const body = bodyBytes.slice(0, this.contentLength).toString("utf-8");
```

**验证手段**：造一条含中文和 emoji 的消息跑一遍。
「用 ASCII 测通了」不能推出「帧协议正确」——这是本章反复出现的
「测试覆盖了正确路径但没覆盖会出错的输入」形态。

### 陷阱 2 · 一次 `data` 事件里的多条消息只处理第一条

**形态**

```ts
// ❌ 错：处理一条就返回
private handleData(data: string): void {
  this.buffer += data;
  const headerEnd = this.buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) return;
  // ... 解析一条消息 ...
  this.handleMessage(msg);
  // 忘了继续处理 buffer 里剩下的
}
```

**为什么难发现**

低频交互下几乎不出现——你发一个请求，服务器回一个响应，一次 `data` 一条消息。

**它在两种情况下才暴露**：
① 服务器一次性刷出多条（初始化后连着推好几个文件的诊断）；
② 高频交互（模型连着发 5 个查询）。

暴露形态是「**偶尔丢一条响应**」，而丢了响应的那个请求会**等到超时**。
于是你看到的是「LSP 请求偶尔超时 30 秒」，完全指不到真因。

**判据**

必须是 `while (true)` 循环，且数据不完整时 `return`（保留 buffer）而不是 `break`：

```ts
while (true) {
  if (this.contentLength < 0) {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;      // 头不完整，保留 buffer 等下一批
    // ...
  }
  if (bodyBytes.length < this.contentLength) return;   // 体不完整，同上
  // ... 处理这一条，然后循环继续处理下一条
}
```

**验证手段**：在测试里把两条完整消息拼成一个字符串一次性喂进 `handleData`，
断言两条都被处理。这个测试三行，能防住一类极难查的超时。

### 陷阱 3 · 用「发完通知」当成「服务器已就绪」

**形态**

```ts
// ❌ 错：didOpen 是通知，发完不等于服务器解析完了
await manager.openFile(filePath, content);
const diags = registry.peekDiagnosticsForFile(uri);    // 恒空
```

**为什么难发现**

**这是本文里最典型的「绿着坏掉」。** 它不报错，返回一句人话：
「无可用的代码修复建议」。而文件里明明有一个大红波浪线。

更阴的是：**在已经打开过的文件上它是对的**（`latest` 里已有快照）。
所以你测试时反复在同一个文件上试 → 第一次空、后面都对 →
你会以为是「第一次的偶发问题」。

**判据**

**任何依赖 push 数据的 pull 操作，都必须显式等待。** §5.6 那个 `waitForDiagnostics`。

自检问法：**「这个数据是我请求来的，还是它推给我的？」**
推来的数据你不能假设它已经到了。

⚠️ 而且等待要用**正确的语义**（§5.6）：
「等不到」有两种成因（还没算完 / 压根不会来），**不能把它当故障**。

### 陷阱 4 · capabilities 只增不管，声明了不处理

**形态**

```ts
// 声明了 linkSupport，但解析代码只认 Location
definition: { linkSupport: true }
// ...
out.push({ uri: item.uri, ... });     // ❌ LocationLink 里没有 uri，是 targetUri

// 声明了 configuration，但不应答 workspace/configuration 请求
workspace: { configuration: true }
// ... client.ts 里没有 handleServerRequest → 服务器一直等
```

**为什么难发现**

第一种：结果恒为空（§9.1）。第二种更糟——**部分服务器卡在初始化里**，
你看到的是「这个语言服务器起不来」，而它其实在等你回一条消息。

**判据**

**每加一条 capabilities，问两个问题**：

1. 这让服务器**多发什么**给我？我处理了吗？
2. 这让服务器**改变返回形状**吗？我的解析认得吗？

`linkSupport` 命中第 2 问，`configuration` 命中第 1 问。

**验证手段**：capabilities 加完之后，抓一次真实的协议往返
（`log.debug` 打出所有收发的 method），看有没有出现你没处理的 method。

### 陷阱 5 · 只发 `didChange` 不发 `didSave`

**形态**

```ts
// ❌ 少一步
await manager.changeFile(filePath, content);
// 缺 manager.saveFile(filePath)
```

**为什么难发现**

**它是「按语言不同而不同」的**。TypeScript 上完全正常（tsserver 在 didChange 就做完整诊断），
Python 的 pylsp、某些 gopls 配置上**类型错误从来不报**。

于是现象是「Python 的 LSP 好像不太行」——你会去怀疑 pyright/pylsp，
而不会怀疑自己少发了一个通知。

**判据**

编辑后三步齐发（§4.4）：`clearForFile` → `didChange` → `didSave`。

**验证手段**：**至少在两种语言上做一次 e2e**。
单语言测试无法暴露这类「服务器行为差异」的坑——
这和 provider 层「至少接两家才能发现协议差异」是同一个道理。

### 陷阱 6 · 编辑后不清去重缓存

**形态**

```ts
// ❌ 只发通知，不清 delivered
await notifyFileChanged(filePath, content);
```

**为什么难发现**

**双向都会错，而且两个方向的现象相反**：

| 方向 | 现象 |
| --- | --- |
| 没修好 | 服务器重推同一条诊断 → 命中 delivered → 被过滤 → **模型再也看不到这个错误，以为修好了** |
| 修好了 | 旧诊断还在 pending 里 → **过时错误驻留**，模型去修一个已经不存在的问题 |

第一个方向尤其危险：它让 agent **在错误还在的情况下宣布完成**。
而且从日志看一切正常（诊断确实被"处理"了，只是被去重掉了）。

**判据**

顺序也有要求：**清缓存必须在 `didChange` 之前**（§4.4）。
先 didChange 的话，快服务器可能在你清之前就推了新诊断，那条会被误过滤。

**验证手段**：一个两轮的 e2e——第一轮引入错误确认注入，
第二轮**不修**再编辑一次（改个空格），确认诊断**再次注入**。
这个断言就是在守去重缓存被正确清除。

### 陷阱 7 · 全局单例 registry 在并发消费者下互相偷数据

**形态**

```ts
// registry 是进程级单例，collect 是「消费即清空」
collectDiagnostics(): DiagnosticFile[] {
  const all = [...this.pending.values()].flatMap(e => e.files);
  this.pending.clear();          // ❌ 把所有人的都清了
  return all;
}
```

**为什么难发现**

**它在单消费者时代完全不存在。** 加了并发子代理之后才浮现，
而浮现形态是「**诊断偶尔不出现**」——在概率上很像 flaky，
很容易被当成「LSP 有时候慢，没赶上这一轮」而忽略。

真因是：谁先 collect 谁把**所有人**的 pending 捞走并清空，另一方永远看不到自己的诊断。

**判据**

三个条件相乘才出这个 bug：**消费即清空 + 全局单例 + 多个消费者**。
任意去掉一个都不会出。所以判据是：

> **对任何「消费即清空」的全局状态，问「有几个消费者？」**
> 超过一个就必须有作用域隔离。

🔬 修法是给 collect 加 `scopeUris` 参数，只收集 + 只清空作用域内的（§7.6）。

⚠️ **还有一个配套的细节容易漏**：

```ts
// 显式传了作用域但没有一个合法 URI → 不误退化为全量消费
if (scopeUris.length === 0) return null;
```

`undefined`（不限制）和 `[]`（限制为空集）**语义相反**，代码里必须区分。
不区分的话，一个本该隔离的消费者会突然变成全量消费者。

### 陷阱 8 · 先截断再排序

**形态**

```ts
// ❌ 顺序颠倒
const limited = diagnostics.slice(0, 10);
const sorted = limited.sort(bySeverity);
```

**为什么难发现**

**输出形态完全正确**：10 条诊断，整整齐齐按严重度排列。
你看不出它们是从 53 条里**随便挑的** 10 条。

一个文件有 3 个 Error 和 50 个 Hint 时，如果 Hint 恰好排在数组前面，
**你一个 Error 都没留下**——而模型收到的是一份看起来很正常的 Hint 列表。

**判据**

```ts
// ✅ 先排序，再截断
const sorted = [...diagnostics].sort((a,b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
const limited = sorted.slice(0, MAX_PER_FILE);
```

**通用形态**：**任何「取前 N 个」之前必须先确定「按什么排」。**
这条在分页、日志采样、搜索结果、上下文裁剪里都一样——
而且失效形态都一样：输出格式正确，内容是随机子集。

**验证手段**：造一个「Hint 在前、Error 在后」的数组，断言截断后 Error 还在。
用「Error 在前」的数组测是测不出来的——**它恰好会通过**。

### 陷阱 9 · 只接主路径，不接子代理路径

**形态**

```text
query/tool-executor.ts     → 编辑后调 syncFileToLSP   ✅
agent/tool-executor.ts     → 什么都不做                ❌

query/loop.ts              → 每轮注入诊断             ✅
agent/agentic-loop.ts      → 从不注入                 ❌
```

**为什么难发现**

**功能代码全都存在。** `syncFileToLSP` 写好了、`collectDiagnosticText` 写好了、
测试也过了。你在主循环里手动试一遍，一切正常。

**成因是结构性的**：子代理是主循环的复制品，而**复制发生在功能加上之前**。
之后每加一个功能，如果不专门想起来，就只加在主循环上。

🔬 这一类债在这个仓库里至少有三例（LSP 同步、hook 接线顺序、后台任务通知回注）。

**判据**

> **对任何「已实现」的能力，grep 它的调用点，然后问：
> 子代理路径在这个列表里吗？**

```bash
# 具体做法
rg -n 'collectDiagnosticText' packages -g '*.ts' | grep -v tests
# 看输出里有没有 agent/ 下的文件
```

**光看功能代码存在与否，看不出这个断层。** 必须看调用点。

⚠️ 而且**接线之后要看语义是否也一致**。🔬 一个至今未收敛的例子：
主循环的诊断注入用 `<system-reminder>` 围栏 + 「非用户输入」标注（陷阱 10 的修复），
**子代理那一处仍在用裸的 `# LSP 诊断（...）` 形态**——
接线补上了，但那次修复没跟着传播过去。

**「接线」和「语义一致」是两件事**，补了前者不代表补了后者。

### 陷阱 10 · 注入文本与用户输入形态混同

**形态**

```ts
// ❌ 用 markdown 标题开头，与用户 prompt 的 `# Commit:` 形态混同
text: `# LSP 诊断（来自语言服务器的实时反馈）\n\n${diagnosticText}`
```

**为什么难发现**

模型的全部输入就是一段文本流。它**看不到「这段是系统注入的、那段是用户写的」**——
除非你标记。

🔬 这个坑在 2026-07-29 出过一次事故，形态是「模型分不清谁在说话」，
当时有**三处**裸注入，LSP 诊断是其中之一。

失效形态很难归因：模型偶尔会把诊断当成用户的要求
（「用户让我修这些错误」），或者反过来把用户的 `# Commit:` 当成系统提示忽略掉。
两个方向都不会报错，只会让模型的行为「有点怪」。

**判据**

**注入进上下文的任何文本，都要在形态上与用户输入可区分。**

```ts
// ✅ 围栏 + 明说来源
`<system-reminder>\n` +
`LSP 诊断（来自语言服务器的实时反馈，非用户输入）：\n\n${diagnosticText}\n\n` +
`...\n</system-reminder>`
```

两个要素：**结构围栏**（`<system-reminder>`）+ **显式来源声明**（「非用户输入」）。
只有围栏不够——围栏可能被 markdown 渲染吃掉或被模型当成普通文本。

**验证手段**：把注入文本单独拿出来看，问「**如果这段话是用户打的，长什么样？**」
一样的话就得改。

### 12.x 把十条压缩成五句话

如果只能记五句：

1. **按字节切，不按字符切；循环处理，不只处理第一条。**
   （陷阱 1、2 —— 帧协议的两个必错点，ASCII 测试全都通过）
2. **推来的数据不能假设它已经到了；等待要区分「还没来」和「不会来」。**
   （陷阱 3 —— 通知不可等待，是 LSP 时序 bug 的总源头）
3. **capabilities 是承诺不是许愿单：声明了什么，就要处理它带来的什么。**
   （陷阱 4 —— 增一条声明，问「多发什么」和「改什么形状」）
4. **取前 N 个之前先确定按什么排；清缓存在通知之前；三个通知都要发。**
   （陷阱 5、6、8 —— 顺序错误的三个形态，输出全都看起来正常）
5. **对任何已实现的能力，grep 调用点，问「子代理在里面吗」。**
   （陷阱 7、9、10 —— 单消费者假设、复制品断层、形态混同，都是「主路径对了」之后的债）

---

## §13 五家横向对比：同一个协议，五种取舍

这一章的目的不是排名，是**看清同一个协议下有几种合理的取舍**。

⚠️ **先说数据可靠性**：其中 Claude Code 那一列是 🔬 **逐条 grep 源码核过的**
（含「零命中」的负向结论）；sid-code 是 🔬 本仓源码；
**其余三家是 📄 二手调研，可靠性低一档**——面试里引用时该说「据我了解」而不是「事实是」。

### 13.1 五家一句话

| 项目 | LSP 策略一句话 |
| --- | --- |
| **Claude Code** 🔬 | 完整 LSP 客户端 + 9 个查询操作 + 诊断 attachment，**刻意不接 codeAction**（极简哲学） |
| **sid-code** 🔬 | 与 CC 同构，多一个只读 `codeAction`；诊断做严重度过滤（更省）；内置 10 语言零配置 |
| **Cursor** 📄 | 被动接收诊断，无 codeAction 交互（它是编辑器，LSP 本来就在宿主里） |
| **Aider** 📄 | **不接 LSP**，走「改完跑测试看输出」闭环 |
| **agent-lsp（MCP）** 📄 | 走另一个极端：`/lsp-fix-all` 对所有诊断应用 quickfix，编辑后自动推荐 |

### 13.2 关键维度对照

| 维度 | Claude Code 🔬 | sid-code 🔬 | Cursor 📄 | Aider 📄 | agent-lsp 📄 |
| --- | --- | --- | --- | --- | --- |
| 自 spawn language server | ✅ | ✅ | 宿主编辑器已有 | ❌ | ✅ |
| 查询操作数 | 9 | **10** | — | 0 | 多（含 fix-all） |
| 诊断注入 | ✅ 全严重度 + 排序 | ✅ **仅 Error/Warning** | ✅ | ❌ | ✅ |
| codeAction | ❌ **刻意不做** | ✅ 只读 pull | ❌ | ❌ | ✅ **自动 apply** |
| 自动改文件 | ❌ | ❌ | ❌ | ❌ | ✅ |
| 编辑后诊断 delta | ❌ 用集合差集 / 内容去重 | ❌ 同上 | ? | — | 部分有 |
| 内置语言目录 | 插件驱动 | ✅ 10 种 + 安装引导 | 编辑器生态 | — | 需配置 |
| 启用门控 | `ENABLE_LSP_TOOL` 环境变量 | **自动检测**（零配置） | 默认 | — | 配置 |

### 13.3 各自在赌什么

这一节比上面那张表有价值——**表告诉你「谁有什么」，这一节告诉你「为什么」。**

**Claude Code 赌的是：模型足够强，闭环足够短。**

它有完整 LSP 却不接 codeAction，逻辑是自洽的：
诊断 → 模型推理 → 编辑，这条闭环能修**所有**错误（包括 codeAction 修不了的 90%）。
加 codeAction 只在 10% 的情况下省点 token，换来一个新操作 + 一堆时序陷阱。

**赌对了会怎样**：代码量最小，行为最可预测，模型变强时自动受益。
**赌错了会怎样**：在弱模型上，那 10% 的机械错误要花掉不必要的轮数。

**sid-code 赌的是：可定制 + 数据主权值得多付一点复杂度。**

它多做的三件事各有理由：
- `codeAction`（只读）：边际成本低（一个操作 + 一个 formatter），且对弱模型有真实价值
- 严重度过滤：服务「更省」这个北极星方向，且明确标注「勿往回改」
- 内置 10 语言 + 安装引导：服务「企业级开箱即用」（装上就接得上，不用先改造企业）

**赌对了会怎样**：企业内网里换模型、换语言都不用改代码。
**赌错了会怎样**：多出来的复杂度（三级配置、10 个内置条目、第 10 个操作）需要持续维护，
而如果没人用第 10 个操作，那就是纯负债。

**Aider 赌的是：测试比诊断更可信。**

这个取舍值得认真对待，它**不是懒**：

| 论据 | 说明 |
| --- | --- |
| 测试验证的是**行为**，诊断验证的是**类型** | 类型全对但逻辑错的代码，诊断一片绿 |
| 零依赖 | 不用装 language server，任何语言任何项目都一样工作 |
| 判据无歧义 | 测试红/绿是二值的，诊断是四档 severity + 一堆需要判断的 Hint |

**赌错了会怎样**：没有测试的项目里它什么反馈都没有；
而且「跑一遍测试」比「读一条诊断」贵一到两个数量级（编译 + 执行 vs 几十个 token）。

**agent-lsp 赌的是：确定性修复应该自动化。**

它做 `/lsp-fix-all`——对所有诊断应用 quickfix。这在**它的定位**（一个 MCP 工具，
用户显式调用）下是合理的：用户敲了这个命令，就是授权了。

**为什么 sid-code 不这么做** 🔬：它会**绕过权限门控改文件**，违反不变量。
在 agent 自主循环里，「自动改文件」和「用户显式命令改文件」是完全不同的授权语境。

> 🔑 **这一节的方法论产出**：
> **五家的差异几乎全部可以由「它们各自在赌什么」推导出来**，
> 而不需要假设谁比谁笨。
>
> 调研竞品时的正确姿势是**先找出对方的赌注**，再判断那个赌注在你的场景里成不成立。
> 直接抄「对方有的功能」，往往是抄了一个服务于别人赌注的东西。

### 13.4 一个诚实的汇总：sid-code 在哪领先、在哪落后

**领先的（有依据的）** 🔬：

| 项 | 依据 |
| --- | --- |
| `codeAction` 只读查询 | CC 源码 grep 零命中，且 CC 有完整前置能力 = 刻意不做，**这是差异不是差距** |
| 严重度过滤（只注入 Error/Warning） | 比 CC 全严重度更省 token |
| 能力门控用 `edit`/`write` 而非 `bash` | 更贴合「诊断是给能改代码的 agent 看的」本意 |
| 内置 10 语言 + 精准安装引导 | CC 走插件驱动，sid-code 走内置目录，零配置体验更好 |
| 自动检测启用（无需环境变量） | CC 要 `ENABLE_LSP_TOOL` |

**落后 / 未收敛的（也得写）**：

| 项 | 状态 |
| --- | --- |
| `lsp` 工具的实际调用率 | ❌ 未采集（§11.6）——**pull 侧 963 行代码的价值当前无法证明** |
| 子代理注入文案仍是裸 `#` 形态 | ⚠️ 陷阱 10 的修复没传播到子代理路径 |
| 零 language server 时工具仍常驻上下文 | ⚠️ `isEnabled` 不检查服务器数量，白付 400–600 token/轮（§11.3） |
| `lsp.json` 解析失败只有 debug 日志 | ⚠️ 用户写错 JSON 时几乎无感（§8.4） |
| 无 pull diagnostics（LSP 3.17） | 走经典 push，功能上没问题，但错过了「按需拉诊断」这个更省的形态 |
| 无 IDE 集成（VSCode/JetBrains over MCP） | 🔬 Note 里留了指路：那时该抄 CC 管线①的**集合差集** |

### 13.5 本章自检

- CC 不做 codeAction，为什么这是「差异」而不是「差距」？判断依据是什么？
- Aider 不接 LSP 的三条论据是什么？它赌错了会怎样？
- agent-lsp 的自动 apply 在它的定位下为什么合理，在 agent 自主循环里为什么不合理？
- 调研竞品的正确姿势是什么？

---

## §14 从零到一：六阶段动手路线

这一章是**实操**。照这个顺序做，你会亲手撞到前面讲的大部分坑——
**撞到过的坑才是真懂**。

每阶段给：目标 / 做什么 / 你会撞到的坑 / 完成判据。

### 阶段 1 · 裸手发一次 initialize（半天）

**目标**：不用任何库，spawn 一个 language server，完成握手。

**做什么**

```bash
npm i -g typescript-language-server typescript
```

```ts
import { spawn } from "child_process";

const p = spawn("typescript-language-server", ["--stdio"]);
p.stdout.on("data", (c) => console.log("← ", c.toString()));
p.stderr.on("data", (c) => console.log("[err]", c.toString()));

function send(msg: unknown) {
  const json = JSON.stringify(msg);
  p.stdin.write(`Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`);
}

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  processId: process.pid,
  rootUri: "file:///tmp/lspdemo",
  capabilities: {},
}});
```

**你会撞到的坑**

| 坑 | 现象 |
| --- | --- |
| 命令不在 PATH | `spawn ENOENT`。这是最好的一个坑——它教你为什么要做 PATH 探测（§8.3） |
| `rootUri` 用了裸路径 | 服务器报错或忽略。必须 `file://` 前缀 |
| 忘了 `\r\n\r\n`（用了 `\n\n`） | **服务器完全不响应，也不报错** |

**完成判据**：stdout 打出一个含 `"capabilities"` 的 JSON。
你能在里面看到服务器声明它支持什么——**这是你第一次看到「服务器能力」的真实形态**。

### 阶段 2 · 写出帧解析器（半天）

**目标**：把 stdout 的字节流正确切成消息。

**做什么**：实现 §2.2 那个状态机。**别偷懒用 `split("\r\n\r\n")`**。

**你会撞到的坑**（就是陷阱 1 和 2）

先用 ASCII 消息测通，然后**故意**做两件事：

```ts
// ① 造一条含中文和 emoji 的消息，看会不会错位
send({ jsonrpc:"2.0", id:2, method:"$/test", params:{ note: "中文注释 🎉" }});

// ② 把两条完整消息拼起来一次性喂给 handleData
handleData(frame(msg1) + frame(msg2));   // 断言两条都被处理
```

**完成判据**：上面两个用例都过。
**这两个用例就是你的第一批测试**——它们防的是最难查的两类 bug。

### 阶段 3 · 完成一次真实查询（一天）

**目标**：`textDocument/definition` 拿到结果。

**做什么**

1. 握手三步（initialize → 等响应 → initialized）
2. `didOpen` 一个真实文件（附完整文本）
3. 发 `textDocument/definition`
4. 把响应里的 0-based 坐标转成 1-based 打印

**你会撞到的坑**

| 坑 | 现象 | 对应章节 |
| --- | --- | --- |
| 忘了 `didOpen` 直接查 | 空结果 | §4.2 |
| 忘了发 `initialized` | 部分服务器不响应查询 | §3.2 |
| 坐标没转换 | 差一行，**结果看起来很合理但是错的** | §9.3 |
| 声明了 `linkSupport` 但只解析 `uri` | 空结果 | §9.1 |

**建议刻意做一次错的**：把 `linkSupport: true` 加上但不改解析代码，
体会一次「配置改了、代码没改、结果恒空、什么都不报错」。

**完成判据**：对 §1.2 那个 `calc.ts`，`findReferences` 输出三行，
且行号列号与编辑器显示一致。

### 阶段 4 · 接住诊断推送（一天）

**目标**：跑通 push 链路——**这是价值最高的一个阶段**（§5.7）。

**做什么**

1. 注册 `textDocument/publishDiagnostics` 通知处理器
2. 数字 severity → 字符串，**保留 `code` 字段**（§7.1）
3. 存进一个 `pending` Map
4. 写一个 `collect()` 取出并清空
5. 格式化成人类可读文本

**你会撞到的坑**

| 坑 | 现象 |
| --- | --- |
| 没等诊断就 collect | 空。诊断是异步推来的（§3.1） |
| 不去重 | 同一条错误每次 collect 都出现 |
| 编辑后没清缓存 | 修好了错误还在 / 没修好错误消失了（陷阱 6） |

**完成判据**：改一个文件引入类型错误，几百毫秒后 `collect()` 拿到那条诊断；
**再 collect 一次拿到空**（去重生效）；改一次文件后**又能拿到**（清缓存生效）。

**这三个断言就是诊断链路的核心测试。**

### 阶段 5 · 加四道门控与并发隔离（一天）

**目标**：从「能跑」到「能上生产」。

**做什么**：§7 那四道门控，按这个顺序加：

```text
① 严重度过滤（最简单，5 行）
② 排序 + 限流（注意顺序：先排序再截断，陷阱 8）
③ 跨轮次去重的 LRU 上限（防内存泄漏）
④ 作用域参数（防并发消费者互偷，陷阱 7）
```

**你会撞到的坑**：④ 最难，因为它要求你先想清
「`undefined`（不限制）和 `[]`（限制为空）语义相反」这件事。

**完成判据**：
- 一个只有 Hint 的文件不注入
- Hint 在前、Error 在后的数组截断后 Error 还在
- 两个不同作用域的消费者各自只拿到自己的诊断，互不清空对方的

### 阶段 6 · 多服务器 + 韧性（一到两天）

**目标**：从「一门语言」到「十门语言」。

**做什么**

```text
① 内置目录数组（一个 name/command/args/extensionToLanguage/installHint 的列表）
② 并行 PATH 探测（Promise.all + which）
③ 扩展名路由表 + 反向索引（区分「没装」和「不支持」，§8.5）
④ 懒启动（ensureStarted + startPromise 并发去重）
⑤ 崩溃恢复（有上限，重建 client）
⑥ 健康快照 + 一次性告警
```

**你会撞到的坑**

| 坑 | 现象 |
| --- | --- |
| 串行 `which` | 冷启动慢几百毫秒 |
| 没有 `startPromise` 去重 | 并发时 spawn 出孤儿进程 |
| 崩溃重启无上限 | CPU 烧光 + 日志刷屏 |
| 健康告警从没触发过 | **无法区分「一切健康」和「告警本身坏了」**（§8.8） |

**完成判据**（最后一条最重要）：
- 装了 TS 和 Python 两个 server，两种文件各自路由正确
- 没装 Go server 时，对 `.go` 文件的查询给出 `go install` 的精准提示
- **变异自证**：故意把某个 command 改成不存在的名字，确认健康告警**真的出现**

### 阶段总览：你会亲手撞到的坑

| 阶段 | 撞到的坑 | 对应章节 |
| --- | --- | --- |
| 1 | ENOENT、`file://`、`\r\n\r\n` | §8.3、§0.4 |
| 2 | 字节 vs 字符、多条消息 | 陷阱 1、2 |
| 3 | 忘 didOpen、忘 initialized、坐标、形状 | §4.2、§3.2、§9.1、§9.3 |
| 4 | 异步推送、去重、清缓存 | §3.1、§7.3、陷阱 6 |
| 5 | 排序顺序、并发隔离 | 陷阱 8、7 |
| 6 | 串行探测、孤儿进程、崩溃循环、死防线 | §8.3、§8.6、§8.7、§8.8 |

**总计四到六天**，产出一个**能用**的 LSP 客户端。
对比 sid-code 的 2906 行——**你会写出其中大约三分之一，而那三分之一覆盖了 90% 的价值。**

> 💡 剩下那一半是什么？格式化的各种边界（`MarkedString` 三种形态、符号树递归缩进）、
> gitignore 过滤的六个防孤儿细节、代数计数器、三级配置合并。
> **都是「已经能用之后」才需要的东西**——这个顺序本身就是一个结论：
> **先跑通链路，再补边界。** 反过来做（先把 formatter 写得完美再接通链路）
> 是最常见的时间浪费形态。

---

## 附录

### A. 三十秒自检清单

接完 LSP 之后，照这个单子过一遍。**每条都能指到一个具体的失效形态**，
所以「想不起来为什么要查这条」本身就是个信号。

**帧协议**

- [ ] `Content-Length` 用 `Buffer.byteLength` 算，读时按字节切片？（陷阱 1）
- [ ] 造一条含中文 + emoji 的消息跑过？（不测这个等于没测帧协议）
- [ ] `handleData` 是 `while` 循环，不完整时 `return` 而非 `break`？（陷阱 2）
- [ ] 两条完整消息拼一起喂进去，两条都被处理？

**生命周期**

- [ ] 握手三步齐全（initialize 等响应 → initialized 通知）？
- [ ] 关闭三步齐全（shutdown 等响应 → exit → kill），且 shutdown 超时短？
- [ ] 服务器→客户端的请求有应答？未知 method 显式回 `-32601`？（§3.4）
- [ ] `ContentModified (-32801)` 有重试，其它错误**没有**重试？（§3.5）

**capabilities**

- [ ] 每条声明都问过「让服务器多发什么 / 改什么形状」？（陷阱 4）
- [ ] 声明了 `linkSupport`，解析代码认 `targetUri`？优先 `targetSelectionRange`？（§9.1）
- [ ] 声明了 `hierarchicalDocumentSymbolSupport`，两种符号形状都能解析？（§9.2）

**文档同步**

- [ ] 查询前确保 `didOpen` 过？
- [ ] 编辑后三步齐发：**清缓存 → didChange → didSave**，且顺序对？（§4.4、陷阱 5、6）
- [ ] 版本号递增，且「打开状态」与「版本号」是同一个事实源？

**坐标**

- [ ] 转换只有一处入、一处出，且有测试？（§9.3）
- [ ] 工具接口暴露 1-based，与 `read` 工具输出一致？

**诊断链路**

- [ ] 四道门控齐全：严重度过滤 / 跨轮次去重 / 排序后限流 / 能力门控？（§7）
- [ ] **先排序再截断**？用「Hint 在前」的数组测过？（陷阱 8）
- [ ] `delivered` 有 LRU 上限（防内存泄漏）？
- [ ] 多消费者场景有作用域隔离？`undefined` 与 `[]` 语义区分开了？（陷阱 7）
- [ ] 注入文本有围栏 + 「非用户输入」标注，**不以 `#` 开头**？（陷阱 10）
- [ ] 采集时保留了 `code` 字段？（模型可按错误码检索）

**多服务器**

- [ ] PATH 探测并行？
- [ ] 懒启动有 `startPromise` 并发去重？（防孤儿进程）
- [ ] 崩溃重启有上限，重启时重建 client？
- [ ] 「没装」和「不支持」的错误信息**能区分**，且各自给出可执行的下一步？（§8.5）

**接线（最容易漏的一组）**

- [ ] `rg` 过每个能力的**调用点**，不只看功能代码存在？（L3-1）
- [ ] **子代理路径**在调用点列表里？（陷阱 9）
- [ ] 子代理路径的**语义**也和主路径一致（不只是接上了）？
- [ ] 健康告警做过**变异自证**（故意改坏 command，确认告警真的出现）？（§8.8）

**成本**

- [ ] 没装任何 language server 时，工具是否仍常驻上下文？（§11.3 的泄漏）
- [ ] 截断时告诉了模型总数？（§9.6）

### B. 术语速查

按英文字母序（这一份用来查，§0 那份用来学）。

| 词 | 一句话 |
| --- | --- |
| **capabilities** | 双向能力声明，握手时交换。**是承诺不是许愿单** |
| **CodeAction** | 「这里能怎么改」，含 `quickfix`/`refactor`/`source`。带 `edit`（坐标式改动） |
| **ContentModified (-32801)** | 「你问的时候文件又变了」。**唯一值得重试的 LSP 错误** |
| **Content-Length** | 帧协议的长度前缀。**单位是字节** |
| **diagnostic** | 一条错误/警告/提示。含 message、severity、range、source、code |
| **didOpen / didChange / didSave / didClose** | 四条文档同步通知。**都是通知，都不可等待** |
| **DocumentSymbol** | 带 `children` 的符号树。对比 `SymbolInformation`（扁平） |
| **initialize / initialized** | 握手的请求与通知。**漏 initialized 会导致部分服务器不推诊断** |
| **JSON-RPC 2.0** | `{jsonrpc, id?, method, params}`。有 `id` 是请求，无 `id` 是通知 |
| **language server** | 独立进程，懂一种语言。**它看到的是你告诉它的内容，不是磁盘上的文件** |
| **Location / LocationLink** | 查询结果的两种形状。前者 `uri`+`range`，后者 `targetUri`+`targetRange` |
| **notification** | 通知，无 `id`，无响应，**失败不可见** |
| **positionEncoding** | LSP 3.17 的坐标单位协商。默认 **UTF-16 code unit** |
| **publishDiagnostics** | 服务器**主动推**诊断的通知。push 链路的起点 |
| **pull diagnostics** | LSP 3.17 的 `textDocument/diagnostic` 请求（客户端主动要）。sid-code 未用 |
| **severity** | 1=Error / 2=Warning / 3=Info / 4=Hint |
| **stdio** | 客户端 spawn 服务器，走 stdin/stdout。agent 场景的标准形态 |
| **SymbolKind** | 符号类型的数字码 1–26（5=Class、12=Function…）。**展示时要转成名字** |
| **TextEdit** | LSP 的**坐标式**编辑（range + newText）。与文本匹配式 edit 工具不同构 |
| **WorkspaceEdit** | 一批 TextEdit，可跨文件。CodeAction 的 `edit` 字段 |

## 最后：这份文档想让你记住的三件事

如果一个月后你只记得三件事，希望是这三件。

### 一 · LSP 的价值分两半，而不可替代的是被少数人重视的那一半

**主动查询**（definition / references / hover）让 agent 查得更准，
但它的实际价值等于**能力质量 × 模型调用率**——而调用率你只能影响，不能保证。
强模型用 grep 加推理，往往也能得到正确答案，只是费 token。

**被动诊断**买到的是另一样东西：**它把「验证代码有没有改坏」
从一个模型要记得做的动作，变成了一个基础设施保证的事实。**

「模型忘了验证就宣布完成」是 coding agent 最常见的失败形态之一。
诊断链路从原理上消灭了它——不需要模型主动查、不需要它选对工具、
不需要它知道项目里装了什么。

所以如果只能做一条链路，做诊断。它代码更少、价值更高、且不可替代。

### 二 · 这个领域的失效形态几乎全是「绿着坏掉」

回看全文的坑，它们有一个共同点：**都不抛异常。**

| 坑 | 它长什么样 |
| --- | --- |
| 帧长度按字符算 | ASCII 测试全过，中文项目里帧错位 |
| 只处理第一条消息 | 「LSP 请求偶尔超时 30 秒」 |
| 忘了 didOpen | 空结果（和「真的没有」一样） |
| 坐标差一行 | **碰巧还是对的**，只是答错了问题 |
| 声明了 linkSupport 没改解析 | 结果恒空 |
| 先截断再排序 | 输出格式完美，内容是随机子集 |
| 没清去重缓存 | 模型看不到自己没修好的错误，宣布完成 |
| 诊断链路没接线 | 每个模块单测都过，因为每个模块都是对的 |
| 健康告警从未触发 | 和「一切健康」在观测上完全一样 |

这决定了一件事：**在这个领域，「代码写了 + 测试过了」不是验收判据。**

判据得是可执行的：
- **grep 调用点**，而不是看功能代码在不在
- **变异自证**——故意改坏，确认防线真的响
- **交叉验证**——同一坐标上 `hover` 有输出吗
- **用会失败的输入测**（Hint 在前的数组、含 emoji 的消息、两条拼一起的帧）

### 三 · 差异不等于差距——先找出对方在赌什么

Claude Code 有完整的 LSP 客户端，却**刻意不做 codeAction**。
Aider 干脆**不接 LSP**，靠跑测试闭环。
agent-lsp 走另一个极端，**自动 apply 所有 quickfix**。

三家都不是笨。它们各自在赌不同的东西：
CC 赌模型足够强、闭环足够短；Aider 赌测试比诊断更可信（类型全对但逻辑错的代码，
诊断一片绿）；agent-lsp 赌的是「用户显式敲命令就是授权」。

**调研竞品时唯一重要的问题不是「对方有什么」，是「对方是做不到，还是不想做」。**
区分方法很具体：**看它有没有前置能力。** CC 有完整 LSP 客户端和诊断管线，
加一个 codeAction 是几十行的工作量——它没做，只能是不想做。

跳过这个问题，你会做两件蠢事：把「对方没有」读成「我们领先」，
或者抄一个服务于别人赌注的功能回来。

而这三件事里，第三件最难。前两件是技术判断，练几次就有；
第三件要你**先承认对方的选择可能是对的**，再去理解它为什么对——
然后才有资格说自己的选择也是对的。
