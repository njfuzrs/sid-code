/**
 * beta 泡制期「一修一号」流程（T1 / T3 / T5）的单测 + CLI 真跑。
 *
 * 落盘隔离：CLI 真跑时经 SID_CHANGELOG_CURATED_DIR 把 curated 目录指到 mkdtemp，
 * 不碰仓库里已入库的 changelog/curated/。
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCurated, type CuratedEntry } from "../../scripts/lib/changelog-curated-schema.ts";
import {
  betaOnlyViolation,
  describeBacklog,
  mergeStableNotes,
  resolveVersionChannel,
  versionsInRange,
  type StableNotes,
} from "../../scripts/lib/changelog-stable.ts";

const ROOT = join(import.meta.dir, "..", "..");
const CLI = join(ROOT, "scripts/changelog-stable.ts");

function entry(version: string, over: Partial<CuratedEntry> = {}): CuratedEntry {
  return {
    version,
    highlight: null,
    userFacing: true,
    sections: [{ title: "新功能", items: [`功能 ${version}`] }],
    commits: [],
    ...over,
  };
}

const betaFix = (version: string, note: string): CuratedEntry => ({
  version,
  highlight: null,
  userFacing: false,
  sections: [],
  commits: [],
  betaOnly: true,
  betaNote: note,
});

describe("versionsInRange：(stable, target] 左开右闭", () => {
  test("下界不含当前 stable，上界含目标", () => {
    expect(
      versionsInRange(
        ["0.1.606", "0.1.607", "0.1.608", "0.1.609", "0.1.610"],
        "0.1.606",
        "0.1.609",
      ),
    ).toEqual(["0.1.607", "0.1.608", "0.1.609"]);
  });

  test("按数值排序（0.1.10 > 0.1.9），去重", () => {
    expect(versionsInRange(["0.1.10", "0.1.9", "0.1.9"], "0.1.8", "0.1.10")).toEqual([
      "0.1.9",
      "0.1.10",
    ]);
  });

  test("不知道当前 stable 时只取目标自己（宁可少合并，也不把全部历史并进来）", () => {
    expect(versionsInRange(["0.1.1", "0.1.2"], null, "0.1.2")).toEqual(["0.1.2"]);
  });
});

describe("mergeStableNotes（T1）", () => {
  const v607 = entry("0.1.607", {
    highlight: "607 亮点",
    sections: [
      { title: "破坏性变更", items: ["Hook 语义变了"] },
      { title: "新功能", items: ["A", "B"] },
    ],
    commits: ["aaaaaaa"],
  });
  const v608 = betaFix("0.1.608", "修复 607 引入的崩溃");
  const v609 = entry("0.1.609", {
    sections: [
      { title: "新功能", items: ["B", "C"] },
      { title: "修复", items: ["修了一个老问题"] },
    ],
    commits: ["bbbbbbb"],
  });

  const merged = mergeStableNotes([v609, v607, v608], "0.1.609") as StableNotes;

  test("破坏性变更完整保留且在首组", () => {
    expect(merged.sections[0]).toEqual({
      title: "破坏性变更",
      items: ["Hook 语义变了"],
    });
  });

  test("betaOnly 版本整份丢弃，其余条目无丢失、无重复", () => {
    const all = merged.sections.flatMap((s) => s.items);
    expect(all).not.toContain("修复 607 引入的崩溃");
    expect(merged.sections.find((s) => s.title === "新功能")!.items).toEqual(["A", "B", "C"]);
    expect(merged.sections.find((s) => s.title === "修复")!.items).toEqual(["修了一个老问题"]);
    expect(new Set(all).size).toBe(all.length);
  });

  test("covers 升序覆盖区间全部版本（含被丢弃的 beta 号），以目标结尾", () => {
    expect(merged.covers).toEqual(["0.1.607", "0.1.608", "0.1.609"]);
    expect(merged.version).toBe("0.1.609");
    expect(merged.commits).toEqual(["aaaaaaa", "bbbbbbb"]);
  });

  test("合并结果通过 curated schema（会和普通 curated 一样被官网 / Release 读）", () => {
    expect(validateCurated(merged, "0.1.609")).toEqual([]);
  });

  test("快车道：区间只有一个版本时原样返回（逐字节相同，零行为变化）", () => {
    const only = entry("0.1.610", { highlight: "x" });
    const out = mergeStableNotes([only], "0.1.610");
    expect(out).toBe(only);
    expect(JSON.stringify(out)).toBe(JSON.stringify(only));
  });

  // 变异自证：若把区间下界写成闭区间（含当前 stable），上一个正式版的说明会被重复带进来。
  // 这里直接断言 versionsInRange + merge 组合不会出现 stable 自己的条目。
  test("变异自证：下界若含当前 stable 会把旧说明带进来 —— 现实现不会", () => {
    const v606 = entry("0.1.606", {
      sections: [{ title: "新功能", items: ["606 旧功能"] }],
    });
    const pool = {
      "0.1.606": v606,
      "0.1.607": v607,
      "0.1.608": v608,
      "0.1.609": v609,
    } as const;
    const range = versionsInRange(Object.keys(pool), "0.1.606", "0.1.609");
    const out = mergeStableNotes(
      range.map((v) => pool[v as keyof typeof pool]),
      "0.1.609",
    ) as StableNotes;
    expect(out.sections.flatMap((s) => s.items)).not.toContain("606 旧功能");
    // 闭区间实现会得到的错误结果，证明这条测试真的能红
    const wrong = mergeStableNotes(Object.values(pool), "0.1.609") as StableNotes;
    expect(wrong.sections.flatMap((s) => s.items)).toContain("606 旧功能");
  });

  test("最后一个版本不是目标时直接报错（防调用方传错区间）", () => {
    expect(() => mergeStableNotes([v607], "0.1.609")).toThrow();
  });
});

describe("curated 最小形态（T3）", () => {
  test("betaOnly 最小形态通过校验（省略 highlight / sections / commits）", () => {
    expect(
      validateCurated(
        {
          version: "0.1.608",
          userFacing: false,
          betaOnly: true,
          betaNote: "修复 x",
        },
        "0.1.608",
      ),
    ).toEqual([]);
  });

  test("betaOnly 但 userFacing:true → 拒绝（有用户可见变更的版本不能被合并丢弃）", () => {
    const errs = validateCurated({
      ...betaFix("0.1.608", "x"),
      userFacing: true,
      sections: [{ title: "修复", items: ["a"] }],
    });
    expect(errs.some((e) => e.includes("betaOnly"))).toBe(true);
  });

  test("betaOnly 缺 betaNote → 拒绝", () => {
    const errs = validateCurated({
      version: "0.1.608",
      userFacing: false,
      betaOnly: true,
    });
    expect(errs.some((e) => e.includes("betaNote"))).toBe(true);
  });

  test("betaNote 含 URL → 拒绝（会发布到公网）", () => {
    const errs = validateCurated(betaFix("0.1.608", "见 https://internal.example/x"));
    expect(errs.some((e) => e.includes("URL"))).toBe(true);
  });

  test("非 betaOnly 的普通 curated 仍要求完整字段（最小形态不放宽普通文件）", () => {
    const errs = validateCurated({ version: "0.1.608", userFacing: false });
    expect(errs.length).toBeGreaterThan(0);
  });

  test("已经是正式版的号不能标 betaOnly（除非被别的稳定版说明覆盖）", () => {
    const e = betaFix("0.1.607", "x");
    expect(betaOnlyViolation(e, "0.1.607", [])).not.toBeNull();
    expect(betaOnlyViolation(e, "0.1.606", [])).toBeNull(); // 还在 beta
    expect(
      betaOnlyViolation(e, "0.1.609", [
        { version: "0.1.609", covers: ["0.1.607", "0.1.608", "0.1.609"] },
      ]),
    ).toBeNull();
    expect(betaOnlyViolation(entry("0.1.607"), "0.1.609", [])).toBeNull(); // 不是 betaOnly
  });
});

describe("resolveVersionChannel（T2 官网通道标记）", () => {
  const notes = [{ version: "0.1.609", covers: ["0.1.607", "0.1.608", "0.1.609"] }];

  test("比当前 stable 新 → beta", () => {
    expect(resolveVersionChannel("0.1.610", "0.1.609", notes)).toEqual({
      channel: "beta",
      mergedInto: null,
    });
  });

  test("被稳定版跳过的中间号 → beta + mergedInto", () => {
    expect(resolveVersionChannel("0.1.608", "0.1.609", notes)).toEqual({
      channel: "beta",
      mergedInto: "0.1.609",
    });
  });

  test("稳定版本身与历史版本 → stable", () => {
    expect(resolveVersionChannel("0.1.609", "0.1.609", notes).channel).toBe("stable");
    expect(resolveVersionChannel("0.1.600", "0.1.609", notes).channel).toBe("stable");
  });

  test("文档场景：latest=0.1.606、beta=0.1.608 时 607/608 为 beta，606 为 stable", () => {
    expect(resolveVersionChannel("0.1.607", "0.1.606", []).channel).toBe("beta");
    expect(resolveVersionChannel("0.1.608", "0.1.606", []).channel).toBe("beta");
    expect(resolveVersionChannel("0.1.606", "0.1.606", []).channel).toBe("stable");
  });
});

describe("describeBacklog（T5）", () => {
  test("积压列表 = (stable, beta]，顺序递增", () => {
    const lookup = (v: string) =>
      v === "0.1.608" ? betaFix(v, "修崩溃") : entry(v, { highlight: `亮点 ${v}` });
    const lines = describeBacklog(
      "0.1.606",
      "0.1.609",
      ["0.1.605", "0.1.606", "0.1.607", "0.1.608", "0.1.609"],
      lookup,
    );
    expect(lines[0]).toContain("积压 3 个 beta 号");
    expect(lines.slice(1).map((l) => /v(\d+\.\d+\.\d+)/.exec(l)![1])).toEqual([
      "0.1.607",
      "0.1.608",
      "0.1.609",
    ]);
    expect(lines[2]).toContain("beta 修复：修崩溃");
  });

  test("beta 不比 stable 新 → 无积压", () => {
    expect(describeBacklog("0.1.609", "0.1.609", [], () => undefined)[0]).toContain("无积压");
  });
});

describe("changelog-stable.ts CLI（真跑，curated 目录隔离到 tmpdir）", () => {
  function run(dir: string, args: string[]) {
    return spawnSync("bun", ["run", CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, SID_CHANGELOG_CURATED_DIR: dir },
    });
  }
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), "sid-cl-stable-"));
    // 用远高于真实 tag 的号，避免与仓库 tag 列表混在一个区间里
    writeFileSync(join(dir, "v9.0.1.json"), JSON.stringify(entry("9.0.1", { highlight: "一" })));
    writeFileSync(join(dir, "v9.0.2.json"), JSON.stringify(betaFix("9.0.2", "修一")));
    writeFileSync(join(dir, "v9.0.3.json"), JSON.stringify(entry("9.0.3")));
    return dir;
  }

  test("merge 多版本：打印合并稿，--write 落到 stable/，且丢弃 beta-only", () => {
    const dir = fixture();
    try {
      const r = run(dir, ["merge", "9.0.0", "9.0.3", "--write"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("覆盖 9.0.1 / 9.0.2 / 9.0.3");
      expect(r.stdout).toContain("已丢弃 beta-only 修复号：v9.0.2");
      const out = JSON.parse(readFileSync(join(dir, "stable", "v9.0.3.json"), "utf8"));
      expect(out.covers).toEqual(["9.0.1", "9.0.2", "9.0.3"]);
      expect(validateCurated(out, "9.0.3")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("merge 单版本（快车道）：__SINGLE__ 且不写文件", () => {
    const dir = fixture();
    try {
      const r = run(dir, ["merge", "9.0.2", "9.0.3", "--write"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("__SINGLE__");
      expect(existsSync(join(dir, "stable"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 区间由「curated 文件名 + git tag」派生；真实发版里每个 beta 号都有 tag，
  // 所以缺文件会被发现。这里用「目标自己缺文件」验证报错路径。
  test("merge 区间内缺 curated → 非 0 退出（不静默漏版本）", () => {
    const dir = fixture();
    try {
      const r = run(dir, ["merge", "9.0.0", "9.0.9"]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("v9.0.9");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("beta-note 写最小形态，已存在则拒绝覆盖", () => {
    const dir = fixture();
    try {
      const ok = run(dir, ["beta-note", "9.0.5", "修复", "启动崩溃"]);
      expect(ok.status).toBe(0);
      const obj = JSON.parse(readFileSync(join(dir, "v9.0.5.json"), "utf8"));
      expect(obj).toMatchObject({
        betaOnly: true,
        userFacing: false,
        betaNote: "修复 启动崩溃",
      });
      expect(validateCurated(obj, "9.0.5")).toEqual([]);
      const again = run(dir, ["beta-note", "9.0.5", "x"]);
      expect(again.status).not.toBe(0);
      const missingNote = run(dir, ["beta-note", "9.0.6"]);
      expect(missingNote.status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
