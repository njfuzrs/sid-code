---
Status: rejected
Date: 2026-10-13
---
# 否决：allowed-tools 保留「工具白名单」语义，只补名字归一

## 决定了什么

否决。`allowed-tools` 改为 CC 口径的免确认 allow 规则，见
`implemented/architecture/2026-10-13-allowed-tools语义对齐CC-fork判定与工具名归一.md`。

## 放弃了什么（以及为什么不选）

候选：`Registry.filter` 接上 `toInternalToolName`，`Bash(ls*)` 取括号前名字，其余不变。
否决理由：
1. 只修 P2。「写了 allowed-tools 就 fork」（P1）、inline 忽略声明（P5）、fork 不注入 checker（P3）、
   丢失主会话模式（P4）都还在；
2. 白名单语义下 `Bash(ls*)` 只能退化成「整个 bash 可见」，模式信息被丢弃，与声明者意图相反；
3. 从 CC 迁来的命令在两边意思不同，同类故障会以别的形态复发。
同样否决：项目级来源不过滤危险规则（完全照搬 CC）——项目级 = 随仓库分发 = 不可信。

## 拿什么证明它生效了

否决论证的依据：轨迹 `20261013-100055-7eeb1160` 中即使名字归一，fork 子代理仍无 checker，
`bash`/`edit` 会在 B0 分支被 fail-closed（`agent/tool-executor.ts`），单靠归一跑不通该命令。
