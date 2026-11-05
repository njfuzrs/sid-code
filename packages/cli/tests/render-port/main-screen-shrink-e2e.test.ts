/**
 * 主屏长会话端到端门禁：真实 TUI（PTY 里起 bootstrap.ts）+ 脚本化 mock 模型。
 *
 * 背景：主屏帧几乎恒超视口，帧一变矮底座就整帧重画全部历史（`2J 3J` + 整段 scrollback，
 * 见 packages/tui/src/frame/main-screen.ts 文件头）。所以有两条不变量，单元测试各自绿不代表合起来对：
 *
 * 1. **高频交互零重画**：打字 / Ctrl+U / 开关补全菜单 / 退出提示出现与取消，
 *    组件自己占住高度（hooks/useHeldRows.ts），不让帧变矮。
 *    例外：退格删行让输入框真实变矮，允许 1 次整帧重画（2026-11-05 用户定：输入框高度跟随内容，
 *    删了行框必须缩回，优先于零重画；InputArea 不再占水位）。
 *    曾经的回归：这些操作每次重画 183KB（3000 行历史），且用户上翻 scrollback 会被拉回底部。
 * 2. **画面不留空白块**：每一帧视口里连续空行不超过 MAX_BLANK_RUN。
 *    曾经的回归（2026-11-03 用户报告）：最后一轮前 TodoPanel 收起留下大块空白，
 *    最后一条消息贴着输入框从下往上长。
 *
 * 判定看 PTY 字节：`ESC[2J ESC[3J` 计数（整帧重画指纹）+ xterm 逐个同步帧重放后的视口。
 * 标：起真实 TUI 要几十秒，本地快通道跳过，CI 全量跑。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";

const { Terminal } = xterm as unknown as { Terminal: typeof import("@xterm/headless").Terminal };

const BOOTSTRAP = join(import.meta.dir, "..", "..", "src", "entrypoints", "bootstrap.ts");
const COLS = 100;
const ROWS = 30;
const RESET = "\x1b[2J\x1b[3J";
/** 消息之间的留白是 1–2 行（gap + 历史项间距），3 行以上就是空白块 */
const MAX_BLANK_RUN = 3;

// ── 脚本化 mock 模型（OpenAI 兼容 SSE）：主循环请求按轮次回放，辅助请求短答 ──

const todos = (done: number) => ({
  todos: ["读代码", "改实现", "跑测试"].map((c, i) => ({
    content: c,
    active_form: `正在${c}`,
    status: i < done ? "completed" : i === done ? "in_progress" : "pending",
  })),
});
type Step = { think?: string; tool?: { name: string; args: unknown }; text?: string };
const SCRIPT: Step[] = [
  { think: "先列计划。", tool: { name: "todo_write", args: todos(0) } },
  {
    think: "跑个命令。",
    tool: {
      name: "bash",
      args: { command: "for i in 1 2 3 4 5 6 7 8; do echo line$i; sleep 0.15; done" },
    },
  },
  { tool: { name: "todo_write", args: todos(3) } },
  {
    think: "总结一下。",
    text: Array.from({ length: 30 }, (_, i) => `- 第 ${i + 1} 条总结：改动点与验证方式说明。`).join(
      "\n",
    ),
  },
];

function startMockModel() {
  let mainTurn = 0;
  const enc = new TextEncoder();
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", created: 0, model: "mock", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.endsWith("/chat/completions")) {
        return Response.json({ object: "list", data: [{ id: "mock", object: "model" }] });
      }
      const body = (await req.json().catch(() => ({}))) as { stream?: boolean; tools?: unknown[] };
      const isMain = Array.isArray(body.tools) && body.tools.length > 0;
      if (!body.stream) {
        return Response.json({
          id: "m",
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "探针" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      }
      const step: Step = isMain ? (SCRIPT[mainTurn++] ?? { text: "完成。" }) : { text: "好" };
      const stream = new ReadableStream({
        async start(ctrl) {
          const send = (s: string) => ctrl.enqueue(enc.encode(s));
          send(chunk({ role: "assistant", content: "" }));
          for (const ch of step.think ?? "") {
            send(chunk({ reasoning_content: ch }));
            await Bun.sleep(25);
          }
          for (let i = 0; i < (step.text ?? "").length; i += 2) {
            send(chunk({ content: step.text!.slice(i, i + 2) }));
            await Bun.sleep(15);
          }
          if (step.tool) {
            send(
              chunk({
                tool_calls: [
                  {
                    index: 0,
                    id: `call_${mainTurn}`,
                    type: "function",
                    function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) },
                  },
                ],
              }),
            );
            send(chunk({}, "tool_calls"));
          } else {
            send(chunk({}, "stop"));
          }
          send(
            `data: ${JSON.stringify({ id: "m", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } })}\n\n`,
          );
          send("data: [DONE]\n\n");
          ctrl.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
}

// ── 驱动真实 TUI，按动作切段记录字节 ──

type Section = { action: string; from: number; to: number };

async function drive(): Promise<{ bytes: string; sections: Section[] }> {
  const server = startMockModel();
  const home = mkdtempSync(join(tmpdir(), "sc-shrink-home-"));
  mkdirSync(join(home, "state"), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "sc-shrink-work-"));
  let all = "";
  const dec = new TextDecoder();
  const proc = Bun.spawn(["bun", BOOTSTRAP, "--dangerously-skip-permissions"], {
    cwd: work,
    env: {
      ...process.env,
      SID_CONFIG_DIR: home,
      SID_CODE_DISABLE_PROJECT_RULES: "1",
      SID_CODE_LLM_PROVIDER: "openai",
      SID_CODE_LLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      SID_CODE_LLM_MODEL: "mock",
      OPENAI_API_KEY: "sk-shrink-e2e",
      TERM: "xterm-256color",
      TERM_PROGRAM: "",
    },
    terminal: {
      cols: COLS,
      rows: ROWS,
      data(_t, d) {
        all += dec.decode(d, { stream: true });
      },
    },
  });
  const sections: Section[] = [];
  let mark = 0;
  const section = (action: string) => {
    sections.push({ action, from: mark, to: all.length });
    mark = all.length;
  };
  /** 等输出静默 quietMs（最长 maxMs） */
  const settle = async (quietMs = 600, maxMs = 30_000) => {
    const t0 = performance.now();
    let last = all.length;
    let lastChange = performance.now();
    while (performance.now() - t0 < maxMs) {
      await Bun.sleep(50);
      if (all.length !== last) {
        last = all.length;
        lastChange = performance.now();
      } else if (performance.now() - lastChange >= quietMs) break;
    }
  };
  const write = (s: string) => proc.terminal!.write(s);
  const type = async (s: string) => {
    for (const ch of s) {
      write(ch);
      await Bun.sleep(60);
    }
  };
  try {
    await settle(1500, 30_000);
    write(" ");
    await Bun.sleep(150);
    write("\x15");
    await settle();
    section("启动");

    await type("请做一个三步的小任务");
    write("\r");
    await settle(2000, 90_000);
    section("完整一轮");

    await type("abc");
    write("\x1b\r"); // Alt+Enter 换行
    await type("def");
    await settle();
    section("输入两行");
    for (let i = 0; i < 4; i++) {
      write("\x7f");
      await Bun.sleep(80);
    }
    await settle();
    section("退格删回一行");
    write("\x15");
    await settle();
    section("Ctrl+U 清空");
    await type("/");
    await settle();
    section("打开补全菜单");
    write("\x7f");
    await settle();
    section("关闭补全菜单");
    write("\x03");
    await settle(400);
    section("Ctrl+C 一次");
    await type("x");
    await settle(400);
    write("\x7f");
    await settle(2500);
    section("取消退出提示");

    // 空闲时出现又自己消失的提示（Ctrl+O 展开提示 3s）：消失后不许留空占位（2026-11-05 用户截图）
    write("\x0f");
    await settle(400);
    section("空闲 Ctrl+O 提示");
    await Bun.sleep(3300);
    await settle(600);
    section("空闲提示消失");

    await type("再来");
    write("\r");
    await settle(2000, 60_000);
    section("第二轮");
  } finally {
    write("\x03");
    await Bun.sleep(150);
    write("\x03");
    await Promise.race([proc.exited, Bun.sleep(3000)]);
    proc.kill();
    await proc.exited;
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
  return { bytes: all, sections };
}

/**
 * 逐个同步帧（DEC 2026 包裹）喂 xterm，返回每帧之后视口内最长的连续空行数与所在段，
 * 以及每段结束时整个终端 buffer（scrollback + 视口）的文本——字节是逐单元 diff，
 * 一句话不会以连续子串出现在字节里，判「画面上有没有某行」必须看重放后的 buffer。
 */
async function replay(bytes: string, sections: Section[]) {
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    allowProposedApi: true,
    scrollback: 100_000,
  });
  const write = (s: string) => new Promise<void>((r) => term.write(s, r));
  const END = "\x1b[?2026l";
  const out: Array<{ action: string; run: number; view: string[] }> = [];
  const bufferAt: Record<string, string> = {};
  const snapshotBuffer = () => {
    const b = term.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < b.length; y++) lines.push(b.getLine(y)!.translateToString(true).trimEnd());
    return lines.join("\n");
  };
  let sectionIdx = 0;
  let pos = 0;
  while (true) {
    const end = bytes.indexOf(END, pos);
    if (end < 0) break;
    // 跨过段边界前先拍下上一段结束时的 buffer
    while (sectionIdx < sections.length && end >= sections[sectionIdx]!.to) {
      bufferAt[sections[sectionIdx]!.action] = snapshotBuffer();
      sectionIdx++;
    }
    await write(bytes.slice(pos, end + END.length));
    pos = end + END.length;
    const b = term.buffer.active;
    const view = Array.from({ length: ROWS }, (_, y) =>
      b
        .getLine(b.viewportY + y)!
        .translateToString(true)
        .trimEnd(),
    );
    // 视口底部（footer 之下的光标行）不算
    while (view.length > 0 && view[view.length - 1] === "") view.pop();
    let run = 0;
    let max = 0;
    for (const l of view) {
      run = l === "" ? run + 1 : 0;
      max = Math.max(max, run);
    }
    const action = sections.find((s) => end >= s.from && end < s.to)?.action ?? "?";
    out.push({ action, run: max, view });
  }
  while (sectionIdx < sections.length) {
    bufferAt[sections[sectionIdx]!.action] = snapshotBuffer();
    sectionIdx++;
  }
  term.dispose();
  return { runs: out, bufferAt };
}

describe("主屏长会话端到端：高频交互零重画、画面无空白块", () => {
  test("真实 TUI + mock 模型", async () => {
    const { bytes, sections } = await drive();
    const resets = Object.fromEntries(
      sections.map((s) => [s.action, bytes.slice(s.from, s.to).split(RESET).length - 1]),
    );
    console.log(`[shrink-e2e] resets ${JSON.stringify(resets)}`);
    const { runs, bufferAt } = await replay(bytes, sections);

    // 前提：长会话（帧已溢出视口），否则「零重画」是空转。
    // 第一轮结束时终端里应有完整的 30 条总结，且总行数超过视口。
    const afterRound = bufferAt["完整一轮"] ?? "";
    expect(afterRound).toContain("第 30 条总结");
    expect(afterRound.split("\n").length).toBeGreaterThan(ROWS);

    // 高频交互：零重画
    for (const a of [
      "输入两行",
      "Ctrl+U 清空",
      "打开补全菜单",
      "关闭补全菜单",
      "Ctrl+C 一次",
      "取消退出提示",
    ]) {
      expect({ action: a, resets: resets[a] }).toEqual({ action: a, resets: 0 });
    }
    // 退格从两行删回一行：输入框变矮 1 行，主屏帧已溢出 → 至多 1 次整帧重画（见文件头 1. 的例外）
    expect(resets["退格删回一行"]).toBeLessThanOrEqual(1);
    // 一轮里只允许低频结构性收缩：TodoPanel 全部完成后收起 + 轮末流式正文并入历史（R5，main 上也有）
    expect(resets["完整一轮"]).toBeLessThanOrEqual(2);
    // 第二轮允许 1 次：回合结束时状态行（spinner）消失、最终回复并入历史，帧净矮 1 行。
    // 2026-11-05 之前这里是 0，靠的是状态行把「2s 前就隐藏了的工具完成提示」算成有内容、
    // 空闲时恒占 1 行空白——用户截图里最后一条消息与输入框之间的空行就是它。
    // 「界面不留空白」优先于「回合末少一次整帧重画」（用户定），这条重画是每轮至多一次的回合末事件，
    // 不是高频交互；高频交互仍锁 0（上面的循环）。
    expect(resets["第二轮"]).toBeLessThanOrEqual(1);

    // 空闲时提示消失后，最后一条消息与输入框之间只剩历史项自带的 1 行留白
    // （修复前：1 行占位 + 1 行 gap，挂到下一轮开始；Composer 状态行另多 1 行）
    const idleView = runs.filter((r) => r.action === "空闲提示消失").at(-1)?.view ?? [];
    const border = idleView.findIndex((l) => /^─{10,}/.test(l));
    expect(border).toBeGreaterThan(0);
    let blanks = 0;
    for (let i = border - 1; i >= 0 && idleView[i] === ""; i--) blanks++;
    expect({ blanks }, `空闲提示消失后的视口：\n${idleView.join("\n")}`).toEqual({ blanks: 1 });

    // 画面：任何一帧视口里都没有空白块
    const worst = runs.reduce((a, b) => (b.run > a.run ? b : a), runs[0]!);
    expect(
      { action: worst.action, run: worst.run },
      `最长连续空行出现在「${worst.action}」：\n${worst.view.join("\n")}`,
    ).toEqual({ action: worst.action, run: Math.min(worst.run, MAX_BLANK_RUN) });
  }, 180_000);
});
