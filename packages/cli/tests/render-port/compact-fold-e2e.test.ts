/**
 * compact 折叠的端到端验收：真实 TUI（PTY 里起 bootstrap.ts）+ 脚本化 mock 模型。
 *
 * 这是方案 §4.3「sc-dev 人工手测」的自动化替代（`docs-research/sid-code/bugfixes/todo/
 * 20261113-TUI主屏历史被截断-显示精简与scrollback保留-设计方案.md`）：
 * 人工手测要求「连续读十几个文件 + 跑几条 bash，确认每条一行；ctrl+o 能看到原文；
 * 失败命令正文照常显示」——三项判据都是**键盘/屏幕**层面的，整帧渲染测试（直接构造
 * expandLevel）覆盖不到 ctrl+o 的真实按键链路。
 *
 * 为什么必须起真实 TUI 而不是再写一个整帧测试：
 * - `ToolMessage-compact.test.tsx` 验的是渲染函数对 `displayMode` / `expandLevel` 的响应；
 * - 本文件验的是**从工具声明 → 执行器解析 → block 落盘 → history-adapter 降级 → 键盘切换
 *   expandLevel → 重渲**这条完整链在真实终端里串起来的结果。中间任何一环接错，
 *   前者全绿而用户看到的仍是「输出铺满屏幕」。
 *
 * 场景用「造数据」：临时目录里造 12 个 20 行文件 + 两条 bash（一条成功多行、一条失败），
 * 不依赖真实仓库内容，也不调真实模型（mock SSE 按轮次回放）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import xterm from "@xterm/headless";

const { Terminal } = xterm as unknown as { Terminal: typeof import("@xterm/headless").Terminal };

const BOOTSTRAP = join(import.meta.dir, "..", "..", "src", "entrypoints", "bootstrap.ts");
const COLS = 100;
const ROWS = 30;

/** 每个文件 20 行（> compact 的 5 视觉行阈值，确保折叠），首行埋唯一 marker */
const FILE_COUNT = 12;
const FILE_LINES = 20;
const markerOf = (i: number) => `MARKER-FILE-${i}-CONTENT`;

/** 成功 bash：6 行输出（> shell 的 1 视觉行阈值，确保折叠） */
const OK_BASH_OUTPUT_MARK = "OK-BASH-LINE-6";
/** 失败 bash：非零退出，正文必须照常可见 */
const FAIL_BASH_MARK = "FAIL-BASH-正文必须可见";

type Step = { think?: string; tool?: { name: string; args: unknown }; text?: string };

const SCRIPT: Step[] = [
  // 连续读十几个文件（文件名 1-based，与 drive() 造的文件对应）
  ...Array.from({ length: FILE_COUNT }, (_, i) => ({
    tool: { name: "read", args: { file_path: `FILE_${i + 1}` } },
  })),
  // 成功退出的 bash：多行输出 → compact 折叠
  {
    tool: {
      name: "bash",
      args: { command: "for i in 1 2 3 4 5 6; do echo OK-BASH-LINE-$i; done" },
    },
  },
  // 失败的 bash：非零退出 → 不折叠，正文照常显示
  {
    tool: {
      name: "bash",
      args: { command: `echo '${FAIL_BASH_MARK}' >&2; exit 1` },
    },
  },
  { text: "全部完成。" },
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
            await Bun.sleep(10);
          }
          for (let i = 0; i < (step.text ?? "").length; i += 4) {
            send(chunk({ content: step.text!.slice(i, i + 4) }));
            await Bun.sleep(8);
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

type Section = { action: string; from: number; to: number };

async function drive(): Promise<{ bytes: string; sections: Section[] }> {
  const server = startMockModel();
  const home = mkdtempSync(join(tmpdir(), "sc-compact-home-"));
  mkdirSync(join(home, "state"), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), "sc-compact-work-"));
  // 造数据：12 个 20 行文件，首行是唯一 marker
  for (let i = 1; i <= FILE_COUNT; i++) {
    const body = [
      markerOf(i),
      ...Array.from({ length: FILE_LINES - 1 }, (_, k) => `文件 ${i} 的第 ${k + 2} 行内容`),
    ].join("\n");
    writeFileSync(join(work, `FILE_${i}`), `${body}\n`);
  }
  let all = "";
  const dec = new TextDecoder();
  // read 的入参是相对路径，mock 里下发的是占位名，这里在提交前替换成真实文件名
  const proc = Bun.spawn(["bun", BOOTSTRAP, "--dangerously-skip-permissions"], {
    cwd: work,
    env: {
      ...process.env,
      SID_CONFIG_DIR: home,
      SID_CODE_DISABLE_PROJECT_RULES: "1",
      SID_CODE_LLM_PROVIDER: "openai",
      SID_CODE_LLM_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      SID_CODE_LLM_MODEL: "mock",
      // ≥ 20 字符且不命中 PLACEHOLDER_PATTERNS，否则启动警告会吞掉回车
      OPENAI_API_KEY: "sk-compact-e2e-0123456789abcdef",
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
  const settle = async (quietMs = 600, maxMs = 60_000) => {
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
  const plainSince = (from: number) => all.slice(from).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const type = async (s: string) => {
    for (const ch of s) {
      write(ch);
      await Bun.sleep(30);
    }
  };
  const submit = async (prompt: string, started: () => boolean) => {
    await type(prompt);
    const deadline = performance.now() + 20_000;
    while (!started() && performance.now() < deadline) {
      write("\r");
      const tick = performance.now() + 500;
      while (!started() && performance.now() < tick) await Bun.sleep(50);
    }
    if (!started()) {
      throw new Error(
        `回车提交后 20s 内没看到轮次开始的信号（提示词「${prompt}」）。\n` +
          `最近输出：\n${plainSince(Math.max(0, all.length - 2000)).slice(-1500)}`,
      );
    }
  };
  try {
    await settle(1500, 30_000);
    write(" ");
    await Bun.sleep(150);
    write("\x15");
    await settle();
    section("启动");

    const round1From = all.length;
    // 第一轮开始的信号：第一个 read 的输出落屏（折叠态也会出现 marker 所在的文件名）
    await submit("把所有文件都读一遍，再跑两条命令", () =>
      plainSince(round1From).includes("FILE_1"),
    );
    // 15 轮工具调用 + 总结，给足时间
    await settle(2500, 180_000);
    section("一轮完成");

    // ctrl+o：展开全部 compact 卡片
    write("\x0f");
    await settle(1500, 30_000);
    section("ctrl+o 展开");
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

/** 把 PTY 字节按段重放进 xterm，取每段结束时的完整 buffer 文本 */
async function replay(bytes: string, sections: Section[]) {
  const term = new Terminal({
    cols: COLS,
    rows: ROWS,
    allowProposedApi: true,
    scrollback: 100_000,
  });
  const write = (s: string) => new Promise<void>((r) => term.write(s, r));
  const END = "\x1b[?2026l";
  const bufferAt: Record<string, string> = {};
  const snapshot = () => {
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
    while (sectionIdx < sections.length && end >= sections[sectionIdx]!.to) {
      bufferAt[sections[sectionIdx]!.action] = snapshot();
      sectionIdx++;
    }
    await write(bytes.slice(pos, end + END.length));
    pos = end + END.length;
  }
  while (sectionIdx < sections.length) {
    bufferAt[sections[sectionIdx]!.action] = snapshot();
    sectionIdx++;
  }
  term.dispose();
  return bufferAt;
}

describe("compact 折叠端到端（方案 §4.3 的自动化替代）", () => {
  test("12 个 read + 成功/失败 bash：每条一行、ctrl+o 见原文、失败正文可见", async () => {
    const { bytes, sections } = await drive();
    const bufferAt = await replay(bytes, sections);
    const folded = bufferAt["一轮完成"] ?? "";
    const expanded = bufferAt["ctrl+o 展开"] ?? "";

    // 诊断用：断言失败时能看到真实画面
    console.log(`[compact-e2e] 折叠态 buffer 行数 ${folded.split("\n").length}`);
    console.log(`[compact-e2e] 折叠态尾部：\n${folded.split("\n").slice(-40).join("\n")}`);

    expect(folded).toContain("全部完成。");

    // 判据 1：每条 read 卡片占一行（标题行带结果规模「N 行」），正文不出现。
    // 行数不硬编码：`read` 的输出带一行文件头，实测 20 行文件报「21 行」；断言的是
    // 「每条卡片都有规模摘要且成一行」这个契约，不是具体数字。
    const readCardLines = folded
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^⏺ read FILE_\d+ — \d+ 行$/.test(l));
    console.log(`[compact-e2e] read 卡片行：\n${readCardLines.join("\n")}`);
    expect({ readCards: readCardLines.length }).toEqual({ readCards: FILE_COUNT });
    // 折叠态正文零行：12 个文件的首行 marker 一个都不该出现
    const leakedFolded = Array.from({ length: FILE_COUNT }, (_, i) => markerOf(i + 1)).filter((m) =>
      folded.includes(m),
    );
    expect({ leakedFolded }).toEqual({ leakedFolded: [] });

    // 判据 2：成功 bash 折成一行，输出正文不出现；失败 bash 正文照常可见
    expect(folded).not.toContain(OK_BASH_OUTPUT_MARK);
    expect(folded).toContain(FAIL_BASH_MARK);

    // 判据 3：ctrl+o 后正文回来（marker 出现）
    const leakedExpanded = Array.from({ length: FILE_COUNT }, (_, i) => markerOf(i + 1)).filter(
      (m) => expanded.includes(m),
    );
    console.log(`[compact-e2e] 展开态可见 marker 数 ${leakedExpanded.length}`);
    expect({ visibleAfterExpand: leakedExpanded.length }).toEqual({
      visibleAfterExpand: FILE_COUNT,
    });
  }, 300_000);
});
