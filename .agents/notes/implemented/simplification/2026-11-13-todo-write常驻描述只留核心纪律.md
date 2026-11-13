---
Status: implemented
Date: 2026-11-13
Source: 内置工具设计对齐 Claude Code：缺陷、修复与验收方案（2026-11-12）T9 / D6
---

# todo_write 常驻描述只留核心纪律，示例挪到首次调用的结果里

## 决定了什么

`packages/core/src/tool/todo-write.ts` 的 `description()` 从 3801 字符收到 922 字符
（`--dump-tools` 含 schema 的整份定义 8109 → 2114 字节）。常驻层只留三块：
何时用 / 何时不用的判据，以及三条核心纪律——任何时刻保持至少一项 in_progress、
每完成一项立即标 completed、blocked 与 pending 的区别。这三句 todo_gate 依赖模型照做，
`searchHint` 里也各留了一句，任何呈现层级都裁不掉。

正例、反例和边界情况挪进 `FIRST_USE_GUIDE`，拼在**第一次成功写入**的工具结果末尾
（diff 之后），一个会话只付一次。校验失败的错误返回不附——那时还没建成清单，
塞示例会把报错挤出视野。`reset()`（/clear）清掉标记，新会话重新给一次。

## 放弃了什么（以及为什么不选）

- **把示例直接删掉**。方案的写法是「挪进工具结果按需注入」，不是删。这些例子是
  「什么时候该建清单」的唯一具体锚点，常驻层的判据只有抽象的「≥ 3 步」。
- **每次调用都附**。那就不是瘦身，是把常驻成本搬进了另一条每轮都走的通道。
- **按模型下发不同描述**。方案 R8 否决：模型能力会漂移，写死分级是隐患。

## 拿什么证明它生效了

- 字节：基线二进制 `/tmp/sid-bin-subagent-base`（同日 `origin/main` 构建）dump 出
  todo_write 8109 字节；本分支 `make build` 产物 `/tmp/sid-bin-todo-new` 为 2114 字节。
  描述正文 922 字符，低于方案定的 1500 字符门槛。同一份 dump 里 bash / sub_agent
  字节数不变（4073 / 5369）。
- 测试：`bun test ./packages/core/tests/tool/todo-write.test.ts ./packages/core/tests/tool/todo-write-blocked.test.ts ./packages/core/tests/tool/todo-write-wakeup-invalidation.test.ts`
  → 50 pass / 0 fail。新增用例覆盖「校验失败不附、首次附在 diff 之后、第二次不附、
  reset 后重新附」。
- 描述正文里「至少一项 in_progress」「立即标 completed」「blocked」三句都还在
  （`description()` 源码可直接核对）。
- 方案要求的同日双模型 A/B 本 PR 合入前没有跑完，而方案把 todo_write 标为三个工具里
  **风险最高**的一个（todo_gate、T2 后台放行依赖这份纪律，A/B 不通过就不合入）。
  PR 维持 draft，等数据补上再摘。
