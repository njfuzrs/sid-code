/**
 * 迁移失败的启动告警暂存（B35 / D128）
 *
 * runMigrations 在 initLogger 之前执行，getLogger() 是 enabled:false 的兜底实例，
 * debug 级直接被吞——迁移失败用户一行都看不到。这里只暂存，由 loadConfig 并进
 * config._validationDiagnostics.warnings，TUI 启动横幅与 --print 的 stderr 诊断共用这个出口。
 *
 * 独立成文件而不放在 runner.ts：config.ts 读它时不想把整条迁移依赖链（含 settings.ts）拉进来。
 */

export interface MigrationWarning {
  path: string;
  message: string;
}

const warnings: MigrationWarning[] = [];

export function recordMigrationWarning(path: string, message: string): void {
  if (warnings.some((w) => w.path === path && w.message === message)) return;
  warnings.push({ path, message });
}

export function getMigrationWarnings(): readonly MigrationWarning[] {
  return warnings;
}

/** 仅供测试：同进程多次 runMigrations 之间清空 */
export function resetMigrationWarnings(): void {
  warnings.length = 0;
}
