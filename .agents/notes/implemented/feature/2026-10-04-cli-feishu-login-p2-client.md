---
Status: implemented
Date: 2026-10-04
---
# P2 客户端：`sid-code auth login` 用飞书身份登录企业后端

## 决定了什么

- `auth login / logout / status` 替换原先的硬拒绝；顶层 `sid-code login` / `logout` 是别名（bootstrap 快速路径）。
- 流程放在 core：`identity/cli-login.ts`。本地 PKCE（S256）+ `cli_state` →
  复用 `mcp/oauth-callback-server.ts` 起 127.0.0.1 回调 → 浏览器打开
  `{backend}/api/v1/auth/feishu/cli/start?port&challenge&challenge_method&cli_state&device_id` →
  回调校验 state → `POST /api/v1/auth/cli/exchange {code, verifier, device_id, platform, ver}` →
  `saveDeviceCredential()`（此前零调用方）。409 映射为「设备已绑定他人」，提示原用户 logout。
- 凭据文件增加 `user:{id, name, union_id}` 段；`getIdentity()` 的 userId 改为
  **登录态（union_id > users 主键）> env > settings**，不一致告警一次。orgId / teamId 不变。
- 新增统一后端地址 `backend.url`（`identity/backend-url.ts`）：env `SID_CODE_BACKEND_URL` > managed-settings > 用户 settings；
  只允许 https 或 loopback http；`backend` 进 `SECURITY_SENSITIVE_FIELDS`，项目级不可覆盖。
  不走 `loadConfig()`，因为 login 是快速路径。已有的各 `SID_CODE_*_ENDPOINT` 不动。
- 四处 401 告警（policy / 账本 / 事件 / 预算）统一追加 `RELOGIN_HINT`「请执行 sid-code auth login 重新登录」。
  fail-open 语义不变。
- `logout` 尽力调 `POST /auth/cli/logout` 解绑（404 当作旧后端，标 unsupported），一律删本地凭据。
  `status --verify` 调 `/ctl/whoami`，能发现服务端吊销。

## 放弃了什么（以及为什么不选）

- **把 backend.url 放进 Config / loadConfig**：login 是 bootstrap 快速路径，加载整套配置会拖慢启动，还会把 MCP / hook 一起带起来。
  这里沿用 `loadManagedIdentity` 的做法，直接读文件。
- **明文非本地地址告警后照用 / 降级到下一个来源**：后端地址决定凭据发往哪里，配错就应该停下，不能悄悄换一个。
- **登录态只用于展示、不改 getIdentity**：方案 §5.2 明确要求 getIdentity 优先读登录态，四方落盘共用这一个入口，改一处全部生效。
  服务端归因仍只认 `device.user_ref`，客户端写什么都伪造不了归属。
- **在 callback 服务器里去掉 `unref()`**：它是给 TUI 内 MCP OAuth 用的，改它会影响那条路径。改为在 `performCliLogin` 里持有保活句柄。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/identity/`：42 pass。覆盖全流程（假后端走真实 127.0.0.1 回调、按 S256 校验 verifier）、
  state 不匹配被拒且不落盘、超时、409、400/401/403/5xx/网络/缺 credential、logout 三种后端状态、verify 401、
  getIdentity 优先级与告警只发一次、项目级 backend 被过滤、凭据 0600。
- **编译产物端到端**（`make build` 后对一个本地假后端跑 `sid-code login` → `auth status --verify` → 吊销 → `--verify` → `logout`）：
  第一次跑发现**真缺陷**：回调服务器与计时器都是 unref，独立进程在浏览器回调前就 exit 0 退出，没有落盘。
  单测里 bun test 撑着事件循环，所以看不见。加保活句柄后整条链路通过：
  `✓ 已登录：张三`、文件 `-rw-------`、`服务端核验: ✓` → 吊销后 `✗ 401` 并提示重新登录 → logout 后文件删除。
- 回归门禁 `flag-e2e.test.ts`「login 等待浏览器回调期间进程不提前退出」做了变异自证：去掉保活句柄后 0 pass / 1 fail。
- `bun run affected-tests:run` 4334 pass / 0 fail；`make build` 成功；lint / format:check / docs:gen-reference --check 全绿。
- **未验证**：真实 agent-backend 的 `cli/start`、`cli/exchange`、`cli/logout` 端点（后端 P2 尚未合入）。
  请求字段按方案 §5.2 与交接约定编写，后端落地后需要用真实飞书走一遍；
  「真实会话的事件 / 账本里出现 user_ref」要等发版后验收。
