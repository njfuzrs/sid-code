/**
 * A17 终端拖拽路径的 shell 转义还原（G4）：真 TUI 里用 bracketed paste 注入
 * 「终端拖拽文件」的两种典型形态，输入框里必须出现还原后的路径，提交后轨迹里的
 * prompt 也不得残留 `\&` 或包裹引号。
 *
 * ## 为什么必须 G4 这一层
 *
 * `dropped-path-unescape.test.ts`（G1）能证明「给定一段转义文本，函数能还原」，
 * 但证明不了**它真的被接进 paste 分支**：`InputArea` 里少调一行、或调用点放在
 * `shouldPlaceholder` 之后导致占位路径先生效，单测都全绿，而真实拖拽一点没修好。
 * 这条接线只有「往真 TUI 的 paste 分支塞一段 bracketed paste、看下一条 prompt」能守。
 *
 * ## 为什么用 `raw` 而不是 `type`
 *
 * 终端把拖拽内容包在 `\x1b[200~…\x1b[201~` 里送进来，`KeypressContext.bufferPaste`
 * 据此合成 `key.name === "paste"`。`type` 是裸字节、且会 `waitFor(原文)`——
 * 既进不了 paste 分支，屏幕上也永远等不到控制序列本身。
 *
 * ## 两种形态都守
 *
 * - 形态 1：`/…/16-Workflow\&Schedule/…`（无引号、`&` 被转义）——Finder 拖拽最常见；
 * - 形态 2：`'/…/My Disk/a.md'`（整条带单引号、内部无转义）——判据 2 的专用回归：
 *   比较对象若取「去引号后的串」会在这里静默漏掉，引号一路留进 prompt。
 *
 * ## 期望来源
 *
 * 输入框文本取自本用例在 PTY 里跑通后的实测屏幕；prompt 断言取自 events.jsonl 的
 * `UserPromptSubmit.data.prompt` 实证（2026-11-18）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseEvents } from "../../lib/assert.ts";
import type { SmokeCase } from "../../lib/types.ts";

/** prompt 必须恰好以这些片段结尾（`${CASE_ROOT}` 前缀由用例仓决定，不写进断言） */
const EXPECTED_PROMPT_SUFFIXES = [
  "16-Workflow&Schedule/0-Workflow-Schedule-个人笔记.md",
  "My Disk/a.md",
] as const;

const def: SmokeCase = {
  id: "A17-dropped-path",
  ledger: "A17",
  feature: "终端拖拽路径的 shell 转义还原",
  kind: "guard",
  repo: {
    "16-Workflow&Schedule/0-Workflow-Schedule-个人笔记.md": "# 个人笔记\n",
    "My Disk/a.md": "a\n",
  },
  argv: [],
  tui: [
    { kind: "wait", screen: "输入消息或 /help 查看命令", label: "TUI 就绪" },
    // 形态 1：Finder 拖拽最常见的形态——无引号、`&` 被 shell 转义成 `\&`。
    {
      kind: "raw",
      text: "\x1b[200~${CASE_ROOT}/16-Workflow\\&Schedule/0-Workflow-Schedule-个人笔记.md\x1b[201~",
    },
    {
      kind: "wait",
      // 强判据：还原没生效时屏幕上是 `16-Workflow\&Schedule`，这里的子串匹配不到（超时失败）。
      screen: "16-Workflow&Schedule/0-Workflow-Schedule-个人笔记.md",
      label: "输入框显示还原后的路径（\\& → &）",
    },
    { kind: "key", key: "enter" },
    { kind: "wait", screen: "已记录拖拽路径一", label: "第一轮结束" },
    // 形态 2：终端给整条路径套上单引号（目录名含空格，空格在引号内不需要反斜杠）。
    { kind: "raw", text: "\x1b[200~'${CASE_ROOT}/My Disk/a.md'\x1b[201~" },
    // 这一步只做同步（引号不影响「去空白后比子串」），引号是否去掉由下方 prompt 断言守。
    { kind: "wait", screen: "MyDisk/a.md", label: "输入框收到带引号形态" },
    { kind: "key", key: "enter" },
    { kind: "wait", screen: "已记录拖拽路径二", label: "第二轮结束" },
  ],
  expect: {
    events: [{ event: "UserPromptSubmit", count: 2 }],
    output: (out) => {
      const sessDir = join(out.configDir, "trajectories/sessions");
      const ids = existsSync(sessDir) ? readdirSync(sessDir) : [];
      if (ids.length !== 1) return `会话目录应恰 1 个，实际 ${ids.length} 个`;
      const eventsPath = join(sessDir, ids[0], "events.jsonl");
      if (!existsSync(eventsPath)) return `找不到轨迹文件 ${eventsPath}`;
      const prompts = parseEvents(readFileSync(eventsPath, "utf8"))
        .filter((e) => e.event === "UserPromptSubmit")
        .map((e) => String(e.data?.prompt ?? ""));
      if (prompts.length !== 2) {
        return `UserPromptSubmit 应 2 条，实际 ${prompts.length} 条：${JSON.stringify(prompts)}`;
      }
      for (const [i, suffix] of EXPECTED_PROMPT_SUFFIXES.entries()) {
        const p = prompts[i];
        if (!p.endsWith(suffix)) {
          return `第 ${i + 1} 条 prompt 应以「${suffix}」结尾，实际「${p}」`;
        }
        if (p.includes("\\")) {
          return `第 ${i + 1} 条 prompt 仍含反斜杠转义（拖拽路径没被还原）：「${p}」`;
        }
        if (p.includes("'") || p.includes('"')) {
          return `第 ${i + 1} 条 prompt 仍含包裹引号（只去了引号中的一半）：「${p}」`;
        }
      }
      return null;
    },
  },
  mutations: [
    {
      file: "packages/cli/src/ui/InputArea.tsx",
      find: "const pathText = unescapeDroppedPath(cleaned);",
      replace: "const pathText = cleaned;",
      why: "接线断了：还原函数不再被调用，粘贴内容原样进输入框（G1 全绿、屏幕上仍是 `\\&`）",
    },
  ],
};

export default def;
