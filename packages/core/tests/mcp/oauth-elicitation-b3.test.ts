/**
 * MCP 批次 3（OAuth / 授权 / 交互）回归用例：D17–D22、D26、D28
 *
 * 每条对应缺陷文档里的验收判据；能做变异自证的写在用例注释里。
 */

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallbackServerHandle } from "@sid-code/core/mcp/oauth-callback-server.ts";
import type { MCPServerConfig } from "@sid-code/core/config/config.ts";
import type { AskUserQuestionRequest } from "@sid-code/core/tool/ask-user-question-bridge.ts";

let handle: CallbackServerHandle | null = null;
afterEach(() => {
  handle?.close();
  handle = null;
});

async function startServer() {
  const { startCallbackServer } = await import("@sid-code/core/mcp/oauth-callback-server.ts");
  handle = await startCallbackServer();
  return handle;
}

// ─── D18：OAuth URL 脱敏 ───

describe("D18 redactOAuthUrl", () => {
  test("state / code_challenge / code 打成 [REDACTED]，其余参数保留", async () => {
    const { redactOAuthUrl } = await import("@sid-code/core/mcp/oauth.ts");
    const raw =
      "https://as.example.com/authorize?response_type=code&client_id=cid&state=SECRET_STATE&code_challenge=CH&code=C0DE&redirect_uri=http%3A%2F%2Flocalhost%3A1%2Fcallback";
    const out = redactOAuthUrl(raw);
    expect(out).not.toContain("SECRET_STATE");
    expect(out).not.toContain("=CH");
    expect(out).not.toContain("C0DE");
    const u = new URL(out);
    expect(u.searchParams.get("state")).toBe("[REDACTED]");
    expect(u.searchParams.get("client_id")).toBe("cid");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:1/callback");
  });

  test("非法 URL 退化为正则替换，仍不漏 state", async () => {
    const { redactOAuthUrl } = await import("@sid-code/core/mcp/oauth.ts");
    const out = redactOAuthUrl("not a url ?state=LEAK&x=1");
    expect(out).not.toContain("LEAK");
    expect(out).toContain("x=1");
  });

  test("无 UI 回调时 manager 的日志分支用脱敏 URL（源码判据）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/mcp/manager.ts")).text();
    // 变异自证：把 redactOAuthUrl(url) 改回 ${url} 本条变红
    expect(src).toMatch(/redactOAuthUrl\(url\)/);
    expect(src).not.toMatch(/OAuth 授权:\\n\$\{url\}/);
  });
});

// ─── D20 / D22：先校验 state 再回复，错误 state 不关服务器 ───

describe("D20/D22 回调服务器 state 校验", () => {
  test("错误 state：浏览器看到失败页（非 200、无「授权成功」）", async () => {
    const h = await startServer();
    const p = h.waitForCode("good", 5000);
    const resp = await fetch(`${h.redirectUri}?code=X&state=bad`);
    const html = await resp.text();
    expect(resp.status).toBe(400);
    expect(html).not.toContain("授权成功");
    expect(html).toContain("授权失败");
    // 仍在等：随后真回调可以成功
    const ok = await fetch(`${h.redirectUri}?code=REAL&state=good`);
    expect(await ok.text()).toContain("授权成功");
    expect(await p).toBe("REAL");
  });

  test("伪造的 error 回调（state 错）不能打断流程", async () => {
    const h = await startServer();
    const p = h.waitForCode("good", 5000);
    await fetch(`${h.redirectUri}?error=access_denied&state=forged`);
    await fetch(`${h.redirectUri}?error=access_denied`);
    await fetch(`${h.redirectUri}?code=REAL&state=good`);
    expect(await p).toBe("REAL");
  });

  test("重复 state 参数视为不匹配", async () => {
    const h = await startServer();
    const p = h.waitForCode("good", 5000);
    const r = await fetch(`${h.redirectUri}?code=X&state=good&state=good`);
    expect(r.status).toBe(400);
    await fetch(`${h.redirectUri}?code=REAL&state=good`);
    expect(await p).toBe("REAL");
  });

  test("code 含 \\x00 不再被误拆（旧实现用 \\x00 拼 code+state）", async () => {
    const h = await startServer();
    const p = h.waitForCode("s1", 5000);
    await fetch(`${h.redirectUri}?code=${encodeURIComponent("a\u0000b")}&state=s1`);
    expect(await p).toBe("a\u0000b");
  });

  test("期间有 state 不匹配回调时，超时报错带上该信息", async () => {
    const h = await startServer();
    const p = h.waitForCode("good", 300);
    await fetch(`${h.redirectUri}?code=X&state=bad`);
    await expect(p).rejects.toThrow(/1 次 state 不匹配/);
  });

  test("state 正确的 error 回调仍终结流程", async () => {
    const h = await startServer();
    const p = h.waitForCode("s", 5000);
    fetch(`${h.redirectUri}?error=access_denied&state=s`).catch(() => {});
    await expect(p).rejects.toThrow("access_denied");
  });
});

// ─── D19：RFC 9207 iss ───

describe("D19 iss 校验", () => {
  test("iss 不匹配 → 授权失败", async () => {
    const h = await startServer();
    const p = h.waitForCode("s", 5000, undefined, { expectedIss: "https://as.good" });
    const settled = p.then(
      () => null,
      (e: Error) => e,
    );
    const r = await fetch(
      `${h.redirectUri}?code=X&state=s&iss=${encodeURIComponent("https://as.evil")}`,
    );
    expect(r.status).toBe(400);
    expect((await settled)?.message).toMatch(/iss/);
  });

  test("iss 匹配 → 成功", async () => {
    const h = await startServer();
    const p = h.waitForCode("s", 5000, undefined, { expectedIss: "https://as.good" });
    await fetch(`${h.redirectUri}?code=X&state=s&iss=${encodeURIComponent("https://as.good")}`);
    expect(await p).toBe("X");
  });

  test("AS 声明必带 iss 而回调缺 iss → 失败；未声明时缺 iss 放行", async () => {
    const h = await startServer();
    const p = h.waitForCode("s", 5000, undefined, {
      expectedIss: "https://as.good",
      issRequired: true,
    });
    fetch(`${h.redirectUri}?code=X&state=s`).catch(() => {});
    await expect(p).rejects.toThrow(/缺少 iss/);

    handle = null;
    const h2 = await startServer();
    const p2 = h2.waitForCode("s", 5000, undefined, { expectedIss: "https://as.good" });
    await fetch(`${h2.redirectUri}?code=Y&state=s`);
    expect(await p2).toBe("Y");
  });
});

// ─── D21：NEEDS_AUTH / DISABLED ───

describe("D21 连接状态", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.SID_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), "sid-b3-"));
    process.env.SID_CONFIG_DIR = dir;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("enabled:false 的 server 出现在 getStatus 里，状态 disabled", async () => {
    const { MCPManager } = await import("@sid-code/core/mcp/manager.ts");
    const mgr = new MCPManager();
    await mgr.connectAll({
      off: { transport: "stdio", command: "nonexistent-cmd", enabled: false } as MCPServerConfig,
    });
    const st = mgr.getStatus();
    expect(st.map((s) => [s.name, String(s.status)])).toEqual([["off", "disabled"]]);
    mgr.closeAll();
  });

  test("OAuth server 授权未完成 → needs_auth（不是 failed）", async () => {
    const { MCPManager } = await import("@sid-code/core/mcp/manager.ts");
    const mgr = new MCPManager();
    // 发现阶段即失败（指向不可达端口）→ runOAuthFlow 抛错 → 统一成 NeedsAuthorizationError
    await mgr.connectAll({
      remote: {
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        oauth: {},
        timeout: 3000,
      } as MCPServerConfig,
    });
    const s = mgr.getStatus().find((x) => x.name === "remote");
    expect(String(s?.status)).toBe("needs_auth");
    mgr.closeAll();
  });
});

// ─── D26 / D28：elicitation 不再假装 accept、不写 stdout ───

describe("D26/D28 elicitation handler", () => {
  // 判据是「handler 自己不写 stdout」。logger 的控制台输出不算：无头模式下 cli 把它配成
  // consoleToStderr，这里照同一配置来（全量跑时别的用例可能打开了 logger 控制台输出）。
  const captureStdout = async (fn: () => Promise<unknown>) => {
    const { getLogger } = await import("@sid-code/core/debug/logger.ts");
    const lgOpts = (getLogger() as any).options as { consoleToStderr?: boolean };
    const prevToStderr = lgOpts.consoleToStderr;
    lgOpts.consoleToStderr = true;
    const orig = process.stdout.write.bind(process.stdout);
    const origLog = console.log;
    let out = "";
    (process.stdout as any).write = (c: any) => {
      out += String(c);
      return true;
    };
    console.log = (...a: unknown[]) => {
      out += a.join(" ");
    };
    try {
      return { result: await fn(), out };
    } finally {
      (process.stdout as any).write = orig;
      console.log = origLog;
      lgOpts.consoleToStderr = prevToStderr;
    }
  };

  test("无交互通道（无头）：URL / 表单 / 消息 一律 decline，stdout 为空", async () => {
    const { createElicitationHandler } = await import("@sid-code/core/mcp/elicitation.ts");
    const h = createElicitationHandler(async () => ({ status: "unavailable" }));
    const { result, out } = await captureStdout(async () => [
      await h("srv", { message: "m", url: "https://x" }),
      await h("srv", { message: "m", requestedSchema: { properties: { a: { type: "string" } } } }),
      await h("srv", { message: "m" }),
    ]);
    expect(result).toEqual([{ action: "decline" }, { action: "decline" }, { action: "decline" }]);
    expect(out).toBe("");
  });

  test("默认 cliElicitationHandler 在未注册提问处理器时 decline（不再无条件 accept）", async () => {
    const bridge = await import("@sid-code/core/tool/ask-user-question-bridge.ts");
    bridge.setAskUserQuestionHandler(null);
    const { cliElicitationHandler } = await import("@sid-code/core/mcp/elicitation.ts");
    const { result, out } = await captureStdout(() =>
      cliElicitationHandler("srv", { message: "go", url: "https://x" }),
    );
    expect(result).toEqual({ action: "decline" });
    expect(out).toBe("");
  });

  test("URL 模式：用户确认才 accept，拒绝 decline，ESC cancel", async () => {
    const { createElicitationHandler } = await import("@sid-code/core/mcp/elicitation.ts");
    const answerWith = (label: string) =>
      createElicitationHandler(async (req) => ({
        status: "answered",
        answers: { [req.questions[0].question]: label },
      }));
    expect(await answerWith("已在浏览器完成")("s", { message: "", url: "https://x" })).toEqual({
      action: "accept",
    });
    expect(await answerWith("拒绝")("s", { message: "", url: "https://x" })).toEqual({
      action: "decline",
    });
    const esc = createElicitationHandler(async () => ({ status: "cancelled" }));
    expect(await esc("s", { message: "", url: "https://x" })).toEqual({ action: "cancel" });
  });

  test("表单模式：答案按 schema 类型回传 content", async () => {
    const { createElicitationHandler } = await import("@sid-code/core/mcp/elicitation.ts");
    let seen: AskUserQuestionRequest | undefined;
    const h = createElicitationHandler(async (req) => {
      seen = req;
      const [q1, q2, q3, q4] = req.questions.map((q) => q.question);
      return {
        status: "answered",
        answers: { [q1]: "alice", [q2]: "42", [q3]: "是", [q4]: "Blue" },
      };
    });
    const res = await h("srv", {
      message: "请填写",
      requestedSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
          ok: { type: "boolean" },
          color: { type: "string", enum: ["r", "b"], enumNames: ["Red", "Blue"] },
        },
        required: ["name"],
      },
    });
    expect(seen?.questions.length).toBe(4);
    expect(res).toEqual({
      action: "accept",
      content: { name: "alice", age: 42, ok: true, color: "b" },
    });
  });

  test("表单：必填项留空 / 类型不对 → decline", async () => {
    const { createElicitationHandler } = await import("@sid-code/core/mcp/elicitation.ts");
    const schema = {
      properties: { n: { type: "number" }, s: { type: "string" } },
      required: ["s"],
    };
    const bad = createElicitationHandler(async (req) => ({
      status: "answered",
      answers: { [req.questions[0].question]: "abc", [req.questions[1].question]: "x" },
    }));
    expect(await bad("srv", { message: "", requestedSchema: schema })).toEqual({
      action: "decline",
    });
    const skip = createElicitationHandler(async (req) => ({
      status: "answered",
      answers: { [req.questions[0].question]: "1", [req.questions[1].question]: "（留空）" },
    }));
    // s 是必填，没有「（留空）」选项；即便回传该字面值也必须 decline
    expect(await skip("srv", { message: "", requestedSchema: schema })).toEqual({
      action: "decline",
    });
  });

  test("elicitation.ts 不再有 console.log（变异自证：加回任一行即红）", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/mcp/elicitation.ts")).text();
    expect(src).not.toMatch(/console\.log\(/);
  });
});

// ─── D17：批准后热连接 ───

describe("D17 approveAndConnectPendingServer", () => {
  let dir: string;
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.SID_CONFIG_DIR;
    dir = mkdtempSync(join(tmpdir(), "sid-b3-appr-"));
    process.env.SID_CONFIG_DIR = dir;
  });
  afterEach(async () => {
    const a = await import("@sid-code/core/mcp/approval.ts");
    a.__resetPendingApproval();
    if (prev === undefined) delete process.env.SID_CONFIG_DIR;
    else process.env.SID_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  });

  test("批准即用快照里的配置调用 connect，并落盘为 approved", async () => {
    const a = await import("@sid-code/core/mcp/approval.ts");
    const cfg = { transport: "stdio", command: "echo" };
    a.setPendingApprovalServers({ proj: cfg }, "/p");
    const calls: Array<[string, unknown]> = [];
    const n = await a.approveAndConnectPendingServer("proj", async (name, c) => {
      calls.push([name, c]);
      return [1, 2, 3];
    });
    expect(n).toBe(3);
    expect(calls).toEqual([["proj", cfg]]);
    expect(a.getProjectServerApproval("proj", "/p")).toBe("approved");
    expect(a.getPendingApprovalServers().names).toEqual([]);
  });

  test("不在快照里 → null，不调用 connect", async () => {
    const a = await import("@sid-code/core/mcp/approval.ts");
    let called = false;
    const n = await a.approveAndConnectPendingServer("nope", async () => {
      called = true;
      return [];
    });
    expect(n).toBeNull();
    expect(called).toBe(false);
  });

  test("注释不再声称「运行中没有补连入口」", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../src/mcp/approval.ts")).text();
    expect(src).not.toMatch(/运行中没有"补连一个 server"的入口/);
  });
});
