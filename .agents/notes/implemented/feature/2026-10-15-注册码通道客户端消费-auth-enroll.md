---
Status: implemented
Date: 2026-10-15
---

# 注册码通道的客户端消费：`auth enroll` 命令（D2）

## 决定了什么

D2 裁决 ①：**保留注册码通道**，定位为「没有飞书 / 无浏览器的机器（CI、共享构建机）」的注册路径；
本次把客户端缺的另一半补上——此前 sid-code 全仓没有任何代码请求 `/ctl/enroll`，注册码只能用 curl 手工换凭据。

- 新增 `packages/core/src/identity/enroll.ts`：`performCodeEnroll()` 走 `POST {backend}/api/v1/ctl/enroll`，
  头 `X-Enroll-Token: <码>`，体 `{device_id, org_id, team_id?, platform, ver}`；成功后 `saveDeviceCredential()`
  落盘（0o600）。**凭据不带 user 段**——注册码流程设备不绑定到人（对比：`cli-login` 的凭据带 `user`）。
- `EnrollError` 把服务端状态码翻译成机器可读 reason：403 `disabled`（开关未开，提示指向管理员）、
  401 `rejected`（码无效 / 已用过 / 过期 / 组织不匹配）、409 `conflict`（设备已绑人 / 已在别的组织）、
  `network` / `server_error` / `bad_response`。
- `endpoints.ts` 新通道 `enroll → /ctl/enroll`（唯一取址入口），并登记进 `BACKEND_ROUTE_CONTRACT`；
  快照 `packages/core/tests/fixtures/backend-paths.json` 同步重新生成。
- CLI `packages/cli/src/command/auth.ts` 加 `cmdEnroll` 子命令（`--code` / `--org` / `--team` / `--json`），
  错误路径 exit(1) 且给可操作提示。
- 配套 agent-backend 侧（PR #72）：`/auth/options` 暴露 `enroll_enabled`，管理台在开关关闭时
  把「签发注册码」置灰并说明原因；签发弹窗的引导文案从「POST /api/v1/ctl/enroll」改为本命令。

## 放弃了什么（以及为什么不选）

- **② 下线通道（管理台隐藏注册码区块）**：D1 之后组织 / 团队虽不再依赖注册码创建，但
  「没有飞书 / 无浏览器」的机器仍只此一条注册路径，删掉等于把这些机器永久排除在控制面之外。
- **把 enroll 逻辑塞进 cli-login.ts**：飞书身份与注册码是两条并列的注册通道，语义不同；
  只导出复用 `readDetail` 一个纯函数（复制一份会留两处漂移点，后端 detail 格式变化时只改一处）。
- **客户端预检 `CTL_ENROLL_ENABLED` 再换码**：开关状态只有服务端知道，预检要多一次请求；
  直接让服务端用 403 一次说清（enroll 本来就一次往返）。
- **`--org` 做成选填**（服务端 `org_id` 本来可选）：做成必填——显式声明目标组织让服务端校验
  「码与组织匹配」（对不上按无效码处理），防「拿错组织的码」这种静默错配。

## 拿什么证明它生效了

- `bun test packages/core/tests/identity/enroll.test.ts` → **10 pass**：成功路径断言 URL / method /
  `X-Enroll-Token` 头 / body 字段 / 凭据落盘且无 user 段；六类错误分支 403 / 401 / 409 / 网络 / 坏响应 / 5xx。
- `bun test packages/cli/tests/command/auth-enroll.test.ts` → **8 pass**：成功输出、`--json`、
  `--code=value` 等号形式、缺参数用法提示、403 / 401、`--json` 失败、未配 backend.url。
- `UPDATE_BACKEND_PATHS=1 bun test packages/core/tests/identity/endpoints.test.ts` → **30 pass**；
  快照新增 `{"method":"POST","path":"/api/v1/ctl/enroll"}`；CHANNELS 补入 enroll 后
  「每条通道的 PATH 都被契约覆盖」仍绿（防漂移哨兵在正常工作）。
- `bun run affected-tests:run` → **13424 pass / 9 skip / 0 fail**。
- `make build` → exit 0；`will always be undefined` 警告 **0 条**（worktree 里先删掉指向主仓的
  `node_modules` 软链、重装后才构建——不重建的话 `@sid-code/core` 会解析到主仓 checkout，
  新模块在产物里就是 undefined，而构建仍 exit 0）。
- `bun run lint` / `format:check` / `lint:boundary` / `typecheck:gate`（66/66 无新增）全绿。
- **待合并发版后**做真实端到端：管理台签发一个码（或直接拿已签的），真实机器执行
  `sid-code auth enroll --code <码> --org <组织>` → `auth status` 显示凭据与登录时间 →
  `/ctl/*` 通道可用。单测覆盖了协议层，这一步验的是「用户链路真的走通」。
