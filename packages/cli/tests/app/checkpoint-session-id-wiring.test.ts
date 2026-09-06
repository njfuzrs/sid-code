/**
 * 门禁 · app.ts 里两处 checkpoint 接线（D5 / D6）
 *
 * 两条缺陷同属一类形态：**上下游全对，断在中间那一行接线上**，所以 grep 两端都能看到
 * 看起来完全正常的代码，而功能名存实亡。这类缺陷没有行为层接缝可测
 * （`recordFileChanges` 全仓零测试引用，RewindManager 的测试用假依赖注入
 * `restoreToSnapshot`，够不到 app.ts 里那一行），所以门禁只能立在源码文本上。
 *
 * **D5：Rewind 文件回滚必须用逻辑会话 id。**
 * 构造函数比 `restoreSession()` 早跑，那时 `resumedSessionId` 还是 null；闭包一旦捕获
 * 构造期的局部变量 `sessionId`，就把「进程新 id」定死了。而建快照走
 * `getLogicalSessionId()`，快照实际落在 `checkpoints/<被恢复会话 id>/`。
 * 写对读错的后果是**同一批快照两个入口一个能用一个不能用**：resume 后 `/undo`
 * 找得到，Esc+Esc 面板找不到，且失败被 catch 成 null，与「本会话确实没有快照」
 * 完全无法区分。
 *
 * **D6：`recordFileChanges` 适配器必须转发第三个形参 snapshotId。**
 * 生产端传 3 个（tool-executor.ts）、接口声明 3 个、实现方完整处理 3 个、恢复端消费
 * `snapshotIds` —— 四处全对，却因适配器箭头函数只写两个形参而集体空转：实测 152 条
 * `file_changes` 里 0 条带 `lastSnapshotId` 或 `snapshotIds`，恢复端那个 for 循环
 * **从未执行过一次**。
 *
 * ⚠️ 用 readFileSync 而非 shell grep：app.ts 曾含 NUL 字节，grep 会把它判成 binary 并
 * **静默跳过**（记忆「app.ts 含 NUL 字节致 grep 静默漏报」）。当前该文件已无 NUL，
 * 但门禁不该依赖这一点保持为真。
 */

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appSrc = readFileSync(join(import.meta.dir, "..", "..", "src", "app.ts"), "utf-8");

describe("门禁 · app.ts 扫描面", () => {
  test("扫描面非空（防止路径漂移让门禁退化成绿灯）", () => {
    // 路径写错时 readFileSync 会抛，但文件被搬空/被截断不会——这条拦后者。
    expect(appSrc.length).toBeGreaterThan(100_000);
  });
});

describe("D5 · Rewind 文件回滚必须跟随逻辑会话 id", () => {
  test("全部 getCheckpointManager( 调用点都不传构造期捕获的裸 sessionId", () => {
    // 判据是「不存在这种写法」，而不是数调用点个数——后者会在新增一个正确调用点时误红。
    // `getCheckpointManager(sessionId` 这种形态就是缺陷本体：构造期局部变量被闭包捕获。
    expect(appSrc).not.toContain("getCheckpointManager(sessionId");
  });

  test("RewindManager 的 restoreToSnapshot 闭包里取的是 getLogicalSessionId()", () => {
    // 定位到 RewindManager 构造那一段（而不是全文搜），避免别处的正确用法把门禁刷绿。
    const start = appSrc.indexOf("new RewindManager({");
    expect(start).toBeGreaterThan(-1);
    const end = appSrc.indexOf("this.sessionState = new SessionState(", start);
    expect(end).toBeGreaterThan(start);
    const block = appSrc.slice(start, end);

    expect(block).toContain("restoreToSnapshot");
    expect(block).toContain("this.getLogicalSessionId()");
    // 反向自证：这一段里不能再出现「直接把构造期 sessionId 交给 checkpoint」的写法
    expect(block).not.toContain("getCheckpointManager(sessionId");
  });

  test("回滚未命中快照时留日志（否则与「本会话没有快照」无法区分）", () => {
    const start = appSrc.indexOf("new RewindManager({");
    const end = appSrc.indexOf("this.sessionState = new SessionState(", start);
    const block = appSrc.slice(start, end);
    // D5 的加重项：旧实现 `if (!result) return null` 静默返回，UI 只显示「跳过文件回滚」。
    expect(block).toContain('"REWIND"');
    expect(block).toContain("文件回滚未命中快照");
  });
});

describe("D6 · recordFileChanges 适配器必须转发 snapshotId", () => {
  test("适配器声明并转发第三个形参", () => {
    // 锁「三个形参都在」，不锁具体排版（oxfmt 会按行宽换行，写死整行会脆）。
    const at = appSrc.indexOf("recordFileChanges: (files");
    expect(at).toBeGreaterThan(-1);
    const decl = appSrc.slice(at, at + 200);

    // 形参列表里必须有 snapshotId（缺陷本体是 `(files, toolName) =>`）
    expect(decl).toContain("snapshotId");
    // 且必须真的传进去，不能只声明不用
    expect(decl).toMatch(/this\.recordFileChanges\(\s*files,\s*toolName,\s*snapshotId\s*\)/);
  });

  test("实现方签名仍收三个形参（防止有人改成两个来「对齐」适配器）", () => {
    expect(appSrc).toContain(
      "private recordFileChanges(files: string[], toolName: string, snapshotId?: string)",
    );
  });

  test("落盘仍写 lastSnapshotId / snapshotIds 两个字段", () => {
    // 这两个字段的展开条件依赖 snapshotId 非空；转发修好后它们才真正会被写出。
    expect(appSrc).toContain("lastSnapshotId: snapshotId");
    expect(appSrc).toContain("snapshotIds: [...this.changedFileSnapshotIds]");
  });

  test("恢复端仍消费 snapshotIds（D6 修好后这段循环才第一次真正执行）", () => {
    expect(appSrc).toContain("Array.isArray(fc.snapshotIds)");
  });
});
