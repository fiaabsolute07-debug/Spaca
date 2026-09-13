import { checkEnvironment, formatEnvironmentReport, isEnvironmentTarget } from './lib/env-rules';

// Deliberately inspect only the supplied process environment; never load/print local secret files.
const target = process.argv[2] ?? process.env.APP_ENV ?? 'local';
if (!isEnvironmentTarget(target) || process.argv.length > 3) {
  console.error('TARGET | INVALID | set |');
  console.error('Usage: tsx scripts/env-check.ts [local|staging|production]');
  process.exitCode = 1;
} else {
  const report = checkEnvironment(process.env, target);
  console.log(formatEnvironmentReport(report));
  process.exitCode = report.ok ? 0 : 1;
}
