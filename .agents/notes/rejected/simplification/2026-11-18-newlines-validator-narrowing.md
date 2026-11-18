---
Status: rejected
Date: 2026-11-18
Source: auto 权限档误报弹窗与分类器缺用户意图 —— 修复与验收方案（2026-11-17）§2.9 / §4.4
---
# 不收窄 `validateNewlines`：它是「解析差异」形态的唯一兜底，且误报收益从未被量化

## 决定了什么

**否决「把 `validateNewlines`（`injection:newlines`）收窄到只扫命令段 / 只扫它独有的形态」这个修法**，
`validateNewlines` 的判定面维持现状，原计划的收窄 PR（方案里的 PR3）**不开**。

核实发生在 2026-11-18，结论是方案 §4.4 的**结局 B**：关掉 `validateNewlines` 之后，
存在第二段命令没有任何一层拦得住。收窄会把这类形态一起放掉，所以不改。

PR1（#915）只做了「把校验器内部的 heredoc 正文剥离移到入口统一处理」，
那一步对 shell 脚本正文是**收紧**，不是收窄判定面；本文否决的是后半步。

## 放弃了什么（以及为什么不选）

### 候选：按「命令段」收窄（只扫剥掉数据正文后的 `stripped`）

看起来收益很大：`injection:newlines` 在冻结语料里命中 **1,317 条**，其中绝大多数是
多行命令（`bun test` 的换行输出、`git commit -m` 的多行 message）——每一条都是一次
无意义的确认弹窗。直觉上「数据正文里的换行不该报」是对的。

但它与当时的真实拦截能力**直接冲突**。关掉 `newlines` 后逐条跑
`PermissionChecker.check`（`default` / `auto`（假分类器判 safe）/ `always-allow` 三档）：

```
(echo hi⏎rm -rf /)      --off + always-allow → allowed=true
                        --off + auto(safe)   → allowed=true
第二段单独跑             → danger:递归删除根目录（critical）
```

同类还有 `echo hi⏎(rm -rf /)`、`(echo hi)⏎(rm -rf /)`。也就是说：

- `newlines` 是这些形态**唯一**的兜底层；
- 收窄它等于把「唯一兜底」也拿掉，而这些形态在 always-allow 档会真的删目录。

**归因对照**（这一条决定了修法不能只改 newlines）：`(echo hi; rm -rf /)`、
`(rm -rf /)`、`if true; then rm -rf /; fi` 在 baseline（`newlines` 生效）下**就已经漏**。
所以真正的缺陷是危险层的**程序位**（分组 / 关键字占位），`newlines` 只是恰好兜住了
「换行子集」。修法应该是补程序位（D1），不是收窄兜底。

### 为什么「补完程序位就能收窄了」也不成立（2026-11-18 实测）

D1 修复（`( … )` 分组递归展开 + 剥括号 + 跳关键字/函数头）合入后，
上表那批形态已经被危险层接住。但 `newlines` 还剩下**解析差异**这一块没有任何别的层覆盖：

```
r\<换行>m -rf /etc        → injection:newlines~ask   （续行把命令名拆开）
echo hi\<CR>rm -rf /etc   → injection:carriage-return~ask
```

`r\<newline>m -rf /etc` 在 shell 里执行的是 `rm -rf /etc`，而危险层的 token 化看到的
是 `r` + `m` 两个片段——任何「按命令段扫」的收窄都会把它放过去。
这类形态**只能**靠 `newlines` 的原文扫描兜住。

### 为什么「先量化误报再收窄」也没做

收窄的收益（1,317 → 个位数）来自冻结语料的命中分布，而那批语料里**没有标注**
「哪些命中是误报、哪些是真拦下」。把命中数直接当误报数是错的：
`(echo hi⏎rm -rf /)` 也是命中。要收窄就得先有一份人工核过的误报标注集，
这个成本远大于收益，且当时无法证明「收窄后不漏」——见上一条。

结论：**收益未量化 + 兜底不可替代 → 维持现状**。D1 已把「分组/关键字」那半边补上，
`newlines` 的兜底面自然变小；等哪天有了人工核过的标注集，可以重新评估收窄。

## 拿什么证明它生效了

### 1. 攻击形态集三档跑（只读调查，2026-11-18）

20+ 条「第二行才是关键」的命令，在关掉 `validateNewlines` 的本地分支上用完整
`PermissionChecker.check` 跑 `default` / `auto`（假分类器判 safe）/ `always-allow` 三档。
判据写死为**单段对照**：漏 = 多行整体 `allowed` **且** 第二段单独跑 `allowed=false`。

硬证据（原样摘录）：

```
(echo hi⏎rm -rf /)   --off + always-allow → allowed=true
                     --off + auto(safe)   → allowed=true
rm -rf /（单段）      → danger:递归删除根目录（critical）
```

### 2. 复算冻结语料命中数

`cmdpart.ts heredoc_cmds.json` 重放得 `newlines n=1317`，与方案原文一致（不是估的）。

### 3. 分段核对不能当结局 A 的判据

危险层 `expandShellCommand → splitCommandStructure` 与 `bash -x` 实际执行序列比对：
段数不一致 9/20，但**段数一致却失守 4 条**、**段数不一致却守住 4 条**。
所以「解析器分段一致」不能证明「每一段都被拦下」——这也是没有采信
「按解析结果收窄」的原因。

### 4. D1 修复后的剩余价值复核（本次 PR）

```
r\<换行>m -rf /etc        → false  injection:newlines~ask
echo hi\<CR>rm -rf /etc   → false  injection:carriage-return~ask
(echo hi⏎rm -rf /)        → false  递归删除根目录~critical   （D1 已接住）
```

前两条只能靠 `newlines` / `carriage-return`；后一条已由 D1 覆盖。
这组对照说明：**D1 与 W1 不互相替代**，收窄 `newlines` 仍然会漏。

### 数据与探针

方案附件 `20261117-auto权限档-附件/w1-核实结论.md`、`w1-probe.ts`、`w1-shell.ts`、
`w1-mech.ts`、`w1-review.ts`、`w1-d1-confirm.ts`（私有文档库，不入开源仓）。
