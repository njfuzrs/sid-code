---
Status: implemented
Date: 2026-11-18
Source: auto 权限档误报弹窗与分类器缺用户意图——修复与验收方案（2026-11-17）
---
# auto 档分类器按用户授权判定，弹窗说明未放行原因

## 决定了什么

把 auto 档分类器的**判据**从「这个动作有没有副作用」改成「这个动作是否超出了用户的授权」，
并给它唯一一条可信的授权来源——用户亲手输入的原话。

- **新增 `permission/user-intent.ts`（`UserIntentLedger`）**：会话级账本，只由
  `QueryEngine.submitMessage` 在「用户提示被接受且未被 hook 阻塞」之后写入。
  保留会话首条 + 最近 4 条，单条超 1500 字符时保留头 1000 + 尾 500，被挤出的条数记 `omitted`。
  刻意**不从 `messages` 反推**：历史里的 user 角色混着任务通知、系统提醒、tool_result、
  压缩摘要、hook additionalContext——它们是 agent 或外部内容能影响的通道。
- **分类器请求结构**：`<user_intent>` 稳定前缀在前，`<action>` 在后（同一轮内所有分类请求
  共享前缀，吃 prefix cache）。`cwd` 改成这条命令的**实际执行目录**（复用
  `resolveBashCwdForCheck`，与危险路径判定同口径），并补 `workspace` 与 `path_verdict`。
  `SYSTEM_PROMPT` 换成新判据，`reason` 要求写明依据。
- **B2**：`enter_worktree` 实现 `toAutoClassifierInput() { return ""; }`，走 Level 0 零成本通道。
  `exit_worktree` 刻意不加——它的 remove 会丢弃未提交的改动。
- **C2 展示**：`Decision.metadata.autoClassifier` 的四种回退成因经 `AutoFallbackNote`
  透传到确认框，多显示一行「为什么没放行」（`auto 未放行：<理由>` /
  `auto 分类器不可用（…），需要你确认` / `auto 无权放行：命中结构检查 <guard>` /
  `auto 无权放行：命中你配置的 ask 规则`）。
- **接线**：`App` 持有账本（会话级），构造时注入 checker（`setUserIntentLedger`）与
  `QueryEngineDeps.userIntentLedger`；派生 checker 在 `deriveWithConfig` 里**按引用共享**
  （子代理做的事，授权仍来自主会话的用户）；`/clear` 时 `reset()`。

代价（点破）：分类器输入从「一条命令」变成「账本快照 + 一条命令」，每条 bash 分类请求的
输入 token 增加。同一轮内前缀缓存能抵掉大部分，但**跨轮的第一条请求要吃满新增前缀**。
这是「更准」换「更省」的明确取舍——换来的是用户要求过的动作不再每次必弹（§1.3 的 52 条
bash 里，绝大多数都是用户要求过的）。

## 放弃了什么（以及为什么不选）

- **给 `git push` / `gh pr create` 加硬编码放行名单**：看不到用户意图，`git push origin main`
  也匹配得上——这正是「按命令名硬编码」的反模式，§1.3 的 #5（推默认分支）会被一起放掉。
- **放宽 `classifierMayApprove`，让分类器放行 injection 命中**：分类器看到的文本和词法器
  一样，看不出解析差异，放行等于把 §0.3 已排除的那类风险重新引入。
- **把助手文本、工具调用 `description` 也传给分类器**：等于给 agent 一条说服分类器的通道。
  Claude Code 刻意剥掉的就是这一类。
- **会话级缓存分类结果**：本会话 52 条 bash 里只有 2 条重复，收益上限是 2 次调用；
  加入用户意图后缓存键还得带账本哈希，命中率更低。
- **两段式分类（单 token 粗筛）**：每次分类平均只输出 36 token，p50 却有 1,768ms——
  延迟主要在首 token 与往返，粗筛省不掉。
- **分类器判 unsafe 时把拒绝回给 agent 自己绕路**（Claude Code 做法）：那是独立的产品决策。
  用户在场时立刻弹窗比让 agent 绕路更便宜；本次摩擦来自「用户授权过的动作被判 unsafe」，
  修 B1 即可，不需要改回退形态。
- **从 `messages` 历史反推用户消息**：过滤规则漏一类就变成注入通道。只认唯一写入点。
- **把 `<user_intent>` 拼进 system prompt**：system 是常量、意图是会话级变量，
  混进去会让 system 失去「全会话恒定」属性；而把 action 放前面则会毁掉前缀缓存。

## 拿什么证明它生效了

```
bun test packages/core/tests/permission/user-intent.test.ts \
         packages/core/tests/permission/tool-classifier-user-intent.test.ts \
         packages/cli/tests/ui/auto-fallback-note.test.ts
→ 28 pass / 0 fail / 55 expect

bun run affected-tests:run
→ 7990 pass / 9 skip / 0 fail，627 文件（判定为仓库级改动，等于全量）

bun run typecheck:gate   → 当前 62 处 / 基线 62 处，无新增
bun run lint             → 0 warnings / 0 errors
bun run format:check     → All matched files use the correct format
bun run lint:boundary    → 跨包相对路径 0 处；绕过渲染端口 0 处
bun run docs:gen-reference → 6 页参考文档 + llms.txt 已生成
make build               → 自检通过（5 项）
bun run smoke            → 42 例：42 通过，0 失败，0 跳过（binary）
```

**变异自证**（新增断言不是恒绿）：一次注入 3 处变异，3 条对应断言各变红一条，其余 17 条仍 pass：

1. `UserIntentLedger` 挤出策略 `splice(1,1)` → `shift()`（丢首条而非丢中间）
   → `保留会话首条 + 最近 4 条` 变红；
2. `composeClassifierUserMessage` 把 `<action>` 挪到 `<user_intent>` 前
   → `user_intent 在前，action 在后` 变红；
3. 删掉 `enter_worktree.toAutoClassifierInput`
   → `enter_worktree.toAutoClassifierInput() 返回空串` 变红。

恢复后复跑：20 pass / 0 fail。

**未覆盖 / 留给后续**：方案 §7.3 的 2-4（真模型 S2：用户说「创建 PR 并自动合并」后
`git push` / `gh pr create` 不再弹）需要真实模型与 key，属于维护者本机验证；
本次交付的是它依赖的确定性那一半（账本内容、请求结构、工具通道、弹窗文案）。
