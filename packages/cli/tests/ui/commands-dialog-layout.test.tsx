/**
 * /commands 面板布局回归：每条命令严格一行、来源列与描述列在所有行上对齐。
 *
 * 旧实现用 flex row + gap 直接摆三个 Text，长描述会把命令名挤成两行
 * （`/incident-r` + `ca`）、把 `[Skill]` 拆开，每行起点都不同。
 */
import { describe, test, expect } from "bun:test";
import React from "react";
import stringWidth from "string-width";
import { render } from "@sid-code/cli/ui/render-port/testing.ts";
import { KeypressProvider } from "@sid-code/cli/ui/contexts/KeypressContext.tsx";
import {
  CommandsDialog,
  computeCommandsLayout,
  formatCommandRow,
} from "@sid-code/cli/ui/components/CommandsDialog.tsx";
import type { UnifiedCommand } from "@sid-code/cli/command/types.ts";
import type { UnifiedCommandRegistry } from "@sid-code/cli/command/unified-registry.ts";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const CMDS = [
  {
    name: "incident-rca",
    source: "skill",
    type: "prompt",
    description:
      "针对线上 incident(P0/P1) 输出结构化根因分析报告. 跨 log / metric / trace /\n commit / ADR 5 个证据维度构造假设,排序根因,给出 hotfix / mitigation / long-term 三档行动建议.",
  },
  { name: "pr", source: "skill", type: "prompt", description: "生成 PR 标题与结构化描述" },
  {
    name: "security-audit",
    source: "skill",
    type: "prompt",
    description:
      "针对 PR diff 输出结构化安全审计报告. 检测 8 类漏洞 (injection / secret_leak / xss)",
  },
  { name: "vibe-bugfix", source: "user", type: "prompt", description: "自定义命令: vibe-bugfix" },
  {
    name: "project-qa",
    source: "project",
    type: "prompt",
    description: "项目追问：盘点讲稿缺口 / 按主题出题 / 把追问写成讲稿里的 Q",
  },
] as unknown as UnifiedCommand[];

const fakeRegistry = {
  getCommands: async () => CMDS,
} as unknown as UnifiedCommandRegistry;

async function frameLines(width: number): Promise<string[]> {
  const { lastFrame, unmount } = render(
    // 必须包 KeypressProvider：useKeypress 无 provider 会 throw，React 吞成空帧
    <KeypressProvider>
      <CommandsDialog onClose={() => {}} registry={fakeRegistry} />
    </KeypressProvider>,
    { columns: width },
  );
  // 等动态 import + getCommands 两层异步落地
  for (let i = 0; i < 50 && !(lastFrame() ?? "").includes("/pr"); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const out = stripAnsi(lastFrame() ?? "").split("\n");
  unmount();
  return out;
}

describe("CommandsDialog 三栏布局", () => {
  test("列宽计算：命令名列按最宽命令定宽，三栏总宽不超出可用宽度", () => {
    const layout = computeCommandsLayout(CMDS, 100);
    expect(layout.nameCol).toBe(stringWidth("/security-audit"));
    expect(layout.sourceCol).toBe(stringWidth("[Skill]"));
    expect(layout.nameCol + 2 + layout.sourceCol + 2 + layout.descCol).toBeLessThanOrEqual(100 - 7);
  });

  test("formatCommandRow：描述压成单行并截断到列宽", () => {
    const layout = computeCommandsLayout(CMDS, 80);
    const row = formatCommandRow(CMDS[0], layout);
    expect(row.desc).not.toContain("\n");
    expect(stringWidth(row.desc)).toBeLessThanOrEqual(layout.descCol);
    expect(row.desc.endsWith("…")).toBe(true);
    expect(stringWidth(row.name)).toBe(layout.nameCol);
  });

  for (const width of [80, 100, 140]) {
    test(`宽 ${width}：每条命令一行，来源列与描述列起点在所有行一致`, async () => {
      const lines = await frameLines(width);
      const rows = lines.filter((l) => /\/[a-z]/.test(l) && /\[(Skill|用户|项目)\]/.test(l));
      expect(rows.length).toBe(CMDS.length);

      const sourceStarts = rows.map((l) =>
        stringWidth(l.slice(0, l.search(/\[(Skill|用户|项目)\]/))),
      );
      expect(new Set(sourceStarts).size).toBe(1);

      // 描述起点：来源标签右侧第一个非空白字符
      const descStarts = rows.map((l) => {
        const m = l.match(/\[(Skill|用户|项目)\]\s+/)!;
        return stringWidth(l.slice(0, (m.index ?? 0) + m[0].length));
      });
      expect(new Set(descStarts).size).toBe(1);

      // 没有任何行溢出终端宽度（溢出即会被终端折行）
      for (const l of lines) expect(stringWidth(l)).toBeLessThanOrEqual(width);
    });
  }
});
