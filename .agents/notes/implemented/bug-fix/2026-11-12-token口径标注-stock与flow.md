---
Status: implemented
Date: 2026-11-12
Source: /cost 口径不一致与面板重做-修复与验收方案（2026-11-10）
---
# /cost 与 /debug 标出 stock / flow 两种 token 口径，并点明状态栏 ↑ 是哪一个

## 决定了什么

D3：同一个会话里，Footer 的 `↑` 是 **stock**（最后一次请求的完整 prompt = 当前上下文大小，
`SessionState.getStockPromptTokens()`），而 `/cost`、`/debug` 的「输入」是 **flow**
（Σ 每次请求的 prompt，`getTotalUsage().inputTokens` = ΣcumulativePromptTokens）。
取证会话里两个数是 99,126 与 2,398,645（差 24 倍），**两个都对**，但界面上都只叫「输入」，
用户必然以为其中一个算错了。所以这一条**不改数值、只标口径**：

- `packages/cli/src/command/commands/cost/cost.ts`：`Token 用量（汇总）:` 改为 `Token 用量:`，
  第一行写明 `输入（累计发送，flow）`，新增 `当前上下文（stock）` 一行并点明
  「状态栏 ↑ 显示的就是它」；`输出` 标 `（累计）`。
- `packages/cli/src/command/commands/debug/debug.ts`：`入` 标 `（累计发送, flow）`，
  新增 `当前上下文 : X（stock，末次请求的完整 prompt；状态栏 ↑ 同一口径）`。
- `website/use/cost.md`：示例输出同步新版式；口径表把 `输入` 改名并新增
  `当前上下文（stock）` 一行（明确「两者必然不等，不是算错了」）；摘要口径那段与
  「输入比窗口还大」的 FAQ 各补一句指向。
- 新增 `packages/cli/tests/command/cost-token-scope.test.ts`（3 条）。

## 放弃了什么（以及为什么不选）

- **不给 Footer 加文字标签**：Footer 横向空间有限（`src/ui/CLAUDE.md` 的 L2 分层里
  token 段是可以被丢的窄屏段）。在 Footer 上塞「stock/flow」会让本来就挤的状态栏更难读，
  而且窄终端下它第一个被丢，标了也看不到。改由 `/cost`、`/debug` 各一句「状态栏 ↑ 就是它」
  + 官网口径表把两者连起来——这是方案 4.2 节规则 2 的既定做法。
- **不改任一处的取值口径**：曾有把 `/cost` 的「输入」也改成 stock 的想法，被否掉了。
  flow 是「花了多少钱 ↔ 累计喂了多少 token」可比的口径（`getCumulativePromptTokens`
  的注释），预算/单价心算都靠它；stock 是「当前上下文多大」，两者各有用途。
  D3 的病是**没标**，不是数值错。
- **不顺手补千分位**：`/cost` 的 `2398645` 没有千分位是 D5 的范围（同属 PR-B）。
  塞进这个 PR 会把「标口径」和「改数字格式」绑在一起，回滚时得一起回滚。
  本 PR 的 diff 只碰文案与一行新取值（`getStockPromptTokens()`），`/debug` 本来就有千分位。
- **不重做 `/cost` 面板版式**（分区、颜色、进度条）：那是 D15 / PR-B 的范围。
  这里只做最小的口径标注，保证单独合入、单独回滚。
- **不把「口径标注」抽成 core 的共享格式化函数**：两处版式本来就不同（`/cost` 多行、
  `/debug` 单行右对齐），共享函数只能共享字符串片段，收益低于多一个跨包 API 的成本。
  一致性改由测试守：两条用例断言两处都出现 flow/stock 字样且数字与同一组源字段相等。

## 拿什么证明它生效了

- 新增 `packages/cli/tests/command/cost-token-scope.test.ts` 3 条（`/cost` 2 条 + `/debug` 1 条），
  用两次 `updateUsage`（30,000 + 40,000）构造「flow = 70,000 / stock = 40,000」。
  断言包括两处都出现口径字样、都指向状态栏 ↑、数字分别等于两个源字段、两个入口互相对得上。
- 变异自证 2 轮（都确认变红后恢复）：
  1. 把 `/cost` 的 `getStockPromptTokens()` 改成 `getCumulativePromptTokens()`
     （模拟「两行都标了、其实读同一个字段」的假修复）→ 3 条全红，
     报错正文正是 `当前上下文（stock）: 70000`；
  2. 删掉 `/debug` 的「当前上下文」行 → `/debug` 那条红，
     `Expected to contain: "当前上下文 : 40,000（stock"`。
- 相关既有测试 21 pass / 0 fail（`cost-pending-tasks`、`cost-protocol-hint`、`debug-upload-status`）。
- 门禁：`affected-tests:run` 3339 pass / 4 fail —— 4 条全是与本改动无关的 TUI 超时 flake，
  已按仓库要求举证：① 三个测试文件都不 import `cost.ts` / `debug.ts`；
  ② 父仓 `main` 上单跑 `terminal-modes` + `useLoadingIndicator` 31 pass、
  `main-screen-shrink-e2e` 一次 fail(20.1s) 紧接一次 pass(27.99s)；
  ③ 成因是该 e2e 正常耗时 27–28s、测试内 `settle` 上限 30s，慢机余量被吃掉
  （失败栈指向 `submit()` 的「回车被 TUI 瞬时事件吞掉」throw，测试注释与已有记忆都记录了这个 flake）。
- `make build`（exit 0，无 `will always be undefined`）、`lint`、`format:check`、
  `typecheck:gate`（62 处 / 基线 64，无新增）、`lint:boundary`、`lint:command-system`、
  `lint:legacy-tool`、`docs:gen-reference --check`、`website:build` 全部通过。
