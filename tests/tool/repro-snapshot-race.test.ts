import { describe, it, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BashTool } from "../../src/tool/bash.ts";
import { setCwd, getCwd } from "../../src/bootstrap/state.ts";

describe("快照竞态复现", () => {
  it("并发重建快照 + 执行命令，命令不应 isError", async () => {
    const orig = getCwd();
    const failures: string[] = [];
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      tasks.push((async () => {
        const dir = mkdtempSync(join(tmpdir(), "race-"));
        mkdirSync(join(dir, "x"));
        writeFileSync(join(dir, "x", "marker.txt"), "found", "utf8");
        const bash = new BashTool();
        const result = await bash.execute({
          command: "cat marker.txt",
          cwd: join(dir, "x"),
          description: "读 marker",
        });
        if (result.isError) failures.push(`#${i}: ${result.output.slice(0, 150).replace(/\n/g, " ")}`);
        rmSync(dir, { recursive: true, force: true });
      })());
    }
    await Promise.all(tasks);
    setCwd(orig);
    if (failures.length) console.log("失败样本:\n" + failures.join("\n"));
    expect(failures).toEqual([]);
  });
});
