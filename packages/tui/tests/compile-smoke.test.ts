/**
 * 新渲染底座的编译冒烟（B9 / T1.2）。
 *
 * 要证明的是「上游 ink@7.1.1 源码原样放进来，`bun build --compile` 后的单文件二进制能渲染」，
 * 所以必须真编译、真运行，不能只 `bun run`：源码模式下能跑，不代表 compile 后也能跑。
 * 实测的差别在 yoga 的 WASM 和 `import.meta.resolve` 这两处。
 *
 * DEV=true 那条用例针对上游 `reconciler.ts` 的 devtools 分支（`import.meta.resolve` 判断有没有装，
 * 有就动态 import `devtools.js`）。实测把 react-devtools-core 设成 `--external` 不打进产物时，
 * bun 会把这个外部 import 提到模块顶层，**DEV 开不开都在启动时崩**（rc=1，两条运行用例都红）。
 * 所以 react-devtools-core 必须是普通 dependency，不能是 optional，构建也不能 external 它。
 * 这两条用例就是为了防止有人把它挪走。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = join(import.meta.dir, "fixtures", "compile-smoke.tsx");
const outDir = mkdtempSync(join(tmpdir(), "tui-compile-smoke-"));
const bin = join(outDir, "smoke");

afterAll(() => rmSync(outDir, { recursive: true, force: true }));

function run(env: Record<string, string>) {
  const r = Bun.spawnSync([bin], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("packages/tui 编译冒烟", () => {
  test("bun build --compile 成功", () => {
    const r = Bun.spawnSync(
      [
        process.execPath,
        "build",
        "--compile",
        "--define",
        'process.env.NODE_ENV="production"',
        "--outfile",
        bin,
        FIXTURE,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode, r.stderr.toString()).toBe(0);
  }, 60_000);

  test("产物能渲染 Box + Text，yoga 可用", () => {
    const r = run({ DEV: "" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("YOGA:function");
    expect(r.out).toContain("hello 你好");
    // 圆角边框四角都在 = 布局与边框绘制都走通了
    for (const ch of ["╭", "╮", "╰", "╯"]) expect(r.out).toContain(ch);
    expect(r.out).toContain("SMOKE_OK");
  }, 30_000);

  test("DEV=true 时 devtools 分支不崩（ws 连不上只告警）", () => {
    const r = run({ DEV: "true" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("SMOKE_OK");
  }, 30_000);
});
