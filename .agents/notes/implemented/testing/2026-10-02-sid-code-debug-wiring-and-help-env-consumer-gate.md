---
Status: implemented
Date: 2026-10-02
---
# SID_CODE_DEBUG 接线到 --debug，并新增「help 环境变量反查消费者」门禁（B27）

## 决定了什么

- `SID_CODE_DEBUG=1`（或 `true`）现在等同 `--debug`：`cli.ts` 组装 config 时
  `debug: values.debug || isDebugEnvEnabled(process.env.SID_CODE_DEBUG)`。取值口径与
  `tui-renderer/_vendor/debug.ts` 一致，同一个变量会同时打开 debug.log 和 ink 的 stderr 日志。
  `help.ts` 的描述改成写清这两种效果，`ref/env.md` 已重新生成。
- 新门禁 `tests/scripts/help-env-consumers.test.ts`：从 `help.ts` 环境变量段解析出全部变量名
  （复用生成器的 `parseHelpEnvVars`，不另写一份解析器），逐个断言在 `packages/{shared,core,cli}/src`
  （排除 `help.ts`、**剥掉注释后**）至少出现一次。
- 扫描范围**排除 `tui-renderer`**。只在渲染层生效、且描述的正是渲染层行为的变量放进 `TUI_ONLY`
  白名单（`SID_DISABLE_TAB_STATUS`、`SID_CODE_DISABLE_MOUSE_CLICKS`）。白名单本身也要过核验：
  每一项必须仍在 help 里、仍被 tui-renderer 读、且主程序不读。
- 顺带改了两处过时注释：`config/schema.ts` 的「37 个成员」改为 32（实际 `HookEventName` 枚举数）；
  `effort.ts` 的标度补上 `xhigh`。
- 扫描结果：help 里共 123 个变量，没有消费者的只有 `SID_CODE_DEBUG` 一个（已接线）；
  另外两个只在 tui-renderer 读、行为一致，进了白名单。

## 放弃了什么（以及为什么不选）

- **从 help / 官网删掉 `SID_CODE_DEBUG`**：用户要的正是这个行为，同族的 `SID_CODE_DEBUG_SSE` 也已存在；
  接线只要几行，而删除要动三处文档。
- **把 tui-renderer 算进扫描范围**：那样 `SID_CODE_DEBUG` 会被判成「有消费者」（ink 读它，但不开 debug.log），
  门禁会正好漏掉它要抓的那个变量。
- **按「作用是否与描述一致」对账**：这需要语义判断，做不成机械门禁。门禁只查有没有消费者，作用对不对靠 review。
- **把门禁做进 `docs-gen-reference --check`**：生成器的职责是「文档 = 源码」，它目前刻意把
  未写进 help 的读取点只列出来、不拦。把方向相反的这条检查塞进去会让两种口径混在一起，所以单独写成测试。

## 拿什么证明它生效了

- 变异自证，三项都转红（`help 里每个变量在主程序源码里都有读取点` 一条 fail）：
  ① 撤掉 cli.ts 的接线；② 在 help 里加一个假变量 `SID_CODE_B27_FAKE`；③ 从 `TUI_ONLY` 删掉一项。
  第一版没剥注释时，变异①**没红**：cli.ts 注释里写着变量名，被当成了消费者，所以补了剥注释这一步。
- 端到端（worktree 构建的二进制，临时 `SID_CONFIG_DIR`）：`SID_CODE_DEBUG=1 ./sid-code -p "回复 ok"`
  写出 502 行 debug.log，首行是 `[CLI] 调试模式已启用`；不设这个变量时不生成 debug.log。
- `bun run affected-tests:run` 3681 pass / 0 fail；`make build` 通过，且没有 undefined 警告；
  lint、format:check、lint:boundary、`docs:gen-reference --check` 都通过。
