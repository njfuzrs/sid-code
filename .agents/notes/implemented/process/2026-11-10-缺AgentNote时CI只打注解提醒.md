---
Status: implemented
Date: 2026-11-10
Source: 质量防线分层专项·总纲 §3.6 与后续规划 PR-8（2026-11-09）
---
# 非平凡改动缺 Agent Note 时，CI 只打注解提醒，不阻断、不发评论

## 决定了什么

- 新脚本 `scripts/note-reminder.ts`：PR diff 里有 `packages/core/src/{query,tool,permission,hook,llm,context}/` 下的文件，但没有任何 `.agents/notes/` 改动时，打一条 `::warning::` 注解，并往 step summary 写一张文件清单。**退出码恒为 0**，取不到 diff 时也只打 warning。
- `ci.yml` 的 lint job 在「G2 用例期望守卫」之后加一步「Agent Note 缺失提醒（只报告）」：`if: pull_request` + `continue-on-error: true` 双保险，复用上一步 fetch 好的两层历史（`--base HEAD^1 --head HEAD`）。
- `tests/scripts/note-reminder.test.ts`（10 条）：判据（六个目录各自触发；相邻同名前缀目录不误报；带 Note 不提醒）、端到端（临时 git 仓里需要提醒时退 0 并打注解；base 不存在时退 0）、CI 接线（在 lint job、`continue-on-error: true`、只在 PR 上、排在期望守卫之后）。
- 这是质量防线专项 M6 左移的第三项（后续规划 PR-8）。

**牺牲**：「更准」只拿到一半。提醒能被无视，「该写没写」照样能合入。换来的是不逼人写空 Note。

## 放弃了什么（以及为什么不选）

- **阻断（缺 Note 就红）**：「非平凡」要语义判断，判据只看目录。阻断会逼人为拼写修正写空 Note 过闸，等于奖励重贴标签，Note 目录也会被稀释。总纲 §3.6 已定为「只报告」。
- **在 PR 上发评论（总纲原写法）**：ci.yml 顶层权限刻意只读（文件头有专门的理由注释）。发评论要给 job 加 `pull-requests: write`；而 fork PR 的 `GITHUB_TOKEN` 不管怎么声明都是只读，外部贡献者的 PR 上一定发不出去。改用 `pull_request_target` 才能拿到写权限，但那会在带 secret 的上下文里跑 PR 代码，风险远大于收益。注解显示在 PR 的 checks 页，不需要任何写权限。**这是对总纲写法的修正**，已回写总纲。
- **监控目录扩到全部 `packages/*/src/`**：误报太多，提醒会被当成噪音。六个目录是主循环、工具、权限、hook、模型调用、上下文，改了几乎总在改行为。要扩就改 `WATCHED_DIRS` 和总纲 §3.6。
- **挂进 pre-commit**：本地已经有 Note 形态校验了。一个只报告的提醒放进 hook，只会在每次提交时刷屏。

## 拿什么证明它生效了

- `bun test ./tests/scripts/note-reminder.test.ts` → 10 pass / 0 fail。
- 变异自证（逐条改坏，看对应断言变红，再还原）：
  - `llm/` 前缀去掉尾斜杠 → 「相邻目录与同名前缀不误报」红。**第一版测试没杀死这条**：相邻目录名是从 `WATCHED_DIRS` 拼出来的，常量写错，期望也跟着错。改成写死六个目录名后才变红；
  - `context/` 改成 `contexts/` → 同一条红；
  - 清单删掉一项 → 「六个目录每一个都会触发」红；
  - 提醒分支 `process.exit(0)` 改成 `exit(1)` → 「需要提醒时…退 0」红；
  - ci.yml 删掉这一步的 `continue-on-error: true` → 「CI 接线…只报告」红。
  全部还原后 10 pass，`git status` 只剩本 PR 的改动。
- 本分支本地跑 `bun run scripts/note-reminder.ts`：输出「没有触及受关注目录」，exit 0（本 PR 不碰那六个目录）。
- 真正上线后的效果，看下一个改这些目录却没带 Note 的 PR，checks 页上有没有出现这条注解。本 PR 自己证明不了。
