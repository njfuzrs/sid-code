# CI Failure Classification Patterns

> ci-self-heal Skill 启发式分类规则手册. 由 RFC-002 §2.4 + SKILL.md §3.2 引用.
> 本文件维护"分类 class → 信号 pattern + 权重"的映射, 让 classify-failure.ts 的判断有人可读的依据.

---

## 1. 分类与权重总表

| 分类 | 强信号(+0.4~0.5) | 中信号(+0.2~0.35) | 弱信号(+0.1~0.15) |
| --- | --- | --- | --- |
| `test_failure` | runner=jest/vitest/pytest/go-test/bun-test/mocha | failedAssertions ≥ 1 | `expect()` / `assert` 关键字 |
| `lint_failure` | runner=eslint | `no-unused-vars` / `prefer-const` / `prettier` | `formatting` / `style` |
| `build_failure` | cargo `error[E*]` | bundler 错误(webpack/vite/esbuild/rollup) | — |
| `type_error` | runner=tsc | `error TS\d{4}` / `TypeError` / `incompatible types` | `cannot assign` |
| `dependency_missing` | `Module not found` / `Cannot find module` | `npm ERR!` / `yarn error` / `ERESOLVE` | `peer dep` / `version conflict` |
| `config_error` | `YAMLException` / `invalid config` | — | `.github/workflows` / `tsconfig` mention |
| `flaky` | retry markers (`retry N` / `attempt M of N`) | `timeout` / `ECONNREFUSED` / `EADDRINUSE` / `Date.now` | `race condition` / `eventually consistent` |
| `timeout` | `timeout exceeded` / `operation timed out` | `deadline exceeded` / `context deadline` | — |
| `unknown` | (兜底) | — | — |

权重叠加, 上限 0.95 (留 0.05 给 LLM 修正).

---

## 2. 各分类详细 pattern

### 2.1 test_failure(测试失败)

**典型 log 形态**:
- jest: `FAIL  src/foo.test.ts` + `Tests: N failed, M passed`
- vitest: `❯ test_name` + `Expected:` / `Received:`
- pytest: `=========== FAILURES ===========` + `assert X == Y`
- go-test: `--- FAIL: TestFoo` + `want X, got Y`
- bun-test: `(fail)` + 错误堆栈
- mocha: `passing (N)` / `failing (N)`

**信号优先级**:
1. runner 命中(parse-ci-log.ts 已识别) → +0.35
2. failedAssertions 数组非空 → +0.25
3. 文本含 `expect(.)\.` 或 `assert ` → +0.15

**反例(应当不归为 test_failure)**:
- 单元测试通过, 但 build 阶段失败(tsc 报错) → 归 `type_error` 或 `build_failure`
- pytest 报 `ImportError: No module named X` → 归 `dependency_missing`(更精准)

---

### 2.2 type_error(类型错误)

**典型 log 形态**:
- TypeScript: `error TS2305: Module "..." has no exported member "..."`
- Flow: `Cannot assign string to number` 配 `[incompatible-type]`
- mypy: `error: Argument 1 to "f" has incompatible type`

**信号优先级**:
1. runner=tsc → +0.5
2. 错误消息含 `error TS\d{4}` / `TypeError:` / `incompatible types` → +0.25

**与 test_failure 的边界**:
- `TypeError: Cannot read properties of undefined` 出现在测试运行时 → 测试失败的根因可能是类型错误, 但**分类应优先 test_failure**(因为 runner 是 jest/vitest, type_error 是次因)
- 这正是 candidate_alternatives 的用途: 主类 test_failure (0.6), 次类 type_error (0.25)

---

### 2.3 lint_failure(lint 失败)

**典型 log 形态**:
- eslint: `src/foo.ts:10:5  error  'bar' is assigned a value but never used  no-unused-vars`
- prettier: `[error] src/foo.ts: SyntaxError`
- ruff/flake8: `src/foo.py:10:5: E501 line too long`

**与 test_failure 的边界**: lint 总是非测试上下文, 不会与 test_failure 强冲突.

---

### 2.4 build_failure(构建失败)

**典型 log 形态**:
- cargo: `error[E0308]: mismatched types`
- webpack/vite: `Module build failed: SyntaxError`
- rollup: `Could not resolve "..."`

**与 dependency_missing 的边界**:
- `Module not found: Can't resolve "lodash"` → 优先 `dependency_missing`(更精确, 修复路径明确: 装包)
- `Module build failed: Unexpected token` → 归 `build_failure`(语法/编译问题)

---

### 2.5 dependency_missing(依赖缺失)

**典型 log 形态**:
- Node.js: `Error: Cannot find module 'lodash'`
- npm/yarn/pnpm/bun 安装错误: `npm ERR! 404 Not Found`, `ERESOLVE peer dep conflict`
- Python: `ModuleNotFoundError: No module named 'pandas'`
- Rust: `error: failed to load source for dependency`

---

### 2.6 config_error(配置错误)

**典型 log 形态**:
- GitHub Actions: `The workflow is not valid. .github/workflows/ci.yml`
- jest config: `Validation Error: Cannot find module from jest.config.ts`
- tsconfig: `error TS5023: Unknown compiler option`

---

### 2.7 flaky(不稳定测试)

**典型信号**:
1. **retry markers**(强信号): `retry 1`, `attempt 2 of 3`, `(2 retries)`
2. **时间相关**: `timeout`, `setTimeout`, `Date.now()`, `now()` —— 测试依赖时间
3. **网络相关**: `ECONNREFUSED`, `EADDRINUSE`, `socket hang up`, `fetch failed` —— 测试依赖网络
4. **并发相关**: `race condition`, `deadlock`, `eventually consistent`

**判定原则**: flaky 在 classify-failure.ts 中**优先识别**, 因为它会"借用"其他类的信号(如 timeout 同时是 timeout 和 flaky 的信号).

**LLM 修正路径**: classify-failure.ts 给出 `class=flaky` 后, LLM 可基于历史 run 数据(M6+ 持久化)进一步确认. M4 阶段单次 log 难以精确判定, 给 `confidence=0.4~0.6` 即可.

---

### 2.8 timeout(超时)

**典型 log 形态**:
- jest/vitest: `Exceeded timeout of 5000 ms for a test`
- go-test: `panic: test timed out after 30s`
- gRPC/HTTP: `context deadline exceeded`

**与 flaky 的边界**: 超时 + retry markers → flaky; 单次超时 + 无 retry → timeout.

---

### 2.9 unknown(兜底)

当所有启发式都未命中, 或总分为 0 时返回 `unknown`. LLM 在这种情况下应:
1. 引用 errorMessages 字段的内容直接询问开发者
2. 不强行给出 hypothesis

---

## 3. ambiguity 处理(LLM 协同)

classify-failure.ts 输出含 `candidate_alternatives` 字段, 用于让 LLM 在 ambiguous 场景做二次判断:

- 主类 confidence ≥ 0.6: LLM 信任主类, 围绕该类生成 hypothesis
- 主类 confidence 0.3~0.6: LLM 在 hypothesis 中**同时考虑主类 + 次类**, 比如 "可能是 test_failure(主), 但若是 type_error(次), 修复路径应为..."
- 主类 confidence < 0.3 或 = unknown: LLM 在 hypothesis 中标 `Confidence: low`, 引用 raw errorMessages 不强分类

---

## 4. 维护规则

新增分类信号时:
1. 在 §1 总表加权重行
2. 在 §2 加详细 pattern + 反例(必填)
3. 在 classify-failure.ts 加对应启发式规则 + signals 字符串
4. 加 1 条 case_csh_NNN.yaml 守护(Step 7 边界 case)

> 本文件维护频率预期: 每 sprint 加 1-3 条新 pattern(基于 dogfood 反馈和 case 沉淀).
