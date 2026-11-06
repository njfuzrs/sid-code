/**
 * 无头形态（`-p` 文本 / `--input-format stream-json` / Bridge）的命令上下文构造。
 *
 * ## 为什么单独一个模块
 *
 * `CommandContext` 有大量**可选**字段，无头只注入其中一部分（见下）。放行一个命令
 * （`index.ts` 里 `headless: true`）的前提是它不依赖**未注入**的字段——否则命令里的
 * `ctx.xxx?.()` 会静默跳过，却照旧返回「已切换为 xxx」，正是「死接线零报错」那类假成功。
 *
 * 这条判据必须能被门禁校验，而门禁必须拿到**真实的注入表**：手抄一份字段清单会随
 * 本文件增删字段而静默过期，门禁恒绿。所以构造逻辑住在这里，app.ts 与门禁测试
 * 共用同一个函数（门禁见 `packages/cli/tests/command/headless-allowed-commands.test.ts`）。
 *
 * ## 为什么只注入这些
 *
 * 交互类 builtin 在分发前就被 `headlessRefusal` 拒绝了，走不到这里；能走到这里的
 * 只有提示词类命令（自定义命令 / skill / 插件 / MCP prompt）与显式 `headless: true`
 * 的 builtin。前者需要的是 ctxMgr / provider / providerRegistry（fork）、
 * confirmShellCommands / requestUserConfirmation（`!{shell}` 模板）与 skillManager；
 * 后者由放行门禁保证不碰其余字段。
 *
 * 新增字段时：加在这里 + 同步 `app.ts` 的 deps 调用点。**不要**在 app.ts 里另写一份。
 */

import type { CommandContext } from "./types.ts";

/**
 * 构造无头命令上下文所需的外部依赖（全部来自 App，测试可注入替身）。
 *
 * 命名刻意对齐 App 的成员名，让调用点是一一对应的搬运，减少「搬错一个」的机会。
 *
 * 刻意**不 export**：生产侧只有 `buildHeadlessCommandContext()` 一个消费点，
 * 调用方传对象字面量即可；导出它就多一个零生产调用的符号（命令体系门禁 G1 会拦）。
 */
interface HeadlessCommandContextDeps {
  ctxMgr: CommandContext["ctxMgr"];
  toolRegistry: CommandContext["toolRegistry"];
  /** 工作目录（App 侧传 `process.cwd()`）。 */
  cwd: string;
  config: CommandContext["config"];
  /**
   * 逻辑会话 id（resume 时=被恢复会话 id，否则=本进程会话 id），**不是**本进程新 id。
   * 轨迹目录名就是它：collector 的 traceSessionId = resumed_from ?? input.session_id
   * （见 core/src/trace/collector.ts 的 SessionStart），会话 jsonl 同口径。
   */
  sessionId: string;
  /** checkpoint 归属 id。与 sessionId 同值（`getLogicalSessionId()`），但语义独立、可分开传。 */
  checkpointSessionId: string;
  provider: CommandContext["provider"];
  providerRegistry?: CommandContext["providerRegistry"];
  mcpManager?: CommandContext["mcpManager"];
  setModel?: CommandContext["setModel"];
  sessionState: CommandContext["sessionState"];
  /** fork 子代理跟随本轮中断信号（会话硬顶 / SDK interrupt / Bridge abort）。 */
  abortSignal?: () => AbortSignal;
  requestUserConfirmation?: (desc: string) => Promise<boolean>;
  permissionRules?: CommandContext["permissionRules"];
  permissionChecker?: CommandContext["permissionChecker"];
  hookSystem?: CommandContext["hookSystem"];
  unifiedRegistry?: CommandContext["unifiedRegistry"];
  skillManager?: CommandContext["skillManager"];
  traceCollector?: CommandContext["traceCollector"];
  fileReadTracker?: CommandContext["fileReadTracker"];
  sessionDir?: string;
}

/**
 * 构造无头命令上下文。
 *
 * ⚠️ 这里的键集合就是「无头注入了什么」的**唯一事实源**。增删字段只改这里。
 */
export function buildHeadlessCommandContext(deps: HeadlessCommandContextDeps): CommandContext {
  return {
    ctxMgr: deps.ctxMgr,
    toolRegistry: deps.toolRegistry,
    cwd: deps.cwd,
    config: deps.config,
    sessionId: deps.sessionId,
    checkpointSessionId: deps.checkpointSessionId,
    provider: deps.provider,
    // fork 型 skill / 自定义命令靠它起子代理；缺了 executor 会静默退回 inline
    providerRegistry: deps.providerRegistry,
    mcpManager: deps.mcpManager,
    setModel: deps.setModel,
    sessionState: deps.sessionState,
    // fork 子代理跟随本轮中断信号（会话硬顶 / SDK interrupt / Bridge abort）
    beginForkedRun: () => ({
      signal: deps.abortSignal?.() ?? new AbortController().signal,
      end: () => {},
    }),
    // 自定义命令模板里的 `!{shell}` 与 skill 的 ask 决策走同一条确认通道：
    // SDK 宿主 can_use_tool / Bridge 远端 / 否则按 permissionMode（default 即 fail-closed 拒绝）
    confirmShellCommands: (commands) =>
      deps.requestUserConfirmation
        ? deps.requestUserConfirmation(`执行命令模板中的 shell：${commands.join("; ")}`)
        : Promise.resolve(false),
    requestUserConfirmation: deps.requestUserConfirmation,
    permissionRules: deps.permissionRules,
    permissionChecker: deps.permissionChecker,
    hookSystem: deps.hookSystem,
    unifiedRegistry: deps.unifiedRegistry,
    skillManager: deps.skillManager,
    traceCollector: deps.traceCollector,
    fileReadTracker: deps.fileReadTracker,
    sessionDir: deps.sessionDir,
  };
}
