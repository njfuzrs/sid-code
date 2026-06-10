/**
 * IDE 集成单测
 * 覆盖：lockfile 解析 / IDE 检测匹配 / 选区同步 / @提及管理 / 上下文收集
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { isSubPath, lockfileToDetectedIDE } from "../../src/ide/detect.ts";
import { IDESelectionSync } from "../../src/ide/selection.ts";
import { IDEMentionManager } from "../../src/ide/mention.ts";
import { isProcessRunning, readIDELockfile } from "../../src/ide/lockfile.ts";
import { shouldAutoConnect, isSupportedTerminal } from "../../src/ide/integration.ts";

// ───────────────────────────── isSubPath ─────────────────────────────

describe("isSubPath", () => {
  test("相等路径视为子路径", () => {
    expect(isSubPath("/a/b", "/a/b")).toBe(true);
  });

  test("真子路径匹配", () => {
    expect(isSubPath("/a/b/c", "/a/b")).toBe(true);
  });

  test("尾部斜杠归一化", () => {
    expect(isSubPath("/a/b/", "/a/b")).toBe(true);
    expect(isSubPath("/a/b", "/a/b/")).toBe(true);
  });

  test("前缀相同但非子路径不匹配", () => {
    expect(isSubPath("/a/bc", "/a/b")).toBe(false);
  });

  test("无关路径不匹配", () => {
    expect(isSubPath("/x/y", "/a/b")).toBe(false);
  });
});

// ───────────────────────── lockfileToDetectedIDE ─────────────────────────

describe("lockfileToDetectedIDE", () => {
  test("ws 传输生成 ws:// URL", () => {
    const ide = lockfileToDetectedIDE(12345, {
      transport: "ws",
      ideName: "VS Code",
      authToken: "tok",
    });
    expect(ide.url).toBe("ws://127.0.0.1:12345");
    expect(ide.name).toBe("VS Code");
    expect(ide.port).toBe(12345);
    expect(ide.authToken).toBe("tok");
  });

  test("sse 传输生成 http:// URL", () => {
    const ide = lockfileToDetectedIDE(8080, { transport: "sse" });
    expect(ide.url).toBe("http://127.0.0.1:8080");
  });

  test("默认传输为 sse", () => {
    const ide = lockfileToDetectedIDE(8080, {});
    expect(ide.url).toBe("http://127.0.0.1:8080");
    expect(ide.name).toBe("Unknown IDE");
  });
});

// ───────────────────────────── readIDELockfile ─────────────────────────────

describe("readIDELockfile", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ide-lock-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("解析有效 lockfile 并从文件名提取端口", async () => {
    const file = join(dir, "12345.lock");
    writeFileSync(file, JSON.stringify({ ideName: "Cursor", transport: "ws" }));
    const result = await readIDELockfile(file);
    expect(result).not.toBeNull();
    expect(result!.port).toBe(12345);
    expect(result!.content.ideName).toBe("Cursor");
  });

  test("非法 JSON 返回 null", async () => {
    const file = join(dir, "999.lock");
    writeFileSync(file, "not json{");
    expect(await readIDELockfile(file)).toBeNull();
  });

  test("文件不存在返回 null", async () => {
    expect(await readIDELockfile(join(dir, "nope.lock"))).toBeNull();
  });
});

// ───────────────────────────── isProcessRunning ─────────────────────────────

describe("isProcessRunning", () => {
  test("当前进程存活", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  test("不存在的 PID 返回 false", () => {
    // 极大 PID 几乎不可能存在
    expect(isProcessRunning(2_000_000_000)).toBe(false);
  });
});

// ───────────────────────────── IDESelectionSync ─────────────────────────────

/** 构造一个最小 MCPClient 桩，捕获 onNotification 注册 */
function makeFakeClient() {
  const handlers = new Map<string, Array<(p: unknown) => void>>();
  return {
    onNotification(method: string, handler: (p: unknown) => void) {
      const list = handlers.get(method) ?? [];
      list.push(handler);
      handlers.set(method, list);
      return () => {
        const l = handlers.get(method);
        if (l) l.splice(l.indexOf(handler), 1);
      };
    },
    emit(method: string, params: unknown) {
      for (const h of handlers.get(method) ?? []) h(params);
    },
    handlerCount(method: string) {
      return handlers.get(method)?.length ?? 0;
    },
  };
}

describe("IDESelectionSync", () => {
  test("接收 selection_changed 通知并格式化", () => {
    const sync = new IDESelectionSync();
    const client = makeFakeClient();
    sync.register(client as any);

    client.emit("notifications/selection_changed", {
      filePath: "/a/b.ts",
      text: "const x = 1;",
      selection: {
        start: { line: 4, character: 0 },
        end: { line: 6, character: 10 },
      },
    });

    const sel = sync.getSelection();
    expect(sel).not.toBeNull();
    expect(sel!.filePath).toBe("/a/b.ts");
    expect(sel!.lineStart).toBe(4);
    expect(sel!.lineCount).toBe(3); // 4,5,6

    const formatted = sync.formatForAttachment();
    expect(formatted).toContain("/a/b.ts");
    expect(formatted).toContain("const x = 1;");
    expect(formatted).toContain("5-7"); // 1-based 行号
  });

  test("光标落在行首时不计入末行", () => {
    const sync = new IDESelectionSync();
    const client = makeFakeClient();
    sync.register(client as any);

    client.emit("notifications/selection_changed", {
      filePath: "/a/b.ts",
      text: "x",
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 3, character: 0 }, // 行首
      },
    });

    expect(sync.getSelection()!.lineCount).toBe(3); // 0,1,2 (末行被排除)
  });

  test("空文本选区不生成附件", () => {
    const sync = new IDESelectionSync();
    const client = makeFakeClient();
    sync.register(client as any);

    client.emit("notifications/selection_changed", {
      filePath: "/a/b.ts",
      text: "   ",
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    });

    expect(sync.formatForAttachment()).toBeNull();
  });

  test("unregister 后清空状态并停止接收", () => {
    const sync = new IDESelectionSync();
    const client = makeFakeClient();
    sync.register(client as any);
    sync.unregister();

    expect(client.handlerCount("notifications/selection_changed")).toBe(0);
    expect(sync.getSelection()).toBeNull();
  });
});

// ───────────────────────────── IDEMentionManager ─────────────────────────────

describe("IDEMentionManager", () => {
  test("接收 at_mentioned 并 consume 清空", () => {
    const mgr = new IDEMentionManager();
    const client = makeFakeClient();
    mgr.register(client as any);

    client.emit("notifications/at_mentioned", { filePath: "/a.ts", lineStart: 0, lineEnd: 2 });
    client.emit("notifications/at_mentioned", { filePath: "/b.ts" });

    expect(mgr.peekMentions().length).toBe(2);
    const consumed = mgr.consumeMentions();
    expect(consumed.length).toBe(2);
    expect(consumed[0]!.filePath).toBe("/a.ts");
    // consume 后清空
    expect(mgr.peekMentions().length).toBe(0);
  });

  test("超过上限保留最近 N 条", () => {
    const mgr = new IDEMentionManager();
    const client = makeFakeClient();
    mgr.register(client as any);

    for (let i = 0; i < 15; i++) {
      client.emit("notifications/at_mentioned", { filePath: `/f${i}.ts` });
    }
    const mentions = mgr.peekMentions();
    expect(mentions.length).toBe(10);
    // 最新的应当保留
    expect(mentions[mentions.length - 1]!.filePath).toBe("/f14.ts");
  });

  test("缺少 filePath 的通知被忽略", () => {
    const mgr = new IDEMentionManager();
    const client = makeFakeClient();
    mgr.register(client as any);
    client.emit("notifications/at_mentioned", { lineStart: 1 });
    expect(mgr.peekMentions().length).toBe(0);
  });
});

// ───────────────────────────── shouldAutoConnect ─────────────────────────────

describe("shouldAutoConnect / isSupportedTerminal", () => {
  const saved = {
    port: process.env.SID_CODE_SSE_PORT,
    auto: process.env.SID_CODE_AUTO_CONNECT_IDE,
    term: process.env.TERM_PROGRAM,
  };

  afterEach(() => {
    process.env.SID_CODE_SSE_PORT = saved.port;
    process.env.SID_CODE_AUTO_CONNECT_IDE = saved.auto;
    process.env.TERM_PROGRAM = saved.term;
  });

  test("环境变量端口触发自动连接", () => {
    delete process.env.TERM_PROGRAM;
    delete process.env.SID_CODE_AUTO_CONNECT_IDE;
    process.env.SID_CODE_SSE_PORT = "12345";
    expect(shouldAutoConnect()).toBe(true);
  });

  test("VS Code 终端被识别", () => {
    process.env.TERM_PROGRAM = "vscode";
    expect(isSupportedTerminal()).toBe(true);
  });

  test("普通终端不触发自动连接", () => {
    delete process.env.SID_CODE_SSE_PORT;
    delete process.env.SID_CODE_AUTO_CONNECT_IDE;
    process.env.TERM_PROGRAM = "iTerm.app";
    expect(shouldAutoConnect()).toBe(false);
  });
});
