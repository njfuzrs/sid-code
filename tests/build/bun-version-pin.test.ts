/**
 * bun 版本钉死门禁 —— 2026-09-21 本地 230 fail 的防复发。
 *
 * ## 治的是什么
 *
 * 本机 bun 1.3.14 无参数 `bun test` 扫描 ~800 个 `.test.ts` 之后，
 * `child_process.spawnSync` / `Bun.spawnSync` 给子进程的 stdout 仍是 pipe，
 * 但父进程读端拿回空字符串。230 条几乎全是「本进程 spawn 再断言 stdout」：
 * 单文件绿、显式文件列表绿、CI bun 1.4.2 绿。
 *
 * 根因在测试运行器，不在产品代码。本地与 CI 分叉的那条缝是
 * `CONTRIBUTING.md` 写的「开发用 1.3.x，CI 用 latest」。
 *
 * ## 为什么必须钉死，不能继续 latest
 *
 * `bun-version: latest` 会让下一次 bun 发版再次把本地与 CI 撕开，
 * 形态是「CI 全绿、本机 make test 大面积红」，且红的看起来像 230 个无关 bug。
 * 升级必须走改 `.bun-version` 的显式 PR，dependabot 的 bun 升级也变成可见 diff。
 *
 * ## 为什么"跑一次测试看绿"测不出来
 *
 * 改回 `latest` 时本机可能刚好也是新版本，断言全绿。唯一的症状要等
 * 下一次 bun 发版、且有人还停在旧版本上才出现。所以必须静态锁：
 * workflow 读 `.bun-version`，且全仓零处 `bun-version: latest`。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");
const BUN_VERSION_FILE = join(ROOT, ".bun-version");
const WF_DIR = join(ROOT, ".github", "workflows");

function pinnedVersion(): string {
  return readFileSync(BUN_VERSION_FILE, "utf8").trim();
}

describe("bun 版本钉死（本地 = CI）", () => {
  test(".bun-version 存在且是 x.y.z（不是 latest / canary）", () => {
    expect(existsSync(BUN_VERSION_FILE)).toBe(true);
    const v = pinnedVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v).not.toBe("latest");
    expect(v.toLowerCase()).not.toBe("canary");
  });

  test("package.json engines.bun 下限等于钉死的版本", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      engines?: { bun?: string };
    };
    expect(pkg.engines?.bun).toBe(`>=${pinnedVersion()}`);
  });

  test("每个用 setup-bun 的 workflow 都读 .bun-version，零处 bun-version: latest", () => {
    const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);

    const latestOffenders: string[] = [];
    const missingFile: string[] = [];
    let setupBunCount = 0;

    for (const f of files) {
      const src = readFileSync(join(WF_DIR, f), "utf8");
      // 只看非注释行：ci.yml 注释里会写「禁止改回 bun-version: latest」，扫全文会假红。
      const live = src
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .join("\n");
      if (/bun-version:\s*latest/.test(live)) latestOffenders.push(f);
      const usesSetupBun = /uses:\s*oven-sh\/setup-bun@/.test(src);
      if (!usesSetupBun) continue;
      setupBunCount += 1;
      if (!src.includes("bun-version-file: .bun-version")) missingFile.push(f);
    }

    // 空集自证：今天确实有 workflow 在装 bun。0 个 setup-bun 时下面两条会无意义地绿。
    expect(setupBunCount).toBeGreaterThan(0);
    expect(latestOffenders).toEqual([]);
    expect(missingFile).toEqual([]);
  });

  test("CONTRIBUTING 不再写「开发用 1.3 / CI 用 latest」这条分叉", () => {
    const md = readFileSync(join(ROOT, "CONTRIBUTING.md"), "utf8");
    expect(md).not.toMatch(/开发用 1\.3/);
    expect(md).not.toMatch(/CI 用 latest/);
    expect(md).toContain(".bun-version");
  });
});

describe("bun 版本钉死：变异自证", () => {
  test("YAML 解析后 ci.yml 每个 setup-bun step 都带 bun-version-file", () => {
    // 正则扫文本会把注释里的字样当命中。解析后按 step 取值才能确认真挂在 step 上。
    const doc = parseYaml(readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8")) as {
      jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, string> }> }>;
    };
    const steps = Object.values(doc.jobs ?? {}).flatMap((j) => j.steps ?? []);
    const setup = steps.filter((s) => (s.uses ?? "").startsWith("oven-sh/setup-bun@"));
    expect(setup.length).toBeGreaterThan(0);
    for (const s of setup) {
      expect(s.with?.["bun-version-file"]).toBe(".bun-version");
      expect(s.with?.["bun-version"]).toBeUndefined();
    }
  });
});
