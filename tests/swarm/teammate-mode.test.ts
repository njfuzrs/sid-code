/**
 * P3-2：teammateMode 显示模式 + Agent Teams 实验开关 单测
 *
 * 覆盖：
 * - resolveTeammateMode 优先级：显式入参 > SID_TEAMMATE_MODE > in-process 默认；非法值回退
 * - generateTeamTmuxSessionName 安全化（路径分隔符/特殊字符不进 session 名）+ 长度封顶
 * - isAgentTeamsEnabled 默认关闭，仅 1/true 开启
 * - 开关关闭时 team_create 直接返回引导错误（不真的起团队），且描述里说明未启用
 */

import { describe, it, expect, afterEach } from "bun:test";
import { resolveTeammateMode } from "../../src/swarm/team.ts";
import { generateTeamTmuxSessionName } from "../../src/worktree/tmux.ts";
import { TeamCreateTool, isAgentTeamsEnabled } from "../../src/tool/team-create.ts";
import { ProviderRegistry } from "../../src/llm/registry.ts";
import { Registry as ToolRegistry } from "../../src/tool/registry.ts";

const MODE_KEY = "SID_TEAMMATE_MODE";
const TEAMS_KEY = "SID_ENABLE_AGENT_TEAMS";

afterEach(() => {
  delete process.env[MODE_KEY];
  delete process.env[TEAMS_KEY];
});

describe("resolveTeammateMode", () => {
  it("默认 in-process", () => {
    expect(resolveTeammateMode(undefined, undefined)).toBe("in-process");
  });

  it("显式入参优先于环境变量", () => {
    expect(resolveTeammateMode("in-process", "tmux")).toBe("in-process");
    expect(resolveTeammateMode("tmux", undefined)).toBe("tmux");
  });

  it("环境变量 tmux 生效", () => {
    expect(resolveTeammateMode(undefined, "tmux")).toBe("tmux");
  });

  it("非法环境变量值回退 in-process", () => {
    expect(resolveTeammateMode(undefined, "iterm")).toBe("in-process");
    expect(resolveTeammateMode(undefined, "")).toBe("in-process");
    expect(resolveTeammateMode(undefined, "TMUX")).toBe("in-process");
  });
});

describe("团队 tmux session 名安全化", () => {
  it("路径分隔符与特殊字符被剔除（防注入进 tmux 参数）", () => {
    const name = generateTeamTmuxSessionName("../../etc/passwd");
    expect(name).not.toContain("/");
    expect(name).not.toContain(".");
    expect(name.startsWith("sid-team-")).toBe(true);
  });

  it("长度封顶", () => {
    const name = generateTeamTmuxSessionName("x".repeat(200));
    expect(name.length).toBeLessThanOrEqual(50);
  });

  it("正常名保留可读性", () => {
    expect(generateTeamTmuxSessionName("refactor-api")).toBe("sid-team-refactor-api");
  });
});

describe("Agent Teams 实验开关", () => {
  it("默认关闭，仅 1/true 开启", () => {
    expect(isAgentTeamsEnabled(undefined)).toBe(false);
    expect(isAgentTeamsEnabled("")).toBe(false);
    expect(isAgentTeamsEnabled("0")).toBe(false);
    expect(isAgentTeamsEnabled("yes")).toBe(false);
    expect(isAgentTeamsEnabled("1")).toBe(true);
    expect(isAgentTeamsEnabled("true")).toBe(true);
  });

  const makeTool = () =>
    new TeamCreateTool(
      new ProviderRegistry({ provider: "anthropic", model: "test" } as any),
      new ToolRegistry(),
    );

  it("关闭时 execute 返回引导错误，不起团队", async () => {
    const res = await makeTool().execute({
      team_name: "t",
      members: [{ name: "w1", type: "explore", task: "看看代码" }],
    });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("SID_ENABLE_AGENT_TEAMS");
    // 引导到可用的替代方案，而不是只说"不行"
    expect(res.output).toContain("sub_agent");
  });

  it("关闭时 description 明示未启用（避免模型反复试）", () => {
    expect(makeTool().description()).toContain("未启用");
  });

  it("开启时 description 恢复正常说明", () => {
    process.env[TEAMS_KEY] = "1";
    const desc = makeTool().description();
    expect(desc).not.toContain("未启用");
    expect(desc).toContain("团队");
  });

  it("开启后参数校验照常生效（缺参仍报错，说明闸门已放行到校验层）", async () => {
    process.env[TEAMS_KEY] = "1";
    const res = await makeTool().execute({ team_name: "t" });
    expect(res.isError).toBe(true);
    expect(res.output).toContain("缺少必需参数");
  });
});
