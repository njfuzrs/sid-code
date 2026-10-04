---
Status: implemented
Date: 2026-10-04
---
# 企业后端取址统一：七条通道只认 `backend.url`

## 决定了什么

P2 验收时发现：`auth login` 成功、设备已绑到人，但事件和账本从没发往后端。原因是七条通道各有各的取址方式，
只配 `backend.url` 时只有登录这一条通了，其余全部静默不发，`auth status` 还显示「✓ 凭据有效」。

- **唯一取址入口** `identity/endpoints.ts`：`resolveEndpoint(channel)` 从 `backend.url`
  （env > managed > user，项目级不参与）拼 `/api/v1 + BACKEND_PATHS[channel]`。策略、预算、账本、
  事件、flag 全部改走它；登录与轨迹上传器的路径也收进同一张表。core/src 里不再有别处拼 `/api/v1/`。
- **事件内置 exporter** `sid-backend`：配了 `backend.url` 自动注册。`analytics.backends[]` 只用来接第三方
  collector，其中与内置端点相同的一项会被跳过并告警，避免重复上报。
- **轨迹** `trace.upload.url` 缺省取 `backend.url`，token 仍单独配（数据面用共享 `X-Upload-Token`，
  这是服务端的冻结约束）。显式配了不同地址照样尊重，启动时告警一次。
- **四份明文 URL 校验合成一份**（`endpoints.ts#isNonLocalHttp` = `normalizeBackendUrl` 判据）。
  顺带堵上旧版 policy.ts 放行 `https://u:p@host` 的问题。
- **「没配」要看得见**：`auth status` 逐条列七条通道（地址 / 来源 / 本地缓存状态）；`--verify` 对每条发一次
  不写库的探测（账本拿到 400 算通过：鉴权先于 body 解析，详见 `backend-channels.ts` 文件头）；
  已登录但没有 backend.url 时启动告警；`/doctor` 也加了同样的检查项。
- **门禁**：静态扫描（除 endpoints.ts 外出现 `/api/v1/` 字面量或读旧 `*_ENDPOINT` 即红）；
  安全门禁（`analytics` / `trace` / `backend` 不在 `PROJECT_BEHAVIOR_FIELDS`）；路由契约快照
  `packages/core/tests/fixtures/backend-paths.json`，供 agent-backend 断言路由存在。

## 放弃了什么（以及为什么不选）

- **直接删掉旧的 `SID_CODE_{POLICY,BUDGET,USAGE}_ENDPOINT`**：已经部署的机器会一夜之间断流。
  现在保留一个版本周期：只在没配 backend.url 时生效，和 backend.url 冲突时被忽略并告警。
- **backend.url 不合法时降级去用旧变量**：一个写错的地址会悄悄换掉出口。现在 invalid 和 none 分开处理，
  invalid 时全部通道返回 null。
- **轨迹上传也改用设备凭据**：要改服务端已冻结的上传鉴权，超出本次范围。只统一地址，不统一鉴权。
- **用 HEAD 做 `--verify` 探测**：两个写入端点都不支持 HEAD。
- **顺手改 agent-backend 的契约测试**：那个仓库里有别人正在改的 P3 代码，本 PR 只导出快照。

## 拿什么证明它生效了

- 单测 `packages/core/tests/identity/endpoints.test.ts`：T1–T14 + 路由快照，共 30 条。
- 编译产物 + 生产后端：`auth status --verify` 七条通道全部拿到真实状态码（200/204/204/400/202/200/200）；
  错误 base 时六条判 404，轨迹单独显示来源；没配 base 时七行都是「未配置」；项目级 evil backend.url 不生效；
  旧变量冲突时告警并忽略。真实会话里内置事件后端已注册，本地没有失败盘残留，账本有这个会话的行。

## 遗留

- agent-backend 要加 `tests/test_client_contract.py`，读拷贝过去的快照断言 `app.routes`。
- 下个版本删掉三个旧 env 和 `analytics.featureFlagEndpoint`。
