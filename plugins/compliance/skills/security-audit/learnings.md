# security-audit Skill 偏差回写记录

> **维护者**: zhourusheng
> **创建日期**: 2026-05-31（Sprint S7-T06）
> **更新频率**: 每次 dogfood / baseline 跑分后有新偏差时更新
> **来源**: dogfood PR 反馈 + baseline N=3 跑分偏差分析

---

## 偏差记录

### L-001: Dockerfile 多阶段构建误报 iac_misconfig

- **发现日期**: 2026-05-31（S6 dogfood PR-11）
- **偏差描述**: 多阶段 Dockerfile 中间阶段无 USER 指令被误报为 iac_misconfig
- **根因**: detect-vulnerabilities.ts 的 iac_misconfig pattern 未区分 build stage vs runtime stage
- **修复**: 加 `FROM.*AS.*build` 上下文排除规则
- **状态**: ✅ 已修复（S7-T07 边界 case 覆盖）

### L-002: 注释中的 SQL 示例被误报 injection

- **发现日期**: 2026-05-31（S7 baseline N=3 跑分）
- **偏差描述**: 代码注释中的 SQL 示例（`// Example: SELECT * FROM users WHERE id=${userId}`）被误报
- **根因**: pattern 未排除注释行（`//` / `/*` / `#` 开头）
- **修复**: 加注释行排除逻辑
- **状态**: ✅ 已修复

### L-003: test fixture 中的硬编码 token 被误报 secret_leak

- **发现日期**: 2026-05-31（S7 baseline）
- **偏差描述**: tests/fixtures/ 下的 mock token 被误报
- **根因**: fixture 路径豁免逻辑未覆盖 `tests/fixtures/` 目录
- **修复**: 加 fixture 路径排除（与 pii-scan 同逻辑）
- **状态**: ✅ 已修复

### L-004: crypto_weak 对 cache key 用途的 MD5 误报

- **发现日期**: 2026-05-31（S7 边界测试）
- **偏差描述**: `createHash('md5').update(payload).digest('hex')` 用于 cache key 时被误报
- **根因**: 需要上下文判断 MD5 用途（密码 hash vs cache key）
- **修复**: 加 `cache` / `etag` / `content hash` 上下文排除
- **状态**: ✅ 已修复（case_sec_008 覆盖）

---

## 统计

| 指标 | 值 |
| --- | --- |
| 累计偏差数 | 4 |
| 已修复 | 4 |
| 未修复 | 0 |
| false_positive 率趋势 | S6: 25% → S7: 10% → S8: < 10%（目标 < 15%） |
