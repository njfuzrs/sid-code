---
Status: rejected
Date: 2026-10-02
---
# `/fast` 与 `team_create`/`team_message` 不删、不隐藏、不补做，只守「写着的就是真的」

## 决定了什么

官网参考页上两项「写着但默认用不了」的能力**维持现状**：

- `/fast`：切的是预留开关 `config.fastMode`，已透传到 `packages/core/src/llm/fallback.ts` 的
  `FallbackConfig.fastMode`，但该字段**无消费点**（全仓只有声明与透传两处）。命令描述自标
  「网关对等能力就绪前为预留开关」，执行结果固定附「暂无实际加速效果」尾注。
- `team_create` / `team_message`：`SID_ENABLE_AGENT_TEAMS` 门控、默认关，`shouldDefer = true`；
  关闭时 `team_create` 描述首句是「[实验特性，当前未启用]」，调用直接返回引导错误。

本次只做两件小事：补一条断言锁住 `/fast` 公开描述里的「预留」二字
（`packages/cli/tests/command/tui-fast.test.ts`）；修正 `fast.ts` 注释里过时的
`src/llm/fallback.ts:202` 路径（分包后已不存在，且行号已漂）。

## 放弃了什么（以及为什么不选）

- **删掉 `/fast`**：否。删了等网关支持 fast 档位时要重新加回命令、settings 字段、透传链路；
  而现在它对用户的误导已被描述 + 尾注两处消除，删除换不回任何收益。
- **给 `/fast` 加 `isHidden`**：否。`isHidden` 只在 `packages/cli/src/command/suggestions.ts:42`
  的补全列表里被过滤，`scripts/docs-gen-reference.ts` **不读 `isHidden`**（grep 0 命中）——
  加了之后补全里看不到、官网参考页上照样列着，两处口径反而分裂。要隐藏就得连生成器一起改，
  为一个已经自标「预留」的命令不值。
- **真去实现 fast**：否。是否加速由网关能力决定，客户端没有可对接的端点；
  按模型名单硬编码「谁支持 fast」违反 `rejected/process/2026-07-06-按模型名称硬编码分级规则.md`。
- **默认开启 Agent Teams**：否。本机 69 个会话 `team_create` 调用 0 次，没有真实使用数据前不默认开；
  它会并发起多个子代理、各开 worktree、跑满 15 分钟硬超时，默认开的副作用远大于收益。
- **删掉 `team_*`**：否。关闭态描述已诚实，`shouldDefer` 保证它不进首轮工具列表、不占 prompt；
  保留可发现性与引导错误，开关打开即可用。

## 拿什么证明它生效了

- `grep -rn fastMode packages/core/src packages/cli/src`：消费点只有声明、透传、`/fast` 自身，
  确认「切了不生效」这个事实与描述一致。
- `website/ref/slash-commands.md` 中 `/fast` 行含「预留开关」，`website/ref/tools.md` 中
  `team_create` 行含「[实验特性，当前未启用]」——两处均由源码生成，`docs:gen-reference --check` 绿。
- 防漂移：`tui-fast.test.ts` 新增断言（描述含「预留」）+ 既有的执行结果尾注断言；
  `packages/core/tests/swarm/teammate-mode.test.ts` 既有「关闭时 description 明示未启用」断言。
  变异自证：把 `fast/index.ts` 描述里的「预留」删掉，新断言红。
- 重新评估的触发条件：网关提供 fast 档位，或真实会话里出现 `team_create` 调用需求。
  在那之前，下一次审阅**不必再评估这两项**。
