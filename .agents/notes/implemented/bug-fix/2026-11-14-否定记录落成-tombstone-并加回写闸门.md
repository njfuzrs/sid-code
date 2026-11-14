---
Status: implemented
Date: 2026-11-14
Source: 记忆提取把 agent 行为固化成经验——根因与修复方案（2026-11-13）
---
# 用户否定过的做法落成结构化 tombstone，回写时必须显式引用它

## 决定了什么

P0-4（MD7）落地。用户说「不要 X」之后，记忆库里第一次有了**结构化的否定记录**，
而不是只靠正文里一句自然语言。

四处改动：

1. **`memory/types.ts`**：`MemoryFrontmatter` / `MemoryHeader` / `MemoryEntry` 新增
   `negates` 字段（指向被推翻的那条记忆 key）。同时给出两个纯函数：
   `isNegationEntry()`（是不是 tombstone）与 `referencesNegation()`（本次写入有没有
   显式引用它）。
2. **`memory/scan.ts` / `memory/store.ts`**：frontmatter 读写两侧同步接上
   `negates`；`formatMemoryManifest()` 在清单里输出 `| negates: <key>` ——
   提取代理看不到这个标记，提示词里的硬规则就没有前提。
3. **`tool/memory.ts`**：`save_memory` 新增 `negates` 参数；新增判据
   `findUnreferencedNegation()`：存在否定记录且 `negates` 指向本次写入的 key 时，
   正文必须**显式引用**该否定记录（写出它的 key，或行首 `推翻：` / `例外：<理由>`），
   否则拒绝并记 `negation_unreferenced`。
4. **`memory/extract/prompts.ts`**：给提取代理加硬规则段——清单里有 `negates:` 时
   不许再把被否定的做法写成流程；要写必须显式引用；用户新的否定表态要用
   `negates` 参数落成 tombstone。

### 判据是结构的，不是语义的（这条必须说清）

「X 是流程」与「不要 X」的语义等价在中文里**无法用字符串判定**（无分词、同义改写空间
无限）。所以本 PR 只做一件能精确判定的事：tombstone 的 `negates` 指向哪个 key，
就往那个 key 的后续写入上挂一道「先引用我」的要求。

**它挡不住**「换个 key 把同样的做法再写一遍」。那部分靠提取提示词的硬规则与人工核实，
不在本判据的承诺范围内。方案文档 P0-4 原文就要求「不要在这条上承诺自动挡住所有回写」，
代码注释与错误文案都照这个口径写。

## 放弃了什么（以及为什么不选）

**放弃一：用 `source` 加第四档表达否定（`user_negation`）。**
方案文档 §7.0 有一句「依赖 PR-2 的 `source`（否定记录本身就是一种 `source`）」，
字面读像是要加一档。否决理由：`source` 的语义是「这条记忆**谁提供的**」，
`user_negation` 回答的是「它讲了什么」——两个维度。混进同一个封闭枚举之后，
`memorySourceRank` / `isIndexVisibleMemory` / 索引过滤三处都要为它写特例，
而这三处本来共用一个朴素的「三档降序」假设。`negates` 单独一列，两个维度各管各的。

**放弃二：从正文里认「不要 / 别 / 禁止」关键词来判定否定记录。**
这正是 P0-4 原文否决的「语义判据」——「不要在这条上承诺自动挡住所有回写」之前一句
就是「中文无分词，同义改写空间无限」。关键词黑名单的失败形态是**双向的**：
`「不要动我的文档」进表就会被「以后甭管我的文档」绕过（漏放行），
而 `「不要忘记跑测试」` 会被误判成否定记录（误拦截）。

**放弃三：把 `negates` 做成数组（一条否定覆盖多个 key）。**
当前取单值。多值需要 frontmatter 支持数组序列化，而 `readFrontmatterFields` 是刻意
只认 `key: value` 的（P2-13：不接受嵌套结构，避免把子键当顶层读）。真要覆盖多条，
写多条 tombstone 即可 —— 代价是多几行文件，收益是解析逻辑不需要第二次改造。

**放弃四（已知边界，不是遗漏）：不给 `edit` / `write` 直写记忆文件加这道闸门。**
后台提取代理的主要写入方式是 `edit`（方案文档 D16：edit 4099 / save_memory 1429），
所以本判据的实际覆盖面有限。这是**刻意的边界**：`edit` 路径的闸门（含截断态、
否定引用）属于 P1-1 的覆盖范围，那里要一并处理「怎么从 `file_path` 反推 key」与
「热路径上读一次记忆目录的成本」。本 PR 的错误文案里写明了这一点，不让读者误以为
`edit` 已经被挡住。

**放弃五：不提供「显式清空 negates」的入口。**
`set()` 里 `negates` 走 `opts?.negates ?? existing?.negates`，`negates: ""` 也被当成
「没给」。撤销否定的正确操作是删掉那条记忆，而不是把它改写成普通记忆 ——
后者会让 frontmatter 里看不出它曾经否定过什么，而判据的存在理由是「这个信息可追溯」。

**放弃六：dream 的「删除/降权与该否定冲突的旧记忆」没做。**
方案文档 P0-4 列了这条，但它需要 dream 的 consolidate 阶段做语义判断（同样无法用
字符串判定），而 dream 当前默认关闭（`autoDream.enabled=false`）。放进本 PR 会让
一个「结构判据」PR 混进一段「语义启发式」，review 时两件事的结论无法分开验证。
留给后续按 dream 的实际使用率决定要不要做。

## 拿什么证明它生效了

**测试**：新增 `packages/core/tests/memory/negation-tombstone-p0-4.test.ts`，15 个用例：

```
bun test ./packages/core/tests/memory/negation-tombstone-p0-4.test.ts
 15 pass / 0 fail / 52 expect() calls
```

覆盖：T-M7（未引用 → 被拒，且**磁盘内容逐字未变**）、T-M7b（写出 tombstone key /
行首 `例外：<理由>` → 放行）、T-M7c（无 tombstone 时同 key 照常、写其它 key 不受影响、
更新 tombstone 自身不被自己挡）、T-M7d（`negates` 落盘 / 归一化三种写法 / 清单可见 /
普通更新不抹掉 negates / 非 feedback 类型拒绝）。

**变异自证（两个方向都做了，这是关键）**：

1. 把 `tool/memory.ts` 的判据改成 `const conflict = null`（删掉闸门）→
   `3 fail`：T-M7 两条 + 「negates 归一化：传 feedback_x / x.md 都能命中同一个 key」。
2. 把 `referencesNegation()` 改成恒 `false`（闸门恒关）→ `2 fail`：
   T-M7b「行首「例外：<理由>」→ 放行」+ 纯函数边界用例。

只做 1 会留下「恒关也能过」的盲区：删掉闸门时放行用例本来就不该红。
两向都红，说明断言真的钉在「该拒时拒、该放时放」而不是只钉了一侧。

**门禁**（全部在 worktree 内跑，跑前先 `bun install` 以避免软链解析到主仓）：

```
bun run affected-tests:run  →  2415 pass / 1 skip / 0 fail（162 文件，44.23s）
make build                  →  编译产物自检 5 项全过
bun run smoke               →  28 例：28 通过，0 失败（binary）
bun run lint                →  0 warnings / 0 errors
bun run format:check        →  All matched files use the correct format
bun run lint:boundary       →  四道门禁通过
bun run lint:command-system →  四道门禁通过
bun run lint:legacy-tool    →  引用 LegacyTool 的生产文件 58 / 基线 58
bun run typecheck:gate      →  当前 62 处 / 基线 62 处，无新增类型错误
bun run docs:gen-reference  →  website/ref/tools.md 已更新（schema 加了 negates 参数）
```

**契约变更导致的测试修正**：`MemoryHeader` 新增必填 `negates: string | null`，
`packages/core/tests/memory/extract-quantify-t1-t3.test.ts` 的手工构造点补了一行
`negates: null`。这是契约变更的必要组成，不是为了让测试变绿而改期望。

**没验证到的**：真实模型会不会在第一次就正确传 `negates`。这属于 G3（真模型冒烟），
本机没有跑；`negates` 的 schema 描述与提取提示词的硬规则是唯一保障，需要一次真实
会话的轨迹来确认它是否被用起来。这一点不假装已经被证明。
