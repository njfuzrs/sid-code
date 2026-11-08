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
  /** 假 HOME。断言「沙箱外写入没有落盘」这类家目录状态用（B2） */
  homeDir: string;
  /** `after` 各步骤的结果（与 `after` 同序）。主运行的 stdout/stderr/exitCode 在上面 */
  steps: StepOutput[];
  /** 各桩服务收到的请求，按到达顺序 */
  services: Record<string, ServiceHit[]>;
}

/**
 * 用例级桩服务（A11 策略下发、A12 bridge）。运行器在进程内 `Bun.serve({ port: 0 })` 起，
 * 只绑 127.0.0.1；用例结束无论成败都 `stop(true)`。
 *
 * 与总纲 §3.3 草案的两处差别（都是因为服务跑在运行器进程内）：
 * - 不需要「就绪探针」：`Bun.serve` 返回时端口已在监听；
 * - 地址不走环境变量，而是经 `SettingsContext.services` / `env` 回调交给用例，
 *   因为 A11 要写进 settings.json 的 `backend.url`，环境变量注入不到那里。
 */
export interface ServiceDef {
  handler: (req: Request) => Response | Promise<Response>;
}

/** 桩服务收到的一次请求。只记方法、路径、是否带 Authorization，不记 token 本身 */
export interface ServiceHit {
  method: string;
  path: string;
  auth: boolean;
}

export interface SettingsContext {
  defaults: Record<string, unknown>;
  refusedBaseURL: string;
  /** 各桩服务的根地址，如 `http://127.0.0.1:53696` */
  services: Record<string, string>;
  /** 本次用例仓的绝对路径（realpath 后）。配置里需要绝对路径时用它，如团队记忆共享目录 */
  repoRoot: string;
}

/**
 * 主 `-p` 跑完之后，在**同一隔离环境**（同一用例仓、配置目录、假 HOME）里起 `daemon start`。
 *
 * 为 A5 加的最小多步能力：daemon 是常驻进程，不能像 `-p` 那样等它自己退出。
 * 运行器轮询 `daemon.log` 直到 `until` 命中（就绪/完成探针，不用固定 sleep），
 * 然后 SIGTERM，宽限后 SIGKILL。无论成败都会停掉，不留常驻进程。
 */
export interface DaemonStep {
  kind: "daemon";
  /** daemon fork 出的 headless job 用的回放夹具，相对用例目录；同样做 `${CASE_ROOT}` 替换与越界校验 */
  replay: string;
  /** `--interval`（ms） */
  intervalMs: number;
  /** 起 daemon 前对磁盘状态的准备（如把任务 createdAt 往前拨，让启动 catch-up 确定性触发） */
  prepare?: (ctx: { repoRoot: string; configDir: string }) => void;
  /** `daemon.log` 出现此正则即停 daemon；超时也停，结果交给断言判 */
  until: RegExp;
  timeoutMs: number;
}

/**
 * 主 `-p` 跑完之后，在同一隔离环境里再跑一次 `-p`（「重启」）。
 * 为 A10「删掉已补入的键，重启后不再加回」加：判据跨两次进程，单次运行看不到。
 */
export interface PrintStep {
  kind: "print";
  /** 这次运行的回放夹具，相对用例目录；同样做 `${CASE_ROOT}` 替换与越界校验 */
  replay: string;
  argv: string[];
  /** 运行前对磁盘状态的准备（如手动删掉 settings.json 里的某个键） */
  prepare?: (ctx: { repoRoot: string; configDir: string }) => void;
}

export type AfterStep = DaemonStep | PrintStep;

/** 每个 `after` 步骤的进程结果，按顺序。daemon 步骤的 stderr 是 daemon 自己的输出 */
export interface StepOutput {
  kind: AfterStep["kind"];
  exitCode: number;
  stderr: string;
  /** print 步骤的 stdout（`--output-format json`，未解析）；daemon 步骤恒为空串 */
  stdout: string;
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
  /**
   * 假 HOME 里的初始文件（相对假 HOME）。用于「沙箱拦住 ~/.ssh」这类需要家目录内容的用例（B2）。
   * 运行器的 P-3 断言只看 `$HOME/.sid-code`，这里预置的文件不触发它；也不许往这里放 `.sid-code/`。
   */
  home?: Record<string, string>;
  /**
   * 隔离配置目录（`SID_CONFIG_DIR`）里的初始文件，如设备凭据 `device-credential.json`（A11）。
   * `settings.json` 请用 `settings` 字段，这里写会被拒绝。
   */
  config?: Record<string, string>;
  services?: Record<string, ServiceDef>;
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
  /** 主运行之后按序执行的步骤。断言在全部步骤结束后统一执行 */
  after?: AfterStep[];
}
