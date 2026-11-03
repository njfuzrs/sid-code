/**
 * 测试全局隔离预载：把配置根目录默认指向临时目录。
 *
 * ## 为什么需要这个
 *
 * 很多写 `~/.sid-code/` 的组件是在调用链深处被**无参构造**的，测试作者根本看不见它。
 * 典型例子：`PermissionChecker` 构造函数里 `new AuditLogger()`（`src/permission/checker.ts:360`），
 * 而 `AuditLogger` 无参时落 `sidPaths.log("permissions-audit.log")`（`src/permission/audit.ts:21`）。
 * 于是 `tests/permission/` 下 5 个**从没提到过 audit 字样**的测试，每跑一次就往用户真实的
 * 审计日志追加几十行。
 *
 * 这类污染靠"测试作者记得隔离"是防不住的——他要隔离的东西在他的视野之外。
 * 所以把隔离做成**默认值**：进程启动时先把 `SID_CONFIG_DIR` 指向临时目录，
 * 任何忘记显式隔离的落盘都掉进临时目录，而不是用户家目录。
 *
 * ## 为什么这样是安全的
 *
 * - `getSidHome()` 每次调用都重新读 env、不缓存（`src/config/paths.ts:27`），
 *   所以预载期设置即对全部后续调用生效。
 * - 已显式设 `SID_CONFIG_DIR` 的测试（39 个文件）在自己的 `beforeEach` 里覆盖本默认值，
 *   行为不变。
 * - **尊重外部显式设置**：若运行者已经在环境里设了 `SID_CONFIG_DIR`（比如 CI 想指定位置），
 *   这里不覆盖。
 *
 * 注：这是**兜底**，不是"不用再写隔离了"。专用重定向变量（如 `SID_CODE_CACHE_BREAKS`）
 * 仍应在需要断言落盘内容的测试里显式设置——兜底只保证"写错地方不会伤到用户"，
 * 不保证"每个测试拿到互不干扰的干净文件"。
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "bun:test";
import { initLogger } from "@sid-code/core/debug/logger.ts";

const existing = process.env.SID_CONFIG_DIR;
if (!existing || existing.trim() === "") {
  process.env.SID_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sid-code-test-home-"));
}

/**
 * 全局 logger 复位兜底（D60）。
 *
 * ## 为什么需要
 *
 * `initLogger()` 改的是**进程级单例**：`globalLogger` 建一次，之后每次调用都是原地
 * `reconfigure`（`src/debug/logger.ts`）。所以一个测试文件打开 logger 之后不复位，
 * 同进程后续所有测试文件都继承这个状态 —— 而 logger 的 `console` 默认为 `true`，
 * 非 ERROR 级别走 `console.log`。
 *
 * D60 的实测形态：`packages/core/tests/config/sid-home-path-derivation.test.ts` 打开
 * logger 没复位 → `packages/cli/tests/command/agents-summarize-tools.test.ts` 的
 * `captureJson()` 把整段 `console.log` 当 JSON 解析 → `SyntaxError: Unrecognized
 * token '^['`。一次红、重跑绿，归于 PR 作者时极难自证无关（PR #538 实测）。
 *
 * ## 为什么放在 preload 而不是只靠静态门禁
 *
 * 静态门禁（`packages/core/tests/debug/logger-global-leak-gate.test.ts`）是**穷举式**
 * 防线：它只扫已知的 6 个测试根，正则也可能漏掉某种写法。这里是**判据式**兜底：
 * 不论哪个测试文件、以什么方式打开了 logger，每个用例结束后都复位，泄漏窗口被压到
 * 单个 test 之内。两者互补，不要拿一个替代另一个。
 *
 * ## 已核实的行为（不是"应该生效"）
 *
 * 2026-11-03 在 bun 1.4.2 上实测：preload 顶层注册的 `afterEach` 对**每个测试文件的
 * 每个 test** 都执行（2 文件 × 2 test = 4 次，preload 本身只加载一次）。
 *
 * ## 代价（写在这里，免得下一个人踩）
 *
 * 它让"logger 在多个 test 之间保持打开"变成不成立。所以**不要在 `beforeAll` /
 * 模块顶层开 logger** —— 要开就在 test / `beforeEach` 里开，用例内用完；文件级的
 * `afterEach` 复位仍然建议写上（静态门禁认可 `console: false` / `fileOnly: true`
 * 那一道，本兜底只负责清状态）。
 *
 * ## 局限
 *
 * - 只在**以仓库根为 cwd** 跑 `bun test` 时生效（读不到根 `bunfig.toml` 就没有
 *   preload）。各包的 `bunfig.toml` 已经指回本文件，但新增包必须一并加一份
 *   （门禁见 `tests/build/test-isolation-preload-wiring.test.ts`）。
 * - 它不能替代测试自己的隔离：要断言落盘内容的测试仍须显式设专用重定向变量。
 */
afterEach(() => {
  initLogger({ enabled: false });
});
