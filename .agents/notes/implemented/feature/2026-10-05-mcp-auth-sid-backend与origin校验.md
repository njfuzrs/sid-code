---
Status: implemented
Date: 2026-10-05
---
# MCP `auth:"sid-backend"`：用设备凭据连公司后端的远程 MCP，只发往 backend.url 同 origin

## 决定了什么

- MCP 服务器配置新增 `auth: "sid-backend"`（`config.ts` / `mcp/types.ts` / settings zod schema）。
  `mcp/manager.ts` 的 `createTransport` 遇到它就调用新模块 `mcp/backend-auth.ts` 的 `buildSidBackendHeaders`。
- 外泄防线：用 `${VAR}` 展开后的最终 url 与 `resolveBackendUrl().origin` 做精确 origin 比对，不一致就抛
  `BackendAuthRejectedError`，连接失败（fail-closed）。没配 backend.url、本机没有可用凭据、ws 传输，同样拒绝。
  backend.url 本身不读项目级 settings（既有设计），所以仓库和插件都改不了比对基准。
- Authorization 是 getter：transport 每个请求都展开一次 headers，所以每次都现取 `getUsableCredentialToken()`。
  续期后不用重连。登出 / 过期后发空 Bearer，让服务端回 401，不沿用旧值。
- 配置里任意大小写的 Authorization 都被剔除。`validateConfig` 拦截拼错的 auth 值，以及 stdio + sid-backend 的组合。

## 放弃了什么（以及为什么不选）

- **给 headers 加 `${VAR}` 展开、让插件写 `Authorization: Bearer ${SID_DEVICE_TOKEN}`**：凭据续期后要重启；
  更关键的是，一旦 headers 能读环境变量，任何插件都能把任意环境变量发到自己的地址，
  这条外泄通道比要堵的那条更宽。设计文档 §5.3 也明确写了「不走 `${VAR}` 展开」。
- **origin 不一致时不带凭据照连**：用户会看到 server 连上了却拿不到数据，很难排查。拒绝并给出原因更直接。
- **按 host 或前缀比对**：`corp.example.attacker.example`、子域名、端口不同、http 降级都会漏过。
  只认 `URL.origin` 完全相等。
- **在 transport 层做重定向防护**：实测 bun 1.4.2 的 fetch 在跨 origin 重定向时会剥掉 Authorization，
  所以本次不另加 `redirect:"error"`。

## 拿什么证明它生效了

- `bun test ./packages/core/tests/mcp/backend-auth.test.ts`：14 pass。其中端到端用例起两个本地 Streamable HTTP MCP，
  断言**服务端实际收到的** Authorization：同 origin 每个请求都是 `Bearer e2e-cred`，异 origin（localhost vs 127.0.0.1）
  一个请求都没收到。
- 变异自证 1：把 origin 比较改成 `false &&` → 7 fail（6 个异 origin 用例 + 端到端），恢复后 14 pass。
- 变异自证 2：把 manager 里的 `config.auth === SID_BACKEND_AUTH` 分支短路 → 端到端用例 fail，证明接进了生产路径。
- `bun run affected-tests:run`：868 pass / 0 fail。`make build` exit 0，`will always be undefined` 命中 0。
- 尚未做：用真实后端 `feishu-docs` 跑一次真实会话验收（需要合并发版后，用 sc-dev 或线上版走 §2 第 4、5 步）。
