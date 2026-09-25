---
Status: implemented
Date: 2026-09-25
---
# baseURL 只认 SID_CODE_LLM_BASE_URL

## 决定了什么

`loadFromEnv` 的 baseURL 只读 `SID_CODE_LLM_BASE_URL`。

- 去掉 `ANTHROPIC_BASE_URL` 兜底（`config.ts`），并从 bash 子进程 env 白名单（`env-sanitizer.ts`）删除该名字，避免子进程里的 sid-code 继续读到它。
- 去掉 `OPENAI_BASE_URL` 兼容别名（`config.ts` + `help.ts`）。参考页 `website/ref/env.md` 由 `bun run docs:gen-reference` 重新生成，该别名从公开列表消失。
- 两处「per-model base_url 覆盖 env」告警的文案改为只点名 `SID_CODE_LLM_BASE_URL`。
- 回归测试锁在 `packages/core/tests/config/config.test.ts`：两个外来变量同时设置时 `baseURL` 为空串，设上自己的变量后取到自己的值。

## 放弃了什么（以及为什么不选）

- **只删 `ANTHROPIC_BASE_URL`、保留 `OPENAI_BASE_URL`。** 不选。它同样不是 sid-code 的配置面：OpenAI SDK 与其它工具都读这个名字，而 env 优先于配置文件，同机设了就会盖掉用户自己的 baseURL。`--help` 把它写成「SID_CODE_LLM_BASE_URL 的兼容别名」并与「仅 sid-code 生效」放在一起，这个说法对一个通用变量不成立。全仓无测试锁这个别名，本机 `~/.zshrc` 与 `settings.json` 都没有使用它。
- **保留别名但降级为「仅当 SID_CODE_LLM_BASE_URL 未设且配置文件也没有 baseURL 时才读」。** 不选。配置文件里的 per-model `base_url` 本来就更高优先级，告警仍然会每次启动打出来；没配 per-model 的模型又会被静默带走。两条路都是这次要消掉的行为。
- **`scripts/provider-canary.ts` 与 `scripts/provider-stress.ts` 里直接读 `process.env.OPENAI_BASE_URL`。** 不动。那是维护者手动跑的探测脚本，不走 `loadConfig`，不进用户启动路径。

## 拿什么证明它生效了

`bun test ./packages/core/tests/config/config.test.ts ./packages/core/tests/config/env-sanitizer.test.ts`

```
24 pass
0 fail
57 expect() calls
Ran 24 tests across 2 files. [45.00ms]
```

新增用例在 `ANTHROPIC_BASE_URL=http://127.0.0.1:4000` 且 `OPENAI_BASE_URL=https://openai.example/v1`、空配置目录下断言 `baseURL === ""`；再设 `SID_CODE_LLM_BASE_URL=https://sid.example/v1` 断言取到该值。
