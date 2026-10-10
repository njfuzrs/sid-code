/**
 * F1：bash 改了已读文件 → 先读后改护栏不再误判「外部修改」
 *
 * 背景（2026-10-10 轨迹核验）：99 会话 / 118 次 edit 中 stale 拒绝 3 次，**3/3** 都是
 * agent 自己用 bash 改了文件（`bunx oxfmt`、`perl -pi`）——tracker 只认 read/edit/write，
 * bash 写盘对它不可见。重读后模型提交的 old/new_string 与被拒那次逐字相同，纯误拦。
 *
 * 本文件复现那两条真实轨迹的形态：write/read → bash 原地改写 → edit。
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FileReadTracker,
  setFileFreshnessTraceSink,
} from "@sid-code/core/tool/file-read-tracker.ts";
import { BashTool, trackedFilesChangedNotice } from "@sid-code/core/tool/bash.ts";
import { EditTool } from "@sid-code/core/tool/edit.ts";
import { WriteTool } from "@sid-code/core/tool/write.ts";
import { ReadTool } from "@sid-code/core/tool/read.ts";

const isWin = process.platform === "win32";
const dirs: string[] = [];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bash-tracked-refresh-"));
  dirs.push(dir);
  const tracker = new FileReadTracker();
  return {
    dir,
    tracker,
    bash: new BashTool(tracker),
    edit: new EditTool(tracker),
    write: new WriteTool(tracker),
    read: new ReadTool(tracker),
  };
}

afterEach(() => {
  setFileFreshnessTraceSink(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 让 mtime 一定前进（同一毫秒内改写在部分文件系统上 mtime 不变，会让用例假绿） */
const tick = () => new Promise((r) => setTimeout(r, 15));

describe("bash 回扫已读文件（F1）", () => {
  test.skipIf(isWin)("轨迹 A 形态：write → bash 格式化改写 → edit 直接成功", async () => {
    const { dir, bash, edit, write } = setup();
    const f = join(dir, "a.ts");
    await write.execute({ file_path: f, content: "const a=1\nconst b=2\n" });
    await tick();
    // 模拟 formatter：真改内容
    const r = await bash.execute({
      command: `perl -pi -e 's/=/ = /g' ${JSON.stringify(f)}`,
    });
    expect(r.output).toContain("[已读文件被本命令修改]");
    expect(r.output).toContain(f);

    const e = await edit.execute({
      file_path: f,
      old_string: "const b = 2",
      new_string: "const b = 3",
    });
    expect(e.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toBe("const a = 1\nconst b = 3\n");
  });

  test.skipIf(isWin)("轨迹 B 形态：read → bash perl -pi → edit 直接成功", async () => {
    const { dir, bash, edit, read } = setup();
    const f = join(dir, "s.sh");
    writeFileSync(f, 'echo "$x：完成"\nN=1\n');
    await read.execute({ file_path: f });
    await tick();
    await bash.execute({ command: `perl -CSD -pi -e 's/\\$x/\\$\\{x\\}/' ${JSON.stringify(f)}` });
    const e = await edit.execute({ file_path: f, old_string: "N=1", new_string: "N=2" });
    expect(e.isError).toBeFalsy();
    expect(readFileSync(f, "utf-8")).toBe('echo "${x}：完成"\nN=2\n');
  });

  test.skipIf(isWin)("bash 改过之后 write 仍须先重读（整文件覆盖会冲掉 bash 改动）", async () => {
    const { dir, bash, write, read } = setup();
    const f = join(dir, "w.ts");
    writeFileSync(f, "x=1\n");
    await read.execute({ file_path: f });
    await tick();
    await bash.execute({ command: `perl -pi -e 's/1/2/' ${JSON.stringify(f)}` });

    const w = await write.execute({ file_path: f, content: "x=9\n" });
    expect(w.isError).toBe(true);
    expect(w.output).toContain("bash 命令修改");
    expect(readFileSync(f, "utf-8")).toBe("x=2\n");

    // 重读后放行
    await read.execute({ file_path: f });
    const w2 = await write.execute({ file_path: f, content: "x=9\n" });
    expect(w2.isError).toBeFalsy();
  });

  test.skipIf(isWin)(
    "edit 之后 write 仍须重读：edit 只交了片段，bash 改动的其余部分没看过",
    async () => {
      const { dir, bash, edit, write, read } = setup();
      const f = join(dir, "m.ts");
      writeFileSync(f, "a=1\nb=1\n");
      await read.execute({ file_path: f });
      await tick();
      await bash.execute({ command: `perl -pi -e 's/a=1/a=2/' ${JSON.stringify(f)}` });
      expect(
        (await edit.execute({ file_path: f, old_string: "b=1", new_string: "b=2" })).isError,
      ).toBeFalsy();
      const w = await write.execute({ file_path: f, content: "a=1\nb=2\n" });
      expect(w.isError).toBe(true);
    },
  );

  test.skipIf(isWin)("重读清掉标记，之后连续 write 不被拦", async () => {
    const { dir, bash, write, read } = setup();
    const f = join(dir, "c.ts");
    writeFileSync(f, "1\n");
    await read.execute({ file_path: f });
    await tick();
    await bash.execute({ command: `perl -pi -e 's/1/2/' ${JSON.stringify(f)}` });
    await read.execute({ file_path: f });
    expect((await write.execute({ file_path: f, content: "3\n" })).isError).toBeFalsy();
    expect((await write.execute({ file_path: f, content: "4\n" })).isError).toBeFalsy();
  });

  test.skipIf(isWin)("bash 之外的修改仍按外部修改拦截（护栏没被放宽）", async () => {
    const { dir, edit, read } = setup();
    const f = join(dir, "ext.ts");
    writeFileSync(f, "v=1\n");
    await read.execute({ file_path: f });
    await tick();
    writeFileSync(f, "v=2\n"); // 进程内直接写，不经 bash：模拟 IDE
    const e = await edit.execute({ file_path: f, old_string: "v=2", new_string: "v=3" });
    expect(e.isError).toBe(true);
    expect(e.output).toContain("外部修改");
    expect(e.output).toContain("IDE");
  });

  test.skipIf(isWin)("只读命令与后台命令不回扫", async () => {
    const { dir, bash, edit, read } = setup();
    const f = join(dir, "ro.ts");
    writeFileSync(f, "k=1\n");
    await read.execute({ file_path: f });
    await tick();
    writeFileSync(f, "k=2\n"); // 外部改动
    const r = await bash.execute({ command: `cat ${JSON.stringify(f)}` });
    expect(r.output).not.toContain("[已读文件被本命令修改]");
    // 只读命令没吸收外部改动 ⇒ edit 仍被拦
    const e = await edit.execute({ file_path: f, old_string: "k=2", new_string: "k=3" });
    expect(e.isError).toBe(true);
  });

  test.skipIf(isWin)("命令没碰已读文件时结果不追加告知", async () => {
    const { dir, bash, read } = setup();
    const f = join(dir, "q.ts");
    writeFileSync(f, "1\n");
    await read.execute({ file_path: f });
    const r = await bash.execute({ command: `touch ${JSON.stringify(join(dir, "other"))}` });
    expect(r.output).not.toContain("[已读文件被本命令修改]");
  });

  test.skipIf(isWin)("touch 只改 mtime 不改内容：不算变更、不打扰模型", async () => {
    const { dir, bash, read } = setup();
    const f = join(dir, "t.ts");
    writeFileSync(f, "1\n");
    await read.execute({ file_path: f });
    await tick();
    const r = await bash.execute({ command: `touch ${JSON.stringify(f)}` });
    expect(r.output).not.toContain("[已读文件被本命令修改]");
  });

  test.skipIf(isWin)("bash 删掉已读文件：告知已删除，记录移除", async () => {
    const { dir, bash, tracker, read } = setup();
    const f = join(dir, "d.ts");
    writeFileSync(f, "1\n");
    await read.execute({ file_path: f });
    const r = await bash.execute({ command: `rm ${JSON.stringify(f)}` });
    expect(r.output).toContain("（已删除）");
    expect(existsSync(f)).toBe(false);
    expect(tracker.hasBeenRead(f)).toBe(false);
  });

  test.skipIf(isWin)("未绑 tracker 的 BashTool 退回旧行为（不回扫）", async () => {
    const { dir, edit, read } = setup();
    const f = join(dir, "n.ts");
    writeFileSync(f, "1\n");
    await read.execute({ file_path: f });
    await tick();
    await new BashTool().execute({ command: `perl -pi -e 's/1/2/' ${JSON.stringify(f)}` });
    const e = await edit.execute({ file_path: f, old_string: "2", new_string: "3" });
    expect(e.isError).toBe(true);
  });

  test.skipIf(isWin)("withFileReadTracker：视图回扫自己的 tracker，不碰父 tracker", async () => {
    const { dir, bash, tracker: parent } = setup();
    const child = new FileReadTracker();
    const childBash = bash.withFileReadTracker(child);
    const childRead = new ReadTool(child);
    const childEdit = new EditTool(child);
    const parentEdit = new EditTool(parent);
    const f = join(dir, "v.ts");
    writeFileSync(f, "1\n");
    await childRead.execute({ file_path: f });
    await new ReadTool(parent).execute({ file_path: f });
    await tick();
    await childBash.execute({ command: `perl -pi -e 's/1/2/' ${JSON.stringify(f)}` });
    // 子代理自己格式化完 → 自己的 edit 放行
    expect(
      (await childEdit.execute({ file_path: f, old_string: "2", new_string: "3" })).isError,
    ).toBeFalsy();
    // 父 tracker 没被刷新：对父代理而言这确实是外部修改
    expect(
      (await parentEdit.execute({ file_path: f, old_string: "3", new_string: "4" })).isError,
    ).toBe(true);
  });
});

describe("新鲜度埋点（F4）", () => {
  test.skipIf(isWin)("bash 回扫与拒绝都写结构化事件", async () => {
    const events: Record<string, unknown>[] = [];
    setFileFreshnessTraceSink((d) => events.push(d));
    const { dir, bash, edit, read } = setup();
    const f = join(dir, "e.ts");
    writeFileSync(f, "1\n");
    await read.execute({ file_path: f });
    await tick();
    await bash.execute({ command: `perl -pi -e 's/1/2/' ${JSON.stringify(f)}` });
    await tick();
    writeFileSync(f, "9\n");
    await edit.execute({ file_path: f, old_string: "9", new_string: "8" });
    await edit.execute({ file_path: join(dir, "never-read.ts"), old_string: "a", new_string: "b" });

    expect(events.map((e) => e.outcome)).toEqual([
      "bash_changed_tracked_files",
      "rejected_modified",
      "rejected_unread",
    ]);
    expect(events[0]).toMatchObject({ tool: "bash", files_changed: 1 });
    expect(typeof events[1]!.ms_since_read).toBe("number");
  });
});

describe("trackedFilesChangedNotice", () => {
  test("空清单返回空串", () => {
    expect(trackedFilesChangedNotice([])).toBe("");
  });
  test("超过 10 个只列前 10 个并给计数", () => {
    const list = Array.from({ length: 13 }, (_, i) => ({ path: `/p/${i}`, deleted: false }));
    const s = trackedFilesChangedNotice(list);
    expect(s).toContain("/p/9");
    expect(s).not.toContain("/p/10\n");
    expect(s).toContain("另有 3 个");
  });
});
