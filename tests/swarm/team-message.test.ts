/**
 * P1-3：mailbox 写入口（team_message 工具）单测
 *
 * 覆盖：
 * - 非团队上下文调用 → 明确报错（不静默投递到残留身份上）
 * - 成员 → leader / 成员 → peer 投递，收信人能 drain 到
 * - 身份取自 ALS（发信人是绑定的成员，不由调用方自报）
 * - 收信人不存在 / 发给自己 → 报错
 * - 并发成员各自身份不串台
 * - tool-filter 不会把 team_message 裁掉（Layer 2 白名单 + Layer 4 异步白名单豁免）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Mailbox } from "@sid-code/core/swarm/mailbox.ts";
import { withTeamMember, getTeamMemberContext } from "@sid-code/core/swarm/team-context.ts";
import { TeamMessageTool } from "@sid-code/core/tool/team-message.ts";
import { filterToolsForAgent } from "@sid-code/core/agent/tool-filter.ts";

let dir: string;
let mailbox: Mailbox;
const tool = new TeamMessageTool();

/** 在成员身份上下文里跑 fn。 */
const asMember = <T>(memberName: string, members: string[], fn: () => T): T =>
  withTeamMember(
    { teamName: "alpha", memberName, mailbox, memberNames: members },
    fn,
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-team-msg-"));
  mailbox = new Mailbox(dir);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("team_message 身份与投递", () => {
  it("非团队上下文调用 → 报错，不投递", async () => {
    const res = await tool.execute({ to: "leader", message: "hi" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("不在团队成员上下文");
  });

  it("成员 → leader 投递，leader 能 drain 到且发信人是绑定身份", async () => {
    const res = await asMember("worker1", ["worker1", "worker2"], () =>
      tool.execute({ to: "leader", message: "进度过半", kind: "info" }),
    );
    expect(res.isError).toBeFalsy();

    const msgs = mailbox.drain("leader");
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("worker1");
    expect(msgs[0]!.to).toBe("leader");
    expect(msgs[0]!.content).toBe("进度过半");
    expect(msgs[0]!.kind).toBe("info");
  });

  it("成员 → peer 投递，peer 能 drain 到", async () => {
    await asMember("worker1", ["worker1", "worker2"], () =>
      tool.execute({ to: "worker2", message: "接口定为 POST /v1/x" }),
    );
    const msgs = mailbox.drain("worker2");
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("worker1");
    expect(msgs[0]!.content).toContain("POST /v1/x");
    // 默认 kind=info
    expect(msgs[0]!.kind).toBe("info");
  });

  it("收信人不在团队中 → 报错且不投递", async () => {
    const res = await asMember("worker1", ["worker1", "worker2"], () =>
      tool.execute({ to: "ghost", message: "hi" }),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("不在团队中");
    expect(mailbox.peekCount("ghost")).toBe(0);
  });

  it("发给自己 → 报错", async () => {
    const res = await asMember("worker1", ["worker1", "worker2"], () =>
      tool.execute({ to: "worker1", message: "hi" }),
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain("不能给自己");
  });

  it("缺少参数 → 报错", async () => {
    const res = await asMember("worker1", ["worker1"], () => tool.execute({ to: "leader" }));
    expect(res.isError).toBe(true);
  });

  it("并发成员身份不串台（各自 ALS store 独立）", async () => {
    const members = ["w1", "w2", "w3"];
    await Promise.all(
      members.map((m) =>
        asMember(m, members, async () => {
          // 插入 await 制造交错，验证跨 await 身份不丢/不串
          await new Promise((r) => setTimeout(r, 5));
          expect(getTeamMemberContext()!.memberName).toBe(m);
          return tool.execute({ to: "leader", message: `来自${m}` });
        }),
      ),
    );
    const msgs = mailbox.drain("leader");
    expect(msgs.length).toBe(3);
    expect(msgs.map((x) => x.from).sort()).toEqual(["w1", "w2", "w3"]);
    // 每条消息内容与发信人一致（若串台会出现 from=w1 content=来自w2 这类错配）
    for (const m of msgs) expect(m.content).toBe(`来自${m.from}`);
  });
});

describe("team_message 不被工具过滤裁掉", () => {
  const fakeTool = (name: string) => ({ name: () => name }) as any;
  const tools = [fakeTool("team_message"), fakeTool("read"), fakeTool("bash")];
  const names = (list: any[]) => list.map((t) => t.name());

  it("内置 explore 白名单（不含 bash）仍保留 team_message", () => {
    const kept = names(filterToolsForAgent(tools, { isBuiltIn: true, builtInType: "explore" }));
    expect(kept).toContain("team_message");
    expect(kept).toContain("read");
    expect(kept).not.toContain("bash"); // 白名单本身仍生效
  });

  it("后台异步 agent 白名单仍保留 team_message", () => {
    const kept = names(filterToolsForAgent(tools, { isAsync: true }));
    expect(kept).toContain("team_message");
  });

  it("用户显式 disallowedTools 仍能禁掉 team_message（Layer 3 优先）", () => {
    const kept = names(
      filterToolsForAgent(tools, { isBuiltIn: true, builtInType: "task", disallowedTools: ["team_message"] }),
    );
    expect(kept).not.toContain("team_message");
  });
});
