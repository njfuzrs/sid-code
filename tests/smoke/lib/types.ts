/**
 * G2 无头回放冒烟：用例类型定义。
 *
 * 为什么用 TS 对象而不是 YAML：断言里的事件名、工具名要能直接 import 源码里的常量
 * （如 `HOOK_EXECUTED_EVENT_NAME`、`HookEventName.PostToolUse`）。改名时类型检查 /
 * import 就红；YAML 里只能写字符串，改名后用例会静默匹配 0 条——那正是这层门禁要防的形态。
 *
 * 设计与归层判据见专项总纲（私有文档库「质量防线分层专项」§3.3），tracking issue #618。
 */

/** 用例性质：守护一个功能，或锁住一个已知缺陷的当前行为（后者不计入覆盖率）。 */
export type SmokeKind = "guard" | "lock-defect";

/**
 * 对 `events.jsonl` 的一条断言。
 *
 * `where` 里的每个键先在事件的 `data` 上找，找不到再在事件顶层找；值做严格相等。
 * `count` 缺省为 `">=1"`；数字表示恰好 N 条。
 */
export interface EventExpect {
  event: string;
  where?: Record<string, unknown>;
  count?: number | `>=${number}`;
}

/** 对用例仓内文件的断言。`path` 相对用例仓根目录。 */
export type FileExpect =
  | { path: string; equals: string }
  | { path: string; contains: string }
  | { path: string; absent: true };

/**
 * 变异配方：把被测接线改断的最小替换。
 *
 * 复跑脚本（scripts/smoke/mutate.ts）应用它之后用例必须变红（killed）。
 * `find` 在 `file` 里必须恰好出现一次，否则判 stale——说明源码动了，配方要跟着更新。
 */
export interface Mutation {
  /** 仓库根相对路径 */
  file: string;
  find: string;
  replace: string;
  /** 这条变异模拟的是哪种「接线断了」，失败报告里原样打印 */
  why: string;
}

/** 解析后的 stdout（`--output-format json`）与进程退出码，交给自定义断言。 */
export interface RunOutput {
  exitCode: number;
  stdout: unknown;
  stderr: string;
  /**
   * 本次会话 `raw.jsonl` 里每条请求的 `request` 字段（按发出顺序）。
   * 断言 system / messages 等「最终序列化结果」用，如 A13 团队记忆注入。
   * 只证明序列化结果，证明不了产出它的加载逻辑没变（总纲 §3.3「G2 的能力边界」）。
   */
  requests: unknown[];
  /** 隔离配置目录（`SID_CONFIG_DIR`）。断言启动后的 settings.json / state 用，如 A10 迁移链 */
  configDir: string;
}

export interface SettingsContext {
  defaults: Record<string, unknown>;
  refusedBaseURL: string;
  /** 本次用例仓的绝对路径（realpath 后）。配置里需要绝对路径时用它，如团队记忆共享目录 */
  repoRoot: string;
}

export interface SmokeCase {
  /** `<台账编号>-<半边短名>`，必须与用例目录名一致 */
  id: string;
  /** 台账编号（如 A2），用于回链台账 */
  ledger: string;
  feature: string;
  kind: SmokeKind;
  /** 不在列表里的平台输出 skip + 原因，而不是静默不跑 */
  platforms?: NodeJS.Platform[];
  /** 用例仓初始文件（相对路径 → 内容）。会在临时目录里 `git init` */
  repo: Record<string, string>;
  /** 传给 sid-code 的参数；`--dangerously-skip-permissions` 与 `--output-format json` 由运行器补 */
  argv: string[];
  /** 额外环境变量（运行器已设好隔离用的那一组，这里只放用例特有的） */
  env?: Record<string, string>;
  /**
   * 覆盖写进隔离配置目录的 settings.json。缺省是单个 replay 模型（`ctx.defaults`）。
   * `ctx.refusedBaseURL` 是一个刚确认没人监听的本地地址，连上去必然被拒，
   * 用来确定性地构造「主模型失败」（A8 降级链）。
   */
  settings?: (ctx: SettingsContext) => Record<string, unknown>;
  expect: {
    events?: EventExpect[];
    files?: FileExpect[];
    /** 只在这个用例有明确退出码语义时设（如预算硬停 = 1）。无头命令失败曾一律退 0，默认不看 */
    exitCode?: number;
    /** 返回 null 表示通过，返回字符串表示失败原因 */
    output?: (out: RunOutput) => string | null;
  };
  mutations: Mutation[];
}
