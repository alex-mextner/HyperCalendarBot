// Import this module FIRST in any benchmark entry point: it switches the repo's pino loggers to silent before the
// engine modules create their child loggers, so a run prints only its own report.
process.env.NODE_ENV = 'production';
const loggers = await import('../../src/utils/logger.ts');
for (const value of Object.values(loggers)) {
  if (value && typeof value === 'object' && 'level' in value) value.level = 'silent';
}
