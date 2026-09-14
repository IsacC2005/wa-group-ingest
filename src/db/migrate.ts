import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Logger } from '../config/logger.js';
import type { Database } from './client.js';

/** Applies pending SQL migrations. Idempotent: drizzle tracks applied ones in `drizzle.__drizzle_migrations`. */
export async function runMigrations(db: Database, migrationsFolder: string, logger: Logger): Promise<void> {
  logger.info({ migrationsFolder }, 'running database migrations');
  await migrate(db, { migrationsFolder });
  logger.info('database migrations up to date');
}
