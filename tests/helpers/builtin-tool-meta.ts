/**
 * 「真实注册表 + 延迟标记」的统一取数入口（D12）。
 *
 * 门禁要问的问题——「哪些工具常驻」「谁声明了 strictPriority」「谁还没挂 zodSchema」——
 * 都必须从**真实注册表**取。工具注册散在 `packages/cli/src/cli.ts` 主流程的 40+ 处
 * `register()` 里，与会话初始化、LSP、MCP 连接交织；而 `packages/core/tests` 不能
 * import 那段代码（`lint:boundary` 禁止 core 依赖 cli）。所以统一 spawn 隐藏出口
 * `--dump-tool-meta`，一条路取全量。
 *
 * 为什么不用 `--dump-tools`：它的输出形状被 `docs:gen-reference` 与
 * `tests/website/gen-reference.test.ts` 依赖，往里加字段会把参考页漂移和门禁绑在一起；
 * 而且它不带「是否延迟」，分不出常驻/延迟两组。
 *
 * 进程内缓存：spawn 一次约 1s，同一批 `bun test` 里的多个门禁（zodSchema 覆盖、
 * strict 预算、前缀碰撞）共用同一份结果，缓存的是结果而非 Promise——它是同步的，
 * 没有并发重复 spawn 的问题。
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface BuiltinToolMeta {
  /** 工具名，与 `definitions()` 同名（权限规则 / hook matcher 用的就是它） */
  name: string;
  /** 是否延迟加载（不进首轮上下文，需要 tool_search 调出） */
  deferred: boolean;
  /** 是否发 strict，与 `toolToDefinition()` 同源（内置 true，MCP 与 StructuredOutput 不发） */
  strict: boolean;
  /** strict 超限时的保留优先级；未声明为 0 */
  strictPriority: number;
  /** 实例上有没有 zodSchema；没有就跳过别名、归一、safeParse 整条校验链 */
  hasZodSchema: boolean;
}

/** 仓库根（`tests/helpers/` 往上两层） */
const ROOT = resolve(import.meta.dir, "..", "..");

let cache: BuiltinToolMeta[] | undefined;

/**
 * 全量内置工具元数据（真实注册表 + 延迟标记）。
 *
 * 必须显式传 `SID_CONFIG_DIR` 指向 tmpdir（CONTRIBUTING「测试约定」第 4 条）：
 * 子进程不继承运行时改过的 `process.env`，而这是一次完整启动，不传会写用户真实的
 * `~/.sid-code`（启动计数 / 迁移 / 启动管家）。
 */
export function builtinToolMeta(): BuiltinToolMeta[] {
  if (cache) return cache;

  const configDir = mkdtempSync(join(tmpdir(), "sid-tool-meta-"));
  const proc = Bun.spawnSync(
    ["bun", "run", join(ROOT, "packages/cli/src/entrypoints/bootstrap.ts"), "--dump-tool-meta"],
    {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
      // 子进程不继承这条改为 tmpdir 的 env，必须整份显式传（同 gen-reference.test.ts 的坑）。
      env: { ...process.env, SID_CONFIG_DIR: configDir },
      timeout: 120_000,
    },
  );
  if (proc.exitCode !== 0) {
    throw new Error(
      `--dump-tool-meta 应退 0，实际 exit=${proc.exitCode}\nstderr: ${proc.stderr.toString()}`,
    );
  }

  const parsed: unknown = JSON.parse(proc.stdout.toString());
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      `--dump-tool-meta 应输出非空数组，实际: ${proc.stdout.toString().slice(0, 300)}`,
    );
  }
  cache = parsed as BuiltinToolMeta[];
  return cache;
}
