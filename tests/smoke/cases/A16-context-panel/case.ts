/**
 * A16 `/context` 输出面板（G4）：真 TUI 里敲 `/context`，面板要真的弹出来、
 * 首屏几块关键内容都在，Esc 能一次关回输入框。
 *
 * ## 为什么要 G4 这一层
 *
 * `context-report.test.ts`（取数）与 `context-render.test.ts`（排版）都是纯函数单测，
 * 它们能证明「给定 report 能排出正确的文本」，但证明不了**这条文本真的走到了屏幕上**：
 * 命令是否标了 `outputPanel`、`executor.resolvePanel` 是否判进面板、
 * `CommandOutputDialog` 是否把它画出来、Esc 是否关得掉——这几段接线任一处断了，
 * 单测都看不见（旧实现是专属 Dialog，接线方式完全不同，正是本次要替换的部分）。
 *
 * ## 为什么先发一轮消息再敲 `/context`
 *
 * 两个原因，都不是凑数：
 * 1. **运行器要求 TUI 会话恰有 1 个会话目录、且能按 session_id 找到轨迹**
 *    （实测：只敲 immediate 命令时 `TUI 会话目录应恰 1 个，实际 0 个`、
 *    `找不到本次会话的轨迹`）——`/context` 自身不落会话轨迹。
 * 2. 面板在有真实历史时才有意义：构成里的「会话」组要有值可看。
 *
 * ## 期望来源
 *
 * 屏幕文本自 PR3 分支构建产物在 PTY 里首次跑通的实测（`bun run smoke:tui` 本用例，
 * 2026-11-18）。断言只取**面板独有**的文案：「上下文用量」取「上下文」三个字会在
 * 命令行回显里也命中，面板没开也会过。
 *
 * ## 为什么只断言首屏
 *
 * 实测这个用例的面板共 41 行，视口 20 行（`1–20 / 41 行`），阈值节在首屏之外，
 * 要 PgDn 才看得到；而 `TuiStep` 的 `key` 只有 `enter/esc/ctrl-c/up/down/tab/shift-tab`，
 * 没有翻页键。等一屏外的内容等于让用例依赖滚动实现的细节。
 * 「四档阈值都在」由 `context-render.test.ts` 的逐行断言守（那是纯排版，测得更准），
 * 这里守的是「命令输出真的进了面板 + 能关掉」这条端到端接线。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "A16-context-panel",
  ledger: "A16",
  feature: "/context 命令输出面板",
  kind: "guard",
  repo: { "README.md": "a16\n" },
  argv: [],
  tui: [
    { kind: "wait", screen: "输入消息或 /help 查看命令", label: "TUI 就绪" },
    // 先跑一轮（回放），让会话轨迹落盘、并让面板里有真实历史
    { kind: "type", text: "你好" },
    { kind: "key", key: "enter" },
    { kind: "wait", screen: "收到，A16 用例开始", label: "一轮结束" },
    { kind: "type", text: "/context" },
    { kind: "key", key: "enter" },
    // 渲染层的第一行。这一步同时证明「命令输出进了面板」而不是被塞进消息流：
    // 消息流里不会有这行标题。
    { kind: "wait", screen: "上下文用量", label: "面板打开（标题行可见）" },
    // 构成分组（B6）：常驻 / 会话两组都要在，且分类明细真的画出来了
    { kind: "wait", screen: "常驻（每轮都带）", label: "常驻分组可见" },
    { kind: "wait", screen: "记忆/CLAUDE.md", label: "分类明细可见" },
    { kind: "wait", screen: "会话", label: "会话分组可见" },
    // Esc 关面板，回到输入框。这一步守「Esc 一次就关」：
    // 关不掉的话用户只能 Ctrl+C 退出整个会话（L4-B：中断要给出路）。
    { kind: "key", key: "esc" },
    { kind: "wait", screen: "输入消息或 /help 查看命令", label: "面板关闭、回到输入框" },
  ],
  expect: {},
  mutations: [
    {
      file: "packages/cli/src/command/commands/context/context.ts",
      find: '    return { type: "text", value };',
      replace: '    return { type: "text", value: "" };',
      why: "命令接线断了：命令照常成功返回，但面板里一个字都没有（单测全绿、屏幕上什么都看不到）",
    },
    {
      file: "packages/cli/src/command/commands/context/context-render.ts",
      find: '  const resident = r.categories.filter((c) => c.group === "resident");',
      replace: "  const resident = r.categories.filter(() => false);",
      why: "常驻组整块不再渲染：用户看不到「每轮都带」的固定成本（B6 的分组白做）",
    },
  ],
};

export default def;
