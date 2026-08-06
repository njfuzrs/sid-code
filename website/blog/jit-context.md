---
title: JIT 上下文：让规则在正确的时刻进入上下文
description: 规则写了却不被遵守，多半不是模型不听话，而是那条规则当时根本不在上下文里。这篇从"为什么不能全塞进去"这个约束推出 JIT 的形状，交出实测基线，并交代三个只能靠实测发现的静默缺陷、五条至今未修的边界，以及一次自己的数据四天后漂移 52 倍的教训。
date: "2026-08-02"
series: 上下文工程
audience: engineer
highlight: 3 个静默缺陷 · 5 条未修边界 · 自己的 P50 四天漂移 52 倍
tags: [上下文工程, 机制解析, 实测]
---

# JIT 上下文：让规则在正确的时刻进入上下文

你在 `src/ui/CLAUDE.md` 里写了"这个目录下的组件禁止用彩色 emoji"，agent 改完代码，
emoji 还在。第一反应大概是"模型不听话"。

多数情况下不是。是那条规则**当时根本不在上下文里**。

::: tip 结论先放这里
- 全量加载在这个仓库要付 11,921 token / 轮（2026-08-06 实测），而绝大多数任务
  只用得上其中一份规则。更麻烦的不是钱，是无关规则会主动干扰模型。
- 同一份带 `paths:` 的规则，启动加载与 JIT 发现的命中判定方式必须不同——
  两条路径手上的信息量不一样，用同一套判据必然有一侧失效。
- 累积字节 P95 = 25.0 KB（2026-08-06 实测），所以淘汰机制现在不该做。
  这个结论是数据给的。
- 三个缺陷都是静默失效：去重缓存毒化整个目录、`startsWith` 把兄弟目录当项目内、
  中文标点吞掉 `@import`。前两个已修，第三个截至 2026-08-06 仍未修。
- 代价：JIT 与 prompt cache 方向直接对立，且这个取舍不是普适最优。
- 只想知道怎么把规则写对 → 直接跳 [怎么把规则写对](#怎么把规则写对)。
:::

Anthropic 在
[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
里把"运行时按需拉数据进上下文"叫 just-in-time，并点明 Claude Code 走混合策略：
`CLAUDE.md` 启动时直接塞进上下文，`glob` / `grep` 负责运行时按需取文件内容。

sid-code 走同一条路，但把"按需"推得更远：不只文件内容按需取，规则本身也按需注入。
下面从约束推起——这套机制的形状不是选出来的，是被逼出来的。

## 约束：全量加载要付多少

最省事的做法是启动时把项目里所有 `CLAUDE.md` 一次读完、全塞进系统提示词。
在这个仓库里（2026-08-06 实测，`estimateTextTokens` 口径）：

| 规则文件 | 体积 | 估算 token |
| --- | --- | --- |
| `CLAUDE.md`（项目根） | 19.2 KB | ≈ 4,154 |
| `src/ui/CLAUDE.md`（TUI 规范） | 31.5 KB | ≈ 6,811 |
| `docs/summary/CLAUDE.md` | 4.4 KB | ≈ 956 |
| 合计 | 55.0 KB | ≈ 11,921 |

一万二千个 token，每一轮请求都要重新发一遍。而绝大多数任务只会碰到其中一份。
写文档时那 6,811 token 的 TUI 规范一条都用不上，但它每轮都在收费。

这张表值得停一下。**上一版这篇同一张表写的是 26.7 KB / 10,561 token——四天后重量，
已经长到 55.0 KB。** 规则文件是活的，把体积写死在文章里必然过期，
所以下面每一处数字都带测量日期。

### 钱不是最麻烦的部分

无关规则会主动干扰模型。踩过一次真实的：在 `website/` 做文档任务，
上下文里被塞进了 `src/ui/` 的 TUI 组件规范，模型连续 6 次在回复里自述
"注入的规范与当前任务无关"——它不但没帮上忙，还占着模型的注意力反复自我解释。

规则之间还会互相矛盾。`src/ui/` 要求"状态靠排版不靠颜色"，
`website/` 要求"配色走 theme 变量"——单独看都对，同时出现模型就得猜。

所以目标不是"尽可能多给规则"，而是在正确的时刻给正确的规则。

## 唯一解的形状：两条路径，而不是一条

先看最直觉的做法：既然要按需，那就全部按需，启动时什么都不加载。这条路立刻撞墙——
整场会话不触碰任何文件的任务（纯对话、纯规划）永远拿不到项目根的 `CLAUDE.md`，
而那恰恰是最该无条件生效的一份。

反过来全部启动加载，就退回上一节那 11,921 token。所以只能是两条路径，分工明确：

| | 启动加载 | JIT 发现 |
| --- | --- | --- |
| 时机 | 会话启动时一次 | 每轮工具调用后按需 |
| 判定依据 | 你在哪工作 + 你在改什么 | 工具实际访问的文件路径 |
| 覆盖范围 | 企业 → 全局 → 用户 → 项目根 → 子目录 → `.claude/rules/` → `CLAUDE.local.md` | 被访问路径向上到项目根的整条目录链 |

启动加载负责"一定要有的"：项目根 `CLAUDE.md`、全局个人偏好、企业下发的强制约束。
这些不依赖任何运行时信号。

JIT 负责"用到才给"。**agent 读了 `src/ui/Footer.tsx`，`src/ui/CLAUDE.md` 这一刻才被
发现并注入；没碰过这个目录，这份规范整场会话不出现。** 后面全部是这一句的细化。

## 触发面：从硬编码名单到工具自报

工具执行完一轮后，harness 检查这批工具访问了哪些路径，向上遍历到项目根，
每一级检查 `CLAUDE.md` / `.claude.md` / `claude.md` / `.claude/CLAUDE.md` /
`.claude/instructions.md` / `CLAUDE.local.md`，以及 `.claude/rules/**/*.md`。

读了 `src/ui/components/Footer.tsx`，扫描链是
`src/ui/components/` → `src/ui/` → `src/` → 项目根，链上任何一级有规则文件都会被拾起。

"哪些工具该触发"有过一次返工。原实现在 `app.ts` 里硬编码了一份名单：
`["read", "write", "edit", "grep", "glob"]`。而现在实现了路径自报的文件类工具是 10 个
（2026-08-06 实测，扫 `src/tool/*.ts`）——`read_many` / `notebook_edit` / `ls` / `lsp` /
`bash` 五个全部漏在旧名单外面。**硬编码名单和真实注册的工具之间没有对账机制，
新增工具必然漏。**

现在改成工具自报：每个工具实现一个 `jitAffectedPaths(input)` 纯函数，
声明"我这次调用碰了哪些路径"，再由 `tests/tool/jit-affected-paths-audit.test.ts`
双向对账，漏报让 CI 变红。

这里刻意不做"按 `file_path` / `path` 字段名猜"的兜底。猜测式兜底会把非文件语义的
同名字段（`web_fetch` 的 url、MCP 工具的 path 形参）误当本地路径去 stat；
而漏报的代价是 CI 可见的——所以这里选 fail-closed。

### bash：只认高确定性形态

一条 shell 命令碰了哪些路径，静态看不出来。做法是只认几个高确定性形态，
其余一律不报（2026-08-06 直接调 `src/tool/bash.ts` 的 `jitAffectedPaths` 实测）：

```text
cat > src/ui/Badge.tsx <<EOF     → ["src/ui/Badge.tsx"]
sed -i '' 's/a/b/' src/ui/F.tsx → ["src/ui/F.tsx"]
echo hi | tee -a src/api/log.txt → ["src/api/log.txt"]
echo x > "src/my dir/a.ts"       → ["src/my dir/a.ts"]
echo x > $OUT                    → []   变量，运行时才知道
echo x > /dev/null               → []   不是业务文件
cp src/a.ts src/ui/b.ts          → []   语义复杂，刻意不支持
```

为什么宁漏不误：误报的代价是烧 token + 可能让模型遵循错误规范，
漏报只是回到改造前的状态。**两者不对称，所以往保守一侧倒。**

### glob：从 pattern 提取静态前缀

`glob("src/ui/**/*.tsx")` 不带 `path` 参数时，原实现拿不到目录信息，
退化成扫项目根——目标目录的规范拿不到。现在从 pattern 里提取静态前缀：

```text
glob{pattern:"src/ui/**/*.tsx"}   → ["src/ui"]
glob{pattern:"src/api/*.ts"}      → ["src/api"]
glob{pattern:"**/*.ts"}           → []
grep{path:"src",pattern:"ui/**"}  → ["src"]
```

最后一条值得单独交代，因为**这篇文章的上一版把它写错了**：旧版称 `grep` 会同时报
`["src","src/ui"]`。回源码一查不是这样——`src/tool/grep.ts:88` 明确只取 `path`、
刻意不解析 pattern，因为 grep 的 pattern 是正则不是 glob，
把 `src/\w+\.ts` 送进 glob 前缀提取会得到伪目录。

## `paths:` 作用域：同一份规则，两条路径判定方式不同

规则文件可以在 frontmatter 里声明作用域。这个仓库的 `src/ui/CLAUDE.md` 就是：

```markdown
---
paths: ["src/ui/**", "src/ink/**"]
---
```

意思是：这份规范只在处理 `src/ui/` 或 `src/ink/` 下的文件时才该出现。
两条路径判定"命中"的方式必须不同，因为它们手上的信息不一样。

### JIT 侧：拿真实的活动文件判

JIT 手里有确切信息——被访问路径就是 agent 这一刻真正在读写的文件，拿它跟 `paths`
直接比：读 `src/ui/Footer.tsx` 命中并注入，读 `website/index.md` 不命中并跳过。
**作用域 = 我此刻正在动的文件，这是 `paths` 语义最干净的一次判定。**

### 启动侧：没有"活动文件"，得先构造信号

启动时 agent 还没碰任何文件。如果这时候对所有带 `paths:` 的规则一律拒绝，
就留下一个坑：整场会话不触碰该目录的任务永远拿不到作用域规则。

所以启动侧自己采集两个信号：cwd 目录标记（你在哪工作）与 git 变更文件（你在改什么）。
在一个受控 fixture 里实测三种启动位置，规则是 `paths: ["src/ui/**"]`：

```text
cwd=项目根，工作区干净
  活动信号 = []
  注入 src/ui 规则 = false   ← 只能靠 JIT 运行时发现

cwd=项目根，src/ui/Badge.tsx 未提交
  活动信号 = ["src/ui/Badge.tsx"]
  注入 src/ui 规则 = true    ← git 信号命中

cwd=src/ui，工作区干净
  活动信号 = ["src/ui/", "src/ui/Badge.tsx"]
  注入 src/ui 规则 = true    ← 目录标记命中

cwd=docs，工作区干净
  活动信号 = ["docs/"]
  注入 src/ui 规则 = false   ← 正确落空
```

两个信号各补对方的盲区。目录标记只能满足 `dir/**` 形状的规则，
`paths: ["**/*.py"]` 这种按扩展名收窄的作用域光有目录标记一律不匹配；
反过来，还没开始改文件时只有目录标记能说明你在哪。

### 三个只能靠实测钉住的实现细节

把 glob 语义实测一遍就清楚第一个（2026-08-06，`Bun.Glob`）：

```text
Glob("src/ui/**").match("src/ui")          → false
Glob("src/ui/**").match("src/ui/")         → true
Glob("**/*.py").match("src/")              → false
Glob("src/ui/**").match("src/ui/READ.md")  → true
Glob("src/ui/**/*.tsx").match("READ.md")   → false
```

目录标记必须带末尾 `/`。**少这一个字符，整个信号静默失效**——不报错、不告警，
只是作用域规则再也匹配不上。

第二个：git 变更必须按 cwd 收窄，只取当前工作目录子树内的变更。这正是前面那起
"website 里被注入 TUI 规范"事故的修法——这类仓库里 `src/ui` 常有未提交改动，
取全仓变更会让那份 TUI 规范在任何目录下都被拉进上下文，等于换个入口重演事故。

第三个在采集命令里（`src/config/rules.ts:347`）：

```bash
git --no-optional-locks status --porcelain -z -uall
```

`-uall` 是必需的。默认的 `-unormal` 会把未追踪目录折叠成 `website/` 一条，
新文件的扩展名根本不出现在输出里——于是 `paths: ["**/*.py"]` 对新建的 Python 文件
一律失配，恰好是最该命中的场景。

顺带一条设计取向：git 不可用时采集结果退回到"仅含 cwd 标记"而不是"匹配一切"。
收窄注入面是这套机制的目的，采集失败就该倒向更保守的一侧。

## 实测基线

这套机制自带埋点，每次发现都记一条 `jit_context` 事件，无论命中与否——
只在命中时打点会让分母永远缺失，算不出覆盖率。

```bash
bun scripts/jit-context-stats.ts --all --by-file
```

2026-08-06 实测，扫 30 个会话（5 个早于埋点上线、12 个有 JIT 数据）：

| 指标 | 值 | 怎么读 |
| --- | --- | --- |
| 命中率 | 0.7%（2 / 283 次触发） | 分母是每一次文件访问 |
| 均次注入 | 125 B | 单次很轻 |
| 浪费率 | 25.0%（跳过 1 / 扫到 4 份） | 作用域判定的"空转"占比 |
| 累积字节 P50 | 9.5 KB | 每轮全量携带的成本 |
| 累积字节 P95 / MAX | 25.0 KB | 上限 |
| 发现耗时 P50 / MAX | 1 ms / 12 ms | 不在关键路径上 |

归因分布 `nested_traversal × 2`、`path_glob_match × 1`；通道分布 `main × 283`、
`subagent × 0`。排行榜上最吃上下文的两份是 `src/ui/CLAUDE.md`（17.4 KB）
与 `CLAUDE.md`（9.5 KB）。

P95 = 25.0 KB 意味着**淘汰机制现在不该做**。25 KB 的常驻量还构不成成本压力；
先写一套 LRU 淘汰再去找数据证明它合理，是把顺序做反了。

命中率 0.7% 不是缺陷。分母是"每一次文件访问"，而绝大多数文件所在的目录本来就没有
规则文件。这个数字的用途是当异常哨兵——掉到 0 说明边界判定或触发面出了问题。

`subagent × 0` 容易被读成"子代理埋点坏了"。回源码核验：`src/agent/sub-agent.ts:479`
确实在发同一个事件，所以 0 的含义是这个窗口没有子代理触发过 JIT，不是埋点缺失。

### 这篇文章自己的数据漂移了 52 倍

上一版这篇写的是"19 个会话、累积字节 P50 = 186 B、P95 = 17.4 KB"。四天后重跑
同一条命令，只剩 12 个会话，**P50 从 186 B 变成 9.5 KB——52 倍**。

数字没错，是窗口移动了：`~/.sid-code/` 下的轨迹是滚动窗口，旧会话被清理。
而漂移的幅度恰好证明了当时那条定性结论：JIT 的成本不是均匀摊开的，是二值的——
上个窗口多数会话根本不碰 `src/ui/`，成本接近零；这个窗口碰上了，
那份 31.5 KB 的 TUI 规范就常驻上下文直到会话结束。

所以结论要写成能跨窗口成立的形态。"命中率个位数百分比、多数触发落在无规则目录"
换个窗口依然成立；"命中 19 次"第二天就过期。你跑出来的数一定和上表不同。

## 怎么把规则写对

机制的部分到这里够用了。这四条不看实现也能直接照做。

**规则放在它约束的代码旁边。** `src/ui/` 的组件规范就放 `src/ui/CLAUDE.md`。
这样它的作用域天然正确，连 `paths:` 都不用声明——agent 碰这个目录才注入。
目录结构本身就是最好的作用域声明。

只在跨目录约束时用 `paths:`。"所有 Python 文件必须带类型标注"没有自然的目录归属，
就放项目根并声明 `paths: ["**/*.py"]`。

规则要写得能被检验。"代码要优雅"没有任何约束力；"禁止彩色 emoji，状态靠排版表达"
可以——模型能判断自己有没有违反，你也能。

规则不生效时，先怀疑它不在上下文里，再怀疑模型。排查顺序：

1. 这轮 agent 碰过那个目录下的文件吗？没碰 → JIT 不会发现它，符合预期
2. 规则文件有 `paths:` 吗？拿实际访问的文件路径手动比一下 glob——
   注意 `src/ui/**` 匹配 `src/ui/README.md`，但 `src/ui/**/*.tsx` 不匹配
3. 规则是刚改的吗？子目录规则要再次触达该目录才重读
4. 规则里有 `@import` 吗？后面紧跟中文标点的话，那条导入现在是坏的

四步走完还是不生效，那才轮到"模型没遵守"这个判断。

## 三个只能靠实测发现的缺陷

这几类缺陷有共同特征：不报错、不告警，只是静默地不生效，读代码看不出来。

### 一次正确的跳过，永久毒化整个目录

JIT 每轮工具调用都跑，必须去重。天然的做法是缓存两个集合：
已加载的文件、已扫描的目录。

但"已扫描"这个状态和作用域判定放在一起会出问题。用 `paths: ["src/ui/**/*.tsx"]`
构造一个序列（README 不匹配 `.tsx`，Footer 匹配）：

```text
1. 读 src/ui/README.md  → 扫 src/ui/ → 作用域未命中 → 跳过
2. 读 src/ui/Footer.tsx → src/ui/ 已在"已扫描"集合 → 直接返回
                        → 规则永远拿不到 ✘
```

第一步的跳过是对的——`README.md` 确实不该触发 `.tsx` 组件规范。但如果因此把
`src/ui/` 记成"已扫描"，第二步那个本该命中的文件就再也没机会拿到规则了。

修法是把两种"没注入"分开：链上候选全处理完才登记为已扫描；
有规则因作用域未命中被跳过则不登记，留待下次触达重新判定。

在 fixture 里复现同一序列（2026-08-06，直接调 `discoverDetailed`）：

```text
读 src/ui/README.md   hit=true  scopeSkipped=1
  loaded = proj/CLAUDE.md[nested_traversal]
读 src/ui/Footer.tsx  hit=true  scopeSkipped=0
  loaded = ui/CLAUDE.md[path_glob_match]   ✔
```

这类缺陷的共同特征：**去重缓存和条件判定耦合在一起时，"这次不适用"会被误存成
"以后都不用看"。**

### 字符串前缀不是路径段

JIT 向上扫描时必须在项目根停住。停止条件最初是这样写的：

```js
while (currentDir.startsWith(projectRoot)) {
```

`startsWith` 是字符串前缀比较，不是路径段比较。`/tmp/proj-evil` 确实以 `/tmp/proj`
开头——于是项目根是 `/tmp/proj` 时，兄弟目录 `/tmp/proj-evil` 被判定为"在项目内"，
它的 `CLAUDE.md` 被当作本项目规则注入。触发形态在日常开发里很常见：
`sid-code` / `sid-code-old`、`proj` / `proj-worktree`、monorepo 里的 `app` / `app-legacy`。

放大危害的是**用户看不见注入内容**。JIT 是 harness 静默注入的内部上下文，
终端里不显示；泄露了也无从发现，你只会偶尔觉得 agent 行为有点怪。

修法是把判据换成路径段，并叠加 realpath 解引用（`src/config/jit-context.ts:268`）：

```js
const rootWithSep = realRoot.endsWith(sep)
  ? realRoot : realRoot + sep;
const isInsideProject = (dir) =>
  dir === realRoot || dir.startsWith(rootWithSep);
```

`dir === realRoot` 单独列出是必要的：项目根自己不以 `projectRoot + sep` 开头，
只写后半条会把项目根本身排除掉。

两个判据缺一不可：只做路径段比对会被 symlink 绕过（`proj/vendor → /other/pkg`），
只做 realpath 会被 `proj-evil` 这类字符串前缀兄弟目录绕过。而且向上遍历时
每一步都要重新 realpath——只在入口解引用一次，挡不住"入口在项目内、
祖先链爬出项目外"这种形态。

fixture 复现（`proj` 与 `proj-evil` 并列，后者规则里埋了标记串，2026-08-06）：

```text
projectRoot = /tmp/jitlab/proj
访问        = /tmp/jitlab/proj-evil/src/a.ts

hit=false  loaded=0  elapsed=0.25ms
注入内容含 EVIL_RULE_LEAKED = false   ✔
```

顺带一个发现：把 Claude Code 的同段循环逻辑抽出来实测，同样的输入也会把
`/tmp/proj-evil` 纳入扫描目录——这是一条上游同样存在的缺陷。

### 中文标点会吞掉 `@import`

这条是写这篇时顺手撞出来的——跑一个无关的探针脚本，日志里蹦出一行告警：

```
⚠ [IMPORT] 导入文件不存在: .../src/ui/jrichman）。**cc
```

`jrichman）。**cc` 显然不是路径。定位到 `src/ui/CLAUDE.md:209`：

```markdown
> **渲染底座 = vendor 进 `src/ink` 的 ink fork**（已脱离
> node_modules 的 `@jrichman/ink`）。cc 的渲染能力**本项目都有**……
```

规则文件支持 `@path/to/file` 语法导入其他文件。提取时会剥掉尾随标点
（`src/config/import-processor.ts:116`）。但这里的 `@jrichman/ink` 后面跟的是
`）。**cc`——中间夹了非标点字符，剥不掉。

构造最小用例，用一个真实存在的 `NOTE.md` 测各种标点形态
（2026-08-06 直接调 `processImports` 实测，缺陷仍然存在）：

```text
see @NOTE.md, then go     ✔  英文逗号 + 后续文字
详见 @NOTE.md，            ✔  中文逗号在句末
见 @NOTE.md，然后继续       ✘  中文逗号 + 后续文字
见 @NOTE.md。然后继续       ✘  中文句号 + 后续文字
（已脱离 @NOTE.md）。**后续  ✘  括号 + 句号 + 强调
```

英文标点后接空格，路径 token 到空格就断了；中文标点不需要空格，
于是标点连着后面的字一起被吞进路径。规则文件本身就是中文写的，
**这个形态在这个仓库里不是边角情况。**

好在失效方向是安全的：导入不成功，原文照样保留在上下文里，只是少了展开的那部分，
并留下一行告警。但如果不是恰好跑了那个探针，这行告警会一直被日志噪音盖着。
截至 2026-08-06 仍未修，绕法在末尾的边界表里。

## 追加式注入需要一个单一收口

JIT 注入的实现方式是把规则块追加到系统提示词末尾。这带来一个必然的副作用：
任何"覆盖式重建系统提示词"的操作都会把它整体抹掉。

覆盖式重建的入口不少：`/model` 切模型、`/language` 切语言、`/memory reload`、
`CLAUDE.md` 变更触发的重建、压缩后重建——每一个都是 `setSystemPrompt(newPrompt)`。

更麻烦的是抹掉之后不会自愈。JIT 的去重集合里已经把那份文件记为"已加载"，
后续再访问同一目录也不会重新注入，规则就此永久丢失直到进程重启。用户视角看到的是：
前半场会话规则好好生效，切了一次模型之后突然不遵守了，且没有任何提示。

第一版修法是在 App 里守一个 `applySystemPrompt`，要求所有重建都走它。这个方案漏了——
`/memory reload` 拿到的是 `ctxMgr`，直接调裸 `setSystemPrompt` 就绕过了收口。
**靠纪律维持的收口必然漏网**：它把"别漏"的责任推给了新增入口的人。

第二版把回灌下沉进 `ContextManager.setSystemPrompt` 本身（`src/context/manager.ts:559`）：

```ts
setSystemPrompt(prompt: string): void {
  let finalPrompt = prompt;
  try {
    const blocks = this.jitBlocksProvider?.() ?? [];
    const missing = blocks.filter(
      (b) => b && !prompt.includes(b),
    );
    if (missing.length > 0)
      finalPrompt = prompt + "\n\n" + missing.join("\n\n");
  } catch {
    // 回灌失败不能阻断提示词写入
  }
  this.systemPrompt = finalPrompt;
}
```

现在没有可绕过的路径：所有写入者共享同一个不变量，新增入口不必知道 JIT 的存在。
逐块判定保证幂等——重复注入会让模型看到两份可能已经不一致的内容。实测：

```text
边界位置=5   JIT位置=78
JIT 落在动态区（缓存边界之后） = true
重建 3 次后 JIT 块出现次数 = 1        ← 幂等
裸调 setSystemPrompt 后自动回灌 = true ← 无旁路
```

差别在责任的位置：守一个 `applySystemPrompt` 是把不变量交给调用方维护，
下沉到 `setSystemPrompt` 是让不变量由持有状态的那个类自己保证。
前者的漏网数量随入口增长，后者恒为零。

## 张力：JIT 与 prompt cache 互相冲突

JIT 是"按需追加系统提示词"，prompt cache 是"系统提示词前缀不变才能命中"。
这两件事在方向上直接对立，而两者服务的是同一个北极星方向——省。

sid-code 的系统提示词按一个边界标记切成两区：静态区打缓存断点，动态区（日期、
git 状态这类每次都变的内容）放在边界之后。上面那组实测确认 JIT 注入落在动态区，
所以它不会击穿整个前缀缓存。但新注入发生的那一轮，动态区内容变了，那部分要重算。

**这是个真实的成本，不是零。** 它换来的是无关规则不进上下文（省下的是每一轮的钱），
以及规则不互相干扰（省下的是模型的注意力）——JIT 为"精准"牺牲了一点"缓存命中"。

而"落在动态区所以不击穿前缀"只对 Anthropic 族完整成立。OpenAI 族没有分段能力，
动态区被搬到了消息序列末尾——那正是 JIT 追加内容的位置，所以每次新注入都会让
该位置之后的前缀本轮断裂。完整对比在
[Prompt Cache：两族协议的分叉](/blog/prompt-cache)。

这个取舍也不是普适最优。规则文件少且都是项目级无条件规则的仓库里，
启动时一次全量加载、之后前缀完全稳定，反而更省。JIT 的收益随"目录级规范的数量和
分散程度"增长——这解释了上面那个二值分布：碰不到 `src/ui/` 的会话，
JIT 的净收益就是省下 6,811 token 而只付百来字节。

所以它是个可关的开关（全部可配字段见 [settings.json](/ref/settings)）：

```json
{ "jitContext": false }
```

关掉之后，带 `paths:` 的规则只剩启动加载那条路径，运行时发现不再发生。

## 当前的能力边界

旧版列的边界逐条重测了一遍，多数已在后续几批改造里修掉（`bash` 现在触发、
`glob` 现在提取静态前缀、子代理现在走 JIT）。下面这些是 2026-08-06 回源码确认仍存在的：

| 边界 | 具体表现 | 绕法 |
| --- | --- | --- |
| 子目录规则不被监听 | `watchCLAUDEmd` 只收项目根 / 全局 / 企业三个文件 + `.claude/rules/` 目录；会话中途改子目录 `CLAUDE.md` 不会即时重建 | 靠 mtime 兜底——再次触达该目录时会重读；想立刻生效则重开会话 |
| 子代理 JIT 关不掉 | `createJitDiscoverer` 有 `jitDisabled` 参数，但唯一调用点 `sub-agent.ts:537` 从不传它，`jitContext: false` 对子代理无效 | 暂无。影响是"关不掉"而非"不生效"，方向安全 |
| `jitContext` 默认值无单一事实源 | "默认 true"靠三处 `=== false` 的调用约定维持，新增消费点写成 `if (config.jitContext)` 会静默反转默认值 | 改代码时注意 |
| 中文标点吞 `@import` | 见上文，中文标点 + 后续文字会把标点连字一起吞进路径 | 让 `@path` 后跟空格或换行 |
| `bash` 部分形态不认 | `cp` / `mv` / 变量路径 / 命令替换刻意不提取 | 需要规则可靠生效时走 `edit` / `write` |

前三条有个共同点：它们都不是"功能没做"，而是**做了但没接到底**——
参数存在却没穿线、默认值靠约定而非常量、监听范围小于加载范围。
这类缺口比"没实现"更难发现，因为代码里看得见对应的机制。

列在这里不是免责声明。不写出来，用户只会遇到"规则有时候生效有时候不生效"
这种最难排查的现象。

## 一句话

规则能不能约束模型，取决于它在那一刻是否在上下文里——这是工程问题，不是模型问题。
JIT 把"什么规则、什么时刻"做成机制，代价是一点缓存开销和几处需要小心维护的耦合点。

两条比机制本身更通用的教训：去重缓存碰上条件判定，"这次不适用"容易被误存成
"以后都不用看"；追加式内容碰上覆盖式重建，不变量要由持有状态的类自己保证，
而不是靠每个调用方记得。

还有一条方法论上的，这次重写自己撞了两回：**旧文那张体积表和那条 `grep` 会报
两个信号的说法，回源码一查全变了。** 带着证据口气的过期描述比不写更容易骗人。

## 相关

- [Prompt Cache：两族协议的分叉](/blog/prompt-cache) —— JIT 追加内容落在哪个区、
  两族协议为什么算出不同的账，附跨数百会话的命中率实测账本
- [记忆与 CLAUDE.md](/use/memory) —— 七层规则的优先级与作用范围，写规则文件先读这篇
- [上下文与压缩](/use/context) —— 上下文占用怎么看、`/compact` 什么时候该手动跑
- [settings.json 字段](/ref/settings) —— `jitContext` 等全部可配字段与默认值
