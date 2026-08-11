/**
 * System-reminder 注入单测（query/reminder-inject.ts）
 *
 * 覆盖三条不变量（每条都有实测事故背书，详见 reminder-inject.ts 头部注释）：
 *   1. 每个片段强制 `<system-reminder>` 围栏（P0-a）
 *   2. 分级顺序：critical 在用户指令前、ambient 在用户指令后（P1-a）
 *   3. 独立 text block 承载，不与用户指令做字符串拼接（P1-b）
 *
 * 另回归：plan mode 连续工具调用场景——最后一条 user 消息只含 tool_result、
 * 无 text block 时，必须**追加** text block 注入 reminder，而不是放弃。
 */

import { describe, test, expect } from "bun:test";
import { injectReminders } from "@sid-code/core/query/reminder-inject.ts";
import type { Message } from "@sid-code/core/llm/types.ts";

const REMINDER = "<system-reminder>[计划模式] 只允许只读操作。</system-reminder>";

/** 取某条消息里所有 text block 的文本，按出现顺序 */
function texts(msg: Message): string[] {
  return (msg.content as any[])
    .filter((c) => c.type === "text")
    .map((c) => c.text as string);
}

describe("injectReminders — 基础行为", () => {
  test("无内容可注入时原样返回（同引用）", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "你好" }] },
    ];
    expect(injectReminders(msgs, [])).toBe(msgs); // 同引用，零拷贝
    expect(injectReminders(msgs, { critical: [], ambient: [] })).toBe(msgs);
    // 全是空白片段 → 过滤后无内容 → 同样零拷贝
    expect(injectReminders(msgs, ["", "   "])).toBe(msgs);
  });

  test("旧签名 string[] 向后兼容：等价于全部 ambient（后置）", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "实现登录功能" }] },
    ];
    const out = injectReminders(msgs, [REMINDER]);
    const t = texts(out[0]);
    expect(t.length).toBe(2);
    expect(t[0]).toBe("实现登录功能"); // 用户指令在**第一个** block
    expect(t[1]).toBe(REMINDER);
  });

  test("多个 ambient 片段以双换行拼进同一个 block", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "原文" }] },
    ];
    const out = injectReminders(msgs, ["A 提醒", "B 提醒"]);
    const t = texts(out[0]);
    expect(t[0]).toBe("原文");
    expect(t[1]).toBe(
      "<system-reminder>\nA 提醒\n</system-reminder>\n\n<system-reminder>\nB 提醒\n</system-reminder>",
    );
  });
});

describe("injectReminders — 不变量 1：强制 <system-reminder> 围栏（P0-a）", () => {
  test("裸文本片段被强制包裹", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "用户指令" }] },
    ];
    const out = injectReminders(msgs, ["# MCP Server Instructions\n裸注入"]);
    const injected = texts(out[0])[1];
    expect(injected.startsWith("<system-reminder>")).toBe(true);
    expect(injected.endsWith("</system-reminder>")).toBe(true);
    expect(injected).toContain("# MCP Server Instructions");
  });

  test("已带围栏的片段不被二次嵌套", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "用户指令" }] },
    ];
    const out = injectReminders(msgs, [REMINDER]);
    const injected = texts(out[0])[1];
    expect(injected).toBe(REMINDER);
    // 只出现一次开标签，未嵌套
    expect(injected.match(/<system-reminder>/g)?.length).toBe(1);
  });

  test("围栏覆盖 critical 与 ambient 两档，无例外", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "用户指令" }] },
    ];
    const out = injectReminders(msgs, {
      critical: ["止损阀裸文本"],
      ambient: ["背景元信息裸文本"],
    });
    for (const t of texts(out[0])) {
      if (t === "用户指令") continue;
      expect(t.startsWith("<system-reminder>")).toBe(true);
    }
  });

  test("用户指令本身绝不被包裹（围栏只作用于注入内容）", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "# Commit: 生成提交信息" }] },
    ];
    const out = injectReminders(msgs, { critical: ["C"], ambient: ["A"] });
    expect(texts(out[0])).toContain("# Commit: 生成提交信息");
  });
});

describe("injectReminders — 不变量 2：分级顺序（P1-a）", () => {
  test("critical 在用户指令前，ambient 在用户指令后", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "# Commit: 提交" }] },
    ];
    const out = injectReminders(msgs, {
      critical: ["矛盾中断：请先裁决假设"],
      ambient: ["<available-deferred-tools>\nfoo\n</available-deferred-tools>"],
    });
    const t = texts(out[0]);
    expect(t.length).toBe(3);
    expect(t[0]).toContain("矛盾中断");
    expect(t[1]).toBe("# Commit: 提交");
    expect(t[2]).toContain("available-deferred-tools");
  });

  test("量化闸门：真实用户指令起始偏移 < 5%（原实测为 40%）", () => {
    // 复刻 2026-07-29 轨迹的注入量级：deferred-tools + MCP 说明共 ~1075 字符
    const userInstruction = "# Commit: 生成提交信息并提交\n\n" + "基".repeat(1600);
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: userInstruction }] },
    ];
    const out = injectReminders(msgs, {
      ambient: [
        "<available-deferred-tools>\n" + "tool_name\n".repeat(40) + "</available-deferred-tools>",
        "# MCP Server Instructions\n" + "说".repeat(600),
      ],
    });
    // 模拟 OpenAI 族的 join("\n") 落地形态（最坏情况：block 边界在 wire 上丢失）
    const wire = texts(out[0]).join("\n");
    const offset = wire.indexOf("# Commit:") / wire.length;
    expect(offset).toBeLessThan(0.05);
  });

  test("只有 critical 时也正确前置", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "用户指令" }] },
    ];
    const t = texts(injectReminders(msgs, { critical: ["止损"] })[0]);
    expect(t.length).toBe(2);
    expect(t[0]).toContain("止损");
    expect(t[1]).toBe("用户指令");
  });

  test("critical 档内次序保持传入顺序（思考发散优先于产出停滞）", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "用户指令" }] },
    ];
    const out = injectReminders(msgs, {
      critical: ["思考发散收敛", "产出停滞提醒"],
    });
    const critical = texts(out[0])[0];
    expect(critical.indexOf("思考发散收敛")).toBeLessThan(critical.indexOf("产出停滞提醒"));
  });
});

describe("injectReminders — 不变量 3：独立 block，不做字符串拼接（P1-b）", () => {
  test("用户指令保持为独立、未被污染的 text block", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "实现登录功能" }] },
    ];
    const out = injectReminders(msgs, { critical: ["C"], ambient: ["A"] });
    const userBlock = texts(out[0]).find((t) => t.includes("实现登录功能"));
    // 关键：用户 block 里**只有**用户指令，没有任何注入内容混入
    expect(userBlock).toBe("实现登录功能");
  });

  test("非 text block（tool_result 等）原样保留、相对位置不变", () => {
    // 混合轮：user 消息同时带 tool_result 和用户追加的文本（真实存在的形态）
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "工具结果" },
          { type: "text", text: "顺便改下这里" },
        ],
      },
    ];
    const out = injectReminders(msgs, { critical: ["C"], ambient: ["A"] });
    const content = out[0].content as any[];
    expect(content.length).toBe(4);
    expect(content[0].type).toBe("tool_result"); // tool_result 仍在最前，未被挤位
    expect(content[1].text).toContain("C"); // critical 紧贴用户 block 之前
    expect(content[2].text).toBe("顺便改下这里");
    expect(content[3].text).toContain("A");
  });
});

describe("injectReminders — 回归：纯 tool_result 轮（无 text block）", () => {
  test("最后一条 user 只含 tool_result 时，追加独立 text block 承载 reminder", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "实现 X" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "文件内容" }],
      },
    ];
    const out = injectReminders(msgs, [REMINDER]);

    const lastUser = out[2];
    expect(lastUser.role).toBe("user");
    expect((lastUser.content as any[])[0].type).toBe("tool_result"); // 原 tool_result 保留
    expect(texts(lastUser)).toEqual([REMINDER]);
    // text block 在 tool_result 之后（顺序：tool_result, text），OpenAI 转换合法
    const c = lastUser.content as any[];
    expect(c[c.length - 1].type).toBe("text");
  });

  test("纯 tool_result 轮：critical 仍排在 ambient 之前（合并为一个 block）", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }],
      },
    ];
    const out = injectReminders(msgs, {
      critical: ["实时 git 状态"],
      ambient: ["延迟工具列表"],
    });
    const t = texts(out[0]);
    expect(t.length).toBe(1); // 无用户指令可夹，合成一块
    expect(t[0].indexOf("实时 git 状态")).toBeLessThan(t[0].indexOf("延迟工具列表"));
  });

  test("注入目标是最后一条 user 消息，而非靠前的带 text 的 user 消息", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "首条带文本" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "grep", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "结果" }],
      },
    ];
    const out = injectReminders(msgs, [REMINDER]);
    expect(texts(out[0])).toEqual(["首条带文本"]); // 首条未被改动
    expect(texts(out[2]).length).toBe(1); // 最后一条被注入
  });

  test("多个 tool_result block 也只追加一个 text block 到末尾", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "r1" },
          { type: "tool_result", tool_use_id: "t2", content: "r2" },
        ],
      },
    ];
    const out = injectReminders(msgs, [REMINDER]);
    expect(texts(out[0]).length).toBe(1);
    expect((out[0].content as any[]).length).toBe(3); // 2 tool_result + 1 text
  });
});

describe("injectReminders — 不变量：入参与边界", () => {
  test("不修改入参（in-place 安全）", () => {
    const original: Message[] = [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }],
      },
    ];
    const snapshot = JSON.stringify(original);
    injectReminders(original, { critical: ["C"], ambient: ["A"] });
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  test("无 user 消息时原样返回（不抛错、不污染 assistant）", () => {
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "text", text: "只有 assistant" }] },
    ];
    const out = injectReminders(msgs, [REMINDER]);
    expect(texts(out[0])).toEqual(["只有 assistant"]);
  });
});
