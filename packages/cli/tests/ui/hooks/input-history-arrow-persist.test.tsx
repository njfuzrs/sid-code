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
import { useInputHistoryStore } from "@sid-code/cli/ui/hooks/useInputHistoryStore.ts";
import { getProjectRoot, setProjectRoot } from "@sid-code/core/bootstrap/state.ts";

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
      [line("p1-旧", "/p1"), line("p2-输入", "/p2"), line("p1-新", "/p1")].join("\n") + "\n",
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

  test("↑/↓ 只灌当前项目的历史（最新在前），Ctrl+R 仍是全局", () => {
    setProjectRoot("/p1");
    const { lastFrame } = render(<Harness />);
    expect(lastFrame()).toContain("P=p1-新,p1-旧|");
    expect(lastFrame()).toContain("A=p1-新,p2-输入,p1-旧");
  });
});
