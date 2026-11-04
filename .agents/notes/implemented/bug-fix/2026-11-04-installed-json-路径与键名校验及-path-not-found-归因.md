---
Status: implemented
Date: 2026-11-04
---
# installed.json 的 path / 键名改为加载时校验，path-not-found 不再冒充组件级失败

## 决定了什么

缺陷 29（P1）与缺陷 30（P3）一起改，因为它们落在同一个函数 `loadInstalledPlugins` 里。

- `packages/cli/src/plugin/loader.ts` 的 `loadInstalledPlugins` 改为 `for (const [key, entry] of ...)`，保留注册表键名，并加三层校验：
  1. 结构校验：entry 必须是非 null 对象、`path` 为非空绝对路径字符串，否则报 `generic-error` 并跳过（不抛异常，一个坏条目不阻断启动）。
  2. 路径边界：`entry.external !== true` 时，`path` 必须在 `getPluginsDir()` 之内（`path.relative` 判据：rel 非空、不以 `..` 开头、不是绝对路径，两侧先 `resolve` 规范化），否则报 `path-escape` 并跳过。
  3. 键名一致性：`loadPluginFromDirectory` 成功后校验 `key === plugin.name`，不一致报 `generic-error`（文案含两个名字）且不 push —— fail-closed。
- `types.ts`：`InstalledPluginEntry` 增加可选 `external?: boolean`；`path-not-found` 的 `component` 改为可选，`formatPluginError` 无 component 时输出「插件目录不存在: …」。
- `operations.ts`：`installPlugin` 在 `copy=false` 时写入 `external: true`（`--no-copy` 是显式原地引用）。
- `loader.ts` 两处目录级 `path-not-found`（installed / inline）不再传 `component: "commands"`。

`checkPluginOrigin`（PR #561 的企业策略门）逻辑未动。

## 放弃了什么（以及为什么不选）

- **不抛异常、不整表拒绝**：installed.json 里一条坏条目不该让用户所有插件都加载不了；逐条跳过 + 结构化错误，与 `readInstalledPlugins`「坏文件返回空注册表」的口径一致。
- **不用裸字符串前缀判据**：`entry.path.startsWith(pluginsDir)` 会把 `/…/plugins-evil` 判成在目录内（缺陷 31 已实测这类判据的问题），所以用 `path.relative`。
- **不把所有目录外条目一律拒**：`--no-copy` 安装的合法场景就是原地引用，全靠「条目必须落在插件目录内」会打断开发流程。折中为显式标记 `external: true` —— 手改 installed.json 仍能伪造这个标记，但那与「用户本来就拥有本机写权限」等价，属于已声明的能力边界（见 types.ts 的 market 段注释），不做对抗。
- **键名不一致时不「自动迁移」或取其一**：operations 按键名操作注册表，builtinOverrides / 运行时按 manifest.name。静默选一边只会把问题藏起来，直接跳过并报错让用户重装。
- **没有扩大结构校验到 name / source / enabled 等全部字段**（缺陷 37 的范围），本次只做与 path 相关的必要校验，避免越界改动。

## 拿什么证明它生效了

- `bun test ./packages/cli/tests/plugin/` → **175 pass / 0 fail**（新增 6 条：相对路径→generic-error；目录外无 external→path-escape、加 external→正常加载；键名不一致→generic-error 且文案含两个名字；正常条目照常加载；formatPluginError 两形态；loader 两处 path-not-found 均无 component）。
- **变异自证**：把 `entry.external !== true && !isInsidePluginsDir(...)` 与 `key !== plugin.name` 两处判据临时改成 `if (false)`，对应两条断言立刻变红（13 pass / 2 fail），恢复后复绿。
- `bun run affected-tests:run`（判定 selective → `bun test ./packages/cli/`）：**2763 pass / 9 skip / 0 fail**。
  - 注：首次运行有 280 fail，原因不是本改动，而是 worktree 的 `node_modules` 软链到主仓、主仓缺 `@sid-code/tui` 链接（`Cannot find module '@sid-code/tui/…'`）。按 CLAUDE.md 的处置删掉 worktree 的 `node_modules` 软链后 `bun install`，同一命令复跑即全绿。
- `make build` 通过（编译产物自检全绿）；`bun run typecheck:gate` 无新增（64/64）；`bun run lint` 0 warning 0 error；`bun run format:check` 通过。
- 隔离：新增测试在 `beforeEach` 把 `SID_CONFIG_DIR` 指向 tmpdir 并在 `afterEach` 恢复原值，installed.json 与插件目录都落在临时目录里。
