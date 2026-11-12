---
Status: implemented
Date: 2026-11-12
Source: /cost 口径不一致与面板重做-修复与验收方案（2026-11-10）
---
# /cost 的「输入」改为归一化互斥三段并统一千分位

## 决定了什么

`/cost` 的 token 段不再直接贴 provider 原始字段，改为统一走
`SessionState.getNormalizedCacheUsage()`（与命中率、省钱、计价同一个归一化事实源），
拆成 **输入·未命中 / 输入·缓存命中 / 输入·缓存写入 / 输入·合计** 四行，
命中与写入为 0 时整行省略；所有 token 数字统一千分位（`toLocaleString("en-US")`）。
`输出` 行保留。

- `packages/cli/src/command/commands/cost/cost.ts`：token 段重写；
  「按模型统计」段的 `input=` 也从裸 `cumulativePromptTokens` 改为逐模型
  `normalizeCacheUsage(...).promptTotal`——否则 anthropic 族会话里分模型之和与
  汇总「输入·合计」对不上（前者是未命中余量，后者含命中/写入）。
- `website/use/cost.md`：示例输出与「每个数字的口径」表按新字段重写，补上三段互斥等式。
- 新增 `packages/cli/tests/command/cost-token-breakdown.test.ts`（4 条）：
  openai 族拆段、anthropic 族不重复计命中、0 值省略、多模型两族混用分模型之和等于汇总。

**与 #760（D3，同批合入）的融合**：D3 给 token 段加了 stock/flow 口径标注
（`输入（累计发送，flow）` / `当前上下文（stock）`），与 D5 改的是同一段代码。融合结果：

```text
Token 用量:
  输入·未命中: 198,709
  输入·缓存命中: 2,199,936
  输入·合计（累计发送，flow）: 2,398,645  ← 全会话累加，每次请求的 prompt 都计入
  当前上下文（stock）: 99,126  ← 最后一次请求的完整 prompt；状态栏 ↑ 显示的就是它
  输出（累计）: 17,440
```

- **D5 的「合计」正好是 D3 的 flow 行**，合并成一行而不是各留一行（两行同值会引出
  「为什么有两个累计发送」的新困惑）；stock 行原样保留，`状态栏 ↑` 的桥梁说明保留。
- 合计行改读 `cacheView.promptTotal`（归一化三段之和），D3 原文读的是
  `getTotalUsage().inputTokens`（ΣcumulativePromptTokens）。两者对 openai 族相同；
  对 anthropic 族后者只是未命中余量，用它会让「三段之和 = 合计」的等式在 anthropic
  族下不成立。这是 D5 修法的必然结果，也是 D3「标口径」在 anthropic 族下更准确的形式。
- D3 的既有测试 `cost-token-scope.test.ts` 断言了旧字段名与非千分位，**属契约被有意
  变更**（D5 明确要求改格式），已同步更新断言；其守护意图（flow/stock 取不同字段、
  两处都标口径、指向状态栏 ↑）全部保留。

没有新增 core 导出，也没有改任何计费/归一化逻辑——`normalizeCacheUsage` 与
`getNormalizedCacheUsage()` 都是既有单一事实源，本次只是让展示层改用它。

## 放弃了什么（以及为什么不选）

1. **放弃「保留原 `输入` 行，另加一行说明它含命中」**。
   说明文字救不了并列数字：用户仍然会拿 `输入` 和 `缓存读取` 相加。而且说明必须
   按协议族分两套（两族语义相反），文案分叉就是下一个 bug 的温床。拆成互斥三段后
   两族同构，加法恒成立，不需要任何协议族判断。
2. **放弃 `/cost --json` 或重做整个面板**。那是方案 PR-B 的范围（数据层
   `buildCostReport` + 渲染层分离、分区版式）。本 PR 只修 D5 这一条显示缺陷，
   保持一个可独立回滚的小单元；面板重做会顺带改 D6/D11–D15，混进来 review 不了。
   因此也**没有**抽公共 `fmtNum`：仓内 `debug.ts` / `StatsDialog.tsx` /
   `ContextDialog.tsx` 各有一份同款实现，抽公共函数会波及这些无关文件；
   等 PR-B 重做时统一收敛更合适。
3. **放弃在按模型统计行直接贴 `cumulativePromptTokens`**（原实现）。它在 openai 族
   等于 `promptTotal`，但 anthropic 族只是未命中余量，两族混用的会话里分模型之和
   会小于汇总「输入·合计」，正是 D5 要消灭的那类「看起来对不上」。
   逐模型过一遍归一化只多一次纯函数调用，没有性能顾虑。
4. **放弃把「缓存命中率」的 `60-70% 上限` 文案一起改**。那是 D6（另一条 P1，
   需要按实测数据重写判据与官网整节），与本条无代码依赖；绑在一起会让 D5 的
   上线速度由 D6 的取证决定。

## 拿什么证明它生效了

- `bun test ./packages/cli/tests/command/cost-token-breakdown.test.ts`：4 pass / 0 fail。
- 变异自证两轮（均已恢复）：
  - 把「未命中」改回 `cacheView.promptTotal`（模拟旧口径）→ 2 fail，
    报 `Expected to contain: "输入·未命中: 198,709"` / `Received: "输入·未命中: 2,398,645"`，
    正是缺陷现场的「输入含命中」。
  - 去掉 `fmtNum` → 2 fail，报 `输入·未命中: 198709` / `1000`（无千分位）。
- 既有 `/cost` 测试回归：`cost-protocol-hint.test.ts` + `cost-pending-tasks.test.ts`
  一起跑 19 pass / 0 fail。
- 门禁：见 PR 正文（`affected-tests:run`、`make build`、`lint`、`format:check`、
  `typecheck:gate`、`lint:boundary`、`docs:gen-reference --check`、`website:build`）。
- 未做 `sc-dev` 真实会话验证：本机没有可用模型凭据，判据落在 G1 用取证会话的
  真实数字（累计 2,398,645 / 命中 2,199,936 / 未命中 198,709 / 输出 17,440）。
