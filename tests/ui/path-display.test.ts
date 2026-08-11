/**
 * 工具 header 摘要的「宽度自适应 + 保住关键信息」回归测试。
 *
 * 锁定本次修复的两条铁律（见 docs/_template/tui界面右侧空间没有被有效利用…）：
 *
 *   1. **收缩看真实列宽，不看固定常数** —— 宽终端要把右侧空间用上；
 *      此前数据层按 50 码点硬截断，120 列终端也只显示 50 列。
 *   2. **路径从头部省略，保住文件名** —— 路径的信息密度在尾部；
 *      此前尾截断保住的是每行都一样的 `/Users/…/sid-code/` 噪音前缀。
 */

import { describe, test, expect } from "bun:test";
import {
  shortenPathForDisplay,
  stripPathNoiseInText,
  fitPathToWidth,
  fitTextToWidth,
} from "../../src/ui/utils/path-display.ts";
import { stringWidth } from "../../src/ink/stringWidth.ts";

const CWD = "/Users/me/Code/person/sid-code";
const HOME = "/Users/me";

describe("shortenPathForDisplay — 去噪音前缀（与终端宽度无关）", () => {
  test("cwd 之内 → 转相对路径（去掉每行都一样的前缀）", () => {
    expect(
      shortenPathForDisplay(`${CWD}/docs/bugfixes/todo/x.md`, CWD, HOME),
    ).toBe("docs/bugfixes/todo/x.md");
  });

  test("home 之内但不在 cwd → ~ 前缀", () => {
    expect(shortenPathForDisplay(`${HOME}/other/y.ts`, CWD, HOME)).toBe(
      "~/other/y.ts",
    );
  });

  test("cwd 外 home 外 → 原样", () => {
    expect(shortenPathForDisplay("/etc/hosts", CWD, HOME)).toBe("/etc/hosts");
  });

  test("相对路径原样返回", () => {
    expect(shortenPathForDisplay("src/a.ts", CWD, HOME)).toBe("src/a.ts");
  });

  test("前缀比较带分隔符，不把 /a/bc 误判为 /a/b 的子路径", () => {
    expect(shortenPathForDisplay("/a/bc/d.ts", "/a/b", HOME)).toBe("/a/bc/d.ts");
  });

  test("路径恰等于 cwd 时不返回空串（落到 ~ 形式，仍是有效显示）", () => {
    // rel 为空串时不能显示成空——退到 home 分支给出 `~/Code/person/sid-code`
    expect(shortenPathForDisplay(CWD, CWD, HOME)).toBe("~/Code/person/sid-code");
  });

  test("**不做截断**：长路径原样保留，截断交给视图层", () => {
    const long = `${CWD}/${"seg/".repeat(30)}tail.md`;
    const out = shortenPathForDisplay(long, CWD, HOME);
    expect(out.endsWith("tail.md")).toBe(true);
    expect(out).not.toContain("…");
  });
});

describe("stripPathNoiseInText — 剥掉散文里内嵌的绝对路径", () => {
  test("prompt 里的 cwd → `.`（省下的列宽留给有区分度的内容）", () => {
    expect(
      stripPathNoiseInText(`你在核查 sid-code 仓库（${CWD}）里 B1 批次`, CWD, HOME),
    ).toBe("你在核查 sid-code 仓库（.）里 B1 批次");
  });

  test("cwd 优先于 home（更长、更省列宽）", () => {
    expect(stripPathNoiseInText(`看 ${CWD}/src/a.ts`, CWD, HOME)).toBe(
      "看 ./src/a.ts",
    );
  });

  test("cwd 外的 home 路径 → ~", () => {
    expect(stripPathNoiseInText(`看 ${HOME}/other/b.ts`, CWD, HOME)).toBe(
      "看 ~/other/b.ts",
    );
  });

  test("同一句里多处出现全部替换", () => {
    expect(stripPathNoiseInText(`从 ${CWD}/a 到 ${CWD}/b`, CWD, HOME)).toBe(
      "从 ./a 到 ./b",
    );
  });

  test("路径含正则元字符时按字面量替换，不当模式解释", () => {
    const weird = "/Users/me/pro.ject+v1";
    expect(stripPathNoiseInText(`在 ${weird}/x.ts 里`, weird, HOME)).toBe(
      "在 ./x.ts 里",
    );
  });

  test("无内嵌路径时原样返回", () => {
    expect(stripPathNoiseInText("普通一句话", CWD, HOME)).toBe("普通一句话");
  });
});

describe("fitPathToWidth — 从头部省略，保住文件名", () => {
  const p = "docs/bugfixes/todo/20260801-韧性层架构对齐CC-方案.md";

  test("放得下就原样（不无谓加省略号）", () => {
    expect(fitPathToWidth(p, 200)).toBe(p);
  });

  test("放不下时保住文件名，砍掉的是目录", () => {
    const out = fitPathToWidth(p, 40);
    expect(out.endsWith("20260801-韧性层架构对齐CC-方案.md")).toBe(true);
    expect(out.startsWith("…/")).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(40);
  });

  test("宽度越大保留的目录层级越多（右侧空间被用上）", () => {
    const narrow = fitPathToWidth(p, 40);
    const wide = fitPathToWidth(p, 50);
    expect(stringWidth(wide)).toBeGreaterThan(stringWidth(narrow));
    // 两者都仍保住文件名
    expect(wide.endsWith("方案.md")).toBe(true);
    expect(narrow.endsWith("方案.md")).toBe(true);
  });

  test("任何宽度下都不超预算（CJK 按列宽算，不是码点数）", () => {
    for (let w = 4; w <= 60; w++) {
      expect(stringWidth(fitPathToWidth(p, w))).toBeLessThanOrEqual(w);
    }
  });

  test("连文件名都放不下 → 中段省略但保住扩展名", () => {
    const out = fitPathToWidth("docs/a/20260801-很长很长的文件名.md", 14);
    expect(out.endsWith(".md")).toBe(true);
    expect(out).toContain("…");
    expect(stringWidth(out)).toBeLessThanOrEqual(14);
  });

  test("尾部元信息后缀（read 的行号范围）被保留，不因路径长被挤掉", () => {
    const withSuffix = `${p} (行 1-100)`;
    const out = fitPathToWidth(withSuffix, 45);
    expect(out.endsWith(" (行 1-100)")).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(45);
  });

  test("maxCols <= 0 → 空串（不崩、不返回原文）", () => {
    expect(fitPathToWidth(p, 0)).toBe("");
    expect(fitPathToWidth(p, -5)).toBe("");
  });
});

describe("fitTextToWidth — 文本从尾部省略（信息密度在头部）", () => {
  test("放得下原样", () => {
    expect(fitTextToWidth("bun test", 20)).toBe("bun test");
  });

  test("放不下保留头部 + 省略号", () => {
    const out = fitTextToWidth("你在核查 sid-code 仓库里 B1 批次的落地情况", 20);
    expect(out.startsWith("你在核查")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(stringWidth(out)).toBeLessThanOrEqual(20);
  });

  test("CJK 按列宽收缩，不超预算", () => {
    const text = "中文".repeat(50);
    for (let w = 2; w <= 40; w++) {
      expect(stringWidth(fitTextToWidth(text, w))).toBeLessThanOrEqual(w);
    }
  });

  test("maxCols <= 0 → 空串", () => {
    expect(fitTextToWidth("abc", 0)).toBe("");
  });
});

describe("回归：截图里的两个具体症状", () => {
  const abs = `${CWD}/docs/bugfixes/todo/20260801-韧性层架构对齐CC-子代理韧性能力根治方案.md`;

  test("症状一：不再保留噪音前缀丢掉文件名（旧行为 `…/docs/bugf…`）", () => {
    const summary = shortenPathForDisplay(abs, CWD, HOME);
    const shown = fitPathToWidth(summary, 60);
    // 旧行为砍掉了文件名，只剩到 docs/bugf；现在文件名必须在
    expect(shown).toContain("根治方案.md");
    expect(shown).not.toContain("/Users/");
  });

  test("症状二：终端越宽显示越多（右侧留白被利用）", () => {
    const summary = shortenPathForDisplay(abs, CWD, HOME);
    const w80 = fitPathToWidth(summary, 50);
    const w140 = fitPathToWidth(summary, 110);
    expect(stringWidth(w140)).toBeGreaterThan(stringWidth(w80));
    // 足够宽时完整显示，一个省略号都不用加
    expect(w140).toBe(summary);
  });

  test("症状三：并行 sub_agent 卡片在窄终端也彼此可区分", () => {
    // 截图里 5 个 sub_agent 行截断后逐字相同，根因同为噪音吃光预算
    const prompts = [
      `你在核查 sid-code 仓库（${CWD}）里 B0 批次：权限层安全缺口`,
      `你在核查 sid-code 仓库（${CWD}）里 B1 批次：韧性层状态搬迁`,
      `你在核查 sid-code 仓库（${CWD}）里 B2 批次：收敛成唯一漏斗`,
    ];
    // 80 列终端下 sub_agent header 的 description 预算
    const budget = 80 - 4 - 3 - stringWidth("sub_agent");
    const shown = prompts.map((p) =>
      fitTextToWidth(
        `general-purpose "${stripPathNoiseInText(p, CWD, HOME)}"`,
        budget,
      ),
    );
    expect(new Set(shown).size).toBe(3);
    // 且区分点（批次号）确实可见
    expect(shown[0]).toContain("B0");
    expect(shown[1]).toContain("B1");
    expect(shown[2]).toContain("B2");
  });

  test("防线：再宽也只占一行、不超给定预算（不侵占屏幕）", () => {
    const summary = shortenPathForDisplay(abs, CWD, HOME);
    for (const w of [20, 40, 60, 80, 120]) {
      const out = fitPathToWidth(summary, w);
      expect(out).not.toContain("\n");
      expect(stringWidth(out)).toBeLessThanOrEqual(w);
    }
  });
});
