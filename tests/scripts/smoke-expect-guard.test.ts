/**
 * G2 用例期望守卫（scripts/smoke/expect-guard.ts）：总纲 §3.4 的两条检查。
 *
 * 两段：
 *  1. `caseFingerprint` / `judge` 纯函数：什么算「改了期望」、两条规则怎么判；
 *  2. `collectChanges` 走真 git 临时仓：夹具 / case.ts / 新增 / 删除按用例归并对。
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  caseFingerprint,
  collectChanges,
  judge,
  REVIEW_LABEL,
} from "../../scripts/smoke/expect-guard.ts";

const BASE = `/** 注释 */
const MARKER = "M1";
const def = {
  id: "X-demo",
  argv: ["-p", "hi"],
  expect: { exitCode: 0, events: [{ event: "E", count: 1 }] },
  mutations: [{ file: "a.ts", find: "x", replace: "y", why: "w" }],
};
export default def;
`;

describe("caseFingerprint：什么算改了期望", () => {
  test("只改注释 / 排版 → 不算", () => {
    const edited = BASE.replace("/** 注释 */", "// 换了个说法").replace(
      'argv: ["-p", "hi"],',
      'argv: [\n    "-p",\n    "hi",\n  ],',
    );
    expect(caseFingerprint(edited)).toBe(caseFingerprint(BASE));
  });

  test("只改 mutations（配方随源码漂移）→ 不算", () => {
    const edited = BASE.replace('find: "x"', 'find: "x2"').replace(
      "mutations: [{",
      'mutations: [{ file: "b.ts", find: "p", replace: "q", why: "w2" }, {',
    );
    expect(caseFingerprint(edited)).toBe(caseFingerprint(BASE));
  });

  test("改 expect 字段 → 算", () => {
    expect(caseFingerprint(BASE.replace("count: 1", "count: 2"))).not.toBe(caseFingerprint(BASE));
  });

  test("改 expect 引用的顶层常量 → 算（只比 expect 字段会漏）", () => {
    expect(caseFingerprint(BASE.replace('"M1"', '"M2"'))).not.toBe(caseFingerprint(BASE));
  });

  test("改输入（argv）→ 算：输入一换，断言可能空转", () => {
    expect(caseFingerprint(BASE.replace('"hi"', '"bye"'))).not.toBe(caseFingerprint(BASE));
  });
});

describe("judge：两条规则", () => {
  const changed = BASE.replace("count: 1", "count: 2");

  test("新增用例：无论夹具与标签都放行", () => {
    const v = judge({ id: "N", baseCase: null, headCase: BASE, fixtureChanged: true }, []);
    expect(v.kind).toBe("ok");
  });

  test("只刷新夹具：放行", () => {
    const v = judge({ id: "A", baseCase: BASE, headCase: BASE, fixtureChanged: true }, []);
    expect(v.kind).toBe("ok");
  });

  test("规则 1：夹具与期望同改 → 报错，带标签也不放", () => {
    const v = judge({ id: "A", baseCase: BASE, headCase: changed, fixtureChanged: true }, [
      REVIEW_LABEL,
    ]);
    expect(v).toMatchObject({ kind: "error", rule: 1 });
  });

  test("规则 2：只改期望、没标签 → 报错", () => {
    const v = judge({ id: "A", baseCase: BASE, headCase: changed, fixtureChanged: false }, [
      "enhancement",
    ]);
    expect(v).toMatchObject({ kind: "error", rule: 2 });
  });

  test("规则 2：只改期望、带标签 → 放行", () => {
    const v = judge({ id: "A", baseCase: BASE, headCase: changed, fixtureChanged: false }, [
      REVIEW_LABEL,
    ]);
    expect(v.kind).toBe("ok");
  });

  test("删除已有用例：按规则 2，需要标签", () => {
    const v = judge({ id: "A", baseCase: BASE, headCase: null, fixtureChanged: true }, []);
    expect(v).toMatchObject({ kind: "error", rule: 2 });
    expect(
      judge({ id: "A", baseCase: BASE, headCase: null, fixtureChanged: true }, [REVIEW_LABEL]).kind,
    ).toBe("ok");
  });
});

describe("collectChanges：真 git 仓库按用例归并", () => {
  let repo: string;
  const sh = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  const put = (rel: string, content: string) => {
    const p = join(repo, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  };

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "sid-expect-guard-"));
    sh("init", "-q");
    sh("config", "user.email", "t@e");
    sh("config", "user.name", "t");
    sh("config", "commit.gpgsign", "false");
    put("tests/smoke/cases/A/case.ts", BASE);
    put("tests/smoke/cases/A/replay.jsonl", "{}\n");
    put("tests/smoke/cases/B/case.ts", BASE);
    put("tests/smoke/cases/D/case.ts", BASE);
    put("README.md", "x\n");
    sh("add", ".");
    sh("commit", "-qm", "base");
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("夹具 / 期望 / 新增 / 删除各自归到正确用例", () => {
    const base = sh("rev-parse", "HEAD");
    put("tests/smoke/cases/A/replay.jsonl", "{}\n{}\n"); // A：只刷夹具
    put("tests/smoke/cases/B/case.ts", BASE.replace("count: 1", "count: 2")); // B：改期望
    put("tests/smoke/cases/C/case.ts", BASE); // C：新增
    rmSync(join(repo, "tests/smoke/cases/D"), { recursive: true }); // D：删除
    put("README.md", "y\n"); // 用例目录外：不计
    sh("add", "-A");
    sh("commit", "-qm", "head");

    const changes = collectChanges(base, "HEAD", repo).sort((a, b) => a.id.localeCompare(b.id));
    expect(changes.map((c) => c.id)).toEqual(["A", "B", "C", "D"]);
    const [a, b, c, d] = changes;
    expect([a!.fixtureChanged, a!.baseCase === a!.headCase]).toEqual([true, true]);
    expect([b!.fixtureChanged, b!.baseCase !== b!.headCase]).toEqual([false, true]);
    expect(c!.baseCase).toBeNull();
    expect(d!.headCase).toBeNull();

    const verdicts = changes.map((x) => judge(x, []));
    expect(verdicts.map((v) => v.kind)).toEqual(["ok", "error", "ok", "error"]);
  });

  test("base 解析不到 → 抛错，不静默当作「没有改动」", () => {
    expect(() => collectChanges("no-such-rev", "HEAD", repo)).toThrow();
  });
});
