/**
 * X1 `-p` 中途致命错误：退出码必须非 0，且 `SessionEnd` 照常落盘、标成 error。
 *
 * 构造：夹具只录了第一轮（一次 bash 调用），第二轮请求时 ReplayProvider 无响应可放，
 * 重试耗尽后 queryLoop 产出 `fatal_error`。这是「模型/网关中途挂掉」最便宜的确定性构造。
 *
 * 期望来源：2026-11-08 构建产物探针——exit 1、`SessionEnd{reason=error,exit_status=error}` 1 条、
 * 第一轮 bash 正常执行完（`PostToolUse{is_error=false}`）。这里守的是「wrapper 用退出码判失败」
 * 这条契约（`resolveHeadlessExitCode` 的 `hasRunError` 一路），曾经的形态是不完整收尾仍 exit 0
 * （见 `packages/cli/tests/cli/print-incomplete-exit-code.test.ts`：那份跑的是源码不是构建产物）。
 *
 * 必须压低重试：不压时同一构造实测 120s 仍未退出（退避一路累加）。
 */
import type { SmokeCase } from "../../lib/types.ts";

const def: SmokeCase = {
  id: "X1-print-fatal-exit",
  ledger: "X1",
  feature: "`-p` 退出码与不完整收尾",
  kind: "guard",
  repo: {},
  env: {
    SID_CODE_MAX_RETRIES_PER_CALL: "1",
    SID_CODE_MAX_TIMEOUT_RETRIES: "1",
    SID_CODE_RETRY_BACKOFF_BASE_MS: "50",
    SID_CODE_RETRY_BACKOFF_MAX_MS: "100",
  },
  argv: ["-p", "执行 echo hi"],
  expect: {
    exitCode: 1,
    events: [
      { event: "PostToolUse", where: { tool_name: "bash", is_error: false }, count: 1 },
      { event: "SessionEnd", where: { reason: "error", exit_status: "error" }, count: 1 },
    ],
  },
  mutations: [
    {
      file: "packages/cli/src/app.ts",
      find: "        hasRunError: !!runError,\n        budgetExceeded,\n        incompleteReason,\n        sessionTimedOut,",
      replace:
        "        hasRunError: false,\n        budgetExceeded,\n        incompleteReason,\n        sessionTimedOut,",
      why: "runHeadless 的退出码不再看 runError：中途致命错误后 exit 0，wrapper 把失败当成功",
    },
    {
      file: "packages/cli/src/app.ts",
      // 必须连 stack 那行一起换掉：只删赋值时下一行 `runError.stack = …` 对 null 抛 TypeError，
      // 外层 catch 照样设上 runError，变异等于没改（2026-11-08 实测 survived）。
      find: '          if (event.kind === "fatal_error") {\n            runError = new Error(event.message);\n            if (event.stack) runError.stack = event.stack;',
      replace: '          if (event.kind === "fatal_error") {',
      why: "fatal_error 事件不再转成 runError（§3.2 之前的形态）：SessionEnd 记成正常 exit 且退 0",
    },
  ],
};

export default def;
