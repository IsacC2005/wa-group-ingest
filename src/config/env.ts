import { z } from 'zod';

const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production']).default('production'),
    LOG_LEVEL: logLevel.default('info'),
    BAILEYS_LOG_LEVEL: logLevel.default('warn'),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    MIGRATIONS_DIR: z.string().default('./src/db/migrations'),

    AUTH_DIR: z.string().default('./auth'),
    STORE_RAW_PAYLOAD: z.stringbool().default(true),

    MEMBER_SYNC_INTERVAL_HOURS: z.coerce.number().positive().default(24),
    MEMBER_SYNC_MIN_DELAY_MS: z.coerce.number().int().nonnegative().default(5_000),
    MEMBER_SYNC_MAX_DELAY_MS: z.coerce.number().int().nonnegative().default(15_000),

    RECONNECT_BASE_DELAY_MS: z.coerce.number().int().positive().default(2_000),
    RECONNECT_MAX_DELAY_MS: z.coerce.number().int().positive().default(300_000),
  })
  .refine((e) => e.MEMBER_SYNC_MIN_DELAY_MS <= e.MEMBER_SYNC_MAX_DELAY_MS, {
    message: 'MEMBER_SYNC_MIN_DELAY_MS must be <= MEMBER_SYNC_MAX_DELAY_MS',
  })
  .refine((e) => e.RECONNECT_BASE_DELAY_MS <= e.RECONNECT_MAX_DELAY_MS, {
    message: 'RECONNECT_BASE_DELAY_MS must be <= RECONNECT_MAX_DELAY_MS',
  });

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:\n', z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
