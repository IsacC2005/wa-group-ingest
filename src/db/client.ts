import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../config/env.js';
import * as schema from './schema.js';

export const sql = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX,
  onnotice: () => {},
});

export const db = drizzle(sql, { schema });

export type Database = typeof db;

export async function closeDb(): Promise<void> {
  await sql.end({ timeout: 5 });
}
