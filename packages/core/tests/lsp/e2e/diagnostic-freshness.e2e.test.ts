/**
 * LSP 诊断新鲜度 — **真实服务器 e2e**（设计方案 §5.2 的 E1–E4）
 *
 * 为什么必须有这一层：单测能证明「屏障越过后才收推送」这段逻辑自洽，但证明不了
 * **真实 typescript-language-server 在 didChange 之后确实还会推旧内容的诊断**——
 * 而这正是本次修复的全部前提。代理指标（单测全绿）会骗人。
 *
 * 运行条件：本机装有 `typescript-language-server` 才跑。CI 没有这个依赖，
 * 会以 **skip** 结束并在输出里明确打印原因——**不许静默绿**（恒绿门禁比没有门禁更危险）。
 *
 * 场景设计的关键：新旧内容必须产生**可区分的错误消息**。这里用
 * `Cannot find name 'OLD_ERR_TYPE'` vs `'NEW_ERR_TYPE'`——类型名出现在消息里，
 * 于是「注入的是哪一版内容的诊断」可以直接从文本判定。
 *
 * ⚠️ E1 依赖真实时序（didChange 落在 tsls 的 syntax 推送与 semantic 推送之间）。
 * 时间窗口是实测出来的（2026-11-05，本机 tsls 5.1.3，6000 行文件，窗口约 400–560ms）。
 * 若换了机器/版本导致窗口整体漂移，E1 会给出明确的失败信息告诉你重新校准，
 * 而不是含糊地失败。
 */
import { describe, test, expect, afterEach, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeLSP,
  shutdownLSP,
  getLSPInitState,
  syncFileToLSP,
  collectDiagnosticText,
  setLspDiagnosticsTraceSink,
} from "@sid-code/core/lsp/manager.ts";

/** 本机是否有真实服务器 */
const HAS_TSLS = Bun.which("typescript-language-server") !== null;

if (!HAS_TSLS) {
  // 明确写出「为什么没跑」，而不是让 0 个用例静默通过
  console.error("[lsp-e2e] 跳过 E1–E4：本机没有 typescript-language-server（CI 无此依赖，属预期）");
}

const maybeDescribe = HAS_TSLS ? describe : describe.skip;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 建一个临时工作区并写入 tsconfig。
 *
 * ⚠️ tsconfig 必须写：没有它 tsls 不做语义分析、根本不推 publishDiagnostics，
 * 于是 e2e 会「全都拿不到诊断」而以另一种方式失败。`types: []` 是为了不依赖 @types/node。
 */
function makeWorkspace(prefix: string): string {
  const ws = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    join(ws, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "esnext",
        module: "esnext",
        noEmit: true,
        types: [],
      },
      include: ["*.ts"],
    }),
    "utf-8",
  );
  return ws;
}

/** 6000 行文件：让 tsls 的 syntax / semantic 两个推送阶段明显分开（S1 窗口需要它） */
const BIG_LINES = 6000;

/** 旧内容：第 1 行是一个「找不到的类型名」，错误消息里带 OLD_ERR_TYPE */
function bigContentOld(): string {
  const lines = [`const a: OLD_ERR_TYPE = 1;`];
  for (let i = 0; i < BIG_LINES; i++) lines.push(`export const v${i}: number = ${i};`);
  return lines.join("\n");
}

/** 新内容：修掉旧错误，在末尾引入一个带 NEW_ERR_TYPE 的新错误 */
function bigContentNew(): string {
  const lines = [`const a: number = 1;`];
  for (let i = 0; i < BIG_LINES; i++) lines.push(`export const v${i}: number = ${i};`);
  lines.push(`const b: NEW_ERR_TYPE = 2;`);
  return lines.join("\n");
}

/** 小文件（E4 用）：常规编辑，不应退步 */
function smallContent(tag: "OLD" | "NEW"): string {
  return tag === "OLD"
    ? `const s: OLD_ERR_TYPE = 1;\nexport const n = 1;\n`
    : `const s: number = 1;\nexport const n: NEW_ERR_TYPE = 2;\n`;
}

/** 启动 LSP 并等到 initState=success */
async function boot(ws: string): Promise<void> {
  initializeLSP(ws);
  for (let i = 0; i < 300; i++) {
    if (getLSPInitState() === "success") return;
    if (getLSPInitState() === "failed") throw new Error("LSP 初始化失败");
    await sleep(10);
  }
  throw new Error("LSP 初始化超时（3s）");
}

/** 每个用例结束后彻底关停，避免服务器进程泄漏到下一个用例 */
afterEach(async () => {
  setLspDiagnosticsTraceSink(null);
  await shutdownLSP();
});

afterAll(async () => {
  await shutdownLSP();
});

maybeDescribe("LSP 诊断新鲜度 e2e（真实 typescript-language-server）", () => {
  test("E1：didChange 落在 syntax/semantic 推送之间 → 不注入旧内容诊断，且窗口拦下过推送", async () => {
    // 采样策略：**多个时刻、命中即停**。
    //
    // 为什么不固定一个 T：S1 窗口（didChange 恰好落在 tsls 的 syntactic 与 semantic 两次
    // 推送之间）只有约 ±150ms 宽，而「didOpen 之后多久开始推第一轮」是浮动的——
    // 并发跑全量测试时机器负载高，整体后移，固定三个采样点会集体错过（实测在
    // `bun run affected-tests:run` 下就是这样红的，单跑却全绿）。
    // 所以按 T 从小到大扫，一旦观察到 stale_syncing>0 就停：那说明真的踩进了窗口，
    // 此时「没注入旧内容」的断言才有说服力。
    const samples: Array<{ T: number; staleSyncing: number; injected: string | null }> = [];
    const workspaces: string[] = [];
    const TS = [260, 320, 380, 440, 500, 560];

    try {
      for (const T of TS) {
        const ws = makeWorkspace(`lsp-e2e-e1-${T}-`);
        workspaces.push(ws);
        const file = join(ws, "a.ts");
        writeFileSync(file, bigContentOld(), "utf-8");

        await boot(ws);
        const events: Array<Record<string, unknown>> = [];
        setLspDiagnosticsTraceSink((d) => events.push(d));

        await syncFileToLSP(file); // didOpen（不挂屏障：没有旧代际）
        await sleep(T); // 让 tsls 先跑一轮分析
        writeFileSync(file, bigContentNew(), "utf-8");
        await syncFileToLSP(file); // didChange + 屏障（这就是 S1 的入口）
        await sleep(600); // 屏障已越过，但 semantic 分析可能还没完成
        const injected = await collectDiagnosticText();

        const last = events.at(-1) ?? {};
        samples.push({
          T,
          staleSyncing: Number(last.stale_syncing ?? 0),
          injected,
        });

        // ⚠️ 每个采样必须**独立关停**：initializeLSP 在 instance 存在且未 fail 时会直接早退
        // （见 manager.initializeLSP），不关停的话第二次起仍在用上一个 workspace 的服务器，
        // 而新 workspace 的文件从未 didOpen 过——changeFile 会发 didOpen 而不是 didChange，
        // S1 窗口根本不存在。
        setLspDiagnosticsTraceSink(null);
        await shutdownLSP();

        if (samples.at(-1)!.staleSyncing > 0) break; // 命中窗口，不再继续烧时间
      }

      // 核心断言：任何一次都不能注入旧内容的诊断
      for (const s of samples) {
        expect(s.injected === null || !s.injected.includes("OLD_ERR_TYPE")).toBe(true);
      }

      // 窗口确实覆盖到了：至少一次拦下过「基于旧内容」的推送。
      // 这条红了说明本机时序与预期不符（不是修复失效）——报错里带全部采样，便于重新校准。
      const hit = samples.some((s) => s.staleSyncing > 0);
      if (!hit) {
        throw new Error(
          `E1 未观察到 S1 窗口（stale_syncing 全为 0）：本机 tsls 时序与 2026-11-05 基线不同。` +
            `采样=${JSON.stringify(samples.map((s) => ({ T: s.T, stale: s.staleSyncing })))}。` +
            `请调整本文件里的 TS 取值重新校准（基线窗口约 260–560ms）。`,
        );
      }
    } finally {
      for (const ws of workspaces) rmSync(ws, { recursive: true, force: true });
    }
  }, 120000);

  test("E2：编辑后等足够久 → 注入新内容诊断，带新鲜度标注，fresh_by_barrier ≥ 1", async () => {
    const ws = makeWorkspace("lsp-e2e-e2-");
    try {
      const file = join(ws, "a.ts");
      writeFileSync(file, bigContentOld(), "utf-8");

      await boot(ws);
      const events: Array<Record<string, unknown>> = [];
      setLspDiagnosticsTraceSink((d) => events.push(d));

      await syncFileToLSP(file);
      await sleep(480);
      writeFileSync(file, bigContentNew(), "utf-8");
      await syncFileToLSP(file);
      await sleep(2500); // 足够 tsls 跑完新内容的 semantic 分析

      const injected = await collectDiagnosticText();
      expect(injected).not.toBeNull();
      expect(injected!).toContain("NEW_ERR_TYPE");
      expect(injected!).not.toContain("OLD_ERR_TYPE");
      // 能证明新鲜 → 带标注（§3.6）
      expect(injected!).toContain("基于你最近一次编辑后的内容");

      const last = events.at(-1) ?? {};
      expect(Number(last.fresh_by_barrier ?? 0)).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 60000);

  test("E3：编辑之后被 bash 风格直接改写 → 本轮不注入、drifted_files=1，下一轮注入新诊断", async () => {
    const ws = makeWorkspace("lsp-e2e-e3-");
    try {
      const file = join(ws, "a.ts");
      writeFileSync(file, bigContentOld(), "utf-8");

      await boot(ws);
      const events: Array<Record<string, unknown>> = [];
      setLspDiagnosticsTraceSink((d) => events.push(d));

      await syncFileToLSP(file);
      await sleep(1500); // 等到旧内容的诊断进入 pending
      expect(getLSPInitState()).toBe("success");

      // 带外修改：不经过 syncFileToLSP，直接写盘（等价于 bash 的 sed -i / formatter）
      writeFileSync(file, bigContentNew(), "utf-8");

      const first = await collectDiagnosticText();
      const firstStats = events.at(-1) ?? {};
      expect(Number(firstStats.drifted_files ?? 0)).toBe(1);
      // 判漂移的文件本轮不注入（旧内容的诊断被丢弃）
      expect(first === null || !first.includes("OLD_ERR_TYPE")).toBe(true);

      // 重同步完成后再收一轮：应该拿到新内容的诊断
      await sleep(3000);
      const second = await collectDiagnosticText();
      expect(second).not.toBeNull();
      expect(second!).toContain("NEW_ERR_TYPE");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 60000);

  test("E4：小文件常规编辑（退步门禁）→ 正常注入新内容诊断", async () => {
    const ws = makeWorkspace("lsp-e2e-e4-");
    try {
      const file = join(ws, "a.ts");
      writeFileSync(file, smallContent("OLD"), "utf-8");

      await boot(ws);
      await syncFileToLSP(file);
      await sleep(600);
      writeFileSync(file, smallContent("NEW"), "utf-8");
      await syncFileToLSP(file);
      await sleep(1000);

      const injected = await collectDiagnosticText();
      expect(injected).not.toBeNull();
      expect(injected!).toContain("NEW_ERR_TYPE");
      expect(injected!).not.toContain("OLD_ERR_TYPE");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 60000);
});
