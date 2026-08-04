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

const existing = process.env.SID_CONFIG_DIR;
if (!existing || existing.trim() === "") {
  process.env.SID_CONFIG_DIR = mkdtempSync(join(tmpdir(), "sid-code-test-home-"));
}
