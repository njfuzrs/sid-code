---
Status: implemented
Date: 2026-10-06
---
# MCP 遗留子项：进程内传输补 sanitize 与 close 通知对端，approveAll 改为按项目生效

## 决定了什么

补齐 MCP 接入层审查（20260927）里 B1/B3 没收进验收判据的三个子项：

- **D12-3**：`InProcessTransportImpl` 的请求 / 应答 / 通知三条出口都过 `sanitizeStrings`，与其它网络传输同口径。
- **D12-4**：`close()` 现在会通知对端。对端进入关闭态、reject 自己的 pending、触发 `onClose`（意外断开语义）；主动关闭的一方**不**触发自己的 `onClose`，保持 D1 的约定（onClose = 意外断开，否则 MCPClient 会把主动断开当成断线去重连）。两头都幂等。
- **D17-3**：`approveAll` 从全局布尔改成按项目的 `approveAllProjects: string[]`，`setApproveAll(value, projectPath)` 只作用于当前项目，显式 rejected 仍优先。旧文件里残留的 `approveAll: true` **一律不认**（fail-closed），下次写盘时删除。

## 放弃了什么（以及为什么不选）

- **把旧的 `approveAll: true` 迁移成"对所有已知项目生效"**：要修掉的正是"全局放行"这个语义，迁过去等于没修；而且也无法反推当初是在哪个项目打开的。代价是曾经打开过它的用户要重新审批一次，这是可以接受的安全侧代价。
- **D12-4 让主动关闭的一方也触发 onClose**：违反 D1 的约定，MCPClient 会对主动断开发起重连。
- **给 approveAll 加过期时间**：按项目已经堵住了跨仓库注入这条攻击路径，过期时间是另一层加固，目前也没有 UI 入口（`setApproveAll` 全仓零调用方），等以后加入口时再一起考虑。

## 拿什么证明它生效了

- 新测试 `packages/core/tests/mcp/mcp-subitems-d12-d17.test.ts`，5 pass。
- 变异自证（逐条改回去重跑）：去掉三处 sanitize → D12-3 组红；删掉 `peer?._peerClosed()` → D12-4 组红（pending 挂到 5s 超时）；判定改回全局放行 → D17-3 组 2 条红。
- `bun run affected-tests:run` 202 pass / 0 fail；`lint`、`format:check`、`lint:boundary` 均 exit 0；`make build` 成功，没有 `will always be undefined` 警告。
