/**
 * verify-doc-claims：跨仓文档常量校验。用夹具文本而不是真实 docs-research
 * （CI 里没有那个仓），断言它**报了什么**，不只看退出码。
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkDoc,
  collectSourceConstants,
  countDoneExits,
  DONE_EXIT_FLOOR,
} from "../../scripts/verify-doc-claims.ts";
import { MAX_EMPTY_PARAM_RETRIES } from "../../packages/core/src/query/empty-param.ts";
import { MAX_CTX_WINDOW_RECOVERIES } from "../../packages/core/src/query/loop.ts";

const constants = collectSourceConstants();

describe("verify-doc-claims", () => {
  test("源码常量收集到真实值", () => {
    expect(constants.get("MAX_EMPTY_PARAM_RETRIES")).toBe(MAX_EMPTY_PARAM_RETRIES);
    expect(constants.get("MAX_CTX_WINDOW_RECOVERIES")).toBe(MAX_CTX_WINDOW_RECOVERIES);
    expect(countDoneExits()).toBeGreaterThanOrEqual(DONE_EXIT_FLOOR);
  });

  test("常量值写错 → 报漂移，并指出行号与真实值", () => {
    const doc = [
      "标题",
      `上限 \`MAX_EMPTY_PARAM_RETRIES = ${MAX_EMPTY_PARAM_RETRIES + 2}\``,
      `封顶 \`MAX_CTX_WINDOW_RECOVERIES=${MAX_CTX_WINDOW_RECOVERIES}\``,
      "CC 的 `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3` 不在本仓源码里，跳过",
    ].join("\n");
    const d = checkDoc("x.md", doc, constants);
    expect(d).toEqual([
      {
        doc: "x.md",
        line: 2,
        kind: "constant",
        claim: `MAX_EMPTY_PARAM_RETRIES = ${MAX_EMPTY_PARAM_RETRIES + 2}`,
        actual: `MAX_EMPTY_PARAM_RETRIES = ${MAX_EMPTY_PARAM_RETRIES}`,
      },
    ]);
  });

  test("done 出口数低于下限 → 报漂移；≥ 下限不报（区间，不是等值）", () => {
    const block = (n: number) =>
      [
        "```bash",
        "grep -c 'kind: \"done\"' packages/core/src/query/loop.ts",
        `# → ${n}`,
        "```",
      ].join("\n");
    expect(checkDoc("a.md", block(12), constants).map((x) => x.kind)).toEqual(["done_exit_count"]);
    expect(checkDoc("b.md", block(22), constants)).toEqual([]);
    expect(checkDoc("c.md", block(28), constants)).toEqual([]);
  });

  test("CLI：有漂移 exit 1 且打印漂移行；无漂移 exit 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "sid-doc-claims-"));
    try {
      const bad = join(dir, "bad.md");
      const good = join(dir, "good.md");
      writeFileSync(bad, `\`MAX_EMPTY_PARAM_RETRIES = ${MAX_EMPTY_PARAM_RETRIES + 1}\`\n`);
      writeFileSync(good, `\`MAX_EMPTY_PARAM_RETRIES = ${MAX_EMPTY_PARAM_RETRIES}\`\n`);
      const script = join(import.meta.dir, "../../scripts/verify-doc-claims.ts");
      const r1 = spawnSync("bun", ["run", script, bad], { encoding: "utf8" });
      expect(r1.status).toBe(1);
      expect(r1.stdout).toContain("bad.md:1");
      const r2 = spawnSync("bun", ["run", script, good], { encoding: "utf8" });
      expect(r2.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
