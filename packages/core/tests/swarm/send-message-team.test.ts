/**
 * P1-5：send_message 在团队上下文里按成员名 / "*" 寻址。
 *
 * 两条来源：成员执行链的 ALS 上下文，和主代理侧的活跃团队登记。
 * 不在任何团队上下文时退回 task_id 解析（原行为不变）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Mailbox } from "@sid-code/core/swarm/mailbox.ts";
import { withTeamMember } from "@sid-code/core/swarm/team-context.ts";
import { TeamManager, getActiveTeam, withActiveTeam } from "@sid-code/core/swarm/team.ts";
import { SendMessageTool } from "@sid-code/core/tool/send-message.ts";

let dir: string;
let mailbox: Mailbox;
const tool = new SendMessageTool();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sid-send-team-"));
  mailbox = new Mailbox(dir);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const asMember = <T>(memberName: string, fn: () => T): T =>
  withTeamMember({ teamName: "alpha", memberName, mailbox, memberNames: ["alice", "bob"] }, fn);

describe("send_message 团队寻址", () => {
  it("成员上下文里 to=成员名 投进对方收件箱", async () => {
    const res = await asMember("alice", () => tool.execute({ to: "bob", message: "看一下" }));
    expect(res.isError).toBeFalsy();
    const msgs = mailbox.drain("bob");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].from).toBe("alice");
    expect(msgs[0].content).toBe("看一下");
  });

  it("成员上下文里 to=* 广播给其他成员", async () => {
    const res = await asMember("alice", () => tool.execute({ to: "*", message: "同步" }));
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.output).status).toBe("broadcast");
    expect(mailbox.drain("bob")).toHaveLength(1);
    expect(mailbox.drain("alice")).toHaveLength(0);
  });

  it("非团队上下文里 to=名字 退回 task_id 解析并报不存在", async () => {
    const res = await tool.execute({ to: "bob", message: "x" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("不存在");
    expect(mailbox.drain("bob")).toHaveLength(0);
  });

  it("withActiveTeam 期间 leader 可按名投递，结束后登记清除且不再投递", async () => {
    const team = new TeamManager({
      teamName: "alpha",
      members: [
        { name: "alice", type: "general", task: "a" },
        { name: "bob", type: "general", task: "b" },
      ],
      providerRegistry: {} as never,
      toolRegistry: {} as never,
      baseDir: dir,
    });
    expect(getActiveTeam()).toBeNull();

    await withActiveTeam(team, async () => {
      expect(getActiveTeam()).toBe(team);
      const res = await tool.execute({ to: "alice", message: "leader 的补充" });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(res.output).status).toBe("delivered");
      // leader 侧的 "*" 广播给全部成员
      const bc = await tool.execute({ to: "*", message: "全体注意" });
      expect(JSON.parse(bc.output).recipients.sort()).toEqual(["alice", "bob"]);
    });

    // 登记已清除：再按名发退回 task_id 解析
    expect(getActiveTeam()).toBeNull();
    const after = await tool.execute({ to: "alice", message: "不该投出" });
    expect(after.isError).toBe(true);

    const alice = team.mailbox.drain("alice");
    expect(alice.map((m) => m.content)).toEqual(["leader 的补充", "全体注意"]);
    expect(alice.every((m) => m.from === "leader")).toBe(true);
    expect(team.mailbox.drain("bob").map((m) => m.content)).toEqual(["全体注意"]);
  });

  it("withActiveTeam 内抛错也清除登记", async () => {
    const team = new TeamManager({
      teamName: "alpha",
      members: [{ name: "alice", type: "general", task: "a" }],
      providerRegistry: {} as never,
      toolRegistry: {} as never,
      baseDir: dir,
    });
    let threw = false;
    try {
      await withActiveTeam(team, () => {
        throw new Error("成员执行失败");
      });
    } catch (err: any) {
      threw = true;
      expect(err.message).toBe("成员执行失败");
    }
    expect(threw).toBe(true);
    expect(getActiveTeam()).toBeNull();
  });
});
