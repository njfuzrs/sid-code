/**
 * ↑/↓ 输入历史跨会话持久化回归测试。
 *
 * 根因：history.jsonl 一直在写，但 TextBuffer 的 history 恒从 [] 起步，
 * ↑/↓ 只能翻到本会话提交过的几条，关掉会话再开就什么都没有。
 * 这里覆盖三层：reducer 吃初始历史 / reset 去重 / hook 从 history.jsonl 按项目灌入。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import React from "react";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { Text } from "@sid-code/cli/ui/render-port/components.ts";
import { textBufferReducer as reduce, createInitialState } from "@sid-code/cli/ui/text-buffer.ts";
import { registerPaste, expandPastedRefs, clearPastes } from "@sid-code/cli/ui/pasted-contents.ts";
import { useInputHistoryStore } from "@sid-code/cli/ui/hooks/useInputHistoryStore.ts";
import { getProjectRoot, setProjectRoot } from "@sid-code/core/bootstrap/state.ts";
import { isSlashCommandInput } from "@sid-code/cli/command/parser.ts";

describe("TextBuffer 初始历史", () => {
  test("带初始历史时 ↑ 能翻到上一会话的输入", () => {
    let s = createInitialState("", ["最新一句", "更早一句"]);
    s = reduce(s, { type: "history-up" });
    expect(s.lines).toEqual(["最新一句"]);
    s = reduce(s, { type: "history-up" });
    expect(s.lines).toEqual(["更早一句"]);
    s = reduce(s, { type: "history-down" });
    s = reduce(s, { type: "history-down" });
    expect(s.lines).toEqual([""]);
  });

  test("提交与历史中相同的内容时去重置顶，不会连按两次 ↑ 看到同一句", () => {
    let s = createInitialState("a", ["b", "a", "c"]);
    s = reduce(s, { type: "reset" });
    expect(s.history).toEqual(["a", "b", "c"]);
  });

  test("提交斜杠命令不进 ↑ 历史：翻回 /model 会弹补全锁死 ↑/↓、回车直接打开弹窗", () => {
    let s = createInitialState("/model", ["你好"]);
    s = reduce(s, { type: "reset" });
    expect(s.history).toEqual(["你好"]);
    s = createInitialState("/model opus", ["你好"]);
    s = reduce(s, { type: "reset" });
    expect(s.history).toEqual(["你好"]);
    // 普通对话照常进
    s = createInitialState("看下 /tmp/a.log", ["你好"]);
    s = reduce(s, { type: "reset" });
    expect(s.history).toEqual(["看下 /tmp/a.log", "你好"]);
  });

  test("粘贴占位以还原后的全文进 ↑ 历史：登记表提交即清空，存占位翻回来就只剩省略号", () => {
    clearPastes();
    const big = Array.from({ length: 13 }, (_, i) => `报错行 ${i + 1}`).join("\n");
    const ref = registerPaste(big);
    let s = createInitialState(`${ref} 为什么重试 5 次？`, []);
    s = reduce(s, { type: "reset", historyText: expandPastedRefs(s.lines.join("\n")) });
    clearPastes(); // 与 InputArea.handleSubmit 同序：提交后立刻清空登记表

    // 期间又粘贴一段：id 从 1 重新分配，旧占位若残留会被还原成这段（串号）
    registerPaste(Array.from({ length: 8 }, () => "无关内容").join("\n"));

    s = reduce(s, { type: "history-up" });
    const recalled = s.lines.join("\n");
    expect(recalled).toBe(`${big} 为什么重试 5 次？`);
    expect(recalled).not.toContain("[粘贴 #");
    // 再回车也不会被新登记表误还原
    expect(expandPastedRefs(recalled)).toBe(recalled);
    clearPastes();
  });

  test("不传 historyText 时行为不变：原文入历史", () => {
    let s = createInitialState("普通一句", []);
    s = reduce(s, { type: "reset" });
    expect(s.history).toEqual(["普通一句"]);
  });
});

describe("isSlashCommandInput", () => {
  test("命令与带参命令判真，普通文本 / 多段路径 / 孤立 / 判假", () => {
    expect(isSlashCommandInput("/model")).toBe(true);
    expect(isSlashCommandInput("  /model opus ")).toBe(true);
    expect(isSlashCommandInput("/mcp:list")).toBe(true);
    expect(isSlashCommandInput("你好 /model")).toBe(false);
    expect(isSlashCommandInput("/var/log/syslog 里有什么")).toBe(false);
    expect(isSlashCommandInput("/")).toBe(false);
    expect(isSlashCommandInput("")).toBe(false);
  });
});

describe("useInputHistoryStore.projectHistory", () => {
  let dir: string;
  let prevHome: string | undefined;
  let prevRoot: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sid-input-history-"));
    prevHome = process.env.SID_CONFIG_DIR;
    prevRoot = getProjectRoot();
    process.env.SID_CONFIG_DIR = dir;
    const line = (display: string, project: string) =>
      JSON.stringify({ display, pastedContents: [], timestamp: "", project, sessionId: "s" });
    // 文件是最旧在前的追加序
    writeFileSync(
      join(dir, "history.jsonl"),
      [
        line("p1-旧", "/p1"),
        line("/model", "/p1"),
        line("p2-输入", "/p2"),
        line("p1-新", "/p1"),
      ].join("\n") + "\n",
    );
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prevHome;
    setProjectRoot(prevRoot);
    rmSync(dir, { recursive: true, force: true });
  });

  function Harness(): React.ReactElement {
    const { history, projectHistory } = useInputHistoryStore();
    return React.createElement(Text, null, `P=${projectHistory.join(",")}|A=${history.join(",")}`);
  }

  test("↑/↓ 只灌当前项目的历史（最新在前、不含斜杠命令），Ctrl+R 仍是全局且保留命令", () => {
    setProjectRoot("/p1");
    const { lastFrame } = render(<Harness />);
    expect(lastFrame()).toContain("P=p1-新,p1-旧|");
    expect(lastFrame()).toContain("A=p1-新,p2-输入,/model,p1-旧");
  });
});
