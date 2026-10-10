/**
 * Phase 2 单测：StructuredIO（NDJSON 双向通信）
 */

import { describe, test, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { z } from "zod/v3";
import { StructuredIO } from "@sid-code/core/sdk/structured-io.ts";
import { ndjsonStringify } from "@sid-code/core/sdk/ndjson.ts";
import type { SDKMessage } from "@sid-code/core/sdk/types.ts";

/** 读取 PassThrough 输出的所有 NDJSON 行（已解析） */
function collectOutput(stream: PassThrough): Promise<unknown[]> {
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (c) => (buf += c.toString("utf-8")));
    stream.on("end", () => {
      const lines = buf
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      resolve(lines);
    });
  });
}

describe("StructuredIO.write", () => {
  test("写出 NDJSON 行", async () => {
    const out = new PassThrough();
    const io = new StructuredIO(new PassThrough(), out);
    const collected = collectOutput(out);

    const msg: SDKMessage = {
      type: "system",
      subtype: "status",
      message: "hello",
    };
    await io.write(msg);
    out.end();

    const lines = await collected;
    expect(lines).toEqual([msg]);
  });

  test("多条消息不交错（写队列序列化）", async () => {
    const out = new PassThrough();
    const io = new StructuredIO(new PassThrough(), out);
    const collected = collectOutput(out);

    const msgs: SDKMessage[] = Array.from({ length: 5 }, (_, i) => ({
      type: "system",
      subtype: "status",
      message: `m${i}`,
    }));
    // 并发触发 write，不 await 中间结果
    await Promise.all(msgs.map((m) => io.write(m)));
    out.end();

    const lines = (await collected) as { message: string }[];
    expect(lines.map((l) => l.message)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });
});

describe("StructuredIO.read", () => {
  test("yield user 消息，忽略 keep_alive", async () => {
    const input = new PassThrough();
    const io = new StructuredIO(input, new PassThrough());

    const userMsg = {
      type: "user",
      uuid: "u1",
      session_id: "s1",
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    };

    input.write(ndjsonStringify({ type: "keep_alive" }) + "\n");
    input.write(ndjsonStringify(userMsg) + "\n");
    input.end();

    const received: unknown[] = [];
    for await (const m of io.read()) received.push(m);
    expect(received).toEqual([userMsg]);
  });

  test("跳过非法 JSON 行", async () => {
    const input = new PassThrough();
    const io = new StructuredIO(input, new PassThrough());

    input.write("not json\n");
    input.write(
      ndjsonStringify({
        type: "user",
        uuid: "u",
        session_id: "s",
        message: { role: "user", content: [] },
      }) + "\n",
    );
    input.end();

    const received: unknown[] = [];
    for await (const m of io.read()) received.push(m);
    expect(received.length).toBe(1);
  });
});

describe("StructuredIO.sendRequest", () => {
  test("请求-响应匹配并 Zod 校验", async () => {
    const input = new PassThrough();
    const out = new PassThrough();
    const io = new StructuredIO(input, out);

    // 后台启动 read 循环（消费 control_response）
    (async () => {
      for await (const _ of io.read()) {
        /* drain */
      }
    })();

    // 捕获发出的 control_request 的 request_id
    let requestId = "";
    out.on("data", (c) => {
      const line = c.toString("utf-8").trim();
      if (!line) return;
      const msg = JSON.parse(line);
      if (msg.type === "control_request") {
        requestId = msg.request_id;
        // 模拟宿主回复
        input.write(
          ndjsonStringify({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: requestId,
              response: { behavior: "allow", tool_use_id: "t1" },
            },
          }) + "\n",
        );
      }
    });

    const schema = z.object({
      behavior: z.enum(["allow", "deny", "always_allow"]),
      tool_use_id: z.string(),
    });
    const result = await io.sendRequest(
      { subtype: "can_use_tool", tool_name: "Bash", input: {}, tool_use_id: "t1" },
      schema,
    );
    expect(result.behavior).toBe("allow");
    expect(requestId).not.toBe("");
  });

  test("error 响应 reject", async () => {
    const input = new PassThrough();
    const out = new PassThrough();
    const io = new StructuredIO(input, out);

    (async () => {
      for await (const _ of io.read()) {
        /* drain */
      }
    })();

    out.on("data", (c) => {
      const line = c.toString("utf-8").trim();
      if (!line) return;
      const msg = JSON.parse(line);
      if (msg.type === "control_request") {
        input.write(
          ndjsonStringify({
            type: "control_response",
            response: { subtype: "error", request_id: msg.request_id, error: "boom" },
          }) + "\n",
        );
      }
    });

    const promise = io.sendRequest({ subtype: "interrupt" }, z.unknown());
    await expect(promise).rejects.toThrow("boom");
  });

  test("AbortSignal 中断请求", async () => {
    const io = new StructuredIO(new PassThrough(), new PassThrough());
    const ac = new AbortController();
    const promise = io.sendRequest({ subtype: "interrupt" }, z.unknown(), ac.signal);
    ac.abort();
    await expect(promise).rejects.toThrow("aborted");
  });
});

describe("StructuredIO.write 按条结算（缺陷 1）", () => {
  const msg = (m: string): SDKMessage => ({ type: "system", subtype: "status", message: m });

  test("第 2 次写抛错：只有 B reject，A/C fulfilled，C 仍被写出", async () => {
    const written: string[] = [];
    let n = 0;
    const out = new PassThrough();
    (out as any).write = (line: string) => {
      n++;
      if (n === 2) throw new Error("EPIPE-like");
      written.push(JSON.parse(line).message);
      return true;
    };
    const io = new StructuredIO(new PassThrough(), out);
    const [A, B, C] = await Promise.allSettled([
      io.write(msg("A")),
      io.write(msg("B")),
      io.write(msg("C")),
    ]);
    expect(A.status).toBe("fulfilled");
    expect(B.status).toBe("rejected");
    expect((B as PromiseRejectedResult).reason.message).toBe("EPIPE-like");
    expect(C.status).toBe("fulfilled");
    expect(written).toEqual(["A", "C"]);
  });

  test("await write(x) 返回时 x 已交给 output（不是入队即 resolve）", async () => {
    const written: string[] = [];
    const out = new PassThrough();
    let release!: () => void;
    (out as any).write = (line: string) => {
      written.push(JSON.parse(line).message);
      if (written.length === 1) {
        // 第一条触发背压，drain 之前后续条目都不该被写、也不该 resolve
        setTimeout(() => release(), 5);
        return false;
      }
      return true;
    };
    (out as any).once = (ev: string, cb: () => void) => {
      if (ev === "drain") release = cb;
      return out;
    };
    const io = new StructuredIO(new PassThrough(), out);
    let bDone = false;
    const a = io.write(msg("A"));
    const b = io.write(msg("B")).then(() => (bDone = true));
    await Promise.resolve();
    expect(bDone).toBe(false);
    await a;
    await b;
    expect(written).toEqual(["A", "B"]);
  });

  test("控制请求的写失败由它自己的 sendRequest reject，不挂起", async () => {
    let n = 0;
    const out = new PassThrough();
    (out as any).write = () => {
      n++;
      if (n === 2) throw new Error("EPIPE-like");
      return true;
    };
    const io = new StructuredIO(new PassThrough(), out);
    const first = io.write(msg("A"));
    const req = io.sendRequest({ subtype: "interrupt" }, z.unknown());
    await first;
    await expect(req).rejects.toThrow("EPIPE-like");
    expect(io.pendingRequestCount()).toBe(0);
  });
});

describe("StructuredIO.sendRequest abort 监听解绑（缺陷 2）", () => {
  function countingSignal() {
    const ac = new AbortController();
    let live = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    (ac.signal as any).addEventListener = (...args: any[]) => {
      live++;
      return (add as any)(...args);
    };
    (ac.signal as any).removeEventListener = (...args: any[]) => {
      live--;
      return (remove as any)(...args);
    };
    return { signal: ac.signal, live: () => live };
  }

  test("共享长寿 signal 上连发 20 个请求并全部 resolve，监听器数归零", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    output.on("data", (chunk) => {
      for (const line of chunk.toString("utf-8").split("\n").filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.type !== "control_request") continue;
        input.write(
          ndjsonStringify({
            type: "control_response",
            response: { subtype: "success", request_id: m.request_id, response: 1 },
          }) + "\n",
        );
      }
    });
    const reading = (async () => {
      for await (const _ of io.read()) {
        /* drain */
      }
    })();
    const { signal, live } = countingSignal();
    for (let i = 0; i < 20; i++) {
      await io.sendRequest({ subtype: "interrupt" }, z.number(), signal);
    }
    expect(live()).toBe(0);
    input.end();
    await reading;
  });

  test("错误响应 reject 时同样解绑", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = new StructuredIO(input, output);
    output.on("data", (chunk) => {
      const m = JSON.parse(chunk.toString("utf-8").trim());
      input.write(
        ndjsonStringify({
          type: "control_response",
          response: { subtype: "error", request_id: m.request_id, error: "nope" },
        }) + "\n",
      );
    });
    const reading = (async () => {
      for await (const _ of io.read()) {
        /* drain */
      }
    })();
    const { signal, live } = countingSignal();
    await expect(io.sendRequest({ subtype: "interrupt" }, z.unknown(), signal)).rejects.toThrow(
      "nope",
    );
    expect(live()).toBe(0);
    input.end();
    await reading;
  });
});
